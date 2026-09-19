/**
 * 「车离线时建图页显示归档建图结果」· 单测（`pages/mapArchive.ts`）
 *
 * ── 这两条最容易出错，也最伤现场 ────────────────────────────────────
 *   1. **拿归档去顶实时**：车明明在线、或实时图已经来了，却还显示归档那一屏，
 *      看着就像"平台把上一次的结果当成本次结果"（这是诚实性红线，和 visibleCopy 同级）；
 *   2. **数字自己长出来**：版本号、覆盖率、格数、归档文件名只要有一处手写，
 *      改了 seed 就会两边不一致。所以逐项与 seed/归档清单对齐。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ARCHIVE_ITEMS, GRID_MAP, MAP_VERSIONS } from "../seed/scenario.ts";
import { archivedMapAssets, archivedMapPanel, gridRowColors, latestArchivedVersion } from "./mapArchive.ts";

test("有实时地图 / 车在线时**不显示**归档那一屏（不能拿归档顶实时）", () => {
  assert.equal(archivedMapPanel({ hasLiveMap: true, link: "offline" }), null, "有实时图时必须让实时图说话");
  assert.equal(archivedMapPanel({ hasLiveMap: false, link: "online" }), null, "车在线时空地图=还没开始建图，不该顶归档");
  assert.ok(archivedMapPanel({ hasLiveMap: false, link: "offline" }), "车离线且没有实时图时，才显示归档结果");
  /* link 未知（还没握手）时也按"离线可用"处理，页面不至于空着 */
  assert.ok(archivedMapPanel({ hasLiveMap: false, link: undefined }));
});

test("取的是最近一次**已保存/待检查**的版本，不取还在采集中的那一个", () => {
  const version = latestArchivedVersion();
  assert.notEqual(version.state, "采集中", "「采集中」还没保存，不能当作成功建图");
  const saved = MAP_VERSIONS.filter((item) => item.state !== "采集中");
  const newest = [...saved].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  assert.equal(version.id, newest.id, "应当取 updatedAt 最新的那个已保存版本");
  assert.equal(version.id, "MAP-SH-06", "当前 seed 里最新的是 MAP-SH-06");
  /* 数字逐个对齐 seed（不手写） */
  assert.equal(version.resolutionM, 0.05);
  assert.equal(version.coveragePct, 96);
  assert.equal(version.updatedAt, "2026-09-11 15:20");
});

test("栅格图与配色都来自 GRID_MAP（界面上没有第二份颜色表）", () => {
  const model = archivedMapPanel({ hasLiveMap: false, link: "offline" });
  assert.ok(model);
  assert.equal(model.grid, GRID_MAP, "缩略图画的就是 GRID_MAP 本身");
  assert.equal(model.grid.cells.length, GRID_MAP.width * GRID_MAP.height, "格数必须与宽高自洽");
  assert.deepEqual(gridRowColors(), GRID_MAP.legend.map((item) => ({ code: item.code, color: item.color })));
  /* 三种格子都要有对应颜色，否则画出来是一片黑 */
  const codes = new Set(model.grid.cells);
  for (const code of codes) {
    assert.ok(model.grid.legend.some((item) => item.code === code), `格值 ${code} 在 legend 里没有配色`);
  }
});

test("归档文件那一行来自 ARCHIVE_ITEMS 的「地图」组，并带上校验结论", () => {
  const assets = archivedMapAssets();
  const expected = ARCHIVE_ITEMS.filter((item) => item.group === "地图");
  assert.equal(assets.length, expected.length);
  assert.deepEqual(
    assets.map((item) => item.name),
    expected.map((item) => item.name),
  );
  /* 现场这两个文件是 present 且摘要一致 —— 界面上会写「SHA-256 一致」 */
  assert.ok(assets.every((item) => item.sha256Match), "归档清单里这两个地图文件的摘要应当一致");
  assert.ok(assets.some((item) => item.name === "MAP-SH-06.pgm"));
});

test("口径文案齐备：写明归档/非实时，并给出把实时画面找回来的步骤", () => {
  const model = archivedMapPanel({ hasLiveMap: false, link: "offline" });
  assert.ok(model);
  assert.match(model.caption, /归档/, "必须写明这是归档");
  assert.match(model.caption, /不是实时/, "必须写明不是实时");
  assert.match(model.headline, /离线/, "标题要说清为什么显示归档");
  assert.equal(model.recovery.length, 3, "恢复步骤三步：上电/同网段、重置链路、去设备页看自检");
  assert.ok(model.recovery.some((step) => step.includes("重置链路")), "要指向页面上那个真按钮");
});
