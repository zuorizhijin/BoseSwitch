// 把底层错误翻译成用户看得懂的中文提示
import { BmapError } from "./headset.js";

export function friendlyError(e) {
  if (e instanceof BmapError && e.code === 8) {
    return "耳机拒绝了：两个连接名额已满，请先断开一台设备。";
  }
  const text = String(e?.message ?? e);
  if (/native messaging host not found/i.test(text)) {
    return "没有找到小助手。请先在这台电脑上运行 helper 文件夹里的安装脚本，然后刷新扩展。";
  }
  if (/10060|timed out/i.test(text)) {
    return "连不上耳机。可能是耳机没开机或不在附近；也可能两个连接名额都被其他设备占着，"
      + "请在已连接的设备上点「让出耳机」，或者断开手机。";
  }
  return text;
}
