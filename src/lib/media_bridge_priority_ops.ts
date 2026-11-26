/**
 * Local Media Bridge — `priority-get` and `priority-set`: an outside tool shows the
 * priority of Rems (a book's notes, a list of search results) and changes one.
 *
 * `priority-get` is asked about hundreds of Rems at once, most of them siblings and
 * cousins. findClosestAncestorWithAnyPriority walks one chain per Rem, so calling it per
 * Rem would read the same ancestors hundreds of times and flood the bridge. Here every
 * Rem is read once per job and each ancestor's answer is shared by all below it.
 */
import { PluginRem, ReactRNPlugin } from '@remnote/plugin-sdk';
import type { BridgeOpJob, BridgeOpResult } from './media_bridge_ops';
import { defaultCardPriorityId, powerupCode, prioritySlotCode } from './consts';
import { CARD_PRIORITY_CODE, SOURCE_SLOT } from './card_priority/types';
import { getRawCardPriorityString } from './card_priority/slot_access';
import { setCardPriority, updateCardPriorityCache } from './card_priority';
import { getIncrementalRemFromRem, setIncRemPriority, updateIncrementalRemCache } from './incremental_rem';
import { resolveRemTextForBreadcrumb } from './richTextRemRefs';
import { getIESetting } from './settings';
import { readPriorityColorScale } from './priority_color_scale';
import { scalePercentile } from './unified_percentile';

type Kind = 'IncRem' | 'Card';

/** A Rem's own slots, as the inheritance walk needs them. */
interface Own {
  rem: PluginRem;
  /** A priority others inherit: the Incremental priority, or a manual/incremental card priority. */
  anchor: { priority: number; kind: Kind } | null;
  /** Its manual (or incremental-sourced) card priority, which an Incremental Rem can carry too. */
  manualCard: number | null;
  /** A card priority copied from above (`inherited`), or the default one. */
  derived: { priority: number; source: string } | null;
}

interface Inherited {
  priority: number;
  kind: Kind;
  from: PluginRem;
}

export interface PriorityAnswer {
  priority: number;
  source: 'own' | 'inherited' | 'default';
  from: string | null;
  kind: Kind;
  /**
   * The priority's place on the unified IncRems + cards scale, the number every priority
   * colour in the plugin is drawn from. Absent until the scale has been built.
   */
  percentile?: number;
}

const fail = (summary: string): BridgeOpResult => ({ ok: false, summary, message: summary });

/** Reads in flight at once: enough to be quick, few enough to leave the bridge free. */
const CONCURRENCY = 8;

async function pooled<T>(items: T[], run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await run(items[next++]);
    })
  );
}

/**
 * One job's view of the priorities: each Rem's own slots are read once, and what a Rem
 * passes down (its own anchor, else what it inherits) is resolved once per Rem.
 */
class PriorityReader {
  private own = new Map<string, Promise<Own | null>>();
  private passedDown = new Map<string, Promise<{ hit: Inherited | null; orphan: Inherited | null }>>();
  private names = new Map<string, Promise<string>>();

  constructor(private plugin: ReactRNPlugin) {}

  seed(rem: PluginRem) {
    if (!this.own.has(rem._id)) this.own.set(rem._id, this.read(rem));
  }

  ownOf(remId: string): Promise<Own | null> {
    let reading = this.own.get(remId);
    if (!reading) {
      reading = this.plugin.rem.findOne(remId).then((rem) => (rem ? this.read(rem) : null));
      this.own.set(remId, reading);
    }
    return reading;
  }

  private async read(rem: PluginRem): Promise<Own> {
    const [isIncremental, cardValue] = await Promise.all([rem.hasPowerup(powerupCode), getRawCardPriorityString(rem)]);
    const [incValue, cardSource] = await Promise.all([
      isIncremental ? rem.getPowerupProperty(powerupCode, prioritySlotCode) : null,
      cardValue ? rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT) : null,
    ]);
    const card = parseInt(cardValue as string, 10);
    const explicitCard = !isNaN(card) && (cardSource === 'manual' || cardSource === 'incremental');
    let anchor: Own['anchor'] = null;
    if (isIncremental) {
      const inc = parseInt(incValue as string, 10);
      // As getIncrementalRemFromRem: an Incremental Rem with an empty slot is at 10.
      anchor = { priority: isNaN(inc) ? 10 : inc, kind: 'IncRem' };
    } else if (explicitCard) {
      anchor = { priority: card, kind: 'Card' };
    }
    return {
      rem,
      anchor,
      manualCard: explicitCard ? card : null,
      derived: !explicitCard && !isNaN(card) ? { priority: card, source: String(cardSource ?? '') } : null,
    };
  }

  /**
   * What the children of `remId` inherit, in the order of
   * findClosestAncestorWithAnyPriority(…, 'Card'): at each level a manual card priority,
   * else the Incremental one; `orphan` is the closest `inherited` value on the way up,
   * used only when the chain has no anchor at all.
   */
  below(remId: string | null | undefined): Promise<{ hit: Inherited | null; orphan: Inherited | null }> {
    if (!remId) return Promise.resolve({ hit: null, orphan: null });
    let walking = this.passedDown.get(remId);
    if (!walking) {
      walking = (async () => {
        const own = await this.ownOf(remId);
        if (!own) return { hit: null, orphan: null };
        if (own.manualCard !== null) {
          return { hit: { priority: own.manualCard, kind: 'Card' as Kind, from: own.rem }, orphan: null };
        }
        if (own.anchor) return { hit: { ...own.anchor, from: own.rem }, orphan: null };
        const up = await this.below(own.rem.parent);
        const mine =
          own.derived?.source === 'inherited' ? { priority: own.derived.priority, kind: 'Card' as Kind, from: own.rem } : null;
        return { hit: up.hit, orphan: mine ?? up.orphan };
      })();
      this.passedDown.set(remId, walking);
    }
    return walking;
  }

  nameOf(rem: PluginRem): Promise<string> {
    let name = this.names.get(rem._id);
    if (!name) {
      name = resolveRemTextForBreadcrumb(this.plugin, rem.text)
        .then((text) => (text.length > 50 ? `${text.slice(0, 50)}...` : text))
        .catch(() => '');
      this.names.set(rem._id, name);
    }
    return name;
  }

  /** The priority a Rem has today, and where it comes from. */
  async answer(remId: string, defaultPriority: number): Promise<PriorityAnswer | null> {
    const own = await this.ownOf(remId);
    if (!own) return null;
    if (own.anchor) return { priority: own.anchor.priority, source: 'own', from: null, kind: own.anchor.kind };
    const up = await this.below(own.rem.parent);
    if (up.hit) {
      return { priority: up.hit.priority, source: 'inherited', from: await this.nameOf(up.hit.from), kind: up.hit.kind };
    }
    // Copied from an anchor that is gone: still what the Rem's cards are sorted by.
    if (own.derived?.source === 'inherited') {
      return { priority: own.derived.priority, source: 'inherited', from: null, kind: 'Card' };
    }
    if (up.orphan) {
      return { priority: up.orphan.priority, source: 'inherited', from: await this.nameOf(up.orphan.from), kind: 'Card' };
    }
    return { priority: defaultPriority, source: 'default', from: null, kind: 'Card' };
  }
}

// --- priority-get ------------------------------------------------------------

export async function runPriorityGet(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const ids = [...new Set(job.remIds)];
  const reader = new PriorityReader(plugin);
  for (const rem of (await plugin.rem.findMany(ids)) ?? []) reader.seed(rem);
  const [defaultPriority, scale] = await Promise.all([
    getIESetting(plugin, defaultCardPriorityId),
    readPriorityColorScale(plugin),
  ]);

  const priorities: Record<string, PriorityAnswer> = {};
  const missing: string[] = [];
  await pooled(ids, async (id) => {
    try {
      const answer = await reader.answer(id, defaultPriority);
      if (!answer) missing.push(id);
      else priorities[id] = scale ? { ...answer, percentile: scalePercentile(scale, answer.priority) } : answer;
    } catch (e) {
      console.warn('[MediaBridge] priority-get failed for', id, e);
      missing.push(id);
    }
  });
  const found = ids.length - missing.length;
  return {
    ok: found > 0 || !ids.length,
    summary: `priority of ${found} rem${found === 1 ? '' : 's'}` + (missing.length ? `, ${missing.length} not found` : ''),
    priorities,
    ...(missing.length ? { missing } : {}),
  };
}

// --- priority-set ------------------------------------------------------------

/** Past this many descendants the preview stops counting and says so. */
const PREVIEW_LIMIT = 3000;

/**
 * Who would inherit a new card priority on `root`: its descendants with no anchor of
 * their own that are not below another anchor.
 */
async function inheritorsOf(reader: PriorityReader, root: PluginRem) {
  const descendants = await root.getDescendants();
  const counted = descendants.slice(0, PREVIEW_LIMIT);
  for (const d of counted) reader.seed(d);
  const inSubtree = new Set(counted.map((d) => d._id));
  let rems = 0;
  let cards = 0;
  await pooled(counted, async (d) => {
    const own = await reader.ownOf(d._id);
    if (!own || own.anchor) return;
    // Shielded by an anchor between it and the root?
    let parentId = d.parent;
    while (parentId && parentId !== root._id && inSubtree.has(parentId)) {
      const above = await reader.ownOf(parentId);
      if (!above) break;
      if (above.anchor) return;
      parentId = above.rem.parent;
    }
    const n = (await d.getCards()).length;
    if (!n) return;
    rems += 1;
    cards += n;
  });
  return { rems, cards, truncated: descendants.length > counted.length };
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function runPrioritySet(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const priority = Number(job.priority);
  if (!(Number.isInteger(priority) && priority >= 0 && priority <= 100)) {
    return fail('The priority must be a whole number from 0 to 100.');
  }
  if (job.remIds.length !== 1) return fail('priority-set takes one rem.');
  const dryRun = job.dryRun === true;
  const reader = new PriorityReader(plugin);
  const own = await reader.ownOf(job.remIds[0]);
  if (!own) return fail('rem not found');
  const { rem } = own;
  const name = await reader.nameOf(rem);
  const defaultPriority = await getIESetting(plugin, defaultCardPriorityId);
  const today = (await reader.answer(rem._id, defaultPriority))!;
  const kind: Kind = own.anchor?.kind ?? 'Card';
  const base = { remId: rem._id, kind, priority, previous: today.priority, previousSource: today.source, dryRun };

  if (own.anchor && own.anchor.priority === priority) {
    return { ...base, ok: true, changed: false, summary: `“${name}” is already at ${priority}` };
  }

  if (dryRun) {
    if (own.anchor) {
      const what = kind === 'IncRem' ? 'Incremental priority' : 'card priority';
      return {
        ...base,
        ok: true,
        changed: false,
        summary: `update the ${what} of “${name}” from ${own.anchor.priority} to ${priority}`,
      };
    }
    const below = await inheritorsOf(reader, rem);
    const ownCards = (await rem.getCards()).length;
    const from =
      today.source === 'default' ? 'the default' : today.from ? `from “${today.from}”` : 'inherited, its source is gone';
    const more = below.truncated ? ' or more' : '';
    return {
      ...base,
      ok: true,
      changed: false,
      inheritors: below,
      summary:
        `add a card priority on “${name}”` +
        (ownCards ? ` (${count(ownCards, 'card')} of its own)` : '') +
        `: ${count(below.cards, 'card')}${more} in ${count(below.rems, 'rem')}${more} below it with no priority of their own ` +
        `will inherit ${priority} (today ${today.priority}, ${from})`,
    };
  }

  // As the batch tools do: one flag bracket, then the inheritance cascade from this rem.
  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    if (kind === 'IncRem') {
      await setIncRemPriority(plugin, rem, priority, { event: 'bridge' });
      const updated = await getIncrementalRemFromRem(plugin, rem);
      if (updated) await updateIncrementalRemCache(plugin, updated);
    } else {
      await setCardPriority(plugin, rem, priority, 'manual', false, { event: 'bridge' });
      await updateCardPriorityCache(plugin, rem._id);
    }
    // The cascade watcher raises the flag again itself, so set it before clearing ours.
    await plugin.storage.setSession('pendingInheritanceCascade', [rem._id]);
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
  return {
    ...base,
    ok: true,
    changed: true,
    summary:
      kind === 'IncRem'
        ? `Incremental priority of “${name}” set to ${priority} (was ${today.priority})`
        : `card priority of “${name}” set to ${priority} (was ${today.priority}, ${today.source})`,
  };
}
