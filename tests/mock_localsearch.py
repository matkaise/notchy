#!/usr/bin/python3
"""A stand-in for GNOME LocalSearch's SPARQL endpoint on the private test bus.

It answers Query(s, h, a{sv}) like Tracker: rows written to the passed file
descriptor in Tracker's cursor format. Matching follows the full-text prefix
semantics for file names. Every query is logged (one JSON line) so the test can
count requests; a query whose term starts with the configured slow prefix is
answered late, to prove that stale answers are dropped.
usage: mock_localsearch.py LOGFILE SLOW_PREFIX PATH...
"""
import json
import os
from pathlib import Path
import re
import struct
import sys
import threading
import time
import unicodedata

from gi.repository import Gio, GLib

NAME = 'org.notchy.LocalSearchTest'
XML = '''<node><interface name="org.freedesktop.Tracker3.Endpoint">
 <method name="Query"><arg type="s" direction="in"/><arg type="h" direction="in"/><arg type="a{sv}" direction="in"/><arg type="as" direction="out"/></method>
</interface></node>'''
log, slow, paths = sys.argv[1], sys.argv[2], sys.argv[3:]


def fold(text):
    return ''.join(c for c in unicodedata.normalize('NFKD', text.casefold()) if not unicodedata.combining(c))


def rows(terms):
    prefixes = [term.rstrip('*') for term in terms.split()]
    out = []
    for path in paths:
        words = re.findall(r'\w+', fold(os.path.basename(path)))
        if all(any(word.startswith(prefix) for word in words) for prefix in prefixes):
            out.append([Path(path).as_uri(), os.path.basename(path)])
    return out


def encode(table):
    data = b''
    for row in table:
        data += struct.pack('=i', len(row)) + struct.pack(f'={len(row)}i', *[2] * len(row)) + struct.pack(f'={len(row)}i', *[0] * len(row))
        data += b''.join(value.encode() + b'\0' for value in row)
    return data


def handle(_connection, _sender, _path, _iface, method, params, invocation):
    query, index, arguments = params.unpack()
    terms = arguments.get('match', '')
    # Take the descriptors over, so the only copy is closed once written.
    fds = invocation.get_message().get_unix_fd_list().steal_fds()
    fd = fds[index]
    for other in fds:
        if other != fd:
            os.close(other)
    with open(log, 'a') as out:
        out.write(json.dumps({'terms': terms, 'query': query, 'time': time.monotonic()}) + '\n')

    def answer():
        if slow and terms.startswith(slow):
            time.sleep(0.9)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encode(rows(terms)))
    # Like Tracker: the reply returns once the cursor is written.
    def finish():
        answer()
        GLib.idle_add(lambda: invocation.return_value(GLib.Variant('(as)', (['url', 'name'],))) and False)
    threading.Thread(target=finish, daemon=True).start()


bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
bus.register_object('/org/freedesktop/Tracker3/Endpoint', Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], handle, None, None)
Gio.bus_own_name_on_connection(bus, NAME, Gio.BusNameOwnerFlags.NONE, None, None)
GLib.MainLoop().run()
