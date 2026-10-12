// 协议核心测试。所有字节都来自 2026-10-12 在 QC45（黑战士，0x4039）上录到的真实收发，见 fixtures/。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OP, encode, FrameParser, cmd,
  parseBattery, parseProductId, parseProductName, parseFirmware,
  parseDeviceList, parseDeviceInfo, modelFor,
} from "../extension/lib/bmap.js";

const hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const toHex = (u8) => Buffer.from(u8).toString("hex");
const probe = JSON.parse(readFileSync(new URL("../fixtures/qc45_probe_readonly.json", import.meta.url)));
const respOf = (name) => hex(probe.exchanges.find((e) => e.name === name).resp);
const payloadOf = (name) => new FrameParser().push(respOf(name))[0].payload;

const PC = "02:00:00:00:00:a1";
const IPHONE = "02:00:00:00:00:b2";

test("encode 生成 4 字节头 + 载荷", () => {
  assert.equal(toHex(encode(0x1f, 3, OP.START, [1, 0])), "1f0305020100");
  assert.equal(toHex(encode(4, 4, OP.GET)), "04040100");
});

test("命令字节与真机验证过的包一致", () => {
  assert.equal(toHex(cmd.setMode(1)), "1f0305020100");
  assert.equal(toHex(cmd.setMode(0)), "1f0305020000");
  assert.equal(toHex(cmd.connect(IPHONE)), "04010507000200000000b2");
  assert.equal(toHex(cmd.connect(PC)), "04010507000200000000a1");
  assert.equal(toHex(cmd.disconnect(PC)), "040205060200000000a1");
  assert.equal(toHex(cmd.deviceInfo(IPHONE)), "040501060200000000b2");
  assert.equal(toHex(cmd.listDevices()), "04040100");
});

test("FrameParser 拆开粘在一起的两帧（迟到的 [0.1] + 本次回包）", () => {
  const frames = new FrameParser().push(hex("00010305312e312e301f03030100"));
  assert.deepEqual(frames.map((f) => [f.fblock, f.func, f.op]), [[0, 1, OP.STATUS], [31, 3, OP.STATUS]]);
  assert.deepEqual([...frames[1].payload], [0]);
});

test("FrameParser 能拼回被切成两段的一帧", () => {
  const p = new FrameParser();
  const whole = hex("040503150200000000b20100004d792d6950686f6e652d3133");
  assert.deepEqual(p.push(whole.slice(0, 7)), []);
  const frames = p.push(whole.slice(7));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 21);
});

test("ERROR 帧带错误码", () => {
  const [f] = new FrameParser().push(respOf("all_modes"));
  assert.equal(f.op, OP.ERROR);
  assert.equal(f.payload[0], 5);
});

test("解析电量、产品 ID、名称、固件", () => {
  assert.equal(parseBattery(payloadOf("battery")), 90);
  assert.deepEqual(parseProductId(payloadOf("product_id")), { productId: 0x4039, variant: 1 });
  assert.equal(parseProductName(payloadOf("product_name")), "黑战士");
  assert.equal(parseFirmware(payloadOf("firmware")), "4.0.4-4360+de6a887");
});

test("解析设备列表：首字节是已连接位图，后面每 6 字节一个 MAC", () => {
  assert.deepEqual(parseDeviceList(payloadOf("dm_list_devices")), {
    connectedMask: 3, macs: [PC, IPHONE],
  });
  // iPhone 被踢下线后，列表仍保留它，位图变为 01
  assert.deepEqual(parseDeviceList(hex("010200000000a10200000000b2")).connectedMask, 1);
});

test("解析设备详情：连接状态、是否本机、名称", () => {
  assert.deepEqual(parseDeviceInfo(payloadOf(`dm_info ${IPHONE}`)), {
    mac: IPHONE, connected: true, local: false, boseProduct: false, name: "My-iPhone-13",
  });
  assert.deepEqual(parseDeviceInfo(payloadOf(`dm_info ${PC}`)), {
    mac: PC, connected: true, local: true, boseProduct: false, name: "MY-PC",
  });
  // 被踢下线后的 iPhone（真机回包）
  const offline = new FrameParser().push(hex("040503150200000000b20000004d792d6950686f6e652d3133"))[0];
  assert.equal(parseDeviceInfo(offline.payload).connected, false);
});

test("按产品 ID 识别型号和降噪模式", () => {
  const qc45 = modelFor(0x4039);
  assert.equal(qc45.name, "QuietComfort 45");
  assert.deepEqual(qc45.modes.map((m) => m.idx), [0, 1]);
  assert.equal(modelFor(0x9999), null);
});

// QC35 II（0x4020）：2026-10-13 在 Mac 上录到的只读回包，见 fixtures/qc35_probe_readonly.json
test("QC35 II 降噪走 [1.6]：读、写命令和档位", () => {
  const qc35 = modelFor(0x4020);
  assert.equal(qc35.name, "QuietComfort 35 II");
  assert.deepEqual(qc35.modes.map((m) => [m.idx, m.label]), [[1, "强"], [3, "弱"]]); // 用户只在耳机上手动关闭，不要「关闭」按钮
  assert.equal(toHex(qc35.readMode()), "01060100");
  // SETGET，载荷只有档位（based-connect 的写法）
  assert.equal(toHex(qc35.writeMode(3)), "0106020103");
  assert.deepEqual([qc35.modeFblock, qc35.modeFunc], [1, 6]);
  const f = new FrameParser().push(hex("01060302010b"))[0];
  assert.equal(qc35.parseMode(f.payload), 1);
});

test("QC45 的模式命令也通过型号表给出", () => {
  const qc45 = modelFor(0x4039);
  assert.equal(toHex(qc45.readMode()), "1f030100");
  assert.equal(toHex(qc45.writeMode(1)), "1f0305020100");
  assert.deepEqual([qc45.modeFblock, qc45.modeFunc], [31, 3]);
  assert.equal(qc45.parseMode(hex("01")), 1);
});
