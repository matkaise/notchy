import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};
function assert(condition, message) { if (!condition) throw Error(message); print(`PASS: ${message}`); }
function styled(actor, cls) { return [actor, ...actor.get_children().flatMap(child => styled(child, cls))].filter(a => a.has_style_class_name?.(cls)); }
function buttons(actor, name) { return [actor, ...actor.get_children().flatMap(child => buttons(child, name))].filter(a => a instanceof St.Button && a.accessible_name === name); }
const here = name => Gio.File.new_for_uri(import.meta.url).get_parent().get_child(name).get_path();
const clipboardText = () => new Promise(resolve => St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => resolve(text)));

export async function run() {
    await Scripting.sleep(1500);
    // This integration test uses its own GTK clients. GNOME's unused performance
    // helper can time out during the longer suite; it needs no explicit Exit.
    const perfHelper = await Scripting._getPerfHelper(); perfHelper._autoExit = false;
    Main.overview.hide(); await Scripting.sleep(500);
    const record = Main.extensionManager.lookup('notchy@matthias.local');
    assert(record && record.stateObj, 'extension loaded');
    const ext = record.stateObj;
    // Never touch the real network's AirPlay receivers from a test.
    ext.settings.set_boolean('airplay-enabled', false);
    // Nor a real AirDrop backend: only the stand-in is ever configured.
    assert(!ext.airdrop.available && ext.airdrop.daemon === '', 'the test never finds a real AirDrop installation');
    const {Lifetime} = await import(`${ext.dir.get_uri()}/src/lifecycle.js`);
    const HandledEvent = GObject.registerClass({Signals: {'handled-event': {return_type: GObject.TYPE_BOOLEAN}}}, class NotchyHandledEventTest extends GObject.Object {});
    const eventFixture = new HandledEvent(), eventLife = new Lifetime(); eventLife.connect(eventFixture, 'handled-event', () => true);
    assert(eventFixture.emit('handled-event'), 'lifecycle preserves handled event return values'); eventLife.dispose();
    assert(!eventFixture.emit('handled-event'), 'disposed lifecycle no longer handles events');
    assert(ext.islands.length === 1, 'one island created');
    const island = ext.islands[0];
    assert(Main.panel.statusArea.notchy === island.panelButton && !island.actor.visible, 'Notchy lives in the top bar; the closed island has no floating surface');
    assert(island.panelSurface.get_children()[1] === island.clockContainer && island.clockContainer === Main.panel.statusArea.dateMenu.container, 'GNOME\'s live clock is the centre of the capsule');
    assert(Main.panel.statusArea.dateMenu._clockDisplay.text.length > 0, 'integrated clock retains live GNOME date/time formatting');
    const path = GLib.getenv('NOTCHY_TEST_OUTPUT') || '/tmp/notchy-test'; GLib.mkdir_with_parents(path, 0o700);
    async function screenshot(name) { const shooter = new Shell.Screenshot(); const stream = Gio.File.new_for_path(`${path}/${name}.png`).replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null); await shooter.screenshot(false, stream); stream.close(null); }
    await screenshot('collapsed');
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const key = async keyval => { keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED); keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED); await Scripting.sleep(120); };
    if (GLib.getenv('NOTCHY_TEST_CORNERS_ONLY')) {
        for (const name of ['corner-one.txt', 'corner-two.txt']) {
            const file = Gio.File.new_for_path(`${path}/${name}`); file.replace_contents('corner fixture', null, false, Gio.FileCreateFlags.PRIVATE, null); ext.shelf.add(file.get_uri());
        }
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.setenv('NOTCHY_EXTENSION_PATH', ext.path, true); launcher.setenv('GDK_BACKEND', 'wayland', true);
        const proc = launcher.spawnv(['/usr/bin/python3', here('tray.py')]);
        await new Promise((resolve, reject) => proc.wait_check_async(null, (p, result) => { try { p.wait_check_finish(result); resolve(); } catch (error) { reject(error); } }));
        ext.disable(); print('NOTCHY_CORNERS_TEST_OK'); return;
    }
    if (GLib.getenv('NOTCHY_TEST_REGAL_ONLY')) {
        await regalMenuRegressions(ext, path, screenshot); ext.disable();
        print('NOTCHY_REGAL_TEST_OK'); return;
    }
    if (GLib.getenv('NOTCHY_TEST_LAUNCHER_ONLY')) {
        await launcherRegressions(ext, path, screenshot); ext.disable();
        print('NOTCHY_LAUNCHER_TEST_OK'); return;
    }
    if (GLib.getenv('NOTCHY_TEST_AIRPODS_ONLY')) {
        await airpodsRegressions(ext, path, screenshot); ext.disable();
        print('NOTCHY_AIRPODS_TEST_OK'); return;
    }
    if (GLib.getenv('NOTCHY_TEST_DROP_ONLY')) {
        ext.settings.set_boolean('clipboard-enabled', true);
        await interactionRegressions(ext, path, screenshot); ext.disable();
        print('NOTCHY_DROP_TEST_OK'); return;
    }

    // Medien: MPRIS fixture, artwork, capsule live activity and the media tab.
    ext.settings.set_boolean('media-waveform', false);
    const mock = Gio.Subprocess.new(['/usr/bin/python3', here('mock_mpris.py')], Gio.SubprocessFlags.NONE);
    await Scripting.sleep(500);
    assert(ext.media.state?.title === 'Paper Moons', 'MPRIS metadata discovered');
    for (let i = 0; i < 30 && !ext.cover.file; i++) await Scripting.sleep(100);
    assert(ext.cover.file?.query_exists(null) && ext.cover.file.get_path().includes('/notchy/covers/'), 'HTTP artwork fetched and decoded outside Shell');
    assert(ext.media.state.canRaise, 'MPRIS root app capabilities discovered');
    await ext.media.raise(); assert(Gio.File.new_for_path(`${path}/notchy-test-raised`).query_exists(null), 'MPRIS Raise opens playing app');
    await Scripting.sleep(100);
    assert(styled(island.leftRow, 'notchy-mini-art').length === 1 && island.panelSurface.has_style_class_name('notchy-wide'), 'playing media frames the clock with its cover');
    island.open('media'); await Scripting.sleep(500); await screenshot('media-playing');
    assert(styled(island.body, 'notchy-album').length === 1 && buttons(island.body, 'Pause').length === 1, 'media tab shows cover and transport');
    const beforePause = ext.media.elapsed;
    await ext.media.call('PlayPause'); await Scripting.sleep(100);
    assert(!ext.media.state.playing, 'MPRIS pause works');
    assert(ext.media.elapsed >= beforePause - 100000, 'MPRIS pause preserves elapsed position');
    ext.media.seek(0.5); await Scripting.sleep(100);
    assert(Math.abs(ext.media.elapsed - 98000000) < 500000, 'MPRIS seek works');
    await ext.media.call('PlayPause'); await Scripting.sleep(100); island.close();
    await ext.media.goTo(ext.media.queue[1].trackId); await Scripting.sleep(150);
    assert(ext.media.state.title === 'Night Transit' && ext.cover.file?.get_path() === `${path}/notchy-test-cover.png`, 'track change switches to local cover');
    await ext.media.goTo(ext.media.queue[2].trackId); await Scripting.sleep(150);
    for (let i = 0; i < 30 && ext.cover.proc; i++) await Scripting.sleep(100);
    assert(!ext.cover.file && ext.media.state.title === 'Slow Orbit', 'invalid remote cover falls back without stale artwork');
    await ext.media.goTo(ext.media.queue[0].trackId); await Scripting.sleep(150);
    // The private test uses a synthesized tone, never the user's audio monitor.
    ext.spectrum.sync = () => {}; ext.settings.set_boolean('media-waveform', true); ext.spectrum.stop(); ext.spectrum.start('', true);
    for (let i = 0; i < 25 && !ext.spectrum.haveFrame && !ext.spectrum.error; i++) await Scripting.sleep(100);
    assert(ext.spectrum.haveFrame && Math.max(...ext.spectrum.levels) > .8, `live GStreamer spectrum reaches Shell (${ext.spectrum.error || 'measured'})`);
    island.open('media'); await Scripting.sleep(450); await screenshot('media-waveform'); island.close(); await Scripting.sleep(400); await screenshot('compact-waveform');
    assert(styled(island.rightRow, 'notchy-waveform').length === 1, 'the waveform plays beside the clock');
    const captureLife = ext.spectrum.capture, captureProc = ext.spectrum.proc; ext.spectrum.stop();
    await new Promise(resolve => captureProc.wait_async(null, (p, result) => { p.wait_finish(result); resolve(); }));
    assert(captureLife.closed && !ext.spectrum.proc && captureProc.get_identifier() === null, 'spectrum capture stops cleanly');

    // Four tabs morph one surface: header with the clock, page, tab bar.
    const heights = {media: 300, shelf: 300, clipboard: 300, calendar: 300};
    for (const [index, page] of ['media', 'shelf', 'clipboard', 'calendar'].entries()) {
        island.open(page); await Scripting.sleep(700);
        const expected = island.headerHeight + 8 + heights[page] + 50;
        assert(Math.abs(island.surface.width - island.expandedWidth) < 1 && Math.abs(island.surface.height - expected) < 1, `${page} tab opens at its designed size (${island.surface.width}x${island.surface.height}, expected ${island.expandedWidth}x${expected})`);
        const pad = island.glass.pad;
        assert(island.glass.actor.visible && island.glass.actor.width === Math.round(island.surface.width + 2 * pad) && island.glass.stage[0] === Math.round(island.actor.x - pad) && island.glass.stage[1] === Math.round(island.actor.y - pad) && island.glass.clones.length > 0, `${page}: the glass layer renders exactly what lies behind the island`);
        assert(island.tabIndicator.x === island.navButtons[index][1].x && island.navButtons[index][1].has_style_class_name('active') && island.panelHeader.contains(island.clockContainer), `${page}: indicator and active tab follow, the clock heads the surface`);
        await screenshot(`tab-${page}`);
    }
    assert(new Set(Object.values(heights)).size === 1, 'every tab has the same height, so the island never jumps between tabs');
    // 100 % black: no glass at all, the whole opened surface is black.
    const level = ext.settings.get_int('glass-level'); ext.settings.set_int('glass-level', 100); island.syncShade();
    assert(!island.glass.actor.visible && island.shadeBlack.visible && Math.abs(island.shadeBlack.height - island.surface.height) < 1 && !island.shadeFade.visible && island.shelfShade.black >= 100000,
        '100 % black hides the glass and shades the entire surface');
    await screenshot('opaque-calendar'); ext.settings.set_int('glass-level', level); island.syncShade();
    island.close(); await Scripting.sleep(400);
    island.toggle('media'); await Scripting.sleep(500);
    await key(Clutter.KEY_3); await Scripting.sleep(400);
    assert(island.page === 'clipboard', 'keys 1–4 switch tabs after an explicit toggle'); await key(Clutter.KEY_Escape);
    assert(!island.expanded, 'Escape closes the island');

    // Super+Space reliably opens the search: with a single keyboard layout Notchy borrows GNOME's layout-switch keys.
    const chord = async (...keys) => {
        for (const k of keys) { keyboard.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.PRESSED); await Scripting.sleep(30); }
        for (const k of [...keys].reverse()) { keyboard.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.RELEASED); await Scripting.sleep(30); }
        await Scripting.sleep(500);
    };
    assert(ext.borrowedKeys.has('switch-input-source') && ext.borrowedKeys.has('switch-input-source-backward') && Main.wm._allowedKeybindings['switch-input-source'] === Shell.ActionMode.NONE, 'with one keyboard layout GNOME\'s Super+Space layout switch yields to Notchy');
    let opened = 0;
    for (let i = 0; i < 4; i++) { await chord(Clutter.KEY_Super_L, Clutter.KEY_space); if (island.expanded && island.page === 'search') opened++; island.close(true); await Scripting.sleep(250); }
    assert(opened === 4, `Super+Space opens the search every time (${opened}/4)`);
    await Scripting.sleep(400); island.toggle('search'); await Scripting.sleep(500);
    // Thunderstorm: the island becomes a search field.
    assert(island.page === 'search' && !island.headerRow.visible && !island.nav.visible && Math.abs(island.surface.width - 620) < 1 && island.views.focusEntry.clutter_text.has_key_focus(), 'search replaces the clock with a focused search field');
    island.views.focusEntry.set_text('2+3*4'); await Scripting.sleep(400);
    assert(styled(island.body, 'notchy-result-title')[0]?.text === '= 14', 'search computes arithmetic first'); await screenshot('search');
    assert(Math.abs(styled(island.body, 'notchy-result')[0].width - (620 - 20)) <= 2, 'results span the search field');
    await key(Clutter.KEY_Return); await Scripting.sleep(300);
    assert(!island.expanded && await clipboardText() === '14', 'Enter copies the result and closes the search');
    island.toggle('search'); await Scripting.sleep(400);
    island.views.focusEntry.set_text('einstellungen'); await Scripting.sleep(400);
    island.views.focusEntry.set_text('xyz-no-match'); await Scripting.sleep(400);
    assert(styled(island.body, 'notchy-result').length === 1 && island.views.searchState.results[0]?.kind === 'Web', 'search without matches offers only the web search'); await key(Clutter.KEY_Escape);

    // Radial capture menu; a full-screen shot lands in the Regal.
    await Scripting.sleep(400); ext.radial.open(); await Scripting.sleep(600);
    assert(ext.radial.actor?.visible && ext.radial.buttons.length === 5, 'radial menu offers five capture actions'); await screenshot('radial');
    const [middleX] = ext.radial.buttons[2].get_transformed_position(), [barX] = island.panelButton.get_transformed_position();
    assert(Math.abs(middleX + 32 - (barX + island.panelButton.width / 2)) <= 2, 'the radial fan is centred below the clock');
    await key(Clutter.KEY_Escape); assert(!ext.radial.actor, 'Escape closes the radial menu');
    const shelfBefore = ext.shelf.items.length;
    ext.radial.open(); await Scripting.sleep(400); await key(Clutter.KEY_3);
    for (let i = 0; i < 40 && ext.shelf.items.length === shelfBefore; i++) await Scripting.sleep(100);
    const shot = ext.shelf.items.at(-1);
    assert(ext.shelf.items.length === shelfBefore + 1 && shot.name.endsWith('.png') && Gio.File.new_for_uri(shot.uri).query_exists(null), 'screen capture is saved and placed in the Regal');
    await Scripting.sleep(250); assert(island.toastState?.text === 'Bildschirmfoto im Regal' && styled(island.rightRow, 'notchy-toast-text')[0]?.text === 'Bildschirmfoto im Regal' && styled(island.leftRow, 'notchy-toast-icon').length === 1, 'a toast confirms the capture inside the capsule'); await screenshot('toast');
    await Scripting.sleep(2000); assert(!island.toastState && !styled(island.panelSurface, 'notchy-toast-text').length, 'the toast leaves the capsule again');
    island.open('clipboard'); await Scripting.sleep(600); island.toast('edit-copy-symbolic', 'In Zwischenablage kopiert'); await Scripting.sleep(250);
    assert(island.panelHeader.contains(island.panelSurface) && styled(island.rightRow, 'notchy-toast-text')[0]?.text === 'In Zwischenablage kopiert', 'with the island open, the toast shows in its header beside the clock');
    await screenshot('toast-open'); island.close(); await Scripting.sleep(2000);
    ext.shelf.remove(shot.uri);

    // Volume and brightness live inline in the capsule.
    await Scripting.sleep(2000);
    Main.osdWindowManager.showOne(island.monitor.index, new Gio.ThemedIcon({name: 'audio-volume-high-symbolic'}), 'Lautsprecher', 0.42, 1); await Scripting.sleep(200);
    assert(island.hudState?.level === 0.42 && island.panelSurface.has_style_class_name('notchy-hud') && !Main.osdWindowManager._osdWindows[island.monitor.index].visible, 'volume appears in the capsule instead of GNOME\'s OSD');
    assert(styled(island.rightRow, 'notchy-hud-value')[0]?.text === '42', 'the capsule shows the level'); await screenshot('hud-volume');
    await Scripting.sleep(1500); assert(!island.hudState && !island.panelSurface.has_style_class_name('notchy-hud'), 'volume activity folds back by itself');
    await key(Clutter.KEY_Num_Lock); await key(Clutter.KEY_Num_Lock); await Scripting.sleep(150);
    assert(!island.hudState && !island.toastState?.text?.startsWith('Feststelltaste'), 'Num Lock and other key states raise no Caps Lock activity');
    await key(Clutter.KEY_Caps_Lock); await Scripting.sleep(150);
    assert(island.hudState?.text === 'Feststelltaste an' && styled(island.rightRow, 'notchy-hud-text')[0]?.text === 'Feststelltaste an', 'Caps Lock appears inside the capsule');
    await screenshot('hud-capslock'); await key(Clutter.KEY_Caps_Lock); await Scripting.sleep(150);
    assert(island.hudState?.text === 'Feststelltaste aus', 'turning Caps Lock off updates the capsule'); await Scripting.sleep(1800); island.clearHud();
    // Scrolling over the capsule, with a controlled mixer instead of real hardware.
    const sink = {volume: 500, is_muted: false, push_volume() {}, change_is_muted(muted) { this.is_muted = muted; }};
    const realSystem = island.system;
    island.system = Object.assign(Object.create(realSystem), {mixer: {get_default_sink: () => sink, get_vol_max_norm: () => 1000}});
    const pointer = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    try {
        const [sx, sy] = island.leftSlot.get_transformed_position();
        ext.settings.set_boolean('hover-open', false);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), sx + island.leftSlot.width / 2, sy + 10); await Scripting.sleep(150);
        pointer.notify_discrete_scroll(GLib.get_monotonic_time(), Clutter.ScrollDirection.UP, Clutter.ScrollSource.WHEEL); await Scripting.sleep(200);
        assert(sink.volume === 540 && island.hudState?.level === 0.54 && !island.expanded, 'scrolling over the closed island raises the volume and shows it inline');
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 20, 600); await Scripting.sleep(150);
    } finally { pointer.run_dispose(); island.system = realSystem; ext.settings.set_boolean('hover-open', true); island.clearHud(); }

    // Notifications grow into a banner below the clock.
    const systemSource = MessageTray.getSystemSource();
    const note = new MessageTray.Notification({source: systemSource, title: 'Build fertig', body: 'Alle Tests bestanden. Das Paket liegt unter dist/.'});
    note.addAction('Anzeigen', () => {}); systemSource.addNotification(note); await Scripting.sleep(500);
    assert(island.peeking && island.peekKind === 'notification' && note.acknowledged && Main.messageTray._notification !== note, 'notification appears as a Notchy banner and GNOME skips its own');
    await screenshot('notification-banner');
    island.open('calendar'); await Scripting.sleep(500);
    assert(styled(island.body, 'notchy-cal-note-title').some(a => a.text === 'Build fertig') && styled(island.body, 'notchy-cal-note-app').length >= 1, 'the Kalender tab lists GNOME\'s notifications grouped per app');
    island.close(); note.destroy(); await Scripting.sleep(400);
    assert(!island.peeking && !island.expanded, 'dismissed notification leaves no banner');

    const prefsLauncher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    prefsLauncher.setenv('NOTCHY_EXTENSION_PATH', ext.path, true); prefsLauncher.setenv('GI_TYPELIB_PATH', '/usr/lib/gnome-shell:/usr/lib/gnome-shell/girepository-1.0', true); prefsLauncher.setenv('LD_LIBRARY_PATH', '/usr/lib/gnome-shell', true); prefsLauncher.setenv('GDK_BACKEND', 'wayland', true);
    prefsLauncher.spawnv(['/usr/bin/gjs', '-m', here('prefs.js')]);
    await Scripting.sleep(1800);

    // Kalender: GNOME's calendar server fixture with live updates.
    const calendarFixture = Gio.Subprocess.new(['/usr/bin/python3', here('mock_calendar.py')], Gio.SubprocessFlags.NONE);
    await Scripting.sleep(200);
    const {Calendar} = await import(`${ext.dir.get_uri()}/src/services/calendar.js`);
    ext.calendar.dispose(); ext.calendar = new Calendar('org.gnome.Shell.CalendarServer.NotchyTest');
    ext.services.calendar = ext.calendar; island.calendar = island.views.calendar = ext.calendar;
    island.open('calendar'); await Scripting.sleep(500);
    const today = new Date(); assert(ext.calendar.hasCalendars && ext.calendar.day(today)[0]?.title === 'Design review', 'calendar loads native D-Bus events');
    const calDays = () => styled(island.body, 'notchy-cal-day');
    assert(calDays().length === 7 && calDays().filter(a => a.has_style_class_name('today')).length === 1 && calDays().find(a => a.has_style_class_name('today')).has_style_class_name('selected'), 'the week strip shows seven days with today selected');
    assert(styled(island.body, 'notchy-cal-event-title').some(a => a.text === 'Design review') && styled(calDays().find(a => a.has_style_class_name('today')), 'notchy-cal-dot').some(a => a.has_style_class_name('busy')), 'the agenda lists today\'s event and the day carries a dot');
    assert(styled(island.body, 'notchy-cal-meta').some(a => /^KW \d+$/.test(a.text)) && styled(island.body, 'notchy-cal-title')[0].text.startsWith('Heute, '), 'the agenda is titled with the day and its calendar week');
    await screenshot('calendar-events');
    const other = calDays().find(a => !a.has_style_class_name('today')); other.emit('clicked', 1); await Scripting.sleep(150);
    assert(calDays().find(a => a.has_style_class_name('selected')) && !calDays().find(a => a.has_style_class_name('selected')).has_style_class_name('today') && !styled(island.body, 'notchy-cal-title')[0].text.startsWith('Heute'), 'another day can be selected');
    const firstDay = styled(calDays()[0], 'notchy-cal-daynum')[0].text;
    buttons(island.body, 'Nächste Woche')[0].emit('clicked', 1); await Scripting.sleep(150);
    assert(styled(calDays()[0], 'notchy-cal-daynum')[0].text !== firstDay && !calDays().some(a => a.has_style_class_name('today')), 'the arrows move to the next week');
    buttons(island.body, 'Vorherige Woche')[0].emit('clicked', 1); island.views.calDay = new Date(new Date().setHours(0, 0, 0, 0)).getTime(); await Scripting.sleep(100);
    const fixtureCall = method => new Promise((resolve, reject) => Gio.DBus.session.call('org.gnome.Shell.CalendarServer.NotchyTest', '/org/gnome/Shell/CalendarServer', 'org.notchy.CalendarFixture', method, null, null, Gio.DBusCallFlags.NONE, 2000, null, (connection, result) => { try { connection.call_finish(result); resolve(); } catch (e) { reject(e); } }));
    await fixtureCall('Update'); await Scripting.sleep(100);
    assert(ext.calendar.day(today)[0]?.title === 'Updated review', 'calendar handles live event updates');
    await fixtureCall('Remove'); await Scripting.sleep(100); assert(ext.calendar.day(today).length === 0, 'calendar handles removed events');
    island.close(); calendarFixture.force_exit(); await Scripting.sleep(100);
    assert(!ext.calendar.loading && ext.calendar.events.size === 0, 'calendar service loss handled');

    // Ablage: capture, keyboard navigation, favourites, filters and copying.
    ext.settings.set_boolean('clipboard-enabled', true); ext.settings.set_boolean('clipboard-persist', true);
    for (const text of ['Erste Kopie aus dem Test', 'https://extensions.gnome.org/notchy', 'Notchy integration sample']) { St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text); await Scripting.sleep(350); }
    assert(ext.clipboard.history.search('integration sample').length === 1, 'clipboard records text');
    island.toggle('clipboard'); await Scripting.sleep(500);
    assert(island.views.focusEntry.clutter_text.has_key_focus() && styled(island.body, 'notchy-clip-row').filter(a => a.has_style_class_name('selected')).length === 1, 'clipboard focuses its search and selects the newest entry');
    await key(Clutter.KEY_Down); await screenshot('clipboard');
    const selectedText = () => styled(styled(island.body, 'notchy-clip-row').find(a => a.has_style_class_name('selected')), 'notchy-clip-text')[0]?.text;
    assert(selectedText() === 'https://extensions.gnome.org/notchy', 'arrow keys move the selection');
    island.actor.grab_key_focus(); await key(Clutter.KEY_f); await Scripting.sleep(100);
    assert(ext.clipboard.history.search('extensions.gnome.org')[0].favorite, 'F marks the selected entry as favourite');
    buttons(island.body, 'Nur Favoriten')[0].emit('clicked', 1); await Scripting.sleep(100);
    assert(styled(island.body, 'notchy-clip-row').length === 1, 'the ★ filter shows only favourites');
    buttons(island.body, 'Links')[0].emit('clicked', 1); await Scripting.sleep(100);
    assert(styled(island.body, 'notchy-clip-row').length === 1 && selectedText().startsWith('https://'), 'the Links filter shows links');
    buttons(island.body, 'Alle')[0].emit('clicked', 1); await Scripting.sleep(100);
    island.views.focusEntry.grab_key_focus(); await key(Clutter.KEY_Return); await Scripting.sleep(300);
    assert(!island.expanded && await clipboardText() === 'Notchy integration sample', 'Enter copies the selected entry and closes');
    const clipFile = Gio.File.new_for_path(`${path}/clipboard-file.txt`); clipFile.replace_contents('clipboard fixture', null, false, Gio.FileCreateFlags.PRIVATE, null);
    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'text/uri-list', new TextEncoder().encode(clipFile.get_uri() + '\r\n')); await Scripting.sleep(250);
    assert(ext.clipboard.history.items[0]?.kind === 'files' && ext.clipboard.history.items[0].title === '1 Datei', 'file clipboard captured with a singular title');
    const [imgOk, png] = Gio.File.new_for_path(`${path}/collapsed.png`).load_contents(null);
    if (!imgOk) throw Error('No PNG fixture');
    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', png); await Scripting.sleep(400);
    assert(ext.clipboard.history.items[0]?.kind === 'image', 'image clipboard captured');
    island.open('clipboard'); await Scripting.sleep(450); await screenshot('clipboard-rich'); island.close();

    // Regal model, the native shelf helper, and the floating Korb.
    const testFile = Gio.File.new_for_path(`${path}/test file ü.txt`); testFile.replace_contents('test', null, false, Gio.FileCreateFlags.PRIVATE, null);
    assert(ext.shelf.add(testFile.get_uri()) === 1, 'file added via shelf model');
    assert(ext.shelf.add(clipFile.get_uri()) === 1, 'second shelf fixture added');
    const trayTest = prefsLauncher.spawnv(['/usr/bin/python3', here('tray.py')]);
    await new Promise((resolve, reject) => trayTest.wait_check_async(null, (p, result) => { try { p.wait_check_finish(result); resolve(); } catch (error) { reject(error); } }));
    ext.companion.open('basket', island.monitor); await Scripting.sleep(1800);
    const basket = global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === 'Notchy File Tray');
    assert(basket && basket.get_client_type() === 0, 'the Korb opens as a native Wayland window');
    const rect = basket.get_frame_rect();
    assert(Math.abs(rect.y - ext.companion.trayPosition.y) <= 2 && Math.abs(rect.x - ext.companion.trayPosition.x) <= 2, 'the Korb appears at the pointer');
    await screenshot('basket'); basket.delete(global.get_current_time()); await Scripting.sleep(400);

    await interactionRegressions(ext, path, screenshot);
    await regalMenuRegressions(ext, path, screenshot);
    await launcherRegressions(ext, path, screenshot);
    mock.force_exit(); await Scripting.sleep(300); assert(ext.media.state === null && !island.panelSurface.has_style_class_name('notchy-wide'), 'MPRIS player removal empties the capsule');
    keyboard.run_dispose();
    // Last, as it ends with repeated disable/enable cycles.
    await airpodsRegressions(ext, path, screenshot);
    const life = ext.life; ext.disable(); assert(life.closed && life.sources.size === 0, 'disable removes timers and signals');
    assert(!global.stage.get_actor_by_name?.('notchy-island') && Main.panel.statusArea.dateMenu.container.get_parent() === Main.panel._centerBox, 'disable restores GNOME\'s clock to the bar');
    assert(Main.wm._allowedKeybindings['switch-input-source'] === Shell.ActionMode.ALL && Main.wm._allowedKeybindings['switch-input-source-backward'] === Shell.ActionMode.ALL, 'disable hands the layout-switch keys back to GNOME');
    ext.enable(); await Scripting.sleep(400); assert(ext.islands.length === 1, 'extension re-enables');
    assert(ext.clipboard.history.search('extensions.gnome.org')[0]?.favorite, 'clipboard favourites persist across disable and enable');
    ext.disable(); await Scripting.sleep(200);
    print('NOTCHY_SHELL_TEST_OK');
}

// The native pane is shown as a clone on top of the island's whole glass, exactly over its window,
// and nothing of Notchy sits among the windows (where Mutter clips painting to the damaged area).
function paneShownOnGlass(island, windowActor) {
    const clone = island.paneClone, children = island.actor.get_children();
    const [cx, cy] = clone?.get_transformed_position() ?? [NaN, NaN];
    return Boolean(clone && windowActor && clone.source === windowActor && clone.mapped && island.glass.actor.visible !== false &&
        children.indexOf(clone) > children.indexOf(island.glass.actor) && Math.abs(cx - windowActor.x) <= 1 && Math.abs(cy - windowActor.y) <= 1 &&
        !global.window_group.get_children().some(child => !child.meta_window && child.name?.startsWith?.('notchy')));
}
async function interactionRegressions(ext, path, screenshot) {
    const island = ext.islands[0];
    const pointer = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const move = async (x, y) => { pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y); await Scripting.sleep(90); };
    let pointerPressed = false;
    const press = async state => { const pressed = state === Clutter.ButtonState.PRESSED; if (pressed === pointerPressed) return; pointerPressed = pressed; pointer.notify_button(GLib.get_monotonic_time(), 1, state); await Scripting.sleep(90); };
    const escape = async () => { keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED); keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED); await Scripting.sleep(350); };
    ext.settings.set_int('collapse-delay', 150);
    try {
        // A real right click opens the radial menu, on the clock and beside it.
        const rightClick = async (x, y) => { await move(x, y); pointer.notify_button(GLib.get_monotonic_time(), 3, Clutter.ButtonState.PRESSED); await Scripting.sleep(80); pointer.notify_button(GLib.get_monotonic_time(), 3, Clutter.ButtonState.RELEASED); await Scripting.sleep(500); };
        ext.settings.set_boolean('hover-open', false);
        for (const [where, target] of [['clock', island.clockContainer], ['slot', island.leftSlot]]) {
            const [tx, ty] = target.get_transformed_position();
            await rightClick(tx + target.width / 2, ty + target.height / 2);
            assert(ext.radial.actor && !island.dateMenu.menu.isOpen, `a real right click on the ${where} opens the radial menu`);
            ext.radial.close(); island.dateMenu.menu.close(); island.close(true); await Scripting.sleep(300);
        }
        ext.settings.set_boolean('hover-open', true);
        // After login GNOME slides the bar in from above: the outward curves follow it.
        const panelBox = Main.layoutManager.panelBox;
        panelBox.translation_y = -panelBox.height; await Scripting.sleep(100);
        panelBox.ease({translation_y: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD}); await Scripting.sleep(450);
        const [, capsuleY] = island.panelSurface.get_transformed_position();
        assert(island.ears.left.visible && island.ears.left.y === Math.round(capsuleY) && island.ears.right.y === Math.round(capsuleY), `the outward corners follow the bar's slide-in at login (${island.ears.left.y} vs ${Math.round(capsuleY)})`);
        // Autofocus in the Ablage must never pin the island.
        island.open('clipboard'); await Scripting.sleep(350);
        assert(!island.pinned && island.views.focusEntry.clutter_text.has_key_focus(), 'clipboard autofocus does not pin the island');
        await move(island.actor.x + 40, island.actor.y + 10); await move(20, 600); await Scripting.sleep(700);
        assert(!island.expanded && !global.stage.get_key_focus(), 'the island collapses on pointer leave and releases hidden entry focus');
        island.open('clipboard'); await Scripting.sleep(350);
        await move(20, 600); await press(Clutter.ButtonState.PRESSED); await press(Clutter.ButtonState.RELEASED);
        assert(!island.expanded, 'outside click dismisses the island');
        island.open('clipboard'); island.togglePin(); island.scheduleCollapse(); await Scripting.sleep(300);
        assert(island.expanded && island.pinButton.has_style_class_name('active'), 'the pin keeps the island open'); island.close(); await Scripting.sleep(400);

        // Both styles in the bar: Dynamic Glass hangs from the edge, Liquid Glass floats.
        for (const style of ['dynamic', 'liquid']) {
            ext.settings.set_string('style', style); await Scripting.sleep(250);
            const [surfaceX, surfaceY] = island.panelSurface.get_transformed_position(), [, panelY] = Main.panel.get_transformed_position();
            const inset = style === 'liquid' ? 3 : 0;
            assert(island.panelSurface.has_style_class_name(`notchy-${style}`) && Math.abs(surfaceY - panelY - inset) < 1 && Math.abs(island.panelSurface.height - Main.panel.height + 2 * inset) < 1, `${style}: capsule geometry in the bar`);
            const earsShown = island.ears.left.visible && island.ears.right.visible;
            assert(style === 'dynamic' ? earsShown && island.ears.left.width === 10 && island.ears.left.x === Math.round(surfaceX) - island.ears.left.width && island.ears.right.x === Math.round(surfaceX + island.panelSurface.width) : !earsShown, `${style}: outward top corners only for Dynamic Glass`);
            if (style === 'dynamic') assert(island.panelSurface.get_theme_node().get_border_width(St.Side.BOTTOM) === 0, 'Dynamic Glass capsule has no outline');
            Main.panel.set_style('background-color: transparent;'); await Scripting.sleep(100);
            await screenshot(`compact-${style}`); Main.panel.set_style(null);
            island.open('media'); await Scripting.sleep(700);
            assert(island.panelHeader.contains(island.clockContainer) && Math.abs(island.actor.y - island.monitor.y - inset) < 1 && (style !== 'dynamic' || island.shadeBlack.visible), `${style}: the surface grows around the clock`);
            if (style === 'dynamic') {
                const compactEar = 10, [openX] = island.surface.get_transformed_position();
                assert(island.ears.left.width > compactEar && island.ears.left.width <= 36 && island.ears.left.width <= island.blackFor(island.surface.height) && island.ears.left.x === Math.round(openX) - island.ears.left.width && island.ears.right.x === Math.round(openX + island.surface.width),
                    `the outward corners grow with the opened notch (${island.ears.left.width}px)`);
                Main.panel.set_style('background-color: transparent;'); await Scripting.sleep(100);
            }
            await screenshot(`open-${style}`); Main.panel.set_style(null); island.close(true); await Scripting.sleep(200);
        }
        // A colourful backdrop (like Droppy's reference) makes blur and refraction visible.
        const backdrop = new St.Widget({style: 'background-gradient-direction: horizontal; background-color: #1f3fd6; background-gradient-end: #e95420;', x: 0, y: 0, width: 1280, height: 720});
        for (let i = 0; i < 12; i++) backdrop.add_child(new St.Widget({style: `background-color: ${i % 2 ? '#ffffff' : '#111111'}; border-radius: 40px;`, x: 120 + i * 90, y: 60 + (i % 3) * 70, width: 46, height: 240}));
        global.window_group.add_child(backdrop);
        try {
            for (const style of ['dynamic', 'liquid']) {
                ext.settings.set_string('style', style); island.open('media'); await Scripting.sleep(800);
                await screenshot(`glass-${style}`); island.close(true); await Scripting.sleep(200);
                await move(640, 120); island.open('shelf'); await Scripting.sleep(1400); await screenshot(`glass-regal-${style}`); island.close(true); await move(20, 600); await Scripting.sleep(300);
            }
        } finally { backdrop.destroy(); }
        ext.settings.set_string('style', 'dynamic'); await Scripting.sleep(200);

        // A real click on the play button toggles playback.
        const playMock = ext.media.state ? null : Gio.Subprocess.new(['/usr/bin/python3', here('mock_mpris.py')], Gio.SubprocessFlags.NONE);
        for (let i = 0; i < 30 && !ext.media.state; i++) await Scripting.sleep(100);
        ext.settings.set_boolean('hover-open', false);
        island.open('media'); island.togglePin(); await Scripting.sleep(700);
        const findPlay = () => styled(island.body, 'notchy-play')[0];
        const play = findPlay(), wasPlaying = ext.media.state.playing;
        const [playX, playY] = play.get_transformed_position(), cx = playX + play.width / 2, cy = playY + play.height / 2;
        const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, cx, cy), hitName = hit?.style_class ?? hit?.name;
        await move(cx, cy); await press(Clutter.ButtonState.PRESSED); await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(400);
        assert(ext.media.state.playing !== wasPlaying, `a real click on the play button toggles playback (hit ${hitName})`);
        await move(20, 600); await Scripting.sleep(200); await screenshot('media-controls');
        await move(cx, cy); await press(Clutter.ButtonState.PRESSED); await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(400);
        assert(ext.media.state.playing === wasPlaying, 'a second click toggles playback back');
        await move(20, 600); await Scripting.sleep(200); await screenshot('media-controls-again');
        // AirPlay: the output button opens a list with this computer and AirPlay receivers.
        const sinks = [{get_name: () => 'alsa_output.speakers', get_description: () => 'Lautsprecher'}, {get_name: () => 'raop_sink.Wohnzimmer.local.192.0.2.8.7000', get_description: () => 'Wohnzimmer'}];
        let current = sinks[0]; const chosen = [];
        Object.defineProperty(ext.outputs, 'list', {configurable: true, get: () => sinks.map(sink => ({sink, name: sink.get_description(), airplay: sink.get_name().startsWith('raop_sink.'), active: sink === current, icon: ''}))});
        const realSelect = ext.outputs.select; ext.outputs.select = output => { chosen.push(output.name); current = output.sink; ext.outputs.changed(); };
        try {
            island.refresh(); await Scripting.sleep(300);
            const outputButton = styled(island.body, 'notchy-output-button')[0];
            assert(outputButton && styled(outputButton, 'notchy-output-name')[0].text === 'Lautsprecher', 'the media tab shows where the music plays');
            outputButton.emit('clicked', 1); await Scripting.sleep(300);
            const items = styled(island.body, 'notchy-output-item');
            assert(items.length === 2 && styled(items[1], 'notchy-output-item-sub')[0].text === 'AirPlay' && items[0].has_style_class_name('active'), 'the output list offers this computer and the AirPlay receiver');
            await screenshot('media-outputs');
            items[1].emit('clicked', 1); await Scripting.sleep(300);
            assert(chosen[0] === 'Wohnzimmer' && !island.views.outputPicker && styled(island.body, 'notchy-output-button')[0]?.has_style_class_name('airplay') && island.toastState?.text === 'Wiedergabe auf Wohnzimmer', 'choosing an AirPlay receiver moves the music there and confirms it');
            await screenshot('media-airplay');
        } finally { delete ext.outputs.list; ext.outputs.select = realSelect; }
        island.togglePin(); island.close(true); await move(20, 600); ext.settings.set_boolean('hover-open', true); await Scripting.sleep(200);
        if (playMock) { playMock.force_exit(); await Scripting.sleep(300); }

        // Snap layouts: a window dragged by its title bar into the notch.
        const windowFixture = Gio.Subprocess.new(['/usr/bin/python3', here('mock_window.py')], Gio.SubprocessFlags.NONE);
        let fixture = null;
        for (let i = 0; i < 50 && !fixture; i++) { await Scripting.sleep(100); fixture = global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === 'Notchy Layer Fixture'); }
        try {
            assert(fixture, 'snap: a native window is mapped');
            fixture.move_frame(true, 360, 320); await Scripting.sleep(400);
            const frame = fixture.get_frame_rect(), [bx, by] = island.panelButton.get_transformed_position();
            const startX = frame.x + 120, startY = frame.y + 16, endX = bx + island.panelButton.width / 2, endY = by + island.panelButton.height / 2;
            await move(startX, startY); await press(Clutter.ButtonState.PRESSED);
            for (const t of [0.05, 0.15, 0.4, 0.7, 1]) await move(startX + (endX - startX) * t, startY + (endY - startY) * t);
            await Scripting.sleep(500);
            assert(island.peeking && island.peekKind === 'snap' && ext.snap.view?.zones.length === 15, `a window dragged to the clock opens snap layouts in the notch (${ext.snap.window ? 'moving' : 'no move grab'})`);
            await screenshot('snap');
            const zone = ext.snap.view.zones[0], [zx, zy] = zone.actor.get_transformed_position();
            await move(zx + zone.actor.width / 2, zy + zone.actor.height / 2); await Scripting.sleep(250);
            assert(zone.actor.has_style_class_name('hover') && zone.tile.has_style_class_name('hover'), 'the zone under the pointer lights up');
            await Scripting.sleep(300);
            const preview = ext.snap.preview, previewArea = Main.layoutManager.getWorkAreaForMonitor(island.monitor.index);
            assert(preview?.visible && preview.has_style_class_name('tile-preview') && preview.x === previewArea.x && preview.y === previewArea.y && Math.abs(preview.width - Math.round(previewArea.width / 2)) <= 1 && preview.height === previewArea.height,
                `GNOME's own tile preview shows where the window will go (${preview?.x},${preview?.y} ${preview?.width}x${preview?.height})`);
            await screenshot('snap-hover');
            await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(700);
            const area = Main.layoutManager.getWorkAreaForMonitor(island.monitor.index), placed = fixture.get_frame_rect();
            assert(placed.x === area.x && placed.y === area.y && Math.abs(placed.width - Math.round(area.width / 2)) <= 1 && placed.height === area.height && !island.peeking,
                `releasing over the left half tiles the window there (${placed.x},${placed.y} ${placed.width}x${placed.height})`);
            await Scripting.sleep(400); assert(!ext.snap.preview.visible, 'the tile preview fades once the window is placed');
        } finally { await press(Clutter.ButtonState.RELEASED); windowFixture.force_exit(); await move(20, 600); await Scripting.sleep(300); }
        // AirDrop against a stand-in backend: the same commands, state and accept hook, no radio.
        const airdropDir = GLib.getenv('NOTCHY_AIRDROP_RUNDIR'), recvDir = `${path}/airdrop-received`;
        GLib.mkdir_with_parents(airdropDir, 0o700);
        for (const name of ['answer', 'sent', 'incoming']) GLib.unlink(`${airdropDir}/${name}`);
        ext.settings.set_string('airdrop-folder', recvDir); ext.settings.set_string('airdrop-daemon', here('mock_airdropd')); await Scripting.sleep(200);
        const airdrop = ext.airdrop;
        // The Bluetooth wake is real BlueZ; the test only records it.
        const realBle = airdrop.ble, bleCalls = []; airdrop.ble = {start: () => bleCalls.push('start'), stop: () => bleCalls.push('stop')};
        assert(airdrop.available && airdrop.daemon === here('mock_airdropd'), 'AirDrop finds its backend');
        island.open('media'); await Scripting.sleep(500);
        assert(island.airdropButton.visible && island.airdropButton.mapped, 'the island header offers AirDrop when its backend is installed');
        island.airdropButton.emit('clicked', 1);
        for (let i = 0; i < 30 && airdrop.state !== 'armed'; i++) await Scripting.sleep(100);
        assert(airdrop.receiving && airdrop.state === 'armed' && island.airdropButton.has_style_class_name('active'), 'switching AirDrop on runs the backend in exclusive mode and arms it');
        island.close(); await Scripting.sleep(2200);
        assert(styled(island.leftRow, 'notchy-airdrop-icon').length === 1 && styled(island.rightRow, 'notchy-airdrop-text')[0]?.text === 'Sichtbar', 'the capsule shows AirDrop as a live activity while visible');
        Main.panel.set_style('background-color: transparent;'); await screenshot('airdrop-armed'); Main.panel.set_style(null);
        const incoming = (sender, name) => Gio.File.new_for_path(`${airdropDir}/incoming`).replace_contents(`${sender}|${name}\n`, null, false, Gio.FileCreateFlags.NONE, null);
        const answer = async () => { for (let i = 0; i < 60 && !GLib.file_test(`${airdropDir}/answer`, GLib.FileTest.EXISTS); i++) await Scripting.sleep(100); const [, bytes] = GLib.file_get_contents(`${airdropDir}/answer`); GLib.unlink(`${airdropDir}/answer`); return new TextDecoder().decode(bytes).trim(); };
        // An incoming photo asks in the notch; „Annehmen“ lets it in, and it joins the Regal.
        incoming('Matthias’ iPhone', 'IMG_2048.HEIC');
        for (let i = 0; i < 40 && island.peekKind !== 'airdrop-ask'; i++) await Scripting.sleep(100);
        assert(island.peekKind === 'airdrop-ask' && airdrop.question?.sender === 'Matthias’ iPhone' && styled(island.body, 'notchy-peek-title')[0]?.text === 'Matthias’ iPhone', 'an incoming AirDrop asks for consent in the notch');
        await Scripting.sleep(400); await screenshot('airdrop-ask');
        buttons(island.body, 'Annehmen')[0].emit('clicked', 1);
        assert(await answer() === 'accepted', 'Annehmen accepts the transfer through the backend\'s hook');
        for (let i = 0; i < 40 && !ext.shelf.items.some(item => item.name === 'IMG_2048.HEIC'); i++) await Scripting.sleep(100);
        const arrived = ext.shelf.items.find(item => item.name === 'IMG_2048.HEIC');
        assert(arrived && arrived.uri === Gio.File.new_for_path(`${recvDir}/IMG_2048.HEIC`).get_uri() && !ext.shelf.items.some(item => item.name.startsWith('._') || item.name.startsWith('NSIRD')), 'the received file lands in the Regal, without iOS\'s wrapper and sidecar files');
        // Escape is an answer too: no.
        incoming('Unbekanntes iPhone', 'Rechnung.pdf');
        for (let i = 0; i < 40 && island.peekKind !== 'airdrop-ask'; i++) await Scripting.sleep(100);
        await escape();
        assert(await answer() === 'declined' && !island.peeking && !ext.shelf.items.some(item => item.name === 'Rechnung.pdf'), 'Escape declines an incoming AirDrop');
        island.open('media'); await Scripting.sleep(400); island.airdropButton.emit('clicked', 1);
        for (let i = 0; i < 30 && airdrop.receiving; i++) await Scripting.sleep(100);
        await Scripting.sleep(500); island.close(true); await Scripting.sleep(300);
        assert(!airdrop.receiving && airdrop.state === 'off' && !styled(island.leftRow, 'notchy-airdrop-icon').length, 'switching AirDrop off gives the Wi-Fi back and leaves the capsule');
        // Sending: the notch searches, names the phone, and settles with a check.
        const sendFile = Gio.File.new_for_path(`${path}/airdrop to phone.txt`); sendFile.replace_contents('to the phone', null, false, Gio.FileCreateFlags.NONE, null);
        assert(airdrop.sendFiles([sendFile.get_path()]), 'a file can be sent over AirDrop');
        await Scripting.sleep(300);
        assert(island.peekKind === 'airdrop' && airdrop.send.phase === 'searching', 'sending opens the AirDrop view, searching first');
        await Scripting.sleep(500); await screenshot('airdrop-searching');
        const rings = styled(island.body, 'notchy-airdrop-ring');
        assert(rings.length === 3 && rings.some(ring => ring.get_transition('scale-x') && ring.opacity > 0), 'the radar rings pulse while searching');
        for (let i = 0; i < 30 && airdrop.send.phase === 'searching'; i++) await Scripting.sleep(100);
        assert(airdrop.send.peer === 'Test iPhone' && styled(island.body, 'notchy-peek-body')[0]?.text.includes('Test iPhone'), 'the view names the iPhone it found'); await screenshot('airdrop-send');
        for (let i = 0; i < 40 && airdrop.send.phase !== 'done'; i++) await Scripting.sleep(100);
        const [, sentBytes] = GLib.file_get_contents(`${airdropDir}/sent`);
        assert(airdrop.send.phase === 'done' && new TextDecoder().decode(sentBytes).trim() === sendFile.get_path(), 'the backend sent the file and the view shows it done');
        assert(bleCalls[0] === 'start' && bleCalls.at(-1) === 'stop', 'a send wakes the iPhone over Bluetooth and stops advertising afterwards'); await Scripting.sleep(200); await screenshot('airdrop-sent');
        await Scripting.sleep(2600); assert(!island.peeking, 'the AirDrop view folds away after sending');
        // No phone found: the view says what to do on the iPhone.
        Gio.File.new_for_path(`${airdropDir}/no-receiver`).replace_contents('1', null, false, Gio.FileCreateFlags.NONE, null);
        airdrop.sendFiles([sendFile.get_path()]);
        for (let i = 0; i < 40 && airdrop.send.phase !== 'failed'; i++) await Scripting.sleep(100);
        assert(airdrop.send.phase === 'failed' && airdrop.send.error.startsWith('Kein iPhone gefunden'), `a failed send explains itself (${airdrop.send.error})`); await screenshot('airdrop-failed');
        GLib.unlink(`${airdropDir}/no-receiver`); island.close(true); await Scripting.sleep(300);
        airdrop.ble = realBle; ext.settings.set_string('airdrop-daemon', ''); ext.settings.set_string('airdrop-folder', '');
        const themePath = GLib.getenv('NOTCHY_TEST_SHELL_THEME');
        if (themePath) {
            const context = St.ThemeContext.get_for_stage(global.stage), original = context.get_theme();
            const theme = new St.Theme({application_stylesheet: Gio.File.new_for_path(themePath)});
            theme.load_stylesheet(ext.dir.get_child('stylesheet.css')); context.set_theme(theme);
            try {
                for (const style of ['dynamic', 'liquid']) {
                    ext.settings.set_string('style', style); await Scripting.sleep(250);
                    const [, y] = island.panelSurface.get_transformed_position(), [, panelY] = Main.panel.get_transformed_position(), inset = style === 'liquid' ? 3 : 0;
                    assert(Math.abs(y - panelY - inset) < 1 && Math.abs(island.panelSurface.height - Main.panel.height + 2 * inset) < 1, `${style} keeps its bar geometry under the supplied desktop theme`);
                    await screenshot(`panel-theme-${style}`);
                }
            } finally { context.set_theme(original); ext.settings.set_string('style', 'dynamic'); await Scripting.sleep(200); }
        }

        // A real click on the capsule; morphing keeps the live clock.
        ext.settings.set_boolean('hover-open', false);
        const [slotX, slotY] = island.leftSlot.get_transformed_position();
        await move(slotX + island.leftSlot.width / 2, slotY + island.leftSlot.height / 2); await press(Clutter.ButtonState.PRESSED); await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(450);
        assert(island.expanded && island.actor.visible && island.actor.y === island.monitor.y && island.panelHeader.contains(island.clockContainer), 'real pointer click expands one surface from the bar with its live clock');
        await move(island.actor.x + 40, island.actor.y + 10); await move(20, 600); await Scripting.sleep(500);
        assert(!island.expanded && island.panelSurface.get_parent() === island.panelButton, 'the island collapses back into the bar');
        ext.settings.set_int('animation-duration', 700);
        const compactWidth = island.panelSurface.width;
        island.open('media'); await Scripting.sleep(120);
        assert(island.surface.width > compactWidth && island.surface.width < island.expandedWidth && island.panelHeader.contains(island.clockContainer), 'the capsule morphs through intermediate sizes with its original clock');
        await screenshot('opening'); await Scripting.sleep(750);
        island.close(); await Scripting.sleep(120);
        assert(island.actor.visible && island.panelAttached && island.surface.width < island.expandedWidth && island.surface.width > compactWidth - 1, 'closing shrinks the surface back towards its bar slot');
        await screenshot('closing'); island.open('clipboard'); await Scripting.sleep(800);
        assert(island.expanded && island.page === 'clipboard' && island.panelHeader.contains(island.clockContainer), 'opening during collapse cancels the old transition without losing the clock');
        ext.settings.set_int('animation-duration', 260);

        // The clock opens the Kalender tab; GNOME's popup when disabled.
        const [clockX, clockY] = island.dateMenu.get_transformed_position();
        await move(clockX + island.dateMenu.width / 2, clockY + island.headerHeight / 2);
        await press(Clutter.ButtonState.PRESSED); await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(500);
        assert(island.expanded && island.page === 'calendar' && !island.dateMenu.menu.isOpen, 'clock click opens the Kalender tab inside Notchy');
        assert(styled(island.body, 'notchy-cal-notes').length === 1 && styled(island.body, 'notchy-cal-strip').length === 1, 'Kalender shows the week, the agenda and the notifications'); await screenshot('calendar');
        ext.settings.set_boolean('clock-opens-notchy', false); await Scripting.sleep(100);
        await press(Clutter.ButtonState.PRESSED); await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(250);
        assert(island.dateMenu.menu.isOpen && !island.expanded && island.clockContainer.mapped, 'with the option off the clock opens GNOME\'s calendar');
        island.dateMenu.menu.close(); await Scripting.sleep(350);
        assert(island.panelSurface.get_parent() === island.panelButton && !island.actor.visible, 'closing the calendar returns the live clock to the bar slot');
        ext.settings.set_boolean('clock-opens-notchy', true); await move(20, 600);

        ext.openPreferences(); ext.openPreferences();
        const prefsWindows = () => global.get_window_actors().map(a => a.meta_window).filter(w => w.get_gtk_application_id() === 'org.gnome.Shell.Extensions' || w.get_wm_class() === 'org.gnome.Shell.Extensions');
        for (let i = 0; i < 60 && !prefsWindows().length; i++) await Scripting.sleep(100);
        assert(prefsWindows().length === 1 && !ext.prefsPending, 'real GNOME preferences service opens one dialog for repeated clicks');
        ext.openPreferences(); await Scripting.sleep(150);
        assert(prefsWindows().length === 1, 'preferences button reuses the existing GNOME dialog');
        prefsWindows()[0].delete(global.get_current_time()); await Scripting.sleep(250);

        // Incoming native drags: Wayland and X11 sources, drop and cancel.
        assert(ext.drops.ready && ext.drops.proc, 'native drop receiver is ready before a drag starts');
        const incomingCases = GLib.getenv('NOTCHY_TEST_FILES_ONLY') ? [] : [['media', false], ['clipboard', false], ['media', true], ['media', false, 'x11'], ['clipboard', false, 'x11'], ['media', false, 'wayland', 'airdrop']];
        for (const [page, cancel, backend = 'wayland', zone = 'shelf'] of incomingCases) {
            // With AirDrop installed the zone splits: „Ins Regal legen“ | „AirDrop“.
            const airdropRun = GLib.getenv('NOTCHY_AIRDROP_RUNDIR');
            const realWake = ext.airdrop.ble;
            if (zone === 'airdrop') { GLib.unlink(`${airdropRun}/sent`); ext.settings.set_string('airdrop-daemon', here('mock_airdropd')); ext.airdrop.ble = {start() {}, stop() {}}; }
            island.open(page); await Scripting.sleep(350);
            const name = `${page}-${backend}${cancel ? '-cancel' : ''}${zone === 'airdrop' ? '-airdrop' : ''}`;
            const files = [Gio.File.new_for_path(`${path}/drop ${name} ü.txt`), Gio.File.new_for_path(`${path}/drop ${name} second.txt`)];
            for (const file of files) file.replace_contents('original drag file', null, false, Gio.FileCreateFlags.PRIVATE, null);
            const receipt = `${path}/drop-${name}.json`;
            const sourceLauncher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            sourceLauncher.setenv('NOTCHY_DROP_SOURCE_BACKEND', backend, true);
            const source = sourceLauncher.spawnv(['/usr/bin/python3', here('mock_drop_source.py'), receipt, ...files.map(file => file.get_uri())]);
            try {
                await Scripting.sleep(600);
                const window = global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === 'Notchy Drop Source');
                assert(window && window.get_client_type() === (backend === 'wayland' ? 0 : 1), `${name}: ${backend} file source mapped`);
                window.move_resize_frame(false, 20, 420, 300, 150); await Scripting.sleep(250);
                await move(80, 470); await press(Clutter.ButtonState.PRESSED);
                await move(120, 450); await move(180, 390); await Scripting.sleep(200);
                assert(ext.drops.dragging && ext.drops.backend === backend, `${name}: real ${backend} file drag detected with matching receiver`);
                const [ax, ay] = island.panelButton.get_transformed_position();
                for (const progress of [.25, .5, .75, 1]) await move(180 + (ax + island.panelButton.width / 2 - 180) * progress, 390 + (ay + 12 - 390) * progress);
                await Scripting.sleep(450);
                assert(ext.drops.island === island && !ext.companion.proc, `${name}: the drop zone opens below the clock without a basket`);
                const p = ext.drops.position; await move(zone === 'airdrop' ? p.x + p.width - 12 - 75 : p.x + p.width / 2, p.y + 65); await Scripting.sleep(350);
                await screenshot(`drop-${name}`);
                const targetWindow = global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === (backend === 'x11' ? 'Notchy Drop Target X11' : 'Notchy Drop Target'));
                const targetRect = targetWindow?.get_frame_rect();
                assert(targetRect && Math.abs(targetRect.x - p.x) <= 1 && Math.abs(targetRect.y - p.y) <= 1 && p.y === island.dropTop, `${name}: native target sits directly below the clock`);
                assert(ext.drops.hovering, `${name}: GTK accepts the native file offer`);
                assert(paneShownOnGlass(island, targetWindow?.get_compositor_private()), `${name}: the drop zone shows on top of the island's whole glass`);
                if (cancel) {
                    await escape();
                    assert(!ext.drops.island && !ext.drops.dragging && !ext.shelf.items.some(item => item.uri === files[0].get_uri()) && files[0].query_exists(null), 'cancelled drag removes target without adding or altering files');
                    continue;
                }
                await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(550);
                if (zone === 'airdrop') {
                    for (let i = 0; i < 40 && island.peekKind !== 'airdrop'; i++) await Scripting.sleep(100);
                    assert(island.peekKind === 'airdrop' && !ext.drops.island, `${name}: dropping on the AirDrop zone folds the zone away and starts sending`);
                    for (let i = 0; i < 60 && !GLib.file_test(`${airdropRun}/sent`, GLib.FileTest.EXISTS); i++) await Scripting.sleep(100);
                    const [, sent] = GLib.file_get_contents(`${airdropRun}/sent`);
                    assert(files.every(file => new TextDecoder().decode(sent).split('\n').includes(file.get_path()) && !ext.shelf.items.some(item => item.uri === file.get_uri())), `${name}: both dragged files go to the iPhone, not into the Regal`);
                    await Scripting.sleep(2800); ext.settings.set_string('airdrop-daemon', ''); ext.airdrop.ble = realWake;
                    continue;
                }
                assert(files.every(file => ext.shelf.items.some(item => item.uri === file.get_uri()) && file.query_exists(null)), `${name}: actual drop adds all files and preserves originals`);
                const [ok, bytes] = Gio.File.new_for_path(receipt).load_contents(null), result = ok && JSON.parse(new TextDecoder().decode(bytes));
                assert(result && !result.cancelled && !result.delete_data, `${name}: source completes COPY successfully`);
                assert(!ext.drops.island && !ext.drops.dragging, `${name}: drop target cleans up after completion`);
            } finally {
                await press(Clutter.ButtonState.RELEASED); source.force_exit(); await move(20, 600); island.close(); await Scripting.sleep(350);
                ext.settings.set_boolean('hover-open', true);
                const [hx, hy] = island.panelButton.get_transformed_position();
                await move(hx + 30, hy + 12); await Scripting.sleep(700);
                assert(island.expanded && island.page === 'media' && !island.dropActive && !ext.drops.island && !ext.companion.shelfIsland, `${name}: ordinary hover after drag opens Medien without a drop zone`);
                await move(20, 600); await Scripting.sleep(600);
                assert(!island.expanded && !ext.drops.island, `${name}: Medien still collapses after drag`);
                ext.settings.set_boolean('hover-open', false);
            }
        }
        // With the Regal open, the native pane is the only drop target: no second drop zone.
        {
            const file = Gio.File.new_for_path(`${path}/drop into open regal.txt`); file.replace_contents('regal drop', null, false, Gio.FileCreateFlags.PRIVATE, null);
            const sourceLauncher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE}); sourceLauncher.setenv('NOTCHY_DROP_SOURCE_BACKEND', 'wayland', true);
            const source = sourceLauncher.spawnv(['/usr/bin/python3', here('mock_drop_source.py'), `${path}/drop-open-regal.json`, file.get_uri()]);
            try {
                // Pinned: the pointer leaves the island to start the drag in another window.
                await move(640, 120); island.open('shelf'); island.togglePin(); await Scripting.sleep(1200);
                const window = global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === 'Notchy Drop Source');
                window.move_resize_frame(false, 20, 420, 300, 150); await Scripting.sleep(250);
                await move(80, 470); await press(Clutter.ButtonState.PRESSED); await move(120, 450); await move(180, 390); await Scripting.sleep(200);
                const p = ext.companion.position;
                for (const progress of [.25, .5, .75, 1]) await move(180 + (p.x + p.width / 2 - 180) * progress, 390 + (p.y + 100 - 390) * progress);
                await Scripting.sleep(450);
                assert(ext.drops.dragging && !ext.drops.island && ext.companion.shelfIsland === island, 'dragging into the open Regal shows a single drop effect');
                await screenshot('drop-open-regal');
                await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(600);
                assert(ext.shelf.items.some(item => item.uri === file.get_uri()), 'the open Regal takes the dropped file itself');
            } finally { await press(Clutter.ButtonState.RELEASED); source.force_exit(); if (island.pinned) island.togglePin(); island.close(); await move(20, 600); await Scripting.sleep(350); }
        }
        await move(20, 600); ext.drops.setDragging(true); await Scripting.sleep(250);
        assert(!ext.drops.dragging && !ext.drops.island, 'a retained DND selection without a pressed mouse button cannot summon a drop zone');

        // The Regal is a native pane between the clock and the tab bar.
        if (!ext.shelf.items.length) {
            const file = Gio.File.new_for_path(`${path}/outgoing ü fixture.txt`);
            file.replace_contents('Original', null, false, Gio.FileCreateFlags.PRIVATE, null); ext.shelf.add(file.get_uri());
        }
        const receipt = `${path}/drag-out.json`;
        if (Gio.File.new_for_path(receipt).query_exists(null)) Gio.File.new_for_path(receipt).delete(null);
        const destination = Gio.Subprocess.new(['/usr/bin/python3', here('mock_drop_target.py'), receipt], Gio.SubprocessFlags.NONE);
        try {
            await Scripting.sleep(500);
            const target = global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === 'Notchy Drop Destination');
            assert(target && target.get_client_type() === 0, 'native outgoing destination mapped');
            target.move_resize_frame(false, 20, 450, 300, 150); await move(640, 100);
            island.open('shelf'); await Scripting.sleep(900);
            const currentPane = () => global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === 'Notchy Files' && w.get_pid() === Number(ext.companion.shelfProc?.get_identifier()));
            for (let i = 0; i < 100 && (!currentPane()?.get_compositor_private()?.mapped || !currentPane()?.get_frame_rect().width); i++) await Scripting.sleep(50);
            await Scripting.sleep(300);
            const pane = currentPane();
            assert(pane && ext.companion.shelfIsland === island && island.nav.mapped && island.body.get_n_children() === 0 && !island.actor.reactive, 'the Regal pane takes the page area with the tab bar below and native pointer input');
            const p = ext.companion.position, frame = pane.get_frame_rect(), [, navY] = island.nav.get_transformed_position();
            assert(Math.abs(frame.x - p.x) <= 1 && frame.x === island.actor.x && Math.abs(frame.y - p.y) <= 1 && frame.height === island.shelfWindowHeight && p.y === island.contentY && Math.abs(navY - (p.y + p.height)) <= 1, `the pane fits exactly between clock row and tab bar (${frame.x},${frame.y} ${frame.width}x${frame.height})`);
            assert(island.surface.has_style_class_name('notchy-native-joined') && island.surface.get_theme_node().get_background_color().alpha === 0, 'the Shell surface does not cover the native files');
            for (const style of ['liquid', 'dynamic']) {
                ext.settings.set_string('style', style); await Scripting.sleep(450);
                assert(currentPane()?.get_compositor_private()?.mapped && paneShownOnGlass(island, currentPane()?.get_compositor_private()), `${style}: the Regal shows on top of the island's whole glass, one glass layer as in every tab`);
                assert(!island.glass.clones.some(([, child]) => child === currentPane()?.get_compositor_private()), `${style}: the glass never blurs the native pane into itself`);
                await screenshot(`regal-${style}`);
            }
            await move(p.x + 60, p.y + 70); await press(Clutter.ButtonState.PRESSED);
            await Scripting.sleep(180);
            await move(p.x + 75, p.y + 80);
            await move(350, 400); await Scripting.sleep(200);
            assert(ext.drops.dragging && ext.companion.shelfHeld && island.expanded && !ext.drops.island, 'outgoing drag keeps its native source alive without summoning a drop zone');
            await move(200, 490); await Scripting.sleep(200); await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(500);
            const [ok, bytes] = Gio.File.new_for_path(receipt).load_contents(null), received = ok && JSON.parse(new TextDecoder().decode(bytes));
            assert(received.length > 0 && received.every(uri => ext.shelf.items.some(item => item.uri === uri) && Gio.File.new_for_uri(uri).query_exists(null)), 'native destination receives file COPY and originals survive');
            await move(640, 100); island.open('shelf'); await Scripting.sleep(600);
            const shelfPid = ext.companion.shelfProc?.get_identifier();
            const [tabX, tabY] = island.navButtons[2][1].get_transformed_position();
            await move(tabX + 30, tabY + 18); await press(Clutter.ButtonState.PRESSED); await press(Clutter.ButtonState.RELEASED); await Scripting.sleep(400);
            assert(island.page === 'clipboard' && !ext.companion.shelfIsland && island.actor.reactive && island.body.get_n_children() === 1, 'the tab bar switches from the native Regal back to the Ablage');
            await move(640, 100); island.open('shelf'); await Scripting.sleep(650);
            assert(shelfPid && ext.companion.shelfProc?.get_identifier() === shelfPid, 'returning to Regal reuses the running native shelf');
            for (let i = 0; i < 100 && (!currentPane()?.get_compositor_private()?.mapped || !currentPane()?.get_frame_rect().width); i++) await Scripting.sleep(50);
            const overviewPane = currentPane();
            Main.overview.show(); await Scripting.sleep(400);
            assert(overviewPane && !island.actor.visible && !overviewPane.get_compositor_private()?.mapped, 'overview hides the native pane together with Notchy');
            Main.overview.hide(); await Scripting.sleep(400);
            assert(!island.actor.visible && !ext.companion.shelfIsland, 'leaving the overview leaves Notchy closed');
            await move(640, 100); island.open('shelf'); await Scripting.sleep(650);
            for (let i = 0; i < 100 && (!currentPane()?.get_compositor_private()?.mapped || !currentPane()?.get_frame_rect().width); i++) await Scripting.sleep(50);
            const panePosition = ext.companion.position;
            await move(panePosition.x + 60, panePosition.y + 70); await Scripting.sleep(200);
            pointer.notify_button(GLib.get_monotonic_time(), 3, Clutter.ButtonState.PRESSED); await Scripting.sleep(120);
            pointer.notify_button(GLib.get_monotonic_time(), 3, Clutter.ButtonState.RELEASED); await Scripting.sleep(400);
            await screenshot('regal-menu');
            const menuOpen = () => [...ext.companion.popups.values()].some(popup => popup.menu);
            for (let i = 0; i < 20 && !menuOpen(); i++) await Scripting.sleep(100);
            assert(menuOpen() && [...ext.companion.popups.values()].every(popup => popup.clone.mapped), 'the file menu opens as a real popup, shown on top of the island');
            await move(20, 650); await Scripting.sleep(300);
            assert(island.expanded && ext.companion.shelfHeld, 'the native file context menu prevents unintended collapse');
            await move(panePosition.x + 200, panePosition.y + 200); await Scripting.sleep(150);
            await escape();
            assert(!ext.companion.shelfHeld && !menuOpen() && island.expanded, 'dismissing the context menu releases the temporary hold');
            // A real click on „Aus Regal entfernen“ in the menu removes that file.
            const before = ext.shelf.items.length;
            GLib.unlink(`${path}/regal-menu.json`);
            await move(panePosition.x + 60, panePosition.y + 70); await Scripting.sleep(200);
            pointer.notify_button(GLib.get_monotonic_time(), 3, Clutter.ButtonState.PRESSED); await Scripting.sleep(120);
            pointer.notify_button(GLib.get_monotonic_time(), 3, Clutter.ButtonState.RELEASED); await Scripting.sleep(700);
            const [[menuWindow]] = [...ext.companion.popups.entries()].filter(([, popup]) => popup.menu);
            const [, rowsBytes] = GLib.file_get_contents(`${path}/regal-menu.json`), removeRow = JSON.parse(new TextDecoder().decode(rowsBytes)).find(r => r.label === 'Aus Regal entfernen');
            const buffer = menuWindow.get_buffer_rect();
            await move(buffer.x + removeRow.x + removeRow.width / 2, buffer.y + removeRow.y + removeRow.height / 2); await Scripting.sleep(150); await screenshot('regal-menu-remove');
            await press(Clutter.ButtonState.PRESSED); await press(Clutter.ButtonState.RELEASED);
            for (let i = 0; i < 20 && ext.shelf.items.length === before; i++) await Scripting.sleep(100);
            assert(ext.shelf.items.length === before - 1 && !ext.companion.shelfHeld, `the menu's actions work with a real click (${before} → ${ext.shelf.items.length})`);
            await move(640, 100); island.open('shelf'); await Scripting.sleep(600);
            for (let i = 0; i < 100 && (!currentPane()?.get_compositor_private()?.mapped || !currentPane()?.get_frame_rect().width); i++) await Scripting.sleep(50);
            // Real clicks select and deselect tiles (GTK's FlowBox keeps a clicked tile selected on its own).
            // Exactly two files, so the space beside and below them is really empty.
            ext.shelf.clear(false);
            for (const name of ['select one.txt', 'select two.txt']) {
                const file = Gio.File.new_for_path(`${path}/${name}`); file.replace_contents('selection fixture', null, false, Gio.FileCreateFlags.NONE, null); ext.shelf.add(file.get_uri());
            }
            await Scripting.sleep(800);
            const regal = ext.companion.position, tile = [regal.x + 60, regal.y + 70], empty = [regal.x + regal.width - 60, regal.y + regal.height - 24];
            // A whole click every time, whatever state earlier steps left the helper in.
            const click = async ([x, y]) => {
                await move(x, y); await Scripting.sleep(150);
                pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED); await Scripting.sleep(60);
                pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED); await Scripting.sleep(700);
            };
            await click(empty); ext.companion.shelfSelected = -1;
            await click(tile); const selectedOnce = ext.companion.shelfSelected;
            await click(tile); const selectedTwice = ext.companion.shelfSelected;
            assert(selectedOnce === 1 && selectedTwice === 0, `a second real click on the selected tile deselects it (${selectedOnce} → ${selectedTwice})`);
            await click(tile); await click(empty);
            assert(ext.companion.shelfSelected === 0, 'a real click on empty space in the Regal clears the selection');
            await click(tile);
            const escapeFrame = currentPane().get_frame_rect();
            await move(escapeFrame.x + escapeFrame.width / 2, escapeFrame.y + 16);
            await press(Clutter.ButtonState.PRESSED); await press(Clutter.ButtonState.RELEASED);
            // Files selected earlier stay selected: the first Esc clears them, the next closes.
            await escape();
            assert(island.expanded && ext.companion.shelfIsland, 'the first Escape only clears the Regal\'s selection');
            await escape();
            assert(!island.expanded && !ext.companion.shelfIsland && island.actor.reactive, 'Escape closes the native Regal and restores the capsule');
        } finally { await press(Clutter.ButtonState.RELEASED); destination.force_exit(); island.close(); await move(20, 600); }
    } finally { pointer.run_dispose(); keyboard.run_dispose(); ext.settings.set_boolean('hover-open', true); ext.settings.set_int('collapse-delay', 700); ext.settings.set_string('style', 'dynamic'); }
}

// The Regal's real context menu: a GTK popover (its own Wayland popup) at the pointer,
// shown on top of the island, with single and multiple selections.
async function regalMenuRegressions(ext, path, screenshot) {
    const island = ext.islands[0];
    const pointer = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const move = async (x, y) => { pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y); await Scripting.sleep(90); };
    const click = async (x, y, button = 1, wait = 600) => { await move(x, y); await Scripting.sleep(150); pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.PRESSED); await Scripting.sleep(60); pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED); await Scripting.sleep(wait); };
    const tap = async (keyval, wait = 300) => { keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED); keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED); await Scripting.sleep(wait); };
    const menus = () => [...ext.companion.popups.entries()].filter(([, popup]) => popup.menu);
    const waitFor = async (condition, ms = 3000) => { for (let i = 0; i < ms / 50 && !condition(); i++) await Scripting.sleep(50); return condition(); };
    const rows = () => { try { const [, bytes] = GLib.file_get_contents(`${path}/regal-menu.json`); return JSON.parse(new TextDecoder().decode(bytes)); } catch { return []; } };
    const clickRow = async label => {
        const [[window]] = menus(), buffer = window.get_buffer_rect(), row = rows().find(r => r.label === label);
        if (!row) throw Error(`menu row ${label} not found in ${JSON.stringify(rows().map(r => r.label))}`);
        await click(buffer.x + row.x + row.width / 2, buffer.y + row.y + row.height / 2, 1, 700);
    };
    const openMenu = async ([x, y]) => {
        GLib.unlink(`${path}/regal-menu.json`);
        await click(x, y, 3, 400); await waitFor(() => menus().length && rows().length);
    };
    const fixtures = ['menu one.png', 'menu two.txt', 'menu three.txt'].map(name => Gio.File.new_for_path(`${path}/${name}`));
    try {
        ext.shelf.clear(false);
        const [, png] = Gio.File.new_for_path(`${path}/collapsed.png`).load_contents(null);
        fixtures[0].replace_contents(png, null, false, Gio.FileCreateFlags.NONE, null);
        for (const file of fixtures.slice(1)) file.replace_contents('menu fixture', null, false, Gio.FileCreateFlags.NONE, null);
        for (const file of fixtures) ext.shelf.add(file.get_uri());
        ext.settings.set_boolean('hover-open', false); ext.settings.set_int('collapse-delay', 150);
        await move(640, 100); island.open('shelf');
        await waitFor(() => ext.companion.shelfWindow?.get_compositor_private()?.mapped && !island.morphing); await Scripting.sleep(900);
        const regal = ext.companion.position, tileAt = i => [regal.x + 60 + i * 132, regal.y + 70], empty = [regal.x + regal.width - 60, regal.y + regal.height - 24];
        // Single selection: a right click selects the tile and opens the menu at the pointer.
        await click(...empty, 1, 400);
        await openMenu(tileAt(1));
        const [[window, popup]] = menus(), actor = window.get_compositor_private(), frame = window.get_frame_rect();
        assert(window.get_transient_for() === ext.companion.shelfWindow && ext.companion.shelfSelected === 1, 'a right click on a tile selects it and opens a real popup menu of the Regal');
        const [tx, ty] = tileAt(1), area = Main.layoutManager.getWorkAreaForMonitor(island.monitor.index);
        assert(Math.abs(frame.x + frame.width / 2 - tx) <= 2 && frame.y >= ty - 2 && frame.y <= ty + 12, `the menu opens right at the pointer (${frame.x},${frame.y} ${frame.width}x${frame.height})`);
        assert(frame.x >= area.x && frame.y >= area.y && frame.x + frame.width <= area.x + area.width && frame.y + frame.height <= area.y + area.height, 'the menu stays inside the work area');
        const uiChildren = Main.layoutManager.uiGroup.get_children();
        assert(popup.clone.source === actor && popup.clone.mapped && uiChildren.indexOf(popup.clone) > uiChildren.indexOf(island.actor) && uiChildren.indexOf(popup.clone) > uiChildren.indexOf(global.top_window_group) &&
            Math.abs(popup.clone.x - actor.x) <= 1 && Math.abs(popup.clone.y - actor.y) <= 1 && !popup.clone.reactive, 'the menu is shown on top of the island and every chrome layer, exactly over its popup');
        const labels = rows().map(r => r.label);
        assert(labels[0] === 'Öffnen' && labels.includes('Im Ordner zeigen') && labels.includes('Kopie speichern …') && labels.includes('Als ZIP packen') && labels.at(-1) === 'Aus Regal entfernen' && !labels.includes('Text erkennen'),
            `a text file's menu lists its actions vertically (${labels.join(', ')})`);
        // Input reaches the popup where it overlaps the island: the topmost reactive actor there is the popup's window.
        const overlap = rows().find(r => r.label === 'Als ZIP packen'), buffer = window.get_buffer_rect();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, buffer.x + overlap.x + 20, buffer.y + overlap.y + overlap.height / 2);
        assert(picked && (picked === actor || actor.contains(picked)), `clicks on the menu reach the popup, not the island (picked ${picked?.name ?? picked})`);
        assert(ext.companion.shelfHeld && island.navButtons.every(([, tab]) => !tab.reactive), 'while the menu is open the island holds and its tab bar lets clicks through');
        await screenshot('regal-context-menu');
        // Hover collapse must not close the island while the menu is open.
        await move(1200, 660); await Scripting.sleep(700);
        assert(island.expanded && menus().length === 1, 'leaving the island with the pointer while the menu is open keeps island and menu');
        await move(tx, ty + 40); await Scripting.sleep(200);
        // Escape closes only the menu.
        await tap(Clutter.KEY_Escape, 500);
        assert(!menus().length && !ext.companion.shelfHeld && island.expanded && ext.companion.shelfIsland === island && ext.companion.shelfSelected === 1 && island.navButtons.every(([, tab]) => tab.reactive),
            'Escape closes only the context menu; the Regal, its selection and the tab bar remain');
        // A click outside closes only the menu.
        await openMenu(tileAt(1));
        await click(regal.x + regal.width - 40, regal.y + 200, 1, 300);
        assert(!menus().length && island.expanded && ext.companion.shelfIsland === island, 'a click outside closes only the context menu');
        // A click on the tab bar while the menu is open dismisses the menu, never switches tabs.
        await openMenu(tileAt(1));
        const [tabX, tabY] = island.navButtons[2][1].get_transformed_position();
        await click(tabX + 20, tabY + 15, 1, 400);
        assert(!menus().length && island.page === 'shelf' && island.expanded, 'a click on the tab bar only dismisses the menu');
        await move(tx, ty + 40); await Scripting.sleep(300);
        // Keyboard: the first entry has focus; arrows walk, Enter runs (Kopieren puts the file on the clipboard).
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, 'before');
        await openMenu(tileAt(1));
        await tap(Clutter.KEY_Down, 150); await tap(Clutter.KEY_Down, 150); await tap(Clutter.KEY_Return, 300);
        await waitFor(() => !menus().length, 2000);
        const mimes = St.Clipboard.get_default().get_mimetypes(St.ClipboardType.CLIPBOARD);
        assert(!menus().length && mimes.some(m => m === 'text/uri-list' || m === 'x-special/gnome-copied-files'), `arrow keys and Enter run a menu entry (clipboard: ${mimes.join(' ')})`);
        // Right click on a tile outside the selection: that tile alone is selected.
        await openMenu(tileAt(0));
        assert(ext.companion.shelfSelected === 1 && rows().some(r => r.label === 'Öffnen'), 'a right click on another tile moves the selection to it');
        const imageLabels = rows().map(r => r.label);
        assert(!GLib.find_program_in_path('tesseract') || imageLabels.includes('Text erkennen'), 'image actions appear for images when their tool is installed');
        await tap(Clutter.KEY_Escape, 400);
        // Multiple selection: Ctrl+click adds a tile; the menu acts on all selected files.
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Control_L, Clutter.KeyState.PRESSED); await Scripting.sleep(80);
        await click(...tileAt(1), 1, 300);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED); await Scripting.sleep(300);
        assert(ext.companion.shelfSelected === 2, 'Ctrl+click selects a second tile');
        await openMenu(tileAt(1));
        const multi = rows().map(r => r.label);
        assert(ext.companion.shelfSelected === 2 && multi.includes('2 Dateien öffnen') && multi.includes('Kopien speichern …'), `a right click inside the selection keeps it and offers actions for all (${multi.join(', ')})`);
        await screenshot('regal-context-menu-multi');
        const before = ext.shelf.items.length;
        await clickRow('Aus Regal entfernen');
        await waitFor(() => ext.shelf.items.length === before - 2);
        assert(ext.shelf.items.length === before - 2 && fixtures.every(file => file.query_exists(null)) && !ext.companion.shelfHeld, `a real click removes all selected files from the Regal, originals stay (${before} → ${ext.shelf.items.length})`);
        await move(20, 650); await Scripting.sleep(700);
        assert(!island.expanded, `with the menu closed, leaving the island collapses it again (pinned ${island.pinned}, held ${ext.companion.shelfHeld}, hovered ${island.hovered}, menus ${menus().length}, page ${island.page})`);
        // Switching to the Regal with the pointer on the island (which then stops being reactive)
        // must not leave a stale hover behind: leaving still collapses it.
        island.open('media'); await Scripting.sleep(500);
        const [shelfTabX, shelfTabY] = island.navButtons[1][1].get_transformed_position();
        await click(shelfTabX + 20, shelfTabY + 15, 1, 1200);
        assert(island.page === 'shelf' && ext.companion.shelfIsland === island && !island.actor.reactive, 'a real click on the Regal tab opens the native pane');
        await move(20, 650); await Scripting.sleep(700);
        assert(!island.expanded, `leaving the Regal collapses the island even after hovering it before (hovered ${island.hovered})`);
    } finally { pointer.run_dispose(); keyboard.run_dispose(); ext.settings.set_boolean('hover-open', true); ext.settings.set_int('collapse-delay', 700); island.close(true); }
}

// Thunderstorm as a launcher: files through a stand-in LocalSearch, debouncing and
// stale answers, ranking, the action panel, quicklinks, units, commands with
// confirmation, windows, clipboard, snippets, emoji and the fallback search.
async function launcherRegressions(ext, path, screenshot) {
    const island = ext.islands[0];
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const press = async (keyval, wait = 200) => { keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED); keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED); await Scripting.sleep(wait); };
    const chord = async (modifiers, keyval, wait = 250) => {
        for (const m of modifiers) keyboard.notify_keyval(GLib.get_monotonic_time(), m, Clutter.KeyState.PRESSED);
        await press(keyval, 60); for (const m of [...modifiers].reverse()) keyboard.notify_keyval(GLib.get_monotonic_time(), m, Clutter.KeyState.RELEASED); await Scripting.sleep(wait);
    };
    const waitFor = async (condition, ms = 4000) => { for (let i = 0; i < ms / 50 && !condition(); i++) await Scripting.sleep(50); return condition(); };
    const state = () => island.views.searchState, titles = () => state().results.map(r => r.title);
    const type = async (text, wait = 120) => { island.views.focusEntry.set_text(text); await Scripting.sleep(wait); };
    const open = async () => { island.close(true); await Scripting.sleep(150); island.toggle('search'); await Scripting.sleep(400); };
    const {system} = await import(`${ext.dir.get_uri()}/src/launcher/providers.js`);
    const realSystem = {open: system.open, call: system.call}, opened = [], calls = [];
    system.open = uri => opened.push(uri);
    system.call = (bus, name, objectPath, iface, method, params) => { calls.push({bus, name, iface, method, params: params?.deep_unpack() ?? null}); return Promise.resolve(null); };
    const root = `${path}/thunderstorm`; GLib.mkdir_with_parents(`${root}/Berichte`, 0o700); GLib.mkdir_with_parents(`${root}/.geheim`, 0o700);
    const files = ['Bericht Quartal.pdf', 'Notizen zum bericht.txt', '.geheim/bericht privat.txt'].map(name => `${root}/${name}`);
    for (const file of files) GLib.file_set_contents(file, 'fixture');
    const indexed = [...files, `${root}/Berichte`, `${root}/verschwunden/bericht alt.txt`];
    const log = `${path}/localsearch-queries.log`; GLib.unlink(log);
    const queries = () => { try { return new TextDecoder().decode(GLib.file_get_contents(log)[1]).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
    const mock = Gio.Subprocess.new(['/usr/bin/python3', here('mock_localsearch.py'), log, 'ber', ...indexed], Gio.SubprocessFlags.NONE);
    ext.settings.set_boolean('hover-open', false);
    try {
        await Scripting.sleep(600);
        // Files from the index: names, kinds, ranking, no hidden or vanished files.
        await open();
        assert(island.page === 'search' && state().empty, 'Thunderstorm opens with its start list');
        await type('quartal');
        await waitFor(() => titles().includes('Bericht Quartal.pdf'));
        const report = state().results.find(r => r.title === 'Bericht Quartal.pdf');
        assert(report && report.kind === 'Datei' && report.subtitle.endsWith('tests/output/thunderstorm') && state().backend === 'localsearch', `files come from the LocalSearch index with name, kind and folder (${titles().join(', ')})`);
        assert(state().selected === 0 && titles()[0] === 'Bericht Quartal.pdf', 'file results arriving late take the top and the selection, above the web search');
        await Scripting.sleep(400); await screenshot('thunderstorm-files');
        await type('berichte'); await waitFor(() => titles().includes('Berichte') && !state().pending, 3000);
        assert(state().results.find(r => r.title === 'Berichte')?.kind === 'Ordner', 'folders are listed as folders');
        await type('bericht'); await waitFor(() => !state().pending && titles().includes('Notizen zum bericht.txt'), 4000);
        const order = titles();
        assert(!order.includes('bericht privat.txt') && !order.includes('bericht alt.txt'), 'hidden files and files no longer on disk are left out');
        assert(order.indexOf('Bericht Quartal.pdf') < order.indexOf('Notizen zum bericht.txt') && order.indexOf('Berichte') < order.indexOf('Notizen zum bericht.txt'), `a name starting with the query ranks above one containing it (${order.join(', ')})`);
        // Fast typing: one index query for a burst of keystrokes.
        GLib.unlink(log);
        for (const text of ['q', 'qu', 'qua', 'quar', 'quart', 'quarta', 'quartal']) await type(text, 25);
        await waitFor(() => !state().pending && titles().includes('Bericht Quartal.pdf'));
        const burst = queries();
        assert(burst.length === 1 && burst[0].terms === 'quartal*', `a burst of keystrokes asks the index once (${burst.map(q => q.terms).join(' ')})`);
        // A slow answer to an older query never replaces the newer one.
        await type('berich', 400); await type('quartal', 50);
        await waitFor(() => queries().some(q => q.terms === 'quartal*') && !state().pending, 4000); await Scripting.sleep(1200);
        assert(titles().includes('Bericht Quartal.pdf') && !titles().includes('Notizen zum bericht.txt') && !titles().includes('Berichte'), `a late answer to an overtaken query is dropped (${titles().join(', ')})`);
        // The action panel and safe file actions.
        await type('quartal'); await waitFor(() => titles()[0] === 'Bericht Quartal.pdf' || titles().includes('Bericht Quartal.pdf'));
        state().selected = state().results.findIndex(r => r.title === 'Bericht Quartal.pdf');
        await chord([Clutter.KEY_Control_L], Clutter.KEY_k);
        assert(state().panel && state().panel.actions.map(a => a.title).join('|') === 'Öffnen|Im Dateimanager zeigen|Pfad kopieren|Ins Regal legen', `Ctrl+K opens the result's actions (${state().panel?.actions.map(a => a.title)})`);
        await screenshot('thunderstorm-actions');
        await press(Clutter.KEY_Down); await press(Clutter.KEY_Down); await press(Clutter.KEY_Return, 400);
        assert(!island.expanded && await clipboardText() === files[0], 'the panel copies the file path');
        await open(); await type('quartal'); await waitFor(() => titles().includes('Bericht Quartal.pdf'));
        state().selected = state().results.findIndex(r => r.title === 'Bericht Quartal.pdf');
        await chord([Clutter.KEY_Control_L], Clutter.KEY_Return, 400);
        assert(calls.some(c => c.method === 'ShowItems' && c.params[0][0] === Gio.File.new_for_path(files[0]).get_uri()), 'Ctrl+Enter shows the file in the file manager');
        await open(); await type('quartal'); await waitFor(() => titles().includes('Bericht Quartal.pdf'));
        state().selected = state().results.findIndex(r => r.title === 'Bericht Quartal.pdf');
        await press(Clutter.KEY_Return, 600);
        assert(opened.at(-1) === Gio.File.new_for_path(files[0]).get_uri(), 'Enter opens the file after checking it still exists');
        // Arithmetic (kept) and units.
        await open(); await type('2+3*4');
        assert(titles()[0] === '= 14', 'the calculator still answers first');
        await type('10 km in mi');
        assert(titles()[0] === '= 6,2137119 mi' && state().results[0].kind === 'Umrechnung', `units convert (${titles()[0]})`);
        await press(Clutter.KEY_Return, 300);
        assert(await clipboardText() === '6,2137119', 'Enter copies the converted value');
        await open(); await type('72 °F');
        assert(titles()[0] === '= 22,222222 °C', `temperatures convert without a target (${titles()[0]})`);
        // Quicklinks with a URL-encoded argument; the web search row comes last.
        await type('yt lofi & chill');
        assert(titles()[0] === 'YouTube: lofi & chill' && state().results.at(-1).kind === 'Web', `a quicklink takes its argument (${titles().join(', ')})`);
        await press(Clutter.KEY_Return, 300);
        assert(opened.at(-1) === 'https://www.youtube.com/results?search_query=lofi%20%26%20chill', `the quicklink opens with the argument encoded (${opened.at(-1)})`);
        await open(); await type('gh');
        await press(Clutter.KEY_Return, 300);
        assert(island.expanded && island.views.focusEntry.get_text() === 'gh ', 'Enter on a quicklink without argument completes its keyword');
        await type('gh matkaise/notchy'); await press(Clutter.KEY_Return, 300);
        assert(opened.at(-1) === 'https://github.com/matkaise/notchy', 'gh owner/repo opens the repository directly');
        // System commands through GNOME's D-Bus interfaces; shutting down asks first.
        await open(); await type('sperren');
        assert(titles()[0] === 'Bildschirm sperren', 'commands are found by German words');
        await press(Clutter.KEY_Return, 300);
        assert(calls.at(-1)?.name === 'org.gnome.ScreenSaver' && calls.at(-1).method === 'Lock', 'locking goes through GNOME\'s ScreenSaver interface');
        await open(); await type('audio');
        assert(titles().includes('Audioeinstellungen'), 'the sound settings are a command');
        await open(); await type('ausschalten');
        const before = calls.length;
        await press(Clutter.KEY_Return, 300);
        assert(calls.length === before && island.expanded && state().confirm === 'cmd:shutdown', 'shutting down asks for confirmation first');
        await screenshot('thunderstorm-confirm');
        await press(Clutter.KEY_Escape, 250);
        assert(island.expanded && !state().confirm && calls.length === before, 'Escape cancels the confirmation');
        await press(Clutter.KEY_Return, 200); await press(Clutter.KEY_Return, 300);
        assert(calls.at(-1)?.method === 'RequestShutdown' && calls.at(-1).name === 'org.gnome.SessionManager', 'a second Enter shuts down through the session manager');
        await open(); await type('neu starten'); await press(Clutter.KEY_Return, 200);
        assert(state().confirm === 'cmd:restart', 'restarting asks too'); await press(Clutter.KEY_Escape);
        // The empty field lists recently used results.
        await type('');
        assert(state().results.some(r => r.section === 'Zuletzt verwendet' && r.title === 'Bildschirm sperren'), 'recently used results return on the empty field');
        await Scripting.sleep(400); await screenshot('thunderstorm-empty');
        const scroller = styled(island.body, 'notchy-results-scroll')[0], content = scroller.get_child();
        assert(Math.abs(island.surface.height - island.body.height) <= 2 && scroller.height >= Math.min(content.height, scroller.height) && scroller.vadjustment.upper - scroller.vadjustment.page_size <= 1, `the island fits the start list without scrolling (${scroller.height} of ${content.height})`);
        // Emoji and special characters.
        await type(':herz');
        const emoji = state().results.filter(r => r.kind !== 'Web');
        assert(emoji.length >= 5 && emoji.every(r => ['Emoji', 'Zeichen'].includes(r.kind)) && emoji[0].glyph === '❤️', `emoji are found by German names (${emoji.slice(0, 4).map(r => r.glyph).join(' ')})`);
        await screenshot('thunderstorm-emoji');
        await type('emoji daumen hoch'); await press(Clutter.KEY_Return, 300);
        assert(await clipboardText() === '👍', 'Enter copies an emoji');
        // Snippets and the clipboard history.
        await open(); await type('mfg'); await press(Clutter.KEY_Return, 300);
        assert(await clipboardText() === 'Freundliche Grüsse\n', 'a snippet is copied by its keyword');
        ext.settings.set_boolean('clipboard-enabled', true);
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, 'Bestellnummer 4711-ABC'); await Scripting.sleep(400);
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, 'anderes'); await Scripting.sleep(400);
        await open(); await type('ablage 4711');
        assert(titles()[0] === 'Bestellnummer 4711-ABC' && state().results[0].kind === 'Ablage', 'the clipboard history is searchable');
        await press(Clutter.KEY_Return, 300);
        assert(await clipboardText() === 'Bestellnummer 4711-ABC', 'Enter copies the history entry back');
        ext.settings.set_boolean('clipboard-enabled', false);
        await open(); await type('ablage 4711');
        assert(!state().results.some(r => r.kind === 'Ablage'), 'without recording, the history stays out of the launcher');
        // Window commands for the window focused before the launcher opened.
        const windowFixture = Gio.Subprocess.new(['/usr/bin/python3', here('mock_window.py')], Gio.SubprocessFlags.NONE);
        let fixture = null;
        for (let i = 0; i < 50 && !fixture; i++) { await Scripting.sleep(100); fixture = global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === 'Notchy Layer Fixture'); }
        try {
            island.close(true); fixture.activate(global.get_current_time()); await Scripting.sleep(400);
            await open(); await type('links anordnen');
            assert(titles()[0] === 'Fenster links anordnen' && state().results[0].subtitle === 'Notchy Layer Fixture', 'window commands act on the window focused before');
            await press(Clutter.KEY_Return, 600);
            const area = Main.layoutManager.getWorkAreaForMonitor(island.monitor.index), rect = fixture.get_frame_rect();
            assert(rect.x === area.x && Math.abs(rect.width - Math.round(area.width / 2)) <= 1 && rect.height === area.height, `the window takes the left half (${rect.x},${rect.y} ${rect.width}x${rect.height})`);
            await open(); await type('maximieren'); await press(Clutter.KEY_Return, 600);
            assert(fixture.is_maximized(), 'the window can be maximised from the launcher');
        } finally { windowFixture.force_exit(); await Scripting.sleep(300); }
        // Indexed folders on request.
        await open(); await type('indizierte ordner'); await press(Clutter.KEY_Return, 800);
        assert(island.expanded && state().drill === 'indexed' && state().results.some(r => r.section?.startsWith('Von GNOME LocalSearch')), `the indexed folders are listed transparently (${island.expanded} ${state().drill} ${state().results.map(r => `${r.section}: ${r.title}`).join(', ')})`);
        await press(Clutter.KEY_Escape, 300);
        assert(island.expanded && !state().drill, 'Escape leaves the folder list');
        // Without the indexer: a clear message and the bounded simple search.
        mock.force_exit(); await Scripting.sleep(400);
        await type('quartal'); await waitFor(() => !state().pending, 6000);
        assert(state().backend === 'fallback' && titles().includes('Bericht Quartal.pdf') && styled(island.body, 'notchy-search-footer-text')[0]?.text.includes('einfache Suche'), `without LocalSearch the simple search finds files and says so (${titles().join(', ')})`);
        await screenshot('thunderstorm-fallback');
        await press(Clutter.KEY_Escape);
        assert(!island.expanded, 'Escape closes Thunderstorm');
    } finally {
        system.open = realSystem.open; system.call = realSystem.call;
        try { mock.force_exit(); } catch { /* Already ended. */ }
        keyboard.run_dispose(); ext.settings.set_boolean('hover-open', true); island.close(true);
    }
}

// AirPods through a stand-in airpods-helper daemon (same D-Bus API, no radio):
// missing backend, connecting with its banner, batteries that arrive later,
// noise control by model, low battery, ear state, disconnecting, and the
// daemon going away. Notchy never pauses media itself (the daemon does).
async function airpodsRegressions(ext, path, screenshot) {
    const island = ext.islands[0], airpods = ext.airpods;
    const name = GLib.getenv('NOTCHY_AIRPODS_NAME'), log = `${path}/airpods-calls.log`; GLib.unlink(log);
    const calls = () => { try { return new TextDecoder().decode(GLib.file_get_contents(log)[1]).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
    const fixture = (method, signature = null, values = null) => new Promise((resolve, reject) => Gio.DBus.session.call(name, '/org/costa/AirPods', 'org.notchy.AirPodsFixture', method,
        signature ? new GLib.Variant(signature, values) : null, null, Gio.DBusCallFlags.NONE, 3000, null, (c, r) => { try { c.call_finish(r); resolve(); } catch (e) { reject(e); } }));
    const waitFor = async (condition, ms = 3000) => { for (let i = 0; i < ms / 50 && !condition(); i++) await Scripting.sleep(50); return condition(); };
    const toasts = []; const realToast = island.toast.bind(island);
    island.toast = (icon, text) => { toasts.push(text); realToast(icon, text); };
    ext.settings.set_boolean('hover-open', false);
    let daemon = null;
    try {
        // No backend installed: nothing in the island, a clear status for the settings.
        await Scripting.sleep(300);
        assert(airpods.state === null && airpods.backend === null && ['missing', 'bluez'].includes(airpods.status), `without airpods-helper there is no AirPods state (${airpods.status})`);
        island.open('media'); await Scripting.sleep(500);
        assert(!styled(island.body, 'notchy-airpods-row').length, 'the media tab shows no AirPods without a device');
        island.close(true); await Scripting.sleep(300);
        // The daemon appears: found by its bus name, still without a device.
        daemon = Gio.Subprocess.new(['/usr/bin/python3', here('mock_airpodsd.py'), name, log], Gio.SubprocessFlags.NONE);
        await waitFor(() => airpods.backend === 'airpods-helper');
        assert(airpods.backend === 'airpods-helper' && airpods.status === 'helper' && !airpods.connected, 'the running airpods-helper daemon is detected over D-Bus');
        // Connecting: the capsule grows into a banner; unknown batteries read „–“, never 0 %.
        await fixture('Connect', '(sas)', ['AirPods Pro 2 (USB-C)', ['anc', 'adaptive', 'ca']]);
        await waitFor(() => island.peekKind === 'airpods');
        assert(island.peeking && island.peekKind === 'airpods' && styled(island.body, 'notchy-airpods-card-title')[0]?.text === 'AirPods Pro 2 (USB-C)', 'connecting AirPods grows the island into the connection card with the name');
        const values = () => styled(island.body, 'notchy-airpods-card-value').map(a => a.text), captions = () => styled(island.body, 'notchy-airpods-card-caption').map(a => a.text);
        assert(values().length === 2 && values().every(v => v === '–') && captions().join('|') === 'AirPods|Case', `batteries not reported yet read „–“, not 0 % (${values().join(' ')})`);
        await Scripting.sleep(300);
        const cards = [...island.peekView.cells.values()];
        assert(cards.every(cell => cell.picture.opacity > 0 && cell.picture.get_transition('scale-x') || cell.picture.scale_x === 1), 'the AirPods and the case spring into the card');
        // A system notification arriving with the card waits until the card has been seen.
        const systemSource = MessageTray.getSystemSource();
        const echo = new MessageTray.Notification({source: systemSource, title: 'AirPods Pro verbunden', body: 'Bluetooth'});
        systemSource.addNotification(echo); await Scripting.sleep(200);
        assert(island.peekKind === 'airpods' && echo.acknowledged, 'a notification arriving with the card does not replace it');
        await fixture('Battery', '(iiib)', [80, 75, 60, true]); await Scripting.sleep(500);
        const counting = values()[0];
        assert(/^\d+ %$/.test(counting) && island.peekView.cells.get('buds').progress < 1, `the ring fills and the number counts up (${counting})`);
        await Scripting.sleep(900);
        assert(values().join('|') === '75 %|⚡ 60 %' && island.peekView.cells.get('buds').progress === 1, `both buds share one ring within 10 %, the case charges (${values().join(' ')})`);
        await screenshot('airpods-connected');
        await fixture('Battery', '(iiib)', [90, 60, 60, false]); await Scripting.sleep(300);
        assert(captions().join('|') === 'Links|Rechts|Case' && values().join('|') === '90 %|60 %|60 %', `buds apart by more than 10 % get a ring each (${captions().join(' ')}: ${values().join(' ')})`);
        await screenshot('airpods-connected-split');
        await Scripting.sleep(6500);
        assert(island.peekKind === 'notification' && styled(island.body, 'notchy-peek-title')[0]?.text === 'AirPods Pro verbunden', 'once the card folds away, the held-back notification shows');
        island.close(); echo.destroy(); await Scripting.sleep(500);
        assert(!island.peeking, 'the card and the notification fold away');
        // The media tab: batteries and the noise control of this model.
        island.open('media'); await Scripting.sleep(600);
        const row = styled(island.body, 'notchy-airpods-row')[0];
        await fixture('Battery', '(iiib)', [80, 75, 60, true]); await Scripting.sleep(400);
        const row2 = styled(island.body, 'notchy-airpods-row')[0];
        assert(row2 && styled(row2, 'notchy-airpods-level').map(a => a.text).join('|') === '80 %|75 %|60 %' && styled(row2, 'notchy-airpods-charging').length === 1, 'the media tab lists left, right and case with charging');
        const modeNames = () => styled(island.body, 'notchy-anc-button').filter(b => !b.has_style_class_name('notchy-airpods-disconnect')).map(b => b.accessible_name);
        assert(modeNames().join('|') === 'Geräuschunterdrückung|Transparenz|Adaptiv|Geräuschkontrolle aus|Gesprächserkennung an', `noise control offers this model's modes (${modeNames().join(', ')})`);
        assert(buttons(island.body, 'Geräuschunterdrückung')[0].has_style_class_name('active'), 'the active mode is marked');
        await screenshot('airpods-media');
        buttons(island.body, 'Transparenz')[0].emit('clicked', 1);
        await waitFor(() => airpods.state.anc === 'transparency');
        assert(calls().some(c => c.method === 'SetAncMode' && c.args[0] === 'transparency') && airpods.state.anc === 'transparency', 'choosing Transparenz sets it in the daemon');
        await Scripting.sleep(300);
        assert(buttons(island.body, 'Transparenz')[0]?.has_style_class_name('active'), 'the island follows the daemon\'s PropertiesChanged');
        buttons(island.body, 'Gesprächserkennung an')[0].emit('clicked', 1);
        await waitFor(() => airpods.state.conversation === true);
        assert(calls().some(c => c.method === 'SetConversationalAwareness' && c.args[0] === true), 'conversation awareness can be switched');
        // Frequent daemon chatter that Notchy does not show leaves the island alone.
        const content = island.body.get_first_child();
        await fixture('Talk', '(s)', ['speaking']); await Scripting.sleep(300);
        assert(island.body.get_first_child() === content, 'unshown property changes do not redraw the tab');
        // Ear detection is shown; pausing stays the daemon's job (its setting is switched, no own logic).
        await fixture('Ear', '(bb)', [true, false]); await Scripting.sleep(400);
        const pills = styled(island.body, 'notchy-airpods-battery');
        assert(!pills[0].has_style_class_name('out') && pills[1].has_style_class_name('out'), 'a bud out of the ear is shown dimmed');
        await airpods.setPauseOnRemoval(false); await waitFor(() => airpods.state.pauseOnRemoval === false);
        assert(calls().some(c => c.set === 'PauseOnRemoval' && c.value === false), 'automatic media pause is the daemon\'s own PauseOnRemoval setting');
        island.close(true); await Scripting.sleep(300);
        // With music playing, the AirPods row sits between the transport and the output, all inside the page.
        const player = Gio.Subprocess.new(['/usr/bin/python3', here('mock_mpris.py')], Gio.SubprocessFlags.NONE);
        try {
            await waitFor(() => ext.media.state); island.open('media'); await Scripting.sleep(700);
            const pods = styled(island.body, 'notchy-airpods-row')[0], output = styled(island.body, 'notchy-output-button')[0], play = styled(island.body, 'notchy-play')[0];
            const [, podsY] = pods.get_transformed_position(), [, outputY] = output.get_transformed_position(), [, playY] = play.get_transformed_position(), [, bodyY] = island.body.get_transformed_position();
            assert(playY + play.height <= podsY && podsY + pods.height <= outputY && outputY + output.height <= bodyY + island.body.height + 1, `with music playing the AirPods row fits between transport and output (${Math.round(playY + play.height)} ≤ ${Math.round(podsY)}, ${Math.round(podsY + pods.height)} ≤ ${Math.round(outputY)})`);
            await screenshot('airpods-media-playing');
        } finally { player.force_exit(); island.close(true); await Scripting.sleep(400); }
        // A model with ANC only: no adaptive mode, no conversation awareness.
        await fixture('Drop'); await Scripting.sleep(300);
        await fixture('Connect', '(sas)', ['AirPods Pro', ['anc']]); await Scripting.sleep(500);
        island.close(true); island.open('media'); await Scripting.sleep(600);
        assert(modeNames().join('|') === 'Geräuschunterdrückung|Transparenz|Geräuschkontrolle aus', `unsupported modes are hidden (${modeNames().join(', ')})`);
        // Low battery: one warning, again only after it recovered.
        island.close(true); await Scripting.sleep(200);
        toasts.length = 0;
        await fixture('Battery', '(iiib)', [10, 70, 50, false]); await Scripting.sleep(300);
        await fixture('Battery', '(iiib)', [9, 70, 50, false]); await Scripting.sleep(300);
        assert(toasts.filter(t => t.includes('links: 10 %')).length === 1 && !toasts.some(t => t.includes('links: 9 %')), `a low bud warns once (${toasts.join(' / ')})`);
        await screenshot('airpods-low');
        // Disconnecting.
        await fixture('Drop'); await waitFor(() => !airpods.connected);
        await Scripting.sleep(200);
        assert(!airpods.connected && toasts.some(t => t.endsWith('getrennt')), 'disconnecting is announced');
        island.open('media'); await Scripting.sleep(500);
        assert(styled(island.body, 'notchy-airpods-row')[0]?.has_style_class_name('disconnected') && !styled(island.body, 'notchy-airpods-battery').length && buttons(island.body, 'Verbinden').length === 1,
            'disconnected AirPods leave a compact row with „Verbinden“ and no batteries');
        // Connect and disconnect from the island go through the daemon.
        buttons(island.body, 'Verbinden')[0].emit('clicked', 1); await waitFor(() => airpods.connected);
        assert(calls().some(c => c.method === 'ConnectTo' || c.method === 'Reconnect') && airpods.connected, '„Verbinden“ connects through the daemon');
        const commands = ext.launcher.providers.cmd.search('airpods', {}).map(r => r.title);
        assert(commands.includes('AirPods trennen') && commands.includes('AirPods: Transparenzmodus') && !commands.includes('AirPods verbinden'), `Thunderstorm offers AirPods commands for the connected model (${commands.join(', ')})`);
        island.close(true); await Scripting.sleep(300); island.open('media'); await Scripting.sleep(500);
        buttons(island.body, 'AirPods trennen')[0].emit('clicked', 1); await waitFor(() => !airpods.connected);
        assert(calls().some(c => c.method === 'Disconnect') && !airpods.connected, '„AirPods trennen“ disconnects through it');
        island.close(true); await Scripting.sleep(300);
        // Turning the integration off hides everything; the daemon vanishing too.
        ext.settings.set_boolean('airpods-enabled', false); await Scripting.sleep(300);
        assert(airpods.state === null && airpods.status === 'disabled', 'switching the integration off drops the device');
        ext.settings.set_boolean('airpods-enabled', true); await waitFor(() => airpods.backend === 'airpods-helper');
        daemon.force_exit(); daemon = null; await waitFor(() => airpods.backend === null);
        assert(airpods.backend === null && airpods.state === null, 'the daemon going away is handled');
        // Without the daemon Notchy reads connected AirPods itself over AAP (recorded packets of real AirPods Pro 2).
        const aapLog = GLib.getenv('NOTCHY_AAP_LOG'); GLib.unlink(aapLog);
        const aapPlayer = Gio.Subprocess.new(['/usr/bin/python3', here('mock_mpris.py')], Gio.SubprocessFlags.NONE);
        try {
            await waitFor(() => ext.media.state?.playing);
            island.open('media'); await Scripting.sleep(300);
            airpods.testDevice({address: '68:CA:C4:DE:31:F3', name: 'Matthias’ AirPods Pro', product: 0x2024, connected: true});
            await waitFor(() => airpods.backend === 'aap' && airpods.state.battery.case === 90, 4000);
            const aap = airpods.state;
            assert(aap.backend === 'aap' && aap.name === 'Matthias’ AirPods Pro' && aap.model === 'A3048' && aap.battery.left === 96 && aap.battery.right === 98 && aap.charging.case,
                `without airpods-helper Notchy reads the AirPods over AAP itself (${aap.backend}: ${aap.battery.left}/${aap.battery.right}/${aap.battery.case})`);
            assert(aap.features.includes('anc') && aap.features.includes('adaptive') && aap.features.includes('ca') && airpods.modes.join('|') === 'noise|transparency|adaptive|off', `the model's features come from its product id (${aap.features.join(', ')})`);
            assert(!island.peeking && island.airpodsPending, 'with a tab open the connection card waits');
            island.close(); await waitFor(() => island.peekKind === 'airpods', 2000);
            assert(island.peekKind === 'airpods', 'closing the tab shows the waiting connection card');
            await Scripting.sleep(1300); await screenshot('airpods-aap-card');
            assert(ext.media.state && !ext.media.state.playing && airpods.pausedByEar, 'taking a bud out pauses the music (own ear logic, only without the daemon)');
            await airpods.setAnc('noise'); await waitFor(() => airpods.state.anc === 'noise');
            const sent = new TextDecoder().decode(GLib.file_get_contents(aapLog)[1]).split('\n');
            assert(sent[0] === '00000400010002000000000000000000' && sent.includes('0400040009000d02000000') && airpods.state.anc === 'noise', 'noise control is set over AAP');
            airpods.testDevice(null); await waitFor(() => !airpods.connected);
            assert(!airpods.aap && airpods.backend === null, 'disconnecting ends the AAP reader');
            island.close(true);
        } finally { aapPlayer.force_exit(); await Scripting.sleep(300); }
        // Repeated disable and enable leave nothing behind.
        for (let i = 0; i < 3; i++) { const life = ext.life; ext.disable(); assert(life.closed && life.sources.size === 0, `disable ${i + 1} removes timers and signals`); ext.enable(); await Scripting.sleep(300); }
        assert(ext.islands.length === 1 && ext.airpods && ext.launcher && ext.files, 'the extension re-enables with its new services');
    } finally {
        island.toast = realToast; try { daemon?.force_exit(); } catch { /* Gone. */ }
        ext.settings?.set_boolean('hover-open', true);
    }
}
