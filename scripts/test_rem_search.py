#!/usr/bin/env python3
"""Tests for rem_search.py and rem_index.py: the parser, and searches on a small fake
remnote.db shaped like RemNote's (the search index remsContents FTS5, remsSearchInfos,
remsSearchRanks, and the Rem documents in quanta).

    python3 scripts/test_rem_search.py
"""
import datetime
import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rem_index as ri  # noqa: E402
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


NOW = int(datetime.datetime.now().timestamp() * 1000)
DAY = 86_400_000
TAG, PW_INC, PW_SRC, PROP_BOOK, PROP_NEXT, CHILD_BOOK, CHILD_NEXT, DAILY_OLD, DAILY_NEW = (
    ids(f'X{i}') for i in range(9))


def slot(text, at, rich=None):
    return {'v': {'v': rich if rich is not None else [text], 's': text}, ',u': at}


def date_name(days_from_today):
    d = datetime.date.today() + datetime.timedelta(days=days_from_today)
    return f"{d.strftime('%B')} {d.day}th, {d.year}"


# Rem documents (quanta), as RemNote stores them.
DOCS = {
    BOOK: {'key': ['Wärtsilä Encyclopedia of Ship Technology'], 'createdAt': NOW - 400 * DAY},
    BOW: {'key': ['Bow flare'], 'type': 1, 'createdAt': NOW - 300 * DAY,
          'tp': {TAG: {'t': True}}},
    FLARE: {'key': ['Ships with … ', {'i': 'q', '_id': MARGIN, 'aliasId': ids('ALIAS')}, ' becomes useless'],
            'createdAt': NOW - 300 * DAY, 'key,u': NOW - 2 * 3600_000,
            'ps': {'os_os': slot('Wärtsilä Encyclopedia of Ship Technology', 1, [{'i': 'q', '_id': BOOK}])}},
    MARGIN: {'key': ['Service power margin'], 'type': 1, 'createdAt': NOW - 3600_000,
             'tp': {PW_INC: {'t': True}},
             # An old `ps` copy of the slot, and a newer one in a property child (below).
             'ps': {'incremental_nextRepDate': slot(date_name(30), NOW - 100 * DAY),
                    'incremental_priority': slot('20', NOW - DAY)}},
    OTHER: {'key': ['The tug pushes the bow'], 'type': 2, 'createdAt': NOW - 500 * DAY, 'tp': {TAG: {'t': False}}},
    TAG: {'key': ['Anki Card'], 'createdAt': 1},
    PW_INC: {'key': ['Incremental'], 'rcrt': 'incremental', 'createdAt': 1},
    PROP_BOOK: {'key': ['Book'], 'parent': TAG, 'createdAt': 1},
    PROP_NEXT: {'key': ['Next Rep Date'], 'parent': PW_INC, 'createdAt': 1},
    CHILD_BOOK: {'key': [{'i': 'q', '_id': PROP_BOOK}], 'value': ['PNA Resistência'], 'ie': True, 'parent': BOW,
                 'createdAt': 1},
    CHILD_NEXT: {'key': [{'i': 'q', '_id': PROP_NEXT}], 'value': [{'i': 'q', '_id': DAILY_OLD}], 'ie': True,
                 'parent': MARGIN, 'createdAt': 1, 'value,u': NOW - 5 * DAY},
    DAILY_OLD: {'key': [date_name(-3)], 'createdAt': 1},
    DAILY_NEW: {'key': [date_name(10)], 'createdAt': 1},
}


def put_doc(db, rid, doc, y):
    db.execute('INSERT OR REPLACE INTO quanta VALUES (?, ?, ?)', (rid, json.dumps({'_id': rid, 'y': y, **doc}), 0))


def make_db(path):
    db = sqlite3.connect(path)
    db.executescript('''
        CREATE TABLE quanta (_id TEXT NOT NULL PRIMARY KEY, doc TEXT, x INTEGER);
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
    for rid, doc in DOCS.items():
        put_doc(db, rid, doc, NOW - 60_000)
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
            '- bow': 'lone-minus', 'is:due': 'not-yet', 'rated:7': 'not-yet', 'is:bogus': 'unknown-value',
            'prop:bogus<3': 'unknown-value', 'has:nothing': 'unknown-value', 'id:short': 'bad-id',
            'added:0': 'bad-number', 'in:': 'missing-value', '...': 'no-words', 'bow\\': 'unknown-escape',
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

    def test_index_terms(self):
        self.assertEqual(rs.parse('tag:"anki card"'), Term('tag', 'anki card', at=0))
        self.assertEqual(rs.parse('"tag:anki card"'), Term('tag', 'anki card', at=0))  # Anki's quoting
        t = rs.parse('incremental.priority<=20')
        self.assertEqual((t.kind, t.owner, t.name, t.op, t.num), ('field', 'incremental', 'priority', '<=', 20.0))
        t = rs.parse('"Anki Card.Book:pna*"')
        self.assertEqual((t.owner, t.name, t.value, t.op), ('ankicard', 'book', 'pna*', ''))
        t = rs.parse('prop:incdue<=0')
        self.assertEqual((t.owner, t.name, t.op, t.num), ('incremental', 'nextrepdate', '<=', 0.0))
        self.assertTrue(rs.needs_index(rs.parse('bow -(tag:x or is:concept)')))
        self.assertFalse(rs.needs_index(rs.parse('bow -(wave or in:x)')))
        self.assertEqual(rs.parse('6.4').kind, 'text')

    def test_fts_terms_are_quoted(self):
        self.assertEqual(rs.fts_term('Navegação', 'prefix'), '"navegacao"*')
        self.assertEqual(rs.fts_term('under-keel', 'prefix'), '"under keel"*')
        self.assertEqual(rs.fts_term('NEAR OR', 'phrase'), '"near or"')


class SearchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = Path(cls.tmp.name) / 'remnote.db'
        cls.index = Path(cls.tmp.name) / 'index.sqlite'
        make_db(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def find(self, query, **kw):
        out = rs.search(KB, query, db_path=self.db, index_file=self.index, **kw)
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



class IndexSearchTest(unittest.TestCase):
    """Terms answered by the helper's own index (rem_index.py)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'remnote.db'
        self.index = Path(self.tmp.name) / 'index.sqlite'
        make_db(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def rems(self, query):
        out = rs.search(KB, query, db_path=self.db, index_file=self.index)
        return {r['remId'] for r in out['results']}

    def test_tags_and_powerups(self):
        self.assertEqual(self.rems('tag:"anki card"'), {BOW})  # OTHER's tag was removed (t: false)
        self.assertEqual(self.rems('tag:anki*'), {BOW})
        self.assertEqual(self.rems('tag:incremental'), {MARGIN})  # a powerup counts as a tag
        self.assertNotIn(BOW, self.rems('tag:none'))
        self.assertIn(OTHER, self.rems('tag:none'))
        self.assertEqual(self.rems('has:powerup:Incremental'), {MARGIN})

    def test_is_and_has(self):
        self.assertEqual(self.rems('is:concept'), {BOW, MARGIN})
        self.assertEqual(self.rems('is:descriptor'), {OTHER})
        self.assertEqual(self.rems('is:document bow'), set())
        self.assertIn(BOOK, self.rems('is:document'))
        self.assertEqual(self.rems('is:incremental'), {MARGIN})
        self.assertEqual(self.rems('has:alias'), {MARGIN})
        self.assertEqual(self.rems('has:source'), {FLARE})
        self.assertEqual(self.rems('has:tag'), {BOW})

    def test_references_and_ids(self):
        self.assertEqual(self.rems('source:"Wärtsilä Encyclopedia of Ship Technology"'), {FLARE})
        self.assertEqual(self.rems('refs:"service power margin"'), {FLARE})
        self.assertEqual(self.rems(f'id:{BOW},{OTHER}'), {BOW, OTHER})

    def test_dates(self):
        self.assertEqual(self.rems('added:1'), {MARGIN})
        self.assertEqual(self.rems('edited:1'), {FLARE})

    def test_properties(self):
        self.assertEqual(self.rems('"anki card.book:pna resistencia"'), {BOW})
        self.assertEqual(self.rems('ankicard.book:pna*'), {BOW})
        self.assertEqual(self.rems('*.book:p_a*'), {BOW})
        self.assertEqual(self.rems('ankicard.book:pna'), set())  # exact unless wildcards
        self.assertEqual(self.rems('ankicard.book:_*'), {BOW})
        self.assertEqual(self.rems('prop:incpriority<=20'), {MARGIN})
        self.assertEqual(self.rems('incremental.priority>20'), set())

    def test_newest_copy_of_a_slot_wins(self):
        # ps says due in 30 days (written 100 days ago); the child says 3 days ago (5 days ago).
        self.assertEqual(self.rems('prop:incdue<=0'), {MARGIN})
        self.assertEqual(self.rems('prop:incdue>0'), set())

    def test_refresh_picks_up_changes(self):
        self.assertEqual(self.rems('prop:incdue<=0'), {MARGIN})
        db = sqlite3.connect(self.db)
        child = dict(DOCS[CHILD_NEXT], value=[{'i': 'q', '_id': DAILY_NEW}], **{'value,u': NOW})
        put_doc(db, CHILD_NEXT, child, NOW)
        put_doc(db, OTHER, dict(DOCS[OTHER], tp={TAG: {'t': True}}), NOW)
        db.commit()
        db.close()
        self.assertEqual(self.rems('prop:incdue>0'), {MARGIN})
        self.assertEqual(self.rems('tag:"anki card"'), {BOW, OTHER})

    def test_text_and_index_terms_together(self):
        self.assertEqual(self.rems('bow is:concept'), {BOW})
        self.assertEqual(self.rems('bow -tag:"anki card"'), {FLARE, OTHER})
        self.assertEqual(self.rems('heavy (tag:incremental or has:source)'), {FLARE})

    def test_helper_never_waits_for_a_build(self):
        with self.assertRaises(SearchError) as ctx:
            rs.search(KB, 'is:concept', db_path=self.db, index_file=self.index, wait=False)
        self.assertEqual(ctx.exception.kind, 'index-building')
        # Text-only searches don't need the index and answer meanwhile.
        self.assertEqual(rs.search(KB, 'bow weather', db_path=self.db, index_file=self.index, wait=False)['total'], 2)
        for _ in range(200):
            if not ri.is_building(KB):
                break
            time.sleep(0.05)
        out = rs.search(KB, 'is:concept', db_path=self.db, index_file=self.index, wait=False)
        self.assertEqual({r['remId'] for r in out['results']}, {BOW, MARGIN})

    def test_index_rebuilds_on_format_change(self):
        self.rems('is:concept')
        db = ri.open_index(KB, self.index)
        ri.set_meta(db, 'schema', 'old')
        db.commit()
        db.close()
        self.assertEqual(self.rems('is:concept'), {BOW, MARGIN})


if __name__ == '__main__':
    unittest.main()
