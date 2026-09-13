/**
 * 数据与知识中心（`/knowledge`）
 *
 * 依据：PRD-数据与知识中心-v1.0.md
 *   · §5.1 总览是默认进入的页面；标题与操作 → 四个页签 → 六项指标 → 主体双栏 → 近期任务
 *   · §5.3–§5.5 四个页签各自的排版
 *   · §6.2 删除、替换与下沉清单（本页不再出现「把小木叫来一起看」「不上传任何服务器」
 *     「本页不连接后端」「本地 TF-IDF / 中文 2–4 元」这类内容）
 *   · §12.5 事件只当变化通知，按 seq 拉同一快照
 *   · §15 文件落点：本文件只做「页签路由容器、范围选择、抽屉入口」
 *
 * 一级导航仍叫「知识库」（不改平台导航认知），进入后标题用「数据与知识中心」。
 * 页眉保留一个低干扰的「演示环境」标识，详细能力边界收进「数据说明」抽屉。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import NumberAnimation from "@/components/numberAnimation";
import { useMumai } from "../context";
import { Btn, StateBlock } from "../ui";
import { useSharedStore } from "../store/shared";
import { useAssetDetail, useAssetList, useKnowledgeOverview, useKnowledgeSearch, useRelationGraph } from "../knowledge/hooks";
import { formatMoment } from "../knowledge/selectors";
import type { AssetFilters, FixtureReport, GraphNode, JobDetail, KnowledgeTab } from "../knowledge/types";
import { knowledgeApi } from "../knowledge/api";
import { KbCollapse, KbDrawer, KbEmpty, KbKV, KbState } from "../knowledge/components/KnowledgeUi";
import { useKnowledgeActions } from "../knowledge/components/api-actions";
import { AssetDrawer } from "../knowledge/components/AssetDrawer";
import { ImportDrawer } from "../knowledge/components/ImportDrawer";
import { JobDetailDrawer } from "../knowledge/components/JobDetailDrawer";
import { OverviewView } from "../knowledge/views/OverviewView";
import { AssetsView } from "../knowledge/views/AssetsView";
import { IndexesView } from "../knowledge/views/IndexesView";
import { SearchView } from "../knowledge/views/SearchView";
import "../knowledge/knowledge.css";

const TABS: { key: KnowledgeTab; label: string }[] = [
  { key: "overview", label: "总览" },
  { key: "assets", label: "数据资产" },
  { key: "indexes", label: "RAG 索引" },
  { key: "search", label: "检索验证" },
];

/** 页签写进 URL：复制链接即可让另一台电脑打开同一视图（PRD §5.1「页签可独立访问」） */
function readTab(value: string | null): KnowledgeTab {
  return value === "assets" || value === "indexes" || value === "search" ? value : "overview";
}

export default function Knowledge() {
  const { sharedStatus, sharedError } = useMumai();
  const [params, setParams] = useSearchParams();
  const tab = readTab(params.get("tab"));

  const overviewState = useKnowledgeOverview();
  const [graphView, setGraphView] = useState<"business" | "lineage">("business");
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const [graphFull, setGraphFull] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [fixture, setFixture] = useState<FixtureReport | null>(null);
  const [jobDetail, setJobDetail] = useState<JobDetail | null>(null);
  const [jobDrawerId, setJobDrawerId] = useState<string | null>(null);

  const sessionId = useSharedStore((state) => state.sessionId);
  const assets = useAssetList({ limit: 50 });
  const detail = useAssetDetail(assetId);
  const search = useKnowledgeSearch();
  const graph = useRelationGraph(graphView, graphFocus, graphFull);

  const onChanged = useCallback(() => {
    void overviewState.reload();
    void assets.reload();
  }, [overviewState, assets]);

  const actions = useKnowledgeActions(onChanged);

  /* 页签与筛选都进 URL：刷新后能回到同一视图（PRD §5.1「筛选可恢复」） */
  const openTab = useCallback(
    (next: KnowledgeTab, filter?: Record<string, string>) => {
      const search = new URLSearchParams(params);
      search.set("tab", next);
      for (const key of ["type", "state", "objectId", "q"]) search.delete(key);
      if (filter) for (const [key, value] of Object.entries(filter)) if (value) search.set(key, value);
      setParams(search, { replace: false });
    },
    [params, setParams],
  );

  /**
   * 资产筛选是**双向**的：URL ↔ 筛选状态。
   *
   * 从总览点「文档」进来要带着筛选（PRD §7.2 点击行为），刷新或前进后退也要恢复；
   * 在筛选栏里改动则回写 URL。两边都只认这四个键，避免把页码之类的东西写进地址栏。
   */
  const urlFilterKey = params.toString();
  useEffect(() => {
    if (tab !== "assets") return;
    assets.setFilters(readAssetFilters(params));
    // 只在 URL 真正变化时同步；assets.setFilters 每次都是新对象，不能进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, urlFilterKey]);

  const applyAssetFilters = useCallback(
    (next: AssetFilters, append = false) => {
      if (append) {
        void assets.loadMore();
        return;
      }
      assets.setFilters(next);
      if (tab !== "assets") return;
      const search = new URLSearchParams(params);
      search.set("tab", "assets");
      const pairs: [string, string | null | undefined][] = [
        ["type", next.type],
        ["state", next.indexState],
        ["category", next.category],
        ["source", next.source],
        ["objectId", next.objectId],
        ["q", next.query],
      ];
      for (const key of URL_FILTER_KEYS) search.delete(key);
      for (const [key, value] of pairs) {
        if (value) search.set(key, String(value));
      }
      setParams(search, { replace: true });
    },
    [assets, params, setParams, tab],
  );

  // 有任务在跑就跟踪它，任务终态自动停（PRD §16.4）
  const activeJob = useMemo(
    () => overviewState.jobs.find((job) => job.status === "运行" || job.status === "排队") ?? null,
    [overviewState.jobs],
  );
  useEffect(() => {
    if (activeJob) overviewState.watchJob(activeJob.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id]);

  // 任务详情：运行中跟随当前任务；否则跟随抽屉里选中的任务
  const detailJobId = jobDrawerId ?? overviewState.watchingJobId ?? activeJob?.id ?? null;
  useEffect(() => {
    if (!detailJobId) {
      setJobDetail(null);
      return;
    }
    let cancelled = false;
    void knowledgeApi
      .job(sessionId, detailJobId)
      .then((value) => {
        if (!cancelled) setJobDetail(value);
      })
      .catch(() => {
        if (!cancelled) setJobDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detailJobId, sessionId, overviewState.jobs]);

  useEffect(() => {
    if (!noteOpen || fixture) return;
    void knowledgeApi
      .fixture(sessionId)
      .then(setFixture)
      .catch(() => setFixture(null));
  }, [noteOpen, fixture, sessionId]);

  const handleGraphNode = useCallback((node: GraphNode | null) => {
    setSelectedNode(node?.id ?? null);
    if (node?.assetId) setAssetId(node.assetId);
  }, []);

  const overview = overviewState.overview;
  const offline = sharedStatus === "offline";

  return (
    <div className="kb">
      <header className="kb-header">
        <div className="kb-title">
          <h1>数据与知识中心</h1>
          <span className="kb-chip" title="资料、关联与索引状态来自演示会话">
            演示环境
          </span>
          <span className="kb-scope">
            项目 · <strong>{overview?.scope.label ?? "示例寺"}</strong>
          </span>
          {overview ? (
            <span className="kb-header-status">
              <KbState text={overview.indexStatus.service} tone={overview.indexStatus.service === "可检索" ? "ok" : "danger"} />
              <KbState text={overview.indexStatus.update} tone={overview.indexStatus.tone} />
              <code>{overview.servingVersion ?? "未就绪"}</code>
            </span>
          ) : null}
        </div>

        <div className="kb-header-actions">
          {/*
            快照 seq 与时间戳并排：seq 每来一份快照都会变（挂载 reload + knowledge.* 事件 +
            索引任务运行时的 1200ms 轮询），属于会变的数，交给 NumberAnimation；
            时间戳是 formatMoment 的文本，按规范不做滚动。
            seq 是标识序号（原来是裸插值，没有千分位），所以显式 group={false}。
          */}
          {overview ? (
            <span className="kb-muted kb-header-time">
              快照 seq <NumberAnimation value={overview.snapshotSeq} group={false} /> · {formatMoment(overview.serverTime)}
            </span>
          ) : null}
          <Btn onClick={() => setNoteOpen(true)}>数据说明</Btn>
          <Btn onClick={() => setImportOpen(true)} disabled={!actions.canManage}>
            导入资料
          </Btn>
          <Btn
            tone="primary"
            disabled={!actions.canIndex || actions.busy}
            onClick={() => void actions.sync({ scope: overview?.metrics.error ? "errors" : "backlog", triggerSource: "页眉" })}>
            更新索引
          </Btn>
        </div>
      </header>

      <nav className="kb-tabs" aria-label="数据与知识中心页签">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`kb-tab ${tab === item.key ? "is-active" : ""}`}
            onClick={() => openTab(item.key)}>
            {item.label}
            {/* 徽标只在计数非 0 时出现；数字传原始值，空值时组件自己落「—」占位 */}
            {item.key === "assets" && overview?.metrics.pending ? (
              <em className="kb-tab-badge">
                <NumberAnimation value={overview.metrics.pending} />
              </em>
            ) : null}
            {item.key === "assets" && overview?.metrics.error ? (
              <em className="kb-tab-badge kb-tab-badge--warn">
                <NumberAnimation value={overview.metrics.error} />
              </em>
            ) : null}
          </button>
        ))}
        <span className="kb-tabs-note kb-muted">
          资料与索引分两层：资产库保存原始事实，RAG 索引保存可检索的派生内容
        </span>
      </nav>

      {offline ? (
        <div className="kb-offline">
          <StateBlock kind="offline" title="连接中断" hint={`${sharedError ?? "共享服务不可达"} · 状态截至 ${formatMoment(overview?.serverTime)}`} />
        </div>
      ) : null}

      <div className="kb-body">
        {tab === "overview" ? (
          <OverviewView
            overview={overview}
            jobs={overviewState.jobs}
            loading={overviewState.loading}
            error={overviewState.error}
            actions={actions}
            onOpenTab={openTab}
            onOpenAsset={setAssetId}
            onOpenJob={setJobDrawerId}
            graph={{
              view: graphView,
              onViewChange: setGraphView,
              data: graph.data,
              loading: graph.loading,
              selectedId: selectedNode,
              onSelectNode: handleGraphNode,
              onExpand: (node) => {
                setGraphFocus(node.id);
                setSelectedNode(node.id);
              },
              expanded: graphFull,
              onToggleExpand: () => setGraphFull((value) => !value),
            }}
          />
        ) : null}

        {tab === "assets" ? (
          <AssetsView
            page={assets.page}
            filters={assets.filters}
            onFilters={(next) => applyAssetFilters(next, false)}
            onLoadMore={() => applyAssetFilters(assets.filters, true)}
            loading={assets.loading}
            error={assets.error}
            actions={actions}
            overview={overview}
            onOpenAsset={setAssetId}
            onImport={() => setImportOpen(true)}
          />
        ) : null}

        {tab === "indexes" ? (
          <IndexesView
            overview={overview}
            versions={overviewState.versions}
            jobs={overviewState.jobs}
            loading={overviewState.loading}
            error={overviewState.error}
            actions={actions}
            onOpenTab={openTab}
            onWatchJob={overviewState.watchJob}
            onOpenAsset={setAssetId}
            jobDetail={jobDetail}
          />
        ) : null}

        {tab === "search" ? (
          <SearchView
            result={search.result}
            running={search.running}
            error={search.error}
            actions={actions}
            onSearch={async (query) => {
              await search.run(query);
            }}
            onClear={search.clear}
            onOpenAsset={setAssetId}
            onFocusGraph={(id) => {
              setGraphView("business");
              setGraphFocus(id);
              openTab("overview");
            }}
            currentServingVersion={overview?.servingVersion ?? null}
            onRerun={() => void search.run(search.result?.query ?? "")}
          />
        ) : null}
      </div>

      {/* ---- 抽屉 ---- */}
      <AssetDrawer
        open={Boolean(assetId)}
        detail={detail.detail}
        loading={detail.loading}
        error={detail.error}
        actions={actions}
        onClose={() => setAssetId(null)}
        onOpenAsset={setAssetId}
      />

      <ImportDrawer
        open={importOpen}
        onClose={() => setImportOpen(false)}
        actions={actions}
        knownNames={(assets.page?.items ?? []).map((asset) => asset.title)}
      />

      <JobDetailDrawer
        open={Boolean(jobDrawerId)}
        detail={jobDetail}
        loading={overviewState.loading}
        error={overviewState.error}
        actions={actions}
        onClose={() => setJobDrawerId(null)}
        onOpenAsset={(id) => {
          setJobDrawerId(null);
          setAssetId(id);
        }}
      />

      <KbDrawer open={noteOpen} title="数据说明" subtitle="演示环境的能力边界与数据处理方式" onClose={() => setNoteOpen(false)}>
        <p className="kb-note-paragraph">
          当前为演示环境。资料、关联与索引状态来自演示会话；支持导入的资产按接入规则处理。检索模式与文件能力可在此查看。
        </p>

        <KbKV
          items={[
            { k: "演示场景", v: fixture?.scenarioId ?? "knowledge-demo-v1" },
            { k: "夹具 seed", v: fixture ? String(fixture.seed) : "—" },
            /*
              下面四个数来自同一份总览快照（轮询时整份替换），是会变的数。
              KbKV 的 v 接受 ReactNode，所以数字就地换成 NumberAnimation，
              单位文字留在外面；缺快照时仍按旧文案显示「—」。
            */
            { k: "平台资产总量", v: overview ? <><NumberAnimation value={overview.metrics.total} /> 项</> : "—" },
            { k: "可展开明细", v: overview ? <><NumberAnimation value={overview.metrics.materialized} /> 项</> : "—" },
            { k: "规模样本（只统计）", v: overview ? <><NumberAnimation value={overview.metrics.scale} /> 项</> : "—" },
            { k: "分块 / 向量条目", v: overview ? <><NumberAnimation value={overview.metrics.chunks} /> / <NumberAnimation value={overview.metrics.vectors} /></> : "—" },
            { k: "索引模式", v: overview ? `${overview.adapterMode} · 维度配置 ${overview.dimensionConfig}` : "—" },
            { k: "当前服务版本", v: overview?.servingVersion ?? "—" },
          ]}
        />

        <KbCollapse summary="为什么有的资料点不开" defaultOpen>
          <p className="kb-note-paragraph">
            平台里的资产分两层：**可展开明细**有文件名、版本、来源与分块，可以筛选、打开详情、参与检索；
            **规模样本**是历史归档里同类资料的计数（例如五万余张现场照片），只参与统计。
            演示库不会把十几万条记录逐条生成 —— 那既没必要，也会让首次启动慢到不可用。
            列表页每个主类都会同时标出「总量」与「可展开条数」，两者不会混成一个数字。
          </p>
        </KbCollapse>

        <KbCollapse summary="十二类资产与不同格式的处理方式">
          <table className="kb-table kb-table--note">
            <thead>
              <tr>
                <th>资产主类</th>
                <th>本期处理方式</th>
                <th>页面表现</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>文档报告</td>
                <td>真正读取真实文件：受大小限制的文本解析、分页定位</td>
                <td>正常进入索引流程，可查看原文与页码</td>
              </tr>
              <tr>
                <td>现场照片</td>
                <td>人工描述 / 审核标注；无标注的不纳入</td>
                <td>有描述可检索，无描述显示「待补充内容」</td>
              </tr>
              <tr>
                <td>巡检视频</td>
                <td>预置转写片段 + 关键帧时间码；无转写不纳入</td>
                <td>可按时间码定位到片段</td>
              </tr>
              <tr>
                <td>音频记录</td>
                <td>现场录音 + 转写片段；未整理的停在待补充</td>
                <td>可按时间码定位到发言</td>
              </tr>
              <tr>
                <td>扫描数据 / 点云</td>
                <td>只登记设备、站点、点数与采集时间，不做文本提取</td>
                <td>「未纳入」，不按文件大小伪造正文</td>
              </tr>
              <tr>
                <td>高斯场景 / 建模建图</td>
                <td>登记训练器、精细度与配准残差；建图成果可带说明</td>
                <td>有说明的可检索，其余只统计</td>
              </tr>
              <tr>
                <td>模型权重</td>
                <td>登记框架、参数量与版本，二进制内容不入索引</td>
                <td>「未纳入」，只用于版本追溯</td>
              </tr>
              <tr>
                <td>历史工单 / 日志 / 业务记录</td>
                <td>结构化实体转文本；工单节点、日志行号、记录 revision 定位</td>
                <td>可检索并追溯到原始记录</td>
              </tr>
            </tbody>
          </table>
        </KbCollapse>

        <KbCollapse summary="检索与回答的能力边界">
          <ul className="kb-note-list">
            <li>检索复用中文 2–4 元词项统计与余弦相似度，先按项目、对象、日期与版本过滤候选，再排名。</li>
            <li>评分绑定当前服务版本的语料统计，构建后缓存；不每次输入都遍历全部内容。</li>
            <li>「向量条目」是演示索引里真实存在的逻辑记录，768 只是配置维度，不代表落盘了稠密向量。</li>
            <li>默认输出证据列表。没有合格命中时显示「未检索到匹配证据」，低分结果只作为候选列出，不写成回答。</li>
          </ul>
        </KbCollapse>

        {fixture?.deepSampleIds.length ? (
          <KbCollapse summary={`可深入展示样本（${fixture.deepSampleCount} 组）`}>
            <ul className="kb-note-list">
              {fixture.deepSampleIds.slice(0, 12).map((id) => (
                <li key={id}>
                  <button type="button" className="kb-link" onClick={() => { setAssetId(id); setNoteOpen(false); }}>
                    {id}
                  </button>
                </li>
              ))}
              {fixture.deepSampleIds.length > 12 ? <li className="kb-muted">其余 {fixture.deepSampleIds.length - 12} 组在资产列表中按类型筛选查看</li> : null}
            </ul>
          </KbCollapse>
        ) : null}

        {fixture && fixture.errors.length ? <p className="kb-toast kb-toast--danger">夹具自检未通过：{fixture.errors.join("；")}</p> : null}
        {!fixture ? <KbEmpty title="暂无夹具报告" hint="当前会话没有安装演示夹具，说明仅显示平台能力边界。" /> : null}
      </KbDrawer>
    </div>
  );
}

/** URL 查询参数 → 资产筛选（与 applyAssetFilters 的写入保持一一对应） */
function readAssetFilters(params: URLSearchParams): AssetFilters {
  return {
    limit: 50,
    type: (params.get("type") as AssetFilters["type"]) || null,
    indexState: (params.get("state") as AssetFilters["indexState"]) || null,
    category: params.get("category") || null,
    source: params.get("source") || null,
    objectId: params.get("objectId") || null,
    query: params.get("q") || "",
  };
}

/** 进 URL 的筛选键：只这四个够用，页码、排序之类不写进地址栏 */
const URL_FILTER_KEYS = ["type", "state", "category", "source", "objectId", "q"] as const;
