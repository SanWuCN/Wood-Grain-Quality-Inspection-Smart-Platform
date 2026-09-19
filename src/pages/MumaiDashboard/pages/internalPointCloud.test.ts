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
  fitDistance,
  fitGroupDistance,
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
      ["内部木料", column.volume],
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

/*
  ── 这一组是「实心点云柱」的核心判据（用户 2026-09-30 改口径之后）──────────
  用户原话：「做的是一个 3d 的点云展示，就是木柱内部都是点云，破损可视化之类的」。
  于是要证伪两件事：
    ① 内部**真的填满了**（不是只有壳）—— 判据是内部点数与柱子体积同量级；
    ② 破损**真的是被掏空的**（不是叠几个彩色球）—— 判据是虫蛀空腔、裂痕缝里
       **一个木料点都没有**。第 ② 条尤其重要：它一旦坏了，画面上会变成「洞里有渣」。
*/
test("内部木料按体积填满（实心点云柱，不是只有壳）", () => {
  for (const column of buildInternalCloud().columns) {
    const volumeM3 = Math.PI * column.spec.radiusM ** 2 * column.spec.heightM;
    const count = column.volume.length / 3;
    const shellCount = column.shell.length / 3;
    assert.ok(count > 12_000, `${column.spec.componentId} 内部点太少（${count}），看着还是空壳`);
    assert.ok(count > shellCount, `内部点应当比壳点多（内部 ${count} vs 壳 ${shellCount}）`);
    /* 与体积同量级：落在 5 万–30 万点/m³ 之间都算"填满" */
    const density = count / volumeM3;
    assert.ok(density > 50_000 && density < 300_000, `${column.spec.componentId} 体密度不合理：${Math.round(density)} 点/m³`);
  }
});

test("虫蛀空洞是掏空的：空腔里一个木料点都没有", () => {
  const z04 = buildInternalCloud().columns.find((column) => column.spec.componentId === "Z04")!;
  const material = [...coords(z04.volume), ...coords(z04.shell)];
  const borers = z04.defects.filter((defect) => defect.kind === "borer");
  assert.equal(borers.length, 2);
  for (const borer of borers) {
    const inside = material.filter(([px, py, pz]) => {
      const dx = px - borer.centroid.x;
      const dy = (py - borer.centroid.y) / 1.25;
      const dz = pz - borer.centroid.z;
      return Math.hypot(dx, dy, dz) < 0.06; // 腔半径 0.085–0.1，取六成算"洞里"
    });
    assert.deepEqual(inside.slice(0, 3), [], `${borer.label} 里还有木料点（${inside.length} 个）—— 洞会看着像塞了渣`);
    assert.ok(borer.points.length / 3 > 1000, `${borer.label} 没画出腔壁`);
  }
});

test("破损缺口里没有木料点，且缺口面画出来了", () => {
  const z04 = buildInternalCloud().columns.find((column) => column.spec.componentId === "Z04")!;
  const damage = z04.defects.find((defect) => defect.kind === "damage")!;
  assert.ok(damage, "Z04 要有柱脚破损");
  const spec = z04.spec;
  const halfSpan = (96 * Math.PI) / 180 / 2;
  const topV = 0.06 + 0.5 * 0.35;
  /*
    ⚠ 判据取**缺口内圈**（角向与高度都在前半段）：那里的"啃掉深度"明确小于 1
      （缺口边缘处 bite 趋近 1，柱面点本来就该在），拿边缘去断言会误伤 —— 第一版就这么红的。
  */
  const offenders = [...coords(z04.volume), ...coords(z04.shell)].filter(([px, py, pz]) => {
    const v = (py - spec.baseY) / spec.heightM;
    if (v < 0 || v > topV / 2) return false;
    const angle = Math.atan2(pz - spec.z, px - spec.x);
    const offset = Math.abs(((angle - 0.35 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (offset > halfSpan / 2) return false;
    return Math.hypot(px - spec.x, pz - spec.z) > spec.radiusM * 0.97;
  });
  assert.deepEqual(offenders.slice(0, 3), [], `缺口内圈还有 ${offenders.length} 个木料点贴在柱面上（没被磕掉）`);
  assert.ok(damage.points.length / 3 > 800, "缺口面点太少，看不出被磕掉一块");
});

test("裂痕是「裂而不空」：缝里空着，两侧仍有木料", () => {
  const z04 = buildInternalCloud().columns.find((column) => column.spec.componentId === "Z04")!;
  const crack = z04.defects.find((defect) => defect.kind === "crack")!;
  assert.ok(crack, "Z04 要有一条内部裂痕");
  const spec = z04.spec;
  const tilt = (18 * Math.PI) / 180;
  const slice = spec.radiusM * 0.09; // 与生成器里的缝厚一致
  /**
   * 缝是**倾斜**的：判据必须与生成器同一套几何 ——
   * 切向距离要减去 `along·sin(tilt)`（沿着缝走，缝心在切向上是偏的）。
   * 第一版只看切向距离、没减这一项，于是"缝里还有木料点"是**假红**。
   */
  const nearSeam = (points: Float32Array, band: number) =>
    coords(points).filter(([px, py, pz]) => {
      const dy = py - crack.centroid.y;
      if (Math.abs(dy) > 0.03) return false;
      /* 只看缝**声明**挖到的那一层（生成器里 outerR = 0.99r）：再往外是柱面点，本来就该在 */
      const radial = Math.hypot(px - spec.x, pz - spec.z);
      if (radial < spec.radiusM * 0.35 || radial > spec.radiusM * 0.9) return false;
      const along = dy * Math.cos(tilt);
      const tangential = -Math.sin(1.2) * (px - spec.x) + Math.cos(1.2) * (pz - spec.z) + along * Math.sin(tilt);
      return Math.abs(tangential) < band;
    }).length;
  assert.equal(nearSeam(z04.volume, slice * 0.3), 0, "缝中心还有木料点（裂痕没掏出来）");
  assert.ok(nearSeam(z04.volume, slice * 3) > 0, "缝两侧应当仍有木料点");
});

test("外表壳点足够密（看得出是圆柱），内部点比外壳多", () => {
  for (const column of buildInternalCloud().columns) {
    const shellCount = column.shell.length / 3;
    const volumeCount = column.volume.length / 3;
    assert.ok(shellCount > 6000, `${column.spec.componentId} 外壳点太少：${shellCount}`);
    assert.ok(volumeCount > shellCount, `内部点应当比壳多：${volumeCount} vs ${shellCount}`);
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

test("取景距离：柱高必须被框住（第一版只按水平跨度算，柱身被切头切尾）", () => {
  /* margin=1（不贴边留白）时，正好框住：2 · d · tan(fov/2) === height */
  const exact = fitDistance({ span: 0.36, height: 3.2, fovDeg: 34, aspect: 1.6, margin: 1 });
  assert.ok(Math.abs(2 * exact * Math.tan((34 * Math.PI) / 180 / 2) - 3.2) < 1e-9, `应正好框住 3.2 m：d=${exact}`);

  /* 只按水平跨度算会得到 0.36·1.9≈0.7 m 这种"贴到柱面上"的距离 —— 必须远大于它 */
  const framed = fitDistance({ span: 0.36, height: 3.2, fovDeg: 34, aspect: 1.6 });
  assert.ok(framed > 4, `单看一根柱子时相机要退到 4 m 以上，实际 ${framed}`);

  /* 横向真摊得很开（跨度 12 m）时，才是水平方向说了算：按宽度算出的距离 */
  const hFov = 2 * Math.atan(Math.tan((34 * Math.PI) / 180 / 2) * 1.6);
  assert.ok(
    Math.abs(fitDistance({ span: 12, height: 3.2, margin: 1 }) - 12 / (2 * Math.tan(hFov / 2))) < 1e-9,
    "跨度很大时应由水平方向定距离",
  );

  /* 视场收窄 → 要退得更远；高度主导时宽高比不影响距离 */
  const narrower = fitDistance({ span: 4.72, height: 3.2, fovDeg: 24, aspect: 1.6 });
  assert.ok(narrower > framed, "视场越小退得越远");
  assert.equal(
    fitDistance({ span: 0.36, height: 3.2, aspect: 2.4 }),
    fitDistance({ span: 0.36, height: 3.2, aspect: 1.6 }),
    "高度主导时宽高比不影响距离",
  );
});

test("四根一起看的取景：斜前方最近那根也要整个框住（柱脚不能切在画外）", () => {
  const specs = COLUMN_SPECS.map(({ x, z, heightM, radiusM }) => ({ x, z, heightM, radiusM }));
  /* 相机方向与页面一致：+x +z 侧看过来（`InternalPointCloudView.CAMERA_DIR`） */
  const distance = fitGroupDistance({ columns: specs, dirX: 0.62, dirZ: 0.78, fovDeg: 34, aspect: 1.6 });

  const single = fitDistance({ span: 0.72, height: 3.2, fovDeg: 34, aspect: 1.6, margin: 1.25 });
  /* Z03（-2.2,-2.2）是最近的一根：比场地中心近约 3.1 m，必须为它多退这些米数 */
  const nearestDepth = Math.abs(((-2.2 - 0) * 0.62 + (-2.2 - 0) * 0.78) / Math.hypot(0.62, 0.78));
  assert.ok(
    distance >= single + nearestDepth - 1e-6,
    `最近那根要单独框：distance=${distance} 应 ≥ 单根 ${single} + 进深 ${nearestDepth}`,
  );
  /* 也不能退到离谱（远到柱子只剩一小条）：8~12 m 之间 */
  assert.ok(distance > 8 && distance < 12, `四根一起看的距离应在 8~12 m，实际 ${distance}`);

  /* 单看一根时必须比四根一起看近得多（"只看 Z04"要把柱子放大） */
  const solo = fitGroupDistance({ columns: [specs[3]], dirX: 0.62, dirZ: 0.78, fovDeg: 34, aspect: 1.6 });
  assert.ok(solo < distance * 0.75, `单看一根要明显更近：solo=${solo} vs group=${distance}`);
  assert.equal(fitGroupDistance({ columns: [], dirX: 1, dirZ: 0 }), 0, "没有柱子时不取景");
});
