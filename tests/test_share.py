"""The QR share helper (helper/share.py): a real server on localhost, driven
as Notchy drives it (JSON lines out, commands in) and fetched as a phone would."""
import html
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'helper'))
spec = importlib.util.spec_from_file_location('share', ROOT / 'helper/share.py')
share = importlib.util.module_from_spec(spec)
spec.loader.exec_module(share)
PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240305.019) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'


class Helper:
    def __init__(self, *args):
        env = {**os.environ, 'NOTCHY_SHARE_ADDRESS': '127.0.0.1', 'NOTCHY_LANGUAGE': 'en', 'PYTHONDONTWRITEBYTECODE': '1'}
        self.proc = subprocess.Popen([sys.executable, str(ROOT / 'helper/share.py'), *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
        self.events = []

    def next(self, kind=None):
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise AssertionError(f'helper ended before {kind}: {self.events}')
            event = json.loads(line)
            self.events.append(event)
            if kind is None or event['event'] == kind:
                return event

    def send(self, line):
        self.proc.stdin.write(line + '\n')
        self.proc.stdin.flush()

    def close(self):
        if self.proc.poll() is None:
            try:
                self.send('stop')
            except (BrokenPipeError, ValueError):
                pass
            self.proc.wait(10)
        for pipe in (self.proc.stdin, self.proc.stdout):
            try:
                pipe.close()
            except (BrokenPipeError, ValueError, OSError):
                pass


def fetch(url, data=None, method=None, agent=PIXEL, headers=None):
    request = urllib.request.Request(url, data=data, method=method, headers={'User-Agent': agent, **(headers or {})})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.status, response.read(), response.headers


class ShareTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_send_one_file_then_the_link_is_gone(self):
        source = self.dir / 'Urlaub 2026 ü.txt'
        source.write_bytes(os.urandom(700_000))
        helper = Helper('send', str(source))
        try:
            url = helper.next('ready')['url']
            self.assertRegex(url, r'^http://127\.0\.0\.1:\d+/[\w-]{12}$')
            status, body, _ = fetch(url)
            self.assertEqual(status, 200)
            self.assertIn('Urlaub 2026 ü.txt', body.decode())
            link = url + '/f/0/' + urllib.request.quote(source.name)
            status, body, headers = fetch(link)
            self.assertEqual(body, source.read_bytes(), 'the file arrives unchanged')
            self.assertIn("filename*=UTF-8''Urlaub%202026%20%C3%BC.txt", headers['Content-Disposition'])
            sent = helper.next('sent')
            self.assertEqual(sent['peer'], 'Pixel 8', 'the phone is named from its browser')
            progress = [e for e in helper.events if e['event'] == 'progress']
            self.assertEqual(progress[-1]['done'], progress[-1]['total'], 'real progress ends complete')
            self.assertEqual(helper.proc.wait(10), 0, 'after the download the session ends')
            with self.assertRaises(OSError):
                fetch(url)
        finally:
            helper.close()

    def test_several_files_and_all_as_zip(self):
        files = []
        for name in ('a.txt', 'b.txt', 'c.bin'):
            path = self.dir / name
            path.write_bytes(name.encode() * 1000)
            files.append(path)
        helper = Helper('send', *map(str, files))
        try:
            url = helper.next('ready')['url']
            _, page, _ = fetch(url)
            self.assertIn('all.zip', page.decode())
            _, body, _ = fetch(url + '/all.zip')
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                self.assertEqual(sorted(archive.namelist()), ['a.txt', 'b.txt', 'c.bin'])
                self.assertEqual(archive.read('b.txt'), b'b.txt' * 1000)
            helper.next('sent')
        finally:
            helper.close()

    def test_wrong_key_and_unknown_paths_are_refused(self):
        source = self.dir / 'x.txt'
        source.write_text('x')
        helper = Helper('send', str(source))
        try:
            url = helper.next('ready')['url']
            base = url.rsplit('/', 1)[0]
            for wrong in (base + '/guess', base + '/', url + '/f/9/x', url + '/../etc/passwd', url + '/all.zip'):
                with self.subTest(wrong=wrong), self.assertRaises(urllib.error.HTTPError) as caught:
                    fetch(wrong)
                self.assertIn(caught.exception.code, (403, 404))
                caught.exception.close()
        finally:
            helper.close()

    def ask(self, url, files, results):
        try:
            results.append(fetch(url + '/ask', json.dumps({'files': files}).encode(), headers={'Content-Type': 'application/json'}))
        except urllib.error.HTTPError as error:
            results.append((error.code, error.read(), None))
            error.close()

    def test_receive_asks_first_then_stores_the_files(self):
        folder = self.dir / 'in'
        helper = Helper('receive', '--folder', str(folder))
        try:
            url = helper.next('ready')['url']
            _, page, _ = fetch(url)
            self.assertIn('type="file"', page.decode())
            results = []
            asking = threading.Thread(target=self.ask, args=(url, [{'name': '../../evil.sh', 'size': 3}, {'name': 'foto.jpg', 'size': 5}], results))
            asking.start()
            question = helper.next('ask')
            self.assertEqual((question['peer'], question['count'], question['size']), ('Pixel 8', 2, 8))
            self.assertEqual(question['files'], ['_.._evil.sh', 'foto.jpg'], 'names are reduced to plain base names')
            self.assertFalse(folder.exists() and any(folder.iterdir()), 'nothing is stored before the answer')
            helper.send(f"accept {question['id']}")
            asking.join(10)
            status, body, _ = results[0]
            ticket = json.loads(body)['ticket']
            self.assertEqual(status, 200)
            with self.assertRaises(urllib.error.HTTPError) as wrong:
                fetch(f'{url}/up/{ticket}/0', b'toolong', method='PUT')
            wrong.exception.close()
            fetch(f'{url}/up/{ticket}/0', b'abc', method='PUT')
            fetch(f'{url}/up/{ticket}/1', b'hello', method='PUT')
            received = helper.next('received')
            paths = [Path(p) for p in received['paths']]
            self.assertEqual([p.read_bytes() for p in paths], [b'abc', b'hello'])
            self.assertTrue(all(p.parent == folder for p in paths), 'every file lands in the chosen folder, never outside')
            self.assertFalse(any(p.name.startswith('.notchy-upload') for p in folder.iterdir()))
            # Open for more („Weitere senden“ on the phone) until Notchy stops it.
            self.assertIsNone(helper.proc.poll(), 'receiving stays open after a transfer')
            more = []
            asking = threading.Thread(target=self.ask, args=(url, [{'name': 'zwei.txt', 'size': 2}], more))
            asking.start()
            again = helper.next('ask')
            helper.send(f"accept {again['id']}")
            asking.join(10)
            fetch(f"{url}/up/{json.loads(more[0][1])['ticket']}/0", b'ok', method='PUT')
            self.assertEqual(Path(helper.next('received')['paths'][0]).read_bytes(), b'ok', 'a second transfer in the same session')
            helper.send('stop')
            self.assertEqual(helper.proc.wait(10), 0)
        finally:
            helper.close()

    def test_declined_or_unanswered_uploads_store_nothing(self):
        folder = self.dir / 'in'
        helper = Helper('receive', '--folder', str(folder))
        try:
            url = helper.next('ready')['url']
            results = []
            asking = threading.Thread(target=self.ask, args=(url, [{'name': 'a.txt', 'size': 1}], results))
            asking.start()
            question = helper.next('ask')
            helper.send(f"decline {question['id']}")
            asking.join(10)
            self.assertEqual(results[0][0], 403)
            helper.next('declined')
            with self.assertRaises(urllib.error.HTTPError) as caught:
                fetch(f'{url}/up/whatever/0', b'a', method='PUT')
            self.assertEqual(caught.exception.code, 404, 'no upload without an accepted ticket')
            caught.exception.close()
            self.assertFalse(folder.exists() and any(folder.iterdir()))
        finally:
            helper.close()

    def test_receive_expires(self):
        helper = Helper('receive', '--folder', str(self.dir), '--timeout', '1')
        try:
            helper.next('ready')
            self.assertEqual(helper.next('expired')['event'], 'expired')
            self.assertEqual(helper.proc.wait(10), 0)
        finally:
            helper.close()

    def test_the_page_in_notchys_design(self):
        photo = self.dir / 'Foto.png'
        import gi
        gi.require_version('GdkPixbuf', '2.0')
        from gi.repository import GdkPixbuf
        GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, 800, 600).savev(str(photo), 'png', [], [])
        hostile = self.dir / '"><img src=x onerror=alert(1)><script>x.pdf'
        hostile.write_text('x')
        helper = Helper('send', str(photo), str(hostile))
        try:
            url = helper.next('ready')['url']
            status, page, headers = fetch(url)
            text = page.decode()
            self.assertIn('class="notch"', text, 'Notchy\'s notch heads the page')
            self.assertIn('class="tile"', text, 'the files are the Regal\'s tiles')
            sys.modules['i18n'].set_language('en')   # as the helper speaks here
            try:
                self.assertIn(html.escape(share.share_page.computer_name()), text, 'the computer is named')
            finally:
                sys.modules['i18n'].set_language(None)
            self.assertNotIn('<img src=x', text, 'file names are escaped')
            self.assertNotIn('<script>x', text, 'not even inside the script')
            self.assertIn("img-src 'self' blob:", headers['Content-Security-Policy'])
            self.assertNotIn('http://', text.replace(url, ''), 'nothing is loaded from elsewhere')
            _, image, headers = fetch(url + '/p/0')
            self.assertEqual(headers['Content-Type'], 'image/jpeg')
            self.assertEqual(image[:2], b'\xff\xd8', 'a picture gets a JPEG preview')
            with self.assertRaises(urllib.error.HTTPError) as caught:
                fetch(url + '/p/1')
            self.assertEqual(caught.exception.code, 404, 'a PDF has no preview')
            caught.exception.close()
            _, state, _ = fetch(url + '/state')
            self.assertEqual(json.loads(state), {'delivered': [False, False]})
            fetch(url + '/f/1/x')
            _, state, _ = fetch(url + '/state')
            self.assertEqual(json.loads(state), {'delivered': [False, True]}, 'the page learns what was delivered')
            with self.assertRaises(urllib.error.HTTPError) as caught:
                fetch(url.rsplit('/', 1)[0] + '/oldkey')
            gone = caught.exception.read().decode()
            caught.exception.close()
            self.assertEqual(caught.exception.code, 404)
            self.assertIn('class="notch"', gone, 'an old link gets a calm page in the same design')
        finally:
            helper.close()

    def test_the_receive_page(self):
        helper = Helper('receive', '--folder', str(self.dir))
        try:
            url = helper.next('ready')['url']
            _, page, _ = fetch(url)
            text = page.decode()
            for part in ('id="pick"', 'id="wait"', 'class="radar"', 'id="run"', 'class="ring"', 'id="end"', 'type="file"'):
                self.assertIn(part, text, part)
        finally:
            helper.close()

    def test_the_computer_has_a_name(self):
        name = share.share_page.computer_name()
        self.assertTrue(name and len(name) <= 60)

    def test_only_the_local_network(self):
        for address in ('192.168.1.4', '10.0.0.7', '172.20.1.1', '127.0.0.1', 'fe80::1', 'fd00::5', '::ffff:192.168.1.9'):
            self.assertTrue(share.allowed_peer(address), address)
        for address in ('8.8.8.8', '2a00:1450::1', '::ffff:8.8.8.8', 'nonsense'):
            self.assertFalse(share.allowed_peer(address), address)

    def test_device_names_and_safe_names(self):
        self.assertEqual(share.device_name(PIXEL), 'Pixel 8')
        self.assertEqual(share.device_name('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone')
        self.assertEqual(share.device_name('Mozilla/5.0 (Linux; Android 10; K) Chrome/120 Mobile'), 'Android')
        self.assertEqual(share.device_name(''), share._('Phone'))
        self.assertEqual(share.safe_name('../../.bashrc'), '_.._.bashrc')
        self.assertEqual(share.safe_name('.hidden'), 'hidden')
        self.assertEqual(share.safe_name('a\x00b/c'), 'a_b_c')
        self.assertEqual(share.safe_name(''), 'file')


if __name__ == '__main__':
    unittest.main()
