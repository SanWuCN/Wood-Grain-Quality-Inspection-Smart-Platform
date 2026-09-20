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
  MissionEntity,
  WorkOrderAction,
  WorkOrderDetail as WorkOrderDetailView,
} from "../api/client";
import { Panel } from "../Panel";
import { useOrderReveal } from "../ordersReveal";
import { WORK_ORDER_STATUS_TONE } from "./overview.constants";
import { Btn, DataTable, KV, Modal, SourceTag, StateBlock, StatusChip } from "../ui";
import { recognizeEntry, recognizeOrder } from "./orders/orderRecognize";
import { AssignmentPanel } from "./orders/AssignmentPanel";
import { TaskScopePanel } from "./orders/TaskScopePanel";
import { EnvironmentPanel } from "./orders/EnvironmentPanel";
import { DispatchPanel } from "./orders/DispatchPanel";
import { CruiseTaskPanel } from "./orders/CruiseTaskPanel";
import { OrderDeliverablesPanel } from "./orders/OrderDeliverablesPanel";
import {
  DELIVERABLE_SECTIONS,
  DELIVERABLE_TITLES,
  draftOrderBlocks,
  reviewBlocks,
  summaryBlocks,
} from "./orders/orderDeliverables";
import type { CruiseDispatchBody } from "../store/cruise";
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
  /*
    自主巡航任务（用户 2026-09-18）：下发 / 接受 / 完成 / 撤销。
    四条都走命令总线（`mission.*`），调用方负责发命令与报错，这一层只负责按钮与预览。
  */
  dispatchCruise: (body: CruiseDispatchBody) => Promise<void>;
  acceptCruise: () => Promise<void>;
  completeCruise: () => Promise<void>;
  cancelCruise: () => Promise<void>;
};

export function WorkOrderDetail({
  detail,
  busy,
  error,
  actions,
  cruiseMission = null,
  cruiseHistory = [],
  canDispatchCruise = false,
  canMonitorCruise = false,
}: {
  detail: WorkOrderDetailView;
  busy: boolean;
  error: ApiError | null;
  actions: WorkOrderDetailActions;
  /** 本单当前该盯的自主巡航任务（未结束优先）；没有就是 null */
  cruiseMission?: MissionEntity | null;
  /** 本单的历史巡航任务（最新在前） */
  cruiseHistory?: MissionEntity[];
  canDispatchCruise?: boolean;
  canMonitorCruise?: boolean;
}) {
  const { order, commission, subjects, logs } = detail;
  /**
   * 「随播报逐步加载」：agent 念这张工单时，分区按台词节奏逐段揭示。
   *
   * 没有揭示计划时（用户自己点进工单 / 从地图跳进来 / 刷新页面）恒为 `Infinity`，
   * 三个分区都带 `is-in`，页面上看不出任何差别 —— 演示效果不会传染成"页面少了内容"。
   */
  /*
    揭示门控（v1.1：**按组名**，不再按计数）。

    `revealed === null` 表示"完整显示"——没有计划（用户自己点进工单 / 刷新）、
    或计划不属于这张工单时的默认值。只有 agent 明确登记过的那一次播报期间，
    才会逐组揭示。"演示效果"因此不会传染成"页面少了内容"。

    组名与 `script.ts` 第①轮的 `reveal.sections` / `ordersReveal.ts` 的
    `ORDER_DETAIL_SECTIONS` 一一对应：
      order   → 工单摘要
      scope   → 委托要求与检测主体
      tasks   → 任务范围与出发清单（四项任务 + 出发清单 + 待现场确认）
      pending → 待确认信息、检测主体清单、附件、人员、环境、下发、作业成果
    `pending` 一次带出较多，是因为交接文档把它们归在同一个播报节点下
    （见「模块展开节拍」表末行）；空态本身也是确定性事实，不算提前展示。
  */
  const revealed = useOrderReveal(order.id);
  const revealGate = (key: string) =>
    revealed === null || revealed.includes(key) ? "wop-reveal is-in" : "wop-reveal";
  /**
   * 「小木生成物」三块（㉓㉔㉕）的门控：**任一**子组被揭示，整块面板就出现。
   *
   * 为什么按"任一"而不是"全部"：面板的标题与来源行属于这一轮的开场
   * （「工单草稿已生成」），念到第一小句就该看见它；里面的三/四块各自再按拍点出现。
   * 播报期间没轮到的两份生成物整块不渲染（`display:none`），
   * 所以观众看到的是"这一轮多出来一块"，而不是三块长得一样的面板。
   */
  const revealGateAny = (keys: readonly string[]) =>
    revealed === null || keys.some((key) => revealed.includes(key)) ? "wop-reveal is-in" : "wop-reveal";
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
  /** 归档确认：同样是终态（没有"撤销归档"迁移），点错了只能重建工单 */
  const [archiveOpen, setArchiveOpen] = useState(false);
  /**
   * 「工单识别」点了却没演起来时的可恢复提示（正常情况下恒为 null）。
   *
   * 为什么要有它：小木那一轮要靠条目表 + 事件通道才能跑起来，任何一环缺失
   * （列表还没拉回来、条目被改坏）都只会**静默不动**。按钮点了没反应是现场
   * 最难查的一类问题，所以宁可在页面留一行字，也不要让讲解人对着屏幕猜。
   */
  const [recognizeHint, setRecognizeHint] = useState<string | null>(null);
  /** 剧本 §9 括号里那句（唯一来源 = 条目表，见 orders/orderRecognize.ts） */
  const recognizeLine = recognizeEntry()?.text ?? "";

  const window =
    order.plannedStart && order.plannedEnd && order.plannedStart !== order.plannedEnd
      ? `${order.plannedStart} 至 ${order.plannedEnd}`
      : (order.plannedStart ?? "—");

  return (
    <>
      <Panel
        className={revealGate("order")}
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
          {/*
            ── 工单识别（剧本 §9：史点击工单识别）───────────────────────────
            文档原文：「（史点击工单识别；小木读取当前工单与附件索引，生成任务卡和
            装备核对清单，未填字段标为待补。）」此前平台上没有这个按钮，
            剧本要求"点"的地方只能用快捷键代替。现在它就是真的点击：
            按下 → 把**这张**工单绑给小木 → 第②轮播报 + 工单页逐组展开
            （展开的四组正好是摘要 / 委托与主体 / 任务范围与出发清单 / 待确认信息）。

            未指派到此工单时按钮置灰：这一档只给摘要，委托正文与附件索引不展示，
            小木也就不该"读出"它 —— 与下面「单位原始要求」的空态同一口径。
          */}
          <Btn
            tone="primary"
            disabled={busy || restricted}
            title={
              restricted
                ? "尚未指派到此工单，委托正文与附件不展示"
                : `小木读取这份工单${recognizeLine ? `：${recognizeLine}` : ""}`
            }
            onClick={() => {
              setRecognizeHint(
                recognizeOrder(order.id)
                  ? null
                  : "小木暂时读不到这张工单（列表未就绪或剧本条目缺失），请刷新页面后重试",
              );
            }}>
            工单识别
          </Btn>
          {recognizeHint ? <span className="muted">{recognizeHint}</span> : null}
          {STATUS_ACTIONS.filter((item) => capabilities[item.capability]).map((item) => (
            <Btn
              key={item.action}
              tone={item.tone ?? "default"}
              disabled={busy}
              /*
                ⚠ 「归档」要再过一次确认（用户 2026-10-01：「平台得能把工单归档」）。
                归档是**终态**（没有"撤销归档"这条迁移），点错了只能重建工单 ——
                与删除同一条口径：不可恢复的动作必须再问一次。
                其余状态动作（开始/提交验收/暂停/恢复）都可逆，保持一键。
              */
              onClick={() => {
                if (item.action === "archive") {
                  setArchiveOpen(true);
                  return;
                }
                void actions.setStatus(item.action);
              }}>
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

      {/*
        ── 小木生成物（用户口径 2026-10-01）──────────────────────────────
        「平台最后几个对话需要更好的平台展示，而不只是跳转下页面」。
        ㉓㉔㉕ 分别生成**工单草稿 / 复盘草稿 / 交付摘要**，三份是不同的东西，
        所以各给一块面板（数据与来源见 `orders/orderDeliverables.ts`），
        台词念到哪一小句、面板里哪一块出现（拍点表在 `script.ts` 的 `reveal.beats`）。

        ⚠ 位置紧跟工单摘要、**在委托要求之前**：委托要求那块很长（委托单位/检测范围/
        原始要求正文本），放在它后面的话，这三轮的主角内容会落在首屏之外 ——
        投屏上就成了"跳过来什么都没看见"，正是用户要修的那个问题。
        没有播报计划时（人自己点进来）三块都在，页面顺序仍读得通：
        摘要 → 生成物 → 委托要求 → 任务范围 → 执行与成果。
      */}
      <OrderDeliverablesPanel
        className={revealGateAny(DELIVERABLE_SECTIONS.draft)}
        title={DELIVERABLE_TITLES.draft.title}
        roundNo={DELIVERABLE_TITLES.draft.roundNo}
        subtitle="复核位置 · 附件 · 处理建议"
        blocks={draftOrderBlocks()}
        gate={revealGate}
      />
      <OrderDeliverablesPanel
        className={revealGateAny(DELIVERABLE_SECTIONS.review)}
        title={DELIVERABLE_TITLES.review.title}
        roundNo={DELIVERABLE_TITLES.review.roundNo}
        subtitle="任务完成情况 · 异常处置 · 版本交付 · 后续待办"
        blocks={reviewBlocks({ orderNo: order.orderNo, status: order.status, title: order.title })}
        gate={revealGate}
      />
      <OrderDeliverablesPanel
        className={revealGateAny(DELIVERABLE_SECTIONS.summary)}
        title={DELIVERABLE_TITLES.summary.title}
        roundNo={DELIVERABLE_TITLES.summary.roundNo}
        subtitle="文件校验 · 待办清单 · 关联与审核"
        blocks={summaryBlocks({ orderNo: order.orderNo, status: order.status, title: order.title })}
        gate={revealGate}
      />

      <Panel
        className={revealGate("scope")}
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

      {/*
        第③组：任务范围与出发清单。
        接在"委托要求"之后、执行模块之前 —— 对应第①轮台词第③段
        「已整理为四项任务：现场建档、风险初筛、重点精扫和复核交付」。
        内容全部来自受控配置（`orders/taskScope.ts`），本组件只负责何时显示它。
      */}
      <TaskScopePanel className={revealGate("tasks")} />

      <AssignmentPanel
        className={revealGate("pending")}
        detail={detail}
        busy={busy}
        onAssign={async (body) => {
          await actions.assign(body);
        }}
      />

      <div className="orders-two">
        <EnvironmentPanel
          className={revealGate("pending")}
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
          className={revealGate("pending")}
          detail={detail}
          busy={busy}
          onDispatch={async (body) => {
            await actions.dispatch(body);
          }}
        />
      </div>

      {/*
        自主巡航任务（用户 2026-09-18）：与「扫描仪下发」并排之上单独一块 —— 它有预览与
        任务编号，横着铺才看得清；揭示门控与其它执行块同一组（念到那一拍才出现）。
      */}
      <CruiseTaskPanel
        className={revealGate("pending")}
        detail={detail}
        mission={cruiseMission}
        history={cruiseHistory}
        canDispatch={canDispatchCruise}
        canMonitor={canMonitorCruise}
        busy={busy}
        onDispatch={async (body) => {
          await actions.dispatchCruise(body);
        }}
        onAccept={async () => {
          await actions.acceptCruise();
        }}
        onComplete={async () => {
          await actions.completeCruise();
        }}
        onCancel={async () => {
          await actions.cancelCruise();
        }}
      />

      {/*
        归档确认（用户 2026-10-01：「平台得能把工单归档」）。
        状态机里归档是**终态**：服务端没有"撤销归档"这条迁移，主体/环境/指派也都改不动了。
        所以这里把"归档之后会发生什么"说清楚，再让人点一下 —— 与删除同一个口径。
      */}
      {archiveOpen ? (
        <Modal
          title={`归档工单 ${order.orderNo}`}
          subtitle="归档后进入「已归档」，不再出现在「待指派 / 进行中」筛选里"
          onClose={() => setArchiveOpen(false)}
          footer={
            <>
              <span className="muted">
                归档是终态：当前没有「撤销归档」；未完成的派发会标记为「工单已归档」
                {logs.length ? `；操作日志保留 ${logs.length} 条` : ""}
              </span>
              <Btn onClick={() => setArchiveOpen(false)}>取消</Btn>
              <Btn
                tone="danger"
                disabled={busy}
                onClick={() => {
                  setArchiveOpen(false);
                  void actions.setStatus("archive");
                }}>
                确认归档
              </Btn>
            </>
          }>
          <p>
            确认把工单 <b>{order.orderNo}</b>（当前状态「{order.status}」）归档？
            归档后它仍可在「报告归档」「知识库」与工单列表的「已归档」筛选里查到，操作日志与附件都保留，
            但**不能再改指派、环境读数或状态**。
          </p>
        </Modal>
      ) : null}

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
        className={revealGate("pending")}
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
