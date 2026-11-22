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
uuid=notchy@matkaise.github.io
bash scripts/pack.sh
# Up to version 10 Notchy was notchy@matthias.local. That copy goes; its
# settings stay (they live under Notchy's schema path, not under the id).
old=notchy@matthias.local
if [[ -d "$HOME/.local/share/gnome-shell/extensions/$old" ]]; then
    gnome-extensions disable "$old" 2>/dev/null || true
    gnome-extensions uninstall "$old" 2>/dev/null || rm -rf "$HOME/.local/share/gnome-shell/extensions/$old"
    enabled="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$enabled" != *"'$uuid'"* ]]; then
        gsettings set org.gnome.shell enabled-extensions "$(python3 -c 'import ast, sys; print(ast.literal_eval(sys.argv[1].removeprefix("@as ")) + [sys.argv[2]])' "$enabled" "$uuid")"
    fi
fi
gnome-extensions install --force "$PWD/dist/$uuid.shell-extension.zip"
# Agent hooks set up before point at the installed helpers; point them at this copy.
helpers="$HOME/.local/share/gnome-shell/extensions/$uuid/helper"
python3 - "$helpers" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import agent_setup
for provider in agent_setup.EVENTS:
    if agent_setup.status(provider)['state'] in ('installed', 'partial'):
        path = str(agent_setup.config_path(provider))
        if sys.argv[1] not in open(path, encoding='utf-8').read():
            result = agent_setup.install(provider)
            print(f"{agent_setup.LABELS[provider]}: hooks now use {sys.argv[1]}" if result['ok'] else f"{agent_setup.LABELS[provider]}: {result['error']}")
PY
if gnome-extensions info "$uuid" >/dev/null 2>&1; then
    gnome-extensions enable "$uuid"
else
    printf 'Installed. Log out and back in; Notchy is enabled then (or run: gnome-extensions enable %s)\n' "$uuid"
fi
