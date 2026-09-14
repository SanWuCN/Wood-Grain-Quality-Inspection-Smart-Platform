/**
 * 小木形象方案展台 · 方案注册表（REQ-01 AC2 / AC4，UC-01 备选 4d）
 *
 * ── 这一层为什么必须存在 ────────────────────────────────────────────
 * 展台是"加一个方案 = 加一个文件 + 挂一行"的结构，代价是**第 13 个方案**、
 * **两个 01**、**漏填 name** 这种错只能在页面上以"某格空白/某格不出现"的
 * 形式表现出来 —— 而用户看到的会是"这一版好像没做"，不是"注册表写错了"。
 * 所以这里把三类错误全部前移成**显式抛错**（4d）。
 *
 * ── 为什么 register() 和 assertValid() 都要有 ────────────────────────
 *   register()    防"写的时候"就错（重复 id、超上限）—— 越早越便宜。
 *   assertValid() 防"已经装好的数组"直接灌进页面（页面入口用 list() 的数组形式），
 *                 并且**一次报全**：挤牙膏式报错（修一个跑一次再报下一个）
 *                 会让"注册表坏了"变成一条很长的排查链。
 *
 * 本文件**不碰 DOM、不碰 three**：纯数据校验，所以能在 Node 里直接单测（2.1）。
 */
// ⚠ 扩展名必须写全 `.ts`：Node 原生 ESM 解析器不做 bundler 式补全，
// `node --test src/lab/*.test.ts` 是本项目唯一的单测入口（不新增依赖）。
// tsconfig.app.json 已开 allowImportingTsExtensions，写全扩展名不影响 tsc -b。
import { MAX_VARIANTS, type LabVariant } from "./types.ts";

/**
 * `MAX_VARIANTS` 定义在 types.ts（它是契约的一部分），这里**转出去**是为了
 * 让"上限"和"谁在强制这个上限"待在同一个模块里：
 * 展台页 `main.ts` 只需要认识 registry，不必再去 types 里捞一个常量。
 */
export { MAX_VARIANTS };

/** assertValid 接受的形状：注册表和页面入口之间传的就是这个 */
export type RegistryEntry = LabVariant;

export interface VariantRegistry {
  /** id 重复 → 抛；id 为空 → 抛；超过 MAX_VARIANTS → 抛 */
  register(variant: LabVariant): void;
  /** 按注册顺序返回（编号即顺序，页面左上到右下照它排）。返回**副本** */
  list(): LabVariant[];
}

/**
 * 把注册表里的问题一次收集完。
 *
 * 空注册表是最特殊的一条：它不是"某个字段坏了"，而是"整页什么都没有"。
 * 单独判、单独给一句人话（4d 的原话就是"注册表为空或变体 id 重复"）。
 */
export function assertValidRegistry(entries: readonly RegistryEntry[]): void {
  const problems: string[] = [];

  if (entries.length === 0) {
    problems.push("注册表为空：0 个方案，展台会渲染出一个空页面（UC-01 备选 4d）");
  }

  if (entries.length > MAX_VARIANTS) {
    problems.push(`注册表有 ${entries.length} 个方案，超过上限 MAX_VARIANTS=${MAX_VARIANTS}`);
  }

  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const at = `第 ${index + 1} 个（id=${JSON.stringify(entry?.id)}）`;

    if (typeof entry?.id !== "string" || entry.id.trim() === "") {
      problems.push(`${at}：id 缺失或为空串`);
    } else if (seen.has(entry.id)) {
      problems.push(`${at}：id "${entry.id}" 重复`);
    } else {
      seen.add(entry.id);
    }

    if (typeof entry?.name !== "string" || entry.name.trim() === "") {
      problems.push(`${at}：name 缺失或为空串`);
    }
    if (typeof entry?.needsWebGL !== "boolean") {
      problems.push(`${at}：needsWebGL 必须是布尔（老方法版写 false）`);
    }
    if (typeof entry?.create !== "function") {
      problems.push(`${at}：create 必须是函数`);
    }
  });

  if (problems.length > 0) {
    throw new Error(`方案注册表不合法（${problems.length} 处）：\n  - ${problems.join("\n  - ")}`);
  }
}

export function createRegistry(): VariantRegistry {
  const items: LabVariant[] = [];

  return {
    register(variant: LabVariant): void {
      if (typeof variant?.id !== "string" || variant.id.trim() === "") {
        throw new Error(`注册失败：id 必须是非空字符串（收到 ${JSON.stringify(variant?.id)}）`);
      }
      if (items.some((item) => item.id === variant.id)) {
        throw new Error(`注册失败：id "${variant.id}" 重复。编号必须唯一，否则两张图分不清谁是谁`);
      }
      if (items.length >= MAX_VARIANTS) {
        throw new Error(
          `注册失败：已达上限 MAX_VARIANTS=${MAX_VARIANTS}，无法再加入 "${variant.id}"`,
        );
      }
      items.push(variant);
    },
    list(): LabVariant[] {
      // 副本：调用方 push/sort 不该改到注册表内部状态
      return items.slice();
    },
  };
}
