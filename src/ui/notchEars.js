import Cairo from 'cairo';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Lifetime} from '../lifecycle.js';

export const EAR_RADIUS = 10, EAR_MAX = 36;

// A hardware notch flows into the screen edge: its top corners curve outward.
// Two concave fillets sit left and right of the notch's top edge and follow
// the compact capsule or the expanding surface. They grow with the notch's
// height, so a deep surface flows into the edge with a wider, softer curve.
export function earRadius(height, headerHeight, limit = EAR_MAX) {
    return Math.round(Math.min(limit, EAR_RADIUS + Math.max(0, height - headerHeight) / 16));
}
export class NotchEars {
    constructor(island) {
        this.island = island; this.life = new Lifetime();
        this.left = this.ear(false); this.right = this.ear(true);
        for (const ear of [this.left, this.right]) Main.layoutManager.uiGroup.insert_child_above(ear, Main.layoutManager.panelBox);
        const sync = () => this.sync();
        for (const [actor, signals] of [[island.actor, ['notify::x', 'notify::y', 'notify::width', 'notify::visible', 'notify::mapped']],
            [island.surface, ['notify::width', 'notify::height', 'notify::mapped']], [island.panelSurface, ['notify::allocation', 'notify::mapped']],
            [island.panelButton, ['notify::allocation']], [Main.overview, ['showing', 'hidden']],
            // After login GNOME slides the bar in from above; the curves must follow it there.
            [Main.layoutManager.panelBox, ['notify::translation-y', 'notify::y', 'notify::allocation']], [Main.panel, ['notify::allocation']],
            [Main.layoutManager, ['startup-complete']]]) {
            if (actor) for (const signal of signals) this.life.connect(actor, signal, sync);
        }
        this.life.connect(island.settings, 'changed', sync);
        this.sync();
    }
    ear(mirror) {
        const actor = new St.DrawingArea({name: 'notchy-notch-ear', width: EAR_RADIUS, height: EAR_RADIUS, reactive: false, visible: false});
        actor.connect('repaint', () => {
            const cr = actor.get_context(), r = actor.width;
            try {
                cr.setSourceRGBA(0, 0, 0, 1);
                // Square minus a quarter disc whose centre is the corner away from the notch.
                if (mirror) { cr.moveTo(r, 0); cr.lineTo(0, 0); cr.lineTo(0, r); cr.arc(r, r, r, Math.PI, Math.PI * 1.5); }
                else { cr.moveTo(0, 0); cr.lineTo(r, 0); cr.lineTo(r, r); cr.arcNegative(0, r, r, 0, -Math.PI / 2); }
                cr.closePath();
                cr.setOperator(Cairo.Operator.SOURCE); cr.fill();
            } finally { cr.$dispose(); }
        });
        return actor;
    }
    get target() {
        const island = this.island;
        return island.panelAttached ? island.surface : island.panelSurface;
    }
    sync() {
        if (this.life.closed) return;
        const island = this.island, target = this.target;
        // Dynamic Glass hangs from the screen edge; Liquid Glass floats in the bar.
        const shown = island.settings.get_string('style') === 'dynamic' && target?.mapped && !Main.overview.visible &&
            (!island.panelAttached || island.actor.visible);
        const [x, y] = shown ? target.get_transformed_position() : [NaN, NaN];
        // Before its first allocation the target has no position yet.
        const placed = Number.isFinite(x) && Number.isFinite(y) && target.width > 0;
        for (const ear of [this.left, this.right]) ear.visible = Boolean(shown && placed);
        if (!shown || !placed) return;
        // Black fillets: never deeper than the notch's black part, so no black
        // curve ends beside glass.
        const height = island.panelAttached ? island.surface.height : target.height;
        const r = earRadius(height, island.headerHeight, Math.max(EAR_RADIUS, Math.min(EAR_MAX, island.blackFor(height))));
        for (const ear of [this.left, this.right]) if (ear.width !== r) { ear.set_size(r, r); ear.queue_repaint(); }
        this.left.set_position(Math.round(x) - r, Math.round(y));
        this.right.set_position(Math.round(x + target.width), Math.round(y));
    }
    dispose() { this.life.dispose(); this.left.destroy(); this.right.destroy(); }
}
