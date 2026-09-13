/**
 * 数据与知识中心 · 总览页签
 *
 * 依据：PRD §5.1（总览布局）、§5.2（布局规格）、§7.1（基线场景）、§9.3（流水线）。
 *
 * 版面顺序就是阅读顺序：六项指标 → 左侧「数据资产库 + RAG 索引库」/ 右侧「资产关系」
 * → 底部「更新任务」。上传不再占据固定侧栏（PRD §6.2 的替换项），导入入口只在页眉。
 */

import { useMemo, type CSSProperties } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Btn, StateBlock } from "../../ui";
import type { AssetTypeKey, GraphNode, KnowledgeJob, KnowledgeTab, Overview, RelationGraphData } from "../types";
import {
  coverageSegments,
  formatCount,
  formatCoverage,
  formatDuration,
  formatMoment,
  indexStateTone,
  jobStatusTone,
  metricCards,
  sampledNote,
} from "../selectors";
import { KbCoverageBar, KbEmpty, KbPanel, KbState } from "../components/KnowledgeUi";
import { RelationGraph } from "../RelationGraph";
import type { KnowledgeApiActions } from "../components/api-actions";

/**
 * `.kb-index-grid :where(span, dt)` 命中的是**任意后代** span（display:block + 辅助级字号/颜色），
 * 而 NumberAnimation 的根节点固定是 span。指标区那五个数字用这组行内声明抵消掉那三条，
 * 继续跟随外层 `<strong>` 的排版 —— 不为动画去改 knowledge.css。
 */
const INDEX_GRID_NUM: CSSProperties = { display: "inline", fontSize: "inherit", lineHeight: "inherit", color: "inherit" };

const TYPE_ORDER: AssetTypeKey[] = [
  "document",
  "image",
  "video",
  "scanData",
  "gaussian",
  "modelFile",
  "pointCloud",
  "modelWeight",
  "audio",
  "workOrder",
  "logBatch",
  "record",
];

export function OverviewView({
  overview,
  jobs,
  loading,
  error,
  actions,
  onOpenTab,
  onOpenAsset,
  onOpenJob,
  graph,
}: {
  overview: Overview | null;
  jobs: KnowledgeJob[];
  loading: boolean;
  error: string | null;
  actions: KnowledgeApiActions;
  onOpenTab: (tab: KnowledgeTab, filter?: Record<string, string>) => void;
  onOpenAsset: (assetId: string) => void;
  /** 打开任务详情抽屉：任务行本身只留摘要，细节在抽屉里看 */
  onOpenJob: (jobId: string) => void;
  graph: {
    view: "business" | "lineage";
    onViewChange: (view: "business" | "lineage") => void;
    data: RelationGraphData | null;
    loading: boolean;
    selectedId: string | null;
    onSelectNode: (node: GraphNode | null) => void;
    onExpand: (node: GraphNode) => void;
    expanded: boolean;
    onToggleExpand: () => void;
  };
}) {
  // 所有 Hook 必须在任何 return 之前调用：早退分支会让 Hook 顺序在不同渲染间变化
  const totalByType = useMemo(() => new Map((overview?.coverage ?? []).map((row) => [row.type, row])), [overview?.coverage]);

  if (loading && !overview) return <StateBlock kind="loading" title="正在读取数据与知识中心" hint="包含资产、索引与任务状态。" />;
  if (error && !overview) return <StateBlock kind="error" title="读取失败" hint={error} />;
  if (!overview) return <KbEmpty title="暂无数据" hint="共享服务未返回总览快照。" />;

  const { metrics, indexStatus } = overview;
  const segments = coverageSegments(overview);

  /**
   * 六张指标卡要滚的是**原始数值**：`metricCards()` 交出来的是已格式化好的字符串
   * （空值还可能是「—」），动画组件只有拿到数字才能插值。这里按 card.key 取回同一份
   * metrics 字段，格式化口径与卡片严格一致：整数计数 = formatCount 的千分位
   * （en-US 与组件默认的 zh-CN 对整数输出相同），覆盖率 = formatCoverage 的一位小数；
   * 空值走组件默认 fallback「—」，与 formatCount / formatCoverage 的空值文案一致。
   */
  const metricRaw: Record<string, number | null> = {
    total: metrics.total,
    coverage: metrics.coveragePct,
    chunks: metrics.chunks,
    vectors: metrics.vectors,
    pending: metrics.pending,
    error: metrics.error,
  };

  return (
    <div className="kb-overview">
      <section className="kb-metrics" aria-label="数据与知识指标">
        {metricCards(metrics, overview.servingVersion).map((card) => (
          <button
            key={card.key}
            type="button"
            className="kb-metric kb-metric--link"
            onClick={() => card.action && onOpenTab(card.action.tab, card.action.filter)}>
            <span className="kb-metric-label">{card.label}</span>
            <span className={`kb-metric-value kb-metric-value--${card.tone}`}>
              {/*
                六张卡原来分别走 formatCount 与 formatCoverage：这里复用同两个口径，
                覆盖率直接给出 formatCoverage（toFixed(1) 本身就会取整，滚动中也不会出现小数尾巴）；
                其余五项是整数计数，交给组件按目标值取整 —— 它的默认千分位（zh-CN）与
                formatCount 的 en-US 对整数输出相同。空值仍由组件的 fallback「—」兜住。
              */}
              <NumberAnimation
                value={metricRaw[card.key]}
                format={card.key === "coverage" ? formatCoverage : undefined}
                digits={card.key === "coverage" ? undefined : 0}
              />
              {card.unit ? <em className="kb-metric-unit">{card.unit}</em> : null}
            </span>
            <span className="kb-metric-hint">{card.hint}</span>
          </button>
        ))}
      </section>

      {/*
        两层数据的说明必须紧贴指标行：看到「资产总量 16.7 万」的人下一步就会去列表里翻，
        不在这里先说清「只有一部分能点开」，列表页的「共 X 项 · 其中 Y 项可展开明细」
        会被当成漏数据。
      */}
      <p className="kb-metrics-note kb-muted">{sampledNote(metrics)}</p>

      <div className="kb-main">
        <div className="kb-col kb-col--left">
          {/* ---- 数据资产库 ---- */}
          <KbPanel
            title="数据资产库"
            className="kb-assets-panel"
            note={
              <span className="kb-muted">
                共 <NumberAnimation value={metrics.total} /> 项 · 可展开明细 <NumberAnimation value={metrics.materialized} /> 项
              </span>
            }
            actions={
              <Btn onClick={() => onOpenTab("assets")} tone="ghost">
                进入资产管理
              </Btn>
            }>
            <div className="kb-types">
              {TYPE_ORDER.map((key) => {
                const row = totalByType.get(key);
                return (
                  <button
                    key={key}
                    type="button"
                    className="kb-type"
                    title={row?.scaleNote ?? undefined}
                    onClick={() => onOpenTab("assets", { type: key })}>
                    <span>{row?.label ?? key}</span>
                    <strong>
                      <NumberAnimation value={row?.total ?? 0} />
                    </strong>
                    <em className="kb-muted">
                      可展开 <NumberAnimation value={row?.materialized ?? 0} /> · 覆盖 <NumberAnimation value={row?.covered ?? 0} />
                    </em>
                  </button>
                );
              })}
            </div>

            <div className="kb-stack" aria-hidden>
              {TYPE_ORDER.map((key) => {
                const row = totalByType.get(key);
                const share = metrics.total > 0 ? ((row?.total ?? 0) / metrics.total) * 100 : 0;
                return <span key={key} className={`kb-stack-seg kb-stack-seg--${key}`} style={{ ["--n" as string]: `${share}%` }} />;
              })}
            </div>

            <div className="kb-table-wrap">
              <table className="kb-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>关联对象</th>
                    <th>版本</th>
                    <th>索引状态</th>
                    <th className="is-num">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recentAssets.map((asset) => (
                    <tr key={asset.id} onClick={() => onOpenAsset(asset.id)} tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onOpenAsset(asset.id);
                      }}>
                      <td title={`${asset.title}${asset.filename ? ` · ${asset.filename}` : ""}`}>
                        {asset.title}
                        <span className="kb-cell-sub kb-muted">{asset.filename ?? asset.id}</span>
                      </td>
                      <td>{asset.format}</td>
                      <td>{asset.primaryObjectId ?? "—"}</td>
                      <td>v{asset.contentRevision}</td>
                      <td>
                        <KbState text={asset.indexState} tone={indexStateTone(asset.indexState)} />
                      </td>
                      <td className="is-num">{formatMoment(asset.updatedAt)}</td>
                    </tr>
                  ))}
                  {!overview.recentAssets.length ? (
                    <tr>
                      <td colSpan={6}>
                        <span className="kb-muted">暂无资产</span>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </KbPanel>

          {/* ---- RAG 索引库 ---- */}
          <KbPanel
            title="RAG 索引库"
            className="kb-index-panel"
            note={<span className="kb-muted">{indexStatus.autoSync ? "自动更新 · 开启" : "自动更新 · 已暂停"}</span>}
            actions={
              <Btn onClick={() => onOpenTab("indexes")} tone="ghost">
                索引运维
              </Btn>
            }>
            <div className="kb-status-head">
              <div className="kb-status-main">
                <KbState text={indexStatus.service} tone={indexStatus.service === "可检索" ? "ok" : "danger"} />
                <KbState text={indexStatus.update} tone={indexStatus.tone} />
                {indexStatus.note ? <em className="kb-muted">{indexStatus.note}</em> : null}
              </div>
              <code className="kb-version">{indexStatus.servingVersion ?? "未就绪"}</code>
            </div>

            <div className="kb-index-grid">
              <div>
                <span>当前版覆盖</span>
                <strong>
                  <NumberAnimation value={metrics.covered} style={INDEX_GRID_NUM} /> /{" "}
                  <NumberAnimation value={metrics.included} style={INDEX_GRID_NUM} /> 项
                </strong>
              </div>
              <div>
                <span>最近成功发布</span>
                <strong>{formatMoment(indexStatus.lastPublishedAt)}</strong>
              </div>
              <div>
                <span>未纳入索引</span>
                <strong>
                  <NumberAnimation value={metrics.excluded} style={INDEX_GRID_NUM} /> 项
                </strong>
              </div>
              <div>
                <span>有效分块 / 向量条目</span>
                <strong>
                  <NumberAnimation value={metrics.chunks} style={INDEX_GRID_NUM} /> /{" "}
                  <NumberAnimation value={metrics.vectors} style={INDEX_GRID_NUM} />
                </strong>
              </div>
            </div>

            <KbCoverageBar
              label="全部资产"
              pct={{
                covered: metrics.total ? (metrics.covered / metrics.total) * 100 : 0,
                pending: metrics.total ? (metrics.pending / metrics.total) * 100 : 0,
                error: metrics.total ? (metrics.error / metrics.total) * 100 : 0,
                excluded: metrics.total ? (metrics.excluded / metrics.total) * 100 : 0,
                processing: 0,
              }}
              onSelect={(segment) =>
                onOpenTab("assets", {
                  state:
                    segment === "covered" ? "已覆盖" : segment === "pending" ? "待更新" : segment === "error" ? "更新失败" : "未纳入",
                })
              }
            />
            <div className="kb-row kb-small kb-muted">
              <span>已覆盖 <NumberAnimation value={metrics.covered} /></span>
              <span>
                待更新 <NumberAnimation value={metrics.pending} /> · 异常 <NumberAnimation value={metrics.error} /> · 覆盖率{" "}
                {/* 覆盖率直接复用 formatCoverage（一位小数 + 空值「—」）：toFixed(1) 会取整，与旧文案逐字节一致 */}
                <NumberAnimation value={metrics.coveragePct} format={formatCoverage} />%
              </span>
            </div>

            <div className="kb-availability">
              {overview.availability.map((row) => (
                <span key={row.key} className="kb-availability-item">
                  {row.key}
                  <strong>
                    <NumberAnimation value={row.n} />
                  </strong>
                </span>
              ))}
            </div>

            <details className="kb-collapse">
              <summary>
                十二类资产覆盖分布 <span className="kb-collapse-caret" aria-hidden>▾</span>
              </summary>
              <div className="kb-collapse-body">
                {segments.map((row) => (
                  <div key={row.type} className="kb-coverage-row">
                    <button type="button" className="kb-link" onClick={() => onOpenTab("assets", { type: row.type })}>
                      {row.label}
                    </button>
                    <KbCoverageBar label={row.label} pct={row.pct} onSelect={() => onOpenTab("assets", { type: row.type })} />
                    <span className="kb-muted">
                      <NumberAnimation value={row.materialized} /> / <NumberAnimation value={row.total} />
                    </span>
                  </div>
                ))}
                <p className="kb-detail-footnote">
                  进度条按「可展开明细」归一：规模样本没有分块与索引成员记录，算进分母会让每一类都显示成一条几乎全空的长条。
                </p>
              </div>
            </details>
          </KbPanel>
        </div>

        {/* ---- 右栏：资产关系 + 更新任务 ---- */}
        <div className="kb-col kb-col--right">
          <RelationGraph
            data={graph.data}
            loading={graph.loading}
            view={graph.view}
            onViewChange={graph.onViewChange}
            selectedId={graph.selectedId}
            onSelectNode={(node) => graph.onSelectNode(node)}
            onExpand={(node) => graph.onExpand(node)}
            expanded={graph.expanded}
            onToggleExpand={graph.onToggleExpand}
          />

          <KbPanel
            title="更新任务"
            className="kb-tasks"
            scroll={false}
            note={
              <span className="kb-muted">
                {jobs.some((job) => job.status === "运行" || job.status === "排队") ? "有任务进行中" : "暂无运行中任务"}
              </span>
            }
            actions={
              <div className="kb-pipeline" aria-label="流水线阶段">
                {["检测变更", "提取内容", "分块", "构建索引", "一致性校验", "发布"].map((stage, index) => (
                  <span key={stage} className="kb-stage">
                    {index > 0 ? <b aria-hidden>→</b> : null}
                    {stage}
                  </span>
                ))}
              </div>
            }>
            {jobs.length ? (
              <ul className="kb-task-list">
                {jobs.slice(0, 4).map((job) => {
                  const live = job.status === "运行" || job.status === "排队";
                  return (
                    <li key={job.id} className="kb-task-item">
                      <button
                        type="button"
                        className="kb-task-main"
                        onClick={() => onOpenJob(job.id)}
                        title="查看任务详情">
                        <KbState text={job.status} tone={jobStatusTone(job.status)} />
                        <span className="kb-task-title">
                          {job.kind} · {job.triggerSource}
                        </span>
                        <span className="kb-muted kb-task-meta">
                          {/* 成功 / 失败 / 已处理 原本都是裸插值（没有千分位），所以 group={false} */}
                          {job.targetVersion} · 成功 <NumberAnimation value={job.counts.succeeded} group={false} /> / 失败{" "}
                          <NumberAnimation value={job.counts.failed} group={false} /> ·{" "}
                          {/*
                            这里原本是 stageSummary(processed, total)：它返回的是纯字符串，
                            装不下带动画的 span。按 selectors.ts 的分支逐字重写（total 为 0 → 「进行中」；
                            已处理数超过总数时按总数封顶，与 stageSummary 的显示口径一致）。
                          */}
                          {job.counts.total ? (
                            <>
                              已处理{" "}
                              <NumberAnimation
                                value={Math.min(job.counts.succeeded + job.counts.failed + job.counts.skipped, job.counts.total)}
                                group={false}
                              />
                              /<NumberAnimation value={job.counts.total} group={false} /> 项
                            </>
                          ) : (
                            "进行中"
                          )}
                        </span>
                        <span className="kb-muted kb-task-time">{formatMoment(job.startedAt)}</span>
                      </button>
                      <span className="kb-task-actions">
                        <button type="button" className="kb-link" onClick={() => onOpenJob(job.id)}>
                          详情
                        </button>
                        {live && actions.canIndex ? (
                          <button type="button" className="kb-link kb-link--danger" onClick={() => void actions.cancelJob(job.id)}>
                            取消
                          </button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <KbEmpty
                title="暂无更新任务"
                hint={
                  metrics.pending
                    ? `存在 ${formatCount(metrics.pending)} 项待更新变更，启动同步后才会创建任务。`
                    : "当前服务版本已覆盖全部纳入资产。"
                }
                action={
                  metrics.pending || metrics.error ? (
                    <Btn tone="primary" onClick={() => void actions.sync()} disabled={!actions.canIndex}>
                      更新索引
                    </Btn>
                  ) : undefined
                }
              />
            )}
            <div className="kb-task-foot kb-muted">
              <span>最长等待 {formatDuration(metrics.longestWaitSeconds)}</span>
              <button type="button" className="kb-link" onClick={() => onOpenTab("indexes")}>
                全部任务与版本记录
              </button>
            </div>
          </KbPanel>
        </div>
      </div>
    </div>
  );
}
