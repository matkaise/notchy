"""The Regal's context menu: which entries appear for which files and tools."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'helper'))
import i18n  # noqa: E402
import tray  # noqa: E402


def labels(entries):
    out = []
    for entry in entries:
        if entry is None:
            out.append('---')
        elif isinstance(entry, dict):
            out.append(entry['label'] + ' ▸')
        else:
            out.append(entry[1])
    return out


class MenuEntries(unittest.TestCase):
    # The labels are checked in German; test_i18n covers English.
    def setUp(self):
        i18n.set_language('de')
        self.addCleanup(i18n.set_language, None)
        self.app = tray.Tray('shelf')
        self.app.airdrop_available = False
        self.calls = []
        self.app.call = lambda method, values=None, done=None: self.calls.append((method, values.unpack() if values else None))

    def entries(self, names, tools=()):
        with mock.patch.object(tray.shutil, 'which', lambda name: f'/usr/bin/{name}' if name in tools else None):
            return self.app.menu_entries([{'uri': f'file:///tmp/{name}', 'name': name} for name in names])

    def test_plain_file_has_only_generic_actions(self):
        self.assertEqual(labels(self.entries(['notes.txt'])),
                         ['Öffnen', 'Im Ordner zeigen', 'Kopieren', 'Kopie speichern …', '---', 'Als ZIP packen', '---', 'Aus Regal entfernen'])

    def test_tools_appear_only_when_installed(self):
        self.assertNotIn('Text erkennen', labels(self.entries(['photo.png'])))
        found = labels(self.entries(['photo.png'], tools=('tesseract', 'magick', 'rembg')))
        self.assertIn('Text erkennen', found)
        self.assertIn('Konvertieren in ▸', found)
        self.assertIn('Hintergrund entfernen', found)
        self.assertIn('PDF verkleinern', labels(self.entries(['paper.pdf'], tools=('gs',))))
        self.assertIn('Video verkleinern ▸', labels(self.entries(['clip.mp4'], tools=('ffmpeg', 'ffprobe'))))
        self.assertNotIn('Video verkleinern ▸', labels(self.entries(['clip.mp4'], tools=('ffmpeg',))))

    def test_airdrop_only_with_backend(self):
        self.assertNotIn('Per AirDrop senden', labels(self.entries(['a.txt'])))
        self.app.airdrop_available = True
        self.assertIn('Per AirDrop senden', labels(self.entries(['a.txt'])))

    def test_multiple_selection_applies_to_matching_files(self):
        entries = self.entries(['a.png', 'b.txt', 'c.jpg'], tools=('tesseract', 'magick'))
        found = labels(entries)
        self.assertEqual(found[0], '3 Dateien öffnen')
        self.assertIn('Kopien speichern …', found)
        self.assertIn('Text erkennen (2 Bilder)', found)
        ocr = next(entry for entry in entries if entry and not isinstance(entry, dict) and entry[1].startswith('Text erkennen'))
        ocr[2]()
        self.assertEqual(self.calls, [('Action', ('ocr', 'file:///tmp/a.png', '')), ('Action', ('ocr', 'file:///tmp/c.jpg', ''))])
        convert = next(entry for entry in entries if isinstance(entry, dict))
        self.assertEqual([label for _icon, label, _cb in convert['entries']], ['PNG', 'JPG', 'WEBP', 'TIFF', 'BMP', 'GIF'])

    def test_remove_and_zip_act_on_every_selected_file(self):
        entries = self.entries(['a.txt', 'b.txt'])
        remove = entries[-1]
        self.assertEqual(remove[3], 'danger')
        remove[2]()
        self.assertEqual(self.calls, [('RemoveUri', ('file:///tmp/a.txt',)), ('RemoveUri', ('file:///tmp/b.txt',))])
        self.calls.clear()
        next(entry for entry in entries if entry and entry[1] == 'Als ZIP packen')[2]()
        self.assertEqual(self.calls[0][0], 'Action')
        self.assertEqual(self.calls[0][1][0], 'zip-many')


if __name__ == '__main__':
    unittest.main()
