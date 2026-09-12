/**
 * 高斯泼溅主视图的常量与类型。
 *
 * 与组件分开放：eslint 的 `react-refresh/only-export-components` 要求
 * 「一个文件只导出组件」，混着导出常量会让 HMR 退化成整页刷新。
 */

/** 重建产物的位置与朝向。朝向不对时整场景会是躺倒的 */
export type SplatTransform = {
  /** 绕 X 轴旋转（度）。摄影测量产物常见 Y 轴朝下，需要翻转 */
  pitch: number;
  /** 整体缩放。SOG 自带真实尺度，这里只做演示取景微调 */
  scale: number;
  /** 平移，把场景中心挪到原点附近 */
  offset: [number, number, number];
};

export const SPLAT_TRANSFORM: SplatTransform = {
  pitch: 0,
  scale: 1,
  offset: [0, 0, 0],
};

/** 一次运镜请求。与 Twin 页低模场景的 CameraRig 同一口径 */
export type SplatCamera = {
  azimuth: number;
  polar: number;
  /** 聚焦点。重建产物没有标定构件位置，所以通常传 null（看场景中心） */
  focus: { x: number; y: number; z: number } | null;
  /** 取景距离 */
  distance?: number;
};

/** 重建产物路径。换产物只改这一处 */
export const SPLAT_URL = "/model/sog/gs.sog";

/**
 * 重建产物声明的包围盒（来自 SOG 内部的 `meta.json` 的 `means.mins/maxs`）。
 *
 * ⚠️ 不要改用 `SplatMesh.getBoundingBox()`：实测在 `lod: true` 下它**永远返回空盒**
 * （Spark 的 LoD 源没有把 `forEachSplat` 暴露到 `mesh.splats` 上，
 * 而 `getBoundingBox` 正是靠它遍历的），轮询 3 秒也拿不到值。
 * 与其在运行时赌它什么时候可用，不如直接读产物自己声明的边界 ——
 * 这份数字是生成产物时写进文件里的，比我猜一个机位可靠。
 */
export const SPLAT_BOUNDS = {
  min: [-3.2036505, -3.8093863, -3.1541593] as const,
  max: [3.3854871, 3.5174401, 3.4391849] as const,
};
