#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(gnome-shell --version)"
# The releases Notchy supports are the ones metadata.json declares
# (docs/COMPATIBILITY.md); GNOME itself refuses any other.
major="$(sed -E 's/[^0-9]*([0-9]+).*/\1/' <<<"$version")"
supported="$(python3 -c 'import json; print(" ".join(json.load(open("metadata.json"))["shell-version"]))')"
if [[ " $supported " != *" $major "* ]]; then
    printf 'Notchy supports GNOME Shell %s. Found: %s\n' "$supported" "$version" >&2
    exit 1
fi
bash scripts/pack.sh
gnome-extensions install --force "$PWD/dist/notchy@matthias.local.shell-extension.zip"
if gnome-extensions info notchy@matthias.local >/dev/null 2>&1; then
    gnome-extensions enable notchy@matthias.local
else
    printf 'Installed. Log out and back in, then run: gnome-extensions enable notchy@matthias.local\n'
fi
