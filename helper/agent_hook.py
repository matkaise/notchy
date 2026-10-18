#!/usr/bin/python3
"""Notchy's hook adapter for AI agents: Claude Code, Codex and Antigravity.

An agent runs this for its lifecycle hooks (session start, prompt, tool use,
approval, stop, session end) with the hook's JSON on stdin. The adapter keeps
only what a status needs — the event's name, the session or conversation id,
a tool's name, the project folder's name — adds the agent's process id (so
Notchy notices a crashed agent) and hands it to Notchy over the session bus
(org.gnome.Shell.Extensions.Notchy.AgentHook). Prompts, tool inputs, answers,
transcripts and file contents are never read further, kept or sent.

It never slows the agent down or changes what it does: it answers at once
(Antigravity's hooks expect a JSON object, the others nothing) and talks to
Notchy in a detached child; it always exits 0, and when Notchy is not running
the event is simply dropped.

usage: agent_hook.py claude|codex|antigravity
NOTCHY_AGENT_HOOK_DRYRUN=1 prints the message instead of sending it (tests).
"""
import json
import os
import sys
import time

BUS = 'org.gnome.Shell.Extensions.Notchy'
PATH = '/org/gnome/Shell/Extensions/Notchy'
PROVIDERS = ('claude', 'codex', 'antigravity')
# Processes between the agent and this script that are not the agent itself.
WRAPPERS = {'sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'env', 'timeout', 'nice', 'nohup', 'setsid', 'python3', 'python', 'agent_hook.py', 'flock', 'stdbuf'}
MAX_INPUT = 1024 * 1024
# The payload fields kept (everything else is dropped unread).
NOTIFICATION_TYPES = {'permission_prompt', 'idle_prompt', 'elicitation_dialog', 'auth_success', 'elicitation_complete', 'elicitation_response'}


def text(value, limit):
    return value[:limit] if isinstance(value, str) else ''


def reduce(payload):
    """The few fields Notchy needs from a hook payload."""
    if not isinstance(payload, dict):
        return None
    name = text(payload.get('hook_event_name') or payload.get('hookEventName'), 40)
    session = text(payload.get('session_id') or payload.get('conversationId') or payload.get('sessionId'), 128)
    if not name or not session:
        return None
    folder = payload.get('cwd')
    if not isinstance(folder, str):
        paths = payload.get('workspacePaths')
        folder = paths[0] if isinstance(paths, list) and paths and isinstance(paths[0], str) else ''
    tool = payload.get('tool_name')
    if not isinstance(tool, str) and isinstance(payload.get('toolCall'), dict):
        tool = payload['toolCall'].get('name')
    out = {'hook_event_name': name, 'session_id': session, 'project': os.path.basename(folder.rstrip('/'))[:60]}
    if isinstance(tool, str):
        out['tool_name'] = tool[:40]
    if payload.get('notification_type') in NOTIFICATION_TYPES:
        out['notification_type'] = payload['notification_type']
    if isinstance(payload.get('fullyIdle'), bool):
        out['fullyIdle'] = payload['fullyIdle']
    if name == 'Stop' and payload.get('error'):
        out['error'] = True
    return out


def stat(pid):
    """(command name, parent pid, start time) from /proc, or None."""
    try:
        with open(f'/proc/{pid}/stat', encoding='utf-8', errors='replace') as source:
            data = source.read()
    except OSError:
        return None
    name = data[data.index('(') + 1:data.rindex(')')]
    fields = data[data.rindex(')') + 2:].split()
    return name, int(fields[1]), fields[19]


def agent_process(start=None):
    """The agent's own process (the first ancestor that is not a shell or
    wrapper) and the chain of ancestors, for crash detection and windows."""
    pid, agent, ancestors = start or os.getppid(), None, []
    for _ in range(16):
        info = stat(pid)
        if not info or pid <= 1:
            break
        name, parent, started = info
        ancestors.append(pid)
        if agent is None and name not in WRAPPERS:
            agent = (pid, started)
        pid = parent
    return agent, ancestors


def message(provider, payload, now=None):
    reduced = reduce(payload)
    if reduced is None:
        return None
    agent, ancestors = agent_process()
    reduced['time'] = int((now or time.time()) * 1000)
    if agent:
        reduced['pid'], reduced['pidStart'] = agent
    reduced['ancestors'] = ancestors
    return reduced


def send(provider, reduced):
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    bus.call_sync(BUS, PATH, BUS, 'AgentHook', GLib.Variant('(ss)', (provider, json.dumps(reduced))),
                  GLib.VariantType('(s)'), Gio.DBusCallFlags.NO_AUTO_START, 2000, None)


def main(argv=sys.argv, stdin=sys.stdin, stdout=sys.stdout):
    provider = argv[1] if len(argv) > 1 else ''
    if provider not in PROVIDERS:
        sys.stderr.write('usage: agent_hook.py claude|codex|antigravity\n')
        return 0
    try:
        raw = stdin.read(MAX_INPUT + 1)
        payload = json.loads(raw) if raw and len(raw) <= MAX_INPUT else None
    except (ValueError, OSError):
        payload = None
    # Antigravity's hooks answer with a JSON object; an empty one changes nothing.
    if provider == 'antigravity':
        stdout.write('{}\n')
    stdout.flush()
    reduced = message(provider, payload)
    if reduced is None:
        return 0
    if os.environ.get('NOTCHY_AGENT_HOOK_DRYRUN'):
        stdout.write(json.dumps({'provider': provider, **reduced}) + '\n')
        return 0
    try:
        child = os.fork()
    except OSError:
        child = 0
        return 0
    if child:
        return 0
    # The detached child: the agent's pipes are closed, so it never waits for it.
    try:
        os.setsid()
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        send(provider, reduced)
    except Exception:  # Notchy not running, no session bus: the event is dropped.
        pass
    finally:
        os._exit(0)


if __name__ == '__main__':
    try:
        code = main()
    except Exception:  # Never fail the agent's hook.
        code = 0
    sys.exit(code)
