import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Lifetime} from '../lifecycle.js';
import {DROP_HEIGHT} from '../ui/island.js';

const TYPE = Meta.SelectionType.SELECTION_DND;

// A prestarted GTK receiver participates in the real Wayland data-device
// protocol; Shell actors alone cannot accept a native application's file drop.
export class Drops {
    constructor(extension) {
        this.extension = extension; this.life = new Lifetime(); this.island = null;
        this.position = null; this.receivers = new Map(); this.backend = 'wayland'; this.dragging = false; this.hovering = false; this.poll = 0;
        this.selection = global.display.get_selection();
        this.life.connect(this.selection, 'owner-changed', (_s, type, owner) => {
            if (type !== TYPE) return;
            if (owner) {
                const ownerType = String(owner);
                const backend = /X11/.test(ownerType) ? 'x11' : /Wayland/.test(ownerType) ? 'wayland' : global.display.focus_window?.get_client_type() === Meta.WindowClientType.X11 ? 'x11' : 'wayland';
                if (backend !== this.backend) this.hide();
                this.backend = backend; this.startReceiver(backend);
            }
            this.setDragging(Boolean(owner && owner.get_mimetypes().some(mime => ['text/uri-list', 'application/vnd.portal.filetransfer'].includes(mime))));
        });
        this.life.connect(extension.settings, 'changed::drag-summon', () => {
            if (!extension.settings.get_boolean('drag-summon')) this.hide();
        });
        this.life.connect(Main.overview, 'showing', () => this.hide());
        this.startReceiver('wayland');
        if (GLib.getenv('DISPLAY')) this.startReceiver('x11');
    }
    get ready() { return this.receivers.get(this.backend)?.ready ?? false; }
    get proc() { return this.receivers.get(this.backend)?.proc ?? null; }
    startReceiver(backend) {
        if (this.life.closed || this.receivers.get(backend)?.proc) return;
        const receiver = {ready: false, proc: null}; this.receivers.set(backend, receiver);
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            launcher.setenv('GDK_BACKEND', backend, true);
            receiver.proc = launcher.spawnv(['/usr/bin/python3', `${this.extension.path}/helper/drop.py`, backend]);
            receiver.proc.wait_async(this.life.cancellable, (proc, result) => {
                try { proc.wait_finish(result); } catch { /* Disabled. */ }
                if (!this.life.closed) { receiver.ready = false; receiver.proc = null; if (backend === this.backend) this.hide(); }
            });
        } catch (error) { console.warn(`Notchy drop target: ${error.message}`); }
    }
    setDragging(active) {
        if (active === this.dragging) return;
        this.dragging = active; this.serial = (this.serial ?? 0) + 1; const serial = this.serial; this.life.cancel(this.poll); this.poll = 0;
        if (active) { this.poll = this.life.every(35, () => this.motion(...global.get_pointer())); this.motion(...global.get_pointer()); }
        else {
            // Allow GTK to finish its drop callback before unmapping the surface.
            this.life.later(180, () => { if (!this.dragging && serial === this.serial) this.hide(); });
        }
    }
    motion(x, y) {
        if (!this.dragging || !this.extension.settings.get_boolean('drag-summon') || Main.overview.visible) return;
        // Some clients retain the DND selection owner after the drag ends.
        // An owner alone must never turn a later ordinary hover into a drag.
        if (!(global.get_pointer()[2] & Clutter.ModifierType.BUTTON1_MASK)) { this.setDragging(false); return; }
        // Never unmap a native source mid-drag. The open file pane already
        // accepts Wayland drops; X11 offers use their matching receiver.
        const companion = this.extension.companion;
        // An open Regal is itself the drop target (with its own highlight); a
        // second drop zone above it would show two effects for one drag.
        if (companion.shelfHeld || companion.shelfIsland) return;
        if (this.island && this.position) {
            const p = this.position;
            if (x >= p.x - 64 && x <= p.x + p.width + 64 && y >= this.island.monitor.y && y <= p.y + p.height + 64) return;
            this.hide();
        }
        const island = this.extension.islands.find(candidate => {
            if (candidate.settings.get_boolean('hide-fullscreen') && global.display.get_monitor_in_fullscreen(candidate.monitor.index)) return false;
            const anchor = candidate.panelButton ?? candidate.actor;
            const [ax, ay] = anchor.get_transformed_position();
            const width = candidate.expanded ? candidate.currentWidth : anchor.width;
            const height = candidate.expanded ? candidate.surface.height : anchor.height;
            const left = candidate.expanded ? candidate.centeredX(width) : ax;
            return x >= left - 64 && x <= left + width + 64 && y >= candidate.monitor.y && y <= ay + height + 48;
        });
        if (island) this.show(island);
    }
    show(island) {
        if (this.life.closed || !this.ready) return;
        this.hide(); this.island = island;
        const width = 460, height = DROP_HEIGHT;
        this.position = {x: island.centeredX(width), y: island.dropTop, width, height};
        island.life.cancel(island.hoverTimeout); island.hoverTimeout = 0; island.cancelCollapse();
        island.beginDrop();
        this.extension.companion.dropTarget({visible: true, backend: this.backend, joined: true, style: island.settings.get_string('style'), shade: island.dropShade, airdrop: Boolean(this.extension.airdrop?.available), ...this.position});
    }
    hide() {
        this.extension.companion?.dropTarget({visible: false});
        if (this.island && !this.island.life.closed) { this.island.endDrop(); }
        this.island = null; this.position = null; this.hovering = false;
    }
    accepted(text) {
        const count = this.extension.shelf.add(text);
        const island = this.island; this.setDragging(false); const serial = this.serial;
        this.life.later(120, () => {
            if (serial !== this.serial) return;
            this.hide();
            if (island && !island.life.closed) { island.open('shelf'); island.scheduleCollapse(); }
        });
        return count;
    }
    // Dropped on the AirDrop zone: the zone folds away, then the notch shows the send.
    airdropped(text) {
        const airdrop = this.extension.airdrop;
        const paths = text.split(/\r?\n/).filter(Boolean).map(uri => Gio.File.new_for_uri(uri).get_path()).filter(Boolean);
        if (!airdrop?.available || airdrop.sendProc || !paths.length) return false;
        this.setDragging(false); const serial = this.serial;
        this.life.later(120, () => { if (serial === this.serial) this.hide(); airdrop.sendFiles(paths); });
        return true;
    }
    receiverReady(backend) { const receiver = this.receivers.get(backend); if (receiver) receiver.ready = true; if (backend === this.backend && this.dragging) this.motion(...global.get_pointer()); }
    dispose() { this.hide(); this.life.dispose(); for (const receiver of this.receivers.values()) receiver.proc?.force_exit(); this.receivers.clear(); }
}
