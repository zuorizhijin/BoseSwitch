// 会话层：在任意字节传输（Web Serial、本机助手等）上收发 BMAP 请求。
// 传输层只需提供 write(Uint8Array) 和 onData(回调)。
import {
  OP, FrameParser, cmd,
  parseBattery, parseProductId, parseProductName, parseDeviceList, parseDeviceInfo, modelFor,
} from "./bmap.js";

export class BmapError extends Error {
  constructor(fblock, func, code) {
    super(`耳机拒绝了 [${fblock}.${func}]，错误码 ${code}`);
    this.code = code;
  }
}

export class Headset {
  #transport;
  #parser = new FrameParser();
  #pending = null;
  #queue = Promise.resolve();
  #listeners = [];

  constructor(transport) {
    this.#transport = transport;
    transport.onData((chunk) => {
      for (const f of this.#parser.push(chunk)) this.#dispatch(f);
    });
  }

  onFrame(cb) {
    this.#listeners.push(cb);
  }

  #dispatch(f) {
    const p = this.#pending;
    if (p && f.fblock === p.fblock && f.func === p.func) {
      if (p.accept.includes(f.op)) return p.resolve(f);
      if (f.op === OP.ERROR) return p.reject(new BmapError(f.fblock, f.func, f.payload[0]));
    }
    for (const cb of this.#listeners) cb(f);
  }

  // 一次只有一个请求在等回包；回包按功能块/功能匹配，不按到达顺序
  request(packet, { timeout = 3000 } = {}) {
    const run = () => new Promise((resolve, reject) => {
      // START 是动作：耳机回 PROCESSING 或 RESULT 即表示接受，结果要另外读回确认
      const accept = (packet[2] & 0x0f) === OP.START ? [OP.PROCESSING, OP.RESULT] : [OP.STATUS];
      const done = (fn, v) => {
        clearTimeout(timer);
        this.#pending = null;
        fn(v);
      };
      const timer = setTimeout(
        () => done(reject, new Error(`等待 [${packet[0]}.${packet[1]}] 回包超时`)), timeout);
      this.#pending = {
        fblock: packet[0], func: packet[1], accept,
        resolve: (f) => done(resolve, f),
        reject: (e) => done(reject, e),
      };
      this.#transport.write(packet).catch((e) => done(reject, e));
    });
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  async readState() {
    const { productId } = parseProductId((await this.request(cmd.productId())).payload);
    const model = modelFor(productId);
    const name = parseProductName((await this.request(cmd.productName())).payload);
    const battery = parseBattery((await this.request(cmd.battery())).payload);
    // 模式命令因型号而异；不认识的型号只跳过模式，其他照常读
    const mode = model ? model.parseMode((await this.request(model.readMode())).payload) : null;
    const { macs } = parseDeviceList((await this.request(cmd.listDevices())).payload);
    const devices = [];
    for (const mac of macs) {
      devices.push(parseDeviceInfo((await this.request(cmd.deviceInfo(mac))).payload));
    }
    return { productId, model, name, battery, mode, devices };
  }
}
