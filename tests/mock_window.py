#!/usr/bin/python3
"""A native Wayland window for desktop-layer hit-testing, in the private bus."""
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib

app = Gtk.Application(application_id='org.notchy.LayerFixture')


def activate(application):
    window = Gtk.ApplicationWindow(application=application, title='Notchy Layer Fixture', default_width=640, default_height=480)
    content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, valign=Gtk.Align.CENTER)
    content.append(Gtk.Label(label='Native Test Window'))
    content.append(Gtk.Label(label='Private GNOME layer fixture'))
    window.set_child(content)
    window.present()
    GLib.timeout_add_seconds(15, lambda: application.quit() or GLib.SOURCE_REMOVE)


app.connect('activate', activate)
app.run([])
