#!/usr/bin/python3
"""File search for Thunderstorm, outside the Shell process.

The primary source is GNOME LocalSearch's file index (Tracker 3), queried over
its D-Bus SPARQL endpoint; the search term is a bound parameter, never part of
the query text. Without a running indexer a bounded crawl of the personal
folders stands in. Nothing is ever started, installed or indexed by Notchy.

Protocol: one JSON request per line on stdin, one JSON reply per line on stdout.
  {"id": 1, "op": "search", "query": "rech", "limit": 40, "hidden": false}
  {"id": 2, "op": "status"}
  {"id": 3, "op": "recent", "limit": 8}
A search superseded by a newer one before it ran is answered with
{"id": n, "superseded": true}.
"""
from concurrent.futures import ThreadPoolExecutor, wait
import json
import os
from pathlib import Path
import queue
import re
import select
import stat
import struct
import sys
import threading
import time
import unicodedata
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree

from gi.repository import Gio, GLib

ENDPOINT_PATH = '/org/freedesktop/Tracker3/Endpoint'
ENDPOINT_IFACE = 'org.freedesktop.Tracker3.Endpoint'
# LocalSearch 3.8+ and the older Tracker 3 miner name.
BUS_NAMES = ('org.freedesktop.LocalSearch3', 'org.freedesktop.Tracker3.Miner.Files')
MINER_SCHEMA = 'org.freedesktop.Tracker3.Miner.Files'
# Name matches only (nfo:fileName exists on files and folders, not on content).
SPARQL = 'SELECT ?url ?name WHERE { ?s fts:match ~match ; nie:url ?url ; nfo:fileName ?name } LIMIT 200'
CANDIDATES = 60
STAT_TIMEOUT = 0.8
POOL_SIZE = 8
# A drive whose files did not answer in time is skipped for this long.
SLOW_MOUNT_TTL = 60
FALLBACK_MAX_ENTRIES = 40000
FALLBACK_DEPTH = 5
FALLBACK_BUDGET = 4.0
FALLBACK_TTL = 300
XDG_DIRS = ('DIRECTORY_DESKTOP', 'DIRECTORY_DOCUMENTS', 'DIRECTORY_DOWNLOAD', 'DIRECTORY_MUSIC',
            'DIRECTORY_PICTURES', 'DIRECTORY_VIDEOS', 'DIRECTORY_PUBLIC_SHARE', 'DIRECTORY_TEMPLATES')
# Tracker's value types (TrackerSparqlValueType); 0 is an unbound variable.
UNBOUND = 0


def fold(text):
    """Lower case without diacritics, so "muller" finds "Müller"."""
    text = unicodedata.normalize('NFKD', text.casefold())
    return ''.join(ch for ch in text if not unicodedata.combining(ch))


def tokens(query):
    return [token[:40] for token in re.findall(r'\w+', fold(query))][:6]


def fts_terms(query):
    """A full-text expression safe for FTS5: plain word prefixes only, so quotes,
    operators (NEAR, AND, -) or column filters in the input mean nothing."""
    words = tokens(query)
    if not words or sum(len(word) for word in words) < 2:
        return ''
    return ' '.join(f'{word}*' for word in words)


def parse_cursor(data):
    """Rows written by Tracker's D-Bus endpoint: per row an int32 column count,
    the value types, end offsets, then each value as a NUL-terminated string
    (host byte order)."""
    rows, at = [], 0
    while at + 4 <= len(data):
        (columns,) = struct.unpack_from('=i', data, at)
        at += 4
        if columns < 0 or columns > 64:
            raise ValueError('invalid cursor')
        types = struct.unpack_from(f'={columns}i', data, at)
        at += 8 * columns  # types and offsets
        values = []
        for kind in types:
            end = data.index(b'\0', at)
            text = data[at:end].decode('utf-8', 'replace')
            at = end + 1
            values.append(None if kind == UNBOUND else text)
        rows.append(values)
    return rows


def is_hidden(path, roots=()):
    parts = Path(path).parts
    return any(part.startswith('.') and part not in ('.', '..') for part in parts[1:])


def coarse_score(name, words, query):
    """Pre-ranking before the Shell's own scoring: keeps the best candidates
    when the index returns many."""
    folded = fold(name)
    stem = folded.rsplit('.', 1)[0]
    joined = ' '.join(words)
    if folded == fold(query).strip() or stem == joined:
        return 4
    if folded.startswith(joined):
        return 3
    if all(word in folded for word in words):
        return 2 if any(re.search(rf'(^|[\W_]){re.escape(word)}', folded) for word in words) else 1
    return 0


def mount_points(path='/proc/self/mounts'):
    """Mount points from the kernel's table, longest first; read as text, so a
    hanging network drive is never touched to find out where it is."""
    try:
        with open(path, encoding='utf-8', errors='replace') as table:
            points = [line.split()[1].replace('\\040', ' ') for line in table if len(line.split()) > 1]
    except OSError:
        points = ['/']
    return sorted(set(points), key=len, reverse=True)


def mount_of(path, mounts):
    for point in mounts:
        if path == point or path.startswith(point.rstrip('/') + '/'):
            return point
    return '/'


def describe(path):
    """Metadata for one candidate; None when it is gone (stale index entry,
    unmounted drive). Permission problems are reported, not hidden."""
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return None
    except PermissionError:
        return {'readable': False, 'dir': False, 'mtime': 0, 'size': 0}
    except OSError:
        return None
    is_dir = stat.S_ISDIR(info.st_mode)
    return {'readable': os.access(path, os.R_OK | (os.X_OK if is_dir else 0)), 'dir': is_dir,
            'mtime': int(info.st_mtime), 'size': info.st_size if not is_dir else 0}


class Searcher:
    def __init__(self, bus=None, names=None):
        self.bus = bus or Gio.bus_get_sync(Gio.BusType.SESSION, None)
        override = os.environ.get('NOTCHY_LOCALSEARCH_NAME')
        self.names = names or ((override,) if override else BUS_NAMES)
        self.pool = ThreadPoolExecutor(max_workers=POOL_SIZE)
        # Checks still running after their deadline (a network drive that does
        # not answer), and mount points that timed out recently.
        self.stuck = set()
        self.slow_mounts = {}
        self.fallback = None
        self.fallback_at = 0
        self.fallback_lock = threading.Lock()
        self.fallback_building = False
        self.home = GLib.get_home_dir()

    # LocalSearch ---------------------------------------------------------------
    def endpoint(self):
        for name in self.names:
            try:
                reply = self.bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
                                           GLib.Variant('(s)', (name,)), GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, 1000, None)
                if reply.unpack()[0]:
                    return name
            except GLib.Error:
                pass
        return None

    def query(self, name, terms):
        # Every descriptor is closed on every path: a failing call (endpoint
        # gone, timeout, too many open files) must not leak the pipe's read end,
        # or repeated failures exhaust the helper's descriptors.
        read, write = os.pipe()
        try:
            fds = Gio.UnixFDList.new()
            try:
                index = fds.append(write)
            finally:
                os.close(write)
            try:
                self.bus.call_with_unix_fd_list_sync(name, ENDPOINT_PATH, ENDPOINT_IFACE, 'Query',
                                                     GLib.Variant('(sha{sv})', (SPARQL, index, {'match': GLib.Variant('s', terms)})),
                                                     GLib.VariantType('(as)'), Gio.DBusCallFlags.NO_AUTO_START, 4000, fds, None)
            finally:
                # Our copy of the write end must go, or the read never ends.
                for fd in fds.steal_fds():
                    os.close(fd)
        except BaseException:
            os.close(read)
            raise
        # A misbehaving endpoint never wedges the helper: the cursor must
        # arrive within the deadline.
        chunks, deadline = [], time.monotonic() + 5
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([read], [], [], remaining)[0]:
                    raise OSError('LocalSearch antwortet nicht')
                chunk = os.read(read, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            os.close(read)
        return parse_cursor(b''.join(chunks))

    # Fallback ------------------------------------------------------------------
    def fallback_roots(self, extra=()):
        # The headless test confines the simple search to its own fixtures.
        if os.environ.get('NOTCHY_FALLBACK_ROOTS'):
            return [folder for folder in os.environ['NOTCHY_FALLBACK_ROOTS'].split(':') if os.path.isdir(folder)]
        roots = []
        for key in XDG_DIRS:
            folder = GLib.get_user_special_dir(getattr(GLib.UserDirectory, key))
            if folder and os.path.isdir(folder) and os.path.realpath(folder) != os.path.realpath(self.home):
                roots.append(folder)
        roots += [folder for folder in extra if os.path.isdir(folder)]
        return list(dict.fromkeys(roots))

    def crawl(self, roots):
        """A bounded walk: personal folders only, no hidden or linked folders,
        a fixed depth, entry count and time budget."""
        entries, started = [], time.monotonic()
        try:
            if os.environ.get('NOTCHY_FALLBACK_ROOTS'):
                raise OSError('confined')
            with os.scandir(self.home) as top:
                for entry in top:
                    if not entry.name.startswith('.'):
                        entries.append((entry.path, entry.name, entry.is_dir(follow_symlinks=False)))
        except OSError:
            pass
        stack = [(root, 0) for root in roots]
        while stack and len(entries) < FALLBACK_MAX_ENTRIES and time.monotonic() - started < FALLBACK_BUDGET:
            folder, depth = stack.pop()
            try:
                with os.scandir(folder) as listing:
                    for entry in listing:
                        if entry.name.startswith('.'):
                            continue
                        is_dir = entry.is_dir(follow_symlinks=False)
                        entries.append((entry.path, entry.name, is_dir))
                        if is_dir and depth < FALLBACK_DEPTH:
                            stack.append((entry.path, depth + 1))
            except OSError:
                continue
        return list({path: (path, name, is_dir) for path, name, is_dir in entries}.values())

    def fallback_entries(self, extra=()):
        with self.fallback_lock:
            fresh = self.fallback is not None and time.monotonic() - self.fallback_at < FALLBACK_TTL
            if fresh or (self.fallback is not None and self.fallback_building):
                return self.fallback
            if self.fallback is not None:
                # Stale: answer from the old list while a new one is built.
                self.fallback_building = True
                threading.Thread(target=self.rebuild, args=(extra,), daemon=True).start()
                return self.fallback
        self.rebuild(extra)
        return self.fallback

    def rebuild(self, extra=()):
        entries = self.crawl(self.fallback_roots(extra))
        with self.fallback_lock:
            self.fallback, self.fallback_at, self.fallback_building = entries, time.monotonic(), False

    # Requests ------------------------------------------------------------------
    def search(self, query, limit=40, hidden=False, extra=()):
        words = tokens(query)
        terms = fts_terms(query)
        if not terms:
            return {'backend': 'none', 'results': []}
        show_hidden = hidden or query.strip().startswith('.')
        name = self.endpoint()
        backend, candidates, error = 'localsearch', [], ''
        if name:
            try:
                for url, filename in self.query(name, terms):
                    if url and url.startswith('file://') and filename:
                        candidates.append((unquote(urlparse(url).path), filename))
            except (GLib.Error, ValueError, OSError) as failure:
                error = str(failure)
                name = None
        if not name:
            backend = 'fallback'
            candidates = [(path, filename) for path, filename, _dir in self.fallback_entries(extra)
                          if all(word in fold(filename) for word in words)]
        seen, ranked = set(), []
        for path, filename in candidates:
            if path in seen or (not show_hidden and is_hidden(path)):
                continue
            seen.add(path)
            ranked.append((coarse_score(filename, words, query), -path.count('/'), path, filename))
        ranked.sort(reverse=True)
        ranked = ranked[:max(limit, CANDIDATES)]
        # Files on a drive that timed out recently are not touched again for a
        # while; a pool whose workers all hang is replaced, so a stuck mount
        # never blocks the searches that follow (its threads end on their own).
        now = time.monotonic()
        self.slow_mounts = {mount: until for mount, until in self.slow_mounts.items() if until > now}
        self.stuck = {future for future in self.stuck if not future.done()}
        if len(self.stuck) >= POOL_SIZE:
            self.pool.shutdown(wait=False, cancel_futures=True)
            self.pool, self.stuck = ThreadPoolExecutor(max_workers=POOL_SIZE), set()
        mounts = mount_points()
        ranked = [entry for entry in ranked if mount_of(entry[2], mounts) not in self.slow_mounts]
        # One probe per drive first: a drive that does not answer costs one
        # worker, not all of them, and its other files are not asked at all.
        by_mount = {}
        for entry in ranked:
            by_mount.setdefault(mount_of(entry[2], mounts), []).append(entry)
        deadline = time.monotonic() + STAT_TIMEOUT
        futures = {self.pool.submit(describe, entries[0][2]): (entries[0][2], entries[0][3]) for entries in by_mount.values()}
        done, pending = wait(futures, timeout=STAT_TIMEOUT / 2)
        slow = set()
        for future in pending:
            mount = mount_of(futures[future][0], mounts)
            slow.add(mount); self.stuck.add(future); self.slow_mounts[mount] = now + SLOW_MOUNT_TTL
        for mount, entries in by_mount.items():
            if mount not in slow:
                futures.update({self.pool.submit(describe, path): (path, filename) for _score, _depth, path, filename in entries[1:]})
        done, pending = wait(futures, timeout=max(0, deadline - time.monotonic()))
        for future in pending:
            self.stuck.add(future)
            self.slow_mounts[mount_of(futures[future][0], mounts)] = now + SLOW_MOUNT_TTL
        # Results keep the ranking order.
        order = {path: i for i, (_s, _d, path, _f) in enumerate(ranked)}
        futures = dict(sorted(futures.items(), key=lambda item: order.get(item[1][0], 0)))
        results = []
        for future in futures:
            if future not in done:
                continue  # A drive that does not answer in time.
            meta = future.result()
            if meta is None:
                continue
            path, filename = futures[future]
            mime = 'inode/directory' if meta['dir'] else (Gio.content_type_guess(filename, None)[0] or 'application/octet-stream')
            results.append({'uri': GLib.filename_to_uri(path, None), 'path': path, 'name': filename, 'mime': mime,
                            'hidden': is_hidden(path), **meta})
        reply = {'backend': backend, 'results': results[:limit]}
        if error:
            reply['error'] = error
        return reply

    def status(self, extra=()):
        name = self.endpoint()
        indexed, single = [], []
        source = Gio.SettingsSchemaSource.get_default()
        if source and source.lookup(MINER_SCHEMA, True):
            settings = Gio.Settings.new(MINER_SCHEMA)
            indexed = [expand(path) for path in settings.get_strv('index-recursive-directories')]
            single = [expand(path) for path in settings.get_strv('index-single-directories')]
        return {'backend': 'localsearch' if name else 'fallback', 'service': name or '', 'indexed': [p for p in indexed if p],
                'single': [p for p in single if p], 'fallback': self.fallback_roots(extra)}

    def recent(self, limit=8):
        """Recently used files (GTK's shared list), newest first, that still exist."""
        path = Path(GLib.get_user_data_dir()) / 'recently-used.xbel'
        try:
            root = ElementTree.parse(path).getroot()
        except (OSError, ElementTree.ParseError):
            return {'results': []}
        entries = []
        for bookmark in root.iter('bookmark'):
            href = bookmark.get('href', '')
            if not href.startswith('file://'):
                continue
            stamp = bookmark.get('visited') or bookmark.get('modified') or ''
            entries.append((stamp, href))
        entries.sort(reverse=True)
        results = []
        for _stamp, href in entries:
            if len(results) >= limit:
                break
            file_path = unquote(urlparse(href).path)
            if is_hidden(file_path):
                continue
            meta = describe(file_path)
            if meta:
                name = os.path.basename(file_path)
                results.append({'uri': href, 'path': file_path, 'name': name, 'hidden': False,
                                'mime': 'inode/directory' if meta['dir'] else (Gio.content_type_guess(name, None)[0] or 'application/octet-stream'), **meta})
        return {'results': results}


def expand(path):
    """LocalSearch's folder notation: $HOME, &DESKTOP, &DOCUMENTS, … or a path."""
    if path == '$HOME':
        return GLib.get_home_dir()
    if path.startswith('&'):
        key = {'DESKTOP': 'DIRECTORY_DESKTOP', 'DOCUMENTS': 'DIRECTORY_DOCUMENTS', 'DOWNLOAD': 'DIRECTORY_DOWNLOAD', 'MUSIC': 'DIRECTORY_MUSIC',
               'PICTURES': 'DIRECTORY_PICTURES', 'VIDEOS': 'DIRECTORY_VIDEOS', 'PUBLIC_SHARE': 'DIRECTORY_PUBLIC_SHARE', 'TEMPLATES': 'DIRECTORY_TEMPLATES'}.get(path[1:])
        return GLib.get_user_special_dir(getattr(GLib.UserDirectory, key)) if key else ''
    return os.path.expanduser(path.replace('$HOME', GLib.get_home_dir()))


def serve(stdin=sys.stdin, stdout=sys.stdout):
    searcher = Searcher()
    requests = queue.Queue()

    def reader():
        for line in stdin:
            try:
                requests.put(json.loads(line))
            except json.JSONDecodeError:
                continue
        requests.put(None)
    threading.Thread(target=reader, daemon=True).start()

    def reply(message):
        stdout.write(json.dumps(message, ensure_ascii=False) + '\n')
        stdout.flush()

    while True:
        request = requests.get()
        if request is None:
            break
        # Only the newest search counts; older ones still waiting are answered as superseded.
        if request.get('op') == 'search':
            newer = []
            while True:
                try:
                    newer.append(requests.get_nowait())
                except queue.Empty:
                    break
            searches = [r for r in newer if r and r.get('op') == 'search']
            if searches:
                reply({'id': request.get('id'), 'superseded': True})
                for stale in searches[:-1]:
                    reply({'id': stale.get('id'), 'superseded': True})
                request = searches[-1]
            for other in newer:
                if other is None or other.get('op') != 'search':
                    requests.put(other)
        extra = [str(p) for p in request.get('extra', []) if isinstance(p, str)]
        try:
            if request.get('op') == 'search':
                result = searcher.search(str(request.get('query', ''))[:200], int(request.get('limit', 40)), bool(request.get('hidden')), extra)
            elif request.get('op') == 'status':
                result = searcher.status(extra)
            elif request.get('op') == 'recent':
                result = searcher.recent(int(request.get('limit', 8)))
            else:
                result = {'error': 'unknown request'}
        except Exception as failure:  # Never let one request end the helper.
            result = {'error': str(failure), 'results': []}
        reply({'id': request.get('id'), **result})


if __name__ == '__main__':
    serve()
    # Leave at once: a check still hanging on a network drive would otherwise
    # keep the interpreter waiting for its worker thread at exit.
    sys.stdout.flush()
    os._exit(0)
