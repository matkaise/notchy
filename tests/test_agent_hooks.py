"""Notchy's agent hook adapter and its setup: private data never leaves the
hook, other hooks are never touched, every change is reversible."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

HELPER = Path(__file__).parent.parent / 'helper'


def load(name):
    spec = importlib.util.spec_from_file_location(name, HELPER / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = load('agent_hook')
setup = load('agent_setup')


class AdapterTest(unittest.TestCase):
    def test_only_status_fields_leave_the_hook(self):
        payload = {'hook_event_name': 'PreToolUse', 'session_id': 'abc', 'cwd': '/home/m/Projekte/Notchy', 'transcript_path': '/home/m/.claude/x.jsonl',
                   'prompt': 'my secret prompt', 'tool_name': 'Bash', 'tool_input': {'command': 'cat ~/.ssh/id_rsa'}, 'last_assistant_message': 'private answer'}
        reduced = hook.reduce(payload)
        self.assertEqual(reduced, {'hook_event_name': 'PreToolUse', 'session_id': 'abc', 'project': 'Notchy', 'tool_name': 'Bash'})
        text = json.dumps(hook.message('claude', payload))
        for secret in ('secret', 'id_rsa', 'private', 'transcript', '/home/m/Projekte'):
            self.assertNotIn(secret, text)

    def test_antigravity_and_codex_payloads(self):
        self.assertEqual(hook.reduce({'hookEventName': 'Stop', 'conversationId': 'c1', 'workspacePaths': ['/w/app/'], 'fullyIdle': True, 'error': 'boom'}),
                         {'hook_event_name': 'Stop', 'session_id': 'c1', 'project': 'app', 'fullyIdle': True, 'error': True})
        self.assertEqual(hook.reduce({'hook_event_name': 'PostToolUse', 'conversationId': 'c1', 'toolCall': {'name': 'run_command', 'args': {'CommandLine': 'x'}}})['tool_name'], 'run_command')
        self.assertIsNone(hook.reduce({'hook_event_name': 'Stop'}))
        self.assertIsNone(hook.reduce('nonsense'))
        self.assertNotIn('notification_type', hook.reduce({'hook_event_name': 'Notification', 'session_id': 's', 'notification_type': '<script>'}))

    def test_the_agent_process_and_its_ancestors(self):
        agent, ancestors = hook.agent_process(os.getpid())
        self.assertEqual(ancestors[0], os.getpid())
        self.assertTrue(agent is None or isinstance(agent[0], int))
        self.assertEqual(hook.stat(os.getpid())[1], os.getppid())
        self.assertIsNone(hook.stat(2 ** 22 + 12345))

    def test_the_adapter_answers_at_once_and_never_fails(self):
        env = {**os.environ, 'NOTCHY_AGENT_HOOK_DRYRUN': '1'}
        for provider, payload, expected in [('antigravity', {'hookEventName': 'PreInvocation', 'conversationId': 'g'}, '{}'),
                                            ('claude', {'hook_event_name': 'Stop', 'session_id': 's'}, '')]:
            started = time.monotonic()
            run = subprocess.run([sys.executable, str(HELPER / 'agent_hook.py'), provider], input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=10)
            self.assertEqual(run.returncode, 0)
            lines = run.stdout.splitlines()
            if expected:
                self.assertEqual(lines[0], expected, 'Antigravity gets an empty decision object')
            sent = json.loads(lines[-1])
            self.assertEqual((sent['provider'], sent['session_id']), (provider, payload.get('session_id') or payload.get('conversationId')))
            self.assertLess(time.monotonic() - started, 3)
        for args, stdin in [(['claude'], 'not json'), (['unknown'], '{}'), ([], '')]:
            run = subprocess.run([sys.executable, str(HELPER / 'agent_hook.py'), *args], input=stdin, capture_output=True, text=True, env=env, timeout=10)
            self.assertEqual(run.returncode, 0, 'a broken payload never fails the agent')
        # Without NOTCHY_AGENT_HOOK_DRYRUN and without Notchy on the bus: still exit 0, quickly.
        with tempfile.TemporaryDirectory() as cache:
            quiet = {k: v for k, v in os.environ.items() if k != 'NOTCHY_AGENT_HOOK_DRYRUN'}
            quiet['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/nonexistent/notchy-test-bus'
            quiet['XDG_CACHE_HOME'] = cache
            run = subprocess.run([sys.executable, str(HELPER / 'agent_hook.py'), 'codex'], input='{"hook_event_name":"Stop","session_id":"secret-session"}', capture_output=True, text=True, env=quiet, timeout=10)
            self.assertEqual((run.returncode, run.stdout), (0, ''))
            # The detached child notes why the event was dropped, without the payload.
            note = Path(cache) / 'notchy' / 'agent-hook-error.json'
            for _ in range(50):
                if note.exists() and note.stat().st_size:
                    break
                time.sleep(0.1)
            failure = json.loads(note.read_text())
            self.assertEqual((failure['provider'], failure['bus']), ('codex', True))
            self.assertTrue(failure['error'])
            self.assertNotIn('secret-session', note.read_text())


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.env = {k: os.environ.pop(k, None) for k in ('CLAUDE_CONFIG_DIR', 'CODEX_HOME')}

    def tearDown(self):
        for key, value in self.env.items():
            if value is not None:
                os.environ[key] = value
        self.temp.cleanup()

    def test_claude_hooks_are_added_beside_existing_ones_and_removed_exactly(self):
        path = self.home / '.claude' / 'settings.json'
        path.parent.mkdir()
        mine = {'model': 'opus', 'hooks': {'PreToolUse': [{'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': '~/bin/guard.sh'}]}],
                                           'Stop': [{'hooks': [{'type': 'command', 'command': 'say done'}]}]}}
        path.write_text(json.dumps(mine))
        os.chmod(path, 0o640)
        self.assertEqual(setup.status('claude', self.home)['state'], 'missing')
        preview = setup.install('claude', self.home, dry_run=True)
        self.assertTrue(preview['changed'])
        self.assertEqual(json.loads(path.read_text()), mine, 'a dry run writes nothing')
        result = setup.install('claude', self.home)
        self.assertTrue(result['ok'] and result['backup'] and Path(result['backup']).exists())
        self.assertEqual(json.loads(Path(result['backup']).read_text()), mine)
        data = json.loads(path.read_text())
        self.assertEqual(data['model'], 'opus')
        self.assertEqual(data['hooks']['PreToolUse'][0], mine['hooks']['PreToolUse'][0], 'existing hooks stay first and unchanged')
        self.assertIn('agent_hook.py', data['hooks']['PreToolUse'][1]['hooks'][0]['command'])
        self.assertEqual(path.stat().st_mode & 0o777, 0o640, 'permissions are kept')
        self.assertEqual(setup.status('claude', self.home)['state'], 'installed')
        again = setup.install('claude', self.home)
        self.assertFalse(again['changed'], 'installing twice adds nothing')
        self.assertEqual(len(json.loads(path.read_text())['hooks']['Stop']), 2)
        removed = setup.uninstall('claude', self.home)
        self.assertTrue(removed['changed'])
        self.assertEqual(json.loads(path.read_text()), mine, 'uninstalling restores exactly the user\'s hooks')

    def test_codex_and_antigravity_files(self):
        codex = setup.install('codex', self.home)
        self.assertTrue(codex['ok'] and not codex['backup'])
        data = json.loads((self.home / '.codex' / 'hooks.json').read_text())
        self.assertEqual(set(data['hooks']), set(setup.EVENTS['codex']))
        self.assertEqual(data['hooks']['SessionEnd'][0]['hooks'][0]['timeout'], 2, 'Codex limits SessionEnd hooks to 3 s')
        self.assertIn('/hooks', setup.status('codex', self.home)['note'])
        gravity_path = self.home / '.gemini' / 'config' / 'hooks.json'
        gravity_path.parent.mkdir(parents=True)
        gravity_path.write_text(json.dumps({'safety-gate': {'PreToolUse': [{'matcher': 'run_command', 'hooks': [{'command': './check.sh'}]}]}}))
        setup.install('antigravity', self.home)
        data = json.loads(gravity_path.read_text())
        self.assertEqual(set(data), {'safety-gate', 'notchy'})
        self.assertNotIn('PreToolUse', data['notchy'], 'Notchy never takes part in Antigravity\'s permission decisions')
        self.assertEqual(data['notchy']['PostToolUse'][0]['matcher'], '*')
        self.assertEqual(setup.status('antigravity', self.home)['state'], 'installed')
        setup.uninstall('antigravity', self.home)
        self.assertEqual(set(json.loads(gravity_path.read_text())), {'safety-gate'})

    def test_broken_files_are_left_alone(self):
        path = self.home / '.claude' / 'settings.json'
        path.parent.mkdir()
        path.write_text('{"hooks": [ broken')
        result = setup.install('claude', self.home)
        self.assertFalse(result['ok'])
        self.assertEqual(path.read_text(), '{"hooks": [ broken')
        self.assertEqual(setup.status('claude', self.home)['state'], 'error')
        path.write_text(json.dumps({'hooks': {'Stop': 'not a list'}}))
        self.assertFalse(setup.install('claude', self.home)['ok'])
        self.assertEqual(list(path.parent.glob('*.notchy-backup-*')), [], 'nothing written, no backup needed')


if __name__ == '__main__':
    unittest.main()
