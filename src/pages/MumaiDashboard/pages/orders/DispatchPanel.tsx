/**
 * 扫描仪下发（PRD-工单指派与扫描仪下发-v1.0 §5.1 第 5 项 / §8.2 / §9）
 *
 * 只做展示与交互：下发动作通过 `onDispatch` 抛给调用方，本组件不碰接口与页面上下文。
 *
 * 三条不能让步的口径：
 *   · 主按钮就叫「下发扫描仪」，不再出现「全栈接收」「返回 ack」这类旧说法（§5.2）。
 *   · 状态文案直接用服务端的 `dispatch.stateText`；八种状态的含义只挂在状态 chip 的
 *     `title` 上（悬停可见），页面上不铺开。页面不自己推断成功，也**不接受人工代填
 *     设备确认**（§8.2 / A14）。
 *   · 设备离线仍允许排队：按钮不禁用，只在按钮 title 上写「设备离线，将排队上线」。
 *
 * 页面文案只留「标签 + 值 + 按钮 + 状态」：解释性小字不进 UI，空态只留一行标题
 * （StateBlock 不给 hint 会掉进 ui.tsx 的兜底解释句，所以显式传空串）。
 */

import { useState } from "react";
import { Panel } from "../../Panel";
import { Btn, DataTable, KV, StateBlock, StatusChip } from "../../ui";
import type { DispatchTarget, DispatchView, WorkOrderDetail } from "../../api/client";
import "./orders.css";

type DispatchBody = { deviceId: string; configVersion?: string | null; idempotencyKey: string };
type DispatchState = DispatchView["state"];
type ChipTone = "ok" | "warn" | "danger" | "info" | "muted";

/** 八种下发状态（PRD §8.2 的页面文案，与服务端 `DISPATCH_STATES` 一致） */
const DISPATCH_TEXT: Record<DispatchState, string> = {
  none: "待下发",
  queued: "等待扫描仪上线",
  sent: "等待扫描仪接收",
  accepted: "扫描仪已接收，正在应用",
  executed: "扫描仪已应用",
  failed: "下发失败",
  expired: "下发超时，可重新下发",
  superseded: "已失效，需下发最新版本",
};

const DISPATCH_TONE: Record<DispatchState, ChipTone> = {
  none: "muted",
  queued: "warn",
  sent: "info",
  accepted: "info",
  executed: "ok",
  failed: "danger",
  expired: "warn",
  superseded: "muted",
};

/** `code=文案` 的完整口径：只作为状态 chip 的 `title`（悬停可见），不在页面上铺开 */
const DISPATCH_LEGEND = (Object.keys(DISPATCH_TEXT) as DispatchState[])
  .map((state) => `${state}=${DISPATCH_TEXT[state]}`)
  .join(" / ");

/** 时间显示：按记录里的墙钟时间截到分钟；没有就是「—」，不补当前时间 */
function stamp(value: string | null | undefined): string {
  if (!value) return "—";
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return matched ? `${matched[1]} ${matched[2]}` : value;
}

/**
 * 幂等键：服务端按它去重，网络重发同一键不会多出一条业务命令（PRD §8.2）。
 *
 * 非安全上下文（局域网 http）没有 `crypto.randomUUID`，退回时间戳 + 随机数，
 * 保证任何部署方式下点击都有键可用。
 */
function makeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `k-${crypto.randomUUID()}`;
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 目标设备已应用过的版本：该设备最近一条 `state === "executed"` 的配置版本。
 *
 * 历史记录按创建时间倒序返回，但这里不依赖顺序 —— 取 `executedAt`（缺失时退回
 * `createdAt`）最大的那条，旧回执就不会盖掉新版本（A18）。
 */
function appliedVersion(dispatches: DispatchView[], deviceId: string): string | null {
  let latest: DispatchView | null = null;
  let latestAt = "";
  for (const row of dispatches) {
    if (row.state !== "executed" || row.deviceId !== deviceId || !row.configVersion) continue;
    const at = row.executedAt ?? row.createdAt ?? "";
    if (!latest || at >= latestAt) {
      latest = row;
      latestAt = at;
    }
  }
  return latest?.configVersion ?? null;
}

/**
 * 下发前置条件（PRD §8.2）：已指派、权限有效、当前环境版本校验通过、
 * 目标设备已绑定、工单可操作。返回 null 表示可以下发。
 *
 * 设备离线**不算阻断**：包与命令会持久化排队，等设备上线。
 */
function blockReason(
  detail: WorkOrderDetail,
  configVersion: string | null,
  target: DispatchTarget | null,
): string | null {
  if (!detail.capabilities.canDispatch) {
    return detail.capabilities.assigned ? "你在本单没有「扫描仪下发」职责" : "尚未指派到此工单，不能下发";
  }
  if (detail.order.status === "已归档" || detail.order.status === "已暂停") {
    return `工单当前是「${detail.order.status}」，不能下发`;
  }
  if (detail.environment.needsRevalidate) return "环境读数已改动但未重新校验，不能下发旧版本";
  if (!configVersion) return "暂无通过校验的配置版本，不能下发";
  if (!target) return "暂无可用扫描仪，不能下发";
  return null;
}

export function DispatchPanel({
  detail,
  busy,
  onDispatch,
  className = "",
}: {
  detail: WorkOrderDetail;
  busy: boolean;
  onDispatch: (body: DispatchBody) => Promise<void>;
  /**
   * 揭示门控用：父组件 `WorkOrderDetail.tsx` 传 `wop-reveal` / `wop-reveal is-in`，
   * 决定这一块在播报念到那一拍之前**不出现**（`orders.css` 里是 `display: none`）。
   * 不传时行为与从前完全一致。
   */
  className?: string;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const pending = busy || submitting;
  const config = detail.environment.config;
  const configVersion = config?.configVersion ?? null;
  /*
    目标设备：选中项失效（换单 / 目标列表变了）时退回第一台，
    用派生值而不是 effect 同步 state，换工单不会短暂停在没有目标的空档。
  */
  const target: DispatchTarget | null =
    detail.targets.find((item) => item.deviceId === selectedId) ?? detail.targets[0] ?? null;
  const applied = target ? appliedVersion(detail.dispatches, target.deviceId) : null;
  const dispatch = detail.dispatch;
  const stateText = dispatch.stateText || DISPATCH_TEXT[dispatch.state];

  /** 前置条件（PRD §8.2）：已指派、权限有效、版本校验通过、目标设备已绑定、工单可操作 */
  const blockedReason = blockReason(detail, configVersion, target);

  const submit = async () => {
    if (!target || blockedReason) return;
    setSubmitting(true);
    try {
      await onDispatch({ deviceId: target.deviceId, configVersion, idempotencyKey: makeIdempotencyKey() });
    } catch {
      // 错误由父组件显示在别处；面板本身不吞掉状态，也不假装成功
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel
      className={className}
      title="扫描仪下发"
      icon="biz-handheld-scanner"
      extra={
        <span title={DISPATCH_LEGEND}>
          <StatusChip text={stateText} tone={DISPATCH_TONE[dispatch.state]} />
        </span>
      }>
      {detail.targets.length === 0 ? (
        <StateBlock kind="empty" title="暂无可用扫描仪" hint="" />
      ) : (
        <>
          <label className="wo-target">
            <span>目标扫描仪</span>
            <select
              className="wo-select"
              value={target?.deviceId ?? ""}
              disabled={pending}
              onChange={(event) => setSelectedId(event.target.value)}>
              {detail.targets.map((item) => (
                <option key={item.deviceId} value={item.deviceId}>
                  {item.deviceId} · {item.online ? "在线" : "离线"} · {item.connectionState}
                </option>
              ))}
            </select>
          </label>
          {target ? (
            <p className="wo-target__meta">
              <StatusChip text={target.online ? "在线" : "离线"} tone={target.online ? "ok" : "warn"} />
              <span>{target.deviceId}</span>
              <span>连接状态 {target.connectionState}</span>
              {target.appVersion ? <span>终端版本 {target.appVersion}</span> : null}
              {target.pendingCommands > 0 ? <span>待处理命令 {target.pendingCommands}</span> : null}
            </p>
          ) : null}
        </>
      )}

      <KV
        columns={3}
        items={[
          { k: "待下发版本", v: configVersion ?? "—" },
          { k: "当前设备版本", v: applied ?? "—" },
          {
            k: "下发状态",
            v: (
              <span title={DISPATCH_LEGEND}>
                <StatusChip text={stateText} tone={DISPATCH_TONE[dispatch.state]} />
              </span>
            ),
          },
          /* 服务端给的状态文案：有就按「标签 + 值」列出，不写成段落 */
          ...(dispatch.reason ? [{ k: "状态说明", v: dispatch.reason }] : []),
          ...(dispatch.activationState ? [{ k: "设备侧激活状态", v: dispatch.activationState }] : []),
        ]}
      />

      <div className="wo-actions">
        <Btn
          tone="primary"
          disabled={pending || blockedReason !== null}
          title={blockedReason ?? (target && !target.online ? "设备离线，将排队上线" : "下发到目标扫描仪")}
          onClick={() => void submit()}>
          下发扫描仪
        </Btn>
      </div>

      <h4 className="sub">历史下发记录</h4>
      <DataTable
        head={["包号", "目标设备", "配置版本", "状态", "创建时间", "过期时间", "接收时间", "应用时间"]}
        rows={detail.dispatches.map((row) => [
          row.bundleId ?? "—",
          row.deviceId ?? "—",
          row.configVersion ?? "—",
          <span
            key={`${row.dispatchId ?? row.bundleId ?? "dispatch"}-state`}
            title={[DISPATCH_LEGEND, row.reason ? `原因：${row.reason}` : null].filter(Boolean).join("；")}>
            <StatusChip text={row.stateText || DISPATCH_TEXT[row.state]} tone={DISPATCH_TONE[row.state]} />
          </span>,
          stamp(row.createdAt),
          stamp(row.expiresAt),
          stamp(row.acceptedAt),
          stamp(row.executedAt),
        ])}
        empty="暂无下发记录"
      />
    </Panel>
  );
}
