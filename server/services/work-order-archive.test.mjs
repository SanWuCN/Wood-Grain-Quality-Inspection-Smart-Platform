/**
 * 工单归档 · 服务端契约（用户 2026-10-01：「平台得能把工单归档」）
 *
 * ── 这条测试在钉什么 ────────────────────────────────────────────────
 * 归档是**终态**（没有"撤销归档"迁移），所以"允许从哪些状态归档"必须写死并可断言。
 * 改之前有两处不对，正是这条要防的：
 *   1. **待指派**的单子归档不了 —— 演示库那张单一直没指派（现场没人点"指派"），
 *      讲解人想收档时按钮根本不出现（能力位 `canArchive` 也不含它）；
 *   2. 能力位 `canArchive` 的名单里**有"已暂停"**、迁移表 `archive.from` 里**没有** ——
 *      暂停中的单子界面给按钮、服务端回 422 BAD_STATE。
 *
 * 现在两处同源：未归档即可归档。另外钉住归档之后**真的锁住**：
 * 不能再改指派、不能再改环境读数、也不能再归档一次。
 *
 * ⚠ 一个文件只起一个服务（同端口起第二个会卡住 —— 实测：拆成两个 test 各起一次，
 *   第二个 startService 永远不返回，整个 runner 挂住不退出）。
 * ⚠ 端口要与其它测试文件错开：`node --test "server/services/*.test.mjs"` 是**并行**跑的，
 *   两个文件占同一个端口会互相抢（实测 18092 与 device-link-reset 撞过一次，
 *   表现是别的用例莫名其妙红）。当前占用：18080/81/86/87/91/92/94/95/96/97，本文件用 **18098**。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("工单归档：待指派 / 已暂停都能归档，归档后锁住且可查", async () => {
  const { startService } = await import("../index.mjs");
  const service = await startService({ port: 18098, host: "127.0.0.1", dbFile: ":memory:", quiet: true });
  const base = service.url;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "shi", password: "123456" }),
  });
  const { token } = await login.json();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };
  const newOrder = async (tag) => {
    const created = await call("POST", "/api/work-orders/trigger", { eventId: `${tag}-${Date.now().toString(36)}` });
    assert.equal(created.status, 200, `建单失败：${created.status}`);
    return created.json.orderId;
  };

  try {
    /* ---------- ① 待指派：演示库那张单的真实状态 ---------- */
    const draftId = await newOrder("archive-draft");
    const before = await call("GET", `/api/work-orders/${draftId}`);
    assert.equal(before.json.order.status, "待指派");
    assert.equal(before.json.capabilities.canArchive, true, "待指派也应当能归档（用户 2026-10-01 口径）");

    const archived = await call("POST", `/api/work-orders/${draftId}/status`, { action: "archive" });
    assert.equal(archived.status, 200, `归档应成功，实得 ${archived.status} ${JSON.stringify(archived.json)}`);
    assert.equal(archived.json.order.status, "已归档", "状态动作的返回是 { ok, order, detail }，状态在 order.status 上");

    const after = await call("GET", `/api/work-orders/${draftId}`);
    assert.equal(after.json.order.status, "已归档");
    assert.equal(after.json.capabilities.canArchive, false, "已归档的单子不该再给「归档」按钮");
    assert.equal(after.json.capabilities.canAssign, false, "已归档的单子不能再改指派");
    assert.equal(after.json.capabilities.canEditEnvironment, false, "已归档的单子不能再改环境读数");

    /* 归档留痕：操作日志里要有一条"归档" */
    const logs = after.json.logs ?? [];
    assert.ok(
      logs.some((item) => String(item.type ?? "").includes("归档") || String(item.text ?? "").includes("归档")),
      `归档要在操作日志里留一条，实得 ${JSON.stringify(logs.slice(0, 3))}`,
    );

    /* 终态不能重复迁移 */
    const again = await call("POST", `/api/work-orders/${draftId}/status`, { action: "archive" });
    assert.equal(again.status, 422, "已归档再归档应回 422，而不是静默成功");

    /* 列表的「已归档」筛选里能查到它（现场找单子的入口） */
    const archivedList = await call("GET", "/api/work-orders?filter=archived");
    const rows = archivedList.json?.orders ?? [];
    assert.ok(rows.some((item) => item.id === draftId), "已归档筛选里应当能看到这张单");

    /* ---------- ② 已暂停：界面上本来就会给「归档」按钮，服务端必须认 ---------- */
    const pausedId = await newOrder("archive-paused");
    const assigned = await call("PUT", `/api/work-orders/${pausedId}/assignment`, {
      leaderAccountId: "shen",
      /* 参与人是**对象数组**（`{accountId, duties}`），传字符串会被 422 BAD_MEMBER 挡下 */
      members: [{ accountId: "shi", duties: [] }],
    });
    assert.equal(assigned.status, 200, `指派应成功，实得 ${assigned.status} ${JSON.stringify(assigned.json)}`);
    const paused = await call("POST", `/api/work-orders/${pausedId}/status`, { action: "pause" });
    assert.equal(paused.status, 200, `暂停应成功，实得 ${paused.status}`);

    const beforePausedArchive = await call("GET", `/api/work-orders/${pausedId}`);
    assert.equal(beforePausedArchive.json.order.status, "已暂停");
    assert.equal(beforePausedArchive.json.capabilities.canArchive, true, "暂停中的单子界面会给「归档」按钮");

    const pausedArchived = await call("POST", `/api/work-orders/${pausedId}/status`, { action: "archive" });
    assert.equal(pausedArchived.status, 200, "暂停中归档应成功（改之前这里回 422 BAD_STATE）");
    assert.equal(pausedArchived.json.order.status, "已归档");

    /* ---------- 收工：两张临时单都删掉 ---------- */
    assert.equal((await call("DELETE", `/api/work-orders/${draftId}`)).status, 200);
    assert.equal((await call("DELETE", `/api/work-orders/${pausedId}`)).status, 200);
  } finally {
    await service.close?.();
  }
});
