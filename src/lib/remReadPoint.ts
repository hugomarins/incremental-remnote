// lib/remReadPoint.ts
import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { addPageToHistory, getPageHistory, PageHistoryEntry } from './pdfUtils';
import { powerupCode, currentIncRemKey, editorReviewTimerRemIdKey } from './consts';
import { resolveRemTextForBreadcrumb } from './richTextRemRefs';

/**
 * Read points (bookmarks) for rem-type IncRems — outline headers whose reading
 * content lives in their descendants (see the Outline shown in the plugin UI).
 *
 * These reuse the PDF/HTML bookmark storage with one twist: a rem-type IncRem
 * "reads from itself", so we key the history under (incRemId, incRemId) and
 * store the descendant rem chosen as the reading position in the entry's
 * `highlightId`. `page` stays undefined — outlines have no pages. This means
 * the entire history/stats/carry-forward machinery in pdfUtils applies for free.
 */

/**
 * Save a read point: associate `descendantRemId` as the current reading
 * position of the rem-type IncRem `incRemId`.
 */
export const setRemReadPoint = async (
  plugin: RNPlugin,
  incRemId: string,
  descendantRemId: string
): Promise<void> => {
  await addPageToHistory(plugin, incRemId, incRemId, null, undefined, descendantRemId);
};

/**
 * The most recent read point (current reading position) for a rem-type IncRem,
 * or null if none has been set.
 */
export const getRemReadPoint = async (
  plugin: RNPlugin,
  incRemId: string
): Promise<PageHistoryEntry | null> => {
  const history = await getPageHistory(plugin, incRemId, incRemId);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].highlightId) return history[i];
  }
  return null;
};

/**
 * Full read-point history for a rem-type IncRem, most recent first, filtered to
 * entries that point at a target rem.
 */
export const getRemReadPointHistory = async (
  plugin: RNPlugin,
  incRemId: string
): Promise<PageHistoryEntry[]> => {
  const history = await getPageHistory(plugin, incRemId, incRemId);
  return history
    .filter((h) => h.highlightId)
    .sort((a, b) => b.timestamp - a.timestamp);
};

/**
 * A read point resolved into the chain of rems that leads to it.
 */
export interface ReadPointPath {
  /** The bookmarked rem (the deepest segment of `path`). */
  remId: string;
  /** Display texts, from just below the IncRem down to the read point. */
  path: string[];
  /** Rem ids parallel to `path`, so any segment can be opened. */
  pathIds: string[];
  /** False when the read point no longer sits under the IncRem. */
  withinTarget: boolean;
  /** When the read point was set. */
  timestamp: number;
}

/** Ancestors kept when the read point turns out to live outside the IncRem. */
const ORPHAN_PATH_SEGMENTS = 4;

/**
 * Resolve `incRemId`'s current read point together with the ancestors leading
 * to it, starting just below `incRemId` itself — what the reading position of
 * an outline looks like written out, and the counterpart of "page N of a range"
 * for a PDF.
 *
 * Read points live under the same synced page-history storage as PDF bookmarks
 * (see the module comment), so this also answers for dismissed rems. Returns
 * null when no read point is set or the bookmarked rem has been deleted.
 *
 * If the bookmarked rem has since been moved out of the outline the upward walk
 * never meets `incRemId`; rather than dropping the information, the last few
 * ancestors are kept and `withinTarget` is false so callers can say so.
 */
export const getReadPointPath = async (
  plugin: RNPlugin,
  incRemId: string,
  maxDepth = 50
): Promise<ReadPointPath | null> => {
  const entry = await getRemReadPoint(plugin, incRemId);
  if (!entry?.highlightId) return null;

  const targetRem = await plugin.rem.findOne(entry.highlightId);
  if (!targetRem) return null;

  const ids: string[] = [entry.highlightId];
  let withinTarget = false;
  // Untyped walker: getParentRem() is loosely typed in the SDK (see
  // isDescendantOf above).
  let current: any = targetRem;
  for (let i = 0; i < maxDepth; i++) {
    const parent = await current.getParentRem();
    if (!parent) break;
    if (parent._id === incRemId) {
      withinTarget = true;
      break;
    }
    ids.unshift(parent._id);
    current = parent;
  }

  if (!withinTarget && ids.length > ORPHAN_PATH_SEGMENTS) {
    ids.splice(0, ids.length - ORPHAN_PATH_SEGMENTS);
  }

  const path = await Promise.all(
    ids.map(async (id) => {
      const r = id === entry.highlightId ? targetRem : await plugin.rem.findOne(id);
      if (!r) return '…';
      const text = (await resolveRemTextForBreadcrumb(plugin, r.text)).trim();
      return text || 'Untitled';
    })
  );

  return { remId: entry.highlightId, path, pathIds: ids, withinTarget, timestamp: entry.timestamp };
};

/**
 * True if `candidate` is a (strict) descendant of the rem `ancestorId`.
 */
export const isDescendantOf = async (
  plugin: RNPlugin,
  candidate: PluginRem,
  ancestorId: string,
  maxDepth = 50
): Promise<boolean> => {
  // Untyped walker: getParentRem() is loosely typed in the SDK, so an annotated
  // `current` trips TS7022/18048 — matches determineIncRemType's pattern.
  let current: any = candidate;
  for (let i = 0; i < maxDepth; i++) {
    const parent = await current.getParentRem();
    if (!parent) return false;
    if (parent._id === ancestorId) return true;
    current = parent;
  }
  return false;
};

/**
 * Walk up from `rem` and return the nearest ancestor tagged as an Incremental
 * Rem, or null. Excludes `rem` itself (starts from its parent), so the result
 * is always a strict ancestor — appropriate for choosing the IncRem a focused
 * descendant belongs to.
 */
export const findNearestAncestorIncRem = async (
  plugin: RNPlugin,
  rem: PluginRem,
  maxDepth = 50
): Promise<string | null> => {
  let current: any = rem;
  for (let i = 0; i < maxDepth; i++) {
    const parent = await current.getParentRem();
    if (!parent) return null;
    if (await parent.hasPowerup(powerupCode)) return parent._id;
    current = parent;
  }
  return null;
};

/**
 * Resolve which rem-type IncRem a read-point action targets, for read-only
 * consumers (e.g. the history popup) that don't require a specific descendant.
 *
 * Priority: an active review session whose IncRem contains the focused rem →
 * the focused rem itself if it is an IncRem → the nearest ancestor IncRem of
 * the focused rem → otherwise the active session's IncRem (if any).
 */
export const resolveReadPointIncRem = async (
  plugin: RNPlugin,
  focused?: PluginRem | null
): Promise<string | null> => {
  const sessionIncRemId =
    (await plugin.storage.getSession<string>(editorReviewTimerRemIdKey)) ||
    (await plugin.storage.getSession<string>(currentIncRemKey)) ||
    null;

  if (focused) {
    if (
      sessionIncRemId &&
      sessionIncRemId !== focused._id &&
      (await isDescendantOf(plugin, focused, sessionIncRemId))
    ) {
      return sessionIncRemId;
    }
    if (await focused.hasPowerup(powerupCode)) return focused._id;
    const ancestor = await findNearestAncestorIncRem(plugin, focused);
    if (ancestor) return ancestor;
  }

  return sessionIncRemId;
};
