#!/usr/bin/env python3
"""
Search a knowledge base with an Anki-style query, read-only, straight from remnote.db.

Served by ai_ocr_helper.py as POST /search; also a command line for tests:

    python3 scripts/rem_search.py --kb <knowledge base id> 'bow weather wave'
    python3 scripts/rem_search.py --kb <id> 'bow (wave or sea) -tug in:"Wärtsilä Encyclopedia"' --json

Why it exists: the plugin can only search through RemNote, whose worker always ORs the
words and keeps the best 1,000 by a rank that ignores the query, so a Rem holding every
word you typed can be dropped before the plugin sees it. See plans/SEARCH_ENGINE_PLAN.md.

The grammar is Anki's (docs-site/manual/searching.mdx, rslib/src/search/parser.rs):
spaces mean AND, `or`, `-` excludes, brackets group, "…" is a phrase, `key:value` and
`key:"…"`, `\\` escapes. AND binds tighter than OR: `a b or c` = `(a b) or c`.

Phase 1 terms (plans/SEARCH_ENGINE_PLAN.md §4):
    word            a word starting with it (RemNote's index is word-based)
    "two words"     the words side by side
    w:word          that whole word
    alias:text      only through one of the Rem's aliases
    in:<name|id>    the Rem and everything under it
    parent:<name|id> its direct children
    path:text       text in the names of the ancestors
Keys of later phases (tag:, is:, prop:, card:, …) are refused with a clear error. Any
other `x:y` is plain text, so "3:30" or a pasted "Note: …" still search as words.

The text index (remsContents) is RemNote's own: lower-case, accents and clozes removed,
references appended at the END of a Rem's text, and one row per alias.
"""
import argparse
import json
import re
import sqlite3
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_archive  # noqa: E402  (KB paths, read-only open)

DEFAULT_LIMIT = 200
MAX_LIMIT = 2000
REM_ID_RE = re.compile(r'^[A-Za-z0-9]{17}$')

# Keys that belong to later phases: a clear error rather than a silent text search.
LATER_KEYS = {
    'tag', 'is', 'has', 'prop', 'card', 'ml', 'rated', 'introduced', 'added', 'edited',
    'source', 'refs', 'id', 'cid', 'sort',
}
NAME_KEYS = {'in', 'parent'}


class SearchError(Exception):
    """A query that can't be run. `kind` is stable for the plugin; `at` is the character
    offset in the query where the problem starts, when there is one."""

    def __init__(self, kind, message, at=None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.at = at

    def to_json(self):
        out = {'kind': self.kind, 'message': self.message}
        if self.at is not None:
            out['at'] = self.at
        return out


# ---------------------------------------------------------------------------
# Text normalization: the same folding RemNote's index applies
# ---------------------------------------------------------------------------

def fold(text):
    """Lower-case, accents removed (ä → a, ç → c), whitespace collapsed."""
    decomposed = unicodedata.normalize('NFKD', text)
    stripped = ''.join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r'\s+', ' ', stripped.lower()).strip()


def words(text):
    """The index's tokens: runs of letters and digits."""
    return re.findall(r'[^\W_]+', fold(text))


def fts_term(text, mode):
    """One FTS5 expression. Every token is double-quoted, so nothing typed can act as an
    FTS operator. `prefix`: the last word may continue (`bow` → bowsprit); `phrase`:
    exact words side by side; `word`: exact words."""
    toks = words(text)
    if not toks:
        return None
    quoted = '"' + ' '.join(toks) + '"'
    return quoted + '*' if mode == 'prefix' else quoted


# ---------------------------------------------------------------------------
# Parser (after Anki's parser.rs)
# ---------------------------------------------------------------------------

@dataclass
class Term:
    kind: str           # 'text' | 'in' | 'parent' | 'path'
    value: str
    mode: str = 'prefix'  # text: 'prefix' | 'phrase' | 'word'
    alias_only: bool = False
    at: int = 0


@dataclass
class Not:
    node: object


@dataclass
class And:
    nodes: list = field(default_factory=list)


@dataclass
class Or:
    nodes: list = field(default_factory=list)


AND, OR = object(), object()
SPACES = ' 　'


class Parser:
    def __init__(self, query):
        self.q = re.sub(r'\s', ' ', query)
        self.i = 0

    def fail(self, kind, message, at=None):
        raise SearchError(kind, message, self.i if at is None else at)

    def skip_ws(self):
        while self.i < len(self.q) and self.q[self.i] in SPACES:
            self.i += 1

    def parse(self):
        self.skip_ws()
        if self.i >= len(self.q):
            raise SearchError('empty', 'Type something to search for.')
        node = self.group_inner()
        self.skip_ws()
        if self.i < len(self.q):  # only an unmatched ')' is left unconsumed
            self.fail('unopened-group', 'This ")" has no "(" before it.')
        return node

    def group_inner(self):
        """Nodes up to a ')' or the end, with implicit ANDs; returns one tree node."""
        items = []
        while True:
            self.skip_ws()
            if self.i >= len(self.q) or self.q[self.i] == ')':
                break
            start = self.i
            item = self.node()
            if len(items) % 2 == 0:
                if item is AND:
                    self.fail('misplaced-and', '"and" needs a search term on each side.', start)
                if item is OR:
                    self.fail('misplaced-or', '"or" needs a search term on each side.', start)
            elif item is not AND and item is not OR:
                items.append(AND)
            items.append(item)
        if items and (items[-1] is AND or items[-1] is OR):
            self.fail('misplaced-and' if items[-1] is AND else 'misplaced-or',
                      f'"{"and" if items[-1] is AND else "or"}" needs a search term on each side.')
        # AND binds tighter than OR, as in Anki's SQL.
        groups, current = [], []
        for item in items:
            if item is OR:
                groups.append(current)
                current = []
            elif item is not AND:
                current.append(item)
        groups.append(current)
        ands = [g[0] if len(g) == 1 else And(g) for g in groups if g]
        if not ands:
            return None
        return ands[0] if len(ands) == 1 else Or(ands)

    def node(self):
        c = self.q[self.i]
        if c == '-':
            self.i += 1
            if self.i >= len(self.q) or self.q[self.i] in SPACES:
                self.fail('lone-minus', 'Put the word to leave out right after "-".')
            inner = self.group() if self.q[self.i] == '(' else self.text()
            if inner is AND or inner is OR:
                self.fail('lone-minus', 'Put the word to leave out right after "-".')
            return Not(inner)
        if c == '(':
            return self.group()
        return self.text()

    def group(self):
        start = self.i
        self.i += 1  # '('
        inner = self.group_inner()
        if self.i >= len(self.q) or self.q[self.i] != ')':
            self.fail('unclosed-group', 'This "(" is never closed.', start)
        self.i += 1
        if inner is None:
            self.fail('empty-group', 'These brackets are empty.', start)
        return inner

    def quoted(self):
        """A "…" string at self.i; returns its unescaped content."""
        start = self.i
        self.i += 1
        out = []
        while self.i < len(self.q):
            c = self.q[self.i]
            if c == '\\' and self.i + 1 < len(self.q):
                out.append(self.q[self.i + 1])
                self.i += 2
                continue
            if c == '"':
                self.i += 1
                if not out:
                    self.fail('empty-quote', 'These quotes are empty.', start)
                return ''.join(out)
            out.append(c)
            self.i += 1
        self.fail('unclosed-quote', 'This quote is never closed.', start)

    def text(self):
        start = self.i
        if self.q[self.i] == '"':
            return self.term_for(self.quoted(), start, quoted=True)
        raw, key_end = [], None
        while self.i < len(self.q):
            c = self.q[self.i]
            if c in SPACES or c in '()':
                break
            if c == '"':
                # key:"value with spaces"
                if key_end is not None and key_end == len(raw):
                    value = self.quoted()
                    return self.keyed(''.join(raw[:key_end - 1]), value, start, quoted=True)
                break
            if c == '\\':
                if self.i + 1 >= len(self.q):
                    self.fail('unknown-escape', 'A "\\" at the end has nothing to escape.')
                raw.append(self.q[self.i + 1])
                self.i += 2
                continue
            if c == ':' and key_end is None:
                key_end = len(raw) + 1
            raw.append(c)
            self.i += 1
        word = ''.join(raw)
        if not word:
            self.fail('parse', 'Unexpected character.')
        if word.lower() == 'and':
            return AND
        if word.lower() == 'or':
            return OR
        if key_end is not None:
            return self.keyed(word[:key_end - 1], word[key_end:], start, quoted=False)
        return self.term_for(word, start, quoted=False)

    def term_for(self, text, at, quoted):
        if not words(text):
            self.fail('no-words', f'"{text}" has no letters or digits to search for.', at)
        # A quoted term is a phrase; an unquoted one with inner punctuation
        # ("under-keel", "6.4") is its words side by side, the last one a prefix.
        return Term('text', text, mode='phrase' if quoted else 'prefix', at=at)

    def keyed(self, key, value, at, quoted):
        k = key.lower()
        if k == 'w':
            if not words(value):
                self.fail('no-words', 'Put a word after "w:".', at)
            return Term('text', value, mode='word', at=at)
        if k == 'alias':
            if not words(value):
                self.fail('no-words', 'Put the alias text after "alias:".', at)
            return Term('text', value, mode='phrase' if quoted else 'prefix', alias_only=True, at=at)
        if k in NAME_KEYS:
            if not value.strip():
                self.fail('missing-value', f'Put a Rem name or id after "{k}:".', at)
            return Term(k, value.strip(), at=at)
        if k == 'path':
            if not words(value):
                self.fail('no-words', 'Put a word after "path:".', at)
            return Term('path', value, at=at)
        if k in LATER_KEYS or '.' in k:
            self.fail('not-yet', f'"{key}:" is planned but not available yet.', at)
        # Not a search key: the whole thing is text ("3:30", "Note: …").
        return self.term_for(f'{key}:{value}', at, quoted)


def parse(query):
    if not isinstance(query, str):
        raise SearchError('empty', 'Type something to search for.')
    return Parser(query).parse()


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

REQUIRED = {
    'remsContents': set(),  # FTS5: pragma table_info lists only `data`
    'remsSearchInfos': {'ftsRowId', 'aliasId', 'id', 'doc', 'ancestor_ids', 'ancestor_not_ref_text'},
    'remsSearchRanks': {'ftsRowId', 'rank'},
}


def open_kb(kb_id, db_path=None):
    path = Path(db_path) if db_path else history_archive.remnote_db_path(kb_id)
    if not path.exists():
        raise SearchError('no-database', f'No RemNote database for knowledge base {kb_id}.')
    db = history_archive.open_remnote(path)
    check_schema(db)
    return db


def check_schema(db):
    """RemNote changed its storage before; fail clearly instead of returning nonsense."""
    for table, cols in REQUIRED.items():
        have = {row[1] for row in db.execute(f'PRAGMA table_info({table})')}
        if not have:
            raise SearchError('schema', f'RemNote\'s search index has changed (no table {table}).')
        missing = cols - have
        if missing:
            raise SearchError('schema', f'RemNote\'s search index has changed ({table} lacks {", ".join(sorted(missing))}).')


def resolve_rem(db, key, value, at):
    """A Rem id, from an id or an exact name. A name shared by several Rems is resolved
    to the only document or folder among them; otherwise it's an error listing them."""
    if REM_ID_RE.match(value):
        row = db.execute('SELECT id, ancestor_ids FROM remsSearchInfos WHERE id = ? LIMIT 1', (value,)).fetchone()
        if row:
            return row[0], row[1] or ''
    name = fold(value)
    expr = fts_term(value, 'phrase')
    if not expr:
        raise SearchError('not-found', f'No Rem is named "{value}".', at)
    rows = db.execute(
        '''SELECT s.id, s.ancestor_ids, s.ancestor_not_ref_text,
                  json_extract(s.doc, '$.r'), json_extract(s.doc, '$.i'), json_extract(s.doc, '$.l')
           FROM remsSearchInfos s
           WHERE s.ftsRowId IN (SELECT rowid FROM remsContents WHERE remsContents MATCH ?)''',
        (expr,)).fetchall()
    exact = {}
    for rid, anc, path, raw, is_doc, is_folder in rows:
        if fold(raw or '') == name:
            exact.setdefault(rid, (anc or '', fold(path or ''), bool(is_doc) or bool(is_folder)))
    if not exact:
        raise SearchError('not-found', f'No Rem is named exactly "{value}".', at)
    if len(exact) > 1:
        docs = {rid: v for rid, v in exact.items() if v[2]}
        if len(docs) == 1:
            exact = docs
    if len(exact) > 1:
        listed = '; '.join(f'{(v[1] or "(top level)")} [{rid}]' for rid, v in list(exact.items())[:5])
        more = f' and {len(exact) - 5} more' if len(exact) > 5 else ''
        raise SearchError('ambiguous', f'{len(exact)} Rems are named "{value}": {listed}{more}. Use {key}:<id>.', at)
    rid, (anc, _, _) = next(iter(exact.items()))
    return rid, anc


# ---------------------------------------------------------------------------
# Compiler: tree → one SQL condition over remsSearchInfos s (after Anki's sqlwriter.rs)
# ---------------------------------------------------------------------------

FTS_IN = 's.ftsRowId IN (SELECT rowid FROM remsContents WHERE remsContents MATCH ?)'


class Compiler:
    def __init__(self, db):
        self.db = db
        self.args = []
        self.rank_terms = []  # positive text terms, for relevance

    def compile(self, node, negated=False):
        if isinstance(node, And):
            return self.compile_and(node.nodes, negated)
        if isinstance(node, Or):
            return '(' + ' OR '.join(self.compile(n, negated) for n in node.nodes) + ')'
        if isinstance(node, Not):
            return f'NOT ({self.compile(node.node, not negated)})'
        return self.leaf(node, negated)

    def compile_and(self, nodes, negated):
        # Plain text terms ANDed together become ONE MATCH: FTS intersects them itself,
        # much faster than one IN (…) per word.
        merged = [n for n in nodes if isinstance(n, Term) and n.kind == 'text' and not n.alias_only]
        rest = [n for n in nodes if n not in merged]
        parts = []
        if len(merged) > 1:
            exprs = [fts_term(n.value, n.mode) for n in merged]
            self.args.append(' AND '.join(exprs))
            if not negated:
                self.rank_terms.extend(exprs)
            parts.append(FTS_IN)
        else:
            rest = nodes
        parts += [self.compile(n, negated) for n in rest]
        return '(' + ' AND '.join(parts) + ')'

    def leaf(self, term, negated):
        if term.kind == 'text':
            expr = fts_term(term.value, term.mode)
            self.args.append(expr)
            if not negated:
                self.rank_terms.append(expr)
            return f'({FTS_IN} AND s.aliasId <> s.id)' if term.alias_only else FTS_IN
        if term.kind == 'in':
            rid, anc = resolve_rem(self.db, 'in', term.value, term.at)
            prefix = f'{anc} {rid}'
            self.args += [rid, prefix, prefix + '~']
            return '(s.id = ? OR (s.ancestor_ids >= ? AND s.ancestor_ids < ?))'
        if term.kind == 'parent':
            rid, _ = resolve_rem(self.db, 'parent', term.value, term.at)
            self.args.append(rid)
            return "json_extract(s.doc, '$.p') = ?"
        if term.kind == 'path':
            conds = []
            for tok in words(term.value):
                self.args.append(f'% {tok}%')
                conds.append("(' ' || IFNULL(s.ancestor_not_ref_text, '')) LIKE ?")
            return '(' + ' AND '.join(conds) + ')'
        raise SearchError('parse', f'Unknown term {term.kind}.')


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def search(kb_id, query, limit=DEFAULT_LIMIT, db_path=None):
    """{results: [{remId, aliasId?}], total, ms}; raises SearchError."""
    started = time.time()
    tree = parse(query)
    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    db = open_kb(kb_id, db_path)
    try:
        compiler = Compiler(db)
        where = compiler.compile(tree)
        try:
            rows = db.execute(
                f'''SELECT s.id, s.aliasId, s.ftsRowId, IFNULL(r.rank, 1e9)
                    FROM remsSearchInfos s LEFT JOIN remsSearchRanks r ON r.ftsRowId = s.ftsRowId
                    WHERE {where}''',
                compiler.args).fetchall()
        except sqlite3.OperationalError as e:
            raise SearchError('query', f'The search could not run: {e}.') from e

        # One result per Rem. Its own row wins over an alias row; an alias-only match
        # reports which alias, so a reference can be made to show it.
        by_rem = {}
        for rid, alias_id, fts_row, static in rows:
            own = alias_id == rid
            prev = by_rem.get(rid)
            if prev is None or (own and not prev['own']) or (own == prev['own'] and static < prev['static']):
                by_rem[rid] = {'own': own, 'alias': None if own else alias_id, 'row': fts_row, 'static': static}

        # Relevance: score every row the positive words match and keep the result rows.
        # Asking FTS for scores of a list of rowids is ~300× slower than this (measured:
        # 600 ms vs 2 ms for 505 rows; a one-letter word scores 159k rows in 92 ms).
        relevance = {}
        if compiler.rank_terms and rows:
            match = ' OR '.join(dict.fromkeys(compiler.rank_terms))
            wanted = {v['row'] for v in by_rem.values()}
            for row_id, score in db.execute(
                    'SELECT rowid, bm25(remsContents) FROM remsContents WHERE remsContents MATCH ?', (match,)):
                if row_id in wanted:
                    relevance[row_id] = score
        ordered = sorted(by_rem.items(), key=lambda kv: (relevance.get(kv[1]['row'], 0.0), kv[1]['static']))
        results = []
        for rid, v in ordered[:limit]:
            item = {'remId': rid}
            if v['alias']:
                item['aliasId'] = v['alias']
            results.append(item)
        return {'results': results, 'total': len(by_rem), 'ms': int((time.time() - started) * 1000)}
    finally:
        db.close()


def main():
    ap = argparse.ArgumentParser(description='Search a RemNote knowledge base with an Anki-style query.')
    ap.add_argument('query')
    ap.add_argument('--kb', required=True, help='knowledge base id (the remnote-<id> folder)')
    ap.add_argument('--db', help='a remnote.db to read instead of the KB\'s own')
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    try:
        out = search(args.kb, args.query, args.limit, args.db)
    except SearchError as e:
        print(json.dumps({'error': e.to_json()}) if args.json else f'error ({e.kind}): {e.message}', file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(out, ensure_ascii=False))
        return 0
    db = open_kb(args.kb, args.db)
    for item in out['results']:
        row = db.execute("SELECT json_extract(doc, '$.r') FROM remsSearchInfos WHERE id = ? AND aliasId = ?",
                         (item['remId'], item.get('aliasId') or item['remId'])).fetchone()
        text = (row[0] if row else '') or ''
        print(f"{item['remId']}{' (alias)' if item.get('aliasId') else ''}  {text[:100]}")
    print(f"{out['total']} Rems in {out['ms']} ms")
    return 0


if __name__ == '__main__':
    sys.exit(main())
