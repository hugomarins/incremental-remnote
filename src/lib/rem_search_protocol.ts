/**
 * The AI helper's /search answer, and the query-syntax test: pure, so it can be
 * tested outside RemNote. The client is lib/rem_search_client.ts.
 */

export interface HelperSearchHit {
  remId: string;
  /** Set when the Rem matched only through this alias. */
  aliasId?: string;
}

export interface HelperQueryError {
  /** Stable: 'unclosed-quote', 'ambiguous', 'not-found', 'not-yet', 'schema'… */
  kind: string;
  message: string;
  /** Character offset in the query where the problem starts. */
  at?: number;
}

export type HelperSearchResult =
  | { status: 'ok'; hits: HelperSearchHit[]; total: number; ms: number }
  /** The query can't run as written; RemNote's search still can. */
  | { status: 'query-error'; error: HelperQueryError }
  /** The helper answered but refused: no token, or not the one it holds. */
  | { status: 'unpaired' }
  /** No helper, an old helper without /search, or it failed. */
  | { status: 'unavailable' };

/** The helper's JSON → a result. */
export function parseSearchResponse(body: any): HelperSearchResult {
  if (!body || body.ok !== true) return { status: 'unavailable' };
  if (body.queryError && typeof body.queryError === 'object') {
    const e = body.queryError;
    return {
      status: 'query-error',
      error: {
        kind: String(e.kind ?? 'query'),
        message: String(e.message ?? 'The search could not run.'),
        ...(typeof e.at === 'number' ? { at: e.at } : {}),
      },
    };
  }
  if (!Array.isArray(body.results)) return { status: 'unavailable' };
  const hits: HelperSearchHit[] = [];
  for (const r of body.results) {
    if (typeof r?.remId !== 'string' || !r.remId) continue;
    hits.push(typeof r.aliasId === 'string' && r.aliasId ? { remId: r.remId, aliasId: r.aliasId } : { remId: r.remId });
  }
  return {
    status: 'ok',
    hits,
    total: typeof body.total === 'number' ? body.total : hits.length,
    ms: typeof body.ms === 'number' ? body.ms : 0,
  };
}

/** The helper's /search/source answer → Rem ids, or null when it didn't answer one. */
export function parseRemIdsResponse(body: any): string[] | null {
  if (!body || body.ok !== true || body.queryError || !Array.isArray(body.remIds)) return null;
  return body.remIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Whether a query uses the helper's syntax (operators, quotes, brackets, keys), so
 * RemNote's word search can't stand in for it. Plain words return false.
 */
const SEARCH_KEYS = 'w|alias|in|parent|path|tag|is|has|source|refs|id|added|edited|prop|card|ml|rated|introduced|cid';
const SYNTAX_RE = new RegExp(
  // operators · quotes and brackets · key: · owner.name:value or owner.name<5 (a slot or property)
  `(^|\\s)(-\\S|or\\s|and\\s)|["()]|(^|\\s)-?(${SEARCH_KEYS}):|(^|\\s)-?[^\\s:]*[a-z*]\\.[a-z][^\\s:<>=]*(:|<|>|=)`,
  'i'
);

export function usesQuerySyntax(query: string): boolean {
  return SYNTAX_RE.test(query.trim() + ' ');
}
