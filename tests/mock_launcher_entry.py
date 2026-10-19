#!/usr/bin/python3
"""A stand-in app publishing LauncherEntry progress, as Chrome or Files do.

Reads commands from stdin, one per line: "show APP PROGRESS", "hide APP",
"progress APP VALUE". Exits at end of input (its bus name vanishes)."""
import sys
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
for line in sys.stdin:
    parts = line.split()
    if not parts:
        continue
    app, properties = parts[1], {}
    if parts[0] == 'show':
        properties = {'progress': GLib.Variant('d', float(parts[2])), 'progress-visible': GLib.Variant('b', True)}
    elif parts[0] == 'progress':
        properties = {'progress': GLib.Variant('d', float(parts[2]))}
    elif parts[0] == 'hide':
        properties = {'progress-visible': GLib.Variant('b', False)}
    bus.emit_signal(None, '/org/notchy/test/entry', 'com.canonical.Unity.LauncherEntry', 'Update', GLib.Variant('(sa{sv})', (f'application://{app}', properties)))
    bus.flush_sync(None)
    print('ok', flush=True)
