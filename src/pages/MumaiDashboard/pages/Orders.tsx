/**
 * 工单档案（`/orders`）
 *
 * 两条来路的工单在这一页并排存在，但**不混为一谈**：
 *   1. 本期新流程（PRD-工单指派与扫描仪下发-v1.0）：隐藏快捷键 → 小木接单转换 →
 *      待指派 → 指派 → 空环境读数 → 校验出版本 → 下发扫描仪。列表按
 *      「待指派 / 进行中 / 已归档」筛选 + 单号搜索；详情六块（摘要、委托与主体、
 *      指派、环境、下发、成果）。
 *   2. 演示回放的旧工单：仍是浏览器里的种子数据（当前工单、草稿、历史工单），
 *      内容一字不改地保留，收在「演示回放工单」里，点开还是原来那套详情。
 *
 * 为什么不把旧工单迁进服务端：`seed/scenario.ts` 里那几张单被总览页、地图点位、
 * 小木回答同时引用着，迁移会连带改一圈不在本期的页面；而 PRD §10 也明确
 * 「历史演示工单保留原值及来源标记，不能迁移成新工单的默认值」。
 *
 * 环境记录：旧单继续用共享会话的配置流程；新单走**按工单**的草稿与不可变版本
 * （`/api/work-orders/{id}/environment-*`），两边互不覆盖。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import NumberAnimation from "@/components/numberAnimation";
import { useMumai } from "../context";
import { isReadOnlyPath, permissionHint } from "../auth";
import { WorkOrderCreateModal } from "./WorkOrderCreate";
import { WorkOrderDetail, type WorkOrderDetailActions } from "./WorkOrderDetail";
import { Panel } from "../Panel";
import { Icon } from "../icons";
import { Btn, DataTable, KV, Modal, PermNote, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import {
  CONFIG_DIFF,
  ENV_HISTORY,
  ENV_RECORD,
  HH_PRIOR,
  MEMBERS,
  ORDER_LOGS,
} from "../seed/scenario";
import { isApiError } from "../api/client";
import type { ApiError, WorkOrderAction } from "../api/client";
import { environmentHistory, isOnline, latestEnvironment, useSharedStore } from "../store/shared";
import { useWorkOrderStore } from "../store/workOrders";
import { ORDER_STATUS_TONE, WORK_ORDER_STATUS_TONE } from "./overview.constants";
import type { EnvRecord, OrderStatus } from "../seed/types";

type Check = { key: string; label: string; ok: boolean; message: string; field?: string };

/** 环境校验：PRD 3.1 的硬规则，逐条给出结论，不做「通过/不通过」一个总分 */
function validateEnv(record: EnvRecord): Check[] {
  const range = record.instrumentRange;
  const inRange =
    record.airTempC >= range.min && record.airTempC <= range.max;
  return [
    {
      key: "humidity",
      label: "相对湿度 0 ≤ RH ≤ 100",
      ok: record.relativeHumidityPct >= 0 && record.relativeHumidityPct <= 100,
      field: "relativeHumidityPct",
      message: `当前 ${record.relativeHumidityPct}%（断言 0 <= relative_humidity_pct <= 100）`,
    },
    {
      key: "wind",
      label: "风速非负",
      ok: record.windSpeedMs >= 0,
      field: "windSpeedMs",
      message: `当前 ${record.windSpeedMs} m/s（仅作采集稳定性记录）`,
    },
    {
      key: "temp",
      label: `温度在仪表量程 ${range.min}–${range.max} ${range.unit} 内`,
      ok: inRange,
      field: "airTempC",
      message: `当前 ${record.airTempC} ℃`,
    },
    {
      key: "instrument",
      label: "仪表编号与测量位置已登记",
      ok: Boolean(record.instrumentId) && Boolean(record.position),
      field: "instrumentId",
      message: `${record.instrumentId || "未登记"} · ${record.position || "未登记"}`,
    },
  ];
}

/** 把一份环境实体的输入回填成表单值（服务端回来的字段可能比表单多） */
function toDraft(inputs: Record<string, unknown> | undefined, fallback: EnvRecord): EnvRecord {
  if (!inputs) return fallback;
  return {
    ...fallback,
    airTempC: Number(inputs.airTempC ?? fallback.airTempC),
    relativeHumidityPct: Number(inputs.relativeHumidityPct ?? fallback.relativeHumidityPct),
    windSpeedMs: Number(inputs.windSpeedMs ?? fallback.windSpeedMs),
    instrumentId: String(inputs.instrumentId ?? fallback.instrumentId),
    position: String(inputs.position ?? fallback.position),
    measuredAt: String(inputs.measuredAt ?? fallback.measuredAt),
  };
}

/**
 * 共享服务回来的环境输入是 `unknown`（服务端字段比表单多）。
 *
 * 能当数用的才交给 `NumberAnimation` 滚；不是数就返回 `null`，由调用点把
 * **原来那段文本**当 `fallback` 传回去 —— 显示内容与改造前逐字一致。
 */
function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 列表筛选口径（与服务端 STATUS_FILTERS 一一对应） */
const FILTERS: { key: "all" | "assign" | "active" | "archived"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "assign", label: "待指派" },
  { key: "active", label: "进行中" },
  { key: "archived", label: "已归档" },
];

export default function Orders() {
  const {
    orders,
    currentOrder,
    draftOrder,
    componentById,
    setOrderStatus,
    confirmDraftOrder,
    createOrder,
    toast,
    pushEvent,
    can,
    accountId,
  } = useMumai();

  /** 只读查阅：能进这一页，但本页没有任何可执行动作（评审 F04 的放权口径） */
  const readOnly = isReadOnlyPath(accountId, "/orders");

  /* ---- 建单弹窗：表单在二级，一级页面只放一个「生成工单」按钮（演示回放的内部建单路径） ---- */
  const [createOpen, setCreateOpen] = useState(false);
  /** 操作记录弹窗：历史记录下沉，一级页面只留最近一条 */
  const [logOpen, setLogOpen] = useState(false);
  /** 环境读数录入弹窗：六个输入框不在一级页面上 */
  const [envOpen, setEnvOpen] = useState(false);
  /** 历史工单默认展开：这一页要一眼看到「已有多少单、各在什么状态」 */
  const [legacyOpen, setLegacyOpen] = useState(true);

  /**
   * 工单号由**已有列表 + 草稿单**一起推导，弹窗不自己编。
   *
   * 只扫 `orders` 会漏掉种子里那张还没确认的草稿 WO-2026-0912，
   * 于是第一张新建单会拿到 WO-2026-0001 —— 编号看着像倒退了。
   */
  const nextOrderId = useMemo(() => {
    const numbers = [...orders.map((item) => item.id), draftOrder.id]
      .map((id) => /^WO-(\d{4})-(\d{4})$/.exec(id))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[2]));
    const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
    return `WO-2026-${String(next).padStart(4, "0")}`;
  }, [draftOrder.id, orders]);

  const [params, setParams] = useSearchParams();
  const paramOrder = params.get("order");

  /* ---------------- 新流程工单（服务端权威） ---------------- */

  const serverOrders = useWorkOrderStore((state) => state.orders);
  const serverDetail = useWorkOrderStore((state) => state.detail);
  const filter = useWorkOrderStore((state) => state.filter);
  const query = useWorkOrderStore((state) => state.query);
  const loading = useWorkOrderStore((state) => state.loading);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  /**
   * 列表加载：首次进入、切换筛选、搜索输入停止 300ms 后各拉一次。
   * 三条路走同一个 effect —— 筛选与搜索都在服务端做，前端不再各写一遍过滤。
   */
  useEffect(() => {
    const timer = window.setTimeout(() => void useWorkOrderStore.getState().refresh(), 300);
    return () => window.clearTimeout(timer);
  }, [query, filter]);

  /**
   * 登录完成后再拉一次。
   *
   * 页面挂载可能早于 `/api/auth/login`（共享 store 的 init 是异步的），
   * 那一次刷新会拿到 401；不补这一次，列表就要等用户手动点筛选才出来。
   */
  const sharedOnline = useSharedStore(isOnline);
  useEffect(() => {
    if (!sharedOnline) return;
    void useWorkOrderStore.getState().refresh();
  }, [sharedOnline]);

  /**
   * 当前选中的新工单：URL 上的 `order` 命中服务端列表才用服务端详情，
   * 否则回落到演示回放的旧工单 —— 两套工单号长得像（都有 WO- 前缀），
   * 所以判据是**列表里有没有**，不是正则长得像不像。
   */
  const serverMatch = useMemo(
    () => serverOrders.find((item) => item.id === paramOrder || item.orderNo === paramOrder) ?? null,
    [serverOrders, paramOrder],
  );
  const activeServerId = serverMatch?.id ?? (paramOrder === null ? (serverOrders[0]?.id ?? null) : null);

  useEffect(() => {
    if (!activeServerId) return;
    if (serverDetail?.order.id === activeServerId) return;
    void useWorkOrderStore.getState().select(activeServerId);
  }, [activeServerId, serverDetail?.order.id]);

  const showServerOrder = Boolean(activeServerId && serverDetail?.order.id === activeServerId);

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("order", id);
    setParams(next, { replace: true });
  };

  /** 所有新流程动作走同一个入口：忙态、错误 toast 与错误块的处理只有一处 */
  const runAction = useCallback(
    async (work: () => Promise<unknown>, okText?: string) => {
      setBusy(true);
      setActionError(null);
      try {
        await work();
        if (okText) toast(okText, "ok");
      } catch (error) {
        const apiError: ApiError = isApiError(error)
          ? error
          : { status: 0, code: "UNKNOWN", message: error instanceof Error ? error.message : "操作失败", fieldErrors: [], retryable: false };
        setActionError(apiError);
        toast(apiError.message, "danger");
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const orderActions = useMemo<WorkOrderDetailActions>(
    () => ({
      assign: async (body: { leaderAccountId: string; members: { accountId: string; duties: string[] }[]; expectedRevision: number }) => {
        if (!serverDetail) return;
        await runAction(async () => {
          const next = await useWorkOrderStore.getState().assign(serverDetail.order.id, body);
          pushEvent(`工单 ${next.order.orderNo} 指派负责人：${next.assignment?.leaderLabel ?? "—"}`, "ok");
        }, "指派已生效，被指派的人现在可以执行对应操作");
      },
      saveEnvironment: async (body: Parameters<typeof import("../api/client").api.saveWorkOrderEnvironment>[1]) => {
        if (!serverDetail) return;
        await runAction(() => useWorkOrderStore.getState().saveEnvironment(serverDetail.order.id, body), "环境草稿已保存");
      },
      validateEnvironment: async (expectedRevision: number) => {
        if (!serverDetail) return;
        await runAction(async () => {
          await useWorkOrderStore.getState().validateEnvironment(serverDetail.order.id, expectedRevision);
        }, "校验通过，已生成配置版本（还需要下发扫描仪）");
      },
      dispatch: async (body: { deviceId: string; configVersion?: string | null; idempotencyKey: string }) => {
        if (!serverDetail) return;
        await runAction(async () => {
          await useWorkOrderStore.getState().dispatch(serverDetail.order.id, body);
        }, "已提交下发，等待扫描仪接收（accepted → executed）");
      },
      setStatus: async (action: WorkOrderAction) => {
        if (!serverDetail) return;
        await runAction(async () => {
          await useWorkOrderStore.getState().setStatus(serverDetail.order.id, action);
        });
      },
      remove: async () => {
        if (!serverDetail) return;
        const orderNo = serverDetail.order.orderNo;
        await runAction(async () => {
          await useWorkOrderStore.getState().remove(serverDetail.order.id);
          /*
            选中项没了：把 URL 上的 order 参数去掉，回到列表默认选中。
            用函数式更新拿当前参数，不闭包捕获 `params` —— 否则删第二张时要靠
            memo 重建才会拿到新值，中间那一次会写回旧的查询串。
          */
          setParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.delete("order");
              return next;
            },
            { replace: true },
          );
          pushEvent(`删除工单 ${orderNo}`, "warn");
        }, `工单 ${orderNo} 已删除`);
      },
    }),
    [pushEvent, runAction, serverDetail, setParams],
  );

  /* ---------------- 演示回放的旧工单 ---------------- */

  const legacySelected = useMemo(
    () => orders.find((item) => item.id === paramOrder) ?? currentOrder,
    [orders, paramOrder, currentOrder],
  );

  /* ---- 环境配置改为读共享服务：四端同一版本，刷新不回退（评审 F01） ---- */

  const envEntity = useSharedStore(latestEnvironment);
  const envVersions = useSharedStore(environmentHistory);
  const online = useSharedStore(isOnline);
  const sharedStatus = useSharedStore((state) => state.status);
  const sharedError = useSharedStore((state) => state.connectionError);

  const [draftEnv, setDraftEnv] = useState<EnvRecord>(() => toDraft(envEntity?.data.inputs, ENV_RECORD));
  const [ran, setRan] = useState(false);
  const [envBusy, setEnvBusy] = useState<"validate" | "receive" | null>(null);
  /** 字段级错误：v1.1 §5.2 要求错误显示在字段旁，不只弹 toast */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [actionErrorLegacy, setActionErrorLegacy] = useState<string | null>(null);

  /**
   * 服务端版本变化时把表单同步过来 —— 但**只在用户还没开始改的时候**，
   * 否则另一端发布一次就会把本地正在填的输入冲掉。
   */
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setDraftEnv(toDraft(envEntity?.data.inputs, ENV_RECORD));
  }, [envEntity?.id, envEntity?.revision, envEntity?.data.inputs, dirty]);

  const checks = useMemo(() => validateEnv(draftEnv), [draftEnv]);

  const publishedState = envEntity?.data.state ?? null;
  const configVersion = envEntity?.data.version ?? null;
  const deviceAck = publishedState === "received" || publishedState === "verified";

  /** 字段级错误优先用服务端返回的（它是权威判据），本地校验只做即时反馈 */
  const errorFor = (field: string) => fieldErrors[field];

  const patch = (next: Partial<EnvRecord>) => {
    setDirty(true);
    setDraftEnv((current) => ({ ...current, ...next }));
  };

  /** 运行校验：先在服务端验一遍，通过了就直接发布成不可变版本 */
  const runValidate = useCallback(async () => {
    if (!online) {
      setActionErrorLegacy("连接不上共享服务，配置无法发布给其他端");
      return;
    }
    setEnvBusy("validate");
    setActionErrorLegacy(null);
    setFieldErrors({});
    try {
      const result = await useSharedStore.getState().send({
        action: "environment.publish",
        payload: {
          inputs: {
            airTempC: draftEnv.airTempC,
            relativeHumidityPct: draftEnv.relativeHumidityPct,
            windSpeedMs: draftEnv.windSpeedMs,
            instrumentId: draftEnv.instrumentId,
            position: draftEnv.position,
            measuredAt: draftEnv.measuredAt,
            instrumentRange: draftEnv.instrumentRange,
          },
          methodVersion: HH_PRIOR.functionVersion,
        },
      });
      setRan(true);
      setDirty(false);
      toast(`校验通过，已发布配置版本 ${result.result.version}`, "ok");
      pushEvent(`环境配置 ${result.result.version} 已发布，等待全栈接收`, "ok");
    } catch (error) {
      setRan(true);
      if (isApiError(error)) {
        // 422 会把每个不合格字段单独列出来，直接贴到对应输入框下面
        const map: Record<string, string> = {};
        error.fieldErrors.forEach((item) => {
          map[item.field] = item.message;
        });
        setFieldErrors(map);
        setActionErrorLegacy(error.fieldErrors.length ? null : error.message);
        toast(error.code === "VALIDATION_FAILED" ? "校验未通过，请修正标红字段" : error.message, "danger");
      } else {
        setActionErrorLegacy("校验请求失败");
      }
    } finally {
      setEnvBusy(null);
    }
  }, [draftEnv, online, pushEvent, toast]);

  /** 全栈接收：写回服务端，沈那一端随后能看到「已接收」 */
  const receive = useCallback(async () => {
    if (!envEntity) return;
    setEnvBusy("receive");
    setActionErrorLegacy(null);
    try {
      await useSharedStore.getState().send({
        action: "environment.receive",
        entityId: envEntity.id,
        expectedRevision: envEntity.revision,
        payload: {},
      });
      toast(`${envEntity.id} 已接收并返回 ack`, "ok");
      pushEvent(`全栈接收配置 ${envEntity.id} 并返回 ack`, "ok");
    } catch (error) {
      const message = isApiError(error) ? error.message : "接收失败";
      setActionErrorLegacy(message);
      toast(message, "danger");
    } finally {
      setEnvBusy(null);
    }
  }, [envEntity, pushEvent, toast]);

  return (
    <div className="page page--orders">
      <Toolbar
        note={
          <>
            <SourceTag label="演示回放" />
            {readOnly ? (
              // 放权之后必须说明「你在这里只能看」，否则一排灰按钮只会让人猜原因
              <span>只读查阅：工单与配置可看，本页审核动作需要工单审核权限</span>
            ) : (
              <span>单位委托转入后自动建立工单</span>
            )}
          </>
        }>
        {/* PRD 2.1：工单审核（建单、确认草稿、暂停、归档）属于项目经理的职责 */}
        <Btn
          tone="primary"
          disabled={!can("order:review")}
          title={can("order:review") ? "打开建单窗口，填地点、构件与来源风险后生成" : permissionHint("order:review")}
          onClick={() => setCreateOpen(true)}>
          生成工单
        </Btn>
        <Btn
          disabled={!can("order:review")}
          title={can("order:review") ? "确认后进入待复核" : permissionHint("order:review")}
          onClick={() => {
            confirmDraftOrder();
            toast(`草稿工单 ${draftOrder.id} 已提交复核`, "ok");
            pushEvent(`工单 ${draftOrder.id} 确认进入待复核`, "ok");
          }}>
          确认草稿工单
        </Btn>
        {can("order:review") ? null : <small className="muted">{permissionHint("order:review")}</small>}
      </Toolbar>

      <div className="orders-layout">
        {/* 左：工单列表（新流程列表 + 演示回放工单分开） */}
        <aside className="orders-side">
          <Panel
            title="工单列表"
            extra={
              <small>
                <NumberAnimation value={serverOrders.length} /> 条
              </small>
            }>
            <div className="wop-filters" role="tablist" aria-label="工单筛选">
              {FILTERS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === item.key}
                  className={`wop-filter ${filter === item.key ? "is-active" : ""}`}
                  onClick={() => useWorkOrderStore.getState().setFilter(item.key)}>
                  {item.label}
                </button>
              ))}
            </div>
            <input
              className="wop-search"
              type="search"
              value={query}
              placeholder="搜索单号 / 地点"
              aria-label="搜索工单"
              onChange={(event) => useWorkOrderStore.getState().setQuery(event.target.value)}
            />
            <div className="orders-history">
              {serverOrders.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`order-item ${showServerOrder && serverDetail?.order.id === item.id ? "is-active" : ""}`}
                  onClick={() => select(item.id)}>
                  <b>{item.orderNo}</b>
                  <span>{item.title}</span>
                  <span>{item.location}</span>
                  <span className="wop-row__status">
                    <StatusChip text={item.status} tone={WORK_ORDER_STATUS_TONE[item.status] ?? "info"} />
                    <em>{item.leaderLabel ?? "未指派负责人"}</em>
                  </span>
                </button>
              ))}
              {!serverOrders.length && !loading ? (
                <StateBlock kind="empty" title="暂无工单" hint="单位委托转入后自动建立。" />
              ) : null}
            </div>
          </Panel>

          <Panel
            title="历史工单"
            extra={
              <button type="button" className="wop-more" onClick={() => setLegacyOpen((open) => !open)}>
                {legacyOpen ? "收起" : `展开 ${orders.length} 条`}
              </button>
            }>
            {legacyOpen ? (
              <div className="orders-history">
                {orders.map((order) => (
                  <button
                    key={order.id}
                    type="button"
                    className={`order-item ${!showServerOrder && legacySelected.id === order.id ? "is-active" : ""}`}
                    onClick={() => select(order.id)}>
                    <b>{order.id}</b>
                    <span>
                      {order.district} · {order.site}
                    </span>
                    <StatusChip text={order.status} tone={ORDER_STATUS_TONE[order.status]} />
                  </button>
                ))}
              </div>
            ) : null}
          </Panel>
        </aside>

        {/* 右：工单详情 */}
        <div className="orders-main">
          {showServerOrder && serverDetail ? (
            <WorkOrderDetail detail={serverDetail} busy={busy} error={actionError} actions={orderActions} />
          ) : (
            <>
              <Panel
                title={`工单详情 · ${legacySelected.id}`}
                extra={
                  <span className="fw-console__actions">
                    <StatusChip text={legacySelected.status} tone={ORDER_STATUS_TONE[legacySelected.status]} />
                    {/* 暂停 / 归档只在适用的旧工单上出现，新流程的状态动作在它自己的摘要面板里 */}
                    <Btn
                      disabled={!can("order:review")}
                      title={can("order:review") ? "暂停保留全部已生成记录" : permissionHint("order:review")}
                      onClick={() => {
                        setOrderStatus(legacySelected.id, "处理中" as OrderStatus);
                        toast("已暂停，所有已生成记录保留", "warn");
                        pushEvent(`工单 ${legacySelected.id} 暂停`, "warn");
                      }}>
                      暂停
                    </Btn>
                    <Btn
                      disabled={!can("order:review")}
                      title={can("order:review") ? "归档工单" : permissionHint("order:review")}
                      onClick={() => {
                        setOrderStatus(legacySelected.id, "已关闭" as OrderStatus);
                        toast("工单已归档", "ok");
                        pushEvent(`工单 ${legacySelected.id} 归档`, "ok");
                      }}>
                      归档
                    </Btn>
                  </span>
                }>
                <KV
                  items={[
                    { k: "地点", v: legacySelected.location },
                    { k: "检测范围", v: legacySelected.scope },
                    { k: "责任部门", v: legacySelected.owner },
                    { k: "来源风险", v: legacySelected.sourceRiskIds.join(" / ") || "—" },
                    { k: "创建时间", v: legacySelected.createdAt },
                    { k: "复巡计划", v: legacySelected.revisitPlanId ?? "未生成" },
                  ]}
                  columns={3}
                />

                <h4 className="sub">构件清单 Z01–Z04</h4>
                <DataTable
                  head={["构件", "部位", "外观记录", "雷达响应", "档案"]}
                  rows={legacySelected.componentIds.map((id) => {
                    const component = componentById(id);
                    return [
                      <b key={`c-${id}`}>{id}</b>,
                      component?.part ?? "—",
                      component?.visibleNote ?? "—",
                      component?.radarScore === null || component?.radarScore === undefined
                        ? "未采集"
                        : component.radarScore.toFixed(2),
                      component?.archive ?? "—",
                    ];
                  })}
                />

                <h4 className="sub">任务附件</h4>
                <ul className="orders-attachments">
                  {legacySelected.attachments.map((item) => (
                    <li key={item.assetId}>
                      {/*
                        PRD §3.3 迁移表：「book → nav-knowledge 或 asset-file；
                        知识导航用 knowledge，具体附件按文件类型」。
                        这里是任务附件列表，所以按附件文件语义取 asset-file，
                        不用 nav-knowledge（那是知识库导航）。
                      */}
                      <Icon name="asset-file" size={16} aria-hidden />
                      <b>{item.name}</b>
                      <em>
                        {item.kind} · {item.sizeText}
                      </em>
                      <SourceTag label={item.sourceMode === "replay" ? "演示回放" : item.sourceMode} />
                    </li>
                  ))}
                </ul>
              </Panel>

              <div className="orders-two">
                {/* 环境记录与校验（演示回放单走共享会话的配置流程） */}
                <Panel
                  title="环境记录与配置校验"
                  extra={
                    online ? (
                      /*
                        chip 是 `inline-flex + gap:5px`：整段文案再包一层 span，
                        数字才不会被圆点之间那道 gap 额外撑开（排版与原来一致）。
                      */
                      <StatusChip
                        text={
                          <span>
                            共享会话 · <NumberAnimation value={envVersions.length} /> 版
                          </span>
                        }
                        tone="ok"
                      />
                    ) : (
                      <StatusChip text={sharedStatus === "connecting" ? "连接中" : "未连接共享服务"} tone="warn" />
                    )
                  }>
                  {online ? null : (
                    <StateBlock
                      kind="offline"
                      title="未连接共享服务"
                      hint={sharedError ?? "环境配置需要服务端保存才能跨端交接；连接恢复后本区域自动可用。"}
                    />
                  )}

                  {/*
                    一级页面只留**当前生效的读数与状态**：三个值 + 仪表位置。
                    六个输入框下沉到「录入环境读数」弹窗 —— 用户的要求是
                    「一级页面不要为了一个操作动态堆出大量表单」。
                  */}
                  <ul className="env-readout">
                    <li>
                      <small>温度</small>
                      <b>
                        <NumberAnimation value={draftEnv.airTempC} />
                        <em>{draftEnv.instrumentRange.unit}</em>
                      </b>
                    </li>
                    <li>
                      <small>相对湿度</small>
                      <b>
                        <NumberAnimation value={draftEnv.relativeHumidityPct} />
                        <em>%</em>
                      </b>
                    </li>
                    <li>
                      <small>风速</small>
                      <b>
                        <NumberAnimation value={draftEnv.windSpeedMs} />
                        <em>m/s</em>
                      </b>
                    </li>
                    <li>
                      <small>仪表 / 位置</small>
                      <b className="env-readout__text">
                        {draftEnv.instrumentId}
                        <em>{draftEnv.position}</em>
                      </b>
                    </li>
                  </ul>

                  <div className="env-actions">
                    <Btn onClick={() => setEnvOpen(true)} title="填写温度 / 湿度 / 风速与仪表信息">
                      录入读数
                    </Btn>
                    {/* PRD 3.1 / 12：校验由经理运行；PRD 2.1：饶接收配置并返回 ack */}
                    <Btn
                      tone="primary"
                      disabled={!can("env:validate") || !online || envBusy !== null}
                      title={
                        !can("env:validate")
                          ? permissionHint("env:validate")
                          : !online
                            ? "连接不上共享服务，无法发布"
                            : "运行环境校验并生成配置版本"
                      }
                      onClick={() => void runValidate()}>
                      {envBusy === "validate" ? "校验中…" : "运行校验"}
                    </Btn>
                    <Btn
                      disabled={!can("env:ack") || !online || envBusy !== null || !envEntity || deviceAck}
                      title={
                        !can("env:ack")
                          ? permissionHint("env:ack")
                          : !online
                            ? "连接不上共享服务，无法接收"
                            : deviceAck
                              ? `配置 ${configVersion ?? "—"} 已接收`
                              : "接收当前已发布的配置版本并返回 ack"
                      }
                      onClick={() => void receive()}>
                      {envBusy === "receive" ? "接收中…" : deviceAck ? "已接收" : "全栈接收并返回 ack"}
                    </Btn>
                    {can("env:validate") && can("env:ack") ? null : (
                      <PermNote permissions={["env:validate", "env:ack"]} />
                    )}
                  </div>

                  {actionErrorLegacy ? <p className="env-action-error">{actionErrorLegacy}</p> : null}

                  {ran ? (
                    <ul className="env-checks">
                      {checks.map((check) => (
                        <li key={check.key} className={check.ok ? "is-ok" : "is-bad"}>
                          {/*
                            PRD §3.3：「check 用于审核入口时应按业务另选，不能机械映射
                            所有场景」。这里是**校验结果**展示，是完成/告警语义，
                            因此用 status-success / status-warning，
                            而不是保留日历勾（check 的原图形留给审核入口）。
                            颜色由 tone 提供，图形本身也能区分，不只靠颜色（PRD §4）。
                          */}
                          <Icon
                            name={check.ok ? "status-success" : "status-warning"}
                            size={16}
                            tone={check.ok ? "success" : "warning"}
                            aria-hidden
                          />
                          {check.label}
                          <em>{check.message}</em>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <StateBlock
                      kind="empty"
                      title="尚未运行校验"
                      hint="校验通过后才会生成不可变配置版本；未通过时不产生版本。"
                    />
                  )}

                  <div className="env-submit">
                    <span>
                      提交状态：
                      <StatusChip
                        text={publishedState === "published" || publishedState === "received" ? "已提交" : "未提交"}
                        tone={publishedState ? "ok" : "muted"}
                      />
                    </span>
                    <span>
                      设备确认：
                      <StatusChip
                        text={deviceAck ? `已接收 · ${envEntity?.data.ackBy ?? "—"}` : "等待设备 ack"}
                        tone={deviceAck ? "ok" : "warn"}
                      />
                    </span>
                    <span>
                      配置版本：{configVersion ?? "—"}
                      {envEntity ? (
                        <em className="env-rev">
                          rev <NumberAnimation value={envEntity.revision} />
                        </em>
                      ) : null}
                    </span>
                  </div>

                  <p className="note">
                    {HH_PRIOR.note}
                    <br />
                    方法版本：{HH_PRIOR.functionVersion}；风速是否代入 HH：
                    {HH_PRIOR.windExcluded ? "不代入" : "代入"}
                    {/* 平衡含水率是共享会话发布时算出来的，会随配置版本变；「%」原样跟在数字后 */}
                    {envEntity?.data.emcPct != null ? (
                      <>；本次平衡含水率估计 <NumberAnimation value={envEntity.data.emcPct} suffix="%" /></>
                    ) : null}
                  </p>
                </Panel>

                {/* 环境补偿：配置差异 + 历史记录（历史来自共享服务，不再读种子） */}
                <Panel title="环境补偿与配置差异">
                  <DataTable
                    head={["参数", "补偿前", "补偿后", "依据"]}
                    rows={CONFIG_DIFF.map((row) => [row.field, row.before, row.after, row.note])}
                  />
                  <h4 className="sub">历史环境记录</h4>
                  <ul className="comp-curves">
                    {envVersions.length ? (
                      envVersions.map((version) => (
                        <li key={version.id}>
                          <b>{version.data.version}</b>
                          <span>
                            <NumberAnimation
                              value={numeric(version.data.inputs.airTempC)}
                              fallback={String(version.data.inputs.airTempC)}
                            />
                            ℃ /{" "}
                            <NumberAnimation
                              value={numeric(version.data.inputs.relativeHumidityPct)}
                              fallback={String(version.data.inputs.relativeHumidityPct)}
                            />
                            % /{" "}
                            <NumberAnimation
                              value={numeric(version.data.inputs.windSpeedMs)}
                              fallback={String(version.data.inputs.windSpeedMs)}
                            />{" "}
                            m/s
                          </span>
                          <StatusChip
                            text={version.data.state === "received" ? "设备已确认" : "已提交"}
                            tone={version.data.state === "received" ? "ok" : "muted"}
                          />
                          <em>{version.data.publishedBy ?? "—"}</em>
                        </li>
                      ))
                    ) : (
                      <li>
                        <b>{ENV_HISTORY[0]?.measuredAt ?? "—"}</b>
                        <span>共享服务未连接，以下为历史归档值</span>
                        <StatusChip text="离线" tone="muted" />
                        <em>—</em>
                      </li>
                    )}
                  </ul>
                </Panel>
              </div>

              {/*
                人员分工与操作记录（811px、12 行）原来整块铺在一级页面 ——
                它是**历史记录**，用户明确要求「历史记录……统一下沉」。
                一级页面只留：谁负责、最近一条动作是什么、完整记录入口。
              */}
              <Panel
                title="人员与操作记录"
                extra={
                  <span className="fw-console__actions">
                    <span className="muted">{ORDER_LOGS.length} 条记录</span>
                    <Btn onClick={() => setLogOpen(true)}>查看全部</Btn>
                  </span>
                }>
                <div className="members">
                  {MEMBERS.map((member) => (
                    <article key={member.id}>
                      <b>
                        {member.name} · {member.role}
                      </b>
                      <span>{member.duty}</span>
                    </article>
                  ))}
                </div>
                {ORDER_LOGS.length ? (
                  <ol className="order-logs order-logs--latest">
                    <li>
                      <time>{ORDER_LOGS[ORDER_LOGS.length - 1].at}</time>
                      <b>{ORDER_LOGS[ORDER_LOGS.length - 1].actor}</b>
                      <span>
                        {ORDER_LOGS[ORDER_LOGS.length - 1].action} · {ORDER_LOGS[ORDER_LOGS.length - 1].object}
                      </span>
                      <em>{ORDER_LOGS[ORDER_LOGS.length - 1].result}</em>
                    </li>
                  </ol>
                ) : null}
              </Panel>
            </>
          )}
        </div>
      </div>

      {logOpen ? (
        <Modal
          wide
          title="操作记录"
          subtitle={`${legacySelected.id} · ${ORDER_LOGS.length} 条`}
          onClose={() => setLogOpen(false)}
          footer={
            <Btn tone="primary" onClick={() => setLogOpen(false)}>
              关闭
            </Btn>
          }>
          <ol className="order-logs">
            {ORDER_LOGS.map((log) => (
              <li key={log.at + log.action}>
                <time>{log.at}</time>
                <b>{log.actor}</b>
                <span>
                  {log.action} · {log.object}
                </span>
                <em>{log.result}</em>
              </li>
            ))}
          </ol>
          <h4 className="sub">人员分工</h4>
          <div className="members">
            {MEMBERS.map((member) => (
              <article key={member.id}>
                <b>
                  {member.name} · {member.role}
                </b>
                <span>{member.duty}</span>
                <em>默认工作区：{member.workspace}</em>
              </article>
            ))}
          </div>
        </Modal>
      ) : null}

      {/*
        建单表单在二级弹窗里。一级页面只有一个「生成工单」按钮 ——
        用户的要求是重要操作先弹确认/配置窗口，不要为一次操作在页面上堆表单。
      */}
      {/*
        环境读数录入弹窗：六个输入框、范围提示与字段级错误都在这里。
        校验与发布仍在上面的一级面板上（那是主要操作，不该藏进弹窗）。
      */}
      {envOpen ? (
        <Modal
          title="录入环境读数"
          subtitle={`仪表 ${draftEnv.instrumentId} · ${draftEnv.measuredAt}`}
          onClose={() => setEnvOpen(false)}
          footer={
            <>
              <span className="muted">
                {HH_PRIOR.note} · 方法版本 {HH_PRIOR.functionVersion}；风速{HH_PRIOR.windExcluded ? "不" : ""}代入 HH
                {envEntity?.data.emcPct != null ? (
                  <> · 当前平衡含水率估计 <NumberAnimation value={envEntity.data.emcPct} suffix="%" /></>
                ) : null}
              </span>
              <Btn tone="primary" onClick={() => setEnvOpen(false)}>
                完成录入
              </Btn>
            </>
          }>
              <div className="env-grid">
                <label className={errorFor("airTempC") ? "is-bad" : undefined}>
                  <span>温度（{draftEnv.instrumentRange.unit}）</span>
                  <input
                    type="number"
                    value={draftEnv.airTempC}
                    onChange={(event) => patch({ airTempC: Number(event.target.value) })}
                  />
                  {errorFor("airTempC") ? <em className="env-field-error">{errorFor("airTempC")}</em> : null}
                </label>
                <label className={errorFor("relativeHumidityPct") ? "is-bad" : undefined}>
                  <span>相对湿度（%）</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={draftEnv.relativeHumidityPct}
                    onChange={(event) => patch({ relativeHumidityPct: Number(event.target.value) })}
                  />
                  {errorFor("relativeHumidityPct") ? (
                    <em className="env-field-error">{errorFor("relativeHumidityPct")}</em>
                  ) : (
                    <em className="env-field-range">有效范围 0–100</em>
                  )}
                </label>
                <label className={errorFor("windSpeedMs") ? "is-bad" : undefined}>
                  <span>风速（m/s）</span>
                  <input
                    type="number"
                    min={0}
                    value={draftEnv.windSpeedMs}
                    onChange={(event) => patch({ windSpeedMs: Number(event.target.value) })}
                  />
                  {errorFor("windSpeedMs") ? <em className="env-field-error">{errorFor("windSpeedMs")}</em> : null}
                </label>
                <label className={errorFor("instrumentId") ? "is-bad" : undefined}>
                  <span>仪表编号</span>
                  <input value={draftEnv.instrumentId} onChange={(event) => patch({ instrumentId: event.target.value })} />
                  {errorFor("instrumentId") ? <em className="env-field-error">{errorFor("instrumentId")}</em> : null}
                </label>
                <label>
                  <span>测量位置</span>
                  <input value={draftEnv.position} onChange={(event) => patch({ position: event.target.value })} />
                </label>
                <label>
                  <span>测量时间</span>
                  <input value={draftEnv.measuredAt} onChange={(event) => patch({ measuredAt: event.target.value })} />
                </label>
              </div>
        </Modal>
      ) : null}
      {createOpen ? (
        <WorkOrderCreateModal
          nextId={nextOrderId}
          onClose={() => setCreateOpen(false)}
          onConfirm={(input) => {
            const created = createOrder(input);
            toast(`工单 ${created.id} 已生成，进入待复核`, "ok");
            pushEvent(`生成工单 ${created.id}（${created.site} · ${created.componentIds.join("/")}）`, "ok");
            return created;
          }}
        />
      ) : null}
    </div>
  );
}
