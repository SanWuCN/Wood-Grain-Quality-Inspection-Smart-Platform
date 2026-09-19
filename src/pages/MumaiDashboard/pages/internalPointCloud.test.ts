/**
 * 内部点云（`internalPointCloud.ts`）的生成结果（unit test）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * 这一屏是**按外形生成的**结构视图，所以"生成得对不对"只能靠断言，不能靠看：
 *   1. **别编缺陷**：Z01 / Z02 的档案是「外观连续」「表面轻微褪色」——
 *      生成器必须一处内部缺陷都不给它们，否则等于平台替健康构件造病；
 *   2. **别跑到柱子外面**：所有点（含缺陷）都要落在自己那根柱子的圆柱范围内，
 *      跑出去就是「点云飘在空中」，一眼假；
 *   3. **可复现**：同一根柱子每次必须给同一份点云（现场说"刚才那个洞"得对得上）；
 *   4. **来源文本要在**：界面上那行"按外形生成、不是实测点云"必须存在（口径要求）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLUMN_SPECS,
  DEFECT_RECIPES,
  DEFECT_STYLE,
  INTERNAL_CLOUD_SOURCE_NOTE,
  buildColumnCloud,
  buildInternalCloud,
  materialFromArchive,
  mulberry32,
  radiusFromArchive,
  seedOf,
} from "./internalPointCloud.ts";

/** 取点集里每个点的坐标 */
function coords(points: Float32Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let index = 0; index + 2 < points.length; index += 3) {
    out.push([points[index], points[index + 1], points[index + 2]]);
  }
  return out;
}

test("外形取自档案：四柱位置 ±2.2，柱径由档案里的「直径 xxx mm」换算", () => {
  const byId = new Map(COLUMN_SPECS.map((spec) => [spec.componentId, spec]));
  assert.deepEqual(
    [...byId.keys()],
    ["Z01", "Z02", "Z03", "Z04"],
    "四根柱子都要在（缺一根就少一屏内容）",
  );
  assert.deepEqual(
    ["Z01", "Z02", "Z03", "Z04"].map((id) => [byId.get(id)!.x, byId.get(id)!.z]),
    [
      [-2.2, 2.2],
      [2.2, 2.2],
      [-2.2, -2.2],
      [2.2, -2.2],
    ],
    "柱位必须与 COMPONENTS[].scene 一致（±2.2）",
  );
  /* 档案里的直径：320 / 318 / 356 / 360 mm → 半径 0.16 / 0.159 / 0.178 / 0.18 */
  assert.deepEqual(
    ["Z01", "Z02", "Z03", "Z04"].map((id) => Number(byId.get(id)!.radiusM.toFixed(3))),
    [0.16, 0.159, 0.178, 0.18],
    "柱径换算：mm → m（除以 2000 得半径）",
  );
  assert.equal(radiusFromArchive("直径 320mm"), 0.16);
  assert.equal(radiusFromArchive("没有写直径"), 0.18, "档案缺项时用保守默认值");
  assert.equal(materialFromArchive("Z04 档案：楠木，直径 360mm"), "楠木");
});

test("健康构件不生成内部缺陷（Z01/Z02 按档案「外观连续/轻微褪色」）", () => {
  assert.deepEqual(DEFECT_RECIPES.Z01, [], "Z01 档案写「外观连续，未见明显缺损」——不许给它编洞");
  assert.deepEqual(DEFECT_RECIPES.Z02, [], "Z02 档案写「表面轻微褪色，无结构疑点」");
  const cloud = buildInternalCloud();
  const z01 = cloud.columns.find((column) => column.spec.componentId === "Z01")!;
  assert.equal(z01.defects.length, 0);
  assert.equal(cloud.totals.borer, 2, "只有 Z04 有两处虫蛀");
  assert.equal(cloud.totals.crack, 2, "Z03 一条 + Z04 一条");
  assert.equal(cloud.totals.damage, 1, "Z04 柱脚修补处缺损");
});

test("Z04 的两处虫蛀直接引用风险记录的编号与措辞（不另抄一份）", () => {
  const z04 = buildInternalCloud().columns.find((column) => column.spec.componentId === "Z04")!;
  const borers = z04.defects.filter((defect) => defect.kind === "borer");
  assert.equal(borers.length, 2);
  for (const borer of borers) {
    assert.match(borer.source, /^CUR-Z04-\d\d$/, `虫蛀要挂到风险记录上，实得 ${borer.source}`);
    assert.match(borer.label, /虫蛀空洞/, "名字要带「虫蛀空洞」（与风险表同措辞）");
  }
  assert.notEqual(borers[0].source, borers[1].source, "上下两处是两条不同的记录");
});

test("所有点都落在各自柱子的圆柱范围内（跑出去就是「点云飘在空中」）", () => {
  for (const column of buildInternalCloud().columns) {
    const { x, z, radiusM, baseY, heightM } = column.spec;
    const groups: [string, Float32Array][] = [
      ["外壳", column.shell],
      ["芯部", column.core],
      ...column.defects.map((defect) => [defect.label, defect.points] as [string, Float32Array]),
    ];
    for (const [name, points] of groups) {
      assert.ok(points.length > 0, `${column.spec.componentId} 的${name}没有点`);
      for (const [px, py, pz] of coords(points)) {
        const radial = Math.hypot(px - x, pz - z);
        /* 虫蛀腔体中心可以略偏，但整体不许超过柱面 12% */
        assert.ok(radial <= radiusM * 1.12, `${column.spec.componentId} 的${name}跑出柱面：${radial.toFixed(3)} > ${radiusM}`);
        assert.ok(
          py >= baseY - 0.02 && py <= baseY + heightM + 0.02,
          `${column.spec.componentId} 的${name}超出柱高：y=${py.toFixed(3)}`,
        );
      }
    }
  }
});

test("外表壳点足够密（看得出是圆柱），芯部比外壳稀", () => {
  for (const column of buildInternalCloud().columns) {
    const shellCount = column.shell.length / 3;
    const coreCount = column.core.length / 3;
    assert.ok(shellCount > 8000, `${column.spec.componentId} 外壳点太少：${shellCount}`);
    assert.ok(coreCount > 1000 && coreCount < shellCount, `芯部点数不合理：${coreCount}`);
  }
});

test("确定性：同一根柱子两次生成完全一致（现场「刚才那个洞」要对得上）", () => {
  const first = buildColumnCloud(COLUMN_SPECS[3]);
  const second = buildColumnCloud(COLUMN_SPECS[3]);
  assert.deepEqual([...first.shell].slice(0, 30), [...second.shell].slice(0, 30));
  assert.equal(first.defects[0].source, second.defects[0].source);
  assert.deepEqual([...first.defects[0].points].slice(0, 30), [...second.defects[0].points].slice(0, 30));
  /* 种子本身也稳定，且不同构件给不同种子 */
  assert.equal(seedOf("Z04"), seedOf("Z04"));
  assert.notEqual(seedOf("Z04"), seedOf("Z03"));
  /* PRNG 值域 [0,1) */
  const random = mulberry32(42);
  for (let index = 0; index < 50; index += 1) {
    const value = random();
    assert.ok(value >= 0 && value < 1, `mulberry32 越界：${value}`);
  }
});

test("来源说明与图例文案齐备（口径要求：必须写明「按外形生成、不是实测」）", () => {
  assert.match(INTERNAL_CLOUD_SOURCE_NOTE, /按构件外形与档案记录生成/, "要写明是生成的");
  assert.match(INTERNAL_CLOUD_SOURCE_NOTE, /不是实测点云/, "要写明不是实测的");
  assert.match(INTERNAL_CLOUD_SOURCE_NOTE, /预置结果/, "缺陷要标成预置结果");
  assert.deepEqual(
    Object.keys(DEFECT_STYLE).sort(),
    ["borer", "crack", "damage"],
    "三类缺陷：虫蛀 / 裂痕 / 破损",
  );
  for (const style of Object.values(DEFECT_STYLE)) {
    assert.match(style.color, /^#[0-9a-f]{6}$/i, `配色要给十六进制值：${style.color}`);
  }
});

test("可以只看某一根（页面按选中构件过滤时走的就是这条路径）", () => {
  const only = buildInternalCloud(["Z04"]);
  assert.equal(only.columns.length, 1);
  assert.equal(only.columns[0].spec.componentId, "Z04");
  assert.equal(only.totals.borer, 2);
  assert.equal(only.totals.crack, 1);
  assert.equal(buildInternalCloud([]).columns.length, 4, "空数组=四根全要（不是一根都不要）");
});
