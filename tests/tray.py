#!/usr/bin/python3
"""Exercise GTK multi-selection and real Wayland file clipboard in the private test session."""
import os
import sys
sys.path.insert(0, os.path.join(os.environ['NOTCHY_EXTENSION_PATH'], 'helper'))
from tray import Tray, Gdk, Gio, GLib, Gtk
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf

app = Tray('basket')
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
        children = []
        child = app.flow.get_first_child()
        while child:
            if hasattr(child, 'notchy_uri'):
                children.append(child)
            child = child.get_next_sibling()
        assert len(children) >= 2, 'two shelf fixtures required'
        app.flow.select_child(children[0])
        app.flow.select_child(children[1])
        expected = set(app.selected_uris())
        assert len(expected) == 2, 'GTK multiple selection'
        # Deselecting: a plain click on the only selected tile clears it; Ctrl keeps GTK's toggling.
        def drain():
            context = GLib.MainContext.default()
            while context.pending():
                context.iteration(False)
        class Click:
            def __init__(self, state=0): self.state = state
            def get_current_button(self): return 1
            def get_current_event_state(self): return self.state
        app.flow.unselect_all(); app.flow.select_child(children[0])
        card = children[0].get_child()
        app.tile_pressed(Click(), 1, {'uri': children[0].notchy_uri}, card); app.tile_released(Click(), 1, card)
        drain()
        assert app.selected_uris() == [], 'a second plain click on the selected tile deselects it'
        app.flow.select_child(children[0]); app.flow.select_child(children[1])
        app.tile_pressed(Click(), 1, {'uri': children[0].notchy_uri}, card); app.tile_released(Click(), 1, card)
        drain()
        assert len(app.selected_uris()) == 2, 'a tile within a group selection is not deselected by its press alone'
        app.flow.unselect_all(); app.flow.select_child(children[0])
        app.tile_pressed(Click(Gdk.ModifierType.CONTROL_MASK), 1, {'uri': children[0].notchy_uri}, card); app.tile_released(Click(Gdk.ModifierType.CONTROL_MASK), 1, card)
        drain()
        assert app.selected_uris() == [children[0].notchy_uri], 'with Ctrl, GTK itself toggles; Notchy does not interfere'
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
            app.quit()
        Gdk.Display.get_default().get_clipboard().read_value_async(Gdk.FileList, 0, None, copied)
    except Exception as error:
        failed = True
        print(f'NOTCHY_TRAY_TEST_FAILED: {error}', flush=True)
        app.quit()
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
