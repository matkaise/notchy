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
        return ('[]',) if method == 'GetItems' else ()


class MCPTest(unittest.TestCase):
    def test_init_tools_and_unknown_method(self):
        server = mcp.Server(BridgeTest())
        before = server.handle({'jsonrpc':'2.0', 'id':1, 'method':'tools/list'})
        self.assertIn('error', before)
        response = server.handle({'jsonrpc':'2.0', 'id':2, 'method':'initialize', 'params':{'protocolVersion':'2025-11-25'}})
        self.assertEqual(response['result']['protocolVersion'], '2025-11-25')
        self.assertEqual(len(server.handle({'jsonrpc':'2.0','id':3,'method':'tools/list'})['result']['tools']),4)
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
