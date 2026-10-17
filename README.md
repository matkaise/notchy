# Notchy

Droppy for GNOME: the clock in the top bar becomes an island. Live activities dock to the left and right of the clock; opened, the island grows around the clock into **Media**, **Shelf**, **Clipboard** and **Calendar**.

**Status: a working, tested build — not a complete Droppy clone.** [docs/PARITY.md](docs/PARITY.md) tracks missing features and design differences. Notchy is an independent project and is not affiliated with Droppy.

The user interface is German; the repository (code, comments, docs, commits) is maintained in English. Tab names are given as *English („German“)* below.

## Requirements

- GNOME Shell **50** on Wayland. Notchy integrates into the top bar of the primary monitor.
- GJS, GTK 4.10 or newer, libadwaita, Python 3 and PyGObject.
- PipeWire 1.x for AirPlay output (uses PipeWire's `raop-discover` module and Avahi).
- Optional, for AirDrop: a MediaTek MT7921/MT7922 Wi-Fi card, Bluetooth, and the [airdrop-mt7921](https://github.com/jedbillyb/airdrop-mt7921) backend (see [AirDrop](#airdrop)).
- To build: `glib-compile-schemas`, `gnome-extensions`.
- Optional: ImageMagick (image conversion), Tesseract (text recognition), Ghostscript, LibreOffice, FFmpeg/FFprobe, `rembg`. Missing tools are never installed; their actions appear only when the program is present.
- Optional, for Thunderstorm's file search: GNOME LocalSearch (package `localsearch`, standard on Ubuntu/GNOME). Without it a bounded search of the personal folders stands in.
- AirPods work without extra software: Notchy reads connected AirPods itself. The [airpods-helper](https://github.com/superninjv/airpods-helper) daemon is used instead when it is installed (see [AirPods](#airpods)).

## Install

```sh
bash scripts/install.sh
```

Or install the built package: `gnome-extensions install --force dist/notchy@matthias.local.shell-extension.zip`. On Wayland, GNOME loads changed extensions only after logging out and back in. Then run `gnome-extensions enable notchy@matthias.local`.

## Usage

- **Clock and date:** GNOME's clock is the core of the island. A click opens the **Calendar („Kalender“)** tab; Settings → „Uhr öffnet den Kalender-Reiter“ switches back to GNOME's popup.
- **Hover opens, leaving closes.** The island morphs like a spring. All tabs have the same height, so switching never makes the island jump. Tabs at the bottom by click or keys **1–4** (after Super + Ctrl + Space or a click on the clock). The pin keeps the island open; the gear opens the settings. Esc or a click elsewhere closes it.
- **Live activities in the bar:** cover on the left, waveform on the right. Volume and brightness show inside the capsule instead of GNOME's OSD. **Scrolling over the closed island** changes the volume. Agent status and running file operations appear as text. Notchy's own confirmations („In Zwischenablage kopiert“, …) appear the same way inside the capsule — collapsed or opened.
- **Notifications** grow out of the island as a banner below the clock (app, title, text, actions); Do Not Disturb and GNOME's per-app banner settings apply.
- **Drag, drop, shake:** drag a file onto the island → „Ins Regal legen“ appears below the clock. Shake while dragging → the floating **basket („Korb“)** appears at the pointer; „Alles ins Regal“ hands its contents over.
- **Window snap layouts:** drag a window by its title bar up to the clock → the notch offers layouts (halves, two-thirds, thirds, half + quarters, quarters, full). Hovering a zone shows GNOME's own translucent tile preview; release and the window takes it.
- **Media („Medien“):** cover, title, artist, waveform, timeline and flat transport controls. The button at the bottom shows where the music plays; it opens a list of this computer's outputs and **AirPlay** receivers on the network. Choosing one moves playback there (like GNOME's own output selector), keeping the current volume.
- **Shelf („Regal“):** five-column grid. Click selects (Ctrl/Shift for several); clicking the selected tile again, clicking empty space or Esc deselects. Double click opens, dragging out copies. With a selection: **Zip**, **Convert** (images → WebP), **Remove** (originals stay). **Right click opens a real context menu** at the pointer, like in a file manager: a right click outside the selection selects that file, inside it the menu acts on all selected files. Entries: open, show in folder (selected in the file manager), copy, save a copy, zip, AirDrop, text recognition, convert ▸, remove background, shrink PDF, save as PDF, shrink video ▸, remove from shelf — only those the files and installed tools support. Arrow keys, Enter, ← for back from a submenu; Esc or a click elsewhere closes only the menu; Menu or Shift+F10 opens it for the selection.
- **Clipboard („Ablage“):** search and filters (all, links, images, ★). ↑↓ select, ↵ copies, ⇧↵ copies as plain text, F toggles favourite, Del deletes; double click copies. Recording is off by default.
- **Calendar („Kalender“):** a week strip with arrows (dots mark days with events), the selected day's agenda with a line at the current time, and GNOME's notifications grouped per app (click a stack to expand it), with Do Not Disturb and „clear all“.
- **Thunderstorm (Super + Space):** the island becomes a local launcher: apps, files and folders anywhere (GNOME LocalSearch), the shelf, arithmetic and unit conversion, quicklinks („yt lofi“), web search, system and window commands, clipboard history, snippets and emoji. Details below.
- **AirPods:** connecting grows the island into a card as on an iPhone — the name, the AirPods and their case springing in, battery rings filling up while the percentages count, „Verbunden“ with a check; the media tab shows left, right and case batteries, ear state, noise control (ANC, transparency, adaptive, off — as the model supports) and connect/disconnect. Details below.
- **AirDrop:** the AirDrop button in the island's header makes this computer visible to iPhones; an incoming transfer asks in the notch („Annehmen“ / „Ablehnen“, with a countdown) and received files land in the shelf. Send by dropping files on the „AirDrop“ half of the drop zone, or from the shelf (selection or file menu). Details below.
- **Radial menu (right click on the island or Super + Shift + R):** area, window, screen, recording, text (OCR). Screenshots land in the shelf, recognised text in the clipboard, recordings use GNOME's screen recorder.
- **Styles:** *Dynamic Glass* (a black notch fading into glass; the black share is adjustable, 100 % is entirely black without glass; its outer top corners widen as the notch grows) and *Liquid Glass* (a floating glass capsule).

Shortcuts: Super + Space (search), Super + Ctrl + Space (island), Super + Shift + Space (clipboard), Super + Shift + B (basket), Super + Shift + R (radial menu). All can be changed or cleared. GNOME uses Super + Space and Shift + Super + Space to switch keyboard layouts: with a single layout configured, Notchy takes these keys over while it runs (no setting is changed); with several layouts GNOME keeps them, so choose other Notchy shortcuts.

**Droplets** (Pomodoro, notes, weather, terminal …) are removed for now and will return later under a new name. The full source before that redesign is kept locally under `archive/` (not part of the repository).

## Thunderstorm

Super + Space opens the launcher in the island (in both styles). Everything runs locally, without accounts or cloud services, and no input is ever executed as a command.

| Source | Examples | Enter |
|---|---|---|
| Apps | `firef`, `gc` (initials), keywords | open (Ctrl+Enter: new window) |
| Files and folders | `rechnung märz` | open; actions: show in file manager (Ctrl+Enter), copy path (Ctrl+Shift+C), add to shelf |
| Arithmetic | `2+3*4`, `(19,90*3)/4` | copy result |
| Units | `10 km in mi`, `72°F`, `3,5 l nach ml`, `2 Stunden in Minuten`, `1 GiB in MB` | copy value |
| Quicklinks | `yt lofi`, `gh matkaise/notchy`, `wiki Zürich`, `dl`, `docs` | open (keyword alone: completes `yt `) |
| Web search | anything (last row) | search with the configured engine |
| System | `sperren`, `audio`, `energie`, `bereitschaft`, `abmelden`, `neu starten`, `ausschalten`, `nicht stören` | runs; log out, restart and shut down ask for a second Enter |
| Windows | `maximieren`, `links anordnen`, `zentrieren`, `arbeitsbereich 2`, `nächster arbeitsbereich` | acts on the window focused before |
| Clipboard | `ablage 4711` (or 3+ letters) | copy again — only while recording is on |
| Snippets | `mfg`, `heute`, `snippet …` | copy (`{date}`, `{time}`, `{datetime}` filled in) |
| Emoji and characters | `:herz`, `emoji daumen`, `zeichen pfeil` | copy |
| AirPods | `airpods transparenz`, `airpods trennen` | with a connected device |

Results are labelled by category; ↑↓ choose, Enter runs, **Ctrl+K** opens the result's action panel (also a right click), Esc steps back (confirmation, panel, folder list) and then closes. The empty field shows recently used results, the dock's favourites and recently opened files. Ranking weighs exact, prefix, word-start, substring, initials and fuzzy matches, how often and how recently a result was used, and for files their age and depth.

**File search.** Thunderstorm queries the index GNOME LocalSearch already keeps (its Tracker 3 SPARQL endpoint on the session bus, `org.freedesktop.LocalSearch3`, or `org.freedesktop.Tracker3.Miner.Files` on older versions). The search term is a bound query parameter reduced to plain word prefixes, so it can never change the query. The work happens in `helper/filesearch.py`, a small process outside the Shell: typing waits 140 ms, an overtaken search is dropped, at most 30 candidates are checked on disk (missing files and unmounted drives drop out, unreadable files are marked), hidden files appear only for a query starting with `.`. Notchy never starts or configures the indexer by itself. Without LocalSearch it says so in the launcher and searches the personal folders instead (no hidden or linked folders, depth 5, at most 40 000 entries and 4 s, cached for 5 minutes). „Indizierte Ordner anzeigen“ lists what is indexed; Settings → Thunderstorm adds or removes indexed folders — this edits LocalSearch's own per-user settings (`org.freedesktop.Tracker3.Miner.Files`), never anything system-wide.

**Quicklinks and snippets** are edited in Settings → Thunderstorm and stored as JSON in GSettings. A quicklink's target is an http(s) address with `{query}` (URL-encoded argument) or `{path}` (encoded, slashes kept), `xdg:DOWNLOAD` and friends, a folder (`~/Projekte`) or `app:ID.desktop`; anything else is rejected. Automatic pasting of snippets into other apps is not offered: Wayland has no reliable and safe way to type into another client.

## AirPods

**Without extra software.** Notchy finds connected Apple headphones through BlueZ (vendor 0x004C/0x05AC only; other headsets are never touched) and reads them itself over Apple's accessory protocol (AAP): `helper/aap.py` opens the AirPods' AAP channel (L2CAP PSM 0x1001) as the logged-in user — no root, no pairing, no change to the Bluetooth configuration — follows the AirPods' own connection steps (handshake, wait for its answer, unlock features, request notifications, ask again until the batteries arrive; as LibrePods does) and reports batteries of both buds and the case, charging, ear state, noise control, conversation awareness and the model. Commands are the AirPods' own control messages (noise control, conversation awareness). Every new Bluetooth connection starts the reader afresh after a short pause; a channel that fails is retried after 2, 4, 8, 15, 30 and then every 60 seconds while the AirPods stay connected. Ear detection then pauses and resumes media through Notchy (Settings → AirPods). BlueZ alone does not report a battery for current AirPods, and their Bluetooth LE adverts carry batteries only while the case is opened, which is why the connected AirPods are asked directly.

**With airpods-helper.** When [airpods-helper](https://github.com/superninjv/airpods-helper)'s daemon runs, it owns the AAP session and Notchy steps back: it reads `org.costa.AirPods` (its `docs/dbus-api.md`), follows `PropertiesChanged` and calls `SetAncMode`, `SetConversationalAwareness`, `ConnectTo`/`Reconnect` and `Disconnect`. The media pause is then the daemon's own `PauseOnRemoval`, switchable in Notchy's settings, so there is never a second ear logic. LibrePods is a full application without a documented D-Bus API for other front ends; OpenPods and similar projects are Android apps.

**In the island.** Connecting grows the island into the connection card: the name, the AirPods and the case drawn in white springing in, battery rings filling up with the percentages counting up, and „Verbunden“ with a check. Both buds share one ring while they are within 10 %, else each gets its own, as on an iPhone. With a tab open the card waits until the island closes; a notification arriving with it (the system announcing the same connection) waits until the card has been seen. The media tab shows a compact row with left, right and case batteries, ear state, noise control and connect/disconnect. While the island is closed, connected AirPods sit beside the notch as a small round symbol inside a battery ring (the lower bud; orange when low), as Droppy and Apple show a connected accessory; a click opens their controls: the batteries, noise control (ANC, transparency, adaptive, off), conversation awareness, the ear pause and disconnect (Settings → AirPods → „Symbol neben der Notch“).

What appears depends on the model: noise control with ANC models, adaptive mode and conversation awareness with AirPods Pro 2/3 and AirPods 4 with ANC, one battery for over-ear models. Batteries the AirPods do not report (e.g. the case closed or out of range) read „–“, never 0 %. A low-battery warning (default below 15 %) appears once per bud or case until it recovers or charges.

**Validation.** The AAP reader was run against real AirPods Pro 2 (USB-C) on this machine (batteries, noise control, conversation awareness, ear state); its packets are recorded in `tests/fixtures/aap-airpods-pro2.hex` and replayed by the tests. The daemon path was tested against a stand-in with airpods-helper's API (`tests/mock_airpodsd.py`), not the real daemon.

## AirDrop

Notchy is a front end for [airdrop-mt7921](https://github.com/jedbillyb/airdrop-mt7921) (GPL-3.0), which speaks AWDL (Apple's peer-to-peer Wi-Fi) through a patched OWL and AirDrop through a patched OpenDrop on MediaTek MT7921/MT7922 cards. Notchy itself never runs anything as root; the backend's own narrow sudo helper does.

What to expect with an MT7921/MT7922:

- **Wi-Fi pauses while AirDrop is active.** Notchy runs the backend in *exclusive* mode, only on demand: switching AirDrop on (or sending) takes the card, and the backend gives it back by itself about a minute after the last transfer (three minutes if nothing arrives). With a LAN cable the internet stays up.
- **Slow:** roughly 40–70 kB/s, so a photo takes a minute or two.
- **„Everyone for 10 Minutes“ only** on the iPhone; „Contacts Only“ is not possible off Apple hardware.
- **Experimental:** discovery sometimes stalls; closing and reopening the share sheet on the iPhone helps.
- Sending goes to the first AirDrop receiver found; the phone always has to accept, so a wrong target only ever sees a request.

Setup (once, as yourself; the installer shows and asks before it adds its sudo rule):

```sh
git clone https://github.com/jedbillyb/airdrop-mt7921.git ~/airdrop-mt7921
cd ~/airdrop-mt7921 && ./install.sh
```

Exclusive mode needs your regulatory country in `~/.config/airdrop/config`, e.g. `AIRDROP_REG="${AIRDROP_REG:-CH}"`. With ufw, allow the receiver: `sudo ufw allow in on awdl0 from fe80::/10 to any port 8770:8771 proto tcp`.

Notchy finds the backend in `~/airdrop-mt7921` (and a few other usual places, or via the `/usr/local/bin/airdrop-send` symlink); Settings → „AirDrop (experimentell)“ shows whether it was found and takes another path. Received files go to `Downloads/AirDrop` unless set otherwise there. Notchy answers the backend's consent hook (`AIRDROP_CONFIRM`) itself: anything but an explicit „Annehmen“ — „Ablehnen“, Esc, a click elsewhere, no answer in time — declines.

## Data

Data lives in `$XDG_DATA_HOME/notchy` (usually `~/.local/share/notchy`), settings in GSettings. The shelf stores references; removing never deletes originals. Thunderstorm keeps the results you used (`launcher-history.json`: title and how to find the result again, at most 200) for ranking and the start list. File outputs (ZIP, conversions) go to `exports`. Screenshots from the radial menu land where GNOME puts them (Pictures/Screenshots).

Clipboard recording and keeping history across sessions are off by default. Known password managers and formats marked as sensitive are excluded; stored history is a local, unencrypted file.

HTTP(S) album covers are fetched outside the Shell process, size-limited and cached under `$XDG_CACHE_HOME/notchy/covers`. The live waveform only analyses the monitor of the default audio output and stores no audio.

AirPlay discovery runs as a small PipeWire client (`pipewire -c helper/airplay.conf`) only while Notchy is enabled and „AirPlay-Geräte im Netzwerk finden“ is on. It changes no system configuration and never restarts PipeWire; the receivers disappear with the process.

## Develop and test

```sh
bash scripts/check.sh
bash scripts/pack.sh
bash scripts/test-shell.sh
```

`check.sh` checks JavaScript syntax, the GSettings schema, Python syntax, and runs the domain, launcher (ranking, units, quicklinks), file-operation, file-search, context-menu, cover, spectrum and MCP tests. `test-shell.sh` starts GNOME Shell 50 headless with its own D-Bus and temporary XDG directories; log and screenshots end up in `tests/output`. Details: [docs/TESTING.md](docs/TESTING.md); current state: [docs/VALIDATION_STATE.md](docs/VALIDATION_STATE.md).

The extension runs inside the GNOME Shell process. Shelf, basket and drop zone are native GTK windows (Python helpers) because only those can send and receive Wayland file drags; they sit exactly inside the Shell surface and are shown on top of the island's glass, so the two read as one surface. Their popups (the shelf's context menu, tooltips) are Wayland popup surfaces that Mutter stacks with the windows, below the Shell's chrome; Notchy shows them as clones on top of everything while the real popup keeps the input (the island's tab bar lets clicks through while a menu is open).

Thunderstorm's providers live in `src/launcher/` (`providers.js`: one class per source; `logic.js`: pure ranking, units and quicklink code shared with the Node tests; `launcher.js`: debouncing, history, sessions). File search is `src/services/filesearch.js` with `helper/filesearch.py`; AirPods are `src/services/airpods.js`.

## Integrations

```sh
scripts/notchyctl add '/path/to/file.pdf'
scripts/notchyctl list
scripts/notchyctl activity 'My agent' 'Running tests' --progress 0.6
scripts/notchyctl clear-activity 'My agent'
```

MCP configuration for a local client:

```json
{
  "mcpServers": {
    "notchy": {
      "command": "/usr/bin/python3",
      "args": ["/absolute/path/to/Notchy/helper/mcp_server.py"]
    }
  }
}
```

The MCP bridge offers `list_shelf`, `add_files`, `set_activity` and `clear_activity`. It opens no network port and never returns clipboard history.
