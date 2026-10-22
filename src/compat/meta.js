import Meta from 'gi://Meta';
import {hasMethod} from './detect.js';

// Maximising. GNOME 49 dropped the direction flags: maximize() and
// unmaximize() take none and is_maximized() replaces get_maximized().
// GNOME 47/48 need Meta.MaximizeFlags (a call without them throws).
const FLAGLESS = hasMethod(Meta.Window, 'is_maximized');

// Maximised in both directions, as GNOME 49+ define it.
export function isMaximized(window) {
    return FLAGLESS ? window.is_maximized() : window.get_maximized() === Meta.MaximizeFlags.BOTH;
}

export function maximize(window) {
    if (FLAGLESS) window.maximize(); else window.maximize(Meta.MaximizeFlags.BOTH);
}

export function unmaximize(window) {
    if (FLAGLESS) window.unmaximize(); else window.unmaximize(Meta.MaximizeFlags.BOTH);
}
