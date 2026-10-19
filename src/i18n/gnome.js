import Gettext from 'gettext';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {DOMAIN, LANGUAGES, catalogBackend, parseMo, resolveLanguage, setBackend} from './core.js';

// Installs Notchy's translation backend in the Shell or the preferences.
//
// 'auto' (the default) uses GNOME's gettext through the extension object,
// whose constructor bound the domain to the extension's locale/ folder — the
// system language decides, exactly as for GNOME itself. A language chosen in
// the preferences ('de', 'en') is read from Notchy's own compiled catalog
// instead: only Notchy's strings change; the Shell's locale, the process
// environment and other extensions stay as they are. Helper processes get the
// choice through NOTCHY_LANGUAGE (see helperEnv).
export function startTranslations(extension, settings) {
    const localeDir = GLib.build_filenamev([extension.path, 'locale']);
    const names = GLib.get_language_names();
    const apply = () => {
        const override = settings?.get_string('language') ?? 'auto';
        if (LANGUAGES.includes(override)) {
            const {language, locale} = resolveLanguage({override, names});
            setBackend(catalogBackend(language === 'en' ? null : readCatalog(localeDir, language), {language, locale}));
            return;
        }
        // The catalog gettext actually picked names its language in its header.
        const header = Gettext.dgettext(DOMAIN, '');
        const detected = /^Language:\s*([a-z]{2})/m.exec(header)?.[1] ?? null;
        const {language, locale} = resolveLanguage({names, detected: detected ?? (header ? null : 'en')});
        setBackend({language, locale, gettext: s => extension.gettext(s), ngettext: (s, p, n) => extension.ngettext(s, p, n), pgettext: (c, s) => extension.pgettext(c, s)});
    };
    apply();
    const id = settings?.connect('changed::language', apply) ?? 0;
    return () => { if (id) settings.disconnect(id); };
}

function readCatalog(localeDir, language) {
    try {
        const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([localeDir, language, 'LC_MESSAGES', `${DOMAIN}.mo`]));
        return ok ? parseMo(bytes) : null;
    } catch (e) {
        console.warn(`Notchy translations (${language}): ${e.message}`);
        return null;
    }
}

// A launcher for Notchy's Python helpers: they translate with the same domain
// (helper/i18n.py) and follow a language chosen in the preferences.
export function helperLauncher(settings, flags = Gio.SubprocessFlags.NONE) {
    const launcher = new Gio.SubprocessLauncher({flags});
    const override = settings?.get_string('language') ?? 'auto';
    if (LANGUAGES.includes(override)) launcher.setenv('NOTCHY_LANGUAGE', override, true);
    else launcher.unsetenv('NOTCHY_LANGUAGE');
    return launcher;
}
