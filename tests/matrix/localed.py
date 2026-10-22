#!/usr/bin/python3
# Stand-in for systemd-localed on the container's private system bus, started
# by scripts/test-matrix.sh when the image ships it (Dockerfile.fedora).
# Fedora's libgnome-desktop 44 (GNOME Shell 47.10) crashes the Shell at
# startup when org.freedesktop.locale1 cannot be reached; a desktop always has it.
import os
from gi.repository import Gio, GLib
XML = '''<node><interface name="org.freedesktop.locale1">
<property name="Locale" type="as" access="read"/>
<property name="VConsoleKeymap" type="s" access="read"/>
<property name="VConsoleKeymapToggle" type="s" access="read"/>
<property name="X11Layout" type="s" access="read"/>
<property name="X11Model" type="s" access="read"/>
<property name="X11Variant" type="s" access="read"/>
<property name="X11Options" type="s" access="read"/>
</interface></node>'''
PROPS = {'Locale': GLib.Variant('as', ['LANG=' + os.environ.get('LANG', 'C.UTF-8')]), 'VConsoleKeymap': GLib.Variant('s', 'us'),
         'VConsoleKeymapToggle': GLib.Variant('s', ''), 'X11Layout': GLib.Variant('s', 'us'),
         'X11Model': GLib.Variant('s', ''), 'X11Variant': GLib.Variant('s', ''), 'X11Options': GLib.Variant('s', '')}
info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]
def acquired(conn, _name):
    conn.register_object('/org/freedesktop/locale1', info, None, lambda c, s, p, i, prop: PROPS[prop], None)
Gio.bus_own_name(Gio.BusType.SYSTEM, 'org.freedesktop.locale1', Gio.BusNameOwnerFlags.NONE, acquired, None, None)
GLib.MainLoop().run()
