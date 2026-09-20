/**
 * ㉑「本批次分析流程」逐段推进（`fusionReveal.ts`）
 *
 * 与 `cleanFlowReveal.test.ts` 同一套判据，另加两条这一页特有的：
 *   · **没有计划时必须是 `null`** —— 人自己打开融合页要看到四块全在，
 *     不能因为"脚本没在推"就少一块（那是最容易出的回归）；
 *   · **四块面板都要挂上 `is-flow-pending`** —— 静态检查 JSX 源码，
 *     漏挂一块的表现是"流程推完了，那块从一开始就一直在"（界面上很难一眼看出）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FUSION_FLOW_SECTIONS,
  advanceFusionReveal,
  beginFusionReveal,
  cancelFusionReveal,
  fusionSectionsFor,
} from "./fusionReveal.ts";

/** 记账式 window 替身（同 `cleanFlowReveal.test.ts`）：定时器回调由测试自己触发 */
type FakeTimer = { id: number; fn: () => void; ms: number };
const timers: FakeTimer[] = [];
const cleared: number[] = [];
let nextTimerId = 1;

(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => {
    const id = nextTimerId++;
    timers.push({ id, fn, ms });
    return id;
  },
  clearTimeout: (id: number) => {
    cleared.push(id);
  },
};

const last = () => timers[timers.length - 1];

test("没有计划时读到的必须是 null：人自己打开融合页，四块照旧全在", () => {
  cancelFusionReveal();
  assert.equal(fusionSectionsFor(), null, "没计划时页面要自己决定显示什么（四块全在）");
});

test("登记后从第一段开始（一段都不预支），推进幂等", () => {
  beginFusionReveal(["completeness", "visual", "radar", "fusion"]);
  assert.deepEqual(fusionSectionsFor(), [], "刚登记时不能先把任何一段点亮");

  advanceFusionReveal(["completeness"]);
  assert.deepEqual(fusionSectionsFor(), ["completeness"]);

  advanceFusionReveal(["completeness"]);
  assert.deepEqual(fusionSectionsFor(), ["completeness"], "同一拍重复推进不能重复点亮或回退");

  advanceFusionReveal(["visual", "radar"]);
  assert.deepEqual(
    fusionSectionsFor(),
    ["completeness", "visual", "radar"],
    "顺序按计划里的段顺序给（页面照它决定显示哪几块）",
  );
  cancelFusionReveal();
});

test("推完最后一段页面仍读得到（融合视图真的要出现），计划由 TTL 或用户动手解除", () => {
  beginFusionReveal(["completeness", "fusion"]);
  advanceFusionReveal(["completeness"]);
  advanceFusionReveal(["fusion"]);
  assert.deepEqual(
    fusionSectionsFor(),
    ["completeness", "fusion"],
    "推完最后一拍不能立刻解除：一解除页面就只读到 null，最后一段的推进等于没发生",
  );
  cancelFusionReveal();
  assert.equal(fusionSectionsFor(), null);
});

test("非法段名不占名额；全是非法段名等于没登记", () => {
  cancelFusionReveal();
  beginFusionReveal(["radar", "根本没有这一段", "fusion"]);
  advanceFusionReveal(["radar", "根本没有这一段", "fusion"]);
  assert.deepEqual(fusionSectionsFor(), ["radar", "fusion"], "非法段名被过滤掉，合法段照常点亮");
  cancelFusionReveal();

  beginFusionReveal(["根本没有这一段"]);
  assert.equal(fusionSectionsFor(), null, "全是非法段名 == 没登记计划");

  assert.deepEqual([...FUSION_FLOW_SECTIONS], ["completeness", "visual", "radar", "fusion"]);
});

test("兜底 TTL：到点自动解除，页面回到四块全在，不留半截舞台", () => {
  beginFusionReveal(["completeness", "visual", "radar", "fusion"]);
  const timer = last();
  assert.ok(timer.ms > 0 && timer.ms <= 60_000, "兜底时长要有限");

  advanceFusionReveal(["completeness"]);
  assert.deepEqual(fusionSectionsFor(), ["completeness"]);

  timer.fn();
  assert.equal(fusionSectionsFor(), null, "到点必须解除");
});

test("重新登记会先解除上一份（不并发两份计划）", () => {
  beginFusionReveal(["completeness", "visual"]);
  const first = last();
  beginFusionReveal(["fusion"]);
  assert.ok(cleared.includes(first.id), "上一份的兜底定时器要被清掉");
  assert.deepEqual(fusionSectionsFor(), []);
  advanceFusionReveal(["visual"]);
  assert.deepEqual(fusionSectionsFor(), [], "旧计划的段不该还能被点亮");
  cancelFusionReveal();
});

test("页面侧：融合页订阅了推进计划，且四块面板都挂了 is-flow-pending", () => {
  /* 静态检查（与 cleanFlowReveal / operationInsights 同一做法）：漏挂一块 =
     "流程推完了那一块却从一开始就在"，界面上很难一眼看出来。 */
  const source = readFileSync(new URL("./pages/adaptTabs.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("useFusionReveal()"), "融合页要订阅这一份推进计划");
  for (const section of FUSION_FLOW_SECTIONS) {
    assert.ok(
      source.includes(`show("${section}")`),
      `第 ${section} 段没有接上推进计划（没挂 is-flow-pending）`,
    );
  }
  assert.ok(source.includes("is-flow-pending"), "要挂上「未跑到先不显示」的那个类");
  /* 探针判据：融合页唯一的骨架类名，写错会让逐段推进静默失效 */
  const css = readFileSync(new URL("./pages.css", import.meta.url), "utf8");
  assert.ok(css.includes(".adapt-grid--fusion .tech-panel.is-flow-pending"), "隐藏规则要落在融合页的网格里");
});
