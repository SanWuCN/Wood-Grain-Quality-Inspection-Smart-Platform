/**
 * 数字孪生的**内部点云**（用户 2026-09-30：「我现在要他也可以展示内部点云，分一项作为
 * 内部点云，有虫蛀或内部裂痕破损，你根据原有外形，生成一下」）
 *
 * ── 这是什么、不是什么（先说清口径）──────────────────────────────────
 * 现场只接通了**外观**（高斯泼溅场景）与手持雷达的**谱段结果**，没有做内部扫描，
 * 所以这一屏不是"实测内部点云"，而是**按外形尺寸生成的结构视图**：
 *   · 外形尺寸（柱位 ±2.2 m、柱径 320/318/356/360 mm）**取自构件档案**
 *     （`seed/scenario.ts` 的 `COMPONENTS[].scene` 与 `archive` 文本），不是编的；
 *   · 可视段高 3.2 m 是**本视图参数**（档案里没有柱高这一项），界面上要写明；
 *   · 缺陷（虫蛀空洞 / 内部裂痕 / 破损）按构件自己的记录布置：
 *       - Z04：`CURRENT_RISKS` 里那两条「疑似虫蛀空洞（上部 / 下部响应区）」+ 档案「柱脚历史修补」；
 *       - Z03：档案「漆层局部起翘」→ 一条内部裂痕；
 *       - Z01 / Z02：档案写「外观连续」「表面轻微褪色」→ **不生成任何内部缺陷**
 *         （平台不替健康构件编缺陷，这条比画面好看重要）。
 * 界面上必须同时显示 `INTERNAL_CLOUD_SOURCE_NOTE`，观众一眼知道这是"按外形生成的
 * 结构视图"，不是实测点云 —— 与仓库里「预置结果必须标来源」同一条规矩。
 *
 * ── 为什么生成而不是画一张图 ────────────────────────────────────────
 * 这一屏要能转、能放大、能按构件过滤、还能跟着选中构件联动，所以是真点云：
 * 用**确定性随机**（`mulberry32` + 固定种子）一次性算出点的坐标，渲染层只负责画。
 * 确定性有两个好处：每次打开长得一模一样（演示可复现），且**能被单测钉住**
 * （点是否都在柱身内、缺陷数量对不对、同一颗种子是否给出同一份点云）。
 */
import { COMPONENTS, CURRENT_RISKS } from "../seed/scenario";
/* 重建产物声明的包围盒（`gs.sog` 内 meta.json 的 means.mins/maxs）——内部点云的参照系 */
import { SPLAT_BOUNDS } from "./splat";

/** 界面上必须原样显示的来源说明（与页面上的角标同一份文本，避免两处走样） */
export const INTERNAL_CLOUD_SOURCE_NOTE =
  "内部点云：按构件外形与档案记录生成的结构视图（柱位与柱径取自构件档案，可视段高为本视图参数）；" +
  "现场未做内部扫描，不是实测点云。缺陷位置为预置结果。";

/** 可视段高（米）。档案里没有柱高，这是**本视图参数**，界面上写明 */
export const COLUMN_VISIBLE_HEIGHT_M = 3.2;
/** 柱脚离地：让柱身略高于地面网格，便于看清柱脚破损 */
export const COLUMN_BASE_LIFT_M = 0.25;
/** 外壳点的环向密度（每层点数的基准）与层数 —— 影响观感与生成耗时 */
const SHELL_RINGS = 84;
const SHELL_LEVELS = 190;
/**
 * 内部木料的点密度（点/立方米）。
 *
 * ── 用户口径改过一次（2026-09-30）──────────────────────────────────
 * 第一版只画了"壳 + 稀疏芯"，用户看了说：「做的是一个 3d 的点云展示，就是**木柱内部
 * 都是点云**，破损可视化之类的」——所以要的是**实心点云柱**：内部按体积填满点，
 * 破损是"从点云里被掏空"的那一块。
 * 密度取值：Z04（直径 360 mm、视高 3.2 m，体积约 0.33 m³）× 140k ≈ 4.6 万点/根，
 * 四根合计约 20 万点 —— WebGL 一帧轻松，肉眼看上去是"实心"的。
 */
const VOLUME_POINTS_PER_M3 = 140_000;
/** 单根柱子的内部点数上限（防止极端参数把浏览器拖死） */
const VOLUME_MAX_POINTS = 90_000;

/**
 * 取景：相机放在多远，才能把「宽 `span` × 高 `height`」这一坨东西整个框进画面。
 *
 * 为什么要有这个函数：相机机位是"看什么就框什么"，第一版只用**水平跨度**推距离
 * （`span * 1.9`），于是单看一根柱子时距离只有 1.1 m —— 柱身高 3.2 m，屏幕上只看得到
 * 中间一小段，虫蛀与柱脚缺损都出画。纵向高度必须一起算进去，取两者较大的那个距离。
 *
 * 纯函数（不带 three、不依赖画布），所以能被单测钉住：见 `internalPointCloud.test.ts`。
 *
 * @param span    要框住的水平跨度（米）
 * @param height  要框住的竖向高度（米）
 * @param fovDeg  相机的竖向视场角（度）
 * @param aspect  画布宽高比（宽 / 高）
 * @param margin  留白系数（1 = 正好贴边，1.18 = 四周各留约一成）
 */
export function fitDistance({
  span,
  height,
  fovDeg = 34,
  aspect = 1.6,
  margin = 1.18,
}: {
  span: number;
  height: number;
  fovDeg?: number;
  aspect?: number;
  margin?: number;
}): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const byHeight = (height * margin) / (2 * Math.tan(vFov / 2));
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const byWidth = (span * margin) / (2 * Math.tan(hFov / 2));
  return Math.max(byHeight, byWidth);
}

/** 取景要用的柱子信息（`ColumnSpec` 天然满足） */
export type FrameColumn = { x: number; z: number; heightM: number; radiusM: number };

/**
 * 一组柱子的取景距离：**每一根各算一次，取最远的那个**。
 *
 * 为什么不能只按"整组的跨度 × 柱高"算一次：相机是斜着看的（`dirX/dirZ`），
 * Z03 那根比场地中心近 3.1 m —— 同样 3.2 m 高的柱子在屏幕上比远处那根粗一圈。
 * 按整组算出来的距离，最近那根的柱脚会切在画面外
 * （真踩过：四根一起看时，右下角那根少了一截，见 `InternalPointCloudView` 的注释）。
 *
 * @param columns 要框住的柱子
 * @param dirX   相机方向（水平分量，从注视点指向相机）；正负决定"哪根更近"
 * @param dirZ   同上
 */
export function fitGroupDistance({
  columns,
  dirX,
  dirZ,
  fovDeg = 34,
  aspect = 1.6,
  margin = 1.25,
}: {
  columns: readonly FrameColumn[];
  dirX: number;
  dirZ: number;
  fovDeg?: number;
  aspect?: number;
  margin?: number;
}): number {
  if (columns.length === 0) return 0;
  const norm = Math.hypot(dirX, dirZ) || 1;
  const ux = dirX / norm;
  const uz = dirZ / norm;
  const cx = columns.reduce((sum, column) => sum + column.x, 0) / columns.length;
  const cz = columns.reduce((sum, column) => sum + column.z, 0) / columns.length;
  let distance = 0;
  for (const column of columns) {
    /* 进深：正 = 这根更远（可以少退一点），负 = 更近（要多退一点，否则柱子被切） */
    const depth = (column.x - cx) * ux + (column.z - cz) * uz;
    const need = fitDistance({ span: column.radiusM * 2, height: column.heightM, fovDeg, aspect, margin });
    distance = Math.max(distance, need - depth);
  }
  return distance;
}


export type ColumnSpec = {
  componentId: string;
  /** 构件名（檐柱 / 金柱） */
  name: string;
  /** 材种（档案文本里那句） */
  material: string;
  /** 场景坐标（米）：与孪生场景同一套（`COMPONENTS[].scene`） */
  x: number;
  z: number;
  /** 半径（米）：由档案里的直径换算（320mm → 0.16） */
  radiusM: number;
  /** 柱脚 y（场景坐标） */
  baseY: number;
  /** 视高（米） */
  heightM: number;
};

export type CloudDefectKind = "borer" | "crack" | "damage";

export type CloudDefect = {
  kind: CloudDefectKind;
  /** 界面上的名字（Z04 用风险记录里的原话） */
  label: string;
  /** 来源（档案 / 风险记录的编号），界面上要能指出来 */
  source: string;
  /** 缺陷点的坐标（米，场景坐标），三三一组 */
  points: Float32Array;
  /** 缺陷中心（用于相机聚焦与列表排序） */
  centroid: { x: number; y: number; z: number };
};

export type ColumnCloud = {
  spec: ColumnSpec;
  /** 外表壳点（柱面 + 两端封口）：看得出"这是一根柱子" */
  shell: Float32Array;
  /** **内部木料点**：按体积填满（实心点云柱），缺陷处已被挖空 */
  volume: Float32Array;
  /** 缺陷（虫蛀空腔壁 / 裂痕两面 / 破损面），已在 `volume` 与 `shell` 里对应挖空 */
  defects: CloudDefect[];
};

export type InternalCloud = {
  columns: ColumnCloud[];
  /** 场景包围盒（取自 `SPLAT_BOUNDS`，画模型外框用） */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** 每一类缺陷的合计，给图例用 */
  totals: Record<CloudDefectKind, number>;
  note: string;
};

/** 缺陷类型的中文名与配色（渲染层与图例共用一份，避免两处走样） */
export const DEFECT_STYLE: Record<CloudDefectKind, { label: string; color: string }> = {
  borer: { label: "虫蛀空洞", color: "#ff8a3d" },
  crack: { label: "内部裂痕", color: "#ff4d6d" },
  damage: { label: "缺损 / 破损", color: "#7f8ea3" },
};

/* ------------------------------------------------------------------ *
 * 确定性随机
 * ------------------------------------------------------------------ */

/**
 * mulberry32：32 位种子的小 PRNG。
 *
 * 为什么不用 `Math.random()`：同一构件每次打开必须是**同一份点云**
 * （现场"刚才那里有个洞"的话得能对上），且单测要能断言具体坐标。
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 构件名 → 固定种子（同一个构件永远同一颗种子） */
export function seedOf(componentId: string): number {
  let hash = 2166136261;
  for (const char of componentId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/* ------------------------------------------------------------------ *
 * 外形与缺陷配方
 * ------------------------------------------------------------------ */

/** 从档案文本里取直径（「直径 320mm」→ 0.16 m）；取不到就用 0.18 m 并记在注释里 */
export function radiusFromArchive(archive: string, fallbackM = 0.18): number {
  const hit = /直径\s*(\d{2,4})\s*mm/.exec(String(archive ?? ""));
  if (!hit) return fallbackM;
  return Number(hit[1]) / 2000;
}

/** 从档案文本里取材种（「Z04 档案：楠木，…」→ 楠木） */
export function materialFromArchive(archive: string): string {
  const hit = /档案[：:]\s*([^，,；;]+)/.exec(String(archive ?? ""));
  return hit ? hit[1].trim() : "—";
}

const scenedMin = SPLAT_BOUNDS.min[1];

/** 四根柱子的规格：位置与柱径取自档案，y 由场景下沿 + 视高推得 */
export const COLUMN_SPECS: readonly ColumnSpec[] = COMPONENTS.map((component) => ({
  componentId: component.id,
  name: component.name,
  material: materialFromArchive(component.archive),
  x: component.scene.x,
  z: component.scene.z,
  radiusM: radiusFromArchive(component.archive),
  baseY: scenedMin + COLUMN_BASE_LIFT_M,
  heightM: COLUMN_VISIBLE_HEIGHT_M,
}));

/**
 * 配方表。
 *
 * `at.u`：缺陷中心相对柱心的水平偏移（比例，0 = 正中）；`at.v`：沿柱高的位置（0 柱脚 → 1 柱顶）、
 * `at.radius/wobble`：空腔大小与凹凸幅度；裂痕用 `depth/tiltDeg/length`；破损用 `depth/spanDeg`。
 *
 * ⚠ Z04 那两处虫蛀的**名字与编号直接从 `CURRENT_RISKS` 取**（不另抄一份）：
 *   窗口里点开哪一处，都能回到融合记录里那条风险（`CUR-Z04-02` / `CUR-Z04-03`）。
 *   记录被改/被删时这里跟着变，不会出现"点云上有个洞、风险表里查无此项"。
 */
type DefectRecipe =
  | { kind: "borer"; label: string; source: string; at: { u: number; v: number; radius: number; wobble: number } }
  | { kind: "crack"; label: string; source: string; at: { v: number; depth: number; tiltDeg: number; length: number } }
  | { kind: "damage"; label: string; source: string; at: { v: number; depth: number; spanDeg: number } };

/** 两处虫蛀的空间布置（上下各一处，对应风险记录里的"上部/下部响应区"） */
const BORER_PLACEMENT = [
  { u: 0.35, v: 0.68, radius: 0.085, wobble: 0.32 },
  { u: -0.3, v: 0.26, radius: 0.1, wobble: 0.38 },
] as const;
/** 记录里查不到虫蛀条目时的兜底名字（宁可写得保守，也不要编一条编号） */
const BORER_FALLBACK = { label: "疑似虫蛀空洞", source: "档案：本轮无有效标定记录" };

function borerRecipesFromRisks(componentId: string): DefectRecipe[] {
  const risks = CURRENT_RISKS.filter((risk) => risk.componentId === componentId);
  const borers = risks.filter((risk) => risk.label.includes("虫蛀"));
  return BORER_PLACEMENT.map((placement, index) => {
    const risk = borers[index];
    return {
      kind: "borer" as const,
      label: risk?.label ?? BORER_FALLBACK.label,
      source: risk?.id ?? BORER_FALLBACK.source,
      at: { ...placement },
    };
  });
}

export const DEFECT_RECIPES: Readonly<Record<string, readonly DefectRecipe[]>> = {
  Z04: [
    ...borerRecipesFromRisks("Z04"),
    { kind: "damage", label: "柱脚历史修补处缺损", source: "档案：柱脚有历史修补痕迹", at: { v: 0.06, depth: 0.5, spanDeg: 96 } },
    { kind: "crack", label: "沿柱身内部的细裂", source: "档案：本轮无有效标定记录", at: { v: 0.45, depth: 0.55, tiltDeg: 18, length: 0.72 } },
  ],
  Z03: [
    { kind: "crack", label: "漆层起翘下方的内部细裂", source: "档案：漆层局部起翘", at: { v: 0.38, depth: 0.4, tiltDeg: -12, length: 0.55 } },
  ],
  /* ⚠ Z01 / Z02 档案写的是「外观连续」「表面轻微褪色」——**一个内部缺陷都不生成**。
     平台不替健康构件编缺陷，这条比画面好看重要（页面上也会写明"本例无内部缺陷记录"）。 */
  Z02: [],
  Z01: [],
};

/* ------------------------------------------------------------------ *
 * 点云生成
 *
 * ── 三个概念（用户口径改过之后的结构，2026-09-30）────────────────────
 *   ① **壳**：柱面 + 两端封口，密一点、亮一点；
 *   ② **内部木料**：按体积填满的点（"木柱内部都是点云"）；
 *   ③ **挖空区（carve）**：每个缺陷先在几何上定义"哪一块木料没了"，
 *      再按它把 ①② 里的点剔掉，最后画上缺陷自己的面（空腔壁 / 裂的两面 / 破损面）。
 * 这样"破损"在点云里的读法就是**空白**——与真扫描看到的一致，而不是叠几个球。
 * ------------------------------------------------------------------ */

/** 柱身上的一个点（柱坐标 → 场景坐标） */
function columnPoint(spec: ColumnSpec, angle: number, v: number, radiusFactor: number): [number, number, number] {
  const radius = spec.radiusM * radiusFactor;
  return [spec.x + Math.cos(angle) * radius, spec.baseY + v * spec.heightM, spec.z + Math.sin(angle) * radius];
}

/** 木柱不是完美圆柱：半径带一点确定性的起伏（年轮 / 找平留下的），幅度 1.5% */
function shellWobble(v: number, angle: number): number {
  return 1 + 0.015 * Math.sin(v * 26 + angle * 3);
}

/** 一个缺陷"挖掉哪块木料"的几何描述（生成点云前先算出来） */
type CarveRegion =
  | { kind: "borer"; cx: number; cy: number; cz: number; radius: number; wobble: number }
  | {
      kind: "crack";
      angle: number;
      centerY: number;
      halfLength: number;
      innerR: number;
      outerR: number;
      thickness: number;
      tilt: number;
    }
  | { kind: "damage"; centerAngle: number; halfSpan: number; topV: number };

/** 这个点是否落在某个挖空区里（真 = 木料在这里已经没了） */
function isCarved(region: CarveRegion, spec: ColumnSpec, x: number, y: number, z: number): boolean {
  if (region.kind === "borer") {
    const dx = x - region.cx;
    const dy = (y - region.cy) / 1.25;
    const dz = z - region.cz;
    /* 多留一点余量：空腔边缘不该还有木料点，否则看起来像"里面塞了渣" */
    return Math.hypot(dx, dy, dz) <= region.radius * (1 + region.wobble * 0.35);
  }
  if (region.kind === "crack") {
    /* 裂痕是一张**切向**的薄片：法线取该角度的切向，木料在片两侧 */
    const dy = y - region.centerY;
    if (Math.abs(dy) > region.halfLength) return false;
    /* 片本身随倾角倾斜：把 y 折算到"沿缝方向"上 */
    const along = dy * Math.cos(region.tilt);
    const radial = Math.hypot(x - spec.x, z - spec.z);
    if (radial < region.innerR || radial > region.outerR) return false;
    /* 切向距离：把点投到该角度处的切线上 */
    const tangential = -Math.sin(region.angle) * (x - spec.x) + Math.cos(region.angle) * (z - spec.z);
    return Math.abs(tangential + along * Math.sin(region.tilt)) <= region.thickness / 2;
  }
  /* 破损：柱脚一圈被磕掉的一块 —— 半径大于"缺口面"的点算作已经没了 */
  const angle = Math.atan2(z - spec.z, x - spec.x);
  const offset = Math.abs(((angle - region.centerAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  if (offset > region.halfSpan) return false;
  const v = (y - spec.baseY) / spec.heightM;
  if (v < 0 || v > region.topV) return false;
  const bite = damageBite(region, offset, v);
  return Math.hypot(x - spec.x, z - spec.z) >= spec.radiusM * bite;
}

/** 缺口面：从缺口中心往两边、往上逐渐收浅（0.45 = 最深啃掉 45% 半径） */
function damageBite(region: Extract<CarveRegion, { kind: "damage" }>, offset: number, v: number): number {
  const edge = 1 - offset / region.halfSpan;
  const depth = 1 - v / Math.max(0.01, region.topV);
  return 1 - edge * depth * 0.45;
}

/** 把缺陷配方翻译成挖空区（几何只算一次，后面壳/体/缺陷面都用它） */
function carveRegionOf(spec: ColumnSpec, recipe: DefectRecipe): CarveRegion {
  if (recipe.kind === "borer") {
    const centerY = spec.baseY + recipe.at.v * spec.heightM;
    const centerAngle = recipe.at.u >= 0 ? 0.6 : Math.PI + 0.6;
    const offset = Math.abs(recipe.at.u) * spec.radiusM;
    return {
      kind: "borer",
      cx: spec.x + Math.cos(centerAngle) * offset * 0.8,
      cy: centerY,
      cz: spec.z + Math.sin(centerAngle) * offset * 0.8,
      radius: recipe.at.radius,
      wobble: recipe.at.wobble,
    };
  }
  if (recipe.kind === "crack") {
    return {
      kind: "crack",
      angle: 1.2,
      centerY: spec.baseY + recipe.at.v * spec.heightM,
      halfLength: (recipe.at.length * spec.radiusM * 2.2) / 1,
      innerR: spec.radiusM * 0.3,
      outerR: spec.radiusM * 0.99,
      thickness: spec.radiusM * 0.09,
      tilt: (recipe.at.tiltDeg * Math.PI) / 180,
    };
  }
  return {
    kind: "damage",
    centerAngle: 0.35,
    halfSpan: (recipe.at.spanDeg * Math.PI) / 180 / 2,
    topV: recipe.at.v + recipe.at.depth * 0.35,
  };
}

/** 外表壳：柱面 + 两端封口（柱脚看得见"是一个圆柱"），缺陷处的壳点同样被剔掉 */
function buildShell(spec: ColumnSpec, regions: readonly CarveRegion[], random: () => number): Float32Array {
  const points: number[] = [];
  const keep = (x: number, y: number, z: number) => !regions.some((region) => isCarved(region, spec, x, y, z));
  for (let level = 0; level < SHELL_LEVELS; level += 1) {
    const v = level / (SHELL_LEVELS - 1);
    const count = Math.round(SHELL_RINGS * Math.max(0.35, Math.sin(Math.PI * v) * 0.3 + 0.75));
    for (let ring = 0; ring < count; ring += 1) {
      const angle = (ring / count) * Math.PI * 2 + random() * 0.06;
      const [x, y, z] = columnPoint(spec, angle, v, shellWobble(v, angle));
      if (keep(x, y, z)) points.push(x, y, z);
    }
  }
  /* 柱脚 / 柱顶封口：点云柱的两端不该是空的 */
  const capRings = 26;
  for (const v of [0, 1]) {
    for (let ring = 0; ring < capRings; ring += 1) {
      for (let step = 0; step < capRings; step += 1) {
        const radiusFactor = (step + 0.5) / capRings;
        const angle = (ring / capRings) * Math.PI * 2;
        const [x, y, z] = columnPoint(spec, angle, v, radiusFactor * 0.995);
        if (keep(x, y, z)) points.push(x, y, z);
      }
    }
  }
  return new Float32Array(points);
}

/**
 * 内部木料：按体积均匀填点（"木柱内部都是点云"）。
 *
 * 采样方式：柱坐标里对半径取 `sqrt(u)`（保证面积均匀、不是往圆心堆），
 * 高度均匀；点落在挖空区里就丢掉 —— 于是虫蛀/裂痕/破损在点云里就是**空白**。
 */
function buildVolume(spec: ColumnSpec, regions: readonly CarveRegion[], random: () => number): Float32Array {
  const volumeM3 = Math.PI * spec.radiusM * spec.radiusM * spec.heightM;
  const want = Math.min(VOLUME_MAX_POINTS, Math.round(volumeM3 * VOLUME_POINTS_PER_M3));
  const points: number[] = [];
  /* 挖空率高时（例如柱脚被啃掉一块）要多采一些才能填满剩余体积 */
  let attempt = 0;
  const maxAttempts = want * 3;
  while (points.length / 3 < want && attempt < maxAttempts) {
    attempt += 1;
    const angle = random() * Math.PI * 2;
    const v = random();
    const radiusFactor = Math.sqrt(random()) * 0.998;
    const [x, y, z] = columnPoint(spec, angle, v, radiusFactor);
    if (regions.some((region) => isCarved(region, spec, x, y, z))) continue;
    points.push(x, y, z);
  }
  return new Float32Array(points);
}

/** 虫蛀空洞：画出**腔壁**（空腔内部本身是空的，所以看上去就是个洞） */
function buildBorer(region: Extract<CarveRegion, { kind: "borer" }>, random: () => number): Float32Array {
  const points: number[] = [];
  const count = 2600;
  for (let index = 0; index < count; index += 1) {
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    /* 腔壁凹凸不平：噪声幅度等于挖空时用的那一份，壁才贴在洞口上 */
    const noise = 1 + (random() - 0.5) * region.wobble;
    const r = region.radius * noise;
    points.push(
      region.cx + r * Math.sin(phi) * Math.cos(theta),
      region.cy + r * Math.cos(phi) * 1.25,
      region.cz + r * Math.sin(phi) * Math.sin(theta),
    );
  }
  return new Float32Array(points);
}

/** 内部裂痕：**两个面**（裂而不空 —— 与虫蛀的区别就在这里） */
function buildCrack(spec: ColumnSpec, region: Extract<CarveRegion, { kind: "crack" }>, random: () => number): Float32Array {
  const points: number[] = [];
  const count = 2400;
  for (let index = 0; index < count; index += 1) {
    const side = index % 2 === 0 ? 1 : -1;
    const along = (random() * 2 - 1) * region.halfLength;
    const radial = region.innerR + random() * (region.outerR - region.innerR);
    const y = region.centerY + along * Math.cos(region.tilt);
    const tangential = -along * Math.sin(region.tilt) + (side * region.thickness) / 2;
    points.push(
      spec.x + Math.cos(region.angle) * radial - Math.sin(region.angle) * tangential,
      y,
      spec.z + Math.sin(region.angle) * radial + Math.cos(region.angle) * tangential,
    );
  }
  return new Float32Array(points);
}

/** 破损：画出被磕出来的**那个面**（缺口的壁），木料点已经在它外面被剔掉 */
function buildDamage(spec: ColumnSpec, region: Extract<CarveRegion, { kind: "damage" }>, random: () => number): Float32Array {
  const points: number[] = [];
  const count = 2200;
  for (let index = 0; index < count; index += 1) {
    const offset = random() * region.halfSpan;
    const v = random() * region.topV;
    const angle = region.centerAngle + (random() < 0.5 ? offset : -offset);
    const bite = damageBite(region, offset, v) * (1 + (random() - 0.5) * 0.05);
    points.push(...columnPoint(spec, angle, v, bite));
  }
  return new Float32Array(points);
}

/** 生成一根柱子：先算挖空区 → 再出壳与体（带剔除）→ 最后画缺陷面 */
export function buildColumnCloud(spec: ColumnSpec, recipes: readonly DefectRecipe[] = DEFECT_RECIPES[spec.componentId] ?? []): ColumnCloud {
  const random = mulberry32(seedOf(spec.componentId));
  const regions = recipes.map((recipe) => carveRegionOf(spec, recipe));
  const shell = buildShell(spec, regions, random);
  const volume = buildVolume(spec, regions, random);
  const defects: CloudDefect[] = recipes.map((recipe, index) => {
    const region = regions[index];
    if (region.kind === "borer") {
      return {
        kind: "borer" as const,
        label: recipe.label,
        source: recipe.source,
        points: buildBorer(region, random),
        centroid: { x: region.cx, y: region.cy, z: region.cz },
      };
    }
    if (region.kind === "crack") {
      return {
        kind: "crack" as const,
        label: recipe.label,
        source: recipe.source,
        points: buildCrack(spec, region, random),
        centroid: { x: spec.x + spec.radiusM * 0.6, y: region.centerY, z: spec.z },
      };
    }
    return {
      kind: "damage" as const,
      label: recipe.label,
      source: recipe.source,
      points: buildDamage(spec, region, random),
      centroid: {
        x: spec.x + Math.cos(region.centerAngle) * spec.radiusM * 0.85,
        y: spec.baseY + (region.topV * spec.heightM) / 2,
        z: spec.z + Math.sin(region.centerAngle) * spec.radiusM * 0.85,
      },
    };
  });
  return { spec, shell, volume, defects };
}

/** 生成整个内部点云（默认四根柱子全要；可按构件过滤） */
export function buildInternalCloud(componentIds?: readonly string[]): InternalCloud {
  const wanted = componentIds?.length ? COLUMN_SPECS.filter((spec) => componentIds.includes(spec.componentId)) : COLUMN_SPECS;
  const columns = wanted.map((spec) => buildColumnCloud(spec));
  const totals: Record<CloudDefectKind, number> = { borer: 0, crack: 0, damage: 0 };
  for (const column of columns) {
    for (const defect of column.defects) totals[defect.kind] += 1;
  }
  return {
    columns,
    bounds: { min: [...SPLAT_BOUNDS.min] as [number, number, number], max: [...SPLAT_BOUNDS.max] as [number, number, number] },
    totals,
    note: INTERNAL_CLOUD_SOURCE_NOTE,
  };
}

/** 这一根柱子有哪些内部缺陷（列表用；也便于单测逐条核） */
export function defectsOf(componentId: string): readonly DefectRecipe[] {
  return DEFECT_RECIPES[componentId] ?? [];
}
