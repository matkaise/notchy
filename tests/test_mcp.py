import importlib.util
import io
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('mcp', Path(__file__).parent.parent / 'helper/mcp_server.py')
mcp = importlib.util.module_from_spec(spec); spec.loader.exec_module(mcp)


class BridgeTest(mcp.Bridge):
    def __init__(self):
        self.calls = []

    def call(self, method, parameters=None):
        self.calls.append((method, parameters.unpack() if parameters else None))
        if method == 'EndActivity':
            return (True,)
        return ('[]',) if method == 'GetItems' else ('',) if method in ('AgentEvent', 'ReportActivity') else ()


class MCPTest(unittest.TestCase):
    def test_init_tools_and_unknown_method(self):
        server = mcp.Server(BridgeTest())
        before = server.handle({'jsonrpc':'2.0', 'id':1, 'method':'tools/list'})
        self.assertIn('error', before)
        response = server.handle({'jsonrpc':'2.0', 'id':2, 'method':'initialize', 'params':{'protocolVersion':'2025-11-25'}})
        self.assertEqual(response['result']['protocolVersion'], '2025-11-25')
        self.assertEqual(len(server.handle({'jsonrpc':'2.0','id':3,'method':'tools/list'})['result']['tools']),8)
        self.assertIn('error',server.handle({'jsonrpc':'2.0','id':4,'method':'arbitrary-command'}))

    def test_activity_validates_parameters_and_never_executes(self):
        bridge = BridgeTest()
        bridge.tool('set_activity', {'name':'Test', 'status':'Working', 'progress':.5})
        self.assertEqual(bridge.calls[0], ('SetActivity', ('Test','Working',.5)))
        for args in [{'name':'Test','status':'Working','progress':float('nan')}, {'name':'Test','status':'Working','progress':True}, {'name':'Test','status':'Working','progress':.5,'command':'rm'}]:
            with self.assertRaises(ValueError):
                bridge.tool('set_activity', args)
        with self.assertRaises(ValueError):
            bridge.tool('shell', {})

    def test_stdio_frames_and_notifications(self):
        stream = io.StringIO('bad json\n'+json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n'+json.dumps({'jsonrpc':'2.0','id':1,'method':'ping'})+'\n')
        output = io.StringIO(); mcp.Server(BridgeTest()).serve(stream,output)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(replies), 2); self.assertEqual(replies[0]['error']['code'],-32700); self.assertEqual(replies[1]['result'],{})


class AgentToolTest(unittest.TestCase):
    def test_agent_status_is_validated_and_sent_as_one_event(self):
        bridge = BridgeTest()
        self.assertEqual(bridge.tool('agent_status', {'agent': 'aider', 'session': 's1', 'state': 'working', 'progress': 0.5})['reported'], 'update')
        method, (payload,) = bridge.calls[0]
        self.assertEqual(method, 'AgentEvent')
        self.assertEqual(json.loads(payload), {'provider': 'aider', 'session': 's1', 'source': 'mcp', 'event': 'update', 'state': 'working', 'progress': 0.5})
        bridge.tool('agent_end', {'agent': 'aider', 'session': 's1'})
        self.assertEqual(json.loads(bridge.calls[1][1][0])['event'], 'end')
        for args in [{'agent': 'Aider!', 'session': 's', 'state': 'working'}, {'agent': 'a', 'session': '', 'state': 'working'}, {'agent': 'a', 'session': 's', 'state': 'busy'},
                     {'agent': 'a', 'session': 's', 'state': 'working', 'progress': 3}, {'agent': 'a', 'session': 's', 'state': 'working', 'shell': 'x'}, {'agent': 'a', 'session': 's'}]:
            with self.assertRaises(ValueError):
                bridge.tool('agent_status', args)


class LiveActivityToolTest(unittest.TestCase):
    def test_live_activity_is_forwarded_as_one_report(self):
        bridge = BridgeTest()
        self.assertEqual(bridge.tool('live_activity', {'id': 'build-1', 'name': 'Build', 'type': 'operation', 'progress': 0.25, 'remaining': 30})['reported'], 'build-1')
        method, (payload,) = bridge.calls[0]
        self.assertEqual(method, 'ReportActivity')
        self.assertEqual(json.loads(payload), {'id': 'build-1', 'name': 'Build', 'type': 'operation', 'progress': 0.25, 'remaining': 30})
        self.assertEqual(bridge.tool('live_activity_end', {'id': 'build-1'}), {'ended': True})
        self.assertEqual(bridge.calls[1], ('EndActivity', ('build-1',)))

    def test_live_activity_rejects_bad_arguments_before_calling(self):
        bridge = BridgeTest()
        for args in [{'name': 'x'}, {'id': 'a b', 'name': 'x'}, {'id': 'a', 'name': 'x', 'progress': float('nan')}, {'id': 'a', 'name': 'x', 'progress': True},
                     {'id': 'a', 'name': 'x', 'command': 'rm -rf'}, {'id': 'a', 'name': 3}]:
            with self.assertRaises(ValueError):
                bridge.tool('live_activity', args)
        self.assertEqual(bridge.calls, [])

    def test_notchys_refusal_reaches_the_client(self):
        bridge = BridgeTest()
        bridge.call = lambda method, parameters=None: ('Progress must be between 0 and 1',)
        with self.assertRaises(ValueError):
            bridge.tool('live_activity', {'id': 'a', 'name': 'x', 'progress': 2})
