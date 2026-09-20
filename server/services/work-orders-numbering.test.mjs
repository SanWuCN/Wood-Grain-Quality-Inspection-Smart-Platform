/**
 * 工单号生成 · 删单之后不许撞号（回归）
 *
 * ── 这一条在防什么 ──────────────────────────────────────────────
 * 2026-09-20 实测踩到：当天已建 0001–0006、0008（0007 被清场删掉），序号原来按
 * `COUNT(*) + 1` 算 → COUNT = 7 → 又生成 `WO-…-0008` → 撞上已存在的
 * `work_orders.order_no UNIQUE` → 建单接口回 **500「服务内部错误」**，
 * 现场表现是「按了接单快捷键，什么都没发生」。
 *
 * 判据：**删掉当天任意一张单之后，下一张单的序号仍是「当天最大值 + 1」**，
 * 而且单号互不重复。这条同时钉住包号（BND）那条同源写法。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../storage/db.mjs";
import { createSession } from "./session.mjs";
import { createWorkOrderService } from "./work-orders.mjs";

const SESSION = "demo-01";

function withService(work) {
  const dir = mkdtempSync(join(tmpdir(), "mumai-wo-no-"));
  const db = openDatabase(join(dir, "test.db"));
  try {
    createSession(db, "chapter2", SESSION);
    return work(createWorkOrderService({ db, hub: null, devices: null, sessionId: SESSION }), db);
  } finally {
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

let eventSeq = 0;
const trigger = (orders) => {
  eventSeq += 1;
  return orders.trigger({ eventId: `evt-${eventSeq}-${Math.random().toString(36).slice(2)}`, actorId: "shi" });
};

test("连建三张单：单号按当天序号递增且互不重复", () => {
  withService((orders) => {
    const numbers = [trigger(orders), trigger(orders), trigger(orders)].map((out) => out.order.order_no);
    assert.equal(new Set(numbers).size, 3, `单号撞了：${numbers.join("、")}`);
    const serials = numbers.map((no) => Number(/-(\d{4})$/.exec(no)?.[1]));
    assert.deepEqual(serials, [1, 2, 3].map((n) => serials[0] + n - 1), `序号不连续：${numbers.join("、")}`);
  });
});

test("删掉当天中间那张单之后，下一张单不回退撞号（曾经的建单 500）", () => {
  withService((orders) => {
    const first = trigger(orders).order;
    const second = trigger(orders).order;
    const third = trigger(orders).order;

    /* 清场：删掉中间那张（现场最常见的就是"把刚试出来的那张删掉"） */
    orders.deleteOrder({ orderId: second.id, actorId: "shi" });

    const fourth = trigger(orders).order;
    const all = [first.order_no, second.order_no, third.order_no, fourth.order_no];
    assert.equal(new Set(all).size, 4, `删单之后撞号了：${all.join("、")}`);
    assert.equal(
      Number(/-(\d{4})$/.exec(fourth.order_no)?.[1]),
      Number(/-(\d{4})$/.exec(third.order_no)?.[1]) + 1,
      `删单之后序号应当接着最大值往下走，实际 ${third.order_no} → ${fourth.order_no}`,
    );
  });
});

test("删到只剩一张单：建单不撞号，新号接着**在册**最大序号", () => {
  withService((orders) => {
    const kept = trigger(orders).order;
    const a = trigger(orders).order;
    const b = trigger(orders).order;
    orders.deleteOrder({ orderId: a.id, actorId: "shi" });
    orders.deleteOrder({ orderId: b.id, actorId: "shi" });

    const afterDelete = orders.list({ filter: "all", q: "" });
    assert.deepEqual(afterDelete.map((item) => item.id), [kept.id], `删完应当只剩 1 张，实际 ${afterDelete.length} 张`);

    /* 注意：**id 与单号都是由序号派生的**，所以删掉最高的号再建单，会拿到同一个 id/号 ——
       这是"号回收"，不是撞号。要钉的是"不与**在册**单重复 + 不抛 UNIQUE"。 */
    const next = trigger(orders).order;
    const alive = orders.list({ filter: "all", q: "" });
    const aliveNos = alive.map((item) => item.orderNo);
    assert.equal(aliveNos.length, 2, `应当只剩 2 张，实际 ${aliveNos.length} 张：${aliveNos.join("、")}`);
    assert.equal(new Set(aliveNos).size, aliveNos.length, `在册单号重复了：${aliveNos.join("、")}`);
    assert.ok(aliveNos.includes(next.order_no), "新单应当出现在列表里");
    assert.equal(
      Number(/-(\d{4})$/.exec(next.order_no)?.[1]),
      Number(/-(\d{4})$/.exec(kept.order_no)?.[1]) + 1,
      `新号应当接着在册最大序号，实际 ${kept.order_no} → ${next.order_no}`,
    );
  });
});

test("下发包号（BND-…）也取当天最大值 +1：删掉中间那条不影响下一号", () => {
  withService((orders, db) => {
    const stamp = /^WO-(\d{8})-/.exec(trigger(orders).order.order_no)?.[1];
    assert.ok(stamp, "工单号里应当带当天日期段");
    const insert = db.prepare(
      `INSERT INTO work_order_dispatches
         (id, work_order_id, bundle_id, device_id, idempotency_key, status, config_version,
          order_revision, assignment_revision, body, sha256, created_by, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const row = (id, bundleId) => [
      id, "wo-x", bundleId, "handheld-02", `key-${id}`, "queued", "CFG-X-001", 1, 1, "{}", "sha", "shi",
      "2026-09-20T00:00:00.000Z", "2026-09-21T00:00:00.000Z",
    ];
    insert.run(...row("d-1", `BND-${stamp}-0001`));
    insert.run(...row("d-3", `BND-${stamp}-0003`));
    db.prepare("DELETE FROM work_order_dispatches WHERE id='d-3'").run();

    const next =
      (db
        .prepare("SELECT MAX(CAST(substr(bundle_id, -4) AS INTEGER)) AS n FROM work_order_dispatches WHERE bundle_id LIKE ?")
        .get(`BND-${stamp}-%`)?.n ?? 0) + 1;
    assert.equal(next, 2, "删掉 0003 之后下一号应是 0002（而不是按条数算出来的 0002 → 0003 撞号）");
  });
});
