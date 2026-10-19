"""The Python helpers speak Notchy's language: the system's, or the one chosen
in the preferences (NOTCHY_LANGUAGE). Needs the compiled catalog in locale/
(scripts/check.sh compiles it before the tests)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'helper'))
import i18n  # noqa: E402
import tray  # noqa: E402
import operations  # noqa: E402
import agent_setup  # noqa: E402


def speak(env):
    """What a helper process started with this environment says."""
    clean = {k: v for k, v in os.environ.items() if k not in ('LANGUAGE', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'NOTCHY_LANGUAGE')}
    script = "import i18n; print(i18n.language(), '|', i18n._('Open'), '|', i18n.ngettext('%d file', '%d files', 3) % 3, '|', i18n.number(1.5))"
    out = subprocess.run([sys.executable, '-c', script], cwd=ROOT / 'helper', env={**clean, **env}, capture_output=True, text=True, check=True).stdout
    return out.strip()


class Language(unittest.TestCase):
    def test_system_language(self):
        self.assertTrue((ROOT / 'locale/de/LC_MESSAGES/notchy.mo').exists(), 'run scripts/i18n.py compile locale first')
        for lang in ('de_DE.UTF-8', 'de_CH.UTF-8', 'de_AT.UTF-8', 'de'):
            self.assertEqual(speak({'LANG': lang}), 'de | Öffnen | 3 Dateien | 1,5', lang)
        for lang in ('en_US.UTF-8', 'en_GB.UTF-8', 'fr_FR.UTF-8', 'C.UTF-8'):
            self.assertEqual(speak({'LANG': lang}), 'en | Open | 3 files | 1.5', lang)

    def test_preference_wins_for_this_process_only(self):
        self.assertEqual(speak({'LANG': 'de_DE.UTF-8', 'NOTCHY_LANGUAGE': 'en'}), 'en | Open | 3 files | 1.5')
        self.assertEqual(speak({'LANG': 'en_US.UTF-8', 'NOTCHY_LANGUAGE': 'de'}), 'de | Öffnen | 3 Dateien | 1,5')
        self.assertEqual(speak({'LANG': 'de_DE.UTF-8', 'NOTCHY_LANGUAGE': 'auto'}), 'de | Öffnen | 3 Dateien | 1,5')
        self.assertEqual(speak({'LANG': 'de_DE.UTF-8', 'NOTCHY_LANGUAGE': 'xx'}), 'de | Öffnen | 3 Dateien | 1,5', 'unknown values mean automatic')


class Helpers(unittest.TestCase):
    def tearDown(self):
        i18n.set_language(None)

    def test_regal_menu_in_both_languages(self):
        app = tray.Tray('shelf')
        app.airdrop_available = False
        app.call = lambda *args, **kwargs: None
        items = [{'uri': f'file:///tmp/{name}', 'name': name} for name in ('a.png', 'b.txt', 'c.jpg')]
        with mock.patch.object(tray.shutil, 'which', lambda name: f'/usr/bin/{name}' if name in ('tesseract', 'magick') else None):
            i18n.set_language('en')
            english = [entry[1] if isinstance(entry, tuple) else entry['label'] if entry else '---' for entry in app.menu_entries(items)]
            i18n.set_language('de')
            german = [entry[1] if isinstance(entry, tuple) else entry['label'] if entry else '---' for entry in app.menu_entries(items)]
        self.assertEqual(english[0], 'Open 3 Files')
        self.assertIn('Recognize Text (2 pictures)', english)
        self.assertIn('Convert To (2 pictures)', english)
        self.assertEqual(german[0], '3 Dateien öffnen')
        self.assertIn('Text erkennen (2 Bilder)', german)
        self.assertEqual(len(english), len(german), 'the same entries, only other words')

    def test_file_operation_messages(self):
        with tempfile.TemporaryDirectory() as temp:
            files = []
            for name in ('one.txt', 'two.txt'):
                path = Path(temp, name)
                path.write_text(name)
                files.append(path.as_uri())
            with mock.patch.dict(os.environ, {'XDG_DATA_HOME': temp}):
                i18n.set_language('en')
                english = operations.process('zip-many', files[0], json.dumps(files))
                i18n.set_language('de')
                german = operations.process('zip-many', files[0], json.dumps(files))
            self.assertRegex(english['message'], r'^2 files compressed · .+\.zip is in the Shelf$')
            self.assertRegex(german['message'], r'^2 Dateien gepackt · .+\.zip im Regal$')
            i18n.set_language('en')
            with self.assertRaisesRegex(ValueError, 'Only local files are supported.'):
                operations.process('copy', 'https://example.org/x')

    def test_agent_setup_errors(self):
        with tempfile.TemporaryDirectory() as home:
            config = agent_setup.config_path('claude', home)
            config.parent.mkdir(parents=True)
            config.write_text('{broken')
            i18n.set_language('en')
            self.assertIn('is not valid JSON', agent_setup.status('claude', home)['error'])
            i18n.set_language('de')
            self.assertIn('ist kein gültiges JSON', agent_setup.status('claude', home)['error'])
            self.assertEqual(agent_setup.status('claude', home)['state'], 'error', 'states stay ids in every language')

    def test_notchyctl_messages(self):
        clean = {k: v for k, v in os.environ.items() if k not in ('LANGUAGE', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'NOTCHY_LANGUAGE')}
        for language, expected in (('en', 'agent update needs --state'), ('de', 'agent update braucht --state')):
            # Exits before it would talk to the session bus.
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/notchyctl'), 'agent', 'update', '--session', 'x'], env={**clean, 'NOTCHY_LANGUAGE': language},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn(expected, result.stderr)


if __name__ == '__main__':
    unittest.main()
