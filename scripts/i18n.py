#!/usr/bin/env python3
"""Notchy's gettext toolchain, self-contained (no xgettext/msgfmt needed).

  i18n.py extract            write po/notchy.pot from the sources in po/POTFILES
  i18n.py update             extract, then merge the template into every po/LL.po
  i18n.py compile OUTDIR     compile po/LL.po into OUTDIR/LL/LC_MESSAGES/notchy.mo
  i18n.py check              the template matches the sources; every catalog is
                             complete, without fuzzy or obsolete entries, and keeps
                             each message's placeholders

Messages are found in calls of _(), N_(), ngettext() and pgettext() (JavaScript
and Python) whose arguments are plain string literals. A comment starting with
"Translators:" right above such a call reaches the translator. The files are
standard gettext PO/MO; GNU gettext tools work on them as well.
"""
import ast
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PO = ROOT / 'po'
DOMAIN = 'notchy'
HEADER = {
    'Project-Id-Version': 'notchy',
    'Report-Msgid-Bugs-To': 'https://github.com/matkaise/notchy/issues',
    'MIME-Version': '1.0',
    'Content-Type': 'text/plain; charset=UTF-8',
    'Content-Transfer-Encoding': '8bit',
}
PLACEHOLDER = re.compile(r'%(?:\(\w+\)|\d+\$)?[sd]')

# --- Extraction -------------------------------------------------------------

CALL = re.compile(r'(?<![\w.$])(_|N_|ngettext|pgettext)\s*\(')
# Arguments per function: which of them are (context, msgid, plural).
SHAPE = {'_': ('msgid',), 'N_': ('msgid',), 'ngettext': ('msgid', 'plural'), 'pgettext': ('context', 'msgid')}


def _string(text, at):
    """A JS/Python string literal at `at` → (value, end) or None."""
    quote = text[at] if at < len(text) else ''
    if quote not in '\'"':
        return None
    end = at + 1
    while end < len(text) and text[end] != quote:
        if text[end] == '\n':
            return None
        end += 2 if text[end] == '\\' else 1
    if end >= len(text):
        return None
    raw = text[at:end + 1]
    # JS and Python escapes agree for what Notchy uses (\\n, \\', \\uXXXX).
    return ast.literal_eval(raw), end + 1


def _arguments(text, at, count):
    values = []
    for index in range(count):
        while at < len(text) and text[at] in ' \t\r\n':
            at += 1
        literal = _string(text, at)
        if not literal:
            return None
        value, at = literal
        values.append(value)
        while at < len(text) and text[at] in ' \t\r\n':
            at += 1
        if index < count - 1:
            if at >= len(text) or text[at] != ',':
                return None
            at += 1
    return values


def extract_file(path):
    text = path.read_text(encoding='utf-8')
    rel = path.relative_to(ROOT).as_posix()
    python = path.suffix == '.py' or text.startswith('#!/usr/bin/env python3') or text.startswith('#!/usr/bin/python3')
    found = []
    for match in CALL.finditer(text):
        name = match.group(1)
        shape = SHAPE[name]
        values = _arguments(text, match.end(), len(shape))
        if values is None:
            continue
        entry = dict(zip(shape, values))
        line = text.count('\n', 0, match.start()) + 1
        # A "Translators:" comment directly above.
        lines = text.split('\n')
        comment = []
        for previous in reversed(lines[:line - 1]):
            stripped = previous.strip()
            marker = '#' if python else '//'
            if not stripped.startswith(marker):
                break
            comment.insert(0, stripped[len(marker):].strip())
        joined = ' '.join(comment)
        note = joined[joined.find('Translators:'):] if 'Translators:' in joined else ''
        entry.update(ref=f'{rel}:{line}', note=note, python=python)
        found.append(entry)
    return found


def sources():
    files = []
    for line in (PO / 'POTFILES').read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        matches = sorted(ROOT.glob(line))
        if not matches:
            raise SystemExit(f'po/POTFILES: nothing matches {line}')
        files.extend(match for match in matches if match.is_file())
    return files


def extract():
    entries = {}
    for path in sources():
        for found in extract_file(path):
            key = (found.get('context'), found['msgid'])
            entry = entries.setdefault(key, {'context': found.get('context'), 'msgid': found['msgid'], 'plural': None, 'refs': [], 'notes': [], 'flags': set()})
            if found.get('plural'):
                if entry['plural'] not in (None, found['plural']):
                    raise SystemExit(f"{found['ref']}: {found['msgid']!r} has two plural forms")
                entry['plural'] = found['plural']
            entry['refs'].append(found['ref'])
            if found['note'] and found['note'] not in entry['notes']:
                entry['notes'].append(found['note'])
            if PLACEHOLDER.search(found['msgid'] + (found.get('plural') or '')):
                entry['flags'].add('python-format' if found['python'] else 'javascript-format')
    return entries

# --- PO reading and writing --------------------------------------------------


def _escape(text):
    return text.replace('\\', '\\\\').replace('"', '\\"').replace('\t', '\\t').replace('\n', '\\n')


def _po_string(keyword, text):
    if '\n' in text[:-1]:
        parts = text.split('\n')
        chunks = [part + '\n' for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])
        return f'{keyword} ""\n' + '\n'.join(f'"{_escape(chunk)}"' for chunk in chunks)
    return f'{keyword} "{_escape(text)}"'


def read_po(path):
    entries, header, current, last = {}, {}, None, None

    def finish():
        nonlocal current
        if current and 'msgid' in current:
            if current['msgid'] == '' and current.get('context') is None:
                for line in current.get('msgstr', '').split('\n'):
                    if ':' in line:
                        name, value = line.split(':', 1)
                        header[name.strip()] = value.strip()
            else:
                entries[(current.get('context'), current['msgid'])] = current
        current = None

    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line:
            finish()
            continue
        if line.startswith('#~'):
            continue
        if current is None:
            current = {'flags': set(), 'refs': [], 'notes': []}
        if line.startswith('#,'):
            current['flags'].update(flag.strip() for flag in line[2:].split(',') if flag.strip())
        elif line.startswith('#:'):
            current['refs'].extend(line[2:].split())
        elif line.startswith('#.'):
            current['notes'].append(line[2:].strip())
        elif line.startswith('#'):
            continue
        elif line.startswith('"'):
            current[last] = current.get(last, '') + ast.literal_eval(line)
        else:
            keyword, _, value = line.partition(' ')
            if keyword in ('msgctxt', 'msgid') and 'msgstr' in current or keyword == 'msgctxt' and 'msgid' in current:
                finish()
                current = {'flags': set(), 'refs': [], 'notes': []}
            name = {'msgctxt': 'context', 'msgid': 'msgid', 'msgid_plural': 'plural', 'msgstr': 'msgstr'}.get(keyword)
            if name is None:
                match = re.fullmatch(r'msgstr\[(\d+)\]', keyword)
                if not match:
                    raise SystemExit(f'{path}: cannot read {raw!r}')
                name = f'msgstr[{match.group(1)}]'
            current[name] = ast.literal_eval(value)
            last = name
    finish()
    return header, entries


def write_po(path, header, entries, language=None):
    lines = []
    if language:
        lines += [f'# German translation of Notchy.', '#', 'msgid ""', 'msgstr ""']
    else:
        lines += ['# Notchy message template.', '#', '#, fuzzy', 'msgid ""', 'msgstr ""']
    for name, value in header.items():
        lines.append(f'"{_escape(f"{name}: {value}")}\\n"')
    lines.append('')
    for entry in sorted(entries.values(), key=lambda e: (min(e['refs']) if e['refs'] else '~', e.get('context') or '', e['msgid'])):
        for note in entry.get('notes', []):
            lines.append(f'#. {note}')
        refs = entry.get('refs', [])
        for start in range(0, len(refs), 4):
            lines.append('#: ' + ' '.join(refs[start:start + 4]))
        if entry.get('flags'):
            lines.append('#, ' + ', '.join(sorted(entry['flags'])))
        if entry.get('context') is not None:
            lines.append(_po_string('msgctxt', entry['context']))
        lines.append(_po_string('msgid', entry['msgid']))
        if entry.get('plural'):
            lines.append(_po_string('msgid_plural', entry['plural']))
            lines.append(_po_string('msgstr[0]', entry.get('msgstr[0]', '')))
            lines.append(_po_string('msgstr[1]', entry.get('msgstr[1]', '')))
        else:
            lines.append(_po_string('msgstr', entry.get('msgstr', '')))
        lines.append('')
    path.write_text('\n'.join(lines), encoding='utf-8')


def template(entries):
    header = {**HEADER, 'Language': '', 'Plural-Forms': 'nplurals=INTEGER; plural=EXPRESSION;'}
    return header, entries


def cmd_extract():
    header, entries = template(extract())
    write_po(PO / f'{DOMAIN}.pot', header, entries)
    return entries


def cmd_update():
    entries = cmd_extract()
    for path in sorted(PO.glob('*.po')):
        header, old = read_po(path)
        merged = {}
        for key, entry in entries.items():
            previous = old.get(key, {})
            fresh = {**entry, 'flags': set(entry['flags'])}
            for field in ('msgstr', 'msgstr[0]', 'msgstr[1]'):
                if field in previous:
                    fresh[field] = previous[field]
            if 'fuzzy' in previous.get('flags', set()):
                fresh['flags'].add('fuzzy')
            merged[key] = fresh
        write_po(path, {**HEADER, **{k: v for k, v in header.items() if k not in HEADER}}, merged, language=path.stem)
        dropped = sorted(set(old) - set(entries), key=lambda k: k[1])
        missing = [key for key, entry in merged.items() if not translated(entry)]
        print(f'{path.name}: {len(merged)} messages, {len(missing)} untranslated, {len(dropped)} dropped')
        for key in missing:
            print(f'  untranslated: {key[1]!r}')

# --- Compilation ---------------------------------------------------------------


def translated(entry):
    if 'fuzzy' in entry.get('flags', set()):
        return False
    if entry.get('plural'):
        return bool(entry.get('msgstr[0]')) and bool(entry.get('msgstr[1]'))
    return bool(entry.get('msgstr'))


def compile_po(path, out):
    header, entries = read_po(path)
    pairs = [(''.encode(), '\n'.join(f'{k}: {v}' for k, v in header.items()).encode() + b'\n')]
    for (context, msgid), entry in entries.items():
        if not translated(entry):
            continue
        key = (f'{context}\x04' if context is not None else '') + msgid
        if entry.get('plural'):
            key += '\0' + entry['plural']
            value = entry['msgstr[0]'] + '\0' + entry['msgstr[1]']
        else:
            value = entry['msgstr']
        pairs.append((key.encode(), value.encode()))
    pairs.sort(key=lambda pair: pair[0])
    count = len(pairs)
    originals_at = 28
    translations_at = originals_at + count * 8
    data_at = translations_at + count * 8
    originals, translations, blob = [], [], b''
    for key, _value in pairs:
        originals.append((len(key), data_at + len(blob)))
        blob += key + b'\0'
    for _key, value in pairs:
        translations.append((len(value), data_at + len(blob)))
        blob += value + b'\0'
    data = struct.pack('<7I', 0x950412de, 0, count, originals_at, translations_at, 0, data_at)
    data += b''.join(struct.pack('<2I', *pair) for pair in originals)
    data += b''.join(struct.pack('<2I', *pair) for pair in translations)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data + blob)


def cmd_compile(target):
    for path in sorted(PO.glob('*.po')):
        out = Path(target) / path.stem / 'LC_MESSAGES' / f'{DOMAIN}.mo'
        compile_po(path, out)
        print(f'{path.name} → {out}')

# --- Check -----------------------------------------------------------------------


def cmd_check():
    problems = []
    entries = extract()
    _header, template_entries = read_po(PO / f'{DOMAIN}.pot')
    if set(entries) != set(template_entries):
        new = sorted(k[1] for k in set(entries) - set(template_entries))
        gone = sorted(k[1] for k in set(template_entries) - set(entries))
        problems.append(f'po/{DOMAIN}.pot is out of date (run scripts/i18n.py update): new {new[:8]}, gone {gone[:8]}')
    linguas = [line.strip() for line in (PO / 'LINGUAS').read_text().splitlines() if line.strip() and not line.startswith('#')]
    for language in linguas:
        path = PO / f'{language}.po'
        if not path.exists():
            problems.append(f'{path.name} is missing')
            continue
        header, catalog = read_po(path)
        if header.get('Language') != language:
            problems.append(f'{path.name}: header Language is {header.get("Language")!r}')
        for key in sorted(set(entries) - set(catalog), key=lambda k: k[1]):
            problems.append(f'{path.name}: missing {key[1]!r}')
        for key in sorted(set(catalog) - set(entries), key=lambda k: k[1]):
            problems.append(f'{path.name}: obsolete {key[1]!r}')
        for key, entry in catalog.items():
            if key not in entries:
                continue
            if not translated(entry):
                problems.append(f'{path.name}: untranslated or fuzzy {key[1]!r}')
                continue
            if entry.get('plural'):
                singular, plural = _placeholders(entry['msgid']), _placeholders(entry['plural'])
                if sorted(_placeholders(entry['msgstr[1]'])) != sorted(plural):
                    problems.append(f'{path.name}: placeholders differ in the plural of {key[1]!r}')
                # A singular may leave its number out ("one file").
                if not set(_placeholders(entry['msgstr[0]'])) <= set(singular) | set(plural):
                    problems.append(f'{path.name}: placeholders differ in the singular of {key[1]!r}')
            elif sorted(_placeholders(entry['msgstr'])) != sorted(_placeholders(entry['msgid'])):
                problems.append(f'{path.name}: placeholders differ in {key[1]!r} → {entry["msgstr"]!r}')
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        raise SystemExit(1)
    print(f'translations complete: {len(entries)} messages, languages: en (source), {", ".join(linguas)}')


def _placeholders(text):
    # %1$s and %s both mean "an argument"; positions only reorder.
    return [re.sub(r'\d+\$', '', p) for p in PLACEHOLDER.findall(text)]


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'extract':
        cmd_extract()
    elif command == 'update':
        cmd_update()
    elif command == 'compile' and len(sys.argv) == 3:
        cmd_compile(sys.argv[2])
    elif command == 'check':
        cmd_check()
    else:
        raise SystemExit(__doc__)
