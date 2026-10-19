import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {Emitter, Lifetime} from '../lifecycle.js';
import {_} from '../i18n/core.js';
import {mprisMetadata, mprisActive} from '../model.js';

export function busCall(name, path, iface, method, parameters, cancellable = null) {
    return new Promise((resolve, reject) => Gio.DBus.session.call(name, path, iface, method,
        parameters, null, Gio.DBusCallFlags.NONE, 5000, cancellable, (conn, result) => {
            try { resolve(conn.call_finish(result).deep_unpack()); } catch (e) { reject(e); }
        }));
}
const PATH = '/org/mpris/MediaPlayer2';
const IFACE = 'org.mpris.MediaPlayer2.Player';
const TRACKS = 'org.mpris.MediaPlayer2.TrackList';
const prop = (proxy, name, fallback) => proxy?.get_cached_property(name)?.deep_unpack() ?? fallback;
const unpack = value => value instanceof GLib.Variant ? value.deep_unpack() : value;
const active = proxy => mprisActive(prop(proxy, 'PlaybackStatus', 'Stopped'), prop(proxy, 'Metadata', {}));

export class Media extends Emitter {
    constructor(settings) {
        super(); this.settings = settings; this.life = new Lifetime(); this.players = new Map(); this.pending = new Set();
        this.name = ''; this.position = 0; this.positionAt = Date.now(); this.clockPlaying = false; this.clockRate = 1; this.clockTrack = ''; this.positionGeneration = 0;
        this.queue = []; this.queueSupported = false; this.queueEditable = false; this.queueLoading = false; this.queueError = ''; this.queueGeneration = 0;
        const queueSubscription = Gio.DBus.session.signal_subscribe(null, TRACKS, null, PATH, null, Gio.DBusSignalFlags.NONE,
            (_c, sender) => { if (sender === this.proxy?.get_name_owner()) this.loadQueue(); });
        this.life.cleanups.push(() => Gio.DBus.session.signal_unsubscribe(queueSubscription));
        const queueProperties = Gio.DBus.session.signal_subscribe(null, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', PATH, TRACKS, Gio.DBusSignalFlags.NONE,
            (_c, sender) => { if (sender === this.proxy?.get_name_owner()) this.loadQueue(); });
        this.life.cleanups.push(() => Gio.DBus.session.signal_unsubscribe(queueProperties));
        this.subscription = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _m, args) => {
                const [name, old, owner] = args.deep_unpack(); if (!name.startsWith('org.mpris.MediaPlayer2.')) return;
                if (old) this.remove(name); if (owner && !this.life.closed) this.add(name);
            });
        this.life.cleanups.push(() => Gio.DBus.session.signal_unsubscribe(this.subscription));
        this.life.connect(settings, 'changed::preferred-player', () => this.choose());
        busCall('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null,
            this.life.cancellable).then(([names]) => {
            if (!this.life.closed) names.filter(n => n.startsWith('org.mpris.MediaPlayer2.')).forEach(n => this.add(n));
        }).catch(e => { if (!this.life.closed) console.warn(e.message); });
    }
    add(name) {
        if (this.players.has(name) || this.pending.has(name)) return; this.pending.add(name);
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, name, PATH, IFACE,
            this.life.cancellable, (_o, result) => {
                this.pending.delete(name);
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    if (this.life.closed || !proxy.get_name_owner()) return;
                    const changed = proxy.connect('g-properties-changed', (_proxy, properties) => { this.choose(name, properties.deep_unpack()); });
                    const signal = proxy.connect('g-signal', (_p, _s, signalName, params) => {
                        if (signalName === 'Seeked' && this.name === name) {
                            this.positionGeneration++; this.position = params.deep_unpack()[0]; this.positionAt = Date.now(); this.changed();
                        }
                    });
                    this.players.set(name, {proxy, changed, signal}); this.choose();
                } catch (e) { if (!this.life.closed) console.warn(`Notchy player: ${e.message}`); }
            });
    }
    remove(name) {
        const player = this.players.get(name);
        if (player) { player.proxy.disconnect(player.changed); player.proxy.disconnect(player.signal); this.players.delete(name); }
        this.choose();
    }
    choose(updated = '', properties = {}) {
        const preferred = this.settings.get_string('preferred-player');
        const old = this.name, elapsed = this.elapsed;
        // Only players with a track take part; a stopped, empty one (e.g. a
        // browser after its media tab closed) leaves the island.
        const live = [...this.players].filter(([_n, p]) => active(p.proxy));
        const has = name => live.some(([n]) => n === name);
        this.name = has(preferred) ? preferred :
            live.find(([_n, p]) => prop(p.proxy, 'PlaybackStatus', '') === 'Playing')?.[0] ??
            (has(old) ? old : live[0]?.[0] ?? '');
        if (old !== this.name || this.name === updated) {
            const state = this.state, track = state?.trackId && state.trackId !== '/' ? state.trackId : `${state?.url}\n${state?.title}`;
            const switched = old !== this.name || track !== this.clockTrack;
            this.positionGeneration++;
            this.position = Object.hasOwn(properties, 'Position') ? unpack(properties.Position) : switched ? 0 : elapsed;
            this.positionAt = Date.now(); this.clockPlaying = Boolean(state?.playing); this.clockTrack = track;
            const rate = prop(this.proxy, 'Rate', 1); this.clockRate = Number.isFinite(rate) && rate !== 0 ? rate : 1;
            if (this.name && (switched || Object.hasOwn(properties, 'PlaybackStatus') || Object.hasOwn(properties, 'Rate'))) this.refreshPosition();
        }
        if (old !== this.name) this.loadQueue();
        this.changed();
    }
    get proxy() { return this.players.get(this.name)?.proxy; }
    get state() {
        if (!this.proxy) return null;
        const root = this.players.get(this.name)?.root ?? {};
        return {name: unpack(root.Identity) || this.name.replace('org.mpris.MediaPlayer2.', ''), ...mprisMetadata(prop(this.proxy, 'Metadata', {})),
            canRaise: Boolean(unpack(root.CanRaise)), desktopEntry: unpack(root.DesktopEntry) || '',
            playing: prop(this.proxy, 'PlaybackStatus', '') === 'Playing',
            shuffle: prop(this.proxy, 'Shuffle', false), loop: prop(this.proxy, 'LoopStatus', 'None'),
            canSeek: prop(this.proxy, 'CanSeek', false), canNext: prop(this.proxy, 'CanGoNext', false),
            canPrevious: prop(this.proxy, 'CanGoPrevious', false), canControl: prop(this.proxy, 'CanControl', true),
            canPlay: prop(this.proxy, 'CanPlay', prop(this.proxy, 'CanControl', true)), canPause: prop(this.proxy, 'CanPause', prop(this.proxy, 'CanControl', true)),
            supportsShuffle: this.proxy.get_cached_property('Shuffle') !== null, supportsLoop: this.proxy.get_cached_property('LoopStatus') !== null};
    }
    get elapsed() { return Math.max(0, this.position + (this.clockPlaying ? (Date.now() - this.positionAt) * 1000 * this.clockRate : 0)); }
    refreshPosition() {
        const generation = this.positionGeneration, name = this.name;
        busCall(name, PATH, 'org.freedesktop.DBus.Properties', 'Get', new GLib.Variant('(ss)', [IFACE, 'Position']), this.life.cancellable).then(([value]) => {
            const position = unpack(value);
            if (!this.life.closed && generation === this.positionGeneration && name === this.name && Number.isFinite(position)) { this.position = position; this.positionAt = Date.now(); this.changed(); }
        }).catch(() => { /* Unsupported Position keeps the monotonic local estimate. */ });
    }
    async loadQueue() {
        const generation = ++this.queueGeneration, name = this.name;
        this.queue = []; this.queueSupported = false; this.queueEditable = false; this.queueError = ''; this.queueLoading = Boolean(name);
        if (!name || this.life.closed) return;
        const current = () => !this.life.closed && generation === this.queueGeneration && name === this.name;
        try {
            const [root] = await busCall(name, PATH, 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', ['org.mpris.MediaPlayer2']), this.life.cancellable);
            if (!current()) return;
            this.players.get(name).root = root; this.changed();
            if (!unpack(root.HasTrackList)) { this.queueLoading = false; this.changed(); return; }
            const [properties] = await busCall(name, PATH, 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', [TRACKS]), this.life.cancellable);
            if (!current()) return;
            this.queueSupported = true; this.queueEditable = Boolean(unpack(properties.CanEditTracks));
            const ids = (unpack(properties.Tracks) ?? []).slice(0, 500), queue = [];
            for (let at = 0; at < ids.length; at += 50) {
                const [metadata] = await busCall(name, PATH, TRACKS, 'GetTracksMetadata', new GLib.Variant('(ao)', [ids.slice(at, at + 50)]), this.life.cancellable);
                if (!current()) return;
                queue.push(...metadata.map(mprisMetadata));
            }
            if (current()) { this.queue = queue; this.queueLoading = false; this.changed(); }
        } catch (e) { if (current()) { this.queueLoading = false; this.queueError = _('This player offers no playlist.'); this.changed(); } }
    }
    trackCall(method, args) {
        if (!this.queueSupported || !this.name || this.life.closed) return;
        return busCall(this.name, PATH, TRACKS, method, args, this.life.cancellable).catch(e => {
            if (!this.life.closed) { this.queueError = e.message; this.changed(); }
        });
    }
    goTo(id) { if (this.queue.some(x => x.trackId === id)) return this.trackCall('GoTo', new GLib.Variant('(o)', [id])); }
    removeTrack(id) { if (this.queueEditable && this.queue.some(x => x.trackId === id)) return this.trackCall('RemoveTrack', new GLib.Variant('(o)', [id])); }
    addTrack(uri) {
        if (!this.queueEditable || !/^(file|https?):\/\//i.test(uri)) return;
        const after = this.queue.at(-1)?.trackId ?? '/org/mpris/MediaPlayer2/TrackList/NoTrack';
        return this.trackCall('AddTrack', new GLib.Variant('(sob)', [uri, after, false]));
    }
    call(method, args = null) {
        if (!this.name) return;
        return busCall(this.name, PATH, IFACE, method, args, this.life.cancellable).catch(e => {
            if (!this.life.closed) console.warn(`Notchy ${method}: ${e.message}`);
        });
    }
    async raise() {
        const state = this.state, name = this.name;
        if (!state || this.life.closed) return;
        if (state.canRaise) {
            try { await busCall(name, PATH, 'org.mpris.MediaPlayer2', 'Raise', null, this.life.cancellable); return; }
            catch { if (this.life.closed || name !== this.name) return; }
        }
        if (state.desktopEntry) {
            const id = state.desktopEntry.endsWith('.desktop') ? state.desktopEntry : `${state.desktopEntry}.desktop`;
            Shell.AppSystem.get_default().lookup_app(id)?.activate();
        }
    }
    seek(fraction) { const state = this.state;
        if (state?.canSeek && state.length && state.trackId !== '/')
            this.call('SetPosition', new GLib.Variant('(ox)', [state.trackId, Math.round(fraction * state.length)]));
    }
    set(name, value) {
        if (!this.name) return;
        busCall(this.name, PATH, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [IFACE, name, value]), this.life.cancellable).catch(e => {
            if (!this.life.closed) console.warn(e.message);
        });
    }
    dispose() { this.life.dispose(); for (const name of [...this.players.keys()]) this.remove(name); this.listeners.clear(); }
}
