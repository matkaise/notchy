import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

// GNOME Shell internals Notchy relies on. All of them are unchanged from
// GNOME 47 to 51 (docs/COMPATIBILITY.md lists the checks); they stay behind
// this module so a later rename is handled here, and so a missing one costs
// a feature, never the Shell.

// The top bar's three boxes. Panel keeps them as private fields; they are
// also its children named panelLeft, panelCenter and panelRight.
export function panelBoxes() {
    const panel = Main.panel, named = name => panel.get_children().find(child => child.name === name) ?? null;
    return {left: panel._leftBox ?? named('panelLeft'), center: panel._centerBox ?? named('panelCenter'), right: panel._rightBox ?? named('panelRight')};
}

// GNOME's OSD (volume, brightness) passes every monitor's popup through
// OsdWindowManager._showOsdWindow(monitorIndex, icon, label, level, maxLevel).
// handler returns true when it showed the OSD itself.
export function overrideOsd(injections, handler) {
    const manager = Main.osdWindowManager;
    if (typeof manager?._showOsdWindow !== 'function') {
        console.warn('Notchy: GNOME\'s OSD cannot be replaced on this version; it stays as it is.');
        return false;
    }
    injections.overrideMethod(manager, '_showOsdWindow', original => function (index, icon, text, level, maxLevel) {
        if (!handler(index, icon, text, level, maxLevel)) return original.call(this, index, icon, text, level, maxLevel);
    });
    return true;
}

// A popup menu switch's new state. On GNOME 47 (GJS 1.82.0) 'toggled' reports
// true even when the switch was just turned off, while the item's own state
// is already right; reading the item is right on every release.
export function onSwitchToggled(item, callback) {
    return item.connect('toggled', () => callback(item.state));
}

// GNOME's keyboard-layout keybindings (Super+Space), which Notchy borrows
// while there is a single layout. They belong to the InputSourceManager.
const INPUT_SOURCE_FIELDS = {'switch-input-source': '_keybindingAction', 'switch-input-source-backward': '_keybindingActionBackward'};
export function canBorrowInputSourceKeys() {
    return typeof getInputSourceManager()?._switchInputSource === 'function';
}
export function restoreInputSourceKey(name, settings, flags) {
    const manager = getInputSourceManager();
    manager[INPUT_SOURCE_FIELDS[name]] = Main.wm.addKeybinding(name, settings, flags, Shell.ActionMode.ALL, manager._switchInputSource.bind(manager));
}
