# Validation state, 15 October 2026

Redesign "Droppy for GNOME": Notchy lives in the top bar only, with the styles Dynamic Glass and Liquid Glass, the tabs Media · Shelf · Clipboard · Calendar (all of one height), Thunderstorm search, a radial capture menu, inline volume and scroll volume, and a basket with its own collection. Droplets and the floating player are removed.

This build passes the complete isolated GNOME Shell test with **195 assertions** plus `NOTCHY_SHELL_TEST_OK`, `NOTCHY_PREFS_TEST_OK` and `NOTCHY_TRAY_TEST_OK`; the interaction part alone (`NOTCHY_TEST_DROP_ONLY=1`) passes as well. The log has no GJS/GObject/Clutter criticals, script failures or Python tracebacks. Log and screenshots are written to `tests/output/`.

`scripts/check.sh` passes: syntax, strict schema, **14 domain tests** and **14 Python tests**.

Verified since the redesign:

- Real liquid glass (cloned backdrop, blur, refraction) instead of plain transparency, visible over a colourful test backdrop (`glass-*.png`). Below the native shelf and the drop zone the Shell paints the very same glass, so there is no seam at the pane's edge (`glass-regal-*.png`, `drop-*.png`). At 100 % black there is no glass at all (`opaque-calendar.png`).
- Flat controls with icons instead of words; the player in Droppy's layout with rounded transport symbols; a real pointer click toggles playback (`media-controls*.png`).
- The outer top corners of the Dynamic Glass notch widen with its height (10 px collapsed, up to 36 px, never deeper than its black part).
- All tabs share one height (300 px).
- Calendar in the design's layout: week strip, agenda with a now line, notifications grouped per app (`calendar-events.png`).
- Notchy's confirmations show as a live activity inside the capsule, collapsed and opened (`toast*.png`).
- Media output selection including AirPlay receivers (`media-outputs.png`, `media-airplay.png`); in the test the outputs are stubbed so the run never touches the real network. AirPlay discovery itself was verified manually on this machine: PipeWire's RAOP discovery found three receivers on the local network.
- Snap layouts: a real window dragged by its title bar to the clock opens the layouts and is tiled onto the hovered zone (`snap*.png`).

Not covered, to verify on a normal desktop: real audio hardware and playback on AirPlay receivers, scroll wheels/touchpads, physical drag gestures and shaking, area selection and screen recording through GNOME's UI, text recognition with Tesseract, calendar accounts, multiple monitors and fractional scaling. See [TESTING.md](TESTING.md) and [PARITY.md](PARITY.md).
