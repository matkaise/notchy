// Platform-independent part of the audio outputs, shared by GJS and the Node test suite.

// How long an output must have been in place, and a receiver on the network,
// before a switch between them counts as the person's own.
export const SETTLE_MS = 3000;

// Only the person sends the sound to another room. Other programs switch to an
// AirPlay receiver on their own: Sunshine sets back whatever was the output
// when a stream began, and WirePlumber returns to a remembered receiver the
// moment it shows up again, so the sound ends up in the bedroom after a game.
// The guard tells such a switch from a choice: a receiver picked in Notchy, or
// one chosen in GNOME's own menu from a settled output of this computer.
// Outputs are {name, airplay, local}; local means a sound card of this computer.
export class OutputGuard {
    constructor() { this.chosen = null; this.current = null; this.since = 0; this.stray = false; this.home = null; this.appeared = new Map(); }
    pick(output) { this.chosen = output?.airplay ? output.name : null; }
    appear(output, now) { if (output?.airplay) this.appeared.set(output.name, now); }
    // True while the output is an AirPlay receiver nobody chose; it should go back to this computer.
    check(sink, now, exists) {
        if (sink?.name === this.current?.name) return this.stray;
        const previous = this.current, since = this.since;
        this.current = sink ?? null; this.since = now; this.stray = false;
        if (!sink?.airplay) {
            if (sink?.local) this.home = sink.name;
            // Leaving the chosen receiver for this computer ends the choice; losing it for a moment does not.
            if (sink?.local && (!previous?.airplay || exists(previous.name))) this.chosen = null;
            return false;
        }
        if (sink.name === this.chosen) return false;
        const settled = previous && exists(previous.name) && now - since >= SETTLE_MS
            && now - (this.appeared.get(sink.name) ?? -Infinity) >= SETTLE_MS;
        if (settled && (previous.local || previous.name === this.chosen)) { this.chosen = sink.name; return false; }
        return (this.stray = true);
    }
}

// Where the sound goes back to: the last output of this computer, else any of them.
export function homeOutput(outputs, last) {
    const local = outputs.filter(output => output.local);
    return local.find(output => output.name === last) ?? local[0] ?? null;
}
