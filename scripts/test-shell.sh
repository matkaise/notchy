#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/pack.sh
mkdir -p tests/output
# Every run starts from the same fixtures (tests/shell.js makes them anew).
rm -rf tests/output/thunderstorm
export NOTCHY_TEST_OUTPUT="$PWD/tests/output"
# Use a private session bus and temporary XDG directories; never restart the real desktop.
export LIBGL_ALWAYS_SOFTWARE=1
# GTK can choose Vulkan independently of LIBGL_ALWAYS_SOFTWARE. Use its
# software renderer too, so headless helper frames cannot depend on a real GPU.
export GSK_RENDERER="${NOTCHY_TEST_GSK_RENDERER:-cairo}"
export WAYLAND_DISPLAY=gnome-shell-test-display
# Ubuntu's wallpaper where the release has it, a small dark one elsewhere
# (the test tool's own default points at GNOME wallpapers a container lacks).
export SHELL_BACKGROUND_IMAGE=/usr/share/backgrounds/ubuntu-wallpaper-d.png
[[ -f "$SHELL_BACKGROUND_IMAGE" ]] || SHELL_BACKGROUND_IMAGE="$PWD/tests/fixtures/background.png"
export MUTTER_DEBUG_DUMMY_MODE_SPECS=1280x720
export MUTTER_DEBUG_DUMMY_MONITOR_SCALES=1
# D-Bus-activated services inherit their environment from the bus, not from
# the test runner's child Shell. Isolate those services before starting it.
notchy_test_services=$(mktemp -d /tmp/notchy-test-services.XXXXXX)
trap 'rm -rf "$notchy_test_services"' EXIT
export XDG_CONFIG_HOME="$notchy_test_services/config"
export XDG_DATA_HOME="$notchy_test_services/data"
export XDG_CACHE_HOME="$notchy_test_services/cache"
# The AirDrop test uses a stand-in backend; keep its state away from a real one.
export NOTCHY_AIRDROP_RUNDIR="$notchy_test_services/airdropd"
# Thunderstorm talks to a stand-in index and never crawls the real home folder.
export NOTCHY_LOCALSEARCH_NAME=org.notchy.LocalSearchTest
export NOTCHY_FALLBACK_ROOTS="$PWD/tests/output/thunderstorm"
# AirPods come from a stand-in airpods-helper daemon on the private bus, or
# from recorded AAP packets; the machine's real Bluetooth is never used.
export NOTCHY_AIRPODS_NAME=org.notchy.AirPodsTest
export NOTCHY_NO_SYSTEM_BLUETOOTH=1
export NOTCHY_AAP_REPLAY="$PWD/tests/fixtures/aap-airpods-pro2.hex"
export NOTCHY_AAP_LOG="$PWD/tests/output/aap-sent.log"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
filters=(--extra-filter org.notchy.FileTray --extra-filter org.notchy.DropTarget --extra-filter org.notchy.DropSource --extra-filter tray.py --extra-filter python3 --extra-filter gjs --extra-filter org.gnome.Shell.Extensions --extra-filter org.notchy.PreferencesTest --extra-filter org.notchy.LayerFixture)
bundle="$PWD/dist/notchy@matthias.local.shell-extension.zip"
if gnome-shell-test-tool --help | grep -- '--extension' >/dev/null; then
    dbus-run-session -- gnome-shell-test-tool --headless "${filters[@]}" --extension "$bundle" "$PWD/tests/shell.js" 2>&1 | tee tests/output/shell.log
else
    # GNOME 47–49's test tool cannot install an extension and keeps the
    # caller's settings backend. Do what GNOME 50's does: install into the
    # private data directory and enable it through a private keyfile.
    gnome-extensions install --force "$bundle"
    export GSETTINGS_BACKEND=keyfile
    mkdir -p "$XDG_CONFIG_HOME/glib-2.0/settings"
    printf '[org/gnome/shell]\nenabled-extensions=["notchy@matthias.local"]\n' > "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile"
    dbus-run-session -- gnome-shell-test-tool --headless "${filters[@]}" "$PWD/tests/shell.js" 2>&1 | tee tests/output/shell.log
fi
if [[ -n "${NOTCHY_TEST_CORNERS_ONLY:-}" ]]; then
    grep -q NOTCHY_CORNERS_TEST_OK tests/output/shell.log
    grep -q NOTCHY_TRAY_TEST_OK tests/output/shell.log
elif [[ -n "${NOTCHY_TEST_DROP_ONLY:-}" ]]; then
    grep -q NOTCHY_DROP_TEST_OK tests/output/shell.log
elif [[ -n "${NOTCHY_TEST_REGAL_ONLY:-}" ]]; then
    grep -q NOTCHY_REGAL_TEST_OK tests/output/shell.log
elif [[ -n "${NOTCHY_TEST_LAUNCHER_ONLY:-}" ]]; then
    grep -q NOTCHY_LAUNCHER_TEST_OK tests/output/shell.log
elif [[ -n "${NOTCHY_TEST_LAYOUT_ONLY:-}" ]]; then
    grep -q NOTCHY_LAYOUT_TEST_OK tests/output/shell.log
elif [[ -n "${NOTCHY_TEST_ACTIVITIES_ONLY:-}" ]]; then
    grep -q NOTCHY_ACTIVITIES_TEST_OK tests/output/shell.log
elif [[ -n "${NOTCHY_TEST_AIRPODS_ONLY:-}" ]]; then
    grep -q NOTCHY_AIRPODS_TEST_OK tests/output/shell.log
else
    grep -q NOTCHY_SHELL_TEST_OK tests/output/shell.log
    grep -q NOTCHY_PREFS_TEST_OK tests/output/shell.log
    grep -q NOTCHY_TRAY_TEST_OK tests/output/shell.log
fi

# Runtime errors fail the run. A JS error whose stack lies entirely in GNOME
# Shell's own code (no file:// frame from Notchy or the tests) is GNOME's,
# e.g. GNOME 48.0's media list throwing whenever an MPRIS player quits; those
# are listed in tests/output/shell-internal-errors.log and reported, not failed.
python3 - tests/output/shell.log tests/output/shell-internal-errors.log <<'PY'
import re, sys
log, internal_log = sys.argv[1:]
lines = open(log, errors='replace').read().split('\n')
pattern = re.compile(r'Gjs-CRITICAL|GLib-GObject-CRITICAL|Gtk-CRITICAL|St-CRITICAL|Clutter-CRITICAL|libmutter-CRITICAL|Script failed|Traceback')
ours, internal = [], []
for i, line in enumerate(lines):
    if not pattern.search(line):
        continue
    block = [line]
    for following in lines[i + 1:i + 40]:
        if not following.strip():
            break
        block.append(following)
    stack = block[1:]
    shell_only = ('JS ERROR' in line and stack and all('file://' not in frame for frame in stack)
                  and any('resource:///org/gnome/shell/' in frame for frame in stack))
    (internal if shell_only else ours).append('\n'.join(block))
with open(internal_log, 'w') as out:
    out.write('\n\n'.join(internal) + ('\n' if internal else ''))
if internal:
    print(f'GNOME Shell logged {len(internal)} error(s) of its own, not from Notchy: {internal_log}', file=sys.stderr)
if ours:
    print('Integration log contains runtime errors:\n\n' + '\n\n'.join(ours[:5]), file=sys.stderr)
    sys.exit(1)
PY
