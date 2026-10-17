"""Thunderstorm's file search helper: cursor format, safe full-text terms,
hidden files, the bounded fallback and the recently-used list."""
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest

from gi.repository import GLib

spec = importlib.util.spec_from_file_location('filesearch', Path(__file__).parent.parent / 'helper/filesearch.py')
filesearch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(filesearch)


def cursor(rows):
    """Encode rows the way Tracker's endpoint writes them (types 1 = URI, 2 = string, 0 = unbound)."""
    out, offset = b'', -1
    for row in rows:
        out += struct.pack('=i', len(row))
        out += struct.pack(f'={len(row)}i', *[0 if value is None else 2 for value in row])
        offsets = []
        for value in row:
            offset += len((value or '').encode()) + 1
            offsets.append(offset)
        out += struct.pack(f'={len(row)}i', *offsets)
        for value in row:
            out += (value or '').encode() + b'\0'
    return out


class NoBus:
    """A session bus without LocalSearch."""
    def call_sync(self, *args):
        raise GLib.Error('no bus')


class FileSearchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'Dokumente' / 'Projekte').mkdir(parents=True)
        (self.root / '.versteckt').mkdir()
        for name in ('Dokumente/Rechnung März.pdf', 'Dokumente/Projekte/rechnung-2026.odt', '.versteckt/rechnung geheim.txt', 'Notizen.txt'):
            (self.root / name).write_text('x')
        self.searcher = filesearch.Searcher(bus=NoBus(), names=('org.notchy.None',))
        self.searcher.home = str(self.root)
        self.searcher.fallback_roots = lambda extra=(): [str(self.root / 'Dokumente')]

    def tearDown(self):
        self.temp.cleanup()

    def test_cursor_rows_including_unbound_values(self):
        rows = [['file:///tmp/a%20b.txt', 'a b.txt'], ['file:///tmp/ü', None]]
        self.assertEqual(filesearch.parse_cursor(cursor(rows)), rows)
        self.assertEqual(filesearch.parse_cursor(b''), [])
        with self.assertRaises(ValueError):
            filesearch.parse_cursor(struct.pack('=i', 999))

    def test_fts_terms_are_plain_prefixes(self):
        self.assertEqual(filesearch.fts_terms('Rechnung März'), 'rechnung* marz*')
        self.assertEqual(filesearch.fts_terms('"a" OR b* NEAR(c) -d'), 'a* or* b* near* c* d*')
        self.assertEqual(filesearch.fts_terms('} ; DROP'), 'drop*')
        self.assertEqual(filesearch.fts_terms('x'), '')
        self.assertEqual(filesearch.fts_terms('!!!'), '')

    def test_fallback_finds_names_without_hidden_files(self):
        reply = self.searcher.search('rechnung', 10)
        self.assertEqual(reply['backend'], 'fallback')
        names = [result['name'] for result in reply['results']]
        self.assertEqual(set(names), {'Rechnung März.pdf', 'rechnung-2026.odt'})
        first = reply['results'][0]
        self.assertTrue(first['readable'] and not first['dir'] and first['uri'].startswith('file:///'))
        self.assertEqual(self.searcher.search('marz', 10)['results'][0]['name'], 'Rechnung März.pdf')
        folders = self.searcher.search('projekte', 10)['results']
        self.assertTrue(folders[0]['dir'] and folders[0]['mime'] == 'inode/directory')

    def test_hidden_files_only_when_asked(self):
        self.searcher.fallback_roots = lambda extra=(): [str(self.root / 'Dokumente'), str(self.root / '.versteckt')]
        self.assertNotIn('rechnung geheim.txt', [r['name'] for r in self.searcher.search('geheim', 10)['results']])
        self.searcher.fallback = None
        self.assertIn('rechnung geheim.txt', [r['name'] for r in self.searcher.search('geheim', 10, hidden=True)['results']])

    def test_vanished_files_are_dropped_and_unreadable_ones_flagged(self):
        self.searcher.search('rechnung', 10)
        (self.root / 'Dokumente/Rechnung März.pdf').unlink()
        self.assertEqual([r['name'] for r in self.searcher.search('rechnung', 10)['results']], ['rechnung-2026.odt'])
        locked = self.root / 'Dokumente' / 'Projekte'
        os.chmod(locked, 0)
        try:
            meta = filesearch.describe(str(locked))
            if os.geteuid() != 0:
                self.assertFalse(meta['readable'])
        finally:
            os.chmod(locked, 0o755)

    def test_recently_used(self):
        data = self.root / 'data'
        data.mkdir()
        target = self.root / 'Notizen.txt'
        (data / 'recently-used.xbel').write_text(f'''<?xml version="1.0"?><xbel version="1.0">
            <bookmark href="{target.as_uri()}" visited="2026-10-17T10:00:00Z"/>
            <bookmark href="file:///nonexistent/gone.txt" visited="2026-10-17T11:00:00Z"/>
            <bookmark href="https://example.com" visited="2026-10-17T12:00:00Z"/></xbel>''')
        original = filesearch.GLib.get_user_data_dir
        filesearch.GLib.get_user_data_dir = lambda: str(data)
        try:
            self.assertEqual([r['name'] for r in self.searcher.recent(5)['results']], ['Notizen.txt'])
        finally:
            filesearch.GLib.get_user_data_dir = original

    def test_protocol_answers_each_request_and_supersedes_stale_searches(self):
        lines = '\n'.join(json.dumps(r) for r in [{'id': 1, 'op': 'search', 'query': 'rech'}, {'id': 2, 'op': 'search', 'query': 'rechnung'}, {'id': 3, 'op': 'bogus'}]) + '\n'
        out = io.StringIO()
        original = filesearch.Searcher
        searcher = self.searcher
        filesearch.Searcher = lambda: searcher
        try:
            filesearch.serve(io.StringIO(lines), out)
        finally:
            filesearch.Searcher = original
        replies = {r['id']: r for r in map(json.loads, out.getvalue().splitlines())}
        self.assertEqual(set(replies), {1, 2, 3})
        # The first search either ran or was superseded by the second, never lost.
        self.assertTrue(replies[1].get('superseded') or 'results' in replies[1])
        self.assertEqual(len(replies[2]['results']), 2)
        self.assertEqual(replies[3]['error'], 'unknown request')


if __name__ == '__main__':
    unittest.main()
