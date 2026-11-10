/**
 * Client for the helper's review-history archive (scripts/history_archive.py,
 * served by scripts/ai_ocr_helper.py). See plans/HISTORY_ARCHIVE_PLAN.md.
 *
 * Reviews of deleted Rems drop out of everything the plugin can read: RemNote
 * moves the cards to a trash that no SDK call reaches, and purges it after two
 * weeks. The desktop helper reads remnote.db and keeps every rep it ever saw.
 * This module asks it for the "ghosts" (reps whose card or Rem is no longer
 * live) and keeps only those that no live history still holds.
 *
 * Rep identity is the timestamp in ms, across kinds: Preserve history & remove,
 * Dismiss and Transfer to parent all keep a rep's `date` while moving it to
 * another Rem or kind. So a ghost whose timestamp is in any live history is
 * already counted there and is dropped.
 *
 * Desktop only, and optional: when the helper is not running every call here
 * resolves to null and callers keep what they had.
 */

export const HISTORY_HELPER_URL = 'http://localhost:3457';

/** Synced, one key per KB: the ghost reps' day buckets, in the authoritative
 *  shard's compact format plus `at` (when they were computed) and `n` (reps). */
export const GHOST_AGGREGATES_KEY = 'ghostDailyAggregates';
export function ghostShardKey(kbId: string): string {
  return `${GHOST_AGGREGATES_KEY}_${kbId}`;
}

export type GhostKind = 'card' | 'inc' | 'dism';

export interface GhostRep {
  /** Rep timestamp, ms. The rep's identity. */
  date: number;
  kind: GhostKind;
  /** Card id, or the Rem id for inc/dism. */
  item: string;
  rem: string | null;
  /** Card score (QueueInteractionScore); null for inc/dism. */
  score: number | null;
  /** Raw ms: card responseTime (uncapped) or IncRem reviewTimeSeconds × 1000. */
  time: number | null;
  /** IncRem eventType; null for cards and for legacy reps without one. */
  event: string | null;
  deletedAt: number | null;
}

export interface GhostRem {
  id: string;
  text: string | null;
  state: 'live' | 'trash' | 'gone';
  deletedAt: number | null;
  parent: string | null;
}

export interface GhostPayload {
  reps: GhostRep[];
  rems: Record<string, GhostRem>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The helper's ghost reps for a KB, or null when it can't be reached or
 * answered with an error. `scan` asks it to scan remnote.db first (~4 s on a
 * large KB), so a Rem deleted since its last background scan is included.
 */
export async function fetchGhosts(
  kbId: string,
  opts?: { scan?: boolean; timeoutMs?: number }
): Promise<GhostPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${HISTORY_HELPER_URL}/history/ghosts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kbId, scan: !!opts?.scan }),
      signal: controller.signal,
    });
    const body = await res.json();
    if (!body?.ok || !Array.isArray(body.reps)) {
      console.warn('[HistoryArchive] helper answered with an error:', body?.error ?? body);
      return null;
    }
    return { reps: body.reps as GhostRep[], rems: (body.rems || {}) as Record<string, GhostRem> };
  } catch {
    // Not running (the usual case on mobile, web and machines without it): quiet.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ghosts that no live history holds. The helper already returns one copy per
 * timestamp (the most recently live one); this drops the ones the plugin
 * itself still sees, e.g. a tombstone's `importedRep` copies or a card restored
 * from the trash since the last scan.
 */
export function filterGhosts(payload: GhostPayload, liveDates: Set<number>): GhostRep[] {
  const seen = new Set<number>();
  const out: GhostRep[] = [];
  for (const r of payload.reps) {
    if (!r || typeof r.date !== 'number') continue;
    if (liveDates.has(r.date) || seen.has(r.date)) continue;
    seen.add(r.date);
    out.push(r);
  }
  return out;
}
