# Testing

## Automated

`bash scripts/check.sh` checks:

- JavaScript syntax of every module; the GSettings schema (strict) and Python syntax.
- URI parsing, history deduplication/favourites/retention, tags and native batch-copy formats, calendar day boundaries, ISO calendar weeks and week strips across month and year ends, notification grouping, snap layouts covering the work area without gaps, the safe calculator grammar, relative times and tolerant MPRIS metadata.
- ZIP with spaces, Unicode and shell metacharacters; one shared archive for a shelf selection; originals preserved; symlinks and remote files rejected.
- MCP lifecycle, tool schemas, JSON-RPC framing and rejection of unknown methods/arguments.
- Real GStreamer spectrum analysis of a synthetic tone and rejection of microphone sources.
- The cover helper against a local HTTP server: PNG normalisation, size limits, cache and rejection of invalid data.

`bash scripts/test-shell.sh` builds the package and starts **GNOME Shell 50** with a virtual monitor, a separate session bus and temporary XDG directories. The log must contain `NOTCHY_SHELL_TEST_OK`, `NOTCHY_PREFS_TEST_OK` and `NOTCHY_TRAY_TEST_OK`; `Gjs-CRITICAL`, `Script failed` or Python tracebacks fail the run. Every `PASS:` line is one concrete assertion. Among other things it checks:

- Top-bar integration: GNOME's clock in the middle of the capsule, both styles (Dynamic Glass flush with outward top corners that widen with the notch, Liquid Glass with a 3 px inset), no floating surface while closed, the clock restored on disable.
- Media through an MPRIS fixture: metadata, HTTP and local covers, raise, pause/seek, a real pointer click on play/pause, cover and waveform in the capsule, GStreamer levels; the output button and list with an AirPlay receiver (stubbed outputs — the test never touches the real network).
- Four tabs with one shared height, sliding indicator, clock in the header; keys 1–4 and Esc after an explicit open; spring morph with intermediate sizes, interrupted closing; 100 % black hides the glass.
- Calendar: native D-Bus events through a fixture, week strip with today selected and event dots, day selection, week arrows, calendar week, grouped notifications.
- Thunderstorm: focus, arithmetic result, copy with Enter, empty results.
- Radial menu: five actions centred below the clock, Esc; a real screenshot lands in the shelf, confirmed by a toast inside the capsule, collapsed and opened.
- Volume/brightness inline in the capsule instead of GNOME's OSD; scrolling over the capsule with a controlled mixer (one wheel step counts once); Caps Lock in the capsule, Num Lock silent.
- Glass layer exactly behind the island, and the same glass geometry below the native shelf and the drop zone; screenshots of both styles over a colourful backdrop.
- Notification banners instead of GNOME's banners.
- Clipboard: recording, autofocus, arrow keys, F, ★ and link filters, copy with Enter, file and PNG contents.
- Basket as a native Wayland window at the pointer; corner rounding, multi-select and copy in the GTK helper (`tests/tray.py`).
- Real file drags from Wayland and X11 windows onto the island: drop zone right below the clock, COPY confirmation, multiple files, Esc cancel, ordinary hover afterwards.
- Snap layouts: a real window dragged by its title bar to the clock opens the layouts; the hovered zone lights up and GNOME's tile preview shows the target; releasing tiles the window onto the left half of the work area.
- Super+Space with real key events opens the search every time; GNOME's layout-switch keys are borrowed with one layout and restored on disable.
- Real right clicks open the radial menu; the outer corners follow the bar's slide-in at login.
- The shelf's file menu opens inside the pane (no popup window) and removes a file with a real click; tiles deselect on a second click (`tests/tray.py`).
- Native shelf between the clock row and the tab bar: geometry, glass below it in both styles, drag-out into another Wayland client, switching via the tab bar, process reuse, overview, context-menu hold and Esc.
- Preferences through GNOME's D-Bus service (one window for repeated clicks) and disable/enable without leftover timers or signals.

`NOTCHY_TEST_DROP_ONLY=1 bash scripts/test-shell.sh` runs only the interaction part (sentinel `NOTCHY_DROP_TEST_OK`), `NOTCHY_TEST_CORNERS_ONLY=1` only the GTK corner test. With `NOTCHY_TEST_SHELL_THEME=/path/gnome-shell.css` the bar geometry is additionally checked under a custom Shell theme.

## Normal desktop session

The headless test does not replace real use. After installing and logging in again, check:

1. Hover, click, shortcuts, pin, Esc; both styles with your own panel theme (transparent bar: corners of the Dynamic Glass notch).
2. Volume keys and scrolling over the capsule with real hardware; brightness.
3. Drag files from Nautilus onto the island, shake for the basket, drag out of shelf and basket, Zip/Convert.
4. Drag windows to the clock and place them with each layout.
5. Media: switch playback to an AirPlay receiver and back.
6. Radial menu: area, window, screen, recording, text recognition (Tesseract).
7. Notifications from real apps, Do Not Disturb, calendar with a configured account.
8. Fullscreen, overview, scaling; disable/enable several times.
