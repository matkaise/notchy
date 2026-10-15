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
gnome-extensions pack "$stage" --force --out-dir="$PWD/dist" --extra-source=src --extra-source=helper --extra-source=README.md --extra-source=docs --extra-source=scripts
printf 'Bundle: %s/dist/notchy@matthias.local.shell-extension.zip\n' "$PWD"
