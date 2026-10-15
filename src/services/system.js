import Shell from 'gi://Shell';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Emitter, Lifetime} from '../lifecycle.js';

const VOLUME_ICONS = ['audio-volume-muted-symbolic', 'audio-volume-low-symbolic', 'audio-volume-medium-symbolic', 'audio-volume-high-symbolic'];

// Output volume for the island's scroll gesture and app lookup for the search.
export class System extends Emitter {
    constructor() { super(); this.life = new Lifetime(); this.mixer = getMixerControl(); }
    get sink() { return this.mixer.get_default_sink(); }
    get volume() { const sink = this.sink; return sink ? (sink.is_muted ? 0 : sink.volume / this.mixer.get_vol_max_norm()) : null; }
    volumeIcon(level) { return VOLUME_ICONS[level <= 0 ? 0 : level < 0.34 ? 1 : level < 0.67 ? 2 : 3]; }
    setVolume(stream, fraction) { stream.volume = Math.round(fraction * this.mixer.get_vol_max_norm()); stream.push_volume(); if (fraction > 0) stream.change_is_muted(false); }
    // Returns the new level, or null without an output device.
    stepVolume(delta) {
        const sink = this.sink, current = this.volume; if (!sink || current === null) return null;
        const level = Math.max(0, Math.min(1, Math.round((current + delta) * 100) / 100));
        this.setVolume(sink, level); if (level === 0) sink.change_is_muted(true);
        return level;
    }
    apps(query) { const system = Shell.AppSystem.get_default(); return system.get_installed().filter(info => info.should_show() && info.get_name().toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 15).map(info => system.lookup_app(info.get_id())).filter(Boolean); }
    dispose() { this.life.dispose(); this.listeners.clear(); }
}
