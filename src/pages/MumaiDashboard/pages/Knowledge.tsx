/**
 * 知识库（`/knowledge`）
 *
 * PRD 5：
 *   - 资料与业务状态分开读取：资料来自本地索引，状态来自结构化数据
 *   - 首版检索是本地轻量实现（seed 里标了检索器与 Top K）
 *   - 相似度标为「检索相似度」，不能标成病害置信度
 *   - 无命中时回答「当前资料未检索到」，不编造
 *   - 页面要体现 RAG：答案带来源与原文位置
 */

import { useMemo, useState } from "react";
import { useMumai } from "../context";
import { Panel } from "../Panel";
import { SourceTag, StateBlock, StatusChip } from "../ui";
import { KNOWLEDGE_DOCS, KNOWLEDGE_META, CURRENT_RISKS, HISTORY_STATS } from "../seed/scenario";

interface Hit {
  docId: string;
  title: string;
  category: string;
  source: string;
  version: string;
  chunkId: string;
  section: string;
  text: string;
  score: number;
}

/** 本地检索：字符 n-gram 命中率（演示版，标注为检索相似度） */
function retrieve(query: string, topK: number): Hit[] {
  const cleaned = query.replace(/\s/g, "");
  if (!cleaned) return [];
  const grams = new Set<string>();
  for (let size = 2; size <= 4; size++) {
    for (let i = 0; i + size <= cleaned.length; i++) grams.add(cleaned.slice(i, i + size));
  }

  const hits: Hit[] = [];
  for (const doc of KNOWLEDGE_DOCS) {
    for (const chunk of doc.chunks) {
      let hit = 0;
      for (const gram of grams) if (chunk.text.includes(gram)) hit += 1;
      const score = grams.size ? hit / grams.size : 0;
      if (score > KNOWLEDGE_META.noHitThreshold) {
        hits.push({
          docId: doc.docId,
          title: doc.title,
          category: doc.category,
          source: doc.source,
          version: doc.version,
          chunkId: chunk.chunkId,
          section: chunk.section,
          text: chunk.text,
          score,
        });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}

export default function Knowledge() {
  const { askAssistant } = useMumai();
  const [query, setQuery] = useState("五月巡检 Z04 渗水");
  const [submitted, setSubmitted] = useState("五月巡检 Z04 渗水");
  const [active, setActive] = useState<string | null>(null);

  const hits = useMemo(() => retrieve(submitted, KNOWLEDGE_META.topK), [submitted]);
  const activeHit = hits.find((hit) => hit.chunkId === active) ?? hits[0] ?? null;

  /** 业务状态：来自结构化数据，不来自资料 */
  const liveFacts = [
    { k: "本轮风险", v: `${CURRENT_RISKS.length} 处（CUR-Z04-01~03）` },
    { k: "历史风险", v: `R01–R06 共 ${HISTORY_STATS.total} 处` },
    { k: "已关闭", v: `${HISTORY_STATS.closed} 处` },
    { k: "未关闭", v: `${HISTORY_STATS.open} 处` },
  ];

  return (
    <div className="page page--knowledge">
      <div className="kn-layout">
        {/* 左：检索 */}
        <div className="kn-left">
          <Panel
            title="资料检索"
            extra={<SourceTag label={`索引 ${KNOWLEDGE_META.indexVersion}`} />}>
            <form
              className="kn-search"
              onSubmit={(event) => {
                event.preventDefault();
                setSubmitted(query);
                setActive(null);
              }}>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="输入关键词，例如：渗水 / 复扫 / HH / 更新包"
                aria-label="检索资料"
              />
              <button type="submit">检索</button>
            </form>

            <dl className="kn-meta">
              <div>
                <dt>检索器</dt>
                <dd>{KNOWLEDGE_META.retriever}</dd>
              </div>
              <div>
                <dt>Top K</dt>
                <dd>{KNOWLEDGE_META.topK}</dd>
              </div>
              <div>
                <dt>分块</dt>
                <dd>{KNOWLEDGE_META.chunkSize}</dd>
              </div>
            </dl>

            <h4 className="sub">检索结果 {hits.length ? `Top ${hits.length}` : ""}</h4>
            {hits.length ? (
              <ul className="kn-hits">
                {hits.map((hit) => (
                  <li key={hit.chunkId} className={activeHit?.chunkId === hit.chunkId ? "is-active" : ""}>
                    <button type="button" onClick={() => setActive(hit.chunkId)}>
                      <b>{hit.title}</b>
                      <span>{hit.section}</span>
                      <em>
                        检索相似度 {hit.score.toFixed(2)} · {hit.chunkId}
                      </em>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <StateBlock
                kind="empty"
                title="当前资料未检索到"
                hint="本地索引没有命中；不调用大模型编造答案。"
              />
            )}
          </Panel>
        </div>

        {/* 右：原文 + 业务状态 + 小木入口 */}
        <div className="kn-right">
          <Panel
            title="原文位置"
            extra={activeHit ? <StatusChip text={activeHit.category} tone="info" /> : null}>
            {activeHit ? (
              <>
                <dl className="kv">
                  <div>
                    <dt>文件</dt>
                    <dd>{activeHit.source}</dd>
                  </div>
                  <div>
                    <dt>版本</dt>
                    <dd>{activeHit.version}</dd>
                  </div>
                  <div>
                    <dt>章节</dt>
                    <dd>{activeHit.section}</dd>
                  </div>
                  <div>
                    <dt>分块</dt>
                    <dd>{activeHit.chunkId}</dd>
                  </div>
                </dl>
                <blockquote className="kn-quote">{activeHit.text}</blockquote>
                <p className="note">
                  相似度是**检索相似度**，不是病害置信度；资料用于解释，不能替代现场实测。
                </p>
              </>
            ) : (
              <StateBlock kind="empty" title="未选中片段" hint="在左侧检索并选择一条结果。" />
            )}
          </Panel>

          <Panel title="业务状态（结构化数据）" extra={<SourceTag label="实时读取" />}>
            <dl className="kv">
              {liveFacts.map((fact) => (
                <div key={fact.k}>
                  <dt>{fact.k}</dt>
                  <dd>{fact.v}</dd>
                </div>
              ))}
            </dl>
            <p className="note">{KNOWLEDGE_META.note}</p>
          </Panel>

          <Panel title="资料库">
            <ul className="kn-docs">
              {KNOWLEDGE_DOCS.map((doc) => (
                <li key={doc.docId}>
                  <b>{doc.title}</b>
                  <span>
                    {doc.category} · {doc.date} · {doc.version}
                  </span>
                  <em>
                    {doc.source} · {doc.digest}
                  </em>
                  <small>{doc.chunks.length} 个片段</small>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => askAssistant(submitted)}>
              把小木叫来一起看
            </button>
          </Panel>
        </div>
      </div>
    </div>
  );
}
