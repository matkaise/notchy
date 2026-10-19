import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const path = GLib.getenv('NOTCHY_EXTENSION_PATH');
const {default: Preferences} = await import(`file://${path}/prefs.js`);
const i18n = await import(`file://${path}/src/i18n/core.js`);
const [ok, bytes] = Gio.File.new_for_path(`${path}/metadata.json`).load_contents(null);
if (!ok) throw Error('No metadata');
const metadata = {...JSON.parse(new TextDecoder().decode(bytes)), path, dir: Gio.File.new_for_path(path)};
const prefs = new Preferences(metadata);
const app = new Adw.Application({application_id: 'org.notchy.PreferencesTest'});
// Every widget below a widget, for checks on the pages.
const all = widget => { const out = [widget]; for (let c = widget.get_first_child(); c; c = c.get_next_sibling()) out.push(...all(c)); return out; };
const fail = message => { print(`NOTCHY_PREFS_TEST_FAILED: ${message}`); };
// The checks below read German (the Shell suite chose German for Notchy already).
prefs.getSettings().set_string('language', 'de');
app.connect('activate', () => {
    const window = new Adw.PreferencesWindow({application: app, title: 'Notchy Test Preferences'});
    prefs.fillPreferencesWindow(window); window.present();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        try {
            const widgets = all(window), titles = widgets.filter(w => w instanceof Adw.PreferencesPage).map(w => w.title);
            const missing = ['Darstellung', 'Thunderstorm', 'AirPods', 'Agenten', 'Ablage', 'Tastenkürzel', 'Info'].filter(t => !titles.includes(t));
            const expanders = widgets.filter(w => w instanceof Adw.ExpanderRow).map(w => w.title);
            const rows = widgets.filter(w => w instanceof Adw.PreferencesRow).map(w => w.title);
            if (missing.length) return fail(`missing pages ${missing.join(', ')}`);
            if (!['YouTube', 'GitHub', 'Wikipedia', 'Freundliche Grüsse'].every(t => expanders.includes(t))) return fail(`quicklink and snippet editors (${expanders.join(', ')})`);
            if (!['Claude Code', 'Codex', 'Antigravity'].every(t => expanders.includes(t))) return fail(`agent integrations (${expanders.join(', ')})`);
            print('PASS: preferences offer Thunderstorm (quicklinks, snippets, file index), AirPods and agent pages with each integration');
            const language = widgets.find(w => w instanceof Adw.ComboRow && w.title === 'Sprache');
            if (!language || language.model.get_n_items() !== 3 || language.model.get_string(1) !== 'Deutsch' || language.model.get_string(2) !== 'English') return fail('the language row');
            print('PASS: Appearance offers the language: automatic, Deutsch, English');
            // Thunderstorm → System Commands: a subpage with every command by category.
            const open = widgets.find(w => w instanceof Adw.ActionRow && w.title === 'Systembefehle einrichten');
            if (!open) return fail(`the System Commands row (${rows.filter(Boolean).slice(0, 40).join(', ')})`);
            const page = prefs.commandsPage(prefs.getSettings());
            const inside = all(page), commandRows = inside.filter(w => w instanceof Adw.ExpanderRow), groups = inside.filter(w => w instanceof Adw.PreferencesGroup).map(g => g.title.replace(/&amp;/g, '&')).filter(Boolean);
            const {COMMANDS} = commandsModule;
            if (commandRows.length !== COMMANDS.length) return fail(`${commandRows.length} command rows for ${COMMANDS.length} commands`);
            if (!['Energie & Sitzung', 'Einstellungen', 'System & Benachrichtigungen', 'Geräte', 'Fenster'].every(t => groups.includes(t))) return fail(`command categories (${groups.join(', ')})`);
            const shutdown = commandRows.find(r => r.title === 'Ausschalten');
            if (!shutdown || !all(shutdown).some(w => w instanceof Adw.ActionRow && w.title === 'Fragt immer nach einer Bestätigung')) return fail('shutting down shows that it always asks first');
            if (all(shutdown).some(w => w instanceof Adw.SwitchRow && /Bestätigung/.test(w.title))) return fail('a switch for the confirmation');
            print('PASS: System Commands lists every built-in command by category; shutting down states its confirmation and offers no switch for it');
            // Switching a command off in the list stores it by id.
            const settings = prefs.getSettings(), before = settings.get_string('launcher-commands');
            const suspend = commandRows.find(r => r.title === 'Bereitschaft');
            suspend.enable_expansion = false;
            const stored = JSON.parse(settings.get_string('launcher-commands'));
            settings.set_string('launcher-commands', before);
            if (stored['system.suspend']?.enabled !== false) return fail(`switching suspend off stored ${JSON.stringify(stored)}`);
            print('PASS: a command switched off in the list is stored under its id');
            // Live Activities: types, priorities with arrows, the agent control center's options.
            if (!titles.includes('Live-Aktivitäten')) return fail(`the Live Activities page (${titles.join(', ')})`);
            const priorityRows = widgets.filter(w => w instanceof Adw.ActionRow && /^\d\. /.test(w.title ?? ''));
            if (priorityRows.length !== 7 || priorityRows[0].title !== '1. Braucht dich' || priorityRows[6].title !== '7. Hintergrundaktivitäten') return fail(`priority rows (${priorityRows.map(r => r.title).join(', ')})`);
            priorityRows[5].up.emit('clicked');
            const order = settings.get_strv('activities-priority');
            if (order[4] !== 'media' || order[5] !== 'timer' || priorityRows[4].title !== '5. Medien') return fail(`moving media up stored ${order.join(', ')}`);
            settings.reset('activities-priority');
            const typeRow = widgets.find(w => w instanceof Adw.SwitchRow && w.title === 'Bildschirmaufnahme');
            if (!typeRow) return fail('a switch per activity type');
            typeRow.active = false;
            if (!settings.get_strv('activities-disabled-types').includes('recording')) return fail('switching a type off is stored');
            settings.reset('activities-disabled-types');
            for (const title of ['Wenn ein Agent dich braucht', 'Wenn ein Agent seine Aufgabe erledigt hat', 'Position der Indikatoren', 'Höchstens sichtbare Indikatoren', 'Beendete Sitzungen auflisten für (Minuten)'])
                if (!rows.includes(title)) return fail(`agent option „${title}“`);
            print('PASS: Live Activities: types, the priority order (arrows store it) and the agent control center\'s notifications, position and limits');
            // The same pages in English, built with an English backend (the shared setting stays).
            i18n.setBackend(i18n.catalogBackend(null, {language: 'en', locale: 'en-US'}));
            const english = new Adw.PreferencesWindow({application: app, title: 'Notchy Test Preferences (English)'});
            prefs.fill(english, prefs.getSettings());
            const englishTitles = all(english).filter(w => w instanceof Adw.PreferencesPage).map(w => w.title);
            const englishCommands = all(prefs.commandsPage(prefs.getSettings())).filter(w => w instanceof Adw.ExpanderRow).map(r => r.title);
            if (!['Appearance', 'Thunderstorm', 'Live Activities', 'AirPods', 'Agents', 'Clipboard', 'Shortcuts', 'About'].every(t => englishTitles.includes(t))) return fail(`English pages (${englishTitles.join(', ')})`);
            if (!['Shut Down', 'Lock Screen', 'Do Not Disturb'].every(t => englishCommands.includes(t))) return fail(`English commands (${englishCommands.slice(0, 8).join(', ')})`);
            const englishExpanders = all(english).filter(w => w instanceof Adw.ExpanderRow).map(w => w.title);
            if (!englishExpanders.includes('Kind regards') || !englishExpanders.includes('Wikipedia')) return fail(`English defaults (${englishExpanders.join(', ')})`);
            english.destroy();
            print('PASS: the preferences and their default snippets in English');
            print('NOTCHY_PREFS_TEST_OK');
        } catch (e) { fail(`${e.message}\n${e.stack}`); }
        finally { window.close(); app.quit(); }
        return GLib.SOURCE_REMOVE;
    });
});
const commandsModule = await import(`file://${path}/src/launcher/commands.js`);
app.run([]);
