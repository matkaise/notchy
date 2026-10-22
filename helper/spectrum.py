#!/usr/bin/python3
"""Analyze output-monitor audio in memory. Never falls back to a microphone."""
import argparse
import json
import math
import re
import signal
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

# Unix signal sources: GLibUnix.signal_add since GLib 2.84 (GNOME 48+, where
# GLib.unix_signal_add is deprecated); older GLib only has the latter.
try:
    gi.require_version('GLibUnix', '2.0')
    from gi.repository import GLibUnix
    unix_signal_add = GLibUnix.signal_add
except (ValueError, ImportError, AttributeError):
    unix_signal_add = GLib.unix_signal_add


def levels(magnitudes):
    # Compress 64 linear bands into 12 display bars, using the strongest band.
    groups = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 6), (6, 9), (9, 13), (13, 19), (19, 28), (28, 39), (39, 51), (51, 64)]
    return [round(max(0.0, min(1.0, (max(magnitudes[lo:hi], default=-72.0) + 72.0) / 60.0)), 3) for lo, hi in groups]


def magnitudes_from_structure(serialized):
    # The stock Ubuntu GI binding cannot marshal GstValueList. GStreamer's
    # documented structure serializer gives the same numeric values portably.
    match = re.search(r'magnitude=\(float\)\{([^}]+)\}', serialized)
    if not match:
        raise ValueError('Missing audio spectrum.')
    values = [float(x.strip()) for x in match[1].split(',')]
    if len(values) != 64 or not all(math.isfinite(x) for x in values):
        raise ValueError('Invalid audio spectrum.')
    return values


def run(device=None, test=False, frames=0):
    Gst.init(None)
    if not test and (not device or not device.endswith('.monitor') or len(device) > 500):
        raise ValueError('Only an explicit PulseAudio output monitor is accepted.')
    pipeline = Gst.Pipeline.new('notchy-spectrum')
    source = Gst.ElementFactory.make('audiotestsrc' if test else 'pulsesrc', 'source')
    convert = Gst.ElementFactory.make('audioconvert', None)
    spectrum = Gst.ElementFactory.make('spectrum', 'analysis')
    sink = Gst.ElementFactory.make('fakesink', None)
    if not all((source, convert, spectrum, sink)):
        raise RuntimeError('GStreamer audio/spectrum plugins are missing.')
    if test:
        source.set_property('is-live', True)
        source.set_property('freq', 440.0)
        source.set_property('volume', 0.5)
    else:
        source.set_property('device', device)
        source.set_property('client-name', 'Notchy · Playback visualization')
        source.set_property('stream-properties', Gst.Structure.new_from_string('props,media.role=(string)filter'))
    spectrum.set_property('bands', 64)
    spectrum.set_property('interval', 50000000)
    spectrum.set_property('threshold', -72)
    sink.set_property('sync', False)
    for element in (source, convert, spectrum, sink):
        pipeline.add(element)
    if not (source.link(convert) and convert.link(spectrum) and spectrum.link(sink)):
        raise RuntimeError('Could not link audio analysis pipeline.')
    loop = GLib.MainLoop()
    count = 0
    def message(_bus, message):
        nonlocal count
        if message.type == Gst.MessageType.ELEMENT:
            structure = message.get_structure()
            if structure and structure.get_name() == 'spectrum':
                magnitudes = magnitudes_from_structure(structure.to_string())
                if all(math.isfinite(x) for x in magnitudes):
                    print(json.dumps({'levels': levels(magnitudes)}, separators=(',', ':')), flush=True)
                    count += 1
                    if frames and count >= frames:
                        loop.quit()
        elif message.type == Gst.MessageType.ERROR:
            error, _debug = message.parse_error()
            print(json.dumps({'error': str(error)}), flush=True)
            loop.quit()
        elif message.type == Gst.MessageType.EOS:
            loop.quit()
    bus = pipeline.get_bus(); bus.add_signal_watch(); bus.connect('message', message)
    for signum in (signal.SIGTERM, signal.SIGINT):
        unix_signal_add(GLib.PRIORITY_DEFAULT, signum, lambda: loop.quit() or GLib.SOURCE_REMOVE)
    pipeline.set_state(Gst.State.PLAYING)
    try:
        loop.run()
    finally:
        pipeline.set_state(Gst.State.NULL); bus.remove_signal_watch()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--device'); parser.add_argument('--test-tone', action='store_true'); parser.add_argument('--frames', type=int, default=0)
    args = parser.parse_args()
    try:
        run(args.device, args.test_tone, args.frames)
    except Exception as error:
        print(json.dumps({'error': str(error)}), flush=True)
        raise SystemExit(1)
