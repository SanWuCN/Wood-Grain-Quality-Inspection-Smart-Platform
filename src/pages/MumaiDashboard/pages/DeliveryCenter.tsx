/**
 * 更新交付（`/firmware?tab=delivery`）
 *
 * 形态是**产物提交与分发**，不是流程展示：
 *   训练侧把训好的东西提交到平台 → 硬件侧从平台取走下载、烧录。
 *
 * 原来的实现是一张「更新包清单」+「量化与兼容性」+ 底部一条「交付步骤」时间线
 * （量化记录 → 兼容性检查 → 封装 → 下发 → 接收 → 更新 → 重启自检 → 版本确认）。
 * 那条时间线是用户点名要去掉的「太假」—— 它把一次交付画成固定的八步仪式，
 * 而真实平台上这一步只有两个动作：**提交**、**取用**。步骤名再漂亮也不解决
 * 「我要的东西在不在平台上、能不能下」这个问题。
 *
 * 现在三块：
 *   ① 待提交产物 —— 训好但还没上平台的（含手工上传），逐项提交前校验；
 *   ② 提交前校验 —— 校验不通过的产物不给提交入口，并写明差在哪；
 *   ③ 已发布产物 —— 已在平台上，可下载 / 记录烧录，并留下取用记录。
 *
 * 三类目标分开列（硬件侧端模型 / 平台模型 / 小车 OTA）：它们的校验项、
 * 目标载体与回退方式都不一样，混成一张表就只能比大小了。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Panel } from "../Panel";
import { Btn, Modal, StateBlock, StatusChip } from "../ui";
import { useMumai } from "../context";
import { permissionHint } from "../auth";
import type { DeliveryTarget } from "../seed/types";
import { ACCOUNT_NAME } from "../api/accounts";
import { api, isApiError, type ArtifactEntity, type SharedEntity } from "../api/client";
import { artifacts as artifactsOf, isOnline, useSharedStore } from "../store/shared";
import { useDeviceLink } from "../device/useDeviceLink";
import type { DeviceCommand, DeviceLedgerEntry } from "../device/types";
import { buildDistillScript, buildTrainScript } from "./terminalScripts";
import {
  buildDeliveryWorkflow,
  buildReceiveFileRows,
  resolveDeliveryScript,
  DELIVERY_UNLINKED_NOTE,
  type DeliveryWorkflow,
  type ReceiveResult,
} from "./deliveryWorkflow";

const TARGETS: DeliveryTarget[] = ["硬件侧端模型", "平台模型", "小车 OTA"];

/** 目标 → 语义色。三类产物在界面上要能一眼分开 */
const TARGET_TONE: Record<DeliveryTarget, "ok" | "info" | "warn"> = {
  硬件侧端模型: "ok",
  平台模型: "info",
  "小车 OTA": "warn",
};

/** 允许上传的产物格式 */
const ALLOWED_EXT = [".engine", ".bin", ".pt", ".onnx", ".tar", ".gz", ".zip"];

/** 从文件名推断产物给谁用 —— 推不出来就归平台模型，并让提交人自己确认 */
function inferTarget(name: string): DeliveryTarget {
  const lower = name.toLowerCase();
  if (lower.includes("cart") || lower.includes("ota") || lower.includes("slam")) return "小车 OTA";
  if (lower.includes("engine") || lower.includes("fw") || lower.includes(".bin")) return "硬件侧端模型";
  return "平台模型";
}

/** 文件名 → 展示用的版本号：去掉扩展名，够用且不会编造版本 */
function versionFromName(name: string): string {
  return name.match(/(?:^|[_-])(v?\d+(?:\.\d+){1,3})(?:[_-]|\.)/i)?.[1] ?? "未标注";
}

/**
 * 「12.40 MB」这类**已经格式化好的大小串** → 数值 + 单位，交给数字动效组件滚。
 *
 * 两个刻意的选择：
 *   · 小数位从原串里数出来（`3.12` → 2 位、`86` → 0 位），滚动前后的文本与
 *     原串逐字一致，不改平台既有的显示精度；
 *   · `group={false}` —— 这些串本来就是 `toFixed` 口径、不带千分位，
 *     开着千分位会把「1234.50 MB」显示成「1,234.50 MB」，等于偷偷换了排版。
 * 串里没有数字（例如「—」）就原样渲染，不做任何事。
 */
const SIZE_TEXT = /^([\d.]+)(.*)$/;

function SizeText({ text }: { text: string }) {
  const matched = SIZE_TEXT.exec(text.trim());
  const value = matched ? Number(matched[1]) : Number.NaN;
  if (!matched || !Number.isFinite(value)) return <>{text}</>;
  return (
    <NumberAnimation
      value={value}
      digits={matched[1].split(".")[1]?.length ?? 0}
      group={false}
      suffix={matched[2]}
    />
  );
}

/* ------------------------------------------------------------------ *
 * 上传产物
 * ------------------------------------------------------------------ */

function UploadModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (file: File, target: DeliveryTarget) => Promise<void>;
}) {
  const { toast } = useMumai();
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<DeliveryTarget>("硬件侧端模型");

  const extOk = file ? ALLOWED_EXT.some((ext) => file.name.toLowerCase().endsWith(ext)) : false;
  const sizeOk = Boolean(file && file.size > 0);
  const canSubmit = Boolean(file) && extOk && sizeOk;

  const submit = async () => {
    if (!file || !canSubmit) return;
    try {
      await onSubmit(file, target);
      toast(`${file.name} 已登记，等待提交前校验`, "ok");
      onClose();
    } catch (error) {
      toast(isApiError(error) ? error.message : "文件登记失败", "danger");
    }
  };

  return (
    <Modal
      title="上传产物"
      subtitle={<span>上传后进入待提交列表，不会直接发布</span>}
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {!file ? "请选择文件" : !extOk ? "格式不在允许列表" : !sizeOk ? "空文件" : "可以提交"}
          </span>
          <Btn onClick={onClose}>取消</Btn>
          <Btn tone="primary" disabled={!canSubmit} onClick={submit}>
            上传
          </Btn>
        </>
      }>
      <label className="pkg-drop">
        <input
          type="file"
          accept={ALLOWED_EXT.join(",")}
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (!picked) return;
            setFile(picked);
            setTarget(inferTarget(picked.name));
          }}
        />
        <span>
          <b>{file ? file.name : "点击选择产物文件"}</b>
          <em>
            {file ? (
              <>
                {/*
                  数字动效渲染出来的是 `<span>`，而 `.pkg-drop span` 是
                  `display:flex; flex-direction:column` —— 那是给外层文案列的，
                  会把这个数字也变成块级 flex 盒，把「3.12 MB」拆成两行。
                  内联样式优先级高于那条选择器，这里把它退回行内、字号颜色继续继承。
                */}
                <NumberAnimation
                  value={file.size / 1024 / 1024}
                  digits={2}
                  group={false}
                  style={{ display: "inline", fontSize: "inherit", color: "inherit" }}
                />{" "}
                MB
              </>
            ) : (
              `支持 ${ALLOWED_EXT.join(" / ")}`
            )}
          </em>
        </span>
      </label>

      <h4 className="sub">产物用途</h4>
      <div className="art-targets">
        {TARGETS.map((item) => (
          <button
            key={item}
            type="button"
            className={target === item ? "is-active" : ""}
            onClick={() => setTarget(item)}>
            {item}
          </button>
        ))}
      </div>
      <p className="note">
        从文件名推断为「{file ? inferTarget(file.name) : "—"}」，可在这里改。
      </p>
    </Modal>
  );
}

type DownloadOutcome = { name: string; size: number; sha256: string | null };

function ReceiveModal({
  artifact,
  workflow,
  online,
  busy,
  canReceive,
  onClose,
  onDownload,
  onVerify,
}: {
  artifact: SharedEntity<ArtifactEntity>;
  workflow: DeliveryWorkflow;
  online: boolean;
  busy: string | null;
  canReceive: boolean;
  onClose: () => void;
  onDownload: (artifact: SharedEntity<ArtifactEntity>, file: { fileId: string; role: string }) => Promise<DownloadOutcome | null>;
  onVerify: (artifact: SharedEntity<ArtifactEntity>, file: File) => Promise<boolean>;
}) {
  const [results, setResults] = useState<Record<string, ReceiveResult>>({});
  const [verifyState, setVerifyState] = useState<"idle" | "passed" | "failed">("idle");
  const rows = buildReceiveFileRows(artifact, results);
  const received = rows.filter((row) => row.state === "已接收").length;
  const failed = rows.filter((row) => row.state === "失败").length;
  const total = rows.length;

  return (
    <Modal
      wide
      title="数据接收台"
      subtitle={`${artifact.data.name} · ${artifact.data.modelVersion} · ${artifact.data.target}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted">{online ? `本次接收 ${received}/${total} 个文件` : "共享服务未连接"}</span>
          <Btn onClick={onClose}>关闭</Btn>
        </>
      }>
      <div className="receive-head">
        <div>
          <b>接收进度</b>
          <span>{received}/{total} 个文件已写入本次接收记录</span>
        </div>
        <strong>{total ? Math.round((received / total) * 100) : 0}%</strong>
        <progress max={Math.max(total, 1)} value={received} />
      </div>

      <div className="receive-meta">
        <div><small>平台状态</small><b>{artifact.data.state}</b></div>
        <div><small>服务端取用</small><b>{artifact.data.downloadCount ?? 0} 次</b></div>
        <div><small>摘要回验</small><b>{workflow.receiptSummary}</b></div>
        {/* 作业号取不到就写清"未关联"，不显示空白也不挂别的作业号 */}
        <div><small>交付作业</small><b>{workflow.runId ?? "未关联"}</b></div>
      </div>

      <h4 className="sub">文件清单</h4>
      <ul className="receive-files">
        {rows.length ? rows.map((row) => {
          const file = artifact.data.files.find((item) => item.fileId === row.fileId);
          if (!file) return null;
          return (
            <li key={row.fileId} className={`is-${row.state === "已接收" ? "ok" : row.state === "失败" ? "bad" : "wait"}`}>
              <span className="receive-files__copy">
                <b>{row.role}</b>
                <small>{row.fileId}</small>
              </span>
              <StatusChip text={row.state} tone={row.state === "已接收" ? "ok" : row.state === "失败" ? "danger" : "muted"} dot />
              <span className="receive-files__digest">{row.sha256 ? `SHA-256 ${row.sha256.slice(0, 16)}…` : row.message ?? "等待接收"}</span>
              <Btn
                disabled={!online || !canReceive || busy !== null}
                title={!canReceive ? permissionHint("deployment:receive") : "接收服务端登记文件"}
                onClick={() => {
                  void onDownload(artifact, file).then((saved) => {
                    setResults((current) => ({
                      ...current,
                      [file.fileId]: saved
                        ? { state: "已接收", size: saved.size, sha256: saved.sha256 }
                        : { state: "失败", message: "下载失败，请检查连接" },
                    }));
                  });
                }}>
                {row.state === "失败" ? "重试" : row.state === "已接收" ? "重新接收" : "接收"}
              </Btn>
            </li>
          );
        }) : <li className="receive-files__empty">服务端未登记可接收文件</li>}
      </ul>

      <div className="receive-verify">
        <div>
          <b>摘要回验</b>
          <span>选择接收后的文件，由浏览器计算 SHA-256 后提交平台核对</span>
        </div>
        <label className={`btn${!online || !canReceive ? " is-disabled" : ""}`}>
          {verifyState === "passed" ? "回验通过" : verifyState === "failed" ? "重新回验" : "选择文件回验"}
          <input
            type="file"
            hidden
            disabled={!online || !canReceive || busy !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void onVerify(artifact, file).then((pass) => setVerifyState(pass ? "passed" : "failed"));
            }}
          />
        </label>
      </div>

      {failed > 0 ? <p className="receive-alert">有 {failed} 个文件接收失败，可在对应行重试</p> : null}
      {artifact.data.receipts.some((receipt) => !receipt.pass) ? (
        <ul className="receive-alerts">
          {artifact.data.receipts.filter((receipt) => !receipt.pass).map((receipt, index) => (
            <li key={`${receipt.at}-${index}`}>{receipt.at.slice(0, 19).replace("T", " ")} · {receipt.note || "摘要回验未通过"}</li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 下发到设备（PRD-第二章演示改造与验收标准 PR-03 / K-5）
 *
 * 剧本 S18 那句「更新包已下发，请接收」原来在平台上**没有入口**：
 * 设备命令白名单里有 `prepare_update`，但全仓没有一处调用它（盘点文档 B-21）。
 * 这里补的就是那一步：选设备 → 带产物编号 / 版本 / 下载地址 / 摘要下发 → 看回执。
 *
 * 三条口径（照抄设备网关与 PRD，不自己发明）：
 *   · `accepted ≠ executed`：下发成功只写「已下发」，剩下的等设备回执；
 *   · 回执是**设备报上来的**：页面从 `/api/devices/{id}/hardware` 的
 *     `recentCommands` 读，读不到就如实写「等待」——不替设备宣布执行完成；
 *   · 下载地址给**绝对地址**：设备在另一台机器上，收不到相对的 `/api/...`。
 * ------------------------------------------------------------------ */

/** 命令状态 → 页面措辞。终端词典（queued/sent/accepted/executed/failed） */
const COMMAND_STATE_LABEL: Record<string, string> = {
  queued: "排队中",
  sent: "已下发",
  accepted: "设备已接收",
  executed: "设备已执行",
  failed: "设备报错",
};

/** 命令动作 → 设备上发生的事。页面上让人看懂这条命令让终端做了什么 */
const COMMAND_ACTION_LABEL: Record<string, string> = {
  prepare_update: "接收更新包",
  query_status: "回报状态快照",
  request_upload: "上传当前批次",
  assign_task: "绑定工单",
  apply_config: "应用配置",
  pause_capture: "暂停采集",
};

function commandTone(state: string): "ok" | "info" | "warn" | "danger" | "muted" {
  if (state === "executed") return "ok";
  if (state === "accepted") return "info";
  if (state === "sent" || state === "queued") return "warn";
  if (state === "failed") return "danger";
  return "muted";
}

function DispatchModal({
  artifact,
  online,
  canDispatch,
  onClose,
  onDispatched,
}: {
  artifact: SharedEntity<ArtifactEntity>;
  online: boolean;
  canDispatch: boolean;
  onClose: () => void;
  onDispatched: (info: { deviceId: string; commandId: string }) => void;
}) {
  const { toast, pushEvent } = useMumai();
  const [ledger, setLedger] = useState<DeviceLedgerEntry[] | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [busy, setBusy] = useState(false);
  /** 本次下发的命令号：回执按它读，避免拿到上一次同类型命令的状态 */
  const [issued, setIssued] = useState<{ deviceId: string; commandId: string } | null>(null);

  /** 设备名录来自共享服务（换台电脑打开看到的是同一份） */
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const result = await api.deviceLedger();
        if (!disposed) setLedger(result.devices);
      } catch {
        /* 取不到就显示「读不到设备名录」——不假装有设备可发 */
        if (!disposed) setLedger([]);
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const link = useDeviceLink(issued?.deviceId ?? deviceId, { enabled: Boolean(issued?.deviceId ?? deviceId) });
  const receipt: DeviceCommand | null =
    issued && link.view
      ? link.view.recentCommands.find((item) => item.commandId === issued.commandId) ?? null
      : null;

  /** 能收命令的设备：链路在线（6 秒内有上报）。命令通道另标一行，不拿它当门槛 */
  const ready = (ledger ?? []).filter((item) => item.link?.state === "online");
  const selected = ready.find((item) => item.deviceId === deviceId) ?? null;
  const artifactFile = artifact.data.files[0] ?? null;

  /**
   * 下发。
   *
   * `args` 里的四个字段就是 PRD PR-03 点名的：产物编号 / 版本 / 下载地址 / 摘要；
   * 同一份载荷再进 `payload` —— 设备网关把 `args` 与业务体分开给终端，
   * 只给一份时真机会读不到（`device-gateway.mjs:685` 的注释记着这个坑）。
   */
  const dispatch = async () => {
    if (!selected || !artifactFile) return;
    setBusy(true);
    try {
      const downloadUrl = new URL(api.downloadUrl(artifactFile.fileId), window.location.origin).toString();
      const payload = {
        artifactId: artifact.id,
        name: artifact.data.name,
        version: artifact.data.modelVersion,
        downloadUrl,
        sha256: artifact.data.sha256,
        sizeText: artifact.data.sizeText,
      };
      const result = await api.deviceCommand(selected.deviceId, "prepare_update", payload);
      setIssued({ deviceId: selected.deviceId, commandId: result.command.commandId });
      onDispatched({ deviceId: selected.deviceId, commandId: result.command.commandId });
      toast(result.hint, result.pushed ? "info" : "warn");
      pushEvent(
        `更新包 ${artifact.data.name} 下发到 ${selected.deviceId}：${COMMAND_STATE_LABEL[result.command.state] ?? result.command.state}`,
        result.pushed ? "ok" : "warn",
      );
    } catch (error) {
      toast(isApiError(error) ? error.message : "下发失败", "danger");
    } finally {
      setBusy(false);
    }
  };

  const receiptLabel = receipt ? COMMAND_STATE_LABEL[receipt.state] ?? receipt.state : "等待设备回执";
  const at = (value: string | null) => (value ? `${value.slice(11, 19)}` : "—");

  return (
    <Modal
      title="下发到设备"
      subtitle={<span>{artifact.data.name} · {artifact.data.modelVersion} · {artifact.data.target}</span>}
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {!canDispatch
              ? permissionHint("scan:capture")
              : !online
                ? "连接不上共享服务"
                : !artifactFile
                  ? "这份产物没有登记文件，没有可下载的地址"
                  : (ledger ?? []).length === 0
                    ? "还没有设备接入"
                    : issued
                      ? `已下发命令 ${issued.commandId}`
                      : "确认后把产物编号、版本、下载地址与摘要一起发给设备"}
          </span>
          <Btn onClick={onClose}>关闭</Btn>
          <Btn
            tone="primary"
            disabled={busy || !canDispatch || !online || !artifactFile || !selected || Boolean(issued)}
            onClick={() => void dispatch()}>
            {issued ? "已下发" : "确认下发"}
          </Btn>
        </>
      }>
      <div className="dispatch">
        <dl className="dispatch__pkg">
          <div>
            <dt>产物编号</dt>
            <dd>{artifact.id}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{artifact.data.modelVersion}</dd>
          </div>
          <div>
            <dt>摘要</dt>
            <dd>{artifact.data.sha256 ? `${artifact.data.sha256.slice(0, 16)}…` : "—"}</dd>
          </div>
          <div>
            <dt>下载地址</dt>
            <dd>{artifactFile ? `${window.location.origin}/api/files/…` : "—"}</dd>
          </div>
        </dl>

        <h4 className="sub">目标设备</h4>
        {/*
          ⚠ 这里的判据是「名录里有没有设备」，**不是**「有没有在线的设备」。
          写成 `ready.length === 0 ? <空状态/> : <列表/>` 踩过一个坑：设备列表是 5 秒
          轮询的，某一次刷新恰好在"设备掉线"的窗口里，列表就被空状态替掉，
          但 state 里 `deviceId` 还记着那台设备 —— 于是底部按钮可点、上面的设备却没了，
          点下去对着一个已经不显示的设备发命令。空状态只在**确实一台都没有**时出现。
        */}
        {ledger === null ? (
          <p className="note">正在读设备名录…</p>
        ) : (ledger ?? []).length === 0 ? (
          <StateBlock
            kind="offline"
            title="还没有设备接入"
            hint="设备接入后（树莓派终端启动并上报）才会出现在这里。设备不在线时命令只会排在队列里，现场看不出「发没发出去」。"
          />
        ) : (
          <>
            <ul className="dispatch__devices">
              {(ledger ?? []).map((item) => {
                const online = item.link?.state === "online";
                return (
                  <li key={item.deviceId}>
                    <button
                      type="button"
                      className={item.deviceId === deviceId ? "is-active" : ""}
                      onClick={() => setDeviceId(item.deviceId)}
                      disabled={Boolean(issued)}>
                      <b>{item.deviceId}</b>
                      <span>
                        {/*
                          `host` 在类型上是 `Record<string, unknown>`（终端报什么就存什么），
                          渲染前统一过一遍 String()：直接塞 unknown 进 JSX 编译不过，
                          也不会因为设备换了一台就崩。
                        */}
                        {String(item.hardware?.model ?? item.host?.hostname ?? "设备")}
                        {item.host?.hostname ? ` · ${String(item.host.hostname)}` : ""}
                      </span>
                      <em>
                        {online ? "在线" : item.link?.state === "stale" ? "延迟" : "离线"}
                        {" · "}
                        当前版本 {item.modelVersion ?? "—"}
                        {" · "}
                        {item.link?.socketConnected ? "命令通道已连接" : "命令通道未连接（下发后排队）"}
                      </em>
                    </button>
                  </li>
                );
              })}
            </ul>
            {ready.length === 0 ? (
              <p className="note">
                名录里的设备现在都不在线（6 秒内没有上报）。选离线的设备也能发，命令会排在队列里等它上线。
              </p>
            ) : null}
          </>
        )}

        {issued && selected ? (
          <>
            <h4 className="sub">下发回执</h4>
            <ul className="dispatch__receipt">
              <li data-cmd={issued.commandId}>
                <span>命令</span>
                <b>{issued.commandId}</b>
                <em>
                  {(COMMAND_ACTION_LABEL[receipt?.action ?? "prepare_update"] ?? "下发产物")} ·{" "}
                  {receipt?.action ?? "prepare_update"}
                </em>
              </li>
              <li>
                <span>状态</span>
                <StatusChip text={receiptLabel} tone={commandTone(receipt?.state ?? "sent")} dot />
                <em>
                  {receipt
                    ? `下发 ${at(receipt.createdAt)} · 送达 ${at(receipt.sentAt)} · 接收 ${at(receipt.acceptedAt)} · 执行 ${at(receipt.executedAt)}`
                    : "命令已发出，等设备回报"}
                </em>
              </li>
              <li>
                <span>版本</span>
                <b>
                  {selected.modelVersion ?? "—"} → {artifact.data.modelVersion}
                </b>
                <em>目标版本是这份产物登记的版本；设备回报的版本以设备为准</em>
              </li>
              {receipt?.reason ? (
                <li>
                  <span>设备说明</span>
                  <b>{receipt.reason}</b>
                  <em>{receipt.errorCode ?? ""}</em>
                </li>
              ) : null}
            </ul>
            {receipt?.state === "failed" ? (
              <p className="receive-alert">设备回报失败：{receipt.reason ?? receipt.errorCode ?? "未给原因"}</p>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 页签
 * ------------------------------------------------------------------ */

export function DeliveryTab() {
  const { toast, pushEvent, can } = useMumai();
  /** 产物清单放进 state：提交会就地把它从待提交挪到已发布 */
  const [selectedId, setSelectedId] = useState<string>("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [receiveId, setReceiveId] = useState<string | null>(null);
  /** 正在下发的产物 id（「下发到设备」弹窗对着哪一份产物） */
  const [dispatchId, setDispatchId] = useState<string | null>(null);
  /**
   * 本次会话下发过谁：产物 id → 命令号。
   *
   * 只记在页面上，**不落库**：设备命令的真相在设备台账里（`recentCommands`），
   * 这里只是「我刚发的是哪一条」，刷新页面后由设备页那份台账回答，不另造一份状态。
   */
  const [dispatched, setDispatched] = useState<Record<string, { deviceId: string; commandId: string }>>({});

  /**
   * 已发布产物来自共享服务，不再来自本地 useState。
   *
   * 评审 F02 的现象是「点击下载只增加取用记录；切换页签再回来，已发布候选产物
   * 又重新待发布」—— 根因是「哪些产物在平台上」只活在这个组件的内存里。
   * 现在它由服务端持有：切页、刷新、换一台电脑都读到同一份。
   */
  const sharedArtifacts = useSharedStore(artifactsOf);
  const online = useSharedStore(isOnline);
  const [busy, setBusy] = useState<string | null>(null);
  const distillScript = useMemo(() => buildDistillScript(), []);
  /** 全量重训脚本：产物的 fromJob 指向它才算出自重训作业 */
  const trainScript = useMemo(() => buildTrainScript(), []);

  const pending = sharedArtifacts.filter((item) => !["已发布", "已下载", "已回验"].includes(item.data.state));
  const published = sharedArtifacts.filter((item) => ["已发布", "已下载", "已回验"].includes(item.data.state));
  const selected = pending.find((item) => item.id === selectedId) ?? pending[0] ?? null;

  const selectedChecks = useMemo(
    () => selected
      ? [
          {
            key: "file",
            label: "文件登记",
            pass: selected.data.files.length > 0,
            detail: `${selected.data.files.length} 个服务端文件引用`,
          },
          {
            key: "digest",
            label: "摘要",
            pass: Boolean(selected.data.sha256),
            detail: selected.data.sha256 || "服务端尚未生成摘要",
          },
          {
            key: "state",
            label: "服务端构建状态",
            pass: selected.data.state === "checked",
            detail: selected.data.state,
          },
        ]
      : [],
    [selected],
  );
  const failed = useMemo(() => selectedChecks.filter((check) => !check.pass), [selectedChecks]);

  const canSubmit = can("package:deliver");
  /**
   * 下发到设备的权限。
   *
   * 与后端同源：`POST /api/devices/{id}/commands` 认的是 `scan:capture` 或
   * `console:admin`（`server/api/http.mjs:423`）。前端这里照抄，不让按钮先亮后灰。
   */
  const canDispatch = can("scan:capture") || can("console:admin");

  /** 提交走服务端命令，只有服务端返回后才显示发布成功 */
  const submit = async (artifact: SharedEntity<ArtifactEntity>) => {
    setBusy(`publish:${artifact.id}`);
    try {
      const result = await useSharedStore.getState().send({
        action: "artifact.publish",
        entityId: artifact.id,
        expectedRevision: artifact.revision,
        payload: {},
      });
      const publishedArtifact = result.entity?.data as ArtifactEntity | undefined;
      pushEvent(`产物 ${publishedArtifact?.name ?? artifact.data.name} 已提交到平台`, "ok");
      toast(`${publishedArtifact?.name ?? artifact.data.name} 已发布，其他工程师可以下载`, "ok");
    } catch (error) {
      toast(isApiError(error) ? error.message : "产物发布失败", "danger");
    } finally {
      setBusy(null);
    }
  };

  const registerUpload = async (file: File, target: DeliveryTarget) => {
    if (!online) throw new Error("连接不上共享服务，无法登记产物");
    const uploaded = await api.upload(file, useSharedStore.getState().sessionId, "artifacts");
    await useSharedStore.getState().send({
      action: "artifact.build",
      payload: {
        name: file.name,
        kind: "模型包",
        target,
        modelVersion: versionFromName(file.name),
        demoOnly: true,
        files: [{ fileId: uploaded.fileId, role: "整包" }],
      },
    });
  };

  /**
   * 真实下载。
   *
   * 原来这里是 `recordUse(artifact, "已下载")`：只往本地列表塞一条取用记录，
   * 浏览器根本不会产生下载事件（评审 F02 第一条）。现在直接打到
   * `/api/files/{id}/download`，服务端返回真实字节 + Content-Disposition，
   * 并把产物的状态从「已发布」推到「已下载」—— 切页与刷新都不会回退，
   * 因为那条状态在服务端，不在这个组件的 useState 里。
   */
  const download = async (
    artifact: SharedEntity<ArtifactEntity>,
    entry: { fileId: string; role: string },
  ): Promise<DownloadOutcome | null> => {
    setBusy(`download:${artifact.id}`);
    try {
      const fallbackName = `${artifact.data.name.replace(/\.[^.]+$/, "")}-${entry.role}`;
      const saved = await api.download(entry.fileId, fallbackName);
      pushEvent(
        `已下载 ${saved.name}（${(saved.size / 1024).toFixed(1)} KB，摘要 ${saved.sha256?.slice(0, 12) ?? "—"}…）`,
        "ok",
      );
      toast(`已下载 ${saved.name}`, "ok");
      return saved;
    } catch (error) {
      toast(isApiError(error) ? error.message : "下载失败", "danger");
      return null;
    } finally {
      setBusy(null);
    }
  };

  /**
   * 回验：让操作员选回刚下载的那份文件，浏览器算它的 SHA-256 再提交。
   *
   * PRD §10.3 建议的做法就是 `crypto.subtle.digest` 读 ArrayBuffer 做小文件复核。
   * 这样「摘要一致」是真的算出来的，不是拿服务端自己的值回填一个通过 ——
   * 选错文件就会走失败分支（验收 T11 要的正是这个）。
   *
   * ⚠ `crypto.subtle` 与 `crypto.randomUUID` 一样**只在安全上下文**里有：
   * 同事从 `http://<局域网IP>:8000` 打开时它是 undefined，原来会抛一句
   * "Cannot read properties of undefined"、界面只显示「回验失败」——
   * 现场会以为是文件不对。这种情况**不许拿服务端的值凑一个"通过"**
   * （那就等于自己跟自己比），只能如实说清做不到、以及该在哪台机器上做。
   */
  const verify = async (artifact: SharedEntity<ArtifactEntity>, file: File): Promise<boolean> => {
    setBusy(`verify:${artifact.id}`);
    try {
      if (!globalThis.crypto?.subtle) {
        toast("内网 http 地址下浏览器不给算摘要（Web Crypto 只在 https / localhost 可用）：请在平台本机（localhost）做这一步回验", "warn");
        return false;
      }
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await useSharedStore.getState().send({
        action: "artifact.receipt",
        entityId: artifact.id,
        expectedRevision: artifact.revision,
        payload: { reportedVersion: artifact.data.modelVersion, verifiedHash: hash, deviceMode: "manual-receive" },
      });
      const receipt = result.result.receipt as { pass: boolean; note: string } | undefined;
      toast(receipt?.note ?? "回验完成", receipt?.pass ? "ok" : "danger");
      pushEvent(
        `${artifact.data.name} 回验${receipt?.pass ? "通过" : "未通过"}：本地摘要 ${hash.slice(0, 12)}…`,
        receipt?.pass ? "ok" : "danger",
      );
      return Boolean(receipt?.pass);
    } catch (error) {
      toast(isApiError(error) ? error.message : "回验失败", "danger");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const renderRow = (entity: SharedEntity<ArtifactEntity>) => {
    const artifact = entity.data;
    const rowFailed = artifact.state !== "checked" ? ["state"] : [];
    return (
    <li
      key={entity.id}
      className={`art-row${selected?.id === entity.id ? " is-selected" : ""}`}>
      <button
        type="button"
        className="art-row__main is-static"
        onClick={() => setSelectedId(entity.id)}>
        <span className="art-row__name">
          <b>{artifact.name}</b>
          <i>
            {artifact.fromJob ?? "手工上传"} · {entity.updatedAt.slice(0, 16).replace("T", " ")}
          </i>
        </span>
        <StatusChip text={artifact.target} tone={TARGET_TONE[artifact.target as DeliveryTarget] ?? "info"} />
        <span className="art-row__ver">{artifact.modelVersion}</span>
        <span className="art-row__num">
          <SizeText text={artifact.sizeText} />
        </span>
        <span className="art-row__num">{artifact.sha256}</span>
        <span className="art-row__checks">
          {rowFailed.length > 0 ? (
            <StatusChip
              /* chip 是 `inline-flex + gap:5px`：整段文案包一层 span，数字才不会被 gap 撑开 */
              text={
                <span>
                  <NumberAnimation value={rowFailed.length} /> 项待处理
                </span>
              }
              tone="warn"
            />
          ) : (
            <StatusChip text="校验通过" tone="ok" />
          )}
        </span>
      </button>
      <span className="art-row__act">
        <Btn
          tone="primary"
          disabled={!canSubmit || rowFailed.length > 0 || !online || busy !== null}
          title={
            !canSubmit
              ? permissionHint("package:deliver")
              : rowFailed.length > 0
                ? "产物尚未完成服务端校验，不能发布"
                : "提交到平台，其他工程师可下载"
          }
          onClick={() => void submit(entity)}>
          提交
        </Btn>
      </span>
    </li>
    );
  };

  /**
   * 四段轨道：生成 → 校验 → 发布 → 接收。
   *
   * 评审 U04/V08 说这一页「字段横向分散，主操作混在长列表里」，PRD §4.5 要求
   * 「候选包、检查结果、发布和接收形成顺序；当前步骤展开详细内容，已完成步骤显示摘要」。
   * 所以把**当前产物**提到最上面，用一条轨道说明它走到哪一步、下一步该谁做什么 ——
   * 下面是全量表格，看细节时再往下翻。
   */
  /** 当前产物 = 最新一条已发布/已回验的产物，阶段记录来自量化脚本与共享服务 */
  const current = published[0] ?? null;
  /*
    ── 作业号必须按产物自己的 `fromJob` 找脚本（现场口径缺陷修复）──────────
    原实现无条件传 `distillScript`，于是「交付作业」那行对**任何**产物都显示
    蒸馏作业号 run-20260911-0244，量化/复测/封装三格也永远来自那个脚本 ——
    种子产物其实是 `EXP-2026-0911`、人工上传是 `null`，都不出自蒸馏作业。
    现在先按 `fromJob` 匹配；匹配不到就传 `null`，页面统一显示 `DELIVERY_UNLINKED_NOTE`。
  */
  const scriptFor = useCallback(
    (item: SharedEntity<ArtifactEntity> | null) =>
      item ? resolveDeliveryScript([distillScript, trainScript], item.data.fromJob) : null,
    [distillScript, trainScript],
  );
  const workflow = useMemo(
    () => (current ? buildDeliveryWorkflow(scriptFor(current), current) : null),
    [current, scriptFor],
  );
  const receiveArtifact = receiveId ? sharedArtifacts.find((item) => item.id === receiveId) ?? null : null;
  const dispatchArtifact = dispatchId ? sharedArtifacts.find((item) => item.id === dispatchId) ?? null : null;

  return (
    <div className="delivery">
      {current && workflow ? (
        <Panel
          title="本轮产物"
          extra={
            <span className="fw-console__actions">
              <StatusChip
                text={current.data.state}
                tone={current.data.state === "已回验" ? "ok" : "info"}
              />
              <Btn tone="ghost" disabled={!online} onClick={() => setReceiveId(current.id)}>
                打开接收台
              </Btn>
            </span>
          }
          className="dl-track-panel">
          <div className="dl-track__head">
            <b>{current.data.name}</b>
            <span>
              {current.data.target} · {current.data.modelVersion} ·{" "}
              {workflow.runId
                ? `作业 ${workflow.runId} · ${workflow.command}`
                : DELIVERY_UNLINKED_NOTE}
            </span>
          </div>
          <ol className="dl-track">
            {workflow.steps.map((step, index) => {
              const next = step.state === "进行中" || (step.state === "等待" && workflow.steps.slice(0, index).every((item) => item.state === "已完成"));
              return (
                <li key={step.key} className={`${step.state === "已完成" ? "is-done" : next ? "is-next" : "is-wait"}`}>
                  <span className="dl-track__dot" />
                  <b>{step.label}</b>
                  <em>{step.state}</em>
                  <span className="dl-track__detail">{step.detail}</span>
                </li>
              );
            })}
          </ol>
        </Panel>
      ) : null}

      <Panel
        title="待提交产物"
        extra={
          <span className="fw-console__actions">
            <Btn
              tone="ghost"
              disabled={!canSubmit || !online}
              title={!canSubmit ? permissionHint("package:deliver") : online ? "上传产物文件" : "共享服务未连接"}
              onClick={() => setUploadOpen(true)}>
              上传产物
            </Btn>
          </span>
        }
        className="dl-panel">
        {pending.length > 0 ? (
          <>
            <div className="art-head">
              <span>产物</span>
              <span>用途</span>
              <span>版本</span>
              <span>大小</span>
              <span>摘要</span>
              <span>提交前校验</span>
              <span />
            </div>
            <ul className="art-list">{pending.map((item) => renderRow(item))}</ul>
          </>
        ) : (
          <StateBlock
            kind="empty"
            title="没有待提交产物"
            hint="训练产出的模型或手工上传的文件会出现在这里。"
          />
        )}
      </Panel>

      <Panel
        title="提交前校验"
        extra={
          selected ? (
            <StatusChip
              /*
                chip 是 `inline-flex + gap:5px`：整段文案包一层 span，数字才不会被 gap 撑开。
                「全部通过」那一支保持原样，不把 0 显示成「0 项未通过」。
              */
              text={
                failed.length > 0 ? (
                  <span>
                    <NumberAnimation value={failed.length} /> 项未通过
                  </span>
                ) : (
                  "全部通过"
                )
              }
              tone={failed.length > 0 ? "warn" : "ok"}
              dot
            />
          ) : undefined
        }
        className="dl-panel dl-panel--checks">
        {selected ? (
          <>
            <ul className="pkg-checks">
              {selectedChecks.map((check) => (
                <li key={check.key} className={check.pass ? "is-ok" : "is-bad"}>
                  <b>{check.label}</b>
                  <span>{check.detail}</span>
                </li>
              ))}
            </ul>
            {failed.length > 0 ? (
              <p className="dl-block">
                有 <NumberAnimation value={failed.length} /> 项未通过，暂不能发布。校验不通过的产物不给提交入口 ——
                发布出去的是别人要烧进设备的东西，不能靠「先发了再说」。
              </p>
            ) : null}
          </>
        ) : (
          <StateBlock kind="empty" title="先选一份待提交产物" />
        )}
      </Panel>

      <Panel
        title="已发布产物"
        extra={
          online ? (
            <span className="muted">
              <NumberAnimation value={published.length} /> 项 · 平台可下载
            </span>
          ) : (
            <StatusChip text="未连接共享服务" tone="warn" />
          )
        }
        className="dl-panel">
        <div className="art-head">
          <span>产物</span>
          <span>用途</span>
          <span>版本</span>
          <span>大小</span>
          <span>摘要</span>
          <span>状态</span>
          <span />
        </div>
        <ul className="art-list">
          {published.length ? (
            published.map((item) => (
              <li key={item.id} className="art-row">
                <span className="art-row__main">
                  <span className="art-row__name">
                    <b>{item.data.name}</b>
                    <i>
                      {item.data.fromJob ?? "手工上传"} · rev <NumberAnimation value={item.revision} />
                      {item.data.demoOnly ? " · 不可烧录归档资产" : ""}
                    </i>
                  </span>
                  <StatusChip text={item.data.target} tone="info" />
                  <span className="art-row__ver">{item.data.modelVersion}</span>
                  <span className="art-row__num">
                    <SizeText text={item.data.sizeText} />
                  </span>
                  <span className="art-row__num">{item.data.sha256.slice(0, 16)}…</span>
                  <span className="art-row__checks">
                    <StatusChip
                      text={item.data.state}
                      tone={item.data.state === "已回验" ? "ok" : item.data.state === "已下载" ? "info" : "muted"}
                    />
                    {item.data.downloadCount ? (
                      <em className="muted">
                        取用 <NumberAnimation value={item.data.downloadCount} /> 次
                      </em>
                    ) : null}
                  </span>
                </span>
                <span className="art-row__act">
                  <Btn
                    disabled={!online}
                    title={online ? "打开文件接收、进度与回验视图" : "连接不上共享服务，无法接收"}
                    onClick={() => setReceiveId(item.id)}>
                    打开接收台
                  </Btn>
                  {/*
                    下发到设备（PRD PR-03）。
                    按钮一直可见，但没有权限时置灰并写明缺哪条权限 —— 藏掉按钮
                    会让人以为平台没这个功能（这正是这次要补的那一步）。
                  */}
                  <Btn
                    tone="primary"
                    disabled={!canDispatch || !online || busy !== null}
                    title={
                      !canDispatch
                        ? permissionHint("scan:capture")
                        : online
                          ? "把这个更新包发给手持终端（记录下发与回执）"
                          : "连接不上共享服务，无法下发"
                    }
                    onClick={() => setDispatchId(item.id)}>
                    下发到设备
                  </Btn>
                  {dispatched[item.id] ? (
                    <em className="muted" title={`命令 ${dispatched[item.id].commandId}`}>
                      已发 {dispatched[item.id].deviceId} · {dispatched[item.id].commandId.slice(-6)}
                    </em>
                  ) : null}
                </span>
              </li>
            ))
          ) : (
            <li className="art-row">
              <StateBlock
                kind={online ? "empty" : "offline"}
                title={online ? "平台还没有已发布产物" : "未连接共享服务"}
                hint={online ? "提交一份待提交产物后，这里会出现可下载的产物。" : "交付状态保存在服务端，连接恢复后自动显示。"}
              />
            </li>
          )}
        </ul>

        {/* 回验记录：谁在什么时候提交了什么摘要。交付的闭环就在这张表上 */}
        <h4 className="sub">回验与取用记录</h4>
        <ol className="art-used">
          {sharedArtifacts
            .flatMap((item) =>
              item.data.receipts.map((receipt) => ({
                at: receipt.at,
                by: receipt.actor,
                action: receipt.pass ? "回验通过" : "回验未通过",
                name: item.data.name,
                note: receipt.note,
              })),
            )
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 6)
            .map((use, index) => (
              <li key={`${use.at}-${use.name}-${index}`}>
                <time>{use.at.slice(11, 19)}</time>
                <b>{ACCOUNT_NAME[use.by] ?? use.by}</b>
                <span>
                  {use.action} · {use.name}
                  {use.note ? ` · ${use.note}` : ""}
                </span>
              </li>
            ))}
        </ol>
      </Panel>

      {uploadOpen ? (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onSubmit={registerUpload}
        />
      ) : null}

      {receiveArtifact ? (
        <ReceiveModal
          artifact={receiveArtifact}
          workflow={buildDeliveryWorkflow(scriptFor(receiveArtifact), receiveArtifact)}
          online={online}
          busy={busy}
          canReceive={can("deployment:receive")}
          onClose={() => setReceiveId(null)}
          onDownload={download}
          onVerify={verify}
        />
      ) : null}

      {dispatchArtifact ? (
        <DispatchModal
          artifact={dispatchArtifact}
          online={online}
          canDispatch={canDispatch}
          onClose={() => setDispatchId(null)}
          onDispatched={(info) => setDispatched((current) => ({ ...current, [dispatchArtifact.id]: info }))}
        />
      ) : null}
    </div>
  );
}

export default DeliveryTab;
