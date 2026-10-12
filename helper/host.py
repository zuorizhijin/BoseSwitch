"""BoseSwitch 小助手：Chrome Native Messaging 宿主，只负责和耳机收发原始字节。

扩展 → 小助手: {"id": n, "cmd": "devices" | "open" | "write" | "close", ...}
回复:          {"id": n, "ok": true, ...} 或 {"id": n, "ok": false, "error": "..."}
主动事件:      {"event": "data", "data": "<十六进制>"} / {"event": "closed", "reason": "..."}
协议解析全部在扩展里做（extension/lib/）。
"""
import json
import os
import queue
import re
import socket
import struct
import sys
import threading
import time


def read_message(stream):
    head = stream.read(4)
    if len(head) < 4:
        return None
    (n,) = struct.unpack("<I", head)
    return json.loads(stream.read(n).decode("utf-8"))


def write_message(stream, obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("<I", len(data)) + data)
    stream.flush()


# Bose 的蓝牙厂商 ID 是 0x009E（来源 0001 = 蓝牙 SIG）
_PID_RE = re.compile(r"_VID&0001009E_PID&([0-9A-F]{4})$", re.I)
_MAC_RE = re.compile(r"&([0-9A-F]{12})_C[0-9A-F]+$", re.I)


def parse_bthenum_pid(key_name):
    m = _PID_RE.search(key_name)
    return int(m.group(1), 16) if m else None


def parse_instance_mac(key_name):
    m = _MAC_RE.search(key_name)
    if not m:
        return None
    h = m.group(1).lower()
    return ":".join(h[i:i + 2] for i in range(0, 12, 2))


def _subkeys(key):
    import winreg
    i = 0
    while True:
        try:
            yield winreg.EnumKey(key, i)
        except OSError:
            return
        i += 1


def _paired_name(mac):
    import winreg
    path = "SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\" + mac.replace(":", "")
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as k:
            raw, _ = winreg.QueryValueEx(k, "Name")
    except OSError:
        return None
    return bytes(raw).split(b"\0")[0].decode("utf-8", "replace")


def list_bose_devices_windows():
    """从注册表列出已配对的 Bose 设备：MAC、名称、产品 ID。"""
    import winreg
    found = {}
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Enum\BTHENUM") as root:
        for name in _subkeys(root):
            pid = parse_bthenum_pid(name)
            if pid is None:
                continue
            with winreg.OpenKey(root, name) as svc:
                for inst in _subkeys(svc):
                    mac = parse_instance_mac(inst)
                    if mac:
                        found[mac] = pid
    devices = []
    for mac, pid in found.items():
        name = _paired_name(mac)
        if name is not None:  # 取消配对后注册表可能残留，只保留仍在配对列表里的
            devices.append({"mac": mac, "name": name, "productId": pid})
    return sorted(devices, key=lambda d: d["name"])


def open_rfcomm_windows(mac, channel, timeout=15):
    s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    s.settimeout(timeout)
    s.connect((mac, channel))
    s.settimeout(None)
    return s


class Host:
    def __init__(self, opener, emit, list_devices):
        self._opener = opener
        self._emit = emit
        self._list = list_devices
        self._sock = None

    def handle(self, msg):
        rid, cmd = msg.get("id"), msg.get("cmd")
        try:
            if cmd == "devices":
                return {"id": rid, "ok": True, "devices": self._list()}
            if cmd == "open":
                self._close()
                sock = self._opener(msg["mac"], int(msg.get("channel", 8)))
                self._sock = sock
                threading.Thread(target=self._reader, args=(sock,), daemon=True).start()
                return {"id": rid, "ok": True}
            if cmd == "write":
                if self._sock is None:
                    raise RuntimeError("通道没有打开")
                self._sock.sendall(bytes.fromhex(msg["data"]))
                return {"id": rid, "ok": True}
            if cmd == "close":
                self._close()
                return {"id": rid, "ok": True}
            raise ValueError("未知命令 %r" % cmd)
        except Exception as e:  # 所有失败都回给扩展显示，不让小助手退出
            log("%s 失败: %s: %s" % (cmd, type(e).__name__, e))
            return {"id": rid, "ok": False, "error": "%s: %s" % (type(e).__name__, e)}

    def _reader(self, sock):
        reason = "耳机关闭了连接"
        try:
            while True:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                self._emit({"event": "data", "data": chunk.hex()})
        except OSError as e:
            reason = str(e)
        if sock is self._sock:  # 我们主动关闭的旧连接不报事件
            self._sock = None
            log("连接断开: " + reason)
            self._emit({"event": "closed", "reason": reason})

    def _close(self):
        sock, self._sock = self._sock, None
        if sock is not None:
            sock.close()


if sys.platform == "win32":
    LOG_PATH = os.path.join(os.environ.get("LOCALAPPDATA", ""), "BoseSwitch", "helper.log")
else:
    LOG_PATH = os.path.expanduser("~/Library/Logs/BoseSwitch/helper.log")


def log(text):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")
    except OSError:
        pass


def platform_parts():
    """返回 (打开通道, 列出设备, 等待函数)。macOS 的等待函数会驱动事件循环。"""
    if sys.platform == "win32":
        return open_rfcomm_windows, list_bose_devices_windows, time.sleep
    if sys.platform == "darwin":
        # python -I 不会把脚本目录加入 sys.path，这里手动加
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import mac_bt
        return mac_bt.RfcommSocket, mac_bt.list_bose_devices, mac_bt.pump
    raise SystemExit("不支持的系统: " + sys.platform)


def main():
    opener, list_devices, wait = platform_parts()
    lock = threading.Lock()
    out = sys.stdout.buffer

    def emit(obj):
        with lock:
            write_message(out, obj)

    # 读 stdin 放到后台线程；主线程负责处理命令（macOS 的蓝牙调用必须在主线程）
    inbox = queue.Queue()

    def read_stdin():
        while True:
            msg = read_message(sys.stdin.buffer)
            inbox.put(msg)
            if msg is None:
                return

    threading.Thread(target=read_stdin, daemon=True).start()
    host = Host(opener=opener, emit=emit, list_devices=list_devices)
    log("启动 " + sys.platform)
    while True:
        wait(0.02)
        try:
            msg = inbox.get_nowait()
        except queue.Empty:
            continue
        if msg is None:
            break
        emit(host.handle(msg))
    host.handle({"cmd": "close"})
    log("退出")


def selftest(name_part=""):
    """不经过 Chrome 的自检：列出 Bose 设备 → 打开通道 → 读电量 → 关闭。"""
    opener, list_devices, wait = platform_parts()
    if sys.platform == "darwin":
        import mac_bt
        print("已配对设备（名称, 地址, 厂商ID, 产品ID, 已连接）:")
        for row in mac_bt.list_all_paired():
            print("  ", row)
    devices = list_devices()
    print("Bose 设备:", devices)
    dev = next((d for d in devices if name_part in d["name"]), None)
    if dev is None:
        print("没有找到 Bose 设备")
        return 1
    events = []
    host = Host(opener=opener, emit=events.append, list_devices=list_devices)
    t0 = time.time()
    r = host.handle({"id": 1, "cmd": "open", "mac": dev["mac"], "channel": 8})
    print("打开通道 %.1fs:" % (time.time() - t0), r)
    if not r["ok"]:
        return 1
    for data in ("00010100", "02020100"):
        print("写入", data, host.handle({"id": 2, "cmd": "write", "data": data}))
        end = time.time() + 1.5
        while time.time() < end:
            wait(0.05)
    for e in events:
        print("收到", e)
        if e.get("data", "").startswith("02020304"):
            print("==> 电量 %d%%" % int(e["data"][8:10], 16))
    print("关闭", host.handle({"id": 3, "cmd": "close"}))
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        args = [a for a in sys.argv[1:] if a != "--selftest"]
        raise SystemExit(selftest(args[0] if args else ""))
    main()
