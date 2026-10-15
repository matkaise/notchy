#!/usr/bin/python3
"""Native destination for an actual drag out of Notchy in the private session."""
import json
import os
from pathlib import Path
import sys

os.environ['GDK_BACKEND'] = 'wayland'
import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
from gi.repository import Gdk, Gio, Gtk


class Target(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='org.notchy.DropSource', flags=Gio.ApplicationFlags.NON_UNIQUE)

    def do_activate(self):
        self.window = Gtk.ApplicationWindow(application=self, title='Notchy Drop Destination', decorated=False, default_width=300, default_height=150)
        self.window.set_child(Gtk.Label(label='Native file destination'))
        target = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        target.connect('drop', self.drop)
        self.window.add_controller(target)
        self.window.present()

    def drop(self, _target, value, _x, _y):
        if not value:
            return False
        Path(sys.argv[1]).write_text(json.dumps([f.get_uri() for f in value.get_files()]))
        return True


Target().run([])
