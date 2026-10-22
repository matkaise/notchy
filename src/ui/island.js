import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {GlassLayer} from './glass.js';
import {NotchEars} from './notchEars.js';
import {Views} from './views.js';
import {AirPodsBubble} from './airpodsBubble.js';
import {AgentIndicators} from './agentBubble.js';
import {ShelfBubble} from './shelfBubble.js';
import {ActivityIndicators} from './activityBubble.js';
import {compactParts, entryTicks} from './activityViews.js';
import {SideIndicators} from './sideIndicators.js';
import {Waveform} from './waveform.js';
import {box, label, icon, gicon, button} from './widgets.js';
import {Lifetime} from '../lifecycle.js';
import {_, N_, fmt, ngettext, formatPercent} from '../i18n/core.js';

// Bottom tab bar (Droppy for GNOME): page, icon, label.
export const TABS = [['media', 'audio-x-generic-symbolic', N_('Media')], ['shelf', 'package-x-generic-symbolic', N_('Shelf')],
    ['clipboard', 'edit-paste-symbolic', N_('Clipboard')], ['calendar', 'x-office-calendar-symbolic', N_('Calendar')], ['activities', 'view-list-bullet-symbolic', N_('Activities')]];
const TAB_INDEX = Object.fromEntries(TABS.map(([page], i) => [page, i]));
// Content heights per tab; the surface morphs between them.
// Every tab has the same height, so switching tabs never makes the island jump.
export const PAGE_HEIGHT = 300;
export const CONTENT_HEIGHT = {media: PAGE_HEIGHT, shelf: PAGE_HEIGHT, clipboard: PAGE_HEIGHT, calendar: PAGE_HEIGHT, activities: PAGE_HEIGHT};
// A compact, icon-only tab pill (as in Droppy); labels remain accessible names.
export const DROP_HEIGHT = 132;
export const TAB_WIDTH = 46, TAB_HEIGHT = 30, TAB_INSET = 3, TABBAR_HEIGHT = 50;
const TOP_GAP = 8, RADIUS = 30, SLIDE = 24;
// AirPods arriving: the pill before the card, the card, the pill after it; leaving.
const AIRPODS_PILL = 900, AIRPODS_CARD = 4200, AIRPODS_AFTER = 1800, AIRPODS_GONE = 2400;
const WIDTH = {search: 620, drop: 460, notification: 440, snap: 560};
const LIQUID_INSET = 3, FADE = 70;
// Settings that change what an opened tab shows (see the settings handler).
const PAGE_KEYS = new Set(['style', 'glass-level', 'width', 'media-enabled', 'media-waveform', 'airplay-enabled', 'clipboard-enabled', 'airpods-battery-threshold']);

// An icon from a name, a Gio.Icon or a Gio.File, set only when it changed
// (a new FileIcon for the same cover would make St load it again).
function setIcon(actor, source) {
    const file = typeof source?.query_exists === 'function';
    const key = typeof source === 'string' ? source : file ? source.get_uri() : source?.to_string?.() ?? '';
    if (actor.notchyIcon === key) return;
    actor.notchyIcon = key;
    actor.gicon = typeof source === 'string' ? gicon(source) : file ? new Gio.FileIcon({file: source}) : source;
}
// One row of the capsule from its parts [{key, make, update}]: a part whose
// key is still there keeps its actor and only gets update(); new parts are
// made, gone ones destroyed, and the order follows the list.
export function syncRow(row, parts) {
    const existing = new Map(row.get_children().map(child => [child.notchyKey, child])), kept = new Set();
    parts.forEach((part, index) => {
        let actor = existing.get(part.key);
        if (!actor) { actor = part.make(); actor.notchyKey = part.key; row.insert_child_at_index(actor, index); }
        else if (row.get_child_at_index(index) !== actor) row.set_child_at_index(actor, index);
        part.update?.(actor); kept.add(actor);
    });
    for (const child of row.get_children()) if (!kept.has(child)) child.destroy();
}

// The AirPods pill in the capsule (Island.showLink). Its parts start moving a
// tick after they are on screen: GNOME skips the easing of unmapped actors.
// `alive()` tells a later step whether the actor still exists.
function whenShown(actor, fn) {
    let gone = false;
    actor.connect('destroy', () => { gone = true; });
    const alive = () => !gone && actor.mapped;
    const go = () => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => { if (alive()) fn(alive); return GLib.SOURCE_REMOVE; });
    if (actor.mapped) { go(); return; }
    const id = actor.connect('notify::mapped', () => { if (gone || !actor.mapped) return; actor.disconnect(id); go(); });
}
// The AirPods' symbol: it springs in from the left when they arrive; when they
// leave it turns grey and falls away.
function linkGlyph(link) {
    const glyph = new St.Icon({gicon: gicon('notchy-airpods-symbolic'), icon_size: 18, style_class: 'notchy-link-glyph', y_align: Clutter.ActorAlign.CENTER,
        pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
    if (link.kind === 'found') { glyph.opacity = 0; glyph.scale_x = glyph.scale_y = 0.5; glyph.translation_x = -12; }
    whenShown(glyph, alive => {
        if (link.kind === 'found') glyph.ease({opacity: 255, scale_x: 1, scale_y: 1, translation_x: 0, duration: 520, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        if (link.kind === 'gone') {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 420, () => { if (alive()) glyph.add_style_class_name('gone'); return GLib.SOURCE_REMOVE; });
            glyph.ease({translation_y: 16, rotation_angle_z: 20, opacity: 0, delay: 760, duration: 560, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        }
    });
    return glyph;
}
// The battery: a small ring with the level beside it (drawn as it arrives,
// emptying as they leave), or „Getrennt“.
function linkRing(link) {
    const row = box(false, {style_class: `notchy-link-ring-row ${link.kind}`, y_align: Clutter.ActorAlign.CENTER});
    const level = link.level;
    const words = label(link.kind === 'gone' ? _('Disconnected') : level === null ? '' : formatPercent(level), 'notchy-link-text', {y_align: Clutter.ActorAlign.CENTER});
    const ring = new St.DrawingArea({width: 18, height: 18, y_align: Clutter.ActorAlign.CENTER});
    let progress = link.kind === 'found' ? 0 : 1, grey = link.kind === 'gone' ? 0 : -1;
    ring.connect('repaint', () => {
        const cr = ring.get_context(), [w, h] = ring.get_surface_size(), r = Math.min(w, h) / 2 - 1.8;
        cr.setLineWidth(2.6); cr.setSourceRGBA(1, 1, 1, 0.16); cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI); cr.stroke();
        const shown = link.kind === 'gone' ? (level ?? 0) / 100 * (1 - Math.max(0, grey)) : (level ?? 0) / 100 * progress;
        if (shown > 0.005) {
            const g = Math.max(0, grey);
            cr.setSourceRGBA(0.2 + 0.23 * g, 0.78 - 0.35 * g, 0.35 + 0.1 * g, 1); cr.setLineCap(Cairo.LineCap.ROUND);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * shown); cr.stroke();
        }
        cr.$dispose();
    });
    if (link.kind === 'gone') words.opacity = 0;
    row.add_child(words); row.add_child(ring);
    whenShown(row, () => {
        if (link.kind === 'gone') words.ease({opacity: 255, duration: 260, delay: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (link.kind === 'connected') return;
        const timeline = new Clutter.Timeline({actor: ring, duration: link.kind === 'gone' ? 700 : 760, delay: link.kind === 'gone' ? 420 : 120, progress_mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        // The pill may give way to the card mid-way: the timeline ends with its ring.
        let dead = false;
        ring.connect('destroy', () => { dead = true; timeline.stop(); });
        timeline.connect('new-frame', () => { if (dead) return; if (link.kind === 'gone') grey = timeline.get_progress(); else progress = timeline.get_progress(); ring.queue_repaint(); });
        timeline.start();
    });
    return row;
}

// The island is GNOME's clock grown into a surface: in the bar it is a capsule
// (live activity · clock · live activity); opened, the same live clock heads a
// surface with pin and settings beside it, the page, and a tab bar below.
export class Island {
    constructor(extension, monitor, services) {
        this.extension = extension; this.monitor = monitor; Object.assign(this, services);
        this.panelMode = true;
        this.life = new Lifetime(); this.expanded = false; this.page = 'media'; this.pinned = false;
        this.hoverTimeout = 0; this.collapseTimeout = 0; this.hudState = null; this.hudTimeout = 0;

        this.actor = new St.Widget({name: 'notchy-island', reactive: true, track_hover: true, visible: false});
        // Dynamic Glass: a black notch that fades into glass. The shade sits
        // below the glass surface, so the blur stays on the glass part.
        this.glass = new GlassLayer(); this.actor.add_child(this.glass.actor);
        this.shadeBlack = new St.Widget({style_class: 'notchy-shade-black'});
        this.shadeFade = new St.Widget({style_class: 'notchy-shade-fade'});
        this.actor.add_child(this.shadeBlack); this.actor.add_child(this.shadeFade);
        this.surface = box(true, {style_class: 'notchy-surface', clip_to_allocation: true}); this.actor.add_child(this.surface);

        // Explicitly not expanding: GNOME's clock asks for vertical expansion,
        // which Clutter would otherwise propagate up and stretch this row.
        this.headerRow = new St.Widget({style_class: 'notchy-header-row', layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: false});
        this.headerActions = box(false, {style_class: 'notchy-header-actions', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.pinButton = button('view-pin-symbolic', _('Keep Open'), () => this.togglePin(), 'notchy-round-button');
        this.headerActions.add_child(this.pinButton);
        this.headerActions.add_child(new St.Widget({x_expand: true}));
        // AirDrop: receiving on demand, only offered when its backend is installed.
        this.airdropButton = button('notchy-airdrop-symbolic', _('AirDrop: become visible to iPhones'), () => this.toggleAirDrop(), 'notchy-round-button notchy-airdrop-button');
        this.headerActions.add_child(this.airdropButton);
        this.headerActions.add_child(button('emblem-system-symbolic', _('Settings'), () => extension.openPreferences(), 'notchy-round-button'));
        this.panelHeader = new St.Bin({style_class: 'notchy-panel-header-slot', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.FILL});
        this.headerRow.add_child(this.headerActions); this.headerRow.add_child(this.panelHeader);
        this.surface.add_child(this.headerRow);
        this.body = box(true, {style_class: 'notchy-body', x_expand: true, clip_to_allocation: true}); this.surface.add_child(this.body);

        this.nav = box(false, {style_class: 'notchy-tabbar-area', x_expand: true, height: TABBAR_HEIGHT});
        // Fixed layout ignores CSS padding, so the inset is part of the geometry:
        // the indicator fills the pill's height and labels sit in its middle.
        this.tabTrack = new St.Widget({style_class: 'notchy-tabs', layout_manager: new Clutter.FixedLayout(), x_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            width: TABS.length * TAB_WIDTH + 2 * TAB_INSET, height: TAB_HEIGHT + 2 * TAB_INSET});
        this.tabIndicator = new St.Widget({style_class: 'notchy-tab-indicator', width: TAB_WIDTH, height: TAB_HEIGHT, x: TAB_INSET, y: TAB_INSET}); this.tabTrack.add_child(this.tabIndicator);
        this.navButtons = TABS.map(([page, name, text], i) => {
            const content = new St.Icon({icon_name: name, icon_size: 17, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            const b = new St.Button({style_class: 'notchy-tab', child: content, can_focus: true, accessible_name: `${i + 1} · ${_(text)}`, track_hover: true, width: TAB_WIDTH, height: TAB_HEIGHT, x: TAB_INSET + i * TAB_WIDTH, y: TAB_INSET});
            b.connect('clicked', () => this.open(page)); this.tabTrack.add_child(b); return [page, b];
        });
        this.nav.add_child(this.tabTrack); this.surface.add_child(this.nav);

        this.views = new Views(this, services);
        Main.layoutManager.addChrome(this.actor, {trackFullscreen: false});
        this.buildPanel();

        this.life.connect(this.actor, 'notify::hover', () => this.hoverChanged());
        this.life.connect(this.panelButton, 'notify::hover', () => this.hoverChanged());
        this.life.connect(global.stage, 'captured-event', (_stage, event) => {
            const source = global.stage.get_event_actor(event);
            if (!this.expanded || this.pinned || this.companion.shelfHeld || this.views.menu?.isOpen || event.type() !== Clutter.EventType.BUTTON_PRESS) return Clutter.EVENT_PROPAGATE;
            if (this.nativeShelf && this.companion.containsShelfPoint(...event.get_coords())) return Clutter.EVENT_PROPAGATE;
            if (source && !this.actor.contains(source) && !this.panelButton.contains(source)) this.close();
            return Clutter.EVENT_PROPAGATE;
        });
        this.life.connect(this.actor, 'captured-event', (_a, event) => this.radialClick(event));
        for (const signal of ['notify::width', 'notify::height']) this.life.connect(this.surface, signal, () => this.syncShade());
        // The glass paints what lies behind it, so it follows every move.
        for (const signal of ['notify::x', 'notify::y']) this.life.connect(this.actor, signal, () => this.syncShade());
        this.life.connect(this.actor, 'key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            // The page may claim Esc first (an AirDrop question declines with it).
            if (this.views.keyPress?.(event) === Clutter.EVENT_STOP) return Clutter.EVENT_STOP;
            if (key === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; }
            // Entries consume typed digits first; elsewhere 1–5 select a tab.
            const tab = TABS[key - Clutter.KEY_1];
            if (this.expanded && !this.peeking && tab) { this.open(tab[0]); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
        this.life.connect(Main.overview, 'showing', () => { this.close(true); this.returnPanelHeader(); this.syncVisibility(); });
        this.life.connect(Main.overview, 'hidden', () => this.syncVisibility());
        this.life.connect(global.display, 'in-fullscreen-changed', () => this.syncVisibility());
        this.life.connect(this.settings, 'changed', (_s, key) => {
            this.applyStyle(); this.position(); this.syncVisibility(); this.updateCompact();
            if (!this.expanded || this.peeking) return;
            // Thunderstorm keeps its field, query, selection and keyboard focus:
            // a changed launcher setting (commands, quicklinks …) searches again.
            if (this.page === 'search') { if (key.startsWith('launcher-') || key === 'clipboard-enabled') this.views.searchAgain?.(); return; }
            // Only what a page shows rebuilds it (an agents or AirPods setting,
            // a shortcut or a delay never takes the focus from an open page).
            if (PAGE_KEYS.has(key)) { this.sizeTarget = null; this.refresh(); }
        });
        this.life.cleanups.push(this.media.subscribe(() => { this.updateCompact(); if (this.expanded && this.page === 'media') this.refresh(); }));
        this.life.cleanups.push(this.cover.subscribe(() => { this.updateCompact(); if (this.expanded && this.page === 'media') this.refresh(); }));
        this.shelfCount = this.shelf.items.length;
        this.life.cleanups.push(this.shelf.subscribe(() => { this.shelfArrived(); this.updateCompact(); if (this.expanded && this.page === 'shelf') this.refresh(); }));
        this.life.cleanups.push(this.productivity.subscribe(() => this.updateCompact()));
        this.life.cleanups.push(this.operations.subscribe(() => this.updateCompact()));
        // Smart Live Activities: the manager's choice for the notch, and its changes.
        if (this.activities) this.life.cleanups.push(this.activities.subscribe(() => this.updateCompact()));
        this.life.cleanups.push(this.companion.subscribe(() => this.syncVisibility()));
        if (this.airdrop) this.life.cleanups.push(this.airdrop.subscribe(() => this.syncAirDrop()));
        if (this.airpods) {
            this.life.cleanups.push(this.airpods.onEvent(event => this.airpodsEvent(event)));
            this.life.cleanups.push(this.airpods.subscribe(() => { if (this.expanded && !this.peeking && this.page === 'media' && !this.views.outputPicker) this.refresh(); }));
        }
        this.ears = new NotchEars(this);
        // Indicators beside the capsule: connected AirPods and AI agents.
        this.sides = new SideIndicators(this);
        if (this.airpods) this.airpodsBubble = new AirPodsBubble(this);
        if (this.agents) this.agentIndicators = new AgentIndicators(this);
        this.shelfBubble = new ShelfBubble(this);
        if (this.activities) this.activityIndicators = new ActivityIndicators(this);
        this.applyStyle(); this.updateCompact(); this.position(); this.syncVisibility(); this.syncAirDrop();
    }
    buildPanel() {
        // The capsule in the bar: left and right slots around GNOME's live clock.
        this.panelButton = new PanelMenu.Button(0.5, 'Notchy', true);
        this.panelButton.add_style_class_name('notchy-panel-button');
        // Reactive, so scroll (volume) and right click (radial menu) reach it.
        this.panelSurface = box(false, {y_expand: true, x_align: Clutter.ActorAlign.CENTER, reactive: true});
        this.leftSlot = new St.Button({style_class: 'notchy-slot notchy-slot-left', can_focus: true, accessible_name: _('Open Notchy')});
        this.leftRow = box(false, {style_class: 'notchy-slot-row', x_expand: true}); this.leftSlot.set_child(this.leftRow);
        this.rightSlot = new St.Button({style_class: 'notchy-slot notchy-slot-right', can_focus: true, accessible_name: _('Open Notchy')});
        this.rightRow = box(false, {style_class: 'notchy-slot-row', x_expand: true, x_align: Clutter.ActorAlign.END}); this.rightSlot.set_child(this.rightRow);
        for (const slot of [this.leftSlot, this.rightSlot]) slot.connect('clicked', () => this.toggle());
        this.panelSurface.add_child(this.leftSlot);
        this.panelButton.add_child(this.panelSurface);
        Main.panel.addToStatusArea('notchy', this.panelButton, 0, 'center');
        // This wrapper has no popup. Registering its dummy menu would make
        // GNOME's menu manager switch away from the nested calendar.
        Main.panel.menuManager.removeMenu(this.panelButton.menu);
        // Reuse GNOME's actual clock button: clock settings, notification
        // indicator and keyboard navigation retain their behavior.
        this.dateMenu = Main.panel.statusArea.dateMenu;
        this.clockContainer = this.dateMenu.container;
        this.clockParent = this.clockContainer.get_parent();
        this.clockIndex = this.clockParent.get_children().indexOf(this.clockContainer);
        this.clockParent.remove_child(this.clockContainer);
        this.panelSurface.add_child(this.clockContainer);
        this.panelSurface.add_child(this.rightSlot);
        // The clock opens the Kalender tab; Super+V and clicks both go through
        // menu.open. GNOME's own popup remains when the setting is off.
        const clockMenu = this.dateMenu.menu, openCalendar = clockMenu.open;
        clockMenu.open = (...args) => {
            if (this.settings.get_boolean('clock-opens-notchy')) this.toggle('calendar');
            else openCalendar.call(clockMenu, ...args);
        };
        this.life.cleanups.push(() => { delete clockMenu.open; });
        this.life.connect(this.dateMenu.menu, 'open-state-changed', (_menu, open) => {
            if (open) this.close(true);
            else if (!this.expanded && !this.dropActive) { this.returnPanelHeader(); this.syncVisibility(); }
        });
        this.life.connect(this.panelSurface, 'scroll-event', (_a, event) => this.scrollVolume(event));
        this.life.connect(this.panelSurface, 'captured-event', (_a, event) => this.radialClick(event));
        this.life.connect(this.panelButton, 'notify::allocation', () => this.position());
        this.life.connect(Main.panel, 'notify::height', () => { this.position(); this.applyStyle(); });
    }
    get style() { return this.settings.get_string('style'); }
    get liquid() { return this.style === 'liquid'; }
    get topInset() { return this.liquid ? LIQUID_INSET : 0; }
    get headerHeight() { return Main.panel.height - 2 * this.topInset; }
    // Dynamic Glass: black down to this depth (from the screen top), then a fade.
    // Dynamic Glass: the black share of the opened surface; at 100 % it is
    // entirely black and no glass is drawn. The clock row is always black.
    get opaque() { return this.style === 'dynamic' && this.settings.get_int('glass-level') >= 100; }
    blackFor(height) { return this.opaque ? height : Math.max(this.headerHeight, Math.round(height * this.settings.get_int('glass-level') / 100)); }
    get expandedWidth() { return Math.min(this.settings.get_int('width'), this.monitor.width - 32); }
    get currentWidth() {
        if (this.dropActive) return WIDTH.drop;
        if (this.peeking) return Math.max(this.peekKind === 'snap' ? WIDTH.snap : WIDTH.notification, this.compactWidth);
        return this.page === 'search' ? WIDTH.search : this.expandedWidth;
    }
    // Native panes start right below the clock row; the shelf pane includes the
    // page gap so nothing transparent remains between header and pane.
    get contentY() { return this.monitor.y + this.topInset + this.headerHeight; }
    get dropTop() { return this.contentY; }
    get shelfHeight() { return CONTENT_HEIGHT.shelf; }
    get shelfWindowHeight() { return CONTENT_HEIGHT.shelf + TOP_GAP; }
    applyStyle() {
        this.surface.set_style_class_name(`notchy-surface notchy-${this.style}${this.expanded || this.dropActive ? ' notchy-expanded' : ''}`);
        this.syncCapsuleClass();
        this.headerRow.height = this.headerHeight; this.panelHeader.height = this.headerHeight;
        if (this.panelPlaceholder) this.panelPlaceholder.height = Main.panel.height;
        this.syncShade();
    }
    // The capsule's classes in one place: style, attached, and what its live
    // activity needs (wide slots around the clock, the HUD, a toast). Style
    // changes and content changes both come through here, so neither can drop
    // the other's classes (that left the closed capsule too narrow, see
    // layoutRegressions).
    syncCapsuleClass() {
        const flags = this.compactFlags ?? {};
        const classes = ['notchy-capsule', `notchy-${this.style}`, this.panelAttached && 'notchy-attached', flags.wide && 'notchy-wide',
            flags.hud && 'notchy-hud', flags.toasting && 'notchy-toasting'].filter(Boolean).join(' ');
        if (this.panelSurface.get_style_class_name() !== classes) this.panelSurface.set_style_class_name(classes);
    }
    // The closed capsule's width for what it shows now: GNOME's clock, the
    // live activity on either side (cover, waveform, media state, HUD, toast,
    // AirDrop, agent text, file work) and the capsule's padding. Always
    // measured from the capsule's current content, never remembered from an
    // earlier moment: a track, toast or HUD that changed while the island was
    // open changes the width the island folds back to.
    get compactWidth() { return Math.ceil(this.panelSurface.get_preferred_width(-1)[1]); }
    // While the capsule heads the opened surface, its place in the bar is held
    // by a placeholder of the same width; a folding surface follows a width
    // that changed under it.
    syncCompactGeometry() {
        if (!this.panelAttached || this.life.closed) return;
        const width = this.compactWidth;
        if (this.panelPlaceholder && this.panelPlaceholder.width !== width) this.panelPlaceholder.width = width;
        if (this.expanded || this.dropActive || this.foldWidth === undefined || this.foldWidth === width) return;
        this.foldWidth = width;
        const mode = Clutter.AnimationMode.EASE_OUT_CUBIC, duration = Math.min(160, this.settings.get_int('animation-duration'));
        this.surface.ease({width, duration, mode});
        this.targetX = this.centeredX(width);
        this.actor.ease({width, x: this.targetX, duration, mode});
    }
    syncShade() {
        const width = this.surface.width, height = this.surface.height;
        const joined = this.surface.has_style_class_name('notchy-native-joined');
        const open = this.expanded || this.dropActive, radius = open ? RADIUS : this.liquid ? 13 : 16;
        // Liquid glass rounds every corner; Dynamic Glass hangs from the edge.
        this.glassRadii = this.liquid ? [radius, radius, radius, radius] : [0, 0, radius, radius];
        this.glass.style(this.style, this.glassRadii);
        this.glass.place(0, 0, width, height, [this.actor.x, this.actor.y]);
        this.syncPane(joined);
        this.glass.actor.visible = !this.opaque;
        this.opaque ? this.surface.add_style_class_name('notchy-opaque') : this.surface.remove_style_class_name('notchy-opaque');
        const show = this.style === 'dynamic' && !joined && height > 0;
        open ? this.shadeBlack.remove_style_class_name('compact') : this.shadeBlack.add_style_class_name('compact');
        // Measured against the final height, so the fade does not slide while morphing.
        const black = Math.min(height, this.blackFor(this.sizeTarget?.[1] ?? height)), fade = this.opaque ? 0 : Math.max(0, Math.min(FADE, height - black));
        this.shadeBlack.visible = show && black > 0; this.shadeFade.visible = show && fade > 0;
        if (!show) return;
        // The shade reaching the bottom takes the surface's rounded corners.
        this.shadeBlack.set_size(width, black); this.shadeBlack.set_position(0, 0);
        this.shadeFade.set_size(width, fade); this.shadeFade.set_position(0, black);
        black >= height ? this.shadeBlack.add_style_class_name('bottom') : this.shadeBlack.remove_style_class_name('bottom');
        black + fade >= height ? this.shadeFade.add_style_class_name('bottom') : this.shadeFade.remove_style_class_name('bottom');
    }
    // Native panes (Regal, drop zone) are windows, which sit below the Shell's
    // chrome. The glass is drawn whole, as in every tab, and the pane is shown
    // on top of it as a clone of its window; the window itself stays below and
    // takes the input, which the island lets through there. (A second glass
    // layer between the windows, as before, is painted while Mutter clips every
    // window to the frame's damaged area: wherever nothing moved, it was black.)
    syncPane(joined) {
        const window = !joined ? null : this.dropActive ? this.companion.dropWindow : this.nativeShelf ? this.companion.shelfWindow : null;
        const source = window?.get_compositor_private() ?? null;
        if ((this.paneClone?.source ?? null) !== source) {
            this.paneLife?.dispose(); this.paneLife = null;
            this.paneClone?.destroy(); this.paneClone = null;
            if (source) {
                this.paneClone = new Clutter.Clone({name: 'notchy-pane', source, reactive: false});
                this.actor.insert_child_above(this.paneClone, this.shadeFade);
                this.paneLife = new Lifetime();
                for (const signal of ['notify::x', 'notify::y', 'notify::width', 'notify::height']) this.paneLife.connect(source, signal, () => this.placePane());
            }
        }
        this.placePane();
    }
    placePane() {
        const clone = this.paneClone, source = clone?.source; if (!source) return;
        clone.set_position(Math.round(source.x - this.actor.x), Math.round(source.y - this.actor.y));
        clone.set_size(source.width, source.height);
    }
    // Gradient offsets for the native shelf below the header (Dynamic Glass).
    get shelfShade() {
        const total = this.headerHeight + TOP_GAP + CONTENT_HEIGHT.shelf + TABBAR_HEIGHT;
        return {black: this.opaque ? 100000 : Math.max(0, this.blackFor(total) - this.headerHeight), fade: FADE};
    }
    // The same for the native drop zone below the clock.
    get dropShade() {
        const total = this.headerHeight + DROP_HEIGHT;
        return {black: this.opaque ? 100000 : Math.max(0, this.blackFor(total) - this.headerHeight), fade: FADE};
    }
    position() {
        const width = this.expanded || this.dropActive ? this.currentWidth : this.panelAttached ? (this.foldWidth ?? this.compactWidth) : this.panelSurface.width;
        const x = this.centeredX(width);
        // A morph in progress keeps its spring; only a moved target redirects it.
        if (this.actor.get_transition('x')) {
            if (Math.abs(x - this.targetX) >= 1) { this.targetX = x; this.actor.ease({x, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_CUBIC}); }
        } else this.actor.x = this.targetX = x;
        this.actor.y = this.monitor.y + this.topInset;
        if (this.nativeShelf) this.companion.positionShelf();
    }
    centeredX(width) {
        let center = this.monitor.x + this.monitor.width / 2;
        // While the bar is first laid out (GNOME 48 enabling Notchy at login)
        // its transformed position is not known yet (NaN): the monitor's
        // centre stands in until the allocation arrives.
        if (this.panelButton?.mapped) { const [x] = this.panelButton.get_transformed_position(), mid = x + this.panelButton.width / 2; if (Number.isFinite(mid)) center = mid; }
        if (!Number.isFinite(width)) width = 0;
        return Math.round(Math.max(this.monitor.x + 16, Math.min(this.monitor.x + this.monitor.width - width - 16, center - width / 2)));
    }
    attachPanelHeader() {
        if (this.panelAttached) return;
        const [x] = this.panelSurface.get_transformed_position();
        const width = this.compactWidth;
        this.panelButton.remove_child(this.panelSurface);
        // PanelMenu allocates its first child. Reserve the original clock slot
        // while that same live clock heads the expanding surface.
        this.panelPlaceholder = new St.Widget({width, height: Main.panel.height});
        this.panelButton.add_child(this.panelPlaceholder);
        this.panelHeader.set_child(this.panelSurface);
        this.panelAttached = true; this.foldWidth = undefined; this.applyStyle(); this.ears?.sync();
        if (!this.expanded && !this.dropActive) {
            this.surface.set_size(width, this.headerHeight);
            this.actor.set_size(width, this.headerHeight);
            this.actor.set_position(x, this.monitor.y + this.topInset);
            this.body.opacity = 0; this.nav.opacity = 0; this.headerActions.opacity = 0;
        }
    }
    returnPanelHeader() {
        if (!this.panelAttached) return;
        this.panelAttached = false; this.foldWidth = undefined;
        this.panelHeader.set_child(null);
        this.panelPlaceholder.destroy(); this.panelPlaceholder = null;
        this.panelButton.add_child(this.panelSurface);
        this.applyStyle(); this.ears?.sync();
    }
    // Chrome per mode: tabs show header, gap and tab bar; banners only the
    // header; search replaces even the clock; a drop shows the clock above it.
    animateSize(contentHeight) {
        const tabs = this.expanded && !this.peeking && this.page !== 'search' && !this.dropActive;
        const header = this.page !== 'search' || this.peeking || this.dropActive;
        this.headerActions.visible = tabs;
        const width = this.currentWidth, total = (header ? this.headerHeight : 0) + (tabs ? TOP_GAP : 0) + contentHeight + (tabs ? TABBAR_HEIGHT : 0);
        this.headerRow.visible = header; this.nav.visible = tabs;
        // Thunderstorm's page fills the surface while it morphs: its result list
        // takes what is left between the field and the footer, so the footer
        // stays inside the surface at every step of the spring. Tabs and banners
        // keep their designed height.
        const flexible = this.page === 'search' && this.expanded && !this.peeking && !this.dropActive;
        this.body.y_expand = flexible;
        this.body.height = flexible ? -1 : contentHeight + (tabs ? TOP_GAP : 0);
        tabs ? this.body.add_style_class_name('with-gap') : this.body.remove_style_class_name('with-gap');
        if (this.sizeTarget?.[0] === width && this.sizeTarget?.[1] === total) return;
        this.sizeTarget = [width, total]; this.foldWidth = undefined;
        this.surface.remove_all_transitions(); this.actor.remove_all_transitions();
        this.life.cancel(this.morphTimeout);
        const duration = this.settings.get_int('animation-duration');
        // Native GTK panes join below the header only once the surface has its final size.
        this.morphing = duration > 0; this.syncVisibility();
        for (const part of [this.body, this.nav, this.headerActions]) part.ease({opacity: 255, duration: Math.round(duration / 2), delay: Math.round(duration / 4)});
        // A spring: slightly past the target, then settle.
        const mode = Clutter.AnimationMode.EASE_OUT_BACK;
        this.surface.ease({width, height: total, duration, mode});
        this.targetX = this.centeredX(width);
        this.actor.ease({width, height: total, x: this.targetX, duration, mode});
        this.morphTimeout = this.life.later(duration, () => {
            this.morphTimeout = 0; this.morphing = false; this.syncVisibility();
            if (this.nativeShelf) this.companion.syncShelfVisibility();
            for (const actor of global.get_window_actors()) this.companion._positionWindow(actor.meta_window);
        });
    }
    beginDrop() {
        this.dateMenu.menu.close();
        if (this.peeking) { this.endPeek(); this.expanded = false; }
        this.dropRestore = {expanded: this.expanded, page: this.page, pinned: this.pinned};
        this.attachPanelHeader(); this.dropActive = true; this.applyStyle();
        this.body.hide(); this.animateSize(DROP_HEIGHT);
        this.syncVisibility();
    }
    endDrop() {
        this.dropActive = false; const restore = this.dropRestore; this.dropRestore = null; this.applyStyle();
        if (restore) {
            this.sizeTarget = null;
            if (restore.expanded) { this.open(restore.page); this.pinned = restore.pinned; }
            else this.close();
        }
        this.syncVisibility(); this.scheduleCollapse();
    }
    get nativeShelf() { return this.companion.shelfIsland === this; }
    get hovered() {
        if (this.panelButton?.hover) return true;
        if (!this.nativeShelf) return this.actor.hover;
        // With the native Regal the island is not reactive, so Clutter's hover
        // flag would keep whatever it was when that switched (and never clear):
        // the pointer is tested against the surface, the pane and its menu.
        const [x, y] = global.get_pointer(), [ax, ay] = this.actor.get_transformed_position();
        return this.companion.containsShelfPoint(x, y) || (x >= ax && x <= ax + this.actor.width && y >= ay && y <= ay + this.actor.height);
    }
    hoverChanged() {
        if (this.dropActive || this.extension.drops?.dragging) return;
        if (this.hovered) {
            this.cancelCollapse(); this.life.cancel(this.hoverTimeout);
            if (!this.expanded && !this.dateMenu.menu.isOpen && this.settings.get_boolean('hover-open')) this.hoverTimeout = this.life.later(this.settings.get_int('hover-delay'), () => { this.hoverTimeout = 0; if (this.hovered && !this.dateMenu.menu.isOpen && !this.dropActive && !this.extension.drops?.dragging) this.open(this.defaultPage); });
        } else { this.life.cancel(this.hoverTimeout); this.hoverTimeout = 0; this.scheduleCollapse(); }
    }
    // The page the island opens on: the Activities tab while the notch shows
    // an activity (a transfer, a timer, an agent that needs you …), else media.
    get defaultPage() {
        const focus = this.activities?.focus;
        return focus && focus.type !== 'media' && !focus.members.some(m => m.legacy) ? 'activities' : 'media';
    }
    open(page = this.defaultPage) {
        if (this.life.closed || this.dropActive) return; this.cancelCollapse(); this.life.cancel(this.hoverTimeout); this.hoverTimeout = 0;
        this.foldWidth = undefined;
        const fromPeek = this.peeking; this.endPeek(); this.clearHud();
        if (page !== 'shelf' && this.nativeShelf) this.companion.closeShelf();
        this.dateMenu.menu.close();
        this.attachPanelHeader();
        if (!this.expanded || fromPeek) for (const part of [this.body, this.nav, this.headerActions]) part.opacity = 0;
        else { this.body.remove_transition('opacity'); this.body.opacity = 255; }
        this.companion.startShelf();
        this.expanded = true; this.page = page;
        this.body.show(); this.applyStyle(); this.syncVisibility(); this.refresh();
        if (page === 'shelf') this.companion.openShelf(this);
        if (this.views.focusEntry && ['clipboard', 'search'].includes(page)) this.views.focusEntry.grab_key_focus();
    }
    refresh() {
        if (!this.expanded || this.peeking || this.dropActive || this.life.closed) return;
        if (this.nativeShelf) { this.companion.positionShelf(); return; }
        this.views.focusEntry = null;
        const content = this.views.make(this.page);
        this.body.destroy_all_children(); this.body.add_child(content);
        const shown = this.shownPage; this.shownPage = this.page;
        if (shown && shown !== this.page) this.slideIn(content, (TAB_INDEX[this.page] ?? -1) - (TAB_INDEX[shown] ?? -1));
        this.resize();
    }
    slideIn(content, direction) {
        // Tabs follow their direction, slightly scaled, as one spring.
        const duration = this.settings.get_int('animation-duration'); if (!duration) return;
        const fade = Math.min(220, duration);
        content.set_pivot_point(0.5, 0.5);
        content.translation_x = Math.sign(direction) * SLIDE; content.scale_x = content.scale_y = 0.97; content.opacity = 0;
        content.ease({opacity: 255, duration: fade, delay: Math.round(fade * 0.4), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        content.ease({translation_x: 0, scale_x: 1, scale_y: 1, duration, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }
    syncTabs() {
        const index = TAB_INDEX[this.page] ?? -1, x = TAB_INSET + index * TAB_WIDTH;
        for (const [name, b] of this.navButtons) {
            if (name === this.page) b.add_style_class_name('active'); else b.remove_style_class_name('active');
        }
        const duration = this.settings.get_int('animation-duration'), placed = this.tabIndicatorPlaced;
        this.tabIndicator.visible = index >= 0; if (index < 0) return;
        this.tabIndicatorPlaced = true;
        if (this.tabIndicator.x === x && !this.tabIndicator.get_transition('x')) return;
        if (!placed || !duration) { this.tabIndicator.remove_all_transitions(); this.tabIndicator.x = x; }
        else this.tabIndicator.ease({x, duration, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }
    togglePin() { this.pinned = !this.pinned; this.pinned ? this.cancelCollapse() : this.scheduleCollapse(); this.syncPin(); this.toast('view-pin-symbolic', this.pinned ? _('Stays open') : _('Closes when the pointer leaves')); }
    syncPin() { if (this.pinned) this.pinButton.add_style_class_name('active'); else this.pinButton.remove_style_class_name('active'); }
    resize() {
        if (!this.expanded || this.peeking || this.dropActive || this.life.closed) return;
        const content = this.body.get_first_child(); if (!content) return;
        const width = this.currentWidth; this.body.width = width;
        // Measured here, with the page on the stage and styled: Thunderstorm's
        // height follows its rows, capped to the screen below the bar.
        const height = this.page === 'search' ? Math.min(content.get_preferred_height(width)[1], this.monitor.height - this.topInset - 24) : CONTENT_HEIGHT[this.page] ?? 190;
        this.animateSize(height);
        this.syncTabs(); this.syncPin();
    }
    close(immediate = false) {
        // Folding an AirDrop question away is an answer: no.
        if (this.peekKind === 'airdrop-ask') this.airdrop?.question?.answer(false);
        // What waited for the island: the AirPods card, then a held-back notification.
        const card = this.airpodsPending && GLib.get_monotonic_time() - this.airpodsPending < 10000000 && this.peekKind !== 'airpods';
        // The card folds back into the pill with the battery, a moment.
        const fromCard = this.peekKind === 'airpods';
        const queued = this.peekKind === 'airpods' ? this.takeQueuedNotifications() : [];
        if (card || queued.length) {
            this.airpodsPending = 0;
            this.life.later(450, () => {
                if (card && this.airpods?.connected) this.airpodsEvent({type: 'connected', state: this.airpods.state});
                // Several held back: the newest is shown, as GNOME would show it last.
                const latest = queued.filter(n => !n.gone).at(-1)?.notification;
                this.releaseNotifications(queued);
                if (latest) this.notify(latest);
            });
        }
        if (this.life.closed) return; this.endPeek(); this.expanded = false;
        if (fromCard && this.airpods?.connected) this.showLink('connected', this.airpods.state, AIRPODS_AFTER); this.pinned = false; this.cancelCollapse(); this.life.cancel(this.hoverTimeout); this.hoverTimeout = 0;
        if (this.nativeShelf) this.companion.closeShelf();
        const focus = global.stage.get_key_focus(); if (focus && this.actor.contains(focus)) global.stage.set_key_focus(null);
        this.views.pageLife?.dispose(); this.views.menu?.close(); this.views.keyPress = null; this.body.hide(); this.nav.hide();
        this.headerRow.show(); this.shownPage = null; this.tabIndicatorPlaced = false; this.syncPin();
        this.surface.remove_all_transitions(); this.actor.remove_all_transitions();
        this.life.cancel(this.morphTimeout); this.morphTimeout = 0; this.morphing = false; this.sizeTarget = null;
        this.body.y_expand = false;
        if (!this.panelAttached) { this.applyStyle(); this.updateCompact(); this.syncVisibility(); return; }
        const duration = immediate ? 0 : this.settings.get_int('animation-duration');
        // The capsule's content first, then the width it needs now.
        this.applyStyle(); this.updateCompact();
        const width = this.foldWidth = this.compactWidth, height = this.headerHeight;
        this.headerActions.ease({opacity: 0, duration: Math.round(duration / 3)});
        this.surface.ease({width, height, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        this.targetX = this.centeredX(width);
        this.actor.ease({width, height, x: this.targetX, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        this.syncVisibility();
        // A mapped popup source must remain mapped for the calendar's lifetime.
        if (this.dateMenu.menu.isOpen) return;
        if (!duration) { this.returnPanelHeader(); this.syncVisibility(); }
        else this.morphTimeout = this.life.later(duration, () => { this.morphTimeout = 0; if (!this.expanded && !this.dropActive) { this.returnPanelHeader(); this.syncVisibility(); } });
    }
    // Shortcuts and clock clicks: hover never takes the keyboard from an app,
    // an explicit toggle does, so Esc and 1–4 work right away.
    toggle(page) {
        if (this.expanded && !this.peeking && (!page || this.page === page)) { this.close(); return; }
        this.open(page ?? this.defaultPage);
        if (this.expanded && !this.views.focusEntry?.has_key_focus?.() && !this.views.focusEntry?.clutter_text?.has_key_focus()) this.actor.grab_key_focus();
    }
    cancelCollapse() { this.life.cancel(this.collapseTimeout); this.collapseTimeout = 0; }
    scheduleCollapse() { this.cancelCollapse(); if (this.pinned || !this.expanded || this.page === 'search' || ['snap', 'airdrop', 'airdrop-ask'].includes(this.peekKind) || (this.nativeShelf && this.companion.shelfHeld) || this.views.menu?.isOpen) return;
        this.collapseTimeout = this.life.later(this.settings.get_int('collapse-delay'), () => { this.collapseTimeout = 0; if (!this.hovered && !this.pinned && !(this.nativeShelf && this.companion.shelfHeld) && !this.views.menu?.isOpen) this.close(); }); }

    // Live activities in the capsule: cover and waveform frame the clock;
    // volume and brightness replace them briefly; agents and file work speak.
    // Each part keeps its actor while it stays (MPRIS reports position and
    // metadata many times a minute): the waveform keeps drawing, the cover is
    // not reloaded and the capsule's width does not flicker.
    updateCompact() {
        if (this.life.closed) return;
        const state = this.settings.get_boolean('media-enabled') ? this.media.state : null;
        const activity = [...this.productivity.activities.values()].sort((a, b) => b.updated - a.updated)[0];
        // With Smart Live Activities the manager decides what the notch shows
        // (activities.js); HUD, toasts and the AirPods pill still borrow it briefly.
        const managed = Boolean(this.activities?.enabled), focus = managed ? this.activities.focus : null;
        const hud = this.hudState, toast = this.toastState, airdrop = !hud && !toast && (!managed || focus?.type === 'airdrop') ? this.airdropActivity : null;
        const center = {y_align: Clutter.ActorAlign.CENTER};
        const text = (key, cls, value) => ({key, make: () => label(value, cls, center), update: a => { if (a.text !== String(value)) a.text = String(value); }});
        const glyph = (key, cls, size, source) => ({key, make: () => new St.Icon({icon_size: size, style_class: cls, ...center}), update: a => setIcon(a, source)});
        const track = (key, cls, ratio) => ({key, make: () => { const t = new St.Widget({style_class: 'notchy-hud-track', width: 70, ...center}); t.add_child(new St.Widget({style_class: cls})); return t; },
            update: a => { const fill = a.get_first_child(); fill.set_style_class_name(cls); fill.width = Math.round(70 * Math.max(0, Math.min(1, ratio))); }});
        const shelfPill = count => ({key: 'shelf', make: () => {
            const pill = box(false, {style_class: 'notchy-shelf-pill', ...center});
            pill.add_child(new St.Icon({gicon: gicon('adwaita:package-x-generic-symbolic'), icon_size: 12, ...center}));
            pill.add_child(label(String(count), 'notchy-shelf-pill-count', center));
            return pill;
        }, update: a => { const text = a.get_last_child(); if (text.text !== String(count)) text.text = String(count); }});
        let left = [], right = [], wide = false, shelfInCapsule = false;
        if (airdrop) {
            left = [glyph('airdrop-icon', 'notchy-airdrop-icon', 16, airdrop.icon)];
            right = airdrop.progress !== null ? [track('airdrop-track', 'notchy-hud-fill notchy-airdrop-fill', airdrop.progress / 100), text('airdrop-value', 'notchy-hud-value', airdrop.progress)]
                : [text('airdrop-text', 'notchy-airdrop-text', airdrop.text)];
            wide = true;
        } else if (this.link && !hud) {
            // AirPods coming or going: the capsule widens into a pill.
            const link = this.link;
            left = [{key: `link-glyph-${link.shown}`, make: () => linkGlyph(link)}];
            right = [{key: `link-ring-${link.shown}`, make: () => linkRing(link)}];
            wide = true;
        } else if (toast && !hud) {
            // A new toast fades in once; redraws during the same toast keep it steady.
            const fade = actor => { actor.opacity = 0; actor.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD}); return actor; };
            const icon_ = glyph(`toast-icon-${toast.shown}`, 'notchy-toast-icon', 16, toast.icon), words = text(`toast-text-${toast.shown}`, 'notchy-toast-text', toast.text);
            left = [{...icon_, make: () => fade(icon_.make())}]; right = [{...words, make: () => fade(words.make())}];
            wide = true;
        } else if (hud) {
            left = [glyph('hud-icon', 'notchy-hud-icon', 17, hud.icon)];
            // A state without a level (Caps Lock): its words beside the clock.
            right = hud.level === null ? [text('hud-text', 'notchy-hud-text', hud.text)]
                : [track('hud-track', `notchy-hud-fill${hud.level > 1 ? ' boost' : ''}`, hud.level / (hud.max > 0 ? hud.max : 1)), text('hud-value', 'notchy-hud-value', Math.round(hud.level * 100))];
            wide = true;
        } else if (focus && focus.type !== 'media' && focus.type !== 'airdrop' && !focus.members.some(m => m.legacy)) {
            // The most important activity: a transfer's progress, a timer's
            // remaining time, a recording's red dot, an agent that needs you.
            ({left, right} = compactParts(focus, {agents: this.agents, animate: this.settings.get_boolean('activities-animations') && this.settings.get_int('animation-duration') > 0}));
            wide = true;
        } else {
            if (state) { left = [glyph('art', 'notchy-mini-art', 20, this.cover.file ?? 'audio-x-generic-symbolic')]; wide = true; }
            if (activity || (!managed && this.operations.busy)) right.push(text('activity', 'notchy-activity-text', activity ? activity.status : _('Processing…')));
            if (state?.playing && this.settings.get_boolean('media-waveform')) right.push({key: 'waveform', make: () => new Waveform(this.spectrum, 22, 13)});
            else if (state) right.push(glyph('media-state', '', 14, state.playing ? 'audio-volume-high-symbolic' : 'media-playback-pause-symbolic'));
            // The Regal's file count beside the clock while nothing else is
            // there; with company the round indicator beside the notch takes it.
            const files = this.shelf.items.length;
            shelfInCapsule = files > 0 && !state && !right.length;
            if (shelfInCapsule) { right.push(shelfPill(files)); wide = true; }
        }
        syncRow(this.leftRow, left); syncRow(this.rightRow, right);
        // A toast or the HUD only borrows the capsule: the count stays where it was.
        if (!airdrop && !toast && !hud) this.shelfInCapsule = shelfInCapsule;
        // The Regal's count and the AirPods pill are quiet indicators: no hover highlight on their slots.
        const quiet = shelfInCapsule || Boolean(this.link && !hud);
        for (const slot of [this.leftSlot, this.rightSlot]) quiet ? slot.add_style_class_name('notchy-slot-quiet') : slot.remove_style_class_name('notchy-slot-quiet');
        this.shelfBubble?.sync();
        this.compactFlags = {wide, hud: Boolean(hud), toasting: Boolean(toast && !hud)};
        this.syncCapsuleClass(); this.syncCompactGeometry();
        this.syncSecondHand(focus);
    }
    // A timer's or a recording's time in the notch moves once a second, and
    // only while one is shown; nothing ticks otherwise.
    syncSecondHand(focus) {
        const ticks = entryTicks(focus) && !this.hudState && !this.toastState && !(this.link && !this.hudState);
        if (ticks && !this.secondHand) this.secondHand = this.life.every(1000, () => this.updateCompact());
        else if (!ticks && this.secondHand) { this.life.cancel(this.secondHand); this.secondHand = 0; }
    }
    // AirDrop as a live activity: what the radio is doing right now.
    get airdropActivity() {
        const airdrop = this.airdrop; if (!airdrop) return null;
        if (airdrop.sendProc) return {icon: 'notchy-airdrop-symbolic', text: airdrop.send?.peer ? fmt(_('To %s'), airdrop.send.peer) : _('Looking for an iPhone…'), progress: null};
        if (airdrop.progress !== null) return {icon: 'notchy-airdrop-symbolic', progress: airdrop.progress};
        if (airdrop.state === 'restoring') return {icon: 'network-wireless-acquiring-symbolic', text: _('Wi-Fi reconnecting…'), progress: null};
        if (airdrop.receiving || airdrop.active) return {icon: 'notchy-airdrop-symbolic', text: airdrop.state === 'waking' ? _('Starting…') : airdrop.state === 'unreachable' ? _('No iPhone') : _('Visible'), progress: null};
        return null;
    }
    toggleAirDrop() {
        const airdrop = this.airdrop;
        if (!airdrop?.available) return;
        const on = !airdrop.receiving;
        if (airdrop.receive(on) && on) this.toast('notchy-airdrop-symbolic', _('AirDrop: visible, Wi-Fi paused'));
    }
    syncAirDrop() {
        if (this.life.closed) return;
        const airdrop = this.airdrop;
        this.airdropButton.visible = Boolean(airdrop?.available);
        airdrop?.receiving ? this.airdropButton.add_style_class_name('active') : this.airdropButton.remove_style_class_name('active');
        this.airdropButton.accessible_name = airdrop?.receiving ? _('AirDrop: stop receiving') : _('AirDrop: become visible to iPhones');
        // A transfer asking for consent always gets the notch, even over an open tab.
        if (airdrop?.question && this.peekKind !== 'airdrop-ask') {
            if (this.expanded && !this.peeking) this.close(true);
            const question = airdrop.question;
            this.peek('airdrop-ask', 0, () => this.views.airdropAskView(question));
        } else if (!airdrop?.question && this.peekKind === 'airdrop-ask') this.close();
        // A send shows its own view until it settles.
        if (airdrop?.send && ['searching', 'waiting', 'sending'].includes(airdrop.send.phase) && !airdrop.question && this.peekKind !== 'airdrop' && this.peekKind !== 'airdrop-ask') {
            if (this.expanded && !this.peeking) this.close(true);
            this.peek('airdrop', 0, () => this.views.airdropSendView());
        }
        if (airdrop?.state === 'error' && airdrop.detail && this.airdropErrorShown !== airdrop.detail) { this.airdropErrorShown = airdrop.detail; this.toast('dialog-warning-symbolic', _('AirDrop could not start')); }
        this.updateCompact();
    }
    // AirPods: connecting grows the capsule into a short banner with the
    // batteries filling up; low batteries and disconnecting are live activities.
    // The AirPods pill in the capsule: 'found' (they arrive, before the card),
    // 'connected' (after it, with the battery) or 'gone'.
    showLink(kind, state, duration) {
        const {left, right, single} = state?.battery ?? {left: null, right: null, single: null};
        const level = single ?? (left === null ? right : right === null ? left : Math.min(left, right));
        this.link = {kind, level: level ?? null, shown: GLib.get_monotonic_time()};
        this.life.cancel(this.linkTimeout);
        this.linkTimeout = duration ? this.life.later(duration, () => { this.linkTimeout = 0; this.link = null; this.updateCompact(); this.sides?.queue(); }) : 0;
        this.updateCompact(); this.sides?.queue();
    }
    clearLink() { if (!this.link) return; this.link = null; this.life.cancel(this.linkTimeout); this.linkTimeout = 0; this.updateCompact(); this.sides?.queue(); }
    // AirPods arriving, as the iPhone shows it: the capsule widens into a
    // pill (their symbol springs in, the battery ring draws), then the notch
    // springs open into the card, and folds back into the pill a moment
    // before it is the clock again. Leaving: the pill says „Getrennt“ and the
    // symbol turns grey and falls away.
    airpodsEvent(event) {
        if (this.life.closed) return;
        const name = event.state?.name || 'AirPods';
        const animated = this.settings.get_boolean('airpods-animation');
        if (event.type === 'connected') {
            if (!animated) { this.toast('notchy-airpods-symbolic', fmt(_('%s connected'), name)); return; }
            this.showLink('found', event.state, 0);
            this.life.cancel(this.linkCard);
            this.linkCard = this.life.later(AIRPODS_PILL, () => {
                this.linkCard = 0;
                const shown = this.peek('airpods', AIRPODS_CARD, () => this.views.airpodsPeekView());
                this.clearLink();
                // An open tab or a menu gets the card as soon as the island closes (within 10 s).
                if (!shown) this.airpodsPending = GLib.get_monotonic_time();
            });
        } else if (event.type === 'disconnected') {
            this.airpodsPending = 0;
            this.life.cancel(this.linkCard); this.linkCard = 0;
            if (this.peekKind === 'airpods') this.close();
            if (animated) this.showLink('gone', event.state, AIRPODS_GONE);
            else this.toast('notchy-airpods-symbolic', fmt(_('%s disconnected'), name));
        } else if (event.type === 'low') {
            // Translators: a low battery: "AirPods left: 10 %".
            const part = {left: _('left'), right: _('right'), case: _('Case')}[event.part] ?? '';
            this.toast('battery-caution-symbolic', fmt(_('%1$s: %2$s'), part ? `${name} ${part}` : name, formatPercent(event.level)));
        }
    }
    // Volume/brightness: inline in the closed capsule; GNOME's OSD otherwise.
    hud(gicon, text, level, maxLevel = 1) {
        if (this.life.closed || (this.expanded && !this.peeking) || !this.panelSurface.mapped) return false;
        this.hudState = {icon: gicon, text, level, max: maxLevel};
        this.life.cancel(this.hudTimeout);
        this.hudTimeout = this.life.later(level === null ? 1600 : 1300, () => { this.hudTimeout = 0; this.clearHud(); });
        this.updateCompact();
        return true;
    }
    clearHud() { if (!this.hudState) return; this.hudState = null; this.life.cancel(this.hudTimeout); this.hudTimeout = 0; this.updateCompact(); }
    scrollVolume(event) {
        if (this.expanded || !this.settings.get_boolean('scroll-volume')) return Clutter.EVENT_PROPAGATE;
        // A wheel step arrives as a discrete and a smooth event; count it once.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED) return Clutter.EVENT_STOP;
        const time = event.get_time(); if (time === this.scrollTime) return Clutter.EVENT_STOP; this.scrollTime = time;
        const direction = event.get_scroll_direction();
        let delta = direction === Clutter.ScrollDirection.UP ? 1 : direction === Clutter.ScrollDirection.DOWN ? -1 : 0;
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            this.scrollAccum = (this.scrollAccum ?? 0) - event.get_scroll_delta()[1];
            delta = Math.trunc(this.scrollAccum); this.scrollAccum -= delta;
        }
        if (!delta) return Clutter.EVENT_STOP;
        const level = this.system.stepVolume(delta * 0.04);
        if (level !== null) this.hud(this.system.volumeIcon(level), _('Volume'), level, 1);
        return Clutter.EVENT_STOP;
    }
    radialClick(event) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== Clutter.BUTTON_SECONDARY) return Clutter.EVENT_PROPAGATE;
        if (['clipboard', 'search'].includes(this.page) && this.expanded && this.body.contains(global.stage.get_event_actor(event))) return Clutter.EVENT_PROPAGATE;
        this.extension.radial?.open();
        return Clutter.EVENT_STOP;
    }
    // Notifications grow the capsule into a short banner below the clock.
    get canPeek() {
        return !this.life.closed && !this.dropActive && !(this.expanded && !this.peeking) && !Main.overview.visible && !this.dateMenu.menu.isOpen &&
            !(this.settings.get_boolean('hide-fullscreen') && global.display.get_monitor_in_fullscreen(this.monitor.index));
    }
    peek(kind, duration, build) {
        if (!this.canPeek) return false;
        this.life.cancel(this.peekTimeout); this.peekTimeout = 0; this.cancelCollapse(); this.clearHud();
        if (!this.peeking) {
            this.dateMenu.menu.close(); this.attachPanelHeader();
            this.peeking = true; this.expanded = true; this.page = 'peek';
            this.body.opacity = 0; this.body.show(); this.applyStyle();
        }
        this.peekKind = kind; this.peekView = build();
        this.body.destroy_all_children(); this.body.add_child(this.peekView.actor);
        const width = this.currentWidth; this.body.width = width;
        this.syncVisibility();
        this.animateSize(this.peekView.actor.get_preferred_height(width)[1]);
        // A banner stays while the pointer rests on it; leaving collapses as usual.
        if (duration) this.peekTimeout = this.life.later(duration, () => { this.peekTimeout = 0; if (!this.hovered) this.close(); });
        return true;
    }
    endPeek() {
        if (!this.peeking) return;
        this.peeking = false; this.peekKind = null; this.peekView = null; this.sizeTarget = null;
        this.life.cancel(this.peekTimeout); this.peekTimeout = 0;
        this.body.destroy_all_children();
    }
    // Snap layouts for a window dragged into the notch; stays until the drag ends.
    snap(window) {
        let view = null;
        return this.peek('snap', 0, () => (view = this.views.snapView(window))) ? view : null;
    }
    notify(notification) {
        // A notification arriving with the AirPods card (the system announcing the
        // same connection, say) waits until the card has been shown.
        if (this.peekKind === 'airpods') {
            this.queuedNotifications ??= [];
            const id = notification.connect('destroy', () => { this.queuedNotifications = this.queuedNotifications.filter(q => q.notification !== notification); });
            this.queuedNotifications.push({notification, id});
            return true;
        }
        // Critical notifications stay until dismissed, as GNOME's banners do.
        return this.peek('notification', notification.urgency === MessageTray.Urgency.CRITICAL ? 0 : 6000, () => this.views.notificationView(notification, () => this.close()));
    }
    // Held-back notifications, each marked once it is destroyed meanwhile.
    takeQueuedNotifications() {
        const queued = (this.queuedNotifications ?? []).map(({notification, id}) => {
            const entry = {notification, gone: false};
            notification.disconnect(id);
            entry.id = notification.connect('destroy', () => { entry.gone = true; });
            return entry;
        });
        this.queuedNotifications = [];
        this.waitingNotifications = [...(this.waitingNotifications ?? []), ...queued];
        return queued;
    }
    // Signals of held-back notifications that are still alive.
    releaseNotifications(entries) {
        for (const entry of entries) if (!entry.gone) { entry.gone = true; entry.notification.disconnect(entry.id); }
        this.waitingNotifications = (this.waitingNotifications ?? []).filter(entry => !entries.includes(entry));
    }
    // Short confirmations ("Copied to clipboard") as a live activity in
    // the capsule itself: the symbol left of the clock, the words right of it.
    // The capsule heads the opened surface too, so they show in both states.
    // Files landing in the Regal while the island is closed: the notch opens a
    // moment and they drop into it, the count rolling up (Views.shelfArrivalView).
    // Callers with their own words (AirDrop, a screenshot) toast after the add.
    // A drop into the drop zone lands while the zone is still open: the
    // arrival follows once it has folded away.
    shelfArrived() {
        const items = this.shelf.items, before = this.shelfCount, added = items.length - before;
        this.shelfCount = items.length;
        if (added <= 0 || (this.expanded && !this.peeking)) return;
        const arrived = items.slice(-added);
        const show = () => {
            if (this.peek('shelf', 2900, () => this.views.shelfArrivalView(arrived, before, this.shelf.items.length))) return;
            const name = arrived.at(-1).name;
            this.toast('adwaita:package-x-generic-symbolic', added === 1 ? fmt(_('In the Shelf · %s'), name.length > 28 ? `${name.slice(0, 27).trimEnd()}…` : name)
                : fmt(ngettext('%d file in the Shelf', '%d files in the Shelf', added), added));
        };
        if (this.dropActive) this.life.later(500, show); else show();
    }
    toast(iconName, text) {
        if (this.life.closed) return;
        this.toastState = {icon: gicon(iconName), text, shown: GLib.get_monotonic_time()};
        this.life.cancel(this.toastTimeout);
        this.toastTimeout = this.life.later(1900, () => { this.toastTimeout = 0; this.toastState = null; this.updateCompact(); });
        this.updateCompact();
    }
    syncVisibility() {
        this.actor.visible = (this.expanded || this.panelAttached) && !Main.overview.visible && !(this.settings.get_boolean('hide-fullscreen') && global.display.get_monitor_in_fullscreen(this.monitor.index));
        // The native pane shows through only once it is mapped at its final size;
        // until then the Shell preview of the shelf stays on top and cross-fades.
        const shelfShown = this.nativeShelf && this.companion.shelfMapped && !this.morphing;
        if (shelfShown || (this.dropActive && !this.morphing)) this.surface.add_style_class_name('notchy-native-joined');
        else this.surface.remove_style_class_name('notchy-native-joined');
        this.syncShade();
        // The page area keeps its size (the tab bar stays below the pane) but
        // must hold no reactive Shell actors above the native pane.
        if (this.nativeShelf && !shelfShown && !this.dropActive && !this.body.get_n_children()) { this.body.opacity = 255; this.body.add_child(this.views.make('shelf')); }
        if (shelfShown && this.body.get_n_children() && !this.body.get_transition('opacity')) {
            this.body.ease({opacity: 0, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => {
                if (this.nativeShelf && this.companion.shelfMapped) this.body.destroy_all_children();
                this.body.opacity = 255;
            }});
        }
        this.actor.reactive = !this.nativeShelf && !this.dropActive;
        // While the Regal's context menu is open, it may reach over the tab
        // bar; its clicks belong to the menu (or dismiss it), never to a tab.
        const menuOpen = this.nativeShelf && this.companion.menuOpen;
        for (const [, tab] of this.navButtons) tab.reactive = !menuOpen;
        if (this.nativeShelf) this.companion.syncShelfVisibility();
        this.ears?.sync(); this.sides?.queue();
    }
    dispose() {
        for (const {notification, id} of this.queuedNotifications ?? []) notification.disconnect(id);
        this.queuedNotifications = []; this.releaseNotifications(this.waitingNotifications ?? []);
        if (this.nativeShelf) this.companion.closeShelf();
        this.agentIndicators?.dispose(); this.agentIndicators = null;
        this.activityIndicators?.dispose(); this.activityIndicators = null;
        this.airpodsBubble?.dispose(); this.airpodsBubble = null;
        this.shelfBubble?.dispose(); this.shelfBubble = null;
        this.sides?.dispose(); this.sides = null;
        this.returnPanelHeader(); this.ears?.dispose(); this.paneLife?.dispose(); this.glass.destroy(); this.life.dispose(); this.views.dispose();
        this.dateMenu.menu.close();
        this.clockContainer.get_parent()?.remove_child(this.clockContainer);
        this.clockParent.insert_child_at_index(this.clockContainer, this.clockIndex);
        this.panelButton.destroy(); Main.layoutManager.removeChrome(this.actor); this.actor.destroy();
    }
}
