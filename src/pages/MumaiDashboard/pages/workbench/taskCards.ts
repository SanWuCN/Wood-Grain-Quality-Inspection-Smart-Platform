/**
 * 执行工作台 · 任务卡的内容与派生（纯逻辑，Node 单测可覆盖）
 *
 * ── 剧本依据（每一批都对得上原文）──────────────────────────────────
 *   · ⑥ 小木：「我已把工单任务同步到工作台。环境配置、地图、场景和检测批次将关联本次工单」
 *     → `startup`（开工四项）：② 的「已整理为四项任务：现场建档、风险初筛、重点精扫和复核交付」；
 *   · ⑭ 小木：「建议核对材种来源与标定范围，补充有来源的参考样本，检查数据质量，并验证候选模型」+
 *     ⑮ 小木：「任务卡已生成。补采交全栈执行，样本与测区由具身核对，项目经理审核分组和验证结果，
 *     平台记录各项回执」→ `adapt`（异常适配四项）；
 *   · 剧本夹注：「小木创建任务草稿，按本轮岗位分工预填执行人；史核对后保存，
 *     **不直接把任务标成已完成**」—— 所以状态只有 草稿 → 已保存 → 已回执（见 `TASK_STATE_*`），
 *     页面也不提供任何"标完成"的按钮。
 *
 * ── 为什么执行人写账号 id 而不是姓名 ────────────────────────────────
 * 姓名是展示用的，改一次称呼就会让历史卡片和权限判断对不上；账号 id 是主键。
 * 姓名/岗位从 `seed/scenario.ts` 的 `MEMBERS` 取（**唯一来源**），
 * 这里不写第二份花名册。
 */

import type { TaskCardEntity } from "../../api/client";
import type { SharedEntity } from "../../api/client";
import { MEMBERS } from "../../seed/scenario";

export type TaskCardRecord = SharedEntity<TaskCardEntity>;

/** 卡片状态的展示口径（服务端只有这三个，见 `server/services/workflow.mjs` 的 TASK_NEXT） */
export const TASK_STATE_LABEL: Record<TaskCardEntity["state"], { text: string; tone: "muted" | "info" | "ok" }> = {
  draft: { text: "草稿", tone: "muted" },
  saved: { text: "已保存", tone: "info" },
  accepted: { text: "已回执", tone: "ok" },
};

/** 状态流转的下一步（页面按钮文案与可用性都由它决定） */
export const TASK_STATE_STEP: Record<TaskCardEntity["state"], { action: "task.save" | "task.ack" | null; label: string }> = {
  draft: { action: "task.save", label: "核对后保存" },
  saved: { action: "task.ack", label: "执行人回执" },
  accepted: { action: null, label: "已回执" },
};

/** 一张卡的预填内容（服务端只存不改，内容归这里） */
export type TaskCardDraft = {
  title: string;
  ownerAccountId: string;
  inputs: string[];
  doneCondition: string;
  note?: string;
};

export type TaskCardBatch = {
  batchKey: string;
  label: string;
  /** 这一批是哪一轮生成的（排练时对稿用） */
  roundNo: string;
  cards: TaskCardDraft[];
};

/** 账号 id → 姓名/岗位（从 MEMBERS 取，找不到时如实显示账号 id，不编一个中文名） */
export function ownerOf(accountId: string): { label: string; role: string } {
  const hit = MEMBERS.find((item) => item.id === accountId);
  return hit ? { label: hit.name, role: hit.role } : { label: accountId, role: "未登记岗位" };
}

/**
 * 两批任务卡。
 *
 * ⚠ 卡片文案**引用剧本原话里的动作**，不写"已完成/已通过"这类结论 ——
 * 完成条件写的是"什么算完成"（可核对），而不是"已经完成"（不可核对）。
 */
export const TASK_BATCHES: readonly TaskCardBatch[] = Object.freeze([
  {
    batchKey: "startup",
    label: "开工四项",
    roundNo: "⑥",
    cards: [
      {
        title: "现场建档",
        ownerAccountId: "ma",
        inputs: ["四根木柱影像采集批次", "场景 SLAM 建图与地图版本"],
        doneCondition: "影像与地图版本按本工单归档；小车数据通道与采集时间各自记录",
      },
      {
        title: "风险初筛",
        ownerAccountId: "shi",
        inputs: ["Z01–Z04 原始关键帧", "归档场景版本"],
        doneCondition: "出具四柱优先复核顺序，并在平台上标注疑点测区",
      },
      {
        title: "重点精扫",
        ownerAccountId: "rao",
        inputs: ["环境配置版本（工单环境校验产物）", "Z04 下部测区与扫描方向"],
        doneCondition: "原始回波与表面图像按测区回传并入库",
      },
      {
        title: "复核交付",
        ownerAccountId: "shen",
        inputs: ["检测记录与校验结果", "交付清单"],
        doneCondition: "交付清单校验通过，复盘草稿纳入报告",
      },
    ],
  },
  {
    batchKey: "adapt",
    label: "异常适配四项",
    roundNo: "⑮",
    cards: [
      {
        title: "补充参考样本",
        ownerAccountId: "rao",
        inputs: ["采样计划（一条目标路径 + 一条换向路径）", "参考样本编号与来源登记规则"],
        doneCondition: "两条路径采集完成，样本编号、来源与扫描条件登记齐全",
      },
      {
        title: "样本与测区核对",
        ownerAccountId: "ma",
        inputs: ["参考样本批次记录", "Z04 测区位置与标高"],
        doneCondition: "样本编号、扫描方向、测区位置三者对应；缺失信息另列清单",
      },
      {
        title: "分组与验证审核",
        ownerAccountId: "shen",
        inputs: ["待审核记录清单", "训练 / 验证 / 测试分组"],
        doneCondition: "三组物理样本编号无交叉，标签依据可追溯",
      },
      {
        title: "适配验证",
        ownerAccountId: "shi",
        inputs: ["候选模型与归档测试集", "端侧部署条件检查项"],
        doneCondition: "独立验证与设备端检查结果就绪，交付状态据实更新",
        note: "只使用事先授权、来源明确的参考样本；不在现场木柱上取样",
      },
    ],
  },
]);

export function batchOf(batchKey: string): TaskCardBatch | null {
  return TASK_BATCHES.find((item) => item.batchKey === batchKey) ?? null;
}

/** 服务端要的卡片载荷（补齐姓名与岗位，服务端只存不改） */
export function cardsFor(batchKey: string): Record<string, unknown>[] {
  const batch = batchOf(batchKey);
  if (!batch) return [];
  return batch.cards.map((card) => {
    const owner = ownerOf(card.ownerAccountId);
    return {
      title: card.title,
      ownerAccountId: card.ownerAccountId,
      ownerLabel: owner.label,
      ownerRole: owner.role,
      inputs: [...card.inputs],
      doneCondition: card.doneCondition,
      ...(card.note ? { note: card.note } : {}),
      source: "小木",
    };
  });
}

/** 某张工单的任务卡：按批次顺序、批次内按 seq 排（不按 id 字典序，TK-10 与 TK-9 会排错） */
export function cardsOfOrder(list: readonly TaskCardRecord[] | undefined, orderId: string | null | undefined): TaskCardEntity[] {
  if (!orderId) return [];
  const order = TASK_BATCHES.map((item) => item.batchKey);
  return (list ?? [])
    .map((item) => item?.data)
    .filter((item): item is TaskCardEntity => Boolean(item) && item.orderId === orderId)
    .sort((a, b) => {
      const batchDiff = (order.indexOf(a.batchKey) + 1 || 99) - (order.indexOf(b.batchKey) + 1 || 99);
      return batchDiff !== 0 ? batchDiff : a.seq - b.seq;
    });
}

/** 按批次分组（页面两栏/两组展示）；未登记批次也照实显示，不丢卡 */
export function groupByBatch(cards: readonly TaskCardEntity[]): { batchKey: string; label: string; cards: TaskCardEntity[] }[] {
  const groups: { batchKey: string; label: string; cards: TaskCardEntity[] }[] = [];
  for (const card of cards) {
    let group = groups.find((item) => item.batchKey === card.batchKey);
    if (!group) {
      group = { batchKey: card.batchKey, label: batchOf(card.batchKey)?.label ?? card.batchKey, cards: [] };
      groups.push(group);
    }
    group.cards.push(card);
  }
  return groups;
}

/** 进度：已回执 / 总数（页头用它，不另算一套） */
export function progressOf(cards: readonly TaskCardEntity[]): { accepted: number; saved: number; draft: number; total: number } {
  return {
    total: cards.length,
    draft: cards.filter((item) => item.state === "draft").length,
    saved: cards.filter((item) => item.state === "saved").length,
    accepted: cards.filter((item) => item.state === "accepted").length,
  };
}

/**
 * 某张卡此刻**该由谁**推进（页面据此决定按钮可不可点）。
 *
 * 两条规则都来自剧本：
 *   · 保存（草稿→已保存）是核对人的事（史/沈，`task:manage`）；
 *   · 回执（已保存→已回执）是**这张卡的执行人**的事 —— 别人的卡不该被他点掉
 *     （服务端只校验 `task:execute` 权限，按卡判执行人这一层在页面上做，
 *      口径与工单页的"按单职责"一致）。
 */
export function canAdvance(
  card: TaskCardEntity,
  actor: { id: string } | null,
  /* 收窄到平台的两条权限码：传 `can` 进来时不用断言，也防住"随手传个别的权限码" */
  can: (permission: "task:manage" | "task:execute") => boolean,
): { allowed: boolean; reason: string } {
  const step = TASK_STATE_STEP[card.state];
  if (!step.action) return { allowed: false, reason: "已回执" };
  if (step.action === "task.save") {
    return can("task:manage")
      ? { allowed: true, reason: "" }
      : { allowed: false, reason: "核对后保存需要 task:manage 权限" };
  }
  if (!can("task:execute")) return { allowed: false, reason: "回执需要 task:execute 权限" };
  if (!actor) return { allowed: false, reason: "未登录" };
  return actor.id === card.ownerAccountId
    ? { allowed: true, reason: "" }
    : { allowed: false, reason: `这张卡由${card.ownerLabel}回执` };
}
