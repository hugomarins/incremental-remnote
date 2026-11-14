# RemNote's search and local database

What the Search Engine (`scripts/rem_search.py`, `scripts/rem_index.py`; plan in
`plans/SEARCH_ENGINE_PLAN.md`) relies on. Established 2026-11-14 on RemNote desktop
1.30.2-beta (macOS) by reading the app bundle and the main knowledge base's
`~/remnote/remnote-<kbId>/remnote.db` (SQLite, opened `?mode=ro`; 443,381 Rems, 71,730
cards, 357,745 search rows). Re-verify after a RemNote update: its storage changed under
the plugin before.

## How RemNote's search retrieves (and why a plugin can't AND)

The plugin API's `search.search(queryText, searchContextRemId?, {filterOnlyConcepts,
numResults})` passes text only. The search worker (`getPrefixMatches` /
`execGetPrefixMatches` in the bundle) builds the FTS query itself:

```js
a = words.filter(w => !/^[a-z0-9]{0,2}$/.test(w))   // words of ≤2 characters dropped
s = a.map(w => '"w"*').join(" OR ")                  // always OR
… WHERE data MATCH s ORDER BY rank LIMIT 10000       // bm25
… ORDER BY remsSearchRanks.rank ASC LIMIT 1000       // static rank, blind to the query
```

plus one branch for the whole query as a phrase (LIMIT 100, only with ≥2 tokens and no
context Rem). A context Rem filters by an `ancestor_ids` range and skips the 10,000 cap.

Consequence: a Rem with every typed word can be cut inside RemNote. `bow weather wave`
matched 5,874 Rems on any word and 1 on all three; that one was 244th by bm25 and 2,761st
by static rank, so it never reached the plugin. `numResults` can't help. The same query
with `AND` on `remnote.db` returns it alone in 5 ms.

## The search tables

| Table | What it holds |
|---|---|
| `remsContents` | FTS5 (`unicode61`, prefix `1 2 3`), one row per Rem **and per alias**. Lower-case, accents and cloze markup removed, front and back text. **A reference's text is appended at the end** (`… expected . becomes useless … sea margin`), so a phrase can't span a reference. Parentheses are stored as `% 7e`. |
| `remsSearchInfos` | `ftsRowId`, `id`, `aliasId` (= `id` on the Rem's own row), `doc` (JSON below), `ancestor_ids` (`"  root … parent"`, indexed: a prefix range = a whole subtree, ~0 ms), `ancestor_not_ref_text` (the path's names). |
| `remsSearchRanks` | The static rank (lower is better), computed by a trigger from the `doc` fields. |

`remsSearchInfos.doc` field names (bundle enum): `_id`, `a` alias id, `p` parent, `i`
is document, `l` is folder, `d` is PDF, `g` is image, `w` website, `wl` website link, `h`
PDF highlight, `fl` flashcard, `m` in template, `e` not visible to the user, `y` type,
`r` the raw text **in reading order, references in place** (folded), `kt`/`ke`/`vt`/`ve`
key and value text without and with references, `st` search aliases, `c` created, `t`
text cost, `rd` depth.

These rows follow RemNote's indexer (`pendingRecomputeRems`), so a new Rem can be missing
for a while; RemNote's own search has the same delay.

## Rem and card documents

`quanta(_id, doc, x)` and `cards(_id, doc, x)`. Field names, from the bundle's enums:

- **Rem:** `key`, `value`, `parent`, `type` (1 concept, 2 descriptor, 6 portal; absent =
  default), `createdAt`, `tp` its tags (`{tagId: {t: bool}}`, `t: false` = removed), `apu`
  applied powerups, `ps` powerup slots (`"<code>_<slot>": {v: {v: richText, s: text},
  ",u": ms}`), `bpc` older slot cache, `rcrt` the powerup a Rem represents, `al` aliases
  (`[{aliasId, alias}]`, not Rems), `ie` not shown in the editor, `dci` disabled cloze ids,
  `forget`, `efc`, `enableBackSR`, `ny`, `docUpdated`, and a `<field>,u` write time per field.
- **Card:** `rId` Rem, `c` type (`f`, `b`, or a cloze id), `n` next time, `a` active next
  time, `h` history (`date`, `score`, …), `ml` mastery level (New, Acquiring, Growing,
  Solidifying, Retaining, NotYetLearned), `l` last repetition, `t` times wrong in a row,
  `e` created, `b` no longer generated, `ny` Learn New.
- **Rating scores in `h`:** 1 (211,677), 0.5 (20,544), 1.5 (17,500), 0 (16,511), 0.01
  (1,804), 2–5 (583). 0/0.5/1/1.5 = Forgot/Hard/Good/Easy; 0.01 and 2–5 not yet named.

### Finding what changed: `y`

Neither table has a change counter: `x` is a number given at creation and never moves.
But `y` (last local write) has an expression index, so
`json_extract(doc, '$.y') > ?` costs ~0 ms, against ~0.7 s for the same test on `u`.
Over 7 days no Rem had `u` newer than `y`, so `y` also follows edits arriving by sync.
`rem_index.refresh` re-reads every Rem with `y` above its watermark (minus 10 s, since
stamps need not commit in order) before each search: ~5 ms.

### Index traps

- `json_extract(doc, '$.rcrt') IS NOT NULL` scans every Rem (0.8 s); `> ''` uses RemNote's
  index on `rcrt` (1 ms).
- Asking FTS5 for `bm25` over a list of rowids is ~300× slower than scoring every match
  (600 ms vs 2 ms for 505 rows; a one-letter prefix scores 159k rows in 92 ms).
- ORing several `ancestor_ids` ranges in a `WHERE` keeps SQLite off their index (1.9 s for
  11 scopes); a `UNION ALL` of one range per scope uses it (0.39 s, the rest a name scan).
- Scanning every Rem's name (`json_extract(doc, '$.r') LIKE …`) costs ~0.3 s.

## Slot and property values live in two places

- **User properties** of a tag are hidden child Rems of the tagged Rem: `ie: true`, `key` =
  a single reference to the property Rem (a child of the tag), `value` = the value. 66,129
  such children for 1,807 properties in the main KB (e.g. the Anki-import tags' Book, Page,
  Chapter, Decks In).
- **Powerup slots** use the same shape for **visible** slots: an IncRem's Priority and Next
  Rep Date are written to property children of the Incremental powerup's slot Rems, while
  hidden slots (history, dates, Card Priority) are in `ps` (see
  `src/lib/powerup_slot_compat.ts`).
- A visible slot can **also** keep an older copy in `ps`: 5,063 IncRems had both, and in
  every one the child was written later (`value,u` > the `ps` entry's `,u`). The `ps` copy
  is stale. Reading "a slot's value" means taking the newest write across both places.
- Date slots hold a reference to a daily document; the text is its name ("August 1st,
  2026"). Sources are the slot `os_os`, whose value lists references to the source Rems.

## Bulk writes move edit times

`key,u` is bumped by any write of the text, not only a person typing: 992 Rems got a new
`key,u` within one minute on 2026-11-13. So "edited in the last N days" means "text
written", as Anki's `edited:` does.
