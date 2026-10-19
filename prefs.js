import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {quicklinkTarget, fold, defaultQuicklinks, defaultSnippets, savedOrDefault} from './src/launcher/logic.js';
import {CATEGORIES, COMMANDS, PRIORITIES, parseCommandConfig, effective, updateCommandConfig, aliasCollisions, sanitizeOverride} from './src/launcher/commands.js';
import {startTranslations} from './src/i18n/gnome.js';
import {_, fmt, ngettext} from './src/i18n/core.js';

const MINER = 'org.freedesktop.Tracker3.Miner.Files';
const LOCALSEARCH = GLib.getenv('NOTCHY_LOCALSEARCH_NAME') || 'org.freedesktop.LocalSearch3';
const AIRPODS = GLib.getenv('NOTCHY_AIRPODS_NAME') || 'org.costa.AirPods';
// The interface languages; each one's name is written in that language.
const LANGUAGES = ['auto', 'de', 'en'];
// A D-Bus call from the preferences window, as a promise.
const bus = (name, path, iface, method, params = null) => new Promise((resolve, reject) => Gio.DBus.session.call(name, path, iface, method, params, null,
    Gio.DBusCallFlags.NO_AUTO_START, 3000, null, (c, r) => { try { resolve(c.call_finish(r).deep_unpack()); } catch (e) { reject(e); } }));
const hasOwner = name => bus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', [name])).then(([owned]) => owned).catch(() => false);

export default class NotchyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(); window.set_default_size(760, 720); window.set_search_enabled(true);
        // Notchy's own symbols (AirPods, noise control) for the command list.
        const display = Gdk.Display.get_default();
        if (display) Gtk.IconTheme.get_for_display(display).add_search_path(`${this.path}/src/icons`);
        const stop = startTranslations(this, settings);
        // A new language: the pages are built again in it (once the combo row
        // that changed it has finished its signal).
        let pages = [];
        const build = () => { for (const p of pages.splice(0)) window.remove(p); pages = this.fill(window, settings); };
        const changed = settings.connect('changed::language', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { if (!window.in_destruction?.()) build(); return GLib.SOURCE_REMOVE; }));
        window.connect('close-request', () => { settings.disconnect(changed); stop(); return false; });
        build();
    }
    fill(window, settings) {
        const added = [];
        const page = (title, icon) => { const p = new Adw.PreferencesPage({title, icon_name: icon}); window.add(p); added.push(p); return p; };
        const group = (p, title, description = '') => { const g = new Adw.PreferencesGroup({title, description}); p.add(g); return g; };
        const toggle = (g, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle}); settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT); g.add(row);
        };
        const number = (g, key, title, min, max, step = 1, subtitle = '') => {
            const row = new Adw.SpinRow({title, subtitle, adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT); g.add(row);
        };
        const general = page(_('Appearance'), 'preferences-desktop-appearance-symbolic');
        const look = group(general, _('Your Island'), _('The GNOME clock in the top bar becomes the island; it grows around the clock.'));
        const styles = ['dynamic', 'liquid'];
        const style = new Adw.ComboRow({title: _('Style'), subtitle: _('Dynamic Glass: a black notch that fades into glass. Liquid Glass: a floating glass capsule.'),
            model: Gtk.StringList.new(['Dynamic Glass', 'Liquid Glass']), selected: Math.max(0, styles.indexOf(settings.get_string('style')))});
        style.connect('notify::selected', () => settings.set_string('style', styles[style.selected])); look.add(style);
        number(look, 'glass-level', _('Black share in percent (Dynamic Glass)'), 0, 100, 5, _('How much of the opened surface is black before it fades into glass. 100 % is entirely black, without glass.'));
        number(look, 'width', _('Width when opened'), 600, 900, 10);
        number(look, 'animation-duration', _('Animation in milliseconds'), 0, 800, 20);
        toggle(look, 'hide-fullscreen', _('Hide over fullscreen apps'));
        // The language: the system's, or one chosen here for Notchy alone.
        const lang = group(general, _('Language'), _('Notchy follows the system language. A language chosen here applies to Notchy only; the system and other apps keep theirs. Your quicklinks, snippets and settings stay as they are.'));
        const language = new Adw.ComboRow({title: _('Language'), model: Gtk.StringList.new([_('Automatic (system language)'), 'Deutsch', 'English']),
            selected: Math.max(0, LANGUAGES.indexOf(settings.get_string('language')))});
        language.connect('notify::selected', () => { const value = LANGUAGES[language.selected] ?? 'auto'; if (settings.get_string('language') !== value) settings.set_string('language', value); });
        lang.add(language);
        const behavior = group(general, _('Behavior'));
        toggle(behavior, 'hover-open', _('Open when the pointer touches it'));
        number(behavior, 'hover-delay', _('Opening delay in milliseconds'), 0, 2000, 50);
        number(behavior, 'collapse-delay', _('Closing delay in milliseconds'), 100, 5000, 100);
        toggle(behavior, 'clock-opens-notchy', _('The clock opens the Calendar tab'), _('A click on date and time shows notifications and the calendar in Notchy instead of GNOME’s popup.'));
        toggle(behavior, 'scroll-volume', _('Scrolling over the island changes the volume'));
        toggle(behavior, 'drag-summon', _('Drop files right onto the island'), _('While dragging, a drop area for the Shelf appears below the clock.'));
        toggle(behavior, 'snap-enabled', _('Arrange windows in the notch'), _('Drag a window to the clock and the notch offers layouts (halves, thirds, quarters…).'));
        toggle(behavior, 'jiggle-enabled', _('Shake while dragging to open the basket'));
        const live = group(general, _('Live Activities'));
        toggle(live, 'media-enabled', _('Show media in the island'));
        toggle(live, 'media-waveform', _('Show a live waveform'), _('Analyzes only the audio output monitor during playback. No audio is stored.'));
        toggle(live, 'airplay-enabled', _('Find AirPlay devices on the network'), _('Speakers and TVs with AirPlay appear as outputs in the Media tab. Runs as a small PipeWire service only while Notchy is active.'));
        toggle(live, 'hud-enabled', _('Show volume and brightness in the island'), _('Replaces GNOME’s on-screen display while the island is closed.'));
        toggle(live, 'notifications-enabled', _('Show notifications in Notchy'), _('New notifications appear as a banner from the island instead of GNOME’s banner. Do Not Disturb is respected.'));
        const preferred = new Adw.EntryRow({title: _('Preferred MPRIS bus name (empty = automatic)'), text: settings.get_string('preferred-player')});
        preferred.connect('changed', () => settings.set_string('preferred-player', preferred.text)); live.add(preferred);
        // AirDrop: Notchy is the front end of airdrop-mt7921, which the user installs.
        const airdrop = group(general, _('AirDrop (experimental)'), _('Sending to and receiving from iPhones through the airdrop-mt7921 project. Works with MediaTek Wi-Fi (MT7921/MT7922). While AirDrop is active, Wi-Fi is paused; it reconnects by itself afterwards. Only “Everyone for 10 Minutes” on the iPhone.'));
        toggle(airdrop, 'airdrop-enabled', _('Offer AirDrop in Notchy'), _('A button in the island’s header, an AirDrop area while dragging, “Send with AirDrop” in the Shelf.'));
        const home = GLib.get_home_dir();
        const found = () => {
            const configured = settings.get_string('airdrop-daemon');
            const candidates = configured ? [configured] : ['airdrop-mt7921', 'src/airdrop-mt7921', 'Projekte/airdrop-mt7921', 'Schreibtisch/airdrop-mt7921', 'Desktop/airdrop-mt7921', 'git/airdrop-mt7921'].map(dir => `${home}/${dir}/daemon/airdropd`);
            try { const target = GLib.file_read_link('/usr/local/bin/airdrop-send'); candidates.unshift(`${GLib.path_get_dirname(target)}/airdropd`); } catch { /* Not linked. */ }
            return candidates.find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ?? '';
        };
        const status = new Adw.ActionRow({title: _('Backend')});
        const sync = () => { const path = found(); status.subtitle = path ? fmt(_('Found: %s'), path) : _('Not found. Install airdrop-mt7921 (guide on the right) or enter the path below.'); };
        const guide = new Gtk.LinkButton({uri: 'https://github.com/jedbillyb/airdrop-mt7921#install', label: _('Guide'), valign: Gtk.Align.CENTER});
        status.add_suffix(guide); airdrop.add(status);
        const daemon = new Adw.EntryRow({title: _('Path to airdropd (empty = search automatically)'), text: settings.get_string('airdrop-daemon')});
        daemon.connect('changed', () => { settings.set_string('airdrop-daemon', daemon.text.trim()); sync(); }); airdrop.add(daemon);
        const folder = new Adw.EntryRow({title: _('Folder for received files (empty = Downloads/AirDrop)'), text: settings.get_string('airdrop-folder')});
        folder.connect('changed', () => settings.set_string('airdrop-folder', folder.text.trim())); airdrop.add(folder);
        sync();
        this.thunderstormPage(window, settings, page, group, toggle, number);
        this.airpodsPage(settings, page, group, toggle, number);
        this.agentsPage(window, settings, page, group, toggle, number);
        const privacy = page(_('Clipboard'), 'edit-paste-symbolic');
        const history = group(privacy, _('History'), _('Stored locally. Recording and keeping it across sessions are off at first.'));
        toggle(history, 'clipboard-enabled', _('Record the clipboard'));
        toggle(history, 'clipboard-persist', _('Keep the history between sessions'), _('The file lies locally in your home folder and is not encrypted.'));
        number(history, 'clipboard-limit', _('Maximum entries besides favorites'), 10, 1000, 10);
        number(history, 'clipboard-retention-days', _('Keep for days'), 1, 365);
        const excluded = new Adw.EntryRow({title: _('Excluded apps (.desktop ids, separated by commas)'), text: settings.get_strv('exclude-apps').join(', ')});
        excluded.connect('changed', () => settings.set_strv('exclude-apps', excluded.text.split(',').map(x => x.trim()).filter(Boolean))); history.add(excluded);
        const shortcuts = page(_('Shortcuts'), 'input-keyboard-symbolic');
        const keys = group(shortcuts, _('Global Shortcuts'), _('GTK syntax, for example &lt;Super&gt;&lt;Shift&gt;space. Leave empty to turn one off.'));
        for (const [key, title] of [['toggle-search', _('Thunderstorm search')], ['toggle-island', _('Open the island')], ['toggle-clipboard', _('Clipboard')], ['toggle-basket', _('Basket')], ['toggle-ring', _('Radial menu for captures')]]) {
            const row = new Adw.EntryRow({title, text: settings.get_strv(key)[0] ?? ''}); row.show_apply_button = true;
            row.connect('apply', () => {
                const text = row.text.trim(); const [ok, keyval, mods] = Gtk.accelerator_parse(text);
                if (!text || (ok && keyval && mods)) { settings.set_strv(key, text ? [text] : []); row.remove_css_class('error'); } else row.add_css_class('error');
            }); keys.add(row);
        }
        const about = page(_('About'), 'help-about-symbolic');
        const info = group(about, _('Notchy · Droppy for GNOME'), _('An independent GNOME implementation inspired by Droppy. Not an official Droppy port.'));
        info.add(new Adw.ActionRow({title: _('GNOME Shell 50 · Wayland · top bar'), subtitle: _('Notchy integrates into the clock of the top bar on the primary monitor.')}));
        info.add(new Adw.ActionRow({title: _('File processing'), subtitle: _('ZIP built in. Picture conversion: ImageMagick. Text recognition: Tesseract. Video: FFmpeg. Office: LibreOffice.')}));
        info.add(new Adw.ActionRow({title: _('Droplets'), subtitle: _('The small tools are removed for now and will return later under a new name.')}));
        return added;
    }

    // Thunderstorm: file search through GNOME LocalSearch, system commands, quicklinks, snippets.
    thunderstormPage(window, settings, page, group, toggle, number) {
        const storm = page('Thunderstorm', 'weather-storm-symbolic');
        const search = group(storm, _('Search'), _('Super + Space opens Thunderstorm: apps, files, commands, calculations and units, quicklinks, clipboard, snippets and emoji. Everything runs locally, without an account and without a cloud.'));
        toggle(search, 'launcher-file-search', _('Search files and folders'), _('Through the file index of GNOME LocalSearch. Without it: a bounded search in the personal folders.'));
        number(search, 'launcher-max-results', _('Visible results'), 5, 12);
        const web = new Adw.EntryRow({title: _('Web search ({query} stands for the search term)'), text: settings.get_string('launcher-web-search')});
        web.connect('changed', () => {
            const valid = quicklinkTarget({url: web.text.trim()}, 'test')?.kind === 'url';
            valid ? web.remove_css_class('error') : web.add_css_class('error');
            if (valid) settings.set_string('launcher-web-search', web.text.trim());
        });
        search.add(web);

        // System commands: their own page with every built-in command.
        const commands = group(storm, _('System Commands'), _('Lock, restart and shut down, settings pages, Do Not Disturb, AirPods and window commands.'));
        const open = new Adw.ActionRow({title: _('Configure System Commands'), activatable: true});
        open.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        const summary = () => {
            const config = parseCommandConfig(settings.get_string('launcher-commands'));
            const off = COMMANDS.filter(def => !effective(def, config).enabled).length, changed = Object.keys(config).filter(id => COMMANDS.some(c => c.id === id)).length;
            open.subtitle = [fmt(ngettext('%d command', '%d commands', COMMANDS.length), COMMANDS.length),
                off ? fmt(ngettext('%d switched off', '%d switched off', off), off) : '', changed ? fmt(ngettext('%d customized', '%d customized', changed), changed) : ''].filter(Boolean).join(' · ');
        };
        const summaryId = settings.connect('changed::launcher-commands', summary); open.connect('destroy', () => settings.disconnect(summaryId));
        open.connect('activated', () => window.push_subpage(this.commandsPage(settings)));
        commands.add(open); summary();

        // Which folders LocalSearch indexes; changes go to LocalSearch's own user settings.
        const index = group(storm, _('File Index (GNOME LocalSearch)'), _('Notchy only searches what LocalSearch has already indexed. Adding folders here changes LocalSearch’s settings for your user, not the system.'));
        const status = new Adw.ActionRow({title: 'LocalSearch', subtitle: _('Checking…')}); index.add(status);
        Promise.all([hasOwner(LOCALSEARCH), hasOwner('org.freedesktop.Tracker3.Miner.Files')]).then(([a, b]) => {
            status.subtitle = a || b ? _('Running · file search through the index') : _('Not running · Thunderstorm searches the personal folders in a basic way. Install or turn on the “localsearch” package for the full search.');
        });
        const source = Gio.SettingsSchemaSource.get_default(), miner = source?.lookup(MINER, true) ? new Gio.Settings({schema_id: MINER}) : null;
        const home = GLib.get_home_dir(), folderRows = [];
        const name = path => path === '$HOME' || path === home ? _('Home Folder') : path.startsWith('&') ? `${path.slice(1).charAt(0)}${path.slice(2).toLowerCase()} (XDG)` : path.replace(home, '~');
        const drawFolders = () => {
            for (const row of folderRows.splice(0)) index.remove(row);
            if (!miner) { const row = new Adw.ActionRow({title: _('LocalSearch’s settings not found'), subtitle: _('Without LocalSearch there are no indexed folders.')}); index.add(row); folderRows.push(row); return; }
            for (const path of miner.get_strv('index-recursive-directories')) {
                const row = new Adw.ActionRow({title: name(path), subtitle: _('Indexed with subfolders')});
                const remove = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Stop indexing'), css_classes: ['flat']});
                remove.connect('clicked', () => { miner.set_strv('index-recursive-directories', miner.get_strv('index-recursive-directories').filter(p => p !== path)); drawFolders(); });
                row.add_suffix(remove); index.add(row); folderRows.push(row);
            }
            const add = new Adw.ButtonRow({title: _('Add Folder to the Index…'), start_icon_name: 'list-add-symbolic'});
            add.connect('activated', () => new Gtk.FileDialog({title: _('Folder for the File Search')}).select_folder(window, null, (dialog, result) => {
                try {
                    const folder = dialog.select_folder_finish(result).get_path();
                    const list = miner.get_strv('index-recursive-directories');
                    if (folder && !list.includes(folder)) miner.set_strv('index-recursive-directories', [...list, folder]);
                    drawFolders();
                } catch { /* Cancelled. */ }
            }));
            index.add(add); folderRows.push(add);
        };
        drawFolders();
        const extra = new Adw.EntryRow({title: _('More folders for the basic search (without LocalSearch, separated by commas)'), text: settings.get_strv('launcher-extra-folders').join(', ')});
        extra.connect('changed', () => settings.set_strv('launcher-extra-folders', extra.text.split(',').map(x => x.trim()).filter(x => x.startsWith('/'))));
        index.add(extra);

        // Quicklinks: keyword, name, target.
        const links = group(storm, _('Quicklinks'), _('Keyword, space, search term: “yt lofi”, “gh notchy”, “wiki Zürich”. Target: an http(s) address with {query} or {path}, xdg:DOWNLOAD, a folder (~/…) or app:ID.desktop.'));
        this.listEditor(links, settings, 'launcher-quicklinks', ['keyword', 'name', 'url'], [['name', _('Name')], ['keyword', _('Keyword')], ['url', _('Target')]],
            item => item.name || item.keyword || _('New Quicklink'), item => quicklinkTarget(item, 'test') !== null && /^\S+$/.test(item.keyword), {keyword: '', name: '', url: 'https://'}, () => defaultQuicklinks());
        // Snippets: name, keyword, text.
        const snippets = group(storm, _('Snippets'), _('Text blocks: type the name or keyword, Enter copies it. {date}, {time} and {datetime} are replaced. Pasting into other apps automatically is not reliably and safely possible under Wayland and is therefore not offered.'));
        this.listEditor(snippets, settings, 'launcher-snippets', ['name', 'text'], [['name', _('Name')], ['keyword', _('Keyword (optional)')], ['text', _('Text')]],
            item => item.name || _('New Snippet'), item => Boolean(item.name && item.text), {name: '', keyword: '', text: ''}, () => defaultSnippets());
    }
    // An editable list stored as JSON in one setting: one expander per entry.
    // While the setting is empty, the language's defaults are shown; the first
    // edit stores the whole list, which from then on is the user's own.
    listEditor(group, settings, key, required, fields, title, valid, blank, defaults) {
        const rows = [];
        const read = () => savedOrDefault(settings.get_string(key), required, defaults);
        const save = items => settings.set_string(key, JSON.stringify(items));
        const draw = () => {
            for (const row of rows.splice(0)) group.remove(row);
            const items = read();
            items.forEach((item, i) => {
                // User data, never markup (a quicklink called "Q&A").
                const expander = new Adw.ExpanderRow({title: title(item), subtitle: item.keyword ?? '', use_markup: false});
                for (const [field, label] of fields) {
                    const entry = new Adw.EntryRow({title: label, text: String(item[field] ?? '').replace(/\n/g, '\\n'), use_markup: false});
                    entry.connect('changed', () => {
                        const next = read(); if (!next[i]) return;
                        next[i] = {...next[i], [field]: field === 'text' ? entry.text.replace(/\\n/g, '\n') : entry.text.trim()};
                        const ok = valid(next[i]);
                        ok ? expander.remove_css_class('error') : expander.add_css_class('error');
                        expander.title = title(next[i]); expander.subtitle = next[i].keyword ?? '';
                        save(next);
                    });
                    expander.add_row(entry);
                }
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Remove'), css_classes: ['flat']});
                remove.connect('clicked', () => { save(read().filter((_x, j) => j !== i)); draw(); });
                expander.add_suffix(remove);
                if (!valid(item)) expander.add_css_class('error');
                group.add(expander); rows.push(expander);
            });
            const add = new Adw.ButtonRow({title: _('Add'), start_icon_name: 'list-add-symbolic'});
            // A new entry is stored only once it has its required fields.
            add.connect('activated', () => { const items = read(); items.push({...blank, name: blank.name || _('New'), ...(required.includes('text') ? {text: ' '} : {})}); save(items); draw(); });
            group.add(add); rows.push(add);
            // Back to the defaults of the current language.
            if (settings.get_string(key).trim()) {
                const reset = new Adw.ButtonRow({title: _('Restore Defaults'), start_icon_name: 'edit-undo-symbolic'});
                reset.connect('activated', () => { settings.set_string(key, ''); draw(); });
                group.add(reset); rows.push(reset);
            }
        };
        draw();
    }

    // Thunderstorm's built-in commands, one row each by category: on or off,
    // shown in results or only by shortcut, favourite, priority, own search
    // terms and a shortcut. Stored per command id (src/launcher/commands.js);
    // confirmations of shutting down and the like are not a setting.
    commandsPage(settings) {
        const KEY = 'launcher-commands';
        const config = () => parseCommandConfig(settings.get_string(KEY));
        // Every change starts from what is stored now, so quick successive
        // edits of different commands never undo one another.
        const update = (id, patch) => settings.set_string(KEY, updateCommandConfig(settings.get_string(KEY), id, patch));
        const quicklinkKeywords = () => savedOrDefault(settings.get_string('launcher-quicklinks'), ['keyword', 'name', 'url'], () => defaultQuicklinks()).map(l => l.keyword);
        const content = new Adw.PreferencesPage();
        const top = new Adw.PreferencesGroup({description: _('Thunderstorm finds these commands by their name and by German and English search terms, whatever language Notchy speaks. Context-dependent commands (AirPods, windows, workspaces) appear only when they can work.')});
        const search = new Gtk.SearchEntry({placeholder_text: _('Search commands'), hexpand: true, margin_bottom: 6});
        top.add(search);
        const resetAll = new Gtk.Button({label: _('Reset All'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
        resetAll.connect('clicked', () => settings.set_string(KEY, '{}'));
        top.set_header_suffix(resetAll);
        content.add(top);
        const rows = [], groups = [];
        let syncing = false;
        const PRIORITY_LABELS = [_('Lowest'), _('Low'), _('Normal'), _('High'), _('Highest')];
        for (const category of CATEGORIES) {
            // Group titles are markup: "Power & Session" needs its & escaped.
            const g = new Adw.PreferencesGroup({title: GLib.markup_escape_text(_(category.title), -1)});
            content.add(g); groups.push(g);
            for (const def of COMMANDS.filter(c => c.category === category.id)) {
                const row = new Adw.ExpanderRow({title: _(def.title), show_enable_switch: true, use_markup: false});
                g.add(row);
                row.add_prefix(new Gtk.Image({icon_name: def.icon}));
                const visible = new Adw.SwitchRow({title: _('Show in search results'), subtitle: _('Off: only its shortcut finds it.')});
                const favorite = new Adw.SwitchRow({title: _('Favorite'), subtitle: _('Listed when the search field is empty, and ranked a little higher.')});
                const priority = new Adw.ComboRow({title: _('Priority'), subtitle: _('Orders it among results that match equally well.'), model: Gtk.StringList.new(PRIORITY_LABELS)});
                const aliases = new Adw.EntryRow({title: _('Own search terms (separated by commas)'), show_apply_button: true});
                const shortcut = new Adw.EntryRow({title: _('Shortcut (typed exactly, it comes first)'), show_apply_button: true});
                const collision = new Adw.ActionRow({title: _('Also used elsewhere'), visible: false, css_classes: ['warning'], use_markup: false});
                collision.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
                const about = new Adw.ActionRow({title: _(def.description), subtitle: fmt(_('Always found by: %s'), def.keywords.join(', ')), subtitle_selectable: true, use_markup: false});
                for (const child of [visible, favorite, priority, aliases, shortcut, collision, about]) row.add_row(child);
                if (def.requiresConfirmation) {
                    const safety = new Adw.ActionRow({title: _('Always asks for confirmation'), subtitle: _('A second Enter confirms, Esc cancels. No setting turns this off.')});
                    safety.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
                    row.add_row(safety);
                }
                const reset = new Adw.ButtonRow({title: _('Reset to Defaults'), start_icon_name: 'edit-undo-symbolic'});
                reset.connect('activated', () => update(def.id, null));
                row.add_row(reset);
                row.connect('notify::enable-expansion', () => { if (!syncing) update(def.id, {enabled: row.enable_expansion}); });
                visible.connect('notify::active', () => { if (!syncing) update(def.id, {visible: visible.active}); });
                favorite.connect('notify::active', () => { if (!syncing) update(def.id, {favorite: favorite.active}); });
                priority.connect('notify::selected', () => { if (!syncing) update(def.id, {priority: PRIORITIES[priority.selected] ?? 0}); });
                aliases.connect('apply', () => update(def.id, {aliases: aliases.text.split(',').map(a => a.trim()).filter(Boolean)}));
                shortcut.connect('apply', () => {
                    const text = shortcut.text.trim();
                    // Letters, digits and . _ + - only, at most 16 characters.
                    if (text && !sanitizeOverride({shortcut: text})?.shortcut) { shortcut.add_css_class('error'); return; }
                    shortcut.remove_css_class('error'); update(def.id, {shortcut: text});
                });
                rows.push({def, row, visible, favorite, priority, aliases, shortcut, collision, reset, group: g});
            }
        }
        const STATE = cfg => [!cfg.enabled ? _('Off') : !cfg.visible ? (cfg.shortcut ? _('Only by its shortcut') : _('Hidden')) : '',
            cfg.favorite ? _('Favorite') : '', cfg.priority > 0 ? _('Higher priority') : cfg.priority < 0 ? _('Lower priority') : '',
            cfg.shortcut ? fmt(_('Shortcut “%s”'), cfg.shortcut) : '', cfg.aliases.length ? fmt(ngettext('%d own search term', '%d own search terms', cfg.aliases.length), cfg.aliases.length) : '',
        ].filter(Boolean).join(' · ');
        const refresh = () => {
            const current = config(), clashes = aliasCollisions(current, quicklinkKeywords());
            syncing = true;
            for (const r of rows) {
                const cfg = effective(r.def, current);
                if (r.row.enable_expansion !== cfg.enabled) r.row.enable_expansion = cfg.enabled;
                r.visible.active = cfg.visible; r.favorite.active = cfg.favorite;
                r.priority.selected = Math.max(0, PRIORITIES.indexOf(cfg.priority));
                // Text being typed (not applied yet) is left alone.
                for (const [entry, value] of [[r.aliases, cfg.aliases.join(', ')], [r.shortcut, cfg.shortcut]]) {
                    if (entry.text === (entry.notchyShown ?? '')) entry.text = value;
                    entry.notchyShown = value;
                }
                const state = STATE(cfg);
                r.row.subtitle = [state || (r.def.requiresConfirmation ? _('Asks for confirmation') : _('Default')), r.def.context ? _('context-dependent') : ''].filter(Boolean).join(' · ');
                // Search terms that more than one command (or a quicklink keyword) claims.
                const mine = [...cfg.aliases, cfg.shortcut].filter(Boolean).map(fold);
                const shared = [...clashes].filter(([text]) => mine.includes(text)).map(([text, owners]) => `${text} → ${owners.filter(o => o !== r.def.id)
                    .map(o => (o.startsWith('quicklink:') ? fmt(_('quicklink %s'), o.slice(10)) : _(COMMANDS.find(c => c.id === o)?.title ?? o))).join(', ')}`);
                r.collision.visible = shared.length > 0; r.collision.subtitle = shared.join('; ');
                r.reset.sensitive = Boolean(current[r.def.id]);
            }
            syncing = false;
        };
        const filter = () => {
            const q = fold(search.text.trim());
            for (const r of rows) {
                const cfg = effective(r.def, config());
                r.row.visible = !q || [_(r.def.title), r.def.title, ...r.def.keywords, ...cfg.aliases].some(term => fold(term).includes(q));
            }
            for (const g of groups) g.visible = rows.some(r => r.group === g && r.row.visible);
        };
        search.connect('search-changed', filter);
        const id = settings.connect(`changed::${KEY}`, () => { refresh(); filter(); });
        const linksId = settings.connect('changed::launcher-quicklinks', refresh);
        refresh();
        const toolbar = new Adw.ToolbarView({content});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const subpage = new Adw.NavigationPage({title: _('System Commands'), tag: 'notchy-commands', child: toolbar});
        subpage.connect('destroy', () => { settings.disconnect(id); settings.disconnect(linksId); });
        return subpage;
    }

    // AirPods: through the optional airpods-helper daemon (or BlueZ for basics).
    airpodsPage(settings, page, group, toggle, number) {
        const pods = page('AirPods', 'audio-headphones-symbolic');
        const main = group(pods, 'AirPods', _('Battery levels, noise control and a connection animation in the island. For more, Notchy uses the optional airpods-helper service; it installs or changes nothing on the system itself.'));
        toggle(main, 'airpods-enabled', _('AirPods integration'));
        toggle(main, 'airpods-animation', _('Connection animation'), _('When they connect, the island grows briefly and shows the battery levels.'));
        toggle(main, 'airpods-bubble', _('Symbol beside the notch'), _('Connected AirPods as a small symbol with a battery ring beside the clock; a click opens their controls.'));
        toggle(main, 'airpods-battery-warning', _('Warn when the battery is low'));
        number(main, 'airpods-battery-threshold', _('Warn below (percent)'), 5, 50, 5);
        toggle(main, 'airpods-builtin', _('Without airpods-helper: read the AirPods directly'), _('Notchy reads connected AirPods itself over Apple’s accessory protocol (AAP): battery levels of buds and case, ear detection, noise control. Without root, without extra software.'));
        toggle(main, 'airpods-ear-pause', _('Pause media when an AirPod is taken out'), _('Applies to reading them directly; with airpods-helper its own setting (below) controls the pause.'));
        toggle(main, 'airpods-bluez-fallback', _('Basic data from BlueZ'), _('The connection (and a battery level, if the system reports one) while nothing else is available.'));
        const backend = group(pods, _('Service'), '');
        const status = new Adw.ActionRow({title: 'airpods-helper', subtitle: _('Checking…')}); backend.add(status);
        const guide = new Gtk.LinkButton({uri: 'https://github.com/superninjv/airpods-helper#readme', label: _('Guide'), valign: Gtk.Align.CENTER}); status.add_suffix(guide);
        const start = new Gtk.Button({label: _('Start'), valign: Gtk.Align.CENTER, visible: false}); status.add_suffix(start);
        const pause = new Adw.SwitchRow({title: _('Pause media when an AirPod is taken out'), subtitle: _('The service’s setting (PauseOnRemoval); it controls playback itself.'), sensitive: false});
        backend.add(pause);
        let syncing = false;
        const refresh = async () => {
            const running = await hasOwner(AIRPODS);
            const installed = running || await bus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListActivatableNames').then(([names]) => names.includes(AIRPODS)).catch(() => false);
            start.visible = installed && !running; pause.sensitive = running;
            if (!running) { status.subtitle = installed ? _('Installed, but not running. Notchy reads the AirPods itself meanwhile.') : _('Not installed – not needed: Notchy reads connected AirPods itself. airpods-helper adds an equalizer and more.'); return; }
            try {
                const [props] = await bus(AIRPODS, '/org/costa/AirPods', 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', ['org.costa.AirPods']));
                const value = name => props[name]?.deep_unpack?.() ?? props[name];
                const running = value('Version') ? fmt(_('Running (version %s)'), value('Version')) : _('Running');
                status.subtitle = `${running} · ${value('Connected') ? fmt(_('%s connected'), value('ModelName') || 'AirPods') : _('no AirPods connected')}`;
                syncing = true; pause.active = Boolean(value('PauseOnRemoval')); syncing = false;
            } catch (e) { status.subtitle = fmt(_('Running, but not answering: %s'), e.message); }
        };
        pause.connect('notify::active', () => {
            if (syncing) return;
            Gio.DBus.session.call(AIRPODS, '/org/costa/AirPods', 'org.freedesktop.DBus.Properties', 'Set', new GLib.Variant('(ssv)', ['org.costa.AirPods', 'PauseOnRemoval', new GLib.Variant('b', pause.active)]),
                null, Gio.DBusCallFlags.NONE, 3000, null, (c, r) => { try { c.call_finish(r); } catch { refresh(); } });
        });
        // Only on request: D-Bus starts the user's installed service.
        start.connect('clicked', () => Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'StartServiceByName', new GLib.Variant('(su)', [AIRPODS, 0]),
            null, Gio.DBusCallFlags.NONE, 10000, null, (c, r) => { try { c.call_finish(r); } catch (e) { status.subtitle = fmt(_('Starting failed: %s'), e.message); } refresh(); }));
        refresh();
    }
    // AI agents beside the notch, and the optional hook adapters. Nothing in an
    // agent's own configuration changes without a click and a confirmation.
    agentsPage(window, settings, page, group, toggle, number) {
        const agents = page(_('Agents'), 'system-run-symbolic');
        const main = group(agents, _('Agents Beside the Notch'), _('Claude Code, Codex and Antigravity report their state to Notchy through their own hooks: working, waiting for you, done, error. A program that merely runs never counts as “working”. Prompts and contents are neither read nor stored.'));
        toggle(main, 'agents-enabled', _('Show agent indicators'));
        toggle(main, 'agents-auto-layout', _('Distribute left and right automatically'), _('New indicators go to the side with more room; the notch stays in the middle.'));
        toggle(main, 'agents-show-idle', _('Show ready agents without a task'), _('As a calm, still symbol.'));
        toggle(main, 'agents-completion-animation', _('Short animation when a task is done'));
        number(main, 'agents-completed-seconds', _('Show “Done” for (seconds)'), 2, 120, 1, _('After that, the agent counts as ready.'));
        const SIDES = ['auto', 'left', 'right'];
        const readSides = () => { try { return JSON.parse(settings.get_string('agents-side')) ?? {}; } catch { return {}; } };
        const hooks = group(agents, _('Integrations'), _('Set Up adds Notchy’s hook adapter to the agent’s configuration beside your existing hooks and makes a backup first. Remove takes out exactly these entries again.'));
        const ctl = `${this.path}/scripts/notchyctl`;
        const run = args => new Promise(resolve => {
            try {
                // notchyctl's messages in Notchy's language.
                const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
                const language = settings.get_string('language');
                if (language === 'de' || language === 'en') launcher.setenv('NOTCHY_LANGUAGE', language, true);
                const proc = launcher.spawnv(['/usr/bin/python3', ctl, 'agent', 'hooks', ...args, '--json']);
                proc.communicate_utf8_async(null, null, (p, result) => {
                    try { const [, out] = p.communicate_utf8_finish(result); resolve(JSON.parse(out)); } catch (e) { resolve([{ok: false, error: e.message}]); }
                });
            } catch (e) { resolve([{ok: false, error: e.message}]); }
        });
        const STATE = {installed: _('Set up'), partial: _('Partly set up'), missing: _('Not set up'), error: _('Configuration broken')};
        for (const [id, name, key] of [['claude', 'Claude Code', 'agents-claude'], ['codex', 'Codex', 'agents-codex'], ['antigravity', 'Antigravity', 'agents-antigravity']]) {
            const row = new Adw.ExpanderRow({title: name, subtitle: _('Checking…'), show_enable_switch: true});
            settings.bind(key, row, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
            const side = new Adw.ComboRow({title: _('Preferred side'), model: Gtk.StringList.new([_('Automatic'), _('Left'), _('Right')]), selected: Math.max(0, SIDES.indexOf(readSides()[id] ?? 'auto'))});
            side.connect('notify::selected', () => { const all = readSides(); all[id] = SIDES[side.selected]; if (all[id] === 'auto') delete all[id]; settings.set_string('agents-side', JSON.stringify(all)); });
            row.add_row(side);
            const config = new Adw.ActionRow({title: _('Hook adapter'), subtitle: ''});
            const install = new Gtk.Button({label: _('Set Up'), valign: Gtk.Align.CENTER}), remove = new Gtk.Button({label: _('Remove'), valign: Gtk.Align.CENTER});
            install.add_css_class('suggested-action');
            config.add_suffix(install); config.add_suffix(remove); row.add_row(config);
            hooks.add(row);
            let path = '';
            const refresh = async () => {
                const [status] = await run(['status', '--provider', id]);
                if (!status || status.ok === false) { row.subtitle = fmt(_('State unknown: %s'), status?.error ?? ''); return; }
                path = status.config;
                row.subtitle = `${STATE[status.state] ?? status.state}${status.program ? '' : ` · ${_('program not found')}`}`;
                config.subtitle = [status.config, status.error, status.note].filter(Boolean).join(' · ');
                install.sensitive = status.state !== 'installed' && status.state !== 'error';
                remove.sensitive = ['installed', 'partial'].includes(status.state);
            };
            const confirm = action => {
                const install = action === 'install';
                const dialog = new Adw.AlertDialog({heading: fmt(install ? _('%s: Set Up Hooks?') : _('%s: Remove Hooks?'), name),
                    body: install ? `${fmt(_('Notchy adds its hook adapter to %s. Existing hooks stay unchanged; a backup is made first.'), path)}${id === 'codex' ? ` ${_('Codex runs the new hooks only after you trusted them with /hooks.')}` : ''}`
                        : fmt(_('Notchy removes only its own entries from %s; a backup is made first.'), path)});
                dialog.add_response('cancel', _('Cancel')); dialog.add_response('ok', install ? _('Set Up') : _('Remove'));
                dialog.set_response_appearance('ok', install ? Adw.ResponseAppearance.SUGGESTED : Adw.ResponseAppearance.DESTRUCTIVE);
                dialog.connect('response', async (_d, response) => {
                    if (response !== 'ok') return;
                    const [result] = await run([action, '--provider', id]);
                    if (result?.ok === false) config.subtitle = fmt(_('Not changed: %s'), result.error);
                    refresh();
                });
                dialog.present(window);
            };
            install.connect('clicked', () => confirm('install'));
            remove.connect('clicked', () => confirm('uninstall'));
            refresh();
        }
        const other = group(agents, _('Other Agents and ChatGPT'), _('ChatGPT in the browser and in the desktop app offer no status interface; Notchy reads nothing there. Your own scripts and other agents report with notchyctl or through the MCP server (tools agent_status, agent_end).'));
        other.add(new Adw.ActionRow({title: 'notchyctl agent update --session ID --state working', subtitle: _('More commands: start, heartbeat, stop, list; details in the README.'), subtitle_selectable: true}));
    }
}
