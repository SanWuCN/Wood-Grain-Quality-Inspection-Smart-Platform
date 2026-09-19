/**
 * 「小木生成物」—— 剧本最后三轮（㉓ 工单草稿 / ㉔ 复盘草稿 / ㉕ 交付摘要）的**数据组装**
 *
 * ── 为什么单独一个模块（用户口径 2026-10-01）──────────────────────────
 * 用户原话：「平台最后几个对话需要更好的平台展示，而不只是跳转下页面」。
 * ㉓㉔㉕ 原先都只做了一件事：跳到工单详情页 + 把同样的三组分区再展开一次 ——
 * 三句台词讲的是三份**不同的**交付物，屏幕上却一模一样。
 *
 * 现在每轮各带出一块自己的面板（`OrderDeliverablesPanel` 渲染），台词念到哪一块、
 * 哪一块出现（拍点表在 `script.ts` 的 `reveal.beats`）。
 *
 * ── 三条口径（与仓库其它地方一致，不能破）────────────────────────────
 *   1. **不编数字**：每一行都取自 `seed/scenario.ts` / `seed/deviceLogs.ts` 的既有事实
 *      （复核工单草稿、归档交付清单、总览待办、异常事件、数据集、版本、实验记录），
 *      并且每行都带 `from`（屏幕上显示"这一行从哪来"）—— 与「预置结果必须标来源」同一条规矩；
 *   2. **状态如实**：草稿就是草稿（`DRAFT_ORDER.status = 草稿`），不写成"已下发"；
 *      「未完成事项」按 `state !== "已完成"` 现算，不手写条数；
 *   3. **组名与揭示框架同源**：`DELIVERABLE_SECTIONS` 里的组名同时被
 *      `ordersReveal.ORDER_DETAIL_SECTIONS`（门控）、`script.ts`（拍点表）与本模块引用，
 *      三处对不上时 `orderDeliverables.test.ts` 会红。
 */
import {
  CURRENT_RISKS,
  DATASET,
  DELIVERY_ARTIFACTS,
  DEMO_SCENARIO_V3,
  DRAFT_ORDER,
  EXPERIMENT,
  TODO_ITEMS,
} from "../../seed/scenario";
import { TRIAGE_EVENTS } from "../../seed/deviceLogs";

/** 面板里的一行：键 / 值 / 这一行的来源（屏幕上显示，别让人猜） */
export type DeliverableLine = { k: string; v: string; from: string };

/** 一块（= 一个揭示组）：台词念到这一拍，这一块出现 */
export type DeliverableBlock = { section: string; title: string; lines: DeliverableLine[] };

/**
 * 三份生成物的揭示组名。
 *
 * ⚠ 这些组名必须同时出现在 `ordersReveal.ORDER_DETAIL_SECTIONS` 里（页面的门控按它判），
 *   否则面板在播报期间永远不显示 —— 单测会核对两处一致。
 */
export const DELIVERABLE_SECTIONS = {
  /** ㉓ 工单草稿：重点复核项 / 附件 / 处理建议 */
  draft: ["draft-focus", "draft-attachments", "draft-advice"],
  /** ㉔ 复盘草稿：任务完成情况 / 异常处置 / 版本交付 / 后续待办 */
  review: ["review-done", "review-issues", "review-version", "review-todo"],
  /** ㉕ 交付摘要：文件校验 / 待办清单 / 关联 */
  summary: ["summary-check", "summary-todo", "summary-linked"],
} as const;

/** 三份生成物的标题与归属轮次（面板标题栏用；轮次号与 `script.ts` 一致） */
export const DELIVERABLE_TITLES = {
  draft: { roundNo: "㉓", title: "工单草稿（小木生成）" },
  review: { roundNo: "㉔", title: "任务复盘草稿（小木生成）" },
  summary: { roundNo: "㉕", title: "交付摘要（小木整理）" },
} as const;

/** 面板需要的工单信息（用**正在看的那张工单**，不是 seed 里写死的常量） */
export type DeliverableOrderInput = { orderNo: string; status: string; title: string };

const delivery = DEMO_SCENARIO_V3.delivery;

/**
 * ㉓ 工单草稿：剧本 §441–443「生成工单草稿，列出复核位置、处理建议和附件」。
 *
 * 数据取自 `DRAFT_ORDER`（PRD 3.8 的复核工单草稿：小木生成草稿 → 经理确认 → 待复核），
 * 三块正好对着台词的三小句：重点复核项 → 附件 → 处理建议。
 */
export function draftOrderBlocks(): DeliverableBlock[] {
  const attachments = DRAFT_ORDER.attachments;
  return [
    {
      section: DELIVERABLE_SECTIONS.draft[0],
      title: "重点复核项",
      lines: [
        { k: "草稿编号", v: DRAFT_ORDER.id, from: "复核工单草稿" },
        { k: "标题", v: DRAFT_ORDER.title, from: "复核工单草稿" },
        { k: "复核位置", v: DRAFT_ORDER.location, from: "复核工单草稿" },
        { k: "等级", v: DRAFT_ORDER.level, from: "复核工单草稿" },
        { k: "来源风险", v: DRAFT_ORDER.sourceRiskIds.join(" / "), from: "本轮融合风险记录" },
      ],
    },
    {
      section: DELIVERABLE_SECTIONS.draft[1],
      title: "附件（检测图像与雷达分析）",
      lines: [
        ...attachments.map((item) => ({
          k: item.name,
          v: `${item.kind} · ${item.sizeText}`,
          from: `${item.from}导出`,
        })),
        { k: "附件合计", v: `${attachments.length} 项`, from: "复核工单草稿" },
      ],
    },
    {
      section: DELIVERABLE_SECTIONS.draft[2],
      title: "处理建议",
      lines: [
        { k: "处理建议", v: DRAFT_ORDER.scope, from: "复核工单草稿" },
        { k: "当前状态", v: `${DRAFT_ORDER.status} · 待专业审核`, from: "复核工单草稿" },
        { k: "验收口径", v: DRAFT_ORDER.acceptanceNote, from: "复核工单草稿" },
      ],
    },
  ];
}

/**
 * ㉔ 复盘草稿：剧本 §454–456「重点写异常原因、处置过程和后续待办」。
 *
 * 台词说的四段就是这四块。数字全部现算：
 *   · 异常事件条数来自 `TRIAGE_EVENTS`（已结案/在跟踪按 `state` 过滤，不手写）；
 *   · 数据集审核通过数按 `reviewAssign` 里 `state === "已通过"` 现算；
 *   · 「未完成事项」按 `TODO_ITEMS.state !== "已完成"` 现算。
 */
export function reviewBlocks(order: DeliverableOrderInput): DeliverableBlock[] {
  const settled = TRIAGE_EVENTS.filter((item) => item.state === "已结案").length;
  const pending = TRIAGE_EVENTS.length - settled;
  const reviewed = DATASET.reviewAssign.filter((item) => item.state === "已通过").length;
  const openTodos = TODO_ITEMS.filter((item) => item.state !== "已完成");
  return [
    {
      section: DELIVERABLE_SECTIONS.review[0],
      title: "任务完成情况",
      lines: [
        { k: "本单", v: `${order.orderNo} · ${order.status}`, from: "本工单" },
        {
          k: "数据集",
          v: `${DATASET.label} · 审核 ${reviewed}/${DATASET.reviewAssign.length} 通过`,
          from: `数据集 ${DATASET.id}`,
        },
        {
          k: "归档交付",
          v: `${delivery.passed}/${delivery.total} 项通过校验（缺失 ${delivery.missing} · 摘要不一致 ${delivery.summaryMismatch}）`,
          from: "归档交付清单",
        },
      ],
    },
    {
      section: DELIVERABLE_SECTIONS.review[1],
      title: "异常处置",
      lines: [
        {
          k: "巡检异常事件",
          v: `共 ${TRIAGE_EVENTS.length} 条 · 已结案 ${settled} 条 · ${pending} 条在跟踪`,
          from: "设备日志 · 异常事件",
        },
        {
          k: "适用域事件",
          v: "scan-Z04-001 诊断输出已冻结（适用域待核验）",
          from: "设备日志",
        },
        {
          k: "本轮风险",
          v: CURRENT_RISKS.map((item) => `${item.id} ${item.priority}`).join(" · "),
          from: "本轮风险记录",
        },
      ],
    },
    {
      section: DELIVERABLE_SECTIONS.review[2],
      title: "版本交付",
      lines: [
        {
          k: "地图",
          v: `${DEMO_SCENARIO_V3.map.version} · ${DEMO_SCENARIO_V3.map.resolutionM} m · 覆盖 ${DEMO_SCENARIO_V3.map.coveragePct}%`,
          from: "建图版本",
        },
        { k: "场景", v: DEMO_SCENARIO_V3.twin.sceneId, from: "三维场景" },
        {
          k: "模型",
          v: `${EXPERIMENT.candidateVersion}（基线 ${EXPERIMENT.baselineVersion}）`,
          from: `实验记录 ${EXPERIMENT.id}`,
        },
      ],
    },
    {
      section: DELIVERABLE_SECTIONS.review[3],
      title: `后续待办（未完成 ${openTodos.length} 项单独列出）`,
      lines: openTodos.map((item) => ({
        k: `${item.id} ${item.text}`,
        v: `${item.owner} · 截止 ${item.due} · ${item.state}`,
        from: "总览待办",
      })),
    },
  ];
}

/**
 * ㉕ 交付摘要：剧本 §476–478「文件校验结果和待办清单分别列出，复盘草稿已关联本次工单」。
 *
 * 「文件校验结果」的四个数取自 `DEMO_SCENARIO_V3.delivery`（同一份清单也渲染在交付中心），
 * 下面再列三份产物的真实摘要前缀（`DELIVERY_ARTIFACTS.sha256`）——
 * 让"逐项对照摘要"看得见，而不是只报一个通过率。
 */
export function summaryBlocks(order: DeliverableOrderInput): DeliverableBlock[] {
  const openTodos = TODO_ITEMS.filter((item) => item.state !== "已完成");
  const published = DELIVERY_ARTIFACTS.filter((item) => item.state === "已发布");
  const samples = (published.length ? published : DELIVERY_ARTIFACTS).slice(0, 3);
  return [
    {
      section: DELIVERABLE_SECTIONS.summary[0],
      title: "文件校验结果（逐项 SHA-256 对照）",
      lines: [
        { k: "归档清单", v: `${delivery.total} 项`, from: "归档交付清单" },
        { k: "校验通过", v: `${delivery.passed} 项`, from: "归档交付清单" },
        { k: "缺失文件", v: `${delivery.missing} 项`, from: "归档交付清单" },
        { k: "摘要不一致", v: `${delivery.summaryMismatch} 项`, from: "归档交付清单" },
        ...samples.map((item) => ({
          k: item.name,
          v: `${item.sha256}… · ${item.state}`,
          from: item.target,
        })),
      ],
    },
    {
      section: DELIVERABLE_SECTIONS.summary[1],
      title: `待办清单（还需要处理 ${openTodos.length} 项）`,
      lines: openTodos.map((item) => ({
        k: `${item.id} ${item.text}`,
        v: `${item.owner} · 截止 ${item.due} · ${item.state}`,
        from: "总览待办",
      })),
    },
    {
      section: DELIVERABLE_SECTIONS.summary[2],
      title: "关联与审核",
      lines: [
        { k: "复盘草稿", v: "已关联本次工单", from: DELIVERABLE_TITLES.review.title },
        { k: "交付摘要", v: "等待项目经理审核", from: DELIVERABLE_TITLES.summary.title },
        { k: "工单", v: order.orderNo, from: "本工单" },
      ],
    },
  ];
}
