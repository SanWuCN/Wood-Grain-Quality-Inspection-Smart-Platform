/**
 * 标签筛选 + 名称缩写 —— 只决定「哪些区域显示名字」和「显示成什么」，
 * 不影响 <Label> 自身的样式。
 *
 * 两个必须解决的问题：
 *   1. Demo2 一共 21 个市级区域，全部显示没问题；换成 34 个省级区域后，
 *      东部沿海（京津冀鲁苏沪浙）会糊成一团。所以做一次贪心的屏幕空间去重叠。
 *   2. 全国图上要能同时看到 30 来个省名，就只能用简称（内蒙古自治区 → 内蒙古）。
 */

import { Box2, type Vector2 } from "three";

export interface LabelRegion {
  name: string;
  points: Vector2[][];
}

/** 省级后缀缩写：全国图上要放下 30+ 个省名，长名字放不下 */
export function shortRegionName(name: string): string {
  let out = name;
  if (out.endsWith("特别行政区")) out = out.slice(0, -5);
  else if (out.endsWith("自治区")) out = out.slice(0, -3);
  else if (out.endsWith("省") || out.endsWith("市")) out = out.slice(0, -1);
  return out.replace(/(壮族|回族|维吾尔)$/, "");
}

export interface LabelCandidate {
  name: string;
  /** 区域中心，归一化到 0..1（地图包围盒） */
  x: number;
  y: number;
  /** 投影后 bbox 面积，用于排序 */
  area: number;
  /**
   * 放置优先级，**越小越先放**；不传表示最后放。
   *
   * 为什么是数字而不是布尔：京津、沪苏浙这些区域挨得极近，如果只标一个
   * 「必显」布尔值，它们之间仍然按面积比大小 —— 结果北京会被更小的天津顶掉，
   * 地图上就少了「北京」。用显式序号才能让调用方决定谁先谁后。
   */
  priority?: number;
}

export interface DeclutterOptions {
  /** 标签宽 / 高，单位为「地图长边的比例」 */
  width: number;
  height: number;
  /** 标签之间的最小间隙，单位同上 */
  gap?: number;
}

/**
 * 贪心去重叠：按「业务优先 → 面积从大到小」依次放置，
 * 与已放置标签的矩形相交就跳过。这样小省不会被大省挤掉，
 * 但真的放不下的（例如京津沪挤在一起）会自然隐藏掉最不重要的那个。
 */
export function declutterLabels(
  candidates: LabelCandidate[],
  options: DeclutterOptions,
): Set<string> {
  const { width, height, gap = 0.004 } = options;
  const halfW = width / 2 + gap;
  const halfH = height / 2 + gap;

  const ordered = [...candidates].sort((a, b) => {
    // 先按显式优先级（小的先放），再按面积从小到大 —— 小区域本来就被挤在
    // 角落，让它们先占到位置。反过来（大到小）会让北京 / 上海 / 重庆 / 安徽 /
    // 福建 永远排最后、位置被大省占完就被整个丢掉。
    // 大区域（新疆 / 西藏 / 内蒙古）中心点彼此相距很远，晚放也排得下。
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.area - b.area;
  });

  const placed: { x: number; y: number }[] = [];
  const keep = new Set<string>();

  for (const item of ordered) {
    const clash = placed.some(
      (p) => Math.abs(p.x - item.x) < halfW + halfW && Math.abs(p.y - item.y) < halfH + halfH,
    );
    if (clash) continue;
    placed.push({ x: item.x, y: item.y });
    keep.add(item.name);
  }

  return keep;
}

/** 由区域点集算出「归一化中心 + 投影 bbox 面积」 */
export function toCandidates(
  regions: LabelRegion[],
  bbox: Box2,
): LabelCandidate[] {
  const sizeX = bbox.max.x - bbox.min.x || 1;
  const sizeY = bbox.max.y - bbox.min.y || 1;

  return regions.map((region) => {
    const box = new Box2();
    region.points.forEach((polygon) => {
      polygon.forEach((point) => box.expandByPoint(point));
    });
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    const w = box.max.x - box.min.x;
    const h = box.max.y - box.min.y;
    const valid = Number.isFinite(w) && Number.isFinite(h);
    return {
      name: region.name,
      x: (cx - bbox.min.x) / sizeX,
      y: (cy - bbox.min.y) / sizeY,
      area: valid ? w * h : 0,
    };
  });
}
