#!/usr/bin/python3
"""MCP stdio bridge. No HTTP endpoint, network listener, or shell-execution tool."""
import json
import math
import re
from pathlib import Path
import sys
from gi.repository import Gio, GLib

BUS = 'org.gnome.Shell.Extensions.Notchy'
PATH = '/org/gnome/Shell/Extensions/Notchy'
VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')
TOOLS = [
    {'name': 'list_shelf', 'description': 'List the files currently staged in the local Notchy tray.',
     'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
     'annotations': {'readOnlyHint': True, 'openWorldHint': False}},
    {'name': 'add_files', 'description': 'Stage existing local file paths in Notchy without moving or modifying the originals.',
     'inputSchema': {'type': 'object', 'properties': {'paths': {'type': 'array', 'items': {'type': 'string'}, 'minItems': 1, 'maxItems': 100}},
                     'required': ['paths'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': False}},
    {'name': 'set_activity', 'description': 'Publish a named agent progress activity on the local island. Progress is between 0 and 1.',
     'inputSchema': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'status': {'type': 'string'}, 'progress': {'type': 'number', 'minimum': 0, 'maximum': 1}},
                     'required': ['name', 'status', 'progress'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': False}},
    {'name': 'clear_activity', 'description': 'Remove a named activity from the local island.',
     'inputSchema': {'type': 'object', 'properties': {'name': {'type': 'string'}}, 'required': ['name'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': False}},
    {'name': 'agent_status', 'description': 'Report this agent session\'s state beside the notch: working, waiting (needs the user), idle, completed or error. '
     'Use one session id per conversation. Progress only when it is real (0 to 1).',
     'inputSchema': {'type': 'object', 'properties': {'agent': {'type': 'string', 'pattern': '^[a-z0-9][a-z0-9._-]{0,31}$'}, 'session': {'type': 'string', 'minLength': 1, 'maxLength': 128},
                                                      'state': {'type': 'string', 'enum': ['working', 'waiting', 'idle', 'completed', 'error']},
                                                      'status': {'type': 'string', 'maxLength': 140}, 'project': {'type': 'string', 'maxLength': 60},
                                                      'progress': {'type': 'number', 'minimum': 0, 'maximum': 1}},
                     'required': ['agent', 'session', 'state'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': False}},
    {'name': 'agent_end', 'description': 'End an agent session beside the notch.',
     'inputSchema': {'type': 'object', 'properties': {'agent': {'type': 'string'}, 'session': {'type': 'string'}}, 'required': ['agent', 'session'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': False}},
    {'name': 'live_activity', 'description': 'Show or update a live activity in the local notch, for example a download, a build or a conversion. '
     'Give progress (0 to 1) only when it is really measured, and remaining seconds only when known. It expires after ttl seconds without an update (default 3600).',
     'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string', 'pattern': '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,95}$'}, 'name': {'type': 'string', 'minLength': 1, 'maxLength': 60},
                                                      'type': {'type': 'string', 'enum': ['transfer', 'operation', 'timer', 'recording', 'custom']},
                                                      'state': {'type': 'string', 'enum': ['running', 'waiting', 'paused', 'completed', 'error']},
                                                      'progress': {'type': 'number', 'minimum': 0, 'maximum': 1}, 'remaining': {'type': 'number', 'minimum': 0, 'maximum': 86400},
                                                      'description': {'type': 'string', 'maxLength': 140}, 'ttl': {'type': 'number', 'minimum': 5, 'maximum': 86400}},
                     'required': ['id', 'name'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': False}},
    {'name': 'live_activity_end', 'description': 'Remove a live activity from the local notch.',
     'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': False}},
]
AGENT_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,31}$')
LIVE_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:@-]{0,95}$')
LIVE_FIELDS = {'id', 'name', 'type', 'state', 'progress', 'remaining', 'description', 'ttl'}


class Bridge:
    def __init__(self):
        self.proxy = None

    def call(self, method, parameters=None):
        if not self.proxy:
            self.proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None, BUS, PATH, BUS, None)
        if not self.proxy.get_name_owner():
            raise ValueError('Notchy is not enabled in this GNOME session.')
        result = self.proxy.call_sync(method, parameters, Gio.DBusCallFlags.NONE, 5000, None)
        return result.unpack() if result else ()

    def tool(self, name, arguments):
        if not isinstance(arguments, dict):
            raise ValueError('Tool arguments must be an object.')
        fields = {'list_shelf': set(), 'add_files': {'paths'}, 'set_activity': {'name', 'status', 'progress'}, 'clear_activity': {'name'}}
        if name in ('agent_status', 'agent_end'):
            return self.agent(name, arguments)
        if name in ('live_activity', 'live_activity_end'):
            return self.live(name, arguments)
        if name not in fields:
            raise ValueError('Unknown tool.')
        if set(arguments) != fields[name]:
            raise ValueError('Missing or unexpected arguments.')
        if name == 'list_shelf':
            return json.loads(self.call('GetItems')[0])
        if name == 'add_files':
            paths = arguments['paths']
            if not isinstance(paths, list) or not 1 <= len(paths) <= 100 or not all(isinstance(p, str) for p in paths):
                raise ValueError('Provide between 1 and 100 local paths.')
            files = [Path(p).expanduser().resolve() for p in paths]
            if not all(p.exists() for p in files):
                raise ValueError('One or more files do not exist.')
            return {'added': self.call('AddUris', GLib.Variant('(s)', ('\r\n'.join(p.as_uri() for p in files),)))[0]}
        title = arguments['name']
        if not isinstance(title, str) or not title.strip() or len(title) > 80:
            raise ValueError('Activity names must contain 1 to 80 characters.')
        if name == 'clear_activity':
            self.call('ClearActivity', GLib.Variant('(s)', (title,)))
            return {'cleared': title}
        status, progress = arguments['status'], arguments['progress']
        if not isinstance(status, str) or len(status) > 200 or not isinstance(progress, (int, float)) or isinstance(progress, bool) or not math.isfinite(progress) or not 0 <= progress <= 1:
            raise ValueError('Invalid status or progress.')
        self.call('SetActivity', GLib.Variant('(ssd)', (title, status, progress)))
        return {'updated': title}


    def live(self, name, arguments):
        allowed = LIVE_FIELDS if name == 'live_activity' else {'id'}
        required = {'id', 'name'} if name == 'live_activity' else {'id'}
        if not required <= set(arguments) or set(arguments) - allowed:
            raise ValueError('Missing or unexpected arguments.')
        if not isinstance(arguments['id'], str) or not LIVE_ID_RE.match(arguments['id']):
            raise ValueError('Invalid activity id.')
        if name == 'live_activity_end':
            return {'ended': bool(self.call('EndActivity', GLib.Variant('(s)', (arguments['id'],)))[0])}
        for key in ('progress', 'remaining', 'ttl'):
            value = arguments.get(key)
            if value is not None and (not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value)):
                raise ValueError(f'Invalid {key}.')
        for key in ('name', 'type', 'state', 'description'):
            if key in arguments and not isinstance(arguments[key], str):
                raise ValueError(f'Invalid {key}.')
        # Notchy validates the rest (ranges, types, states) and answers with the reason.
        error = self.call('ReportActivity', GLib.Variant('(s)', (json.dumps(arguments),)))[0]
        if error:
            raise ValueError(error)
        return {'reported': arguments['id']}

    def agent(self, name, arguments):
        required, optional = ({'agent', 'session', 'state'}, {'status', 'project', 'progress'}) if name == 'agent_status' else ({'agent', 'session'}, set())
        if not required <= set(arguments) or set(arguments) - required - optional:
            raise ValueError('Missing or unexpected arguments.')
        agent, session = arguments['agent'], arguments['session']
        if not isinstance(agent, str) or not AGENT_RE.match(agent) or not isinstance(session, str) or not 0 < len(session) <= 128:
            raise ValueError('Invalid agent or session.')
        event = {'provider': agent, 'session': session, 'source': 'mcp', 'event': 'end' if name == 'agent_end' else 'update'}
        if name == 'agent_status':
            if arguments['state'] not in ('working', 'waiting', 'idle', 'completed', 'error'):
                raise ValueError('Invalid state.')
            event['state'] = arguments['state']
            for key, limit in (('status', 140), ('project', 60)):
                if key in arguments:
                    if not isinstance(arguments[key], str) or len(arguments[key]) > limit:
                        raise ValueError(f'Invalid {key}.')
                    event[key] = arguments[key]
            if 'progress' in arguments:
                progress = arguments['progress']
                if not isinstance(progress, (int, float)) or isinstance(progress, bool) or not math.isfinite(progress) or not 0 <= progress <= 1:
                    raise ValueError('Invalid progress.')
                event['progress'] = progress
        error = self.call('AgentEvent', GLib.Variant('(s)', (json.dumps(event),)))[0]
        if error:
            raise ValueError(error)
        return {'reported': event['event'], 'session': session}


class Server:
    def __init__(self, bridge=None):
        self.bridge = bridge or Bridge()
        self.initialized = False

    def handle(self, message):
        if not isinstance(message, dict) or message.get('jsonrpc') != '2.0' or not isinstance(message.get('method'), str):
            return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid request'}}
        method = message['method']
        if 'id' not in message:
            return None
        response = {'jsonrpc': '2.0', 'id': message['id']}
        params = message.get('params') or {}
        if not isinstance(params, dict):
            response['error'] = {'code': -32602, 'message': 'Invalid params'}
        elif method == 'initialize':
            requested = params.get('protocolVersion')
            self.initialized = True
            response['result'] = {'protocolVersion': requested if requested in VERSIONS else VERSIONS[0],
                                  'capabilities': {'tools': {'listChanged': False}},
                                  'serverInfo': {'name': 'notchy', 'version': '0.1.0'}}
        elif method == 'ping':
            response['result'] = {}
        elif not self.initialized:
            response['error'] = {'code': -32000, 'message': 'Initialize the server first'}
        elif method == 'tools/list':
            response['result'] = {'tools': TOOLS}
        elif method == 'tools/call':
            try:
                result = self.bridge.tool(params.get('name'), params.get('arguments', {}))
                response['result'] = {'content': [{'type': 'text', 'text': json.dumps(result, ensure_ascii=False)}], 'isError': False}
            except (ValueError, GLib.Error, OSError) as error:
                response['result'] = {'content': [{'type': 'text', 'text': str(error)}], 'isError': True}
        else:
            response['error'] = {'code': -32601, 'message': 'Method not found'}
        return response

    def serve(self, stream=sys.stdin, output=sys.stdout):
        while True:
            line = stream.readline(1024 * 1024 + 1)
            if not line:
                break
            try:
                if len(line) > 1024 * 1024 or not line.endswith('\n'):
                    raise ValueError('Message too large or incomplete')
                response = self.handle(json.loads(line))
            except (ValueError, RecursionError):
                response = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Parse error'}}
            if response is not None:
                output.write(json.dumps(response, ensure_ascii=False) + '\n')
                output.flush()


if __name__ == '__main__':
    Server().serve()
