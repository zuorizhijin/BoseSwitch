import { NativeHelper } from "./lib/native.js";
import { Headset } from "./lib/headset.js";
import { cmd, OP } from "./lib/bmap.js";
import { friendlyError } from "./lib/messages.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let helper = null;
let hs = null;
let state = null;
let releasing = false;
let channelOpen = false;

function say(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = kind;
}

function setBusy(busy) {
  for (const b of document.querySelectorAll("section button")) b.disabled = busy;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function render() {
  const { name, model, productId, battery, mode, devices } = state;
  $("info").hidden = false;
  $("info").replaceChildren(
    el("b", { textContent: name }),
    ` · ${model ? model.name : "未知型号 0x" + productId.toString(16)} · 电量 ${battery}%`,
  );

  $("modes").hidden = !model;
  if (model) {
    $("modeButtons").replaceChildren(...model.modes.map((m) => el("button", {
      textContent: m.label,
      className: m.idx === mode ? "on" : "",
      onclick: () => act(`切换到${m.label}`, () => hs.request(model.writeMode(m.idx)), 800),
    })));
  }

  $("devices").hidden = false;
  $("deviceList").replaceChildren(...devices.map((d) => {
    const label = el("span", { className: "name", textContent: d.name || d.mac, title: d.mac });
    if (d.local) label.append(el("span", { className: "tag", textContent: "本机" }));
    const row = el("li", {}, el("span", { className: "dot" + (d.connected ? " on" : "") }), label);
    if (d.local) {
      row.append(
        el("button", { textContent: "拉到本机", title: "让耳机把音频连到这台电脑",
          onclick: pullHere }),
        el("button", { textContent: "让出耳机", title: "断开这台电脑，空出一个名额给别的设备",
          onclick: release }),
      );
    } else if (d.connected) {
      row.append(el("button", { textContent: "断开",
        onclick: () => act(`正在断开 ${d.name}`, () => hs.request(cmd.disconnect(d.mac)), 2500) }));
    } else {
      row.append(el("button", { textContent: "连接",
        onclick: () => act(`正在连接 ${d.name}`, () => hs.request(cmd.connect(d.mac)), 5000) }));
    }
    return row;
  }));
}

async function refresh() {
  state = await hs.readState();
  render();
}

// 发命令 → 等耳机处理 → 重新读取状态确认结果
async function act(label, fn, settleMs) {
  setBusy(true);
  say(label + "…");
  try {
    await fn();
    await sleep(settleMs);
    await refresh();
    say("完成", "ok");
  } catch (e) {
    say(friendlyError(e), "error");
  } finally {
    setBusy(!channelOpen);
  }
}

// 拉到本机：发连接命令后重读状态，明确告诉用户结果（之前只显示「完成」，看不出有没有生效）
async function pullHere() {
  const me = state.devices.find((d) => d.local);
  const already = me.connected;
  await act("正在把音频连到本机", () => hs.request(cmd.connect(me.mac)), 4000);
  if ($("msg").className === "error") return;
  const now = state.devices.find((d) => d.local);
  if (now?.connected) say(already ? "耳机本来就连在这台电脑上，不用再拉。" : "已把耳机连到这台电脑。", "ok");
  else say("耳机没有连到这台电脑，可能名额已满：请先在别的设备上让出耳机。", "error");
}

// 断开本机后耳机会立刻切断这条连接，所以不等回包，等连接关闭事件
function release() {
  const me = state.devices.find((d) => d.local);
  releasing = true;
  setBusy(true);
  say("正在让出耳机…");
  hs.request(cmd.disconnect(me.mac)).catch(() => {});
}

function onPush(f) {
  if (!state || f.op !== OP.STATUS) return;
  const { model } = state;
  if (model && f.fblock === model.modeFblock && f.func === model.modeFunc) state.mode = model.parseMode(f.payload);
  else if (f.fblock === 2 && f.func === 2) state.battery = f.payload[0];
  else return;
  render();
}

async function start() {
  say("正在启动小助手…");
  helper = new NativeHelper();
  helper.onClose((reason) => {
    channelOpen = false;
    setBusy(true);
    if (releasing) say("已让出耳机。在另一台电脑上点「拉到本机」就能接过去。", "ok");
    else say("连接断开了：" + friendlyError(new Error(reason)), "error");
  });

  const list = await helper.devices();
  if (!list.length) {
    say("这台电脑还没有配对任何 Bose 耳机。", "error");
    return;
  }
  const { last } = await chrome.storage.local.get("last");
  const current = list.find((d) => d.mac === last) ?? list[0];
  $("headset").replaceChildren(...list.map((d) => el("option", {
    value: d.mac, textContent: d.name, selected: d.mac === current.mac,
  })));

  say(`正在连接 ${current.name}…`);
  await helper.open(current.mac, 8);
  channelOpen = true;
  hs = new Headset(helper);
  hs.onFrame(onPush);
  await hs.request(cmd.bmapVersion());
  await refresh();
  say("");
}

// 换耳机：记住选择后重开弹窗逻辑（新开一个小助手进程，避免两条连接混用）
$("headset").onchange = async (e) => {
  await chrome.storage.local.set({ last: e.target.value });
  location.reload();
};
$("refresh").onclick = () => location.reload();

start().catch((e) => {
  say(friendlyError(e), "error");
  setBusy(false);
});
