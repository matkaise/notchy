#!/usr/bin/python3
"""Native Wayland drag source/target for the Regal and the floating Korb, positioned by the extension."""
import json
import os
from pathlib import Path
import shutil
import sys
import gi

gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
gi.require_version('Graphene', '1.0')
gi.require_version('Gsk', '4.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Graphene, Gsk, Gtk
from i18n import _, ngettext
from icons import image

BUS = 'org.gnome.Shell.Extensions.Notchy'
PATH = '/org/gnome/Shell/Extensions/Notchy'
IMAGES = ('.png', '.jpg', '.jpeg', '.webp', '.heic', '.tiff', '.bmp', '.gif', '.svg')
# A file's kind: the colour of its type label (matching the Shell preview).
KINDS = {'pdf': 'pdf', 'md': 'text', 'txt': 'text', 'json': 'text', 'csv': 'text', 'log': 'text',
         'zip': 'archive', 'gz': 'archive', 'tar': 'archive', 'xz': 'archive', '7z': 'archive', 'rar': 'archive',
         'mp4': 'video', 'mkv': 'video', 'webm': 'video', 'mov': 'video', 'avi': 'video',
         'mp3': 'audio', 'flac': 'audio', 'ogg': 'audio', 'wav': 'audio', 'm4a': 'audio', 'opus': 'audio',
         'doc': 'doc', 'docx': 'doc', 'odt': 'doc', 'rtf': 'doc', 'xls': 'doc', 'xlsx': 'doc', 'ods': 'doc', 'ppt': 'doc', 'pptx': 'doc', 'odp': 'doc'}
# The Shell shows this pane on top of the island's glass (Island.syncPane); the
# pane itself stays clear there and only paints Dynamic Glass's black shade.
CLEAR = 'rgba(0,0,0,0)'
# The Korb's window (Companion.open places it) and its fanned stack.
BASKET = (280, 262)
FAN = (190, 100)


def airdrop_image():
    return image('notchy-airdrop-symbolic')


# Buttons keep the focus where it was when clicked: a header button that hides
# itself (the selection changed) would hand it to a tile, and the grid selects
# the tile it focuses, replacing the selection just made. The keyboard still
# reaches them with Tab.
def icon_button(name, tooltip, classes=('circle',), **props):
    return Gtk.Button(child=image(name), tooltip_text=tooltip, css_classes=list(classes), focus_on_click=False, **props)


def pill(icon, text, tooltip, callback, classes=()):
    # A labelled action: its icon, a short word, the full name as tooltip.
    content = Gtk.Box(spacing=7, halign=Gtk.Align.CENTER)
    content.append(icon if isinstance(icon, Gtk.Widget) else image(icon))
    content.append(Gtk.Label(label=text))
    button = Gtk.Button(child=content, tooltip_text=tooltip, css_classes=['pill', *classes], focus_on_click=False)
    button.connect('clicked', lambda *_: callback())
    return button


def size_text(size):
    return GLib.format_size(size) if size else ''
CSS = '''
* { color: #f4f4f6; }
.title { font-size: 15px; font-weight: 700; }
.count { font-size: 12.5px; color: rgba(255,255,255,0.6); }
button { background: #1c1c1e; border-radius: 16px; padding: 0 13px; box-shadow: none; border: none; outline: none; min-height: 32px; font-size: 12.5px; }
button:hover { background: #2a2a2d; }
button:disabled { opacity: 0.35; }
button:focus-visible { outline: 1px solid rgba(255,255,255,0.35); outline-offset: -1px; }
button label, button image { color: #d6d6da; }
button.circle { padding: 0; min-width: 32px; border-radius: 16px; }
button.circle.danger image { color: #ff8f84; }
button.pill { padding: 0 13px 0 10px; }
button.airdrop image { color: #6cb4ff; }
button.primary { background: rgba(255,255,255,0.92); border-radius: 20px; min-height: 38px; padding: 0 18px 0 14px; font-weight: 700; outline: none; }
button.primary:hover { background: #ffffff; }
button.primary label, button.primary image { color: #000000; }
button.circle.large { min-width: 38px; min-height: 38px; border-radius: 19px; }
/* The Regal's tiles: a preview card, the name and the size beneath. */
flowboxchild { border-radius: 16px; padding: 2px; background: transparent; outline: none; box-shadow: none; }
flowboxchild:hover, flowboxchild:selected { background: transparent; box-shadow: none; }
.preview { border-radius: 14px; background: #141416; border: 1px solid #232326; }
flowboxchild:hover .preview { background: #19191c; border-color: #3a3a3e; }
flowboxchild:selected .preview { border-color: #f2a25c; box-shadow: inset 0 0 0 1px #f2a25c; }
.preview picture { border-radius: 13px; }
.check { background: #f2a25c; border-radius: 10px; min-width: 20px; min-height: 20px; margin: 5px; opacity: 0; }
.check image { color: #000000; }
flowboxchild:selected .check { opacity: 1; }
.sheet { min-width: 40px; min-height: 50px; border-radius: 6px; background: #2a2a2e; }
.ext { font-size: 9px; font-weight: 700; color: #000000; background: #b8c0cc; border-radius: 4px; padding: 1px 4px; margin-bottom: 6px; }
.ext.pdf { background: #f08a7e; }
.ext.archive { background: #e6c36a; }
.ext.video { background: #a99bf5; }
.ext.audio { background: #f2a25c; }
.ext.doc { background: #86b6f2; }
.ext.image { background: #7fd1a8; }
.name { font-size: 12px; }
.size { font-size: 11px; color: rgba(255,255,255,0.5); }
scrolledwindow.shelf-scroll > scrollbar { background: transparent; border: none; margin-left: 4px; }
scrolledwindow.shelf-scroll > scrollbar slider { min-width: 6px; margin: 0; border-radius: 6px; background: rgba(255,255,255,0.24); border: 2px solid transparent; }
scrolledwindow.shelf-scroll > scrollbar slider:hover { background: rgba(255,255,255,0.36); }
.drop-area { border-radius: 18px; }
.drop-area.active .preview { border-color: rgba(242,162,92,0.5); }
/* The empty Regal: a small stack of tiles, one line and a way to add files. */
.ghost { border-radius: 12px; background: #141416; border: 1.5px solid #2c2c30; }
.ghost.front { background: #1c1c1f; border-color: #3a3a3e; }
.ghost.front image { color: #f2a25c; }
.empty-title { font-size: 20px; font-weight: 700; }
.empty-hint { font-size: 14px; color: #a3abb8; }
/* The Korb: a well that lights up under a drag, the collected files as a fanned stack. */
.basket .basket-icon { color: #f2a25c; }
.basket .well { border-radius: 18px; background: #141416; border: 1.5px solid #141416; }
.basket .well.active { background: rgba(242,162,92,0.12); border-color: #f2a25c; }
.basket .badge { background: #2e2419; border-radius: 22px; min-width: 44px; min-height: 44px; }
.basket .badge image { color: #f2a25c; }
.basket .well.active .badge { background: #f2a25c; }
.basket .well.active .badge image { color: #000000; }
.basket .well-title { font-size: 14px; font-weight: 700; }
.basket .well-hint, .basket .caption { font-size: 12px; color: #c4c4c9; }
.basket .well { transition: background 260ms ease-out, border-color 260ms ease-out; }
.basket .fan-holder { padding: 3px; background: transparent; }
.basket .fan { border-radius: 9px; background: #2c2c30; border: 1px solid #44444a; box-shadow: 0 4px 10px rgba(0,0,0,0.45); }
.basket .fan picture { border-radius: 8px; }
.basket .fan .ext { font-size: 8px; margin-bottom: 5px; }
.basket .well.landed { background: rgba(242,162,92,0.2); border-color: #f2a25c; }
'''
WINDOW_CSS = '''
.tray.shelf { padding: 6px 22px 0; border-radius: 0; border: none; }
.tray.shelf.liquid { background: transparent; }
.tray.basket { background: rgba(12,12,14,0.97); border-radius: 26px; padding: 14px; border: none; }
/* GtkFrame draws its outline on a separate "border" node; it would leave a seam. */
frame.tray > border { border: none; box-shadow: none; margin: 0; padding: 0; }
/* GTK's own drop highlight (a green inset ring) would be a second effect. */
window.notchy-files *:drop(active), window.notchy-files:drop(active) { box-shadow: none; outline: none; }
window.notchy-files, window.notchy-files > contents {
    background: transparent; background-image: none; color: #f4f4f6;
    border: none; box-shadow: none; padding: 0; margin: 0;
}
/* The file context menu: a real popup (its own Wayland surface) in Notchy's
   dark glass style, above a user theme's popover styling. */
popover.notchy-menu { background: transparent; box-shadow: none; padding: 0; margin: 0; }
popover.notchy-menu > contents {
    background: rgba(28,26,31,0.98); background-image: none; color: #f4f4f6; border-radius: 14px; padding: 5px;
    border: 1px solid rgba(255,255,255,0.09); box-shadow: 0 10px 28px rgba(0,0,0,0.45); min-width: 220px;
}
popover.notchy-menu > arrow { background: transparent; border: none; }
popover.notchy-menu button.ctx-item { background: transparent; border-radius: 9px; padding: 4px 10px; min-height: 24px; font-size: 12.5px; box-shadow: none; border: none; outline: none; }
popover.notchy-menu button.ctx-item:hover, popover.notchy-menu button.ctx-item:focus-visible, popover.notchy-menu button.ctx-item:focus { background: rgba(255,255,255,0.1); }
popover.notchy-menu button.ctx-item image { color: rgba(255,255,255,0.78); }
popover.notchy-menu button.ctx-item.danger, popover.notchy-menu button.ctx-item.danger image { color: #ffb38a; }
popover.notchy-menu separator { margin: 4px 8px; background: rgba(255,255,255,0.1); min-height: 1px; }
popover.notchy-menu .ctx-title { font-size: 11.5px; font-weight: 700; color: rgba(255,255,255,0.55); padding: 3px 10px 3px; }
popover.notchy-menu .ctx-accel { color: rgba(255,255,255,0.38); font-size: 11px; }
'''


def kind_of(name):
    ext = Path(name).suffix.lower()
    return 'image' if ext in IMAGES else KINDS.get(ext.lstrip('.'), 'other')


def ease_out_back(t):
    return 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2


def ease_out_cubic(t):
    return 1 - (1 - t) ** 3


class Fan(Gtk.Fixed):
    """The Korb's files as a fanned stack. A new file drops in from above,
    turning and overshooting a little before it settles; the others spread
    to make room. Each card sits in a holder with a clear border: GTK draws a
    turned widget as a texture, and only clear pixels at its edge give the
    card smooth edges at any angle."""
    HOLDER = (58, 68)
    LAND, MOVE = 0.55, 0.32

    def __init__(self):
        super().__init__(width_request=FAN[0], height_request=FAN[1], halign=Gtk.Align.CENTER)
        self.cards = []
        self.ticking = 0

    def place(self, entries):
        """entries: (uri, make) oldest first, make() builds the card; four at most are shown."""
        now = GLib.get_monotonic_time() / 1e6
        known = {card['uri']: card for card in self.cards}
        shown = entries[-4:]
        cards = []
        for index, (uri, make) in enumerate(shown):
            offset = index - (len(shown) - 1) / 2
            target = (FAN[0] / 2 + offset * 28, FAN[1] / 2 + 8 + abs(offset) * 4, offset * 9, 1.0, 1.0)
            card = known.pop(uri, None)
            if card:
                card.update(start=self.state(card, now), target=target, begun=now, duration=self.MOVE, ease=ease_out_cubic)
            else:
                holder = Gtk.Box(css_classes=['fan-holder'])
                holder.append(make())
                self.put(holder, 0, 0)
                # From above the well, turned the other way, larger and clear.
                card = {'uri': uri, 'widget': holder, 'start': (target[0] + 10, -36, target[2] - 28, 1.35, 0.0),
                        'target': target, 'begun': now, 'duration': self.LAND, 'ease': ease_out_back}
            cards.append(card)
        for card in known.values():
            self.remove(card['widget'])
        self.cards = cards
        for card in cards:
            self.apply(card, now)
        if not self.ticking:
            self.ticking = self.add_tick_callback(self.tick)

    def state(self, card, now):
        progress = min(1.0, (now - card['begun']) / card['duration'])
        eased = card['ease'](progress)
        # Opacity never overshoots.
        return tuple(a + (b - a) * (min(1.0, progress * 2.5) if i == 4 else eased) for i, (a, b) in enumerate(zip(card['start'], card['target'])))

    def apply(self, card, now):
        x, y, angle, scale, alpha = self.state(card, now)
        w, h = self.HOLDER
        transform = Gsk.Transform.new().translate(Graphene.Point().init(x, y)).rotate(angle).scale(scale, scale).translate(Graphene.Point().init(-w / 2, -h / 2))
        self.set_child_transform(card['widget'], transform)
        card['widget'].set_opacity(alpha)

    def tick(self, _widget, clock):
        now = clock.get_frame_time() / 1e6
        for card in self.cards:
            self.apply(card, now)
        if all(now - card['begun'] >= card['duration'] for card in self.cards):
            self.ticking = 0
            return GLib.SOURCE_REMOVE
        return GLib.SOURCE_CONTINUE


class Tray(Gtk.Application):
    def __init__(self, kind='shelf', width=700, style='dynamic', hidden=False):
        super().__init__(application_id='org.notchy.FileTray', flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.kind = 'basket' if kind == 'basket' else 'shelf'
        self.width, self.style, self.hidden = width, style, hidden
        self.holds = 0
        self.basket_items = []

    def do_activate(self):
        self.proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE,
                                                   None, BUS, PATH, BUS, None)
        if not self.proxy.get_name_owner():
            print('Notchy extension is not running.', file=sys.stderr)
            self.quit()
            return
        display = Gdk.Display.get_default()
        # Above a user's gtk.css (a full theme there styles every button):
        # the Regal and the Korb keep Notchy's look whatever the GTK theme.
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS.encode())
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
        # A user's gtk.css has higher priority than application CSS. Its window
        # background must not paint a second outline behind our root.
        window_provider = Gtk.CssProvider()
        window_provider.load_from_data(WINDOW_CSS.encode())
        Gtk.StyleContext.add_provider_for_display(display, window_provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
        # Dynamic Glass continues the island's black-to-glass shade; its offsets
        # arrive with ShelfConfig.
        self.shade_provider = Gtk.CssProvider()
        Gtk.StyleContext.add_provider_for_display(display, self.shade_provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 2)
        shelf = self.kind == 'shelf'
        self.window = Gtk.ApplicationWindow(application=self, title='Notchy Files' if shelf else 'Notchy File Tray', decorated=False,
                                            default_width=self.width if shelf else BASKET[0], default_height=250 if shelf else BASKET[1], resizable=False)
        self.window.connect('close-request', self.close)
        self.window.add_css_class('notchy-files')
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12 if shelf else 10)
        # The Korb moves by dragging it anywhere but on its buttons and its stack.
        self.root = Gtk.Frame(child=root if shelf else Gtk.WindowHandle(child=root), css_classes=['tray', self.kind, self.style], overflow=Gtk.Overflow.HIDDEN)
        self.window.set_child(self.root)
        (self.build_shelf if shelf else self.build_basket)(root)
        target = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        target.connect('drop', self.drop)
        target.connect('enter', lambda *_: self.highlight(True))
        target.connect('leave', lambda *_: self.highlight(False))
        self.root.add_controller(target)
        key = Gtk.EventControllerKey()
        key.connect('key-pressed', self.key)
        root.add_controller(key)
        self.proxy.connect('g-signal', self.signal)
        self.proxy.connect('notify::g-name-owner', lambda *_: self.quit() if not self.proxy.get_name_owner() else None)
        if shelf:
            self.refresh()
        else:
            self.render_basket()
        if self.hidden:
            # A prestarted shelf waits for Notchy; it may have missed the last ShelfConfig.
            self.hold()
            self.call('GetShelfConfig', done=lambda reply: reply and self.configure(json.loads(reply[0])))
        else:
            self.window.present()
            # No focus ring until the keyboard is used.
            self.window.set_focus_visible(False)

    def build_shelf(self, root):
        root.set_margin_top(0)
        # Idle: „Regal · 12 Dateien · 68 MB“, select all and add. With a
        # selection: clear it, how many and how large, and what to do with them.
        header = self.header = Gtk.Box(spacing=8, height_request=40)
        self.clear_button = icon_button('window-close-symbolic', _('Clear Selection'), visible=False, valign=Gtk.Align.CENTER)
        self.clear_button.connect('clicked', lambda *_: self.flow.unselect_all())
        header.append(self.clear_button)
        self.title = Gtk.Label(label=_('Shelf'), xalign=0, css_classes=['title'])
        header.append(self.title)
        self.count = Gtk.Label(xalign=0, hexpand=True, ellipsize=3, css_classes=['count'], margin_start=2)
        header.append(self.count)
        self.actions = Gtk.Box(spacing=6, visible=False, valign=Gtk.Align.CENTER)
        # To a phone (AirDrop or a QR code) appears once Notchy reports it can (ShelfConfig / AirDrop signal).
        self.airdrop_available = False
        # Translators: a short button label; its tooltip is „Send to Phone“.
        self.airdrop_button = pill(airdrop_image(), _('Phone'), _('Send to Phone'), self.airdrop_selected, ('airdrop',))
        self.airdrop_button.set_visible(False)
        self.actions.append(self.airdrop_button)
        # Translators: a short button label; its tooltip is „Compress as ZIP“.
        self.zip_button = pill('package-x-generic-symbolic', _('Zip'), _('Compress as ZIP'), self.zip_selected)
        self.actions.append(self.zip_button)
        can_convert = bool(shutil.which('magick') or shutil.which('convert'))
        # Translators: a short button label; its tooltip says what it converts.
        self.convert_button = pill('emblem-synchronizing-symbolic', _('Convert'), _('Convert Pictures to WebP') if can_convert else _('Converting pictures needs ImageMagick'), self.convert_selected)
        self.convert_button.can_convert = can_convert
        self.actions.append(self.convert_button)
        remove = icon_button('user-trash-symbolic', _('Remove from the Shelf · originals stay'), ('circle', 'danger'))
        remove.connect('clicked', lambda *_: self.remove_selected())
        self.actions.append(remove)
        header.append(self.actions)
        self.idle = Gtk.Box(spacing=6, valign=Gtk.Align.CENTER)
        self.select_all = Gtk.Button(label=_('Select All'), tooltip_text=_('Select All'), focus_on_click=False)
        self.select_all.connect('clicked', lambda *_: self.flow.select_all())
        self.idle.append(self.select_all)
        add = icon_button('list-add-symbolic', _('Add Files · a click selects, a double click opens'))
        add.connect('clicked', self.choose)
        self.idle.append(add)
        header.append(self.idle)
        root.append(header)
        self.area = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, css_classes=['drop-area'], vexpand=True)
        self.flow = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.MULTIPLE, max_children_per_line=6, min_children_per_line=6,
                                column_spacing=10, row_spacing=10, homogeneous=True, valign=Gtk.Align.START)
        # A classic scroll bar beside the tiles (only while there is more to
        # scroll): GTK's overlay indicator would cover the right column.
        scroll = Gtk.ScrolledWindow(vexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER, min_content_height=150,
                                    overlay_scrolling=False, css_classes=['shelf-scroll'])
        self.scroll = scroll
        scroll.set_child(self.flow)
        self.flow.set_hadjustment(scroll.get_hadjustment())
        self.flow.set_vadjustment(scroll.get_vadjustment())
        self.area.append(scroll)
        self.empty = self.empty_state()
        self.area.append(self.empty)
        root.append(self.area)
        # A file's actions open as a real context menu: a GTK popover, which is
        # its own Wayland popup surface at the pointer. The Shell shows shelf
        # popups on top of the island and lets their input through
        # (Companion.trackPopup), so the island never covers them.
        self.popover = Gtk.Popover(has_arrow=False, autohide=True, position=Gtk.PositionType.BOTTOM, css_classes=['notchy-menu'])
        self.popover.set_parent(self.area)
        self.popover.connect('closed', lambda *_: self.menu_closed())
        menu_keys = Gtk.EventControllerKey()
        menu_keys.connect('key-pressed', self.menu_key)
        self.popover.add_controller(menu_keys)
        self.menu_stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.SLIDE_LEFT_RIGHT, transition_duration=140,
                                    vhomogeneous=False, hhomogeneous=False, interpolate_size=True)
        self.popover.set_child(self.menu_stack)
        self.menu_open = False
        self.menu_items = []
        self.flow.connect('selected-children-changed', lambda *_: self.update_selection())
        # Selecting like a file manager. With activate-on-single-click (GTK's
        # default) a plain click only ever ADDS a tile to the selection; off, a
        # plain click selects just that tile, Ctrl toggles, Shift extends.
        self.flow.set_activate_on_single_click(False)
        # Deselecting on top: a plain click on the only selected tile, or on
        # empty space. The press is read before the FlowBox (capture phase);
        # the release comes from a legacy controller, because the FlowBox's
        # gesture claims the click and other gestures never see it end. A
        # press that turns into a drag never deselects.
        self.press = None
        press = Gtk.GestureClick(button=1)
        press.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        press.connect('pressed', self.area_pressed)
        self.area.add_controller(press)
        release = Gtk.EventControllerLegacy()
        release.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        release.connect('event', self.area_event)
        self.area.add_controller(release)

    def empty_state(self):
        empty = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0, visible=False, vexpand=True, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)
        # Three tiles, the outer two tilted, an arrow into the front one.
        stack = Gtk.Fixed(width_request=150, height_request=84, halign=Gtk.Align.CENTER)
        for x, y, width, height, angle, front in ((14, 14, 58, 64, -9, False), (78, 14, 58, 64, 9, False), (44, 4, 62, 70, 0, True)):
            ghost = Gtk.Box(css_classes=['ghost', 'front'] if front else ['ghost'], width_request=width, height_request=height)
            if front:
                ghost.append(image('document-save-symbolic', 24, hexpand=True, halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER, vexpand=True))
            stack.put(ghost, 0, 0)
            # Rotate about the tile's centre.
            transform = Gsk.Transform.new().translate(Graphene.Point().init(x + width / 2, y + height / 2)).rotate(angle).translate(Graphene.Point().init(-width / 2, -height / 2))
            stack.set_child_transform(ghost, transform)
        empty.append(stack)
        empty.append(Gtk.Label(label=_('The Shelf Is Empty'), css_classes=['empty-title'], margin_top=18))
        empty.append(Gtk.Label(label=_('Drag files onto the notch to keep them close at hand.'), css_classes=['empty-hint'], margin_top=6, wrap=True, justify=Gtk.Justification.CENTER))
        choose = pill('list-add-symbolic', _('Choose Files'), _('Add Files to the Shelf'), self.choose, ('primary',))
        choose.set_halign(Gtk.Align.CENTER)
        choose.set_margin_top(18)
        empty.append(choose)
        return empty

    def build_basket(self, root):
        self.flow = None
        header = Gtk.Box(spacing=10, css_classes=['header'], margin_start=4)
        icon = image('notchy-basket-symbolic', 18)
        icon.add_css_class('basket-icon')
        header.append(icon)
        header.append(Gtk.Label(label=_('Basket'), xalign=0, css_classes=['title']))
        self.count = Gtk.Label(xalign=0, hexpand=True, css_classes=['count'])
        header.append(self.count)
        close = icon_button('window-close-symbolic', _('Close Basket'))
        close.connect('clicked', lambda *_: self.quit())
        header.append(close)
        root.append(header)
        # Waiting: a well that lights up under a drag. Filled: the files as a
        # fanned stack, dragged out as one.
        self.area = Gtk.Stack(css_classes=['well'], vexpand=True, transition_type=Gtk.StackTransitionType.CROSSFADE, transition_duration=160)
        waiting = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)
        badge = Gtk.Box(css_classes=['badge'], halign=Gtk.Align.CENTER)
        badge.append(image('document-save-symbolic', 22, hexpand=True, halign=Gtk.Align.CENTER))
        waiting.append(badge)
        waiting.append(Gtk.Label(label=_('Drop here'), css_classes=['well-title']))
        waiting.append(Gtk.Label(label=_('Collect now, drop later'), css_classes=['well-hint']))
        self.area.add_named(waiting, 'waiting')
        filled = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)
        self.fan = Fan()
        filled.append(self.fan)
        self.caption = Gtk.Label(css_classes=['caption'], ellipsize=3, max_width_chars=30)
        filled.append(self.caption)
        drag = Gtk.DragSource(actions=Gdk.DragAction.COPY)
        drag.connect('prepare', lambda *_: self.stack_content())
        filled.add_controller(drag)
        self.area.add_named(filled, 'filled')
        root.append(self.area)
        footer = Gtk.Box(spacing=8)
        self.to_shelf = pill('document-save-symbolic', _('Everything to the Shelf'), _('Everything to the Shelf'), self.basket_to_shelf, ('primary',))
        self.to_shelf.set_hexpand(True)
        footer.append(self.to_shelf)
        self.airdrop_available = False
        self.airdrop_button = Gtk.Button(child=airdrop_image(), tooltip_text=_('Send Everything to a Phone'), css_classes=['circle', 'airdrop', 'large'], visible=False)
        self.airdrop_button.connect('clicked', lambda *_: self.basket_items and self.call('AirDropSend', GLib.Variant('(s)', ('\n'.join(item['uri'] for item in self.basket_items),))))
        footer.append(self.airdrop_button)
        root.append(footer)
        self.call('GetShelfConfig', done=lambda reply: reply and self.set_airdrop(json.loads(reply[0]).get('airdrop')))

    def key(self, _controller, keyval, _code, state):
        if keyval == Gdk.KEY_Escape:
            # Esc first clears a selection, then closes. (An open context
            # menu is its own popup surface and takes its Esc itself.)
            if self.kind == 'shelf' and self.selected_children():
                self.flow.unselect_all()
            else:
                self.close()
            return True
        if keyval in (Gdk.KEY_c, Gdk.KEY_C) and state & Gdk.ModifierType.CONTROL_MASK:
            if self.kind == 'basket':
                if self.basket_items:
                    Gdk.Display.get_default().get_clipboard().set_content(self.content([item['uri'] for item in self.basket_items]))
            else:
                self.copy_selected()
            return True
        if keyval == Gdk.KEY_Delete and self.kind == 'shelf':
            self.remove_selected()
            return True
        # The keyboard way to the context menu: Menu or Shift+F10 on the selection.
        if self.kind == 'shelf' and (keyval == Gdk.KEY_Menu or (keyval == Gdk.KEY_F10 and state & Gdk.ModifierType.SHIFT_MASK)):
            selected = self.selected_children()
            if selected:
                ok, bounds = selected[0].compute_bounds(self.area)
                if ok:
                    self.context_menu(bounds.get_x() + bounds.get_width() / 2, bounds.get_y() + bounds.get_height() / 2)
            return True
        return False

    def close(self, *_args):
        if self.kind == 'shelf':
            self.call('CloseShelf')
        else:
            self.quit()
        return True

    def hold_interaction(self, active):
        self.holds = max(0, self.holds + (1 if active else -1))
        if self.kind == 'shelf':
            self.call('ShelfHold', GLib.Variant('(b)', (self.holds > 0,)))
        if not self.holds and getattr(self, 'pending_items', None):
            self.pending_items = None
            # Never destroy a drag source or popover parent inside its signal.
            GLib.idle_add(lambda: self.refresh() or GLib.SOURCE_REMOVE)

    def signal(self, _proxy, _sender, name, values):
        if name == 'Changed' and self.kind == 'shelf':
            self.refresh()
        elif name == 'ShelfConfig' and self.kind == 'shelf':
            self.configure(json.loads(values.unpack()[0]))
        elif name == 'AirDrop':
            self.set_airdrop(json.loads(values.unpack()[0]))

    def set_airdrop(self, config):
        self.airdrop_available = bool((config or {}).get('available'))
        self.airdrop_button.set_visible(self.airdrop_available and (self.kind == 'shelf' or bool(self.basket_items)))

    def airdrop_selected(self):
        uris = self.selected_uris()
        if uris:
            self.call('AirDropSend', GLib.Variant('(s)', ('\n'.join(uris),)))

    def configure(self, config):
        for style in ('dynamic', 'liquid'):
            self.root.remove_css_class(style)
        style = config.get('style', 'dynamic')
        self.root.add_css_class(style)
        shade = config.get('shade') or {}
        black, fade = int(shade.get('black', 0)), int(shade.get('fade', 70))
        css = (f'.tray.shelf.dynamic {{ background: linear-gradient(to bottom, #000 0px, #000 {black}px, {CLEAR} {black + fade}px, {CLEAR} 100%); }}'
               if style == 'dynamic' else '')
        self.shade_provider.load_from_data(css.encode())
        self.set_airdrop(config.get('airdrop'))
        # Six tiles a row; five on a narrow island.
        columns = 6 if config['width'] >= 680 else 5
        self.flow.set_min_children_per_line(columns)
        self.flow.set_max_children_per_line(columns)
        self.window.set_default_size(config['width'], config['height'])
        if not config['visible'] and self.menu_open:
            self.popover.popdown()
        self.window.set_visible(config['visible'])

    def call(self, method, values=None, done=None):
        def finished(proxy, result):
            try:
                reply = proxy.call_finish(result)
                if done:
                    done(reply.unpack() if reply else ())
            except GLib.Error as error:
                print(str(error), file=sys.stderr)
        self.proxy.call(method, values, Gio.DBusCallFlags.NONE, 5000, None, finished)

    def highlight(self, active):
        self.area.add_css_class('active') if active else self.area.remove_css_class('active')
        return Gdk.DragAction.COPY

    def drop(self, _target, value, _x, _y):
        self.highlight(False)
        if not value:
            return False
        uris = [f.get_uri() for f in value.get_files()]
        if self.kind == 'basket':
            self.basket_add(uris)
            return True
        try:
            self.proxy.call_sync('AddUris', GLib.Variant('(s)', ('\r\n'.join(uris),)), Gio.DBusCallFlags.NONE, 3000, None)
            return True
        except GLib.Error as error:
            print(str(error), file=sys.stderr)
        return False

    def basket_add(self, uris):
        before = len(self.basket_items)
        known = {item['uri'] for item in self.basket_items}
        for uri in uris:
            file = Gio.File.new_for_uri(uri)
            if uri not in known and file.get_path():
                self.basket_items.append({'uri': uri, 'name': file.get_basename()})
                known.add(uri)
        if len(self.basket_items) > before:
            self.area.add_css_class('landed')
            GLib.timeout_add(420, lambda: self.area.remove_css_class('landed') or GLib.SOURCE_REMOVE)
        self.render_basket()

    def basket_to_shelf(self):
        if not self.basket_items:
            return
        uris = '\r\n'.join(item['uri'] for item in self.basket_items)
        self.call('AddUris', GLib.Variant('(s)', (uris,)), done=lambda *_: self.quit())

    def leave_for_dialog(self):
        # A file dialog stands on its own, on top: as the Regal's child GNOME
        # would attach it (moving one moves both) and keep it below the Regal,
        # which stays above windows. So the Regal closes; what the dialog adds
        # or saves is announced in the notch.
        if self.kind == 'shelf':
            self.call('CloseShelf')

    def choose(self, *_args):
        self.leave_for_dialog()
        dialog = Gtk.FileDialog(title=_('Add Files to the Shelf'))
        def selected(d, result):
            try:
                files = d.open_multiple_finish(result)
                self.call('AddUris', GLib.Variant('(s)', ('\r\n'.join(files.get_item(i).get_uri() for i in range(files.get_n_items())),)))
            except GLib.Error:
                pass
            finally:
                self.hold_interaction(False)
        dialog.open_multiple(None, None, selected)

    def refresh(self):
        self.call('GetItems', done=self.populate)

    def clear_flow(self):
        child = self.flow.get_first_child()
        while child:
            next_child = child.get_next_sibling()
            self.flow.remove(child)
            child = next_child

    def file_info(self, item):
        # The thumbnail GNOME made, else (pictures only) the picture itself, and the size.
        try:
            info = Gio.File.new_for_uri(item['uri']).query_info('thumbnail::path,standard::size', Gio.FileQueryInfoFlags.NONE, None)
        except GLib.Error:
            return None, 0
        path = info.get_attribute_byte_string('thumbnail::path')
        if not path and kind_of(item['name']) == 'image' and info.get_size() < 30 * 1024 * 1024:
            path = Gio.File.new_for_uri(item['uri']).get_path()
        return path, info.get_size()

    def preview(self, item, thumb, width, height, classes, inset):
        # A picture fills the card; any other file shows its type label, on a
        # small document shape inside the card (inset) or at the card's foot.
        kind = kind_of(item['name'])
        card = Gtk.Overlay(css_classes=classes, overflow=Gtk.Overflow.HIDDEN, width_request=width, height_request=height)
        picture = None
        if thumb and kind == 'image':
            try:
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(thumb, 256, 256, True)
                picture = Gtk.Picture(paintable=Gdk.Texture.new_for_pixbuf(pixbuf), content_fit=Gtk.ContentFit.COVER)
            # An unreadable image raises GLib.Error; the gdk-pixbuf of GNOME 48's
            # Ubuntu returns NULL instead, which PyGObject turns into TypeError.
            except (GLib.Error, TypeError):
                picture = None
        if picture:
            card.set_child(picture)
            return card
        ext = Path(item['name']).suffix.lstrip('.').upper()[:5] or _('FILE')
        label = Gtk.Label(label=ext, css_classes=['ext', kind], valign=Gtk.Align.END, halign=Gtk.Align.CENTER)
        if inset:
            doc = Gtk.Overlay(css_classes=['sheet'], halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
            doc.set_child(Gtk.Box(width_request=40, height_request=50))
            doc.add_overlay(label)
            card.set_child(doc)
        else:
            # Fanned: the next card covers this one's right half.
            label.set_halign(Gtk.Align.START)
            label.set_margin_start(6)
            card.set_child(Gtk.Box())
            card.add_overlay(label)
        return card

    def tile(self, item):
        thumb, size = self.file_info(item)
        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5, css_classes=['file'])
        preview = self.preview(item, thumb, -1, 76, ['preview'], True)
        check = Gtk.Box(css_classes=['check'], halign=Gtk.Align.END, valign=Gtk.Align.START)
        check.append(image('object-select-symbolic', 12, hexpand=True, halign=Gtk.Align.CENTER))
        preview.add_overlay(check)
        card.append(preview)
        card.append(Gtk.Label(label=item['name'], ellipsize=3, max_width_chars=12, width_chars=1, css_classes=['name']))
        card.append(Gtk.Label(label=size_text(size), css_classes=['size']))
        drag = Gtk.DragSource(actions=Gdk.DragAction.COPY)
        drag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        drag.connect('prepare', lambda *_args, widget=card: self.prepare_drag(widget))
        drag.connect('drag-begin', lambda *_: self.hold_interaction(True))
        drag.connect('drag-end', lambda *_: self.hold_interaction(False))
        click = Gtk.GestureClick(button=0)
        click.connect('pressed', lambda g, n, x, y, it=item, widget=card: self.tile_pressed(g, n, x, y, it, widget))
        self.flow.insert(card, -1)
        child = card.get_parent()
        # The entire file tile, including its selection padding, is a
        # source; dragging near the icon must not start rubber-band selection.
        child.add_controller(drag)
        child.add_controller(click)
        child.notchy_uri = item['uri']
        child.notchy_name = item['name']
        child.notchy_size = size
        child.set_tooltip_text(item['name'])
        return child

    def populate(self, reply):
        if not reply:
            return
        if self.holds:
            self.pending_items = reply
            return
        selected_uris = set(self.selected_uris())
        self.clear_flow()
        items = json.loads(reply[0])
        self.total, self.total_size = len(items), 0
        self.empty.set_visible(not items)
        self.flow.get_parent().get_parent().set_visible(bool(items))
        for item in items:
            child = self.tile(item)
            self.total_size += child.notchy_size
            if item['uri'] in selected_uris:
                self.flow.select_child(child)
        self.update_selection()

    def stack_content(self):
        # The Korb's stack drags out as one: every file it holds.
        return self.content([item['uri'] for item in self.basket_items]) if self.basket_items else None

    def render_basket(self):
        items = self.basket_items
        # Built only for a file new to the stack (its preview is read once).
        self.fan.place([(item['uri'], lambda it=item: self.preview(it, self.file_info(it)[0], 52, 62, ['fan'], False)) for item in items])
        self.count.set_text(ngettext('%d file', '%d files', len(items)) % len(items) if items else '')
        if items:
            self.caption.set_text(items[-1]['name'] if len(items) == 1 else
                                  ngettext('%(name)s and %(count)d more', '%(name)s and %(count)d more', len(items) - 1) % {'name': items[-1]['name'], 'count': len(items) - 1})
            self.caption.set_tooltip_text('\n'.join(item['name'] for item in items))
        self.area.set_visible_child_name('filled' if items else 'waiting')
        self.to_shelf.set_sensitive(bool(items))
        self.airdrop_button.set_visible(self.airdrop_available and bool(items))

    def tile_pressed(self, gesture, presses, x, y, item, card):
        child = card.get_parent()
        if gesture.get_current_button() == 3 and self.kind == 'shelf':
            # Like a file manager: a right click on a tile outside the
            # selection selects just that tile; inside it, the whole
            # selection stays and the menu acts on all of it.
            if not child.is_selected():
                self.flow.unselect_all()
                self.flow.select_child(child)
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)
            ok, point = child.compute_point(self.area, Graphene.Point().init(x, y))
            self.context_menu(point.x if ok else x, point.y if ok else y)
        elif presses == 2 and gesture.get_current_button() == 1:
            self.open(item['uri'])

    def area_pressed(self, gesture, presses, x, y):
        ok, point = self.area.compute_point(self.flow, Graphene.Point().init(x, y))
        child = self.flow.get_child_at_pos(point.x, point.y) if ok else None
        modifiers = gesture.get_current_event_state() & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK)
        event = gesture.get_current_event()
        self.press_at(child if child is not None and hasattr(child, 'notchy_uri') else None, presses, bool(modifiers), event.get_position()[1:] if event else (x, y))

    def press_at(self, child, presses, modifiers, position):
        self.press = None if modifiers else {
            'child': child, 'position': position,
            'deselect': child is not None and presses == 1 and child.is_selected() and len(self.selected_children()) == 1}

    def area_event(self, controller, event):
        # PyGObject hands the signal's event over as None; the controller knows it.
        event = event or controller.get_current_event()
        if event and event.get_event_type() == Gdk.EventType.BUTTON_RELEASE and event.get_button() == 1:
            self.release_at(event.get_position()[1:])
        return False

    def release_at(self, position):
        press, self.press = self.press, None
        if not press:
            return
        (x0, y0), (x1, y1) = press['position'], position
        if abs(x1 - x0) > 6 or abs(y1 - y0) > 6:
            return
        if press['child'] is None:
            self.flow.unselect_all()
        elif press['deselect']:
            # After the FlowBox has applied the click (it selects on release).
            child = press['child']
            GLib.idle_add(lambda: (self.flow.unselect_child(child) if child.get_parent() is self.flow else None, GLib.SOURCE_REMOVE)[1])

    def selected_children(self):
        if not self.flow:
            return []
        return [child for child in self.flow.get_selected_children() if hasattr(child, 'notchy_uri')]

    def selected_uris(self):
        return [child.notchy_uri for child in self.selected_children()]

    def update_selection(self):
        if self.kind != 'shelf':
            return
        selected = self.selected_children()
        self.call('ShelfSelected', GLib.Variant('(u)', (len(selected),)))
        total = getattr(self, 'total', 0)
        # The keyboard way (Tab, Enter): a focused button about to hide lets go
        # of the focus first, so it never lands on a tile (which would select it).
        focus = self.window.get_focus() if getattr(self, 'window', None) else None
        if focus and any(focus is box or focus.is_ancestor(box) for box in ((self.idle,) if selected else (self.actions, self.clear_button))):
            self.window.set_focus(None)
        self.actions.set_visible(bool(selected))
        self.clear_button.set_visible(bool(selected))
        # The empty Regal offers its own button to add files.
        self.idle.set_visible(not selected and total > 0)
        if selected:
            self.title.set_text(ngettext('%d selected', '%d selected', len(selected)) % len(selected))
            self.count.set_text(size_text(sum(child.notchy_size for child in selected)))
        else:
            self.title.set_text(_('Shelf'))
            words, size = ngettext('%d file', '%d files', total) % total, size_text(getattr(self, 'total_size', 0))
            self.count.set_text(f'{words} · {size}' if total and size else words)
        self.report_header()
        if selected:
            images = [child for child in selected if Path(child.notchy_name).suffix.lower() in IMAGES]
            self.convert_button.set_sensitive(bool(images) and self.convert_button.can_convert)

    def content(self, uris):
        return Gdk.ContentProvider.new_for_value(Gdk.FileList.new_from_list([Gio.File.new_for_uri(uri) for uri in uris]))

    def prepare_drag(self, card):
        child = card.get_parent()
        if not child.is_selected():
            self.flow.unselect_all()
            self.flow.select_child(child)
        return self.content(self.selected_uris())

    def copy_selected(self):
        uris = self.selected_uris()
        if uris:
            Gdk.Display.get_default().get_clipboard().set_content(self.content(uris))

    def zip_selected(self):
        uris = self.selected_uris()
        if len(uris) == 1:
            self.call('Action', GLib.Variant('(sss)', ('zip', uris[0], '')))
        elif uris:
            self.call('Action', GLib.Variant('(sss)', ('zip-many', uris[0], json.dumps(uris))))

    def convert_selected(self):
        for child in self.selected_children():
            if Path(child.notchy_name).suffix.lower() in IMAGES:
                self.call('Action', GLib.Variant('(sss)', ('image', child.notchy_uri, 'webp')))

    def remove_selected(self):
        for uri in self.selected_uris():
            self.call('RemoveUri', GLib.Variant('(s)', (uri,)))

    def open(self, uri):
        Gio.AppInfo.launch_default_for_uri_async(uri, None, None, None)

    def save(self, item):
        self.leave_for_dialog()
        dialog = Gtk.FileDialog(title=_('Save a Copy'), initial_name=item['name'])
        def selected(d, result):
            try:
                target = d.save_finish(result)
                def copied(file, response):
                    try:
                        file.copy_finish(response)
                    except GLib.Error as error:
                        print(str(error), file=sys.stderr)
                    finally:
                        self.hold_interaction(False)
                Gio.File.new_for_uri(item['uri']).copy_async(target, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, None, None, copied)
            except GLib.Error as error:
                print(str(error), file=sys.stderr)
                self.hold_interaction(False)
        dialog.save(None, None, selected)

    def save_many(self, items):
        # Several files: one folder, a copy of each.
        self.leave_for_dialog()
        dialog = Gtk.FileDialog(title=ngettext('Save %d Copy In', 'Save %d Copies In', len(items)) % len(items))
        def selected(d, result):
            try:
                folder = d.select_folder_finish(result)
            except GLib.Error as error:
                print(str(error), file=sys.stderr)
                self.hold_interaction(False)
                return
            pending = [len(items)]
            def copied(file, response):
                try:
                    file.copy_finish(response)
                except GLib.Error as error:
                    print(str(error), file=sys.stderr)
                pending[0] -= 1
                if not pending[0]:
                    self.hold_interaction(False)
            for item in items:
                Gio.File.new_for_uri(item['uri']).copy_async(folder.get_child(item['name']), Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, None, None, copied)
        dialog.select_folder(None, None, selected)

    def show_in_folder(self, uris):
        # The file manager opens the folder with the files selected; without
        # one on the bus, the first file's folder opens.
        def done(proxy, result):
            try:
                proxy.call_finish(result)
            except GLib.Error:
                self.open(Gio.File.new_for_uri(uris[0]).get_parent().get_uri())
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1', 'ShowItems',
                              GLib.Variant('(ass)', (uris, '')), None, Gio.DBusCallFlags.NONE, 3000, None, done)

    def menu_entries(self, items):
        """The context menu for these shelf items, as data: entries are
        (icon, label, callback) tuples, None for a separator, or a dict for a
        submenu. Only actions their files and installed tools support appear."""
        uris = [item['uri'] for item in items]
        single = len(items) == 1
        def kind(suffixes):
            return [item for item in items if Path(item['name']).suffix.lower() in suffixes]
        images, pdfs = kind(IMAGES), kind(('.pdf',))
        documents = kind(('.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'))
        videos = kind(('.mp4', '.mkv', '.mov', '.webm'))
        def count(subset, label):
            # A partial selection names how many files the action reaches.
            return '' if len(subset) == len(items) else f' ({label})'
        pictures = ngettext('%d picture', '%d pictures', len(images)) % len(images)
        def each(subset, action, extra=''):
            return lambda: [self.call('Action', GLib.Variant('(sss)', (action, item['uri'], extra))) for item in subset]
        entries = [
            ('document-open-symbolic', _('Open') if single else ngettext('Open %d File', 'Open %d Files', len(items)) % len(items), lambda: [self.open(uri) for uri in uris]),
            ('folder-open-symbolic', _('Show in Folder'), lambda: self.show_in_folder(uris)),
            ('edit-copy-symbolic', _('Copy'), lambda: Gdk.Display.get_default().get_clipboard().set_content(self.content(uris))),
            ('document-save-as-symbolic', _('Save a Copy…') if single else _('Save Copies…'), (lambda: self.save(items[0])) if single else (lambda: self.save_many(items))),
            None,
            ('package-x-generic-symbolic', _('Compress as ZIP'), lambda: self.call('Action', GLib.Variant('(sss)', ('zip', uris[0], ''))) if single
             else self.call('Action', GLib.Variant('(sss)', ('zip-many', uris[0], json.dumps(uris))))),
        ]
        if self.airdrop_available:
            entries.append(('notchy-airdrop', _('Send to Phone'), lambda: self.call('AirDropSend', GLib.Variant('(s)', ('\n'.join(uris),)))))
        tools = []
        if images and shutil.which('tesseract'):
            tools.append(('edit-select-all-symbolic', _('Recognize Text') + count(images, pictures), each(images, 'ocr')))
        if images and (shutil.which('magick') or shutil.which('convert')):
            tools.append({'icon': 'emblem-synchronizing-symbolic', 'label': _('Convert To') + count(images, pictures),
                          'entries': [('image-x-generic-symbolic', fmt.upper(), each(images, 'image', fmt)) for fmt in ('png', 'jpg', 'webp', 'tiff', 'bmp', 'gif')]})
        if images and shutil.which('rembg'):
            tools.append(('edit-cut-symbolic', _('Remove Background') + count(images, pictures), each(images, 'background')))
        if pdfs and shutil.which('gs'):
            tools.append(('document-save-symbolic', _('Shrink PDF') + count(pdfs, ngettext('%d PDF', '%d PDFs', len(pdfs)) % len(pdfs)), each(pdfs, 'pdf-compress')))
        if documents and (shutil.which('libreoffice') or shutil.which('soffice')):
            tools.append(('x-office-document-symbolic', _('Save as PDF') + count(documents, ngettext('%d document', '%d documents', len(documents)) % len(documents)), each(documents, 'document-pdf')))
        if videos and shutil.which('ffmpeg') and shutil.which('ffprobe'):
            tools.append({'icon': 'video-x-generic-symbolic', 'label': _('Shrink Video') + count(videos, ngettext('%d video', '%d videos', len(videos)) % len(videos)),
                          'entries': [('video-x-generic-symbolic', _('To %s MB') % mb, each(videos, 'video', mb)) for mb in ('10', '25', '50', '100')]})
        if tools:
            entries += [None, *tools]
        entries += [None, ('user-trash-symbolic', _('Remove from Shelf'), lambda: [self.call('RemoveUri', GLib.Variant('(s)', (uri,))) for uri in uris], 'danger')]
        return entries

    def menu_page(self, title, entries, back=False):
        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        if back:
            page.append(self.menu_row('go-previous-symbolic', title, lambda: self.menu_stack.set_visible_child_name('main'), keep=True))
            page.append(Gtk.Separator())
        else:
            page.append(Gtk.Label(label=title, xalign=0, ellipsize=3, max_width_chars=30, css_classes=['ctx-title']))
        for entry in entries:
            if entry is None:
                if page.get_last_child() and not isinstance(page.get_last_child(), Gtk.Separator):
                    page.append(Gtk.Separator())
            elif isinstance(entry, dict):
                name = f'sub{len(self.menu_items)}'
                self.menu_stack.add_named(self.menu_page(entry['label'], entry['entries'], back=True), name)
                page.append(self.menu_row(entry['icon'], entry['label'], lambda name=name: self.open_submenu(name), keep=True, submenu=True))
            else:
                icon, label, callback, *style = entry
                page.append(self.menu_row(icon, label, callback, danger='danger' in style))
        return page

    def menu_row(self, icon, label, callback, keep=False, submenu=False, danger=False):
        content = Gtk.Box(spacing=10)
        content.append(airdrop_image() if icon == 'notchy-airdrop' else image(icon))
        content.append(Gtk.Label(label=label, xalign=0, hexpand=True, ellipsize=3, max_width_chars=34))
        if submenu:
            content.append(image('go-next-symbolic'))
        button = Gtk.Button(child=content, css_classes=['ctx-item'] + (['danger'] if danger else []))
        button.update_property([Gtk.AccessibleProperty.LABEL], [label])
        button.notchy_label, button.notchy_submenu = label, submenu
        self.menu_items.append(button)
        def activate(*_args):
            if keep:
                callback()
                return
            # The action runs once the popup has gone, so a dialog it opens
            # or a refresh it causes never meets a closing popover.
            self.popover.popdown()
            GLib.idle_add(lambda: (callback(), GLib.SOURCE_REMOVE)[1])
        button.connect('clicked', activate)
        return button

    def open_submenu(self, name):
        self.menu_stack.set_visible_child_name(name)
        # Focus the first entry after the back row.
        items = self.page_items()
        if len(items) > 1:
            items[1].grab_focus()

    def page_items(self):
        page = self.menu_stack.get_visible_child()
        return [button for button in self.menu_items if button.get_parent() is page]

    def menu_key(self, _controller, keyval, _code, _state):
        if keyval in (Gdk.KEY_Left, Gdk.KEY_BackSpace) and self.menu_stack.get_visible_child_name() != 'main':
            self.menu_stack.set_visible_child_name('main')
            items = self.page_items()
            if items:
                items[0].grab_focus()
            return True
        # Arrow keys walk the entries, wrapping around, as in any menu.
        if keyval in (Gdk.KEY_Up, Gdk.KEY_Down, Gdk.KEY_Home, Gdk.KEY_End):
            items = self.page_items()
            if not items:
                return False
            focus = next((i for i, button in enumerate(items) if button.has_focus()), -1)
            index = {Gdk.KEY_Home: 0, Gdk.KEY_End: len(items) - 1}.get(keyval, (focus + (1 if keyval == Gdk.KEY_Down else -1)) % len(items) if focus >= 0 else 0)
            items[index].grab_focus()
            return True
        if keyval == Gdk.KEY_Right:
            focused = next((button for button in self.page_items() if button.has_focus()), None)
            if focused and getattr(focused, 'notchy_submenu', False):
                focused.emit('clicked')
                return True
        return False

    def context_menu(self, x, y):
        """Open the real context menu at (x, y) in the pane's file area."""
        children = self.selected_children()
        if not children:
            return
        items = [{'uri': child.notchy_uri, 'name': child.notchy_name} for child in children]
        child = self.menu_stack.get_first_child()
        while child:
            following = child.get_next_sibling()
            self.menu_stack.remove(child)
            child = following
        self.menu_items = []
        title = items[0]['name'] if len(items) == 1 else ngettext('%d file selected', '%d files selected', len(items)) % len(items)
        self.menu_stack.add_named(self.menu_page(title, self.menu_entries(items)), 'main')
        self.menu_stack.set_visible_child_name('main')
        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        self.popover.set_pointing_to(rect)
        if not self.menu_open:
            # The island stays open while the menu is: ShelfHold.
            self.menu_open = True
            self.hold_interaction(True)
        self.popover.popup()
        # Keyboard users start on the first entry.
        first = next(iter(self.page_items()), None)
        if first:
            first.grab_focus()
        self.report_menu()

    def menu_closed(self):
        if self.menu_open:
            self.menu_open = False
            self.hold_interaction(False)

    def report_menu(self):
        # The headless Shell test clicks entries by position; it reads them here.
        out = os.environ.get('NOTCHY_TEST_OUTPUT')
        if not out:
            return
        def write():
            if not self.menu_open:
                return GLib.SOURCE_REMOVE
            native = self.popover.get_native()
            surface_x, surface_y = native.get_surface_transform() if native else (0, 0)
            rows = []
            for button in self.menu_items:
                ok, bounds = button.compute_bounds(self.popover)
                if ok and button.get_mapped():
                    rows.append({'label': button.notchy_label, 'x': surface_x + bounds.get_x(), 'y': surface_y + bounds.get_y(),
                                 'width': bounds.get_width(), 'height': bounds.get_height()})
            Path(out, 'regal-menu.json').write_text(json.dumps(rows))
            return GLib.SOURCE_REMOVE
        GLib.timeout_add(250, write)

    def report_header(self):
        # The headless Shell test clicks the header's buttons by position too.
        out = os.environ.get('NOTCHY_TEST_OUTPUT')
        if not out or self.kind != 'shelf':
            return
        def write():
            native = self.window.get_native()
            surface_x, surface_y = native.get_surface_transform() if native else (0, 0)
            buttons = {}
            for name, button in (('selectAll', self.select_all), ('clear', self.clear_button)):
                ok, bounds = button.compute_bounds(self.window)
                if ok and button.get_mapped():
                    buttons[name] = {'x': surface_x + bounds.get_x(), 'y': surface_y + bounds.get_y(), 'width': bounds.get_width(), 'height': bounds.get_height()}
            Path(out, 'regal-header.json').write_text(json.dumps(buttons))
            return GLib.SOURCE_REMOVE
        GLib.timeout_add(250, write)


if __name__ == '__main__':
    Tray(sys.argv[1] if len(sys.argv) > 1 else 'shelf', int(sys.argv[2]) if len(sys.argv) > 2 else 700, sys.argv[3] if len(sys.argv) > 3 else 'dynamic',
         len(sys.argv) > 4 and sys.argv[4] == 'hidden').run([])
