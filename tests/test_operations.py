import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('operations', Path(__file__).parent.parent / 'helper/operations.py')
operations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operations)


class OperationsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get('XDG_DATA_HOME')
        os.environ['XDG_DATA_HOME'] = self.temp.name

    def tearDown(self):
        if self.previous is None:
            os.environ.pop('XDG_DATA_HOME', None)
        else:
            os.environ['XDG_DATA_HOME'] = self.previous
        self.temp.cleanup()

    def test_zip_preserves_original_and_handles_shell_characters(self):
        source = Path(self.temp.name, 'file $(noexec) ü.txt')
        source.write_text('test payload')
        result = operations.process('zip', source.as_uri())
        destination = operations.local_path(result['uri'])
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.read(source.name), b'test payload')
        self.assertEqual(source.read_text(), 'test payload')

    def test_zip_many_packs_a_selection_into_one_archive(self):
        first = Path(self.temp.name, 'eins ü.txt'); first.write_text('1')
        second = Path(self.temp.name, 'zwei.md'); second.write_text('2')
        result = operations.process('zip-many', first.as_uri(), operations.json.dumps([first.as_uri(), second.as_uri()]))
        with zipfile.ZipFile(operations.local_path(result['uri'])) as archive:
            self.assertEqual(sorted(archive.namelist()), sorted([first.name, second.name]))
        self.assertTrue(first.exists() and second.exists())
        with self.assertRaises(ValueError):
            operations.process('zip-many', first.as_uri(), operations.json.dumps(['https://example.com/x']))

    def test_zip_does_not_follow_directory_symlinks(self):
        source = Path(self.temp.name, 'folder'); source.mkdir()
        outside = Path(self.temp.name, 'outside.txt'); outside.write_text('private')
        Path(source, 'link.txt').symlink_to(outside)
        Path(source, 'inside.txt').write_text('included')
        result = operations.process('zip', source.as_uri())
        with zipfile.ZipFile(operations.local_path(result['uri'])) as archive:
            self.assertEqual(archive.namelist(), ['folder/inside.txt'])

    def test_remote_and_missing_files_are_rejected(self):
        for uri in ['https://example.com/a', 'file://remote/tmp/a', 'file:///nonexistent-very-specific']:
            with self.assertRaises(ValueError):
                operations.local_path(uri)

    def test_bad_format_rejected_before_spawning(self):
        source = Path(self.temp.name, 'a.txt'); source.write_text('test')
        with self.assertRaises(ValueError):
            operations.process('image', source.as_uri(), '$(noexec)')


if __name__ == '__main__':
    unittest.main()
