import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gicon} from '../ui/widgets.js';

// Notchy's own notifications (agents waiting or finished, a timer that ran
// out): one message-tray source, made when the first one is sent and removed
// with Notchy. They go through GNOME's message tray, so Do Not Disturb and
// the notification settings apply, and Notchy's banner shows them in the
// island. They carry status only — an agent's name, its project folder's
// name, its state — never a prompt or anything an agent wrote.
export class Notifier {
    constructor() { this.source = null; }
    // {title, body, icon (name), urgent, sound (a sound theme id), activate,
    // quiet: straight into the message list without a banner — the notch
    // announces it already}
    send({title, body = '', icon = 'notchy-agent-symbolic', urgent = false, sound = null, activate = null, quiet = false}) {
        if (!this.source) {
            this.source = new MessageTray.Source({title: 'Notchy', iconName: 'notchy-agent-symbolic'});
            this.source.connect('destroy', () => { this.source = null; });
            Main.messageTray.add(this.source);
        }
        const notification = new MessageTray.Notification({source: this.source, title, body, gicon: gicon(icon), isTransient: !urgent && !quiet,
            urgency: urgent ? MessageTray.Urgency.HIGH : MessageTray.Urgency.NORMAL});
        // Acknowledged before it is added: neither GNOME nor Notchy show a banner for it.
        if (quiet) notification.acknowledged = true;
        if (activate) notification.connect('activated', () => { try { activate(); } catch (e) { console.error(e); } });
        this.source.addNotification(notification);
        if (sound) { try { global.display.get_sound_player().play_from_theme(sound, title, null); } catch { /* No sound theme. */ } }
        return notification;
    }
    dispose() { this.source?.destroy(); this.source = null; }
}
