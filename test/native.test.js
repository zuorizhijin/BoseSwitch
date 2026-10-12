// 小助手连接器测试：用假的 Chrome 端口模拟小助手。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NativeHelper } from "../extension/lib/native.js";
import { Headset } from "../extension/lib/headset.js";

class FakePort {
  constructor(respond) {
    this.respond = respond ?? (() => ({ ok: true }));
    this.sent = [];
    this.msgCbs = [];
    this.discCbs = [];
    this.onMessage = { addListener: (cb) => this.msgCbs.push(cb) };
    this.onDisconnect = { addListener: (cb) => this.discCbs.push(cb) };
  }
  postMessage(m) {
    this.sent.push(m);
    const extra = this.respond(m, this);
    if (extra) setTimeout(() => this.deliver({ id: m.id, ...extra }), 1);
  }
  deliver(m) { for (const cb of this.msgCbs) cb(m); }
  disconnect() {}
  die() { for (const cb of this.discCbs) cb(); }
}

test("call 按 id 匹配回复", async () => {
  const port = new FakePort((m) => m.cmd === "devices" ? { ok: true, devices: [{ name: "黑战士" }] } : { ok: true });
  const h = new NativeHelper(() => port);
  assert.deepEqual(await h.devices(), [{ name: "黑战士" }]);
  assert.equal(port.sent[0].cmd, "devices");
});

test("小助手回复 ok:false 时抛出它的错误文字", async () => {
  const port = new FakePort(() => ({ ok: false, error: "TimeoutError: [WinError 10060]" }));
  const h = new NativeHelper(() => port);
  await assert.rejects(h.open("02:00:00:00:45:01"), /10060/);
  assert.deepEqual(port.sent[0], { id: 1, cmd: "open", mac: "02:00:00:00:45:01", channel: 8 });
});

test("write 把字节转成十六进制发给小助手", async () => {
  const port = new FakePort();
  const h = new NativeHelper(() => port);
  await h.write(Uint8Array.from([2, 2, 1, 0]));
  assert.deepEqual(port.sent[0], { id: 1, cmd: "write", data: "02020100" });
});

test("data 事件转成字节交给 onData；closed 事件交给 onClose", () => {
  const port = new FakePort();
  const h = new NativeHelper(() => port);
  const got = [];
  h.onData((u8) => got.push([...u8]));
  h.onClose((reason) => got.push(reason));
  port.deliver({ event: "data", data: "020203045affff00" });
  port.deliver({ event: "closed", reason: "耳机关闭了连接" });
  assert.deepEqual(got, [[2, 2, 3, 4, 0x5a, 0xff, 0xff, 0], "耳机关闭了连接"]);
});

test("小助手进程退出时，等待中的请求失败，并通知 onClose", async () => {
  const port = new FakePort(() => null);
  const h = new NativeHelper(() => port, () => "Specified native messaging host not found.");
  const closed = [];
  h.onClose((r) => closed.push(r));
  const pending = h.devices();
  port.die();
  await assert.rejects(pending, /native messaging host not found/);
  assert.deepEqual(closed, ["Specified native messaging host not found."]);
});

test("NativeHelper 可以直接作为 Headset 的传输层（回放真机录音）", async () => {
  const probe = JSON.parse(readFileSync(new URL("../fixtures/qc45_probe_readonly.json", import.meta.url)));
  const replies = Object.fromEntries(probe.exchanges.map((e) => [e.req, e.resp]));
  const port = new FakePort((m, p) => {
    if (m.cmd === "write" && replies[m.data]) {
      setTimeout(() => p.deliver({ event: "data", data: replies[m.data] }), 2);
    }
    return { ok: true };
  });
  const hs = new Headset(new NativeHelper(() => port));
  const s = await hs.readState();
  assert.equal(s.name, "黑战士");
  assert.equal(s.battery, 90);
  assert.equal(s.devices.length, 2);
});
