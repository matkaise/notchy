#!/usr/bin/python3
"""Notchy's silent status line for Claude Code: its usage limits.

Claude Code hands its status line command a JSON description of the session
on stdin; for Pro, Max and Ultra plans it includes the 5-hour and weekly
limits (rate_limits.five_hour / seven_day: used_percentage, resets_at). This
keeps exactly those numbers in ~/.cache/notchy/agent-usage-claude.json, where
Notchy reads them, and prints nothing — the status line stays empty. Nothing
else of the session (model, cost, folders, transcript) is read further or
kept. Set up by agent_setup.py only where no status line exists yet.

It never fails Claude Code: it always exits 0, quickly.
"""
import json
import os
import sys
import tempfile
import time

MAX_INPUT = 256 * 1024
WINDOWS = {'five_hour': 'fiveHour', 'seven_day': 'week'}


def limits(payload):
    """{'fiveHour': {'used', 'resetsAt'}, 'week': {…}} from the status line JSON, or None."""
    rate = payload.get('rate_limits') if isinstance(payload, dict) else None
    if not isinstance(rate, dict):
        return None
    out = {}
    for key, name in WINDOWS.items():
        window = rate.get(key)
        if not isinstance(window, dict):
            continue
        used = window.get('used_percentage')
        if isinstance(used, bool) or not isinstance(used, (int, float)):
            continue
        resets = window.get('resets_at')
        out[name] = {'used': max(0.0, min(100.0, float(used))),
                     'resetsAt': int(resets) if isinstance(resets, (int, float)) and not isinstance(resets, bool) and resets > 0 else None}
    return out or None


def path():
    folder = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'), 'notchy')
    return os.path.join(folder, 'agent-usage-claude.json')


def save(found, now=None, target=None):
    target = target or path()
    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=os.path.dirname(target), prefix='.agent-usage-')
    try:
        with os.fdopen(handle, 'w') as out:
            json.dump({'time': int(now or time.time()), **found}, out)
        os.replace(temp, target)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def main(stdin=sys.stdin):
    raw = stdin.read(MAX_INPUT + 1)
    if not raw or len(raw) > MAX_INPUT:
        return 0
    try:
        found = limits(json.loads(raw))
    except ValueError:
        return 0
    if found:
        save(found)
    return 0


if __name__ == '__main__':
    try:
        main()
    except Exception:  # Never fail Claude Code's status line.
        pass
    sys.exit(0)
