import { RNPlugin, PluginRem, RemId } from '@remnote/plugin-sdk';
import { allIncrementalRemKey } from '../consts';
import { IncrementalRem } from '../incremental_rem';
import { repCountsForStats } from '../incremental_rem/types';
import { hasCardClusterPowerup } from './index';
import {
  CardLike,
  CoolingCandidate,
  CoolingParams,
  CoolingVerdict,
  DEFAULT_COOLING_PARAMS,
  SpoilerSeenEvent,
  cardIntervalDays,
  cardLastSeenAt,
  evaluateCooling,
  isCardDue,
} from './cooling';
import { readCoolingOverrides, writeCoolingCache } from './cooling_store';

/**
 * Turns RemNote data into the plain facts the cooling engine judges.
 *
 * COST MODEL. One `card.getAll()` answers every card question for every
 * candidate — due-ness, last viewing, interval — as map lookups; the clean
 * command already pays this read and it is the cheap part. Tree reads are the
 * only per-candidate cost and they are bounded by the candidate list, never by
 * the KB: a candidate's parent, its siblings, its children and grandchildren,
 * fetched with `findMany` in a few batches and memoised across candidates that
 * share them (siblings share a parent; a descriptor tree shares whole rows).
 * Candidates are processed in small concurrent windows so wall time is a few
 * round-trips deep regardless of how many there are.
 *
 * MEMBERSHIP. Alt+Z clozes are identified by the `cloze-extract` tag's own
 * member list, read once. That list is known to under-report for BUILT-IN
 * powerups (lib/empty_ecd_scan.ts), but `cloze-extract` is a plain Rem tag the
 * plugin creates itself, and the debug "Probe Spoiler State" cross-check found
 * the two sources agreeing on it. The clean command reads INC/FC the same way.
 *
 * CLUSTERS. Children of a Card Cluster are designed to be shown together, and
 * RemNote's own bury rule treats the selected cluster as one unit; so a cluster
 * parent contributes no sibling events, and a cluster parent's own children
 * contribute no descendant events.
 */

export interface CoolingScanOptions {
  now?: number;
  params?: CoolingParams;
  /** Recorded on the cache so the UI can say which scope it describes. */
  scopeRemId?: RemId | null;
  /** Priority per candidate, when the caller has it; copied onto the verdicts. */
  priorityByRemId?: Map<RemId, number>;
  /** Keep the raw candidates (every seen event) on the result — for probes. */
  includeCandidates?: boolean;
  /** Skip writing the session cache — for probes that must not disturb the shields. */
  dryRun?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface CoolingScanResult {
  verdicts: CoolingVerdict[];
  /** Candidates examined. */
  checked: number;
  /** Candidates that actually owed a card (the rest cannot cool). */
  withDueCards: number;
  /** Parents / candidates skipped as Card Clusters. */
  clustersSkipped: number;
  candidates?: CoolingCandidate[];
  elapsedMs: number;
}

const WINDOW = 8;

/** Local, allocation-only text for labels — same trade as clean.ts. */
function flattenText(text: unknown): string {
  if (!Array.isArray(text)) return '';
  return text
    .map((el) => {
      if (typeof el === 'string') return el;
      if (el && typeof el === 'object' && 'text' in el && typeof (el as any).text === 'string') {
        return (el as any).text;
      }
      return '';
    })
    .join('')
    .trim();
}

/** Memoising Rem reader: one findMany per batch of misses. */
class RemReader {
  private cache = new Map<RemId, PluginRem | null>();
  constructor(private plugin: RNPlugin) {}

  async many(ids: RemId[]): Promise<Map<RemId, PluginRem>> {
    const unique = [...new Set(ids.filter(Boolean))];
    const misses = unique.filter((id) => !this.cache.has(id));
    if (misses.length) {
      try {
        const found = (await this.plugin.rem.findMany(misses)) || [];
        for (const r of found) this.cache.set(r._id, r);
      } catch (e) {
        console.warn('[Cooling] findMany failed:', e);
      }
      for (const id of misses) if (!this.cache.has(id)) this.cache.set(id, null);
    }
    const out = new Map<RemId, PluginRem>();
    for (const id of unique) {
      const r = this.cache.get(id);
      if (r) out.set(id, r);
    }
    return out;
  }

  async one(id: RemId): Promise<PluginRem | null> {
    return (await this.many([id])).get(id) ?? null;
  }
}

/** Last date the IncRem was actually read, from the plugin's own history. */
function incRemLastReadAt(inc: IncrementalRem | undefined): number | null {
  if (!inc?.history?.length) return null;
  let last: number | null = null;
  for (const rep of inc.history) {
    if (!repCountsForStats(rep.eventType)) continue;
    if (typeof rep.date !== 'number') continue;
    if (last === null || rep.date > last) last = rep.date;
  }
  return last;
}

/**
 * Runs the cooling rule over the given Rems and, unless `dryRun`, publishes
 * the verdicts to the session cache the shields read.
 */
export async function scanCooling(
  plugin: RNPlugin,
  candidateRemIds: RemId[],
  options: CoolingScanOptions = {}
): Promise<CoolingScanResult> {
  const startedAt = Date.now();
  const now = options.now ?? startedAt;
  const params = options.params ?? DEFAULT_COOLING_PARAMS;
  const reader = new RemReader(plugin);

  const [allCards, overrides, allIncRems, clozeExtractTag] = await Promise.all([
    plugin.card.getAll().catch((e) => {
      console.error('[Cooling] card.getAll failed:', e);
      return [] as CardLike[];
    }),
    readCoolingOverrides(plugin),
    plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey).then((v) => v || []),
    plugin.rem.findByName(['cloze-extract'], null).catch(() => null),
  ]);

  const cardsByRem = new Map<RemId, CardLike[]>();
  for (const card of allCards as any[]) {
    const owner = card.remId as RemId | undefined;
    if (!owner) continue;
    const list = cardsByRem.get(owner);
    if (list) list.push(card);
    else cardsByRem.set(owner, [card]);
  }
  const incByRem = new Map<RemId, IncrementalRem>(allIncRems.map((r) => [r.remId, r]));

  let clozeExtractIds = new Set<RemId>();
  if (clozeExtractTag) {
    try {
      clozeExtractIds = new Set(((await clozeExtractTag.taggedRem()) || []).map((r) => r._id));
    } catch (e) {
      console.warn('[Cooling] cloze-extract member list unavailable:', e);
    }
  }

  const clusterCache = new Map<RemId, boolean>();
  let clustersSkipped = 0;
  const isCluster = async (rem: PluginRem): Promise<boolean> => {
    const cached = clusterCache.get(rem._id);
    if (cached !== undefined) return cached;
    const result = await hasCardClusterPowerup(plugin, rem);
    clusterCache.set(rem._id, result);
    if (result) clustersSkipped++;
    return result;
  };

  /** Every viewing of a Rem's cards that is not itself still due. */
  const seenEventsFor = (
    ownerId: RemId,
    relation: SpoilerSeenEvent['relation'],
    label: string | undefined,
    excludeCardId?: RemId
  ): SpoilerSeenEvent[] => {
    const events: SpoilerSeenEvent[] = [];
    for (const card of cardsByRem.get(ownerId) ?? []) {
      if (card._id === excludeCardId) continue;
      const seenAt = cardLastSeenAt(card);
      if (seenAt === null) continue;
      events.push({
        relation,
        sourceRemId: ownerId,
        sourceLabel: label,
        cardId: card._id,
        seenAt,
        stillDue: isCardDue(card, now),
      });
    }
    return events;
  };

  const buildCandidate = async (remId: RemId): Promise<CoolingCandidate | null> => {
    const own = cardsByRem.get(remId) ?? [];
    const dueCards = own.filter((c) => isCardDue(c, now));
    if (dueCards.length === 0) return null;

    const rem = await reader.one(remId);
    if (!rem) return null;
    const label = flattenText(rem.text) || undefined;

    const candidate: CoolingCandidate = {
      remId,
      label,
      priority: options.priorityByRemId?.get(remId),
      dueCards: dueCards.map((c) => ({ cardId: c._id, intervalDays: cardIntervalDays(c) })),
      seen: [],
    };

    // 1. Other cards of the same Rem.
    for (const card of own) {
      if (isCardDue(card, now)) continue;
      const seenAt = cardLastSeenAt(card);
      if (seenAt === null) continue;
      candidate.seen.push({
        relation: 'same-rem',
        sourceRemId: remId,
        sourceLabel: label,
        cardId: card._id,
        seenAt,
        stillDue: false,
      });
    }

    // 2. Cloze siblings and the parent extract — only when this Rem IS an Alt+Z
    //    cloze, since only then is its content the parent's sentence.
    const parentId = (rem.parent as RemId | undefined) ?? null;
    if (parentId && clozeExtractIds.has(remId)) {
      const parent = await reader.one(parentId);
      if (parent && !(await isCluster(parent))) {
        const parentLabel = flattenText(parent.text) || undefined;
        const siblingIds = ((parent.children as RemId[] | undefined) ?? []).filter(
          (id) => id !== remId && clozeExtractIds.has(id)
        );
        const siblings = await reader.many(siblingIds);
        for (const [sibId, sib] of siblings) {
          candidate.seen.push(
            ...seenEventsFor(sibId, 'cloze-sibling', flattenText(sib.text) || undefined)
          );
        }
        candidate.seen.push(...seenEventsFor(parentId, 'parent-extract', parentLabel));
        const readAt = incRemLastReadAt(incByRem.get(parentId));
        if (readAt !== null) {
          candidate.seen.push({
            relation: 'parent-extract',
            sourceRemId: parentId,
            sourceLabel: parentLabel,
            seenAt: readAt,
            // An IncRem read is not a card; it never "stays due" in the sense
            // that matters here. The parent extract is held by the queue's own
            // spoiler gate while these clozes are due, so treat it as done.
            stillDue: false,
          });
        }
      }
    }

    // 3 & 4. Own Alt+Z clozes, and descendant cards two levels down.
    if (!(await isCluster(rem))) {
      const childIds = (rem.children as RemId[] | undefined) ?? [];
      const children = await reader.many(childIds);
      const grandchildIds: RemId[] = [];
      for (const [childId, child] of children) {
        const childLabel = flattenText(child.text) || undefined;
        const relation = clozeExtractIds.has(childId) ? 'own-cloze-child' : 'descendant';
        candidate.seen.push(...seenEventsFor(childId, relation, childLabel));
        grandchildIds.push(...(((child.children as RemId[] | undefined) ?? [])));
      }
      const grandchildren = await reader.many(grandchildIds);
      for (const [gcId, gc] of grandchildren) {
        candidate.seen.push(...seenEventsFor(gcId, 'descendant', flattenText(gc.text) || undefined));
      }
    }

    return candidate;
  };

  const verdicts: CoolingVerdict[] = [];
  const candidates: CoolingCandidate[] = [];
  let withDueCards = 0;
  const ids = [...new Set(candidateRemIds)];

  for (let i = 0; i < ids.length; i += WINDOW) {
    const window = ids.slice(i, i + WINDOW);
    const built = await Promise.all(
      window.map((id) =>
        buildCandidate(id).catch((e) => {
          console.warn(`[Cooling] candidate ${id} failed, treated as not cooling:`, e);
          return null;
        })
      )
    );
    for (const candidate of built) {
      if (!candidate) continue;
      withDueCards++;
      if (options.includeCandidates) candidates.push(candidate);
      const verdict = evaluateCooling(candidate, now, params, overrides);
      if (verdict) verdicts.push(verdict);
    }
    options.onProgress?.(Math.min(i + WINDOW, ids.length), ids.length);
  }

  verdicts.sort((a, b) => (a.priority ?? 101) - (b.priority ?? 101) || a.until - b.until);

  if (!options.dryRun) {
    await writeCoolingCache(plugin, {
      computedAt: now,
      scopeRemId: options.scopeRemId ?? null,
      verdicts,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[Cooling] ${verdicts.length} cooling of ${withDueCards} with due cards ` +
      `(${ids.length} checked, ${clustersSkipped} clusters skipped) in ${elapsedMs}ms` +
      (options.dryRun ? ' [dry run]' : '')
  );

  return {
    verdicts,
    checked: ids.length,
    withDueCards,
    clustersSkipped,
    candidates: options.includeCandidates ? candidates : undefined,
    elapsedMs,
  };
}
