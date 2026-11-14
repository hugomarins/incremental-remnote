/**
 * Client for the AI helper's search (scripts/rem_search.py, served by
 * scripts/ai_ocr_helper.py as POST /search). See plans/SEARCH_ENGINE_PLAN.md.
 *
 * RemNote's own search, the only one the SDK offers, ORs the words and keeps the
 * best 1,000 by a rank that ignores the query, so a Rem holding every word typed
 * can be dropped before the plugin sees it. The helper runs an Anki-style query
 * (AND, OR, -word, "phrase", in:…) straight on remnote.db instead.
 *
 * Desktop only and optional: when the helper is off, on the iPhone or on the web,
 * every call resolves to `unavailable` and callers keep RemNote's search.
 */
import type { RNPlugin } from '@remnote/plugin-sdk';
import { aiHelperPairingTokenId } from './consts';
import { getIESetting } from './settings';
import {
  HelperSearchResult,
  HelperSuppression,
  parseRemIdsResponse,
  parseSearchResponse,
  parseSuppressionResponse,
} from './rem_search_protocol';

export type {
  HelperQueryError,
  HelperSearchHit,
  HelperSearchResult,
  HelperSuppression,
  HelperSuppressionCause,
} from './rem_search_protocol';
export { usesQuerySyntax } from './rem_search_protocol';

export const SEARCH_HELPER_URL = 'http://localhost:3457';
const TIMEOUT_MS = 1500;

let kbIdCache: string | null | undefined;

async function currentKbId(plugin: RNPlugin): Promise<string | null> {
  if (kbIdCache === undefined) {
    try {
      kbIdCache = (await plugin.kb.getCurrentKnowledgeBaseData())?._id ?? null;
    } catch {
      kbIdCache = null;
    }
  }
  return kbIdCache;
}

type HelperPost = { status: 'ok'; body: any } | { status: 'unpaired' } | { status: 'unavailable' };

/** POST to a token-guarded helper route for the current knowledge base. Never throws. */
async function postToHelper(
  plugin: RNPlugin,
  path: string,
  payload: Record<string, unknown>,
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<HelperPost> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return { status: 'unavailable' };
  const token = ((await getIESetting(plugin, aiHelperPairingTokenId)) ?? '').trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? TIMEOUT_MS);
  opts?.signal?.addEventListener('abort', () => controller.abort());
  try {
    const res = await fetch(`${SEARCH_HELPER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IR-Token': token },
      body: JSON.stringify({ kbId, ...payload }),
      signal: controller.signal,
    });
    if (res.status === 403) return { status: 'unpaired' };
    if (!res.ok) return { status: 'unavailable' };
    return { status: 'ok', body: await res.json() };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Search the current knowledge base through the helper. Never throws. */
export async function searchViaHelper(
  plugin: RNPlugin,
  query: string,
  opts?: { limit?: number; signal?: AbortSignal }
): Promise<HelperSearchResult> {
  const res = await postToHelper(plugin, '/search', { query, limit: opts?.limit ?? 100 }, opts);
  return res.status === 'ok' ? parseSearchResponse(res.body) : res;
}

/**
 * The Rems whose Sources list `sourceId` (with `incrementalOnly`, only IncRems), from
 * the helper's index, or null when the helper can't answer (off, unpaired, mobile,
 * index still being built). A single indexed lookup, replacing a walk over every
 * IncRem's Sources. Callers still verify each Rem and keep their own caches: the
 * index follows RemNote's database on disk, which can trail a Rem made seconds ago.
 */
export async function remsWithSourceViaHelper(
  plugin: RNPlugin,
  sourceId: string,
  opts?: { incrementalOnly?: boolean }
): Promise<string[] | null> {
  const res = await postToHelper(
    plugin,
    '/search/source',
    { sourceId, incrementalOnly: !!opts?.incrementalOnly },
    { timeoutMs: 3000 }
  );
  return res.status === 'ok' ? parseRemIdsResponse(res.body) : null;
}

/**
 * Every card RemNote won't put in a queue, with its cause, read from the helper's
 * index (stored fields the plugin can't read: `forget`, `efc`, `enableBackSR`,
 * `dci`, table view type), or null when the helper can't answer. Feeds the Weighted
 * Shield's Suppressed Cards tab, which otherwise infers causes Rem by Rem.
 */
export async function suppressionCausesViaHelper(plugin: RNPlugin): Promise<HelperSuppression | null> {
  const res = await postToHelper(plugin, '/search/suppression', {}, { timeoutMs: 20_000 });
  return res.status === 'ok' ? parseSuppressionResponse(res.body) : null;
}
