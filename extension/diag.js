import { NativeHelper } from "./lib/native.js";
import { FrameParser, cmd } from "./lib/bmap.js";

const OPS = ["SET", "GET", "SETGET", "STATUS", "ERROR", "START", "RESULT", "PROCESSING"];
const $ = (id) => document.getElementById(id);
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const fromHex = (s) => Uint8Array.from(s.replace(/\s+/g, "").match(/../g).map((h) => parseInt(h, 16)));
const describe = (fb, fn, op, payload) => `[${fb}.${fn}] ${OPS[op] ?? op} len=${payload.length} ${hex(payload)}`;

function log(msg) {
  $("log").textContent += `${new Date().toTimeString().slice(0, 8)}  ${msg}\n`;
}

const helper = new NativeHelper();
const parser = new FrameParser();
helper.onData((u8) => {
  for (const f of parser.push(u8)) log("<< " + describe(f.fblock, f.func, f.op, f.payload));
});
helper.onClose((reason) => {
  log("连接关闭: " + reason);
  $("send").disabled = true;
});

async function send(u8) {
  log(">> " + describe(u8[0], u8[1], u8[2] & 0x0f, u8.slice(4)));
  await helper.write(u8);
}

$("open").onclick = async () => {
  try {
    await helper.open($("dev").value, 8);
    log("通道已打开: " + $("dev").value);
    $("send").disabled = false;
    await send(cmd.bmapVersion());
  } catch (e) {
    log("打开失败: " + e.message);
  }
};

$("send").onclick = async () => {
  try {
    const u8 = fromHex($("hex").value);
    if (u8.length < 4 || u8[3] !== u8.length - 4) throw new Error("包长度不符");
    await send(u8);
  } catch (e) {
    log("发送失败: " + e.message);
  }
};

$("copy").onclick = () => navigator.clipboard.writeText($("log").textContent);

helper.devices().then((list) => {
  $("dev").replaceChildren(...list.map((d) => Object.assign(document.createElement("option"), {
    value: d.mac, textContent: `${d.name}  (${d.mac}, 0x${d.productId.toString(16)})`,
  })));
  log(`找到 ${list.length} 个已配对的 Bose 设备`);
}).catch((e) => log("小助手不可用: " + e.message));
