/**
 * 数据与知识中心 · RAG 索引页签
 *
 * 依据：PRD §5.4（服务状态卡 + 覆盖分布 + 更新任务 + 版本记录；高级参数在配置抽屉）、
 *      §9.1（检索服务与更新状态）、§9.3（阶段进度）、§9.4（版本切换）。
 *
 * 「构建时统计」与「当前有效数量」始终分两列显示（PRD §12.3）：
 * 历史版本的 buildCounts 不因源资产后来删除而改写，把两者混成一个数字会误导。
 */

import { useState } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Btn, StateBlock } from "../../ui";
import type { IndexConfig, IndexVersionRow, JobDetail, KnowledgeJob, KnowledgeTab, Overview } from "../types";
import { formatCount, formatCoverage, formatMoment, jobStatusTone } from "../selectors";
import { KbCollapse, KbCoverageBar, KbEmpty, KbKV, KbPanel, KbState } from "../components/KnowledgeUi";
import { coverageSegments } from "../selectors";
import type { KnowledgeApiActions } from "../components/api-actions";

export function IndexesView({
  overview,
  versions,
  jobs,
  loading,
  error,
  actions,
  onOpenTab,
  onWatchJob,
  onOpenAsset,
  jobDetail,
}: {
  overview: Overview | null;
  versions: IndexVersionRow[];
  jobs: KnowledgeJob[];
  loading: boolean;
  error: string | null;
  actions: KnowledgeApiActions;
  onOpenTab: (tab: KnowledgeTab, filter?: Record<string, string>) => void;
  onWatchJob: (jobId: string) => void;
  onOpenAsset: (assetId: string) => void;
  jobDetail: JobDetail | null;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  if (loading && !overview) return <StateBlock kind="loading" title="正在读取索引状态" hint="包含服务版本、任务与版本记录。" />;
  if (error && !overview) return <StateBlock kind="error" title="读取失败" hint={error} />;
  if (!overview) return <KbEmpty title="暂无索引信息" hint="共享服务未返回索引状态。" />;

  const { indexStatus, metrics } = overview;
  const running = jobs.filter((job) => job.status === "运行" || job.status === "排队");
  const history = jobs.filter((job) => !running.includes(job));

  return (
    <div className="kb-indexes">
      {/* ---- 服务状态卡 ---- */}
      <KbPanel
        title="索引服务状态"
        className="kb-service"
        scroll={false}
        note={<span className="kb-muted">浏览器本地索引 · {overview.adapterMode} · 维度配置 {overview.dimensionConfig}</span>}
        actions={
          <div className="kb-toolbar">
            <Btn onClick={() => void actions.sync({ scope: "backlog", triggerSource: "索引运维" })} disabled={!actions.canIndex || actions.busy}>
              更新索引
            </Btn>
            <Btn onClick={() => void actions.retryErrors()} disabled={!actions.canIndex || !metrics.error}>
              重试失败项 {metrics.error ? `(${metrics.error})` : ""}
            </Btn>
            <Btn onClick={() => setConfigOpen((value) => !value)}>{configOpen ? "收起配置" : "索引配置"}</Btn>
          </div>
        }>
        <div className="kb-status-head">
          <div className="kb-status-main">
            <KbState text={indexStatus.service} tone={indexStatus.service === "可检索" ? "ok" : "danger"} />
            <KbState text={indexStatus.update} tone={indexStatus.tone} />
            <code className="kb-version">{indexStatus.servingVersion ?? "未就绪"}</code>
            <span className="kb-muted">{indexStatus.autoSync ? "自动更新 · 开启" : "自动更新 · 已暂停"}</span>
          </div>
          <span className="kb-muted">配置版本 {overview.configRevision}</span>
        </div>

        <KbKV
          columns={4}
          items={[
            /*
              八个 KPI 行是一个视觉组：其中七个是数量/比率，全部交给 NumberAnimation
              （KbKV 的 v 收 ReactNode，数字就地换掉，单位文字留在外面）。
              第四行「最近成功发布」是 formatMoment 的时间戳，按规范不做滚动。
              数字传原始值，空值由组件落「—」；千分位与 formatCount 的 en-US 对整数一致。
            */
            { k: "当前版覆盖资产", v: <><NumberAnimation value={metrics.covered} /> 项</> },
            { k: "有可用索引资产", v: <><NumberAnimation value={indexStatus.effective.assets} /> 项</> },
            { k: "有效分块", v: <><NumberAnimation value={metrics.chunks} /> 个</> },
            { k: "向量条目", v: <><NumberAnimation value={metrics.vectors} /> 条</> },
            { k: "最近成功发布", v: formatMoment(indexStatus.lastPublishedAt) },
            { k: "待处理变化", v: <><NumberAnimation value={metrics.pending + (metrics.processing ?? 0)} /> 项</> },
            { k: "更新异常", v: <><NumberAnimation value={metrics.error} /> 项</> },
            /* 覆盖率复用 formatCoverage（= 原来的 toFixed(1)，不做千分位）；suffix 只在有数值时才写出来，
               所以 coveragePct === null 时这里仍然只显示「—」，不带 % */
            { k: "索引覆盖率", v: <NumberAnimation value={metrics.coveragePct} format={formatCoverage} suffix="%" /> },
          ]}
        />

        <details className="kb-collapse" open={configOpen}>
          <summary>
            纳入规则 · 分块策略 · 本地索引参数 <span className="kb-collapse-caret" aria-hidden>▾</span>
          </summary>
          <div className="kb-collapse-body">
            <IndexConfigForm actions={actions} revision={overview.configRevision} searchConfig={overview.searchConfig} limits={overview.limits} />
          </div>
        </details>
      </KbPanel>

      {/* ---- 覆盖分布 + 更新任务 ---- */}
      <div className="kb-index-mid">
        <KbPanel title="覆盖分布" note={<span className="kb-muted">点击任一段进入对应资产列表</span>}>
          {coverageSegments(overview).map((row) => (
            <div key={row.type} className="kb-coverage-row">
              <button type="button" className="kb-link" onClick={() => onOpenTab("assets", { type: row.type })}>
                {row.label}
              </button>
              <KbCoverageBar label={row.label} pct={row.pct} onSelect={(segment) => onOpenTab("assets", {
                type: row.type,
                state: segment === "covered" ? "已覆盖" : segment === "pending" ? "待更新" : segment === "error" ? "更新失败" : "未纳入",
              })} />
              <span className="kb-muted kb-coverage-num">
                已覆盖 <NumberAnimation value={row.covered} /> · 待更新 <NumberAnimation value={row.pending} /> · 异常{" "}
                <NumberAnimation value={row.error} /> · 未纳入 <NumberAnimation value={row.excluded} /> · 分块{" "}
                <NumberAnimation value={row.chunks} />
              </span>
            </div>
          ))}
        </KbPanel>

        <KbPanel
          title="更新任务"
          note={<span className="kb-muted">{running.length ? <><NumberAnimation value={running.length} group={false} /> 个进行中</> : "暂无运行中任务"}</span>}>
          {running.length ? (
            <div className="kb-job-cards">
              {running.map((job) => (
                <div key={job.id} className="kb-job-card">
                  <div className="kb-row">
                    <code>{job.id}</code>
                    <KbState text={job.status} tone={jobStatusTone(job.status)} />
                    <span className="kb-muted">目标 {job.targetVersion}</span>
                    <span className="kb-muted">{job.kind}</span>
                  </div>
                  <ol className="kb-stage-list">
                    {job.stages.map((stage) => (
                      <li key={stage.key} className={`kb-stage-item is-${stage.status === "运行" ? "active" : stage.status === "完成" ? "done" : stage.status === "失败" ? "failed" : "wait"}`}>
                        <strong>{stage.label}</strong>
                        <span>
                          {stage.detail ||
                            /*
                              stageSummary(processed, total) 返回纯字符串，装不下带动画的 span。
                              按 selectors.ts 的分支逐字重写：total 为 0 → 「进行中」；
                              已处理数超过总数时按总数封顶（Math.min 与它的显示口径一致）。
                            */
                            (stage.total ? (
                              <>
                                已处理 <NumberAnimation value={Math.min(stage.processed, stage.total)} group={false} />/
                                <NumberAnimation value={stage.total} group={false} /> 项
                              </>
                            ) : (
                              "进行中"
                            ))}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <div className="kb-row">
                    <span className="kb-muted">
                      {/* 成功 / 失败 原本是裸插值（无千分位）→ group={false}；分块原本走 formatCount（有千分位）→ 默认分组 */}
                      成功 <NumberAnimation value={job.counts.succeeded} group={false} /> · 失败{" "}
                      <NumberAnimation value={job.counts.failed} group={false} /> · 分块 +
                      <NumberAnimation value={job.counts.chunks} />
                    </span>
                    <button type="button" className="kb-link" onClick={() => onWatchJob(job.id)}>
                      跟踪进度
                    </button>
                    <Btn tone="danger" onClick={() => void actions.cancelJob(job.id)} disabled={!actions.canIndex}>
                      取消
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <KbEmpty
              title="暂无运行中任务"
              hint={metrics.pending || metrics.error ? `存在 ${formatCount(metrics.pending)} 项待更新、${formatCount(metrics.error)} 项异常。` : "纳入资产已全部覆盖当前版本。"}
              action={
                metrics.pending || metrics.error ? (
                  <Btn tone="primary" onClick={() => void actions.sync({ scope: metrics.error ? "errors" : "backlog", triggerSource: "索引运维" })} disabled={!actions.canIndex}>
                    {metrics.error ? "重试失败项" : "启动同步"}
                  </Btn>
                ) : undefined
              }
            />
          )}

          {jobDetail ? (
            <KbCollapse summary={`任务详情 ${jobDetail.job.id}（${jobDetail.items.length} 项）`} defaultOpen>
              <ul className="kb-job-item-list">
                {jobDetail.items.slice(0, 60).map((item) => (
                  <li key={item.assetId}>
                    <button type="button" className="kb-link" onClick={() => onOpenAsset(item.assetId)}>
                      {item.assetId}
                    </button>
                    <span>{item.stage}</span>
                    <KbState text={item.status} tone={item.status === "成功" ? "ok" : item.status === "失败" ? "danger" : "info"} />
                    {item.errorCode ? <em>{item.errorCode}</em> : null}
                    <span className="kb-muted">{item.message}</span>
                  </li>
                ))}
              </ul>
            </KbCollapse>
          ) : null}

          {history.length ? <KbCollapse summary={`历史任务（${history.length} 条）`}>
            <ul className="kb-job-item-list">
              {history.map((job) => (
                <li key={job.id}>
                  <code>{job.id}</code>
                  <span>{formatMoment(job.startedAt)}</span>
                  <KbState text={job.status} tone={jobStatusTone(job.status)} />
                  <span className="kb-muted">{job.message}</span>
                </li>
              ))}
            </ul>
          </KbCollapse> : null}
        </KbPanel>
      </div>

      {/* ---- 版本记录 ---- */}
      <KbPanel title="版本记录" note={<span className="kb-muted">发布后不可变；切换只影响检索层</span>}>
        <div className="kb-table-wrap kb-table-wrap--scroll">
          <table className="kb-table">
            <thead>
              <tr>
                <th>版本</th>
                <th className="is-num">发布时间</th>
                <th>构建范围</th>
                <th className="is-num">构建资产</th>
                <th className="is-num">构建分块</th>
                <th className="is-num">当前有效</th>
                <th>增 / 改 / 删</th>
                <th>操作者</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((row) => (
                <tr key={row.id} className={row.serving ? "is-selected" : ""}>
                  <td>
                    <code>{row.id}</code>
                    <span className="kb-cell-sub kb-muted">{row.configRevision}</span>
                  </td>
                  <td className="is-num">{formatMoment(row.publishedAt)}</td>
                  <td className="kb-cell-note" title={row.note}>
                    {row.note}
                  </td>
                  <td className="is-num">{formatCount(row.buildCounts.assets ?? 0)}</td>
                  <td className="is-num">{formatCount(row.buildCounts.chunks ?? 0)}</td>
                  <td className="is-num">{formatCount(row.effectiveCounts.chunks)}</td>
                  <td className="is-num">
                    {formatCount(row.buildCounts.added ?? 0)} / {formatCount(row.buildCounts.changed ?? 0)} /{" "}
                    {formatCount(row.buildCounts.removed ?? 0)}
                  </td>
                  <td>{row.operator ?? "—"}</td>
                  <td>
                    {row.serving ? <KbState text="当前服务" tone="ok" /> : <span className="kb-muted">历史版本</span>}
                  </td>
                  <td>
                    {row.serving ? null : (
                      <Btn onClick={() => void actions.activateVersion(row.id)} disabled={!actions.canIndex} title="只切换检索层，原始资产不回滚">
                        切换服务版本
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="kb-detail-footnote">
          「构建资产 / 构建分块」是发布当时的统计，不因源资产后来删除而改写；「当前有效」是应用当前删除与访问过滤后的可检索数量。
        </p>
      </KbPanel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 配置表单（生成配置版本，不原地改旧配置）
 * ------------------------------------------------------------------ */

function IndexConfigForm({
  actions,
  revision,
  searchConfig,
  limits,
}: {
  actions: KnowledgeApiActions;
  revision: string;
  searchConfig: Overview["searchConfig"];
  limits: Record<string, number>;
}) {
  const [maxChars, setMaxChars] = useState(420);
  const [overlap, setOverlap] = useState(60);
  const [threshold, setThreshold] = useState(searchConfig.minScoreLow);
  const [topK, setTopK] = useState(searchConfig.topKDefault);
  const [autoSync, setAutoSync] = useState(true);

  return (
    <div className="kb-config">
      <div className="kb-config-grid">
        <label className="kb-field">
          <span>分块长度上限（字）</span>
          <input type="number" className="kb-input" value={maxChars} onChange={(event) => setMaxChars(Number(event.target.value))} />
        </label>
        <label className="kb-field">
          <span>分块重叠（字）</span>
          <input type="number" className="kb-input" value={overlap} onChange={(event) => setOverlap(Number(event.target.value))} />
        </label>
        <label className="kb-field">
          <span>相似度阈值</span>
          <input type="number" step="0.01" className="kb-input" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
        </label>
        <label className="kb-field">
          <span>默认 Top K</span>
          <input type="number" className="kb-input" value={topK} onChange={(event) => setTopK(Number(event.target.value))} />
        </label>
        <label className="kb-field kb-field--check">
          <input type="checkbox" checked={autoSync} onChange={(event) => setAutoSync(event.target.checked)} />
          <span>自动更新</span>
        </label>
      </div>

      <div className="kb-config-actions">
        <Btn
          tone="primary"
          disabled={!actions.canIndex || actions.busy}
          onClick={() =>
            void actions.configure({
              chunkPolicy: { maxChars, overlapChars: overlap },
              search: { ...searchConfig, minScoreLow: threshold, topKDefault: topK },
              autoSync,
            })
          }>
          保存为新配置版本
        </Btn>
        <span className="kb-muted">当前 {revision} · 参数调整会生成新版本，旧索引继续按原配置服务</span>
      </div>

      {!actions.canIndex ? <p className="kb-detail-note">变更纳入规则、启动任务与切换索引需要「索引管理」权限。</p> : null}

      <div className="kb-config-limits kb-muted">
        <span>单批最多 {limits.maxFilesPerBatch} 个文件</span>
        <span>单文件上限 {(limits.maxFileBytes / 1024 / 1024).toFixed(0)} MiB</span>
        <span>纯文本解析上限 {(limits.maxParseBytes / 1024 / 1024).toFixed(0)} MiB</span>
        <span>自动调度：安静窗口 {limits.autoSyncQuietWindowMs / 1000}s / 最长等待 {limits.autoSyncMaxWaitMs / 1000}s / 每批 {limits.autoSyncBatchSize} 项</span>
      </div>
    </div>
  );
}

export type { IndexConfig };
