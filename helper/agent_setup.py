#!/usr/bin/python3
"""Sets up Notchy's hook adapter (agent_hook.py) in the agents' own hook
configuration — only when the user asks for it (notchyctl agent hooks
install, or the button in Notchy's settings).

Existing hooks are never removed or changed: Notchy's entries are recognised
by the adapter's file name and added beside the others; uninstalling removes
exactly those. Before a file is changed, a dated copy is kept next to it. A
file that is not valid JSON is left alone.

  Claude Code   ~/.claude/settings.json ("hooks", per event a matcher group)
  Codex         ~/.codex/hooks.json (same layout; Codex runs new hooks only
                after they are reviewed and trusted with /hooks)
  Antigravity   ~/.gemini/config/hooks.json (a named hook "notchy")
"""
import json
import os
from pathlib import Path
import shlex
import shutil
import tempfile
import time

ADAPTER = Path(__file__).resolve().parent / 'agent_hook.py'
MARKER = 'agent_hook.py'
NAME = 'notchy'
EVENTS = {
    'claude': ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'],
    'codex': ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'],
    'antigravity': ['SessionStart', 'PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop'],
}
# Antigravity's tool events take a matcher group; its other events take handlers directly.
MATCHED = {'claude': None, 'codex': None, 'antigravity': {'PreToolUse', 'PostToolUse'}}
PROGRAMS = {'claude': ['claude'], 'codex': ['codex'], 'antigravity': ['antigravity', 'agy']}
LABELS = {'claude': 'Claude Code', 'codex': 'Codex', 'antigravity': 'Antigravity'}


def config_path(provider, home=None):
    home = Path(home or os.path.expanduser('~'))
    if provider == 'claude':
        return Path(os.environ.get('CLAUDE_CONFIG_DIR') or home / '.claude') / 'settings.json'
    if provider == 'codex':
        return Path(os.environ.get('CODEX_HOME') or home / '.codex') / 'hooks.json'
    if provider == 'antigravity':
        return home / '.gemini' / 'config' / 'hooks.json'
    raise ValueError(provider)


def command(provider, adapter=ADAPTER):
    return f'/usr/bin/python3 {shlex.quote(str(adapter))} {provider}'


def handler(provider, event, adapter=ADAPTER):
    timeout = 2 if event in ('SessionEnd', 'Interrupt') else 5
    return {'type': 'command', 'command': command(provider, adapter), 'timeout': timeout}


def ours(entry):
    return isinstance(entry, dict) and MARKER in str(entry.get('command', ''))


def load(path):
    """(data, error): {} for a missing file, an error for one that is not a JSON object."""
    try:
        text = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        return {}, ''
    except OSError as error:
        return None, str(error)
    if not text.strip():
        return {}, ''
    try:
        data = json.loads(text)
    except ValueError as error:
        return None, f'{path} ist kein gültiges JSON ({error})'
    if not isinstance(data, dict):
        return None, f'{path} enthält kein JSON-Objekt'
    return data, ''


def strip(provider, data):
    """The configuration without Notchy's entries; everything else unchanged."""
    data = json.loads(json.dumps(data))
    if provider == 'antigravity':
        data.pop(NAME, None)
        return data
    hooks = data.get('hooks')
    if not isinstance(hooks, dict):
        return data
    for event in list(hooks):
        groups = hooks[event]
        if not isinstance(groups, list):
            continue
        kept = []
        for group in groups:
            if isinstance(group, dict) and isinstance(group.get('hooks'), list):
                remaining = [h for h in group['hooks'] if not ours(h)]
                if not remaining and len(remaining) != len(group['hooks']):
                    continue
                group = {**group, 'hooks': remaining}
            kept.append(group)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not hooks:
        data.pop('hooks', None)
    return data


def add(provider, data, adapter=ADAPTER):
    data = strip(provider, data)
    if provider == 'antigravity':
        entry = {}
        for event in EVENTS[provider]:
            h = handler(provider, event, adapter)
            entry[event] = [{'matcher': '*', 'hooks': [h]}] if event in MATCHED[provider] else [h]
        data[NAME] = entry
        return data
    hooks = data.setdefault('hooks', {})
    if not isinstance(hooks, dict):
        raise ValueError('"hooks" ist kein Objekt; Notchy ändert die Datei nicht')
    for event in EVENTS[provider]:
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            raise ValueError(f'"hooks.{event}" ist keine Liste; Notchy ändert die Datei nicht')
        groups.append({'hooks': [handler(provider, event, adapter)]})
    return data


def installed_events(provider, data):
    if not isinstance(data, dict):
        return set()
    if provider == 'antigravity':
        entry = data.get(NAME)
        if not isinstance(entry, dict) or entry.get('enabled') is False:
            return set()
        found = set()
        for event, items in entry.items():
            for item in items if isinstance(items, list) else []:
                handlers = item.get('hooks', []) if isinstance(item, dict) and 'hooks' in item else [item]
                if any(ours(h) for h in handlers):
                    found.add(event)
        return found
    hooks = data.get('hooks') if isinstance(data.get('hooks'), dict) else {}
    return {event for event, groups in hooks.items() if isinstance(groups, list)
            and any(isinstance(g, dict) and any(ours(h) for h in g.get('hooks', []) if isinstance(g.get('hooks'), list)) for g in groups)}


def program(provider):
    for name in PROGRAMS[provider]:
        found = shutil.which(name) or (f'/snap/bin/{name}' if os.path.exists(f'/snap/bin/{name}') else None)
        if found:
            return found
    return ''


def status(provider, home=None):
    path = config_path(provider, home)
    data, error = load(path)
    events = installed_events(provider, data) if data is not None else set()
    wanted = set(EVENTS[provider])
    state = 'error' if error else 'installed' if wanted <= events else 'partial' if events else 'missing'
    note = 'Codex führt neue Hooks erst aus, nachdem du sie in Codex mit /hooks geprüft und freigegeben hast.' if provider == 'codex' else ''
    return {'provider': provider, 'name': LABELS[provider], 'state': state, 'config': str(path), 'program': program(provider),
            'events': sorted(events), 'missing': sorted(wanted - events), 'error': error, 'note': note, 'lastFailure': last_failure(provider)}


def last_failure(provider, cache=None):
    """The adapter's last delivery failure for this agent (agent_hook.note), if any."""
    folder = Path(cache or os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache')) / 'notchy'
    try:
        failure = json.loads((folder / 'agent-hook-error.json').read_text())
    except (OSError, ValueError):
        return None
    return failure if isinstance(failure, dict) and failure.get('provider') == provider else None


def write(path, data):
    """A dated copy of the old file, then an atomic replace with the same permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = ''
    mode = 0o600
    if path.exists():
        mode = path.stat().st_mode & 0o777
        backup = f'{path}.notchy-backup-{time.strftime("%Y%m%d-%H%M%S")}'
        shutil.copy2(path, backup)
    handle, temp = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as out:
            json.dump(data, out, indent=2, ensure_ascii=False)
            out.write('\n')
        os.chmod(temp, mode)
        os.replace(temp, path)
    except BaseException:
        os.unlink(temp)
        raise
    return backup


def install(provider, home=None, dry_run=False, adapter=ADAPTER):
    path = config_path(provider, home)
    data, error = load(path)
    if error:
        return {'ok': False, 'error': error, 'config': str(path)}
    try:
        updated = add(provider, data, adapter)
    except ValueError as failure:
        return {'ok': False, 'error': str(failure), 'config': str(path)}
    if dry_run:
        return {'ok': True, 'config': str(path), 'preview': updated, 'changed': updated != data}
    backup = write(path, updated) if updated != data else ''
    return {'ok': True, 'config': str(path), 'backup': backup, 'changed': updated != data}


def uninstall(provider, home=None, dry_run=False):
    path = config_path(provider, home)
    data, error = load(path)
    if error:
        return {'ok': False, 'error': error, 'config': str(path)}
    if not path.exists():
        return {'ok': True, 'config': str(path), 'changed': False}
    updated = strip(provider, data)
    if dry_run:
        return {'ok': True, 'config': str(path), 'preview': updated, 'changed': updated != data}
    backup = write(path, updated) if updated != data else ''
    return {'ok': True, 'config': str(path), 'backup': backup, 'changed': updated != data}
