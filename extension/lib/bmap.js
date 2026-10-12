// BMAP（Bose 耳机控制协议）编解码。纯函数，不做 I/O，扩展页面和 Node 测试共用。
// 包格式: [功能块, 功能, 标志(低 4 位是操作符), 载荷长度, ...载荷]

export const OP = { SET: 0, GET: 1, SETGET: 2, STATUS: 3, ERROR: 4, START: 5, RESULT: 6, PROCESSING: 7 };

export function encode(fblock, func, op, payload = []) {
  const p = Uint8Array.from(payload);
  const out = new Uint8Array(4 + p.length);
  out.set([fblock, func, op & 0x0f, p.length]);
  out.set(p, 4);
  return out;
}

const macBytes = (mac) => mac.split(":").map((h) => parseInt(h, 16));
const macStr = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join(":");
const utf8 = (u8) => new TextDecoder().decode(u8);

export const cmd = {
  // 连接后先发这一条：QC45 先回它，之后才响应其他请求
  bmapVersion: () => encode(0, 1, OP.GET),
  productId: () => encode(0, 3, OP.GET),
  firmware: () => encode(0, 5, OP.GET),
  productName: () => encode(1, 2, OP.GET),
  battery: () => encode(2, 2, OP.GET),
  currentMode: () => encode(31, 3, OP.GET),
  setMode: (idx, announce = false) => encode(31, 3, OP.START, [idx, announce ? 1 : 0]),
  // QC35 II 等老型号的降噪档位：回包载荷 [当前值, 支持位图]
  anr: () => encode(1, 6, OP.GET),
  setAnr: (level) => encode(1, 6, OP.SETGET, [level]),
  listDevices: () => encode(4, 4, OP.GET),
  deviceInfo: (mac) => encode(4, 5, OP.GET, macBytes(mac)),
  connect: (mac) => encode(4, 1, OP.START, [0, ...macBytes(mac)]),
  // 断开没有前导 0；带上会被耳机拒绝（bosebridge 记录）
  disconnect: (mac) => encode(4, 2, OP.START, macBytes(mac)),
};

export class FrameParser {
  #buf = new Uint8Array(0);

  push(chunk) {
    const data = new Uint8Array(this.#buf.length + chunk.length);
    data.set(this.#buf);
    data.set(chunk, this.#buf.length);
    const frames = [];
    let pos = 0;
    while (pos + 4 <= data.length && pos + 4 + data[pos + 3] <= data.length) {
      const n = data[pos + 3];
      frames.push({
        fblock: data[pos],
        func: data[pos + 1],
        op: data[pos + 2] & 0x0f,
        payload: data.slice(pos + 4, pos + 4 + n),
      });
      pos += 4 + n;
    }
    this.#buf = data.slice(pos);
    return frames;
  }
}

export const parseBattery = (p) => p[0];
export const parseProductId = (p) => ({ productId: (p[0] << 8) | p[1], variant: p[2] });
// 首字节是 00，不属于名称
export const parseProductName = (p) => utf8(p.slice(1));
export const parseFirmware = (p) => utf8(p);

export function parseDeviceList(p) {
  const macs = [];
  for (let i = 1; i + 6 <= p.length; i += 6) macs.push(macStr(p.slice(i, i + 6)));
  return { connectedMask: p[0], macs };
}

export function parseDeviceInfo(p) {
  const flags = p[6];
  const boseProduct = (flags & 0b100) !== 0;
  // Bose 自家产品在名称前多 3 字节（产品 ID + 变体），其他设备多 2 字节
  return {
    mac: macStr(p.slice(0, 6)),
    connected: (flags & 0b1) !== 0,
    local: (flags & 0b10) !== 0,
    boseProduct,
    name: utf8(p.slice(boseProduct ? 10 : 9)),
  };
}

// 每个型号的降噪命令不同：readMode / writeMode 生成请求，parseMode 从回包或推送里取出当前值，
// modeFblock / modeFunc 用来识别耳机主动推送的模式变化
const MODELS = {
  0x4039: {
    name: "QuietComfort 45",
    modes: [{ idx: 0, label: "安静" }, { idx: 1, label: "感知" }],
    modeFblock: 31, modeFunc: 3,
    readMode: cmd.currentMode,
    writeMode: (idx) => cmd.setMode(idx),
    parseMode: (p) => p[0],
  },
  // 不支持 [31.3]（回错误 03），档位值 1=强 3=弱 0=关，2026-10-13 真机读到
  0x4020: {
    name: "QuietComfort 35 II",
    // 用户只在耳机上手动关闭降噪（档位 0），所以不提供「关闭」按钮；处于关闭时两个按钮都不高亮
    modes: [{ idx: 1, label: "强" }, { idx: 3, label: "弱" }],
    modeFblock: 1, modeFunc: 6,
    readMode: cmd.anr,
    writeMode: cmd.setAnr,
    parseMode: (p) => p[0],
  },
};

export const modelFor = (productId) => MODELS[productId] ?? null;
