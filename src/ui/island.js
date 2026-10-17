import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {GlassLayer} from './glass.js';
import {NotchEars} from './notchEars.js';
import {Views} from './views.js';
import {Waveform} from './waveform.js';
import {box, label, icon, gicon, button} from './widgets.js';
import {Lifetime} from '../lifecycle.js';

// Bottom tab bar (Droppy for GNOME): page, icon, label.
export const TABS = [['media', 'audio-x-generic-symbolic', 'Medien'], ['shelf', 'package-x-generic-symbolic', 'Regal'],
    ['clipboard', 'edit-paste-symbolic', 'Ablage'], ['calendar', 'x-office-calendar-symbolic', 'Kalender']];
const TAB_INDEX = Object.fromEntries(TABS.map(([page], i) => [page, i]));
// Content heights per tab; the surface morphs between them.
// Every tab has the same height, so switching tabs never makes the island jump.
export const PAGE_HEIGHT = 300;
export const CONTENT_HEIGHT = {media: PAGE_HEIGHT, shelf: PAGE_HEIGHT, clipboard: PAGE_HEIGHT, calendar: PAGE_HEIGHT};
// A compact, icon-only tab pill (as in Droppy); labels remain accessible names.
export const DROP_HEIGHT = 132;
export const TAB_WIDTH = 46, TAB_HEIGHT = 30, TAB_INSET = 3, TABBAR_HEIGHT = 50;
const TOP_GAP = 8, RADIUS = 30, SLIDE = 24;
const WIDTH = {search: 620, drop: 460, notification: 440, snap: 560};
const LIQUID_INSET = 3, FADE = 70;

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
        this.pinButton = button('view-pin-symbolic', 'Offen halten', () => this.togglePin(), 'notchy-round-button');
        this.headerActions.add_child(this.pinButton);
        this.headerActions.add_child(new St.Widget({x_expand: true}));
        // AirDrop: receiving on demand, only offered when its backend is installed.
        this.airdropButton = button('notchy-airdrop-symbolic', 'AirDrop: für iPhones sichtbar werden', () => this.toggleAirDrop(), 'notchy-round-button notchy-airdrop-button');
        this.headerActions.add_child(this.airdropButton);
        this.headerActions.add_child(button('emblem-system-symbolic', 'Einstellungen', () => extension.openPreferences(), 'notchy-round-button'));
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
            const b = new St.Button({style_class: 'notchy-tab', child: content, can_focus: true, accessible_name: `${i + 1} · ${text}`, track_hover: true, width: TAB_WIDTH, height: TAB_HEIGHT, x: TAB_INSET + i * TAB_WIDTH, y: TAB_INSET});
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
            // Entries consume typed digits first; elsewhere 1–4 select a tab.
            const tab = TABS[key - Clutter.KEY_1];
            if (this.expanded && !this.peeking && tab) { this.open(tab[0]); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
        this.life.connect(Main.overview, 'showing', () => { this.close(true); this.returnPanelHeader(); this.syncVisibility(); });
        this.life.connect(Main.overview, 'hidden', () => this.syncVisibility());
        this.life.connect(global.display, 'in-fullscreen-changed', () => this.syncVisibility());
        this.life.connect(this.settings, 'changed', (_s, key) => {
            this.applyStyle(); this.position(); this.syncVisibility(); this.updateCompact();
            if (this.expanded && !['animation-duration', 'hover-delay', 'collapse-delay'].includes(key)) { this.sizeTarget = null; this.refresh(); }
        });
        this.life.cleanups.push(this.media.subscribe(() => { this.updateCompact(); if (this.expanded && this.page === 'media') this.refresh(); }));
        this.life.cleanups.push(this.cover.subscribe(() => { this.updateCompact(); if (this.expanded && this.page === 'media') this.refresh(); }));
        this.life.cleanups.push(this.shelf.subscribe(() => { if (this.expanded && this.page === 'shelf') this.refresh(); }));
        this.life.cleanups.push(this.productivity.subscribe(() => this.updateCompact()));
        this.life.cleanups.push(this.operations.subscribe(() => this.updateCompact()));
        this.life.cleanups.push(this.companion.subscribe(() => this.syncVisibility()));
        if (this.airdrop) this.life.cleanups.push(this.airdrop.subscribe(() => this.syncAirDrop()));
        if (this.airpods) {
            this.life.cleanups.push(this.airpods.onEvent(event => this.airpodsEvent(event)));
            this.life.cleanups.push(this.airpods.subscribe(() => { if (this.expanded && !this.peeking && this.page === 'media' && !this.views.outputPicker) this.refresh(); }));
        }
        this.ears = new NotchEars(this);
        this.applyStyle(); this.updateCompact(); this.position(); this.syncVisibility(); this.syncAirDrop();
    }
    buildPanel() {
        // The capsule in the bar: left and right slots around GNOME's live clock.
        this.panelButton = new PanelMenu.Button(0.5, 'Notchy', true);
        this.panelButton.add_style_class_name('notchy-panel-button');
        // Reactive, so scroll (volume) and right click (radial menu) reach it.
        this.panelSurface = box(false, {y_expand: true, x_align: Clutter.ActorAlign.CENTER, reactive: true});
        this.leftSlot = new St.Button({style_class: 'notchy-slot notchy-slot-left', can_focus: true, accessible_name: 'Notchy öffnen'});
        this.leftRow = box(false, {style_class: 'notchy-slot-row', x_expand: true}); this.leftSlot.set_child(this.leftRow);
        this.rightSlot = new St.Button({style_class: 'notchy-slot notchy-slot-right', can_focus: true, accessible_name: 'Notchy öffnen'});
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
        if (this.peeking) return Math.max(this.peekKind === 'snap' ? WIDTH.snap : WIDTH.notification, this.panelCompactWidth ?? 0);
        return this.page === 'search' ? WIDTH.search : this.expandedWidth;
    }
    // Native panes start right below the clock row; the shelf pane includes the
    // page gap so nothing transparent remains between header and pane.
    get contentY() { return this.monitor.y + this.topInset + this.headerHeight; }
    get dropTop() { return this.contentY; }
    get shelfHeight() { return CONTENT_HEIGHT.shelf; }
    get shelfWindowHeight() { return CONTENT_HEIGHT.shelf + TOP_GAP; }
    applyStyle() {
        const style = this.style, attached = this.panelAttached;
        this.surface.set_style_class_name(`notchy-surface notchy-${style}${this.expanded || this.dropActive ? ' notchy-expanded' : ''}`);
        this.panelSurface.set_style_class_name(`notchy-capsule notchy-${style}${attached ? ' notchy-attached' : ''}${this.hudState ? ' notchy-hud' : ''}`);
        this.headerRow.height = this.headerHeight; this.panelHeader.height = this.headerHeight;
        this.syncShade();
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
        const width = this.expanded || this.dropActive ? this.currentWidth : this.panelSurface.width;
        this.actor.x = this.targetX = this.centeredX(width);
        this.actor.y = this.monitor.y + this.topInset;
        if (this.nativeShelf) this.companion.positionShelf();
    }
    centeredX(width) {
        let center = this.monitor.x + this.monitor.width / 2;
        if (this.panelButton?.mapped) { const [x] = this.panelButton.get_transformed_position(); center = x + this.panelButton.width / 2; }
        return Math.round(Math.max(this.monitor.x + 16, Math.min(this.monitor.x + this.monitor.width - width - 16, center - width / 2)));
    }
    attachPanelHeader() {
        if (this.panelAttached) return;
        const [x] = this.panelSurface.get_transformed_position();
        this.panelCompactWidth = this.panelSurface.width;
        this.panelButton.remove_child(this.panelSurface);
        // PanelMenu allocates its first child. Reserve the original clock slot
        // while that same live clock heads the expanding surface.
        this.panelPlaceholder = new St.Widget({width: this.panelCompactWidth, height: Main.panel.height});
        this.panelButton.add_child(this.panelPlaceholder);
        this.panelHeader.set_child(this.panelSurface);
        this.panelAttached = true; this.applyStyle(); this.ears?.sync();
        if (!this.expanded && !this.dropActive) {
            this.surface.set_size(this.panelCompactWidth, this.headerHeight);
            this.actor.set_size(this.panelCompactWidth, this.headerHeight);
            this.actor.set_position(x, this.monitor.y + this.topInset);
            this.body.opacity = 0; this.nav.opacity = 0; this.headerActions.opacity = 0;
        }
    }
    returnPanelHeader() {
        if (!this.panelAttached) return;
        this.panelAttached = false;
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
        this.body.height = contentHeight + (tabs ? TOP_GAP : 0);
        tabs ? this.body.add_style_class_name('with-gap') : this.body.remove_style_class_name('with-gap');
        if (this.sizeTarget?.[0] === width && this.sizeTarget?.[1] === total) return;
        this.sizeTarget = [width, total];
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
            if (!this.expanded && !this.dateMenu.menu.isOpen && this.settings.get_boolean('hover-open')) this.hoverTimeout = this.life.later(this.settings.get_int('hover-delay'), () => { this.hoverTimeout = 0; if (this.hovered && !this.dateMenu.menu.isOpen && !this.dropActive && !this.extension.drops?.dragging) this.open(); });
        } else { this.life.cancel(this.hoverTimeout); this.hoverTimeout = 0; this.scheduleCollapse(); }
    }
    open(page = 'media') {
        if (this.life.closed || this.dropActive) return; this.cancelCollapse(); this.life.cancel(this.hoverTimeout); this.hoverTimeout = 0;
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
    togglePin() { this.pinned = !this.pinned; this.pinned ? this.cancelCollapse() : this.scheduleCollapse(); this.syncPin(); this.toast('view-pin-symbolic', this.pinned ? 'Bleibt geöffnet' : 'Schließt beim Verlassen'); }
    syncPin() { if (this.pinned) this.pinButton.add_style_class_name('active'); else this.pinButton.remove_style_class_name('active'); }
    resize() {
        if (!this.expanded || this.peeking || this.dropActive || this.life.closed) return;
        const content = this.body.get_first_child(); if (!content) return;
        const width = this.currentWidth; this.body.width = width;
        const height = this.page === 'search' ? content.get_preferred_height(width)[1] : CONTENT_HEIGHT[this.page] ?? 190;
        this.animateSize(height);
        this.syncTabs(); this.syncPin();
    }
    close(immediate = false) {
        // Folding an AirDrop question away is an answer: no.
        if (this.peekKind === 'airdrop-ask') this.airdrop?.question?.answer(false);
        // What waited for the island: the AirPods card, then a held-back notification.
        const card = this.airpodsPending && GLib.get_monotonic_time() - this.airpodsPending < 10000000 && this.peekKind !== 'airpods';
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
        if (this.life.closed) return; this.endPeek(); this.expanded = false; this.pinned = false; this.cancelCollapse(); this.life.cancel(this.hoverTimeout); this.hoverTimeout = 0;
        if (this.nativeShelf) this.companion.closeShelf();
        const focus = global.stage.get_key_focus(); if (focus && this.actor.contains(focus)) global.stage.set_key_focus(null);
        this.views.pageLife?.dispose(); this.views.menu?.close(); this.views.keyPress = null; this.body.hide(); this.nav.hide();
        this.headerRow.show(); this.shownPage = null; this.tabIndicatorPlaced = false; this.syncPin();
        this.surface.remove_all_transitions(); this.actor.remove_all_transitions();
        this.life.cancel(this.morphTimeout); this.morphTimeout = 0; this.morphing = false; this.sizeTarget = null;
        if (!this.panelAttached) { this.applyStyle(); this.updateCompact(); this.syncVisibility(); return; }
        const duration = immediate ? 0 : this.settings.get_int('animation-duration');
        const width = this.panelCompactWidth, height = this.headerHeight;
        this.headerActions.ease({opacity: 0, duration: Math.round(duration / 3)});
        this.surface.ease({width, height, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        this.actor.ease({width, height, x: this.centeredX(width), duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        this.applyStyle(); this.updateCompact(); this.syncVisibility();
        // A mapped popup source must remain mapped for the calendar's lifetime.
        if (this.dateMenu.menu.isOpen) return;
        if (!duration) { this.returnPanelHeader(); this.syncVisibility(); }
        else this.morphTimeout = this.life.later(duration, () => { this.morphTimeout = 0; if (!this.expanded && !this.dropActive) { this.returnPanelHeader(); this.syncVisibility(); } });
    }
    // Shortcuts and clock clicks: hover never takes the keyboard from an app,
    // an explicit toggle does, so Esc and 1–4 work right away.
    toggle(page) {
        if (this.expanded && !this.peeking && (!page || this.page === page)) { this.close(); return; }
        this.open(page);
        if (this.expanded && !this.views.focusEntry?.has_key_focus?.() && !this.views.focusEntry?.clutter_text?.has_key_focus()) this.actor.grab_key_focus();
    }
    cancelCollapse() { this.life.cancel(this.collapseTimeout); this.collapseTimeout = 0; }
    scheduleCollapse() { this.cancelCollapse(); if (this.pinned || !this.expanded || this.page === 'search' || ['snap', 'airdrop', 'airdrop-ask'].includes(this.peekKind) || (this.nativeShelf && this.companion.shelfHeld) || this.views.menu?.isOpen) return;
        this.collapseTimeout = this.life.later(this.settings.get_int('collapse-delay'), () => { this.collapseTimeout = 0; if (!this.hovered && !this.pinned && !(this.nativeShelf && this.companion.shelfHeld) && !this.views.menu?.isOpen) this.close(); }); }

    // Live activities in the capsule: cover and waveform frame the clock;
    // volume and brightness replace them briefly; agents and file work speak.
    updateCompact() {
        if (this.life.closed) return;
        this.leftRow.destroy_all_children(); this.rightRow.destroy_all_children();
        const state = this.settings.get_boolean('media-enabled') ? this.media.state : null;
        const activity = [...this.productivity.activities.values()][0];
        let wide = false;
        const hud = this.hudState, toast = this.toastState, airdrop = !hud && !toast ? this.airdropActivity : null;
        if (airdrop) {
            const glyph = new St.Icon({gicon: gicon(airdrop.icon), icon_size: 16, style_class: 'notchy-airdrop-icon', y_align: Clutter.ActorAlign.CENTER});
            this.leftRow.add_child(glyph);
            if (airdrop.progress !== null) {
                const track = new St.Widget({style_class: 'notchy-hud-track', width: 70, y_align: Clutter.ActorAlign.CENTER});
                track.add_child(new St.Widget({style_class: 'notchy-hud-fill notchy-airdrop-fill', width: Math.round(70 * airdrop.progress / 100)}));
                this.rightRow.add_child(track);
                this.rightRow.add_child(label(String(airdrop.progress), 'notchy-hud-value', {y_align: Clutter.ActorAlign.CENTER}));
            } else this.rightRow.add_child(label(airdrop.text, 'notchy-airdrop-text', {y_align: Clutter.ActorAlign.CENTER}));
            wide = true;
        } else if (toast && !hud) {
            const glyph = new St.Icon({gicon: toast.icon, icon_size: 16, style_class: 'notchy-toast-icon', y_align: Clutter.ActorAlign.CENTER});
            const words = label(toast.text, 'notchy-toast-text', {y_align: Clutter.ActorAlign.CENTER});
            this.leftRow.add_child(glyph); this.rightRow.add_child(words);
            // Fade in once; later redraws during the same toast keep it steady.
            if (GLib.get_monotonic_time() - toast.shown < 100000) for (const actor of [glyph, words]) { actor.opacity = 0; actor.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD}); }
            wide = true;
        } else if (hud) {
            const glyph = new St.Icon({icon_size: 17, style_class: 'notchy-hud-icon', y_align: Clutter.ActorAlign.CENTER});
            if (typeof hud.icon === 'string') glyph.icon_name = hud.icon; else glyph.gicon = hud.icon;
            this.leftRow.add_child(glyph);
            if (hud.level === null) {
                // A state without a level (Caps Lock): its words beside the clock.
                this.rightRow.add_child(label(hud.text, 'notchy-hud-text', {y_align: Clutter.ActorAlign.CENTER}));
            } else {
                const track = new St.Widget({style_class: 'notchy-hud-track', width: 70, y_align: Clutter.ActorAlign.CENTER});
                const ratio = Math.max(0, Math.min(1, hud.level / (hud.max > 0 ? hud.max : 1)));
                track.add_child(new St.Widget({style_class: `notchy-hud-fill${hud.level > 1 ? ' boost' : ''}`, width: Math.round(70 * ratio)}));
                this.rightRow.add_child(track);
                this.rightRow.add_child(label(String(Math.round(hud.level * 100)), 'notchy-hud-value', {y_align: Clutter.ActorAlign.CENTER}));
            }
            wide = true;
        } else {
            if (state) {
                const art = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 20, style_class: 'notchy-mini-art', y_align: Clutter.ActorAlign.CENTER});
                if (this.cover.file) art.gicon = new Gio.FileIcon({file: this.cover.file});
                this.leftRow.add_child(art); wide = true;
            }
            if (activity || this.operations.busy) this.rightRow.add_child(label(activity ? activity.status : 'Verarbeitung …', 'notchy-activity-text', {y_align: Clutter.ActorAlign.CENTER}));
            if (state?.playing && this.settings.get_boolean('media-waveform')) this.rightRow.add_child(new Waveform(this.spectrum, 22, 13));
            else if (state) this.rightRow.add_child(icon(state.playing ? 'audio-volume-high-symbolic' : 'media-playback-pause-symbolic', 14));
        }
        wide ? this.panelSurface.add_style_class_name('notchy-wide') : this.panelSurface.remove_style_class_name('notchy-wide');
        hud ? this.panelSurface.add_style_class_name('notchy-hud') : this.panelSurface.remove_style_class_name('notchy-hud');
        toast && !hud ? this.panelSurface.add_style_class_name('notchy-toasting') : this.panelSurface.remove_style_class_name('notchy-toasting');
    }
    // AirDrop as a live activity: what the radio is doing right now.
    get airdropActivity() {
        const airdrop = this.airdrop; if (!airdrop) return null;
        if (airdrop.sendProc) return {icon: 'notchy-airdrop-symbolic', text: airdrop.send?.peer ? `An ${airdrop.send.peer}` : 'Sucht iPhone …', progress: null};
        if (airdrop.progress !== null) return {icon: 'notchy-airdrop-symbolic', progress: airdrop.progress};
        if (airdrop.state === 'restoring') return {icon: 'network-wireless-acquiring-symbolic', text: 'WLAN verbindet …', progress: null};
        if (airdrop.receiving || airdrop.active) return {icon: 'notchy-airdrop-symbolic', text: airdrop.state === 'waking' ? 'Startet …' : airdrop.state === 'unreachable' ? 'Kein iPhone' : 'Sichtbar', progress: null};
        return null;
    }
    toggleAirDrop() {
        const airdrop = this.airdrop;
        if (!airdrop?.available) return;
        const on = !airdrop.receiving;
        if (airdrop.receive(on) && on) this.toast('notchy-airdrop-symbolic', 'AirDrop: sichtbar, WLAN pausiert');
    }
    syncAirDrop() {
        if (this.life.closed) return;
        const airdrop = this.airdrop;
        this.airdropButton.visible = Boolean(airdrop?.available);
        airdrop?.receiving ? this.airdropButton.add_style_class_name('active') : this.airdropButton.remove_style_class_name('active');
        this.airdropButton.accessible_name = airdrop?.receiving ? 'AirDrop: Empfang beenden' : 'AirDrop: für iPhones sichtbar werden';
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
        if (airdrop?.state === 'error' && airdrop.detail && this.airdropErrorShown !== airdrop.detail) { this.airdropErrorShown = airdrop.detail; this.toast('dialog-warning-symbolic', 'AirDrop konnte nicht starten'); }
        this.updateCompact();
    }
    // AirPods: connecting grows the capsule into a short banner with the
    // batteries filling up; low batteries and disconnecting are live activities.
    airpodsEvent(event) {
        if (this.life.closed) return;
        const name = event.state?.name || 'AirPods';
        if (event.type === 'connected') {
            if (!this.settings.get_boolean('airpods-animation')) { this.toast('notchy-airpods-symbolic', `${name} verbunden`); return; }
            // An open tab or a menu gets the card as soon as the island closes (within 10 s).
            if (!this.peek('airpods', 6500, () => this.views.airpodsPeekView())) this.airpodsPending = GLib.get_monotonic_time();
        } else if (event.type === 'disconnected') {
            this.airpodsPending = 0;
            if (this.peekKind === 'airpods') this.close();
            this.toast('notchy-airpods-symbolic', `${name} getrennt`);
        } else if (event.type === 'low') {
            const part = {left: 'links', right: 'rechts', case: 'Case', single: ''}[event.part] ?? '';
            this.toast('battery-caution-symbolic', `${name}${part ? ` ${part}` : ''}: ${event.level} %`);
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
        if (level !== null) this.hud(this.system.volumeIcon(level), 'Lautstärke', level, 1);
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
    // Short confirmations ("In Zwischenablage kopiert") as a live activity in
    // the capsule itself: the symbol left of the clock, the words right of it.
    // The capsule heads the opened surface too, so they show in both states.
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
        this.ears?.sync();
    }
    dispose() {
        for (const {notification, id} of this.queuedNotifications ?? []) notification.disconnect(id);
        this.queuedNotifications = []; this.releaseNotifications(this.waitingNotifications ?? []);
        if (this.nativeShelf) this.companion.closeShelf();
        this.returnPanelHeader(); this.ears?.dispose(); this.paneLife?.dispose(); this.glass.destroy(); this.life.dispose(); this.views.dispose();
        this.dateMenu.menu.close();
        this.clockContainer.get_parent()?.remove_child(this.clockContainer);
        this.clockParent.insert_child_at_index(this.clockContainer, this.clockIndex);
        this.panelButton.destroy(); Main.layoutManager.removeChrome(this.actor); this.actor.destroy();
    }
}
