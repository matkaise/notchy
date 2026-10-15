#!/usr/bin/python3
"""Private fixture, never takes GNOME's real calendar service name."""
import datetime
import signal
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
BUS = 'org.gnome.Shell.CalendarServer.NotchyTest'
IFACE = 'org.gnome.Shell.CalendarServer'
PATH = '/org/gnome/Shell/CalendarServer'
XML = f'''<node><interface name="{IFACE}">
<method name="SetTimeRange"><arg type="x" direction="in"/><arg type="x" direction="in"/><arg type="b" direction="in"/></method>
<signal name="EventsAddedOrUpdated"><arg type="a(ssxxa{{sv}})"/></signal>
<signal name="EventsRemoved"><arg type="as"/></signal>
<signal name="ClientDisappeared"><arg type="s"/></signal>
<property name="HasCalendars" type="b" access="read"/></interface>
<interface name="org.notchy.CalendarFixture"><method name="Update"/><method name="Remove"/></interface></node>'''
loop = GLib.MainLoop()
connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
now = datetime.datetime.now().replace(hour=13, minute=0, second=0, microsecond=0)
start = int(now.timestamp())
uid = 'fixture-calendar\nmeeting\n'
title = 'Design review'

def publish():
    connection.emit_signal(None, PATH, IFACE, 'EventsAddedOrUpdated', GLib.Variant('(a(ssxxa{sv}))', ([(uid, title, start, start + 3600, {})],)))

def method(_connection, _sender, _path, interface, name, params, invocation):
    global title
    if name == 'SetTimeRange':
        begin, end, _force = params.unpack()
        if begin <= start < end:
            publish()
    elif name == 'Update':
        title = 'Updated review'; publish()
    elif name == 'Remove':
        connection.emit_signal(None, PATH, IFACE, 'EventsRemoved', GLib.Variant('(as)', ([uid],)))
    invocation.return_value(None)

for info in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
    connection.register_object(PATH, info, method, lambda *_: GLib.Variant('b', True), None)
Gio.bus_own_name_on_connection(connection, BUS, Gio.BusNameOwnerFlags.NONE, None, None)
for signum in (signal.SIGTERM, signal.SIGINT):
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signum, lambda: loop.quit() or GLib.SOURCE_REMOVE)
loop.run()
