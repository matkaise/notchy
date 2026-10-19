#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
stage="$(mktemp -d /tmp/notchy-pack.XXXXXX)"
trap 'rm -rf "$stage"' EXIT
python3 - "$PWD" "$stage" <<'PY'
from pathlib import Path
import shutil
import sys
source, stage = map(Path, sys.argv[1:])
for name in ['metadata.json', 'extension.js', 'prefs.js', 'stylesheet.css', 'README.md']:
    shutil.copy2(source / name, stage / name)
for name in ['src', 'helper', 'schemas', 'docs']:
    shutil.copytree(source / name, stage / name, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'gschemas.compiled'))
(stage / 'scripts').mkdir()
shutil.copy2(source / 'scripts/notchyctl', stage / 'scripts/notchyctl')
PY
glib-compile-schemas --strict "$stage/schemas"
# Translations: po/LL.po compiled to locale/LL/LC_MESSAGES/notchy.mo, where
# the extension (gettext-domain in metadata.json) and the helpers find them.
python3 scripts/i18n.py check
python3 scripts/i18n.py compile "$stage/locale" >/dev/null
if command -v msgfmt >/dev/null; then for po in po/*.po; do msgfmt --check --output-file=/dev/null "$po"; done; fi
gnome-extensions pack "$stage" --force --out-dir="$PWD/dist" --extra-source=src --extra-source=helper --extra-source=README.md --extra-source=docs --extra-source=scripts --extra-source=locale
python3 - "$PWD/dist/notchy@matthias.local.shell-extension.zip" <<'PY'
import sys, zipfile
names = zipfile.ZipFile(sys.argv[1]).namelist()
assert 'locale/de/LC_MESSAGES/notchy.mo' in names, 'the package lacks the German catalog'
PY
printf 'Bundle: %s/dist/notchy@matthias.local.shell-extension.zip\n' "$PWD"
