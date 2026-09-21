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

/**
 * 界面上必须原样显示的来源说明（与页面上的角标同一份文本，避免两处走样）。
 *
 * ⚠ 2026-10-02 压成**一句话**（用户口径：「『这一屏是什么 … 缺陷位置为预置结果。』
 * 这个东西不要有」）：去掉的是那块标题与整段解释，**口径本身不能丢** ——
 * PRD 要求写明"按外形生成、不是实测、缺陷为预置结果"，这三件事一个字都没少，
 * 只是不再占一屏的位置去解释自己（柱高参数那句挪进 `COLUMN_VISIBLE_HEIGHT_M` 的注释，
 * 界面上由"可视段高"那一行的读数承担）。
 */
export const INTERNAL_CLOUD_SOURCE_NOTE =
  "按构件外形与档案记录生成，不是实测点云；缺陷位置为预置结果";

/** 可视段高（米）。档案里没有柱高，这是**本视图参数**，界面上写明 */
export const COLUMN_VISIBLE_HEIGHT_M = 3.2;
/** 柱脚离地：让柱身略高于地面网格，便于看清柱脚破损 */
export const COLUMN_BASE_LIFT_M = 0.25;

/* ------------------------------------------------------------------ *
 * 中空（用户口径 2026-10-01：「能看到内部中空啊」）
 *
 * ── 为什么口径改成"真的掏一个空腔" ──────────────────────────────────
 * 前面几版只在**颜色**上做"洞口暗、腔壁亮"的暗示，屏幕上是一块暗斑；
 * 而"中空"是**几何**：柱心确实没有木料、从柱顶 / 洞口能看进去。
 * 老木柱的**心材腐朽**正是这种形态（外皮还在、里面空了），
 * 也是这一屏"内部点云"最该展示的东西。
 *
 * ── 形态（都跟着构件尺寸走，不写死米数）────────────────────────────
 *   · 空腔半径 `HOLLOW_RADIUS_RATIO × 半径`（0.45）：外皮留着，心是空的；
 *   · 空腔从**柱顶**往下延伸到 `HOLLOW_TOP_V - HOLLOW_DEPTH_V`（1.0 → 0.42）；
 *     下段仍是实心木料 —— 这样从顶上往里看是"一个深不见底的洞"，不是一根通管；
 *   · 柱顶封口在空腔范围内**不封**（那里什么都没有），所以真能看进去。
 * ------------------------------------------------------------------ */

/** 空腔半径（相对柱半径）—— 外皮厚度 = 半径的 55% */
export const HOLLOW_RADIUS_RATIO = 0.62;
/**
 * 空腔沿柱高的归一化范围（0 = 柱脚、1 = 柱顶）
 *
 * ⚠ 2026-10-02 改动（用户口径：「根本看不出内部问题，内部得有虫蛀之类的孔洞」）：
 * 原来空腔是一根**干净的水滴形**管子（圆形截面 + 一点正弦扰动），屏幕上读成
 * "被人钻了一个规整的孔"—— 那是孔，不是**虫蛀**：真实的蛀心材是
 * 腔壁凹凸不平、有主虫道与分叉的细虫道、道口在柱面上有好几个。
 * 所以现在：① 腔壁按噪声做不规则（`hollowRadiusFactor`）；
 * ② 腔里再挖一层**虫道网络**（见 `BurrowSegment` / `BURROW_*`）；
 * ③ 虫道走到柱面就是**孔口**（每根柱子多出 4 个可见的洞，不是只有那两处配方洞）。
 */
export const HOLLOW_TOP_V = 1.0;
export const HOLLOW_BOTTOM_V = 0.34;

/**
 * 腔壁的不规则度（相对半径）。
 *
 * 三层噪声叠加：低频鼓包（0.30）+ 中频龛洞（0.22）+ 高频麻点（0.08）。
 * 取值是按"看得出来的凹凸"定的：太小（<0.1）读起来还是光滑管壁；
 * 太大会把腔壁推到外皮上（外皮厚度 = 半径的 38%），柱面就破了。
 */
export const HOLLOW_WALL_WOBBLE = { low: 0.3, mid: 0.22, fine: 0.08 } as const;

/**
 * 空腔壁的半径系数（1 = 名义空腔半径）。
 *
 * 用噪声做**真正的凹凸** —— 不是"圆形 + 正弦扰一点"，而是：
 *   · 低频（`v` 方向 ~2.5 个鼓包、环向 3 个）：整段腔壁鼓出来 / 凹进去；
 *   · 中频：一个个小龛（虫子啃出来的凹坑）；
 *   · 高频：麻点。
 * 上下界卡在 [0.55, 1.42]：下限保证腔壁不会贴到柱轴上（那样看着像实心被钻穿），
 * 上限保证不会顶破外皮（0.62 × 1.42 = 0.88 < 1，外皮还剩 12%）。
 */
export function hollowRadiusFactor(spec: ColumnSpec, angle: number, v: number): number {
  const seed = columnSeed(spec);
  const low = valueNoise2(v * 2.5, angle * 0.5, seed + 907) - 0.5;
  const mid = valueNoise2(v * 7.5, angle * 2.4, seed + 1091) - 0.5;
  const fine = valueNoise2(v * 26, angle * 7.5, seed + 1237) - 0.5;
  const factor =
    1 +
    low * 2 * HOLLOW_WALL_WOBBLE.low +
    mid * 2 * HOLLOW_WALL_WOBBLE.mid +
    fine * 2 * HOLLOW_WALL_WOBBLE.fine;
  return Math.min(1.42, Math.max(0.55, factor));
}

/* ------------------------------------------------------------------ *
 * 虫道网络（用户口径 2026-10-02：「内部得有虫蛀之类的孔洞」）
 *
 * ── 为什么光有"空腔"不够 ──────────────────────────────────────────
 * 前面几版把内部做成一个规整的空腔，读起来是"钻了一个孔"。
 * 蛀心材真正的样子是：**主虫道 + 分叉的细虫道**，道壁粗糙，
 * 而且道会走到柱面 —— 柱身上因此有好几个小圆孔。
 *
 * ── 怎么保证"看得见" ─────────────────────────────────────────────
 *   · 主虫道沿柱心竖直走（在空腔里，天生可见）；
 *   · 分叉虫道从主虫道斜着往外走，**终点落在朝相机那一侧的柱面上**
 *     （与 `CAMERA_FACING_ANGLE` 同一套方位约定），于是柱面上多出几个孔口；
 *   · 每条道给一个"忽粗忽细"的半径（蛀道不是等径管）。
 * ------------------------------------------------------------------ */

/** 虫道的一段：圆柱胶囊（起点 → 终点 + 半径），判据只用点到线段的距离 */
export type BurrowSegment = {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  radius: number;
  /** 预计算的包围球半径（判据先做一次快速排除，点云生成时省一大半距离计算） */
  reach: number;
};

/** 一根柱子的虫道网 */
export type BurrowNetwork = {
  segments: BurrowSegment[];
  /** 柱面上被打出来的孔口（每个 = 位置 + 法向），供壳体开口与孔口描边用 */
  mouths: { x: number; y: number; z: number; nx: number; nz: number; radius: number }[];
};

/**
 * 主虫道半径（相对柱半径）：柱径 360 mm 时约 31 mm —— 粉蠹/天牛的蛀道口径量级。
 *
 * ⚠ 这个数决定"看不看得出是虫道"：腔壁点距约 3–8 mm，道径 40 mm 以上道壁才铺得出
 * 一圈像样的点；太细（<15 mm）在点云里就是一条虚线，读不出"孔洞"。
 */
export const BURROW_TRUNK_RATIO = 0.09;
/** 分叉虫道半径（相对主虫道）—— 分叉要细一档，主次才分得出来 */
export const BURROW_BRANCH_RATIO = 0.62;
/**
 * 分叉条数（每根柱子；都朝看得见的那一面）。
 *
 * ⚠ 条数与角距是一对：分叉太多、挨太近，孔口会在柱面上**连成一片**
 * （实测 5 条 × 0.17 rad 时，5 个孔口里有 2 个被邻道的壳体盖住，"通了"的只有 3 个）。
 * 现在 4 条 × 0.44 rad 铺开约 76°，孔口彼此分得开、又都朝着相机那一面。
 */
export const BURROW_BRANCH_COUNT = 4;
/** 分叉之间的方位角距（弧度）。孔口半径约 0.1 rad，留足余量才不互相压住 */
export const BURROW_BRANCH_SPREAD = 0.44;

/**
 * 生成一根柱子的虫道网（确定性：同一根柱子每次一样）。
 *
 * 形态：一条沿柱心竖直的主虫道 + N 条从主虫道斜向柱面的分叉。
 * `v` 高度错开（不同高度各出一条），方位角绕相机朝向左右铺开 ——
 * 全挤在一个方位会读成"一个洞"，铺开才读成"虫蛀了一片"。
 */
export function burrowNetworkOf(spec: ColumnSpec): BurrowNetwork {
  const random = mulberry32(seedOf(spec.componentId) ^ 0x5f3a);
  const trunkR = spec.radiusM * BURROW_TRUNK_RATIO;
  const spread = spec.radiusM * HOLLOW_RADIUS_RATIO;
  const segments: BurrowSegment[] = [];
  const mouths: BurrowNetwork["mouths"] = [];
  const baseY = spec.baseY + spec.heightM * (HOLLOW_BOTTOM_V + 0.06);

  const push = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, radius: number) => {
    const reach = radius + Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
    segments.push({ x0, y0, z0, x1, y1, z1, radius, reach });
  };

  /* 主虫道：分几段接起来，略微蛇形（直的读起来像钻孔） */
  const trunkTop = spec.baseY + spec.heightM * (HOLLOW_TOP_V - 0.02);
  const trunkSteps = 5;
  let cursor = { x: spec.x, y: baseY, z: spec.z };
  for (let step = 1; step <= trunkSteps; step += 1) {
    const t = step / trunkSteps;
    const y = baseY + (trunkTop - baseY) * t;
    const wander = spec.radiusM * 0.035;
    const next = {
      x: spec.x + (random() - 0.5) * wander * 2,
      y,
      z: spec.z + (random() - 0.5) * wander * 2,
    };
    const radius = trunkR * (0.82 + random() * 0.42);
    push(cursor.x, cursor.y, cursor.z, next.x, next.y, next.z, radius);
    cursor = next;
  }

  /* 分叉：从主虫道斜着往外，终点扎到柱面上 —— 那就是孔口 */
  for (let index = 0; index < BURROW_BRANCH_COUNT; index += 1) {
    const t = (index + 0.5) / BURROW_BRANCH_COUNT;
    const y = baseY + (trunkTop - baseY) * (0.12 + t * 0.78);
    /* 方位绕相机朝向左右铺开（见 BURROW_BRANCH_SPREAD 的说明），与那两处配方洞同一套约定 */
    const angle = CAMERA_FACING_ANGLE + (index - (BURROW_BRANCH_COUNT - 1) / 2) * BURROW_BRANCH_SPREAD;
    const startRadius = spread * (0.15 + random() * 0.25);
    const sx = spec.x + Math.cos(angle) * startRadius;
    const sz = spec.z + Math.sin(angle) * startRadius;
    /* 终点在柱面上（0.995 倍：贴到表面，又不至于让道壁点飘到柱外） */
    const mouthRadius = spec.radiusM * 0.995;
    const mx = spec.x + Math.cos(angle) * mouthRadius;
    const mz = spec.z + Math.sin(angle) * mouthRadius;
    const radius = trunkR * BURROW_BRANCH_RATIO * (0.7 + random() * 0.7);
    push(sx, y, sz, mx, y + (random() - 0.5) * spec.heightM * 0.02, mz, radius);
    mouths.push({ x: mx, y, z: mz, nx: Math.cos(angle), nz: Math.sin(angle), radius: radius * 1.5 });
    /* 一条细支道从分叉中段再拐一次（虫道是分叉的，不是一把直叉子） */
    const k = 0.35 + random() * 0.3;
    const bx = sx + (mx - sx) * k;
    const bz = sz + (mz - sz) * k;
    const sideAngle = angle + (random() > 0.5 ? 1 : -1) * (0.4 + random() * 0.5);
    const len = spec.radiusM * (0.18 + random() * 0.16);
    push(
      bx,
      y,
      bz,
      bx + Math.cos(sideAngle) * len,
      y + (random() - 0.5) * spec.heightM * 0.03,
      bz + Math.sin(sideAngle) * len,
      radius * (0.45 + random() * 0.35),
    );
  }

  return { segments, mouths };
}

/** 这个点是不是落在某条虫道里（先按包围球快速排除，再做点到线段的距离） */
export function inBurrow(segments: readonly BurrowSegment[], x: number, y: number, z: number): boolean {
  for (const segment of segments) {
    const cx = (segment.x0 + segment.x1) / 2;
    const cy = (segment.y0 + segment.y1) / 2;
    const cz = (segment.z0 + segment.z1) / 2;
    const dx = x - cx;
    const dy = y - cy;
    const dz = z - cz;
    if (dx * dx + dy * dy + dz * dz > segment.reach * segment.reach) continue;
    /* 点到线段的距离 */
    const ax = segment.x1 - segment.x0;
    const ay = segment.y1 - segment.y0;
    const az = segment.z1 - segment.z0;
    const lengthSq = ax * ax + ay * ay + az * az;
    let t = 0;
    if (lengthSq > 1e-12) {
      t = ((x - segment.x0) * ax + (y - segment.y0) * ay + (z - segment.z0) * az) / lengthSq;
      t = Math.min(1, Math.max(0, t));
    }
    const px = segment.x0 + ax * t - x;
    const py = segment.y0 + ay * t - y;
    const pz = segment.z0 + az * t - z;
    if (px * px + py * py + pz * pz <= segment.radius * segment.radius) return true;
  }
  return false;
}

/**
 * 这个点是否在**中空腔**里（真 = 木料在这里已经没了）。
 *
 * 判据 = 到柱轴的距离 + 高度（与壳体/体/缺陷面共用同一份），
 * 腔壁半径按 `hollowRadiusFactor` 做**不规则**（虫蛀腔壁本身就是凹凸的）。
 */
function inHollow(spec: ColumnSpec, x: number, y: number, z: number): boolean {
  const v = (y - spec.baseY) / Math.max(1e-6, spec.heightM);
  if (v < HOLLOW_BOTTOM_V || v > HOLLOW_TOP_V + 1e-6) return false;
  const angle = Math.atan2(z - spec.z, x - spec.x);
  const limit = spec.radiusM * HOLLOW_RADIUS_RATIO * hollowRadiusFactor(spec, angle, v);
  return Math.hypot(x - spec.x, z - spec.z) < limit;
}

/* ------------------------------------------------------------------ *
 * 精度参数（用户口径两轮：「3d 点云做得更精细一些」→「外观保证单根木柱
 * 高斯泼溅的那根」）
 *
 * ── 第一轮（纯加密）不够 ────────────────────────────────────────────
 * 把环向 84 → 176 点/圈、体密度 140k → 220k 之后，点距到了 5.7–6.4 mm，
 * 但用户看了还是说"要更精细" —— 因为**尺寸精细 ≠ 像那根柱子**：
 * 高斯泼溅那根是真实旧木柱，截面不规则、有斧凿的凹面、有剥落，柱顶还有雕花；
 * 而这边是一个**光滑圆柱**，轮廓当然对不上。
 *
 * ── 这一轮按"扫描质感"重建柱面 ──────────────────────────────────────
 * 柱面半径 = 标称半径 ×（截面不规则 × 斧凿棱面 × 剥落残斑 × 皴纹），逐项都在
 * `surfaceRadiusFactor()` 里，噪声用**确定性 valueNoise**（同一根每次一样）。
 * 同时把采样加密到 3.5 mm 级 —— 细节要有足够点才读得出来。
 *
 * ⚠ 预算：四根一起看时点是一起进 GPU 的。目标 < 120 万颗高斯
 * （泼溅比 `gl.POINTS` 贵，但也不该无限涨），见 `columnPointBudget()` 与单测的预算断言。
 *
 * ⚠ 2026-10-01 加密过一次（×1.4）：用户口径「正常是要看到一个一个点啊，
 * 你现在这点云图都纯棕色木柱」—— 把每颗点缩到间距以下之后（见 `SPLAT_SPREAD`），
 * **点与点之间露出的空隙变大**，柱子会显得发虚、发淡。修法不是把点重新调大
 * （那就回到"实心木柱"），而是**加密**：点距缩小、点又各自分得开，颗粒与实心兼得。
 * ------------------------------------------------------------------ */

/** 柱面环向点数（每层一圈的基准点数） */
const SHELL_RINGS = 340;
/** 柱面轴向层数 */
const SHELL_LEVELS = 390;
/**
 * 柱面起伏上限（相对半径）。
 *
 * ⚠ 这个常量同时是**单测判据**（`internalPointCloud.test.ts` 断言"所有点都在圆柱内"
 * 用的就是它）：截面不规则 + 斧凿棱面 + 皴纹 + 剥落余量 + 抖动加起来不许超过它。
 * 所以这里导出，让生成器与单测用**同一个数**，不再各写一份。
 * 下限（凹陷侧）另有 `SURFACE_MIN_FACTOR`，同样导出给单测。
 */
export const SHELL_MAX_WOBBLE = 0.14;
/** 凹陷侧下限：任何一处半径都不该薄到"快穿到轴心" */
export const SURFACE_MIN_FACTOR = 0.86;
/**
 * 截面不规则：低频，把圆截面变成手砍原木的鼓形。
 *
 * ⚠ 幅度是**量过才定的**：第一版写成
 * `(1+a·sin)·(1-b·cos(7θ))·(1-c·grain)` 相乘，又把棱面做成"乘一个深因子"，
 * 结果实测截面不规则度 **16–18%**（看着像多面体）、深凹陷面积占 **26%**（像海绵）。
 * 现在四个分量改成**同量纲的加法偏移**（都以标称半径为基准），每项对
 * "半径极差"的贡献可以直接加出来：
 *   截面 2×0.028 + 棱面 2×0.016 + 皴纹 2×0.008 ≈ 10.4% 极差（目标 6–8%，取小值后达标）
 */
const LOG_IRREGULARITY = 0.026;
/** 斧凿棱面：环向 7 条宽棱，读起来是"被斧子削出来的平缓面" */
const ADZE_FACETS = 0.014;
/** 剥落残斑的最大深度（局部斑块，用 valueNoise 阈值挑出来） */
const PEEL_DEPTH = 0.034;
/** 竖向皴纹：高频、细，读起来是木纹与风化 */
const GRAIN_RIPPLE = 0.007;
/** 柱面点的位置抖动（相对半径）：打散规则采样网格 */
const SHELL_JITTER = 0.007;
/**
 * 柱面点的**轴向**抖动（相对柱高）。
 *
 * ⚠ 这个不能省（2026-10 实测）：只抖角度与半径时，一层层点仍然严格落在
 * `v = level/(LEVELS-1)` 上（每层 10.0 mm）。壳是**半透明**的（0.42），
 * 背面与内部点透过正面一起参与显示，规则层与屏幕像素列拍频成**横向环纹**
 * （实测行计数波动 RMS 23.9%、最强周期 139 mm、自相关 0.85；而表面本身
 * 的粗糙度只有 0.03%，所以环纹不是几何，是采样网格）。
 * 给高度也加 ±1/3 层距的抖动，规则层被打散，环纹消失。
 */
const SHELL_AXIAL_JITTER = 0.0035;

/**
 * 内部木料的点密度（点/立方米）。
 *
 * ── 用户口径改过两次（2026-09-30 实心化 → 2026-10 加密）──────────────
 * 第一版只画"壳 + 稀疏芯"，用户说：「木柱内部都是点云，破损可视化之类的」
 * → 改成实心点云柱（140k 点/m³）。
 * 之后用户又说"更精细一些"：实心柱在近看时能看出**均匀网格感**，
 * 所以密度提到 220k 点/m³，并在每个点位置加抖动（`VOLUME_JITTER`）。
 *
 * 预算参考：Z04（r=0.18 m、高 3.2 m，体积约 0.326 m³）× 220k ≈ 7.2 万点/根，
 * 四根合计约 28 万（未含缺陷面），加壳与缺陷面后总量约 50 万 ——
 * WebGL 一帧仍然轻松（点渲染就是一次 draw call），而近看不再有网格感。
 */
const VOLUME_POINTS_PER_M3 = 310_000;
/** 单根柱子的内部点数上限（防止极端参数把浏览器拖死） */
const VOLUME_MAX_POINTS = 210_000;
/** 内部点抖动（相对半径）：打散"均匀撒点"的格子感 */
const VOLUME_JITTER = 0.004;
/**
 * 内部木料的径向上限（相对标称半径）。
 *
 * 0.96 = 比"最凹的柱面"（`SURFACE_MIN_FACTOR`）远、又比标称柱面（1.0）近，
 * 于是**任何一处凹面之下都还有木料**，同时内部点也不会从凹面里戳出来。
 *
 * ⚠ 内部点**不需要**轴向抖动：它本来就是均匀随机采样（`random()` 取 v），
 * 没有规则层。实测里"只算内部"那一档残留的 28 mm 周期只是统计噪声（相关 0.40），
 * 不是采样网格 —— 别为了它加一个不起作用的旋钮。
 */
const VOLUME_RADIUS_LIMIT = 0.96;

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
  /** 缺陷自己的**逐点颜色 / 法向 / 尺度**（0–1 / 单位向量 / 米）。
   *
   * 为什么缺陷不再用材质给一个平涂色：平涂色 + 硬边圆盘 = 一团彩色噪点，
   * 无论形状做得多准都读不出"洞 / 缝 / 断面"。这三样是缺陷形态的载体：
   * 颜色带**深度明暗**（洞口亮、腔底暗），法向给高斯朝向，尺度按各自密度定。
   */
  colors: Float32Array;
  normals: Float32Array;
  scales: Float32Array;
  /**
   * 这个缺陷**挖掉了哪块木料**（生成端算出来的权威几何）。
   *
   * 为什么要把内部结构交出来：判据（单测/工装）要断言"腔里是空的"，
   * 就得知道洞心、洞口半径、深度。让判据自己在外部按配方重算一遍，
   * 只要有一处与生成端不一致，得出的结论就是错的 —— 本轮为这条查了四轮，
   * 每一轮都是判据错（用点云反推的洞心与真实洞心差了几毫米，判据就翻在边界上）。
   * 交出权威几何之后，判据只做"量"，不再做"推"。
   */
  carve: CarveRegion;
  /** 缺陷中心（用于相机聚焦与列表排序） */
  centroid: { x: number; y: number; z: number };
};

/**
 * 一份**真高斯泼溅**：每个高斯有位置、颜色、朝向（四元数）与三个轴的尺度。
 *
 * 用户口径（2026-10-01）：「外壳像高斯泼溅的」——
 * 点云用 `gl.POINTS` 画出来是**硬边圆盘**，一颗颗分得清，看着就是"点云"；
 * 泼溅是**有朝向的软高斯椭球**，交叠之后连成一张连续的面。
 * 差别不在点的数量，而在这四个属性（位置之外还有颜色/朝向/尺度）。
 *
 * 数据布局：位置与法向各 3 个 float、颜色 3 个（0–1）、尺度 3 个（**米**，世界单位）。
 * 朝向用**法向**给（`SplatCloud` 里按视线与法向现算两个切向），
 * 因为柱面法向天然就是"这个高斯该贴在哪张面上"，比存四元数省一半内存也好算。
 */
export type SplatCloud = {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  /** 三个轴的尺度（米）：`x` 沿首切向、`y` 沿次切向、`z` 沿法向 */
  scale: Float32Array;
  count: number;
};

export type ColumnCloud = {
  spec: ColumnSpec;
  /** 外表壳点（柱面 + 两端封口）：看得出"这是一根柱子" */
  shell: Float32Array;
  /** 外壳的**高斯泼溅**版（与 `shell` 同一批点，多了法向/尺度/颜色） */
  shellSplats: SplatCloud;
  /** **内部木料点**：按体积填满（实心点云柱），缺陷处已被挖空 */
  volume: Float32Array;
  /** 内部木料的高斯泼溅版 */
  volumeSplats: SplatCloud;
  /**
   * **中空腔的内壁 + 腔底 + 虫道内壁**（用户口径 2026-10-01：「能看到内部中空啊」，
   * 2026-10-02 追加：「内部得有虫蛀之类的孔洞」）。
   *
   * 它不是缺陷：缺陷是"某处坏了"，中空是这根柱子的**既有形态**
   * （老木柱心材腐朽后外皮还在、里面空了 —— 也正是"内部点云"最该展示的东西）。
   * 虫道内壁并进这一层：虫道与空腔是**同一件事的两个层次**（腔是蛀空的腔、道是虫子走的路），
   * 跟着木料一起显示 / 一起收掉（「只看破损」时不该出现）。
   */
  hollowSplats: SplatCloud;
  /**
   * 这根柱子的**虫道网**（主虫道 + 分叉 + 柱面孔口）。
   *
   * 与 `defects[].carve` 一样是**生成端算出来的权威几何**：判据（单测/工装）
   * 要断言"虫道里是空的、道壁画出来了、孔口真的通到柱面"，都得按它量，
   * 不许在判据里按配方重推一遍（本轮为这条反复查过——推出来的与真实的差几毫米就翻边界）。
   */
  burrows: BurrowNetwork;
  /** 缺陷（虫蛀空腔壁 / 裂痕两面 / 破损面），已在 `volume` 与 `shell` 里对应挖空 */
  defects: CloudDefect[];
  /** 缺陷的高斯泼溅版，与 `defects` 一一对应 */
  defectSplats: SplatCloud[];
};

export type InternalCloud = {
  columns: ColumnCloud[];
  /** 场景包围盒（取自 `SPLAT_BOUNDS`，画模型外框用） */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** 每一类缺陷的合计，给图例用 */
  totals: Record<CloudDefectKind, number>;
  note: string;
};

/**
 * 缺陷类型的中文名与配色（渲染层与图例共用一份，避免两处走样）。
 *
 * ── 为什么降了饱和度（用户 2026-09-20：「点云目前色彩太花了」）────────
 * 原来用高饱和橙（`#ff8a3d`）/ 洋红（`#ff4d6d`）：单看醒目，但与木色系
 * （壳 `#d9c4a3` / 芯 `#8a6f4e`）摆在一起就是三种互不相干的高饱和色，
 * 整根柱子成了拼色。现在改成**同明度区间的降饱和色**：三类仍分得清（色相没变），
 * 但不再从木色里"跳出来喊"。图例与缺陷点读的是同一份，改这里两处一起变。
 */
export const DEFECT_STYLE: Record<CloudDefectKind, { label: string; color: string }> = {
  borer: { label: "虫蛀空洞", color: "#c9762f" },
  crack: { label: "内部裂痕", color: "#b5636f" },
  damage: { label: "缺损 / 破损", color: "#8c9199" },
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

/**
 * 柱面的噪声种子：从构件编号推出来，**四根柱子的截面/棱面/剥落各不相同**。
 *
 * 为什么要与 `mulberry32` 的种子分开：那个（`seedOf`）驱动**采样顺序**，
 * 这个驱动**表面几何**。混用一个会让"改一处纹理参数"连带把采样序列也改掉，
 * 单测与工装里那些"具体坐标"的断言就全漂了。
 */
function columnSeed(spec: ColumnSpec): number {
  return (seedOf(spec.componentId) % 997) + 1;
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

/**
 * 两处虫蛀的空间布置（上下各一处，对应风险记录里的"上部/下部响应区"）。
 *
 * ⚠ 洞口半径有**上下两个夹**，本轮把两头都撞过一次：
 *   · 太小（0.06）：柱径 360 mm 时屏幕上只有几像素，讲解时指不出来；
 *   · 太大（0.11）：口径只有 360 mm，"口小肚大"的腔按公式最宽处能到 1.05R，
 *     壁会越过挖空边界与柱面，被边界削掉一大半（实测只剩 1147 点，腔成了半拉）。
 * 0.075 / 0.085 这一档两头都过：屏幕上十几像素、一眼能指出来，
 * 12 cm 左右的洞深也整根落在柱体里（洞深 = 半径 × 1.35）。
 */
const BORER_PLACEMENT = [
  { u: 0.35, v: 0.68, radius: 0.075, wobble: 0.32 },
  { u: -0.3, v: 0.26, radius: 0.085, wobble: 0.38 },
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

/** 柱身上的一个点（柱坐标 → 场景坐标；`radiusFactor` 与 `angle` 已含各自的起伏/抖动） */
function columnPoint(spec: ColumnSpec, angle: number, v: number, radiusFactor: number): [number, number, number] {
  const radius = spec.radiusM * radiusFactor;
  return [spec.x + Math.cos(angle) * radius, spec.baseY + v * spec.heightM, spec.z + Math.sin(angle) * radius];
}

/**
 * 2D 值噪声（确定性，无第三方依赖）。
 *
 * 为什么要它：柱面上的"剥落残斑"是**不规则形状的成片凹陷**，
 * 用几条正弦叠不出来（叠出来像波纹）。值噪声 + 阈值天然给出成片的斑块、
 * 边界还自带缓坡（斑块边缘不会像刀切）。
 *
 * 为什么不用 `Math.random()`：同一根柱子每次打开必须一模一样（演示要可复现，
 * 单测也要能断言具体坐标）。
 */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

/** 平滑插值（smoothstep 权重），避免格点处出现折线 */
function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/**
 * 柱面半径系数（相对标称半径）：**扫描质感的全部来源**。
 *
 * 四层叠加，各管一件事（旧版只有一条正弦 → 近看是光滑管子）：
 *   ① **截面不规则** `LOG_IRREGULARITY`：低频（环向 2 个波 + 沿柱高缓变），
 *      把圆截面变成手工砍出来的原木鼓形/多边形，**轮廓整体就不是正圆了**；
 *   ② **斧凿棱面** `ADZE_FACETS`：环向 7 条较宽的棱，相位随高度缓慢漂移 ——
 *      读起来是"被斧子削出来的平缓面"，这是旧木柱最显眼的特征；
 *   ③ **剥落残斑** `PEEL_DEPTH`：valueNoise 阈值挑出成片凹陷（旧漆/表层脱落），
 *      边界由噪声自身给出缓坡，不是硬边圆坑；
 *   ④ **竖向皴纹** `GRAIN_RIPPLE`：环向高频、轴向极慢，即木纹与风化的细纹。
 *
 * 返回值一定落在 `[SURFACE_MIN_FACTOR, 1 + SHELL_MAX_WOBBLE]` 内
 * （单测按这两个导出常量断言"点不飘到柱外、也不薄到穿心"）。
 *
 * @param seed 每根柱子一个固定种子，四根纹理不同但各自可复现
 * @param jitter 调用方给的 [0,1) 随机数，只用来打散采样网格
 */
function surfaceRadiusFactor(v: number, angle: number, seed: number, jitter = 0.5): number {
  /* ① 截面不规则：低频（环向 2 个波 + 沿柱高缓变）—— 决定"整体不是正圆" */
  const irregular = LOG_IRREGULARITY * Math.sin(angle * 2 + seed * 0.7 + v * 1.1);
  /* ② 斧凿棱面：7 条宽棱，相位随高度漂 —— 手砍的痕迹 */
  const adze = -ADZE_FACETS * (0.5 + 0.5 * Math.cos(angle * 7 + v * 2.3 + seed));
  /* ③ 剥落残斑：噪声阈值 → 成片凹陷（阈值与深度都调过：太浅看不出来，太深像海绵） */
  const peelNoise = valueNoise2(angle * 1.9 + seed * 3.1, v * 3.4, seed);
  const peel = peelNoise > 0.66 ? -PEEL_DEPTH * ((peelNoise - 0.66) / 0.34) : 0;
  /* ④ 竖向皴纹：环向高频、轴向极慢 */
  const grain = GRAIN_RIPPLE * Math.sin(angle * 19 + v * 0.9 + seed * 1.7);
  /* 采样抖动 */
  const shake = SHELL_JITTER * (jitter * 2 - 1);
  const factor = 1 + irregular + adze + peel + grain + shake;
  return Math.min(1 + SHELL_MAX_WOBBLE, Math.max(SURFACE_MIN_FACTOR, factor));
}

/**
 * 一个缺陷"挖掉哪块木料"的几何描述（生成点云前先算出来）
 */
type CarveRegion =
  | {
      kind: "borer";
      cx: number;
      cy: number;
      cz: number;
      /**
       * 洞口**朝外**的方位角（弧度）。
       *
       * ⚠ 必须跟着构件上那个角度走：挖空判据与腔体几何都要用它把场景坐标
       * 换算成"朝外 / 竖直 / 切向"这套局部坐标。第一版没有它（把 +Z 当成朝外），
       * 于是腔体落在洞口方位之外的地方，整块被埋在柱身里 —— 屏幕上什么洞都看不见。
       */
      outAngle: number;
      /** 腔的深度（沿朝外方向往柱子里挖多少米） */
      depth: number;
      radius: number;
      wobble: number;
    }
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
    const dz = z - region.cz;
    /* 场景坐标 → 局部：`u` 朝外、`v` 竖直、`w` 切向 */
    const u = dx * Math.cos(region.outAngle) + dz * Math.sin(region.outAngle);
    const w = -dx * Math.sin(region.outAngle) + dz * Math.cos(region.outAngle);
    const v = y - region.cy;
    /*
      ⚠ 挖空在**深度方向**也要留够：原来只在 `u ≥ -depth × 0.08` 之外切掉，
      意思是"洞口平面再往里一点点就不再挖" —— 于是腔壁（想要一整口碗）只有最靠外
      一小圈合法，其余全被边界拒掉：实测下部那个洞只剩 1135 点（应有的六分之一），
      腔成了半拉。切在 `-depth × 0.8` 上：碗铺到哪、挖到哪，**洞口那一侧多余的部分**
      （`u > 0`，也就是会鼓出柱面的那半边）仍然被下面 `pushWall` 的 `u > 0` 拒掉。
    */
    if (u < -region.depth * 0.8) return false;
    /*
      腔的形状 = 一个从洞口往里收的旋转体：横向半径随深度先不变、后收，
      深度方向按 `u` 从 0 走到 `-depth`。多留一点余量（`wobble`），
      空腔边缘不该还有木料点，否则看起来像"里面塞了渣"。
    */
    const depthT = Math.min(1, Math.max(0, -u / Math.max(1e-6, region.depth)));
    const taper = Math.sqrt(Math.max(0, 1 - depthT * depthT * 0.55));
    const lateral = Math.hypot(w, v / 1.15);
    return lateral <= region.radius * taper * (1 + region.wobble * 0.3);
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

/**
 * 缺口面：从缺口中心往两边、往上逐渐收浅（`BITE_DEPTH` = 最深啃掉多少半径）。
 *
 * ⚠ 这个深度**同时决定缺口看不看得出来**：缺口在柱脚，屏幕上一共几十像素高，
 * 45% 时只剩一圈很浅的亮边，读起来像"高光"而不是"被磕掉一块"。
 * 55% 才够——柱脚明显缺一块，且断面朝外的那一片能露出来。
 */
export const BITE_DEPTH = 0.55;

function damageBite(region: Extract<CarveRegion, { kind: "damage" }>, offset: number, v: number): number {
  const edge = 1 - offset / region.halfSpan;
  const depth = 1 - v / Math.max(0.01, region.topV);
  return 1 - edge * depth * BITE_DEPTH;
}

/**
 * 这一屏的**取景方位角**（弧度）：与 `InternalPointCloudView` 的
 * `CAMERA_DIR = { x: 0.62, z: 0.78 }` 是同一个方向（`atan2(0.78, 0.62) ≈ 0.90`，
 * 而柱位在 ±2.2 的对角上，实际看过去约 0.73 —— 两者都落在这一带）。
 *
 * ⚠ 缺陷的方位角**必须按它来放**（用户口径 2026-10-01：「木柱点云做到能看到里面的空洞」）：
 * 原来虫蛀朝 0.6、裂痕朝 1.2、柱脚缺损朝 0.35，而相机在 0.73 ——
 * 于是只有虫蛀正对镜头（实测对比度 27%、暗区 62%），**裂痕与缺损都在侧后方**，
 * 量出来"中心与周围一样亮"（对比 -1% 与 3%）。
 * 档案与风险记录只说到"上部/下部响应区"，没有角度标定，角度本来就是布置参数；
 * 既然要"看得见"，就摆在看得见的那一面。
 */
const CAMERA_FACING_ANGLE = 0.73;

/** 把缺陷配方翻译成挖空区（几何只算一次，后面壳/体/缺陷面都用它） */
function carveRegionOf(spec: ColumnSpec, recipe: DefectRecipe): CarveRegion {
  if (recipe.kind === "borer") {
    const centerY = spec.baseY + recipe.at.v * spec.heightM;
    /*
      `at.u` 是"这一处缺陷在柱子的哪个方位"：正负号决定左右半圈，绝对值给个偏移量。
      （档案与风险记录只说到"上部/下部响应区"，没有角度标定，所以左右是布置参数。）
      两个洞一左一右各偏 `BORER_SPREAD`，不要完全重叠在一根母线上。
    */
    const BORER_SPREAD = 0.26;
    const centerAngle = recipe.at.u >= 0 ? CAMERA_FACING_ANGLE + BORER_SPREAD : CAMERA_FACING_ANGLE - BORER_SPREAD;
    /*
      ⚠ 洞口的**中心放在柱面上**（`0.97 × 半径`），不是按 `u` 往里缩：
      第一版把中心按 `u × 半径 × 0.8` 往轴心挪，腔体于是埋在木料里 ——
      屏幕上既看不到洞，也看不到被挖掉的木料。
      放在柱面上之后，"往里挖 `depth`"才真的从表面开始。
    */
    const r = spec.radiusM * 0.97;
    return {
      kind: "borer",
      cx: spec.x + Math.cos(centerAngle) * r,
      cy: centerY,
      cz: spec.z + Math.sin(centerAngle) * r,
      outAngle: centerAngle,
      depth: recipe.at.radius * 1.35,
      radius: recipe.at.radius,
      wobble: recipe.at.wobble,
    };
  }
  if (recipe.kind === "crack") {
    /*
      ── 缝的几何为什么要算过才敢定（2026-10 加密点云时暴露）──────────────
      裂痕是一张**平的叶片**（法线取该角度的切向），不是跟着柱面弯的曲面。
      `outerR` 只管**中线**：沿缝走到两端时，点离轴线的距离比中线更远
      （叶片上的点在角向上按 `√(radial² + 切向²)` 换算，而切向又含
      `along·sin(tilt)` 这一项）。实测旧参数（outerR=0.99r、缝长 1.3r）下，
      缝端半径到 **1.105r** —— 已经探到柱面外了，只是当时"所有点在圆柱内"
      的容差写着 12%，把它盖住了；点云加密、判据收紧之后它才浮出来。

      现在按"缝端也不出柱面"反解（都要 ≤ 1.075r，见单测的缺陷面限值）：
        · 半长 `half = length · r · 0.5`（length ≤ 0.72 ⇒ half ≤ 0.36r）
        · 端部角向偏移 h = half·sin(tilt) ≤ 0.36r·0.31 = 0.112r
        · 缝端半径 = √(outerR² + h²) + thickness/2
        · outerR = 0.9r、thickness = 0.06r ⇒ √(0.81+h²) + 0.03 ≤ 1.0r ✓
    */
    return {
      kind: "crack",
      /* 缝的位置与柱脚缺损都朝**相机那一面**（见 `CAMERA_FACING_ANGLE`）：摆在侧后方就看不见 */
      angle: CAMERA_FACING_ANGLE + 0.12,
      centerY: spec.baseY + recipe.at.v * spec.heightM,
      halfLength: recipe.at.length * spec.radiusM * 0.5,
      innerR: spec.radiusM * 0.3,
      outerR: spec.radiusM * 0.9,
      thickness: spec.radiusM * 0.06,
      tilt: (recipe.at.tiltDeg * Math.PI) / 180,
    };
  }
  return {
    kind: "damage",
    centerAngle: CAMERA_FACING_ANGLE,
    /*
      ⚠ 角向跨度要**收窄**（96° → 60°，配方里的 `spanDeg` 不动、这里乘 0.62）：
      96° 摊在 360 mm 的柱子上是 30 cm 宽的一大片，`damageBite` 又让它从中心往两边
      逐渐收浅 —— 屏幕上读成"柱脚整片发暗"，而不是"磕掉一块"。
      收窄之后缺口是个明确的坑，断面（浅色新断口）才有地方亮出来。
    */
    halfSpan: ((recipe.at.spanDeg * Math.PI) / 180 / 2) * 0.62,
    topV: recipe.at.v + recipe.at.depth * 0.35,
  };
}

/**
 * 外表壳：柱面 + 两端封口（柱脚看得见"是一个圆柱"），缺陷处的壳点同样被剔掉。
 *
 * ── 轮廓精度（用户两轮口径：「更精细」→「外观保证单根那根」）──────────
 * 每一层的点数**固定**为 `SHELL_RINGS`（旧版按 `sin` 收放，柱腰最密、两端最疏，
 * 于是柱脚柱顶两段轮廓更"棱"），再叠环向相位抖动，避免相邻层叠成竖条纹。
 *
 * 半径起伏**全部**走 `surfaceRadiusFactor()`（扫描质感四层），
 * 所以 `SHELL_MAX_WOBBLE` / `SURFACE_MIN_FACTOR` 是可断言的上/下界（见单测）。
 */
/** 柱坐标里的一个采样点（`radiusFactor` 已含表面的起伏与抖动） */
type SurfaceSample = { angle: number; v: number; factor: number };

/**
 * 柱面上某点的**外法向**（解析 + 有限差分，单位向量）。
 *
 * 高斯泼溅里每个高斯是一个**有朝向的椭球**，朝向不对就退化成一团圆点 ——
 * 柱子看起来"毛毛的、一颗颗小球"就是这么来的。
 * 柱面的法向没有闭式解（半径是四层噪声叠出来的），所以用两个切向量叉乘：
 *   · T_v：沿柱高方向（对 `v` 求偏导）
 *   · T_θ：沿环向（对 `angle` 求偏导）
 * 差分步长取"点距量级"（高度 1.5 mm / 环向 0.4 mm 的角增量）：
 * 步长太大会把噪声抹平（法向偏差方向），太小会被逐点抖动主导（法向乱跳）。
 */
function surfaceNormalAt(spec: ColumnSpec, seed: number, angle: number, v: number): [number, number, number] {
  const dv = 0.0015 / Math.max(0.001, spec.heightM);
  const dTheta = 0.0004 / Math.max(0.001, spec.radiusM);
  const r0 = surfaceRadiusFactor(v, angle, seed, 0.5);
  const rv = surfaceRadiusFactor(Math.min(1, v + dv), angle, seed, 0.5);
  const rt = surfaceRadiusFactor(v, angle + dTheta, seed, 0.5);
  const rr = spec.radiusM;
  /* 位置对两个参数的偏导（柱坐标 → 场景坐标） */
  const pv: [number, number, number] = [
    Math.cos(angle) * rr * (rv - r0),
    dv * spec.heightM,
    Math.sin(angle) * rr * (rv - r0),
  ];
  const pt: [number, number, number] = [-Math.sin(angle) * rr * rt * dTheta, 0, Math.cos(angle) * rr * rt * dTheta];
  const normal: [number, number, number] = [
    pt[1] * pv[2] - pt[2] * pv[1],
    pt[2] * pv[0] - pt[0] * pv[2],
    pt[0] * pv[1] - pt[1] * pv[0],
  ];
  const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  /* 取成朝外（径向分量为正），否则一半的高斯会翻到柱子里 */
  const outward = normal[0] * Math.cos(angle) + normal[2] * Math.sin(angle);
  const sign = outward >= 0 ? 1 : -1;
  return [(normal[0] * sign) / length, (normal[1] * sign) / length, (normal[2] * sign) / length];
}

/**
 * 外表壳：柱面 + 两端封口（柱脚看得见"是一个圆柱"），缺陷处的壳点同样被剔掉。
 *
 * ── 轮廓精度（用户两轮口径：「更精细」→「外观保证单根那根」）──────────
 * 每一层的点数**固定**为 `SHELL_RINGS`（旧版按 `sin` 收放，柱腰最密、两端最疏，
 * 于是柱脚柱顶两段轮廓更"棱"），再叠环向相位抖动，避免相邻层叠成竖条纹。
 *
 * 半径起伏**全部**走 `surfaceRadiusFactor()`（扫描质感四层），
 * 所以 `SHELL_MAX_WOBBLE` / `SURFACE_MIN_FACTOR` 是可断言的上/下界（见单测）。
 *
 * ⚠ 采样结果**不在这里展平成坐标数组**：外壳要的是"每个点的位置 + 法向 + 尺度"
 * （真高斯泼溅），所以这里只出柱坐标，由 `buildSplatCloud` 统一转场景坐标、
 * 顺手算逐点法向与各向异性尺度。点在场景坐标里算是为了缺陷剔除（`isCarved` 吃场景坐标）。
 */
function buildShell(
  spec: ColumnSpec,
  regions: readonly CarveRegion[],
  random: () => number,
  burrows: BurrowNetwork,
): SurfaceSample[] {
  const samples: SurfaceSample[] = [];
  const seed = columnSeed(spec);
  const keep = (x: number, y: number, z: number) => {
    /* 剖切：朝相机那一面的一段扇形不生成壳点（见 `CUTAWAY_SPAN` 的说明） */
    if (activeCutaway && inCutaway(Math.atan2(z - spec.z, x - spec.x))) return false;
    return (
      !regions.some((region) => isCarved(region, spec, x, y, z)) &&
      !inHollow(spec, x, y, z) &&
      /*
        虫道走到柱面的地方要**开口**：不剔掉的话，屏幕上柱身完好、
        虫道全埋在木头里看不见（用户口径：「根本看不出内部问题」就是这么来的）。
        剔掉之后柱身上多出几个孔，与 `buildHollowWalls` 里那圈道口沿正好对上。
      */
      !inBurrow(burrows.segments, x, y, z)
    );
  };
  for (let level = 0; level < SHELL_LEVELS; level += 1) {
    const vBase = level / (SHELL_LEVELS - 1);
    /* 每层的起点相位错开半格：相邻层不叠成竖条纹 */
    const phase = (level % 3) * ((Math.PI * 2) / (SHELL_RINGS * 3));
    for (let ring = 0; ring < SHELL_RINGS; ring += 1) {
      const angle = (ring / SHELL_RINGS) * Math.PI * 2 + phase;
      /* 轴向抖 ±1/3 层距（见 SHELL_AXIAL_JITTER）：打破规则层，消掉横向环纹 */
      const v = Math.min(1, Math.max(0, vBase + SHELL_AXIAL_JITTER * (random() * 2 - 1)));
      const factor = surfaceRadiusFactor(v, angle, seed, random());
      const [x, y, z] = columnPoint(spec, angle, v, factor);
      if (keep(x, y, z)) samples.push({ angle, v, factor });
    }
  }
  /*
    柱脚 / 柱顶封口：两端不该是空的。封口也按同一套表面系数收边，柱脚才"接得上"柱身。
    ⚠ 柱顶那一片在**空腔范围内不画**（`keep` 里的 `inHollow`）——
    不开口的话从上面看是个盖着的圆盘，"中空"只能在侧面靠阴影猜；
    开了口才能真的看进去（用户口径：「能看到内部中空啊」）。
  */
  const capRings = 26;
  for (const v of [0, 1]) {
    for (let ring = 0; ring < capRings; ring += 1) {
      for (let step = 0; step < capRings; step += 1) {
        const radiusFactor = (step + 0.5) / capRings;
        const angle = (ring / capRings) * Math.PI * 2;
        const edge = surfaceRadiusFactor(v, angle, seed, 0.5);
        const factor = radiusFactor * edge * 0.995;
        const [x, y, z] = columnPoint(spec, angle, v, factor);
        if (keep(x, y, z)) samples.push({ angle, v, factor });
      }
    }
  }
  return samples;
}

/* ------------------------------------------------------------------ *
 * 剖切（用户口径 2026-10-02：「根本看不出内部问题」）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 柱子是一根实心外皮 + 内部空腔。**角度对了**才看得见腔与虫道；
 * 默认机位是斜前方，柱子正面朝相机那一面全是外皮 —— 屏幕上一根完好的木柱，
 * 内部有没有虫蛀、空到什么程度，从外面根本读不出来。
 *
 * ── 怎么剖 ──────────────────────────────────────────────────────────
 * 把**朝相机那一面**的一段扇形（`CUTAWAY_SPAN` 弧度、以 `CAMERA_FACING_ANGLE`
 * 为中心）的外壳与内部木料都收掉，露出腔壁与虫道。剖切是**生成期**做的
 * （与挖空同一套：点不生成就没有），不在渲染期裁 —— 渲染期裁要么动着色器、
 * 要么靠裁剪面，都要动到 `@sparkjsdev/spark` 的内部。
 *
 * ⚠ 剖切只影响**木料两层**（壳 + 体）：腔壁、虫道内壁、缺陷面照画 ——
 * 它们正是要给人看的东西。
 * ------------------------------------------------------------------ */

/** 剖切扇形的张角（弧度，约 132°）—— 太窄看不进去，太宽柱子就不像柱子了 */
export const CUTAWAY_SPAN = 2.3;

/** 当前这次构建是否剖切（由 `buildInternalCloud` 按参数设置，生成期读它） */
let activeCutaway = false;
export function setCutaway(on: boolean): void {
  activeCutaway = on;
}
export function cutawayEnabled(): boolean {
  return activeCutaway;
}

/** 这个方位角是否落在剖切扇形里（朝相机那一面） */
export function inCutaway(angle: number): boolean {
  if (!activeCutaway) return false;
  const diff = Math.abs(((angle - CAMERA_FACING_ANGLE + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  return diff <= CUTAWAY_SPAN / 2;
}

/** 内部木料：按体积均匀填点（"木柱内部都是点云"）。
 *
 * 采样方式：柱坐标里对半径取 `sqrt(u)`（保证面积均匀、不是往圆心堆），
 * 高度均匀；点落在挖空区里就丢掉 —— 于是虫蛀/裂痕/破损在点云里就是**空白**。
 *
 * ⚠ 半径上再叠一点抖动（`VOLUME_JITTER`）：纯均匀撒点在近看时能看出**同心层**，
 * 加密之后这层"格子感"反而更显眼。抖动只在小尺度上打散位置，
 * 不改变"实心填满"这个性质（单测的体密度判据仍然成立）。
 */
function buildVolume(
  spec: ColumnSpec,
  regions: readonly CarveRegion[],
  random: () => number,
  burrows: BurrowNetwork,
): Float32Array {
  const volumeM3 = Math.PI * spec.radiusM * spec.radiusM * spec.heightM;
  const want = Math.min(VOLUME_MAX_POINTS, Math.round(volumeM3 * VOLUME_POINTS_PER_M3));
  const points: number[] = [];
  /*
    ⚠ 内部点收在 `VOLUME_RADIUS_LIMIT` 以内，不再填到标称柱面：
    柱面现在是"扫描质感"（最深可凹到 0.82r），木料填到标称半径就会**从凹面里戳出来**。
    收在 0.96r 是"任何一处表面之下都还有木料"的稳妥上界 ——
    代价是凹处表面与内部之间留了几毫米空档，但那一层本来就是壳点负责的。
  */
  const limit = VOLUME_RADIUS_LIMIT;
  /* 挖空率高时（例如柱脚被啃掉一块）要多采一些才能填满剩余体积 */
  let attempt = 0;
  const maxAttempts = want * 3;
  while (points.length / 3 < want && attempt < maxAttempts) {
    attempt += 1;
    const angle = random() * Math.PI * 2;
    const v = random();
    const radiusFactor = Math.sqrt(random()) * limit * (1 + VOLUME_JITTER * (random() * 2 - 1));
    const [x, y, z] = columnPoint(spec, angle, v, radiusFactor);
    if (regions.some((region) => isCarved(region, spec, x, y, z))) continue;
    if (inHollow(spec, x, y, z)) continue;
    /* 虫道里也没有木料（这是"内部有孔洞"在体点云里的落点） */
    if (inBurrow(burrows.segments, x, y, z)) continue;
    /* 剖切：朝相机那一面的扇形里不留木料，让腔与虫道露出来 */
    if (activeCutaway && inCutaway(Math.atan2(z - spec.z, x - spec.x))) continue;
    points.push(x, y, z);
  }
  return new Float32Array(points);
}

/**
 * 中空腔的**内壁 + 腔底 + 虫道内壁**（用户口径：「能看到内部中空啊」→
 * 2026-10-02：「根本看不出内部问题，内部得有虫蛀之类的孔洞」）。
 *
 * 为什么必须有：把体点挖空之后，从柱顶看进去是**穿透到背景的空洞** ——
 * 那不是"中空"，那是"没有模型"。真实的空心木柱里壁是**看得见的木料断面**
 * （有时还带腐朽的深色），腔底也是实的。所以这一层三步：
 *   · **内壁**：沿柱高从 `HOLLOW_BOTTOM_V` 到 `HOLLOW_TOP_V`，半径 = 名义腔径 ×
 *     `hollowRadiusFactor()`（**不规则**：低频鼓包 + 中频龛洞 + 高频麻点），
 *     法向朝**内**（这层唯一的区别：壳的高斯朝外，腔壁的朝里）；
 *   · **腔底**：`HOLLOW_BOTTOM_V` 处的一片圆盘，朝向**上**；
 *   · **虫道内壁 + 孔口**：按 `burrows` 把每条虫道画成管状内壁，
 *     并在道口（柱面上那个孔）铺一圈**压暗的沿口** —— 屏幕上就是"柱身上有虫眼"。
 * 颜色：越深越暗（与 `occlusionAt` 同一套"光进不去"的道理）。
 */
function buildHollowWalls(
  spec: ColumnSpec,
  burrows: BurrowNetwork,
): { points: Float32Array; normals: Float32Array; colors: Float32Array } {
  const points: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const seed = columnSeed(spec);
  const radius = spec.radiusM * HOLLOW_RADIUS_RATIO;
  const levels = Math.max(8, Math.round((HOLLOW_TOP_V - HOLLOW_BOTTOM_V) * SHELL_LEVELS));
  /** 腔壁的底色：比外皮暗一档（里面本来就照不到光），仍属同一个木色系 */
  const wallBase: [number, number, number] = [0.46, 0.32, 0.2];
  const floorBase: [number, number, number] = [0.2, 0.13, 0.08];
  /*
    虫道壁的颜色：比空腔壁**更暗**（虫道更窄、光更进不去），
    但道口那一圈要给一点点浅色（新鲜啃痕），否则整片黑读不出"这里有个眼"。
  */
  const burrowWallBase: [number, number, number] = [0.27, 0.185, 0.12];
  const burrowRimBase: [number, number, number] = [0.4, 0.28, 0.18];

  for (let level = 0; level < levels; level += 1) {
    const t = level / (levels - 1);
    const v = HOLLOW_BOTTOM_V + (HOLLOW_TOP_V - HOLLOW_BOTTOM_V) * t;
    for (let ring = 0; ring < SHELL_RINGS; ring += 1) {
      const angle = (ring / SHELL_RINGS) * Math.PI * 2;
      const factor = hollowRadiusFactor(spec, angle, v);
      const [x, y, z] = columnPoint(spec, angle, v, (radius * factor) / spec.radiusM);
      /*
        虫道经过的地方，腔壁点不该还铺在那儿（那是"道壁上又糊了一层腔壁"）——
        跳过落在虫道里的点，腔壁自然被虫道**咬出缺口**，读成"壁上被钻进去一条道"。
      */
      if (inBurrow(burrows.segments, x, y, z)) continue;
      points.push(x, y, z);
      /* 法向朝**内**：腔壁的高斯要贴在壁上、朝柱心 */
      normals.push(-Math.cos(angle), 0, -Math.sin(angle));
      /* 越深越暗：洞口（柱顶/剖口）一侧是能看到木料断面的亮档，腔底最暗 */
      const depth = 1 - t;
      const shade = 0.95 - 0.42 * depth;
      const tinted = applyWoodTone([wallBase[0] * shade, wallBase[1] * shade, wallBase[2] * shade]);
      colors.push(tinted[0], tinted[1], tinted[2]);
    }
  }
  /* 腔底：一小片朝上的圆盘（半径收 0.95，免得与壁面互相穿插） */
  const floorRings = 24;
  for (let ring = 0; ring < floorRings; ring += 1) {
    for (let step = 0; step < floorRings; step += 1) {
      const rr = ((step + 0.5) / floorRings) * radius * 0.95;
      const angle = (ring / floorRings) * Math.PI * 2;
      const y = spec.baseY + spec.heightM * HOLLOW_BOTTOM_V;
      const rough = (valueNoise2(step * 0.7, ring * 0.9, seed + 311) - 0.5) * 0.012;
      points.push(spec.x + Math.cos(angle) * rr, y + rough, spec.z + Math.sin(angle) * rr);
      normals.push(0, 1, 0);
      colors.push(floorBase[0], floorBase[1], floorBase[2]);
    }
  }

  /* ---------------- 虫道内壁 + 道口沿 ----------------
     每条虫道画成一根**管子的内壁**（法向朝轴心），颜色比腔壁更暗；
     道口那一圈（柱面上的孔）铺一层略浅的压暗沿口 —— 屏幕上读成"虫眼"。 */
  const tubeRings = 18;
  for (const segment of burrows.segments) {
    const ax = segment.x1 - segment.x0;
    const ay = segment.y1 - segment.y0;
    const az = segment.z1 - segment.z0;
    const length = Math.hypot(ax, ay, az) || 1e-6;
    const ux = ax / length;
    const uy = ay / length;
    const uz = az / length;
    /* 管轴的两个正交基 */
    const helper = Math.abs(uy) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let tx = uy * helper[2] - uz * helper[1];
    let ty = uz * helper[0] - ux * helper[2];
    let tz = ux * helper[1] - uy * helper[0];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const bx = uy * tz - uz * ty;
    const by = uz * tx - ux * tz;
    const bz = ux * ty - uy * tx;
    const steps = Math.max(6, Math.round(length / (segment.radius * 0.7)));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const cx = segment.x0 + ax * t;
      const cy = segment.y0 + ay * t;
      const cz = segment.z0 + az * t;
      /* 半径忽粗忽细：蛀道不是等径管 */
      const wobble = 1 + (valueNoise2(t * 6, s * 0.3, seed + 733) - 0.5) * 0.5;
      const r = segment.radius * wobble;
      for (let ring = 0; ring < tubeRings; ring += 1) {
        const angle = (ring / tubeRings) * Math.PI * 2 + s * 0.7;
        const ox = Math.cos(angle) * tx + Math.sin(angle) * bx;
        const oy = Math.cos(angle) * ty + Math.sin(angle) * by;
        const oz = Math.cos(angle) * tz + Math.sin(angle) * bz;
        const px = cx + ox * r;
        const py = cy + oy * r;
        const pz = cz + oz * r;
        /* 只画柱体以内、且落在空腔/虫道空间里的那部分壁（越界的点会飘在柱面外） */
        const radial = Math.hypot(px - spec.x, pz - spec.z);
        if (radial > spec.radiusM * 0.995) continue;
        points.push(px, py, pz);
        /* 法向朝**轴心**（管子的内壁） */
        normals.push(-ox, -oy, -oz);
        const depth = 1 - Math.abs(t - 0.5) * 2;
        const shade = 0.82 + 0.18 * depth;
        const tinted = applyWoodTone([
          burrowWallBase[0] * shade,
          burrowWallBase[1] * shade,
          burrowWallBase[2] * shade,
        ]);
        colors.push(tinted[0], tinted[1], tinted[2]);
      }
    }
  }
  /* 道口沿：柱面上那几个孔的一圈（略浅，让"眼"的边缘看得出来） */
  for (const mouth of burrows.mouths) {
    /*
      ⚠ 沿口要铺**三圈**（内 / 中 / 外）：一圈太细，在这根柱子的采样密度下
      只有十几个点，屏幕上根本看不出"这里有个眼"。三圈 + 每圈按孔口半径给点数，
      孔口读起来才是"一个被虫钻出来的圆眼"（用户口径：看不出内部问题）。
    */
    const ringSteps = Math.max(10, Math.round((mouth.radius / spec.radiusM) * SHELL_RINGS * 0.55));
    for (const [bandIndex, bandScale] of [0.72, 1, 1.28].entries()) {
      const rimColor: [number, number, number] = [
        burrowRimBase[0] * (bandIndex === 1 ? 0.82 : 1),
        burrowRimBase[1] * (bandIndex === 1 ? 0.82 : 1),
        burrowRimBase[2] * (bandIndex === 1 ? 0.82 : 1),
      ];
      for (let i = 0; i < ringSteps; i += 1) {
        const angle = (i / ringSteps) * Math.PI * 2 + bandIndex * 0.3;
        const tangential = -mouth.nz;
        const px = mouth.x + Math.cos(angle) * tangential * mouth.radius * bandScale;
        const pz = mouth.z + Math.cos(angle) * mouth.nx * mouth.radius * bandScale;
        const py = mouth.y + Math.sin(angle) * mouth.radius * bandScale;
        const radial = Math.hypot(px - spec.x, pz - spec.z);
        if (radial > spec.radiusM * 0.995) continue;
        points.push(px, py, pz);
        normals.push(mouth.nx, 0, mouth.nz);
        const tinted = applyWoodTone(rimColor);
        colors.push(tinted[0], tinted[1], tinted[2]);
      }
    }
  }
  return { points: new Float32Array(points), normals: new Float32Array(normals), colors: new Float32Array(colors) };
}

/* ---- 缺陷的三种真实形态（用户口径 2026-10-01：「内部缺陷也得真实点」）--------
 *
 * 旧版三处都"太粗糙"的根子：
 *   · 虫蛀腔壁是**球面随机撒点**，且空腔内部也撒 → 读起来是一团彩色噪点而不是洞；
 *   · 裂痕是**两片平板**，均匀撒点 → 读起来是一块贴片；
 *   · 破损面是**平板扇面** → 读起来是一张贴纸。
 * 共同点是"形状没有层次、颜色没有明暗"。下面按真东西的形态重做，
 * 并各自给出**逐点颜色**（缺陷不再靠材质给一个平涂色）。
 */

/** 缺陷点在腔内的**深度比**（0 = 洞口/表面，1 = 最深处）：颜色靠它压暗，读出"往里凹" */
function darken(color: [number, number, number], depth: number, amount: number): [number, number, number] {
  const k = 1 - amount * Math.min(1, Math.max(0, depth));
  return [color[0] * k, color[1] * k, color[2] * k];
}

/* ------------------------------------------------------------------ *
 * 层次：接触阴影（环境光遮蔽）与木质色相偏移
 *
 * 用户口径（2026-10-01）：「外壳像高斯泼溅的，内部缺陷也得真实点，现在的实在是太粗糙了」。
 * 到这一步几何已经对了（洞是洞、缝是缝），差的是**层次**：
 *   · 单色点云 + 一处压暗 = 像塑料模型；真实的木柱在洞口内部、柱脚与破损附近
 *     是**越往里越暗**的（光进不去），这一层叫接触阴影（AO）；
 *   · 木料的暗部**偏冷**（偏灰蓝）、亮部**偏暖**（偏橙）—— 这是木头与"上色的塑料"
 *     在观感上最大的差别之一（见 `applyWoodTone`）。
 * 两样都只作用在**颜色**上，不改几何：位置/法向/尺度一个都没动。
 * ------------------------------------------------------------------ */

/**
 * 邻近挖空区造成的**遮蔽系数**（1 = 完全受光，越小越暗）。
 *
 * 为什么在生成阶段算、而不是渲染阶段：这是**几何事实**（这个点离空腔口多远、
 * 多深），生成阶段一次算完、烘进逐点颜色，运行时零成本；
 * 渲染阶段算要么得读深度缓冲（Spark 的高斯没有常规深度），要么得做屏幕空间 AO。
 *
 * ⚠ 必须**排除自己那个缺陷**：缺陷的腔壁/断面本来就贴着它自己的挖空区，
 * 不排除的话它们会被自己遮成一片黑（本轮实现时就撞上了）。
 */
function occlusionAt(
  regions: readonly CarveRegion[],
  spec: ColumnSpec,
  x: number,
  y: number,
  z: number,
  skip?: CarveRegion,
): number {
  const radial = Math.hypot(x - spec.x, z - spec.z) || 1;
  let dark = 0;
  for (const region of regions) {
    if (region === skip) continue;
    if (region.kind === "borer") {
      /* 洞口在其局部 `u ≥ 0` 那一侧是敞开的，只有**里面**才暗 */
      const dx = x - region.cx;
      const dy = y - region.cy;
      const dz = z - region.cz;
      const u = dx * Math.cos(region.outAngle) + dz * Math.sin(region.outAngle);
      if (u > 0.02) continue;
      const near = Math.hypot(u, dy / 1.15, -dx * Math.sin(region.outAngle) + dz * Math.cos(region.outAngle));
      if (near > region.radius * 1.9) continue;
      dark = Math.max(dark, 0.85 * Math.max(0, 1 - near / (region.radius * 1.9)));
      continue;
    }
    if (region.kind === "crack") {
      const dy = Math.abs(y - region.centerY);
      if (dy > region.halfLength * 1.25 + region.thickness) continue;
      if (radial < region.innerR - region.thickness || radial > region.outerR + region.thickness) continue;
      /* 缝口与缝内都属于"光进不去"：按到缝中面的距离压暗 */
      dark = Math.max(dark, 0.5);
      continue;
    }
    /* 破损：缺口里与缺口边缘的木料被周围挡住 */
    const angle = Math.atan2(z - spec.z, x - spec.x);
    const offset = Math.abs(((angle - region.centerAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (offset > region.halfSpan * 1.1) continue;
    const v = (y - spec.baseY) / Math.max(1e-6, spec.heightM);
    if (v < 0 || v > region.topV * 1.15) continue;
    const bite = damageBite(region, Math.min(offset, region.halfSpan), Math.min(v, region.topV));
    const edge = Math.max(0, radial - spec.radiusM * bite);
    dark = Math.max(dark, 0.6 * Math.max(0, 1 - edge / 0.1));
  }
  return 1 - dark;
}

/**
 * 木质色相偏移：暗部偏冷、亮部偏暖。
 *
 * 真实木料的反射是**有色的**：纤维深处的多次反射带走暖色，于是暗部偏灰蓝；
 * 受光面则偏橙。程序化木头最容易"像塑料"的地方就在这里 ——
 * 单靠明度变化（同一色相乘一个系数）永远像一个灰模上了色。
 */
const WOOD_SHADOW_TINT: [number, number, number] = [0.88, 0.97, 1.12];
const WOOD_LIGHT_TINT: [number, number, number] = [1.07, 1.0, 0.9];

function applyWoodTone(color: [number, number, number]): [number, number, number] {
  const lum = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  const t = Math.min(1, Math.max(0, lum / 0.5));
  return [
    color[0] * (WOOD_SHADOW_TINT[0] + (WOOD_LIGHT_TINT[0] - WOOD_SHADOW_TINT[0]) * t),
    color[1] * (WOOD_SHADOW_TINT[1] + (WOOD_LIGHT_TINT[1] - WOOD_SHADOW_TINT[1]) * t),
    color[2] * (WOOD_SHADOW_TINT[2] + (WOOD_LIGHT_TINT[2] - WOOD_SHADOW_TINT[2]) * t),
  ];
}

/**
 * 虫蛀空洞：一个**入口收窄、往里扩大**的腔（真实蠹虫坑道就是这种"口小肚大"）。
 *
 * ── 坐标系（第一版就栽在这儿）────────────────────────────────────
 * 洞的"朝外"必须跟着构件上那个方位角走，不能在场景坐标里当成固定的 +Z：
 * 第一版把 `region.cz - 半径` 当作"往柱子里挖"，而挖空判据（`isCarved`）用的是
 * 该缺陷角度上的径向 —— 于是腔体根本没在洞口那一侧，整块被埋在柱身里看不见。
 * 所以这里先在**局部坐标系**里造腔（`u` 朝外、`v` 竖直、`w` 切向），最后旋回场景坐标。
 *
 * ── 三层结构（这就是"真实"的来源）────────────────────────────────
 *   ① **洞口环缘**：半径略大于腔口、颜色偏亮（被啃断的木纤维翻在洞口）；
 *   ② **腔壁**：只在**朝外的那半边**撒点 —— 空腔内部没有点，透过去看到更深的木料，
 *      于是读成"一个洞"而不是一团色斑；
 *   ③ **洞底**：腔最深处收一个小盘，颜色压到最暗。
 * 颜色按深度压暗（0 = 洞口、1 = 最深处），洞才有"往里凹"的立体感。
 */
function buildBorer(
  spec: ColumnSpec,
  region: Extract<CarveRegion, { kind: "borer" }>,
  random: () => number,
): { points: Float32Array; colors: Float32Array; scales: Float32Array; normals: Float32Array } {
  const points: number[] = [];
  const colors: number[] = [];
  const scales: number[] = [];
  const normals: number[] = [];
  /**
   * 洞口沿的颜色 = **暗**（不是亮）。
   *
   * ⚠ 这一对颜色本轮调反过一次：原来沿口给亮色（"断口纤维"），
   * 于是屏幕上读成"亮环 + 暗心"，像一个鼓包而不是一个洞。
   * 真实的洞口是**光照不到的那一圈**：沿口最暗（就是看到的"洞"），
   * 越往里越是新断口的浅色木料（有漫反射进来），洞底再暗回去。
   */
  const rimColor: [number, number, number] = [0.34, 0.24, 0.15];
  /** 洞内壁：新断口的木料偏浅（这是"这里被啃开了"的物证之一） */
  const wallColor: [number, number, number] = [0.62, 0.46, 0.29];
  /** 洞底：光进不去，最暗，但**不是纯黑**（纯黑在点云里像渲染 bug） */
  const floorColor: [number, number, number] = [0.26, 0.18, 0.11];
  const push = (    u: number,
    v: number,
    w: number,
    color: [number, number, number],
    scale: [number, number, number],
  ) => {
    /* 局部 (朝外, 竖直, 切向) → 场景坐标 */
    points.push(
      region.cx + Math.cos(region.outAngle) * u - Math.sin(region.outAngle) * w,
      region.cy + v,
      region.cz + Math.sin(region.outAngle) * u + Math.cos(region.outAngle) * w,
    );
    colors.push(color[0], color[1], color[2]);
    scales.push(scale[0], scale[1], scale[2]);
    normals.push(Math.cos(region.outAngle), 0, Math.sin(region.outAngle));
  };

  /**
   * 洞口环缘（①）与腔壁（②）都只能铺在**朝外的那半边**。
   *
   * ⚠ 为什么（本轮实测的错）：先前按"以洞心为圆心的整圈"铺，
   * 于是"朝柱心那一侧"的点被铺到了 `u > 0`（洞口平面**之外**）——
   * 它们的径向距离比柱面还大，等于在洞旁边鼓出一圈，屏幕上就是一个亮环套一个暗点。
   * 真实的口子只挖掉了朝外那半边，所以壁也只在朝外那半边存在。
   *
   * ⚠ 但**不能收得太死**（第二版就收死了）：口径细的柱子上，洞深 12–14 cm 已经越过柱轴，
   * 腔底那几圈点的径向分量会变成正数 —— 一刀切掉之后最深只到 0.145 m（洞口 0.175 m），
   * "口小肚大"的腔变成了一个浅坑。所以放宽到 `radius × 0.25`，
   * 且这一层只在"洞口**内侧**"这个前提下放松（`u` 必须还是负的），不会在柱面上鼓出唇边。
   */
  const pushWall = (
    u: number,
    v: number,
    w: number,
    color: [number, number, number],
    scale: [number, number, number],
    onSurface = false,
  ) => {
    if (u > 0) return;
    const radial = u * Math.cos(region.outAngle) + w * Math.sin(region.outAngle);
    if (radial > radius * 0.25) return;
    if (!onSurface) {
      push(u, v, w, color, scale);
      return;
    }
    /*
      ⚠ 洞口那一圈必须**贴到柱面上**（`onSurface`）：
      洞口是个**平面圆**，而柱面是**弯的** —— 直接把这一圈铺在平面上，
      切向走到边缘的点就会鼓到柱面之外（实测径向 0.199 > 柱面 0.180），
      屏幕上是一圈凸唇，判据上又是"点云飘在空中"。
      做法：先把局部坐标换成场景坐标，再**绕柱轴按比例缩放**（比例 = 柱面半径 / 当前径向），
      点就落到柱面上；高度不动。
    */
    const cosA = Math.cos(region.outAngle);
    const sinA = Math.sin(region.outAngle);
    const sx = region.cx + cosA * u - sinA * w;
    const sz = region.cz + sinA * u + cosA * w;
    const r = Math.hypot(sx - spec.x, sz - spec.z) || 1;
    const k = (spec.radiusM * 0.995) / r;
    const nx = spec.x + (sx - spec.x) * k;
    const nz = spec.z + (sz - spec.z) * k;
    /* 场景坐标 → 局部（`v` 不变），再交给 `push` 统一转回去 */
    const dx = nx - region.cx;
    const dz = nz - region.cz;
    push(
      dx * cosA + dz * sinA,
      v,
      -dx * sinA + dz * cosA,
      color,
      scale,
    );
  };

  const radius = region.radius;
  const depth = region.depth;
  const step = radius / 10;
  /**
   * ⚠ 腔壁的横向范围也要**封在柱子里**（`radius × 1.15` 那条边界之外的点会被判成"飘在空中"）。
   *
   * 口径 360 mm、洞口半径 110 mm 时，"口小肚大"的腔按公式最宽处能到 1.05R —— 看着没问题，
   * 但 `isCarved` 的挖空边界是 `radius · taper · (1 + wobble × 0.3)`，
   * 壁铺得比挖空边界还靠外时，那些点就落在**没被挖掉**的柱壳后面，
   * 结果是"洞里有木料"（判据红）+ 壁被柱面挡掉（白铺）。
   * 所以壁的横向半径按挖空边界**收 12%**，永远贴在腔的内侧。
   */
  const wallLateral = (t: number) => radius * 0.88 * Math.sqrt(Math.max(0.12, 1 - 0.55 * t * t));
  /**
   * 腔壁的**深度剖面**：`t` = 洞口 0 → 腔底 1，返回该处往柱子里退了多少米。
   *
   * `t` 用**归一化横向半径**（`lateral / 洞口半径`）而不是球极角 ——
   * 洞口的点要正好落在柱面上（`u = 0`），用球极角算出来的是个悬在柱子里的球。
   * 剖面本身口小肚大：靠洞口一段退得慢（形成一圈立壁），到底再收。
   */
  const wallDepthAt = (t: number) => depth * Math.pow(Math.min(1, Math.max(0, t)), 0.62);

  /* ① 洞口环缘：一圈木纤维断面，压在洞口平面上（u 略往里一点点），颜色最暗 = 看到的"洞" */
  for (let index = 0; index < 1400; index += 1) {
    const theta = random() * Math.PI * 2;
    const edgeT = 0.8 + random() * 0.24;
    pushWall(
      -depth * 0.04 * random(),
      Math.sin(theta) * radius * edgeT,
      Math.cos(theta) * radius * edgeT,
      darken(rimColor, random(), 0.3),
      [step * 0.8, step * 0.8, step * 0.4],
      true,
    );
  }
  /*
    ② 腔壁：从洞口（t≈0）一直铺到腔底（t=1），横向半径随深度收，颜色**从暗过渡到浅**。
    ⚠ 采 5200 而不是按面积算：腔每深一点，横向半径就小一圈，同样的面积配额落到
    深处只剩几颗点（`t` 用 `sqrt` 也是这个道理 —— 往洞口一侧多给）。
  */
  for (let index = 0; index < 5200; index += 1) {
    const theta = random() * Math.PI * 2;
    /* 往洞口一侧多采一点（`sqrt` 让采样在深处也够密，不至于只剩洞口一圈） */
    const t = Math.sqrt(random());
    const wobble = 1 + (random() - 0.5) * region.wobble * 0.5;
    const lateral = wallLateral(t) * wobble;
    pushWall(
      -wallDepthAt(t),
      Math.sin(theta) * lateral,
      Math.cos(theta) * lateral,
      darken(wallColor, t, 0.6),
      [step * 0.7, step * 0.7, step * 0.35],
    );
  }
  /* ③ 腔底：最深处的小盘，再暗回去（透过去看到它，洞才有深度） */
  for (let index = 0; index < 900; index += 1) {
    const theta = random() * Math.PI * 2;
    const r = wallLateral(1) * 0.6 * Math.sqrt(random());
    pushWall(
      -depth * (1 + random() * 0.06),
      r * Math.sin(theta),
      r * Math.cos(theta),
      darken(floorColor, random(), 0.2),
      [step, step, step * 0.5],
    );
  }
  return {
    points: new Float32Array(points),
    colors: new Float32Array(colors),
    scales: new Float32Array(scales),
    normals: new Float32Array(normals),
  };
}

/**
 * 内部裂痕：**两片贴在一起的断口面**（裂而不空 —— 与虫蛀的区别就在这里）。
 *
 * 真实木裂的样子：缝是一条**两头尖、中间宽**的楔形，断口面沿缝长与缝深都粗糙，
 * 缝越深越暗（光进不去），缝口那一条线最暗（就是"缝"本身被看到的那个黑）。
 * 旧版是两片等宽的平板均匀撒点，所以像贴纸 —— 这里给宽度包络、沿缝的粗糙度与深度压暗。
 *
 * ⚠ 缝口那条暗线要**单独加密**：缝宽只有 0.06r（360 mm 柱子上约 2 cm），
 * 屏幕上就是几像素宽。按面积均匀撒点时绝大多数点落在"往里"的宽面上，
 * 缝口反而稀 —— 于是"裂"读不出来。所以每第 4 个点强制落在 `radialT ∈ [0, 0.25]`。
 */
function buildCrack(
  spec: ColumnSpec,
  region: Extract<CarveRegion, { kind: "crack" }>,
  random: () => number,
): { points: Float32Array; colors: Float32Array; scales: Float32Array; normals: Float32Array } {
  const points: number[] = [];
  const colors: number[] = [];
  const scales: number[] = [];
  const normals: number[] = [];
  const seed = columnSeed(spec);
  const count = 3600;
  /* 断口面：新裂开的木料是浅色纤维，缝深处压暗 */
  const faceColor: [number, number, number] = [0.78, 0.6, 0.4];
  const step = (region.outerR - region.innerR) / 24;
  for (let index = 0; index < count; index += 1) {
    const side = index % 2 === 0 ? 1 : -1;
    /* `u` ∈ [-1,1] 沿缝长；宽度包络 `(1-|u|)^0.6` —— 两头尖、中间宽，不是等宽平板 */
    const u = random() * 2 - 1;
    const envelope = Math.pow(1 - Math.abs(u), 0.6);
    const along = u * region.halfLength;
    /* 缝的张开量：中段最宽，两端闭合 */
    const opening = region.thickness * (0.3 + 0.7 * envelope);
    const radialT = index % 4 === 0 ? random() * 0.25 : random();
    /*
      ⚠ 断口面要**贴进挖空边界的内侧**（`0.88`）：取在边界上时，
      `occlusionAt` 会把断面判成"被自己那条缝挡住"→ 整片压黑
      （与破损断面同一个坑，本轮实现接触阴影时撞到）。
    */
    const radial = (region.innerR + radialT * (region.outerR - region.innerR)) * 0.88;
    const roughness = (valueNoise2(u * 7, radialT * 9, seed + 401) - 0.5) * region.thickness * 1.4;
    const y = region.centerY + along * Math.cos(region.tilt) + roughness;
    const tangential = -along * Math.sin(region.tilt) + (side * opening) / 2;
    const x = spec.x + Math.cos(region.angle) * radial - Math.sin(region.angle) * tangential;
    const z = spec.z + Math.sin(region.angle) * radial + Math.cos(region.angle) * tangential;
    /*
      缝内自成一套明暗：缝口（内半径侧）最暗 —— 那正是肉眼看到的"一道黑缝"；
      往里（外半径侧）回到新断口的木色。再乘环境光遮蔽（跳过自己那条缝）。
    */
    const depth = 1 - radialT;
    const normal: [number, number, number] = [
      -Math.sin(region.angle) * side,
      0,
      Math.cos(region.angle) * side,
    ];
    points.push(x, y, z);
    const occluded = occlusionAt(currentRegions(), spec, x, y, z, region);
    /*
      缝口那一条线**额外压暗**：缝宽只有 2 cm 左右，屏幕上就是几像素，
      只靠"深度渐变"它读不出来（实测对比度 11%、暗区 0%）。
      做法是把暗度与**缝口程度**（`1 - radialT`，缝口为 1）挂钩：
      缝口附近压到 0.35，往里迅速回到新断口的木色。
    */
    const mouthDark = 0.35 + 0.65 * Math.min(1, radialT / 0.35);
    const shaded = darken(faceColor, depth * envelope, 0.82);
    const color = applyWoodTone([
      shaded[0] * occluded * mouthDark,
      shaded[1] * occluded * mouthDark,
      shaded[2] * occluded * mouthDark,
    ]);
    colors.push(color[0], color[1], color[2]);
    scales.push(step * 0.6, step * 0.6, step * 0.26);
    normals.push(normal[0], normal[1], normal[2]);
  }
  return {
    points: new Float32Array(points),
    colors: new Float32Array(colors),
    scales: new Float32Array(scales),
    normals: new Float32Array(normals),
  };
}

/**
 * 破损：柱脚被磕掉一块之后**露出来的那个断面**。
 *
 * 真实的磕碰断面有三样东西，缺一样就像贴纸：
 *   ① **离柱面越深越往里缩**（`damageBite` 已给出半径系数）；
 *   ② **断面本身不是光的**：新断口的木纤维有起伏与毛刺（`valueNoise2` 给粗糙度）；
 *   ③ **断口边缘有一圈毛边**（纤维被扯断的地方颜色更浅、更碎）。
 */
function buildDamage(
  spec: ColumnSpec,
  region: Extract<CarveRegion, { kind: "damage" }>,
  random: () => number,
): { points: Float32Array; colors: Float32Array; scales: Float32Array; normals: Float32Array } {
  const points: number[] = [];
  const colors: number[] = [];
  const scales: number[] = [];
  const normals: number[] = [];
  const seed = columnSeed(spec);
  const count = 3400;
  /* 新断口的木料是**浅色**纤维（比柱面亮）—— 这是"磕掉一块"最主要的视觉线索 */
  const freshColor: [number, number, number] = [0.86, 0.7, 0.5];
  const step = (spec.radiusM * region.halfSpan) / 28;
  for (let index = 0; index < count; index += 1) {
    const offset = random() * region.halfSpan;
    const v = random() * region.topV;
    const angle = region.centerAngle + (random() < 0.5 ? offset : -offset);
    const bite = damageBite(region, offset, v);
    /* ② 断面粗糙度：沿（环向、高度）二维噪声，幅度为半径的 6% */
    const rough = (valueNoise2((offset / region.halfSpan) * 8, v * 14, seed + 733) - 0.5) * 0.06;
    /*
      ⚠ 断面要**贴进挖空边界的内侧**（`0.88`）：
      取在边界上时，`occlusionAt` 会把断面判成"被自己那个缺口挡住"→ 整片压黑
      （本轮实现接触阴影时撞到：断面从"新断口的浅色木料"直接变成一块焦黑）。
      收 12% 之后断面在缺口里面，遮蔽来自它自己那个区域以外的邻近空腔。
    */
    const factor = bite * 0.88 * (1 + rough) * (1 + (random() - 0.5) * 0.02);
    const [x, y, z] = columnPoint(spec, angle, v, factor);
    /*
      ③ 明暗按"离缺口边缘多远"分两档：
      边缘一圈是**刚被扯断的纤维**（亮、显得毛），往里迅速回到旧木料的深色 ——
      没有这层对比，缺口面就是一个均匀的亮斑，读起来像高光而不是断面。
      再乘环境光遮蔽（`occlusionAt`，跳过自己那个缺口）：缺口与柱脚附近整体压暗一层。
    */
    const edge = Math.min(1, offset / region.halfSpan + v / Math.max(0.01, region.topV));
    const occluded = occlusionAt(currentRegions(), spec, x, y, z, region);
    const shaded = darken(freshColor, 1 - edge, 0.62);
    const color = applyWoodTone([shaded[0] * occluded, shaded[1] * occluded, shaded[2] * occluded]);
    /* 断面的法向：近似取该角度处的径向（磕掉的是外皮，断面朝向柱外） */
    const normal: [number, number, number] = [Math.cos(angle), 0.25, Math.sin(angle)];
    const nl = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    points.push(x, y, z);
    colors.push(color[0], color[1], color[2]);
    scales.push(step * 0.75, step * 0.75, step * 0.36);
    normals.push(normal[0] / nl, normal[1] / nl, normal[2] / nl);
  }
  return {
    points: new Float32Array(points),
    colors: new Float32Array(colors),
    scales: new Float32Array(scales),
    normals: new Float32Array(normals),
  };
}

/**
 * 生成一根柱子时，**这一次用到的全部挖空区**（模块级临时引用）。
 *
 * 为什么放在这里而不是当参数层层往下传：缺陷面要在生成时算环境光遮蔽
 * （`occlusionAt` 要看"邻近还有哪些空腔"），而三个缺陷生成函数已经各自带
 * `spec / region / random` 三个参数；再加一个 `regions` 会让每个调用点都得
 * 多穿一层。这里是**模块内私有、每次生成前赋一次值**，不会跨构件串
 * （生成是同步的，`buildColumnCloud` 与 `buildInternalCloud` 都不会交错）。
 */
let activeRegions: readonly CarveRegion[] = [];
const currentRegions = (): readonly CarveRegion[] => activeRegions;

/**
 * 采样点 → **真高斯泼溅**（位置 + 法向 + 尺度 + 逐点颜色）。
 *
 * 这是"外壳像高斯泼溅的"的全部机关：`gl.POINTS` 画出来是硬边圆盘，
 * 一颗颗分得清；泼溅是**有朝向的软高斯椭球**，交叠起来才连成一张面。
 *
 * ── 尺度怎么定（都从采样密度反推，不写魔数）──────────────────────────
 * 采样的点距是已知的（环向 `2πr/SHELL_RINGS`、轴向 `height/(SHELL_LEVELS-1)`），
 * 高斯轴长取 `点距 × SPLAT_SPREAD`：
 *   · `SPLAT_SPREAD < 1` 时相邻高斯**彼此分开**，屏幕上就是"一颗一颗点"（真实扫描点云的读法）；
 *   · `SPLAT_SPREAD > 1` 时它们重叠成一张连续的面 —— **颗粒感消失**。
 *     用户 2026-10-01 的原话：「正常是要看到一个一个点啊，你现在这点云图都纯棕色木柱，
 *     怎么看啊」—— 之前就是把这一项调到了 1.5 倍，表面连成一片，看着像实体木柱。
 *   · 法向那一轴单独压到 `SPLAT_THIN`（点距的 35%）：壳要"薄"，
 *     否则高斯鼓成球，柱面看起来像一层面包。
 *
 * ── 颜色为什么在这里给 ────────────────────────────────────────────
 * 上一版由材质给一个平涂色，于是木纹完全没有 —— 单色点云天生是一根白管子。
 * 外壳走 `shellGrainColor`（逐点木纹）；内部木料给同色系压暗一档，
 * 缺陷各自带自己的颜色（洞口亮、腔壁随深度变暗）。
 */
export const SPLAT_SPREAD = 0.6;

/**
 * 单颗点的**直径**（相对采样点距的倍数）允许区间 —— 单测按它卡"看得出是一颗颗点"。
 *
 * 上限 1.05 是硬线：再大相邻点就开始粘连成面，屏幕上就是用户说的"纯棕色木柱"。
 * 下限 0.45 是另一头：再小点太稀，柱子会虚成一片雾。
 * 这个区间是**产品口径的量化**，不是描述性注释 —— 谁把 `SPLAT_SPREAD` 调到区间外就红。
 */
export const SPLAT_SPREAD_RANGE = { min: 0.45, max: 1.05 } as const;

/** 高斯**法向**那一轴的厚度（相对点距）：壳要薄，否则高斯鼓成球，柱面像一层面包 */
const SPLAT_THIN = 0.35;

/**
 * 渲染层还会把点再放大这么多倍（`columnSplats.tsx` 的 `SPLAT_SIZE_BOOST`）。
 *
 * ⚠ 为什么这个数放在**几何模块**里：屏幕上真正的点直径 = `SPLAT_SPREAD × SPLAT_SIZE_BOOST`，
 * 只卡其中一层的话，另一层被调大照样会连成面（用户否掉的那一版就是渲染层 1.85）。
 * 判据（单测）要一条断言同时卡住两层，而测试加载器**解析不了 `.tsx`**
 * （`ERR_UNKNOWN_FILE_EXTENSION`），所以这个数必须待在 `.ts` 里、由渲染层导入使用。
 * 改点直径就在这一处或 `SPLAT_SPREAD` 上改。
 */
export const SPLAT_SIZE_BOOST = 0.95;

/** 屏幕上单颗点的直径（相对采样点距）。> 1 就会粘连成面，看不出是点云 */
export const splatDotDiameter = (): number => SPLAT_SPREAD * SPLAT_SIZE_BOOST;

export function buildSplatCloud(
  spec: ColumnSpec,
  positions: Float32Array,
  flavor: "shell" | "volume",
): SplatCloud {
  const count = positions.length / 3;
  const normalArray = new Float32Array(count * 3);
  const scaleArray = new Float32Array(count * 3);
  const colorArray = flavor === "shell" ? shellGrainColor(positions, spec) : new Float32Array(count * 3);
  const seed = columnSeed(spec);

  /* 采样点距（米）：环向按该构件实际半径算，轴向按视高 */
  const arcStep = (2 * Math.PI * spec.radiusM) / SHELL_RINGS;
  const levelStep = spec.heightM / (SHELL_LEVELS - 1);
  const axial = levelStep * SPLAT_SPREAD;
  const tangential = arcStep * SPLAT_SPREAD;

  if (flavor === "volume") {
    /* 内部木料：各向同性的一颗颗小高斯（体填充要"实"，不能是片），颜色同色系压暗 */
    const volumeM3 = Math.PI * spec.radiusM ** 2 * spec.heightM;
    const spacing = Math.cbrt(volumeM3 / Math.max(1, count));
    const radius = spacing * SPLAT_SPREAD * 0.62;
    for (let index = 0; index < count; index += 1) {
      const jitter = 0.8 + hash2(index, 7, seed) * 0.5;
      scaleArray[index * 3] = radius * jitter;
      scaleArray[index * 3 + 1] = radius * jitter;
      scaleArray[index * 3 + 2] = radius * jitter;
      const shade = 0.62 + hash2(index, 11, seed) * 0.22;
      /*
        体点也吃环境光遮蔽：壳体是半透的，洞口与柱脚附近的**木料本身**也该更暗，
        否则壳暗、芯亮，透过去看会"外暗内亮"（像一个发光的芯）。
      */
      const occluded = occlusionAt(currentRegions(), spec, positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
      const tinted = applyWoodTone([0.62 * shade * occluded, 0.47 * shade * occluded, 0.3 * shade * occluded]);
      colorArray[index * 3] = tinted[0];
      colorArray[index * 3 + 1] = tinted[1];
      colorArray[index * 3 + 2] = tinted[2];
    }
    return { position: positions, normal: normalArray, color: colorArray, scale: scaleArray, count };
  }

  for (let index = 0; index < count; index += 1) {
    const x = positions[index * 3];
    const y = positions[index * 3 + 1];
    const z = positions[index * 3 + 2];
    const angle = Math.atan2(z - spec.z, x - spec.x);
    const v = Math.min(1, Math.max(0, (y - spec.baseY) / Math.max(1e-6, spec.heightM)));
    const normal = surfaceNormalAt(spec, seed, angle, v);
    normalArray[index * 3] = normal[0];
    normalArray[index * 3 + 1] = normal[1];
    normalArray[index * 3 + 2] = normal[2];
    /* 封口（柱脚/柱顶那两个圆盘）的法向被上面算成了柱面的径向，
       于是圆盘上会立起一圈"刺"。按到轴线的距离与高度识别封口并改成正上/正下。 */
    const isCap = v <= 1e-6 || v >= 1 - 1e-6;
    if (isCap) {
      const up = v <= 1e-6 ? -1 : 1;
      normalArray[index * 3] = 0;
      normalArray[index * 3 + 1] = up;
      normalArray[index * 3 + 2] = 0;
      scaleArray[index * 3] = tangential;
      scaleArray[index * 3 + 1] = axial;
      scaleArray[index * 3 + 2] = levelStep * SPLAT_THIN;
    } else {
      scaleArray[index * 3] = tangential;
      scaleArray[index * 3 + 1] = axial;
      scaleArray[index * 3 + 2] = arcStep * SPLAT_THIN;
    }
  }
  return { position: positions, normal: normalArray, color: colorArray, scale: scaleArray, count };
}

/** 生成一根柱子：先算挖空区 → 再出壳与体（带剔除）→ 最后画缺陷面 */
export function buildColumnCloud(spec: ColumnSpec, recipes: readonly DefectRecipe[] = DEFECT_RECIPES[spec.componentId] ?? []): ColumnCloud {
  const random = mulberry32(seedOf(spec.componentId));
  const regions = recipes.map((recipe) => carveRegionOf(spec, recipe));
  /* 缺陷面生成时要看"邻近还有哪些空腔"来算接触阴影，见 `activeRegions` 的说明 */
  activeRegions = regions;
  /*
    虫道网**必须先算**（壳 / 体 / 腔壁三处都要按它挖空，`inBurrow` 是唯一判据），
    算一次、三处共用 —— 与 `regions`（缺陷挖空）同一套做法。
  */
  const burrows = burrowNetworkOf(spec);
  const shellSamples = buildShell(spec, regions, random, burrows);
  /* 柱坐标 → 场景坐标（`shell` 那份扁平数组是给单测与精度读数用的） */
  const shellPositions = new Float32Array(shellSamples.length * 3);
  shellSamples.forEach((sample, index) => {
    const [x, y, z] = columnPoint(spec, sample.angle, sample.v, sample.factor);
    shellPositions[index * 3] = x;
    shellPositions[index * 3 + 1] = y;
    shellPositions[index * 3 + 2] = z;
  });
  const volume = buildVolume(spec, regions, random, burrows);
  const defects: CloudDefect[] = recipes.map((recipe, index) => {
    const region = regions[index];
    if (region.kind === "borer") {
      const built = buildBorer(spec, region, random);
      return {
        kind: "borer" as const,
        label: recipe.label,
        source: recipe.source,
        points: built.points,
        colors: built.colors,
        normals: built.normals,
        scales: built.scales,
        carve: region,
        centroid: { x: region.cx, y: region.cy, z: region.cz },
      };
    }
    if (region.kind === "crack") {
      const built = buildCrack(spec, region, random);
      return {
        kind: "crack" as const,
        label: recipe.label,
        source: recipe.source,
        points: built.points,
        colors: built.colors,
        normals: built.normals,
        scales: built.scales,
        carve: region,
        centroid: { x: spec.x + spec.radiusM * 0.6, y: region.centerY, z: spec.z },
      };
    }
    const built = buildDamage(spec, region, random);
    return {
      kind: "damage" as const,
      label: recipe.label,
      source: recipe.source,
      points: built.points,
      colors: built.colors,
      normals: built.normals,
      scales: built.scales,
      carve: region,
      centroid: {
        x: spec.x + Math.cos(region.centerAngle) * spec.radiusM * 0.85,
        y: spec.baseY + (region.topV * spec.heightM) / 2,
        z: spec.z + Math.sin(region.centerAngle) * spec.radiusM * 0.85,
      },
    };
  });
  /*
    中空腔的壁与底：尺度按**空腔自己的采样密度**算（口径比柱面小，点距也更小），
    不复用柱面的 `SPLAT_SPREAD` —— 否则壁上的点会稀到看不出是一面墙。
  */
  const hollow = buildHollowWalls(spec, burrows);
  const hollowCount = hollow.points.length / 3;
  const hollowArc = (2 * Math.PI * spec.radiusM * HOLLOW_RADIUS_RATIO) / SHELL_RINGS;
  const hollowLevel = (spec.heightM * (HOLLOW_TOP_V - HOLLOW_BOTTOM_V)) / Math.max(1, Math.round((HOLLOW_TOP_V - HOLLOW_BOTTOM_V) * SHELL_LEVELS));
  const hollowScale = new Float32Array(hollowCount * 3);
  for (let index = 0; index < hollowCount; index += 1) {
    hollowScale[index * 3] = hollowArc * SPLAT_SPREAD;
    hollowScale[index * 3 + 1] = hollowLevel * SPLAT_SPREAD;
    hollowScale[index * 3 + 2] = hollowArc * SPLAT_THIN;
  }
  return {
    spec,
    shell: shellPositions,
    shellSplats: buildSplatCloud(spec, shellPositions, "shell"),
    volume,
    volumeSplats: buildSplatCloud(spec, volume, "volume"),
    hollowSplats: {
      position: hollow.points,
      normal: hollow.normals,
      color: hollow.colors,
      scale: hollowScale,
      count: hollowCount,
    },
    burrows,
    defects,
    defectSplats: defects.map((defect) => ({
      position: defect.points,
      normal: defect.normals,
      color: defect.colors,
      scale: defect.scales,
      count: defect.points.length / 3,
    })),
  };
}

/**
 * 生成整个内部点云（默认四根柱子全要；可按构件过滤）。
 *
 * `cutaway` = 剖开看内部（用户口径 2026-10-02：「根本看不出内部问题」）：
 * 把朝相机那一面的一段扇形壳与木料收掉，露出腔壁与虫道。
 * **必须走参数**（而不是只靠模块级开关）：构建结果是 `useMemo` 缓存的，
 * 开关状态得进依赖数组，切一下才会真的重建（只改模块变量不会触发重算）。
 */
export function buildInternalCloud(componentIds?: readonly string[], cutaway = false): InternalCloud {
  setCutaway(cutaway);
  try {
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
  } finally {
    /* 构建完就复位：模块级开关不该把状态泄漏给别的调用方（单测、别的页面） */
    setCutaway(false);
  }
}

/** 这一根柱子有哪些内部缺陷（列表用；也便于单测逐条核） */
export function defectsOf(componentId: string): readonly DefectRecipe[] {
  return DEFECT_RECIPES[componentId] ?? [];
}

/* ------------------------------------------------------------------ *
 * 精度读数（用户 2026-10：「3d 点云做得更精细一些，轮廓要能对上单根那根」）
 *
 * ── 为什么要把"精细"变成一个数 ──────────────────────────────────────
 * "更精细"如果只靠肉眼判断，下次谁改参数都说不清是变好还是变坏。
 * 轮廓读不读得出来，本质上就是**柱面相邻点隔多少毫米**：
 *   · 环向：`2πr / 每圈点数`（决定侧影是光滑曲线还是多边形）
 *   · 轴向：`视高 / 层数`（决定柱身有没有横向条纹）
 * 所以这里把两个间距与体密度算出来：界面显示、单测断言、工装核对，都用同一份数字。
 * ------------------------------------------------------------------ */

/** 一棵柱子的精度读数 */
export type ColumnRefinement = {
  componentId: string;
  /** 柱面环向每圈点数（实际采样值） */
  shellRings: number;
  /** 柱面轴向层数 */
  shellLevels: number;
  /** 环向相邻点弧长（**毫米**）—— 侧影光滑度的判据 */
  arcSpacingMm: number;
  /** 轴向相邻层间距（**毫米**） */
  levelSpacingMm: number;
  /** 内部木料实得体密度（点/立方米） */
  volumePerM3: number;
  /** 三段点数（壳 / 内部 / 缺陷面） */
  shellPoints: number;
  volumePoints: number;
  defectPoints: number;
};

/**
 * 精度读数。
 *
 * ⚠ 环向间距是**按每根柱子的实际半径**算的：四根柱径不同（320/318/356/360 mm），
 * 同样的每圈点数下，最粗那根的弧长最大 —— 现场"看哪根最糊"就是这个数最大的那根。
 */
export function refinementOf(cloud: ColumnCloud): ColumnRefinement {
  const defectPoints = cloud.defects.reduce((sum, defect) => sum + defect.points.length / 3, 0);
  const volumeM3 = Math.PI * cloud.spec.radiusM ** 2 * cloud.spec.heightM;
  const volumePoints = cloud.volume.length / 3;
  return {
    componentId: cloud.spec.componentId,
    shellRings: SHELL_RINGS,
    shellLevels: SHELL_LEVELS,
    arcSpacingMm: ((2 * Math.PI * cloud.spec.radiusM) / SHELL_RINGS) * 1000,
    levelSpacingMm: (cloud.spec.heightM / (SHELL_LEVELS - 1)) * 1000,
    volumePerM3: volumePoints / volumeM3,
    shellPoints: cloud.shell.length / 3,
    volumePoints,
    defectPoints,
  };
}

/** 整份点云的精度读数（四根一起；界面上的"精度"一栏读它） */
export function cloudRefinement(cloud: InternalCloud): ColumnRefinement[] {
  return cloud.columns.map(refinementOf);
}

/**
 * 点数预算（给界面与工装用）：这份点云一共多少个点。
 *
 * 为什么单列一个函数而不是各处 `length / 3`：四根一起看时这几个数要**相加**
 * 才是真正进 GPU 的量，写散了迟早有一处漏算缺陷面。
 */
export function columnPointBudget(cloud: ColumnCloud): number {
  return (
    cloud.shell.length / 3 +
    cloud.volume.length / 3 +
    /* 中空腔的内壁与腔底也是进 GPU 的点：漏算它，"屏上的颗数"就与预算对不上（本轮撞到） */
    cloud.hollowSplats.count +
    cloud.defects.reduce((sum, defect) => sum + defect.points.length / 3, 0)
  );
}

/**
 * 柱面外壳的**逐点木色**（用户口径 2026-09-20：「点云目前色彩太花了」）。
 *
 * ── 为什么必须逐点给色 ────────────────────────────────────────────
 * 单一颜色的点云**天生没有纹理**：无论点径多大、多不透明，看上去都是一根白管子。
 * 真实感只能来自"点与点之间的明暗差"，也就是木纹。
 *
 * ── 为什么是程序化的木纹，而不是去取泼溅里的颜色 ────────────────
 * 本轮把 `gs.sog` 的 239 万点全部解出来核对过（脚本与结论都在
 * `voice-module/runtime/find-column.py` 的注释里）：这份泼溅里**没有一根能单独取出的木柱**——
 * y 直方图显示 130 万点压在楼板（y -3.8~-1.9 m），柱身段每 0.26 m 只有约 2 万点，
 * 2.39 M 点摊在整个房间约合 1.3 cm 间距；按半径取出来的那 4.2 万点实测是**均匀噪声**
 * （这正是"柱子一块块发斑"的根因）。所以几何与颜色都由这里保证，
 * 泼溅只作为薄薄一层真实质感叠在上面（见 `InternalPointCloudView`）。
 *
 * ── 木纹怎么算 ──────────────────────────────────────────────────
 * 两种纹理叠在一起，都是**沿柱高拉长**的（`y / 高` 的缩放远大于环向）：
 *   ① 轴向长纹：低环向频率 + 沿高度缓慢漂移 —— 原木通长的丝缕；
 *   ② 细密环纹：环向频率高一些、沿高度快速变化 —— 木料的细密度。
 * 再叠一点**逐点细粒**（`hash2`，无空间相关性），避免整根柱子显得太"塑料"。
 * 幅度 `GRAIN_AMPLITUDE` 压在 0.3 以内：木纹是**明暗**，不是换一种颜色 ——
 * 幅度一大，"太花"就会以另一种形式回来。
 *
 * @param positions 场景坐标点（三三一组）
 * @param spec      构件（要轴心与半径来算环向角）
 * @returns 与点一一对应的 RGB（0–1）；返回 `Float32Array`，直接喂 bufferAttribute
 */
export const GRAIN_AMPLITUDE = 0.26;

/** 每根构件木纹的相位：让四根柱子的纹理错开（同一份纹理复制四遍会一眼看穿） */
function grainPhaseOf(componentId: string): number {
  return ((seedOf(componentId) % 6283) / 1000) % (Math.PI * 2);
}

/**
 * 木纹的**明暗因子**（1 = 基准色，越小越暗）。
 *
 * 单独抽出来是为了能被**单测直接量**：`shellGrainColor` 现在的最终颜色是
 * `基准色 × 木纹 × 接触阴影`，拿最终颜色去量"木纹幅度"会被遮蔽带偏
 * （最亮的那一点也得乘遮蔽，比值就不再是木纹本身的幅度了 —— 本轮就撞上这条）。
 * 判据要量什么，就得能单独拿到什么。
 *
 * @param ring 环向坐标（已按弧长折算，见 `shellGrainColor`）
 * @param heightT 沿柱高的归一化位置
 */
export function grainShadeAt(ring: number, heightT: number, seed: number): number {
  const fiber = valueNoise2(ring * 0.5, heightT * 2.6, seed);
  const tight = valueNoise2(ring * 2.1, heightT * 17, seed + 977);
  const speck = hash2(Math.round(ring * 4096), Math.round(heightT * 4096), seed + 31);
  return 1 - GRAIN_AMPLITUDE * (0.55 * fiber + 0.3 * tight + 0.15 * speck);
}

export function shellGrainColor(positions: Float32Array, spec: ColumnSpec): Float32Array {
  const count = positions.length / 3;
  const out = new Float32Array(count * 3);
  const seed = columnSeed(spec);
  const spin = grainPhaseOf(spec.componentId);
  /** 木纹的基准色：暖木黄（不是纯白 —— 纯白在暗背景上会读成"石膏柱"）。
      注意着色器里顶点色与材质色（`#d9c4a3`）**相乘**，而且外面还叠着两层点，
      实测（`tools/column-color-probe.mjs`）基准色取到 0.78 时整根柱子量出来是
      rgb(196,182,161) —— 亮得像石膏。这里压到让量出来的木色落在"中深暖棕"一档。 */
  const base = [0.70, 0.51, 0.32];
  const height = Math.max(1e-6, spec.heightM);
  for (let i = 0; i < count; i += 1) {
    const dx = positions[i * 3] - spec.x;
    const dz = positions[i * 3 + 2] - spec.z;
    const angle = Math.atan2(dz, dx) + spin;
    const heightT = (positions[i * 3 + 1] - spec.baseY) / height;
    /*
      环向坐标按弧长折算（`ring * r`）：粗柱子与细柱子的纹理**看上去一样密**，
      否则 320 mm 那根与 360 mm 那根的木纹粗细会不一样。
    */
    const ring = (angle / (2 * Math.PI)) * (2 * Math.PI * spec.radiusM) * 14;
    const shade = grainShadeAt(ring, heightT, seed);
    /*
      ⚠ 接触阴影（`occlusionAt`）要**烘进外壳的颜色**，否则洞口读不出来：
      洞口在几何上被挖空了，但如果洞口的壳点颜色与旁边一样亮，
      屏幕上就只是"纹路断了"，而不是"这里有洞" —— 用户口径里的
      「能看到里面的空洞」靠的正是这一层：洞口暗 → 洞内壁亮 → 洞底再暗。
      遮蔽是按点算的（邻近的空腔 / 裂缝 / 缺口），只影响颜色，不动几何。
    */
    const occluded = occlusionAt(currentRegions(), spec, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    const tinted = applyWoodTone([base[0] * shade * occluded, base[1] * shade * occluded, base[2] * shade * occluded]);
    out[i * 3] = tinted[0];
    out[i * 3 + 1] = tinted[1];
    out[i * 3 + 2] = tinted[2];
  }
  return out;
}
