#!/usr/bin/python3
"""Prewarmed native Wayland file receiver, shown at the Notchy surface."""
import json
import sys
import gi

gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
from gi.repository import Gdk, Gio, GLib, Gtk
from i18n import _
from icons import gicon, image

BACKEND = sys.argv[1] if len(sys.argv) > 1 else 'wayland'

BUS = 'org.gnome.Shell.Extensions.Notchy'
PATH = '/org/gnome/Shell/Extensions/Notchy'
CSS = '''
window.notchy-receiver, window.notchy-receiver > contents { background: transparent; background-image: none; color: #f4f4f6; border: none; box-shadow: none; padding: 0; margin: 0; }
window.notchy-receiver *:drop(active), window.notchy-receiver:drop(active) { box-shadow: none; outline: none; }
frame.notchy-drop > border { border: none; box-shadow: none; }
frame.notchy-drop { background: transparent; border: none; border-radius: 0 0 30px 30px; padding: 0 12px 12px; }
/* Two cards: the one under the pointer grows and lights up, the other keeps
   its symbol and name. AirDrop keeps Apple's blue, as in the Shell. */
.notchy-zone { border-radius: 20px; border: 1.5px solid #26262a; background: #141416; padding: 0 18px; }
.notchy-zone .badge { border-radius: 20px; min-width: 40px; min-height: 40px; background: #2e2419; }
.notchy-zone .badge image { color: #f2a25c; }
.notchy-zone.airdrop .badge { background: #1d2633; }
.notchy-zone.airdrop .badge image { color: #6cb4ff; }
.notchy-zone.active { border-color: #f2a25c; background: rgba(242,162,92,0.13); }
.notchy-zone.active .badge { min-width: 52px; min-height: 52px; border-radius: 26px; background: #f2a25c; }
.notchy-zone.airdrop.active { border-color: #5aa9ff; background: rgba(90,169,255,0.13); }
.notchy-zone.airdrop.active .badge { background: #5aa9ff; }
.notchy-zone.active .badge image { color: #000000; }
.title { font-size: 14px; font-weight: 700; color: #d6d6da; }
.notchy-zone.active .title { font-size: 16.5px; color: #ffffff; }
.hint { font-size: 12.5px; color: #c9c2ba; }
.notchy-zone.airdrop .hint { color: #b9c7d8; }
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
        # or send them to a phone — AirDrop when its backend is installed (the
        # banner offers the QR code too), else by QR code.
        zones = Gtk.Box(spacing=10)
        self.root = Gtk.Frame(child=zones, css_classes=['notchy-drop'], overflow=Gtk.Overflow.HIDDEN)
        self.window.set_child(self.root)
        self.area = self.zone(zones, 'shelf', image('document-save-symbolic'), (_('Shelf'), _('Add to Shelf')), None)
        self.airdrop_image = image('notchy-airdrop-symbolic')
        self.airdrop_zone = self.zone(zones, 'airdrop', self.airdrop_image, (_('Phone'), _('Send to Phone')), _('AirDrop or QR code'))
        self.airdrop_zone.set_visible(False)
        self.inside = {'shelf': False, 'airdrop': False}
        self.arrange()
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

    def zone(self, parent, kind, image, titles, hint):
        area = Gtk.Box(css_classes=['notchy-zone', kind], valign=Gtk.Align.FILL, vexpand=True)
        content = Gtk.Box(spacing=14, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER, hexpand=True)
        badge = Gtk.Box(css_classes=['badge'], valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)
        image.set_pixel_size(22)
        image.set_hexpand(True)
        image.set_halign(Gtk.Align.CENTER)
        badge.append(image)
        content.append(badge)
        texts = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3, valign=Gtk.Align.CENTER)
        area.notchy_title = Gtk.Label(css_classes=['title'], ellipsize=3)
        # The Regal's card says only what it does; AirDrop adds where it goes.
        area.notchy_hint = Gtk.Label(label=hint or '', css_classes=['hint'], ellipsize=3, xalign=0)
        area.notchy_has_hint = bool(hint)
        texts.append(area.notchy_title)
        texts.append(area.notchy_hint)
        content.append(texts)
        area.append(content)
        area.notchy_content, area.notchy_texts, area.notchy_titles = content, texts, titles
        parent.append(area)
        if kind != 'airdrop':
            return area
        target = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        target.connect('enter', lambda *_: self.highlight(area, True))
        target.connect('leave', lambda *_: self.highlight(area, False))
        target.connect('drop', lambda _t, value, _x, _y: self.drop(value, kind))
        area.add_controller(target)
        return area

    # The card under the pointer (else the Regal's) is wide: its symbol, the
    # action and a line beneath. The other one is narrow: symbol over name.
    def arrange(self):
        zones = [zone for zone in (self.area, self.airdrop_zone) if zone.get_visible()]
        lit = next((zone for zone in zones if zone.has_css_class('active')), None)
        wide = lit if lit is not None else self.area
        for zone in (self.area, self.airdrop_zone):
            expanded = zone is wide or len(zones) == 1
            zone.set_hexpand(expanded)
            zone.set_size_request(-1 if expanded else 170, -1)
            zone.notchy_content.set_orientation(Gtk.Orientation.HORIZONTAL if expanded else Gtk.Orientation.VERTICAL)
            zone.notchy_content.set_spacing(14 if expanded else 8)
            zone.notchy_texts.set_halign(Gtk.Align.START if expanded else Gtk.Align.CENTER)
            zone.notchy_title.set_xalign(0 if expanded else 0.5)
            zone.notchy_title.set_label(zone.notchy_titles[1] if expanded else zone.notchy_titles[0])
            zone.notchy_hint.set_visible(expanded and zone.notchy_has_hint)

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
            # The Shell shows this window on top of the island's glass (Island.syncPane);
            # Dynamic Glass continues its black-to-glass shade here, Liquid Glass stays clear.
            shade = config.get('shade') or {}
            black, fade = int(shade.get('black', 0)), int(shade.get('fade', 70))
            css = (f'frame.notchy-drop {{ background: linear-gradient(to bottom, #000 0px, #000 {black}px, rgba(0,0,0,0) {black + fade}px, rgba(0,0,0,0) 100%); }}'
                   if config.get('style') != 'liquid' else '')
            self.shade_provider.load_from_data(css.encode())
            self.airdrop_zone.set_visible(bool(config.get('airdrop')))
            backend = bool(config.get('airdropBackend', config.get('airdrop')))
            self.airdrop_zone.notchy_hint.set_label(_('AirDrop or QR code') if backend else _('By QR code, any phone'))
            self.airdrop_image.set_from_gicon(gicon('notchy-airdrop-symbolic' if backend else 'notchy-qr-symbolic'))
            self.arrange()
            self.window.set_default_size(config['width'], config['height'])
            self.window.set_visible(True)
        else:
            self.window.set_visible(False)
            self.reset()

    def highlight(self, area, active):
        # The whole window is the Regal's target and keeps the drag while the
        # pointer is over the AirDrop card: that card wins, only one lights up.
        self.inside['airdrop' if area is self.airdrop_zone else 'shelf'] = active
        airdrop = self.inside['airdrop'] and self.airdrop_zone.get_visible()
        self.airdrop_zone.add_css_class('active') if airdrop else self.airdrop_zone.remove_css_class('active')
        self.area.add_css_class('active') if self.inside['shelf'] and not airdrop else self.area.remove_css_class('active')
        self.arrange()
        self.call('DropHover', GLib.Variant('(sb)', (BACKEND, self.inside['shelf'] or self.inside['airdrop'])))
        return Gdk.DragAction.COPY

    def reset(self):
        self.inside = {'shelf': False, 'airdrop': False}
        for area in (self.area, self.airdrop_zone):
            area.remove_css_class('active')
        self.arrange()

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
        self.reset()
        return bool(reply.unpack()[0]) if kind == 'airdrop' else True


if __name__ == '__main__':
    DropReceiver().run([])
