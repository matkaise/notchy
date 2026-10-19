#!/usr/bin/python3
"""Private MPRIS fixture with native TrackList, playback and local LRC sidecars."""
import os
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
from gi.repository import Gio, GLib

NAME = 'org.mpris.MediaPlayer2.NotchyTest'
PATH = '/org/mpris/MediaPlayer2'
IFACE = 'org.mpris.MediaPlayer2.Player'
TRACKS = 'org.mpris.MediaPlayer2.TrackList'
ROOT = 'org.mpris.MediaPlayer2'
XML = '''<node><interface name="org.mpris.MediaPlayer2.Player">
<method name="PlayPause"/><method name="Play"/><method name="Pause"/><method name="Previous"/><method name="Next"/>
<method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
<property name="PlaybackStatus" type="s" access="read"/>
<property name="Metadata" type="a{sv}" access="read"/>
<property name="Position" type="x" access="read"/>
<property name="Shuffle" type="b" access="readwrite"/>
<property name="LoopStatus" type="s" access="readwrite"/>
<property name="CanSeek" type="b" access="read"/>
<property name="CanGoNext" type="b" access="read"/>
<property name="CanGoPrevious" type="b" access="read"/>
<property name="CanControl" type="b" access="read"/>
<signal name="Seeked"><arg type="x"/></signal>
</interface>
<interface name="org.mpris.MediaPlayer2"><method name="Raise"/><property name="CanRaise" type="b" access="read"/><property name="DesktopEntry" type="s" access="read"/><property name="HasTrackList" type="b" access="read"/><property name="Identity" type="s" access="read"/><property name="SupportedUriSchemes" type="as" access="read"/></interface>
<interface name="org.mpris.MediaPlayer2.TrackList">
<method name="GetTracksMetadata"><arg type="ao" direction="in"/><arg type="aa{sv}" direction="out"/></method>
<method name="GoTo"><arg type="o" direction="in"/></method>
<method name="RemoveTrack"><arg type="o" direction="in"/></method>
<method name="AddTrack"><arg type="s" direction="in"/><arg type="o" direction="in"/><arg type="b" direction="in"/></method>
<property name="Tracks" type="ao" access="read"/><property name="CanEditTracks" type="b" access="read"/>
<signal name="TrackListReplaced"><arg type="ao"/><arg type="o"/></signal>
<signal name="TrackRemoved"><arg type="o"/></signal>
<signal name="TrackAdded"><arg type="a{sv}"/><arg type="o"/></signal>
</interface></node>'''
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
base = Path(os.environ.get('NOTCHY_TEST_OUTPUT', '/tmp/notchy-fixtures'))
base.mkdir(parents=True, exist_ok=True)
song = base / 'notchy-test-track.mp3'
song.write_bytes(b'')
song.with_suffix('.lrc').write_text('[ar:Lumen Park]\n[00:00.00]A quiet morning on the bridge\n[00:01.00]Our footsteps meet the light\n[00:05.00]The city opens slowly\n[00:10.00]And every window shines\n')
raised = base / 'notchy-test-raised'
raised.unlink(missing_ok=True)
# Deliberately synthetic test artwork, served locally, never a real provider.
pixels = bytes(channel for y in range(320) for x in range(320) for channel in (25 + x // 3, 12 + y // 5, 70 + (x + y) // 4))
art = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(pixels), GdkPixbuf.Colorspace.RGB, False, 8, 320, 320, 960)
art.savev(str(base / 'notchy-test-cover.png'), 'png', [], [])
cover_data = (base / 'notchy-test-cover.png').read_bytes()


class CoverServer(BaseHTTPRequestHandler):
    def do_GET(self):
        data = cover_data if self.path == '/cover.png' else b'not an image'
        self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), CoverServer)
threading.Thread(target=server.serve_forever, daemon=True).start()
cover_url = f'http://127.0.0.1:{server.server_port}/cover.png'

def metadata(number, title, uri=''):
    return {'xesam:title': GLib.Variant('s', title), 'xesam:artist': GLib.Variant('as', ['Lumen Park']),
            'mpris:length': GLib.Variant('x', 196000000), 'mpris:trackid': GLib.Variant('o', f'/org/mpris/MediaPlayer2/track/{number}'),
            'mpris:artUrl': GLib.Variant('s', cover_url if number == 1 else (base / 'notchy-test-cover.png').as_uri() if number == 2 else cover_url.replace('/cover.png', '/invalid.png') if number == 3 else ''),
            'xesam:url': GLib.Variant('s', uri)}
tracks = {f'/org/mpris/MediaPlayer2/track/{i}': metadata(i, title, song.as_uri() if i == 1 else '') for i, title in enumerate(['Paper Moons', 'Night Transit', 'Slow Orbit'], 1)}
props = {'PlaybackStatus': GLib.Variant('s', 'Playing'), 'Metadata': GLib.Variant('a{sv}', next(iter(tracks.values()))),
         'Position': GLib.Variant('x', 1000000), 'Shuffle': GLib.Variant('b', False), 'LoopStatus': GLib.Variant('s', 'None'),
         **{name: GLib.Variant('b', True) for name in ['CanSeek', 'CanGoNext', 'CanGoPrevious', 'CanControl']}}

position_stamp = time.monotonic()
def position_now():
    elapsed = int((time.monotonic() - position_stamp) * 1000000) if props['PlaybackStatus'].unpack() == 'Playing' else 0
    return props['Position'].unpack() + elapsed


def emit(name, value):
    props[name] = value
    bus.emit_signal(None, PATH, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', GLib.Variant('(sa{sv}as)', (IFACE, {name: value}, [])))


def go_to(track):
    global position_stamp
    if track in tracks:
        props['Position'] = GLib.Variant('x', 0); position_stamp = time.monotonic()
        emit('Metadata', GLib.Variant('a{sv}', tracks[track]))


def method(_conn, _sender, _path, iface, name, parameters, invocation):
    global position_stamp
    if iface == ROOT and name == 'Raise':
        raised.write_text('raised')
    elif iface == TRACKS:
        if name == 'GetTracksMetadata':
            invocation.return_value(GLib.Variant('(aa{sv})', ([tracks[x] for x in parameters.unpack()[0] if x in tracks],)))
            return
        if name == 'GoTo':
            go_to(parameters.unpack()[0])
        elif name == 'RemoveTrack':
            track = parameters.unpack()[0]; tracks.pop(track, None)
            bus.emit_signal(None, PATH, TRACKS, 'TrackRemoved', GLib.Variant('(o)', (track,)))
        elif name == 'AddTrack':
            uri, after, current = parameters.unpack(); number = 4; track = f'/org/mpris/MediaPlayer2/track/{number}'
            tracks[track] = metadata(number, 'Added track', uri)
            bus.emit_signal(None, PATH, TRACKS, 'TrackAdded', GLib.Variant('(a{sv}o)', (tracks[track], after)))
            if current:
                go_to(track)
    elif name in ('PlayPause', 'Play', 'Pause'):
        props['Position'] = GLib.Variant('x', position_now()); position_stamp = time.monotonic()
        playing = props['PlaybackStatus'].unpack() == 'Playing'
        emit('PlaybackStatus', GLib.Variant('s', {'Play': 'Playing', 'Pause': 'Paused'}.get(name, 'Paused' if playing else 'Playing')))
    elif name == 'SetPosition':
        _track, position = parameters.unpack(); props['Position'] = GLib.Variant('x', position); position_stamp = time.monotonic()
        bus.emit_signal(None, PATH, IFACE, 'Seeked', GLib.Variant('(x)', (position,)))
    elif name in ('Next', 'Previous'):
        # Like Spotify and browsers: between two tracks the player briefly
        # reports Stopped and no metadata, then the next track.
        ids = list(tracks); current = props['Metadata'].unpack()['mpris:trackid']; idx = ids.index(current)
        target, status = ids[(idx + (1 if name == 'Next' else -1)) % len(ids)], props['PlaybackStatus']
        emit('PlaybackStatus', GLib.Variant('s', 'Stopped')); emit('Metadata', GLib.Variant('a{sv}', {}))
        def resume():
            go_to(target); emit('PlaybackStatus', status); return False
        GLib.timeout_add(400, resume)
    invocation.return_value(None)


def get_property(_conn, _sender, _path, iface, name):
    if iface == TRACKS:
        return GLib.Variant('ao', list(tracks)) if name == 'Tracks' else GLib.Variant('b', True)
    if iface == ROOT:
        return {'CanRaise': GLib.Variant('b', True), 'DesktopEntry': GLib.Variant('s', ''), 'HasTrackList': GLib.Variant('b', True), 'Identity': GLib.Variant('s', 'NotchyTest'), 'SupportedUriSchemes': GLib.Variant('as', ['file', 'https', 'http'])}[name]
    return GLib.Variant('x', position_now()) if name == 'Position' else props[name]


def set_property(_conn, _sender, _path, _iface, name, value):
    emit(name, value); return True

for info in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
    bus.register_object(PATH, info, method, get_property, set_property)
Gio.bus_own_name_on_connection(bus, NAME, Gio.BusNameOwnerFlags.NONE, None, None)
GLib.MainLoop().run()
