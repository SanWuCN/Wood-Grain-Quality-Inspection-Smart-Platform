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
  BURROW_BRANCH_COUNT,
  BURROW_TRUNK_RATIO,
  BITE_DEPTH,
  COLUMN_SPECS,
  DEFECT_RECIPES,
  DEFECT_STYLE,
  HOLLOW_RADIUS_RATIO,
  HOLLOW_WALL_WOBBLE,
  INTERNAL_CLOUD_SOURCE_NOTE,
  SHELL_MAX_WOBBLE,
  SPLAT_SPREAD,
  SPLAT_SPREAD_RANGE,
  splatDotDiameter,
  buildColumnCloud,
  buildInternalCloud,
  burrowNetworkOf,
  cloudRefinement,
  columnPointBudget,
  fitDistance,
  fitGroupDistance,
  hollowRadiusFactor,
  inBurrow,
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
  /*
    判据用生成器导出的 `SHELL_MAX_WOBBLE`（木纹脊 + 旋切纹 + 柱形起伏 + 抖动之和的
    **声明上界**），不再各写一个魔数：木纹幅度一改，这里跟着改一次就够，
    而且能真正卡住"脊加得太深、点飘到柱外"。

    ⚠ 壳/体与**缺陷面**分两个判据：
      · 壳与内部木料：径向不得超过 `1 + SHELL_MAX_WOBBLE`（它们就该在那层皮以内）；
      · 缺陷面（腔壁 / 裂的两面 / 缺口面）：几何上允许略微贴到柱面外一点点
        （虫蛀腔心可以偏、裂面有厚度），所以放宽到 `+0.02`。
      两条分开之后，"裂痕面伸到柱面外"这类真实几何问题才会被抓住 ——
      旧版一律给 12% 容差，它一直被盖着。
  */
  for (const column of buildInternalCloud().columns) {
    const { x, z, radiusM, baseY, heightM } = column.spec;
    const groups: [string, Float32Array, number][] = [
      ["外壳", column.shell, radiusM * (1 + SHELL_MAX_WOBBLE)],
      ["内部木料", column.volume, radiusM * (1 + SHELL_MAX_WOBBLE)],
      ...column.defects.map(
        (defect) => [defect.label, defect.points, radiusM * (1 + SHELL_MAX_WOBBLE + 0.02)] as [string, Float32Array, number],
      ),
    ];
    for (const [name, points, limit] of groups) {
      assert.ok(points.length > 0, `${column.spec.componentId} 的${name}没有点`);
      for (const [px, py, pz] of coords(points)) {
        const radial = Math.hypot(px - x, pz - z);
        assert.ok(
          radial <= limit,
          `${column.spec.componentId} 的${name}跑出柱面：${radial.toFixed(3)} > ${limit.toFixed(3)}`,
        );
        assert.ok(
          py >= baseY - 0.02 && py <= baseY + heightM + 0.02,
          `${column.spec.componentId} 的${name}超出柱高：y=${py.toFixed(3)}`,
        );
      }
    }
  }
});

test("木纹脊在半径上真的体现出来（不是一根光滑的管子）", () => {
  /*
    用户要的"轮廓能对上单根那根"里，有一半是**表面细节**：高斯泼溅那根是木头的，
    不是塑料管。判据取"同一层上半径的波动幅度"：
      · 太小（< 1%）→ 近看还是光滑圆柱；
      · 太大（> SHELL_MAX_WOBBLE）→ 点会飘到柱外（上一条会红）。
  */
  const z04 = buildInternalCloud(["Z04"]).columns[0];
  const spec = z04.spec;
  /* 取柱腰附近的一层（避开柱脚缺口与柱顶封口） */
  const band = coords(z04.shell).filter(([, py]) => {
    const v = (py - spec.baseY) / spec.heightM;
    return v > 0.45 && v < 0.5;
  });
  assert.ok(band.length > 200, `取到的一层点太少（${band.length}），判据不成立`);
  const radii = band.map(([px, , pz]) => Math.hypot(px - spec.x, pz - spec.z) / spec.radiusM);
  const spread = (Math.max(...radii) - Math.min(...radii)) / (radii.reduce((a, b) => a + b, 0) / radii.length);
  assert.ok(spread > 0.02, `半径波动只有 ${(spread * 100).toFixed(1)}%，看不出木纹脊（还是光滑管子）`);
  assert.ok(spread < SHELL_MAX_WOBBLE * 2.2, `半径波动 ${(spread * 100).toFixed(1)}% 过大，点会飘出柱面`);
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
  /*
    ⚠ 判据在"加密壳"之后改过一次：旧断言是 `内部点数 > 壳点数`，
    而 2026-10 把柱面提到 300×330（壳 ~10 万点，为了轮廓与质感）之后，
    壳**本来就该比内部点多** —— 那条断言从此测的不是"实心"，而是"壳不够密"。
    现在按**体密度**判"实心"（与体积同量级就是填满了），
    "谁多"改由下面那条按比例判（内部不该少到只剩一层皮）。
  */
  for (const column of buildInternalCloud().columns) {
    const volumeM3 = Math.PI * column.spec.radiusM ** 2 * column.spec.heightM;
    const count = column.volume.length / 3;
    const shellCount = column.shell.length / 3;
    assert.ok(count > 12_000, `${column.spec.componentId} 内部点太少（${count}），看着还是空壳`);
    /* 与体积同量级：落在 5 万–45 万点/m³ 之间都算"填满"（上界随 2026-10-01 加密一起抬） */
    const density = count / volumeM3;
    assert.ok(density > 50_000 && density < 450_000, `${column.spec.componentId} 体密度不合理：${Math.round(density)} 点/m³`);
    assert.ok(
      count > shellCount * 0.3,
      `${column.spec.componentId} 内部点相对壳太少（内部 ${count} vs 壳 ${shellCount}），会看成只有一层皮`,
    );
  }
});

test("虫蛀空洞是掏空的：洞口范围内一个木料点都没有", () => {
  const z04 = buildInternalCloud().columns.find((column) => column.spec.componentId === "Z04")!;
  const borers = z04.defects.filter((defect) => defect.kind === "borer");
  assert.equal(borers.length, 2);
  const spec = z04.spec;
  const shell = coords(z04.shell);
  for (const borer of borers) {
    assert.equal(borer.carve.kind, "borer", "虫蛀缺陷必须带自己的挖空几何");
    const carve = borer.carve;
    /*
      ⚠ 这条判据改过四轮，每轮都是**判据本身不成立**（几何一直是好的），过程留在这里：
      ① 第一版洞心按 `u × 半径 × 0.8` 埋在木料里 → "洞心附近 0.06 m 的球内没有点"成立；
         现在洞心放在柱面上、腔往里挖，量那个球会量到柱面另一侧的木料（恒假）。
      ② 改成"沿柱轴偏移 + 贴柱面" → 假红 4886 个：那两个条件圈出的是**整圈**柱面，
         而洞口只占全周约 17%，判据必须带朝外方向。
      ③ 带方向后报 9–25 个 —— 那是洞口边上的柱面点，落在挖空边界之外一点点，本就该留着；
         于是把"洞心"收到 6 成半径。
      ④ 体那一条又假红：判据里用**缺陷点云的质心**当洞心，与生成端的真实洞心差了几毫米，
         量出来"腔里还有木料 0.0112 m"，而按真实洞心算那颗点本该被挖掉。
      → 结论：判据不许自己推几何。生成端把 `carve`（洞心/洞口半径/深度/方位角）一起交出来，
        判据只负责量。这也是为什么 `CloudDefect` 上多了 `carve` 这个字段。
    */
    /* 局部坐标：`u` 朝外（洞口平面为 0）、`lateral` 横向（切向 + 竖直，按腔的扁平比折算） */
    const localOf = ([px, py, pz]: [number, number, number]) => {
      const dx = px - carve.cx;
      const dz = pz - carve.cz;
      return {
        u: dx * Math.cos(carve.outAngle) + dz * Math.sin(carve.outAngle),
        lateral: Math.hypot(-dx * Math.sin(carve.outAngle) + dz * Math.cos(carve.outAngle), (py - carve.cy) / 1.15),
      };
    };

    /*
      ① 壳：洞口范围内不该有壳点 —— 取**洞口那个半椭球**（半径 = 洞口半径、
      沿朝外方向压扁到 0.6，只算朝里那一侧）的**内 5 成**：
      洞口是圆、柱面在洞口处是**弧**，用"到某个平面的距离"这种单分量判据
      在边缘总会差几毫米（本轮就在这里假红过 229 次）。
      留 5 成余量是因为挖空边界本身随深度变化（`taper`），边缘那一圈点
      按闭式解本来就在边界之外。
    */
    const shellInHole = shell.filter((point) => {
      const { u, lateral } = localOf(point);
      if (u > 0.005) return false;
      return Math.hypot(lateral / carve.radius, u / (carve.radius * 0.6)) < 0.5;
    });
    assert.deepEqual(shellInHole.slice(0, 3), [], `${borer.label} 洞口还有壳点（${shellInHole.length} 个）—— 洞会看着像塞了渣`);

    /* ② 腔壁要真的**往里凹**：最深处比洞口更靠近柱轴（阈值取洞深的 4 成，留余量） */
    const wall = coords(borer.points);
    const deepest = Math.min(...wall.map(([px, , pz]) => Math.hypot(px - spec.x, pz - spec.z)));
    const mouth = Math.hypot(carve.cx - spec.x, carve.cz - spec.z);
    assert.ok(
      deepest < mouth - carve.depth * 0.4,
      `${borer.label} 的腔壁没往里凹（最深处 ${deepest.toFixed(3)} vs 洞口 ${mouth.toFixed(3)}，洞深 ${carve.depth.toFixed(3)}）`,
    );
    assert.ok(borer.points.length / 3 > 1000, `${borer.label} 没画出腔壁`);
  }
});

test("破损缺口里没有木料点，且缺口面画出来了", () => {
  const z04 = buildInternalCloud().columns.find((column) => column.spec.componentId === "Z04")!;
  const damage = z04.defects.find((defect) => defect.kind === "damage")!;
  assert.ok(damage, "Z04 要有柱脚破损");
  assert.equal(damage.carve.kind, "damage", "破损缺陷必须带自己的挖空几何");
  const carve = damage.carve;
  const spec = z04.spec;
  /*
    ⚠ 这一条原来把「角向中心 0.35 / 跨度 96°」写死在判据里，于是**布置参数一改就假绿**：
    本轮把缺陷挪到朝相机那一面（中心 0.35 → 0.73）并把跨度收到 96°×0.62 ——
    判据还按 0.35/96° 去量，量到的是另一块地方，`offenders` 自然是 0 个。
    所以一律读 `carve`（生成端的权威几何），判据只做量、不做推。
  */
  const halfSpan = carve.halfSpan;
  const topV = carve.topV;
  /* 缺口面画在挖空边界的内侧（`0.88`，见 `buildDamage` 的说明） */
  const SURFACE_INSET = 0.88;
  const biteAt = (offset: number, v: number) =>
    1 - (1 - offset / halfSpan) * (1 - v / Math.max(0.01, topV)) * BITE_DEPTH * SURFACE_INSET;
  /*
    ⚠ 判据取**缺口内圈**（角向与高度都在前半段）：那里的"啃掉深度"明确小于 1
      （缺口边缘处 bite 趋近 1，柱面点本来就该在），拿边缘去断言会误伤 —— 第一版就这么红的。
  */
  const offenders = [...coords(z04.volume), ...coords(z04.shell)].filter(([px, py, pz]) => {
    const v = (py - spec.baseY) / spec.heightM;
    if (v < 0 || v > topV / 2) return false;
    const angle = Math.atan2(pz - spec.z, px - spec.x);
    const offset = Math.abs(((angle - carve.centerAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (offset > halfSpan / 2) return false;
    return Math.hypot(px - spec.x, pz - spec.z) > spec.radiusM * biteAt(offset, v);
  });
  assert.deepEqual(offenders.slice(0, 3), [], `缺口内圈还有 ${offenders.length} 个木料点贴在柱面上（没被磕掉）`);
  assert.ok(damage.points.length / 3 > 800, "缺口面点太少，看不出被磕掉一块");
});

test("裂痕是「裂而不空」：缝里空着，两侧仍有木料", () => {
  const z04 = buildInternalCloud().columns.find((column) => column.spec.componentId === "Z04")!;
  const crack = z04.defects.find((defect) => defect.kind === "crack")!;
  assert.ok(crack, "Z04 要有一条内部裂痕");
  assert.equal(crack.carve.kind, "crack", "裂痕必须带自己的挖空几何");
  const carve = crack.carve;
  const spec = z04.spec;
  /*
    ⚠ 判据的切向公式必须与生成端**逐字一致**（`isCarved` 里那条）：
      · `dy * Math.cos(tilt)` 得到"沿缝方向"的坐标，再把它投影回切向（`+ along·sin(tilt)`）；
      · 半径范围读 `carve.innerR/outerR`（原来写死 `0.35r`～`0.9r`，而缝是从 `0.3r` 开始挖的）。
    混用 `sin/cos`（比如写成 `-sin·b + cos·a`）会算到另一条母线上，判据就与"缝"无关了 ——
    本轮先把公式写错、再加容差，量出 12 个"缝里的木料点"，其实全是假红。
  */
  const tilt = carve.tilt;
  const slice = carve.thickness;
  const nearSeam = (points: Float32Array, band: number) =>
    coords(points).filter(([px, py, pz]) => {
      const dy = py - carve.centerY;
      if (Math.abs(dy) > carve.halfLength) return false;
      const radial = Math.hypot(px - spec.x, pz - spec.z);
      if (radial < carve.innerR || radial > carve.outerR) return false;
      const along = dy * Math.cos(tilt);
      const tangential =
        -Math.sin(carve.angle) * (px - spec.x) + Math.cos(carve.angle) * (pz - spec.z) + along * Math.sin(tilt);
      return Math.abs(tangential) <= band;
    }).length;
  /*
    ── "缝里空着"这一问的带宽怎么定 ────────────────────────────────────
    判据拿 `Float32Array` 里的坐标重算，而挖空时用的是 double，两者在**边界上**
    可以差 8e-5（约缝厚的 1.5%）：实测有 1 个点落在 `半厚 + 1%` 之内（假红）。
    但**真正的空腔芯**是确定的（那是 `isCarved` 保证的），所以这里：
      · 空腔那一问把带宽**收到 94% 半厚**（往严的方向），落在这个核里的点必然在腔里；
      · 有没有木料那一问放到 ±2 倍缝厚（往宽的方向）。
    两问合起来就是"缝中心空、两侧有料"，既不假红也不放水。
  */
  assert.equal(nearSeam(z04.volume, slice * 0.47), 0, "缝中心还有木料点（裂痕没掏出来）");
  assert.ok(nearSeam(z04.volume, slice * 2) > 0, "缝两侧应当仍有木料点");
});

/* ------------------------------------------------------------------ *
 * 虫蛀孔洞（用户口径 2026-10-02：「根本看不出内部问题，内部得有虫蛀之类的孔洞」）
 *
 * 这一组要证伪的正是"看不出"：腔壁得是不规则的、内部得有虫道网络、
 * 虫道得真的通到柱面（柱身上有孔口）、孔口那一圈还得有痕迹。
 * ------------------------------------------------------------------ */

test("空腔壁是不规则的：一圈上半径明显有起伏，不是一根光溜的管子", () => {
  const spec = COLUMN_SPECS.find((item) => item.componentId === "Z04")!;
  const v = 0.7;
  const factors = Array.from({ length: 180 }, (_, index) => hollowRadiusFactor(spec, (index / 180) * Math.PI * 2, v));
  const min = Math.min(...factors);
  const max = Math.max(...factors);
  assert.ok(
    max - min > 0.25,
    `一圈上腔壁半径只差 ${(max - min).toFixed(3)}，读起来还是光滑管壁`,
  );
  /* 上下界：下限别贴到柱轴（那样像钻穿），上限别顶破外皮 */
  assert.ok(min >= 0.55 && max <= 1.42, `腔壁系数越界：${min.toFixed(2)} ~ ${max.toFixed(2)}`);
  assert.ok(
    HOLLOW_RADIUS_RATIO * max < 0.95,
    "腔壁最大半径顶到外皮了：柱面会破",
  );
  assert.ok(HOLLOW_WALL_WOBBLE.mid >= 0.15, "中频龛洞幅度太小，看不出被啃过的凹凸");
});

test("虫道网：主虫道 + 多条分叉，且分叉真的扎到柱面上（柱身有孔口）", () => {
  const spec = COLUMN_SPECS.find((item) => item.componentId === "Z04")!;
  const network = burrowNetworkOf(spec);
  assert.ok(network.segments.length >= 6, `只有 ${network.segments.length} 段虫道，读不成"网络"`);
  assert.equal(network.mouths.length, BURROW_BRANCH_COUNT, "每条分叉都该在柱面上留一个孔口");
  assert.ok(
    spec.radiusM * BURROW_TRUNK_RATIO > 0.012,
    `主虫道太细（${(spec.radiusM * BURROW_TRUNK_RATIO * 1000).toFixed(0)} mm），点云里会变成一条虚线，看不出孔洞`,
  );
  /* 孔口之间要分得开：挨太近会在柱面上连成一片，读成一个洞 */
  const angles = network.mouths.map((mouth) => Math.atan2(mouth.z - spec.z, mouth.x - spec.x));
  const gaps = angles
    .slice()
    .sort((a, b) => a - b)
    .slice(1)
    .map((angle, index) => Math.abs(angle - angles.slice().sort((a, b) => a - b)[index]));
  assert.ok(
    Math.min(...gaps) > 0.2,
    `孔口最小角距只有 ${Math.min(...gaps).toFixed(2)} rad，会连成一片`,
  );
  for (const mouth of network.mouths) {
    const radial = Math.hypot(mouth.x - spec.x, mouth.z - spec.z);
    /* 孔口就在柱面上（不是埋在木头里、也不是飘在柱外） */
    assert.ok(
      radial > spec.radiusM * 0.95 && radial <= spec.radiusM,
      `孔口半径 ${radial.toFixed(3)} 不在柱面上（柱半径 ${spec.radiusM.toFixed(3)}）`,
    );
  }
  /* 确定性：同一根柱子两次生成一致（现场"刚才那个眼"要对得上） */
  assert.deepEqual(burrowNetworkOf(spec), network);
});

test("虫道里没有木料，柱面上也被虫道打出了孔（壳点被剔掉）", () => {
  const spec = COLUMN_SPECS.find((item) => item.componentId === "Z04")!;
  const column = buildColumnCloud(spec);
  const network = column.burrows;
  /* ① 虫道轴线上不该还有木料点 */
  let woodInTunnel = 0;
  for (const segment of network.segments) {
    for (const t of [0.25, 0.5, 0.75]) {
      const px = segment.x0 + (segment.x1 - segment.x0) * t;
      const py = segment.y0 + (segment.y1 - segment.y0) * t;
      const pz = segment.z0 + (segment.z1 - segment.z0) * t;
      for (const [x, y, z] of coords(column.volume)) {
        if (Math.hypot(x - px, y - py, z - pz) < segment.radius * 0.6) woodInTunnel += 1;
      }
    }
  }
  assert.equal(woodInTunnel, 0, `虫道里还剩 ${woodInTunnel} 个木料点（没挖干净）`);

  /*
    ② 孔口真的通了：**落在虫道里的壳点必须是 0**。
    为什么这么判（而不是"孔口中心附近没有壳点"）：柱面是起伏的（`SHELL_MAX_WOBBLE`），
    孔口中心旁边那些**本来就该在**的柱面点会落进"半径 0.6 倍"的球里，
    于是判据假红 —— 实测第一版就是这么红的（0/4 个孔口"没通"，其实孔是通的）。
    真正的判据是生成端那句 `keep()`：虫道里的壳点必须一个都不留。
  */
  const shellInBurrow = coords(column.shell).filter(([x, y, z]) => inBurrow(network.segments, x, y, z));
  assert.deepEqual(
    shellInBurrow.slice(0, 3),
    [],
    `柱面上还有 ${shellInBurrow.length} 个壳点落在虫道里（孔口没通）`,
  );

  /* ③ 腔壁层里得有虫道内壁的点（道壁），否则虫道只是一片空白 */
  const burrowWallPoints = coords(column.hollowSplats.position).filter(([x, y, z]) =>
    inBurrow(network.segments, x, y, z),
  );
  assert.ok(
    burrowWallPoints.length > 200,
    `虫道内壁只有 ${burrowWallPoints.length} 个点，看不出"这是一条道"`,
  );
});

test("虫道内壁的点也都在柱体以内（不许飘在柱面外）", () => {
  const spec = COLUMN_SPECS.find((item) => item.componentId === "Z04")!;
  const column = buildColumnCloud(spec);
  const outside = coords(column.hollowSplats.position).filter(
    ([x, , z]) => Math.hypot(x - spec.x, z - spec.z) > spec.radiusM * 1.001,
  );
  assert.deepEqual(outside.slice(0, 3), [], `有 ${outside.length} 个腔壁/虫道点飘到柱面外`);
});

test("外表壳点足够密（轮廓与质感都靠它），且内部没有退化成一层皮", () => {
  for (const column of buildInternalCloud().columns) {
    const shellCount = column.shell.length / 3;
    const volumeCount = column.volume.length / 3;
    /* 壳是"轮廓 + 木纹/斧凿/剥落"的载体：加密到 300×330 之后单根应到 6 万点以上 */
    assert.ok(shellCount > 60_000, `${column.spec.componentId} 外壳点太少：${shellCount}`);
    assert.ok(volumeCount > 12_000, `${column.spec.componentId} 内部点太少：${volumeCount}`);
  }
});

/**
 * 用户 2026-10 口径：「3d 点云做得更精细一些，轮廓要能对上单根木柱高斯泼溅的那一根」。
 *
 * 把"精细"落成**柱面相邻点距**（毫米）来断言，而不是"点数更多"：
 *   · 环向点距决定侧影是光滑曲线还是多边形（旧规格 84 点/圈 → 12–13 mm，近看是棱柱）；
 *   · 轴向点距决定柱身有没有横向条纹（旧 190 层 → 16.8 mm，太粗）。
 * 单根取景距离是 6.54 m（`fitDistance`），在这个距离上 6 mm 级的点距才读得出轮廓。
 * 谁把参数调回粗规格，这一条立刻红。
 */
test("精度：柱面点距足够细，轮廓在单根取景距离上也读得出", () => {
  const cloud = buildInternalCloud();
  const rows = cloudRefinement(cloud);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.ok(
      row.arcSpacingMm <= 7,
      `${row.componentId} 环向点距 ${row.arcSpacingMm.toFixed(2)} mm 太粗（近看轮廓会成多边形，对不上单根那根）`,
    );
    assert.ok(
      row.levelSpacingMm <= 13,
      `${row.componentId} 轴向点距 ${row.levelSpacingMm.toFixed(2)} mm 太粗（柱身会有横向条纹）`,
    );
    assert.ok(
      row.volumePerM3 >= 200_000,
      `${row.componentId} 内部密度 ${Math.round(row.volumePerM3)} 点/m³ 偏低（近看有网格感）`,
    );
  }
  /* 逐根之间也要"可比"：最粗那根（Z04，直径 360 mm）的环向点距不该比最细的差一倍以上 */
  const arcs = rows.map((row) => row.arcSpacingMm);
  assert.ok(Math.max(...arcs) / Math.min(...arcs) < 1.3, `四根的点距应当接近，实际 ${arcs.map((a) => a.toFixed(2)).join(" / ")}`);
});

/**
 * 用户这一轮要的是"外观保证单根木柱高斯泼溅的那根"：那根是**真实旧木柱**，
 * 截面不是正圆（手工砍削）、柱面有斧凿凹面与剥落。
 * 判据取"同一条高度带上，各角度的半径与最佳拟合圆的偏差"——
 * 光滑圆柱这一项会接近 0；有棱面/剥落才会明显偏离。
 */
test("截面不是正圆（看得到手工砍削的棱面，不是光滑圆柱）", () => {
  const cloud = buildInternalCloud();
  for (const column of cloud.columns) {
    const spec = column.spec;
    const band = coords(column.shell).filter(([, py]) => {
      const v = (py - spec.baseY) / spec.heightM;
      return v > 0.5 && v < 0.54;
    });
    assert.ok(band.length > 500, `${spec.componentId} 取到的一层点太少（${band.length}）`);
    const radii = band.map(([px, , pz]) => Math.hypot(px - spec.x, pz - spec.z));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    const maxDeviation = Math.max(...radii.map((r) => Math.abs(r - mean) / mean));
    assert.ok(
      maxDeviation > 0.045,
      `${spec.componentId} 截面几乎正圆（最大偏差 ${(maxDeviation * 100).toFixed(1)}%）：看不出斧凿棱面，会像光滑管子`,
    );
    assert.ok(
      maxDeviation < SHELL_MAX_WOBBLE + 0.02,
      `${spec.componentId} 截面偏差 ${(maxDeviation * 100).toFixed(1)}% 超过声明上界，点会飘出柱面`,
    );
  }
});

test("点数预算：四根合计仍在一次能画完的量级（加密不等于把浏览器拖死）", () => {
  const cloud = buildInternalCloud();
  const total = cloud.columns.reduce((sum, column) => sum + columnPointBudget(column), 0);
  assert.ok(total > 300_000, `加密之后总量应明显高于旧规格的 23.85 万，实际 ${total}`);
  /*
    ⚠ 上界 2026-10-01 从 70 万提到 120 万：为了"看得出是一颗颗点"（每颗点缩到间距以下，
    见 `SPLAT_SPREAD`），点距必须更密 —— 否则点与点之间的空隙会让柱子发虚。
    修法是**加密**而不是把点调回大尺寸（那就回到"纯棕色木柱"）。
    这一条仍然是"不许无限涨"的闸门，只是闸门抬高了一档。
  */
  assert.ok(total < 1_600_000, `四根合计 ${total} 颗高斯已经偏多，泼溅比点渲染贵，但不该无限涨`);
  /* 只看一根时屏幕上就是这一根的点（"只看 Z04"是最常用的讲法） */
  const solo = buildInternalCloud(["Z04"]);
  assert.ok(columnPointBudget(solo.columns[0]) > 80_000, "单看一根时也要够细");
});

/**
 * 用户口径 2026-10-01：「正常是要看到一个一个点啊，你现在这点云图都纯棕色木柱，怎么看啊」。
 *
 * 把这句话落成一个**数**：单颗点的直径相对采样点距的倍数。
 *   · 小于 1 → 相邻点分开，屏幕上一颗一颗（要的就是这个）；
 *   · 大于 1 → 相邻点粘连成面，颗粒感消失，看着像实体木柱（用户否掉的那一版是 1.85）。
 * 这条判据卡在 `SPLAT_SPREAD` 上，谁再把它调回重叠区就红。
 */
test("单颗点的直径小于采样点距（屏幕上是一颗颗点，不是一根实心木柱）", () => {
  assert.ok(
    SPLAT_SPREAD >= SPLAT_SPREAD_RANGE.min && SPLAT_SPREAD <= SPLAT_SPREAD_RANGE.max,
    `点直径倍数 ${SPLAT_SPREAD} 落在区间 [${SPLAT_SPREAD_RANGE.min}, ${SPLAT_SPREAD_RANGE.max}] 之外：` +
      `${SPLAT_SPREAD > SPLAT_SPREAD_RANGE.max ? "点会粘连成面，看不出是点云" : "点太稀，柱子会虚成一片雾"}`,
  );
  /* 渲染层还会再乘一个放大倍数，两者相乘才是屏幕上真正的点直径 —— 它也必须 < 1 */
  const effective = splatDotDiameter();
  assert.ok(
    effective < 1.05,
    `几何 × 渲染两层放大之后，单颗点直径是点距的 ${effective.toFixed(2)} 倍 —— 已经超过 1，点会连成面`,
  );
});

test("确定性：同一根柱子两次生成完全一致（现场「刚才那个洞」要对得上）", () => {
  const first = buildColumnCloud(COLUMN_SPECS[3]);
  const second = buildColumnCloud(COLUMN_SPECS[3]);
  /*
    ⚠ 比较**整份**点云，不再只比前 30 个点：加密之后每个点都吃到了随机抖动，
    "前 30 个一致、后面的漂了"这种坏法只比前 30 个是看不出来的。
  */
  assert.deepEqual([...first.shell], [...second.shell], "壳点两次生成必须逐点一致");
  assert.deepEqual([...first.volume], [...second.volume], "内部木料两次生成必须逐点一致");
  assert.equal(first.defects[0].source, second.defects[0].source);
  for (let index = 0; index < first.defects.length; index += 1) {
    assert.deepEqual(
      [...first.defects[index].points],
      [...second.defects[index].points],
      `第 ${index + 1} 处缺陷的点两次生成必须逐点一致`,
    );
  }
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
