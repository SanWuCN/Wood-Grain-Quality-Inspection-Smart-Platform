/**
 * 演示表面的**渲染数据**（纯逻辑，与 React 分开）
 *
 * ── 为什么从组件里抽出来 ────────────────────────────────────────────
 * 本仓库的单测跑在 Node 原生类型剥离下，而它**只支持 `.ts`，不认 `.tsx`**
 * （实测 `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".tsx"`）。
 * 「要显示什么」本来就是纯数据变换，把它留在 `.tsx` 里等于让它永远测不到 ——
 * 而漏标签、缺失态这些东西恰恰最容易错，也最该被测。
 * 所以：本文件放纯函数（可测），`demoSurface.tsx` 只负责把它画出来。
 */
import { type DemoAction } from "./demoActions.ts";
import { formatValue, labelOf } from "./demoSurfaceLabels.ts";
import { scenarioValue } from "../seed/scenario.ts";

/** 一行渲染结果 */
export type SurfaceRow = {
  key: string;
  label: string;
  value: string;
  /** 数据包里取不到值（§11.1：进入缺失态，不补写） */
  missing: boolean;
  /** 是否属于本地演习数据（§4.2：要能标注来源性质） */
  demoData: boolean;
};

/**
 * 把动作的数据键渲染成行。
 *
 * 缺失时显示 `—` 并标记 `missing`，**绝不补写**一个像样的值（§11.1）；
 * 没有标签时显式写出"标签缺失"而不是把键名抛给观众。
 */
export function rowsOf(action: DemoAction): SurfaceRow[] {
  return action.dataKeys.map((key) => {
    const raw = scenarioValue(key);
    const meta = labelOf(key);
    const missing = raw === undefined || meta === null;
    return {
      key,
      label: meta ? meta.label : `〔标签缺失：${key}〕`,
      value: missing ? "—" : formatValue(raw, meta?.unit),
      missing,
      demoData: Boolean(meta?.demoData),
    };
  });
}

/** 该表面是否含"本地演习数据"（决定要不要显示来源角标） */
export function hasDemoData(action: DemoAction): boolean {
  return rowsOf(action).some((r) => r.demoData);
}
