import json
from pathlib import Path
import subprocess
import unittest
import sys
sys.path.insert(0, str(Path(__file__).parents[1] / 'helper'))
from spectrum import levels, magnitudes_from_structure

class SpectrumTests(unittest.TestCase):
    def test_silence_and_finite_scaling(self):
        self.assertEqual(levels([-72.0] * 64), [0.0] * 12)
        self.assertEqual(levels([0.0] * 64), [1.0] * 12)
        self.assertRaises(ValueError, magnitudes_from_structure, 'magnitude=(float){ nan };')
    def test_monitor_required_no_microphone_fallback(self):
        result = subprocess.run(['/usr/bin/python3', 'helper/spectrum.py', '--device', 'alsa_input.microphone'], capture_output=True, text=True, timeout=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('output monitor', result.stdout)
    def test_real_gstreamer_analysis_frames(self):
        result = subprocess.run(['/usr/bin/python3', 'helper/spectrum.py', '--test-tone', '--frames', '3'], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        frames = [json.loads(line)['levels'] for line in result.stdout.splitlines()]
        self.assertEqual(len(frames), 3)
        self.assertTrue(all(len(frame) == 12 and max(frame) > 0.8 and all(0 <= x <= 1 for x in frame) for frame in frames))
