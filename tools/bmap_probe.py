"""BMAP 只读探针：通过 RFCOMM 读取 Bose 耳机状态，并把原始字节存成 JSON。

用法: python tools/bmap_probe.py 02:00:00:00:45:01 [channel=8] [out.json]
只发送 GET（operator=1），不修改耳机任何设置。
"""
import json
import socket
import sys
import time

OPS = {0: "SET", 1: "GET", 2: "SETGET", 3: "STATUS", 4: "ERROR",
       5: "START", 6: "RESULT", 7: "PROCESSING"}


def packet(fblock, func, op, payload=b""):
    return bytes([fblock, func, op & 0x0F, len(payload)]) + payload


def split(data):
    out, pos = [], 0
    while pos + 4 <= len(data):
        n = data[pos + 3]
        if pos + 4 + n > len(data):
            break
        out.append(data[pos:pos + 4 + n])
        pos += 4 + n
    return out


def describe(frame):
    fb, fn, flags, n = frame[0], frame[1], frame[2], frame[3]
    return "[%d.%d] %s len=%d %s" % (fb, fn, OPS.get(flags & 0x0F, flags), n, frame[4:].hex(" "))


def exchange(sock, req, wait=1.2):
    sock.sendall(req)
    buf, deadline = b"", time.time() + wait
    while time.time() < deadline:
        sock.settimeout(max(0.05, deadline - time.time()))
        try:
            chunk = sock.recv(1024)
        except socket.timeout:
            break
        except OSError as e:
            print("   (连接已断开: %s)" % e)
            break
        if not chunk:
            break
        buf += chunk
    return buf


def main():
    mac = sys.argv[1]
    channel = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    out_path = sys.argv[3] if len(sys.argv) > 3 else "probe.json"

    sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    t0 = time.time()
    sock.connect((mac, channel))
    print("connected ch%d in %.2fs" % (channel, time.time() - t0))

    log = []
    queries = [
        ("bmap_version (init)", 0, 1),
        ("product_id", 0, 3),
        ("firmware", 0, 5),
        ("product_name", 1, 2),
        ("cnc", 1, 5),
        ("multipoint", 1, 10),
        ("battery", 2, 2),
        ("dm_list_devices", 4, 4),
        ("current_mode", 31, 3),
        ("all_modes", 31, 1),
    ]
    macs = []
    for name, fb, fn in queries:
        req = packet(fb, fn, 1)
        raw = exchange(sock, req, wait=2.0 if name == "all_modes" else 1.2)
        frames = split(raw)
        log.append({"name": name, "req": req.hex(), "resp": raw.hex()})
        print("\n## %s  req=%s" % (name, req.hex(" ")))
        for f in frames:
            print("   " + describe(f))
            if f[0] == 4 and f[1] == 4 and (f[2] & 0x0F) == 3:
                body = f[5:4 + f[3]]
                macs = [body[i:i + 6] for i in range(0, len(body) - 5, 6)]

    for m in macs:
        req = packet(4, 5, 1, m)
        raw = exchange(sock, req)
        log.append({"name": "dm_info " + m.hex(":"), "req": req.hex(), "resp": raw.hex()})
        print("\n## dm_info %s" % m.hex(":"))
        for f in split(raw):
            p = f[4:]
            flags = p[6] if len(p) > 6 else 0
            print("   " + describe(f))
            if (f[2] & 0x0F) == 3 and len(p) >= 9:
                start = 10 if flags & 0b100 else 9
                print("   -> connected=%d is_local=%d bose=%d name=%r" % (
                    flags & 1, (flags >> 1) & 1, (flags >> 2) & 1,
                    p[start:].decode("utf-8", "replace")))

    sock.close()
    json.dump({"mac": mac, "channel": channel, "time": time.strftime("%Y-%m-%d %H:%M:%S"),
               "exchanges": log}, open(out_path, "w", encoding="utf-8"), indent=1)
    print("\nsaved", out_path)


if __name__ == "__main__":
    main()
