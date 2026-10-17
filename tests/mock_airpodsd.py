#!/usr/bin/python3
"""A stand-in for airpods-helper's daemon on the private test bus.

It publishes the documented org.costa.AirPods interface (properties with
PropertiesChanged, methods and signals) without any Bluetooth. A second
interface, org.notchy.AirPodsFixture, lets the test connect, disconnect,
change batteries and ear state. usage: mock_airpodsd.py BUSNAME LOGFILE
"""
import json
import sys

from gi.repository import Gio, GLib

NAME, LOG = sys.argv[1], sys.argv[2]
PATH, IFACE = '/org/costa/AirPods', 'org.costa.AirPods'
XML = f'''<node><interface name="{IFACE}">
 <property name="Connected" type="b" access="read"/><property name="Address" type="s" access="read"/>
 <property name="Model" type="s" access="read"/><property name="ModelName" type="s" access="read"/><property name="Firmware" type="s" access="read"/>
 <property name="Features" type="as" access="read"/>
 <property name="BatteryLeft" type="i" access="read"/><property name="BatteryRight" type="i" access="read"/><property name="BatteryCase" type="i" access="read"/>
 <property name="ChargingLeft" type="b" access="read"/><property name="ChargingRight" type="b" access="read"/><property name="ChargingCase" type="b" access="read"/>
 <property name="EarLeft" type="b" access="read"/><property name="EarRight" type="b" access="read"/>
 <property name="AncMode" type="s" access="read"/><property name="ConversationalAwareness" type="b" access="read"/>
 <property name="ConversationalActivityState" type="s" access="read"/>
 <property name="PauseOnRemoval" type="b" access="readwrite"/><property name="Version" type="s" access="read"/>
 <method name="SetAncMode"><arg type="s" direction="in"/></method>
 <method name="SetConversationalAwareness"><arg type="b" direction="in"/></method>
 <method name="ListPaired"><arg type="a(ss)" direction="out"/></method>
 <method name="ConnectTo"><arg type="s" direction="in"/></method>
 <method name="Disconnect"/><method name="Reconnect"/>
 <signal name="DeviceConnected"><arg type="s"/></signal><signal name="DeviceDisconnected"/>
 <signal name="EarDetectionChanged"><arg type="b"/><arg type="b"/></signal>
</interface><interface name="org.notchy.AirPodsFixture">
 <method name="Connect"><arg type="s" direction="in"/><arg type="as" direction="in"/></method>
 <method name="Drop"/>
 <method name="Battery"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="b" direction="in"/></method>
 <method name="Ear"><arg type="b" direction="in"/><arg type="b" direction="in"/></method>
 <method name="Talk"><arg type="s" direction="in"/></method>
</interface></node>'''
TYPES = {'Connected': 'b', 'Address': 's', 'Model': 's', 'ModelName': 's', 'Firmware': 's', 'Features': 'as', 'BatteryLeft': 'i', 'BatteryRight': 'i', 'BatteryCase': 'i',
         'ChargingLeft': 'b', 'ChargingRight': 'b', 'ChargingCase': 'b', 'EarLeft': 'b', 'EarRight': 'b', 'AncMode': 's', 'ConversationalAwareness': 'b',
         'ConversationalActivityState': 's', 'PauseOnRemoval': 'b', 'Version': 's'}
state = {'Connected': False, 'Address': '', 'Model': '', 'ModelName': '', 'Firmware': '', 'Features': [], 'BatteryLeft': -1, 'BatteryRight': -1, 'BatteryCase': -1,
         'ChargingLeft': False, 'ChargingRight': False, 'ChargingCase': False, 'EarLeft': False, 'EarRight': False, 'AncMode': 'off',
         'ConversationalAwareness': False, 'ConversationalActivityState': 'normal', 'PauseOnRemoval': True, 'Version': '0.0-test'}
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def log(entry):
    with open(LOG, 'a') as out:
        out.write(json.dumps(entry) + '\n')


def change(**values):
    state.update(values)
    bus.emit_signal(None, PATH, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                    GLib.Variant('(sa{sv}as)', (IFACE, {k: GLib.Variant(TYPES[k], v) for k, v in values.items()}, [])))


def signal(name, signature=None, values=None):
    bus.emit_signal(None, PATH, IFACE, name, GLib.Variant(signature, values) if signature else None)


def method(_c, _s, _p, iface, name, params, invocation):
    args = params.unpack()
    log({'method': name, 'args': list(args)})
    if iface == IFACE and name in ('SetAncMode', 'SetConversationalAwareness') and not state['Connected']:
        invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', 'not connected')
        return
    if name == 'SetAncMode':
        change(AncMode=args[0])
    elif name == 'SetConversationalAwareness':
        change(ConversationalAwareness=args[0])
    elif name == 'ListPaired':
        invocation.return_value(GLib.Variant('(a(ss))', ([('AA:BB:CC:DD:EE:FF', 'AirPods Pro')],)))
        return
    elif name in ('ConnectTo', 'Reconnect'):
        connect('AirPods Pro 2 (USB-C)', ['anc', 'adaptive', 'ca'])
    elif name in ('Disconnect', 'Drop'):
        if not state['Connected'] and name == 'Disconnect':
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', 'not connected')
            return
        change(Connected=False, Address='', Features=[], BatteryLeft=-1, BatteryRight=-1, BatteryCase=-1, EarLeft=False, EarRight=False)
        signal('DeviceDisconnected')
    elif name == 'Connect':
        connect(*args)
    elif name == 'Battery':
        change(BatteryLeft=args[0], BatteryRight=args[1], BatteryCase=args[2], ChargingCase=args[3])
    elif name == 'Ear':
        change(EarLeft=args[0], EarRight=args[1])
        signal('EarDetectionChanged', '(bb)', args)
    elif name == 'Talk':
        change(ConversationalActivityState=args[0])
    invocation.return_value(None)


def connect(model, features):
    # Like the daemon: connected first, features and batteries follow.
    change(Connected=True, Address='AA:BB:CC:DD:EE:FF', Model='A3047', ModelName=model, Features=list(features), AncMode='noise', EarLeft=True, EarRight=True)
    signal('DeviceConnected', '(s)', (model,))


def get(_c, _s, _p, _iface, name):
    return GLib.Variant(TYPES[name], state[name])


def set_(_c, _s, _p, _iface, name, value):
    state[name] = value.unpack()
    log({'set': name, 'value': state[name]})
    change(**{name: state[name]})
    return True


info = Gio.DBusNodeInfo.new_for_xml(XML)
bus.register_object(PATH, info.interfaces[0], method, get, set_)
bus.register_object(PATH, info.interfaces[1], method, None, None)
Gio.bus_own_name_on_connection(bus, NAME, Gio.BusNameOwnerFlags.NONE, None, None)
GLib.MainLoop().run()
