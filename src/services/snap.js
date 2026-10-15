import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {TilePreview} from 'resource:///org/gnome/shell/ui/windowManager.js';
import {Lifetime} from '../lifecycle.js';
import {zoneRect} from '../model.js';

// Snap layouts in the notch: dragging a window up to the clock opens the
// island with a row of layouts; releasing over a zone places the window
// there. During the move Mutter holds the pointer, so Shell actors get no
// hover events: the pointer is polled and tested against the zones instead.
// The hovered zone is previewed with GNOME's own tile preview, the same
// translucent area that edge tiling shows.
export class Snap {
    constructor(extension) {
        this.extension = extension; this.life = new Lifetime(); this.window = null; this.poll = 0; this.view = null; this.target = null;
        this.life.connect(global.display, 'grab-op-begin', (_display, window, op) => this.begin(window, op));
        this.life.connect(global.display, 'grab-op-end', () => this.end());
    }
    get island() { return this.extension.activeIsland(); }
    begin(window, op) {
        if (!this.extension.settings.get_boolean('snap-enabled')) return;
        if (op !== Meta.GrabOp.MOVING && op !== Meta.GrabOp.MOVING_UNCONSTRAINED) return;
        if (!window || window.get_window_type() !== Meta.WindowType.NORMAL || !window.allows_resize()) return;
        this.window = window; this.life.cancel(this.poll);
        this.poll = this.life.every(40, () => this.motion(...global.get_pointer()));
    }
    // The capsule in the bar, widened a little: where a dragged window summons the layouts.
    near(x, y) {
        const anchor = this.island?.panelButton; if (!anchor?.mapped) return false;
        const [ax, ay] = anchor.get_transformed_position();
        return x >= ax - 60 && x <= ax + anchor.width + 60 && y >= ay - 4 && y <= ay + anchor.height + 6;
    }
    motion(x, y) {
        const island = this.island; if (!island || !this.window) return;
        if (!this.view) {
            if (this.near(x, y)) this.view = island.snap(this.window);
            return;
        }
        // Leaving the opened island (with some slack) closes the layouts again.
        const [ix, iy] = island.actor.get_transformed_position();
        if (x < ix - 40 || x > ix + island.actor.width + 40 || y > iy + island.actor.height + 40) { this.hide(); return; }
        let hit = null;
        for (const zone of this.view.zones) {
            const [zx, zy] = zone.actor.get_transformed_position();
            if (x >= zx && x < zx + zone.actor.width && y >= zy && y < zy + zone.actor.height) hit = zone;
        }
        if (hit === this.target) return;
        this.target?.actor.remove_style_class_name('hover'); this.target?.tile.remove_style_class_name('hover');
        this.target = hit;
        hit?.actor.add_style_class_name('hover'); hit?.tile.add_style_class_name('hover');
        if (!hit) { this.preview?.close(); return; }
        this.preview ??= new TilePreview();
        const monitor = island.monitor.index, rect = zoneRect(Main.layoutManager.getWorkAreaForMonitor(monitor), hit.zone);
        this.preview.open(this.window, new Mtk.Rectangle(rect), monitor);
    }
    hide() {
        this.preview?.close();
        if (this.view && this.island?.peekKind === 'snap') this.island.close();
        this.view = null; this.target = null;
    }
    end() {
        this.life.cancel(this.poll); this.poll = 0;
        const window = this.window, target = this.target;
        this.window = null; this.hide();
        // Mutter finishes its own move first; then the window takes its zone.
        if (window && target) GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this.place(window, target.zone); return GLib.SOURCE_REMOVE; });
    }
    place(window, zone) {
        if (this.life.closed || !window.get_compositor_private()) return;
        const island = this.island, monitor = island?.monitor.index ?? window.get_monitor();
        if (zone.every((v, i) => v === [0, 0, 1, 1][i])) { window.maximize(); return; }
        if (window.is_maximized()) window.unmaximize();
        const rect = zoneRect(Main.layoutManager.getWorkAreaForMonitor(monitor), zone);
        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        island?.toast('view-grid-symbolic', 'Fenster angeordnet');
    }
    dispose() { this.life.dispose(); this.preview?.destroy(); this.preview = null; this.window = null; this.view = null; }
}
