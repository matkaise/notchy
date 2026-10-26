#!/usr/bin/python3
"""Sharing files with a phone in the same network, by QR code.

    share.py send FILE…                 offer files for download
    share.py receive --folder DIR       accept files from a phone (after asking)

A small web server for one session: the phone scans the QR code Notchy shows,
opens the page in its browser and downloads (or picks files and sends them).
No app, no account, no internet. The session lives as long as Notchy keeps
this process; the link carries a random key and only private-network
addresses are served. Uploads wait for an explicit "Accept" in the notch.

Events go to stdout as JSON lines (Notchy reads them):
    {"event": "waiting"}                         no local network yet (Wi-Fi reconnecting)
    {"event": "ready", "url": …}
    {"event": "progress", "peer": …, "done": bytes, "total": bytes}
    {"event": "sent", "peer": …}                 every file was downloaded once
    {"event": "ask", "id": …, "peer": …, "files": […], "count": n, "size": bytes}
    {"event": "received", "peer": …, "paths": […]}
    {"event": "declined"} / {"event": "expired"} / {"event": "error", "message": …}
Commands come on stdin, one per line: "accept ID", "decline ID", "stop".
"""
import argparse
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote
import zipfile

from i18n import _
import share_page

CHUNK = 256 * 1024
MAX_FILES, MAX_BYTES = 200, 50 * 1024 ** 3
ASK_SECONDS = 60

_out = threading.Lock()


def emit(**event):
    with _out:
        print(json.dumps(event, ensure_ascii=False), flush=True)


def local_address():
    """The address phones in this network reach: the one of the default route (nothing is sent)."""
    override = os.environ.get('NOTCHY_SHARE_ADDRESS')
    if override:
        return override
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(('192.0.2.1', 9))
            address = probe.getsockname()[0]
    except OSError:
        return None
    ip = ipaddress.ip_address(address)
    return address if ip.is_private and not ip.is_loopback else None


def allowed_peer(address):
    """Only the local network (and this computer) may connect, never the internet."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if getattr(ip, 'ipv4_mapped', None):
        ip = ip.ipv4_mapped
    return ip.is_private or ip.is_link_local or ip.is_loopback


def device_name(user_agent):
    """A phone's name as its browser tells it: "Pixel 8", "iPhone", or a plain "Phone"."""
    agent = user_agent or ''
    match = re.search(r'Android [\d.]+; (?:[a-z]{2}[-_][A-Z]{2}; )?([^;)]+?)(?: Build/[^;)]*)?[;)]', agent)
    if match and match.group(1).strip() not in ('K', 'wv', 'Mobile'):
        return match.group(1).strip()[:40]
    for name in ('iPhone', 'iPad', 'Android'):
        if name in agent:
            return name
    return _('Phone')


def safe_name(name):
    """A file name a phone sent, reduced to a plain, harmless base name."""
    base = re.sub(r'[\x00-\x1f\x7f/\\]+', '_', str(name)).strip().lstrip('.')
    return (base or 'file')[:200]


def unique(folder, name):
    path = Path(folder, name)
    stem, suffix = path.stem, path.suffix
    count = 1
    while path.exists():
        count += 1
        path = Path(folder, f'{stem} ({count}){suffix}')
    return path


def preview(path, size=360):
    """A picture scaled down for its tile as JPEG bytes, or None (not a picture GdkPixbuf reads, too large)."""
    try:
        if path.stat().st_size > 80 * 1024 ** 2:
            return None
        import gi
        gi.require_version('GdkPixbuf', '2.0')
        from gi.repository import GdkPixbuf
        pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(path), size, size, True)
        pixbuf = pixbuf.apply_embedded_orientation() or pixbuf
        ok, data = pixbuf.save_to_bufferv('jpeg', ['quality'], ['82'])
        return bytes(data) if ok else None
    except Exception:  # noqa: BLE001 - any picture that cannot be read simply has no preview
        return None






class Session:
    def __init__(self, mode, files=(), folder=None, timeout=600):
        self.mode, self.files, self.folder, self.timeout = mode, [Path(f) for f in files], folder, timeout
        self.token = secrets.token_urlsafe(9)
        self.sizes = [f.stat().st_size for f in self.files]
        self.delivered = [0] * len(self.files)
        self.lock = threading.Lock()
        self.finished = threading.Event()
        self.last_progress = 0.0
        self.question = None   # {id, event, accepted, files, ticket}
        self.ticket = None
        self.name = share_page.computer_name()
        self.previews = {}
        # Receiving ends this long after its start or its last transfer.
        self.until = time.monotonic() + timeout

    def progress(self, peer, done, total, force=False):
        now = time.monotonic()
        if force or now - self.last_progress >= 0.25:
            self.last_progress = now
            emit(event='progress', peer=peer, done=done, total=total)


class Handler(BaseHTTPRequestHandler):
    server_version = 'Notchy'
    sys_version = ''

    def log_message(self, *_args):
        pass

    @property
    def session(self):
        return self.server.session

    def peer(self):
        return device_name(self.headers.get('User-Agent'))

    def check(self):
        """The path below the session's key, or None after answering 403/404."""
        if not allowed_peer(self.client_address[0]):
            self.send_error(403)
            return None
        parts = self.path.split('?', 1)[0].split('/')
        if len(parts) < 2 or not secrets.compare_digest(parts[1], self.session.token):
            # A page asked for with an old or wrong key: a calm page instead of a bare 404.
            if self.command == 'GET' and len(parts) == 2:
                self.answer(404, share_page.gone_page(self.session.name))
            else:
                self.send_error(404)
            return None
        return [unquote(p) for p in parts[2:] if p]

    def headers_out(self, status, kind, length=None, extra=()):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        if length is not None:
            self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:")
        for key, value in extra:
            self.send_header(key, value)
        self.end_headers()

    def answer(self, status, body, kind='text/html; charset=utf-8'):
        self.headers_out(status, kind, len(body))
        self.wfile.write(body)

    def do_GET(self):
        rest = self.check()
        if rest is None:
            return
        session = self.session
        if session.mode == 'send':
            if not rest:
                return self.answer(200, share_page.send_page(session.token, session.name, session.files, session.sizes))
            if rest[0] == 'f' and len(rest) >= 2 and rest[1].isdigit() and int(rest[1]) < len(session.files):
                return self.send_file(int(rest[1]))
            if rest[0] == 'p' and len(rest) == 2 and rest[1].isdigit() and int(rest[1]) < len(session.files):
                return self.send_preview(int(rest[1]))
            if rest == ['state']:
                with session.lock:
                    done = [d >= s for d, s in zip(session.delivered, session.sizes)]
                return self.answer(200, json.dumps({'delivered': done}).encode(), 'application/json')
            if rest == ['all.zip'] and len(session.files) > 1:
                return self.send_zip()
        elif not rest:
            return self.answer(200, share_page.receive_page(session.token, session.name))
        self.send_error(404)

    def delivered(self, index, sent):
        session, peer = self.session, self.peer()
        with session.lock:
            session.delivered[index] = max(session.delivered[index], sent)
            done = sum(min(d, s) for d, s in zip(session.delivered, session.sizes))
            complete = all(d >= s for d, s in zip(session.delivered, session.sizes))
        session.progress(peer, done, sum(session.sizes), force=complete)
        if complete and not session.finished.is_set():
            session.finished.set()
            emit(event='sent', peer=peer)

    def send_preview(self, index):
        """A small JPEG of a picture for its tile (made once, kept for the session)."""
        session = self.session
        with session.lock:
            cached = session.previews.get(index, False)
        if cached is False:
            cached = preview(session.files[index])
            with session.lock:
                session.previews[index] = cached
        if not cached:
            return self.send_error(404)
        self.answer(200, cached, 'image/jpeg')

    def send_file(self, index):
        path, size = self.session.files[index], self.session.sizes[index]
        kind = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        self.headers_out(200, kind, size, [('Content-Disposition', f"attachment; filename*=UTF-8''{quote(path.name)}")])
        sent = 0
        with open(path, 'rb') as source:
            while block := source.read(CHUNK):
                self.wfile.write(block)
                sent += len(block)
                self.delivered(index, sent)
        if size == 0:
            self.delivered(index, 0)

    def send_zip(self):
        session = self.session
        self.headers_out(200, 'application/zip', None, [('Content-Disposition', "attachment; filename*=UTF-8''Notchy.zip"), ('Connection', 'close')])
        self.close_connection = True

        class Stream:
            def __init__(self, out):
                self.out, self.position = out, 0

            def write(self, data):
                self.out.write(data)
                self.position += len(data)
                return len(data)

            def tell(self):
                return self.position

            def flush(self):
                self.out.flush()
        names = set()
        with zipfile.ZipFile(Stream(self.wfile), 'w', compression=zipfile.ZIP_STORED) as archive:
            for index, path in enumerate(session.files):
                name = path.name
                while name in names:
                    name = f'_{name}'
                names.add(name)
                sent = 0
                with open(path, 'rb') as source, archive.open(zipfile.ZipInfo.from_file(path, name), 'w') as target:
                    while block := source.read(CHUNK):
                        target.write(block)
                        sent += len(block)
                        self.delivered(index, sent)
                self.delivered(index, sent)

    def do_POST(self):
        rest = self.check()
        if rest is None:
            return
        session = self.session
        if session.mode != 'receive' or rest != ['ask']:
            return self.send_error(404)
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= 64 * 1024:
            return self.send_error(413)
        try:
            files = json.loads(self.rfile.read(length))['files']
            files = [{'name': safe_name(f['name']), 'size': int(f['size'])} for f in files]
        except (ValueError, KeyError, TypeError):
            return self.send_error(400)
        if not 0 < len(files) <= MAX_FILES or any(f['size'] < 0 for f in files) or sum(f['size'] for f in files) > MAX_BYTES:
            return self.send_error(413)
        with session.lock:
            if session.question or session.ticket:
                return self.send_error(409)
            question = {'id': secrets.token_hex(4), 'event': threading.Event(), 'accepted': False, 'files': files}
            session.question = question
        emit(event='ask', id=question['id'], peer=self.peer(), files=[f['name'] for f in files], count=len(files), size=sum(f['size'] for f in files))
        question['event'].wait(ASK_SECONDS)
        with session.lock:
            session.question = None
            if question['accepted']:
                session.ticket = {'id': secrets.token_urlsafe(9), 'files': files, 'paths': [None] * len(files), 'peer': self.peer()}
        if not question['accepted']:
            emit(event='declined')
            return self.answer(403, b'{"ok": false}', 'application/json')
        return self.answer(200, json.dumps({'ok': True, 'ticket': session.ticket['id']}).encode(), 'application/json')

    def do_PUT(self):
        rest = self.check()
        if rest is None:
            return
        session = self.session
        ticket = session.ticket
        if session.mode != 'receive' or len(rest) != 3 or rest[0] != 'up' or not ticket or not secrets.compare_digest(rest[1], ticket['id']) or not rest[2].isdigit():
            return self.send_error(404)
        index = int(rest[2])
        if index >= len(ticket['files']) or ticket['paths'][index]:
            return self.send_error(409)
        expected, length = ticket['files'][index]['size'], int(self.headers.get('Content-Length') or -1)
        if length != expected:
            return self.send_error(400)
        folder = Path(session.folder)
        folder.mkdir(parents=True, exist_ok=True)
        partial = folder / f'.notchy-upload-{secrets.token_hex(6)}'
        total = sum(f['size'] for f in ticket['files'])
        before = sum(f['size'] for f, p in zip(ticket['files'], ticket['paths']) if p)
        received = 0
        try:
            with open(partial, 'wb') as target:
                while received < length:
                    block = self.rfile.read(min(CHUNK, length - received))
                    if not block:
                        raise OSError('connection closed')
                    target.write(block)
                    received += len(block)
                    session.progress(ticket['peer'], before + received, total)
            path = unique(folder, ticket['files'][index]['name'])
            os.replace(partial, path)
        except OSError:
            partial.unlink(missing_ok=True)
            return self.send_error(500)
        with session.lock:
            ticket['paths'][index] = str(path)
            complete = all(ticket['paths'])
        self.answer(200, b'{"ok": true}', 'application/json')
        if complete:
            session.progress(ticket['peer'], total, total, force=True)
            emit(event='received', peer=ticket['peer'], paths=ticket['paths'])
            # Open for more ("Send More" on the phone) until the banner closes or time runs out.
            with session.lock:
                session.ticket = None
                session.until = time.monotonic() + session.timeout


def commands(session, stop):
    for line in sys.stdin:
        word, _sep, arg = line.strip().partition(' ')
        if word == 'stop':
            break
        question = session.question
        if word in ('accept', 'decline') and question and question['id'] == arg:
            question['accepted'] = word == 'accept'
            question['event'].set()
    stop.set()


def main():
    parser = argparse.ArgumentParser(description='Share files with a phone by QR code')
    parser.add_argument('mode', choices=['send', 'receive'])
    parser.add_argument('files', nargs='*')
    parser.add_argument('--folder')
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    if args.mode == 'send':
        files = [Path(f) for f in args.files]
        if not files or not all(f.is_file() for f in files):
            emit(event='error', message=_('A file to share no longer exists.'))
            return 1
    elif not args.folder:
        parser.error('receive needs --folder')
    # Coming from AirDrop, the Wi-Fi reconnects first: wait for the network a while.
    address, waited = local_address(), 0.0
    while not address and waited < 30:
        if waited == 0:
            emit(event='waiting')
        time.sleep(1)
        waited += 1
        address = local_address()
    if not address:
        emit(event='error', message=_('Not connected to a local network.'))
        return 1
    session = Session(args.mode, args.files if args.mode == 'send' else (), args.folder, args.timeout)
    try:
        server = ThreadingHTTPServer(('0.0.0.0' if address != '127.0.0.1' else '127.0.0.1', args.port), Handler)
    except OSError as error:
        emit(event='error', message=str(error))
        return 1
    server.daemon_threads = True
    server.session = session
    # A phone that breaks off a download is no error worth a trace.
    server.handle_error = lambda *_args: None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    emit(event='ready', url=f'http://{address}:{server.server_address[1]}/{session.token}')
    stop = threading.Event()
    threading.Thread(target=commands, args=(session, stop), daemon=True).start()
    while not stop.is_set():
        if session.finished.is_set():
            # The last bytes are on their way; then the link is gone.
            time.sleep(1.5)
            break
        if args.mode == 'receive' and time.monotonic() > session.until and not session.question and not session.ticket:
            emit(event='expired')
            break
        stop.wait(0.2)
    server.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
