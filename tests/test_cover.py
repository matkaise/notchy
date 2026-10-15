import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('cover_helper', Path(__file__).parents[1] / 'helper' / 'cover.py')
cover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cover)


class CoverTests(unittest.TestCase):
    def test_raster_sanitized_and_cached_without_refetch(self):
        image = cover.GdkPixbuf.Pixbuf.new(cover.GdkPixbuf.Colorspace.RGB, True, 8, 640, 320)
        image.fill(0x8866CCFF)
        _ok, data = image.save_to_bufferv('png', [], [])

        class Server(BaseHTTPRequestHandler):
            calls = 0

            def do_GET(self):
                Server.calls += 1
                self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                uri = f'http://127.0.0.1:{server.server_port}/cover.png'
                path = cover.cache_cover(uri, directory)
                pixbuf = cover.GdkPixbuf.Pixbuf.new_from_file(str(path))
                self.assertEqual((pixbuf.get_width(), pixbuf.get_height()), (512, 256))
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(cover.cache_cover(uri, directory), path)
                self.assertEqual(Server.calls, 1)
        finally:
            server.shutdown(); server.server_close()

    def test_rejects_documents_invalid_raster_and_oversized(self):
        for data in (b'<svg xmlns="http://www.w3.org/2000/svg"/>', b'not an image', b'\x89PNG\r\n\x1a\ninvalid', b'x' * (cover.LIMIT + 1)):
            with self.assertRaises(Exception):
                cover.decode(data)

    def test_rejects_non_http_and_embedded_credentials(self):
        for uri in ('file:///tmp/test.png', 'ftp://localhost/art', 'https://user:secret@example.com/a.png', 'https:///image'):
            with self.assertRaises(ValueError):
                cover.fetch(uri)
