import { RNPlugin, PluginRem, RemId } from '@remnote/plugin-sdk';
import { getAllPowerupSlotIds } from '../powerupSlotFilter';

/**
 * Reading a Rem's children reliably.
 *
 * DO NOT trust `rem.children`. The plugin bridge fills that field from RemNote's
 * CHILDREN_LAZY_CACHE (`mapRemToPluginInterface` in app.asar: `children:
 * e[CHILDREN_LAZY_CACHE] || []`), and that cache is only populated once
 * something loads the Rem's children — opening the document, expanding it.
 * For a document nobody has opened this session the field is `[]`.
 *
 * `getChildrenRem()` goes through `childrenRemAsync()`, which reads the child
 * ids off the always-loaded structure graph (`getTinyGraph().
 * orderedChildrenNumberIds`) and fetches the Rems — correct whether or not the
 * document was ever opened. It is one bridge call per parent.
 *
 * Measured consequence of getting this wrong: the Priority Queue popup reported
 * "Holding 0 entries" for a full document until it was opened — and a Refresh in
 * that state would have refilled 25 duplicates and a second status block and
 * graph, while Clean could have offered to delete a document that still held due
 * entries and notes.
 *
 * ORDER is not promised by `getChildrenRem()`. Callers that care about position
 * must ask `positionAmongstSiblings()`.
 */
export async function readChildren(plugin: RNPlugin, rem: PluginRem): Promise<PluginRem[]> {
  try {
    return ((await rem.getChildrenRem()) || []) as PluginRem[];
  } catch (e) {
    // Fall back to the lazy field: better a possibly-empty answer than a throw
    // in the middle of a scan.
    console.warn(`[Children] getChildrenRem failed for ${rem._id}, falling back to the lazy field:`, e);
    const ids = (rem.children as RemId[] | undefined) ?? [];
    return ids.length ? (((await plugin.rem.findMany(ids)) || []) as PluginRem[]) : [];
  }
}

/** True when the text is exactly one Rem reference to a powerup slot definition. */
function isSlotRow(rem: PluginRem, slotIds: ReadonlySet<RemId>): boolean {
  const text = rem.text;
  if (!Array.isArray(text) || slotIds.size === 0) return false;
  let refId: RemId | null = null;
  for (const el of text) {
    if (typeof el === 'string') {
      if (el.trim()) return false;
      continue;
    }
    if (el && typeof el === 'object' && (el as any).i === 'q' && (el as any)._id) {
      if (refId) return false;
      refId = (el as any)._id as RemId;
      continue;
    }
    return false;
  }
  return !!refId && slotIds.has(refId);
}

/**
 * Children minus powerup slot rows.
 *
 * A slot value can be stored as a child Rem whose text is a single reference to
 * the slot definition (`getOrCreateSlotChildAsync` in app.asar) — the very shape
 * of a review-document entry. Left in, a Priority Queue document's own hidden
 * config (scope, fill target, …) would be counted as entries, judged "stale",
 * and drained. Recognised locally against the cached slot-definition ids, so it
 * costs no call per child.
 */
export async function readContentChildren(plugin: RNPlugin, rem: PluginRem): Promise<PluginRem[]> {
  const [children, slotIds] = await Promise.all([
    readChildren(plugin, rem),
    getAllPowerupSlotIds(plugin).catch(() => new Set<RemId>()),
  ]);
  return children.filter((c) => !isSlotRow(c, slotIds));
}

/**
 * How many content children each Rem has, read in concurrent windows. Used for
 * the "notes written under an entry" checks, which must never read a lazily
 * empty list as "no notes".
 */
export async function contentChildCounts(
  plugin: RNPlugin,
  rems: PluginRem[],
  windowSize = 16
): Promise<Map<RemId, number>> {
  const counts = new Map<RemId, number>();
  for (let i = 0; i < rems.length; i += windowSize) {
    const window = rems.slice(i, i + windowSize);
    const results = await Promise.all(window.map((r) => readContentChildren(plugin, r)));
    window.forEach((r, idx) => counts.set(r._id, results[idx].length));
  }
  return counts;
}
