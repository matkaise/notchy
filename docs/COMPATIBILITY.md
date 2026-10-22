# GNOME compatibility

Notchy is one code base and one package for every supported GNOME Shell
release. What differs between releases is handled in one place,
[`src/compat/`](../src/compat), mostly by asking what an API offers rather
than which version is running. GNOME 50 is the development baseline.

## Supported releases

| GNOME Shell | GJS | libadwaita / GTK | Status |
|---|---|---|---|
| 47 | 1.82 | 1.6 / 4.16 | prepared, not declared (see *Test results*) |
| 48 | 1.82 | 1.7 / 4.18 | declared; automated suite passed |
| 49 | 1.86 | 1.8 / 4.20 | declared; automated suite passed |
| 50 | 1.88 | 1.9 / 4.22 | declared; automated suite passed |
| 51 | 1.90 | 1.10 / 4.24 | declared; automated suite passed |

`metadata.json` declares exactly the releases whose complete test suite
passed (see *Test results*). GNOME refuses to load an extension on any other
release.

## API differences found

Every entry was checked against the GNOME Shell and Mutter sources at the
tags 47.10, 48.8, 49.10 (Mutter 49.8), 50.6 and 51.1, and then on the real
releases in the test matrix.

| Area | What changed | Releases | Where handled |
|---|---|---|---|
| Liquid/Dynamic Glass shader | `Shell.GLSLEffect` removed; GNOME 51 builds shader effects with `Clutter.ShaderEffect` from a `Cogl.Snippet` (`vfunc_get_static_snippet`) and sets uniforms by name (`set_uniform_float(name, n, values)`) instead of by location | 51 | `shaderEffect()` in `src/compat/clutter.js` |
| Liquid/Dynamic Glass shader | `Shell.GLSLEffect.add_glsl_snippet()` takes `Shell.SnippetHook` in 47 (Cogl did not export `CoglSnippetHook`), `Cogl.SnippetHook` from 48; the values are identical | 47 | `shaderEffect()` |
| Caps Lock activity | `Clutter.get_default_backend()` removed; the backend comes from the stage's `ClutterContext` (`global.stage.get_context().get_backend()`, available since 46) | 51 | `backend()`, `keymap()` in `src/compat/clutter.js` |
| Every vertical/horizontal box | `St.BoxLayout` gained `orientation` in 48 and dropped `vertical` in 51; 47 only knows `vertical` (an unknown property throws) | 47, 51 | `boxOrientation()` in `src/compat/clutter.js`, used by `box()` in `src/ui/widgets.js` |
| Thunderstorm and clipboard search fields (Enter, arrows, Ctrl+K …) | Mutter 51 gives every actor with key bindings a `Clutter.KeyController` action; in the event chain an actor's actions run before its own `key-press-event`, so `Clutter.Text` now acts on Return (activate), the arrows, Home/End, Delete and BackSpace before Notchy's handler saw them (Enter no longer copied a result). Up to 50 `Clutter.Text` handled keys in its class handler, after the signal | 51 | `connectKeyPress()` in `src/compat/clutter.js`: on an actor with such a controller the handler listens in the capture phase (`captured-event`), which precedes every controller; elsewhere `key-press-event` as before |
| Snap layouts, window commands, Korb | `Meta.Window.maximize()`/`unmaximize()` take `Meta.MaximizeFlags` in 47/48 (a call without throws) and no argument from 49; `get_maximized()` became `is_maximized()` | 47, 48 | `maximize()`, `unmaximize()`, `isMaximized()` in `src/compat/meta.js` |
| Spectrum helper (waveform) | `GLibUnix.signal_add` does not exist in GLib 2.82 (Ubuntu's GNOME 47); `GLib.unix_signal_add` is deprecated from 2.84 | 47 | `helper/spectrum.py` picks whichever exists |
| Focus handling (island, AirPods menu, activities list) | `Clutter.Stage.get_key_focus()` returns the stage itself when nothing has the focus in Mutter 47, `null` from 48 | 47 | Nothing to adapt: Notchy only asks whether its own actors `contains()` the focus, which the stage never is; the test normalises it (`keyFocus()` in `tests/shell.js`) |
| Notch position at login | While GNOME 48 lays out the bar for the first time, the clock button's transformed position is NaN when Notchy is enabled | 48 | `Island.centeredX()` keeps the monitor's centre until the allocation arrives |
| AirPods controls (conversation awareness, pause when taken out) | `PopupMenu.PopupSwitchMenuItem` emits `toggled` with `true` even when the switch was turned off on GNOME 47.0 (GJS 1.82.0); reproduced without Notchy. Notchy would have sent the opposite of what the user switched | 47 | `onSwitchToggled()` in `src/compat/shell.js` reads the item's own state, which is right on every release |
| Agent/AirPods indicators beside the notch | Panel's private `_leftBox`, `_centerBox`, `_rightBox` — unchanged 47–51 | – | `panelBoxes()` in `src/compat/shell.js` (falls back to the boxes' names) |
| Volume/brightness in the capsule | `OsdWindowManager._showOsdWindow(monitor, icon, label, level, maxLevel)` — unchanged 47–51, although the public `show()` was split into `showOne()`/`showAll()` in 49 | – | `overrideOsd()` in `src/compat/shell.js` (GNOME's OSD stays if it disappears) |
| Super+Space | `InputSourceManager._switchInputSource`, `_keybindingAction(Backward)` — unchanged 47–51 | – | `canBorrowInputSourceKeys()`, `restoreInputSourceKey()` in `src/compat/shell.js` |

Checked and unchanged from 47 to 51 for everything Notchy uses: `Main.panel`
(`addToStatusArea`, `statusArea.dateMenu`, `menuManager`), `Main.layoutManager`
(`addChrome`, `addTopChrome`, `panelBox`, `uiGroup`, `getWorkAreaForMonitor`,
`findMonitorForActor`, `startup-complete`), `Main.messageTray` and
`MessageTray` (`Source`, `Notification`, `Urgency`, `acknowledged`,
`forFeedback`, `policy.showBanners`, `source-added`, `notification-added`),
`TilePreview.open(window, rect, monitor)` with `Mtk.Rectangle`,
`Main.screenshotUI` (`open`, `stopScreencast`, `screenshot-taken`),
`Main.xdndHandler`, `Shell.BlurEffect` (`radius`), `Shell.Screenshot`,
`St.Clipboard`, `St.ScrollView` (`set_child`, `overlay_scrollbars`),
`St.DrawingArea`, `Clutter.Timeline`, Clutter events, `Meta.Selection`,
`Meta.SoundPlayer`, `Meta.Display` signals (`grab-op-begin` gained a third
argument in 51, which Notchy ignores), `Meta.Window.move_resize_frame`,
`move_frame`, `make_above`, `stick`, `getInputSourceManager`,
`getMixerControl`, `formatTimeSpan`, `getAppFavorites`, `Slider`,
`PanelMenu.Button`, `PopupMenu` items (GNOME 51 registers them with static
blocks, which changes nothing for users of the classes), the
`org.gnome.Shell.CalendarServer` interface and `InjectionManager`.
The preferences use only libadwaita 1.6 widgets (`Adw.ButtonRow` being the
newest), so they run unchanged on GNOME 47. JavaScript language features stay
within SpiderMonkey 128 (GJS 1.82).

Bluetooth/AirPods (BlueZ and the AAP socket), AirPlay (PipeWire/PulseAudio),
AirDrop (its backend daemon), MPRIS, LocalSearch and the GTK helpers talk to
system services, not to the Shell, and do not depend on its release.

## How the compatibility layer works

- `src/compat/detect.js` — the running version (`Config.PACKAGE_VERSION`,
  for diagnostics only) and the feature probes `hasProperty()` and
  `hasMethod()`.
- `src/compat/clutter.js` — Clutter backend and keymap, box orientation,
  `connectKeyPress()` for keys a text field would otherwise consume first, and
  `shaderEffect(name, declarations, code, uniforms)`, which returns an effect
  class with `setUniform(name, values)` on top of `Shell.GLSLEffect` or
  `Clutter.ShaderEffect`, whichever exists. Both paint the actor into an
  offscreen buffer (enlarged by the same 3 px) and run one and the same GLSL
  over it, so both draw the glass with the same shader and parameters (the
  suite checks its geometry and saves screenshots of both styles per release;
  a visual comparison on real hardware is still to do for 47–49 and 51).
- `src/compat/meta.js` — maximising with or without direction flags.
- `src/compat/shell.js` — the Shell internals Notchy touches: panel boxes, the
  OSD hook, the layout-switch keys, and `onSwitchToggled()` for popup switches. A missing internal costs that one
  feature and logs a warning; it never stops the extension or the Shell.
- `src/compat/index.js` — the one module components import; it also writes
  one line per Shell session to the journal, e.g.
  `Notchy 10: GNOME Shell 51.0, shaders through Clutter.ShaderEffect`.

Nothing is stored differently per release: settings, the shelf, the clipboard
history and all other saved data are shared unchanged.

## Test results

Run on 2026-10-20 with `bash scripts/test-matrix.sh` (Ubuntu containers,
headless GNOME Shell, software rendering) and with `bash scripts/test-shell.sh`
on the development machine (Ubuntu 26.04, GNOME Shell 50.1). Every run is the
complete suite: `check.sh` (99 Node tests, 53 Python tests, schema and
translation checks) and the Shell suite (517 assertions, the preferences
window, the GTK Regal, three disable/enable cycles), with the log free of
runtime errors.

| Release | Environment | check.sh | Shell suite | Notes |
|---|---|---|---|---|
| 47.0 | Ubuntu 24.10, GJS 1.82.0, GTK 4.16.3, libadwaita 1.6.2 | passed | three runs with the final code: one fully clean (517/517); one 517/517 but | the second run: a GTK 4.16 assertion in Notchy's GTK helper during the synthetic X11 drags (`gtk_drop_target_async_handle_event: self->drop == drop`, inside GTK); in the third, GNOME Shell 47.0 itself aborted (`malloc(): unsorted double linked list corrupted`) right after the snap layouts opened (assertion 132). 15 snap rounds in a row with and without Notchy did not reproduce it. Not declared until a real GNOME 47 session confirms it |
| 48.0 | Ubuntu 25.04, GJS 1.82.1, GTK 4.18.5, libadwaita 1.7.0 | passed | passed, 517/517 | GNOME logs 2 errors of its own (media list, MPRIS player quitting), reproduced without Notchy |
| 49.0 | Ubuntu 25.10, GJS 1.86.0, GTK 4.20.1, libadwaita 1.8.0 | passed | passed, 517/517 | same 2 GNOME errors as 48 |
| 50.1 | Ubuntu 26.04 container, GJS 1.88.0, GTK 4.22.4, libadwaita 1.9.1 | passed | passed, 517/517 | – |
| 50.1 | development machine (host) | passed | passed, 517/517 | final code, clean `tests/output` |
| 51.0 | Ubuntu 26.10, GJS 1.90.0, GTK 4.24.1, libadwaita 1.10.0 | passed | passed, 517/517 | shaders through `Clutter.ShaderEffect` |

Not tested: point releases other than these, other distributions, X11
sessions (GNOME 49 deprecated and 50 removed them; Notchy targets Wayland),
real hardware per release (see *Known limitations*).

What the matrix found and what was changed for it:

- In Notchy: the glass shader on 51, the keymap on 51, box orientation on 47,
  maximising on 47/48, search field keys on 51, popup switches on 47, the
  notch position at login on 48 (all in the table above), the spectrum
  helper's signal source on 47 (`helper/spectrum.py`) and an unreadable
  thumbnail ending the Regal's tile list on 48/49 (`helper/tray.py`: newer
  gdk-pixbuf returns NULL instead of raising).
- In the tests, never weakening an assertion: the virtual pointer's first
  motion can land on one axis (`pointTo()`), the hot corner is off in the
  test session, Ctrl+K comes from the same virtual keyboard as Return,
  a window just mapped is waited for before it is dragged, and a real drag
  sends several motion events. Assertions that failed now print the values
  they saw. GNOME 49's and older test tools cannot install an extension;
  `test-shell.sh` then installs it itself. The Thunderstorm fixtures are made
  before the first search (a clean checkout used to fail where an old
  `tests/output` hid it). A JS error whose stack lies entirely in GNOME
  Shell is listed in `tests/output/shell-internal-errors.log` instead of
  failing the run; any error with a frame from Notchy still fails it.

## Known limitations

- **GNOME 47 is prepared, not declared.** Every API difference is handled and
  the suite passes, but one of three runs ended in a crash of GNOME Shell 47.0
  itself (heap corruption, see *Test results*) that could not be reproduced or
  attributed. Ubuntu's 47.0 is the only GNOME 47 the matrix can run; check a
  current 47.x session (Fedora 41 shipped 47.10) by hand before adding "47" to
  `metadata.json`.
- **Tested headless, in containers.** Every release ran the complete automated
  suite (real input events through virtual devices, real Wayland and X11 client
  windows, software rendering at scale 1 on a 1280×720 virtual monitor). What
  only a real desktop shows was checked on GNOME 50 alone, the development
  machine: the look of Liquid/Dynamic Glass with GPU rendering and damage-clipped
  repaints, fractional scaling, several monitors, real Bluetooth/AirPods, AirPlay
  receivers, AirDrop hardware, real LocalSearch, notifications from real apps.
  See *Manual checks per release* below.
- **The releases tested are the ones Ubuntu ships**: 47.0, 48.0, 49.0, 50.1 and
  51.0. Point releases change no API Notchy uses (checked against the sources
  up to 47.10, 48.8, 49.10, 50.6, 51.1), but they were not run.
- **GNOME 51.0 dash.** With no favourite app installed, the dash starts empty;
  when a window without an installed `.desktop` file (Notchy's Regal is one)
  becomes its first entry while the overview is closed, GNOME's
  `Dash._adjustIconSize()` throws (`firstIcon.icon is null`) once. This is
  GNOME's code, harmless for Notchy, and does not happen with any favourite in
  the dash (every default installation has some). The test containers install
  one.
- **GNOME 48 at login.** The top bar's position is not known yet when Notchy is
  enabled during startup; the notch is centred on the monitor until the bar's
  allocation arrives a frame later (`Island.centeredX()`), instead of reading
  NaN.
- **Shell internals.** The OSD hook, the layout-switch keys and the panel boxes
  are private GNOME code. If a future release renames them, Notchy logs a
  warning and leaves that part to GNOME (the OSD stays GNOME's, Super+Space
  stays a layout switch, the side indicators use the boxes' names).
- **extensions.gnome.org.** The package follows the review rules that matter
  for one package on several releases: no compiled schemas, `shell-version`
  lists only tested releases, every signal, timer, injection and actor is
  released in `disable()` (three disable/enable cycles per run, and a run per
  release). Notchy's Python/GTK helpers, the D-Bus services it exports and its
  subprocesses (spectrum, cover art, file search, AirPlay, AirDrop) will need
  the usual explanation for reviewers; `version` is set by the site on upload.

### Manual checks per release

On a real session of each release (log out and back in after installing):
the notch's look in both styles over a busy wallpaper and a moving window,
125 %/150 % scaling, a second monitor, Super+Space with one and two keyboard
layouts, volume/brightness keys, dragging files from Files and windows to the
clock, AirPods connect/disconnect, an AirPlay receiver, notifications from a
real app with Do Not Disturb on and off, Settings → every page, and
`journalctl --user -b | grep -i notchy` free of errors after disabling and
enabling Notchy a few times. docs/TESTING.md lists the full desktop checklist.

## Supporting a new GNOME release

1. Add the release to `UBUNTU` in `scripts/test-matrix.sh` (the Ubuntu
   release that ships it) and to the matrix in `.github/workflows/tests.yml`.
2. Run `bash scripts/test-matrix.sh N`. The package built inside the container
   lists release N, so GNOME loads it before `metadata.json` does.
3. Read the Shell's and Mutter's changes since the last supported release for
   the APIs listed above (`git log`/`git diff` between the tags of
   `js/ui/{panel,layout,messageTray,osdWindow,windowManager,screenshot}.js`,
   `js/ui/status/keyboard.js`, `src/shell-*.h`, `src/st/*.h`,
   `clutter/clutter/*.h`, `src/meta/*.h`), and GNOME's porting guide for
   extensions (gjs.guide/extensions/upgrading).
4. Put every difference into `src/compat/` behind a feature probe, never into a
   component; add a line to the table above.
5. Only when the whole matrix passes, add N to `shell-version` in
   `metadata.json`.
