/**
 * 数字孪生 · 机位关键帧的位姿换算（纯函数，可单测）
 *
 * ── 这一层在干什么 ────────────────────────────────────────────────
 * 相机在渲染层是「position + 朝向」，而 `splat.ts` 那套声明式机位是
 * 「看向哪个点 + 距离 + 极角 + 方位角」。打关键帧与回到机位就是这两个表示之间的
 * 一次换算：
 *   · 打帧：`poseFromView()` 把当前相机**读成**声明式机位，交给服务端存；
 *   · 回帧：`poseToCamera()` 把存的机位**喂回**渲染层（`SplatStage` 的 `camera`）。
 *
 * 为什么单独抽成纯函数：这是**最容易错、又最难在现场发现**的一段 ——
 * 角度符号或口径反了，镜头会飞到模型另一侧，而页面不会报任何错，只是"看起来不对"。
 * 所以配套 `splatPose.test.ts`：往返一致、边界钳制、坏数据拒收。
 *
 * 口径与 `SplatCameraRig` 里那一行**必须逐字一致**（改一处就得改另一处）：
 *   x = focus.x + d·sin(polar)·sin(azimuth)
 *   y = focus.y + d·cos(polar)
 *   z = focus.z + d·sin(polar)·cos(azimuth)
 * 即：极角从 +Y 量（0 = 正上方），方位角从 +Z 向 +X 量，角度单位是**度**。
 */
import type { SplatCamera } from "./splat";

/** 一个可回放的机位（就是 `SplatCamera` 去掉可空字段的那个形态） */
export type SplatPose = {
  /** 方位角（度）：从 +Z 向 +X 量 */
  azimuth: number;
  /** 极角（度）：从 +Y 量，0 = 正上方 */
  polar: number;
  /** 相机到「看向的点」的距离（米），必须 > 0 */
  distance: number;
  focus: { x: number; y: number; z: number };
};

/** 渲染层读出来的一个视角：相机在哪、朝哪看 */
export type CameraView = {
  position: { x: number; y: number; z: number };
  /** 朝向单位向量（镜头正前方） */
  forward: { x: number; y: number; z: number };
};

/**
 * 纵向留 2° 余量：正上 / 正下时极角退化（sin=0，方位角失去意义），
 * 与 `FirstPersonControls` 里给 pitch 留余量是同一个理由。
 */
const POLAR_EPSILON_DEG = 2;

/** 距离下限：0 或负数会让相机落在模型里，画面全黑，看起来像坏了 */
const MIN_DISTANCE = 0.02;

/**
 * 看向的点该放在镜头前方多远。
 *
 * 取模型尺度的 0.6 倍（`flyScale` = 包围盒最长边的一半，由 `SplatStage` 量出来）：
 * 太近则"看向的点"落在相机自己身上（回放时插值没有方向感），
 * 太远则在拉近看柱子时那个点跑到柱子后面去了。
 */
export function lookAheadFor(flyScale: number | null | undefined): number {
  const scale = Number(flyScale);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  /* 顺手取到 4 位小数：机位本身也是 4 位精度，免得 3 × 0.6 变成 1.7999999999999998 */
  return Math.round(Math.min(6, Math.max(0.4, scale * 0.6)) * 10000) / 10000;
}

/**
 * 严格取数：只有真正是数字（或非空数字字符串）才算数。
 *
 * ⚠ 不能直接 `Number(value)`：`Number(null)` 与 `Number("")` 都是 **0** ——
 * 实体里一条缺字段的坏帧（JSON 里就是 `null`）会被当成"方位角 0°"这种**看起来合法**的
 * 机位显示出来，点一下镜头就飞到完全不对的地方。所以 null / 空串 / 布尔一律按"没有"处理。
 * （服务端 `normalizeKeyframePose` 有同一条口径，两边都要拒。）
 */
const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * 当前视角 → 可落库的机位。
 *
 * @param view      相机位置与朝向（朝向会被归一化；零向量按"看向 -Z"处理）
 * @param lookAhead 看向的点放在镜头前方多远，见 `lookAheadFor`
 */
export function poseFromView(view: CameraView, lookAhead: number): SplatPose {
  const px = finite(view.position?.x);
  const py = finite(view.position?.y);
  const pz = finite(view.position?.z);
  if (px === null || py === null || pz === null) {
    throw new Error("机位换算：相机位置不是有限数字");
  }
  let fx = finite(view.forward?.x) ?? 0;
  let fy = finite(view.forward?.y) ?? 0;
  let fz = finite(view.forward?.z) ?? 0;
  const length = Math.hypot(fx, fy, fz);
  if (length < 1e-6) {
    /* 退化朝向（理论上不会发生）：按 three.js 相机的默认朝向 -Z 处理，而不是抛错 */
    fx = 0;
    fy = 0;
    fz = -1;
  } else {
    fx /= length;
    fy /= length;
    fz /= length;
  }
  const distance = clamp(finite(lookAhead) ?? 1, MIN_DISTANCE, 1000);
  /* focus = 相机位置 + 朝向 × 距离：从 focus 看回相机的方向就是 -forward */
  const focus = { x: px + fx * distance, y: py + fy * distance, z: pz + fz * distance };
  /* 从 focus 指向相机 = -forward，按上面那三行口径反解出角度 */
  const polar = clamp((Math.acos(clamp(-fy, -1, 1)) * 180) / Math.PI, POLAR_EPSILON_DEG, 180 - POLAR_EPSILON_DEG);
  const azimuth = (Math.atan2(-fx, -fz) * 180) / Math.PI;
  return {
    azimuth: round4(azimuth),
    polar: round4(polar),
    distance: round4(distance),
    focus: { x: round4(focus.x), y: round4(focus.y), z: round4(focus.z) },
  };
}

/** 机位 → `SplatStage` 的 `camera` 入参（顺带钳制到安全范围） */
export function poseToCamera(pose: SplatPose): SplatCamera {
  return {
    azimuth: clamp(pose.azimuth, -360, 360),
    polar: clamp(pose.polar, POLAR_EPSILON_DEG, 180 - POLAR_EPSILON_DEG),
    distance: clamp(pose.distance, MIN_DISTANCE, 1000),
    focus: { x: pose.focus.x, y: pose.focus.y, z: pose.focus.z },
  };
}

/** 镜头位置（由机位反算）—— 回放动画的终点，也用来做"到了没有"的判断 */
export function poseToPosition(pose: SplatPose): { x: number; y: number; z: number } {
  const phi = (pose.polar * Math.PI) / 180;
  const theta = (pose.azimuth * Math.PI) / 180;
  return {
    x: pose.focus.x + pose.distance * Math.sin(phi) * Math.sin(theta),
    y: pose.focus.y + pose.distance * Math.cos(phi),
    z: pose.focus.z + pose.distance * Math.sin(phi) * Math.cos(theta),
  };
}

/** 服务端存的一帧（字段名与服务端 `scene.keyframe.add` 写入的结构一致） */
export type TwinKeyframe = {
  id: string;
  componentId: string | null;
  label: string;
  pose: SplatPose;
  /**
   * 这一帧的配图（打帧那一刻 3D 画面的截图，用户 2026-09-18 口径）。
   *
   * 存的是**文件库里的 id**，不是图片本身：场景快照每台端都要收一遍，
   * 把上百 KB 的 base64 塞进实体等于每次刷新都在内网重传所有帧的图。
   * 老帧（这个字段之前打的）没有它 —— 所以是可选的，缺了就显示"无图"。
   */
  imageFileId?: string;
  imageName?: string;
  addedBy: string;
  addedAt: string;
  /** 最后一次改名 / 覆盖机位的人与时间（服务端在 update 时写；打帧时没有） */
  updatedBy?: string;
  updatedAt?: string;
};

/**
 * 容错解析一个机位：**任何一项不是有限数字、距离非正**就返回 null。
 *
 * 为什么必须容错而不是 `as`：实体是历史数据（老库、手改、别的版本写进去的），
 * 一条坏帧如果在渲染时被当成合法机位，镜头会飞到 NaN 位置 —— 整个画面消失，
 * 而控制台只有一行 WebGL 警告。宁可这一条不显示。
 */
export function parsePose(value: unknown): SplatPose | null {
  const raw = value as Partial<SplatPose> | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  const azimuth = finite(raw.azimuth);
  const polar = finite(raw.polar);
  const distance = finite(raw.distance);
  const fx = finite(raw.focus?.x);
  const fy = finite(raw.focus?.y);
  const fz = finite(raw.focus?.z);
  if (azimuth === null || polar === null || distance === null || distance <= 0) return null;
  if (fx === null || fy === null || fz === null) return null;
  return { azimuth, polar, distance, focus: { x: fx, y: fy, z: fz } };
}

/** 容错解析服务端 `scene.keyframes`：坏帧直接丢，不抛错、不显示 */
export function readKeyframes(data: unknown): TwinKeyframe[] {
  const list = (data as { keyframes?: unknown } | null | undefined)?.keyframes;
  if (!Array.isArray(list)) return [];
  const out: TwinKeyframe[] = [];
  for (const item of list) {
    const frame = item as Partial<TwinKeyframe> | null;
    if (!frame || typeof frame !== "object") continue;
    const id = String(frame.id ?? "").trim();
    const pose = parsePose(frame.pose);
    if (!id || !pose) continue;
    /* 配图是可选字段：只认"非空字符串"，半个 fileId（空串/null）按没有图处理 */
    const imageFileId = String(frame.imageFileId ?? "").trim();
    const imageName = String(frame.imageName ?? "").trim();
    out.push({
      id,
      componentId: frame.componentId ? String(frame.componentId) : null,
      label: String(frame.label ?? "").trim() || id,
      pose,
      ...(imageFileId ? { imageFileId, imageName: imageName || `${id}.jpg` } : {}),
      addedBy: String(frame.addedBy ?? ""),
      addedAt: String(frame.addedAt ?? ""),
      ...(frame.updatedBy ? { updatedBy: String(frame.updatedBy) } : {}),
      ...(frame.updatedAt ? { updatedAt: String(frame.updatedAt) } : {}),
    });
  }
  return out;
}

/** 关键帧标签上限（与服务端 `scene.keyframe.update` 的 40 字一致） */
export const KEYFRAME_LABEL_MAX = 40;

/**
 * 「这一帧的画面是不是全黑」的判据（0~255 的最亮像素）。
 *
 * 场景背景是 `#05080d`（亮度约 9）。实测：`SplatMesh` 的加载回调（页面据此撤掉
 * 加载覆盖层、放开「打关键帧」按钮）只代表**文件解析完**，画面还要等 6~10 秒
 * （6.4MB 产物）甚至更久（58MB 产物）才出第一帧 —— 这段时间整块画布就是背景色。
 * 现场现象是"点一下打关键帧，3D 区是黑的，也不知道这一帧记的是哪儿"。
 *
 * 所以这个阈值有两个用处（口径必须一致，所以放在这里给两端共用）：
 *   · 渲染舞台每 400ms 探一次画面，亮过它就报「画出来了」→ 按钮才放开；
 *   · 打帧时对**截下来的那一张图**再判一次，全黑就拒收（宁可当场说清楚，不记黑帧）。
 *
 * 取 24：比背景（9）高出一截，又远低于木构件在画面里的亮度（实测 150~220），
 * 不至于因为产物偏暗就永远打不了帧。
 */
export const FRAME_BLACK_LUMA = 24;

/**
 * 规范化用户输入的标签（纯函数，前后端同一条口径）。
 *
 * 返回 `null` = 这次输入不该提交（空白），调用方按"取消"处理 ——
 * 空串在服务端是"回到自动标签"，在这里先挡住，避免手滑把名字清空。
 */
export function normalizeKeyframeLabel(input: string): string | null {
  const label = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!label) return null;
  return label.slice(0, KEYFRAME_LABEL_MAX);
}

/**
 * 巡场走到下一帧的下标（纯函数，可单测）。
 *
 * 讲解用法是「一帧一帧自动走一遍」：走到头**停下**而不是绕回第 1 帧 ——
 * 台上绕回会让人以为讲完了又从头开始；`wrap` 留给需要循环的场景。
 */
export function nextTourIndex(index: number, total: number, step: number, wrap = false): number | null {
  if (total <= 0) return null;
  const next = index + step;
  if (next < 0) return 0;
  if (next >= total) return wrap ? 0 : null;
  return next;
}

/** 帧上显示的时间：`21:03`（本地时间）；解析不了就写 `—`，不显示 NaN */
export function keyframeTimeText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 机位读数（气泡/读数条用）：`方位 32° · 仰角 88° · 2.4 m` */
export function poseReadout(pose: SplatPose): string {
  return `方位 ${Math.round(pose.azimuth)}° · 仰角 ${Math.round(pose.polar)}° · ${pose.distance.toFixed(1)} m`;
}

/**
 * 镜头位置读数：`位置 1.5, 0.8, -3.2`。
 *
 * 为什么还要报位置：只报"方位 + 仰角 + 距离"的话，**平移看不出来**（沿着朝向走、
 * 或按 WASD 侧移，这三个数一个都不变），只有转动才会变。而"回到那一帧"恰恰是靠位置区分的：
 * 讲解人拉近柱子前后方位角可能一样，位置差了好几米。所以读数条上两个都给。
 */
export function posePositionText(pose: SplatPose): string {
  const at = poseToPosition(pose);
  return `位置 ${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}`;
}

const round4 = (value: number) => Number(value.toFixed(4));
