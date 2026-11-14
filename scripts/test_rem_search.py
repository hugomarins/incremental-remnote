#!/usr/bin/env python3
"""Tests for rem_search.py: the parser, and searches on a small fake remnote.db shaped like
RemNote's search index (remsContents FTS5, remsSearchInfos, remsSearchRanks).

    python3 scripts/test_rem_search.py
"""
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rem_search as rs  # noqa: E402
from rem_search import And, Not, Or, SearchError, Term  # noqa: E402

KB = '0123456789abcdef01234567'


def ids(n):
    """A 17-character Rem id."""
    return f'{n:0>17}'


ROOT, BOOK, BOW, FLARE, MARGIN, OTHER, ARCHIVE, DUP1, DUP2 = (ids(f'R{i}') for i in range(9))

# id, aliasId, parent, ancestors (root first), indexed text, raw text, is document
ROWS = [
    (ROOT, ROOT, None, [], 'pscpp', 'pscpp', True),
    (BOOK, BOOK, ROOT, [ROOT], 'wartsila encyclopedia of ship technology', 'wartsila encyclopedia of ship technology', True),
    (BOW, BOW, BOOK, [ROOT, BOOK], 'bow flare', 'bow flare', False),
    # A reference is indexed at the END: "[sea margin] becomes useless" → "… becomes useless … sea margin".
    (FLARE, FLARE, BOW, [ROOT, BOOK, BOW],
     'ships with an excessive bow flare are exposed to higher sea loads . becomes useless in heavy weather due to wave impact . sea margin',
     'ships with an excessive bow flare are exposed to higher sea loads. sea margin becomes useless in heavy weather due to wave impact.',
     False),
    (MARGIN, MARGIN, ROOT, [ROOT], 'service power margin margem de seguranca', 'service power margin', False),
    (MARGIN, ids('ALIAS'), ROOT, [ROOT], 'sea margin margem de seguranca', 'sea margin', False),
    (OTHER, OTHER, ROOT, [ROOT], 'the tug pushes the bow in heavy weather', 'the tug pushes the bow in heavy weather', False),
    (ARCHIVE, ARCHIVE, None, [], 'archive', 'archive', True),
    (DUP1, DUP1, ROOT, [ROOT], 'notes', 'notes', False),
    (DUP2, DUP2, ARCHIVE, [ARCHIVE], 'notes', 'notes', False),
]


def make_db(path):
    db = sqlite3.connect(path)
    db.executescript('''
        CREATE VIRTUAL TABLE remsContents USING FTS5(data, tokenize = 'unicode61', prefix = '1 2 3');
        CREATE TABLE remsSearchInfos(ftsRowId INTEGER PRIMARY KEY AUTOINCREMENT, aliasId TEXT NOT NULL,
            id TEXT NOT NULL, doc TEXT NOT NULL, freqCounter REAL NOT NULL, freqTime REAL NOT NULL,
            ancestor_not_ref_text, ancestor_ref_text, ancestor_ids);
        CREATE TABLE remsSearchRanks(ftsRowId INTEGER PRIMARY KEY, rank REAL);
    ''')
    names = {r[0]: r[5] for r in ROWS if r[0] == r[1]}
    for n, (rid, alias, parent, anc, text, raw, is_doc) in enumerate(ROWS, start=1):
        doc = {'_id': rid, 'a': alias, 'p': parent, 'r': raw, 'i': is_doc, 'l': False}
        db.execute('INSERT INTO remsSearchInfos VALUES (?,?,?,?,0,0,?,?,?)',
                   (n, alias, rid, json.dumps(doc), '  ' + '  '.join(names[a] for a in anc), '',
                    ' ' + ''.join(f' {a}' for a in anc)))
        db.execute('INSERT INTO remsContents(rowid, data) VALUES (?, ?)', (n, text))
        db.execute('INSERT INTO remsSearchRanks VALUES (?, ?)', (n, n * 10))
    db.commit()
    db.close()


class ParserTest(unittest.TestCase):
    def test_implicit_and_and_precedence(self):
        tree = rs.parse('dog cat or mouse')
        self.assertIsInstance(tree, Or)
        self.assertIsInstance(tree.nodes[0], And)
        self.assertEqual([t.value for t in tree.nodes[0].nodes], ['dog', 'cat'])
        self.assertEqual(tree.nodes[1].value, 'mouse')

    def test_groups_negation_and_explicit_and(self):
        tree = rs.parse('dog AND -(cat or mouse)')
        self.assertIsInstance(tree, And)
        self.assertIsInstance(tree.nodes[1], Not)
        self.assertIsInstance(tree.nodes[1].node, Or)

    def test_terms(self):
        self.assertEqual(rs.parse('"bow flare"'), Term('text', 'bow flare', mode='phrase', at=0))
        self.assertEqual(rs.parse('w:bow').mode, 'word')
        self.assertTrue(rs.parse('alias:"sea margin"').alias_only)
        self.assertEqual(rs.parse('in:"Wärtsilä Encyclopedia"'), Term('in', 'Wärtsilä Encyclopedia', at=0))
        self.assertEqual(rs.parse('path:pscpp').kind, 'path')

    def test_unknown_key_is_text(self):
        self.assertEqual(rs.parse('3:30'), Term('text', '3:30', at=0))
        self.assertEqual(rs.parse('Note:').kind, 'text')

    def test_escapes(self):
        self.assertEqual(rs.parse(r'\-free').value, '-free')
        self.assertEqual(rs.parse(r'"a \"quoted\" word"').value, 'a "quoted" word')

    def test_errors(self):
        cases = {
            '': 'empty', 'bow (': 'unclosed-group', 'bow )': 'unopened-group', '()': 'empty-group',
            '"bow': 'unclosed-quote', 'or bow': 'misplaced-or', 'bow and': 'misplaced-and',
            '- bow': 'lone-minus', 'tag:x': 'not-yet', 'incremental.priority:3': 'not-yet',
            'in:': 'missing-value', '...': 'no-words', 'bow\\': 'unknown-escape',
        }
        for query, kind in cases.items():
            with self.subTest(query=query):
                with self.assertRaises(SearchError) as ctx:
                    rs.parse(query)
                self.assertEqual(ctx.exception.kind, kind)

    def test_error_position(self):
        with self.assertRaises(SearchError) as ctx:
            rs.parse('bow (wave')
        self.assertEqual(ctx.exception.at, 4)

    def test_fts_terms_are_quoted(self):
        self.assertEqual(rs.fts_term('Navegação', 'prefix'), '"navegacao"*')
        self.assertEqual(rs.fts_term('under-keel', 'prefix'), '"under keel"*')
        self.assertEqual(rs.fts_term('NEAR OR', 'phrase'), '"near or"')


class SearchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = Path(cls.tmp.name) / 'remnote.db'
        make_db(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def find(self, query, **kw):
        out = rs.search(KB, query, db_path=self.db, **kw)
        return [(r['remId'], r.get('aliasId')) for r in out['results']]

    def rems(self, query):
        return {rid for rid, _ in self.find(query)}

    def test_and_finds_what_or_buries(self):
        self.assertEqual(self.rems('bow weather wave'), {FLARE})

    def test_words_around_a_reference(self):
        # The phrase is broken by the reference, but the words are all there.
        self.assertEqual(self.rems('sea margin becomes'), {FLARE})

    def test_or_not_groups(self):
        self.assertEqual(self.rems('bow weather'), {FLARE, OTHER})
        self.assertEqual(self.rems('bow weather -tug'), {FLARE})
        self.assertEqual(self.rems('tug or "service power"'), {OTHER, MARGIN})
        self.assertEqual(self.rems('heavy -(tug or wave)'), set())

    def test_prefix_phrase_word(self):
        self.assertEqual(self.rems('excess'), {FLARE})
        self.assertEqual(self.rems('w:excess'), set())
        self.assertEqual(self.rems('"bow flare"'), {BOW, FLARE})

    def test_alias(self):
        self.assertEqual(self.find('alias:"sea margin"'), [(MARGIN, ids('ALIAS'))])
        # Its own row wins over the alias row, so no aliasId then.
        self.assertIn((MARGIN, None), self.find('margem'))

    def test_scopes(self):
        self.assertEqual(self.rems('in:"Wärtsilä Encyclopedia of Ship Technology" bow'), {BOW, FLARE})
        self.assertEqual(self.rems(f'in:{BOOK} bow'), {BOW, FLARE})
        self.assertEqual(self.rems('bow -in:"Wartsila encyclopedia of ship technology"'), {OTHER})
        self.assertEqual(self.rems('parent:"bow flare"'), {FLARE})
        self.assertEqual(self.rems('path:wartsila sea'), {FLARE})

    def test_name_resolution(self):
        with self.assertRaises(SearchError) as ctx:
            rs.search(KB, 'in:notes', db_path=self.db)
        self.assertEqual(ctx.exception.kind, 'ambiguous')
        with self.assertRaises(SearchError) as ctx:
            rs.search(KB, 'in:"no such thing"', db_path=self.db)
        self.assertEqual(ctx.exception.kind, 'not-found')

    def test_relevance_then_rank(self):
        # Both match "bow"; the short title is the better text match.
        self.assertEqual(self.find('bow', limit=1)[0][0], BOW)

    def test_limit_and_total(self):
        out = rs.search(KB, 'bow', limit=1, db_path=self.db)
        self.assertEqual(len(out['results']), 1)
        self.assertEqual(out['total'], 3)

    def test_schema_change_is_reported(self):
        bad = Path(self.tmp.name) / 'bad.db'
        sqlite3.connect(bad).execute('CREATE TABLE remsSearchInfos(id TEXT)').connection.commit()
        with self.assertRaises(SearchError) as ctx:
            rs.search(KB, 'bow', db_path=bad)
        self.assertEqual(ctx.exception.kind, 'schema')


if __name__ == '__main__':
    unittest.main()
