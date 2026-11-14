/** The AI helper's search answer and query syntax (rem_search_protocol.ts). Run with `npm test`. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResponse, usesQuerySyntax } from './rem_search_protocol';

describe('parseSearchResponse', () => {
  it('reads hits, keeping the alias a Rem matched through', () => {
    assert.deepEqual(
      parseSearchResponse({
        ok: true,
        ms: 5,
        total: 2,
        results: [{ remId: 'go7LdXuu9hpAZH12G' }, { remId: 'rzGXXDY2z0yi0Iefg', aliasId: 'qWCrdfRe3iCpnoLZg' }, { nope: 1 }],
      }),
      {
        status: 'ok',
        hits: [{ remId: 'go7LdXuu9hpAZH12G' }, { remId: 'rzGXXDY2z0yi0Iefg', aliasId: 'qWCrdfRe3iCpnoLZg' }],
        total: 2,
        ms: 5,
      }
    );
  });
  it('passes a query error on, and treats anything else as no helper', () => {
    assert.deepEqual(
      parseSearchResponse({ ok: true, queryError: { kind: 'unclosed-group', message: 'This "(" is never closed.', at: 4 } }),
      { status: 'query-error', error: { kind: 'unclosed-group', message: 'This "(" is never closed.', at: 4 } }
    );
    assert.deepEqual(parseSearchResponse({ ok: false, error: 'boom' }), { status: 'unavailable' });
    assert.deepEqual(parseSearchResponse({ ok: true }), { status: 'unavailable' });
    assert.deepEqual(parseSearchResponse(null), { status: 'unavailable' });
  });
});

describe('usesQuerySyntax', () => {
  it('spots operators, quotes, brackets and keys', () => {
    for (const q of ['bow -tug', 'bow or bowsprit', 'bow and wave', '"bow flare"', 'bow (wave)', 'in:PSCPP squat', 'w:bow', 'alias:x',
      'tag:anki squat', 'is:concept', '-is:incremental bow', 'prop:priority<20', 'incremental.priority<=5', 'ankicard.book:pna*', '*.book:x', 'added:7', 'has:alias']) {
      assert.equal(usesQuerySyntax(q), true, q);
    }
  });
  it('leaves plain words alone', () => {
    for (const q of ['bow weather wave', 'under-keel clearance', 'navegação interior', 'fig. 6.4', 'order', 'android', 'fig. 6.4: squat', 'e.g. squat', '3:30']) {
      assert.equal(usesQuerySyntax(q), false, q);
    }
  });
});
