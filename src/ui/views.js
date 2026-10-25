import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Cairo from 'cairo';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {formatTimeSpan} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {box, label, icon, gicon, button, textButton, emptyState, scroll, time} from './widgets.js';
import {relativeTime, isoWeek, weekDays, groupBy, SNAP_LAYOUTS, zoneRect, clipTitle} from '../model.js';
import {launchUri} from '../launcher/providers.js';
import {kindLabel, sectionLabel} from '../launcher/logic.js';
import {_, N_, fmt, ngettext, formatPercent, formatDate, formatTime} from '../i18n/core.js';
import {ageText} from '../services/batteries.js';
import {Waveform} from './waveform.js';
import {Lifetime} from '../lifecycle.js';
import {connectKeyPress} from '../compat/index.js';

// A file's kind: the colour of its type label (as in helper/tray.py).
const KIND = Object.fromEntries([
    ['pdf', 'pdf'], ...['md', 'txt', 'json', 'csv', 'log'].map(e => [e, 'text']), ...['zip', 'gz', 'tar', 'xz', '7z', 'rar'].map(e => [e, 'archive']),
    ...['mp4', 'mkv', 'webm', 'mov', 'avi'].map(e => [e, 'video']), ...['mp3', 'flac', 'ogg', 'wav', 'm4a', 'opus'].map(e => [e, 'audio']),
    ...['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'].map(e => [e, 'doc']),
    ...['png', 'jpg', 'jpeg', 'webp', 'heic', 'tiff', 'bmp', 'gif', 'svg'].map(e => [e, 'image'])]);
// The clipboard: its list's height, an entry's kind as a tile, its day.
const CLIP_HEIGHT = 238;
const CLIP_KIND = {text: N_('Text'), link: N_('Link'), image: N_('Picture'), color: N_('Color'), files: N_('Files')};
const clipKindName = item => _(CLIP_KIND[item.kind] ?? CLIP_KIND.text);
function clipTile(item) {
    const tile = new St.Bin({style_class: `notchy-clip-icon ${item.kind}`, y_align: Clutter.ActorAlign.CENTER});
    if (item.kind === 'color') tile.style = `background-color: ${normalHex(item.text.trim())};`;
    else if (item.kind === 'image' && item.asset) tile.style = `background-image: url("${item.asset.replace(/["\\]/g, '\\$&')}");`;
    else tile.set_child(icon(CLIP_ICON[item.kind] ?? CLIP_ICON.text, 14));
    return tile;
}
function dayHeading(created) {
    const day = new Date(created); day.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((today - day) / 86400000);
    return days <= 0 ? _('Today') : days === 1 ? _('Yesterday') : formatDate(day, {weekday: 'long', day: 'numeric', month: 'long'});
}
function clipSize(item) {
    if (item.kind === 'image' && item.asset) {
        try { const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(item.asset); if (width) return `${width} × ${height}`; } catch { /* Unreadable: no size. */ }
        return '';
    }
    if (item.kind === 'text') return fmt(ngettext('%d character', '%d characters', item.text.length), item.text.length);
    return '';
}
// #abc and #aabbcc, upper case, six digits.
const normalHex = text => (/^#[0-9a-f]{3}$/i.test(text) ? `#${[...text.slice(1)].map(c => c + c).join('')}` : text).toUpperCase();
function colorFormats(hex) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    const [rf, gf, bf] = [r / 255, g / 255, b / 255], max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf), l = (max + min) / 2;
    let h = 0, sat = 0;
    if (max !== min) {
        const d = max - min; sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        h = max === rf ? (gf - bf) / d + (gf < bf ? 6 : 0) : max === gf ? (bf - rf) / d + 2 : (rf - gf) / d + 4; h *= 60;
    }
    return [['HEX', hex], ['RGB', `${r}, ${g}, ${b}`], ['HSL', `${Math.round(h)}°, ${Math.round(sat * 100)} %, ${Math.round(l * 100)} %`]];
}
// The AirPods card: its product picture and the size of its battery rings.
const AIRPODS_HERO = [128, 140], CARD_RING = 64;
// The stage the arriving files drop onto (Views.shelfArrivalView).
const ARRIVAL_STAGE = [104, 58];
// The Regal's tiles: six a row (five on a narrow island), as in helper/tray.py.
const shelfColumns = width => (width >= 680 ? 6 : 5);
export const extensionOf = name => (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
const CLIP_ICON = {text: 'text-x-generic-symbolic', link: 'web-browser-symbolic', color: 'applications-graphics-symbolic', image: 'image-x-generic-symbolic', files: 'folder-symbolic'};
const FILTERS = [['all', 'view-list-symbolic', N_('All')], ['link', 'insert-link-symbolic', N_('Links')], ['image', 'image-x-generic-symbolic', N_('Pictures')], ['fav', 'starred-symbolic', N_('Favorites Only')]];

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
// The media tab's cover, as tall as the page allows.
const COVER = 236;
// Bar heights of the resting waveform shown while nothing plays.
const QUIET_LINE = [4, 4, 4, 5, 4, 6, 4, 4, 5, 8, 5, 4, 4, 6, 4, 4, 5, 4, 7, 4, 4, 5, 4, 4, 6, 4, 4, 4];
// Height of the calendar tab's two scrolling lists.
const CAL_LIST_HEIGHT = 196;
// AirPods noise control: symbol and name per mode.
export const ANC_ICON = {noise: 'notchy-anc-symbolic', transparency: 'notchy-transparency-symbolic', adaptive: 'notchy-adaptive-symbolic', off: 'notchy-anc-off-symbolic'};
const ANC_NAME = {noise: N_('Noise Cancellation'), transparency: N_('Transparency'), adaptive: N_('Adaptive'), off: N_('Noise Control Off')};
export const ancName = mode => (ANC_NAME[mode] ? _(ANC_NAME[mode]) : '');
// The batteries an AirPods model reports: both buds and the case, or one (AirPods Max).
export function airpodsParts(state) {
    if (state.battery.single !== null || state.headphones || state.backend === 'bluez') return [{key: 'single', short: '', name: _('Battery'), icon: 'notchy-airpods-symbolic'}];
    // Translators: L and R are the left and the right AirPod.
    return [{key: 'left', short: _('L'), name: _('Left')}, {key: 'right', short: _('R'), name: _('Right')}, {key: 'case', short: '', name: _('Case'), icon: 'notchy-airpods-case-symbolic'}];
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
export function productCell(kind, caption, SIZE = 84) {
    const actor = box(true, {style_class: 'notchy-airpods-cell'});
    const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), width: SIZE, height: SIZE, x_align: Clutter.ActorAlign.CENTER});
    const ring = new St.DrawingArea({width: SIZE, height: SIZE});
    const picture = new St.DrawingArea({width: Math.round(SIZE * 2 / 3), height: Math.round(SIZE * 2 / 3), x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
    stack.add_child(ring); stack.add_child(picture);
    const value = label('–', 'notchy-airpods-card-value', {x_align: Clutter.ActorAlign.CENTER});
    const captionLabel = label(caption, 'notchy-airpods-card-caption', {x_align: Clutter.ActorAlign.CENTER});
    actor.add_child(stack); actor.add_child(value); actor.add_child(captionLabel);
    // `stale`: the last valid reading ({level, at}) while the part reports none now.
    const cell = {actor, kind, caption, level: null, charging: false, low: false, stale: null, progress: 0, timeline: null};
    picture.connect('repaint', () => { const cr = picture.get_context(); drawProduct(cr, kind, picture.get_surface_size()[0]); cr.$dispose(); });
    ring.connect('repaint', () => {
        const cr = ring.get_context(), [w, h] = ring.get_surface_size(), r = Math.min(w, h) / 2 - 3;
        cr.setLineWidth(Math.max(3, SIZE / 21)); cr.setSourceRGBA(1, 1, 1, 0.13); cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI); cr.stroke();
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
        value.text = cell.level !== null ? `${cell.charging ? '⚡ ' : ''}${formatPercent(Math.round(cell.level * cell.progress))}` : stale ? formatPercent(cell.stale.level) : '–';
        stale ? value.add_style_class_name('stale') : value.remove_style_class_name('stale');
        const words = stale ? `${cell.caption} · ${cell.stale.at ? ageText(cell.stale.at) : _('last known')}` : cell.caption;
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
        const reading = level !== null ? formatPercent(level) : cell.stale ? fmt(_('last %1$s, %2$s'), formatPercent(cell.stale.level), ageText(cell.stale.at)) : _('unknown');
        actor.accessible_name = charging ? fmt(_('%1$s: %2$s, charging'), cell.caption, reading) : `${cell.caption}: ${reading}`;
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

    // Medien: a large cover beside the track — title and artist, waveform,
    // timeline, transport, and where it plays with the playing app below.
    mediaView() {
        const state = this.settings.get_boolean('media-enabled') ? this.media.state : null;
        this.outputs.ensure();
        if (this.outputPicker) return this.outputsView(box(true, {style_class: 'notchy-page notchy-media', y_expand: true}));
        if (!state) return this.quietView();
        const root = box(false, {style_class: 'notchy-page notchy-media', y_expand: true});
        // The cover fills the page's height; a click brings the playing app forward.
        const cover = new St.Bin({style_class: 'notchy-cover', width: COVER, height: COVER});
        const coverPath = this.cover.file?.get_path();
        if (coverPath) cover.style = `background-image: url("${coverPath.replace(/["\\]/g, '\\$&')}");`;
        else cover.child = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 72, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const coverButton = new St.Button({child: cover, can_focus: true, accessible_name: _('Open the playing app'), y_align: Clutter.ActorAlign.START, style_class: 'notchy-cover-button'});
        coverButton.connect('clicked', () => this.media.raise()); root.add_child(coverButton);
        const side = box(true, {style_class: 'notchy-media-side', x_expand: true, height: COVER, y_align: Clutter.ActorAlign.START});
        const top = box(false, {style_class: 'notchy-media-top'});
        const names = box(true, {x_expand: true});
        names.add_child(label(state.playing ? _('Now Playing') : _('Paused'), 'notchy-media-status'));
        names.add_child(label(state.title, 'notchy-track'));
        names.add_child(label(state.artist || state.album || state.name, 'notchy-artist'));
        top.add_child(names);
        if (state.playing && this.settings.get_boolean('media-waveform')) { const wave = new Waveform(this.spectrum, 40, 28); wave.y_align = Clutter.ActorAlign.START; top.add_child(wave); }
        side.add_child(top); side.add_child(new St.Widget({y_expand: true}));
        // The timeline: the bar across the column, the times beneath its ends.
        const timeline = box(true, {style_class: 'notchy-timeline'});
        const seek = new Slider(state.length ? Math.min(1, this.media.elapsed / state.length) : 0);
        seek.reactive = state.canSeek; seek.add_style_class_name('notchy-seek'); seek.x_expand = true;
        seek.connect('drag-end', () => this.media.seek(seek.value));
        const times = box(false), elapsed = label(time(this.media.elapsed), 'notchy-time', {x_expand: true});
        const remaining = label(`−${time(Math.max(0, state.length - this.media.elapsed))}`, 'notchy-time notchy-time-end');
        times.add_child(elapsed); times.add_child(remaining);
        timeline.add_child(seek); timeline.add_child(times); side.add_child(timeline);
        this.pageLife.every(1000, () => { if (!seek._dragging) {
            seek.value = state.length ? Math.min(1, this.media.elapsed / state.length) : 0;
            elapsed.text = time(this.media.elapsed); remaining.text = `−${time(Math.max(0, state.length - this.media.elapsed))}`;
        }});
        side.add_child(new St.Widget({y_expand: true}));
        const controls = box(false, {style_class: 'notchy-controls', x_align: Clutter.ActorAlign.CENTER});
        const prev = button('notchy-backward-symbolic', _('Previous Track'), () => this.media.call('Previous'), 'notchy-transport'); prev.reactive = state.canPrevious; controls.add_child(prev);
        const play = button(state.playing ? 'notchy-pause-symbolic' : 'notchy-play-symbolic', state.playing ? _('Pause') : _('Play'), () => this.media.call('PlayPause'), 'notchy-play');
        controls.add_child(play);
        const next = button('notchy-forward-symbolic', _('Next Track'), () => this.media.call('Next'), 'notchy-transport'); next.reactive = state.canNext; controls.add_child(next);
        side.add_child(controls); side.add_child(new St.Widget({y_expand: true}));
        // Where the music plays (this computer or an AirPlay receiver) and the playing app.
        const foot = box(false, {style_class: 'notchy-media-foot'});
        foot.add_child(this.outputButton()); foot.add_child(new St.Widget({x_expand: true}));
        const app = state.desktopEntry ? Shell.AppSystem.get_default().lookup_app(`${state.desktopEntry}.desktop`) : null;
        const sourceRow = box(false, {style_class: 'notchy-source-row'});
        const sourceIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 20, y_align: Clutter.ActorAlign.CENTER}); if (app) sourceIcon.gicon = app.get_icon();
        sourceRow.add_child(sourceIcon); sourceRow.add_child(label(shorten(app?.get_name() || state.name, 18), 'notchy-source-name', {y_align: Clutter.ActorAlign.CENTER}));
        const source = new St.Button({style_class: 'notchy-source', child: sourceRow, can_focus: true, accessible_name: fmt(_('Open %s'), state.name), y_align: Clutter.ActorAlign.CENTER});
        source.connect('clicked', () => this.media.raise()); foot.add_child(source);
        side.add_child(foot);
        root.add_child(side);
        return root;
    }

    // Nothing playing: a resting waveform, one calm line, the music app to
    // start and where it will play.
    quietView() {
        const root = box(true, {style_class: 'notchy-page notchy-quiet', y_expand: true});
        const body = box(true, {x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const line = box(false, {style_class: 'notchy-quiet-line', x_align: Clutter.ActorAlign.CENTER});
        for (const height of QUIET_LINE) line.add_child(new St.Widget({style_class: 'notchy-quiet-bar', width: 4, height, y_align: Clutter.ActorAlign.CENTER}));
        body.add_child(line);
        body.add_child(label(_('All Quiet'), 'notchy-quiet-title', {x_align: Clutter.ActorAlign.CENTER}));
        const actions = box(false, {style_class: 'notchy-quiet-actions', x_align: Clutter.ActorAlign.CENTER});
        // The music app is whatever opens an MP3 here.
        const player = Gio.AppInfo.get_default_for_type('audio/mpeg', false);
        const app = player?.get_id() ? Shell.AppSystem.get_default().lookup_app(player.get_id()) : null;
        if (app) {
            const row = box(false, {style_class: 'notchy-quiet-open-row'});
            row.add_child(new St.Icon({gicon: app.get_icon(), icon_size: 18, y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(label(fmt(_('Open %s'), shorten(app.get_name(), 24)), '', {y_align: Clutter.ActorAlign.CENTER}));
            const open = new St.Button({style_class: 'notchy-quiet-open', child: row, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
            open.connect('clicked', () => app.activate()); actions.add_child(open);
        }
        const output = this.outputButton(); output.add_style_class_name('large'); actions.add_child(output);
        body.add_child(actions); root.add_child(body);
        return root;
    }

    // The output button: where the music plays; a click opens the list.
    outputButton() {
        const outputIcon = new St.Icon({icon_size: 15}), outputName = label('', 'notchy-output-name', {y_align: Clutter.ActorAlign.CENTER});
        const outputRow = box(false, {style_class: 'notchy-output-row'});
        outputRow.add_child(outputIcon); outputRow.add_child(outputName); outputRow.add_child(icon('pan-down-symbolic', 12));
        const output = new St.Button({style_class: 'notchy-output-button', child: outputRow, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        output.connect('clicked', () => { this.outputPicker = true; this.island.refresh(); });
        const drawOutput = () => {
            const active = this.outputs.active;
            outputIcon.gicon = outputGicon(active); outputName.text = shorten(active?.name ?? _('No Output'), 28);
            output.accessible_name = fmt(_('Output: %s. Switch to AirPlay or another device'), outputName.text);
            active?.airplay ? output.add_style_class_name('airplay') : output.remove_style_class_name('airplay');
        };
        this.pageLife.cleanups.push(this.outputs.subscribe(drawOutput)); drawOutput();
        return output;
    }

    // AirPods connected: the capsule grows into a card as on an iPhone — the
    // name, the AirPods and their case springing in, battery rings filling up
    // with the percentages counting, and „Verbunden“ with a check.
    // AirPods connected, as an iPhone shows it: the notch springs open into a
    // card. The AirPods and their case float in large on the left, turning and
    // overshooting, a glint passes over them; beside them the name, „Verbunden“
    // with a check, and the battery rings filling with the numbers counting up.
    airpodsPeekView() {
        const airpods = this.airpods, root = box(false, {style_class: 'notchy-peek notchy-airpods-card'});
        const hero = this.airpodsHero(airpods.state);
        root.add_child(hero.actor);
        const column = box(true, {style_class: 'notchy-airpods-card-column', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        root.add_child(column);
        const head = box(true, {style_class: 'notchy-airpods-card-head'});
        const title = label('', 'notchy-airpods-card-title', {y_align: Clutter.ActorAlign.CENTER});
        const status = box(false, {style_class: 'notchy-airpods-card-status', x_align: Clutter.ActorAlign.START, opacity: 0, pivot_point: new Graphene.Point({x: 0, y: 0.5})});
        status.add_child(new St.Icon({icon_name: 'object-select-symbolic', icon_size: 13, style_class: 'notchy-airpods-card-check', y_align: Clutter.ActorAlign.CENTER}));
        const statusText = label(_('Connected'), 'notchy-airpods-card-status-text', {y_align: Clutter.ActorAlign.CENTER});
        status.add_child(statusText);
        head.add_child(title); head.add_child(status); column.add_child(head);
        const products = box(false, {style_class: 'notchy-airpods-products', x_align: Clutter.ActorAlign.START});
        column.add_child(products);
        const threshold = this.settings.get_int('airpods-battery-threshold');
        let cells = new Map(), layout = '';
        // Both buds in one ring while they are within 10 %, as the iPhone does; else one each.
        const parts = state => {
            const {left, right, single} = state.battery;
            if (state.headphones || state.backend === 'bluez' || single !== null) return [['single', state.headphones ? 'headphones' : 'buds', state.headphones ? _('Battery') : 'AirPods']];
            const together = left === null || right === null ? left === right : Math.abs(left - right) <= 10;
            return [...(together ? [['buds', 'buds', 'AirPods']] : [['left', 'left', _('Left')], ['right', 'right', _('Right')]]), ['case', 'case', _('Case')]];
        };
        const animate = () => {
            hero.play();
            let delay = 120;
            for (const cell of cells.values()) { cell.appear(delay); delay += 130; }
            status.ease({opacity: 255, scale_x: 1, scale_y: 1, delay: 550, duration: 420, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        };
        const draw = () => {
            const state = airpods.state; if (!state) return;
            title.text = state.name;
            statusText.text = state.connected ? (state.anc ? fmt(_('Connected · %s'), ancName(state.anc)) : _('Connected')) : _('Disconnected');
            const wanted = parts(state), key = wanted.map(([k]) => k).join('|');
            if (key !== layout) {
                const shown = layout !== '';
                layout = key;
                for (const cell of cells.values()) cell.stop();
                products.destroy_all_children(); cells = new Map();
                for (const [partKey, kind, caption] of wanted) { const cell = productCell(kind, caption, CARD_RING); cells.set(partKey, cell); products.add_child(cell.actor); }
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
        // GNOME skips the easing of actors not on screen: the show starts a
        // tick after the card is mapped (its children map after it).
        const mappedId = products.connect('notify::mapped', () => this.life.later(0, start)); start();
        root.connect('destroy', () => { unsubscribe(); products.disconnect(mappedId); hero.stop(); for (const cell of cells.values()) cell.stop(); });
        return {actor: root, hero, get cells() { return cells; }};
    }
    // The product, large: the case below, the buds above it (or headphones).
    // It flies in turned and too large, overshoots and settles, then floats
    // gently; a glint passes over it once.
    airpodsHero(state) {
        const [W, H] = AIRPODS_HERO, center = new Graphene.Point({x: 0.5, y: 0.5});
        const actor = new St.Widget({style_class: 'notchy-airpods-hero', width: W, height: H, clip_to_allocation: true, y_align: Clutter.ActorAlign.CENTER});
        const body = new St.Widget({width: W, height: H, pivot_point: center, opacity: 0, scale_x: 0.5, scale_y: 0.5, rotation_angle_z: -16});
        actor.add_child(body);
        const piece = (kind, size, x, y) => {
            const area = new St.DrawingArea({width: size, height: size, x, y});
            area.connect('repaint', () => { const cr = area.get_context(); drawProduct(cr, kind, area.get_surface_size()[0]); cr.$dispose(); });
            body.add_child(area);
        };
        if (state?.headphones) piece('headphones', 112, (W - 112) / 2, (H - 112) / 2);
        else { piece('case', 96, (W - 96) / 2, H - 100); piece('buds', 86, (W - 86) / 2, 2); }
        // The glint: a soft bright band, turned, sweeping across once.
        const glint = new St.Widget({style_class: 'notchy-airpods-glint', width: 34, height: H * 1.6, x: -60, y: -H * 0.3, rotation_angle_z: 18, opacity: 0});
        actor.add_child(glint);
        let floating = 0, kick = 0;
        const stop = () => { this.life.cancel(floating); this.life.cancel(kick); floating = kick = 0; };
        const play = () => {
            body.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            body.ease({scale_x: 1, scale_y: 1, rotation_angle_z: 0, duration: 720, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            glint.opacity = 200;
            glint.ease({x: W + 40, duration: 760, delay: 520, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD, onComplete: () => { glint.opacity = 0; }});
            // Floating: up and down, turning a little, until the card folds.
            let up = true;
            const sway = () => {
                body.ease({translation_y: up ? -4 : 0, rotation_angle_z: up ? 2 : -2, duration: 1600, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
                up = !up;
            };
            kick = this.life.later(760, () => { kick = 0; sway(); floating = this.life.every(1600, sway); });
        };
        return {actor, body, play, stop};
    }

    // Snap layouts: miniature screens whose zones take the dragged window.
    snapView(window) {
        const actor = box(true, {style_class: 'notchy-snap'});
        const head = box(false, {style_class: 'notchy-snap-head'});
        head.add_child(icon('view-grid-symbolic', 14));
        head.add_child(label(window.get_title() || _('Window'), 'notchy-snap-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        head.add_child(label(_('Release over an area'), 'notchy-cal-meta', {y_align: Clutter.ActorAlign.CENTER}));
        actor.add_child(head);
        const row = box(false, {style_class: 'notchy-snap-row', x_align: Clutter.ActorAlign.CENTER}), zones = [];
        for (const layout of SNAP_LAYOUTS) {
            const tile = new St.Widget({style_class: 'notchy-snap-tile', width: SNAP_TILE[0], height: SNAP_TILE[1], accessible_name: _(layout.name)});
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
        const back = button('go-previous-symbolic', _('Back to the Player'), () => { this.outputPicker = false; this.island.refresh(); }, 'notchy-round-button small');
        back.y_align = Clutter.ActorAlign.CENTER; head.add_child(back);
        head.add_child(label(_('Play Music On'), 'notchy-cal-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
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
            status.text = !airplay ? '' : this.outputs.error || (this.outputs.discovering ? _('AirPlay active') : '');
            for (const output of outputs) {
                const row = box(false, {style_class: 'notchy-output-item-row', x_expand: true});
                const tile = new St.Bin({style_class: `notchy-output-tile${output.airplay ? ' airplay' : ''}`, child: new St.Icon({gicon: outputGicon(output), icon_size: 16})});
                row.add_child(tile);
                const text = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                text.add_child(label(shorten(output.name, 60), 'notchy-output-item-name'));
                text.add_child(label(output.airplay ? 'AirPlay' : _('This Computer'), 'notchy-output-item-sub'));
                row.add_child(text);
                if (output.active) row.add_child(new St.Icon({icon_name: 'object-select-symbolic', icon_size: 16, style_class: 'notchy-output-check', y_align: Clutter.ActorAlign.CENTER}));
                const item = new St.Button({style_class: `notchy-output-item${output.active ? ' active' : ''}`, child: row, x_expand: true, can_focus: true, accessible_name: `${output.name}${output.airplay ? ' (AirPlay)' : ''}`});
                item.connect('clicked', () => {
                    this.outputs.select(output);
                    this.island.toast(output.airplay ? 'notchy-airplay-symbolic' : 'audio-speakers-symbolic', fmt(_('Playing on %s'), output.name));
                    this.outputPicker = false; this.island.refresh();
                });
                list.add_child(item);
            }
            if (!airplay) {
                const find = new St.Button({style_class: 'notchy-output-find', x_expand: true, can_focus: true, accessible_name: _('Find AirPlay Devices')});
                const findRow = box(false, {style_class: 'notchy-output-item-row', x_expand: true});
                findRow.add_child(new St.Bin({style_class: 'notchy-output-tile airplay', child: icon('notchy-airplay-symbolic', 16)}));
                findRow.add_child(label(_('Find AirPlay Devices on the Network'), 'notchy-output-item-name', {y_align: Clutter.ActorAlign.CENTER}));
                find.set_child(findRow); find.connect('clicked', () => this.settings.set_boolean('airplay-enabled', true));
                list.add_child(find);
            } else if (!outputs.some(output => output.airplay)) {
                list.add_child(label(this.outputs.discovering ? _('Looking for AirPlay devices on the network…') : _('No AirPlay devices found.'), 'notchy-output-hint'));
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
    // The Shell's picture of the Regal, shown until its GTK window is mapped
    // (helper/tray.py): the same header, tiles and empty state.
    shelfView() {
        const root = box(true, {style_class: 'notchy-page notchy-shelf-preview', y_expand: true});
        const items = this.shelf.items, center = {y_align: Clutter.ActorAlign.CENTER};
        const head = box(false, {style_class: 'notchy-shelf-head'});
        head.add_child(label(_('Shelf'), 'notchy-shelf-title', center));
        head.add_child(label(fmt(ngettext('%d file', '%d files', items.length), items.length), 'notchy-shelf-count', {x_expand: true, ...center}));
        root.add_child(head);
        if (!items.length) { root.add_child(this.shelfEmpty()); return root; }
        const columns = shelfColumns(this.island.currentWidth);
        const width = Math.floor((this.island.currentWidth - 44 - (columns - 1) * 14) / columns);
        const grid = box(true, {style_class: 'notchy-shelf-grid'});
        for (let i = 0; i < Math.min(items.length, 2 * columns); i += columns) {
            const row = box(false, {style_class: 'notchy-shelf-row'});
            for (const item of items.slice(i, i + columns)) row.add_child(this.fileTile(item, width));
            grid.add_child(row);
        }
        root.add_child(grid);
        return root;
    }
    shelfEmpty() {
        const empty = box(true, {style_class: 'notchy-shelf-empty', x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const stack = new St.Widget({width: 150, height: 84, x_align: Clutter.ActorAlign.CENTER});
        for (const [x, y, w, h, angle, front] of [[14, 14, 58, 64, -9, false], [78, 14, 58, 64, 9, false], [44, 4, 62, 70, 0, true]]) {
            const ghost = new St.Bin({style_class: front ? 'notchy-shelf-ghost front' : 'notchy-shelf-ghost', x, y, width: w, height: h,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}), rotation_angle_z: angle});
            if (front) ghost.child = new St.Icon({gicon: gicon('adwaita:document-save-symbolic'), icon_size: 24});
            stack.add_child(ghost);
        }
        empty.add_child(stack);
        empty.add_child(label(_('The Shelf Is Empty'), 'notchy-shelf-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        empty.add_child(label(_('Drag files onto the notch to keep them close at hand.'), 'notchy-shelf-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));
        return empty;
    }
    fileTile(item, width) {
        const ext = extensionOf(item.name);
        const tile = box(true, {style_class: 'notchy-file-tile', width});
        const card = new St.Widget({style_class: 'notchy-file-card', layout_manager: new Clutter.BinLayout(), height: 76});
        const sheet = new St.Widget({style_class: 'notchy-file-sheet', layout_manager: new Clutter.BinLayout(), width: 40, height: 50, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        // Translators: shown on a file tile without a file name extension.
        sheet.add_child(label(ext.toUpperCase().slice(0, 5) || _('FILE'), `notchy-file-ext ${KIND[ext] ?? 'other'}`, {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END}));
        card.add_child(sheet);
        tile.add_child(card);
        tile.add_child(label(item.name, 'notchy-file-name', {x_align: Clutter.ActorAlign.CENTER}));
        return tile;
    }

    // Files landing in the Regal, in the opened notch: their cards drop in
    // from behind the clock one after another, overshoot and settle in a fan;
    // where the first lands a ring of light spreads and sparks fly apart;
    // „Im Regal“ slides in beside them and the Regal's count rolls up to its
    // new number with a pop. A click opens the Regal.
    shelfArrivalView(arrived, before, total) {
        const life = new Lifetime(), ease = (actor, props) => actor.ease({mode: Clutter.AnimationMode.EASE_OUT_QUAD, ...props});
        const root = new St.Button({style_class: 'notchy-peek notchy-shelf-arrival', can_focus: true, x_expand: true,
            accessible_name: fmt(ngettext('%d file in the Shelf', '%d files in the Shelf', arrived.length), arrived.length)});
        root.connect('clicked', () => this.island.open('shelf'));
        const row = box(false, {style_class: 'notchy-shelf-arrival-row', x_expand: true});
        root.set_child(row);
        const [W, H] = ARRIVAL_STAGE, center = new Graphene.Point({x: 0.5, y: 0.5});
        const stage = new St.Widget({width: W, height: H, y_align: Clutter.ActorAlign.CENTER});
        row.add_child(stage);
        // The light: two rings and a handful of sparks, at the landing point.
        const rings = [0, 1].map(() => new St.Widget({style_class: 'notchy-shelf-arrival-ring', width: 44, height: 44, x: W / 2 - 22, y: H / 2 - 18, opacity: 0, pivot_point: center}));
        const sparks = Array.from({length: 12}, (_s, i) => new St.Widget({style_class: 'notchy-shelf-arrival-spark', width: i % 2 ? 4 : 7, height: i % 2 ? 4 : 7, x: W / 2 - 3, y: H / 2, opacity: 0}));
        for (const actor of [...rings, ...sparks]) stage.add_child(actor);
        const shown = arrived.slice(-3), first = 180, step = 120, landing = 520, cards = [];
        shown.forEach((item, index) => {
            const offset = index - (shown.length - 1) / 2;
            const card = new St.Widget({style_class: 'notchy-shelf-arrival-card', layout_manager: new Clutter.BinLayout(), width: 34, height: 42,
                x: W / 2 - 17 + offset * 16, y: H / 2 - 21 + 2 + Math.abs(offset) * 2, pivot_point: center});
            const path = Gio.File.new_for_uri(item.uri).get_path(), ext = extensionOf(item.name);
            if (path && KIND[ext] === 'image') card.style = `background-image: url("${path.replace(/["\\]/g, '\\$&')}");`;
            else card.add_child(label(ext.toUpperCase().slice(0, 4) || _('FILE'), `notchy-file-ext notchy-shelf-arrival-ext ${KIND[ext] ?? 'other'}`, {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END}));
            // From high above, turned the other way, larger; in it falls.
            card.translation_y = -90; card.opacity = 0; card.scale_x = card.scale_y = 1.4; card.rotation_angle_z = offset * 10 + 30;
            stage.add_child(card); cards.push([card, offset]);
        });
        // „Im Regal“ and what came, sliding in.
        const words = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'notchy-shelf-arrival-words', opacity: 0, translation_x: -16});
        words.add_child(label(_('In the Shelf'), 'notchy-shelf-arrival-title'));
        words.add_child(label(arrived.length === 1 ? arrived[0].name : fmt(ngettext('%d file', '%d files', arrived.length), arrived.length), 'notchy-shelf-arrival-name'));
        row.add_child(words);
        const pill = box(false, {style_class: 'notchy-shelf-pill notchy-shelf-arrival-pill', y_align: Clutter.ActorAlign.CENTER, pivot_point: center});
        pill.add_child(new St.Icon({gicon: gicon('adwaita:package-x-generic-symbolic'), icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
        const count = label(String(before), 'notchy-shelf-pill-count', {y_align: Clutter.ActorAlign.CENTER});
        pill.add_child(count); row.add_child(pill);
        // GNOME skips the easing of an actor not yet on screen: the show
        // starts once the opening notch has mapped the stage and, a tick
        // later, its cards (the stage says so before its children are).
        let played = false;
        const play = () => {
            if (played || !stage.mapped || cards.some(([card]) => !card.mapped)) return;
            played = true;
            cards.forEach(([card, offset], index) => {
                const delay = first + index * step;
                ease(card, {opacity: 255, duration: 160, delay});
                card.ease({translation_y: 0, scale_x: 1, scale_y: 1, rotation_angle_z: offset * 10, duration: landing, delay, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            });
            // A bump of the whole stack as the last card lands.
            const landed = first + (shown.length - 1) * step + landing * 0.62;
            life.later(landed, () => {
                stage.pivot_point = new Graphene.Point({x: 0.5, y: 0.8});
                stage.ease({scale_x: 1.08, scale_y: 0.92, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => stage.ease({scale_x: 1, scale_y: 1, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK})});
            });
            life.later(first + landing * 0.62, () => {
                rings.forEach((ring, i) => {
                    ring.opacity = 230; ring.scale_x = ring.scale_y = 0.5;
                    ease(ring, {scale_x: 2.4, scale_y: 2.4, opacity: 0, duration: 760, delay: i * 170, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
                });
                sparks.forEach((spark, i) => {
                    const angle = (i / sparks.length) * 2 * Math.PI + 0.3, reach = 34 + (i % 3) * 10;
                    spark.opacity = 255;
                    ease(spark, {translation_x: Math.cos(angle) * reach * 1.5, translation_y: Math.sin(angle) * reach, opacity: 0, duration: 700 + (i % 3) * 110, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
                });
            });
            ease(words, {opacity: 255, translation_x: 0, duration: 420, delay: first + 180, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            // The count rolls from what was there to what is there now, then pops.
            const rolls = Math.max(1, total - before), rollStart = first + landing * 0.62;
            for (let i = 1; i <= rolls; i++) {
                life.later(rollStart + (i - 1) * Math.min(110, 480 / rolls), () => {
                    count.text = String(before + Math.round((total - before) * i / rolls));
                    count.translation_y = -6; count.opacity = 120;
                    ease(count, {translation_y: 0, opacity: 255, duration: 140});
                    if (i === rolls) pill.ease({scale_x: 1.35, scale_y: 1.35, duration: 130, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => pill.ease({scale_x: 1, scale_y: 1, duration: 360, mode: Clutter.AnimationMode.EASE_OUT_BACK})});
                });
            }
        };
        const mapped = stage.connect('notify::mapped', () => life.later(0, play));
        root.connect('destroy', () => { stage.disconnect(mapped); life.dispose(); });
        return {actor: root, stage, get played() { return played; }};
    }

    // Ablage: search with filters, a quiet list and one selected row that
    // offers its actions. ↑↓ move, ↵ copies, ⇧↵ copies plain text, F and Entf.
    // Ablage: the history on the left, grouped by day — each entry's kind as a
    // tinted tile (a colour as itself), one line, a star, the time — and the
    // selected entry on the right, shown as what it is: text to read, a link
    // with its site, the picture, a colour with HEX, RGB and HSL to copy, the
    // files. ↑↓ move, ↵ copies, ⇧↵ copies plain text, F and Entf.
    clipboardView() {
        const root = box(true, {style_class: 'notchy-page notchy-clipboard', y_expand: true});
        if (!this.settings.get_boolean('clipboard-enabled')) return this.clipboardPaused(root);
        let filter = 'all', query = '', selected = 0, lastClick = [-1, 0];
        const center = {y_align: Clutter.ActorAlign.CENTER};
        const top = box(false, {style_class: 'notchy-clip-top'});
        const search = new St.Entry({style_class: 'notchy-search-pill', hint_text: _('Search the history'), can_focus: true, x_expand: true});
        search.set_primary_icon(icon('edit-find-symbolic', 16));
        top.add_child(search); this.focusEntry = search;
        // Filters as one segmented control: the word and how many there are.
        const segments = box(false, {style_class: 'notchy-clip-segments', ...center});
        const chipButtons = FILTERS.map(([id, , title]) => {
            const row = box(false, {style_class: 'notchy-clip-segment-row'});
            row.add_child(label(id === 'fav' ? _('Favorites') : _(title), 'notchy-clip-segment-label', center));
            const count = label('', 'notchy-clip-segment-count', center); row.add_child(count);
            const chip = new St.Button({style_class: 'notchy-clip-segment', child: row, can_focus: true, accessible_name: _(title)});
            chip.connect('clicked', () => { filter = id; selected = 0; update(); });
            segments.add_child(chip); return [id, chip, count];
        });
        top.add_child(segments); root.add_child(top);
        const body = box(false, {style_class: 'notchy-clip-body', y_expand: true});
        const list = box(true, {style_class: 'notchy-clip-list'});
        // Fixed widths: what the preview shows never moves the list.
        const inner = this.island.currentWidth - 36, listWidth = Math.round(inner * 0.44);
        const listScroll = scroll(list, CLIP_HEIGHT);
        listScroll.width = listWidth;
        body.add_child(listScroll);
        const preview = box(true, {style_class: 'notchy-clip-preview', width: inner - listWidth - 14, height: CLIP_HEIGHT});
        body.add_child(preview); root.add_child(body);
        const items = () => this.clipboard.history.search(query, filter === 'link' ? 'link' : filter === 'image' ? 'image' : 'all', filter === 'fav');
        const copy = (item, plain = false) => {
            if (plain && item.kind !== 'image' && item.kind !== 'files') St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.text);
            else this.clipboard.copy(item);
            this.island.close(); this.island.toast('edit-copy-symbolic', plain ? _('Copied as plain text') : _('Copied to clipboard'));
        };
        const act = (action, item) => {
            if (!item) return;
            if (action === 'copy' || action === 'plain') copy(item, action === 'plain');
            else if (action === 'fav') this.clipboard.favorite(item.id);
            else if (action === 'del') this.clipboard.remove(item.id);
            else if (action === 'shelf') { this.shelveClip(item); this.island.toast('package-x-generic-symbolic', _('Added to the Shelf')); }
        };
        const update = () => {
            const counts = {all: this.clipboard.history.search(query).length, link: this.clipboard.history.search(query, 'link').length,
                image: this.clipboard.history.search(query, 'image').length, fav: this.clipboard.history.search(query, 'all', true).length};
            for (const [id, chip, count] of chipButtons) { id === filter ? chip.add_style_class_name('active') : chip.remove_style_class_name('active'); count.text = String(counts[id]); }
            list.destroy_all_children();
            const found = items(); selected = Math.max(0, Math.min(selected, found.length - 1));
            let day = '';
            found.slice(0, 100).forEach((item, index) => {
                const heading = dayHeading(item.created);
                if (heading !== day) { day = heading; list.add_child(label(heading, 'notchy-clip-group')); }
                const current = index === selected;
                const row = box(false, {style_class: `notchy-clip-row${current ? ' selected' : ''}`});
                row.add_child(clipTile(item));
                const words = clipTitle(item) || item.text.replace(/\s+/g, ' ').slice(0, 160);
                const open = new St.Button({child: label(words, `notchy-clip-text${item.kind === 'color' ? ' mono' : ''}`, {x_expand: true, x_align: Clutter.ActorAlign.START, ...center}), x_expand: true, can_focus: false,
                    style_class: 'notchy-clip-open', accessible_name: clipTitle(item) || item.text.slice(0, 80)});
                open.connect('clicked', () => {
                    // A second click on the same row within 400 ms copies it.
                    const now = GLib.get_monotonic_time() / 1000, double = lastClick[0] === item.id && now - lastClick[1] < 400;
                    lastClick = [item.id, now];
                    if (double) { copy(item); return; }
                    selected = index; update();
                });
                row.add_child(open);
                if (item.favorite) { const star = icon('starred-symbolic', 12); star.add_style_class_name('notchy-star'); star.y_align = Clutter.ActorAlign.CENTER; row.add_child(star); }
                row.add_child(label(relativeTime(item.created), 'notchy-clip-meta', center));
                list.add_child(row);
            });
            if (!found.length) list.add_child(label(query ? _('Nothing found') : _('Nothing copied yet'), 'notchy-clip-none', {x_align: Clutter.ActorAlign.CENTER}));
            preview.destroy_all_children();
            if (found[selected]) this.clipPreview(preview, found[selected], act, query); else preview.add_style_class_name('empty');
            if (found[selected]) preview.remove_style_class_name('empty');
            this.pageLife.later(0, () => {
                const row = list.get_children().filter(child => child.has_style_class_name?.('notchy-clip-row'))[selected], view = list.get_parent();
                if (!row || !view?.vadjustment) return;
                const adjust = view.vadjustment;
                if (row.y < adjust.value) adjust.value = Math.max(0, row.y - 22);
                else if (row.y + row.height > adjust.value + adjust.page_size) adjust.value = row.y + row.height - adjust.page_size;
            });
        };
        const keys = (event, inEntry) => {
            const key = event.get_key_symbol(), shift = Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
            const found = items();
            if (key === Clutter.KEY_Down) { selected = Math.min(found.length - 1, selected + 1); update(); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Up) { selected = Math.max(0, selected - 1); update(); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) { act(shift ? 'plain' : 'copy', found[selected]); return Clutter.EVENT_STOP; }
            if (inEntry && key === Clutter.KEY_Escape && search.get_text()) { search.set_text(''); return Clutter.EVENT_STOP; }
            if (inEntry) return Clutter.EVENT_PROPAGATE;
            if (key === Clutter.KEY_f || key === Clutter.KEY_F) { act('fav', found[selected]); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Delete) { act('del', found[selected]); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        };
        search.clutter_text.connect('text-changed', () => { query = search.get_text(); selected = 0; search.get_text() ? search.add_style_class_name('searching') : search.remove_style_class_name('searching'); update(); });
        connectKeyPress(search.clutter_text, (_t, event) => keys(event, true));
        this.keyPress = event => keys(event, false);
        update(); this.pageLife.cleanups.push(this.clipboard.subscribe(update));
        return root;
    }
    // The selected entry, shown as what it is, with what can be done with it.
    clipPreview(preview, item, act, query) {
        const center = {y_align: Clutter.ActorAlign.CENTER};
        const meta = box(false, {style_class: 'notchy-clip-preview-meta'});
        meta.add_child(label(clipKindName(item), `notchy-clip-kind ${item.kind}`, center));
        const where = [item.source, relativeTime(item.created)].filter(Boolean).join(' · ');
        meta.add_child(label(where, 'notchy-clip-preview-where', {x_expand: true, ...center}));
        const size = clipSize(item);
        if (size) meta.add_child(label(size, 'notchy-clip-preview-where', center));
        preview.add_child(meta);
        const content = box(true, {style_class: 'notchy-clip-preview-content', y_expand: true, clip_to_allocation: true});
        if (item.kind === 'link') {
            let host = item.text;
            try { host = GLib.Uri.parse(item.text.trim(), GLib.UriFlags.NONE).get_host() || item.text; } catch { /* Shown as it is. */ }
            const card = box(false, {style_class: 'notchy-clip-link-card'});
            card.add_child(new St.Bin({style_class: 'notchy-clip-link-avatar', child: label(host.replace(/^www\./, '').charAt(0).toUpperCase(), 'notchy-clip-link-letter', {x_align: Clutter.ActorAlign.CENTER, ...center}), ...center}));
            card.add_child(label(host.replace(/^www\./, ''), 'notchy-clip-link-host', {x_expand: true, ...center}));
            content.add_child(card);
            const url = label(item.text.trim(), 'notchy-clip-link-url'); url.clutter_text.line_wrap = true; url.clutter_text.line_wrap_mode = Pango.WrapMode.CHAR; url.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            content.add_child(url);
        } else if (item.kind === 'image' && item.asset) {
            const picture = new St.Widget({style_class: 'notchy-clip-picture', y_expand: true, x_expand: true});
            picture.style = `background-image: url("${item.asset.replace(/["\\]/g, '\\$&')}");`;
            content.add_child(picture);
        } else if (item.kind === 'color') {
            const hex = normalHex(item.text.trim());
            const swatch = new St.Widget({style_class: 'notchy-clip-swatch', height: 74}); swatch.style = `background-color: ${hex};`;
            content.add_child(swatch);
            const formats = box(false, {style_class: 'notchy-clip-formats'});
            for (const [name, value] of colorFormats(hex)) {
                const cell = box(true, {style_class: 'notchy-clip-format-cell'});
                cell.add_child(label(name, 'notchy-clip-format-name')); cell.add_child(label(value, 'notchy-clip-format-value'));
                const button_ = new St.Button({style_class: 'notchy-clip-format', child: cell, x_expand: true, can_focus: true, accessible_name: fmt(_('Copy %s'), value)});
                button_.connect('clicked', () => { St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, value); this.island.close(); this.island.toast('edit-copy-symbolic', _('Copied to clipboard')); });
                formats.add_child(button_);
            }
            content.add_child(formats);
        } else if (item.kind === 'files') {
            for (const uri of (item.uris ?? []).slice(0, 4)) {
                const name = Gio.File.new_for_uri(uri).get_basename() ?? uri, ext = extensionOf(name);
                const row = box(false, {style_class: 'notchy-clip-file'});
                row.add_child(label(ext.toUpperCase().slice(0, 4) || _('FILE'), `notchy-file-ext ${KIND[ext] ?? 'other'}`, center));
                row.add_child(label(name, 'notchy-clip-file-name', {x_expand: true, ...center}));
                content.add_child(row);
            }
            if ((item.uris?.length ?? 0) > 4) content.add_child(label(fmt(ngettext('and %d more', 'and %d more', item.uris.length - 4), item.uris.length - 4), 'notchy-clip-preview-where'));
        } else {
            const text = label(item.text, 'notchy-clip-preview-text');
            text.clutter_text.line_wrap = true; text.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR; text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            // The match stands out while searching.
            const at = query ? item.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
            if (at >= 0 && item.text.length < 4000) {
                const escape = t => GLib.markup_escape_text(t, -1);
                text.clutter_text.set_markup(`${escape(item.text.slice(0, at))}<span background="#f2a25c55" foreground="#ffffff">${escape(item.text.slice(at, at + query.length))}</span>${escape(item.text.slice(at + query.length))}`);
            }
            content.add_child(text);
        }
        preview.add_child(content);
        const actions = box(false, {style_class: 'notchy-clip-preview-actions'});
        const primary = new St.Button({style_class: 'notchy-clip-copy', can_focus: true, accessible_name: _('Copy (Enter)'), ...center});
        const primaryRow = box(false, {style_class: 'notchy-clip-copy-row'});
        primaryRow.add_child(label(_('Copy'), 'notchy-clip-copy-label', center));
        primary.set_child(primaryRow); primary.connect('clicked', () => act('copy', item)); actions.add_child(primary);
        // The keys (↵, ⇧↵) are in the buttons' names; the room goes to the words.
        if (item.kind === 'text' || item.kind === 'link') {
            const plain = new St.Button({style_class: 'notchy-clip-plain', can_focus: true, accessible_name: _('Copy as plain text (Shift+Enter)'), ...center});
            const plainRow = box(false, {style_class: 'notchy-clip-copy-row'});
            plainRow.add_child(label(_('Copy as Text'), 'notchy-clip-plain-label', center));
            plain.set_child(plainRow); plain.connect('clicked', () => act('plain', item)); actions.add_child(plain);
        }
        actions.add_child(new St.Widget({x_expand: true}));
        actions.add_child(button(item.favorite ? 'starred-symbolic' : 'non-starred-symbolic', _('Favorite (F)'), () => act('fav', item), `notchy-round-button notchy-clip-action${item.favorite ? ' favorite' : ''}`));
        actions.add_child(button('package-x-generic-symbolic', _('Add to Shelf'), () => act('shelf', item), 'notchy-round-button notchy-clip-action'));
        actions.add_child(button('user-trash-symbolic', _('Delete (Del)'), () => act('del', item), 'notchy-round-button notchy-clip-action danger'));
        preview.add_child(actions);
    }
    // The history is off: what it would do, and a way to turn it on.
    clipboardPaused(root) {
        const empty = box(true, {style_class: 'notchy-clip-paused', x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const stack = new St.Widget({width: 150, height: 84, x_align: Clutter.ActorAlign.CENTER});
        for (const [x, y, w, h, angle, front] of [[26, 18, 98, 26, -4, false], [22, 36, 106, 28, 3, false], [18, 50, 114, 30, 0, true]]) {
            const strip = new St.Widget({style_class: front ? 'notchy-clip-ghost front' : 'notchy-clip-ghost', x, y, width: w, height: h, pivot_point: new Graphene.Point({x: 0.5, y: 0.5}), rotation_angle_z: angle});
            if (front) {
                strip.add_child(new St.Widget({style_class: 'notchy-clip-ghost-dot', x: 10, y: 8, width: 14, height: 14}));
                strip.add_child(new St.Widget({style_class: 'notchy-clip-ghost-line', x: 32, y: 13, width: 70, height: 5}));
            }
            stack.add_child(strip);
        }
        empty.add_child(stack);
        empty.add_child(label(_('The History Is Off'), 'notchy-clip-paused-title', {x_align: Clutter.ActorAlign.CENTER}));
        empty.add_child(label(_('Turn it on to find everything you copied here again.'), 'notchy-clip-paused-hint', {x_align: Clutter.ActorAlign.CENTER}));
        const turnOn = textButton(_('Turn On History'), () => this.settings.set_boolean('clipboard-enabled', true), 'notchy-clip-turn-on');
        turnOn.x_align = Clutter.ActorAlign.CENTER; empty.add_child(turnOn);
        empty.add_child(label(_('It is kept on this computer only.'), 'notchy-clip-paused-note', {x_align: Clutter.ActorAlign.CENTER}));
        root.add_child(empty);
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
        const prevWeek = button('go-previous-symbolic', _('Previous Week'), () => { this.calWeek--; drawWeek(); }, 'notchy-round-button small');
        const nextWeek = button('go-next-symbolic', _('Next Week'), () => { this.calWeek++; drawWeek(); }, 'notchy-round-button small');
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
        notesHead.add_child(label(_('Notifications'), 'notchy-cal-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const dndIcon = new St.Icon({icon_size: 14}), dndLabel = label('', 'notchy-cal-dnd-label');
        const dndRow = box(false, {style_class: 'notchy-cal-dnd-row'}); dndRow.add_child(dndIcon); dndRow.add_child(dndLabel);
        const dnd = new St.Button({style_class: 'notchy-cal-dnd', child: dndRow, can_focus: true, accessible_name: _('Do Not Disturb'), y_align: Clutter.ActorAlign.CENTER});
        dnd.connect('clicked', () => {
            this.notifications.doNotDisturb = !this.notifications.doNotDisturb;
            this.island.toast(this.notifications.doNotDisturb ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
                this.notifications.doNotDisturb ? _('Do Not Disturb is on') : _('Notifications are back on'));
        });
        const clear = button('edit-clear-all-symbolic', _('Clear All'), () => this.notifications.clear(), 'notchy-round-button small');
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
        const clock = d => formatTime(d);
        const drawAgenda = () => {
            agenda.destroy_all_children();
            const day = new Date(this.calDay), offset = Math.round((day - today) / 86400000);
            const date = formatDate(day, {day: 'numeric', month: 'long'});
            // Translators: %s is a date like "19 October".
            dayTitle.text = offset === 0 ? fmt(_('Today, %s'), date) : offset === 1 ? fmt(_('Tomorrow, %s'), date) : offset === -1 ? fmt(_('Yesterday, %s'), date) : formatDate(day, {weekday: 'long', day: 'numeric', month: 'long'});
            // Translators: the ISO calendar week, short ("KW 42" in German).
            weekLabel.text = fmt(_('Week %d'), isoWeek(day));
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
                // Translators: in place of a start time, for an event lasting all day.
                row.add_child(label(allDay ? _('Day') : clock(begin), 'notchy-cal-event-time'));
                const card = box(false, {style_class: 'notchy-cal-event-card', x_expand: true});
                card.add_child(new St.Widget({style_class: `notchy-cal-event-bar tone-${i % 4}`}));
                const text = box(true, {x_expand: true});
                text.add_child(label(event.title || _('Event'), 'notchy-cal-event-title'));
                const minutes = Math.round((event.end - event.begin) / 60000);
                text.add_child(label(allDay ? _('All day') : minutes > 0 ? `${clock(begin)} – ${clock(end)}` : clock(begin), 'notchy-cal-event-sub'));
                card.add_child(text); row.add_child(card); agenda.add_child(row);
            });
            if (!nowShown && events.length) nowLine();
            if (!events.length) agenda.add_child(empty('x-office-calendar-symbolic', this.calendar.loading ? _('Loading events…') : this.calendar.error || _('No events')));
        };
        // request: only for a new week; calendar updates merely redraw.
        const drawWeek = (request = true) => {
            days.destroy_all_children();
            const week = weekDays(today, this.calWeek);
            if (request) this.calendar.requestRange(week[0], new Date(week[6].getFullYear(), week[6].getMonth(), week[6].getDate() + 1));
            for (const day of week) {
                const selected = day.getTime() === this.calDay, isToday = day.getTime() === today.getTime(), weekend = day.getDay() % 6 === 0;
                const cell = box(true, {x_expand: true});
                cell.add_child(label(formatDate(day, {weekday: 'short'}).replace('.', ''), 'notchy-cal-weekday', {x_align: Clutter.ActorAlign.CENTER}));
                cell.add_child(label(String(day.getDate()), 'notchy-cal-daynum', {x_align: Clutter.ActorAlign.CENTER}));
                cell.add_child(new St.Widget({style_class: `notchy-cal-dot${this.calendar.day(day).length ? ' busy' : ''}`, x_align: Clutter.ActorAlign.CENTER}));
                const classes = ['notchy-cal-day', selected && 'selected', isToday && 'today', weekend && 'weekend'].filter(Boolean).join(' ');
                const b = new St.Button({style_class: classes, child: cell, x_expand: true, can_focus: true, accessible_name: formatDate(day, {weekday: 'long', day: 'numeric', month: 'long'})});
                b.connect('clicked', () => { this.calDay = day.getTime(); drawWeek(); });
                days.add_child(b);
            }
            drawAgenda();
        };
        const drawNotes = () => {
            const on = this.notifications.doNotDisturb;
            dndIcon.icon_name = on ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic';
            // Translators: the notifications switch in the calendar tab: on, or Do Not Disturb.
            dndLabel.text = on ? _('Do Not Disturb') : _('On');
            on ? dnd.add_style_class_name('on') : dnd.remove_style_class_name('on');
            notes.destroy_all_children();
            const items = this.notifications.items;
            clear.reactive = items.some(x => !x.resident); clear.opacity = clear.reactive ? 255 : 90;
            for (const group of groupBy(items.slice(0, 60), n => n.source?.title || _('Notification'))) {
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
                const press = new St.Button({child: text, x_expand: true, can_focus: true, accessible_name: rest.length ? fmt(ngettext('%1$s: %2$d notification', '%1$s: %2$d notifications', group.items.length), group.name, group.items.length) : fmt(_('Open: %s'), top.title || '')});
                press.connect('clicked', () => {
                    if (rest.length) { open ? this.calOpen.delete(group.name) : this.calOpen.add(group.name); drawNotes(); }
                    else { this.island.close(); top.activate(); }
                });
                card.add_child(press);
                if (group.items.some(n => !n.resident)) {
                    const close = button('window-close-symbolic', _('Close Notifications'), () => { for (const n of group.items) if (!n.resident) n.destroy(); }, 'notchy-round-button tiny');
                    close.y_align = Clutter.ActorAlign.START; card.add_child(close);
                }
                stack.add_child(card);
                if (open) for (const n of rest) {
                    const sub = box(true, {style_class: 'notchy-cal-note-sub'});
                    const line = box(false); line.add_child(label(n.title || group.name, 'notchy-cal-note-title', {x_expand: true}));
                    if (n.datetime) line.add_child(label(formatTimeSpan(n.datetime), 'notchy-cal-note-time'));
                    sub.add_child(line); const subBody = plain(n); if (subBody) sub.add_child(label(subBody, 'notchy-cal-note-body'));
                    const subButton = new St.Button({child: sub, x_expand: true, can_focus: true, accessible_name: fmt(_('Open: %s'), n.title || '')});
                    subButton.connect('clicked', () => { this.island.close(); n.activate(); });
                    stack.add_child(subButton);
                }
                notes.add_child(stack);
            }
            if (!items.length) notes.add_child(empty('notifications-disabled-symbolic', _('All caught up')));
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
        const entry = new St.Entry({style_class: 'notchy-search-entry', hint_text: _('Apps, commands, calculations… · “file …” for files'), can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
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
            copy: (text, message) => { St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text); island.toast('edit-copy-symbolic', message ?? _('Copied')); },
            setQuery: text => { entry.set_text(text); entry.clutter_text.set_cursor_position(-1); entry.grab_key_focus(); },
            drill: name => openDrill(name),
            fileBackend: (backend, error) => { state.backend = backend ?? ''; state.error = error ?? ''; },
            openFile: file => Gio.File.new_for_uri(file.uri).query_info_async('standard::type,access::can-read,access::can-execute', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (f, result) => {
                try {
                    const info = f.query_info_finish(result);
                    if (!info.get_attribute_boolean('access::can-read')) { island.toast('dialog-warning-symbolic', _('No permission for this file')); return; }
                    launchUri(file.uri);
                } catch (e) {
                    island.toast('dialog-warning-symbolic', e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ? _('The file no longer exists') : _('The file cannot be reached'));
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
        const ROW = 42, HEADER = 24, visible = () => this.settings.get_int('launcher-max-results');
        const current = () => state.panel ? state.panel.actions : state.results;
        const run = (result, action) => {
            if (!result || !action) return;
            // Shutting down and the like ask first, whichever of their actions
            // runs (Enter, Ctrl+Enter, the action panel): a second Enter confirms.
            if (result.confirm && state.confirm !== result.id) { state.confirm = result.id; if (state.panel) { state.selected = state.panel.index; state.panel = null; } draw(); return; }
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
            text.add_child(label(confirming ? fmt(_('%s ↵ to confirm'), item.confirm) : item.title, 'notchy-result-title', {y_align: Clutter.ActorAlign.CENTER}));
            const sub = isAction ? item.shortcut ?? '' : confirming ? _('Esc cancels') : item.subtitle ?? '';
            if (sub) text.add_child(label(sub, 'notchy-result-subtitle', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            actor.add_child(text);
            if (!isAction) actor.add_child(label(kindLabel(item.kind), 'notchy-result-kind', {y_align: Clutter.ActorAlign.CENTER}));
            const b = new St.Button({child: actor, x_expand: true, x_align: Clutter.ActorAlign.FILL, can_focus: false, track_hover: true, reactive: true,
                accessible_name: isAction ? item.title : `${item.title} · ${kindLabel(item.kind)}`});
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
            if (state.panel) hint.text = _('↵ run · Esc back');
            else if (item) {
                const confirming = state.confirm === item.id;
                const first = item.actions[0]?.title ?? _('Open');
                hint.text = confirming ? _('↵ confirm · Esc cancel') : item.actions.length > 1 ? fmt(_('↵ %s · Ctrl+K Actions'), first) : `↵ ${first}`;
            } else hint.text = '';
            const query = entry.get_text().trim();
            const count = state.results.length, hits = fmt(ngettext('%d result', '%d results', count), count);
            status.text = state.panel ? state.panel.result.title
                : state.drill ? _('Indexed folders · Esc back')
                : state.pending ? _('Searching files…')
                : state.mode === 'files' && query ? fmt(_('Files and folders only · %s'), hits)
                : state.backend === 'fallback' && query ? _('File index not active · basic search in personal folders')
                : !this.settings.get_boolean('launcher-file-search') && query ? _('File search is turned off')
                : state.empty ? 'Thunderstorm' : hits;
        };
        const draw = () => {
            list.destroy_all_children();
            const items = current();
            state.selected = Math.max(0, Math.min(state.selected, items.length - 1));
            let rows = 0, headers = 0, section = null;
            if (state.panel) { list.add_child(label(fmt(_('Actions · %s'), state.panel.result.title), 'notchy-results-section')); headers++; }
            items.forEach((item, index) => {
                if (!state.panel && item.section && item.section !== section) { section = item.section; list.add_child(label(sectionLabel(section), 'notchy-results-section')); headers++; }
                list.add_child(row(item, index, index === state.selected)); rows++;
            });
            // The list's own height, up to the visible rows (and its headers) and the
            // screen; beyond that it scrolls. A constraint, not a measurement: the
            // rows just built may not be on the stage or styled yet, and the
            // island measures the whole page once they are (Island.resize).
            view.visible = rows > 0;
            const room = island.monitor.height - island.topInset - 24 - SEARCH_CHROME;
            view.set_style(`max-height: ${Math.max(ROW, Math.min(room, visible() * ROW + Math.min(headers, 3) * HEADER))}px;`);
            footer.visible = rows > 0 || state.pending || Boolean(entry.get_text().trim());
            drawFooter(); keepVisible();
            this.pageLife.later(0, () => island.resize());
        };
        const update = () => { state.panel = null; state.confirm = null; state.drill = null; state.fresh = true; session.query(entry.get_text()); };
        // Changed settings (commands, quicklinks, the visible rows): the same
        // query again, on the same row if the user had moved; field and focus stay.
        this.searchAgain = () => { if (this.pageLife.closed || state.drill || state.panel) return; state.confirm = null; session.query(entry.get_text()); };
        this.pageLife.cleanups.push(() => { this.searchAgain = null; });
        entry.clutter_text.connect('text-changed', update);
        connectKeyPress(entry.clutter_text, (_t, event) => {
            const key = event.get_key_symbol(), mods = event.get_state(), ctrl = Boolean(mods & Clutter.ModifierType.CONTROL_MASK), shift = Boolean(mods & Clutter.ModifierType.SHIFT_MASK);
            const items = current();
            const step = delta => { state.selected = Math.max(0, Math.min(items.length - 1, state.selected + delta)); state.confirm = null; state.moved = true; drawSelection(); };
            if (key === Clutter.KEY_Down) { step(1); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Up) { step(-1); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Page_Down) { step(visible()); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Page_Up) { step(-visible()); return Clutter.EVENT_STOP; }
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) { activate(state.selected, ctrl && !state.panel); return Clutter.EVENT_STOP; }
            if (ctrl && (key === Clutter.KEY_k || key === Clutter.KEY_K)) { togglePanel(); return Clutter.EVENT_STOP; }
            if (ctrl && shift && (key === Clutter.KEY_c || key === Clutter.KEY_C)) {
                // By the action's id, never its (translated) title.
                const result = state.results[state.selected], action = result?.actions.find(a => a.id === 'file.copyPath');
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
        const cancel = button('window-close-symbolic', _('Cancel Sending'), () => airdrop.cancelSend(), 'notchy-round-button small');
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
            const files = send.files.length === 1 ? send.files[0] : fmt(ngettext('%d file', '%d files', send.files.length), send.files.length);
            title.text = files;
            const phase = send.phase;
            root.set_style_class_name(`notchy-peek notchy-airdrop ${phase}`);
            coreIcon.gicon = gicon(phase === 'done' ? 'object-select-symbolic' : phase === 'failed' ? 'dialog-warning-symbolic' : phase === 'searching' || phase === 'cancelled' ? 'notchy-airdrop-symbolic' : 'phone-symbolic');
            status.text = {searching: _('Looking for iPhones nearby…'), waiting: fmt(_('To %s · accept on the iPhone'), send.peer), sending: fmt(_('To %s · sending…'), send.peer),
                done: send.peer ? fmt(_('Sent to %s'), send.peer) : _('Sent'), failed: send.error || _('Sending failed'), cancelled: _('Cancelled')}[phase] ?? '';
            hint.text = phase === 'searching' ? _('iPhone: AirDrop “Everyone”, share menu closed') : ['waiting', 'sending'].includes(phase) ? _('Wi-Fi is paused during AirDrop') : '';
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
    // AirDrop, receiving: who sends what, and "Accept" before the time runs out.
    airdropAskView(question) {
        const root = box(false, {style_class: 'notchy-peek notchy-airdrop notchy-airdrop-ask'});
        const badge = new St.Bin({style_class: 'notchy-airdrop-core', width: 46, height: 46, y_align: Clutter.ActorAlign.START, child: icon('notchy-airdrop-symbolic', 22)});
        root.add_child(badge);
        const column = box(true, {x_expand: true});
        const meta = box(false, {style_class: 'notchy-peek-meta'});
        meta.add_child(label('AirDrop', 'notchy-peek-app', {x_expand: true}));
        const left = label('', 'notchy-peek-app'); meta.add_child(left);
        column.add_child(meta);
        column.add_child(label(question.sender || _('A device nearby'), 'notchy-peek-title'));
        const what = question.files ? fmt(_('wants to send “%s”'), question.files) : _('wants to send something');
        const body = label(what, 'notchy-peek-body'); body.clutter_text.set_line_wrap(true); body.clutter_text.ellipsize = 0; column.add_child(body);
        const actions = box(false, {style_class: 'notchy-peek-actions'});
        actions.add_child(textButton(_('Decline'), () => question.answer(false), 'notchy-pill-button'));
        const accept = textButton(_('Accept'), () => question.answer(true), 'notchy-pill-button notchy-accept');
        actions.add_child(accept); column.add_child(actions);
        // The backend declines on its own once this runs out.
        const track = new St.Widget({style_class: 'notchy-airdrop-timeout', x_expand: true});
        const fill = new St.Widget({style_class: 'notchy-airdrop-timeout-fill'}); track.add_child(fill); column.add_child(track);
        root.add_child(column);
        const tick = () => {
            if (!track.mapped) return;
            const remaining = Math.max(0, question.timeout - (GLib.get_monotonic_time() - question.asked) / 1000);
            left.text = fmt(_('%d s'), Math.ceil(remaining / 1000));
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
        meta.add_child(label(notification.source?.title || _('Notification'), 'notchy-peek-app', {x_expand: true}));
        if (notification.datetime) meta.add_child(label(formatTimeSpan(notification.datetime), 'notchy-peek-app'));
        text.add_child(meta);
        if (notification.title) text.add_child(label(notification.title, 'notchy-peek-title'));
        const body = (notification.body || '').replace(notification.useBodyMarkup ? /<[^>]*>/g : /$^/, '').replace(/\s+/g, ' ').trim();
        if (body) text.add_child(label(body, 'notchy-peek-body'));
        const open = new St.Button({child: text, x_expand: true, can_focus: true, style_class: 'notchy-peek-open', accessible_name: fmt(_('Open: %s'), notification.title || '')});
        open.connect('clicked', () => { done(); notification.activate(); });
        column.add_child(open);
        if (notification.actions?.length) {
            const actions = box(false, {style_class: 'notchy-peek-actions'});
            for (const action of notification.actions.slice(0, 3)) actions.add_child(textButton(action.label, () => { done(); action.activate(); }, 'notchy-pill-button'));
            column.add_child(actions);
        }
        root.add_child(column);
        const hide = button('window-close-symbolic', _('Hide Banner'), done, 'notchy-round-button small'); hide.y_align = Clutter.ActorAlign.START;
        root.add_child(hide);
        // Dismissed elsewhere (e.g. by its app): fold the banner away too.
        const id = notification.connect('destroy', () => done());
        root.connect('destroy', () => { try { notification.disconnect(id); } catch { /* Already disposed. */ } });
        return {actor: root};
    }
    dispose() { this.pageLife?.dispose(); this.life.dispose(); this.menu?.destroy(); }
}
