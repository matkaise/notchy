#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(gnome-shell --version)"
if [[ "$version" != 'GNOME Shell 50.'* && "$version" != 'GNOME Shell 50' ]]; then
    printf 'Notchy currently targets GNOME Shell 50. Found: %s\n' "$version" >&2
    exit 1
fi
bash scripts/pack.sh
gnome-extensions install --force "$PWD/dist/notchy@matthias.local.shell-extension.zip"
if gnome-extensions info notchy@matthias.local >/dev/null 2>&1; then
    gnome-extensions enable notchy@matthias.local
else
    printf 'Installed. Log out and back in, then run: gnome-extensions enable notchy@matthias.local\n'
fi
