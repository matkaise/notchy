import St from 'gi://St';
import {GlassLayer} from './glass.js';
import {Lifetime} from '../lifecycle.js';

// Native GTK panes (Regal, drop zone) are windows, which sit below Shell
// chrome, so the island's glass leaves a hole for them. This layer lives in
// the window group directly below the pane and paints the very same glass
// there: the island's shape, position, blur, refraction and tint, clipped to
// the hole. Above and below the pane's edge the pixels therefore match
// exactly, so no seam shows. The pane itself only paints the black shade.
export class Backdrop {
    constructor(extension) {
        this.extension = extension; this.life = new Lifetime(); this.actor = null; this.glass = null;
        this.life.connect(global.display, 'restacked', () => this.sync());
        this.life.connect(extension.settings, 'changed::style', () => this.sync());
    }
    hide() { this.glass?.destroy(); this.glass = null; this.actor?.hide(); }
    sync() {
        if (this.life.closed) return;
        // The open Regal, or else the drop zone summoned by a drag.
        const companion = this.extension.companion, drops = this.extension.drops;
        const shelf = Boolean(companion?.shelfIsland && companion.shelfMapped && companion.position);
        const island = shelf ? companion.shelfIsland : drops?.island?.dropActive ? drops.island : null;
        const windowActor = (shelf ? companion.shelfWindow : companion?.dropWindow)?.get_compositor_private();
        const wanted = island && windowActor?.mapped && windowActor.visible && !island.morphing && !island.opaque && island.glassHole;
        if (!wanted) { this.hide(); return; }
        if (!this.actor) this.actor = new St.Widget({name: 'notchy-shelf-backdrop', reactive: false, clip_to_allocation: true});
        if (!this.glass) { this.glass = new GlassLayer(); this.actor.add_child(this.glass.actor); }
        const parent = windowActor.get_parent();
        if (this.actor.get_parent() !== parent) { this.actor.get_parent()?.remove_child(this.actor); parent.add_child(this.actor); }
        // Mutter restacks window actors on every stack change; stay just below the pane.
        if (windowActor.get_previous_sibling() !== this.actor) parent.set_child_below_sibling(this.actor, windowActor);
        // The island's hole in stage coordinates; the glass keeps the island's geometry.
        const [holeX, holeY, holeWidth, holeHeight] = island.glassHole, ox = island.actor.x, oy = island.actor.y;
        const x = Math.round(ox + holeX), y = Math.round(oy + holeY);
        this.actor.set_position(x, y); this.actor.set_size(Math.round(holeWidth), Math.round(holeHeight));
        this.glass.style(island.style, island.glassRadii);
        this.glass.place(ox - x, oy - y, island.surface.width, island.surface.height, [x, y]);
        this.actor.show();
    }
    dispose() { this.life.dispose(); this.glass?.destroy(); this.glass = null; this.actor?.destroy(); this.actor = null; }
}
