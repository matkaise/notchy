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


class FailingEndpoint:
    """A LocalSearch endpoint whose Query call fails every time."""
    def call_sync(self, *args):
        return GLib.Variant('(b)', (True,))

    def call_with_unix_fd_list_sync(self, *args):
        raise GLib.Error('Timeout was reached')


class ResourceTest(unittest.TestCase):
    def open_fds(self):
        return len(os.listdir('/proc/self/fd'))

    def test_failed_queries_close_every_descriptor(self):
        searcher = filesearch.Searcher(bus=FailingEndpoint(), names=('org.notchy.Failing',))
        searcher.fallback_entries = lambda extra=(): []
        before = self.open_fds()
        for _ in range(200):
            with self.assertRaises(GLib.Error):
                searcher.query('org.notchy.Failing', 'bericht*')
            reply = searcher.search('bericht')
            self.assertEqual(reply['backend'], 'fallback')
            self.assertIn('Timeout', reply['error'])
        self.assertLessEqual(self.open_fds(), before + 1, 'no file descriptor leaks over 400 failed index queries')
        searcher.pool.shutdown()

    def test_a_hanging_drive_neither_blocks_nor_exhausts_the_search(self):
        import threading
        release = threading.Event()
        with tempfile.TemporaryDirectory() as temp:
            stuck_dir, fine_dir = Path(temp) / 'netz', Path(temp) / 'lokal'
            stuck_dir.mkdir(); fine_dir.mkdir()
            for i in range(12):
                (stuck_dir / f'bericht {i}.txt').write_text('x')
            (fine_dir / 'bericht lokal.txt').write_text('x')
            searcher = filesearch.Searcher(bus=NoBus(), names=('org.notchy.None',))
            searcher.fallback_entries = lambda extra=(): [(str(p), p.name, False) for p in [*stuck_dir.iterdir(), *fine_dir.iterdir()]]
            real_describe, real_mounts = filesearch.describe, filesearch.mount_points
            filesearch.describe = lambda path: (release.wait(10), real_describe(path))[1] if '/netz/' in path else real_describe(path)
            filesearch.mount_points = lambda: [str(stuck_dir), '/']
            try:
                first = searcher.search('bericht')
                self.assertEqual([r['name'] for r in first['results']], ['bericht lokal.txt'], 'the answering drive is listed despite the hanging one')
                self.assertIn(str(stuck_dir), searcher.slow_mounts)
                again = searcher.search('bericht')
                self.assertEqual([r['name'] for r in again['results']], ['bericht lokal.txt'])
                self.assertEqual(len(searcher.stuck), 1, 'only one probe waits on the hanging drive; it is not asked again while known to be slow')
                for _ in range(10):
                    searcher.slow_mounts.clear()
                    third = searcher.search('bericht')
                self.assertEqual([r['name'] for r in third['results']], ['bericht lokal.txt'], 'a pool whose workers all hang is replaced')
                self.assertLess(len(searcher.stuck), 8)
            finally:
                release.set(); filesearch.describe, filesearch.mount_points = real_describe, real_mounts
                searcher.pool.shutdown()

    def test_mount_lookup_reads_text_only(self):
        mounts = ['/home/a/net', '/home', '/']
        self.assertEqual(filesearch.mount_of('/home/a/net/x.txt', mounts), '/home/a/net')
        self.assertEqual(filesearch.mount_of('/home/a/network.txt', mounts), '/home')
        self.assertEqual(filesearch.mount_of('/etc/x', mounts), '/')
        self.assertIn('/', filesearch.mount_points())
