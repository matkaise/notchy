import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getAppFavorites} from 'resource:///org/gnome/shell/ui/appFavorites.js';
import {calculate, SNAP_LAYOUTS, zoneRect, clipTitle} from '../model.js';
import {matchScore, bestScore, formatNumber, parseConversion, unitSymbol, quicklinkTarget, matchQuicklink, expandSnippet, fold,
    defaultQuicklinks, defaultSnippets, savedOrDefault, CLIPBOARD_PREFIX, SNIPPET_PREFIX, EMOJI_PREFIX} from './logic.js';
import {COMMANDS, canonicalId, commandById, parseCommandConfig, effective, commandScore, commandBonus, available, SHORTCUT_SCORE} from './commands.js';
import {EMOJI, emojiCategoryLabel, emojiCategoryTerms} from './emoji.js';
import {parseTimerQuery} from '../services/timerModel.js';
import {formatClock} from '../services/activityModel.js';
import {_, fmt} from '../i18n/core.js';
import {isMaximized, maximize, unmaximize} from '../compat/index.js';

// Thunderstorm's sources. Each provider turns a query into results:
//   {id, kind, title, subtitle?, icon | gicon, score, bonus?, actions: [{id, title, icon, run, shortcut?}], confirm?, revive?}
// `kind` and every action's `id` are stable identifiers (logic.js translates
// kinds for display); titles are translated text and never compared.
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
            try { Gio.AppInfo.launch_default_for_uri_finish(result); } catch (e) { Main.notify('Notchy', fmt(_('Could not open: %s'), e.message)); }
        });
    },
    call(bus, name, path, iface, method, params) {
        return new Promise((resolve, reject) => (bus === 'system' ? Gio.DBus.system : Gio.DBus.session).call(name, path, iface, method, params, null, Gio.DBusCallFlags.NONE, 5000, null,
            (connection, result) => { try { resolve(connection.call_finish(result)); } catch (e) { reject(e); } }));
    },
};
// A page of GNOME's Settings, opened over its D-Bus interface.
export function settingsPanel(panel) {
    return system.call('session', 'org.gnome.Settings', '/org/gnome/Settings', 'org.gtk.Actions', 'Activate',
        new GLib.Variant('(sava{sv})', ['launch-panel', [new GLib.Variant('(sav)', [panel, []])], {}]))
        .catch(() => Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate());
}
const copyAction = (id, title, run) => ({id, title, icon: 'edit-copy-symbolic', run});

// Arithmetic with the safe calculator (no eval). Comma and point are both
// decimal marks in the input; the result is shown in the interface's format.
export class CalculatorProvider {
    search(query, ctx) {
        const q = query.trim();
        if (!/\d/.test(q) || !/[+\-*/%()]/.test(q.replace(/^-/, ''))) return [];
        const value = calculate(q.replace(/,/g, '.').replace(/[×x]/g, '*').replace(/÷/g, '/'));
        if (value === null) return [];
        const text = formatNumber(Math.round(value * 1e9) / 1e9);
        return [{id: 'calc', kind: 'calc', title: `= ${text}`, subtitle: q, icon: 'accessories-calculator-symbolic', accent: true, score: 2000,
            actions: [copyAction('calc.copy', _('Copy Result'), () => ctx.copy(text, fmt(_('%s copied'), text)))]}];
    }
}

// Units: length, area, mass, volume, temperature, time, data.
export class UnitsProvider {
    search(query, ctx) {
        const parsed = parseConversion(query);
        if (!parsed) return [];
        return parsed.conversions.map((conversion, i) => {
            const text = formatNumber(conversion.value, 8), unit = unitSymbol(conversion.to, conversion.value), both = `${text} ${unit}`;
            return {id: `unit:${conversion.to}`, kind: 'unit', title: `= ${both}`, subtitle: `${formatNumber(parsed.value)} ${unitSymbol(parsed.from, parsed.value)}`,
                icon: 'accessories-calculator-symbolic', accent: true, score: 1950 - i,
                actions: [copyAction('unit.copy', _('Copy Result'), () => ctx.copy(text, fmt(_('%s copied'), both))),
                    copyAction('unit.copyWithUnit', _('Copy with Unit'), () => ctx.copy(both, fmt(_('%s copied'), both)))]};
        });
    }
}

// Timers in the notch: "timer 10 min", "timer 1h30 Pizza", "countdown 90s",
// "pomodoro". The duration comes first, an optional name after it.
export class TimerProvider {
    constructor(extension) { this.extension = extension; }
    search(query) {
        const timers = this.extension.timers, parsed = timers ? parseTimerQuery(query) : null;
        if (!parsed) return [];
        const start = () => { const result = timers.start(parsed); if (typeof result === 'string') this.extension.activeIsland()?.toast('dialog-warning-symbolic', result); };
        const title = parsed.pomodoro ? _('Start a Pomodoro') : fmt(_('Start a timer: %s'), formatClock(parsed.ms));
        const subtitle = parsed.pomodoro ? fmt(_('%1$d min focus, %2$d min break'), this.extension.settings.get_int('pomodoro-work-minutes'), this.extension.settings.get_int('pomodoro-break-minutes'))
            : parsed.name || _('Counts down in the notch');
        return [{id: parsed.pomodoro ? 'timer:pomodoro' : 'timer:start', kind: 'timer', title, subtitle, icon: 'alarm-symbolic', accent: true, score: 1900,
            actions: [{id: 'timer.start', title: _('Start Timer'), icon: 'alarm-symbolic', run: start}]}];
    }
}

// Quicklinks: "yt lofi", "gh notchy", "wiki Zürich", folders and apps by keyword.
export class QuicklinkProvider {
    constructor(settings) { this.settings = settings; }
    get links() { return savedOrDefault(this.settings.get_string('launcher-quicklinks'), ['keyword', 'name', 'url'], () => defaultQuicklinks()); }
    open(link, argument, ctx) {
        const target = quicklinkTarget(link, argument);
        if (!target) { ctx.toast('dialog-warning-symbolic', _('This quicklink is not valid')); return; }
        if (target.kind === 'url') launchUri(target.url);
        else if (target.kind === 'app') {
            const app = Shell.AppSystem.get_default().lookup_app(target.id);
            if (app) app.activate(); else ctx.toast('dialog-warning-symbolic', _('App not installed'));
        } else {
            const path = target.xdg ? GLib.get_user_special_dir(GLib.UserDirectory[`DIRECTORY_${target.xdg}`] ?? -1) : target.path.replace(/^~(?=\/)/, GLib.get_home_dir());
            if (path) launchUri(Gio.File.new_for_path(path).get_uri()); else ctx.toast('dialog-warning-symbolic', _('Folder not found'));
        }
    }
    result(link, argument, score, ctx) {
        const target = quicklinkTarget(link, argument);
        const web = target?.kind === 'url', takes = /\{(query|path)\}/.test(link.url);
        const title = takes && argument ? `${link.name}: ${argument}` : takes ? fmt(_('Search %s…'), link.name) : link.name;
        const result = {id: `link:${link.keyword}`, kind: 'link', title, subtitle: takes && !argument ? fmt(_('%s search term'), link.keyword) : link.keyword,
            icon: web ? 'web-browser-symbolic' : target?.kind === 'app' ? 'application-x-executable-symbolic' : 'folder-symbolic', score,
            revive: {provider: 'link', keyword: link.keyword}, actions: []};
        // Without its argument, Enter completes "keyword " in the field.
        if (takes && !argument) result.actions.push({id: 'link.complete', title: _('Enter Search Term'), icon: 'edit-find-symbolic', keepOpen: true, run: () => ctx.setQuery(`${link.keyword} `)});
        else result.actions.push({id: 'link.open', title: web ? _('Open in Browser') : _('Open'), icon: 'go-next-symbolic', run: () => this.open(link, argument, ctx)});
        if (web && (!takes || argument)) result.actions.push(copyAction('link.copy', _('Copy Link'), () => ctx.copy(target.url, _('Link copied'))));
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
        return [{id: 'web', kind: 'web', title: fmt(_('Search the Web for “%s”'), q), icon: 'web-browser-symbolic', score: 1,
            actions: [{id: 'web.search', title: _('Search in Browser'), icon: 'web-browser-symbolic', run: () => launchUri(target.url)}, copyAction('web.copy', _('Copy Link'), () => ctx.copy(target.url, _('Link copied')))]}];
    }
}

// Installed applications; the dock's favourites for the empty query.
export class AppsProvider {
    result(app, score) {
        const info = app.get_app_info();
        return {id: `app:${app.get_id()}`, kind: 'app', title: app.get_name(), subtitle: info?.get_description?.() ?? '', gicon: app.get_icon(), score,
            revive: {provider: 'app', app: app.get_id()},
            actions: [{id: 'app.open', title: _('Open'), icon: 'go-next-symbolic', run: () => app.activate()},
                ...(app.can_open_new_window?.() ? [{id: 'app.newWindow', title: _('New Window'), icon: 'window-new-symbolic', shortcut: _('Ctrl+↵'), run: () => app.open_new_window(-1)}] : [])]};
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

// The built-in commands of the catalog (src/launcher/commands.js): how each
// runs, when it is available, and the user's settings for it. Shutting down,
// restarting and logging out always ask first (the catalog says so; no
// setting changes it).
class CommandRegistry {
    constructor(extension) { this.extension = extension; this.json = null; this.parsed = {}; }
    // The user's overrides, parsed once per change of the setting.
    get config() {
        const json = this.extension.settings.get_string('launcher-commands');
        if (json !== this.json) { this.json = json; this.parsed = parseCommandConfig(json); }
        return this.parsed;
    }
    settingsFor(def) { return effective(def, this.config); }
    title(def) {
        const ext = this.extension;
        if (def.id === 'system.dnd') return ext.notifications?.doNotDisturb ? _('Turn Off Do Not Disturb') : _('Turn On Do Not Disturb');
        return _(def.title);
    }
    // Context-dependent commands are offered only while they can work (commands.js).
    available(def, ctx = {}) {
        const ext = this.extension;
        return available(def, {airpods: ext.airpods ? {state: ext.airpods.state, connected: ext.airpods.connected, modes: ext.airpods.modes} : null,
            window: usableWindow(ctx.window), workspaces: global.workspace_manager.get_n_workspaces(), notifications: Boolean(ext.notifications),
            files: Boolean(ext.files), capture: Boolean(ext.capture)});
    }
    execute(def, ctx = {}) {
        const ext = this.extension, island = () => ext.activeIsland?.();
        const session = (method, params = null) => system.call('session', 'org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager', method, params);
        switch (def.id) {
        case 'system.lock': return system.call('session', 'org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver', 'Lock', null);
        case 'system.suspend': return system.call('system', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'Suspend', new GLib.Variant('(b)', [true]));
        case 'system.logout': return session('Logout', new GLib.Variant('(u)', [1]));
        case 'system.restart': return session('RequestReboot');
        case 'system.shutdown': return session('RequestShutdown');
        case 'settings.open': return Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate();
        case 'notchy.settings': return ext.openPreferences();
        case 'system.dnd': if (ext.notifications) ext.notifications.doNotDisturb = !ext.notifications.doNotDisturb; return null;
        // Through Notchy's capture: the screenshot lands in the Regal.
        case 'system.screenshot': return ext.capture?.run('area');
        case 'system.screencast': return ext.capture?.run('record');
        case 'notchy.open': return island()?.toggle('media');
        case 'notchy.shelf': return island()?.toggle('shelf');
        case 'notchy.clipboard': return island()?.toggle('clipboard');
        case 'notchy.outputs': { const target = island(); if (target) { target.views.outputPicker = true; target.toggle('media'); } return null; }
        case 'airpods.connect': return ext.airpods?.connect();
        case 'airpods.disconnect': return ext.airpods?.disconnect();
        default:
            if (def.panel) return settingsPanel(def.panel);
            if (def.id.startsWith('airpods.anc.')) return ext.airpods?.setAnc(def.id.slice(12));
            throw new Error(`unknown command ${def.id}`);
        }
    }
}
export function usableWindow(window) {
    return Boolean(window && window.get_window_type() === Meta.WindowType.NORMAL && window.get_compositor_private());
}

export class SystemProvider {
    constructor(extension) { this.extension = extension; this.registry = new CommandRegistry(extension); }
    // The catalog's commands outside the window category, enabled and available now.
    entries(ctx) {
        return COMMANDS.filter(def => def.category !== 'windows').map(def => ({def, cfg: this.registry.settingsFor(def)}))
            .filter(({def, cfg}) => cfg.enabled && this.registry.available(def, ctx));
    }
    result(def, cfg, score, ctx) {
        const title = this.registry.title(def);
        const run = def.drill ? () => ctx.drill(def.drill) : () => {
            // Ran after the island closed: a failure is a toast in the capsule.
            Promise.resolve().then(() => this.registry.execute(def, ctx)).catch(e => ctx.toast('dialog-warning-symbolic', `${title}: ${e.message}`));
        };
        return {id: `cmd:${def.id}`, kind: 'command', commandId: def.id, title, icon: def.icon, score, bonus: commandBonus(cfg),
            confirm: def.requiresConfirmation ? _(def.confirm) : undefined, revive: {provider: 'cmd', command: def.id},
            actions: [{id: def.drill ? 'command.show' : 'command.run', title: def.drill ? _('Show') : _('Run'), icon: 'go-next-symbolic', keepOpen: Boolean(def.drill), run}]};
    }
    search(query, ctx) {
        const out = [];
        for (const {def, cfg} of this.entries(ctx)) {
            const score = commandScore(query, def, cfg, this.registry.title(def));
            if (score >= 450) out.push(this.result(def, cfg, score, ctx));
        }
        return out;
    }
    // Favourite commands, for the empty field.
    favorites(ctx) { return this.entries(ctx).filter(({cfg}) => cfg.favorite).map(({def, cfg}) => this.result(def, cfg, 0, ctx)); }
    // From the usage history (also entries saved with older ids); a command
    // switched off or unavailable since does not come back.
    revive(entry, ctx) {
        const def = commandById(canonicalId(entry.command));
        if (!def || def.category === 'windows') return null;
        const cfg = this.registry.settingsFor(def);
        return cfg.enabled && this.registry.available(def, ctx) ? this.result(def, cfg, 0, ctx) : null;
    }
}

// Window commands for the window that had focus before Thunderstorm opened;
// part of the same catalog and settings (category 'windows').
export class WindowProvider {
    constructor(extension) { this.extension = extension; this.registry = new CommandRegistry(extension); }
    runner(id, window, n = 0) {
        const manager = global.workspace_manager, time = () => global.get_current_time();
        const area = () => Main.layoutManager.getWorkAreaForMonitor(window.get_monitor());
        const place = zone => () => {
            if (isMaximized(window)) unmaximize(window);
            const rect = zoneRect(area(), zone); window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height); window.activate(time());
        };
        const halves = SNAP_LAYOUTS[0].zones, thirds = SNAP_LAYOUTS[2].zones;
        const neighbour = direction => manager.get_active_workspace().get_neighbor(direction);
        return {
            'window.maximize': () => { maximize(window); window.activate(time()); },
            'window.restore': () => { unmaximize(window); window.activate(time()); },
            'window.left': place(halves[0]), 'window.right': place(halves[1]), 'window.centerThird': place(thirds[1]),
            'window.center': () => {
                const a = area(), frame = window.get_frame_rect(); if (isMaximized(window)) unmaximize(window);
                window.move_frame(true, Math.round(a.x + (a.width - frame.width) / 2), Math.round(a.y + (a.height - frame.height) / 2)); window.activate(time());
            },
            'window.minimize': () => window.minimize(),
            'window.workspaceNext': () => neighbour(Meta.MotionDirection.RIGHT).activate(time()),
            'window.workspacePrevious': () => neighbour(Meta.MotionDirection.LEFT).activate(time()),
            'window.moveNext': () => { const target = neighbour(Meta.MotionDirection.RIGHT); window.change_workspace(target); target.activate_with_focus(window, time()); },
            'window.workspace': () => manager.get_workspace_by_index(n - 1)?.activate(time()),
        }[id];
    }
    search(query, ctx) {
        const window = ctx.window;
        if (!usableWindow(window)) return [];
        const out = [], subtitle = window.get_title() ?? '';
        const add = (def, cfg, id, title, score, run) => out.push({id, kind: 'window', commandId: def.id, title, subtitle, icon: def.icon, score: score === SHORTCUT_SCORE ? score : score - 20,
            bonus: commandBonus(cfg), actions: [{id: 'command.run', title: _('Run'), icon: 'go-next-symbolic', run}]});
        for (const def of COMMANDS.filter(c => c.category === 'windows')) {
            const cfg = this.registry.settingsFor(def);
            if (!cfg.enabled || !this.registry.available(def, ctx)) continue;
            if (def.numbered) {
                // "Workspace 2", "arbeitsbereich 2", "ws 2" with a user alias.
                const count = Math.min(global.workspace_manager.get_n_workspaces(), 9);
                for (let n = 1; n <= count; n++) {
                    const title = fmt(_('Workspace %d'), n);
                    const score = commandScore(query, {...def, keywords: def.keywords.map(k => `${k} ${n}`)}, {...cfg, aliases: cfg.aliases.map(a => `${a} ${n}`), shortcut: ''}, title);
                    if (score >= 450) add(def, cfg, `win:${def.id}.${n}`, title, score, this.runner(def.id, window, n));
                }
                continue;
            }
            const title = this.registry.title(def), score = commandScore(query, def, cfg, title);
            if (score >= 450) add(def, cfg, `win:${def.id}`, title, score, this.runner(def.id, window));
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
        const prefixed = CLIPBOARD_PREFIX.exec(query);
        const q = prefixed ? query.slice(prefixed[0].length) : query;
        if (!clipboard || !settings.get_boolean('clipboard-enabled') || (!prefixed && q.trim().length < 3)) return [];
        return clipboard.history.search(q.trim()).slice(0, prefixed ? 10 : 3).map((item, i) => {
            const text = clipTitle(item) || item.text.replace(/\s+/g, ' ').slice(0, 120);
            return {id: `clip:${item.id}`, kind: 'clipboard', title: text, subtitle: item.source ?? '', score: (prefixed ? 1500 : 640) - i * 5,
                icon: item.kind === 'image' ? 'image-x-generic-symbolic' : item.kind === 'files' ? 'folder-symbolic' : item.kind === 'link' ? 'web-browser-symbolic' : 'edit-paste-symbolic',
                actions: [copyAction('clipboard.copy', _('Copy'), () => { clipboard.copy(item); ctx.toast('edit-copy-symbolic', _('Copied to clipboard')); }),
                    ...(item.kind === 'link' ? [{id: 'clipboard.openLink', title: _('Open Link'), icon: 'web-browser-symbolic', run: () => launchUri(item.text.trim())}] : [])]};
        });
    }
}

// Text snippets with a name and keyword; Enter copies them.
export class SnippetProvider {
    constructor(settings) { this.settings = settings; }
    get snippets() { return savedOrDefault(this.settings.get_string('launcher-snippets'), ['name', 'text'], () => defaultSnippets()); }
    result(snippet, score, ctx) {
        return {id: `snippet:${snippet.keyword || snippet.name}`, kind: 'snippet', title: snippet.name, subtitle: snippet.text.replace(/\s+/g, ' ').slice(0, 80),
            icon: 'insert-text-symbolic', score, revive: {provider: 'snippet', name: snippet.name, keyword: snippet.keyword ?? ''},
            actions: [copyAction('snippet.copy', _('Copy Snippet'), () => ctx.copy(expandSnippet(snippet.text), fmt(_('“%s” copied'), snippet.name)))]};
    }
    search(query, ctx) {
        const prefixed = SNIPPET_PREFIX.exec(query), q = prefixed ? query.slice(prefixed[0].length) : query;
        return this.snippets.map(snippet => {
            const exact = snippet.keyword && fold(snippet.keyword) === fold(q.trim());
            const score = exact ? 1400 : bestScore(q, [snippet.name, snippet.keyword, prefixed ? snippet.text : null]);
            return score >= (prefixed ? 1 : 500) ? this.result(snippet, prefixed ? score + 600 : score, ctx) : null;
        }).filter(Boolean);
    }
    revive(entry, ctx) {
        const snippet = this.snippets.find(s => (entry.keyword && s.keyword === entry.keyword) || s.name === entry.name);
        return snippet ? this.result(snippet, 0, ctx) : null;
    }
}

// Emoji and special characters by name (German and English), offline.
// "emoji herz", ":herz" or "symbol pfeil" list more.
export class EmojiProvider {
    result(entry, score, ctx) {
        const name = entry.names.split(' ').slice(0, 3).join(' ');
        return {id: `emoji:${entry.char}`, kind: entry.category === 'chars' ? 'char' : 'emoji', title: `${entry.char}  ${name}`, subtitle: emojiCategoryLabel(entry.category), glyph: entry.char, score,
            revive: {provider: 'emoji', char: entry.char},
            actions: [copyAction('emoji.copy', _('Copy'), () => ctx.copy(entry.char, fmt(_('%s copied'), entry.char)))]};
    }
    search(query, ctx) {
        const prefixed = EMOJI_PREFIX.exec(query), q = (prefixed ? query.slice(prefixed[0].length) : query).trim();
        if (q.length < (prefixed ? 1 : 3)) return [];
        const out = [];
        for (const entry of EMOJI) {
            const words = entry.names.split(' ');
            const category = Math.max(...emojiCategoryTerms(entry.category).map(term => matchScore(q, term)));
            const score = Math.max(...words.map(word => matchScore(q, word)), matchScore(q, entry.names) - 100, category - 300);
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
        {id: 'file.open', title: file.dir ? _('Open Folder') : _('Open'), icon: 'document-open-symbolic', run: () => ctx.openFile(file)},
        {id: 'file.showInFolder', title: _('Show in File Manager'), icon: 'folder-open-symbolic', shortcut: _('Ctrl+↵'), run: () => showInFolder(file.uri)},
        {...copyAction('file.copyPath', _('Copy Path'), () => ctx.copy(file.path, _('Path copied'))), shortcut: _('Ctrl+⇧+C')},
        {id: 'file.addToShelf', title: _('Add to Shelf'), icon: 'package-x-generic-symbolic', run: () => { extension.shelf.add(file.uri); ctx.toast('package-x-generic-symbolic', _('Added to the Shelf')); }},
    ];
}
export function fileResult(file, score, extension, ctx, kind = null) {
    const gicon = file.dir ? Gio.ThemedIcon.new('folder-symbolic') : Gio.content_type_get_symbolic_icon(file.mime || 'application/octet-stream');
    const home = GLib.get_home_dir(), parent = GLib.path_get_dirname(file.path);
    const where = parent === home ? '~' : parent.startsWith(`${home}/`) ? `~${parent.slice(home.length)}` : parent;
    return {id: `file:${file.uri}`, kind: kind ?? (file.dir ? 'folder' : 'file'), title: file.name, subtitle: file.readable === false ? fmt(_('%s · no permission'), where) : where, gicon, score,
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
            return fileResult({uri: item.uri, path, name: item.name, dir: false, mime, readable: true}, score - 30, this.extension, ctx, 'shelf');
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
        return (reply.results ?? []).map(file => fileResult(file, 0, this.extension, ctx, 'recent'));
    }
    revive(entry, ctx) { return entry.uri ? fileResult({...entry, readable: true}, 0, this.extension, ctx) : null; }
}
