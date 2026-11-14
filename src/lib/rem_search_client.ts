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
import { HelperSearchResult, parseSearchResponse } from './rem_search_protocol';

export type { HelperQueryError, HelperSearchHit, HelperSearchResult } from './rem_search_protocol';
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

/** Search the current knowledge base through the helper. Never throws. */
export async function searchViaHelper(
  plugin: RNPlugin,
  query: string,
  opts?: { limit?: number; signal?: AbortSignal }
): Promise<HelperSearchResult> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return { status: 'unavailable' };
  const token = ((await getIESetting(plugin, aiHelperPairingTokenId)) ?? '').trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  opts?.signal?.addEventListener('abort', () => controller.abort());
  try {
    const res = await fetch(`${SEARCH_HELPER_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IR-Token': token },
      body: JSON.stringify({ kbId, query, limit: opts?.limit ?? 100 }),
      signal: controller.signal,
    });
    if (res.status === 403) return { status: 'unpaired' };
    if (!res.ok) return { status: 'unavailable' };
    return parseSearchResponse(await res.json());
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
