import GObject from 'gi://GObject';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// Feature detection for the GNOME versions Notchy supports (see
// docs/COMPATIBILITY.md). The other compat modules ask what an API offers,
// not which version is running; the version is only reported for diagnostics.
export const shellVersion = Config.PACKAGE_VERSION;
export const shellMajor = Number.parseInt(shellVersion, 10) || 0;

// A GObject property on a registered class, without creating an instance.
export function hasProperty(klass, name) {
    try { return Boolean(GObject.Object.find_property.call(klass, name)); } catch { return false; }
}

export function hasMethod(klass, name) { return typeof klass?.prototype?.[name] === 'function'; }
