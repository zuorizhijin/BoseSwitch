// 会话层测试：用回放真机录音的假传输层驱动 Headset。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Headset, BmapError } from "../extension/lib/headset.js";

const hex = (s) => Uint8Array.from((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const toHex = (u8) => Buffer.from(u8).toString("hex");
const probe = JSON.parse(readFileSync(new URL("../fixtures/qc45_probe_readonly.json", import.meta.url)));

// 收到某个请求时，回放录到的回包；没录到的请求不回应
class ReplayTransport {
  constructor(replies) {
    this.replies = replies;
    this.writes = [];
    this.listener = null;
  }
  onData(cb) { this.listener = cb; }
  async write(u8) {
    const req = toHex(u8);
    this.writes.push("w:" + req);
    const resp = this.replies[req];
    if (resp !== undefined) {
      setTimeout(() => {
        this.writes.push("r:" + req);
        this.listener(hex(resp));
      }, 5);
    }
  }
}

const probeReplies = Object.fromEntries(probe.exchanges.map((e) => [e.req, e.resp]));

test("请求按功能块/功能匹配回包，跳过同一段里迟到的 [0.1]", async () => {
  const hs = new Headset(new ReplayTransport({ "1f030100": "00010305312e312e301f03030101" }));
  const f = await hs.request(hex("1f030100"));
  assert.deepEqual([f.fblock, f.func, [...f.payload]], [31, 3, [1]]);
});

test("START 请求收到 PROCESSING 就算被接受", async () => {
  const hs = new Headset(new ReplayTransport({ "1f0305020100": "1f030700" }));
  const f = await hs.request(hex("1f0305020100"));
  assert.equal(f.op, 7);
});

test("ERROR 回包抛出带错误码的 BmapError", async () => {
  const hs = new Headset(new ReplayTransport(probeReplies));
  await assert.rejects(hs.request(hex("1f010100")), (e) => e instanceof BmapError && e.code === 5);
});

test("没有回包时超时", async () => {
  const hs = new Headset(new ReplayTransport({}));
  await assert.rejects(hs.request(hex("02020100"), { timeout: 50 }), /超时/);
});

test("同时发出的请求排队：前一个有回包后才写下一个", async () => {
  const t = new ReplayTransport(probeReplies);
  const hs = new Headset(t);
  const A = "040501060200000000a1";
  const B = "040501060200000000b2";
  const [fa, fb] = await Promise.all([hs.request(hex(A)), hs.request(hex(B))]);
  assert.deepEqual(t.writes, ["w:" + A, "r:" + A, "w:" + B, "r:" + B]);
  assert.equal(fa.payload[5], 0xa1); // 回包里的 MAC 末字节：A 是电脑，B 是 iPhone
  assert.equal(fb.payload[5], 0xb2);
});

test("耳机主动推送的帧交给监听者", async () => {
  const t = new ReplayTransport({});
  const hs = new Headset(t);
  const seen = [];
  hs.onFrame((f) => seen.push([f.fblock, f.func, f.payload[0]]));
  t.listener(hex("1f03030101"));
  assert.deepEqual(seen, [[31, 3, 1]]);
});

test("不认识的型号不读模式，仍然返回电量和设备列表", async () => {
  const replies = { ...probeReplies, "00030100": "00030303999901" }; // 产品 ID 改成未知的 0x9999
  const t = new ReplayTransport(replies);
  const s = await new Headset(t).readState();
  assert.equal(s.model, null);
  assert.equal(s.mode, null);
  assert.equal(s.battery, 90);
  assert.equal(s.devices.length, 2);
  assert.ok(!t.writes.includes("w:1f030100"), "不应读取 [31.3]");
});

test("readState 汇总型号、名称、电量、模式和设备列表", async () => {
  const hs = new Headset(new ReplayTransport(probeReplies));
  const s = await hs.readState();
  assert.equal(s.productId, 0x4039);
  assert.equal(s.model.name, "QuietComfort 45");
  assert.equal(s.name, "黑战士");
  assert.equal(s.battery, 90);
  assert.equal(s.mode, 0);
  assert.deepEqual(s.devices.map((d) => [d.name, d.connected, d.local]), [
    ["MY-PC", true, true],
    ["My-iPhone-13", true, false],
  ]);
});

test("QC35 II：readState 用 [1.6] 读降噪档位，不碰 [31.3]", async () => {
  const qc35 = JSON.parse(readFileSync(new URL("../fixtures/qc35_probe_readonly.json", import.meta.url)));
  const replies = { ...probeReplies, ...Object.fromEntries(qc35.exchanges.map((e) => [e.req, e.resp])) };
  const t = new ReplayTransport(replies);
  const s = await new Headset(t).readState();
  assert.equal(s.model.name, "QuietComfort 35 II");
  assert.equal(s.name, "Bose QC35 II");
  assert.equal(s.battery, 100);
  assert.equal(s.mode, 1);
  assert.ok(!t.writes.includes("w:1f030100"), "不应读取 [31.3]");
});
