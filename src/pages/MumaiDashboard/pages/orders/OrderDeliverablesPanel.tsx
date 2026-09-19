/**
 * 「小木生成物」面板（剧本最后三轮 ㉓㉔㉕ 的屏幕落点）
 *
 * ── 用户口径（2026-10-01）────────────────────────────────────────────
 * 「平台最后几个对话需要更好的平台展示，而不只是跳转下页面」。
 * 原先 ㉓㉔㉕ 都只是跳到工单详情页、再把同样的三组分区展开一遍：三句台词讲三份不同的
 * 交付物，屏幕上却一模一样。现在每轮各带出一块**自己的**面板，面板里再按台词逐块出现。
 *
 * ── 三条口径 ────────────────────────────────────────────────────────
 *   1. 组件**只负责画**：数据全部来自 `orderDeliverables.ts`（那里规定"每一行都要有来源"），
 *      本组件不读接口、不拼字符串数字 —— 没有"临时编一条"的入口；
 *   2. `className` 原样保留 `wop-reveal` 一词，`is-in` 由父组件按播报节拍拼
 *      （见 `orders.css` 的 `.wop-reveal:not(.is-in)`）。自己加 `is-in` 会在人还没念到时先亮；
 *   3. 每一行都显示 `from`（这一行从哪来）—— 与仓库「预置结果必须标来源」同一条规矩，
 *      投屏上也要看得见（不做成 hover 才出现的 tooltip）。
 */

import { Panel } from "../../Panel";
import type { DeliverableBlock } from "./orderDeliverables";
import "./order-deliverables.css";

export type OrderDeliverablesPanelProps = {
  title: string;
  /** 这一轮是第几轮（面板标题右侧的角标，例如 ㉓） */
  roundNo: string;
  /** 这一份生成物的一句话说明（取自数据模块，不在这里写死文案） */
  subtitle: string;
  blocks: readonly DeliverableBlock[];
  /**
   * 门控：给一个揭示组名，返回该块该不该显示。
   *
   * 父组件（`WorkOrderDetail.tsx`）用 `useOrderReveal()` 拼出 `revealGate`：
   * 没有计划时（用户自己点进来 / 刷新）恒为真，播报期间按拍点逐块显示。
   */
  gate: (section: string) => string;
  className?: string;
};

export function OrderDeliverablesPanel({
  title,
  roundNo,
  subtitle,
  blocks,
  gate,
  className = "",
}: OrderDeliverablesPanelProps) {
  return (
    <Panel
      title={title}
      className={`wop-reveal ${className}`.trim()}
      extra={<span className="muted">{roundNo} 生成 · {subtitle}</span>}>
      <dl className="deliv">
        {blocks.map((block) => (
          <div key={block.section} className={`deliv__block ${gate(block.section)}`}>
            <dt>{block.title}</dt>
            <dd>
              <ul>
                {block.lines.map((line) => (
                  <li key={`${block.section}-${line.k}`}>
                    <span className="deliv__k">{line.k}</span>
                    <span className="deliv__v">{line.v}</span>
                    {/* 来源逐行标出：投屏上看得见，不用 hover */}
                    <em className="deliv__from">{line.from}</em>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
