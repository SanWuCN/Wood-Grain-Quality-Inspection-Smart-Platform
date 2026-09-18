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
import NumberAnimation from "@/components/numberAnimation";
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

/**
 * 轮询数值的显示口径。都提成模块级常量：`NumberAnimation` 把 `format` 存在 ref 里读，
 * 内联箭头也不会重建动画，但稳定的引用让「这一列到底怎么格式化」一眼可查，
 * 也保证滚动中的每一帧与最终落值共用同一套小数位与单位。
 */
/** 比率（0–1）→ 百分比：`summary.*Ratio` 与逐台 `ratio` 统一乘 100 后交给 `percent()`（一位小数） */
const ratioPercent = (value: number) => percent(value * 100);
/** 每台配额四位小数（§9.2 等分口径），固定 `tb` 的小数位，不在调用点各写一遍 */
const tb4 = (value: number) => tb(value, 4);
/** 功耗 W：取整口径与弹窗、主卡完全同源，不另写一份 round */
const powerWatts = (value: number) => power(value).w;
/** kW 只在 `power()` 判定 ≥1000 W 时才渲染（出现条件不在这里），这里只管滚动中的 kW 怎么写 */
const powerKilowatts = (value: number) => `${(value / 1000).toFixed(2)} kW`;

function Bar({ ratio }: { ratio: number | null }) {
  const width = barWidth(ratio);
  /* 比例条宽度是 CSS 尺寸（`<u>` 的 style.width），不是文本数字，`NumberAnimation`
     只产出 `<span>` 文本，因此这条保持静态；旁边的百分数已经在滚。 */
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
              {/* 服务器台数是 2s 轮询快照里的实时计数，走动效；后端主机 ID / 快照 ID 是标识，保持静止 */}
              {data.serverCount > 0 ? (
                <>
                  <NumberAnimation value={data.serverCount} /> 台服务器
                </>
              ) : (
                data.noVolumeReason ?? "未识别存储卷"
              )}{" "}
              · 后端主机 {data.hostId} · 快照 {data.snapshotId}
              {data.fixture ? ` · 验收夹具输入（${data.fixture.label}，不是真实主机采集）` : ""}
            </span>
          </span>
        ) : (
          error || "正在读取后端主机资源…"
        )
      }
      onClose={onClose}
      footer={
        <>
          {/* 映射口径只写一句：型号、容量、采集源都在「映射说明」里（页脚没有它们的版面）。
              2026-09-18 实测截图：页脚塞进 GPU 型号后整行换行溃散，按钮被挤成一列单字 */}
          <span className="modal__foot-note">资源按后端主机实测值等比映射 · 服务器为展示单元，不是主机物理规格</span>
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
        {/* 页码与总页数是导航序号（跟着翻页变，不跟数据变）保持静止；「共 N 台」是轮询计数，走动效 */}
        第 {page + 1} / {pageCount} 页 · 共 <NumberAnimation value={total} /> 台
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
          <dd>
            <NumberAnimation value={s.storageTotalTB} format={tb} />
          </dd>
        </div>
        <div>
          <dt>已用</dt>
          <dd>
            <NumberAnimation value={s.storageUsedTB} format={tb} />
          </dd>
        </div>
        <div>
          <dt>使用率</dt>
          <dd>
            <NumberAnimation value={s.storageRatio} format={ratioPercent} />
          </dd>
        </div>
        <div>
          <dt>存储质量</dt>
          <dd>{QUALITY_TEXT[data.metricQuality.storage]}</dd>
        </div>
      </dl>
      <p className="note">
        每台配额等分（
        <NumberAnimation value={data.serverCount > 0 ? s.storageTotalTB / data.serverCount : null} format={tb4} /> ×{" "}
        {/* 台数为 0 时沿用 `|| DASH` 的「—」，不拿 0 冒充（§10.3） */}
        <NumberAnimation value={data.serverCount || null} />），
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
        {/* 逐台行是同一份 2s 快照：配额 / 已用 / 剩余 / 使用率四个数字都滚；
            `server.id` 是标识，保持静止 */}
        {servers.map((server) => (
          <div key={server.id} className="rm-table__row">
            <span className="rm-id">{server.id}</span>
            <span>
              <NumberAnimation value={server.storage.totalTb} format={tb4} />
            </span>
            <span>
              <NumberAnimation value={server.storage.usedTb} format={tb} />
            </span>
            <span>
              <NumberAnimation value={server.storage.freeTb} format={tb} />
            </span>
            <span className="rm-cell">
              <b>
                <NumberAnimation value={server.storage.ratio} format={ratioPercent} />
              </b>
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
          <dd>
            <NumberAnimation value={s.memoryTotalGiB} format={gib} />
          </dd>
        </div>
        <div>
          <dt>集群已用</dt>
          <dd>
            <NumberAnimation value={s.memoryUsedGiB} format={gib} />
          </dd>
        </div>
        <div>
          <dt>占用比例</dt>
          <dd>
            <NumberAnimation value={s.memoryRatio} format={ratioPercent} />
          </dd>
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
        {/* 逐台内存同样来自 2s 轮询快照，整列走动效；`server.id` 是标识，保持静止 */}
        {servers.map((server) => (
          <div key={server.id} className="rm-table__row">
            <span className="rm-id">{server.id}</span>
            <span>
              <NumberAnimation value={server.memory.totalGib} format={gib} />
            </span>
            <span>
              <NumberAnimation value={server.memory.usedGib} format={gib} />
            </span>
            <span>
              <NumberAnimation value={server.memory.ratio} format={ratioPercent} />
            </span>
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
          <dd>
            <NumberAnimation value={s.gpuBasePercent} format={percent} />
          </dd>
        </div>
        <div>
          <dt>负载状态</dt>
          <dd>
            <StatusChip text={LOAD_TEXT[s.loadState]} tone={LOAD_TONE[s.loadState]} dot />
          </dd>
        </div>
        <div>
          <dt>实测显存</dt>
          <dd>
            {/* 分母是主机实测显存（同一份 2s 快照），随采集变化；因此这行也走动效 */}
            <NumberAnimation value={data.gpuVramTotalGib} format={gib} />
            <em> · 逐台按比例映射</em>
          </dd>
        </div>
        <div>
          <dt>GPU 质量</dt>
          <dd>{QUALITY_TEXT[data.metricQuality.gpu]}</dd>
        </div>
      </dl>
      <p className="note">
        主机基准是后端主机实测的 GPU 利用率；下表每台按 ±12% 相对浮动映射，
        所以与基准不相等是正常的。逐台显存是「主机实测显存 × 映射比例」，
        不预置型号与容量 —— 采集来源与卡名在「映射说明」里可追溯。
      </p>
      <div className="rm-table">
        <div className="rm-table__head rm-table__head--flex">
          <span>服务器</span>
          <span>GPU 占用</span>
          <span>显存占用</span>
          <span>负载</span>
        </div>
        {/* 逐台 GPU：占用率、显存占用比例都随 2s 快照变；`server.id` 是标识，保持静止。
            这里不列型号：CON1..CONn 是映射单元，头上没有一张实际安装的卡 */}
        {servers.map((server) => (
          <div key={server.id} className="rm-table__row rm-table__row--flex">
            <span className="rm-id">{server.id}</span>
            <span className="rm-cell">
              <b>
                <NumberAnimation value={server.gpu.percent} format={percent} />
              </b>
              <Bar ratio={server.gpu.percent === null ? null : server.gpu.percent / 100} />
            </span>
            <span className="rm-cell">
              <b>
                <NumberAnimation value={server.gpu.vramRatio} format={ratioPercent} />
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
  /* 只留 `.kw` 当「是否显示 kW」的判据；W 的取整口径交给 `powerWatts` 逐帧复用（与 `power()` 同源） */
  const formatted = power(s.powerTotalW);
  return (
    <>
      {/* 这一行 rm-kv 是一整组 KPI：集群总功耗 / 单台范围 / 服务器数 都在同一行里，
          按「整组一致」的口径全部走动效，避免旁边三个在数、这个不动 */}
      <dl className="rm-kv">
        <div>
          <dt>集群总功耗</dt>
          <dd>
            <NumberAnimation value={s.powerTotalW} format={powerWatts} />
            {formatted.kw ? (
              <em>
                {" · "}
                <NumberAnimation value={s.powerTotalW} format={powerKilowatts} />
              </em>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>单台范围</dt>
          <dd>
            <NumberAnimation value={range[0]} />–<NumberAnimation value={range[1]} /> W
          </dd>
        </div>
        <div>
          <dt>映射方式</dt>
          <dd>按该台 GPU 占用线性插值</dd>
        </div>
        <div>
          <dt>服务器数</dt>
          {/* 0 台时沿用 `|| DASH` 的「—」，不拿 0 冒充（§10.3） */}
          <dd>
            <NumberAnimation value={data.serverCount || null} />
          </dd>
        </div>
      </dl>
      <p className="note">
        这是服务器负载的**估算映射**，不代表插座功率、GPU 板卡功率或电费实测值。
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
        {/* 逐台功耗与 GPU 占用是 2s 轮询的重算值，随负载上下滚；`server.id` 是标识，保持静止 */}
        {servers.map((server) => (
          <div key={server.id} className="rm-table__row">
            <span className="rm-id">{server.id}</span>
            <span>
              <NumberAnimation value={server.powerW} format={powerWatts} />
            </span>
            <span className="rm-cell">
              <Bar
                ratio={
                  server.powerW === null ? null : (server.powerW - range[0]) / Math.max(1, range[1] - range[0])
                }
              />
            </span>
            <span>
              <NumberAnimation value={server.gpu.percent} format={percent} />
            </span>
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
          <dd>
            ↑ <NumberAnimation value={s.uploadBytesPerSec} format={bytesPerSec} />
          </dd>
        </div>
        <div>
          <dt>平台下行</dt>
          <dd>
            ↓ <NumberAnimation value={s.downloadBytesPerSec} format={bytesPerSec} />
          </dd>
        </div>
        <div>
          <dt>展示倍率</dt>
          {/* 这一行是整组 KPI（上行 / 下行 / 倍率），倍率跟着一起走，口径仍是映射常量 */}
          <dd>
            ×<NumberAnimation value={data.mappingExplain.networkScale} />
          </dd>
        </div>
        <div>
          <dt>网络质量</dt>
          <dd>{QUALITY_TEXT[data.metricQuality.network]}</dd>
        </div>
      </dl>
      <p className="note">
        {/* 说明句里的倍率是映射常量（口径解释，不是指标），与映射说明一致保持静止 */}
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
  /* 这一区是技术追溯：主机 ID / 平台与架构 / 核数 / 采集源 / 映射与拓扑版本 / 纪元
     都是标识、版本串或规格常量（不随轮询变），全部保持静止，不走数字动效 */
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
          <dt>实测显存</dt>
          <dd>{explain.vramTotalGiB === null || explain.vramTotalGiB === undefined ? DASH : `${gib(explain.vramTotalGiB)} · 逐台显存映射的分母`}</dd>
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
