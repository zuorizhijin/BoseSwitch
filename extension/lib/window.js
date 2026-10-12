// 点扩展图标时打开独立小窗口（不跟着 Chrome 的弹出框一失焦就关掉）。
// 同一时间只保留一个窗口：已开着就提到前面，避免两个小助手抢 8 号频道。

const KEY = "panelWindowId";

export async function openPanel(c = chrome) {
  const { [KEY]: id } = await c.storage.session.get(KEY);
  if (id != null) {
    try {
      await c.windows.get(id);
      await c.windows.update(id, { focused: true });
      return;
    } catch {
      // 窗口已被关掉，往下重新打开
    }
  }
  const w = await c.windows.create({
    url: c.runtime.getURL("popup.html"),
    type: "popup",
    width: 380,
    height: 520,
  });
  await c.storage.session.set({ [KEY]: w.id });
}
