import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Cairo from 'cairo';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Shell from 'gi://Shell';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {formatTimeSpan} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {box, label, icon, gicon, button, textButton, emptyState, scroll, time} from './widgets.js';
import {relativeTime, isoWeek, weekDays, groupBy, SNAP_LAYOUTS, zoneRect} from '../model.js';
import {launchUri} from '../launcher/providers.js';
import {ageText} from '../services/batteries.js';
import {Waveform} from './waveform.js';
import {Lifetime} from '../lifecycle.js';

// File-type tints for shelf tiles (Droppy for GNOME palette).
const EXT_CLASS = {pdf: 'pdf', md: 'text', txt: 'text', zip: 'archive', gz: 'archive', tar: 'archive', png: 'image', jpg: 'image', jpeg: 'image', svg: 'image', webp: 'image', gif: 'image'};
export const extensionOf = name => (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
const CLIP_ICON = {text: 'text-x-generic-symbolic', link: 'web-browser-symbolic', color: 'applications-graphics-symbolic', image: 'image-x-generic-symbolic', files: 'folder-symbolic'};
const FILTERS = [['all', 'view-list-symbolic', 'Alle'], ['link', 'insert-link-symbolic', 'Links'], ['image', 'image-x-generic-symbolic', 'Bilder'], ['fav', 'starred-symbolic', 'Nur Favoriten']];

// An output's symbol: AirPlay, headphones, a display (HDMI) or speakers.
function outputGicon(output) {
    const name = output?.airplay ? 'notchy-airplay-symbolic' : /headphone|headset/i.test(`${output?.icon} ${output?.name}`) ? 'audio-headphones-symbolic'
        : /hdmi|displayport/i.test(output?.name ?? '') ? 'video-display-symbolic' : 'audio-speakers-symbolic';
    return gicon(name);
}

// Long device names end in an ellipsis.
const shorten = (text, max) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
// Thunderstorm's field, footer and padding around its result list.
const SEARCH_CHROME = 64 + 26 + 10;
// The AirDrop radar's size.
const RADAR = 84;
// A snap layout's miniature screen.
const SNAP_TILE = [76, 48];
// Height of the calendar tab's two scrolling lists.
const CAL_LIST_HEIGHT = 196;
// AirPods noise control: symbol and name per mode.
export const ANC_ICON = {noise: 'notchy-anc-symbolic', transparency: 'notchy-transparency-symbolic', adaptive: 'notchy-adaptive-symbolic', off: 'notchy-anc-off-symbolic'};
export const ANC_NAME = {noise: 'Geräuschunterdrückung', transparency: 'Transparenz', adaptive: 'Adaptiv', off: 'Geräuschkontrolle aus'};
// The batteries an AirPods model reports: both buds and the case, or one (AirPods Max).
export function airpodsParts(state) {
    if (state.battery.single !== null || state.headphones || state.backend === 'bluez') return [{key: 'single', short: '', name: 'Akku', icon: 'notchy-airpods-symbolic'}];
    return [{key: 'left', short: 'L', name: 'Links'}, {key: 'right', short: 'R', name: 'Rechts'}, {key: 'case', short: '', name: 'Case', icon: 'notchy-airpods-case-symbolic'}];
}
// One cell's reading: the live level (both buds together: the lower one), its
// charging, and the last valid reading when the part reports nothing now.
export function partReading(state, key) {
    const b = state.battery, c = state.charging, info = state.batteries ?? {};
    const level = key === 'buds' ? (b.left === null ? b.right : b.right === null ? b.left : Math.min(b.left, b.right)) : b[key];
    const charging = Boolean(key === 'buds' ? c.left || c.right : key === 'single' ? c.left : c[key]);
    const remembered = key === 'buds' ? ['left', 'right'].map(p => info[p]).filter(p => p?.status === 'stale') : [info[key]].filter(p => p?.status === 'stale');
    const stale = level === null && remembered.length ? {level: Math.min(...remembered.map(p => p.last)), at: Math.min(...remembered.map(p => p.at))} : null;
    return {level, charging, stale};
}
// AirPods drawn in white, like the product pictures on an iPhone: two buds
// (stem and head), an over-ear headphone, or the charging case with its lid
// line and status light. Drawn with Cairo into `size`×`size`.
function drawProduct(cr, kind, size) {
    const white = (x0, y0, x1, y1) => {
        const g = new Cairo.LinearGradient(x0, y0, x1, y1);
        g.addColorStopRGBA(0, 1, 1, 1, 1); g.addColorStopRGBA(0.55, 0.95, 0.95, 0.97, 1); g.addColorStopRGBA(1, 0.78, 0.78, 0.82, 1);
        return g;
    };
    const rounded = (x, y, w, h, r) => {
        cr.newSubPath(); cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0); cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI); cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI); cr.closePath();
    };
    const u = size / 100;
    cr.setLineWidth(Math.max(1, 1.2 * u));
    if (kind === 'case') {
        rounded(14 * u, 26 * u, 72 * u, 54 * u, 20 * u);
        cr.setSource(white(0, 26 * u, 0, 80 * u)); cr.fillPreserve(); cr.setSourceRGBA(0, 0, 0, 0.28); cr.stroke();
        cr.setSourceRGBA(0, 0, 0, 0.22); cr.moveTo(16 * u, 44 * u); cr.lineTo(84 * u, 44 * u); cr.stroke();
        cr.setSourceRGBA(0.3, 0.85, 0.4, 0.95); cr.arc(50 * u, 60 * u, 2.6 * u, 0, 2 * Math.PI); cr.fill();
    } else if (kind === 'headphones') {
        cr.setLineWidth(7 * u); cr.setSourceRGBA(0.85, 0.85, 0.88, 1); cr.arc(50 * u, 54 * u, 32 * u, Math.PI * 1.05, Math.PI * 1.95); cr.stroke();
        cr.setLineWidth(Math.max(1, 1.2 * u));
        for (const x of [14, 66]) { rounded(x * u, 46 * u, 20 * u, 32 * u, 9 * u); cr.setSource(white(x * u, 0, (x + 20) * u, 0)); cr.fillPreserve(); cr.setSourceRGBA(0, 0, 0, 0.28); cr.stroke(); }
    } else {
        // Two buds, mirrored; `kind` 'left' or 'right' draws one.
        const bud = mirror => {
            cr.save(); if (mirror) { cr.translate(100 * u, 0); cr.scale(-1, 1); }
            rounded(40 * u, 40 * u, 10 * u, 44 * u, 5 * u);
            cr.setSource(white(40 * u, 0, 50 * u, 0)); cr.fillPreserve(); cr.setSourceRGBA(0, 0, 0, 0.25); cr.stroke();
            cr.newSubPath(); cr.arc(36 * u, 34 * u, 15 * u, 0, 2 * Math.PI);
            cr.setSource(white(22 * u, 20 * u, 50 * u, 48 * u)); cr.fillPreserve(); cr.setSourceRGBA(0, 0, 0, 0.25); cr.stroke();
            cr.setSourceRGBA(0.15, 0.15, 0.17, 0.85); cr.newSubPath(); cr.arc(30 * u, 30 * u, 3.4 * u, 0, 2 * Math.PI); cr.fill();
            cr.restore();
        };
        if (kind === 'buds') { cr.save(); cr.translate(-12 * u, 0); bud(false); cr.restore(); cr.save(); cr.translate(12 * u, 0); bud(true); cr.restore(); }
        else bud(kind === 'right');
    }
}
// One product of the connection card: its picture inside a battery ring, the
// percentage below. The picture springs in, the ring fills and the number counts up.
export function productCell(kind, caption) {
    const SIZE = 84, actor = box(true, {style_class: 'notchy-airpods-cell'});
    const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), width: SIZE, height: SIZE, x_align: Clutter.ActorAlign.CENTER});
    const ring = new St.DrawingArea({width: SIZE, height: SIZE});
    const picture = new St.DrawingArea({width: 56, height: 56, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
    stack.add_child(ring); stack.add_child(picture);
    const value = label('–', 'notchy-airpods-card-value', {x_align: Clutter.ActorAlign.CENTER});
    const captionLabel = label(caption, 'notchy-airpods-card-caption', {x_align: Clutter.ActorAlign.CENTER});
    actor.add_child(stack); actor.add_child(value); actor.add_child(captionLabel);
    // `stale`: the last valid reading ({level, at}) while the part reports none now.
    const cell = {actor, kind, caption, level: null, charging: false, low: false, stale: null, progress: 0, timeline: null};
    picture.connect('repaint', () => { const cr = picture.get_context(); drawProduct(cr, kind, picture.get_surface_size()[0]); cr.$dispose(); });
    ring.connect('repaint', () => {
        const cr = ring.get_context(), [w, h] = ring.get_surface_size(), r = Math.min(w, h) / 2 - 3;
        cr.setLineWidth(4); cr.setSourceRGBA(1, 1, 1, 0.13); cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI); cr.stroke();
        if (cell.level !== null && cell.progress > 0) {
            if (cell.low) cr.setSourceRGBA(1, 0.62, 0.04, 1); else cr.setSourceRGBA(0.2, 0.78, 0.35, 1);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.01, cell.level / 100 * cell.progress)); cr.stroke();
        } else if (cell.level === null && cell.stale) {
            // A remembered level: a quiet grey ring, never the live green.
            cr.setSourceRGBA(1, 1, 1, 0.32); cr.setLineCap(Cairo.LineCap.ROUND);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.01, cell.stale.level / 100)); cr.stroke();
        }
        cr.$dispose();
    });
    const text = () => {
        const stale = cell.level === null && cell.stale;
        value.text = cell.level !== null ? `${cell.charging ? '⚡ ' : ''}${Math.round(cell.level * cell.progress)} %` : stale ? `${cell.stale.level} %` : '–';
        stale ? value.add_style_class_name('stale') : value.remove_style_class_name('stale');
        const words = stale ? `${cell.caption} · ${cell.stale.at ? ageText(cell.stale.at) : 'zuletzt'}` : cell.caption;
        if (captionLabel.text !== words) captionLabel.text = words;
    };
    cell.setCaption = words => { cell.caption = words; text(); };
    cell.set = (level, charging, low, stale = null) => {
        const first = cell.level === null && level !== null && !cell.instant;
        cell.level = level; cell.charging = charging; cell.low = low; cell.stale = level === null && stale?.level !== null && stale?.level !== undefined ? stale : null;
        if (first) {
            cell.timeline?.stop(); cell.progress = 0;
            cell.timeline = new Clutter.Timeline({actor: ring, duration: 1100, progress_mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            cell.timeline.connect('new-frame', () => { cell.progress = cell.timeline.get_progress(); text(); ring.queue_repaint(); });
            cell.timeline.connect('completed', () => { cell.progress = 1; text(); ring.queue_repaint(); });
            cell.timeline.start();
        } else if (level !== null && !cell.timeline?.is_playing()) cell.progress = 1;
        actor.accessible_name = `${cell.caption}: ${level !== null ? `${level} %` : cell.stale ? `zuletzt ${cell.stale.level} %, ${ageText(cell.stale.at)}` : 'unbekannt'}${charging ? ', lädt' : ''}`;
        text(); ring.queue_repaint();
    };
    // The picture springs in once on screen, slightly turned, like on an iPhone.
    picture.opacity = 0; picture.scale_x = picture.scale_y = 0.35; picture.rotation_angle_z = -14;
    // Clutter skips transitions of actors not on screen yet; the picture maps after its parents.
    cell.appear = delay => {
        const go = () => picture.ease({opacity: 255, scale_x: 1, scale_y: 1, rotation_angle_z: 0, delay, duration: 700, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        if (picture.mapped) { go(); return; }
        const id = picture.connect('notify::mapped', () => { if (!picture.mapped) return; picture.disconnect(id); go(); });
    };
    cell.picture = picture;
    cell.stop = () => { cell.timeline?.stop(); cell.timeline = null; };
    return cell;
}
// A notification's body as one plain line.
const plain = n => (n.body || '').replace(n.useBodyMarkup ? /<[^>]*>/g : /$^/, '').replace(/\s+/g, ' ').trim();

export class Views {
    constructor(island, services) { Object.assign(this, services); this.island = island; this.life = new Lifetime(); this.menu = null; this.keyPress = null; }
    make(name) {
        this.pageLife?.dispose(); this.pageLife = new Lifetime(); this.keyPress = null;
        if (name === 'shelf') return this.shelfView();
        if (name === 'clipboard') return this.clipboardView();
        if (name === 'calendar') return this.calendarView();
        if (name === 'search') return this.searchView();
        return this.mediaView();
    }

    // Medien: large cover, title and artist, waveform, timeline, transport.
    mediaView() {
        // Droppy's player: cover, title and artist with the waveform, one
        // timeline row, flat transport icons and the playing app on the right.
        const root = box(true, {style_class: 'notchy-page notchy-media', y_expand: true});
        const state = this.settings.get_boolean('media-enabled') ? this.media.state : null;
        this.outputs.ensure();
        if (this.outputPicker) return this.outputsView(root);
        if (!state) {
            root.add_child(emptyState('audio-x-generic-symbolic', 'Gerade keine Wiedergabe', 'Starte Musik in einer MPRIS-fähigen App.', null, null));
            return root;
        }
        const top = box(false, {style_class: 'notchy-media-top'});
        const art = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 64, style_class: 'notchy-album'});
        if (this.cover.file) art.gicon = new Gio.FileIcon({file: this.cover.file});
        const artButton = new St.Button({child: art, can_focus: true, accessible_name: 'Spielende App öffnen', y_align: Clutter.ActorAlign.CENTER, style_class: 'notchy-album-button'});
        artButton.connect('clicked', () => this.media.raise()); top.add_child(artButton);
        const names = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        names.add_child(label(state.title, 'notchy-track'));
        names.add_child(label(state.artist || state.album || state.name, 'notchy-artist'));
        top.add_child(names);
        if (state.playing && this.settings.get_boolean('media-waveform')) top.add_child(new Waveform(this.spectrum, 30, 18));
        root.add_child(top);
        const timeline = box(false, {style_class: 'notchy-timeline'});
        const elapsed = label(time(this.media.elapsed), 'notchy-time', {y_align: Clutter.ActorAlign.CENTER});
        const seek = new Slider(state.length ? Math.min(1, this.media.elapsed / state.length) : 0);
        seek.reactive = state.canSeek; seek.add_style_class_name('notchy-seek'); seek.x_expand = true; seek.y_align = Clutter.ActorAlign.CENTER;
        seek.connect('drag-end', () => this.media.seek(seek.value));
        const remaining = label(`−${time(Math.max(0, state.length - this.media.elapsed))}`, 'notchy-time notchy-time-end', {y_align: Clutter.ActorAlign.CENTER});
        timeline.add_child(elapsed); timeline.add_child(seek); timeline.add_child(remaining); root.add_child(timeline);
        this.pageLife.every(1000, () => { if (!seek._dragging) {
            seek.value = state.length ? Math.min(1, this.media.elapsed / state.length) : 0;
            elapsed.text = time(this.media.elapsed); remaining.text = `−${time(Math.max(0, state.length - this.media.elapsed))}`;
        }});
        // A spacer as wide as the app tile keeps the transport exactly centred;
        // overlapping layouts would let the tile swallow the transport's clicks.
        const row = box(false, {x_expand: true, style_class: 'notchy-controls-row'});
        row.add_child(new St.Widget({width: 30}));
        const controls = box(false, {style_class: 'notchy-controls', x_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const prev = button('notchy-backward-symbolic', 'Vorheriger Titel', () => this.media.call('Previous'), 'notchy-transport'); prev.reactive = state.canPrevious; controls.add_child(prev);
        controls.add_child(button(state.playing ? 'notchy-pause-symbolic' : 'notchy-play-symbolic', state.playing ? 'Pause' : 'Wiedergabe', () => this.media.call('PlayPause'), 'notchy-play'));
        const next = button('notchy-forward-symbolic', 'Nächster Titel', () => this.media.call('Next'), 'notchy-transport'); next.reactive = state.canNext; controls.add_child(next);
        row.add_child(controls);
        // The playing app, as a small tile on the right (Droppy shows the source there too).
        const app = state.desktopEntry ? Shell.AppSystem.get_default().lookup_app(`${state.desktopEntry}.desktop`) : null;
        const source = new St.Button({style_class: 'notchy-source', can_focus: true, accessible_name: `${state.name} öffnen`, y_align: Clutter.ActorAlign.CENTER});
        const sourceIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 20}); if (app) sourceIcon.gicon = app.get_icon();
        source.set_child(sourceIcon); source.connect('clicked', () => this.media.raise()); row.add_child(source);
        root.add_child(row);
        // Where the music plays: this computer or an AirPlay receiver.
        root.add_child(new St.Widget({y_expand: true}));
        const outputIcon = new St.Icon({icon_size: 15}), outputName = label('', 'notchy-output-name', {y_align: Clutter.ActorAlign.CENTER});
        const outputRow = box(false, {style_class: 'notchy-output-row'});
        outputRow.add_child(outputIcon); outputRow.add_child(outputName); outputRow.add_child(icon('pan-down-symbolic', 12));
        const output = new St.Button({style_class: 'notchy-output-button', child: outputRow, can_focus: true, x_align: Clutter.ActorAlign.CENTER});
        output.connect('clicked', () => { this.outputPicker = true; this.island.refresh(); });
        const drawOutput = () => {
            const active = this.outputs.active;
            outputIcon.gicon = outputGicon(active); outputName.text = shorten(active?.name ?? 'Keine Ausgabe', 40);
            output.accessible_name = `Ausgabe: ${outputName.text}. Auf AirPlay oder ein anderes Gerät umschalten`;
            active?.airplay ? output.add_style_class_name('airplay') : output.remove_style_class_name('airplay');
        };
        this.pageLife.cleanups.push(this.outputs.subscribe(drawOutput)); drawOutput();
        root.add_child(output);
        return root;
    }

    // AirPods connected: the capsule grows into a card as on an iPhone — the
    // name, the AirPods and their case springing in, battery rings filling up
    // with the percentages counting, and „Verbunden“ with a check.
    airpodsPeekView() {
        const airpods = this.airpods, root = box(true, {style_class: 'notchy-peek notchy-airpods-card'});
        const head = box(false, {style_class: 'notchy-airpods-card-head'});
        const title = label('', 'notchy-airpods-card-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const status = box(false, {style_class: 'notchy-airpods-card-status', y_align: Clutter.ActorAlign.CENTER, opacity: 0, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        status.add_child(new St.Icon({icon_name: 'object-select-symbolic', icon_size: 13, style_class: 'notchy-airpods-card-check', y_align: Clutter.ActorAlign.CENTER}));
        const statusText = label('Verbunden', 'notchy-airpods-card-status-text', {y_align: Clutter.ActorAlign.CENTER});
        status.add_child(statusText);
        head.add_child(title); head.add_child(status); root.add_child(head);
        const products = box(false, {style_class: 'notchy-airpods-products', x_align: Clutter.ActorAlign.CENTER});
        root.add_child(products);
        const threshold = this.settings.get_int('airpods-battery-threshold');
        let cells = new Map(), layout = '';
        // Both buds in one ring while they are within 10 %, as the iPhone does; else one each.
        const parts = state => {
            const {left, right, single} = state.battery;
            if (state.headphones || state.backend === 'bluez' || single !== null) return [['single', state.headphones ? 'headphones' : 'buds', state.headphones ? 'Akku' : 'AirPods']];
            const together = left === null || right === null ? left === right : Math.abs(left - right) <= 10;
            return [...(together ? [['buds', 'buds', 'AirPods']] : [['left', 'left', 'Links'], ['right', 'right', 'Rechts']]), ['case', 'case', 'Case']];
        };
        const animate = () => {
            let delay = 0;
            for (const cell of cells.values()) { cell.appear(delay); delay += 130; }
            status.ease({opacity: 255, scale_x: 1, scale_y: 1, delay: 650, duration: 400, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        };
        const draw = () => {
            const state = airpods.state; if (!state) return;
            title.text = state.name;
            statusText.text = state.connected ? (state.anc ? `Verbunden · ${ANC_NAME[state.anc]}` : 'Verbunden') : 'Getrennt';
            const wanted = parts(state), key = wanted.map(([k]) => k).join('|');
            if (key !== layout) {
                const shown = layout !== '';
                layout = key;
                for (const cell of cells.values()) cell.stop();
                products.destroy_all_children(); cells = new Map();
                for (const [partKey, kind, caption] of wanted) { const cell = productCell(kind, caption); cells.set(partKey, cell); products.add_child(cell.actor); }
                // A later re-layout (batteries arrived) shows the pictures at once.
                if (shown) for (const cell of cells.values()) { cell.instant = true; cell.progress = 1; cell.picture.opacity = 255; cell.picture.scale_x = cell.picture.scale_y = 1; cell.picture.rotation_angle_z = 0; }
            }
            for (const [partKey, cell] of cells) {
                const {level, charging, stale} = partReading(state, partKey);
                cell.set(level, charging, level !== null && level < threshold && !charging, stale);
            }
        };
        const unsubscribe = airpods.subscribe(draw); draw();
        status.scale_x = status.scale_y = 0.6;
        let started = false;
        const start = () => { if (started || !products.mapped) return; started = true; animate(); };
        const mappedId = products.connect('notify::mapped', start); start();
        root.connect('destroy', () => { unsubscribe(); products.disconnect(mappedId); for (const cell of cells.values()) cell.stop(); });
        return {actor: root, get cells() { return cells; }};
    }

    // Snap layouts: miniature screens whose zones take the dragged window.
    snapView(window) {
        const actor = box(true, {style_class: 'notchy-snap'});
        const head = box(false, {style_class: 'notchy-snap-head'});
        head.add_child(icon('view-grid-symbolic', 14));
        head.add_child(label(window.get_title() || 'Fenster', 'notchy-snap-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        head.add_child(label('Loslassen über einer Fläche', 'notchy-cal-meta', {y_align: Clutter.ActorAlign.CENTER}));
        actor.add_child(head);
        const row = box(false, {style_class: 'notchy-snap-row', x_align: Clutter.ActorAlign.CENTER}), zones = [];
        for (const layout of SNAP_LAYOUTS) {
            const tile = new St.Widget({style_class: 'notchy-snap-tile', width: SNAP_TILE[0], height: SNAP_TILE[1], accessible_name: layout.name});
            const inner = {x: 3, y: 3, width: SNAP_TILE[0] - 6, height: SNAP_TILE[1] - 6};
            for (const zone of layout.zones) {
                const r = zoneRect(inner, zone);
                const zoneActor = new St.Widget({style_class: 'notchy-snap-zone', x: r.x + 1, y: r.y + 1, width: r.width - 2, height: r.height - 2});
                tile.add_child(zoneActor); zones.push({actor: zoneActor, tile, zone, layout});
            }
            row.add_child(tile);
        }
        actor.add_child(row);
        return {actor, zones};
    }

    // The audio output list: this computer's outputs and AirPlay receivers.
    outputsView(root) {
        root.add_style_class_name('notchy-outputs');
        const head = box(false, {style_class: 'notchy-outputs-head'});
        const back = button('go-previous-symbolic', 'Zurück zum Player', () => { this.outputPicker = false; this.island.refresh(); }, 'notchy-round-button small');
        back.y_align = Clutter.ActorAlign.CENTER; head.add_child(back);
        head.add_child(label('Musik abspielen auf', 'notchy-cal-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const status = label('', 'notchy-cal-meta', {y_align: Clutter.ActorAlign.CENTER}); head.add_child(status);
        root.add_child(head);
        const list = box(true, {style_class: 'notchy-outputs-list'});
        root.add_child(scroll(list, 214));
        this.keyPress = event => {
            if (event.get_key_symbol() !== Clutter.KEY_BackSpace) return Clutter.EVENT_PROPAGATE;
            this.outputPicker = false; this.island.refresh(); return Clutter.EVENT_STOP;
        };
        const draw = () => {
            list.destroy_all_children();
            const outputs = this.outputs.list, airplay = this.settings.get_boolean('airplay-enabled');
            status.text = !airplay ? '' : this.outputs.error || (this.outputs.discovering ? 'AirPlay aktiv' : '');
            for (const output of outputs) {
                const row = box(false, {style_class: 'notchy-output-item-row', x_expand: true});
                const tile = new St.Bin({style_class: `notchy-output-tile${output.airplay ? ' airplay' : ''}`, child: new St.Icon({gicon: outputGicon(output), icon_size: 16})});
                row.add_child(tile);
                const text = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                text.add_child(label(shorten(output.name, 60), 'notchy-output-item-name'));
                text.add_child(label(output.airplay ? 'AirPlay' : 'Dieser Computer', 'notchy-output-item-sub'));
                row.add_child(text);
                if (output.active) row.add_child(new St.Icon({icon_name: 'object-select-symbolic', icon_size: 16, style_class: 'notchy-output-check', y_align: Clutter.ActorAlign.CENTER}));
                const item = new St.Button({style_class: `notchy-output-item${output.active ? ' active' : ''}`, child: row, x_expand: true, can_focus: true, accessible_name: `${output.name}${output.airplay ? ' (AirPlay)' : ''}`});
                item.connect('clicked', () => {
                    this.outputs.select(output);
                    this.island.toast(output.airplay ? 'notchy-airplay-symbolic' : 'audio-speakers-symbolic', `Wiedergabe auf ${output.name}`);
                    this.outputPicker = false; this.island.refresh();
                });
                list.add_child(item);
            }
            if (!airplay) {
                const find = new St.Button({style_class: 'notchy-output-find', x_expand: true, can_focus: true, accessible_name: 'AirPlay-Geräte finden'});
                const findRow = box(false, {style_class: 'notchy-output-item-row', x_expand: true});
                findRow.add_child(new St.Bin({style_class: 'notchy-output-tile airplay', child: icon('notchy-airplay-symbolic', 16)}));
                findRow.add_child(label('AirPlay-Geräte im Netzwerk finden', 'notchy-output-item-name', {y_align: Clutter.ActorAlign.CENTER}));
                find.set_child(findRow); find.connect('clicked', () => this.settings.set_boolean('airplay-enabled', true));
                list.add_child(find);
            } else if (!outputs.some(output => output.airplay)) {
                list.add_child(label(this.outputs.discovering ? 'Suche nach AirPlay-Geräten im Netzwerk …' : 'Keine AirPlay-Geräte gefunden.', 'notchy-output-hint'));
            }
        };
        this.pageLife.cleanups.push(this.outputs.subscribe(draw));
        const settingsId = this.settings.connect('changed::airplay-enabled', draw); this.pageLife.cleanups.push(() => this.settings.disconnect(settingsId));
        draw();
        return root;
    }

    // Regal: the native GTK pane supplies files, selection and drag sources in
    // this same place. This Shell copy mirrors its layout so switching tabs
    // cross-fades into the native pane instead of visibly rebuilding.
    shelfView() {
        const root = box(true, {style_class: 'notchy-page notchy-shelf-preview', y_expand: true});
        const items = this.shelf.items;
        const head = box(false, {style_class: 'notchy-shelf-head'});
        head.add_child(label(`${items.length} ${items.length === 1 ? 'Datei' : 'Dateien'}`, 'notchy-shelf-count', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        head.add_child(new St.Bin({style_class: 'notchy-shelf-add', child: icon('list-add-symbolic', 16), y_align: Clutter.ActorAlign.CENTER}));
        root.add_child(head);
        if (!items.length) {
            const empty = box(true, {style_class: 'notchy-drop-hint', x_expand: true});
            empty.add_child(icon('document-save-symbolic', 24)); empty.add_child(label('Dateien auf die Island ziehen', 'notchy-muted'));
            root.add_child(empty); return root;
        }
        const width = Math.floor((this.island.currentWidth - 44 - 4 * 6) / 5);
        for (let i = 0; i < Math.min(items.length, 10); i += 5) {
            const row = box(false, {style_class: 'notchy-shelf-row'});
            for (const item of items.slice(i, i + 5)) row.add_child(this.fileTile(item, width));
            root.add_child(row);
        }
        return root;
    }
    fileTile(item, width) {
        const ext = extensionOf(item.name);
        const tile = box(true, {style_class: 'notchy-file-tile', width});
        const thumb = new St.Widget({style_class: `notchy-file-thumb ${EXT_CLASS[ext] ?? 'other'}`, layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        thumb.add_child(label(ext.toUpperCase() || 'DATEI', 'notchy-file-ext', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END}));
        tile.add_child(thumb);
        tile.add_child(label(item.name, 'notchy-file-name', {x_align: Clutter.ActorAlign.CENTER}));
        return tile;
    }

    // Ablage: search with filters, a quiet list and one selected row that
    // offers its actions. ↑↓ move, ↵ copies, ⇧↵ copies plain text, F and Entf.
    clipboardView() {
        const root = box(true, {style_class: 'notchy-page notchy-clipboard', y_expand: true});
        if (!this.settings.get_boolean('clipboard-enabled')) {
            root.add_child(emptyState('edit-paste-symbolic', 'Verlauf ist pausiert', 'Kopien werden nur nach Aktivierung aufgezeichnet.', 'Aufzeichnung aktivieren', () => this.settings.set_boolean('clipboard-enabled', true)));
            return root;
        }
        let filter = 'all', query = '', selected = 0, lastClick = [-1, 0];
        const top = box(false, {style_class: 'notchy-clip-top'});
        const search = new St.Entry({style_class: 'notchy-search-pill', hint_text: 'Suchen', can_focus: true, x_expand: true});
        search.set_primary_icon(icon('edit-find-symbolic', 16));
        top.add_child(search); this.focusEntry = search;
        const chips = box(false, {style_class: 'notchy-chips'});
        const chipButtons = FILTERS.map(([id, iconName, title]) => {
            const chip = button(iconName, title, () => { filter = id; selected = 0; update(); }, 'notchy-chip'); chips.add_child(chip); return [id, chip];
        });
        top.add_child(chips); root.add_child(top);
        const list = box(true, {style_class: 'notchy-clip-list'});
        root.add_child(scroll(list, 250));
        const items = () => this.clipboard.history.search(query, filter === 'link' ? 'link' : filter === 'image' ? 'image' : 'all', filter === 'fav');
        const copy = (item, plain = false) => {
            if (plain && item.kind !== 'image' && item.kind !== 'files') St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.text);
            else this.clipboard.copy(item);
            this.island.close(); this.island.toast('edit-copy-symbolic', plain ? 'Als reiner Text kopiert' : 'In Zwischenablage kopiert');
        };
        const act = (action, item) => {
            if (!item) return;
            if (action === 'copy' || action === 'plain') copy(item, action === 'plain');
            else if (action === 'fav') this.clipboard.favorite(item.id);
            else if (action === 'del') this.clipboard.remove(item.id);
            else if (action === 'shelf') { this.shelveClip(item); this.island.toast('package-x-generic-symbolic', 'Ins Regal gelegt'); }
        };
        const update = () => {
            for (const [id, chip] of chipButtons) id === filter ? chip.add_style_class_name('active') : chip.remove_style_class_name('active');
            list.destroy_all_children();
            const found = items(); selected = Math.max(0, Math.min(selected, found.length - 1));
            found.slice(0, 100).forEach((item, index) => {
                const current = index === selected;
                const row = box(false, {style_class: `notchy-clip-row${current ? ' selected' : ''}`});
                const tile = new St.Bin({style_class: `notchy-clip-icon ${item.kind}`, y_align: Clutter.ActorAlign.CENTER});
                if (item.kind === 'color') tile.style = `background-color: ${item.text.trim()};`;
                tile.set_child(item.kind === 'image' && item.asset ? new St.Icon({gicon: new Gio.FileIcon({file: Gio.File.new_for_path(item.asset)}), icon_size: 26}) : icon(CLIP_ICON[item.kind] ?? CLIP_ICON.text, 15));
                row.add_child(tile);
                const text = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                text.add_child(label(item.title || item.text.replace(/\s+/g, ' ').slice(0, 160), `notchy-clip-text${item.kind === 'color' ? ' mono' : ''}`));
                if (current) text.add_child(label([item.source, relativeTime(item.created)].filter(Boolean).join(' · '), 'notchy-clip-meta'));
                const open = new St.Button({child: text, x_expand: true, can_focus: false, style_class: 'notchy-clip-open', accessible_name: item.title || item.text.slice(0, 80)});
                open.connect('clicked', () => {
                    // A second click on the same row within 400 ms copies it.
                    const now = GLib.get_monotonic_time() / 1000, double = lastClick[0] === item.id && now - lastClick[1] < 400;
                    lastClick = [item.id, now];
                    if (double) { copy(item); return; }
                    selected = index; update();
                });
                row.add_child(open);
                if (current) {
                    const actions = box(false, {style_class: 'notchy-clip-actions', y_align: Clutter.ActorAlign.CENTER});
                    actions.add_child(button(item.favorite ? 'starred-symbolic' : 'non-starred-symbolic', 'Favorit (F)', () => act('fav', item), `notchy-round-button${item.favorite ? ' favorite' : ''}`));
                    actions.add_child(button('user-trash-symbolic', 'Löschen (Entf)', () => act('del', item), 'notchy-round-button'));
                    actions.add_child(button('package-x-generic-symbolic', 'Ins Regal', () => act('shelf', item), 'notchy-round-button'));
                    actions.add_child(button('edit-copy-symbolic', 'Kopieren (Enter)', () => act('copy', item), 'notchy-round-button accent'));
                    row.add_child(actions);
                } else {
                    if (item.favorite) { const star = icon('starred-symbolic', 13); star.add_style_class_name('notchy-star'); star.y_align = Clutter.ActorAlign.CENTER; row.add_child(star); }
                    row.add_child(label(relativeTime(item.created), 'notchy-clip-time', {y_align: Clutter.ActorAlign.CENTER}));
                }
                list.add_child(row);
            });
            if (!found.length) list.add_child(label('Nichts gefunden', 'notchy-muted', {x_align: Clutter.ActorAlign.CENTER, style: 'padding: 24px 0;'}));
            this.pageLife.later(0, () => {
                const row = list.get_child_at_index(selected), view = list.get_parent();
                if (!row || !view?.vadjustment) return;
                const adjust = view.vadjustment;
                if (row.y < adjust.value) adjust.value = row.y;
                else if (row.y + row.height > adjust.value + adjust.page_size) adjust.value = row.y + row.height - adjust.page_size;
            });
        };
        const keys = (event, inEntry) => {
            const key = event.get_key_symbol(), shift = Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
            const found = items();
            if (key === Clutter.KEY_Down) { selected = Math.min(found.length - 1, selected + 1); update(); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Up) { selected = Math.max(0, selected - 1); update(); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) { act(shift ? 'plain' : 'copy', found[selected]); return Clutter.EVENT_STOP; }
            if (inEntry) return Clutter.EVENT_PROPAGATE;
            if (key === Clutter.KEY_f || key === Clutter.KEY_F) { act('fav', found[selected]); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Delete) { act('del', found[selected]); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        };
        search.clutter_text.connect('text-changed', () => { query = search.get_text(); selected = 0; update(); });
        search.clutter_text.connect('key-press-event', (_t, event) => keys(event, true));
        this.keyPress = event => keys(event, false);
        update(); this.pageLife.cleanups.push(this.clipboard.subscribe(update));
        return root;
    }
    shelveClip(item) {
        if (item.kind === 'files') { this.shelf.add(item.uris.join('\r\n')); return; }
        if (item.kind === 'image' && item.asset) { this.operations.run('copy', Gio.File.new_for_path(item.asset).get_uri()); return; }
        const file = Gio.File.new_for_path(`${this.store.dir}/clip-${item.id}.txt`);
        file.replace_contents_async(new TextEncoder().encode(item.text), null, false, Gio.FileCreateFlags.PRIVATE, this.life.cancellable, (f, res) => {
            try { f.replace_contents_finish(res); if (!this.life.closed) this.shelf.add(f.get_uri()); } catch (e) { if (!this.life.closed) console.warn(e.message); }
        });
    }

    // Kalender: GNOME's clock popup inside Notchy — notifications with Do Not
    // Disturb on the left, this month with upcoming events on the right.
    // Kalender (Droppy design): a week strip with arrows, the selected day's
    // agenda with a "now" line, and GNOME's notifications grouped per app.
    calendarView() {
        const root = box(true, {style_class: 'notchy-page notchy-calendar', y_expand: true});
        const today = new Date(); today.setHours(0, 0, 0, 0);
        this.calWeek ??= 0; this.calDay ??= today.getTime(); this.calOpen ??= new Set();
        const strip = box(false, {style_class: 'notchy-cal-strip'});
        const days = box(false, {style_class: 'notchy-cal-days', x_expand: true});
        const prevWeek = button('go-previous-symbolic', 'Vorherige Woche', () => { this.calWeek--; drawWeek(); }, 'notchy-round-button small');
        const nextWeek = button('go-next-symbolic', 'Nächste Woche', () => { this.calWeek++; drawWeek(); }, 'notchy-round-button small');
        for (const b of [prevWeek, nextWeek]) b.y_align = Clutter.ActorAlign.CENTER;
        strip.add_child(prevWeek); strip.add_child(days); strip.add_child(nextWeek); root.add_child(strip);

        const columns = box(false, {style_class: 'notchy-cal-columns', y_expand: true});
        const agendaColumn = box(true, {style_class: 'notchy-cal-column', x_expand: true});
        const dayHead = box(false, {style_class: 'notchy-cal-head'});
        const dayTitle = label('', 'notchy-cal-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const weekLabel = label('', 'notchy-cal-meta', {y_align: Clutter.ActorAlign.CENTER});
        dayHead.add_child(dayTitle); dayHead.add_child(weekLabel); agendaColumn.add_child(dayHead);
        const agenda = box(true, {style_class: 'notchy-cal-agenda'}); agendaColumn.add_child(scroll(agenda, CAL_LIST_HEIGHT));
        columns.add_child(agendaColumn);

        const notesColumn = box(true, {style_class: 'notchy-cal-column', x_expand: true});
        const notesHead = box(false, {style_class: 'notchy-cal-head'});
        notesHead.add_child(label('Mitteilungen', 'notchy-cal-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const dndIcon = new St.Icon({icon_size: 14}), dndLabel = label('', 'notchy-cal-dnd-label');
        const dndRow = box(false, {style_class: 'notchy-cal-dnd-row'}); dndRow.add_child(dndIcon); dndRow.add_child(dndLabel);
        const dnd = new St.Button({style_class: 'notchy-cal-dnd', child: dndRow, can_focus: true, accessible_name: 'Nicht stören', y_align: Clutter.ActorAlign.CENTER});
        dnd.connect('clicked', () => {
            this.notifications.doNotDisturb = !this.notifications.doNotDisturb;
            this.island.toast(this.notifications.doNotDisturb ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
                this.notifications.doNotDisturb ? 'Nicht stören ist an' : 'Mitteilungen wieder an');
        });
        const clear = button('edit-clear-all-symbolic', 'Alle löschen', () => this.notifications.clear(), 'notchy-round-button small');
        clear.y_align = Clutter.ActorAlign.CENTER;
        notesHead.add_child(dnd); notesHead.add_child(clear); notesColumn.add_child(notesHead);
        const notes = box(true, {style_class: 'notchy-cal-notes'}); notesColumn.add_child(scroll(notes, CAL_LIST_HEIGHT));
        columns.add_child(notesColumn);
        root.add_child(columns);

        const empty = (iconName, text) => {
            const actor = box(true, {style_class: 'notchy-cal-empty', x_expand: true, y_expand: true});
            actor.add_child(icon(iconName, 24)); actor.add_child(label(text, '', {x_align: Clutter.ActorAlign.CENTER}));
            return actor;
        };
        const clock = d => d.toLocaleTimeString('de-CH', {hour: '2-digit', minute: '2-digit'});
        const drawAgenda = () => {
            agenda.destroy_all_children();
            const day = new Date(this.calDay), offset = Math.round((day - today) / 86400000);
            const name = offset === 0 ? 'Heute' : offset === 1 ? 'Morgen' : offset === -1 ? 'Gestern' : day.toLocaleDateString('de-CH', {weekday: 'long'});
            dayTitle.text = `${name}, ${day.getDate()}. ${day.toLocaleDateString('de-CH', {month: 'long'})}`;
            weekLabel.text = `KW ${isoWeek(day)}`;
            const events = this.calendar.day(day), now = Date.now();
            let nowShown = offset !== 0;
            const nowLine = () => {
                const row = box(false, {style_class: 'notchy-cal-now'});
                row.add_child(label(clock(new Date()), 'notchy-cal-now-time', {y_align: Clutter.ActorAlign.CENTER}));
                row.add_child(new St.Widget({style_class: 'notchy-cal-now-dot', y_align: Clutter.ActorAlign.CENTER}));
                row.add_child(new St.Widget({style_class: 'notchy-cal-now-line', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
                agenda.add_child(row); nowShown = true;
            };
            events.forEach((event, i) => {
                const begin = new Date(event.begin), end = new Date(event.end);
                if (!nowShown && event.begin >= now) nowLine();
                const allDay = begin.getHours() === 0 && begin.getMinutes() === 0 && end.getHours() === 0 && end.getMinutes() === 0 && event.end > event.begin;
                const past = offset < 0 || (offset === 0 && event.end <= now && !allDay);
                const row = box(false, {style_class: `notchy-cal-event${past ? ' past' : ''}`});
                row.add_child(label(allDay ? 'Tag' : clock(begin), 'notchy-cal-event-time'));
                const card = box(false, {style_class: 'notchy-cal-event-card', x_expand: true});
                card.add_child(new St.Widget({style_class: `notchy-cal-event-bar tone-${i % 4}`}));
                const text = box(true, {x_expand: true});
                text.add_child(label(event.title || 'Termin', 'notchy-cal-event-title'));
                const minutes = Math.round((event.end - event.begin) / 60000);
                text.add_child(label(allDay ? 'Ganztägig' : minutes > 0 ? `${clock(begin)} – ${clock(end)}` : clock(begin), 'notchy-cal-event-sub'));
                card.add_child(text); row.add_child(card); agenda.add_child(row);
            });
            if (!nowShown && events.length) nowLine();
            if (!events.length) agenda.add_child(empty('x-office-calendar-symbolic', this.calendar.loading ? 'Termine werden geladen …' : this.calendar.error || 'Keine Termine'));
        };
        // request: only for a new week; calendar updates merely redraw.
        const drawWeek = (request = true) => {
            days.destroy_all_children();
            const week = weekDays(today, this.calWeek);
            if (request) this.calendar.requestRange(week[0], new Date(week[6].getFullYear(), week[6].getMonth(), week[6].getDate() + 1));
            for (const day of week) {
                const selected = day.getTime() === this.calDay, isToday = day.getTime() === today.getTime(), weekend = day.getDay() % 6 === 0;
                const cell = box(true, {x_expand: true});
                cell.add_child(label(day.toLocaleDateString('de-CH', {weekday: 'short'}).replace('.', ''), 'notchy-cal-weekday', {x_align: Clutter.ActorAlign.CENTER}));
                cell.add_child(label(String(day.getDate()), 'notchy-cal-daynum', {x_align: Clutter.ActorAlign.CENTER}));
                cell.add_child(new St.Widget({style_class: `notchy-cal-dot${this.calendar.day(day).length ? ' busy' : ''}`, x_align: Clutter.ActorAlign.CENTER}));
                const classes = ['notchy-cal-day', selected && 'selected', isToday && 'today', weekend && 'weekend'].filter(Boolean).join(' ');
                const b = new St.Button({style_class: classes, child: cell, x_expand: true, can_focus: true, accessible_name: day.toLocaleDateString('de-CH', {weekday: 'long', day: 'numeric', month: 'long'})});
                b.connect('clicked', () => { this.calDay = day.getTime(); drawWeek(); });
                days.add_child(b);
            }
            drawAgenda();
        };
        const drawNotes = () => {
            const on = this.notifications.doNotDisturb;
            dndIcon.icon_name = on ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic';
            dndLabel.text = on ? 'Nicht stören' : 'An';
            on ? dnd.add_style_class_name('on') : dnd.remove_style_class_name('on');
            notes.destroy_all_children();
            const items = this.notifications.items;
            clear.reactive = items.some(x => !x.resident); clear.opacity = clear.reactive ? 255 : 90;
            for (const group of groupBy(items.slice(0, 60), n => n.source?.title || 'Benachrichtigung')) {
                const [top, ...rest] = group.items, open = rest.length > 0 && this.calOpen.has(group.name);
                const stack = box(true, {style_class: `notchy-cal-group${rest.length && !open ? ' stacked' : ''}`});
                const card = box(false, {style_class: 'notchy-cal-note'});
                const badge = new St.Bin({style_class: 'notchy-cal-note-icon', y_align: Clutter.ActorAlign.START});
                const glyph = new St.Icon({icon_name: 'preferences-system-notifications-symbolic', icon_size: 16});
                const gicon = top.gicon ?? top.source?.icon; if (gicon) glyph.gicon = gicon;
                badge.set_child(glyph); card.add_child(badge);
                const text = box(true, {x_expand: true});
                const meta = box(false, {style_class: 'notchy-cal-note-meta'});
                meta.add_child(label(group.name, 'notchy-cal-note-app'));
                if (rest.length) meta.add_child(label(String(group.items.length), 'notchy-cal-note-count'));
                meta.add_child(new St.Widget({x_expand: true}));
                if (top.datetime) meta.add_child(label(formatTimeSpan(top.datetime), 'notchy-cal-note-time'));
                text.add_child(meta);
                text.add_child(label(top.title || group.name, 'notchy-cal-note-title'));
                const body = plain(top);
                // About two lines, as in the design.
                if (body) { const b = label(body.length > 84 ? `${body.slice(0, 82).trimEnd()} …` : body, 'notchy-cal-note-body'); b.clutter_text.set_line_wrap(true); b.clutter_text.ellipsize = 0; text.add_child(b); }
                // A stack opens on click; a single notification opens its app.
                const press = new St.Button({child: text, x_expand: true, can_focus: true, accessible_name: rest.length ? `${group.name}: ${group.items.length} Mitteilungen` : `Öffnen: ${top.title || ''}`});
                press.connect('clicked', () => {
                    if (rest.length) { open ? this.calOpen.delete(group.name) : this.calOpen.add(group.name); drawNotes(); }
                    else { this.island.close(); top.activate(); }
                });
                card.add_child(press);
                if (group.items.some(n => !n.resident)) {
                    const close = button('window-close-symbolic', 'Mitteilungen schließen', () => { for (const n of group.items) if (!n.resident) n.destroy(); }, 'notchy-round-button tiny');
                    close.y_align = Clutter.ActorAlign.START; card.add_child(close);
                }
                stack.add_child(card);
                if (open) for (const n of rest) {
                    const sub = box(true, {style_class: 'notchy-cal-note-sub'});
                    const line = box(false); line.add_child(label(n.title || group.name, 'notchy-cal-note-title', {x_expand: true}));
                    if (n.datetime) line.add_child(label(formatTimeSpan(n.datetime), 'notchy-cal-note-time'));
                    sub.add_child(line); const subBody = plain(n); if (subBody) sub.add_child(label(subBody, 'notchy-cal-note-body'));
                    const subButton = new St.Button({child: sub, x_expand: true, can_focus: true, accessible_name: `Öffnen: ${n.title || ''}`});
                    subButton.connect('clicked', () => { this.island.close(); n.activate(); });
                    stack.add_child(subButton);
                }
                notes.add_child(stack);
            }
            if (!items.length) notes.add_child(empty('notifications-disabled-symbolic', 'Alles erledigt'));
        };
        this.pageLife.cleanups.push(this.notifications.subscribe(drawNotes)); drawNotes();
        this.pageLife.cleanups.push(this.calendar.subscribe(() => drawWeek(false))); drawWeek();
        // The "now" line moves along while the tab is open.
        this.pageLife.every(60000, () => drawAgenda());
        return root;
    }

    // Thunderstorm: the island becomes a launcher. Apps, files anywhere (GNOME
    // LocalSearch), the Regal, arithmetic and units, quicklinks and web search,
    // system and window commands, the clipboard history, snippets and emoji.
    // ↑↓ choose, ↵ runs, Strg+↵ the second action, Strg+K all actions, Esc
    // steps back or closes. Providers live in src/launcher/.
    searchView() {
        const root = box(true, {style_class: 'notchy-search', y_expand: true});
        const bar = box(false, {style_class: 'notchy-search-bar'});
        bar.add_child(new St.Icon({icon_name: 'weather-storm-symbolic', icon_size: 22, style_class: 'notchy-search-bolt', y_align: Clutter.ActorAlign.CENTER}));
        const entry = new St.Entry({style_class: 'notchy-search-entry', hint_text: 'Apps, Befehle, Rechnen … · „datei …“ für Dateien', can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        bar.add_child(entry); bar.add_child(label('Esc', 'notchy-keycap', {y_align: Clutter.ActorAlign.CENTER}));
        root.add_child(bar); this.focusEntry = entry;
        const list = box(true, {style_class: 'notchy-results'});
        const view = new St.ScrollView({style_class: 'notchy-scroll notchy-results-scroll', x_expand: true, y_expand: true, overlay_scrollbars: false});
        view.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC); view.set_child(list); root.add_child(view);
        const footer = box(false, {style_class: 'notchy-search-footer'});
        const status = label('', 'notchy-search-footer-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const hint = label('', 'notchy-search-footer-key', {y_align: Clutter.ActorAlign.CENTER});
        footer.add_child(status); footer.add_child(hint); root.add_child(footer);
        // The window that had focus before the launcher took the keyboard.
        const focusWindow = global.display.focus_window ?? global.display.get_tab_list(Meta.TabList.NORMAL, null)[0] ?? null;
        const state = {results: [], selected: 0, panel: null, confirm: null, drill: null, pending: false, empty: true, backend: '', error: ''};
        const island = this.island, launcher = this.launcher;
        const ctx = {
            window: focusWindow,
            toast: (iconName, text) => island.toast(iconName, text),
            copy: (text, message) => { St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text); island.toast('edit-copy-symbolic', message ?? 'Kopiert'); },
            setQuery: text => { entry.set_text(text); entry.clutter_text.set_cursor_position(-1); entry.grab_key_focus(); },
            drill: name => openDrill(name),
            fileBackend: (backend, error) => { state.backend = backend ?? ''; state.error = error ?? ''; },
            openFile: file => Gio.File.new_for_uri(file.uri).query_info_async('standard::type,access::can-read,access::can-execute', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (f, result) => {
                try {
                    const info = f.query_info_finish(result);
                    if (!info.get_attribute_boolean('access::can-read')) { island.toast('dialog-warning-symbolic', 'Keine Berechtigung für diese Datei'); return; }
                    launchUri(file.uri);
                } catch (e) {
                    island.toast('dialog-warning-symbolic', e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ? 'Datei nicht mehr vorhanden' : 'Datei nicht erreichbar');
                }
            }),
        };
        const session = launcher.session(ctx, this.pageLife, (results, info) => {
            if (state.drill) return;
            const keep = state.fresh || !state.moved ? null : state.results[state.selected]?.id;
            state.results = results; state.pending = info.pending; state.empty = Boolean(info.empty); state.mode = info.mode ?? 'all';
            if (state.fresh) state.moved = false;
            state.fresh = false;
            // A new query starts at the top, and so does a late answer (files) —
            // unless the user already moved to a row: then it stays on that row.
            const index = keep ? results.findIndex(r => r.id === keep) : -1;
            state.selected = index >= 0 ? index : 0;
            draw();
        });
        this.searchSession = session; this.searchState = state;
        const ROW = 42, HEADER = 24, VISIBLE = this.settings.get_int('launcher-max-results');
        const current = () => state.panel ? state.panel.actions : state.results;
        const run = (result, action) => {
            if (!result || !action) return;
            // Shutting down and the like ask first: a second Enter confirms.
            if (result.confirm && action === result.actions[0] && state.confirm !== result.id) { state.confirm = result.id; draw(); return; }
            if (action.keepOpen) { state.panel = null; state.confirm = null; action.run(); return; }
            launcher.record(result); island.close(); action.run();
        };
        const activate = (index = state.selected, second = false) => {
            if (state.panel) { const action = state.panel.actions[index]; if (action) run(state.panel.result, action); return; }
            const result = state.results[index]; if (!result) return;
            run(result, second ? result.actions[1] ?? result.actions[0] : result.actions[0]);
        };
        const togglePanel = () => {
            if (state.panel) { state.selected = state.panel.index; state.panel = null; }
            else { const result = state.results[state.selected]; if (!result?.actions?.length) return; state.panel = {result, actions: result.actions, index: state.selected}; state.selected = 0; }
            state.confirm = null; draw();
        };
        const openDrill = async name => {
            if (name !== 'indexed') return;
            session.cancel(); state.drill = name; state.panel = null; state.confirm = null; state.results = []; state.pending = true; draw();
            const rows = await session.indexed().catch(() => []);
            if (state.drill !== name || this.pageLife.closed) return;
            state.results = rows; state.selected = 0; state.pending = false; draw();
        };
        const row = (item, index, selected) => {
            const isAction = Boolean(state.panel), confirming = !isAction && state.confirm === item.id;
            const classes = ['notchy-result', selected && 'selected', confirming && 'confirm'].filter(Boolean).join(' ');
            const actor = box(false, {style_class: classes, x_expand: true, x_align: Clutter.ActorAlign.FILL});
            const tile = new St.Bin({style_class: `notchy-result-icon${item.accent ? ' accent' : ''}${confirming ? ' danger' : ''}`, y_align: Clutter.ActorAlign.CENTER});
            if (item.glyph) tile.set_child(label(item.glyph, 'notchy-result-glyph', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
            else { const glyph = new St.Icon({icon_size: item.gicon && !item.file ? 22 : 16}); if (item.gicon) glyph.gicon = item.gicon; else glyph.gicon = gicon(item.icon ?? 'go-next-symbolic'); tile.set_child(glyph); }
            actor.add_child(tile);
            const text = box(false, {x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'notchy-result-text'});
            text.add_child(label(confirming ? `${item.confirm} ↵ zum Bestätigen` : item.title, 'notchy-result-title', {y_align: Clutter.ActorAlign.CENTER}));
            const sub = isAction ? item.shortcut ?? '' : confirming ? 'Esc bricht ab' : item.subtitle ?? '';
            if (sub) text.add_child(label(sub, 'notchy-result-subtitle', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            actor.add_child(text);
            if (!isAction) actor.add_child(label(item.kind, 'notchy-result-kind', {y_align: Clutter.ActorAlign.CENTER}));
            const b = new St.Button({child: actor, x_expand: true, x_align: Clutter.ActorAlign.FILL, can_focus: false, track_hover: true, reactive: true,
                accessible_name: isAction ? item.title : `${item.title} · ${item.kind}`});
            b.connect('clicked', () => activate(index));
            b.connect('notify::hover', () => { if (b.hover && state.selected !== index) { state.selected = index; state.moved = true; drawSelection(); } });
            // A right click on a result opens its actions.
            b.connect('button-press-event', (_b, event) => {
                if (event.get_button() !== Clutter.BUTTON_SECONDARY || isAction) return Clutter.EVENT_PROPAGATE;
                state.selected = index; togglePanel(); return Clutter.EVENT_STOP;
            });
            b.notchyIndex = index;
            return b;
        };
        const drawSelection = () => {
            for (const child of list.get_children()) {
                if (child.notchyIndex === undefined) continue;
                const inner = child.get_child();
                child.notchyIndex === state.selected ? inner.add_style_class_name('selected') : inner.remove_style_class_name('selected');
            }
            drawFooter(); keepVisible();
        };
        const keepVisible = () => this.pageLife.later(0, () => {
            const target = list.get_children().find(child => child.notchyIndex === state.selected), adjust = view.vadjustment;
            if (!target || !adjust) return;
            if (target.y < adjust.value) adjust.value = target.y;
            else if (target.y + target.height > adjust.value + adjust.page_size) adjust.value = target.y + target.height - adjust.page_size;
        });
        const drawFooter = () => {
            const items = current(), item = items[state.selected];
            if (state.panel) hint.text = `↵ ausführen · Esc zurück`;
            else if (item) {
                const confirming = state.confirm === item.id;
                hint.text = confirming ? '↵ bestätigen · Esc abbrechen' : `↵ ${item.actions[0]?.title ?? 'Öffnen'}${item.actions.length > 1 ? ' · Strg+K Aktionen' : ''}`;
            } else hint.text = '';
            const query = entry.get_text().trim();
            status.text = state.panel ? state.panel.result.title
                : state.drill ? 'Indizierte Ordner · Esc zurück'
                : state.pending ? 'Suche Dateien …'
                : state.mode === 'files' && query ? `Nur Dateien und Ordner · ${state.results.length} Treffer`
                : state.backend === 'fallback' && query ? 'Dateiindex nicht aktiv · einfache Suche in persönlichen Ordnern'
                : !this.settings.get_boolean('launcher-file-search') && query ? 'Dateisuche ist ausgeschaltet'
                : state.empty ? 'Thunderstorm' : `${state.results.length} ${state.results.length === 1 ? 'Treffer' : 'Treffer'}`;
        };
        const draw = () => {
            list.destroy_all_children();
            const items = current();
            state.selected = Math.max(0, Math.min(state.selected, items.length - 1));
            let rows = 0, headers = 0, section = null;
            if (state.panel) { list.add_child(label(`Aktionen · ${state.panel.result.title}`, 'notchy-results-section')); headers++; }
            items.forEach((item, index) => {
                if (!state.panel && item.section && item.section !== section) { section = item.section; list.add_child(label(section, 'notchy-results-section')); headers++; }
                list.add_child(row(item, index, index === state.selected)); rows++;
            });
            // The list's own height, up to VISIBLE rows (and its headers) and the
            // screen; beyond that it scrolls. A constraint, not a measurement: the
            // rows just built may not be on the stage or styled yet, and the
            // island measures the whole page once they are (Island.resize).
            view.visible = rows > 0;
            const room = island.monitor.height - island.topInset - 24 - SEARCH_CHROME;
            view.set_style(`max-height: ${Math.max(ROW, Math.min(room, VISIBLE * ROW + Math.min(headers, 3) * HEADER))}px;`);
            footer.visible = rows > 0 || state.pending || Boolean(entry.get_text().trim());
            drawFooter(); keepVisible();
            this.pageLife.later(0, () => island.resize());
        };
        const update = () => { state.panel = null; state.confirm = null; state.drill = null; state.fresh = true; session.query(entry.get_text()); };
        entry.clutter_text.connect('text-changed', update);
        entry.clutter_text.connect('key-press-event', (_t, event) => {
            const key = event.get_key_symbol(), mods = event.get_state(), ctrl = Boolean(mods & Clutter.ModifierType.CONTROL_MASK), shift = Boolean(mods & Clutter.ModifierType.SHIFT_MASK);
            const items = current();
            const step = delta => { state.selected = Math.max(0, Math.min(items.length - 1, state.selected + delta)); state.confirm = null; state.moved = true; drawSelection(); };
            if (key === Clutter.KEY_Down) { step(1); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Up) { step(-1); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Page_Down) { step(VISIBLE); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Page_Up) { step(-VISIBLE); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) { activate(state.selected, ctrl && !state.panel); return Clutter.EVENT_STOP; }
            if (ctrl && (key === Clutter.KEY_k || key === Clutter.KEY_K)) { togglePanel(); return Clutter.EVENT_STOP; }
            if (ctrl && shift && (key === Clutter.KEY_c || key === Clutter.KEY_C)) {
                const result = state.results[state.selected], action = result?.actions.find(a => a.title === 'Pfad kopieren');
                if (action) run(result, action); return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Escape) {
                // Esc steps back: confirmation, action panel, drill-down, then closes.
                if (state.confirm) { state.confirm = null; draw(); }
                else if (state.panel) togglePanel();
                else if (state.drill) update();
                else island.close();
                return Clutter.EVENT_STOP;
            }
            if (state.confirm && ![Clutter.KEY_Shift_L, Clutter.KEY_Shift_R, Clutter.KEY_Control_L, Clutter.KEY_Control_R].includes(key)) { state.confirm = null; draw(); }
            return Clutter.EVENT_PROPAGATE;
        });
        state.fresh = true; session.query('');
        return root;
    }
    // AirDrop, sending: a radar while the phone is searched for, then the
    // phone it found, a ring while the file goes over, a check at the end.
    airdropSendView() {
        const airdrop = this.airdrop, life = new Lifetime();
        const root = box(false, {style_class: 'notchy-peek notchy-airdrop'});
        const radar = new St.Widget({style_class: 'notchy-airdrop-radar', layout_manager: new Clutter.BinLayout(), width: RADAR, height: RADAR, y_align: Clutter.ActorAlign.CENTER});
        // Three rings leave the centre one after another, like AirDrop's own search.
        const rings = [0, 1, 2].map(i => {
            const ring = new St.Widget({style_class: 'notchy-airdrop-ring', width: RADAR, height: RADAR, opacity: 0, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
            radar.add_child(ring); return [ring, i];
        });
        const core = new St.Bin({style_class: 'notchy-airdrop-core', width: 46, height: 46, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const coreIcon = new St.Icon({icon_size: 22}); core.set_child(coreIcon); radar.add_child(core);
        root.add_child(radar);
        const text = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'notchy-airdrop-text-column'});
        const meta = label('AirDrop', 'notchy-peek-app');
        const title = label('', 'notchy-peek-title'), status = label('', 'notchy-peek-body'), hint = label('', 'notchy-airdrop-hint');
        for (const actor of [status, hint]) { actor.clutter_text.set_line_wrap(true); actor.clutter_text.ellipsize = 0; }
        for (const actor of [meta, title, status, hint]) text.add_child(actor);
        root.add_child(text);
        const cancel = button('window-close-symbolic', 'Senden abbrechen', () => airdrop.cancelSend(), 'notchy-round-button small');
        cancel.y_align = Clutter.ActorAlign.START; root.add_child(cancel);
        // Clutter skips animations of actors not yet shown, so the radar starts once mapped.
        let pulsing = false, wanted = false;
        // The rings map after their parent, so wait for the rings themselves.
        const lastRing = rings.at(-1)[0];
        lastRing.connect('notify::mapped', () => { if (lastRing.mapped && wanted && !pulsing) pulse(true); });
        const pulse = on => {
            wanted = on;
            if (on && !lastRing.mapped) return;
            if (on === pulsing) return; pulsing = on;
            for (const [ring, i] of rings) {
                ring.remove_all_transitions(); ring.scale_x = ring.scale_y = 0.45; ring.opacity = on ? 210 : 0;
                // Each ring grows and fades, over and over; the delays stagger them once.
                if (on) ring.ease({opacity: 0, scale_x: 1, scale_y: 1, duration: 1800, delay: i * 600, repeatCount: -1, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        };
        const draw = () => {
            const send = airdrop.send; if (!send) return;
            const files = send.files.length === 1 ? send.files[0] : `${send.files.length} Dateien`;
            title.text = files;
            const phase = send.phase;
            root.set_style_class_name(`notchy-peek notchy-airdrop ${phase}`);
            coreIcon.gicon = gicon(phase === 'done' ? 'object-select-symbolic' : phase === 'failed' ? 'dialog-warning-symbolic' : phase === 'searching' || phase === 'cancelled' ? 'notchy-airdrop-symbolic' : 'phone-symbolic');
            status.text = {searching: 'Sucht iPhones in der Nähe …', waiting: `An ${send.peer} · auf dem iPhone annehmen`, sending: `An ${send.peer} · wird gesendet …`,
                done: send.peer ? `An ${send.peer} gesendet` : 'Gesendet', failed: send.error || 'Senden fehlgeschlagen', cancelled: 'Abgebrochen'}[phase] ?? '';
            hint.text = phase === 'searching' ? 'iPhone: AirDrop „Für alle“, Teilen-Menü zu' : ['waiting', 'sending'].includes(phase) ? 'WLAN ist während AirDrop pausiert' : '';
            hint.visible = Boolean(hint.text);
            cancel.visible = ['searching', 'waiting', 'sending'].includes(phase);
            pulse(['searching', 'waiting', 'sending'].includes(phase));
            // Settled: show the outcome briefly, then fold the notch away.
            if (!cancel.visible && !life.closeTimer) life.closeTimer = life.later(phase === 'failed' ? 6000 : 2200, () => { if (this.island.peekKind === 'airdrop') this.island.close(); });
        };
        life.cleanups.push(airdrop.subscribe(draw)); draw();
        root.connect('destroy', () => { pulse(false); life.dispose(); });
        return {actor: root};
    }
    // AirDrop, receiving: who sends what, and „Annehmen“ before the time runs out.
    airdropAskView(question) {
        const root = box(false, {style_class: 'notchy-peek notchy-airdrop notchy-airdrop-ask'});
        const badge = new St.Bin({style_class: 'notchy-airdrop-core', width: 46, height: 46, y_align: Clutter.ActorAlign.START, child: icon('notchy-airdrop-symbolic', 22)});
        root.add_child(badge);
        const column = box(true, {x_expand: true});
        const meta = box(false, {style_class: 'notchy-peek-meta'});
        meta.add_child(label('AirDrop', 'notchy-peek-app', {x_expand: true}));
        const left = label('', 'notchy-peek-app'); meta.add_child(left);
        column.add_child(meta);
        column.add_child(label(question.sender || 'Ein Gerät in der Nähe', 'notchy-peek-title'));
        const what = question.files ? `möchte „${question.files}“ senden` : 'möchte etwas senden';
        const body = label(what, 'notchy-peek-body'); body.clutter_text.set_line_wrap(true); body.clutter_text.ellipsize = 0; column.add_child(body);
        const actions = box(false, {style_class: 'notchy-peek-actions'});
        actions.add_child(textButton('Ablehnen', () => question.answer(false), 'notchy-pill-button'));
        const accept = textButton('Annehmen', () => question.answer(true), 'notchy-pill-button notchy-accept');
        actions.add_child(accept); column.add_child(actions);
        // The backend declines on its own once this runs out.
        const track = new St.Widget({style_class: 'notchy-airdrop-timeout', x_expand: true});
        const fill = new St.Widget({style_class: 'notchy-airdrop-timeout-fill'}); track.add_child(fill); column.add_child(track);
        root.add_child(column);
        const tick = () => {
            if (!track.mapped) return;
            const remaining = Math.max(0, question.timeout - (GLib.get_monotonic_time() - question.asked) / 1000);
            left.text = `${Math.ceil(remaining / 1000)} s`;
            fill.width = Math.round(track.width * remaining / question.timeout);
        };
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => { tick(); return GLib.SOURCE_CONTINUE; });
        root.connect('destroy', () => GLib.source_remove(id));
        track.connect('notify::width', tick); tick();
        this.island.actor.grab_key_focus();
        this.keyPress = event => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) { question.answer(true); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Escape) { question.answer(false); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        };
        return {actor: root, accept};
    }
    notificationView(notification, done) {
        // One notification as a banner: app icon, app · time, title, body and its actions.
        const root = box(false, {style_class: 'notchy-peek notchy-peek-notification'});
        const badge = new St.Icon({icon_name: 'preferences-system-notifications-symbolic', icon_size: 36, style_class: 'notchy-peek-app-icon', y_align: Clutter.ActorAlign.START});
        const gicon = notification.gicon ?? notification.source?.icon; if (gicon) badge.gicon = gicon;
        root.add_child(badge);
        const column = box(true, {x_expand: true});
        const text = box(true, {x_expand: true});
        const meta = box(false, {style_class: 'notchy-peek-meta'});
        meta.add_child(label(notification.source?.title || 'Benachrichtigung', 'notchy-peek-app', {x_expand: true}));
        if (notification.datetime) meta.add_child(label(formatTimeSpan(notification.datetime), 'notchy-peek-app'));
        text.add_child(meta);
        if (notification.title) text.add_child(label(notification.title, 'notchy-peek-title'));
        const body = (notification.body || '').replace(notification.useBodyMarkup ? /<[^>]*>/g : /$^/, '').replace(/\s+/g, ' ').trim();
        if (body) text.add_child(label(body, 'notchy-peek-body'));
        const open = new St.Button({child: text, x_expand: true, can_focus: true, style_class: 'notchy-peek-open', accessible_name: `Öffnen: ${notification.title || ''}`});
        open.connect('clicked', () => { done(); notification.activate(); });
        column.add_child(open);
        if (notification.actions?.length) {
            const actions = box(false, {style_class: 'notchy-peek-actions'});
            for (const action of notification.actions.slice(0, 3)) actions.add_child(textButton(action.label, () => { done(); action.activate(); }, 'notchy-pill-button'));
            column.add_child(actions);
        }
        root.add_child(column);
        const hide = button('window-close-symbolic', 'Banner ausblenden', done, 'notchy-round-button small'); hide.y_align = Clutter.ActorAlign.START;
        root.add_child(hide);
        // Dismissed elsewhere (e.g. by its app): fold the banner away too.
        const id = notification.connect('destroy', () => done());
        root.connect('destroy', () => { try { notification.disconnect(id); } catch { /* Already disposed. */ } });
        return {actor: root};
    }
    dispose() { this.pageLife?.dispose(); this.life.dispose(); this.menu?.destroy(); }
}
