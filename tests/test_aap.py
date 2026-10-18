"""Notchy's built-in AAP reader: packets recorded from real AirPods Pro 2."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('aap', Path(__file__).parent.parent / 'helper/aap.py')
aap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aap)
FIXTURE = Path(__file__).parent / 'fixtures/aap-airpods-pro2.hex'


def packets():
    return [bytes.fromhex(line) for line in FIXTURE.read_text().splitlines() if line and not line.startswith('#')]


class AapTest(unittest.TestCase):
    def test_recorded_packets(self):
        state = aap.new_state()
        records = packets()
        aap.parse(records[0], state)  # the handshake reply changes nothing
        aap.parse(records[1], state)  # nor does the feature acknowledgement
        self.assertEqual(state, aap.new_state())
        records = records[1:]
        aap.parse(records[1], state)
        self.assertEqual((state['name'], state['model']), ('AirPods Pro', 'A3048'))
        aap.parse(records[2], state); aap.parse(records[3], state)
        self.assertEqual((state['anc'], state['ancSupported'], state['conversation']), ('transparency', True, True))
        aap.parse(records[4], state)
        self.assertEqual(state['battery'], {'left': 93, 'right': 99, 'case': None, 'single': None})
        self.assertEqual(state['primary'], 'left')
        self.assertFalse(state['charging']['left'])
        aap.parse(records[5], state)
        self.assertEqual(state['ear'], {'left': True, 'right': True})
        aap.parse(records[6], state)
        self.assertEqual(state['ear'], {'left': True, 'right': False})
        # Right bud primary now, the case open and charging.
        aap.parse(records[7], state)
        self.assertEqual(state['battery'], {'left': 96, 'right': 98, 'case': 90, 'single': None})
        self.assertEqual(state['primary'], 'right')
        self.assertTrue(state['charging']['case'] and state['charging']['right'] is False)

    def test_case_unknown_then_known_again(self):
        # Both buds in the ears: the case is reported as disconnected (0x04), never as 0 %.
        state = aap.new_state()
        aap.parse(bytes.fromhex('040004000400030201620201040160020108015a0101'), state)
        self.assertEqual(state['battery']['case'], 90)
        aap.parse(bytes.fromhex('04000400040003020162020104016002010801000401'), state)
        self.assertIsNone(state['battery']['case'])
        self.assertFalse(state['charging']['case'])
        # A packet without the case leaves what is known about it as it was.
        aap.parse(bytes.fromhex('0400040004000202016202010401600201'), state)
        self.assertIsNone(state['battery']['case'])
        aap.parse(bytes.fromhex('040004000400030201620201040160020108014b0201'), state)
        self.assertEqual((state['battery']['case'], state['charging']['case']), (75, False))
        # An invalid level is unknown as well.
        aap.parse(bytes.fromhex('04000400040001080190020101'), state)
        self.assertIsNone(state['battery']['case'])

    def test_unknown_and_short_packets_change_nothing(self):
        state = aap.new_state()
        for packet in [b'', b'\x04\x00\x04', bytes.fromhex('0400040004000104'), bytes.fromhex('05000400040001'), bytes.fromhex('0400040009000d09000000')]:
            self.assertFalse(aap.parse(packet, state))
        self.assertEqual(state, aap.new_state())

    def test_commands(self):
        self.assertEqual(aap.command('{"anc": "noise"}').hex(), '0400040009000d02000000')
        self.assertEqual(aap.command('{"anc": "adaptive"}').hex(), '0400040009000d04000000')
        self.assertEqual(aap.command('{"conversation": false}').hex(), '04000400090028020000 00'.replace(' ', ''))
        self.assertIsNone(aap.command('{"anc": "boost"}'))
        self.assertIsNone(aap.command('rm -rf /'))

    def test_helper_protocol_with_replayed_packets(self):
        with tempfile.TemporaryDirectory() as temp:
            log = os.path.join(temp, 'sent.log')
            os.environ['NOTCHY_AAP_REPLAY'], os.environ['NOTCHY_AAP_LOG'] = str(FIXTURE), log
            try:
                out, (read, write) = io.StringIO(), os.pipe()
                os.write(write, b'{"anc": "noise"}\n')
                os.close(write)
                with os.fdopen(read) as stdin:
                    aap.run('68:CA:C4:DE:31:F3', out, stdin)
            finally:
                del os.environ['NOTCHY_AAP_REPLAY'], os.environ['NOTCHY_AAP_LOG']
            states = [json.loads(line) for line in out.getvalue().splitlines()]
            self.assertTrue(states[0]['connected'])
            self.assertEqual(states[-1]['anc'], 'noise')
            self.assertEqual(states[-1]['battery']['case'], 90)
            sent = Path(log).read_text().split()
            # Handshake, then features after its answer, then notifications after theirs.
            self.assertEqual(sent[:2], [aap.HANDSHAKE.hex(), aap.FEATURES.hex()])
            self.assertIn(aap.NOTIFICATIONS.hex(), sent)
            self.assertIn('0400040009000d02000000', sent)


if __name__ == '__main__':
    unittest.main()
