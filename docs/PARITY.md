# Droppy ↔ Notchy: actual implementation state

Reference date: 15 October 2026 (redesign "Droppy for GNOME"). Based on [Droppy's interface](https://getdroppy.app/), [its documentation](https://getdroppy.app/docs) and [the Droplet catalogue](https://getdroppy.app/docs/droplets). The website mentions 41 extensions while the documentation lists "All 40 Droplets"; these inconsistent numbers are not used as an exact denominator for a percentage.

**Full feature and design parity is not reached.** "Implemented" means existing code, not complete equality with every detail of the original. "GNOME substitute" means a different system tool with a similar purpose. "Open" means missing work; it does not mean the feature is impossible.

## Core surfaces

| Reference feature | Notchy | Limits and missing parts |
|---|---|---|
| Island at the clock | GNOME's clock is the core of the top bar; capsule with live activities left/right; opens by hover/click/shortcut with a spring morph; pin, settings, tab bar below, keys 1–4; all tabs share one height | Primary monitor only (GNOME's bar); exact reference sizes and every state animation are missing |
| Dynamic / Liquid Glass | Two styles: black notch with an adjustable fade into glass (100 % = no glass), floating glass capsule; own glass shader with blur, refraction and colour fringes at the rim, saturation; the same glass is painted below native panes (shelf, drop zone); outer top corners widen with the notch's height | An approximation of Apple's material; flat controls by design |
| Shelf („Regal“) | Native GTK pane between the clock row and the tab bar: 5-column grid, selection, double click, drag out, Zip/Convert/Remove; a real context menu (GTK popover at the pointer, shown on top of the island) with submenus and actions for single and multiple selections; automatic drop zone „Ins Regal legen“ for Wayland and X11 sources | Physical gestures, other app toolkits and fractional scaling still to verify on a normal desktop |
| Basket („Korb“) | Floating GTK basket at the pointer by shaking during a drag; own collection, „Alles ins Regal“, drag out | Peek/hide animation and several baskets are missing |
| Clipboard („Ablage“) | Search, filters all/links/images/★, selected row with favourite/delete/to shelf/copy, keyboard ↑↓ ↵ ⇧↵ F Del, text/links/colours/files/PNG | Sequential paste, rich-text fidelity, import from other managers are missing |
| Media („Medien“) | MPRIS: cover (local/HTTP), title, artist, waveform from the output monitor, timeline, previous/play/next, open app; output selection including AirPlay receivers (PipeWire RAOP) | No motion art, no queue/lyrics view in the island; one output at a time (no multi-room) |
| Calendar („Kalender“) | Week strip with arrows and event dots, day agenda with a now line and calendar week, notifications grouped per app with expandable stacks, Do Not Disturb, clear all; events from GNOME's calendar service; the clock opens this tab | No event editing; accounts via GNOME Calendar |
| Live activities / HUD | Volume/brightness inline in the capsule, scroll volume, notification banners, agent status, file operations, Notchy's confirmations (toasts) inside the capsule, AirPods connecting (banner with batteries) and low battery | Laptop battery and prioritised parallel activities are missing |
| AirPods | Built in over AAP (or through the airpods-helper daemon when installed): model, left/right/case batteries with charging, ear state with media pause, ANC/transparency/adaptive/off by model, conversation awareness, connect/disconnect; a connection card as on an iPhone and a symbol with their controls beside the notch | Only AirPods Pro 2 checked with real hardware; no 3D model or case-opening popup (needs continuous Bluetooth scanning) |
| AirDrop | Front end for airdrop-mt7921 on MT7921/MT7922: visible on demand, consent in the notch, received files in the shelf, sending from the drop zone and the shelf with a live activity | Wi-Fi pauses during AirDrop (exclusive mode); ~40–70 kB/s; „Everyone“ only; sends to the first receiver found; experimental backend |
| Window Snap | Dragging a window to the clock opens six snap layouts in the notch; releasing over a zone places the window | No custom layouts; one monitor (the bar's) |
| Thunderstorm | A local Raycast-like launcher in the island: apps, files and folders through GNOME LocalSearch (bounded fallback without it), shelf files, safe arithmetic, unit conversion, quicklinks and web search, system and window commands, clipboard history, snippets, emoji; categories, action panel (Ctrl+K), recent results | No extension store, no automatic pasting (not reliably possible on Wayland), file names only (no full-text content search) |
| Radial menu | Area, window, screen, recording, text (OCR); results go to the shelf or the clipboard | Area/recording use GNOME's screenshot UI; no own editor |
| Lock screen | Open | No session on the lock screen |
| Droppy Cloud, iPhone sync, LocalSend | Open | Needs its own backend/protocol |
| MCP | Local stdio bridge for the shelf and agent status | Limited set of tools |
| Localisation | German UI | No other languages yet |

## Droplets

Temporarily removed (as of 14 October 2026); the tools will return under a new name. Thunderstorm and capture became fixed parts of the island as search and radial menu; Window Snap returned as snap layouts in the notch.

## Validation still required

The automated headless test does not replace real use: physical drag in/out, shaking for the basket, scrolling with real hardware, audio hardware and AirPlay receivers, area selection/recording, text recognition, converters and the lock screen must be verified in a normal GNOME session. The lock screen is explicitly not an enabled target.

Next work: Droplets under a new name, sequential clipboard paste, event editing, multi-room AirPlay, Nautilus integration and extensive desktop verification. Cloud and iPhone need an independent backend/protocol that is yet to be defined. Apple's original renderer cannot be carried over to St/Clutter.
