// One place for everything that differs between the supported GNOME
// versions (47–51). Components import from here instead of asking for
// versions themselves; docs/COMPATIBILITY.md describes each difference.
import {shellVersion} from './detect.js';
import {shaderBackend} from './clutter.js';

export {shellVersion, shellMajor, hasProperty, hasMethod} from './detect.js';
export {backend, keymap, boxOrientation, connectKeyPress, shaderEffect, shaderBackend} from './clutter.js';
export {isMaximized, maximize, unmaximize} from './meta.js';
export {panelBoxes, overrideOsd, onSwitchToggled, canBorrowInputSourceKeys, restoreInputSourceKey} from './shell.js';

// One line in the journal per Shell session (extension.js), for bug reports.
export function describe() { return `GNOME Shell ${shellVersion}, shaders through ${shaderBackend}`; }
