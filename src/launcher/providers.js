import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getAppFavorites} from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {calculate, SNAP_LAYOUTS, zoneRect} from '../model.js';
import {matchScore, bestScore, formatNumber, parseConversion, unitSymbol, quicklinkTarget, matchQuicklink, parseList, expandSnippet, fold} from './logic.js';
import {EMOJI} from './emoji.js';

// Thunderstorm's sources. Each provider turns a query into results:
//   {id, kind, title, subtitle?, icon | gicon, score, actions: [{title, icon, run, shortcut?}], confirm?, revive?}
// actions[0] is what Enter does; the rest appear in the action panel (Ctrl+K).
// A provider may also answer the empty query (empty) and bring a result back
// from the usage history (revive). Adding a provider means adding a class here
// and listing it in Launcher; nothing else needs to know about it.

export function launchUri(uri) { system.open(uri); }
// The file manager shows the files selected; without one, the folder opens.
export function showInFolder(uri) {
    system.call('session', 'org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[uri], '']))
        .catch(() => { const parent = Gio.File.new_for_uri(uri).get_parent(); if (parent) launchUri(parent.get_uri()); });
}
// What leaves Notchy: opening URIs, and D-Bus calls to the session, the login
// manager and Settings. The headless test replaces these to record them.
export const system = {
    open(uri) {
        Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1), null, (_o, result) => {
            try { Gio.AppInfo.launch_default_for_uri_finish(result); } catch (e) { Main.notify('Notchy', `Konnte nicht geöffnet werden: ${e.message}`); }
        });
    },
    call(bus, name, path, iface, method, params) {
        return new Promise((resolve, reject) => (bus === 'system' ? Gio.DBus.system : Gio.DBus.session).call(name, path, iface, method, params, null, Gio.DBusCallFlags.NONE, 5000, null,
            (connection, result) => { try { resolve(connection.call_finish(result)); } catch (e) { reject(e); } }));
    },
};
function settingsPanel(panel) {
    system.call('session', 'org.gnome.Settings', '/org/gnome/Settings', 'org.gtk.Actions', 'Activate',
        new GLib.Variant('(sava{sv})', ['launch-panel', [new GLib.Variant('(sav)', [panel, []])], {}]))
        .catch(() => Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate());
}

// Arithmetic with the safe calculator (no eval).
export class CalculatorProvider {
    search(query, ctx) {
        const q = query.trim();
        if (!/\d/.test(q) || !/[+\-*/%()]/.test(q.replace(/^-/, ''))) return [];
        const value = calculate(q.replace(/,/g, '.').replace(/[×x]/g, '*').replace(/÷/g, '/'));
        if (value === null) return [];
        const text = formatNumber(Math.round(value * 1e9) / 1e9);
        return [{id: 'calc', kind: 'Rechner', title: `= ${text}`, subtitle: q, icon: 'accessories-calculator-symbolic', accent: true, score: 2000,
            actions: [{title: 'Ergebnis kopieren', icon: 'edit-copy-symbolic', run: () => ctx.copy(text, `${text} kopiert`)}]}];
    }
}

// Units: length, area, mass, volume, temperature, time, data.
export class UnitsProvider {
    search(query, ctx) {
        const parsed = parseConversion(query);
        if (!parsed) return [];
        return parsed.conversions.map((conversion, i) => {
            const text = formatNumber(conversion.value, 8), unit = unitSymbol(conversion.to);
            return {id: `unit:${conversion.to}`, kind: 'Umrechnung', title: `= ${text} ${unit}`, subtitle: `${formatNumber(parsed.value)} ${unitSymbol(parsed.from)}`,
                icon: 'accessories-calculator-symbolic', accent: true, score: 1950 - i,
                actions: [{title: 'Ergebnis kopieren', icon: 'edit-copy-symbolic', run: () => ctx.copy(text, `${text} ${unit} kopiert`)},
                    {title: 'Mit Einheit kopieren', icon: 'edit-copy-symbolic', run: () => ctx.copy(`${text} ${unit}`, `${text} ${unit} kopiert`)}]};
        });
    }
}

// Quicklinks: "yt lofi", "gh notchy", "wiki Zürich", folders and apps by keyword.
export class QuicklinkProvider {
    constructor(settings) { this.settings = settings; }
    get links() { return parseList(this.settings.get_string('launcher-quicklinks'), ['keyword', 'name', 'url']); }
    open(link, argument, ctx) {
        const target = quicklinkTarget(link, argument);
        if (!target) { ctx.toast('dialog-warning-symbolic', 'Quicklink ist ungültig'); return; }
        if (target.kind === 'url') launchUri(target.url);
        else if (target.kind === 'app') {
            const app = Shell.AppSystem.get_default().lookup_app(target.id);
            if (app) app.activate(); else ctx.toast('dialog-warning-symbolic', 'App nicht installiert');
        } else {
            const path = target.xdg ? GLib.get_user_special_dir(GLib.UserDirectory[`DIRECTORY_${target.xdg}`] ?? -1) : target.path.replace(/^~(?=\/)/, GLib.get_home_dir());
            if (path) launchUri(Gio.File.new_for_path(path).get_uri()); else ctx.toast('dialog-warning-symbolic', 'Ordner nicht gefunden');
        }
    }
    result(link, argument, score, ctx) {
        const target = quicklinkTarget(link, argument);
        const web = target?.kind === 'url', takes = /\{(query|path)\}/.test(link.url);
        const title = takes && argument ? `${link.name}: ${argument}` : takes ? `${link.name} durchsuchen …` : link.name;
        const result = {id: `link:${link.keyword}`, kind: 'Link', title, subtitle: takes && !argument ? `${link.keyword} Suchbegriff` : link.keyword,
            icon: web ? 'web-browser-symbolic' : target?.kind === 'app' ? 'application-x-executable-symbolic' : 'folder-symbolic', score,
            revive: {provider: 'link', keyword: link.keyword}, actions: []};
        // Without its argument, Enter completes "keyword " in the field.
        if (takes && !argument) result.actions.push({title: 'Suchbegriff eingeben', icon: 'edit-find-symbolic', keepOpen: true, run: () => ctx.setQuery(`${link.keyword} `)});
        else result.actions.push({title: web ? 'Im Browser öffnen' : 'Öffnen', icon: 'go-next-symbolic', run: () => this.open(link, argument, ctx)});
        if (web && (!takes || argument)) result.actions.push({title: 'Link kopieren', icon: 'edit-copy-symbolic', run: () => ctx.copy(target.url, 'Link kopiert')});
        return result;
    }
    search(query, ctx) {
        const links = this.links, hit = matchQuicklink(query, links), out = [];
        if (hit) out.push(this.result(hit.link, hit.argument, hit.complete ? 1900 : 1300, ctx));
        if (!hit?.complete) for (const link of links) {
            if (link === hit?.link) continue;
            const score = Math.max(matchScore(query, link.name), matchScore(query, link.keyword) - 50);
            if (score >= 500) out.push(this.result(link, '', score, ctx));
        }
        return out;
    }
    revive(entry, ctx) { const link = this.links.find(l => l.keyword === entry.keyword); return link ? this.result(link, '', 0, ctx) : null; }
}

// Search the web for anything, always the last row.
export class WebSearchProvider {
    constructor(settings) { this.settings = settings; }
    search(query, ctx) {
        const q = query.trim(); if (q.length < 2) return [];
        const target = quicklinkTarget({url: this.settings.get_string('launcher-web-search')}, q);
        if (!target || target.kind !== 'url') return [];
        return [{id: 'web', kind: 'Web', title: `„${q}“ im Web suchen`, icon: 'web-browser-symbolic', score: 1,
            actions: [{title: 'Im Browser suchen', icon: 'web-browser-symbolic', run: () => launchUri(target.url)}, {title: 'Link kopieren', icon: 'edit-copy-symbolic', run: () => ctx.copy(target.url, 'Link kopiert')}]}];
    }
}

// Installed applications; the dock's favourites for the empty query.
export class AppsProvider {
    result(app, score) {
        const info = app.get_app_info();
        return {id: `app:${app.get_id()}`, kind: 'App', title: app.get_name(), subtitle: info?.get_description?.() ?? '', gicon: app.get_icon(), score,
            revive: {provider: 'app', app: app.get_id()},
            actions: [{title: 'Öffnen', icon: 'go-next-symbolic', run: () => app.activate()},
                ...(app.can_open_new_window?.() ? [{title: 'Neues Fenster', icon: 'window-new-symbolic', shortcut: 'Strg+↵', run: () => app.open_new_window(-1)}] : [])]};
    }
    search(query) {
        const system = Shell.AppSystem.get_default(), out = [];
        for (const info of system.get_installed()) {
            if (!info.should_show()) continue;
            const keywords = info.get_keywords?.() ?? [];
            const score = bestScore(query, [info.get_name(), info.get_generic_name?.(), keywords.join(' '), info.get_executable?.()]);
            if (score < 300) continue;
            const app = system.lookup_app(info.get_id());
            if (app) out.push(this.result(app, Math.min(1000, score)));
        }
        return out;
    }
    empty() { return getAppFavorites().getFavorites().slice(0, 3).map(app => this.result(app, 0)); }
    revive(entry) { const app = Shell.AppSystem.get_default().lookup_app(entry.app); return app ? this.result(app, 0) : null; }
}

// System commands. Shutting down, restarting and logging out ask first.
export class SystemProvider {
    constructor(extension) { this.extension = extension; }
    get commands() {
        const ext = this.extension;
        // A page of GNOME's Settings, opened over its D-Bus interface.
        const panel = (id, title, keywords, icon) => ({id: `settings-${id}`, title, keywords: `einstellungen settings ${keywords}`, icon, run: () => settingsPanel(id)});
        return [
            {id: 'lock', title: 'Bildschirm sperren', keywords: 'sperren lock screen', icon: 'system-lock-screen-symbolic',
                run: () => system.call('session', 'org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver', 'Lock', null)},
            {id: 'settings', title: 'Einstellungen öffnen', keywords: 'einstellungen settings systemeinstellungen control center', icon: 'preferences-system-symbolic',
                run: () => Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate()},
            panel('sound', 'Audioeinstellungen', 'ton audio sound lautstärke volume lautsprecher mikrofon', 'audio-speakers-symbolic'),
            panel('power', 'Energieoptionen', 'energie power akku batterie energieoptionen energiesparen', 'battery-symbolic'),
            panel('display', 'Bildschirmeinstellungen', 'anzeige display monitor auflösung skalierung', 'video-display-symbolic'),
            panel('bluetooth', 'Bluetooth-Einstellungen', 'bluetooth airpods kopfhörer', 'bluetooth-active-symbolic'),
            panel('wifi', 'WLAN-Einstellungen', 'wlan wifi wireless netzwerk', 'network-wireless-symbolic'),
            {id: 'suspend', title: 'Bereitschaft', keywords: 'bereitschaft schlafen suspend sleep standby', icon: 'weather-clear-night-symbolic',
                run: () => system.call('system', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'Suspend', new GLib.Variant('(b)', [true]))},
            {id: 'logout', title: 'Abmelden', keywords: 'abmelden logout log out sign out', icon: 'system-log-out-symbolic', confirm: 'Wirklich abmelden?',
                run: () => system.call('session', 'org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager', 'Logout', new GLib.Variant('(u)', [1]))},
            {id: 'restart', title: 'Neu starten', keywords: 'neustart neu starten restart reboot', icon: 'system-reboot-symbolic', confirm: 'Wirklich neu starten?',
                run: () => system.call('session', 'org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager', 'RequestReboot', null)},
            {id: 'shutdown', title: 'Ausschalten', keywords: 'ausschalten herunterfahren shutdown power off', icon: 'system-shutdown-symbolic', confirm: 'Wirklich ausschalten?',
                run: () => system.call('session', 'org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager', 'RequestShutdown', null)},
            {id: 'dnd', title: ext.notifications?.doNotDisturb ? 'Nicht stören ausschalten' : 'Nicht stören einschalten', keywords: 'nicht stören do not disturb dnd mitteilungen benachrichtigungen',
                icon: 'notifications-disabled-symbolic', run: () => { if (ext.notifications) ext.notifications.doNotDisturb = !ext.notifications.doNotDisturb; }},
            {id: 'notchy-settings', title: 'Notchy-Einstellungen', keywords: 'notchy einstellungen preferences thunderstorm quicklinks snippets airpods', icon: 'emblem-system-symbolic',
                run: () => ext.openPreferences()},
            ...(ext.airpods?.state ? [ext.airpods.connected
                ? {id: 'airpods-disconnect', title: 'AirPods trennen', keywords: 'airpods trennen disconnect kopfhörer', icon: 'notchy-airpods-symbolic', run: () => ext.airpods.disconnect()}
                : {id: 'airpods-connect', title: 'AirPods verbinden', keywords: 'airpods verbinden connect kopfhörer', icon: 'notchy-airpods-symbolic', run: () => ext.airpods.connect()}] : []),
            ...(ext.airpods?.modes.length ? ext.airpods.modes.map(mode => ({id: `airpods-${mode}`, title: {noise: 'AirPods: Geräuschunterdrückung', transparency: 'AirPods: Transparenzmodus', adaptive: 'AirPods: Adaptiver Modus', off: 'AirPods: Geräuschkontrolle aus'}[mode],
                keywords: `airpods anc noise ${mode} geräuschunterdrückung transparenz adaptiv aus`, icon: {noise: 'notchy-anc-symbolic', transparency: 'notchy-transparency-symbolic', adaptive: 'notchy-adaptive-symbolic', off: 'notchy-anc-off-symbolic'}[mode],
                run: () => ext.airpods.setAnc(mode)})) : []),
            {id: 'indexed', title: 'Indizierte Ordner anzeigen', keywords: 'index indizierte ordner dateisuche localsearch tracker suchordner', icon: 'folder-saved-search-symbolic', drill: 'indexed'},
        ];
    }
    result(command, score, ctx) {
        const run = command.drill ? () => ctx.drill(command.drill) : () => {
            Promise.resolve().then(() => command.run()).catch(e => ctx.toast('dialog-warning-symbolic', `${command.title}: ${e.message}`));
        };
        return {id: `cmd:${command.id}`, kind: 'Befehl', title: command.title, icon: command.icon, score, confirm: command.confirm, revive: {provider: 'cmd', command: command.id},
            actions: [{title: command.drill ? 'Anzeigen' : 'Ausführen', icon: 'go-next-symbolic', keepOpen: Boolean(command.drill), run}]};
    }
    search(query, ctx) {
        const out = [];
        for (const command of this.commands) {
            const score = bestScore(query, [command.title, command.keywords]);
            if (score >= 450) out.push(this.result(command, score, ctx));
        }
        return out;
    }
    revive(entry, ctx) { const command = this.commands.find(c => c.id === entry.command); return command ? this.result(command, 0, ctx) : null; }
}

// Window commands for the window that had focus before Thunderstorm opened.
export class WindowProvider {
    constructor(extension) { this.extension = extension; }
    commands(window) {
        const manager = global.workspace_manager, time = () => global.get_current_time();
        const area = () => Main.layoutManager.getWorkAreaForMonitor(window.get_monitor());
        const place = zone => () => {
            if (window.is_maximized()) window.unmaximize();
            const rect = zoneRect(area(), zone); window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height); window.activate(time());
        };
        const halves = SNAP_LAYOUTS[0].zones, thirds = SNAP_LAYOUTS[2].zones;
        const neighbour = direction => manager.get_active_workspace().get_neighbor(direction);
        const list = [
            {id: 'maximize', title: 'Fenster maximieren', keywords: 'maximieren vollbild maximize', icon: 'view-fullscreen-symbolic', run: () => { window.maximize(); window.activate(time()); }},
            {id: 'restore', title: 'Fenster wiederherstellen', keywords: 'wiederherstellen restore unmaximize', icon: 'view-restore-symbolic', run: () => { window.unmaximize(); window.activate(time()); }},
            {id: 'left', title: 'Fenster links anordnen', keywords: 'links linke hälfte left half snap', icon: 'view-dual-symbolic', run: place(halves[0])},
            {id: 'right', title: 'Fenster rechts anordnen', keywords: 'rechts rechte hälfte right half snap', icon: 'view-dual-symbolic', run: place(halves[1])},
            {id: 'center-third', title: 'Fenster ins mittlere Drittel', keywords: 'mitte drittel center third', icon: 'view-column-symbolic', run: place(thirds[1])},
            {id: 'center', title: 'Fenster zentrieren', keywords: 'zentrieren mitte center', icon: 'zoom-fit-best-symbolic', run: () => {
                const a = area(), frame = window.get_frame_rect(); if (window.is_maximized()) window.unmaximize();
                window.move_frame(true, Math.round(a.x + (a.width - frame.width) / 2), Math.round(a.y + (a.height - frame.height) / 2)); window.activate(time());
            }},
            {id: 'minimize', title: 'Fenster minimieren', keywords: 'minimieren minimize verstecken', icon: 'window-minimize-symbolic', run: () => window.minimize()},
        ];
        if (manager.get_n_workspaces() > 1) {
            list.push({id: 'ws-next', title: 'Nächster Arbeitsbereich', keywords: 'workspace arbeitsbereich nächster rechts next', icon: 'go-next-symbolic', run: () => neighbour(Meta.MotionDirection.RIGHT).activate(time())},
                {id: 'ws-prev', title: 'Vorheriger Arbeitsbereich', keywords: 'workspace arbeitsbereich vorheriger links previous', icon: 'go-previous-symbolic', run: () => neighbour(Meta.MotionDirection.LEFT).activate(time())},
                {id: 'move-next', title: 'Fenster in nächsten Arbeitsbereich', keywords: 'workspace arbeitsbereich verschieben move window next', icon: 'go-next-symbolic', run: () => {
                    const target = neighbour(Meta.MotionDirection.RIGHT); window.change_workspace(target); target.activate_with_focus(window, time());
                }});
            for (let i = 0; i < Math.min(manager.get_n_workspaces(), 9); i++)
                list.push({id: `ws-${i + 1}`, title: `Arbeitsbereich ${i + 1}`, keywords: `workspace arbeitsbereich ${i + 1}`, icon: 'view-grid-symbolic', run: () => manager.get_workspace_by_index(i)?.activate(time())});
        }
        return list;
    }
    search(query, ctx) {
        const window = ctx.window;
        if (!window || window.get_window_type() !== Meta.WindowType.NORMAL || !window.get_compositor_private()) return [];
        const out = [];
        for (const command of this.commands(window)) {
            const score = bestScore(query, [command.title, command.keywords]);
            if (score >= 450) out.push({id: `win:${command.id}`, kind: 'Fenster', title: command.title, subtitle: window.get_title() ?? '', icon: command.icon, score: score - 20,
                actions: [{title: 'Ausführen', icon: 'go-next-symbolic', run: command.run}]});
        }
        return out;
    }
}

// The clipboard history, only when recording is on (and only what it recorded:
// password managers and sensitive formats never enter it).
export class ClipboardProvider {
    constructor(extension) { this.extension = extension; }
    search(query, ctx) {
        const clipboard = this.extension.clipboard, settings = this.extension.settings;
        const prefixed = /^(ablage|clip|clipboard|zwischenablage)\s/i.exec(query);
        const q = prefixed ? query.slice(prefixed[0].length) : query;
        if (!clipboard || !settings.get_boolean('clipboard-enabled') || (!prefixed && q.trim().length < 3)) return [];
        return clipboard.history.search(q.trim()).slice(0, prefixed ? 10 : 3).map((item, i) => {
            const text = item.title || item.text.replace(/\s+/g, ' ').slice(0, 120);
            return {id: `clip:${item.id}`, kind: 'Ablage', title: text, subtitle: item.source ?? '', score: (prefixed ? 1500 : 640) - i * 5,
                icon: item.kind === 'image' ? 'image-x-generic-symbolic' : item.kind === 'files' ? 'folder-symbolic' : item.kind === 'link' ? 'web-browser-symbolic' : 'edit-paste-symbolic',
                actions: [{title: 'Kopieren', icon: 'edit-copy-symbolic', run: () => { clipboard.copy(item); ctx.toast('edit-copy-symbolic', 'In Zwischenablage kopiert'); }},
                    ...(item.kind === 'link' ? [{title: 'Link öffnen', icon: 'web-browser-symbolic', run: () => launchUri(item.text.trim())}] : [])]};
        });
    }
}

// Text snippets with a name and keyword; Enter copies them.
export class SnippetProvider {
    constructor(settings) { this.settings = settings; }
    get snippets() { return parseList(this.settings.get_string('launcher-snippets'), ['name', 'text']); }
    result(snippet, score, ctx) {
        return {id: `snippet:${snippet.keyword || snippet.name}`, kind: 'Snippet', title: snippet.name, subtitle: snippet.text.replace(/\s+/g, ' ').slice(0, 80),
            icon: 'insert-text-symbolic', score, revive: {provider: 'snippet', name: snippet.name},
            actions: [{title: 'Snippet kopieren', icon: 'edit-copy-symbolic', run: () => ctx.copy(expandSnippet(snippet.text), `„${snippet.name}“ kopiert`)}]};
    }
    search(query, ctx) {
        const prefixed = /^(snippet|snip|text)\s/i.exec(query), q = prefixed ? query.slice(prefixed[0].length) : query;
        return this.snippets.map(snippet => {
            const exact = snippet.keyword && fold(snippet.keyword) === fold(q.trim());
            const score = exact ? 1400 : bestScore(q, [snippet.name, snippet.keyword, prefixed ? snippet.text : null]);
            return score >= (prefixed ? 1 : 500) ? this.result(snippet, prefixed ? score + 600 : score, ctx) : null;
        }).filter(Boolean);
    }
    revive(entry, ctx) { const snippet = this.snippets.find(s => s.name === entry.name); return snippet ? this.result(snippet, 0, ctx) : null; }
}

// Emoji and special characters by name, offline. "emoji herz" or ":herz" lists more.
export class EmojiProvider {
    result(entry, score, ctx) {
        const name = entry.names.split(' ').slice(0, 3).join(' ');
        return {id: `emoji:${entry.char}`, kind: entry.category === 'Zeichen' ? 'Zeichen' : 'Emoji', title: `${entry.char}  ${name}`, subtitle: entry.category, glyph: entry.char, score,
            revive: {provider: 'emoji', char: entry.char},
            actions: [{title: 'Kopieren', icon: 'edit-copy-symbolic', run: () => ctx.copy(entry.char, `${entry.char} kopiert`)}]};
    }
    search(query, ctx) {
        const prefixed = /^(emoji|zeichen|symbol)\s+|^:/i.exec(query), q = (prefixed ? query.slice(prefixed[0].length) : query).trim();
        if (q.length < (prefixed ? 1 : 3)) return [];
        const out = [];
        for (const entry of EMOJI) {
            const words = entry.names.split(' ');
            let score = Math.max(...words.map(word => matchScore(q, word)), matchScore(q, entry.names) - 100, matchScore(q, entry.category) - 300);
            if (score < (prefixed ? 300 : 800)) continue;
            out.push(this.result(entry, prefixed ? 1200 + score / 10 : score - 250, ctx));
        }
        return out;
    }
    revive(entry, ctx) { const found = EMOJI.find(e => e.char === entry.char); return found ? this.result(found, 0, ctx) : null; }
}

// Common file actions: open, show in the file manager, copy the path, add to the Regal.
export function fileActions(file, extension, ctx) {
    return [
        {title: file.dir ? 'Ordner öffnen' : 'Öffnen', icon: 'document-open-symbolic', run: () => ctx.openFile(file)},
        {title: 'Im Dateimanager zeigen', icon: 'folder-open-symbolic', shortcut: 'Strg+↵', run: () => showInFolder(file.uri)},
        {title: 'Pfad kopieren', icon: 'edit-copy-symbolic', shortcut: 'Strg+⇧+C', run: () => ctx.copy(file.path, 'Pfad kopiert')},
        {title: 'Ins Regal legen', icon: 'package-x-generic-symbolic', run: () => { extension.shelf.add(file.uri); ctx.toast('package-x-generic-symbolic', 'Ins Regal gelegt'); }},
    ];
}
export function fileResult(file, score, extension, ctx, kind = null) {
    const gicon = file.dir ? Gio.ThemedIcon.new('folder-symbolic') : Gio.content_type_get_symbolic_icon(file.mime || 'application/octet-stream');
    const home = GLib.get_home_dir(), parent = GLib.path_get_dirname(file.path);
    const where = parent === home ? '~' : parent.startsWith(`${home}/`) ? `~${parent.slice(home.length)}` : parent;
    return {id: `file:${file.uri}`, kind: kind ?? (file.dir ? 'Ordner' : 'Datei'), title: file.name, subtitle: file.readable === false ? `${where} · keine Berechtigung` : where, gicon, score,
        revive: {provider: 'file', uri: file.uri, path: file.path, name: file.name, dir: file.dir, mime: file.mime}, file,
        actions: fileActions(file, extension, ctx)};
}

// Files of the Regal by name.
export class ShelfProvider {
    constructor(extension) { this.extension = extension; }
    search(query, ctx) {
        return this.extension.shelf.items.map(item => {
            const score = matchScore(query, item.name); if (score < 400) return null;
            const path = Gio.File.new_for_uri(item.uri).get_path(); if (!path) return null;
            const [mime] = Gio.content_type_guess(item.name, null);
            return fileResult({uri: item.uri, path, name: item.name, dir: false, mime, readable: true}, score - 30, this.extension, ctx, 'Regal');
        }).filter(Boolean);
    }
}

// Files and folders anywhere: GNOME LocalSearch's index (see FileSearch).
// The helper returns candidates; they are ranked here like every result.
export class FileProvider {
    constructor(extension, files) { this.extension = extension; this.files = files; }
    // Recently used files (GTK's shared list), refreshed at most every minute,
    // rank higher: frequently used files come first.
    async recentUris() {
        if (this.recentAt && Date.now() - this.recentAt < 60000) return this.recentSet;
        this.recentAt = Date.now();
        const reply = await this.files.recent(40).catch(() => ({results: []}));
        this.recentSet = new Set((reply.results ?? []).map(file => file.uri));
        return this.recentSet;
    }
    async searchAsync(query, ctx) {
        const q = query.trim();
        if (!this.files.enabled || q.length < 2 || /^[\d\s.,+\-*/%()=]+$/.test(q)) return null;
        const recent = await this.recentUris();
        const reply = await this.files.search(q, 30);
        if (reply.superseded) return null;
        ctx.fileBackend(reply.backend, reply.error);
        return (reply.results ?? []).map(file => {
            const score = matchScore(q, file.name) || matchScore(q, file.path) / 2;
            if (score < 200) return null;
            // Recently changed files and shallow paths rank a little higher.
            const age = (Date.now() / 1000 - (file.mtime || 0)) / 86400, depth = file.path.split('/').length;
            const boost = (age < 2 ? 40 : age < 14 ? 20 : 0) + (recent?.has(file.uri) ? 80 : 0) - Math.min(60, Math.max(0, depth - 4) * 8) - (file.readable === false ? 200 : 0);
            // The match quality is the score; recency and depth only order files
            // within their band (see rankScore), they never lift a file above an app.
            return {...fileResult(file, Math.max(1, Math.min(1000, score)), this.extension, ctx), bonus: boost};
        }).filter(Boolean);
    }
    async recent(ctx) {
        if (!this.files.enabled) return [];
        const reply = await this.files.recent(4);
        return (reply.results ?? []).map(file => fileResult(file, 0, this.extension, ctx, 'Zuletzt geöffnet'));
    }
    revive(entry, ctx) { return entry.uri ? fileResult({...entry, readable: true}, 0, this.extension, ctx) : null; }
}
