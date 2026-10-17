#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/pack.sh
mkdir -p tests/output
export NOTCHY_TEST_OUTPUT="$PWD/tests/output"
# Use a private session bus and temporary XDG directories; never restart the real desktop.
export LIBGL_ALWAYS_SOFTWARE=1
# GTK can choose Vulkan independently of LIBGL_ALWAYS_SOFTWARE. Use its
# software renderer too, so headless helper frames cannot depend on a real GPU.
export GSK_RENDERER="${NOTCHY_TEST_GSK_RENDERER:-cairo}"
export WAYLAND_DISPLAY=gnome-shell-test-display
export SHELL_BACKGROUND_IMAGE=/usr/share/backgrounds/ubuntu-wallpaper-d.png
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
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
dbus-run-session -- gnome-shell-test-tool --headless --extra-filter org.notchy.FileTray --extra-filter org.notchy.DropTarget --extra-filter org.notchy.DropSource --extra-filter tray.py --extra-filter python3 --extra-filter gjs --extra-filter org.gnome.Shell.Extensions --extra-filter org.notchy.PreferencesTest --extra-filter org.notchy.LayerFixture --extension "$PWD/dist/notchy@matthias.local.shell-extension.zip" "$PWD/tests/shell.js" 2>&1 | tee tests/output/shell.log
if [[ -n "${NOTCHY_TEST_CORNERS_ONLY:-}" ]]; then
    grep -q NOTCHY_CORNERS_TEST_OK tests/output/shell.log
    grep -q NOTCHY_TRAY_TEST_OK tests/output/shell.log
elif [[ -n "${NOTCHY_TEST_DROP_ONLY:-}" ]]; then
    grep -q NOTCHY_DROP_TEST_OK tests/output/shell.log
else
    grep -q NOTCHY_SHELL_TEST_OK tests/output/shell.log
    grep -q NOTCHY_PREFS_TEST_OK tests/output/shell.log
    grep -q NOTCHY_TRAY_TEST_OK tests/output/shell.log
fi

if grep -Eq 'Gjs-CRITICAL|GLib-GObject-CRITICAL|Gtk-CRITICAL|libmutter-CRITICAL|Script failed|Traceback' tests/output/shell.log; then
    printf 'Integration log contains runtime errors.
' >&2
    exit 1
fi
