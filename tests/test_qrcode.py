"""Notchy's QR encoder (src/qrcode.js) read back by a real decoder: zbar,
through GStreamer's zbar element. Skipped where it is not installed."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
CASES = [
    ('M', 'http://192.168.1.23:41234/k7Q2-wX9pLm'),
    ('H', 'http://192.168.178.40:53317/r/AbCdEfGhIjKl'),
    ('L', 'a'),
    ('Q', 'Notchy'),
    ('M', 'Grüße aus Zürich – „Ümläute“ und ✓'),
    ('L', 'x' * 120),          # version 6/7 boundary (version information)
    ('M', 'https://example.org/' + 'q' * 180),   # version ≥ 9, several blocks
    ('H', '0123456789' * 20),
    ('Q', 'z' * 400),          # version ≥ 15
]


def zbar_available():
    try:
        import gi
        gi.require_version('Gst', '1.0')
        from gi.repository import Gst
        Gst.init(None)
        return Gst.ElementFactory.find('zbar') is not None
    except (ImportError, ValueError):
        return False


def encode(cases):
    script = """
import(process.argv[1]).then(m => {
    const cases = JSON.parse(process.argv[2]);
    console.log(JSON.stringify(cases.map(([ecl, text]) => { const q = m.qrEncode(text, {ecl}); return {version: q.version, ecl: q.ecl, rows: q.modules.map(r => r.map(x => (x ? 1 : 0)).join(''))}; })));
});"""
    out = subprocess.run(['node', '-e', script, (ROOT / 'src/qrcode.js').as_uri(), json.dumps(cases)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def decode(rows, folder, logo=False):
    from PIL import Image, ImageDraw
    n, scale, quiet = len(rows), 6, 4
    image = Image.new('L', ((n + 2 * quiet) * scale,) * 2, 255)
    draw = ImageDraw.Draw(image)
    for y, row in enumerate(rows):
        for x, cell in enumerate(row):
            if cell == '1':
                draw.rectangle([(x + quiet) * scale, (y + quiet) * scale, (x + quiet + 1) * scale - 1, (y + quiet + 1) * scale - 1], fill=0)
    if logo:
        # The badge Notchy draws in the middle: a quarter of the side, on a light frame.
        side = image.size[0] // 4
        c = image.size[0] // 2
        draw.rectangle([c - side // 2 - scale, c - side // 2 - scale, c + side // 2 + scale, c + side // 2 + scale], fill=255)
        draw.rectangle([c - side // 2, c - side // 2, c + side // 2, c + side // 2], fill=80)
    path = Path(folder, 'code.png')
    image.save(path)
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst
    Gst.init(None)
    pipeline = Gst.parse_launch(f'filesrc location="{path}" ! pngdec ! videoconvert ! zbar ! fakesink')
    bus = pipeline.get_bus()
    pipeline.set_state(Gst.State.PLAYING)
    found = None
    try:
        while True:
            message = bus.timed_pop_filtered(10 * Gst.SECOND, Gst.MessageType.ELEMENT | Gst.MessageType.EOS | Gst.MessageType.ERROR)
            if message is None or message.type != Gst.MessageType.ELEMENT:
                break
            structure = message.get_structure()
            if structure and structure.get_name() == 'barcode':
                found = structure.get_value('symbol')
                break
    finally:
        pipeline.set_state(Gst.State.NULL)
    return found


@unittest.skipUnless(zbar_available() and shutil.which('node'), 'zbar (GStreamer) or node is not installed')
class QRCodeTest(unittest.TestCase):
    def test_every_case_reads_back(self):
        codes = encode(CASES)
        with tempfile.TemporaryDirectory() as folder:
            for (ecl, text), code in zip(CASES, codes):
                with self.subTest(text=text[:30], ecl=ecl, version=code['version']):
                    self.assertEqual(len(code['rows']), code['version'] * 4 + 17)
                    self.assertEqual(decode(code['rows'], folder), text)
        self.assertTrue(any(code['version'] >= 7 for code in codes), 'a version with version information is covered')

    def test_the_badge_in_the_middle_leaves_it_readable_at_level_h(self):
        url = 'http://192.168.178.40:53317/s/Zx81-QwErTy'
        code = encode([('H', url)])[0]
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(decode(code['rows'], folder, logo=True), url)

    def test_too_long_is_refused(self):
        script = "import(process.argv[1]).then(m => console.log(JSON.stringify(m.qrEncode('x'.repeat(4000), {ecl: 'H'}))))"
        out = subprocess.run(['node', '-e', script, (ROOT / 'src/qrcode.js').as_uri()], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), 'null')


if __name__ == '__main__':
    unittest.main()
