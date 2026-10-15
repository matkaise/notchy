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
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { print('NOTCHY_PREFS_TEST_OK'); window.close(); app.quit(); return GLib.SOURCE_REMOVE; });
});
app.run([]);
