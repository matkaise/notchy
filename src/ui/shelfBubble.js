import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gicon, label} from './widgets.js';
import {_, ngettext, fmt} from '../i18n/core.js';
import {Lifetime} from '../lifecycle.js';

// After the AirPods and the agents: when room runs out, the Regal joins the "+N" group first.
const PRIORITY = 0.5;

// The Regal beside the notch while the capsule is busy (music, an activity):
// a small pill with its symbol and the number of files. Without such company the
// count sits inside the capsule itself (Island.updateCompact); a click opens
// the Regal. Its place comes from the island's SideIndicators.
export class ShelfBubble {
    constructor(island) {
        this.island = island; this.shelf = island.shelf; this.settings = island.settings; this.life = new Lifetime();
        this.button = new PanelMenu.Button(0.5, 'Regal', true);
        this.button.add_style_class_name('notchy-shelf-bubble-button');
        // A small black pill: the symbol and the count side by side, as in the capsule.
        const content = new St.BoxLayout({style_class: 'notchy-shelf-bubble', y_align: Clutter.ActorAlign.CENTER});
        content.add_child(new St.Icon({gicon: gicon('adwaita:package-x-generic-symbolic'), icon_size: 13, y_align: Clutter.ActorAlign.CENTER}));
        this.badge = label('', 'notchy-shelf-bubble-count', {y_align: Clutter.ActorAlign.CENTER});
        content.add_child(this.badge);
        this.content = content;
        this.button.add_child(content);
        this.life.connect(this.button, 'button-press-event', () => { this.island.open('shelf'); return Clutter.EVENT_STOP; });
        this.life.connect(this.button, 'key-press-event', (_actor, event) => {
            if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(event.get_key_symbol())) return Clutter.EVENT_PROPAGATE;
            this.island.open('shelf'); return Clutter.EVENT_STOP;
        });
        this.unplace = island.sides.add({id: 'shelf', actor: this.button.container, priority: () => PRIORITY, preferred: () => 'right',
            wanted: () => this.wanted, summary: () => this.summary()});
        this.life.cleanups.push(this.shelf.subscribe(() => this.sync()));
        this.life.connect(this.settings, 'changed::style', () => this.sync());
        this.sync();
    }
    get count() { return this.shelf.items.length; }
    // Only while the capsule has no room for the count itself.
    get wanted() { return this.count > 0 && !this.island.shelfInCapsule; }
    summary() {
        const count = this.count;
        return [{title: _('Shelf'), subtitle: fmt(ngettext('%d file', '%d files', count), count), icon: gicon('adwaita:package-x-generic-symbolic'), activate: () => this.island.open('shelf')}];
    }
    sync() {
        if (this.life.closed) return;
        const count = this.count, style = this.settings.get_string('style');
        this.content.set_style_class_name(`notchy-shelf-bubble notchy-${style}`);
        this.content.height = Math.max(22, Main.panel.height - (style === 'liquid' ? 6 : 4));
        this.badge.text = count > 99 ? '99+' : String(count);
        this.button.accessible_name = fmt(ngettext('Shelf: %d file', 'Shelf: %d files', count), count);
        this.island.sides.queue();
    }
    dispose() { this.life.dispose(); this.unplace(); this.button.destroy(); }
}
