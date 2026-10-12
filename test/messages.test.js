import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyError } from "../extension/lib/messages.js";
import { BmapError } from "../extension/lib/headset.js";

test("没装小助手：Chrome 报 host not found", () => {
  assert.match(friendlyError(new Error("Specified native messaging host not found.")), /没有找到小助手/);
});

test("打不开通道：Windows 连接超时 10060", () => {
  const t = friendlyError(new Error("TimeoutError: [WinError 10060] 由于连接方在一段时间后没有正确答复"));
  assert.match(t, /连不上耳机/);
  assert.match(t, /名额/);
});

test("耳机回错误码 08：名额已满", () => {
  assert.match(friendlyError(new BmapError(4, 1, 8)), /名额已满/);
});

test("其他错误原样显示", () => {
  assert.equal(friendlyError(new Error("奇怪的错误")), "奇怪的错误");
});
