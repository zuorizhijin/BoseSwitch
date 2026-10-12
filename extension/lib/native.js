// 扩展这一侧的小助手连接器：通过 Chrome Native Messaging 和本机小助手（helper/host.py）通信。
// 同时实现 Headset 需要的传输层接口：write(Uint8Array) 和 onData(回调)。

export const HOST_NAME = "com.boseswitch.helper";

const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (s) => Uint8Array.from((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

export class NativeHelper {
  #port;
  #nextId = 1;
  #pending = new Map();
  #dataCbs = [];
  #closeCbs = [];

  constructor(
    connect = () => chrome.runtime.connectNative(HOST_NAME),
    lastError = () => chrome.runtime.lastError?.message,
  ) {
    this.#port = connect();
    this.#port.onMessage.addListener((m) => this.#onMessage(m));
    this.#port.onDisconnect.addListener(() => {
      const reason = lastError() || "小助手已退出";
      for (const p of this.#pending.values()) p.reject(new Error(reason));
      this.#pending.clear();
      for (const cb of this.#closeCbs) cb(reason);
    });
  }

  #onMessage(m) {
    if (m.event === "data") {
      const u8 = fromHex(m.data);
      for (const cb of this.#dataCbs) cb(u8);
      return;
    }
    if (m.event === "closed") {
      for (const cb of this.#closeCbs) cb(m.reason);
      return;
    }
    const p = this.#pending.get(m.id);
    if (!p) return;
    this.#pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(new Error(m.error));
  }

  call(cmd, args = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#port.postMessage({ id, cmd, ...args });
    });
  }

  async devices() {
    return (await this.call("devices")).devices;
  }

  open(mac, channel = 8) {
    return this.call("open", { mac, channel });
  }

  write(u8) {
    return this.call("write", { data: toHex(u8) });
  }

  close() {
    return this.call("close");
  }

  onData(cb) {
    this.#dataCbs.push(cb);
  }

  onClose(cb) {
    this.#closeCbs.push(cb);
  }
}
