#!/usr/bin/python3
"""Native Wayland drag source/target for the Regal and the floating Korb, positioned by the extension."""
import json
from pathlib import Path
import shutil
import sys
import gi

gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
from gi.repository import Gdk, Gio, GLib, Gtk

BUS = 'org.gnome.Shell.Extensions.Notchy'
PATH = '/org/gnome/Shell/Extensions/Notchy'
IMAGES = ('.png', '.jpg', '.jpeg', '.webp', '.heic', '.tiff', '.bmp', '.gif', '.svg')
# File-type tints (Droppy for GNOME palette), matching the Shell preview.
EXT_CLASS = {'pdf': 'pdf', 'md': 'text', 'txt': 'text', 'zip': 'archive', 'gz': 'archive', 'tar': 'archive'}
# The Shell paints the island's glass below the pane (src/ui/backdrop.js); the
# pane itself stays clear there and only paints Dynamic Glass's black shade.
CLEAR = 'rgba(0,0,0,0)'
CSS = '''
* { color: #f4f4f6; }
.count { font-size: 12.5px; color: rgba(255,255,255,0.6); }
.hint { font-size: 11.5px; color: rgba(255,255,255,0.45); }
.title { font-size: 12.5px; font-weight: 700; }
button { background: rgba(255,255,255,0.08); border-radius: 15px; padding: 4px 12px; box-shadow: none; border: none; min-height: 22px; font-size: 12px; }
button:hover { background: rgba(255,255,255,0.16); }
button:disabled { opacity: 0.35; }
button.round { padding: 5px; min-width: 22px; border-radius: 15px; background: transparent; color: rgba(255,255,255,0.8); }
button.round:hover { background: rgba(255,255,255,0.1); color: #ffffff; }
button.wide { padding: 7px 12px; border-radius: 16px; background: rgba(255,255,255,0.12); }
.drop-area { border-radius: 18px; border: 1.5px dashed transparent; }
.drop-area.active { background: rgba(255,179,138,0.08); border-color: rgba(255,200,170,0.6); }
.empty { border-radius: 18px; border: 1.5px dashed rgba(255,255,255,0.18); color: rgba(255,255,255,0.5); font-size: 12.5px; padding: 30px 0; }
flowboxchild { border-radius: 16px; padding: 8px 6px; background: transparent; outline: none; }
flowboxchild:hover { background: rgba(255,255,255,0.06); }
flowboxchild:selected { background: rgba(255,179,138,0.16); box-shadow: inset 0 0 0 1.5px rgba(255,179,138,0.75); }
.thumb { border-radius: 10px; min-width: 62px; min-height: 76px; background: rgba(255,255,255,0.1); box-shadow: 0 4px 12px rgba(0,0,0,0.25); }
.thumb.pdf { background: #a8432f; }
.thumb.text { background: #3f5b8c; }
.thumb.archive { background: #8b742f; }
.thumb picture { border-radius: 10px; }
.ext { font-family: monospace; font-size: 9.5px; color: rgba(255,255,255,0.9); margin-bottom: 6px; }
.name { font-size: 11.5px; }
.basket .zone { min-height: 84px; border-radius: 16px; border: 1.5px dashed rgba(255,255,255,0.25); padding: 8px; }
.basket .zone.active { border-color: rgba(255,200,170,0.7); background: rgba(255,179,138,0.08); }
.basket .thumb { min-width: 38px; min-height: 48px; border-radius: 7px; }
.basket .ext { font-size: 8.5px; margin-bottom: 4px; }
.basket .zone-hint { font-size: 11.5px; color: rgba(255,255,255,0.65); }
'''
WINDOW_CSS = '''
.tray.shelf { padding: 8px 22px 0; border-radius: 0; border: none; }
.tray.shelf.liquid { background: transparent; }
.tray.basket { background: rgba(18,16,20,0.96); border-radius: 26px; padding: 12px; border: none; }
/* GtkFrame draws its outline on a separate "border" node; it would leave a seam. */
frame.tray > border { border: none; box-shadow: none; margin: 0; padding: 0; }
/* GTK's own drop highlight (a green inset ring) would be a second effect. */
window.notchy-files *:drop(active), window.notchy-files:drop(active) { box-shadow: none; outline: none; }
window.notchy-files, window.notchy-files > contents {
    background: transparent; background-image: none; color: #f4f4f6;
    border: none; box-shadow: none; padding: 0; margin: 0;
}
'''


def tint(name):
    return EXT_CLASS.get(Path(name).suffix.lower().lstrip('.'), 'other')


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
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS.encode())
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
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
                                            default_width=self.width if shelf else 240, default_height=250 if shelf else 230, resizable=False)
        self.window.connect('close-request', self.close)
        self.window.add_css_class('notchy-files')
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12 if shelf else 10)
        self.root = Gtk.Frame(child=root, css_classes=['tray', self.kind, self.style], overflow=Gtk.Overflow.HIDDEN)
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

    def build_shelf(self, root):
        root.set_margin_top(0)
        header = Gtk.Box(spacing=10, height_request=30)
        self.count = Gtk.Label(xalign=0, hexpand=True, ellipsize=3, css_classes=['count'])
        header.append(self.count)
        self.actions = Gtk.Box(spacing=4, visible=False)
        self.zip_button = self.action('package-x-generic-symbolic', 'Als ZIP packen', self.zip_selected)
        can_convert = bool(shutil.which('magick') or shutil.which('convert'))
        self.convert_button = self.action('emblem-synchronizing-symbolic', 'Bilder nach WebP konvertieren' if can_convert else 'Bildkonvertierung braucht ImageMagick', self.convert_selected)
        self.convert_button.can_convert = can_convert
        self.action('user-trash-symbolic', 'Aus dem Regal entfernen · Originale bleiben', self.remove_selected)
        header.append(self.actions)
        # Icons instead of words; tooltips name each action.
        self.idle = Gtk.Box(spacing=8)
        add = Gtk.Button(icon_name='list-add-symbolic', tooltip_text='Dateien hinzufügen · Klicken wählt aus, Doppelklick öffnet', css_classes=['round'])
        add.connect('clicked', self.choose)
        self.idle.append(add)
        header.append(self.idle)
        root.append(header)
        self.area = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, css_classes=['drop-area'], vexpand=True)
        self.flow = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.MULTIPLE, max_children_per_line=5, min_children_per_line=5,
                                column_spacing=6, row_spacing=6, homogeneous=True, valign=Gtk.Align.START)
        scroll = Gtk.ScrolledWindow(vexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER, min_content_height=150)
        scroll.set_child(self.flow)
        self.flow.set_hadjustment(scroll.get_hadjustment())
        self.flow.set_vadjustment(scroll.get_vadjustment())
        self.area.append(scroll)
        self.empty = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, css_classes=['empty'], visible=False, valign=Gtk.Align.START)
        self.empty.append(Gtk.Image.new_from_icon_name('document-save-symbolic'))
        self.empty.append(Gtk.Label(label='Dateien auf die Island ziehen'))
        self.area.append(self.empty)
        root.append(self.area)
        self.flow.connect('selected-children-changed', lambda *_: self.update_selection())

    def action(self, icon_name, tooltip, callback):
        button = Gtk.Button(icon_name=icon_name, tooltip_text=tooltip, css_classes=['round'])
        button.connect('clicked', lambda *_: callback())
        self.actions.append(button)
        return button

    def build_basket(self, root):
        header = Gtk.Box(spacing=8)
        header.append(Gtk.Label(label='Korb', xalign=0, hexpand=True, css_classes=['title']))
        close = Gtk.Button(icon_name='window-close-symbolic', tooltip_text='Korb schließen', css_classes=['round'])
        close.connect('clicked', lambda *_: self.quit())
        header.append(close)
        root.append(header)
        self.area = Gtk.Box(css_classes=['zone'], vexpand=True)
        self.flow = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.MULTIPLE, max_children_per_line=4, min_children_per_line=1,
                                column_spacing=6, row_spacing=6, homogeneous=True, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER, hexpand=True)
        self.area.append(self.flow)
        root.append(self.area)
        self.to_shelf = Gtk.Button(label='Alles ins Regal', css_classes=['wide'])
        self.to_shelf.connect('clicked', lambda *_: self.basket_to_shelf())
        root.append(self.to_shelf)

    def key(self, _controller, keyval, _code, state):
        if keyval == Gdk.KEY_Escape:
            self.close()
            return True
        if keyval in (Gdk.KEY_c, Gdk.KEY_C) and state & Gdk.ModifierType.CONTROL_MASK:
            self.copy_selected()
            return True
        if keyval == Gdk.KEY_Delete and self.kind == 'shelf':
            self.remove_selected()
            return True
        return False

    def close(self, *_):
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
        self.window.set_default_size(config['width'], config['height'])
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
        known = {item['uri'] for item in self.basket_items}
        for uri in uris:
            file = Gio.File.new_for_uri(uri)
            if uri not in known and file.get_path():
                self.basket_items.append({'uri': uri, 'name': file.get_basename()})
                known.add(uri)
        self.render_basket()

    def basket_to_shelf(self):
        if not self.basket_items:
            return
        uris = '\r\n'.join(item['uri'] for item in self.basket_items)
        self.call('AddUris', GLib.Variant('(s)', (uris,)), done=lambda *_: self.quit())

    def choose(self, *_):
        self.hold_interaction(True)
        dialog = Gtk.FileDialog(title='Dateien zum Regal hinzufügen')
        def selected(d, result):
            try:
                files = d.open_multiple_finish(result)
                self.call('AddUris', GLib.Variant('(s)', ('\r\n'.join(files.get_item(i).get_uri() for i in range(files.get_n_items())),)))
            except GLib.Error:
                pass
            finally:
                self.hold_interaction(False)
        dialog.open_multiple(self.window, None, selected)

    def refresh(self):
        self.call('GetItems', done=self.populate)

    def clear_flow(self):
        child = self.flow.get_first_child()
        while child:
            next_child = child.get_next_sibling()
            self.flow.remove(child)
            child = next_child

    def thumbnail(self, item, small=False):
        ext = Path(item['name']).suffix.lower().lstrip('.')
        thumb = Gtk.Overlay(css_classes=['thumb', tint(item['name'])], halign=Gtk.Align.CENTER, overflow=Gtk.Overflow.HIDDEN)
        width, height = (38, 48) if small else (62, 76)
        thumb.set_size_request(width, height)
        try:
            info = Gio.File.new_for_uri(item['uri']).query_info('thumbnail::path', Gio.FileQueryInfoFlags.NONE, None)
            path = info.get_attribute_byte_string('thumbnail::path')
            if path and Path(item['name']).suffix.lower() in IMAGES:
                thumb.set_child(Gtk.Picture.new_for_filename(path))
                thumb.get_child().set_content_fit(Gtk.ContentFit.COVER)
        except GLib.Error:
            pass
        thumb.add_overlay(Gtk.Label(label=(ext or 'datei').upper()[:5], css_classes=['ext'], valign=Gtk.Align.END, halign=Gtk.Align.CENTER))
        return thumb

    def tile(self, item, small=False):
        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, css_classes=['file'])
        card.append(self.thumbnail(item, small))
        if not small:
            card.append(Gtk.Label(label=item['name'], ellipsize=3, max_width_chars=10, tooltip_text=item['name'], css_classes=['name']))
        drag = Gtk.DragSource(actions=Gdk.DragAction.COPY)
        drag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        drag.connect('prepare', lambda *_args, widget=card: self.prepare_drag(widget))
        drag.connect('drag-begin', lambda *_: self.hold_interaction(True))
        drag.connect('drag-end', lambda *_: self.hold_interaction(False))
        click = Gtk.GestureClick(button=0)
        click.connect('pressed', lambda g, n, _x, _y, it=item, widget=card:
                      self.menu(widget, it) if g.get_current_button() == 3 and self.kind == 'shelf' else self.open(it['uri']) if n == 2 else None)
        self.flow.insert(card, -1)
        child = card.get_parent()
        # The entire file tile, including its selection padding, is a
        # source; dragging near the icon must not start rubber-band selection.
        child.add_controller(drag)
        child.add_controller(click)
        child.notchy_uri = item['uri']
        child.notchy_name = item['name']
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
        self.total = len(items)
        self.empty.set_visible(not items)
        self.flow.get_parent().get_parent().set_visible(bool(items))
        for item in items:
            child = self.tile(item)
            if item['uri'] in selected_uris:
                self.flow.select_child(child)
        self.update_selection()

    def render_basket(self):
        self.clear_flow()
        for item in self.basket_items:
            self.tile(item, small=True)
        if not self.basket_items:
            self.flow.insert(Gtk.Label(label='Hier loslassen', css_classes=['zone-hint']), -1)
        self.to_shelf.set_sensitive(bool(self.basket_items))

    def selected_children(self):
        return [child for child in self.flow.get_selected_children() if hasattr(child, 'notchy_uri')]

    def selected_uris(self):
        return [child.notchy_uri for child in self.selected_children()]

    def update_selection(self):
        if self.kind != 'shelf':
            return
        selected = self.selected_children()
        self.actions.set_visible(bool(selected))
        self.idle.set_visible(not selected)
        total = getattr(self, 'total', 0)
        self.count.set_text(f'{len(selected)} von {total} ausgewählt' if selected else f"{total} {'Datei' if total == 1 else 'Dateien'}")
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
        self.hold_interaction(True)
        dialog = Gtk.FileDialog(title='Kopie speichern', initial_name=item['name'])
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
        dialog.save(self.window, None, selected)

    def menu(self, widget, item):
        self.hold_interaction(True)
        popover = Gtk.Popover()
        popover.set_parent(widget)
        actions = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        def action(label, callback):
            button = Gtk.Button(label=label)
            button.connect('clicked', lambda *_: (popover.popdown(), callback()))
            actions.append(button)
        action('Öffnen', lambda: self.open(item['uri']))
        action('Im Dateimanager anzeigen', lambda: self.open(Gio.File.new_for_uri(item['uri']).get_parent().get_uri()))
        action('Kopie speichern …', lambda: self.save(item))
        action('ZIP erstellen', lambda: self.call('Action', GLib.Variant('(sss)', ('zip', item['uri'], ''))))
        suffix = Path(item['name']).suffix.lower()
        if suffix in IMAGES and (shutil.which('magick') or shutil.which('convert')):
            for format_name in ('png', 'jpg', 'webp', 'tiff', 'bmp', 'gif'):
                action('In ' + format_name.upper() + ' konvertieren', lambda fmt=format_name: self.call('Action', GLib.Variant('(sss)', ('image', item['uri'], fmt))))
        if suffix in IMAGES and shutil.which('tesseract'):
            action('Text erkennen und kopieren', lambda: self.call('Action', GLib.Variant('(sss)', ('ocr', item['uri'], ''))))
        if suffix in IMAGES and shutil.which('rembg'):
            action('Hintergrund entfernen', lambda: self.call('Action', GLib.Variant('(sss)', ('background', item['uri'], ''))))
        if suffix == '.pdf' and shutil.which('gs'):
            action('PDF komprimieren', lambda: self.call('Action', GLib.Variant('(sss)', ('pdf-compress', item['uri'], ''))))
        if suffix in ('.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt') and shutil.which('libreoffice'):
            action('In PDF konvertieren', lambda: self.call('Action', GLib.Variant('(sss)', ('document-pdf', item['uri'], ''))))
        if suffix in ('.mp4', '.mkv', '.mov', '.webm') and shutil.which('ffmpeg') and shutil.which('ffprobe'):
            for mb in ('10', '25', '50', '100'):
                action('Video auf ca. ' + mb + ' MB komprimieren', lambda size=mb: self.call('Action', GLib.Variant('(sss)', ('video', item['uri'], size))))
        action('Aus Regal entfernen', lambda: self.call('RemoveUri', GLib.Variant('(s)', (item['uri'],))))
        popover.set_child(actions)
        popover.connect('closed', lambda p: (self.hold_interaction(False), p.unparent()))
        popover.popup()


if __name__ == '__main__':
    Tray(sys.argv[1] if len(sys.argv) > 1 else 'shelf', int(sys.argv[2]) if len(sys.argv) > 2 else 700, sys.argv[3] if len(sys.argv) > 3 else 'dynamic',
         len(sys.argv) > 4 and sys.argv[4] == 'hidden').run([])
