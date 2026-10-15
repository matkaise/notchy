import Gio from 'gi://Gio';
import {Emitter, Lifetime} from '../lifecycle.js';

export class Spectrum extends Emitter {
    constructor(extension, media, system, settings) {
        super(); this.extension = extension; this.media = media; this.system = system; this.settings = settings; this.life = new Lifetime(); this.levels = Array(12).fill(0); this.device = ''; this.error = ''; this.proc = null; this.haveFrame = false;
        this.life.cleanups.push(media.subscribe(() => this.sync()));
        this.life.connect(system.mixer, 'default-sink-changed', () => this.sync());
        this.life.connect(system.mixer, 'state-changed', () => this.sync());
        this.life.connect(settings, 'changed::media-waveform', () => this.sync());
        this.life.connect(settings, 'changed::media-enabled', () => this.sync()); this.sync();
    }
    sync() {
        const sink = this.system.mixer.get_default_sink();
        const device = this.settings.get_boolean('media-enabled') && this.settings.get_boolean('media-waveform') && this.media.state?.playing && sink?.get_name() ? `${sink.get_name()}.monitor` : '';
        if (device === this.device && (!device || this.proc)) return;
        this.stop(); this.device = device; this.error = ''; if (device) this.start(device);
    }
    start(device, test = false) {
        this.capture = new Lifetime();
        const args = ['/usr/bin/python3', `${this.extension.path}/helper/spectrum.py`, ...(test ? ['--test-tone'] : ['--device', device])];
        try {
            const proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE); this.proc = proc;
            const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()}); const capture = this.capture;
            let reading = false, streamClosed = false;
            const close = () => { if (streamClosed) return; streamClosed = true;
                stream.close_async(0, null, (s, result) => { try { s.close_finish(result); } catch { /* Already closed. */ } });
            };
            const read = () => { reading = true; stream.read_line_async(0, capture.cancellable, (input, result) => {
                reading = false;
                try {
                    const [line] = input.read_line_finish_utf8(result);
                    if (capture.closed) { close(); return; }
                    if (line === null) { this.haveFrame = false; this.levels = Array(12).fill(0); this.changed(); close(); return; }
                    if (line.length <= 4096) {
                        const frame = JSON.parse(line);
                        if (Array.isArray(frame.levels) && frame.levels.length === 12 && frame.levels.every(x => Number.isFinite(x) && x >= 0 && x <= 1)) { this.levels = frame.levels; this.haveFrame = true; this.changed(); }
                        if (frame.error) { this.error = 'Audio-Monitor nicht verfügbar.'; this.levels = Array(12).fill(0); this.changed(); }
                    }
                    read();
                } catch (e) { if (!capture.closed) { this.error = e.message; this.levels = Array(12).fill(0); this.changed(); } close(); }
            }); }; read();
            proc.wait_async(null, (p, result) => { try { p.wait_finish(result); if (this.proc === p) this.proc = null; if (!capture.closed && !p.get_successful()) { this.error = 'Audioanalyse konnte nicht gestartet werden.'; this.haveFrame = false; this.levels = Array(12).fill(0); this.changed(); } } catch { /* Already ended. */ } });
            capture.cleanups.push(() => { try { if (proc.get_identifier()) proc.send_signal(15); } catch { /* Already exited. */ } if (!reading) close(); });
        } catch (e) { this.error = e.message; this.capture.dispose(); this.capture = null; }
    }
    stop() { this.capture?.dispose(); this.capture = null; this.proc = null; this.haveFrame = false; this.levels = Array(12).fill(0); this.changed(); }
    dispose() { this.life.dispose(); this.stop(); this.listeners.clear(); }
}
