#!/usr/bin/python3
"""Prewarmed native Wayland file receiver, shown at the Notchy surface."""
import json
from pathlib import Path
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
.notchy-zone.active { border-color: #ffb38a; background: rgba(255,179,138,0.16); }
.notchy-zone image { color: #ffb38a; }
/* AirDrop keeps Apple's blue, as in the Shell. */
.notchy-zone.airdrop { border-color: rgba(110,180,255,0.6); background: rgba(10,132,255,0.10); }
.notchy-zone.airdrop.active { border-color: #6cb4ff; background: rgba(10,132,255,0.22); }
.notchy-zone.airdrop image { color: #6cb4ff; }
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
        # Below the island's clock: dashed zones that take files into the Regal
        # or, with AirDrop installed, send them to an iPhone.
        zones = Gtk.Box(spacing=10)
        self.root = Gtk.Frame(child=zones, css_classes=['notchy-drop'], overflow=Gtk.Overflow.HIDDEN)
        self.window.set_child(self.root)
        self.area = self.zone(zones, 'shelf', Gtk.Image.new_from_icon_name('document-save-symbolic'), 'Ins Regal legen', 'Original bleibt, wo es ist')
        icon = Gio.FileIcon.new(Gio.File.new_for_path(str(Path(__file__).resolve().parent.parent / 'src' / 'icons' / 'notchy-airdrop-symbolic.svg')))
        self.airdrop_zone = self.zone(zones, 'airdrop', Gtk.Image(gicon=icon), 'AirDrop', 'An ein iPhone senden')
        self.airdrop_zone.set_hexpand(False)
        self.airdrop_zone.set_size_request(150, -1)
        self.airdrop_zone.set_visible(False)
        # The whole window takes files into the Regal, as before the split; only
        # the AirDrop zone has a target of its own on top (the deepest one wins).
        target = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        target.connect('enter', lambda *_: self.highlight(self.area, True))
        target.connect('leave', lambda *_: self.highlight(self.area, False))
        target.connect('drop', lambda _t, value, _x, _y: self.drop(value, 'shelf'))
        self.window.add_controller(target)
        self.proxy.connect('g-signal', self.signal)
        self.proxy.connect('notify::g-name-owner', lambda *_: self.quit() if not self.proxy.get_name_owner() else None)
        self.call('DropReady', GLib.Variant('(s)', (BACKEND,)))

    def zone(self, parent, kind, image, title, hint):
        area = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5, css_classes=['notchy-zone', kind], valign=Gtk.Align.FILL, vexpand=True, hexpand=True)
        image.set_pixel_size(26)
        image.set_margin_top(22)
        area.append(image)
        area.append(Gtk.Label(label=title, css_classes=['title']))
        area.append(Gtk.Label(label=hint, css_classes=['hint'], ellipsize=3))
        parent.append(area)
        if kind != 'airdrop':
            return area
        target = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        target.connect('enter', lambda *_: self.highlight(area, True))
        target.connect('leave', lambda *_: self.highlight(area, False))
        target.connect('drop', lambda _t, value, _x, _y: self.drop(value, kind))
        area.add_controller(target)
        return area

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
            self.airdrop_zone.set_visible(bool(config.get('airdrop')))
            self.window.set_default_size(config['width'], config['height'])
            self.window.set_visible(True)
        else:
            self.window.set_visible(False)
            for area in (self.area, self.airdrop_zone):
                area.remove_css_class('active')

    def highlight(self, area, active):
        area.add_css_class('active') if active else area.remove_css_class('active')
        self.call('DropHover', GLib.Variant('(sb)', (BACKEND, active)))
        return Gdk.DragAction.COPY

    def drop(self, value, kind='shelf'):
        if not value or not value.get_files() or any(file.get_path() is None for file in value.get_files()):
            return False
        uris = '\r\n'.join(file.get_uri() for file in value.get_files())
        # Keep the protocol's success response tied to a completed shelf write
        # (or an AirDrop send that started).
        try:
            reply = self.proxy.call_sync('AirDropDropped' if kind == 'airdrop' else 'AddDroppedUris', GLib.Variant('(s)', (uris,)),
                                         Gio.DBusCallFlags.NONE, 3000, None)
        except GLib.Error as error:
            print(f'Notchy drop receiver: {error.message}', file=sys.stderr)
            return False
        for area in (self.area, self.airdrop_zone):
            area.remove_css_class('active')
        return bool(reply.unpack()[0]) if kind == 'airdrop' else True


if __name__ == '__main__':
    DropReceiver().run([])
