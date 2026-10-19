// Thunderstorm's built-in commands: a stable catalog shared by the launcher
// (src/launcher/providers.js adds how each one runs and when it is available),
// the preferences (Thunderstorm → System Commands) and the Node tests.
//
// Every command is known by its id ('system.shutdown'), never by its title:
// titles are msgids translated for display, the usage history and the user's
// settings refer to ids. Search terms (`keywords`) are deliberately in German
// and English and do not depend on the interface language, so "ausschalten"
// and "shutdown" find the same command with the same weight either way.
//
// The user's choices live in the `launcher-commands` setting as JSON, one
// override object per command id; anything missing means the default.
//   {"system.shutdown": {"enabled": true, "visible": true, "aliases": ["aus"],
//    "favorite": false, "priority": 0, "shortcut": "off"}}
// A confirmation is part of the catalog (`requiresConfirmation`): no setting
// can turn it off.

import {N_} from '../i18n/core.js';
import {matchScore, fold} from './logic.js';

export const CATEGORIES = [
    {id: 'power', title: N_('Power & Session')},
    {id: 'settings', title: N_('Settings')},
    {id: 'system', title: N_('System & Notifications')},
    {id: 'devices', title: N_('Devices')},
    {id: 'windows', title: N_('Windows')},
];

// context: when a command can be offered at all (providers.js checks it):
//   airpods-off / airpods-on / airpods-mode:<mode>, window, workspaces, files.
const command = (id, category, title, description, icon, keywords, extra = {}) => ({
    id, category, title, description, icon, keywords, requiresConfirmation: false, dangerous: false,
    defaultEnabled: true, defaultVisible: true, ...extra,
});
export const COMMANDS = [
    command('system.lock', 'power', N_('Lock Screen'), N_('Locks the screen; your session keeps running.'), 'system-lock-screen-symbolic',
        ['lock screen', 'lock', 'bildschirm sperren', 'sperren']),
    command('system.suspend', 'power', N_('Suspend'), N_('Puts the computer to sleep.'), 'weather-clear-night-symbolic',
        ['suspend', 'sleep', 'standby', 'bereitschaft', 'schlafen', 'ruhezustand']),
    command('system.logout', 'power', N_('Log Out'), N_('Ends your session. Asks for confirmation first.'), 'system-log-out-symbolic',
        ['log out', 'logout', 'sign out', 'abmelden'], {requiresConfirmation: true, dangerous: true, confirm: N_('Really log out?')}),
    command('system.restart', 'power', N_('Restart'), N_('Restarts the computer. Asks for confirmation first.'), 'system-reboot-symbolic',
        ['restart', 'reboot', 'neu starten', 'neustart', 'neustarten'], {requiresConfirmation: true, dangerous: true, confirm: N_('Really restart?')}),
    command('system.shutdown', 'power', N_('Shut Down'), N_('Turns the computer off. Asks for confirmation first.'), 'system-shutdown-symbolic',
        ['shut down', 'shutdown', 'power off', 'turn off', 'ausschalten', 'herunterfahren'], {requiresConfirmation: true, dangerous: true, confirm: N_('Really shut down?')}),

    command('settings.open', 'settings', N_('Open Settings'), N_('GNOME Settings.'), 'preferences-system-symbolic',
        ['settings', 'system settings', 'control center', 'preferences', 'einstellungen', 'einstellungen öffnen', 'systemeinstellungen']),
    command('settings.sound', 'settings', N_('Sound Settings'), N_('Output, input and volume.'), 'audio-speakers-symbolic',
        ['sound settings', 'sound', 'audio', 'volume', 'speakers', 'microphone', 'audioeinstellungen', 'ton', 'lautstärke', 'lautsprecher', 'mikrofon'], {panel: 'sound'}),
    command('settings.power', 'settings', N_('Power Settings'), N_('Power mode, battery and screen blank.'), 'battery-symbolic',
        ['power settings', 'power', 'battery', 'energy', 'energieoptionen', 'energie', 'akku', 'batterie', 'energiesparen'], {panel: 'power'}),
    command('settings.display', 'settings', N_('Display Settings'), N_('Resolution, scale and arrangement of monitors.'), 'video-display-symbolic',
        ['display settings', 'display', 'monitor', 'resolution', 'scale', 'bildschirmeinstellungen', 'anzeige', 'auflösung', 'skalierung'], {panel: 'display'}),
    command('settings.bluetooth', 'settings', N_('Bluetooth Settings'), N_('Pair and connect Bluetooth devices.'), 'bluetooth-active-symbolic',
        ['bluetooth settings', 'bluetooth', 'headphones', 'bluetooth-einstellungen', 'kopfhörer', 'airpods'], {panel: 'bluetooth'}),
    command('settings.wifi', 'settings', N_('Wi-Fi Settings'), N_('Wireless networks.'), 'network-wireless-symbolic',
        ['wi-fi settings', 'wifi', 'wi-fi', 'wireless', 'network', 'wlan-einstellungen', 'wlan', 'netzwerk'], {panel: 'wifi'}),
    command('notchy.settings', 'settings', N_('Notchy Settings'), N_('Notchy’s own preferences.'), 'emblem-system-symbolic',
        ['notchy settings', 'notchy preferences', 'thunderstorm', 'quicklinks', 'snippets', 'notchy-einstellungen', 'notchy einstellungen']),

    command('system.dnd', 'system', N_('Do Not Disturb'), N_('Turns notification banners off or on again.'), 'notifications-disabled-symbolic',
        ['do not disturb', 'dnd', 'notifications', 'nicht stören', 'mitteilungen', 'benachrichtigungen']),
    command('system.screenshot', 'system', N_('Take Screenshot'), N_('GNOME’s screenshot tool; Notchy puts the picture into the Shelf.'), 'camera-photo-symbolic',
        ['screenshot', 'take screenshot', 'capture', 'bildschirmfoto', 'bildschirmfoto aufnehmen', 'screenshot aufnehmen', 'aufnahme']),
    command('system.screencast', 'system', N_('Record Screen'), N_('GNOME’s screen recording.'), 'media-record-symbolic',
        ['record screen', 'screen recording', 'screencast', 'bildschirm aufnehmen', 'bildschirmaufnahme', 'video aufnehmen']),
    command('notchy.open', 'system', N_('Open Notchy'), N_('Opens the island.'), 'view-reveal-symbolic',
        ['open notchy', 'notchy', 'island', 'notchy öffnen', 'insel']),
    command('notchy.shelf', 'system', N_('Open Shelf'), N_('Notchy’s shelf for files.'), 'package-x-generic-symbolic',
        ['open shelf', 'shelf', 'files tray', 'regal öffnen', 'regal', 'ablagefach']),
    command('notchy.clipboard', 'system', N_('Open Clipboard History'), N_('Notchy’s clipboard history.'), 'edit-paste-symbolic',
        ['clipboard history', 'clipboard', 'zwischenablage', 'ablage öffnen', 'verlauf']),
    command('notchy.outputs', 'system', N_('Choose Audio Output'), N_('This computer’s outputs and AirPlay receivers.'), 'audio-speakers-symbolic',
        ['audio output', 'output device', 'speakers', 'airplay', 'audioausgabe', 'audioausgabe wählen', 'ausgabegerät', 'ausgabe wechseln']),
    command('notchy.indexedFolders', 'system', N_('Show Indexed Folders'), N_('The folders Thunderstorm’s file search covers.'), 'folder-saved-search-symbolic',
        ['indexed folders', 'file search', 'search folders', 'localsearch', 'tracker', 'index', 'indizierte ordner anzeigen', 'indizierte ordner', 'dateisuche', 'suchordner'],
        {drill: 'indexed'}),

    command('airpods.connect', 'devices', N_('Connect AirPods'), N_('Offered while paired AirPods are not connected.'), 'notchy-airpods-symbolic',
        ['connect airpods', 'airpods', 'headphones', 'airpods verbinden', 'verbinden', 'kopfhörer'], {context: 'airpods-off'}),
    command('airpods.disconnect', 'devices', N_('Disconnect AirPods'), N_('Offered while AirPods are connected.'), 'notchy-airpods-symbolic',
        ['disconnect airpods', 'airpods', 'headphones', 'airpods trennen', 'trennen', 'kopfhörer'], {context: 'airpods-on'}),
    command('airpods.anc.noise', 'devices', N_('AirPods: Noise Cancellation'), N_('Offered when the connected model has it.'), 'notchy-anc-symbolic',
        ['airpods noise cancellation', 'anc', 'noise', 'airpods: geräuschunterdrückung', 'airpods geräuschunterdrückung', 'geräuschunterdrückung'], {context: 'airpods-mode:noise'}),
    command('airpods.anc.transparency', 'devices', N_('AirPods: Transparency'), N_('Offered when the connected model has it.'), 'notchy-transparency-symbolic',
        ['airpods transparency', 'transparency', 'anc', 'airpods: transparenzmodus', 'airpods transparenzmodus', 'transparenz', 'transparenzmodus'], {context: 'airpods-mode:transparency'}),
    command('airpods.anc.adaptive', 'devices', N_('AirPods: Adaptive'), N_('Offered when the connected model has it.'), 'notchy-adaptive-symbolic',
        ['airpods adaptive', 'adaptive', 'anc', 'airpods: adaptiver modus', 'airpods adaptiver modus', 'adaptiv'], {context: 'airpods-mode:adaptive'}),
    command('airpods.anc.off', 'devices', N_('AirPods: Noise Control Off'), N_('Offered when the connected model has it.'), 'notchy-anc-off-symbolic',
        ['airpods noise control off', 'anc off', 'airpods: geräuschkontrolle aus', 'airpods geräuschkontrolle aus', 'geräuschkontrolle aus'], {context: 'airpods-mode:off'}),

    command('window.maximize', 'windows', N_('Maximize Window'), N_('The window that had focus before Thunderstorm opened.'), 'view-fullscreen-symbolic',
        ['maximize window', 'maximize', 'fullscreen', 'fenster maximieren', 'maximieren', 'vollbild'], {context: 'window'}),
    command('window.restore', 'windows', N_('Restore Window'), N_('Back to its size before maximizing.'), 'view-restore-symbolic',
        ['restore window', 'restore', 'unmaximize', 'fenster wiederherstellen', 'wiederherstellen'], {context: 'window'}),
    command('window.left', 'windows', N_('Window to the Left Half'), N_('Tiles the window onto the left half.'), 'view-dual-symbolic',
        ['window left', 'left half', 'snap left', 'fenster links anordnen', 'links', 'linke hälfte'], {context: 'window'}),
    command('window.right', 'windows', N_('Window to the Right Half'), N_('Tiles the window onto the right half.'), 'view-dual-symbolic',
        ['window right', 'right half', 'snap right', 'fenster rechts anordnen', 'rechts', 'rechte hälfte'], {context: 'window'}),
    command('window.centerThird', 'windows', N_('Window to the Middle Third'), N_('Tiles the window onto the middle third.'), 'view-column-symbolic',
        ['middle third', 'center third', 'fenster ins mittlere drittel', 'drittel', 'mitte'], {context: 'window'}),
    command('window.center', 'windows', N_('Center Window'), N_('Moves the window to the middle of the screen.'), 'zoom-fit-best-symbolic',
        ['center window', 'center', 'centre', 'fenster zentrieren', 'zentrieren', 'mitte'], {context: 'window'}),
    command('window.minimize', 'windows', N_('Minimize Window'), N_('Hides the window.'), 'window-minimize-symbolic',
        ['minimize window', 'minimize', 'hide', 'fenster minimieren', 'minimieren', 'verstecken'], {context: 'window'}),
    command('window.workspaceNext', 'windows', N_('Next Workspace'), N_('Offered with more than one workspace.'), 'go-next-symbolic',
        ['next workspace', 'workspace right', 'nächster arbeitsbereich', 'arbeitsbereich rechts'], {context: 'workspaces'}),
    command('window.workspacePrevious', 'windows', N_('Previous Workspace'), N_('Offered with more than one workspace.'), 'go-previous-symbolic',
        ['previous workspace', 'workspace left', 'vorheriger arbeitsbereich', 'arbeitsbereich links'], {context: 'workspaces'}),
    command('window.moveNext', 'windows', N_('Move Window to Next Workspace'), N_('Moves the window and follows it.'), 'go-next-symbolic',
        ['move window to next workspace', 'move window', 'fenster in nächsten arbeitsbereich', 'fenster verschieben'], {context: 'window workspaces'}),
    command('window.workspace', 'windows', N_('Workspace 1–9'), N_('“Workspace 2” switches to that workspace.'), 'view-grid-symbolic',
        ['workspace', 'arbeitsbereich'], {context: 'workspaces', numbered: true}),
];
export const COMMAND_IDS = new Set(COMMANDS.map(c => c.id));
const BY_ID = new Map(COMMANDS.map(c => [c.id, c]));
export const commandById = id => BY_ID.get(id) ?? null;

// Ids before the catalog existed, as the usage history may still hold them.
export const LEGACY_IDS = {
    lock: 'system.lock', suspend: 'system.suspend', logout: 'system.logout', restart: 'system.restart', shutdown: 'system.shutdown',
    settings: 'settings.open', 'settings-sound': 'settings.sound', 'settings-power': 'settings.power', 'settings-display': 'settings.display',
    'settings-bluetooth': 'settings.bluetooth', 'settings-wifi': 'settings.wifi', 'notchy-settings': 'notchy.settings', dnd: 'system.dnd',
    indexed: 'notchy.indexedFolders', 'airpods-connect': 'airpods.connect', 'airpods-disconnect': 'airpods.disconnect',
    'airpods-noise': 'airpods.anc.noise', 'airpods-transparency': 'airpods.anc.transparency', 'airpods-adaptive': 'airpods.anc.adaptive', 'airpods-off': 'airpods.anc.off',
};
export const canonicalId = id => (COMMAND_IDS.has(id) ? id : LEGACY_IDS[id] ?? null);

// The usage history from older versions: 'cmd:lock' becomes 'cmd:system.lock';
// everything else is kept as it is. Returns a new object.
export function migrateHistory(history) {
    const out = {};
    for (const [key, entry] of Object.entries(history ?? {})) {
        if (!entry || typeof entry !== 'object') continue;
        const old = /^cmd:(.+)$/.exec(key)?.[1], id = old ? canonicalId(old) ?? old : null;
        const target = id ? `cmd:${id}` : key, next = id ? {...entry, command: id} : entry;
        const merged = out[target];
        out[target] = merged ? {...merged, ...next, count: (merged.count ?? 0) + (entry.count ?? 0), last: Math.max(merged.last ?? 0, entry.last ?? 0)} : next;
    }
    return out;
}

// Whether a command can be offered now. `env` describes the moment:
//   {airpods: {state, connected, modes} | null, window: bool, workspaces: n,
//    notifications: bool, files: bool, capture: bool}
// Context-dependent commands appear only while they can work.
export function available(def, env = {}) {
    const airpods = env.airpods;
    for (const need of String(def.context ?? '').split(' ').filter(Boolean)) {
        if (need === 'airpods-off' && !(airpods?.state && !airpods.connected)) return false;
        if (need === 'airpods-on' && !(airpods?.state && airpods.connected)) return false;
        if (need.startsWith('airpods-mode:') && !airpods?.modes?.includes(need.slice(13))) return false;
        if (need === 'window' && !env.window) return false;
        if (need === 'workspaces' && !(env.workspaces > 1)) return false;
    }
    if (def.id === 'system.dnd' && !env.notifications) return false;
    if (def.id === 'notchy.indexedFolders' && !env.files) return false;
    if ((def.id === 'system.screenshot' || def.id === 'system.screencast') && !env.capture) return false;
    return true;
}

// --- The user's overrides ----------------------------------------------------
export const PRIORITIES = [-2, -1, 0, 1, 2];
const ALIAS_MAX = 12, ALIAS_LENGTH = 40;
const SHORTCUT = /^[\p{L}\p{N}._+-]{1,16}$/u;
const clean = text => String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

// One command's override from untrusted JSON: only known fields with valid
// values survive; anything else (a "requiresConfirmation", wrong types) is
// dropped. Returns null when nothing valid is left.
export function sanitizeOverride(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const key of ['enabled', 'visible', 'favorite']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
    if (Number.isInteger(raw.priority)) out.priority = Math.max(-2, Math.min(2, raw.priority));
    if (Array.isArray(raw.aliases)) {
        const aliases = [...new Set(raw.aliases.filter(a => typeof a === 'string').map(clean).filter(a => a && a.length <= ALIAS_LENGTH).map(a => a.toLowerCase()))].slice(0, ALIAS_MAX);
        if (aliases.length) out.aliases = aliases;
    }
    if (typeof raw.shortcut === 'string') { const shortcut = clean(raw.shortcut).toLowerCase(); if (SHORTCUT.test(shortcut)) out.shortcut = shortcut; }
    return Object.keys(out).length ? out : null;
}
// The whole setting: overrides of known commands (and of ids a newer Notchy
// may know: kept, so a downgrade loses nothing, but never used).
export function parseCommandConfig(json) {
    let raw;
    try { raw = typeof json === 'string' ? (json.trim() ? JSON.parse(json) : {}) : json; } catch { return {}; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, value] of Object.entries(raw).slice(0, 200)) {
        if (!/^[a-z][a-zA-Z0-9.]{0,63}$/.test(id)) continue;
        const override = sanitizeOverride(value);
        if (override) out[id] = override;
    }
    return out;
}
// What applies to a command: its defaults with the user's override.
export function effective(commandOrId, config = {}) {
    const def = typeof commandOrId === 'string' ? commandById(commandOrId) : commandOrId;
    if (!def) return null;
    const o = config[def.id] ?? {};
    return {enabled: o.enabled ?? def.defaultEnabled, visible: o.visible ?? def.defaultVisible, favorite: o.favorite ?? false,
        priority: o.priority ?? 0, aliases: o.aliases ?? [], shortcut: o.shortcut ?? '', requiresConfirmation: def.requiresConfirmation};
}
// A changed setting as JSON. `patch` null resets the command to its defaults;
// values equal to the default are not stored.
export function updateCommandConfig(json, id, patch) {
    const config = parseCommandConfig(json);
    const def = commandById(id);
    if (!def) return JSON.stringify(config);
    if (patch === null) { delete config[id]; return JSON.stringify(config); }
    const next = sanitizeOverride({...(config[id] ?? {}), ...patch}) ?? {};
    if (next.enabled === def.defaultEnabled) delete next.enabled;
    if (next.visible === def.defaultVisible) delete next.visible;
    if (next.favorite === false) delete next.favorite;
    if (next.priority === 0) delete next.priority;
    if (patch.aliases && !patch.aliases.length) delete next.aliases;
    if (patch.shortcut === '') delete next.shortcut;
    if (Object.keys(next).length) config[id] = next; else delete config[id];
    return JSON.stringify(config);
}
// Aliases and shortcuts used by more than one command, or equal to a quicklink
// keyword: Map text → [ids or 'quicklink:keyword'].
export function aliasCollisions(config, quicklinkKeywords = []) {
    const owners = new Map();
    const claim = (text, owner) => { const key = fold(text); if (!key) return; if (!owners.has(key)) owners.set(key, new Set()); owners.get(key).add(owner); };
    for (const def of COMMANDS) {
        const cfg = effective(def, config);
        for (const alias of cfg.aliases) claim(alias, def.id);
        if (cfg.shortcut) claim(cfg.shortcut, def.id);
    }
    for (const keyword of quicklinkKeywords) if (owners.has(fold(keyword))) owners.get(fold(keyword)).add(`quicklink:${keyword}`);
    return new Map([...owners].filter(([, set]) => set.size > 1).map(([text, set]) => [text, [...set]]));
}

// How well `query` finds a command (0–1000; 1850 for its exact shortcut, an
// explicit intent like a quicklink keyword). The interface language does not
// matter: the localized title is only one more term next to the catalog's
// German and English keywords and the user's aliases.
export const SHORTCUT_SCORE = 1850;
export function commandScore(query, def, cfg, title = '') {
    const q = fold(query).trim();
    if (!q || !cfg?.enabled) return 0;
    if (cfg.shortcut && q === cfg.shortcut) return SHORTCUT_SCORE;
    if (!cfg.visible) return 0;
    // The English title (the msgid) always counts; the German one is among the keywords.
    let best = Math.max(matchScore(q, title), matchScore(q, def.title));
    for (const term of [...def.keywords, ...cfg.aliases]) best = Math.max(best, matchScore(q, term));
    return best;
}
// The ranking bonus for favourites and priorities: it orders results within
// their band and never lifts a weak match above a strong one (rankScore caps it).
export function commandBonus(cfg) { return (cfg?.favorite ? 60 : 0) + (cfg?.priority ?? 0) * 40; }

