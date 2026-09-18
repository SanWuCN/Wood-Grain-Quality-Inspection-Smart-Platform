/**
 * 数据接收（`/hardware?tab=receive`）· 剧本点名的「数据接收页」
 *
 * ── 谁在用这一页 ────────────────────────────────────────────────────
 * 讲解人：「到达现场后我会分别检查小车数据通道、手持设备通道和场景文件网络通道。
 * 三类数据使用同一工单编号，采集时间各自独立记录」；
 * ⑦ 小木：「我按设备编号核对数据来源，确认平台显示的是本次设备数据，不串数据」；
 * ⑯ 小木：「我正在按样本编号核对文件和路径记录。缺失项会保留在补采清单中，
 * 已接收文件不会重复要求上传」；史：「手持数据已进入接收页」。
 *
 * ── 三条边界 ────────────────────────────────────────────────────────
 *   1. **只读**：这一页没有任何写入口（接收是设备侧推、平台侧落盘的动作）；
 *   2. **通道现状来自服务端自检**（`/api/device-readiness`，与「设备接入」页同一份），
 *      探针没数据就写「未接通」—— 现场靠这一栏判断该查哪一头，不按推断写在线；
 *   3. **数字只从数据包来**：清单与路径记录都读 `seed/scenario.ts` 的冻结数据，
 *      本组件不写任何数值。
 *
 * ── 为什么挂在「硬件详情」下 ────────────────────────────────────────
 * PRD 2.2 的一级导航固定八项；剧本把「设备页、环境记录页和数据接收页」放在同一句里说，
 * 与「采集作业 / 环境记录 / 异常排查 / 硬件监看 / 设备接入」是同一组页签。
 */

import { useEffect, useState } from "react";
import { Panel } from "../Panel";
import { Icon } from "../icons";
import { apiRequest, isApiError } from "../api/client";
import { Btn, DataTable, KV, SourceTag, StateBlock, StatusChip } from "../ui";
import type { Tone } from "../lib";
import {
  channelsOf,
  receiveNotes,
  receiveRows,
  receiveTally,
  referenceRows,
  rowsByBatch,
  sampleChecks,
  type ChannelState,
  type ReadinessLike,
} from "./receiveChannel";
import "./receiveChannel.css";

/** 通道状态 → 语义色（与「设备接入」页的LEVEL_CHIP 同一套口径） */
const CHANNEL_CHIP: Record<ChannelState, { text: string; tone: Tone }> = {
  ok: { text: "已接通", tone: "ok" },
  warn: { text: "部分可用", tone: "warn" },
  fail: { text: "未接通", tone: "danger" },
  unknown: { text: "无自检结论", tone: "muted" },
  checking: { text: "正在自检…", tone: "info" },
};

const STATE_TONE: Record<string, Tone> = {
  已入库: "ok",
  待审核: "warn",
  已驳回: "danger",
};

/**
 * 自检结论的模块级缓存（60 秒）。
 *
 * 服务端这一路要**逐路探设备**（实测约 3 秒），而演示时会在「数据接收 / 设备接入」
 * 两个页签之间来回切 —— 每次都重新探一遍，页面上就是反复的"正在自检…"。
 * 缓存只影响**读取**：点「重新自检」永远强制重探（现场要先看最新结论时用它）。
 */
let readinessCache: { at: number; value: NonNullable<ReadinessLike> } | null = null;
const READINESS_TTL_MS = 60_000;

export function ReceiveChannelsTab() {
  const [readiness, setReadiness] = useState<ReadinessLike>(() =>
    readinessCache && Date.now() - readinessCache.at < READINESS_TTL_MS ? readinessCache.value : null,
  );
  const [probeError, setProbeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* 通道现状现取自服务端自检（与「设备接入」页读同一个接口，页面不各自算一套） */
  const load = async (force = false) => {
    setBusy(true);
    try {
      if (!force && readinessCache && Date.now() - readinessCache.at < READINESS_TTL_MS) {
        setReadiness(readinessCache.value);
        setProbeError(null);
        return;
      }
      const value = await apiRequest<NonNullable<ReadinessLike>>("/api/device-readiness");
      readinessCache = { at: Date.now(), value };
      setReadiness(value);
      setProbeError(null);
    } catch (error) {
      setReadiness(null);
      setProbeError(isApiError(error) ? error.message : "读不到自检结论：连不上共享服务");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const channels = channelsOf(readiness, { checking: busy && !readiness });
  const rows = receiveRows();
  const tally = receiveTally(rows);
  const batches = rowsByBatch(rows);
  const checks = sampleChecks();

  return (
    <>
      <Panel
        title="三类数据通道"
        icon="biz-multimodal"
        extra={
          <span className="rc-head">
            <span className="muted">
              {busy && !readiness ? "正在自检…" : readiness ? "现状取自平台自检" : probeError ?? "未读到自检结论"}
            </span>
            <Btn tone="ghost" disabled={busy} onClick={() => void load(true)}>
              {busy ? "自检中…" : "重新自检"}
            </Btn>
          </span>
        }>
        <div className="rc-channels">
          {channels.map((channel) => (
            <section key={channel.key} className={`rc-channel is-${channel.state}`}>
              <header>
                <b>{channel.label}</b>
                <StatusChip text={CHANNEL_CHIP[channel.state].text} tone={CHANNEL_CHIP[channel.state].tone} />
              </header>
              <dl>
                <div>
                  <dt>通道形态</dt>
                  <dd>{channel.form}</dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>{channel.origin}</dd>
                </div>
                <div>
                  <dt>现状</dt>
                  <dd>{channel.detail}</dd>
                </div>
              </dl>
            </section>
          ))}
        </div>
        <ul className="rc-notes">
          {receiveNotes().map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Panel>

      <Panel
        title="本单接收清单"
        icon="asset-folder"
        extra={
          <span className="rc-head">
            <StatusChip text={`${tally.stored}/${tally.total} 已入库`} tone={tally.stored === tally.total ? "ok" : "warn"} />
            {tally.issueCount ? <StatusChip text={`${tally.issueCount} 条校验未过`} tone="warn" /> : null}
          </span>
        }>
        {batches.map((batch) => (
          <section key={batch.batchId} className="rc-batch">
            <header>
              <b>{batch.label}</b>
              <span className="muted">
                {batch.rows.length} 个文件 · 采集时间各自独立记录
                {batch.rows[0]?.componentId ? ` · 构件 ${batch.rows[0].componentId}` : ""}
              </span>
            </header>
            <DataTable
              head={["文件", "类型", "来源", "采集时间", "帧 / 大小", "校验", "状态"]}
              rows={batch.rows.map((row) => [
                <span key={`n-${row.id}`} className="rc-name">
                  {row.name}
                  {row.issues.length ? (
                    <small className="rc-issue">
                      <Icon name="status-warning" size={16} aria-hidden />
                      {row.issues.join("；")}
                    </small>
                  ) : null}
                </span>,
                row.kind,
                row.source,
                <span key={`t-${row.id}`} className="rc-time">
                  {row.capturedAt}
                </span>,
                `${row.frames ?? "—"} 帧 · ${row.sizeText}`,
                `${row.checksPassed}/${row.checksTotal}`,
                <StatusChip key={`s-${row.id}`} text={row.state} tone={STATE_TONE[row.state] ?? "muted"} />,
              ])}
            />
          </section>
        ))}
        <p className="note">
          接收清单按<b>文件</b>列：一个文件一条，各自的采集时间与校验结论都留在这里（剧本：采集时间各自独立记录）。
        </p>
      </Panel>

      <Panel
        title="按样本编号核对（路径记录与补采清单）"
        icon="biz-sample-group"
        extra={
          <span className="rc-head">
            <StatusChip text={`${checks.length} 个物理样本`} tone="info" />
            <StatusChip
              text={`${checks.reduce((sum, item) => sum + item.followUps.length, 0)} 条进补采清单`}
              tone={checks.some((item) => item.followUps.length) ? "warn" : "ok"}
            />
          </span>
        }>
        <DataTable
          head={["物理样本编号", "记录数", "路径（目录）", "可用 / 待审核 / 不可用", "需要补采或重看"]}
          rows={checks.map((item) => [
            <b key={`id-${item.physicalSampleId}`}>{item.physicalSampleId}</b>,
            `${item.records} 条`,
            <span key={`p-${item.physicalSampleId}`} className="rc-paths">
              {item.folders.join("；")}
            </span>,
            `${item.usable} / ${item.toReview} / ${item.unusable}`,
            item.followUps.length ? (
              <ul key={`f-${item.physicalSampleId}`} className="rc-follow">
                {item.followUps.map((follow) => (
                  <li key={follow.recordId}>
                    <code>{follow.recordId}</code>
                    <span>{follow.path}</span>
                    <em>{follow.reason}</em>
                  </li>
                ))}
              </ul>
            ) : (
              <span key={`f-${item.physicalSampleId}`} className="muted">
                无需补采
              </span>
            ),
          ])}
        />
        <p className="note">
          补采清单里只有**非「可用」**的条目（待审核与不可用），已接收且可用的文件不会重复要求上传。
        </p>
      </Panel>

      <Panel title="参考样本批次（来源与扫描条件）" icon="biz-manual-mark">
        <DataTable head={["批次", "分组", "材种来源", "扫描次数", "扫描方向"]} rows={referenceRows()} />
        <KV
          columns={3}
          items={[
            { k: "数据来源", v: <SourceTag label="归档回放 + 真机探针" /> },
            { k: "接收口径", v: "设备侧推送、平台侧落盘；清单只读" },
            { k: "缺失处理", v: "进补采清单，不重复要求已接收文件" },
          ]}
        />
      </Panel>

      {probeError ? <StateBlock kind="partial" title="通道现状暂时读不到" hint={probeError} /> : null}
    </>
  );
}

export default ReceiveChannelsTab;
