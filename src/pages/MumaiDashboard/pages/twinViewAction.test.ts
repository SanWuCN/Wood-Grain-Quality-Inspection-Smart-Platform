/**
 * 「切到内部点云」的跨树开关（`pages/twinViewAction.ts`）
 *
 * ── 为什么这条要有单测 ──────────────────────────────────────────────
 * 它由 **㉒ 那一轮**（小木带路）与**页面上的页签**两条路共用，而"事件名/载荷写错"
 * 既不报错也不崩，只表现为"念完了屏幕没切过去"——正是最该被钉住的那类毛病。
 * 同时钉住一条**剧情约束**：切内部点云挂在 ㉒（证据对照）上，
 * **不能挂 ⑪**（那一轮讲的是外观，精扫还没做）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_ROUNDS } from "../agent/script.ts";
import { TWIN_INTERNAL_CLOUD_EVENT, openInternalCloud } from "./twinViewAction.ts";

test("事件名固定（Twin 页监听的就是这一个常量）", () => {
  assert.equal(TWIN_INTERNAL_CLOUD_EVENT, "mumai:twin-internal-cloud");
});

test("派发带构件号 / 不带构件号两种载荷都对", () => {
  const sent: { type: string; detail: unknown }[] = [];
  const host = globalThis as unknown as { window?: unknown };
  const before = host.window;
  host.window = {
    dispatchEvent(event: { type: string; detail?: unknown }) {
      sent.push({ type: event.type, detail: event.detail });
      return true;
    },
  };
  try {
    assert.equal(openInternalCloud("Z04"), true);
    assert.equal(sent[0].type, TWIN_INTERNAL_CLOUD_EVENT);
    assert.deepEqual(sent[0].detail, { componentId: "Z04" });
    /* 不带构件号 = 保持当前选中；空串是"不指定"的意思，不是"选空白" */
    assert.equal(openInternalCloud(), true);
    assert.deepEqual(sent[1].detail, { componentId: "" });
  } finally {
    host.window = before;
  }
});

test("剧情约束：切内部点云挂 ㉒（证据对照），不挂 ⑪（那一轮讲外观）", () => {
  const round22 = SCRIPT_ROUNDS.find((item) => item.roundNo === "㉒");
  assert.ok(round22, "剧本里要有 ㉒");
  assert.equal(round22.nav?.route, "/twin", "㉒ 落在数字孪生页，切主视图才说得通");
  assert.match(round22.title, /证据对照/, "㉒ 是证据对照那一轮");

  /* ⑪ 是"外观初筛"：它的落点带 component=Z04（去看那一根），但台词**明确声明**内部不可判 ——
     所以内部点云不能挂在这一轮（那等于把后面精扫才得到的结论提前演了）。 */
  const round11 = SCRIPT_ROUNDS.find((item) => item.roundNo === "⑪");
  assert.ok(round11);
  assert.equal(round11.nav?.component, "Z04", "⑪ 只是把视角带到 Z04");
  const text11 = round11.lines.map((line) => line.text).join("");
  assert.match(text11, /不能确认内部是否存在空洞/, "⑪ 的台词必须保留「内部不可判」这句限定");
  assert.ok(!/虫蛀空洞|内部裂痕/.test(text11), "⑪ 的台词里不该出现内部缺陷的具体结论");
});
