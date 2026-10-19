import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Lifetime} from '../lifecycle.js';
import {_, fmt} from '../i18n/core.js';

const UI_SCREENSHOT = 0, UI_SCREENCAST = 1;

// Captures from the radial menu. Area, window and screen shots land in the
// Regal; text recognition copies the recognised text. GNOME's own screenshot
// UI handles interactive selection and screen recording.
export class Capture {
    constructor(extension) {
        this.extension = extension; this.life = new Lifetime(); this.pending = null; this.pendingTimeout = 0;
        // Only shots Notchy asked for go to the Regal; Print key shots stay GNOME's.
        this.life.connect(Main.screenshotUI, 'screenshot-taken', (_ui, file) => { if (this.pending) this.taken(file, this.pending); });
    }
    get ocrAvailable() { return Boolean(GLib.find_program_in_path('tesseract')); }
    run(kind) {
        if (kind === 'area') this.openUI(UI_SCREENSHOT, 'shelf');
        else if (kind === 'text') {
            if (this.ocrAvailable) this.openUI(UI_SCREENSHOT, 'ocr');
            else this.toast('dialog-warning-symbolic', _('Text recognition needs Tesseract'));
        } else if (kind === 'record') { this.pending = null; Main.screenshotUI.open(UI_SCREENCAST).catch(e => console.warn(`Notchy capture: ${e.message}`)); }
        else if (kind === 'window') {
            if (!global.display.focus_window) { this.toast('dialog-information-symbolic', _('No window has focus')); return; }
            this.save((shooter, stream) => shooter.screenshot_window(true, false, stream));
        } else if (kind === 'screen') this.save((shooter, stream) => shooter.screenshot(false, stream));
    }
    openUI(mode, pending) {
        this.pending = pending; this.life.cancel(this.pendingTimeout);
        this.pendingTimeout = this.life.later(120000, () => { this.pendingTimeout = 0; this.pending = null; });
        Main.screenshotUI.open(mode).then(() => {
            // GNOME restores the last mode; the radial entry means a selection.
            try { Main.screenshotUI._selectionButton.checked = true; } catch { /* Private API changed. */ }
        }).catch(e => console.warn(`Notchy capture: ${e.message}`));
    }
    newFile() {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(),
            Gettext.dgettext('gnome-shell', 'Screenshots')]));
        try { dir.make_directory_with_parents(null); } catch (e) { if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) throw e; }
        const name = Gettext.dgettext('gnome-shell', 'Screenshot From %s').replace('%s', GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S'));
        for (let i = 0; ; i++) {
            const file = dir.get_child(`${name}${i ? `-${i}` : ''}.png`);
            if (!file.query_exists(null)) return file;
        }
    }
    async save(capture) {
        try {
            const file = this.newFile(), stream = file.create(Gio.FileCreateFlags.NONE, null);
            try { await capture(new Shell.Screenshot(), stream); } finally { stream.close(null); }
            if (this.life.closed) return;
            global.display.get_sound_player().play_from_theme('screen-capture', _('Screenshot'), null);
            this.taken(file, 'shelf');
        } catch (e) { if (!this.life.closed) this.toast('dialog-warning-symbolic', fmt(_('Capture failed: %s'), e.message)); }
    }
    taken(file, kind) {
        this.pending = null; this.life.cancel(this.pendingTimeout); this.pendingTimeout = 0;
        if (kind === 'ocr') { this.extension.operations.run('ocr', file.get_uri()); return; }
        this.extension.shelf.add(file.get_uri());
        this.toast('screenshot-ui-area-symbolic', _('Screenshot added to the Shelf'));
    }
    toast(iconName, text) { this.extension.activeIsland()?.toast(iconName, text); }
    dispose() { this.life.dispose(); }
}
