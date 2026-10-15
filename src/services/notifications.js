import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Emitter, Lifetime} from '../lifecycle.js';

// GNOME's notification list, read from the message tray for the Heute page.
// Notifications stay owned by GNOME; Notchy only lists, opens and dismisses them.
export class Notifications extends Emitter {
    constructor() {
        super(); this.life = new Lifetime(); this.sources = new Set();
        this.desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this.life.connect(this.desktop, 'changed::show-banners', () => this.changed());
        for (const source of Main.messageTray.getSources()) this.watch(source);
        this.life.connect(Main.messageTray, 'source-added', (_tray, source) => { this.watch(source); this.changed(); });
        this.life.connect(Main.messageTray, 'source-removed', (_tray, source) => { this.sources.delete(source); this.changed(); });
    }
    watch(source) {
        if (this.sources.has(source)) return; this.sources.add(source);
        this.life.connect(source, 'notification-added', () => this.changed());
        this.life.connect(source, 'notification-removed', () => this.changed());
    }
    get items() {
        return [...this.sources].flatMap(source => source.notifications)
            .sort((a, b) => (b.datetime?.to_unix() ?? 0) - (a.datetime?.to_unix() ?? 0));
    }
    get doNotDisturb() { return !this.desktop.get_boolean('show-banners'); }
    set doNotDisturb(value) { this.desktop.set_boolean('show-banners', !value); }
    clear() {
        // Resident notifications (e.g. running downloads) keep their place, as in GNOME's list.
        for (const notification of this.items) if (!notification.resident) notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
    }
    dispose() { this.life.dispose(); this.sources.clear(); this.listeners.clear(); }
}
