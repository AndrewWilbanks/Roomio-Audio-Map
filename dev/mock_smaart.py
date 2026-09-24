#!/usr/bin/env python3
"""Fake Smaart v9 API server (API v4, as documented in the Smaart API v4 SDK) for testing
Roomio without Smaart running.

  root      ws://localhost:26000/api/v4/     get -> server properties; activeCalibratedInputs;
                                             activeMeasurements; optional API password
  SPL       /api/v4/devices/Mock%20I-O/channels/FOH       {"metrics":[{"SPL A Slow":..}, ...]}
            /api/v4/devices/Mock%20I-O/channels/Roaming
  spectrum  /api/v4/measurements/FOH%20RTA                {"banding":"1/3 Octave","data":[[f,dB],...]}
            /api/v4/measurements/Roaming%20RTA

Roomio's built-in Smaart v9 mode needs no mapping: FOH = first input/measurement.
Streams honour {"action":"set","properties":[{"targetFPS":n}]}.

Usage: python3 dev/mock_smaart.py [port]        MOCK_PASSWORD=secret python3 dev/mock_smaart.py
"""
import base64, hashlib, json, math, random, socket, struct, sys, threading, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 26000
PASSWORD = __import__('os').environ.get('MOCK_PASSWORD', '')
GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
FREQS = [round(20 * 2 ** (i / 3), 1) for i in range(31)]          # 1/3-octave 20 Hz..20 kHz


def frame(text):
    data = text.encode()
    n = len(data)
    head = bytes([0x81])
    if n < 126: head += bytes([n])
    elif n < 65536: head += bytes([126]) + struct.pack('>H', n)
    else: head += bytes([127]) + struct.pack('>Q', n)
    return head + data


def read_frame(conn):
    h = conn.recv(2)
    if len(h) < 2: return None
    op, n = h[0] & 0x0F, h[1] & 0x7F
    if n == 126: n = struct.unpack('>H', conn.recv(2))[0]
    elif n == 127: n = struct.unpack('>Q', conn.recv(8))[0]
    mask = conn.recv(4) if h[1] & 0x80 else b'\0\0\0\0'
    buf = b''
    while len(buf) < n: buf += conn.recv(n - len(buf))
    if op == 8: return None
    return bytes(b ^ mask[i % 4] for i, b in enumerate(buf)).decode(errors='replace')


def spectrum(base, t):
    out = []
    for f in FREQS:
        tilt = 6 if f < 120 else (0 if f < 2000 else -4)             # sub-heavy worship mix
        out.append([f, round(base - 12 + tilt + 3 * math.sin(t * 0.7 + f / 900) + random.uniform(-1, 1), 1)])
    return out


DEVICE = 'Mock I-O'
ENC = lambda s: s.replace(' ', '%20')
SPL_EP = {ENC(f'/api/v4/devices/{DEVICE}/channels/{ch}'): ch for ch in ('FOH', 'Roaming')}
SPEC_EP = {ENC(f'/api/v4/measurements/{m}'): m for m in ('FOH RTA', 'Roaming RTA')}
T0 = time.time()


def levels():
    t = time.time() - T0
    booth = 92 + 3 * math.sin(t / 4) + random.uniform(-0.6, 0.6)
    return t, booth, booth - 2.5 + random.uniform(-0.8, 0.8)


def root_reply(j, authed):
    target = j.get('target')
    if j.get('action') == 'get' and not target:
        return {'applicationName': 'Smaart Suite', 'applicationVersion': '9.5.0 (mock)', 'machineName': socket.gethostname(),
                'authenticationRequired': not authed, 'marshallingTimeout': 4000, 'serializationFormat': 'clear text'}
    if not authed:
        return {'error': 'authentication required'}
    if target == 'activeCalibratedInputs':
        return {'devices': [{'deviceName': DEVICE, 'activeCalibratedChannels': [
            {'channelIndex': i, 'channelName': ch, 'streamEndpoint': ep, 'logEndpointPrefix': ep.replace('/devices/', '/logs/')}
            for i, (ep, ch) in enumerate(SPL_EP.items())]}], 'metrics': ['SPL A Slow', 'SPL C Slow', 'LAeq 1']}
    if target == 'activeMeasurements':
        return {'spectrumMeasurements': [{'measurementName': m, 'active': True, 'streamEndpoint': ep} for ep, m in SPEC_EP.items()],
                'transferFunctionMeasurements': []}
    return {'error': 'unknown target'}


def client(conn, addr):
    try:
        req = b''
        while b'\r\n\r\n' not in req: req += conn.recv(1024)
        lines = req.decode().split('\r\n')
        path = lines[0].split(' ')[1]
        kind = 'root' if path.rstrip('/') == '/api/v4' else 'spl' if path.rstrip('/') in SPL_EP else 'spec' if path.rstrip('/') in SPEC_EP else None
        if not kind:
            conn.sendall(b'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); conn.close()
            print('rejected path', path); return
        key = [l.split(':', 1)[1].strip() for l in lines if l.lower().startswith('sec-websocket-key')][0]
        acc = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        conn.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                      f'Sec-WebSocket-Accept: {acc}\r\n\r\n').encode())
        print('client connected', addr, path)
        alive, authed, fps = [True], [not PASSWORD], [8 if kind == 'spl' else 23]

        def reader():
            while alive[0]:
                m = read_frame(conn)
                if m is None: alive[0] = False; break
                try: j = json.loads(m)
                except ValueError:
                    if kind == 'root': conn.sendall(frame(json.dumps({'response': {'error': 'parse error'}})))
                    continue
                props = {k: v for p in j.get('properties') or [] for k, v in p.items()}
                if 'password' in props:
                    ok = props['password'] == PASSWORD
                    authed[0] = authed[0] or ok
                    if kind == 'root': conn.sendall(frame(json.dumps({'sequenceNumber': j.get('sequenceNumber'), 'response': {} if ok else {'error': 'incorrect password'}})))
                elif kind != 'root':                             # stream commands get no reply
                    if 'targetFPS' in props: fps[0] = max(1, min(fps[0], int(props['targetFPS'])))
                else:
                    r = {'response': root_reply(j, authed[0])}
                    if j.get('sequenceNumber'): r['sequenceNumber'] = j['sequenceNumber']
                    conn.sendall(frame(json.dumps(r)))
        threading.Thread(target=reader, daemon=True).start()
        while alive[0]:
            if kind != 'root' and (authed[0] or not PASSWORD):
                t, booth, roam = levels()
                if kind == 'spl':
                    lvl = booth if SPL_EP[path.rstrip('/')] == 'FOH' else roam
                    msg = {'timestamp': time.strftime('%Y-%m-%d:T%H:%M:%S'), 'deviceName': DEVICE, 'channelName': SPL_EP[path.rstrip('/')],
                           'metrics': [{'FS Peak': round(lvl - 120, 2)}, {'SPL A Slow': round(lvl, 1)}, {'SPL A Fast': round(lvl + random.uniform(-1, 1), 1)},
                                       {'SPL C Slow': round(lvl + 7, 1)}, {'LAeq 1': round(lvl - 0.5, 1)}, {'LAeq 10': round(lvl - 0.8, 1)}]}
                else:
                    foh = SPEC_EP[path.rstrip('/')] == 'FOH RTA'
                    data = spectrum(booth, t) if foh else [[f, round(db - 2.5 + (3 if f < 120 else 0) - f / 4000, 1)] for f, db in spectrum(roam + 2.5, t)]
                    msg = {'timestamp': time.strftime('%Y-%m-%d:T%H:%M:%S'), 'description': 'frequency vs magnitude', 'banding': '1/3 Octave', 'dB FS Peak': -26.2, 'data': data}
                conn.sendall(frame(json.dumps(msg)))
            time.sleep(1 / fps[0] if kind != 'root' else 0.25)
    except (OSError, IndexError) as e:
        print('client gone', addr, e)
    finally:
        conn.close()


def main():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('0.0.0.0', PORT)); s.listen(5)
    print(f'mock Smaart API on ws://localhost:{PORT}')
    while True:
        c, a = s.accept()
        threading.Thread(target=client, args=(c, a), daemon=True).start()


if __name__ == '__main__':
    main()
