#!/usr/bin/python3
"""Exercise GTK multi-selection and real Wayland file clipboard in the private test session."""
import os
import sys
sys.path.insert(0, os.path.join(os.environ['NOTCHY_EXTENSION_PATH'], 'helper'))
from tray import Tray, Gdk, Gio, GLib, Gtk, _, ngettext
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf

app = basket = Tray('basket')
shelf = None
failed = False

def check():
    global failed
    try:
        # Render the real native root, including its CSS and children, rather
        # than inferring corner correctness from CSS radius strings.
        assert app.window.get_width() == app.root.get_allocated_width() and app.window.get_height() == app.root.get_allocated_height(), 'user GTK theme cannot add a second window border or padding'
        snapshot = Gtk.Snapshot.new()
        app.paintable.snapshot(snapshot, app.root.get_allocated_width(), app.root.get_allocated_height())
        node = snapshot.to_node()
        assert node is not None, 'native basket render node available'
        renderer = app.window.get_native().get_renderer()
        texture = renderer.render_texture(node, None)
        image_path = os.path.join(os.environ['NOTCHY_TEST_OUTPUT'], 'file-basket-alpha.png')
        texture.save_to_png(image_path)
        image = GdkPixbuf.Pixbuf.new_from_file(image_path)
        assert image.get_has_alpha(), 'native basket has an alpha channel'
        pixels, stride = image.get_pixels(), image.get_rowstride()
        width, height = image.get_width(), image.get_height()
        alpha = lambda x, y: pixels[y * stride + x * 4 + 3]
        assert all(alpha(x, y) == 0 for x, y in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1))), 'all four native basket corners are transparent'
        assert all(alpha(x, y) == 0 for x, y in ((5, 5), (width - 6, 5), (5, height - 6), (width - 6, height - 6))), 'basket preserves its large corner radius against user frame styles'
        assert alpha(width // 2, height // 2) > 200, 'native basket contents remain visible'
        print('PASS: native basket renders transparent corners and visible contents', flush=True)
        # The Korb shows what it holds as one fanned stack, dragged out as one.
        fanned = len(app.fan.cards)
        items = app.basket_items
        assert app.area.get_visible_child_name() == 'filled' and fanned == min(4, len(items)) and app.to_shelf.get_sensitive(), 'the Korb fans out its files'
        more = ngettext('%(name)s and %(count)d more', '%(name)s and %(count)d more', len(items) - 1) % {'name': items[-1]['name'], 'count': len(items) - 1}
        assert app.caption.get_text() == (items[-1]['name'] if len(items) == 1 else more), 'the Korb names its newest file'
        stack = app.stack_content()
        assert stack.ref_formats().contain_gtype(Gdk.FileList) and len(items) >= 2, 'the stack drags the Korb\'s files as one native file list'
        print('PASS: the Korb fans out its files and drags them as one stack', flush=True)
        # Selecting is the Regal's: one built in this process from the same files.
        global shelf
        shelf = Tray('shelf')
        shelf.proxy = app.proxy
        shelf.call = lambda method, values=None, done=None: app.call(method, values, done) if method == 'GetItems' else None
        shelf.window = Gtk.Window(application=app, title='Notchy Tray Test Regal', decorated=False, default_width=700, default_height=300)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        shelf.root = Gtk.Frame(child=box, css_classes=['tray', 'shelf', 'dynamic'])
        shelf.window.set_child(shelf.root)
        shelf.build_shelf(box)
        shelf.window.present()
        shelf.refresh()
        GLib.timeout_add(500, select)
    except Exception as error:
        failed = True
        print(f'NOTCHY_TRAY_TEST_FAILED: {error}', flush=True)
        app.quit()
    return GLib.SOURCE_REMOVE

def select():
    global failed
    app = shelf
    try:
        children = []
        child = app.flow.get_first_child()
        while child:
            if hasattr(child, 'notchy_uri'):
                children.append(child)
            child = child.get_next_sibling()
        assert len(children) >= 2, 'two shelf fixtures required'
        assert not app.empty.get_visible() and app.title.get_text() == _('Shelf'), 'the Regal lists its files under its name'
        app.flow.select_child(children[0])
        app.flow.select_child(children[1])
        expected = set(app.selected_uris())
        assert app.title.get_text() == ngettext('%d selected', '%d selected', 2) % 2 and app.actions.get_visible() and app.clear_button.get_visible() and not app.idle.get_visible(), 'a selection turns the header into its actions'
        assert len(expected) == 2, 'GTK multiple selection'
        # Deselecting: a plain click (press and release in place) on the only
        # selected tile clears it; a press that turns into a drag never does.
        # (Real clicks through GTK's FlowBox are covered by the Shell test.)
        def drain():
            context = GLib.MainContext.default()
            while context.pending():
                context.iteration(False)
        assert not app.flow.get_activate_on_single_click(), 'plain clicks replace the selection instead of adding to it'
        app.flow.unselect_all(); app.flow.select_child(children[0])
        app.press_at(children[0], 1, False, (10, 10)); app.release_at((11, 10)); drain()
        assert app.selected_uris() == [], 'a second plain click on the selected tile deselects it'
        app.flow.select_child(children[0])
        app.press_at(children[0], 1, False, (10, 10)); app.release_at((60, 10)); drain()
        assert app.selected_uris() == [children[0].notchy_uri], 'dragging a selected tile keeps it selected'
        app.flow.select_child(children[1])
        app.press_at(children[0], 1, False, (10, 10)); app.release_at((10, 10)); drain()
        assert len(app.selected_uris()) == 2, 'a tile within a group selection is not deselected by itself'
        app.press_at(None, 1, False, (300, 200)); app.release_at((300, 200)); drain()
        assert app.selected_uris() == [], 'a click on empty space clears the selection'
        app.flow.select_child(children[0])
        app.press_at(children[0], 1, True, (10, 10)); app.release_at((10, 10)); drain()
        assert app.selected_uris() == [children[0].notchy_uri], 'with Ctrl or Shift, GTK alone decides'
        print('PASS: shelf tiles can be deselected with a second click', flush=True)
        app.flow.select_child(children[0]); app.flow.select_child(children[1])
        provider = app.prepare_drag(children[0].get_child())
        assert provider.ref_formats().contain_gtype(Gdk.FileList), 'native file drag provider'
        assert len(app.selected_uris()) == 2, 'drag preserves selected group'
        app.copy_selected()
        def copied(clipboard, result):
            global failed
            try:
                value = clipboard.read_value_finish(result)
                assert set(f.get_uri() for f in value.get_files()) == expected, 'Wayland batch copy'
                assert set(app.selected_uris()) == expected, 'selection is kept after copying'
                print('NOTCHY_TRAY_TEST_OK', flush=True)
            except Exception as error:
                failed = True
                print(f'NOTCHY_TRAY_TEST_FAILED: {error}', flush=True)
            basket.quit()
        Gdk.Display.get_default().get_clipboard().read_value_async(Gdk.FileList, 0, None, copied)
    except Exception as error:
        failed = True
        print(f'NOTCHY_TRAY_TEST_FAILED: {error}', flush=True)
        basket.quit()
    return GLib.SOURCE_REMOVE

def prepare_render():
    # The Korb collects its own files; seed it with the two shelf fixtures.
    reply = app.proxy.call_sync('GetItems', None, Gio.DBusCallFlags.NONE, 3000, None)
    app.basket_add([item['uri'] for item in __import__('json').loads(reply.unpack()[0])])
    # Deliberately emulate gtk.css overriding the application's background.
    # The narrowly scoped window reset must still keep the corners transparent.
    provider = Gtk.CssProvider()
    provider.load_from_data(b'window.notchy-files { background: #ff00ff; padding: 9px; border: 5px solid #ff00ff; } frame.tray { background: #ff00ff; border-radius: 6px; padding: 9px; }')
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
    app.paintable = Gtk.WidgetPaintable.new(app.root)
    app.root.queue_draw()
    GLib.timeout_add(400, check)
    return GLib.SOURCE_REMOVE

app.connect('activate', lambda *_: GLib.timeout_add(600, prepare_render))
app.run([])
sys.exit(1 if failed else 0)
