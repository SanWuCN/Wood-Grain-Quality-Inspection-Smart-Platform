/**
 * 工单档案（`/orders`）
 *
 * PRD 3.1：工单详情包括地点、范围、Z01 至 Z04 清单、任务附件、环境记录、
 * 人员分工和操作记录；支持创建、编辑、开始、暂停、归档；
 * 历史工单与当前工单分列表显示。
 *
 * 环境表单：温度必须注明摄氏度，湿度 0–100，风速非负（PRD 3.1）。
 * 经理运行校验通过后生成「不可变配置版本」，饶接收并返回 ack，
 * 界面分别显示「已提交」「设备已确认」。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMumai } from "../context";
import { isReadOnlyPath, permissionHint } from "../auth";
import { WorkOrderCreateModal } from "./WorkOrderCreate";
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
import { environmentHistory, isOnline, latestEnvironment, useSharedStore } from "../store/shared";
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

export default function Orders() {
  const {
    orders,
    currentOrder,
    archivedOrders,
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

  /** 建单弹窗：表单在二级，一级页面只放一个「生成工单」按钮 */
  const [createOpen, setCreateOpen] = useState(false);
  /** 操作记录弹窗：历史记录下沉，一级页面只留最近一条 */
  const [logOpen, setLogOpen] = useState(false);
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
  const selectedId = params.get("order") ?? currentOrder.id;
  const selected = useMemo(
    () => orders.find((item) => item.id === selectedId) ?? currentOrder,
    [orders, selectedId, currentOrder],
  );

  /* ---- 环境配置改为读共享服务：四端同一版本，刷新不回退（评审 F01） ---- */

  const envEntity = useSharedStore(latestEnvironment);
  const envVersions = useSharedStore(environmentHistory);
  const online = useSharedStore(isOnline);
  const sharedStatus = useSharedStore((state) => state.status);
  const sharedError = useSharedStore((state) => state.connectionError);

  const [draftEnv, setDraftEnv] = useState<EnvRecord>(() => toDraft(envEntity?.data.inputs, ENV_RECORD));
  const [ran, setRan] = useState(false);
  const [busy, setBusy] = useState<"validate" | "receive" | null>(null);
  /** 字段级错误：v1.1 §5.2 要求错误显示在字段旁，不只弹 toast */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

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
      setActionError("连接不上共享服务，配置无法发布给其他端");
      return;
    }
    setBusy("validate");
    setActionError(null);
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
        setActionError(error.fieldErrors.length ? null : error.message);
        toast(error.code === "VALIDATION_FAILED" ? "校验未通过，请修正标红字段" : error.message, "danger");
      } else {
        setActionError("校验请求失败");
      }
    } finally {
      setBusy(null);
    }
  }, [draftEnv, online, pushEvent, toast]);

  /** 全栈接收：写回服务端，沈那一端随后能看到「已接收」 */
  const receive = useCallback(async () => {
    if (!envEntity) return;
    setBusy("receive");
    setActionError(null);
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
      setActionError(message);
      toast(message, "danger");
    } finally {
      setBusy(null);
    }
  }, [envEntity, pushEvent, toast]);

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("order", id);
    setParams(next, { replace: true });
  };

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
              <span>历史工单与当前工单分列表显示；暂停保留所有已生成记录</span>
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
        <Btn
          disabled={!can("order:review")}
          title={can("order:review") ? "暂停保留全部已生成记录" : permissionHint("order:review")}
          onClick={() => {
            setOrderStatus(selected.id, "处理中" as OrderStatus);
            toast("已暂停，所有已生成记录保留", "warn");
            pushEvent(`工单 ${selected.id} 暂停`, "warn");
          }}>
          暂停
        </Btn>
        <Btn
          disabled={!can("order:review")}
          title={can("order:review") ? "归档工单" : permissionHint("order:review")}
          onClick={() => {
            setOrderStatus(selected.id, "已关闭" as OrderStatus);
            toast("工单已归档", "ok");
            pushEvent(`工单 ${selected.id} 归档`, "ok");
          }}>
          归档
        </Btn>
        {can("order:review") ? null : <small className="muted">{permissionHint("order:review")}</small>}
      </Toolbar>

      <div className="orders-layout">
        {/* 左：工单列表（当前 / 历史分开） */}
        <aside className="orders-side">
          <Panel title="当前工单">
            <button
              type="button"
              className={`order-item ${selected.id === currentOrder.id ? "is-active" : ""}`}
              onClick={() => select(currentOrder.id)}>
              <b>{currentOrder.id}</b>
              <span>
                {currentOrder.district} · {currentOrder.site}
              </span>
              <StatusChip text={currentOrder.status} tone="warn" />
            </button>
            <button
              type="button"
              className={`order-item ${selected.id === draftOrder.id ? "is-active" : ""}`}
              onClick={() => select(draftOrder.id)}>
              <b>{draftOrder.id}</b>
              <span>小木生成草稿 · {draftOrder.componentIds.join("/")}</span>
              <StatusChip text={draftOrder.status} tone="muted" />
            </button>
          </Panel>

          <Panel title="历史工单" extra={<small>{archivedOrders.length} 条</small>}>
            <div className="orders-history">
              {archivedOrders.map((order) => (
                <button
                  key={order.id}
                  type="button"
                  className={`order-item ${selected.id === order.id ? "is-active" : ""}`}
                  onClick={() => select(order.id)}>
                  <b>{order.id}</b>
                  <span>
                    {order.district} · {order.site}
                  </span>
                  <StatusChip text={order.status} tone="muted" />
                </button>
              ))}
            </div>
          </Panel>
        </aside>

        {/* 右：工单详情 */}
        <div className="orders-main">
          <Panel
            title={`工单详情 · ${selected.id}`}
            extra={<StatusChip text={selected.status} tone="warn" />}>
            <KV
              items={[
                { k: "地点", v: selected.location },
                { k: "检测范围", v: selected.scope },
                { k: "责任部门", v: selected.owner },
                { k: "来源风险", v: selected.sourceRiskIds.join(" / ") || "—" },
                { k: "创建时间", v: selected.createdAt },
                { k: "复巡计划", v: selected.revisitPlanId ?? "未生成" },
              ]}
              columns={3}
            />

            <h4 className="sub">构件清单 Z01–Z04</h4>
            <DataTable
              head={["构件", "部位", "外观记录", "雷达响应", "档案"]}
              rows={selected.componentIds.map((id) => {
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
              {selected.attachments.map((item) => (
                <li key={item.assetId}>
                  <Icon name="database" />
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
            {/* 环境记录与校验 */}
            <Panel
              title="环境记录与配置校验"
              extra={
                online ? (
                  <StatusChip text={`共享会话 · ${envVersions.length} 版`} tone="ok" />
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

              <div className="env-actions">
                {/* PRD 3.1 / 12：校验由经理运行；PRD 2.1：饶接收配置并返回 ack */}
                <Btn
                  tone="primary"
                  disabled={!can("env:validate") || !online || busy !== null}
                  title={
                    !can("env:validate")
                      ? permissionHint("env:validate")
                      : !online
                        ? "连接不上共享服务，无法发布"
                        : "运行环境校验并生成配置版本"
                  }
                  onClick={() => void runValidate()}>
                  {busy === "validate" ? "校验中…" : "运行校验"}
                </Btn>
                <Btn
                  disabled={!can("env:ack") || !online || busy !== null || !envEntity || deviceAck}
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
                  {busy === "receive" ? "接收中…" : deviceAck ? "已接收" : "全栈接收并返回 ack"}
                </Btn>
                {can("env:validate") && can("env:ack") ? null : (
                  <PermNote permissions={["env:validate", "env:ack"]} />
                )}
              </div>

              {actionError ? <p className="env-action-error">{actionError}</p> : null}

              {ran ? (
                <ul className="env-checks">
                  {checks.map((check) => (
                    <li key={check.key} className={check.ok ? "is-ok" : "is-bad"}>
                      <Icon name={check.ok ? "check" : "alert"} />
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
                  {envEntity ? <em className="env-rev">rev {envEntity.revision}</em> : null}
                </span>
              </div>

              <p className="note">
                {HH_PRIOR.note}
                <br />
                方法版本：{HH_PRIOR.functionVersion}；风速是否代入 HH：
                {HH_PRIOR.windExcluded ? "不代入" : "代入"}
                {envEntity?.data.emcPct != null ? `；本次平衡含水率估计 ${envEntity.data.emcPct}%` : ""}
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
                        {String(version.data.inputs.airTempC)}℃ / {String(version.data.inputs.relativeHumidityPct)}% /{" "}
                        {String(version.data.inputs.windSpeedMs)} m/s
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
        </div>
      </div>

      {logOpen ? (
        <Modal
          wide
          title="操作记录"
          subtitle={`${selected.id} · ${ORDER_LOGS.length} 条`}
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
