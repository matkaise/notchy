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
- **Shelf („Regal“):** five-column grid. Click selects (Ctrl/Shift for several); clicking the selected tile again, clicking empty space or Esc deselects. Double click opens, dragging out copies. With a selection: **Zip**, **Convert** (images → WebP), **Remove** (originals stay). Right click opens the file's actions inside the pane (open, show in folder, save a copy, zip, convert, OCR, compress, remove).
- **Clipboard („Ablage“):** search and filters (all, links, images, ★). ↑↓ select, ↵ copies, ⇧↵ copies as plain text, F toggles favourite, Del deletes; double click copies. Recording is off by default.
- **Calendar („Kalender“):** a week strip with arrows (dots mark days with events), the selected day's agenda with a line at the current time, and GNOME's notifications grouped per app (click a stack to expand it), with Do Not Disturb and „clear all“.
- **Thunderstorm (Super + Space):** the island becomes a search field for apps, shelf files and arithmetic. Arrow keys and Enter; Esc closes.
- **AirDrop:** the AirDrop button in the island's header makes this computer visible to iPhones; an incoming transfer asks in the notch („Annehmen“ / „Ablehnen“, with a countdown) and received files land in the shelf. Send by dropping files on the „AirDrop“ half of the drop zone, or from the shelf (selection or file menu). Details below.
- **Radial menu (right click on the island or Super + Shift + R):** area, window, screen, recording, text (OCR). Screenshots land in the shelf, recognised text in the clipboard, recordings use GNOME's screen recorder.
- **Styles:** *Dynamic Glass* (a black notch fading into glass; the black share is adjustable, 100 % is entirely black without glass; its outer top corners widen as the notch grows) and *Liquid Glass* (a floating glass capsule).

Shortcuts: Super + Space (search), Super + Ctrl + Space (island), Super + Shift + Space (clipboard), Super + Shift + B (basket), Super + Shift + R (radial menu). All can be changed or cleared. GNOME uses Super + Space and Shift + Super + Space to switch keyboard layouts: with a single layout configured, Notchy takes these keys over while it runs (no setting is changed); with several layouts GNOME keeps them, so choose other Notchy shortcuts.

**Droplets** (Pomodoro, notes, weather, terminal …) are removed for now and will return later under a new name. The full source before that redesign is kept locally under `archive/` (not part of the repository).

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

Data lives in `$XDG_DATA_HOME/notchy` (usually `~/.local/share/notchy`), settings in GSettings. The shelf stores references; removing never deletes originals. File outputs (ZIP, conversions) go to `exports`. Screenshots from the radial menu land where GNOME puts them (Pictures/Screenshots).

Clipboard recording and keeping history across sessions are off by default. Known password managers and formats marked as sensitive are excluded; stored history is a local, unencrypted file.

HTTP(S) album covers are fetched outside the Shell process, size-limited and cached under `$XDG_CACHE_HOME/notchy/covers`. The live waveform only analyses the monitor of the default audio output and stores no audio.

AirPlay discovery runs as a small PipeWire client (`pipewire -c helper/airplay.conf`) only while Notchy is enabled and „AirPlay-Geräte im Netzwerk finden“ is on. It changes no system configuration and never restarts PipeWire; the receivers disappear with the process.

## Develop and test

```sh
bash scripts/check.sh
bash scripts/pack.sh
bash scripts/test-shell.sh
```

`check.sh` checks JavaScript syntax, the GSettings schema, Python syntax, and runs the domain, file-operation, cover, spectrum and MCP tests. `test-shell.sh` starts GNOME Shell 50 headless with its own D-Bus and temporary XDG directories; log and screenshots end up in `tests/output`. Details: [docs/TESTING.md](docs/TESTING.md); current state: [docs/VALIDATION_STATE.md](docs/VALIDATION_STATE.md).

The extension runs inside the GNOME Shell process. Shelf, basket and drop zone are native GTK windows (Python helpers) because only those can send and receive Wayland file drags; they sit exactly inside the Shell surface and are shown on top of the island's glass, so the two read as one surface.

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
