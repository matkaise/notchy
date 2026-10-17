import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const path = GLib.getenv('NOTCHY_EXTENSION_PATH');
const {default: Preferences} = await import(`file://${path}/prefs.js`);
const [ok, bytes] = Gio.File.new_for_path(`${path}/metadata.json`).load_contents(null);
if (!ok) throw Error('No metadata');
const metadata = {...JSON.parse(new TextDecoder().decode(bytes)), path, dir: Gio.File.new_for_path(path)};
const prefs = new Preferences(metadata);
const app = new Adw.Application({application_id: 'org.notchy.PreferencesTest'});
app.connect('activate', () => {
    const window = new Adw.PreferencesWindow({application: app, title: 'Notchy Test Preferences'});
    prefs.fillPreferencesWindow(window); window.present();
    // Every widget below the window, for checks on the new pages.
    const all = widget => { const out = [widget]; for (let c = widget.get_first_child(); c; c = c.get_next_sibling()) out.push(...all(c)); return out; };
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        const widgets = all(window), titles = widgets.filter(w => w instanceof Adw.PreferencesPage).map(w => w.title);
        const missing = ['Darstellung', 'Thunderstorm', 'AirPods', 'Ablage', 'Tastenkürzel', 'Info'].filter(t => !titles.includes(t));
        const quicklinks = widgets.filter(w => w instanceof Adw.ExpanderRow).map(w => w.title);
        if (missing.length) print(`NOTCHY_PREFS_TEST_FAILED: missing pages ${missing.join(', ')}`);
        else if (!['YouTube', 'GitHub', 'Wikipedia', 'Freundliche Grüsse'].every(t => quicklinks.includes(t))) print(`NOTCHY_PREFS_TEST_FAILED: quicklink and snippet editors (${quicklinks.join(', ')})`);
        else { print('PASS: preferences offer Thunderstorm (quicklinks, snippets, file index) and AirPods pages'); print('NOTCHY_PREFS_TEST_OK'); }
        window.close(); app.quit(); return GLib.SOURCE_REMOVE;
    });
});
app.run([]);
