// 独立窗口测试：点扩展图标时打开（或聚焦已有的）独立小窗口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { openPanel } from "../extension/lib/window.js";

function fakeChrome({ existing = [] } = {}) {
  const windows = new Map(existing.map((id) => [id, { id }]));
  const calls = [];
  let store = {};
  let nextId = 100;
  return {
    calls,
    windows: {
      async get(id) {
        if (!windows.has(id)) throw new Error("No window with id: " + id);
        return windows.get(id);
      },
      async update(id, info) { calls.push(["update", id, info]); return windows.get(id); },
      async create(info) {
        const w = { id: nextId++ };
        windows.set(w.id, w);
        calls.push(["create", info]);
        return w;
      },
    },
    storage: { session: {
      async get(key) { return key in store ? { [key]: store[key] } : {}; },
      async set(obj) { store = { ...store, ...obj }; },
    } },
    runtime: { getURL: (p) => "chrome-extension://x/" + p },
  };
}

test("第一次点击：新建一个 popup 类型的独立窗口", async () => {
  const c = fakeChrome();
  await openPanel(c);
  assert.equal(c.calls.length, 1);
  const [kind, info] = c.calls[0];
  assert.equal(kind, "create");
  assert.equal(info.type, "popup");
  assert.equal(info.url, "chrome-extension://x/popup.html");
  assert.ok(info.width > 0 && info.height > 0);
});

test("窗口还开着：只把它提到前面，不重复打开", async () => {
  const c = fakeChrome();
  await openPanel(c);
  await openPanel(c);
  assert.equal(c.calls.filter(([k]) => k === "create").length, 1);
  assert.deepEqual(c.calls[1], ["update", 100, { focused: true }]);
});

test("窗口被用户关掉后：再点重新打开", async () => {
  const c = fakeChrome();
  await c.storage.session.set({ panelWindowId: 42 }); // 42 号窗口已不存在
  await openPanel(c);
  assert.equal(c.calls[0][0], "create");
});
