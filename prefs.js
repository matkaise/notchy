import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class NotchyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(); window.set_default_size(760, 720); window.set_search_enabled(true);
        const page = (title, icon) => { const p = new Adw.PreferencesPage({title, icon_name: icon}); window.add(p); return p; };
        const group = (p, title, description = '') => { const g = new Adw.PreferencesGroup({title, description}); p.add(g); return g; };
        const toggle = (g, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle}); settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT); g.add(row);
        };
        const number = (g, key, title, min, max, step = 1, subtitle = '') => {
            const row = new Adw.SpinRow({title, subtitle, adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT); g.add(row);
        };
        const general = page('Darstellung', 'preferences-desktop-appearance-symbolic');
        const look = group(general, 'Deine Island', 'Die GNOME-Uhr in der oberen Leiste wird zur Island; sie wächst um die Uhr herum.');
        const styles = ['dynamic', 'liquid'];
        const style = new Adw.ComboRow({title: 'Stil', subtitle: 'Dynamic Glass: schwarze Notch, die in Glas übergeht. Liquid Glass: schwebende Glaskapsel.',
            model: Gtk.StringList.new(['Dynamic Glass', 'Liquid Glass']), selected: Math.max(0, styles.indexOf(settings.get_string('style')))});
        style.connect('notify::selected', () => settings.set_string('style', styles[style.selected])); look.add(style);
        number(look, 'glass-level', 'Schwarzanteil in Prozent (Dynamic Glass)', 0, 100, 5, 'Anteil der geöffneten Fläche in Schwarz, bevor sie in Glas übergeht. 100 % ist komplett schwarz, ohne Glas.');
        number(look, 'width', 'Breite im geöffneten Zustand', 600, 900, 10);
        number(look, 'animation-duration', 'Animation in Millisekunden', 0, 800, 20);
        toggle(look, 'hide-fullscreen', 'Bei Vollbild ausblenden');
        const behavior = group(general, 'Bedienung');
        toggle(behavior, 'hover-open', 'Bei Mauszeigerkontakt öffnen');
        number(behavior, 'hover-delay', 'Öffnungsverzögerung in Millisekunden', 0, 2000, 50);
        number(behavior, 'collapse-delay', 'Schließverzögerung in Millisekunden', 100, 5000, 100);
        toggle(behavior, 'clock-opens-notchy', 'Uhr öffnet den Kalender-Reiter', 'Ein Klick auf Datum und Uhrzeit zeigt Benachrichtigungen und Kalender in Notchy statt im GNOME-Popup.');
        toggle(behavior, 'scroll-volume', 'Scrollen über der Island ändert die Lautstärke');
        toggle(behavior, 'drag-summon', 'Dateien direkt auf der Island ablegen', 'Beim Ziehen erscheint unter der Uhr eine Ablagefläche fürs Regal.');
        toggle(behavior, 'snap-enabled', 'Fenster in der Notch anordnen', 'Zieht man ein Fenster an die Uhr, bietet die Notch Layouts an (Hälften, Drittel, Viertel …).');
        toggle(behavior, 'jiggle-enabled', 'Korb durch Schütteln beim Ziehen öffnen');
        const live = group(general, 'Live-Aktivitäten');
        toggle(live, 'media-enabled', 'Medien in der Island anzeigen');
        toggle(live, 'media-waveform', 'Live-Wellenform anzeigen', 'Analysiert nur den Audiomonitorausgang während der Wiedergabe. Audiodaten werden nicht gespeichert.');
        toggle(live, 'airplay-enabled', 'AirPlay-Geräte im Netzwerk finden', 'Lautsprecher und Fernseher mit AirPlay erscheinen im Medien-Reiter als Ausgabe. Läuft als kleiner PipeWire-Dienst nur während Notchy aktiv ist.');
        toggle(live, 'hud-enabled', 'Lautstärke und Helligkeit in der Island anzeigen', 'Ersetzt GNOMEs Bildschirmanzeige, solange die Island geschlossen ist.');
        toggle(live, 'notifications-enabled', 'Benachrichtigungen in Notchy anzeigen', 'Neue Benachrichtigungen erscheinen als Banner aus der Island statt als GNOME-Banner. Nicht stören wird beachtet.');
        const preferred = new Adw.EntryRow({title: 'Bevorzugter MPRIS-Busname (leer = automatisch)', text: settings.get_string('preferred-player')});
        preferred.connect('changed', () => settings.set_string('preferred-player', preferred.text)); live.add(preferred);
        const privacy = page('Ablage', 'edit-paste-symbolic');
        const history = group(privacy, 'Verlauf', 'Lokal gespeichert. Aufzeichnung und dauerhafte Speicherung sind anfangs aus.');
        toggle(history, 'clipboard-enabled', 'Zwischenablage aufzeichnen');
        toggle(history, 'clipboard-persist', 'Verlauf zwischen Sitzungen behalten', 'Datei liegt lokal im Benutzerverzeichnis und ist nicht verschlüsselt.');
        number(history, 'clipboard-limit', 'Maximale Einträge ohne Favoriten', 10, 1000, 10);
        number(history, 'clipboard-retention-days', 'Aufbewahrung in Tagen', 1, 365);
        const excluded = new Adw.EntryRow({title: 'Ausgeschlossene Apps (.desktop-IDs, mit Komma trennen)', text: settings.get_strv('exclude-apps').join(', ')});
        excluded.connect('changed', () => settings.set_strv('exclude-apps', excluded.text.split(',').map(x => x.trim()).filter(Boolean))); history.add(excluded);
        const shortcuts = page('Tastenkürzel', 'input-keyboard-symbolic');
        const keys = group(shortcuts, 'Globale Shortcuts', 'GTK-Syntax, zum Beispiel &lt;Super&gt;&lt;Shift&gt;space. Leer lassen zum Deaktivieren.');
        for (const [key, title] of [['toggle-search', 'Thunderstorm-Suche'], ['toggle-island', 'Island öffnen'], ['toggle-clipboard', 'Ablage'], ['toggle-basket', 'Korb'], ['toggle-ring', 'Radialmenü für Aufnahmen']]) {
            const row = new Adw.EntryRow({title, text: settings.get_strv(key)[0] ?? ''}); row.show_apply_button = true;
            row.connect('apply', () => {
                const text = row.text.trim(); const [ok, keyval, mods] = Gtk.accelerator_parse(text);
                if (!text || (ok && keyval && mods)) { settings.set_strv(key, text ? [text] : []); row.remove_css_class('error'); } else row.add_css_class('error');
            }); keys.add(row);
        }
        const about = page('Info', 'help-about-symbolic');
        const info = group(about, 'Notchy · Droppy für GNOME', 'Eigenständige GNOME-Implementierung, inspiriert von Droppy. Kein offizieller Droppy-Port.');
        info.add(new Adw.ActionRow({title: 'GNOME Shell 50 · Wayland · obere Leiste', subtitle: 'Notchy integriert sich in die Uhr der oberen Leiste auf dem Hauptbildschirm.'}));
        info.add(new Adw.ActionRow({title: 'Dateiverarbeitung', subtitle: 'ZIP eingebaut. Bildkonvertierung: ImageMagick. Texterkennung: Tesseract. Video: FFmpeg. Office: LibreOffice.'}));
        info.add(new Adw.ActionRow({title: 'Droplets', subtitle: 'Die kleinen Werkzeuge sind vorerst entfernt und kehren später unter neuem Namen zurück.'}));
    }
}
