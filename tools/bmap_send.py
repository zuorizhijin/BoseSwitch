"""按顺序发送 BMAP 原始包并打印回包，用于真机验证。

用法: python tools/bmap_send.py MAC [--ch 8] [--log out.jsonl] STEP [STEP ...]
STEP 是十六进制包（如 1f030502010 0，空格可省），或 sleep:秒数。
"""
import argparse
import json
import socket
import time

from bmap_probe import describe, exchange, split


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mac")
    ap.add_argument("--ch", type=int, default=8)
    ap.add_argument("--log")
    ap.add_argument("--wait", type=float, default=1.5)
    ap.add_argument("steps", nargs="+")
    a = ap.parse_args()

    # 先校验全部步骤：声明长度必须等于实际载荷长度，否则一个包都不发
    for step in a.steps:
        if step.startswith("sleep:"):
            continue
        req = bytes.fromhex(step.replace(" ", ""))
        if len(req) < 4 or req[3] != len(req) - 4:
            raise SystemExit("拒绝发送：包长度不符 %r" % step)

    sock =socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    sock.connect((a.mac, a.ch))
    log = open(a.log, "a", encoding="utf-8") if a.log else None
    exchange(sock, bytes.fromhex("00010100"))  # init: GET [0.1]
    for step in a.steps:
        if step.startswith("sleep:"):
            time.sleep(float(step[6:]))
            continue
        req = bytes.fromhex(step.replace(" ", ""))
        raw = exchange(sock, req, wait=a.wait)
        print(">> " + describe(req))
        for f in split(raw):
            print("   " + describe(f))
        if log:
            log.write(json.dumps({"t": time.strftime("%H:%M:%S"), "req": req.hex(),
                                  "resp": raw.hex()}) + "\n")
    sock.close()


if __name__ == "__main__":
    main()
