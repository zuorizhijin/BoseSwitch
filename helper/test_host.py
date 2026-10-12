"""小助手测试。运行: python -m unittest discover -s helper"""
import io
import struct
import threading
import unittest

import host


class FakeSocket:
    """模拟 RFCOMM socket：记录写入，可手动推送回包或模拟对端断开。"""

    def __init__(self):
        self.sent = b""
        self.closed = False
        self._chunks = []
        self._cv = threading.Condition()

    def sendall(self, data):
        if self.closed:
            raise OSError("closed")
        self.sent += data

    def recv(self, n):
        with self._cv:
            while not self._chunks:
                self._cv.wait()
            chunk = self._chunks.pop(0)
        if chunk is None:
            return b""
        return chunk

    def push(self, chunk):
        with self._cv:
            self._chunks.append(chunk)
            self._cv.notify()

    def close(self):
        self.closed = True
        self.push(None)


class Collector:
    def __init__(self):
        self.items = []
        self.cv = threading.Condition()

    def __call__(self, obj):
        with self.cv:
            self.items.append(obj)
            self.cv.notify_all()

    def wait_for(self, pred, timeout=2):
        with self.cv:
            ok = self.cv.wait_for(lambda: any(pred(i) for i in self.items), timeout)
        return ok


class FramingTest(unittest.TestCase):
    def test_roundtrip_with_little_endian_length(self):
        buf = io.BytesIO()
        host.write_message(buf, {"id": 1, "cmd": "devices", "名": "黑战士"})
        raw = buf.getvalue()
        self.assertEqual(struct.unpack("<I", raw[:4])[0], len(raw) - 4)
        self.assertEqual(host.read_message(io.BytesIO(raw)), {"id": 1, "cmd": "devices", "名": "黑战士"})

    def test_eof_returns_none(self):
        self.assertIsNone(host.read_message(io.BytesIO(b"")))


class RegistryNameTest(unittest.TestCase):
    # 键名取自本机注册表 Enum\BTHENUM（2026-10-12）
    def test_bose_service_key_gives_product_id(self):
        self.assertEqual(host.parse_bthenum_pid("{0000110B-0000-1000-8000-00805F9B34FB}_VID&0001009E_PID&4039"), 0x4039)
        self.assertEqual(host.parse_bthenum_pid("{0000110b-0000-1000-8000-00805f9b34fb}_VID&0001009e_PID&4020"), 0x4020)

    def test_other_vendor_is_ignored(self):
        self.assertIsNone(host.parse_bthenum_pid("{0000110B-0000-1000-8000-00805F9B34FB}_VID&0001004C_PID&2014"))
        self.assertIsNone(host.parse_bthenum_pid("Dev_020000004501"))

    def test_instance_key_gives_mac(self):
        self.assertEqual(host.parse_instance_mac("7&DF4B050&0&020000004501_C00000000"), "02:00:00:00:45:01")
        self.assertIsNone(host.parse_instance_mac("8&34781811&0&97"))


class HostTest(unittest.TestCase):
    def setUp(self):
        self.sock = FakeSocket()
        self.opened = []
        self.events = Collector()

        def opener(mac, channel):
            self.opened.append((mac, channel))
            return self.sock

        self.host = host.Host(opener=opener, emit=self.events, list_devices=lambda: [
            {"mac": "02:00:00:00:45:01", "name": "黑战士", "productId": 0x4039}])

    def test_devices(self):
        r = self.host.handle({"id": 1, "cmd": "devices"})
        self.assertEqual(r, {"id": 1, "ok": True, "devices": [
            {"mac": "02:00:00:00:45:01", "name": "黑战士", "productId": 0x4039}]})

    def test_open_write_and_receive(self):
        self.assertEqual(self.host.handle({"id": 2, "cmd": "open", "mac": "02:00:00:00:45:01", "channel": 8}),
                         {"id": 2, "ok": True})
        self.assertEqual(self.opened, [("02:00:00:00:45:01", 8)])
        self.assertEqual(self.host.handle({"id": 3, "cmd": "write", "data": "02020100"}), {"id": 3, "ok": True})
        self.assertEqual(self.sock.sent, bytes.fromhex("02020100"))
        self.sock.push(bytes.fromhex("020203045affff00"))
        self.assertTrue(self.events.wait_for(lambda e: e == {"event": "data", "data": "020203045affff00"}))

    def test_open_failure_is_reported(self):
        def bad_opener(mac, channel):
            raise TimeoutError("[WinError 10060] 连接超时")
        h = host.Host(opener=bad_opener, emit=self.events, list_devices=list)
        r = h.handle({"id": 4, "cmd": "open", "mac": "02:00:00:00:45:01", "channel": 8})
        self.assertEqual(r["ok"], False)
        self.assertIn("10060", r["error"])

    def test_write_before_open_fails(self):
        r = self.host.handle({"id": 5, "cmd": "write", "data": "02020100"})
        self.assertEqual(r["ok"], False)

    def test_remote_close_emits_closed_event(self):
        self.host.handle({"id": 6, "cmd": "open", "mac": "02:00:00:00:45:01", "channel": 8})
        self.sock.push(None)
        self.assertTrue(self.events.wait_for(lambda e: e.get("event") == "closed"))

    def test_close(self):
        self.host.handle({"id": 7, "cmd": "open", "mac": "02:00:00:00:45:01", "channel": 8})
        self.assertEqual(self.host.handle({"id": 8, "cmd": "close"}), {"id": 8, "ok": True})
        self.assertTrue(self.sock.closed)

    def test_unknown_command(self):
        r = self.host.handle({"id": 9, "cmd": "fly"})
        self.assertEqual(r["ok"], False)


if __name__ == "__main__":
    unittest.main()
