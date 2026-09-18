/**
 * 任务范围与出发清单（面板）
 *
 * 外壳用 `../../Panel`，标题固定「任务范围与出发清单」（与第①轮台词第②段对齐）。
 *
 * ── 三条口径 ────────────────────────────────────────────────────────
 *   1. **只画受控配置，不生成任何内容**：任务、装备、待确认项逐条来自
 *      `taskScope.ts`（唯一事实源，测试逐字核对）。本组件只接收父组件拼进来的
 *      `className`，**不收任何数据 props**、不读工单详情、不碰图片与接口 ——
 *      从根上没有"根据现场内容临时编清单"的入口。
 *   2. 待确认项只标「待现场确认 · 附件未明确」，**不给任何取值**：
 *      没有 Z 编号、没有树种、没有含水率、没有联系电话（防幻觉硬规则第 6 / 10 条）。
 *   3. `className` 原样保留 `wop-reveal` 一词，供父组件 `WorkOrderDetail.tsx`
 *      拼接 `is-in` 做揭示门控（见 `orders.css` 的 `.wop-reveal:not(.is-in)`）。
 *      本组件**不自己加** `is-in`：门控由父组件按播报节拍负责，
 *      自己加上去会让这一块在人还没念到时就先亮。
 */

import { Panel } from "../../Panel";
import { Btn, DataTable } from "../../ui";
import { DEPARTURE_KIT, FOUR_TASKS, TO_CONFIRM, TO_CONFIRM_MARK } from "./taskScope";
import "./task-scope.css";

export function TaskScopePanel({ className = "" }: { className?: string }) {
  return (
    <Panel
      title="任务范围与出发清单"
      className={`wop-reveal ${className}`.trim()}
      /*
        通往执行工作台的入口（剧本 ⑥「我已把工单任务同步到工作台」）。
        工作台**不进一级导航**（PRD 2.2 固定八项），所以工单页要留一个手动入口：
        现场漏触发小木那两轮时，人也能自己走过去看任务卡与回执。
      */
      extra={
        <Btn tone="ghost" onClick={() => (window.location.hash = "#/workbench")}>
          执行工作台
        </Btn>
      }>
      <h4 className="sub">四项任务</h4>
      <DataTable
        head={["序号", "任务", "说明"]}
        rows={FOUR_TASKS.map((task) => [
          <span key={`task-${task.no}`}>{String(task.no).padStart(2, "0")}</span>,
          task.name,
          task.detail,
        ])}
      />

      <h4 className="sub">出发清单</h4>
      <dl className="tscope-kit">
        {DEPARTURE_KIT.map((kit) => (
          <div key={kit.group} className="tscope-kit__row">
            <dt>{kit.group}</dt>
            {/* 装备文本原样输出：不再二次切分，切错就是把一件装备拆成两件 */}
            <dd>{kit.items}</dd>
          </div>
        ))}
      </dl>

      <h4 className="sub">待现场确认</h4>
      <ul className="tscope-confirm">
        {TO_CONFIRM.map((item) => (
          <li key={item}>
            <span>{item}</span>
            {/* 固定占位说明：不进 title、不折叠，投屏上也要看得见 */}
            <em className="muted">{TO_CONFIRM_MARK}</em>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
