"""真机冒烟测试：像 Chrome 一样启动小助手，走一遍 devices → open → write → close。

用法: python tools/host_smoke.py [耳机名称关键字，默认 黑战士]
"""
import os
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "helper"))
from host import read_message, write_message  # noqa: E402

HOST = os.path.join(os.path.dirname(__file__), "..", "helper", "host.py")
want = sys.argv[1] if len(sys.argv) > 1 else "黑战士"

p = subprocess.Popen([sys.executable, "-I", HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
inbox = []


def pump():
    while True:
        m = read_message(p.stdout)
        if m is None:
            return
        inbox.append(m)
        print("  <-", m)


threading.Thread(target=pump, daemon=True).start()


def call(msg, wait=1.0):
    print("->", msg)
    write_message(p.stdin, msg)
    time.sleep(wait)


call({"id": 1, "cmd": "devices"})
devs = next(m for m in inbox if m.get("id") == 1)["devices"]
dev = next(d for d in devs if want in d["name"])
t0 = time.time()
call({"id": 2, "cmd": "open", "mac": dev["mac"], "channel": 8}, wait=0.2)
while not any(m.get("id") == 2 for m in inbox) and time.time() - t0 < 20:
    time.sleep(0.1)
print("  open 用时 %.1fs" % (time.time() - t0))
call({"id": 3, "cmd": "write", "data": "00010100"})
call({"id": 4, "cmd": "write", "data": "02020100"})
call({"id": 5, "cmd": "close"})
p.stdin.close()
p.wait(timeout=5)
print("小助手退出码", p.returncode)
