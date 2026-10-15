#!/usr/bin/python3
"""Prewarmed native Wayland file receiver, shown at the Notchy surface."""
import json
import sys
import gi

gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
from gi.repository import Gdk, Gio, GLib, Gtk

BACKEND = sys.argv[1] if len(sys.argv) > 1 else 'wayland'

BUS = 'org.gnome.Shell.Extensions.Notchy'
PATH = '/org/gnome/Shell/Extensions/Notchy'
CSS = '''
window.notchy-receiver, window.notchy-receiver > contents { background: transparent; background-image: none; color: #f4f4f6; border: none; box-shadow: none; padding: 0; margin: 0; }
window.notchy-receiver *:drop(active), window.notchy-receiver:drop(active) { box-shadow: none; outline: none; }
frame.notchy-drop > border { border: none; box-shadow: none; }
frame.notchy-drop { background: transparent; border: none; border-radius: 0 0 30px 30px; padding: 0 12px 12px; }
.notchy-zone { border-radius: 22px; border: 1.5px dashed rgba(255,200,170,0.6); background: rgba(255,179,138,0.08); }
frame.notchy-drop.active .notchy-zone { border-color: #ffb38a; background: rgba(255,179,138,0.16); }
.notchy-zone image { color: #ffb38a; }
.title { font-size: 13.5px; font-weight: 700; }
.hint { font-size: 11.5px; color: rgba(255,255,255,0.6); }
'''


class DropReceiver(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='org.notchy.DropTarget', flags=Gio.ApplicationFlags.NON_UNIQUE)

    def do_activate(self):
        self.hold()
        self.proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None, BUS, PATH, BUS, None)
        if not self.proxy.get_name_owner():
            self.quit()
            return
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS.encode())
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
        self.shade_provider = Gtk.CssProvider()
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), self.shade_provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 2)
        self.window = Gtk.ApplicationWindow(application=self, title='Notchy Drop Target X11' if BACKEND == 'x11' else 'Notchy Drop Target', decorated=False, resizable=False,
                                            default_width=560, default_height=132)
        self.window.add_css_class('notchy-receiver')
        # Below the island's clock: a dashed zone that takes files into the Regal.
        self.area = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5, css_classes=['notchy-zone'], valign=Gtk.Align.FILL, vexpand=True)
        self.root = Gtk.Frame(child=self.area, css_classes=['notchy-drop'], overflow=Gtk.Overflow.HIDDEN)
        self.window.set_child(self.root)
        image = Gtk.Image.new_from_icon_name('document-save-symbolic')
        image.set_pixel_size(26)
        image.set_margin_top(22)
        self.area.append(image)
        self.area.append(Gtk.Label(label='Ins Regal legen', css_classes=['title']))
        self.area.append(Gtk.Label(label='Original bleibt, wo es ist', css_classes=['hint']))
        target = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        target.connect('enter', lambda *_: self.highlight(True))
        target.connect('leave', lambda *_: self.highlight(False))
        target.connect('drop', self.drop)
        self.window.add_controller(target)
        self.proxy.connect('g-signal', self.signal)
        self.proxy.connect('notify::g-name-owner', lambda *_: self.quit() if not self.proxy.get_name_owner() else None)
        self.call('DropReady', GLib.Variant('(s)', (BACKEND,)))

    def call(self, method, values):
        self.proxy.call(method, values, Gio.DBusCallFlags.NONE, 3000, None, self.finished)

    def finished(self, proxy, result):
        try:
            proxy.call_finish(result)
        except GLib.Error as error:
            print(f'Notchy drop receiver: {error.message}', file=sys.stderr)

    def signal(self, _proxy, _sender, name, values):
        if name != 'DropTarget':
            return
        config = json.loads(values.unpack()[0])
        if config.get('visible') and config.get('backend') == BACKEND:
            self.root.add_css_class('liquid') if config.get('style') == 'liquid' else self.root.remove_css_class('liquid')
            # The Shell paints the island's glass below this window (src/ui/backdrop.js);
            # Dynamic Glass continues its black-to-glass shade here, Liquid Glass stays clear.
            shade = config.get('shade') or {}
            black, fade = int(shade.get('black', 0)), int(shade.get('fade', 70))
            css = (f'frame.notchy-drop {{ background: linear-gradient(to bottom, #000 0px, #000 {black}px, rgba(0,0,0,0) {black + fade}px, rgba(0,0,0,0) 100%); }}'
                   if config.get('style') != 'liquid' else '')
            self.shade_provider.load_from_data(css.encode())
            self.window.set_default_size(config['width'], config['height'])
            self.window.set_visible(True)
        else:
            self.window.set_visible(False)
            self.root.remove_css_class('active')

    def highlight(self, active):
        self.root.add_css_class('active') if active else self.root.remove_css_class('active')
        self.call('DropHover', GLib.Variant('(sb)', (BACKEND, active)))
        return Gdk.DragAction.COPY

    def drop(self, _target, value, _x, _y):
        if not value or not value.get_files() or any(file.get_path() is None for file in value.get_files()):
            return False
        # Keep the protocol's success response tied to a completed shelf write.
        try:
            self.proxy.call_sync('AddDroppedUris', GLib.Variant('(s)', ('\r\n'.join(file.get_uri() for file in value.get_files()),)),
                                 Gio.DBusCallFlags.NONE, 3000, None)
        except GLib.Error as error:
            print(f'Notchy drop receiver: {error.message}', file=sys.stderr)
            return False
        self.root.remove_css_class('active')
        return True


if __name__ == '__main__':
    DropReceiver().run([])
