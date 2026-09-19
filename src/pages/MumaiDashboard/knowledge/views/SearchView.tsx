/**
 * 数据与知识中心 · 检索验证页签
 *
 * 依据：PRD §5.5（上方检索栏 + 左侧结果列表 40% + 右侧证据详情 60%；
 *      无查询时给 3 条工作场景示例，不展示算法教程）、§10.4（检索与图谱联动）、
 *      §16.3 R04（无命中不生成确定性回答，允许展开低相关候选）。
 *
 * 界面上只出现**一个**证据详情区：结果列表里是两行摘要，完整片段只在这里展示，
 * 不在图下面再复制一份（PRD §6.2「重复展示同一个片段 → 合并」）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Btn, StateBlock } from "../../ui";
import type { SearchHit, SearchResult } from "../types";
import { formatMoment, formatScore } from "../selectors";
import { describeLocatorText } from "../components/locator";
import { KbCollapse, KbEmpty, KbKV, KbPanel, KbState } from "../components/KnowledgeUi";
import type { KnowledgeApiActions } from "../components/api-actions";

const EXAMPLES = [
  "Z04 柱脚历次渗水记录与处置结果",
  "扫描设备在九月巡检期间的通信异常",
  "某工单对应的报告、现场照片和复核记录",
];

export function SearchView({
  result,
  running,
  error,
  actions,
  onSearch,
  onClear,
  onOpenAsset,
  onFocusGraph,
  currentServingVersion,
  onRerun,
  initialQuery = "",
}: {
  result: SearchResult | null;
  running: boolean;
  error: string | null;
  actions: KnowledgeApiActions;
  onSearch: (query: string, options?: { topK?: number }) => Promise<void>;
  onClear: () => void;
  onOpenAsset: (assetId: string) => void;
  onFocusGraph: (assetId: string) => void;
  currentServingVersion: string | null;
  onRerun: () => void;
  /**
   * URL 里带的检索问题（`#/knowledge?tab=search&q=…`）：进页面就**直接跑这一问**。
   *
   * 为什么要它（用户 2026-10-01：「第一个对话跳转不对，跳那啥都没有评委看什么」）：
   * 小木第①轮说「我正在检索RAG知识库…」，落点就是这一页；不代问的话屏幕上只剩一个
   * 空输入框 + 三条示例。带 `q` 进来 → 问题、命中的资料与原文定位一起出现，
   * 而且刷新/复制链接都能回到同一屏（与 `doc`/`chunk` 落点同一条口径）。
   */
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showLow, setShowLow] = useState(false);

  const hits = useMemo(() => result?.hits ?? [], [result]);
  const selected = useMemo(
    () => hits.find((hit) => hit.chunkId === selectedId) ?? result?.lowCandidates.find((hit) => hit.chunkId === selectedId) ?? null,
    [hits, result, selectedId],
  );
  const staleVersion = Boolean(result && result.version && currentServingVersion && result.version !== currentServingVersion);

  function submit(next?: string) {
    const text = (next ?? query).trim();
    if (!text) return;
    setQuery(text);
    setSelectedId(null);
    setShowLow(false);
    void onSearch(text).then(() => setSelectedId(null));
  }

  /*
    URL 带来的问题**自动跑一次**（小木第①轮代问）。
    `ranRef` 保证同一个问题只自动跑一次：结果回来后父组件会重渲染，
    不禁一下会把同一问反复提交（每次提交都会打一次检索接口）。
  */
  const ranRef = useRef("");
  const autoSelectRef = useRef(false);
  useEffect(() => {
    const text = initialQuery.trim();
    if (!text || ranRef.current === text) return;
    ranRef.current = text;
    /* 代问的这一问跑完**自动选中第一条证据**：否则右侧详情停在
       「从左侧选择一条证据」，投屏上等于半屏是空的（真人自己检索时不受影响） */
    autoSelectRef.current = true;
    submit(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只认 initialQuery，submit 每次渲染都会重建
  }, [initialQuery]);

  useEffect(() => {
    if (!autoSelectRef.current) return;
    const first = (result?.hits ?? [])[0];
    if (!first) return;
    autoSelectRef.current = false;
    setSelectedId(first.chunkId);
  }, [result]);

  return (
    <div className="kb-search">
      <div className="kb-search-bar">
        <input
          className="kb-input kb-input--search"
          placeholder="输入对象编号、时间范围或问题线索，例如「Z04 柱脚历次渗水记录与处置结果」"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <Btn tone="primary" onClick={() => submit()} disabled={running || !actions.canSearch}>
          {running ? "检索中…" : "检索"}
        </Btn>
        {result ? <Btn onClick={() => { onClear(); setSelectedId(null); }}>清空</Btn> : null}
        {!actions.canSearch ? <span className="kb-muted">当前角色没有证据检索权限</span> : null}
      </div>

      {staleVersion ? (
        <p className="kb-toast kb-toast--warn">
          索引已更新到 {currentServingVersion}，当前结果仍绑定 {result?.version}。
          <button type="button" className="kb-link" onClick={onRerun}>
            用新版本重新检索
          </button>
        </p>
      ) : null}

      {error ? <StateBlock kind="error" title="检索失败" hint={error} /> : null}

      {!result && !running ? (
        <KbPanel title="工作场景示例" note={<span className="kb-muted">选择一条即可执行检索</span>}>
          <ul className="kb-example-list">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button type="button" className="kb-link" onClick={() => submit(example)} disabled={!actions.canSearch}>
                  {example}
                </button>
              </li>
            ))}
          </ul>
          <p className="kb-detail-footnote">
            检索返回的是证据本身：来源资产、版本与原文定位。默认不生成结论性回答，也不补充检索不到的原因或处置建议。
          </p>
        </KbPanel>
      ) : null}

      {result ? (
        <div className="kb-search-split">
          <KbPanel
            title="检索结果"
            className="kb-hit-list"
            note={
              <span className="kb-muted">
                {/* 命中数原本走 formatCount（有千分位）→ 默认分组；耗时是毫秒测量值，原来是裸插值 → group={false} */}
                {result.hits.length ? <><NumberAnimation value={result.hits.length} /> 条证据</> : "未检索到匹配证据"} ·{" "}
                <NumberAnimation value={result.elapsedMs} group={false} /> ms
              </span>
            }
            actions={
              <span className="kb-muted">
                服务版本 <code>{result.version ?? "—"}</code>
              </span>
            }>
            {hits.length ? (
              <ul className="kb-hits">
                {hits.map((hit, index) => (
                  <li key={hit.chunkId}>
                    <button
                      type="button"
                      className={`kb-hit ${selectedId === hit.chunkId ? "is-selected" : ""}`}
                      onClick={() => setSelectedId(hit.chunkId)}>
                      <div className="kb-hit-head">
                        <span className="kb-hit-index">{index + 1}</span>
                        <strong>{hit.title}</strong>
                        {/* 分数沿用 selectors 的 formatScore（= toFixed(4)），滚动过程中也是四位小数 */}
                        <span className="kb-hit-score">
                          <NumberAnimation value={hit.score} format={formatScore} />
                        </span>
                      </div>
                      <div className="kb-hit-meta">
                        <span>{hit.assetTypeLabel}</span>
                        {hit.objectIds.length ? <span>对象 {hit.objectIds.join("、")}</span> : null}
                        <span>{hit.locatorText}</span>
                      </div>
                      <p className="kb-hit-snippet">{hit.snippet}</p>
                      {hit.versionNote ? <span className="kb-hit-note">{hit.versionNote}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <KbEmpty
                title="未检索到匹配证据"
                hint={`阈值 ${result.threshold} 以下的结果不会作为证据返回。`}
                action={
                  result.lowCandidates.length ? (
                    /* 按钮文案原本是模板串；同上，`.btn` 是 inline-flex + gap，整句必须是一个 flex 项 */
                    <Btn onClick={() => setShowLow((value) => !value)}>
                      {showLow ? (
                        "收起低相关候选"
                      ) : (
                        <span>
                          展开低相关候选（<NumberAnimation value={result.lowCandidates.length} group={false} />）
                        </span>
                      )}
                    </Btn>
                  ) : undefined
                }
              />
            )}

            {showLow && result.lowCandidates.length ? (
              <KbCollapse summary={`低相关候选（${result.lowCandidates.length} 条，不作为证据）`} defaultOpen>
                <ul className="kb-hits kb-hits--low">
                  {result.lowCandidates.map((hit) => (
                    <li key={hit.chunkId}>
                      <button type="button" className="kb-hit" onClick={() => setSelectedId(hit.chunkId)}>
                        <div className="kb-hit-head">
                          <strong>{hit.title}</strong>
                          <span className="kb-hit-score">
                            <NumberAnimation value={hit.score} format={formatScore} />
                          </span>
                        </div>
                        <p className="kb-hit-snippet">{hit.snippet}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              </KbCollapse>
            ) : null}
          </KbPanel>

          <KbPanel
            title="证据详情"
            className="kb-evidence"
            note={selected ? <span className="kb-muted">{selected.locatorText}</span> : <span className="kb-muted">从左侧选择一条证据</span>}>
            {selected ? (
              <EvidenceDetail
                hit={selected}
                threshold={result.threshold}
                onOpenAsset={onOpenAsset}
                onFocusGraph={onFocusGraph}
                result={result}
              />
            ) : (
              <KbEmpty title="未选择证据" hint="选择左侧任一结果，这里显示完整片段与原始资料入口。" />
            )}
          </KbPanel>
        </div>
      ) : null}
    </div>
  );
}

function EvidenceDetail({
  hit,
  threshold,
  onOpenAsset,
  onFocusGraph,
  result,
}: {
  hit: SearchHit;
  threshold: number;
  onOpenAsset: (assetId: string) => void;
  onFocusGraph: (assetId: string) => void;
  result: SearchResult;
}) {
  return (
    <div className="kb-evidence-body">
      <div className="kb-evidence-head">
        <h3>{hit.title}</h3>
        <div className="kb-evidence-tags">
          <KbState text={hit.assetTypeLabel} tone="info" />
          {hit.matchedObjects.length ? <KbState text={`对象匹配 ${hit.matchedObjects.join("、")}`} tone="ok" /> : null}
          {hit.low ? <KbState text={`低于阈值 ${threshold}`} tone="warn" /> : null}
        </div>
      </div>

      <pre className="kb-evidence-text">{hit.snippet}</pre>

      <div className="kb-evidence-actions">
        <Btn onClick={() => onOpenAsset(hit.assetId)}>查看来源资产</Btn>
        <Btn onClick={() => onFocusGraph(hit.assetId)}>在图谱中定位</Btn>
      </div>

      <KbCollapse summary="检索详情（相似度、定位与配置）">
        <KbKV
          items={[
            /*
              只有会变的数字才滚：相似度、分块字数、耗时、阈值、快照序号。
              来源资产 / 分块编号是 id，来源版本是 v 串，分块摘要是哈希，命中时间是时间戳，
              「中文 2–4 元」是静态文案 —— 一律保持原样（KbKV 的 v 收 ReactNode，其余不用改）。
              千分位按原来的写法区分：分块字数原来走 formatCount（有千分位）；
              语料构建 ms、快照序号原来是裸插值 / String()（无千分位）→ 显式 group={false}。
            */
            { k: "检索相似度", v: <NumberAnimation value={hit.score} format={formatScore} /> },
            { k: "来源定位", v: describeLocatorText(hit.locator) },
            { k: "来源资产", v: <code>{hit.assetId}</code> },
            { k: "来源版本", v: `v${hit.assetRevision}（当前 v${hit.currentRevision}）` },
            { k: "分块编号", v: <code>{hit.chunkId}</code> },
            { k: "分块摘要", v: hit.digest ?? "—" },
            { k: "分块字数", v: <><NumberAnimation value={hit.charCount} /> 字</> },
            { k: "命中时间", v: formatMoment(result.serverTime) },
            /* 阈值原来是 String(threshold)：沿用同一口径，配置里的小数位数一位都不改 */
            { k: "相似度阈值", v: <NumberAnimation value={threshold} format={String} /> },
            { k: "检索模式", v: `${result.adapterMode} · 中文 2–4 元 TF-IDF / 余弦` },
            { k: "语料构建", v: <><NumberAnimation value={result.corpusBuiltMs} group={false} /> ms（按服务版本缓存）</> },
            { k: "快照序号", v: <NumberAnimation value={result.snapshotSeq} group={false} /> },
          ]}
        />
        {result.interpreted.objectIds.length || result.interpreted.timeRange ? (
          <p className="kb-detail-note">
            本次解析出的筛选条件：
            {result.interpreted.objectIds.length ? ` 对象 ${result.interpreted.objectIds.join("、")}` : ""}
            {result.interpreted.timeRange ? ` 时间范围 ${result.interpreted.timeRange.label}` : ""}
          </p>
        ) : null}
      </KbCollapse>
    </div>
  );
}
