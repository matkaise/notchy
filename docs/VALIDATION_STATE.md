# Validation state, 15 October 2026

Redesign "Droppy for GNOME": Notchy lives in the top bar only, with the styles Dynamic Glass and Liquid Glass, the tabs Media · Shelf · Clipboard · Calendar (all of one height), Thunderstorm search, a radial capture menu, inline volume and scroll volume, and a basket with its own collection. Droplets and the floating player are removed.

This build passes the complete isolated GNOME Shell test with **233 assertions** plus `NOTCHY_SHELL_TEST_OK`, `NOTCHY_PREFS_TEST_OK` and `NOTCHY_TRAY_TEST_OK`; the interaction part alone (`NOTCHY_TEST_DROP_ONLY=1`) passes as well. The log has no GJS/GObject/Clutter criticals, script failures or Python tracebacks. Log and screenshots are written to `tests/output/`.

`scripts/check.sh` passes: syntax, strict schema, **15 domain tests** and **14 Python tests**.

Verified since the redesign:

- Real liquid glass (cloned backdrop, blur, refraction) instead of plain transparency, visible over a colourful test backdrop (`glass-*.png`). Below the native shelf and the drop zone the Shell paints the very same glass, so there is no seam at the pane's edge (`glass-regal-*.png`, `drop-*.png`). At 100 % black there is no glass at all (`opaque-calendar.png`).
- Flat controls with icons instead of words; the player in Droppy's layout with rounded transport symbols; a real pointer click toggles playback (`media-controls*.png`).
- The outer top corners of the Dynamic Glass notch widen with its height (10 px collapsed, up to 36 px, never deeper than its black part).
- All tabs share one height (300 px).
- Calendar in the design's layout: week strip, agenda with a now line, notifications grouped per app (`calendar-events.png`).
- Notchy's confirmations show as a live activity inside the capsule, collapsed and opened (`toast*.png`).
- Media output selection including AirPlay receivers (`media-outputs.png`, `media-airplay.png`); in the test the outputs are stubbed so the run never touches the real network. AirPlay discovery itself was verified manually on this machine: PipeWire's RAOP discovery found three receivers on the local network.
- Snap layouts: a real window dragged by its title bar to the clock opens the layouts; the hovered zone shows GNOME's own tile preview, and the window is tiled onto it on release (`snap*.png`).
- Super+Space opens the search on every press: with a single keyboard layout Notchy borrows GNOME's layout-switch keys while it runs and hands them back on disable.
- A real right click on the clock or beside it opens the radial menu. The shelf's file menu is a page inside the pane in Notchy's design; it can no longer be covered by the island, and its actions work with real clicks (`regal-menu*.png`).
- Shelf tiles can be deselected: a second click on the only selected tile, a click on empty space, or Esc.
- The outer top corners follow the bar's slide-in at login, so the capsule looks right before it was ever opened.
- AirDrop against a stand-in backend with the same commands, state file and consent hook as airdrop-mt7921's `airdropd` (`tests/mock_airdropd`, which never touches the radio): switching on arms it in exclusive mode and shows the live activity; an incoming transfer asks in the notch, „Annehmen“ answers the real hook over D-Bus and the flattened file lands in the shelf without iOS's wrapper; Escape declines; sending shows the radar, the phone's name and the result, and explains a failure; a real Wayland file drag onto the AirDrop half of the drop zone sends both files instead of shelving them (`airdrop-*.png`, `drop-media-wayland-airdrop.png`). The radio side itself (OWL, AWDL, the iPhone) is the backend's and is not covered here.

First run with a real iPhone (iOS 26) on this machine's MediaTek MT7922 (`mt7921e`, Ubuntu kernel 7.0, BlueZ 5.85) through the installed airdrop-mt7921 backend: Notchy started, armed and stopped the backend correctly, the Wi-Fi paused and reconnected, and the receiver announced itself — but over five runs, several minutes with the iPhone's share sheet open, OWL received **no frame at all** (`rx_action 0`), with runtime PM and deep sleep verified off. Monitor reception on this card is not working here, matching what both backend projects report as unreliable on MT7921/MT7922. Two backend problems found on the way are handled in Notchy: its `btmgmt` Bluetooth wake hangs on BlueZ 5.85, so Notchy registers the wake advert through bluetoothd itself; and a cancelled send can leave `opendrop find` holding the backend's lock, which Notchy now ends.

Not covered, to verify on a normal desktop: AirDrop with a real iPhone through the installed backend, real audio hardware and playback on AirPlay receivers, scroll wheels/touchpads, physical drag gestures and shaking, area selection and screen recording through GNOME's UI, text recognition with Tesseract, calendar accounts, multiple monitors and fractional scaling. See [TESTING.md](TESTING.md) and [PARITY.md](PARITY.md).
