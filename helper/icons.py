"""Symbols for the GTK helpers (Regal, Korb, drop zone), always from Adwaita.

GNOME installs Adwaita with GTK, so these files are always there. A user icon
theme may ship symbolic SVGs that GTK 4 draws off-centre or clipped (Tela's
document-save-symbolic sits in a group moved by translate(-4,-4)); Notchy's
own surfaces keep one set of symbols whatever the theme. A symbol Adwaita
lacks falls back to the theme's icon of that name.
"""
from functools import lru_cache
from pathlib import Path

import gi

gi.require_version('Gtk', '4.0')
from gi.repository import Gio, GLib, Gtk  # noqa: E402

NOTCHY = Path(__file__).resolve().parent.parent / 'src' / 'icons'


@lru_cache(maxsize=None)
def gicon(name):
    if name.startswith('notchy-'):
        return Gio.FileIcon.new(Gio.File.new_for_path(str(NOTCHY / f'{name}.svg')))
    for base in GLib.get_system_data_dirs():
        root = Path(base, 'icons', 'Adwaita', 'symbolic')
        if root.is_dir():
            for path in root.glob(f'*/{name}.svg'):
                return Gio.FileIcon.new(Gio.File.new_for_path(str(path)))
    return Gio.ThemedIcon.new(name)


def image(name, size=16, **props):
    return Gtk.Image(gicon=gicon(name), pixel_size=size, **props)
