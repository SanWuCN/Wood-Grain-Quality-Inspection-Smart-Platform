/**
 * 新流程工单详情（PRD-工单指派与扫描仪下发-v1.0 §5.1）
 *
 * 信息结构从上到下就是 PRD 列的那六块：
 *   ① 工单摘要（编号 / 标题 / 状态 / 计划作业时间 / 地点 / 平台创建时间 / 负责人岗位）
 *   ② 委托要求与检测主体（委托原文 + Z01—Z04 四条木柱，两块分开呈现）
 *   ③ 负责人及参与人员      → AssignmentPanel
 *   ④ 环境记录与配置校验    → EnvironmentPanel
 *   ⑤ 扫描仪下发            → DispatchPanel
 *   ⑥ 作业记录与成果（新单为空态）
 *
 * 这里只做**编排与摘要**：录入、指派、下发的表单都在各自的二级面板里，
 * 一级页面不为了某一次操作铺一整片表单。
 *
 * 原「来源风险」不进摘要：新单是现场检测委托，本来就没有风险结论；
 * 之后真有检测结果了，在「作业记录与成果」里关联（PRD §5.1）。
 */

import { useState } from "react";
import type {
  ApiError,
  WorkOrderAction,
  WorkOrderDetail as WorkOrderDetailView,
} from "../api/client";
import { Panel } from "../Panel";
import { WORK_ORDER_STATUS_TONE } from "./overview.constants";
import { Btn, DataTable, KV, Modal, SourceTag, StateBlock, StatusChip } from "../ui";
import { AssignmentPanel } from "./orders/AssignmentPanel";
import { EnvironmentPanel } from "./orders/EnvironmentPanel";
import { DispatchPanel } from "./orders/DispatchPanel";
import "./orders/orders.css";
import "./orders-page.css";

/** 状态动作的按钮文案：与 PRD §8.1 的状态机逐字对应 */
const STATUS_ACTIONS: { action: WorkOrderAction; label: string; tone?: "default" | "primary" | "danger"; capability: keyof WorkOrderDetailView["capabilities"] }[] = [
  { action: "start", label: "开始作业", tone: "primary", capability: "canStart" },
  { action: "submit", label: "提交验收", tone: "primary", capability: "canSubmit" },
  { action: "accept", label: "验收通过并归档", tone: "primary", capability: "canAccept" },
  { action: "pause", label: "暂停", capability: "canPause" },
  { action: "resume", label: "恢复", tone: "primary", capability: "canResume" },
  { action: "archive", label: "归档", tone: "danger", capability: "canArchive" },
];

export type WorkOrderDetailActions = {
  assign: (body: { leaderAccountId: string; members: { accountId: string; duties: string[] }[]; expectedRevision: number }) => Promise<void>;
  saveEnvironment: (body: Parameters<typeof import("../api/client").api.saveWorkOrderEnvironment>[1]) => Promise<void>;
  validateEnvironment: (expectedRevision: number) => Promise<void>;
  dispatch: (body: { deviceId: string; configVersion?: string | null; idempotencyKey: string }) => Promise<void>;
  setStatus: (action: WorkOrderAction) => Promise<void>;
  /** 删除工单：不可恢复，调用方负责刷列表 */
  remove: () => Promise<void>;
};

export function WorkOrderDetail({
  detail,
  busy,
  error,
  actions,
}: {
  detail: WorkOrderDetailView;
  busy: boolean;
  error: ApiError | null;
  actions: WorkOrderDetailActions;
}) {
  const { order, commission, subjects, logs } = detail;
  /*
    能力集合兜底：服务端每条返回详情的路由都带 capabilities（services/work-orders.mjs 的
    detailFor）。这里再兜一层是**不让一个字段缺失把整页打成白屏** ——
    按钮不出现，比整页报错好排查。
  */
  const capabilities: WorkOrderDetailView["capabilities"] = detail.capabilities ?? {
    canAssign: false,
    canViewFull: false,
    assigned: false,
    isLeader: false,
    canEditEnvironment: false,
    canValidate: false,
    canDispatch: false,
    canPause: false,
    canResume: false,
    canStart: false,
    canSubmit: false,
    canAccept: false,
    canArchive: false,
  };
  /** 未指派到此工单：委托原文与随单附件按项目可见范围控制（PRD §6.1） */
  const restricted = Boolean(detail.restricted);
  /** 委托正文长，默认收起（§5.1「长正文可展开」） */
  const [requirementsOpen, setRequirementsOpen] = useState(false);
  /** 删除确认：不可恢复的动作必须再问一次 */
  const [deleteOpen, setDeleteOpen] = useState(false);

  const window =
    order.plannedStart && order.plannedEnd && order.plannedStart !== order.plannedEnd
      ? `${order.plannedStart} 至 ${order.plannedEnd}`
      : (order.plannedStart ?? "—");

  return (
    <>
      <Panel
        title={`工单摘要 · ${order.orderNo}`}
        extra={<StatusChip text={order.status} tone={WORK_ORDER_STATUS_TONE[order.status] ?? "info"} />}>
        <KV
          columns={3}
          items={[
            { k: "工单编号", v: order.orderNo },
            { k: "标题", v: order.title },
            { k: "状态", v: <StatusChip text={order.status} tone={WORK_ORDER_STATUS_TONE[order.status] ?? "info"} /> },
            { k: "计划作业时间", v: window },
            { k: "地点", v: order.location },
            { k: "平台创建时间", v: order.createdAt.replace("T", " ").slice(0, 16) },
            {
              k: "负责人",
              v: detail.assignment ? (
                <>
                  {detail.assignment.leaderLabel}
                </>
              ) : (
                "未指派"
              ),
            },
            { k: "交付内容", v: order.deliveryText || "—" },
            { k: "来源", v: order.source === "shortcut" ? <SourceTag label="小木接单转换" /> : <SourceTag /> },
          ]}
        />

        {/* 状态动作随当前账号与状态变化，不适用就不出现（§5.1 / §8.1） */}
        <div className="wop-actions">
          {STATUS_ACTIONS.filter((item) => capabilities[item.capability]).map((item) => (
            <Btn
              key={item.action}
              tone={item.tone ?? "default"}
              disabled={busy}
              onClick={() => void actions.setStatus(item.action)}>
              {item.label}
            </Btn>
          ))}
          {/*
            删除是清场动作：不放进状态机（它不是一种「状态」），
            但同样只有项目经理看得到，并且必须过一道二次确认。
          */}
          {capabilities.canDelete ? (
            <Btn tone="danger" disabled={busy} onClick={() => setDeleteOpen(true)}>
              删除工单
            </Btn>
          ) : null}
          {order.status === "已暂停" && order.pausedFrom ? (
            <span className="muted">暂停前状态：{order.pausedFrom}；暂停期间不新下发、不启动采集</span>
          ) : null}
          {!capabilities.assigned && !capabilities.canAssign ? (
            <span className="muted">尚未指派到此工单</span>
          ) : null}
        </div>

        {error ? <p className="wop-error">{error.message}</p> : null}
      </Panel>

      <Panel
        title="委托要求与检测主体"
        extra={<span className="muted">{commission.unit} · {commission.date}</span>}>
        <KV
          columns={3}
          items={[
            { k: "委托单位", v: commission.unit },
            { k: "委托日期", v: commission.date },
            { k: "委托编号／文号", v: commission.no ?? "—" },
            { k: "项目名称", v: commission.projectName },
            { k: "检测地点", v: order.location },
            { k: "计划作业时间", v: window },
            { k: "交付内容", v: commission.deliveryText },
            { k: "现场对接", v: `${commission.contact.role} · ${commission.contact.channel}` },
            { k: "检测主体", v: `${commission.subjectNote}（共 ${subjects.length} 根）` },
          ]}
        />

        <h4 className="sub">
          单位原始要求
          {restricted ? null : (
            <button
              type="button"
              className="wop-more"
              onClick={() => setRequirementsOpen((open) => !open)}>
              {requirementsOpen ? "收起正文" : "展开正文"}
            </button>
          )}
        </h4>
        {restricted ? (
          <StateBlock kind="empty" title="尚未指派到此工单" />
        ) : (
          <>
            <p className={`wop-requirements ${requirementsOpen ? "is-open" : ""}`}>{order.requirementsText}</p>
          </>
        )}

        <h4 className="sub">平台检测主体清单</h4>
        <DataTable
          head={["平台编号", "主体 ID", "主体", "位置", "检测记录"]}
          rows={subjects.map((subject) => [
            <b key={`${subject.subjectId}-code`}>{subject.code}</b>,
            <code key={`${subject.subjectId}-id`} className="wop-subject-id">
              {subject.subjectId}
            </code>,
            subject.name,
            subject.position ?? "待定位",
            "未采集",
          ])}
        />

        <h4 className="sub">原始委托附件</h4>
        {restricted ? (
          <StateBlock kind="empty" title="附件不可见" />
        ) : commission.attachments.length ? (
          <ul className="wop-attachments">
            {commission.attachments.map((item) => (
              <li key={item.assetId}>
                <b>{item.name}</b>
                <em>
                  {item.kind} · {item.sizeText}
                </em>
                <SourceTag label="单位随单资料" />
              </li>
            ))}
          </ul>
        ) : (
          <StateBlock kind="empty" title="没有随单附件" />
        )}
      </Panel>

      <AssignmentPanel
        detail={detail}
        busy={busy}
        onAssign={async (body) => {
          await actions.assign(body);
        }}
      />

      <div className="orders-two">
        <EnvironmentPanel
          detail={detail}
          busy={busy}
          onSave={async (body) => {
            await actions.saveEnvironment(body);
          }}
          onValidate={async (expectedRevision) => {
            await actions.validateEnvironment(expectedRevision);
          }}
        />
        <DispatchPanel
          detail={detail}
          busy={busy}
          onDispatch={async (body) => {
            await actions.dispatch(body);
          }}
        />
      </div>

      {deleteOpen ? (
        <Modal
          title={`删除工单 ${order.orderNo}`}
          subtitle="删除后不可恢复"
          onClose={() => setDeleteOpen(false)}
          footer={
            <>
              <span className="muted">
                主体编号、指派、环境版本与下发记录一并删除
                {detail.dispatches.some((item) => item.state === "executed") ? "；设备侧已应用的副本不会撤回" : ""}
              </span>
              <Btn onClick={() => setDeleteOpen(false)}>取消</Btn>
              <Btn
                tone="danger"
                disabled={busy}
                onClick={() => {
                  void actions.remove();
                }}>
                删除
              </Btn>
            </>
          }>
          <p>
            确认删除工单 <b>{order.orderNo}</b>？该工单的四条主体记录、指派历史、环境草稿与配置版本、
            下发记录和操作日志会一起删除，之后无法找回。
          </p>
        </Modal>
      ) : null}

      <Panel
        title="作业记录与成果"
        extra={<span className="muted">{logs.length} 条记录</span>}>
        <StateBlock kind="empty" title="本单还没有作业记录" />
        {logs.length ? (
          <ol className="order-logs">
            {logs.map((item) => (
              <li key={`${item.at}-${item.type}-${item.text}`}>
                <time>{item.at.replace("T", " ").slice(0, 16)}</time>
                <b>{item.actorLabel}</b>
                <span>{item.text}</span>
                <em>{item.type}</em>
              </li>
            ))}
          </ol>
        ) : null}
      </Panel>
    </>
  );
}
