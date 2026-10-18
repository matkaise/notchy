import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Lifetime} from '../lifecycle.js';
import {planSides} from './sideLayout.js';
import {box, label} from './widgets.js';

// Gap between the indicators and GNOME's other panel items.
const MARGIN = 16;
const SPACING = 6;
// The gap between the notch and the first indicator (the frames' padding).
const PAD = 10;

// The two rows beside the notch, in the bar's centre box right before and
// after Notchy's capsule. Indicators (AirPods, agents) register here; this
// decides their side (sideLayout.js), keeps both rows equally wide so the
// notch stays centred, hides them while the island is open (its surface
// covers that place) and gathers what does not fit into a "+N" group.
export class SideIndicators {
    constructor(island) {
        this.island = island; this.settings = island.settings; this.life = new Lifetime();
        this.items = new Map(); this.sides = new Map(); this.order = 0; this.pending = 0;
        // Each side: a frame of the shared width, its row aligned to the notch.
        this.leftRow = box(false, {style_class: 'notchy-side-row', x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this.rightRow = box(false, {style_class: 'notchy-side-row', x_expand: true, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
        this.left = new St.Bin({style_class: 'notchy-side notchy-side-left', child: this.leftRow, y_expand: true, visible: false});
        this.right = new St.Bin({style_class: 'notchy-side notchy-side-right', child: this.rightRow, y_expand: true, visible: false});
        const center = Main.panel._centerBox, notchy = island.panelButton.container;
        center.insert_child_below(this.left, notchy); center.insert_child_above(this.right, notchy);
        this.groups = {left: this.group('left'), right: this.group('right')};
        const relayout = () => this.queue();
        for (const [actor, signals] of [[Main.panel._leftBox, ['notify::width']], [Main.panel._rightBox, ['notify::width']], [Main.panel, ['notify::width', 'notify::height']],
            [island.actor, ['notify::visible']], [Main.overview, ['showing', 'hidden']], [island.panelSurface, ['notify::width']]]) {
            for (const signal of signals) this.life.connect(actor, signal, relayout);
        }
        this.life.connect(this.settings, 'changed', (_s, key) => { if (key.startsWith('agents-') || key === 'style') this.queue(); });
    }
    // A "+N" button per side; its menu lists what did not fit.
    group(side) {
        const button = new PanelMenu.Button(0.5, 'Weitere Indikatoren', false);
        button.add_style_class_name('notchy-side-button');
        const content = new St.Widget({style_class: 'notchy-side-group', layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        const count = label('', 'notchy-side-group-count', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        content.add_child(count); button.add_child(content);
        button.menu.box.add_style_class_name('notchy-agent-menu');
        Main.panel.menuManager.addMenu(button.menu);
        button.container.visible = false;
        (side === 'left' ? this.leftRow : this.rightRow).add_child(button.container);
        // Rows read the agents' current state each time the group opens.
        this.life.connect(button.menu, 'open-state-changed', (_m, open) => { if (open) this.fillGroup(side); });
        return {button, content, count, ids: []};
    }
    fillGroup(side) {
        const group = this.groups[side], menu = group.button.menu;
        menu.removeAll();
        for (const id of group.ids) {
            const item = this.items.get(id); if (!item) continue;
            for (const row of item.summary?.() ?? []) {
                const entry = new PopupMenu.PopupBaseMenuItem({style_class: 'notchy-agent-row'});
                const column = box(true, {x_expand: true});
                column.add_child(label(row.title, 'notchy-agent-row-title'));
                if (row.subtitle) column.add_child(label(row.subtitle, 'notchy-agent-row-sub'));
                if (row.icon) entry.add_child(new St.Icon({gicon: row.icon, icon_size: 16, style_class: 'notchy-agent-row-icon'}));
                entry.add_child(column);
                if (row.activate) entry.connect('activate', () => row.activate()); else entry.reactive = false;
                menu.addMenuItem(entry);
            }
        }
    }
    // item: {id, actor, priority(), preferred() → 'left' | 'right' | null, wanted() → bool, summary() → rows}
    add(item) {
        this.items.set(item.id, {...item, order: this.order++});
        // On the stage from the start (hidden), so it can be measured styled.
        item.actor.visible = false; this.rightRow.add_child(item.actor);
        this.queue();
        return () => { this.items.delete(item.id); this.sides.delete(item.id); item.actor.get_parent()?.remove_child(item.actor); this.queue(); };
    }
    queue() { if (!this.pending && !this.life.closed) this.pending = this.life.later(0, () => { this.pending = 0; this.relayout(); }); }
    // Room for indicators on each side: half of what the bar leaves beside the
    // capsule, less GNOME's left and right boxes and anything else in the
    // centre box, less a margin.
    get capacity() {
        const panel = Main.panel, center = panel._centerBox;
        const ours = new Set([this.left, this.right, this.island.panelButton.container]);
        const others = center.get_children().filter(child => !ours.has(child) && child.visible).reduce((sum, child) => sum + child.get_preferred_width(-1)[1], 0);
        const capsule = this.island.panelAttached ? this.island.panelPlaceholder?.width ?? 0 : this.island.panelSurface.get_preferred_width(-1)[1];
        // GNOME centres the clock in the work area (beside a dock), not on the
        // monitor; the room on each side follows the same offset (panel.js).
        const monitor = Main.layoutManager.findMonitorForActor(panel);
        const area = monitor ? Main.layoutManager.getWorkAreaForMonitor(monitor.index) : null;
        const offset = monitor && area ? 2 * (area.x - monitor.x) + area.width - monitor.width : 0;
        const middle = (panel.width + offset) / 2, half = (capsule + others) / 2;
        const left = middle - half - panel._leftBox.get_preferred_width(-1)[1];
        const right = panel.width - (middle + half) - panel._rightBox.get_preferred_width(-1)[1];
        return Math.max(0, Math.floor(Math.min(left, right) - MARGIN - PAD));
    }
    get shown() { return !this.island.actor.visible && !this.island.life.closed; }
    relayout() {
        if (this.life.closed) return;
        const shown = this.shown;
        const wanted = [...this.items.values()].filter(item => item.wanted());
        // Measured where they are, without showing them: making an indicator
        // visible in one row and then moving it to the other stopped its
        // appear animation half-way and left it invisible (opacity 0).
        const measured = wanted.map(item => {
            return {id: item.id, order: item.order, priority: item.priority(), preferred: item.preferred?.() ?? null, width: Math.ceil(item.actor.get_preferred_width(-1)[1])};
        });
        const plan = planSides(measured, this.capacity, this.sides, {auto: this.settings.get_boolean('agents-auto-layout'), spacing: SPACING, groupWidth: Math.max(26, Main.panel.height - 4)});
        for (const [id, side] of plan.sides) this.sides.set(id, side);
        const placed = new Set();
        for (const side of ['left', 'right']) {
            const row = side === 'left' ? this.leftRow : this.rightRow, group = this.groups[side];
            // Left of the notch: the group outermost, the first placed nearest the notch.
            const ids = side === 'left' ? [...plan.visible.left].reverse() : plan.visible.right;
            const sequence = side === 'left' ? [group.button.container, ...ids.map(id => this.items.get(id).actor)] : [...ids.map(id => this.items.get(id).actor), group.button.container];
            sequence.forEach((actor, index) => {
                const parent = actor.get_parent();
                if (parent !== row) {
                    parent?.remove_child(actor); row.insert_child_at_index(actor, index);
                    // A move to the other side fades in.
                    if (parent && parent !== this.rightRow) { actor.opacity = 0; actor.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD}); }
                } else if (row.get_child_at_index(index) !== actor) row.set_child_at_index(actor, index);
            });
            for (const id of ids) { this.items.get(id).actor.visible = true; placed.add(id); }
            group.button.container.visible = plan.hidden[side].length > 0;
            // A PopupMenu never opens while empty: the list is kept current.
            const changed = group.ids.join() !== plan.hidden[side].join();
            group.ids = plan.hidden[side];
            if (changed) this.fillGroup(side);
            group.count.text = `+${group.ids.length}`;
            group.content.set_style_class_name(`notchy-side-group notchy-${this.settings.get_string('style')}`);
            const size = Math.max(22, Main.panel.height - (this.settings.get_string('style') === 'liquid' ? 6 : 4));
            group.content.set_size(Math.max(size, 30), size);
            if (!group.ids.length && group.button.menu.isOpen) group.button.menu.close();
        }
        for (const item of this.items.values()) if (!placed.has(item.id)) item.actor.visible = false;
        // Equal widths: the notch keeps its place in the middle of the bar.
        const width = plan.width ? plan.width + PAD : 0;
        for (const row of [this.left, this.right]) {
            row.visible = shown && width > 0;
            if (row.width !== width) row.width = width;
        }
        if (!shown) for (const group of Object.values(this.groups)) if (group.button.menu.isOpen) group.button.menu.close();
        this.island.ears?.sync();
    }
    // Where an indicator sits now ('left', 'right' or null if grouped or hidden).
    sideOf(id) { const item = this.items.get(id); return item?.actor.visible && item.actor.get_parent()?.visible ? this.sides.get(id) ?? null : null; }
    dispose() {
        this.life.dispose();
        for (const group of Object.values(this.groups)) group.button.destroy();
        for (const item of this.items.values()) item.actor.get_parent()?.remove_child(item.actor);
        this.items.clear();
        this.left.destroy(); this.right.destroy();
    }
}
