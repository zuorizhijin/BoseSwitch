"""macOS 蓝牙层：用 IOBluetooth（PyObjC）列出 Bose 设备、打开 RFCOMM 通道。

IOBluetooth 的回调只在调用线程的 NSRunLoop 运行时送达，所以本模块的函数都要在主线程调用，
等待期间由 pump() 驱动事件循环。RFCOMM 打开流程参考 bosectl（MIT，aaronsb/bosectl）。
"""
import queue
import time

import objc
from Foundation import NSDate, NSDefaultRunLoopMode, NSObject, NSRunLoop
from IOBluetooth import IOBluetoothDevice

BOSE_VENDOR_ID = 0x009E
KNOWN_BOSE_PIDS = {0x4020, 0x4039}  # 取不到厂商 ID 时的兜底：QC35 II、QC45

objc.registerMetaDataForSelector(
    b"IOBluetoothDevice",
    b"openRFCOMMChannelSync:withChannelID:delegate:",
    dict(arguments={
        2: dict(type=objc._C_PTR + objc._C_ID, type_modifier=objc._C_OUT),
        3: dict(type=objc._C_USHT),
        4: dict(type=objc._C_ID),
    }),
)


def pump(seconds):
    NSRunLoop.currentRunLoop().runMode_beforeDate_(
        NSDefaultRunLoopMode, NSDate.dateWithTimeIntervalSinceNow_(seconds))


def _wait(pred, timeout):
    end = time.time() + timeout
    while time.time() < end and not pred():
        pump(0.05)
    return pred()


def _ids(device):
    def call(name):
        fn = getattr(device, name, None)
        try:
            return int(fn()) if fn else None
        except Exception:
            return None
    return call("vendorID"), call("productID")


def list_bose_devices():
    out = []
    for d in IOBluetoothDevice.pairedDevices() or []:
        vid, pid = _ids(d)
        if vid != BOSE_VENDOR_ID and not (vid is None and pid in KNOWN_BOSE_PIDS):
            continue
        mac = str(d.addressString()).replace("-", ":").lower()
        out.append({"mac": mac, "name": str(d.name() or mac), "productId": pid or 0})
    return sorted(out, key=lambda x: x["name"])


def list_all_paired():
    """自检用：列出所有已配对设备及其厂商/产品 ID。"""
    rows = []
    for d in IOBluetoothDevice.pairedDevices() or []:
        vid, pid = _ids(d)
        rows.append((str(d.name()), str(d.addressString()), vid, pid, bool(d.isConnected())))
    return rows


class _Delegate(NSObject):
    def init(self):
        self = objc.super(_Delegate, self).init()
        if self is None:
            return None
        self.baseband_status = None
        self.channel_status = None
        self.inbox = queue.Queue()
        return self

    def connectionComplete_status_(self, device, status):
        self.baseband_status = status

    def rfcommChannelOpenComplete_status_(self, channel, status):
        self.channel_status = status

    @objc.typedSelector(b"v@:@^vQ")
    def rfcommChannelData_data_length_(self, channel, data_ptr, length):
        try:
            self.inbox.put(bytes(data_ptr.as_buffer(length)))
        except Exception:
            self.inbox.put(bytes(data_ptr[:length]))

    def rfcommChannelClosed_(self, channel):
        self.inbox.put(b"")


class RfcommSocket:
    """提供和 Python socket 相同的 sendall / recv / close，供 host.Host 使用。

    构造、sendall、close 必须在主线程调用；recv 可在任意线程阻塞等待。
    """

    def __init__(self, mac, channel_id, timeout=15):
        self._device = IOBluetoothDevice.deviceWithAddressString_(mac.replace(":", "-"))
        if self._device is None:
            raise OSError("找不到设备 %s" % mac)
        self._delegate = _Delegate.alloc().init()
        self._channel = None
        if not self._device.isConnected():
            # 先建立基带连接（会呼叫耳机）。名额已满时这里会失败
            status = self._device.openConnection_(self._delegate)
            if status != 0 or not _wait(lambda: self._delegate.baseband_status is not None, timeout) \
                    or self._delegate.baseband_status != 0:
                raise OSError("连不上耳机（基带连接失败，状态 %s）" % self._delegate.baseband_status)
        status, channel = self._device.openRFCOMMChannelSync_withChannelID_delegate_(
            None, channel_id, self._delegate)
        if status != 0 or channel is None:
            raise OSError("打开 RFCOMM 通道 %d 失败（状态 %d）" % (channel_id, status))
        _wait(lambda: self._delegate.channel_status is not None, 3)
        self._channel = channel

    def sendall(self, data):
        if self._channel is None:
            raise OSError("通道已关闭")
        status = self._channel.writeSync_length_(data, len(data))
        if status != 0:
            raise OSError("写入失败（状态 %d）" % status)

    def recv(self, n):
        return self._delegate.inbox.get()

    def close(self):
        channel, self._channel = self._channel, None
        if channel is not None:
            try:
                channel.closeChannel()
            except Exception:
                pass
        self._delegate.inbox.put(b"")
