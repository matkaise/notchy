# Smart Live Activities and the Agent Control Center

Notchy keeps everything that runs right now in one place, the **Activity Manager**, decides what the closed notch shows, puts further important activities beside it and lists all of them in the island's **Activities** tab (key 5). The AI agent integration feeds the same manager; its own service keeps the session lifecycle and the hooks.

## Architecture

```
 data sources                     Activity Manager                       display
 ─────────────                    ────────────────                       ───────
 agents.js (hooks, notchyctl,  ┐
   MCP)                        │   activities.js (GNOME)                 island.js        closed notch: the focus
 productivity.js (set_activity)│     collectors → ActivityStore.sync()   activityBubble   indicators beside it
 operations.js (Notchy's       │                                         activityViews    Activities tab, Agent
   file work, measured)        ├──►  activityModel.js (pure)                                Control Center
 airdrop.js, media.js          │       ActivityStore  lifecycle, linger,  agentBubble.js   per-agent popup
 GNOME screen recorder         │                      expiry                              (sessions)
 timers.js (deadlines)         │       groupEntries   summarising
 launcherEntry.js (other apps' │       Arbiter        priority, minimum   interactions:
   LauncherEntry progress)     │                      time, hysteresis    activities.invoke(id, action)
 airpods.js                    │                                          → the owning source
 ReportActivity / notchyctl    ┘
   live / MCP live_activity
```

- **Data sources** keep their own state and lifecycle. The agent service owns sessions, hook events, liveness and agent-specific actions (switching windows); timers own their deadlines; the file operations own their processes. The manager never keeps a second status model or a second clock for them.
- **Collectors** (`src/services/activities.js`) translate a source's current state into activities. A source change marks it dirty; all dirty sources are collected in one idle pass, so a burst of hook events or MPRIS chatter costs one refresh. A collector that throws drops only its own activities and logs a warning — GNOME Shell is not affected.
- **ActivityStore** (`src/services/activityModel.js`, pure, Node-tested) holds one record per activity and reports transitions (`appeared`, `completed`, `failed`, `removed`). A finished activity lingers (Settings → Live Activities, default 4 s; failures at least 20 s), also when its source no longer reports it, and does not come back once it expired. An activity a source drops while it still runs is removed at once: Notchy never claims something finished.
- **groupEntries** summarises activities of the same type and class („2 transfers“, „2 agents waiting“). A group shows a combined percentage only when every member reports its size, so the sum is exact.
- **Arbiter** chooses the entry for the closed notch (below).
- **One timeout** wakes the manager when a lingering activity expires or a waiting entry's turn comes; nothing polls. A second hand runs only while a timer or recording is visible (in the notch, beside it or in the open tab).

## Activity model

| Field | Meaning |
|---|---|
| `id`, `type` | unique id; `transfer`, `operation`, `airdrop`, `timer`, `recording`, `agent`, `media`, `accessory`, `custom` |
| `name`, `icon`, `description` | what is shown; `app` (desktop id) gives the app's icon |
| `state` | `running`, `waiting`, `paused`, `completed`, `error` |
| class (priority) | derived: `attention` (waiting), `error`, `completed`, else by type: `transfer`, `timer` (timers and recordings), `media`, `background` |
| `progress` | 0–1 **only when measured**, else `null` (no bar, no percentage) |
| `started`, `deadline` / `left` | start time; a countdown's deadline, or the time left while paused; `estimate` marks a reporter's guess (shown as `~4:10`) |
| `actions` | e.g. pause, resume, cancel, stop, switch, play/pause, and actions external apps declare |
| `updated`, `finishedAt`, `expires` | last change, end, lifetime of external reports |

### Where progress comes from

| Source | Progress | Notes |
|---|---|---|
| Notchy's copy, ZIP, ZIP of a selection | bytes read / total | `helper/operations.py` prints `progress 0.42` lines (throttled) |
| Notchy's video compression | FFmpeg's `out_time` / video length, two passes | |
| Image/PDF/Office conversion, OCR, background removal | none | the external tools report nothing; shown without a bar |
| AirDrop receiving | the backend's percentage | sending shows the peer, no percentage |
| Files (copies, moves, compressing) and other apps that publish it (Transmission …) | what the app publishes through `com.canonical.Unity.LauncherEntry` | event-driven broadcast signal, the same docks listen to; no file names, no polling. Measured with Ubuntu's Files 50: it publishes only while one of its windows is open and only for operations that take longer than about 1.4 s (shorter ones are never shown), with values such as 0.54 → 0.62 → 0.77 → 1. 100 % counts as finished at once (Files keeps it visible about 3.6 s longer); hidden half-way it just leaves (a cancel is no success); an app that quits takes its entry along; 30 min without an update is no longer believed |
| Timers | elapsed share of an exact deadline | |
| Agents | only what the agent reports (`notchyctl agent update --progress`, MCP) | hooks carry no progress |
| `set_activity` / `notchyctl activity` | its value if above 0 | these APIs default to 0, so 0 means „unknown“ |

Not supported: browser downloads. Chrome loads its LauncherEntry support (libunity) only under the Unity desktop or KDE — on Ubuntu's GNOME session the library is not loaded (checked on Chrome 155's running browser process) — and Firefox has no such support at all (from its sources). Watching the Downloads folder for the browsers' temporary files would work, but was left out deliberately; a browser extension with the downloads permission and native messaging would be the clean way and is not built. Also not supported: Files operations shorter than about 1.4 s or without an open Files window, `wget`/`curl` in a terminal (report them yourself, see the examples), apps that publish no progress at all. Notchy never reads other programs' files, windows or processes for progress.

## Priorities and the closed notch

Default order (Settings → Live Activities → Priorities, stored in `activities-priority`):

1. `attention` — needs you (an agent waiting for an approval or an answer)
2. `error` — failed
3. `completed` — just finished
4. `transfer` — downloads, file work, AirDrop
5. `timer` — timers and screen recordings
6. `media` — music
7. `background` — other running activities (a working agent is shown by its own indicator instead)

The Arbiter's rules:

- The best-ranked entry wins; within a class the newest.
- **Minimum display time** (3 s): the entry shown keeps the notch that long; a better one waits and the manager wakes exactly when its turn comes.
- **Urgent** entries (`attention`, `error`) show at once, whatever the minimum time.
- **Hysteresis**: an entry of the same rank never takes over from the one shown, so two downloads do not take turns and flapping states do not make the notch jump.
- **Return**: when the shown entry goes, the notch goes back to the entry it interrupted if that is still among the best.
- HUD (volume/brightness), toasts, the AirPods pill and notification banners still borrow the notch for a moment, above any activity, as before; they are transient and never enter the list.

What the closed notch draws: a transfer's symbol, bar and percentage (or just its name without a measured progress), a timer's remaining time, a red dot and running time while recording, an agent's symbol and „wartet auf dich“, a green check when something finished, a red symbol with a short shake on failure, music as cover and waveform. More important activities that are not the focus appear as small round indicators beside the notch (their ring fills only with measured progress); a click opens the Activities tab. The notch's width follows its content and it stays centred; indicators keep both sides equally wide (`src/ui/sideLayout.js`).

With **Smart Live Activities off** the notch behaves exactly as before (music, `set_activity` text, „Wird verarbeitet …“, AirDrop); the Activities tab stays available.

## Agent Control Center

The agent service (`src/services/agents.js`, `agentModel.js`) is unchanged in its job; new are:

- **Indicators** beside the notch keep their states and animations: working (a turning arc, or a filling ring with real progress), waiting (orange ring that pulses a few times, „?“), completed (green ✓ with a short bounce), error (red, „!“), idle (static ring, can be hidden), disconnected (fades out). Waiting agents are kept visible when room is short; a global position (automatic, left, right) and a maximum number of visible indicators can be set; the rest joins the „+N“ group. A side once chosen is kept.
- **Popup per agent** (click its indicator): every session with project, state, current step (the tool it runs, the approval it waits for), real progress, running time and last activity, the interaction it needs, and „Wechseln“; „Alle Agenten und Aktivitäten“ opens the tab.
- **Overview** in the Activities tab: every agent with its sessions, ended sessions for a configurable time (Settings → Agents, default 10 min), updated in place without losing the keyboard focus.
- **Switching** to an agent brings its window forward only when it is unambiguous: the only window of the nearest process ancestor owning windows, or the only one of them whose title names the session's project folder.
- **Notifications** when an agent needs you (default on), finished (off) or failed (on), optionally with a sound, through GNOME's message tray (Do Not Disturb applies) and Notchy's banner. Not while the agent's own window has the focus. They carry the agent's name, the project folder's name and the state — never a prompt, a tool input or anything the agent wrote. A click switches to the agent.
- **Late, duplicate or out-of-order hook events** and crashed agents are handled by the agent model as before (tombstones, ranks, process checks); the activities follow its state.

### Supported agents

| Agent | Status | Waiting | Answering from Notchy |
|---|---|---|---|
| Claude Code | hooks (`~/.claude/settings.json`) | exact (PermissionRequest, Notification, Elicitation) | not implemented, see below |
| Codex CLI | hooks (`~/.codex/hooks.json`, trusted with `/hooks`) | PermissionRequest | not implemented |
| Antigravity | hooks (`~/.gemini/config/hooks.json`) | no event for it | — |
| Anything else | `notchyctl agent …`, MCP `agent_status` | as reported | — |

**Confirmations.** Claude Code's `PermissionRequest` hook can return a decision (`allow`/`deny`) — an official interface. Using it would mean Notchy's hook holds the agent until you answer in the notch; until then the agent's own dialog would not appear in the terminal, and a slow or absent answer would stall it until the hook's timeout. Codex and Antigravity offer no comparable path that could be verified here. Notchy therefore answers nothing itself: it shows what the agent waits for and switches to its window, where you confirm as usual. No simulated keystrokes, no automatic approvals.

## Interfaces

All on the user's session bus (`org.gnome.Shell.Extensions.Notchy`, `/org/gnome/Shell/Extensions/Notchy`); Notchy opens no network port. Existing methods (`SetActivity`, `ClearActivity`, `GetActivities`, `AgentEvent`, `AgentHook`, `GetAgents`, …) are unchanged.

| Method / signal | |
|---|---|
| `ReportActivity(s json) → s error` | add or update an activity of your own; `''` on success, else the reason |
| `EndActivity(s id) → b` | remove it |
| `GetLiveActivities() → s json` | `{enabled, focus: {key, ids}, activities: [{id, type, class, priority, name, description, state, progress, started, updated, remaining, estimate, app, actions, source}]}` |
| `InvokeActivity(s id, s action) → s error` | run an action (`pause`, `resume`, `cancel`, `stop`, `dismiss`, `switch`, or a declared one) |
| `Timer(s json) → s json` | `{action: "start", duration: "25m", name}`, `{action: "start", pomodoro: true}`, `{action: "pause"|"resume"|"cancel", id}`, `{action: "list"}` |
| signal `LiveActivitiesChanged(s json)` | the same JSON as `GetLiveActivities` after each change |
| signal `ActivityAction(s id, s action)` | an action you declared was chosen in Notchy |

`ReportActivity` fields: `id` (required, `[A-Za-z0-9][A-Za-z0-9._:@-]{0,95}`), `name` (required, ≤ 60), `type` (`transfer`, `operation`, `timer`, `recording`, `custom`; default `custom`), `state` (default `running`), `progress` (0–1, a number, only when measured), `total` (bytes, so several transfers add up exactly), `remaining` (seconds; shown as an estimate), `description` (≤ 140), `icon` (a themed icon name), `app` (`name.desktop`), `actions` (≤ 3 × `{id, label}`; reserved ids are refused), `ttl` (5–86400 s, default 3600: it disappears when you stop reporting). At most 24 activities from other apps.

### Examples

```sh
# A download in a script, with real progress and its size
scripts/notchyctl live report --id iso --name 'Ubuntu ISO' --type transfer --progress 0.68 --total 6114656256
scripts/notchyctl live report --id iso --name 'Ubuntu ISO' --type transfer --state completed
# A build without measurable progress, with an action you handle yourself
scripts/notchyctl live report --id build --name 'Build' --type operation --status 'Tests laufen' --action log:Log --ttl 600
scripts/notchyctl live watch          # prints {"id": "build", "action": "log"} when chosen in Notchy
scripts/notchyctl live end build
scripts/notchyctl live list
# Timers
scripts/notchyctl timer start 25m --name 'Fokus'
scripts/notchyctl timer pomodoro
scripts/notchyctl timer pause
scripts/notchyctl timer list
```

A script that measures its own progress reports it every second or so (each report renews its lifetime); there is no need to report more often.

Python over D-Bus:

```python
from gi.repository import Gio, GLib
import json
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
def report(**fields):
    reply = bus.call_sync('org.gnome.Shell.Extensions.Notchy', '/org/gnome/Shell/Extensions/Notchy', 'org.gnome.Shell.Extensions.Notchy',
                          'ReportActivity', GLib.Variant('(s)', (json.dumps(fields),)), None, Gio.DBusCallFlags.NONE, 3000, None)
    if reply.unpack()[0]:
        raise ValueError(reply.unpack()[0])
report(id='render', name='Render', type='operation', progress=0.25, remaining=90)
```

MCP (`helper/mcp_server.py`): `live_activity` (`id`, `name`, optional `type`, `state`, `progress`, `remaining`, `description`, `ttl`) and `live_activity_end` (`id`), besides the existing `set_activity`, `agent_status`, `agent_end`.

Apps that already publish LauncherEntry progress need nothing: Notchy shows it.

## Adding a new activity type

1. Add the type to `TYPES` in `activityModel.js` (and to `EXTERNAL_TYPES` if other apps may report it), its base class in `BASE`, a label in `TYPE_TEXT`, a symbol in `TYPE_ICON` (`activityViews.js`).
2. Write a collector in `activities.js` that maps the source's state to `activity({...})` records (real progress or `null`), and subscribe to the source in the constructor (`watch(service, 'name')`).
3. Handle its actions in `Activities.invoke` by calling the source.
4. If it needs a special look in the closed notch, add a branch to `compactParts` (keys must stay stable for updates).
5. Add it to the types list in `prefs.js`, the translations (`python3 scripts/i18n.py update`, then `po/de.po`) and tests (`tests/activities.test.js`; a Shell check in `activityRegressions`).

## Settings

Live Activities page: on/off, further activities beside the notch, summarising, animations, how long finished activities stay, a sound when a timer runs out, each type on/off, the priority order (with reset), Pomodoro lengths. Agents page: position of the indicators (automatic, left, right; a side per agent wins), maximum visible indicators (0 = as many as fit), how long ended sessions stay listed, notifications per state and their sound — besides the existing per-agent switches, sides and hook setup. Everything is translated (German, English). Existing settings keep their values; new ones start with the defaults above.

## Privacy

Everything stays local. Only status metadata is processed: an agent's name, session id, event, a tool's name, the project folder's name; for other apps the fraction they publish and their desktop id. Hook adapters never forward prompts, tool arguments, answers or transcripts (see `helper/agent_hook.py`), notifications show only the metadata above, and nothing is sent anywhere. Hook setup still adds Notchy's entries beside existing ones and removes exactly them (`notchyctl agent hooks uninstall`); turning agents or activities off in the settings stops showing them at once.
