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

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMumai } from "../context";
import { permissionHint } from "../auth";
import { Panel } from "../Panel";
import { Icon } from "../icons";
import { Btn, DataTable, KV, PermNote, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import {
  CONFIG_DIFF,
  ENV_HISTORY,
  HH_PRIOR,
  MEMBERS,
  ORDER_LOGS,
} from "../seed/scenario";
import type { EnvRecord, OrderStatus } from "../seed/types";

type Check = { key: string; label: string; ok: boolean; message: string };

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
      message: `当前 ${record.relativeHumidityPct}%（断言 0 <= relative_humidity_pct <= 100）`,
    },
    {
      key: "wind",
      label: "风速非负",
      ok: record.windSpeedMs >= 0,
      message: `当前 ${record.windSpeedMs} m/s（仅作采集稳定性记录）`,
    },
    {
      key: "temp",
      label: `温度在仪表量程 ${range.min}–${range.max} ${range.unit} 内`,
      ok: inRange,
      message: `当前 ${record.airTempC} ℃`,
    },
    {
      key: "instrument",
      label: "仪表编号与测量位置已登记",
      ok: Boolean(record.instrumentId) && Boolean(record.position),
      message: `${record.instrumentId || "未登记"} · ${record.position || "未登记"}`,
    },
  ];
}

export default function Orders() {
  const {
    orders,
    currentOrder,
    archivedOrders,
    draftOrder,
    componentById,
    envRecord,
    setEnvRecord,
    publishedConfig,
    publishConfig,
    deviceAck,
    setDeviceAck,
    setOrderStatus,
    confirmDraftOrder,
    toast,
    pushEvent,
    can,
  } = useMumai();

  const [params, setParams] = useSearchParams();
  const selectedId = params.get("order") ?? currentOrder.id;
  const selected = useMemo(
    () => orders.find((item) => item.id === selectedId) ?? currentOrder,
    [orders, selectedId, currentOrder],
  );

  const [draftEnv, setDraftEnv] = useState<EnvRecord>(envRecord);
  const [ran, setRan] = useState(false);

  const checks = useMemo(() => validateEnv(draftEnv), [draftEnv]);
  const allOk = checks.every((item) => item.ok);

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
            <span>历史工单与当前工单分列表显示；暂停保留所有已生成记录</span>
          </>
        }>
        {/* PRD 2.1：工单审核（确认草稿、暂停、归档）属于项目经理的职责 */}
        <Btn
          tone="primary"
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
            <Panel title="环境记录与配置校验">
              <div className="env-grid">
                <label>
                  <span>温度（℃）</span>
                  <input
                    type="number"
                    value={draftEnv.airTempC}
                    onChange={(event) =>
                      setDraftEnv({ ...draftEnv, airTempC: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>相对湿度（%）</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={draftEnv.relativeHumidityPct}
                    onChange={(event) =>
                      setDraftEnv({ ...draftEnv, relativeHumidityPct: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>风速（m/s）</span>
                  <input
                    type="number"
                    min={0}
                    value={draftEnv.windSpeedMs}
                    onChange={(event) =>
                      setDraftEnv({ ...draftEnv, windSpeedMs: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>仪表编号</span>
                  <input
                    value={draftEnv.instrumentId}
                    onChange={(event) =>
                      setDraftEnv({ ...draftEnv, instrumentId: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>测量位置</span>
                  <input
                    value={draftEnv.position}
                    onChange={(event) => setDraftEnv({ ...draftEnv, position: event.target.value })}
                  />
                </label>
                <label>
                  <span>测量时间</span>
                  <input
                    value={draftEnv.measuredAt}
                    onChange={(event) =>
                      setDraftEnv({ ...draftEnv, measuredAt: event.target.value })
                    }
                  />
                </label>
              </div>

              <div className="env-actions">
                {/* PRD 3.1 / 12：校验由经理运行；PRD 2.1：饶接收配置并返回 ack */}
                <Btn
                  tone="primary"
                  disabled={!can("env:validate")}
                  title={can("env:validate") ? "运行环境校验并生成配置版本" : permissionHint("env:validate")}
                  onClick={() => {
                    setRan(true);
                    if (allOk) {
                      setEnvRecord(draftEnv);
                      publishConfig(`CFG-${String(ENV_HISTORY.length + 3).padStart(2, "0")}`);
                      toast("校验通过，已生成不可变配置版本", "ok");
                      pushEvent("环境配置校验通过并发布新版本", "ok");
                    } else {
                      toast("校验未通过，请修正标红字段", "danger");
                    }
                  }}>
                  运行校验
                </Btn>
                <Btn
                  disabled={!can("env:ack")}
                  title={can("env:ack") ? "设备代理返回 ack" : permissionHint("env:ack")}
                  onClick={() => {
                    setDeviceAck(true);
                    toast("设备代理已返回 ack", "ok");
                    pushEvent("全栈工程师接收配置并返回 ack", "ok");
                  }}>
                  全栈接收并返回 ack
                </Btn>
                {can("env:validate") && can("env:ack") ? null : (
                  <PermNote permissions={["env:validate", "env:ack"]} />
                )}
              </div>

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
                    text={publishedConfig ? "已提交" : "未提交"}
                    tone={publishedConfig ? "ok" : "muted"}
                  />
                </span>
                <span>
                  设备确认：
                  <StatusChip
                    text={deviceAck ? "设备已确认" : "等待设备 ack"}
                    tone={deviceAck ? "ok" : "warn"}
                  />
                </span>
                <span>配置版本：{publishedConfig ?? "—"}</span>
              </div>

              <p className="note">
                {HH_PRIOR.note}
                <br />
                方法版本：{HH_PRIOR.functionVersion}；风速是否代入 HH：
                {HH_PRIOR.windExcluded ? "不代入" : "代入"}
              </p>
            </Panel>

            {/* 环境补偿：配置差异 + 历史记录 */}
            <Panel title="环境补偿与配置差异">
              <DataTable
                head={["参数", "补偿前", "补偿后", "依据"]}
                rows={CONFIG_DIFF.map((row) => [row.field, row.before, row.after, row.note])}
              />
              <h4 className="sub">历史环境记录</h4>
              <ul className="comp-curves">
                {ENV_HISTORY.map((record) => (
                  <li key={record.recordId}>
                    <b>{record.measuredAt}</b>
                    <span>
                      {record.airTempC}℃ / {record.relativeHumidityPct}% / {record.windSpeedMs} m/s
                    </span>
                    <StatusChip text={record.submitState} tone="muted" />
                    <em>{record.configVersion ?? "—"}</em>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <Panel title="人员分工与操作记录">
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
          </Panel>
        </div>
      </div>
    </div>
  );
}
