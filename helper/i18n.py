"""Notchy's translations for the Python helpers and notchyctl.

Same gettext domain and catalogs as the extension (locale/LL/LC_MESSAGES/
notchy.mo next to helper/). The system language decides, as for GNOME; a
language chosen in Notchy's preferences arrives as NOTCHY_LANGUAGE ('de',
'en') from the Shell and applies to this process only. Without a catalog the
English source strings are used.
"""
import gettext
import os
from pathlib import Path

DOMAIN = 'notchy'
LANGUAGES = ('de', 'en')
LOCALEDIR = Path(__file__).resolve().parent.parent / 'locale'


def translation(language=None):
    override = language if language is not None else os.environ.get('NOTCHY_LANGUAGE', '')
    languages = [override] if override in LANGUAGES else None
    return gettext.translation(DOMAIN, localedir=str(LOCALEDIR), languages=languages, fallback=True)


_translation = translation()


def set_language(language):
    """Switch this process to 'de', 'en' or (None) the environment's choice."""
    global _translation
    _translation = translation(language)


def language():
    """'de' or 'en': the language this process speaks."""
    return 'de' if (_translation.info().get('language') or '').startswith('de') else 'en'


def _(message):
    return _translation.gettext(message)


def N_(message):
    return message


def ngettext(singular, plural, n):
    return _translation.ngettext(singular, plural, n)


def pgettext(context, message):
    return _translation.pgettext(context, message)


def number(value, digits=1):
    """A decimal number in the process language: 1,5 (German) or 1.5."""
    text = f'{value:.{digits}f}'
    return text.replace('.', ',') if language() == 'de' else text
