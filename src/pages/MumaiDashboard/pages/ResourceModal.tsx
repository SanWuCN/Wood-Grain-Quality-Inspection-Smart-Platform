/**
 * 平台资源弹窗（PRD §8.2）
 *
 * 五个页签：存储 / 内存 / GPU / 功耗 / 网络。主卡点哪一行就打开哪个页签。
 *
 * 硬约束（PRD 明确写了，改之前先读）：
 *   · 页眉与页签固定，**只有正文一个滚动区域**；窗口本身不滚
 *   · 超过 8 台服务器分页，不靠无限拉长弹窗
 *   · 顶部写「主机基准」，不把虚拟节点的平均值当成主机实测
 *   · 盘符与真实 GPU 型号不进普通视图，收在「映射说明」里
 *   · 焦点锁在弹窗内、Esc 关闭并回到触发点（沿用平台 Modal 的行为）
 *
 * 数据与主卡同源：都读 `/api/platform/resources`，因此两边永远是同一份快照。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Btn, Modal, StatusChip } from "../ui";
import Chart from "./OverviewCharts";
import { CHART } from "../design";
import { CHART_BASE } from "./overview.constants";
import {
  DASH,
  LOAD_TEXT,
  LOAD_TONE,
  QUALITY_TEXT,
  RESOURCE_TABS,
  barWidth,
  bytesPerSec,
  gib,
  percent,
  power,
  tb,
  usePlatformHistory,
  usePlatformResources,
  type ResourceTab,
} from "./usePlatformResources";
import type { PlatformResources } from "../api/client";

/** 每页服务器数（§8.2：超过 8 台分页） */
const PAGE_SIZE = 8;

function Bar({ ratio }: { ratio: number | null }) {
  const width = barWidth(ratio);
  return <i className="pd-bar">{width === null ? null : <u style={{ width: `${width}%` }} />}</i>;
}

export default function ResourceModal({
  initialTab = "storage",
  onClose,
}: {
  initialTab?: ResourceTab;
  onClose: () => void;
}) {
  const { data, error } = usePlatformResources(true);
  const [tab, setTab] = useState<ResourceTab>(initialTab);
  const [page, setPage] = useState(0);
  const [explainOpen, setExplainOpen] = useState(false);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  /* 页签变化时回到第一页，避免停在超出范围的页码上 */
  useEffect(() => setPage(0), [tab]);

  const servers = data?.servers ?? [];
  const pageCount = Math.max(1, Math.ceil(servers.length / PAGE_SIZE));
  const pageServers = servers.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <Modal
      wide
      title="平台资源"
      subtitle={
        data ? (
          <span className="rm-sub">
            <StatusChip text={QUALITY_TEXT[data.quality]} tone={data.quality === "fresh" ? "ok" : data.quality === "stale" ? "warn" : "danger"} dot />
            <span>
              {data.serverCount > 0 ? `${data.serverCount} 台服务器` : data.noVolumeReason ?? "未识别存储卷"} ·
              后端主机 {data.hostId} · 快照 {data.snapshotId}
            </span>
          </span>
        ) : (
          error || "正在读取后端主机资源…"
        )
      }
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            资源按后端主机实测比例映射，服务器为演示配置（{data?.mappingExplain.gpuModel ?? "NVIDIA GeForce RTX 4090"} ·{" "}
            {data?.mappingExplain.vramTotalGiB ?? 24} GiB 显存/台）
          </span>
          <Btn tone="ghost" onClick={() => setExplainOpen((open) => !open)} aria-expanded={explainOpen}>
            映射说明
          </Btn>
          <Btn onClick={onClose}>关闭</Btn>
        </>
      }>
      {/* 页签：固定不滚，正文单独滚动 */}
      <div className="rm-tabs" role="tablist" aria-label="资源分类" ref={tabsRef}>
        {RESOURCE_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? "is-active" : ""}
            onClick={() => setTab(item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      <div className="rm-body" role="tabpanel">
        {!data ? (
          <p className="note">{error ? `连接中断：${error}` : "正在读取后端主机资源…"}</p>
        ) : tab === "storage" ? (
          <StorageTab data={data} servers={pageServers} page={page} pageCount={pageCount} onPage={setPage} />
        ) : tab === "memory" ? (
          <MemoryTab data={data} servers={pageServers} page={page} pageCount={pageCount} onPage={setPage} />
        ) : tab === "gpu" ? (
          <GpuTab data={data} servers={pageServers} page={page} pageCount={pageCount} onPage={setPage} />
        ) : tab === "power" ? (
          <PowerTab data={data} servers={pageServers} page={page} pageCount={pageCount} onPage={setPage} />
        ) : (
          <NetworkTab data={data} />
        )}

        {explainOpen && data ? <MappingExplain data={data} /> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 分页条（只有一页时不渲染）
 * ------------------------------------------------------------------ */
function Pager({ page, pageCount, onPage, total }: { page: number; pageCount: number; onPage: (page: number) => void; total: number }) {
  if (pageCount <= 1) return null;
  return (
    <div className="rm-pager">
      <span className="muted">
        第 {page + 1} / {pageCount} 页 · 共 {total} 台
      </span>
      <Btn tone="ghost" disabled={page === 0} onClick={() => onPage(page - 1)}>
        上一页
      </Btn>
      <Btn tone="ghost" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}>
        下一页
      </Btn>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 存储
 * ------------------------------------------------------------------ */
function StorageTab({ data, servers, page, pageCount, onPage }: TabProps) {
  const s = data.summary;
  return (
    <>
      <dl className="rm-kv">
        <div>
          <dt>总配额</dt>
          <dd>{tb(s.storageTotalTB)}</dd>
        </div>
        <div>
          <dt>已用</dt>
          <dd>{tb(s.storageUsedTB)}</dd>
        </div>
        <div>
          <dt>使用率</dt>
          <dd>{percent(s.storageRatio === null ? null : s.storageRatio * 100)}</dd>
        </div>
        <div>
          <dt>存储质量</dt>
          <dd>{QUALITY_TEXT[data.metricQuality.storage]}</dd>
        </div>
      </dl>
      <p className="note">
        每台配额等分（{tb(data.serverCount > 0 ? s.storageTotalTB / data.serverCount : null, 4)} × {data.serverCount || DASH}），
        集群使用率取各卷使用率的算术平均。
        {data.noVolumeReason ? `当前${data.noVolumeReason}，已用与使用率不可用。` : ""}
      </p>
      <div className="rm-table">
        <div className="rm-table__head">
          <span>服务器</span>
          <span>配额</span>
          <span>已用</span>
          <span>剩余</span>
          <span>使用率</span>
        </div>
        {servers.map((server) => (
          <div key={server.id} className="rm-table__row">
            <span className="rm-id">{server.id}</span>
            <span>{tb(server.storage.totalTb, 4)}</span>
            <span>{tb(server.storage.usedTb)}</span>
            <span>{tb(server.storage.freeTb)}</span>
            <span className="rm-cell">
              <b>{percent(server.storage.ratio === null ? null : server.storage.ratio * 100)}</b>
              <Bar ratio={server.storage.ratio} />
            </span>
          </div>
        ))}
        {servers.length === 0 ? <p className="note">未识别存储卷，没有可列的服务器。</p> : null}
      </div>
      <Pager page={page} pageCount={pageCount} onPage={onPage} total={data.serverCount} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 内存
 * ------------------------------------------------------------------ */
function MemoryTab({ data, servers, page, pageCount, onPage }: TabProps) {
  const s = data.summary;
  return (
    <>
      <dl className="rm-kv">
        <div>
          <dt>集群总量</dt>
          <dd>{gib(s.memoryTotalGiB)}</dd>
        </div>
        <div>
          <dt>集群已用</dt>
          <dd>{gib(s.memoryUsedGiB)}</dd>
        </div>
        <div>
          <dt>占用比例</dt>
          <dd>{percent(s.memoryRatio === null ? null : s.memoryRatio * 100)}</dd>
        </div>
        <div>
          <dt>内存质量</dt>
          <dd>{QUALITY_TEXT[data.metricQuality.memory]}</dd>
        </div>
      </dl>
      <p className="note">按后端主机物理内存占用比例映射；各台配额等分，不做额外浮动。</p>
      <div className="rm-table">
        <div className="rm-table__head">
          <span>服务器</span>
          <span>配额</span>
          <span>已用</span>
          <span>占比</span>
          <span />
        </div>
        {servers.map((server) => (
          <div key={server.id} className="rm-table__row">
            <span className="rm-id">{server.id}</span>
            <span>{gib(server.memory.totalGib)}</span>
            <span>{gib(server.memory.usedGib)}</span>
            <span>{percent(server.memory.ratio === null ? null : server.memory.ratio * 100)}</span>
            <span className="rm-cell">
              <Bar ratio={server.memory.ratio} />
            </span>
          </div>
        ))}
      </div>
      <Pager page={page} pageCount={pageCount} onPage={onPage} total={data.serverCount} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * GPU
 * ------------------------------------------------------------------ */
function GpuTab({ data, servers, page, pageCount, onPage }: TabProps) {
  const s = data.summary;
  return (
    <>
      <dl className="rm-kv">
        <div>
          <dt>主机基准</dt>
          <dd>{percent(s.gpuBasePercent)}</dd>
        </div>
        <div>
          <dt>负载状态</dt>
          <dd>
            <StatusChip text={LOAD_TEXT[s.loadState]} tone={LOAD_TONE[s.loadState]} dot />
          </dd>
        </div>
        <div>
          <dt>展示型号</dt>
          <dd>{data.mappingExplain.gpuModel}</dd>
        </div>
        <div>
          <dt>GPU 质量</dt>
          <dd>{QUALITY_TEXT[data.metricQuality.gpu]}</dd>
        </div>
      </dl>
      <p className="note">
        主机基准是后端主机实测的 GPU 利用率；下表每台按 ±12% 相对浮动映射，
        所以与基准不相等是正常的。显存占用率取「已用容量 / 总容量」。
      </p>
      <div className="rm-table">
        <div className="rm-table__head">
          <span>服务器</span>
          <span>型号</span>
          <span>GPU 占用</span>
          <span>显存已用 / 总</span>
          <span>负载</span>
        </div>
        {servers.map((server) => (
          <div key={server.id} className="rm-table__row">
            <span className="rm-id">{server.id}</span>
            <span>{server.gpu.model}</span>
            <span className="rm-cell">
              <b>{percent(server.gpu.percent)}</b>
              <Bar ratio={server.gpu.percent === null ? null : server.gpu.percent / 100} />
            </span>
            <span className="rm-cell">
              <b>
                {gib(server.gpu.vramUsedGib)} / {server.gpu.vramTotalGib} GiB
              </b>
              <Bar ratio={server.gpu.vramRatio} />
            </span>
            <span>
              <StatusChip text={LOAD_TEXT[server.gpu.load]} tone={LOAD_TONE[server.gpu.load]} dot />
            </span>
          </div>
        ))}
      </div>
      <Pager page={page} pageCount={pageCount} onPage={onPage} total={data.serverCount} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 功耗
 * ------------------------------------------------------------------ */
function PowerTab({ data, servers, page, pageCount, onPage }: TabProps) {
  const s = data.summary;
  const range = data.mappingExplain.powerRangeW;
  const formatted = power(s.powerTotalW);
  return (
    <>
      <dl className="rm-kv">
        <div>
          <dt>集群总功耗</dt>
          <dd>
            {formatted.w}
            {formatted.kw ? <em> · {formatted.kw}</em> : null}
          </dd>
        </div>
        <div>
          <dt>单台范围</dt>
          <dd>
            {range[0]}–{range[1]} W
          </dd>
        </div>
        <div>
          <dt>映射方式</dt>
          <dd>按该台 GPU 占用线性插值</dd>
        </div>
        <div>
          <dt>服务器数</dt>
          <dd>{data.serverCount || DASH}</dd>
        </div>
      </dl>
      <p className="note">
        这是服务器功耗的**演示映射**，不是实际插座功率、GPU 板卡功率或电费测量值。
        GPU 样本不可用时功耗显示「—」，不退化成 600 W。
      </p>
      <div className="rm-table">
        <div className="rm-table__head">
          <span>服务器</span>
          <span>当前功耗</span>
          <span>区间位置</span>
          <span>GPU 占用</span>
          <span />
        </div>
        {servers.map((server) => (
          <div key={server.id} className="rm-table__row">
            <span className="rm-id">{server.id}</span>
            <span>{power(server.powerW).w}</span>
            <span className="rm-cell">
              <Bar
                ratio={
                  server.powerW === null ? null : (server.powerW - range[0]) / Math.max(1, range[1] - range[0])
                }
              />
            </span>
            <span>{percent(server.gpu.percent)}</span>
            <span />
          </div>
        ))}
      </div>
      <Pager page={page} pageCount={pageCount} onPage={onPage} total={data.serverCount} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 网络
 * ------------------------------------------------------------------ */
function NetworkTab({ data }: { data: PlatformResources }) {
  const points = usePlatformHistory(true);
  const s = data.summary;
  const option = useMemo(() => {
    const rows = points.filter((point) => point.uploadBytesPerSec !== null || point.downloadBytesPerSec !== null);
    return {
      ...CHART_BASE,
      grid: { left: 0, right: 8, top: 24, bottom: 0, containLabel: true },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        icon: "circle",
        textStyle: { color: CHART.axisText, fontSize: 12 },
        data: ["上行", "下行"],
      },
      xAxis: {
        type: "category" as const,
        boundaryGap: false,
        data: rows.map((point) => new Date(point.atMs).toLocaleTimeString("zh-CN", { hour12: false })),
        axisLine: { lineStyle: { color: CHART.axisLine } },
        axisLabel: { color: CHART.axisText, fontSize: 11, interval: Math.max(0, Math.floor(rows.length / 6)) },
      },
      yAxis: {
        type: "value" as const,
        splitLine: { lineStyle: { color: CHART.grid } },
        axisLabel: { color: CHART.axisText, fontSize: 11, formatter: (value: number) => bytesPerSec(value) },
      },
      series: [
        {
          name: "上行",
          type: "line" as const,
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: CHART.palette[0] },
          areaStyle: { color: "rgba(78,168,255,0.12)" },
          /* 缺口保持 null：ECharts 默认断开，不跨越缺口连线（MOD-05） */
          connectNulls: false,
          data: rows.map((point) => point.uploadBytesPerSec),
        },
        {
          name: "下行",
          type: "line" as const,
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: CHART.palette[1] },
          connectNulls: false,
          data: rows.map((point) => point.downloadBytesPerSec),
        },
      ],
    };
  }, [points]);

  return (
    <>
      <dl className="rm-kv">
        <div>
          <dt>平台上行</dt>
          <dd>↑ {bytesPerSec(s.uploadBytesPerSec)}</dd>
        </div>
        <div>
          <dt>平台下行</dt>
          <dd>↓ {bytesPerSec(s.downloadBytesPerSec)}</dd>
        </div>
        <div>
          <dt>展示倍率</dt>
          <dd>×{data.mappingExplain.networkScale}</dd>
        </div>
        <div>
          <dt>网络质量</dt>
          <dd>{QUALITY_TEXT[data.metricQuality.network]}</dd>
        </div>
      </dl>
      <p className="note">
        上行为后端网卡发送、下行为接收，按真实采样间隔差分后乘 {data.mappingExplain.networkScale}；集群只乘一次，
        不随服务器数放大。统计接口：
        {(data.mappingExplain.networkInterfaces ?? []).join("、") || DASH}
      </p>
      <Chart
        className="rm-chart"
        option={option}
        ariaLabel={`最近 60 秒平台网络速率：↑ ${bytesPerSec(s.uploadBytesPerSec)}，↓ ${bytesPerSec(s.downloadBytesPerSec)}`}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 映射说明（二级区：技术追溯，默认收起）
 * ------------------------------------------------------------------ */
function MappingExplain({ data }: { data: PlatformResources }) {
  const explain = data.mappingExplain;
  return (
    <details className="rm-explain" open>
      <summary>映射说明</summary>
      <dl className="rm-kv rm-kv--dense">
        <div>
          <dt>来源主机</dt>
          <dd>{explain.hostId}</dd>
        </div>
        <div>
          <dt>运行平台</dt>
          <dd>
            {explain.platform ?? DASH}/{explain.arch ?? DASH} · {explain.cpuCores ?? DASH} 核
          </dd>
        </div>
        <div>
          <dt>GPU 采集源</dt>
          <dd>
            {explain.gpuSource ?? DASH}
            {explain.gpuName ? ` · ${explain.gpuName}` : ""}
          </dd>
        </div>
        <div>
          <dt>映射配置</dt>
          <dd>{explain.mappingVersion}</dd>
        </div>
        <div>
          <dt>卷拓扑版本</dt>
          <dd>{explain.topologyVersion ?? DASH}</dd>
        </div>
        <div>
          <dt>采集纪元</dt>
          <dd>{explain.epoch ?? DASH}</dd>
        </div>
      </dl>
      <p className="note">
        {explain.note}。快照 {data.snapshotId} · 采样时间 {new Date(data.sampledAt).toLocaleTimeString("zh-CN", { hour12: false })}。
        存储口径为十进制 TB，内存与显存为 GiB，网络为十进制 B/s。
      </p>
      {explain.errors ? (
        <p className="note">
          最近一次采集错误：
          {Object.entries(explain.errors)
            .filter(([, message]) => message)
            .map(([metric, message]) => `${metric}: ${message}`)
            .join("；") || "无"}
        </p>
      ) : null}
    </details>
  );
}

type TabProps = {
  data: PlatformResources;
  servers: PlatformResources["servers"];
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
};
