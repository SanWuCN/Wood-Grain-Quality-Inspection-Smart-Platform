/**
 * 小木形象方案展台 · 方案清单（**唯一**的登记处）
 *
 * 加一版方案 = 加一个文件 + 在这里挂一行。`main.ts` 与 `loop.ts` 都不用改 ——
 * 这是这套契约存在的全部理由（见 `types.ts` 顶部）。
 *
 * 编号即顺序：页面按这个数组从上到下、从左到右排。
 * 前 8 版是需要 WebGL 上下文的 three 实现，第 9 版是老方法（`needsWebGL: false`）。
 *
 * ⚠ 不要在这里做筛选/排序/条件注册：`registry.assertValid()` 会校验 id 唯一、
 *    非空、`needsWebGL` 是布尔。任何"按环境挑几个"的写法都会让页面与对照表对不上号。
 */

import type { LabVariant } from "../types.ts";
import { glassTransmission } from "./glassTransmission.ts";
import { jellyWobble } from "./jellyWobble.ts";
import { iridescentFlow } from "./iridescentFlow.ts";
import { doubleShell } from "./doubleShell.ts";
import { plasma } from "./plasma.ts";
import { soapFilm } from "./soapFilm.ts";
import { metaballFluid } from "./fluidMetaball.ts";
import { flatGlow } from "./flatGlow.ts";
import { oldMethodSvg } from "./oldMethodSvg.ts";
import { paleLavenderGlass } from "./paleLavenderGlass.ts";

/** 展台上的全部方案（首版 9 个：8 three + 1 老方法） */
export const ALL_VARIANTS: LabVariant[] = [
  glassTransmission,
  jellyWobble,
  iridescentFlow,
  doubleShell,
  plasma,
  soapFilm,
  metaballFluid,
  flatGlow,
  oldMethodSvg,
  paleLavenderGlass,
];

export {
  glassTransmission,
  jellyWobble,
  iridescentFlow,
  doubleShell,
  plasma,
  soapFilm,
  metaballFluid,
  flatGlow,
  oldMethodSvg,
  paleLavenderGlass,
};
