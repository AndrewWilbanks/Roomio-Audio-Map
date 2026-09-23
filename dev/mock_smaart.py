#!/usr/bin/env python3
"""Fake Smaart API server for testing the app without Smaart running.

Streams made-up JSON over a WebSocket on port 26000 (Smaart's default) four
times a second. The message format is invented - real Smaart messages will look
different, which is why the app maps fields by path. With this mock, use:

  Booth SPL path:        meters.name=Booth.dBA
  Roaming mic SPL path:  meters.name=Roaming.dBA
  Booth spectrum path:   spectrum.name=Booth.bins
  Roaming spectrum path: spectrum.name=Roaming.bins

Like Smaart v9 (API v4) it only accepts ws://host:port/api/v4/, answers {"action":"get"}
with {"sequenceNumber":..,"response":{..}}, and can require the API password:

Usage: python3 tools/mock_smaart.py [port]        MOCK_PASSWORD=secret python3 tools/mock_smaart.py
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
        out.append({'f': f, 'db': round(base - 12 + tilt + 3 * math.sin(t * 0.7 + f / 900) + random.uniform(-1, 1), 1)})
    return out


def client(conn, addr):
    try:
        req = b''
        while b'\r\n\r\n' not in req: req += conn.recv(1024)
        lines = req.decode().split('\r\n')
        if not lines[0].split(' ')[1].startswith('/api/v4'):
            conn.sendall(b'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); conn.close()
            print('rejected path', lines[0]); return
        key = [l.split(':', 1)[1].strip() for l in lines if l.lower().startswith('sec-websocket-key')][0]
        acc = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        conn.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                      f'Sec-WebSocket-Accept: {acc}\r\n\r\n').encode())
        print('client connected', addr)
        alive = [True]
        authed = [not PASSWORD]

        def reader():
            while alive[0]:
                m = read_frame(conn)
                if m is None: alive[0] = False; break
                try: j = json.loads(m)
                except ValueError: j = {}
                sq = j.get('sequenceNumber')
                if j.get('action') == 'set' and j.get('properties') and 'password' in j['properties'][0]:
                    ok = j['properties'][0]['password'] == PASSWORD
                    authed[0] = authed[0] or ok
                    conn.sendall(frame(json.dumps({'sequenceNumber': sq, 'response': {} if ok else {'error': 'incorect password'}})))
                elif j.get('action') == 'get':
                    r = {'authenticationRequired': True} if not authed[0] else {'version': 'mock-4', 'tabs': ['Walk', 'FOH']}
                    conn.sendall(frame(json.dumps({'sequenceNumber': sq, 'response': r})))
                else:
                    print('<-', m)
        threading.Thread(target=reader, daemon=True).start()
        t0 = time.time()
        while alive[0]:
            if not authed[0]:
                time.sleep(0.25); continue
            t = time.time() - t0
            booth = 92 + 3 * math.sin(t / 4) + random.uniform(-0.6, 0.6)
            roam = booth - 2.5 + random.uniform(-0.8, 0.8)
            msg = {
                'type': 'mock-smaart',
                'meters': [
                    {'name': 'Booth', 'dBA': round(booth, 1), 'dBC': round(booth + 7, 1), 'LeqA': round(booth - 0.5, 1)},
                    {'name': 'Roaming', 'dBA': round(roam, 1), 'dBC': round(roam + 8, 1), 'LeqA': round(roam - 0.5, 1)},
                ],
                'spectrum': [
                    {'name': 'Booth', 'bins': spectrum(booth, t)},
                    {'name': 'Roaming', 'bins': [{'f': b['f'], 'db': round(b['db'] - 2.5 + (3 if b['f'] < 120 else 0) - (b['f'] / 4000), 1)}
                                                 for b in spectrum(roam + 2.5, t)]},
                ],
            }
            conn.sendall(frame(json.dumps(msg)))
            time.sleep(0.25)
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
