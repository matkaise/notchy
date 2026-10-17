import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {parseList, quicklinkTarget} from './src/launcher/logic.js';

const MINER = 'org.freedesktop.Tracker3.Miner.Files';
const LOCALSEARCH = GLib.getenv('NOTCHY_LOCALSEARCH_NAME') || 'org.freedesktop.LocalSearch3';
const AIRPODS = GLib.getenv('NOTCHY_AIRPODS_NAME') || 'org.costa.AirPods';
// A D-Bus call from the preferences window, as a promise.
const bus = (name, path, iface, method, params = null) => new Promise((resolve, reject) => Gio.DBus.session.call(name, path, iface, method, params, null,
    Gio.DBusCallFlags.NO_AUTO_START, 3000, null, (c, r) => { try { resolve(c.call_finish(r).deep_unpack()); } catch (e) { reject(e); } }));
const hasOwner = name => bus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', [name])).then(([owned]) => owned).catch(() => false);

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
        // AirDrop: Notchy is the front end of airdrop-mt7921, which the user installs.
        const airdrop = group(general, 'AirDrop (experimentell)', 'Senden an und Empfangen von iPhones über das Projekt airdrop-mt7921. Funktioniert mit MediaTek-WLAN (MT7921/MT7922). Während AirDrop aktiv ist, ist das WLAN pausiert; danach verbindet es sich selbst wieder. Nur „Für alle für 10 Minuten“ auf dem iPhone.');
        toggle(airdrop, 'airdrop-enabled', 'AirDrop in Notchy anbieten', 'Knopf im Kopf der Island, AirDrop-Fläche beim Ziehen, „Per AirDrop senden“ im Regal.');
        const home = GLib.get_home_dir();
        const found = () => {
            const configured = settings.get_string('airdrop-daemon');
            const candidates = configured ? [configured] : ['airdrop-mt7921', 'src/airdrop-mt7921', 'Projekte/airdrop-mt7921', 'Schreibtisch/airdrop-mt7921', 'Desktop/airdrop-mt7921', 'git/airdrop-mt7921'].map(dir => `${home}/${dir}/daemon/airdropd`);
            try { const target = GLib.file_read_link('/usr/local/bin/airdrop-send'); candidates.unshift(`${GLib.path_get_dirname(target)}/airdropd`); } catch { /* Not linked. */ }
            return candidates.find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ?? '';
        };
        const status = new Adw.ActionRow({title: 'Backend'});
        const sync = () => { const path = found(); status.subtitle = path ? `Gefunden: ${path}` : 'Nicht gefunden. airdrop-mt7921 installieren (Anleitung rechts) oder den Pfad unten angeben.'; };
        const guide = new Gtk.LinkButton({uri: 'https://github.com/jedbillyb/airdrop-mt7921#install', label: 'Anleitung', valign: Gtk.Align.CENTER});
        status.add_suffix(guide); airdrop.add(status);
        const daemon = new Adw.EntryRow({title: 'Pfad zu airdropd (leer = automatisch suchen)', text: settings.get_string('airdrop-daemon')});
        daemon.connect('changed', () => { settings.set_string('airdrop-daemon', daemon.text.trim()); sync(); }); airdrop.add(daemon);
        const folder = new Adw.EntryRow({title: 'Ordner für empfangene Dateien (leer = Downloads/AirDrop)', text: settings.get_string('airdrop-folder')});
        folder.connect('changed', () => settings.set_string('airdrop-folder', folder.text.trim())); airdrop.add(folder);
        sync();
        this.thunderstormPage(window, settings, page, group, toggle, number);
        this.airpodsPage(settings, page, group, toggle, number);
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

    // Thunderstorm: file search through GNOME LocalSearch, quicklinks, snippets.
    thunderstormPage(window, settings, page, group, toggle, number) {
        const storm = page('Thunderstorm', 'weather-storm-symbolic');
        const search = group(storm, 'Suche', 'Super + Leertaste öffnet Thunderstorm: Apps, Dateien, Befehle, Rechnen und Einheiten, Quicklinks, Ablage, Snippets und Emoji. Alles läuft lokal, ohne Konto und ohne Cloud.');
        toggle(search, 'launcher-file-search', 'Dateien und Ordner suchen', 'Über den Dateiindex von GNOME LocalSearch. Ohne ihn: eine begrenzte Suche in den persönlichen Ordnern.');
        number(search, 'launcher-max-results', 'Sichtbare Treffer', 5, 12);
        const web = new Adw.EntryRow({title: 'Websuche ({query} steht für den Suchbegriff)', text: settings.get_string('launcher-web-search')});
        web.connect('changed', () => {
            const valid = quicklinkTarget({url: web.text.trim()}, 'test')?.kind === 'url';
            valid ? web.remove_css_class('error') : web.add_css_class('error');
            if (valid) settings.set_string('launcher-web-search', web.text.trim());
        });
        search.add(web);

        // Which folders LocalSearch indexes; changes go to LocalSearch's own user settings.
        const index = group(storm, 'Dateiindex (GNOME LocalSearch)', 'Notchy durchsucht nur, was LocalSearch bereits indiziert. Ordner hier hinzuzufügen ändert die Einstellungen von LocalSearch für deinen Benutzer, nicht das System.');
        const status = new Adw.ActionRow({title: 'LocalSearch', subtitle: 'Wird geprüft …'}); index.add(status);
        Promise.all([hasOwner(LOCALSEARCH), hasOwner('org.freedesktop.Tracker3.Miner.Files')]).then(([a, b]) => {
            status.subtitle = a || b ? 'Läuft · Dateisuche über den Index' : 'Läuft nicht · Thunderstorm sucht einfach in den persönlichen Ordnern. Installiere bzw. aktiviere das Paket „localsearch“ für die volle Suche.';
        });
        const source = Gio.SettingsSchemaSource.get_default(), miner = source?.lookup(MINER, true) ? new Gio.Settings({schema_id: MINER}) : null;
        const home = GLib.get_home_dir(), folderRows = [];
        const name = path => path === '$HOME' || path === home ? 'Persönlicher Ordner' : path.startsWith('&') ? `${path.slice(1).charAt(0)}${path.slice(2).toLowerCase()} (XDG)` : path.replace(home, '~');
        const drawFolders = () => {
            for (const row of folderRows.splice(0)) index.remove(row);
            if (!miner) { const row = new Adw.ActionRow({title: 'Einstellungen von LocalSearch nicht gefunden', subtitle: 'Ohne LocalSearch gibt es keine indizierten Ordner.'}); index.add(row); folderRows.push(row); return; }
            for (const path of miner.get_strv('index-recursive-directories')) {
                const row = new Adw.ActionRow({title: name(path), subtitle: 'Mit Unterordnern indiziert'});
                const remove = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Nicht mehr indizieren', css_classes: ['flat']});
                remove.connect('clicked', () => { miner.set_strv('index-recursive-directories', miner.get_strv('index-recursive-directories').filter(p => p !== path)); drawFolders(); });
                row.add_suffix(remove); index.add(row); folderRows.push(row);
            }
            const add = new Adw.ButtonRow({title: 'Ordner zum Index hinzufügen …', start_icon_name: 'list-add-symbolic'});
            add.connect('activated', () => new Gtk.FileDialog({title: 'Ordner für die Dateisuche'}).select_folder(window, null, (dialog, result) => {
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
        const extra = new Adw.EntryRow({title: 'Weitere Ordner für die einfache Suche (ohne LocalSearch, mit Komma trennen)', text: settings.get_strv('launcher-extra-folders').join(', ')});
        extra.connect('changed', () => settings.set_strv('launcher-extra-folders', extra.text.split(',').map(x => x.trim()).filter(x => x.startsWith('/'))));
        index.add(extra);

        // Quicklinks: keyword, name, target.
        const links = group(storm, 'Quicklinks', 'Kürzel, Leerzeichen, Suchbegriff: „yt lofi“, „gh notchy“, „wiki Zürich“. Ziel: eine http(s)-Adresse mit {query} oder {path}, xdg:DOWNLOAD, ein Ordner (~/…) oder app:ID.desktop.');
        this.listEditor(links, settings, 'launcher-quicklinks', ['keyword', 'name', 'url'], [['name', 'Name'], ['keyword', 'Kürzel'], ['url', 'Ziel']],
            item => item.name || item.keyword || 'Neuer Quicklink', item => quicklinkTarget(item, 'test') !== null && /^\S+$/.test(item.keyword), {keyword: '', name: '', url: 'https://'});
        // Snippets: name, keyword, text.
        const snippets = group(storm, 'Snippets', 'Textbausteine: Name oder Kürzel eingeben, Enter kopiert. {date}, {time} und {datetime} werden ersetzt. Automatisches Einfügen in andere Apps ist unter Wayland nicht zuverlässig und sicher möglich und wird daher nicht angeboten.');
        this.listEditor(snippets, settings, 'launcher-snippets', ['name', 'text'], [['name', 'Name'], ['keyword', 'Kürzel (optional)'], ['text', 'Text']],
            item => item.name || 'Neues Snippet', item => Boolean(item.name && item.text), {name: '', keyword: '', text: ''});
    }
    // An editable list stored as JSON in one setting: one expander per entry.
    listEditor(group, settings, key, required, fields, title, valid, blank) {
        const rows = [];
        const read = () => parseList(settings.get_string(key), required);
        const save = items => settings.set_string(key, JSON.stringify(items));
        const draw = () => {
            for (const row of rows.splice(0)) group.remove(row);
            const items = read();
            items.forEach((item, i) => {
                const expander = new Adw.ExpanderRow({title: title(item), subtitle: item.keyword ?? ''});
                for (const [field, label] of fields) {
                    const entry = new Adw.EntryRow({title: label, text: String(item[field] ?? '').replace(/\n/g, '\\n')});
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
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Entfernen', css_classes: ['flat']});
                remove.connect('clicked', () => { save(read().filter((_x, j) => j !== i)); draw(); });
                expander.add_suffix(remove);
                if (!valid(item)) expander.add_css_class('error');
                group.add(expander); rows.push(expander);
            });
            const add = new Adw.ButtonRow({title: 'Hinzufügen', start_icon_name: 'list-add-symbolic'});
            // A new entry is stored only once it has its required fields.
            add.connect('activated', () => { const items = read(); items.push({...blank, name: blank.name || 'Neu', ...(required.includes('text') ? {text: ' '} : {})}); save(items); draw(); });
            group.add(add); rows.push(add);
        };
        draw();
    }

    // AirPods: through the optional airpods-helper daemon (or BlueZ for basics).
    airpodsPage(settings, page, group, toggle, number) {
        const pods = page('AirPods', 'audio-headphones-symbolic');
        const main = group(pods, 'AirPods', 'Akkustände, Geräuschkontrolle und eine Verbindungsanimation in der Island. Notchy nutzt dafür den optionalen Dienst airpods-helper und installiert oder ändert selbst nichts am System.');
        toggle(main, 'airpods-enabled', 'AirPods-Integration');
        toggle(main, 'airpods-animation', 'Verbindungsanimation', 'Beim Verbinden wächst die Island kurz und zeigt die Akkustände.');
        toggle(main, 'airpods-battery-warning', 'Warnung bei niedrigem Akkustand');
        number(main, 'airpods-battery-threshold', 'Warnen unter (Prozent)', 5, 50, 5);
        toggle(main, 'airpods-bluez-fallback', 'Ohne airpods-helper: Grunddaten von BlueZ', 'Verbindung und ein Akkustand für Apple-Kopfhörer, sofern das System sie meldet. Keine Geräuschkontrolle.');
        const backend = group(pods, 'Dienst', '');
        const status = new Adw.ActionRow({title: 'airpods-helper', subtitle: 'Wird geprüft …'}); backend.add(status);
        const guide = new Gtk.LinkButton({uri: 'https://github.com/superninjv/airpods-helper#readme', label: 'Anleitung', valign: Gtk.Align.CENTER}); status.add_suffix(guide);
        const start = new Gtk.Button({label: 'Starten', valign: Gtk.Align.CENTER, visible: false}); status.add_suffix(start);
        const pause = new Adw.SwitchRow({title: 'Medien pausieren, wenn ein AirPod herausgenommen wird', subtitle: 'Einstellung des Dienstes (PauseOnRemoval); er steuert die Wiedergabe selbst.', sensitive: false});
        backend.add(pause);
        let syncing = false;
        const refresh = async () => {
            const running = await hasOwner(AIRPODS);
            const installed = running || await bus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListActivatableNames').then(([names]) => names.includes(AIRPODS)).catch(() => false);
            start.visible = installed && !running; pause.sensitive = running;
            if (!running) { status.subtitle = installed ? 'Installiert, läuft aber nicht.' : 'Nicht gefunden. Für Geräuschkontrolle und Akkustände von Buds und Case airpods-helper installieren (Anleitung).'; return; }
            try {
                const [props] = await bus(AIRPODS, '/org/costa/AirPods', 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', ['org.costa.AirPods']));
                const value = name => props[name]?.deep_unpack?.() ?? props[name];
                status.subtitle = `Läuft${value('Version') ? ` (Version ${value('Version')})` : ''} · ${value('Connected') ? `${value('ModelName') || 'AirPods'} verbunden` : 'keine AirPods verbunden'}`;
                syncing = true; pause.active = Boolean(value('PauseOnRemoval')); syncing = false;
            } catch (e) { status.subtitle = `Läuft, antwortet aber nicht: ${e.message}`; }
        };
        pause.connect('notify::active', () => {
            if (syncing) return;
            Gio.DBus.session.call(AIRPODS, '/org/costa/AirPods', 'org.freedesktop.DBus.Properties', 'Set', new GLib.Variant('(ssv)', ['org.costa.AirPods', 'PauseOnRemoval', new GLib.Variant('b', pause.active)]),
                null, Gio.DBusCallFlags.NONE, 3000, null, (c, r) => { try { c.call_finish(r); } catch { refresh(); } });
        });
        // Only on request: D-Bus starts the user's installed service.
        start.connect('clicked', () => Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'StartServiceByName', new GLib.Variant('(su)', [AIRPODS, 0]),
            null, Gio.DBusCallFlags.NONE, 10000, null, (c, r) => { try { c.call_finish(r); } catch (e) { status.subtitle = `Start fehlgeschlagen: ${e.message}`; } refresh(); }));
        refresh();
    }
}
