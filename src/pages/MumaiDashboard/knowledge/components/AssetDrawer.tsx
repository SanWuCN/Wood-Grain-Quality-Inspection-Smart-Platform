/**
 * 数据与知识中心 · 资产详情抽屉
 *
 * 依据：PRD §5.3（资产详情四个页签：内容 / 元数据 / 索引 / 历史）、
 *      §9.1（资产可用性与单资产索引状态分开表达）、
 *      §10.2（当前 v2 / 索引 v1 的版本对照）、§11.2（附件是否随演示包提供）。
 *
 * 一条硬规则：**没有真实附件时不出现可点击的下载按钮**，只给文字说明。
 * 界面上凡是「旧版继续服务」「待补充内容」这类状态，都写清楚而不是统一写「失败」。
 */

import { useState } from "react";
import { Btn, StateBlock } from "../../ui";
import type { AssetDetail, Chunk } from "../types";
import { describeLocatorText, locatorKindLabel } from "./locator";
import { attachmentState, availabilityTone, formatBytes, formatCount, formatMoment, indexStateTone } from "../selectors";
import { KbCollapse, KbDrawer, KbEmpty, KbKV, KbState } from "./KnowledgeUi";
import type { KnowledgeApiActions } from "./api-actions";

type DetailTab = "content" | "metadata" | "index" | "history";

const TABS: { key: DetailTab; label: string }[] = [
  { key: "content", label: "内容" },
  { key: "metadata", label: "元数据" },
  { key: "index", label: "索引" },
  { key: "history", label: "历史" },
];

export function AssetDrawer({
  open,
  detail,
  loading,
  error,
  onClose,
  actions,
  onOpenAsset,
}: {
  open: boolean;
  detail: AssetDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  actions: KnowledgeApiActions;
  onOpenAsset?: (assetId: string) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("content");
  if (!open) return null;
  const asset = detail?.asset ?? null;

  return (
    <KbDrawer
      open={open}
      wide
      title={asset ? asset.title : "资产详情"}
      subtitle={
        asset ? (
          <span className="kb-drawer-sub">
            <code>{asset.id}</code>
            <KbState text={asset.indexState} tone={indexStateTone(asset.indexState)} />
            <KbState text={asset.availability} tone={availabilityTone(asset.availability)} />
          </span>
        ) : null
      }
      onClose={onClose}
      footer={
        asset ? (
          <div className="kb-drawer-actions">
            <Btn
              onClick={() => void actions.setInclusion(asset.id, asset.indexState === "未纳入")}
              disabled={!actions.canManage}>
              {asset.indexState === "未纳入" ? "纳入索引" : "移出索引"}
            </Btn>
            <Btn onClick={() => void actions.syncAsset(asset.id)} disabled={!actions.canIndex || asset.indexState === "未纳入"}>
              更新此项索引
            </Btn>
            <Btn
              tone="danger"
              onClick={() => void actions.remove(asset.id).then((ok) => ok && onClose())}
              disabled={!actions.canManage}>
              删除资产
            </Btn>
          </div>
        ) : null
      }>
      {loading ? <StateBlock kind="loading" title="正在读取资产" hint="包含内容、版本与索引状态。" /> : null}
      {error ? <StateBlock kind="error" title="读取失败" hint={error} /> : null}
      {!loading && !error && detail && asset ? (
        <>
          <nav className="kb-drawer-tabs" aria-label="资产详情页签">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`kb-tab ${tab === item.key ? "is-active" : ""}`}
                onClick={() => setTab(item.key)}>
                {item.label}
              </button>
            ))}
          </nav>

          {tab === "content" ? <ContentTab detail={detail} actions={actions} /> : null}
          {tab === "metadata" ? <MetadataTab detail={detail} /> : null}
          {tab === "index" ? <IndexTab detail={detail} /> : null}
          {tab === "history" ? <HistoryTab detail={detail} onOpenAsset={onOpenAsset} /> : null}
        </>
      ) : null}
    </KbDrawer>
  );
}

/* ------------------------------------------------------------------ *
 * 内容
 * ------------------------------------------------------------------ */

function ContentTab({ detail, actions }: { detail: AssetDetail; actions: KnowledgeApiActions }) {
  const { asset, content, file, chunks } = detail;
  const attachment = attachmentState(asset);
  return (
    <div className="kb-detail-section">
      <div className="kb-detail-row">
        <span className="kb-detail-label">原始资料</span>
        <div>
          {attachment.downloadable && asset.fileId ? (
            <Btn onClick={() => void actions.download(asset.fileId as string, asset.title)}>下载原始文件</Btn>
          ) : (
            <em className="kb-detail-note">{attachment.note}</em>
          )}
          {content ? <em className="kb-detail-note"> · 提取方式 {content.extractionMode === "fixture" ? "内置资料" : content.extractionMode === "uploaded" ? "导入文本" : content.extractionMode}</em> : null}
        </div>
      </div>

      {content ? (
        <>
          <div className="kb-detail-row">
            <span className="kb-detail-label">来源定位</span>
            <em className="kb-detail-note">
              {locatorKindLabel(content.locatorKind)} · 共 {formatCount(content.chars)} 字 · 版本 v{content.revision}
            </em>
          </div>
          <pre className="kb-content-preview">{content.preview || "（无文本）"}</pre>
        </>
      ) : (
        <KbEmpty
          title="待补充内容"
          hint="这份资料还没有可检索文本，导入描述或提取文本后才会进入索引。"
          action={actions.canManage ? <Btn onClick={() => void actions.syncAsset(asset.id)}>提交索引处理</Btn> : undefined}
        />
      )}

      {chunks.length ? (
        <KbCollapse summary={`分块与来源定位（${chunks.length} 个）`}>
          <ChunkList chunks={chunks.slice(0, 40)} />
        </KbCollapse>
      ) : null}

      {!file.provided ? <p className="kb-detail-footnote">{file.note}</p> : null}
      {asset.excludedReason ? <p className="kb-detail-footnote">未纳入原因：{asset.excludedReason}</p> : null}
    </div>
  );
}

function ChunkList({ chunks }: { chunks: Chunk[] }) {
  return (
    <ol className="kb-chunk-list">
      {chunks.map((chunk) => (
        <li key={chunk.id}>
          <div className="kb-chunk-head">
            <code>C-{String(chunk.ordinal + 1).padStart(3, "0")}</code>
            <span>{describeLocatorText(chunk.locator)}</span>
            <em>{formatCount(chunk.charCount)} 字</em>
          </div>
          <p>{chunk.text}</p>
          <div className="kb-chunk-meta">
            <span>摘要 {chunk.digest}</span>
            <span>{chunk.vectorId ? `向量条目 ${chunk.vectorId}` : "无向量条目"}</span>
            {chunk.adapterMode ? <span>模式 {chunk.adapterMode}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ *
 * 元数据
 * ------------------------------------------------------------------ */

function MetadataTab({ detail }: { detail: AssetDetail }) {
  const { asset } = detail;
  return (
    <div className="kb-detail-section">
      <KbKV
        items={[
          { k: "资产编号", v: <code>{asset.id}</code> },
          { k: "原始文件名", v: <code>{asset.filename ?? "未登记"}</code> },
          { k: "资产类型", v: asset.type },
          { k: "文件格式", v: asset.format },
          { k: "业务分类", v: asset.businessCategories.join("、") || "—" },
          { k: "数据来源", v: `${asset.mainSource}（${asset.sourceSystem}）` },
          { k: "来源编号", v: <code>{asset.sourceEntityId}</code> },
          { k: "关联对象", v: asset.objectIds.join("、") || "—" },
          { k: "所属建筑 / 区域", v: [asset.buildingId, asset.zone].filter(Boolean).join(" ") || "—" },
          { k: "文件大小", v: formatBytes(asset.sizeBytes) },
          { k: "内容版本", v: `v${asset.contentRevision}` },
          { k: "元数据版本", v: `m${asset.metadataRevision}` },
          { k: "采集时间", v: formatMoment(asset.capturedAt) },
          { k: "导入时间", v: formatMoment(asset.importedAt) },
          { k: "版本更新时间", v: formatMoment(asset.updatedAt) },
          { k: "负责人", v: asset.owner ?? "—" },
          { k: "文件摘要", v: asset.sha256 ? <code>{asset.sha256.slice(0, 16)}…</code> : "—" },
        ]}
      />
      <div className="kb-detail-row">
        <span className="kb-detail-label">摘要</span>
        <p className="kb-detail-text">{asset.summary || "—"}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 索引
 * ------------------------------------------------------------------ */

function IndexTab({ detail }: { detail: AssetDetail }) {
  const { asset, index, chunks, jobItems } = detail;
  return (
    <div className="kb-detail-section">
      <KbKV
        items={[
          { k: "当前服务版本", v: <code>{index.servingVersion ?? "未就绪"}</code> },
          { k: "资产当前版本", v: `v${index.currentRevision}` },
          { k: "已索引版本", v: index.indexedRevision === null ? "尚未进入索引" : `v${index.indexedRevision}` },
          { k: "分块数", v: `${formatCount(index.chunkCount)} 个` },
          { k: "向量条目", v: `${formatCount(index.vectorCount)} 条` },
          { k: "分块配置版本", v: <code>{index.configRevision ?? "—"}</code> },
          { k: "配置维度", v: index.dimensionConfig ? `${index.dimensionConfig}（浏览器本地索引）` : "—" },
          { k: "索引状态", v: <KbState text={asset.indexState} tone={indexStateTone(asset.indexState)} /> },
        ]}
      />
      {index.note ? <p className="kb-detail-note kb-detail-note--warn">{index.note}</p> : null}

      {jobItems.length ? (
        <KbCollapse summary={`任务结果（最近 ${jobItems.length} 条）`}>
          <ul className="kb-job-item-list">
            {jobItems.map((item) => (
              <li key={`${item.jobId}-${item.updatedAt}`}>
                <code>{item.jobId}</code>
                <span>{item.stage}</span>
                <KbState text={item.status} tone={item.status === "成功" ? "ok" : item.status === "失败" ? "danger" : "info"} />
                {item.errorCode ? <em>{item.errorCode}</em> : null}
                <span className="kb-muted">{item.message}</span>
              </li>
            ))}
          </ul>
        </KbCollapse>
      ) : (
        <p className="kb-detail-footnote">这份资产还没有参与过索引构建。</p>
      )}

      {chunks.length ? (
        <KbCollapse summary={`当前版本分块（${chunks.length} 个）`}>
          <ChunkList chunks={chunks.slice(0, 40)} />
        </KbCollapse>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 历史
 * ------------------------------------------------------------------ */

function HistoryTab({ detail, onOpenAsset }: { detail: AssetDetail; onOpenAsset?: (assetId: string) => void }) {
  const { revisions, relations } = detail;
  return (
    <div className="kb-detail-section">
      <h3 className="kb-detail-h3">版本记录</h3>
      <ol className="kb-timeline">
        {revisions.map((row) => (
          <li key={row.revision}>
            <div className="kb-timeline-head">
              <strong>v{row.revision}</strong>
              <span>{row.label || row.kind}</span>
              <em>{formatMoment(row.createdAt)}</em>
            </div>
            <p className="kb-muted">
              {row.contentMode} · {row.createdBy ?? "—"}
              {row.contentHash ? ` · 摘要 ${row.contentHash.slice(0, 12)}…` : ""}
            </p>
          </li>
        ))}
      </ol>

      <h3 className="kb-detail-h3">关联关系</h3>
      {relations.length ? (
        <ul className="kb-relation-list">
          {relations.map((relation) => (
            <li key={relation.id}>
              <span className="kb-relation-type">{relation.relationType}</span>
              <button type="button" className="kb-link" onClick={() => onOpenAsset?.(relation.fromId === detail.asset.id ? relation.toId : relation.fromId)}>
                {relation.title}
              </button>
              <em className="kb-muted">{relation.evidenceRef}</em>
              <span className="kb-relation-origin">{relation.origin}</span>
            </li>
          ))}
        </ul>
      ) : (
        <KbEmpty title="暂无关联关系" hint="这份资料还没有登记关联对象。" />
      )}
    </div>
  );
}
