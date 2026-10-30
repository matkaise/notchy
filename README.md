# Notchy

Droppy for GNOME: the clock in the top bar becomes an island. Live activities dock to the left and right of the clock; opened, the island grows around the clock into **Media**, **Shelf**, **Clipboard** and **Calendar**.

**Status: a working, tested build — not a complete Droppy clone.** [docs/PARITY.md](docs/PARITY.md) tracks missing features and design differences. Notchy is an independent project and is not affiliated with Droppy.

The user interface speaks **German and English** and follows the GNOME/system language automatically (`de`, `de_DE`, `de_CH`, `de_AT` → German; English for `en_*` and every other language); Settings → Appearance → Language can pick one for Notchy alone (see [Languages](#languages)). The repository (code, comments, docs, commits) is maintained in English. Tab names are given as *English („German“)* below.

## Requirements

- GNOME Shell **47, 48, 49, 50 or 51** on Wayland, from one package ([docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) lists what differs between releases and how each was tested). Notchy integrates into the top bar of the primary monitor.
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
- **Live activities in the bar:** cover on the left, waveform on the right. Volume and brightness show inside the capsule instead of GNOME's OSD. **Scrolling over the closed island** changes the volume. Simple named activities (`notchyctl activity`, MCP `set_activity`) and running file operations appear as text. AI agents (Claude Code, Codex, Antigravity) and connected AirPods sit as small round indicators beside the notch (see [AI agents](#ai-agents)); the notch keeps one width for one content and stays in the middle of the bar however many indicators there are. Notchy's own confirmations („In Zwischenablage kopiert“, …) appear the same way inside the capsule — collapsed or opened.
- **Smart Live Activities:** the closed notch shows the most important thing that runs — an agent waiting for you, a failure, something that just finished (a green check), a transfer with its real progress (Notchy's own copies, ZIPs and videos; copies and archives in Files, which publishes its progress; browser downloads are not shown, as Chrome and Firefox publish no progress here), a timer's remaining time, a red dot while GNOME records the screen, the music. Urgent ones show at once, the others after the shown one had its moment, so the notch does not jump; a click on the capsule while it names a waiting agent opens that agent's card. Timers: „timer 10 min Tee“ or „pomodoro“ in Thunderstorm, or `notchyctl timer`. Other apps report their own activities over D-Bus, `notchyctl live` or MCP. Progress is never invented: without a measurement there is no bar. Details in [docs/ACTIVITIES.md](docs/ACTIVITIES.md).
- **Notifications** grow out of the island as a banner below the clock (app, title, text, actions); Do Not Disturb and GNOME's per-app banner settings apply.
- **Drag, drop, shake:** drag a file onto the island → two cards appear below the clock, „Ins Regal legen“ and (with AirDrop) „AirDrop“; the one under the pointer grows and lights up. Shake while dragging → the floating **basket („Korb“)** appears at the pointer: it fans out what it collects, drags it out as one stack, and „Alles ins Regal“ hands its contents over.
- **Window snap layouts:** drag a window by its title bar up to the clock → the notch offers layouts (halves, two-thirds, thirds, half + quarters, quarters, full). Hovering a zone shows GNOME's own translucent tile preview; release and the window takes it.
- **Media („Medien“):** a large cover beside title, artist, waveform, timeline and the transport with a round play button; the playing app sits at the foot of the column. With nothing playing the tab rests quietly („Gerade ist es still“) and offers to open the music app (whatever opens an MP3). The output button shows where the music plays; it opens a list of this computer's outputs and **AirPlay** receivers on the network. Choosing one moves playback there (like GNOME's own output selector), keeping the current volume.
- **Shelf („Regal“):** a grid of six tiles a row (five on a narrow island): a picture's preview or the file type on a small document, the name and the size; the header names the Regal with its count and total size, or with a selection its size and its actions. Empty, it says so and offers „Dateien auswählen“. **In the notch:** while files wait, their count sits beside the clock; when music or an activity has the capsule, a small Regal pill with the count waits beside the notch (a click opens the Regal). Files landing while the island is closed open the notch a moment: their cards drop in, a ring of light and sparks mark the landing, „Im Regal“ slides in and the count rolls up. Click selects (Ctrl/Shift for several); clicking the selected tile again, clicking empty space or Esc deselects. Double click opens, dragging out copies. With a selection: **Zip**, **Convert** (images → WebP), **Remove** (originals stay). **Right click opens a real context menu** at the pointer, like in a file manager: a right click outside the selection selects that file, inside it the menu acts on all selected files. Entries: open, show in folder (selected in the file manager), copy, save a copy, zip, AirDrop, text recognition, convert ▸, remove background, shrink PDF, save as PDF, shrink video ▸, remove from shelf — only those the files and installed tools support. Arrow keys, Enter, ← for back from a submenu; Esc or a click elsewhere closes only the menu; Menu or Shift+F10 opens it for the selection.
- **Clipboard („Ablage“):** the history on the left, grouped by day (each entry's kind as a tinted tile, a colour as itself, the time), the selected entry on the right as what it is: text to read, a link with its site, the picture with its size, a colour with HEX, RGB and HSL to copy, the files — with Kopieren, Als Text, favourite, Regal and delete. Search (the match highlighted) and filters (all, links, pictures, favourites, each with its count). ↑↓ select, ↵ copies, ⇧↵ copies as plain text, F toggles favourite, Del deletes; double click copies. Recording is off by default.
- **Calendar („Kalender“):** a week strip with arrows (dots mark days with events), the selected day's agenda with a line at the current time, and GNOME's notifications grouped per app (click a stack to expand it), with Do Not Disturb and „clear all“.
- **Thunderstorm (Super + Space):** the island becomes a local launcher: apps, files and folders anywhere (GNOME LocalSearch), the shelf, arithmetic and unit conversion, quicklinks („yt lofi“), web search, system and window commands, clipboard history, snippets and emoji. Details below.
- **AirPods:** connecting grows the island into a card as on an iPhone — the name, the AirPods and their case springing in, battery rings filling up while the percentages count, „Verbunden“ with a check. Afterwards they sit beside the notch as a small symbol in a battery ring; a click opens their controls: left, right and case batteries, ear state, noise control (ANC, transparency, adaptive, off — as the model supports), conversation awareness, the ear pause and disconnect. Details below.
- **AirDrop:** the AirDrop button in the island's header makes this computer visible to iPhones; an incoming transfer asks in the notch („Annehmen“ / „Ablehnen“, with a countdown) and received files land in the shelf. Send by dropping files on „An Handy senden“ in the drop zone, or from the shelf (selection or file menu). Any phone — without AirDrop's backend, or by switching the banner's pill — gets them by **QR code** instead, through the same banners ([Phones by QR code](#phones-by-qr-code)). Details below.
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
| System | `sperren`/`lock`, `audio`, `energie`, `bereitschaft`/`suspend`, `abmelden`/`log out`, `neu starten`/`restart`, `ausschalten`/`shutdown`, `nicht stören`, `bildschirmfoto`, `regal` | runs; log out, restart and shut down ask for a second Enter. Configurable: [System commands](#system-commands) |
| Windows | `maximieren`, `links anordnen`, `zentrieren`, `arbeitsbereich 2`, `nächster arbeitsbereich` | acts on the window focused before |
| Clipboard | `ablage 4711` (or 3+ letters) | copy again — only while recording is on |
| Snippets | `mfg`, `heute`, `snippet …` | copy (`{date}`, `{time}`, `{datetime}` filled in) |
| Emoji and characters | `:herz`, `emoji daumen`, `zeichen pfeil` | copy |
| AirPods | `airpods transparenz`, `airpods trennen` | with a connected device |

Results are labelled by category; ↑↓ choose, Enter runs, **Ctrl+K** opens the result's action panel (also a right click), Esc steps back (confirmation, panel, folder list) and then closes. The empty field shows recently used results, the dock's favourites and recently opened files. Ranking is type-aware: an ordinary query puts exactly matching apps first, then strongly matching apps (prefix, word start), then exactly matching system commands and quicklinks, then exactly matching files and folders, then the remaining apps, commands and files, then weak (fuzzy) matches — so „chrome“ finds Google Chrome above thirty files called chrome-something, while a barely matching app still yields to a file with exactly that name. Within these bands the match quality (exact, prefix, word start, substring, initials, fuzzy), how often and how recently a result was used (capped per type, so an often opened file never pushes an exactly matching app away), and for files their age, depth and recent use decide. Calculator, unit conversions, quicklink keywords and prefixed searches (`emoji …`, `ablage …`) always lead. **`datei …`, `file …` or `/…` searches files and folders only** („Nur Dateien und Ordner“ in the footer). File results that arrive late are merged without moving the selection once you moved it.

Search terms work in **German and English whatever language the interface speaks** (`ausschalten` and `shutdown`, `bildschirm sperren` and `lock screen`, `datei bericht` and `file report`, `3,5 l nach ml` and `3.5 l to ml`); a translated title is only one more search term, so translations never change the order of results. Numbers are shown the interface's way (`1,5 km` / `1.5 km`); the calculator accepts a decimal comma or point either way.

### System commands

Settings → Thunderstorm → **Configure System Commands** lists every built-in command by category (Power & Session, Settings, System & Notifications, Devices, Windows) with a search field. Per command: on or off, shown in results or **only by its shortcut**, own **search terms**, **favourite** (listed on the empty field, ranked a little higher), **priority** (orders equally good matches), a **shortcut** (typed exactly, it leads like a quicklink keyword), and „Reset to Defaults“ (also for all at once). Changes apply at once, without restarting the extension. Shared search terms or a shortcut equal to a quicklink keyword are pointed out. A switched-off command never appears, not even from the usage history; context-dependent ones (AirPods, window and workspace commands, Do Not Disturb) appear only when they can work. **Log out, restart and shut down always ask for a second Enter** — from a search, a shortcut, the action panel or the history; no setting can turn that off.

Besides GNOME's settings pages and the power commands, the catalog offers safe actions through existing GNOME and Notchy functions: take a screenshot (into the Regal), record the screen, open Notchy, the Regal, the clipboard history or the audio output list, show the indexed folders, AirPods connect/disconnect and noise control. Free shell commands are deliberately not offered: a launcher that runs arbitrary command lines from a settings string would turn any settings change into code execution. Everything is stored per stable command id (`system.shutdown`, `settings.bluetooth`, …) as JSON in `launcher-commands`; titles are never stored, so a language change keeps every setting.

**File search.** Thunderstorm queries the index GNOME LocalSearch already keeps (its Tracker 3 SPARQL endpoint on the session bus, `org.freedesktop.LocalSearch3`, or `org.freedesktop.Tracker3.Miner.Files` on older versions). The search term is a bound query parameter reduced to plain word prefixes, so it can never change the query. The work happens in `helper/filesearch.py`, a small process outside the Shell: typing waits 140 ms, an overtaken search is dropped, at most 30 candidates are checked on disk (missing files and unmounted drives drop out, unreadable files are marked), hidden files appear only for a query starting with `.`. Notchy never starts or configures the indexer by itself. Without LocalSearch it says so in the launcher and searches the personal folders instead (no hidden or linked folders, depth 5, at most 40 000 entries and 4 s, cached for 5 minutes). „Indizierte Ordner anzeigen“ lists what is indexed; Settings → Thunderstorm adds or removes indexed folders — this edits LocalSearch's own per-user settings (`org.freedesktop.Tracker3.Miner.Files`), never anything system-wide.

**Quicklinks and snippets** are edited in Settings → Thunderstorm and stored as JSON in GSettings. A quicklink's target is an http(s) address with `{query}` (URL-encoded argument) or `{path}` (encoded, slashes kept), `xdg:DOWNLOAD` and friends, a folder (`~/Projekte`) or `app:ID.desktop`; anything else is rejected. Automatic pasting of snippets into other apps is not offered: Wayland has no reliable and safe way to type into another client.

## AirPods

**Without extra software.** Notchy finds connected Apple headphones through BlueZ (vendor 0x004C/0x05AC only; other headsets are never touched) and reads them itself over Apple's accessory protocol (AAP): `helper/aap.py` opens the AirPods' AAP channel (L2CAP PSM 0x1001) as the logged-in user — no root, no pairing, no change to the Bluetooth configuration — follows the AirPods' own connection steps (handshake, wait for its answer, unlock features, request notifications, ask again until the batteries arrive; as LibrePods does) and reports batteries of both buds and the case, charging, ear state, noise control, conversation awareness and the model. Commands are the AirPods' own control messages (noise control, conversation awareness). Every new Bluetooth connection starts the reader afresh after a short pause; a channel that fails is retried after 2, 4, 8, 15, 30 and then every 60 seconds while the AirPods stay connected. Ear detection then pauses and resumes media through Notchy (Settings → AirPods). BlueZ alone does not report a battery for current AirPods, and their Bluetooth LE adverts carry batteries only while the case is opened, which is why the connected AirPods are asked directly.

**With airpods-helper.** When [airpods-helper](https://github.com/superninjv/airpods-helper)'s daemon runs, it owns the AAP session and Notchy steps back: it reads `org.costa.AirPods` (its `docs/dbus-api.md`), follows `PropertiesChanged` and calls `SetAncMode`, `SetConversationalAwareness`, `ConnectTo`/`Reconnect` and `Disconnect`. The media pause is then the daemon's own `PauseOnRemoval`, switchable in Notchy's settings, so there is never a second ear logic. LibrePods is a full application without a documented D-Bus API for other front ends; OpenPods and similar projects are Android apps.

**In the island.** Connecting plays out as on an iPhone's island: the capsule widens into a pill (the AirPods' symbol springs in, a battery ring draws), then the notch springs open into the connection card — the AirPods and their case large on the left, flying in turned, overshooting, floating, a glint passing over them; beside them the name, „Verbunden“ with a check, and battery rings filling up with the percentages counting up — and folds back into the pill with the battery a moment before it is the clock again. Disconnecting widens the capsule into a pill that says „Getrennt“ while the AirPods' symbol turns grey and falls away and the ring empties. Both buds share one ring while they are within 10 %, else each gets its own, as on an iPhone. With a tab open the card waits until the island closes; a notification arriving with it (the system announcing the same connection) waits until the card has been seen. The media tab stays the player's; the AirPods' controls are beside the notch: while the island is closed, connected AirPods sit beside the notch as a small round symbol inside a battery ring (the lower bud; orange when low), as Droppy and Apple show a connected accessory; a click opens their controls: the batteries (a bud out of the ear says so), noise control (ANC, transparency, adaptive, off), conversation awareness, the ear pause, disconnect and Bluetooth settings (Settings → AirPods → „Symbol neben der Notch“). Known but disconnected AirPods are connected from Thunderstorm („airpods verbinden“).

What appears depends on the model: noise control with ANC models, adaptive mode and conversation awareness with AirPods Pro 2/3 and AirPods 4 with ANC, one battery for over-ear models.

**The case battery.** AirPods report the case's level only while the case is connected to a bud — while at least one bud sits in it, lid open or just closed. With both buds in the ears, or the case out of reach, the AirPods themselves report the case as disconnected (AAP status 0x04; airpods-helper's `BatteryCase = -1`): its level is unknown at that moment, which is why it used to come and go. Notchy now keeps, per device (by its Bluetooth address) and per part, the last valid reading with its time and source (`src/services/batteries.js`, saved in `airpods-batteries.json`): a live reading shows normally; a remembered one shows greyed with its age („Case · vor 12 Min.“, a grey ring), never as live and never as charging; it expires after 12 hours. A part never read in this connection or before reads „–“, never 0 %; another pair's case is never used. An unknown value never erases a valid one; switching between the built-in reader and airpods-helper keeps the cache. When the case is still unknown after the buds reported, the built-in reader asks the AirPods once more after 15 s and 45 s — never more often, and never while airpods-helper owns the connection. Notchy cannot read a closed case far away: no AirPods model sends that. A low-battery warning (default below 15 %) appears once per bud or case until it recovers or charges.

**Validation.** The AAP reader was run against real AirPods Pro 2 (USB-C) on this machine (batteries, noise control, conversation awareness, ear state); its packets are recorded in `tests/fixtures/aap-airpods-pro2.hex` and replayed by the tests. The daemon path was tested against a stand-in with airpods-helper's API (`tests/mock_airpodsd.py`), not the real daemon.

## AI agents

Active AI agents appear beside the notch, each as a small round indicator like the AirPods: Claude Code, Codex and Google Antigravity through their own hook systems, anything else through `notchyctl` or the MCP bridge. Each indicator is one agent; its sessions (one per conversation, so two Claude Code sessions are two rows) are its card's rings.

| State | Shown as |
|---|---|
| working — a task runs (also between tool calls) | a short arc turning around the icon; a real progress, if reported, as a filling ring |
| waiting — needs your approval or an answer | an orange ring that pulses a few times, then stays orange; „?“ |
| completed — a task finished | a short bounce and a green ✓ — it stays until you looked (its window, its card); the badge counts the finished sessions |
| error | a red ring with „!“ |
| idle — ready, no task | a quiet static ring (can be hidden) |
| disconnected | fades out |

A started process alone never counts as working: only the agent's own events change a state. A click opens the agent's **card** out of the notch, as the AirPods card springs open: the agent's symbol large on the left, each session as a ring on the right, three to a row and scrolling past about three rows (waiting „?“, working with a turning arc or its real progress, done „✓“, quiet), the project folder's name and the state with its time below. A click on a ring (or Enter) switches to that session's window when it can be named for sure (the nearest of its process ancestors owning windows: its only window, or the only one whose title names the project). A waiting session adds one line — „Website möchte Bash ausführen – bestätige in seinem Fenster.“ — with „Später“ and „Zum Fenster“; with several agents a small pill of their symbols at the foot switches between their cards. The card updates in place; Esc or leaving it closes it, and while it is open the indicators hide as they do whenever the notch is open. A finished task stays **done** (green, „neu“ on the card) until you looked — its window got the focus, you switched to it or its card was shown (Settings → Agenten: off turns it ready after the seconds set there). A crashed agent is noticed by its process (its id and start time come with each event). An app closed to the background (its window gone, its process still running, as the ChatGPT/Codex app does) sends no session end: once the app that had a window has none for 3 s, its idle and finished sessions leave the bar, while a task that still works or waits stays; reopening the app brings them back; a session without a process to check ends after missed heartbeats or a long quiet time (2 h idle, 8 h working) — never after a fixed hour while it works. Sessions survive disabling and enabling Notchy for 15 minutes if their process still runs. An ended session stays ended: hooks run as separate processes, so a PostToolUse or Stop can arrive after SessionEnd, even with a newer time; such stragglers are ignored for two minutes after the end, also once the indicator has faded. Only a new start (SessionStart, `claude --resume`, `notchyctl agent start`) or an explicit report from `notchyctl`/MCP brings the id back, as a new generation. Events of the same millisecond keep the order a session goes through (a Stop is not undone by its last PostToolUse arriving later), and a SessionEnd always ends the session even if a later-stamped step arrived first.

**Notifications.** Notchy can notify when an agent needs you, finished or failed (each switchable, optionally with a sound; not while its window has the focus) — with the agent, project and state only. Notchy answers no approval itself (Claude Code's PermissionRequest hook could, but it would hold the agent until Notchy answered; see [docs/ACTIVITIES.md](docs/ACTIVITIES.md#agent-control-center)); it shows what the agent waits for and switches to it.

**Placement.** Indicators are placed by a layout manager (`src/ui/sideLayout.js`, `src/ui/sideIndicators.js`): both sides of the notch are kept equally wide, so the notch stays exactly in the middle and its own width never changes; a new indicator goes to the side with less in use; an indicator keeps its side on every status update; sides are only rebalanced when they drift two apart; what does not fit between the notch and GNOME's other panel items spills to the other side and then gathers in a „+N“ group whose popup lists the rest, keeping waiting and failed agents and the AirPods visible. AirPods stay right of the notch; all agents can be put on one side, each agent's side can be fixed, and the number of visible indicators can be limited (Settings → Agenten). While the island is open the indicators are hidden.

**Setting up the hooks** (only when you ask for it: Settings → Agenten → „Einrichten“, or `scripts/notchyctl agent hooks install --provider claude|codex|antigravity`, `--dry-run` to see the result first). Notchy adds `helper/agent_hook.py` beside your existing hooks, never changes or removes them, keeps a dated copy of the file first and leaves a file that is not valid JSON alone; „Entfernen“ (`… hooks uninstall`) takes out exactly Notchy's entries. The adapter answers at once and talks to Notchy in a detached child, so it never slows the agent; it forwards only the event, the session id, a tool's name and the project folder's name — prompts, tool inputs, answers and transcripts are never read further or sent. When an event cannot be delivered (Notchy not running, no session bus in the agent's environment), the adapter keeps the reason — never the payload — in `~/.cache/notchy/agent-hook-error.json`, and `notchyctl agent hooks status` shows it. Codex also needs the hooks approved once: run `codex` (the CLI shares its configuration with the desktop app; on the desktop app's bundled CLI `codex --no-daemon`), open `/hooks` and trust Notchy's entries; events sent before that are not run.

| Agent | Configuration | Events used | Notes |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification (`permission_prompt`, `idle_prompt`, `elicitation_dialog`), Stop, StopFailure, SessionEnd | waiting is exact: a permission request or question |
| Codex (CLI) | `~/.codex/hooks.json` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop, Interrupt, SessionEnd | Codex runs new hooks only after you reviewed and trusted them with `/hooks` |
| Antigravity | `~/.gemini/config/hooks.json` (hook „notchy“) | SessionStart, PreInvocation, PostInvocation, PostToolUse, Stop (`fullyIdle`, `error`) | no event for „needs approval“, so waiting is never shown; no session end (the process check ends it); Notchy takes no part in its PreToolUse permission decisions |
| ChatGPT (browser, desktop app) | — | — | no status interface; Notchy reads nothing from them. Report manually with `notchyctl` or MCP if you like |

The Codex desktop app and IDE extension share Codex's configuration directory, but whether they run hooks was not verified; ChatGPT's chat in the browser is deliberately not read.

## Phones by QR code

Any phone in the same Wi-Fi can receive files from Notchy and send files to it — Android or iPhone, without an app or an account — through the same banners as AirDrop, not a second surface:

- **Sending:** drop files on „An Handy senden“ below the clock, or use „An Handy senden“ in the Regal and the basket. Without AirDrop's backend the banner shows a QR code at once; with it, AirDrop searches as before and a small pill „AirDrop | QR-Code“ switches to the code (AirDrop is stopped then, as it holds the Wi-Fi card; the code appears once the Wi-Fi is back). The phone scans it with its camera, its browser opens a page in Notchy's look — a notch naming this computer („Rechner von Matthias“, from its pretty hostname or the user's first name), the files as tiles with previews for photos, „Alle laden (ZIP)“ for several, a ✓ on each file once it arrived — and the banner shows who downloads and how far — bytes Notchy really delivered — then „An Pixel 8 gesendet“. The link ends with the banner.
- **Receiving:** the button in the island's header (AirDrop's) opens the receive banner: visible to iPhones with AirDrop, or a QR code. The phone picks files and sends; the notch asks first with AirDrop's question („Pixel 8 möchte 3 Dateien senden (12,4 MB)“), and only „Annehmen“ lets them in. The phone's page shows the chosen files as tiles, waits for the answer, then a ring with each file's progress. They land in the Regal and in the AirDrop folder (Settings); the banner counts them („1 Datei empfangen · bereit für mehr“) and stays open, so „Weitere senden“ on the phone works. Receiving ends 10 minutes after the last transfer or with the banner.
- **How:** `helper/share.py` runs a small web server for one session, in its own process (nothing of it runs in the Shell). The link carries a random key; only private-network addresses are served (never the internet); file names a phone sends are reduced to plain names inside the chosen folder; nothing is stored before „Annehmen“. The page is plain HTML with no external resources under a strict CSP; photo previews are scaled down on the computer (GdkPixbuf), and an old link shows „Dieser Link gilt nicht mehr“. The QR code is Notchy's own encoder (`src/qrcode.js`, checked against zbar).
- **Limits:** phone and computer must be in the same network (guest Wi-Fi with client isolation prevents it). The link is plain http in the local network: someone reading the same Wi-Fi could see the files (https would need a self-signed certificate the phone warns about). AirDrop and the QR code cannot run at the same time with the MediaTek card, hence the pill. A firewall (ufw) must allow incoming connections from the local network on a random port.
- Settings → „Handys per QR-Code“ switches it off.

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

Data lives in `$XDG_DATA_HOME/notchy` (usually `~/.local/share/notchy`), settings in GSettings. The shelf stores references; removing never deletes originals. Thunderstorm keeps the results you used (`launcher-history.json`: their ids and how to find them again, never their translated titles, at most 200) for ranking and the start list; entries of older versions (`cmd:lock` …) are moved to the new ids (`cmd:system.lock`) with their counts. File outputs (ZIP, conversions) go to `exports`. Screenshots from the radial menu land where GNOME puts them (Pictures/Screenshots).

Clipboard recording and keeping history across sessions are off by default. Known password managers and formats marked as sensitive are excluded; stored history is a local, unencrypted file.

HTTP(S) album covers are fetched outside the Shell process, size-limited and cached under `$XDG_CACHE_HOME/notchy/covers`. The live waveform only analyses the monitor of the default audio output and stores no audio.

AirPlay discovery runs as a small PipeWire client (`pipewire -c helper/airplay.conf`) only while Notchy is enabled and „AirPlay-Geräte im Netzwerk finden“ is on. It changes no system configuration and never restarts PipeWire; the receivers disappear with the process.

## Languages

German and English are complete; English is the source language of the gettext catalog (`po/notchy.pot`, `po/de.po`, domain `notchy`, compiled to `locale/LL/LC_MESSAGES/notchy.mo` in the package). The Shell extension, the preferences and the Python helpers (the Regal, the drop zone, file operations, `notchyctl`, the hook setup) share this domain.

- **Automatic (default):** GNOME's gettext with the extension's catalog, exactly as for GNOME itself; dates and times use the system region (`de_CH` → `de-CH`, `en_GB` → 19 Oct 2026), numbers the language (German: decimal comma). Other languages fall back to English.
- **Deutsch / English in Settings → Appearance → Language:** stored in the `language` key. It applies to Notchy only: the Shell reads Notchy's own `.mo` file for that language instead of changing any locale, the helper processes get `NOTCHY_LANGUAGE` in their environment, and GNOME, other apps and other extensions keep the system language (GNOME's own clock stays in the system language). The island is rebuilt in the new language at once; the Regal's and the drop zone's GTK processes restart in it (an open Regal on its next start); the preferences window rebuilds itself.
- Nothing the user saved is translated: quicklinks, snippets, command settings, the history and agent settings keep their content and ids. Default quicklinks and snippets of a new installation follow the language (Wikipedia: `de.` or `en.wikipedia.org`; „Freundliche Grüsse“/„Kind regards“) as long as the list was never edited; „Restore Defaults“ returns to them. Clipboard entries of files and pictures get their titles when shown (older German titles are recognised).
- Technical debug messages in the log stay English.

Translations: `python3 scripts/i18n.py update` extracts the strings (`_()`, `N_()`, `ngettext()`, `pgettext()` in the files of `po/POTFILES`) into the template and merges it into `po/*.po`; `check` fails on untranslated, fuzzy or obsolete entries and on mismatched placeholders; `compile` writes the `.mo` files (`pack.sh` does it into the package). The script needs no GNU gettext tools; with them installed, `msgfmt --check` runs too. A new language is a `po/LL.po` plus its code in `po/LINGUAS` (and in `LANGUAGES` of `src/i18n/core.js` and `helper/i18n.py` to be selectable).

## Develop and test

```sh
bash scripts/check.sh
bash scripts/pack.sh
bash scripts/test-shell.sh
bash scripts/test-matrix.sh   # every supported GNOME release, in containers
```

`check.sh` checks JavaScript syntax, the GSettings schema, Python syntax and the translation catalogs (complete, current, placeholders), compiles them, and runs the domain, launcher (ranking, units, quicklinks), system command configuration, translation and locale formatting, AirPods battery cache, agent session and side-layout tests (Node) and the file-operation, file-search, AAP, agent hook adapter and setup, context-menu, translation, cover, spectrum and MCP tests (Python). `test-shell.sh` starts GNOME Shell 50 headless with its own D-Bus and temporary XDG directories; log and screenshots end up in `tests/output`. Details: [docs/TESTING.md](docs/TESTING.md); current state: [docs/VALIDATION_STATE.md](docs/VALIDATION_STATE.md).

The extension runs inside the GNOME Shell process. Shelf, basket and drop zone are native GTK windows (Python helpers) because only those can send and receive Wayland file drags; they sit exactly inside the Shell surface and are shown on top of the island's glass, so the two read as one surface. Their popups (the shelf's context menu, tooltips) are Wayland popup surfaces that Mutter stacks with the windows, below the Shell's chrome; Notchy shows them as clones on top of everything while the real popup keeps the input (the island's tab bar lets clicks through while a menu is open).

Thunderstorm's providers live in `src/launcher/` (`providers.js`: one class per source; `logic.js`: pure ranking, units and quicklink code shared with the Node tests; `commands.js`: the command catalog, the user's overrides and their validation; `launcher.js`: debouncing, history, sessions). Translations and locale formatting are `src/i18n/core.js` (no GNOME imports) with `src/i18n/gnome.js` (the backend), and `helper/i18n.py` for Python. File search is `src/services/filesearch.js` with `helper/filesearch.py`; AirPods are `src/services/airpods.js` with `src/services/batteries.js`; agents are `src/services/agentModel.js` (sessions, states, hook mapping), `src/services/agents.js` (D-Bus, process checks), `src/ui/agentBubble.js`, and the placement beside the notch `src/ui/sideLayout.js` with `src/ui/sideIndicators.js`; the hook adapter is `helper/agent_hook.py`, its setup `helper/agent_setup.py`.

## Integrations

```sh
scripts/notchyctl add '/path/to/file.pdf'
scripts/notchyctl list
scripts/notchyctl activity 'My agent' 'Running tests' --progress 0.6
scripts/notchyctl clear-activity 'My agent'

# Structured agent sessions (one per session id; several per agent)
scripts/notchyctl agent start --provider aider --session build-42 --project Notchy --pid "$PPID" --heartbeat 60
scripts/notchyctl agent update --provider aider --session build-42 --state working --status 'Tests laufen' --progress 0.4
scripts/notchyctl agent update --provider aider --session build-42 --state waiting
scripts/notchyctl agent heartbeat --provider aider --session build-42
scripts/notchyctl agent update --provider aider --session build-42 --state completed
scripts/notchyctl agent stop --provider aider --session build-42
scripts/notchyctl agent list
scripts/notchyctl agent hooks status
```

```sh
# Live activities of your own, and timers (docs/ACTIVITIES.md)
scripts/notchyctl live report --id iso --name 'Ubuntu ISO' --type transfer --progress 0.68 --total 6114656256
scripts/notchyctl live report --id build --name Build --type operation --status 'Tests laufen' --action log:Log
scripts/notchyctl live watch
scripts/notchyctl live end build
scripts/notchyctl live list
scripts/notchyctl timer start 25m --name Fokus
scripts/notchyctl timer pomodoro
```

`--pid` names the agent's process (the session ends when it exits), `--heartbeat` the seconds between heartbeats (three missed ones end it). Over D-Bus the same is `org.gnome.Shell.Extensions.Notchy.AgentEvent(s json)` with `{provider, session, event: start|prompt|tool|waiting|resume|stop|idle|error|end|heartbeat|update, state, status, project, progress, pid, time}`; `GetAgents` lists the sessions and the `AgentsChanged` signal reports changes. Live activities use `ReportActivity`, `EndActivity`, `GetLiveActivities`, `InvokeActivity`, `Timer` and the signals `LiveActivitiesChanged` and `ActivityAction` ([docs/ACTIVITIES.md](docs/ACTIVITIES.md#interfaces)). Events with an older `time` than the newest one applied do not change a state. Everything goes over the user's session bus; Notchy opens no network port.

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

The MCP bridge offers `list_shelf`, `add_files`, `set_activity`, `clear_activity`, `live_activity` and `live_activity_end` (a live activity of your own, see [docs/ACTIVITIES.md](docs/ACTIVITIES.md)), and for agent sessions `agent_status` (agent, session, state, optional status, project and real progress) and `agent_end`. It opens no network port and never returns clipboard history.
