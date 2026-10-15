#!/usr/bin/python3
"""Real GTK file drag source for the private GNOME compositor."""
import json
from pathlib import Path
import sys
import os
os.environ['GDK_BACKEND'] = os.environ.get('NOTCHY_DROP_SOURCE_BACKEND', 'wayland')
if os.environ.get('NOTCHY_DROP_DEBUG'):
    os.environ['WAYLAND_DEBUG'] = 'client'
import gi

gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
from gi.repository import Gdk, Gio, Gtk


app = Gtk.Application(application_id='org.notchy.DropSource')
state = {'cancelled': False}


def activate(application):
    window = Gtk.ApplicationWindow(application=application, title='Notchy Drop Source', decorated=False,
                                   default_width=360, default_height=150)
    source = Gtk.Label(label='Drag these real files to Notchy', hexpand=True, vexpand=True)
    window.set_child(source)
    drag = Gtk.DragSource(actions=Gdk.DragAction.COPY)
    drag.connect('prepare', lambda *_: Gdk.ContentProvider.new_for_value(
        Gdk.FileList.new_from_list([Gio.File.new_for_uri(uri) for uri in sys.argv[2:]])))
    drag.connect('drag-cancel', lambda *_: state.update(cancelled=True) or False)
    def ended(_source, _drag, delete_data):
        state['delete_data'] = delete_data
        Path(sys.argv[1]).write_text(json.dumps(state))
    drag.connect('drag-end', ended)
    source.add_controller(drag)
    window.present()


app.connect('activate', activate)
app.run([])
