import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Pango from 'gi://Pango';

export const box = (vertical = false, props = {}) => new St.BoxLayout({orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL, ...props});
export function label(text, cls = '', props = {}) {
    const actor = new St.Label({text: String(text), style_class: cls, ...props});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END; return actor;
}
// Notchy's own icons (rounded transport glyphs) live in src/icons; everything
// else comes from the icon theme.
const ICONS = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('icons');
export function gicon(name) {
    return name.startsWith('notchy-') ? new Gio.FileIcon({file: ICONS.get_child(`${name}.svg`)}) : new Gio.ThemedIcon({name});
}
export function icon(name, size = 18) { return new St.Icon({gicon: gicon(name), icon_size: size}); }
export function button(name, title, callback, cls = '') {
    const actor = new St.Button({style_class: `notchy-button ${cls}`, can_focus: true, accessible_name: title,
        child: name ? icon(name, cls.includes('notchy-play') ? 30 : cls.includes('notchy-transport') ? 24 : cls.includes('notchy-mode') ? 20 : 18) : label(title), track_hover: true});
    actor.connect('clicked', callback); return actor;
}
export function textButton(title, callback, cls = '') { return button(null, title, callback, cls); }
export function emptyState(name, title, hint, action, callback) {
    const root = box(true, {style_class: 'notchy-empty', x_expand: true});
    root.add_child(new St.Icon({icon_name: name, icon_size: 40, style_class: 'notchy-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
    root.add_child(label(title, 'notchy-title', {x_align: Clutter.ActorAlign.CENTER}));
    root.add_child(label(hint, 'notchy-muted', {x_align: Clutter.ActorAlign.CENTER}));
    if (action) { const b = textButton(action, callback, 'notchy-primary'); b.x_align = Clutter.ActorAlign.CENTER; root.add_child(b); }
    return root;
}
// A scrolling list. Its scroll bar takes its own room beside the rows (only
// while there is something to scroll), so it never covers a row's end — the
// clipboard's time and actions, Thunderstorm's kind labels.
export function scroll(child, height = 220) {
    const view = new St.ScrollView({style_class: 'notchy-scroll', height, x_expand: true, overlay_scrollbars: false});
    view.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC); view.set_child(child); return view;
}
export function entry(placeholder, onChange, onActivate) {
    const actor = new St.Entry({hint_text: placeholder, style_class: 'notchy-entry', can_focus: true, x_expand: true});
    if (onChange) actor.clutter_text.connect('text-changed', () => onChange(actor.get_text()));
    if (onActivate) actor.clutter_text.connect('activate', () => onActivate(actor.get_text()));
    return actor;
}
export function time(us) { const sec = Math.max(0, Math.floor(us / 1e6)); return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`; }
