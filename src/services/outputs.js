import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Emitter, Lifetime} from '../lifecycle.js';
import {_} from '../i18n/core.js';

// AirPlay receivers appear as RAOP sinks named "raop_sink.<host>…".
export const isAirPlay = sink => /^raop_sink\./.test(sink?.get_name?.() ?? '');

// Audio outputs for the media tab: the system's sinks plus AirPlay receivers.
// AirPlay discovery runs as a small PipeWire client (helper/airplay.conf)
// while enabled; switching works like GNOME's own output selector, so every
// stream that follows the default output moves along, the music included.
export class Outputs extends Emitter {
    constructor(extension, system, settings) {
        super(); this.extension = extension; this.mixer = system.mixer; this.system = system; this.settings = settings;
        this.life = new Lifetime(); this.proc = null; this.error = '';
        for (const signal of ['stream-added', 'stream-removed', 'default-sink-changed', 'state-changed'])
            this.life.connect(this.mixer, signal, () => this.changed());
        this.life.connect(settings, 'changed::airplay-enabled', () => this.sync());
        // Discovery starts shortly after login, or at once when the media tab asks.
        this.life.later(8000, () => this.sync());
    }
    ensure() { if (!this.proc) this.sync(); }
    get pidFile() { return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'notchy-airplay.pid']); }
    get discovering() { return Boolean(this.proc); }
    get list() {
        const active = this.mixer.get_default_sink();
        return this.mixer.get_sinks().filter(sink => sink.get_description())
            // GNOME's own wording: the port ("Lautsprecher", "HDMI / DisplayPort"), not the sound card.
            .map(sink => {
                const airplay = isAirPlay(sink), port = airplay ? '' : this.mixer.lookup_device_from_stream(sink)?.get_description();
                return {sink, name: port || sink.get_description(), airplay, active: sink === active, icon: sink.get_icon_name()};
            })
            // This computer's outputs first, then AirPlay receivers by name.
            .sort((a, b) => a.airplay - b.airplay || a.name.localeCompare(b.name));
    }
    get active() { return this.list.find(output => output.active) ?? null; }
    select(output) {
        const previous = this.mixer.get_default_sink();
        if (!output?.sink || output.sink === previous) return;
        // AirPlay receivers start at full volume; carry the current level over.
        if (output.airplay && previous) { output.sink.volume = previous.volume; output.sink.push_volume(); }
        const device = this.mixer.lookup_device_from_stream(output.sink);
        if (device) this.mixer.change_output(device); else this.mixer.set_default_sink(output.sink);
    }
    sync() {
        const wanted = this.settings.get_boolean('airplay-enabled');
        if (wanted && !this.proc) this.start();
        else if (!wanted && this.proc) this.stop();
        this.changed();
    }
    // A Shell crash cannot stop the client; end a leftover one so receivers never appear twice.
    reapStale() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this.pidFile);
            const pid = ok ? Number(new TextDecoder().decode(bytes).trim()) : 0;
            if (pid > 1) {
                const [found, cmdline] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
                if (found && new TextDecoder().decode(cmdline).includes('airplay.conf')) GLib.spawn_command_line_sync(`kill ${pid}`);
            }
        } catch { /* No leftover client. */ }
    }
    start() {
        this.reapStale(); this.error = '';
        try {
            const proc = Gio.Subprocess.new(['pipewire', '-c', `${this.extension.path}/helper/airplay.conf`], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            this.proc = proc;
            GLib.file_set_contents(this.pidFile, proc.get_identifier() ?? '');
            proc.wait_async(null, (p, result) => {
                try { p.wait_finish(result); } catch { /* Already ended. */ }
                if (this.proc !== p) return;
                this.proc = null; this.error = _('The AirPlay search has ended.'); this.changed();
            });
        } catch (e) { this.proc = null; this.error = _('PipeWire is not available.'); console.warn(`Notchy AirPlay: ${e.message}`); }
    }
    stop() {
        const proc = this.proc; this.proc = null;
        try { proc?.send_signal(15); } catch { /* Already ended. */ }
        try { GLib.unlink(this.pidFile); } catch { /* Already gone. */ }
    }
    dispose() { this.life.dispose(); this.stop(); this.listeners.clear(); }
}
