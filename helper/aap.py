#!/usr/bin/python3
"""AirPods status over Apple's accessory protocol (AAP), for Notchy.

Used only when the airpods-helper daemon is not running. It opens the AAP
channel (L2CAP PSM 0x1001) of AirPods that BlueZ already connected — as the
logged-in user, no root, no pairing, no Bluetooth configuration — asks for
notifications and reports what the AirPods tell: batteries, charging, ear
state, noise control, conversation awareness and the model name.

Protocol with the Shell: one JSON state object per line on stdout, one JSON
command per line on stdin ({"anc": "noise"}, {"conversation": true}).
usage: aap.py MAC
"""
import json
import os
import select
import socket
import sys
import time

PSM = 0x1001
HANDSHAKE = bytes.fromhex('00000400010002000000000000000000')
# Unlocks conversational awareness during playback and adaptive transparency.
FEATURES = bytes.fromhex('040004004d00d700000000000000')
NOTIFICATIONS = bytes.fromhex('040004000f00ffffffff')
HEADER = bytes.fromhex('04000400')
HANDSHAKE_ACK = bytes.fromhex('01000400')
FEATURES_ACK = bytes.fromhex('040004002b00')
# Connection steps (as LibrePods does it): handshake, wait for its answer,
# unlock features, request notifications, ask again until batteries arrive.
HANDSHAKE_TRIES, HANDSHAKE_WAIT = 4, 1.5
NOTIFY_TRIES, NOTIFY_WAIT = 4, 2.0
# The case reports its battery only while it is connected to a bud (a bud in
# it). When it is still unknown once the buds report, ask again a little
# later, at most this often: the AirPods push every change themselves.
CASE_REQUESTS, CASE_REQUEST_AFTER = 2, (15.0, 45.0)
ANC_CODES = {1: 'off', 2: 'noise', 3: 'transparency', 4: 'adaptive'}
ANC_VALUES = {name: code for code, name in ANC_CODES.items()}
# Battery components and states as the AirPods report them.
PARTS = {0x02: 'right', 0x04: 'left', 0x08: 'case', 0x01: 'single'}
CHARGING, DISCHARGING, DISCONNECTED = 0x01, 0x02, 0x04
# Ear state per bud: 0 in the ear, 1 out of the ear, 2 in the case.
IN_EAR = 0


def control(setting, value):
    """A control command: set one setting (0x09) to a value."""
    return HEADER + bytes([0x09, 0x00, setting, value, 0x00, 0x00, 0x00])


def parse(packet, state):
    """Apply one AAP packet to the state dict; returns True when it changed."""
    if len(packet) < 6 or packet[:4] != HEADER:
        return False
    opcode, body = packet[4], packet[6:]
    before = json.dumps(state, sort_keys=True)
    if opcode == 0x04 and body:
        # Battery: count, then per component: id, 0x01, level, state, 0x01.
        count, items = body[0], body[1:]
        # The first bud listed is the primary one; ear states refer to it.
        buds = [PARTS.get(items[i * 5]) for i in range(count) if len(items) > i * 5 and PARTS.get(items[i * 5]) in ('left', 'right')]
        if buds:
            state['primary'] = buds[0]
        for i in range(count):
            item = items[i * 5:i * 5 + 5]
            if len(item) < 4 or item[0] not in PARTS:
                continue
            part, level, status = PARTS[item[0]], item[2], item[3]
            state['battery'][part] = level if status != DISCONNECTED and 0 <= level <= 100 else None
            state['charging'][part] = status == CHARGING
    elif opcode == 0x06 and len(body) >= 2:
        primary = state.get('primary', 'left')
        secondary = 'right' if primary == 'left' else 'left'
        state['ear'] = {primary: body[0] == IN_EAR, secondary: body[1] == IN_EAR}
    elif opcode == 0x09 and len(body) >= 2:
        setting, value = body[0], body[1]
        if setting == 0x0d and value in ANC_CODES:
            state['anc'] = ANC_CODES[value]
            state['ancSupported'] = True
        elif setting == 0x28:
            state['conversation'] = value == 0x01
    elif opcode == 0x1d and len(body) > 4:
        # Device information: NUL-separated strings, the name first, then the model number.
        fields = [field.decode('utf-8', 'replace') for field in body[4:].lstrip(b'\0').split(b'\0')]
        if fields and fields[0]:
            state['name'] = fields[0]
        if len(fields) > 1 and fields[1]:
            state['model'] = fields[1]
    return json.dumps(state, sort_keys=True) != before


def new_state():
    return {'connected': False, 'name': '', 'model': '', 'battery': {'left': None, 'right': None, 'case': None, 'single': None},
            'charging': {'left': False, 'right': False, 'case': False, 'single': False}, 'ear': None, 'anc': None, 'ancSupported': False,
            'conversation': None, 'primary': 'left'}


def command(line):
    """A command line from the Shell as an AAP packet, or None."""
    try:
        request = json.loads(line)
    except json.JSONDecodeError:
        return None
    if request.get('anc') in ANC_VALUES:
        return control(0x0d, ANC_VALUES[request['anc']])
    if isinstance(request.get('conversation'), bool):
        return control(0x28, 0x01 if request['conversation'] else 0x02)
    return None


class Replay:
    """The headless test's stand-in for the L2CAP socket: recorded packets in,
    sent packets logged."""
    def __init__(self, path, log):
        self.packets = [bytes.fromhex(line.strip()) for line in open(path) if line.strip() and not line.startswith('#')]
        self.log = log
        self.read, self.write = os.pipe()
        for _ in self.packets:
            os.write(self.write, b'.')

    def fileno(self):
        return self.read

    def send(self, data):
        with open(self.log, 'a') as out:
            out.write(data.hex() + '\n')
        # The AirPods confirm a control command by repeating it.
        if data[4:5] == b'\x09':
            self.packets.append(data)
            os.write(self.write, b'.')

    def recv(self, _size):
        os.read(self.read, 1)
        return self.packets.pop(0)

    def close(self):
        os.close(self.read)
        os.close(self.write)


def run(mac, out=sys.stdout, stdin=sys.stdin):
    replay = os.environ.get('NOTCHY_AAP_REPLAY')
    if replay:
        channel = Replay(replay, os.environ.get('NOTCHY_AAP_LOG', os.devnull))
    else:
        channel = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_SEQPACKET, socket.BTPROTO_L2CAP)
        channel.settimeout(8)
        channel.connect((mac, PSM))
        channel.settimeout(None)
    state = new_state()
    state['connected'] = True

    def emit():
        out.write(json.dumps(state) + '\n')
        out.flush()
    # step: 'handshake' until the AirPods answer, then 'notify' until a battery arrives, then 'ready'.
    step, tries, deadline = 'handshake', 1, time.monotonic() + HANDSHAKE_WAIT
    channel.send(HANDSHAKE)
    emit()
    inputs = [channel, stdin]
    case_asked, ready_at = 0, None
    try:
        while True:
            now = time.monotonic()
            case_due = ready_at + CASE_REQUEST_AFTER[case_asked] if ready_at is not None and case_asked < CASE_REQUESTS else None
            timeout = 0.3 if replay else max(0.05, deadline - now) if step != 'ready' else max(0.05, min(30, case_due - now)) if case_due else 30
            ready, _, _ = select.select(inputs, [], [], timeout)
            if channel in ready:
                packet = channel.recv(1024)
                if not packet:
                    break
                if step == 'handshake' and packet.startswith(HANDSHAKE_ACK):
                    channel.send(FEATURES)
                    step, tries, deadline = 'features', 1, time.monotonic() + 1.0
                elif step == 'features' and packet.startswith(FEATURES_ACK):
                    channel.send(NOTIFICATIONS)
                    step, tries, deadline = 'notify', 1, time.monotonic() + NOTIFY_WAIT
                if parse(packet, state):
                    emit()
                if step == 'notify' and any(value is not None for value in state['battery'].values()):
                    step, ready_at = 'ready', time.monotonic()
            if stdin in ready:
                line = stdin.readline()
                if not line:
                    # The Shell is gone (a replay just has no more commands).
                    if not replay:
                        break
                    inputs.remove(stdin)
                    continue
                packet = command(line)
                if packet:
                    channel.send(packet)
            if not replay and step == 'ready' and case_due and time.monotonic() >= case_due:
                case_asked += 1
                if state['battery']['case'] is None and state['battery']['single'] is None:
                    channel.send(NOTIFICATIONS)
            if not replay and step != 'ready' and time.monotonic() >= deadline:
                if step == 'handshake':
                    if tries >= HANDSHAKE_TRIES:
                        raise OSError('Die AirPods antworten nicht auf den Handshake')
                    channel.send(HANDSHAKE)
                    tries, deadline = tries + 1, time.monotonic() + HANDSHAKE_WAIT
                elif step == 'features':
                    # Not every model confirms the feature packet.
                    channel.send(NOTIFICATIONS)
                    step, tries, deadline = 'notify', 1, time.monotonic() + NOTIFY_WAIT
                elif step == 'notify':
                    if tries >= NOTIFY_TRIES:
                        step, ready_at = 'ready', time.monotonic()  # Connected, but the AirPods report no battery (yet).
                    else:
                        channel.send(NOTIFICATIONS)
                        tries, deadline = tries + 1, time.monotonic() + NOTIFY_WAIT
            # A replay ends once its packets and its commands are used up.
            if replay and not ready and stdin not in inputs:
                break
    except OSError:
        pass
    finally:
        channel.close()


if __name__ == '__main__':
    if len(sys.argv) != 2 or len(sys.argv[1].split(':')) != 6:
        sys.exit('usage: aap.py MAC')
    try:
        run(sys.argv[1])
    except OSError as error:
        print(json.dumps({'connected': False, 'error': str(error)}), flush=True)
        sys.exit(1)
