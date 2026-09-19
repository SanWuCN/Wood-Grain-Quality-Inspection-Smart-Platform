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
const SHELL_RINGS = 96;
const SHELL_LEVELS = 220;
/** 芯部（内部实木）点密度：比外壳稀，避免挡住内部缺陷 */
const CORE_RATIO = 0.22;

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
  /** 外表壳点（看得出来是"柱子的形状"） */
  shell: Float32Array;
  /** 内部芯点（稀疏） */
  core: Float32Array;
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
 * ------------------------------------------------------------------ */

/** 柱身上的一个点（柱坐标 → 场景坐标） */
function columnPoint(spec: ColumnSpec, angle: number, v: number, radiusFactor: number): [number, number, number] {
  const radius = spec.radiusM * radiusFactor;
  return [spec.x + Math.cos(angle) * radius, spec.baseY + v * spec.heightM, spec.z + Math.sin(angle) * radius];
}

/** 外表壳：柱面 + 两端封口（柱脚看得见"是一个圆柱"） */
function buildShell(spec: ColumnSpec, random: () => number): Float32Array {
  const points: number[] = [];
  for (let level = 0; level < SHELL_LEVELS; level += 1) {
    const v = level / (SHELL_LEVELS - 1);
    const count = Math.round(SHELL_RINGS * Math.max(0.35, Math.sin(Math.PI * v) * 0.3 + 0.75));
    for (let ring = 0; ring < count; ring += 1) {
      const angle = (ring / count) * Math.PI * 2 + random() * 0.06;
      /* 木柱不是完美圆柱：半径带一点确定性的起伏（年轮/找平留下的），幅度 1.5% */
      const wobble = 1 + 0.015 * Math.sin(v * 26 + angle * 3);
      points.push(...columnPoint(spec, angle, v, wobble));
    }
  }
  return new Float32Array(points);
}

/** 内部芯：半径 0–55% 的稀疏点，用来"填出体积感" */
function buildCore(spec: ColumnSpec, random: () => number): Float32Array {
  const count = Math.round(SHELL_RINGS * SHELL_LEVELS * CORE_RATIO);
  const points: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = random() * Math.PI * 2;
    const v = random();
    const radiusFactor = Math.sqrt(random()) * 0.55;
    points.push(...columnPoint(spec, angle, v, radiusFactor));
  }
  return new Float32Array(points);
}

/** 虫蛀空洞：一个不规则空腔的**腔壁**点（所以看起来是"里面被掏空了"） */
function buildBorer(spec: ColumnSpec, recipe: Extract<DefectRecipe, { kind: "borer" }>, random: () => number): CloudDefect {
  const points: number[] = [];
  const centerY = spec.baseY + recipe.at.v * spec.heightM;
  const centerAngle = recipe.at.u >= 0 ? 0.6 : Math.PI + 0.6;
  const offset = Math.abs(recipe.at.u) * spec.radiusM;
  const cx = spec.x + Math.cos(centerAngle) * offset * 0.8;
  const cz = spec.z + Math.sin(centerAngle) * offset * 0.8;
  const count = 1400;
  for (let index = 0; index < count; index += 1) {
    /* 球面均匀采样 + 噪声：腔壁凹凸不平（wobble 控幅度） */
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    const noise = 1 + (random() - 0.5) * recipe.at.wobble;
    const r = recipe.at.radius * noise;
    points.push(
      cx + r * Math.sin(phi) * Math.cos(theta),
      centerY + r * Math.cos(phi) * 1.25,
      cz + r * Math.sin(phi) * Math.sin(theta),
    );
  }
  return {
    kind: "borer",
    label: recipe.label,
    source: recipe.source,
    points: new Float32Array(points),
    centroid: { x: cx, y: centerY, z: cz },
  };
}

/** 内部裂痕：一张沿柱高倾斜的**薄片**点（裂而不空 —— 这一点与虫蛀不同） */
function buildCrack(spec: ColumnSpec, recipe: Extract<DefectRecipe, { kind: "crack" }>, random: () => number): CloudDefect {
  const points: number[] = [];
  const centerV = recipe.at.v;
  const centerY = spec.baseY + centerV * spec.heightM;
  const tilt = (recipe.at.tiltDeg * Math.PI) / 180;
  const half = recipe.at.length * spec.radiusM * 2.2;
  const count = 900;
  for (let index = 0; index < count; index += 1) {
    /* 沿柱身方向的细长裂：长度方向 = 柱高，宽度方向 = 半径，厚度极小 */
    const along = (random() * 2 - 1) * half;
    const depth = random() * recipe.at.depth * spec.radiusM;
    const thickness = (random() - 0.5) * spec.radiusM * 0.05;
    const y = centerY + along * Math.cos(tilt);
    const lateral = along * Math.sin(tilt);
    const angle = 1.2 + lateral / Math.max(0.02, spec.radiusM);
    points.push(
      spec.x + Math.cos(angle) * (spec.radiusM * 0.35 + depth) + thickness,
      y,
      spec.z + Math.sin(angle) * (spec.radiusM * 0.35 + depth) + thickness,
    );
  }
  return {
    kind: "crack",
    label: recipe.label,
    source: recipe.source,
    points: new Float32Array(points),
    centroid: { x: spec.x + spec.radiusM * 0.35, y: centerY, z: spec.z },
  };
}

/** 缺损 / 破损：柱脚一圈被磕掉的一块（缺的是外壳点，边上留毛刺） */
function buildDamage(spec: ColumnSpec, recipe: Extract<DefectRecipe, { kind: "damage" }>, random: () => number): CloudDefect {
  const points: number[] = [];
  const centerAngle = 0.35;
  const halfSpan = (recipe.at.spanDeg * Math.PI) / 180 / 2;
  const topV = recipe.at.v + recipe.at.depth * 0.35;
  const count = 1200;
  for (let index = 0; index < count; index += 1) {
    const angle = centerAngle + (random() * 2 - 1) * halfSpan;
    const v = random() * topV;
    /* 缺口边缘：半径比柱面小一点（"被啃掉一层"），越靠缺口中心越深 */
    const bite = 1 - (1 - Math.abs(angle - centerAngle) / halfSpan) * (1 - v / Math.max(0.01, topV)) * 0.45;
    points.push(...columnPoint(spec, angle, v, bite * (1 + (random() - 0.5) * 0.06)));
  }
  return {
    kind: "damage",
    label: recipe.label,
    source: recipe.source,
    points: new Float32Array(points),
    centroid: {
      x: spec.x + Math.cos(centerAngle) * spec.radiusM,
      y: spec.baseY + topV * spec.heightM * 0.5,
      z: spec.z + Math.sin(centerAngle) * spec.radiusM,
    },
  };
}

/** 生成一根柱子的点云（外壳 + 芯 + 它的内部缺陷） */
export function buildColumnCloud(spec: ColumnSpec, recipes: readonly DefectRecipe[] = DEFECT_RECIPES[spec.componentId] ?? []): ColumnCloud {
  const random = mulberry32(seedOf(spec.componentId));
  const defects = recipes.map((recipe) => {
    if (recipe.kind === "borer") return buildBorer(spec, recipe, random);
    if (recipe.kind === "crack") return buildCrack(spec, recipe, random);
    return buildDamage(spec, recipe, random);
  });
  return { spec, shell: buildShell(spec, random), core: buildCore(spec, random), defects };
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
