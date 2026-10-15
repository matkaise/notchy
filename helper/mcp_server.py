#!/usr/bin/python3
"""MCP stdio bridge. No HTTP endpoint, network listener, or shell-execution tool."""
import json
import math
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
]


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
