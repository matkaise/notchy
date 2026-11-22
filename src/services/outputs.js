import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import {Emitter, Lifetime} from '../lifecycle.js';
import {OutputGuard, homeOutput} from './outputModel.js';
import {_} from '../i18n/core.js';

// AirPlay receivers appear as RAOP sinks named "raop_sink.<host>…".
export const isAirPlay = sink => /^raop_sink\./.test(sink?.get_name?.() ?? '');
// Sinks without a sound card are receivers or virtual ones (Sunshine's, a null sink).
const NO_CARD = 0xffffffff;
const describe = sink => sink && {name: sink.get_name(), airplay: isAirPlay(sink), local: !isAirPlay(sink) && sink.get_card_index() !== NO_CARD};

// Audio outputs for the media tab: the system's sinks plus AirPlay receivers.
// AirPlay discovery runs as a small PipeWire client (helper/airplay.conf)
// while enabled; switching works like GNOME's own output selector, so every
// stream that follows the default output moves along, the music included.
// A receiver nobody chose is left again for this computer (see OutputGuard).
export class Outputs extends Emitter {
    constructor(extension, system, settings) {
        super(); this.extension = extension; this.mixer = system.mixer; this.system = system; this.settings = settings;
        this.life = new Lifetime(); this.proc = null; this.error = ''; this.guard = new OutputGuard(); this.pending = 0;
        this.life.connect(this.mixer, 'stream-added', (_mixer, id) => this.guard.appear(describe(this.mixer.lookup_stream_id(id)), Date.now()));
        for (const signal of ['stream-added', 'stream-removed', 'default-sink-changed', 'state-changed'])
            this.life.connect(this.mixer, signal, () => { this.watchSoon(); this.changed(); });
        this.watchSoon();
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
        this.guard.pick(describe(output.sink));
        // AirPlay receivers start at full volume; carry the current level over.
        if (output.airplay && previous) { output.sink.volume = previous.volume; output.sink.push_volume(); }
        this.route(output.sink);
    }
    // Through GNOME's selector, so WirePlumber remembers it, and Sunshine finds it when the next stream begins.
    route(sink) {
        const device = this.mixer.lookup_device_from_stream(sink);
        if (device) this.mixer.change_output(device); else this.mixer.set_default_sink(sink);
    }
    // Programs switch in several quick steps (Sunshine: its own sink, a fallback, the receiver); judge where they end.
    watchSoon() { this.life.cancel(this.pending); this.pending = this.life.later(400, () => { this.pending = 0; this.watch(); }); }
    watch() {
        // Receivers are Notchy's business only while it searches for them itself.
        if (!this.settings.get_boolean('airplay-enabled') || this.mixer.get_state() !== Gvc.MixerControlState.READY) return;
        const sinks = this.mixer.get_sinks(), find = name => sinks.find(sink => sink.get_name() === name);
        const sink = this.mixer.get_default_sink();
        if (!this.guard.check(describe(sink), Date.now(), name => Boolean(find(name)))) return;
        // Without an output of this computer the receiver stays until one appears.
        const home = homeOutput(sinks.map(describe), this.guard.home);
        if (!home) return;
        console.log(`Notchy AirPlay: ${sink.get_description()} was not chosen, back to ${home.name}`);
        this.route(find(home.name));
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
