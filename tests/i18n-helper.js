// The Node tests' translations: the German catalog compiled by
// `scripts/i18n.py compile locale` (scripts/check.sh does it first), loaded
// through the same backend the Shell uses for a language override.
import {readFileSync} from 'node:fs';
import {setBackend, catalogBackend, parseMo} from '../src/i18n/core.js';

const MO = new URL('../locale/de/LC_MESSAGES/notchy.mo', import.meta.url);
export function useLanguage(language, locale = language === 'de' ? 'de-DE' : 'en-US') {
    setBackend(catalogBackend(language === 'de' ? parseMo(readFileSync(MO)) : null, {language, locale}));
}
