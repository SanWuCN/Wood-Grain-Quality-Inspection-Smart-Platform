/**
 * 数据与知识中心 · 数据资产页签
 *
 * 依据：PRD §5.3（分类侧栏 184px + 资产表格自适应；默认列不超过 9 个；高级筛选折叠）、
 *      §7.3（时间字段与范围口径）。
 *
 * 空状态分两种：首次没有资产给「导入资料」，筛选后没有结果给「清除筛选」（PRD §5.3）。
 */

import { useState } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Btn, StateBlock } from "../../ui";
import type { AssetFilters, AssetTypeKey, AssetPage, Overview } from "../types";
import { attachmentState, formatBytes, formatMoment, indexStateTone, sampledHint } from "../selectors";
import { KbEmpty, KbPanel, KbState } from "../components/KnowledgeUi";
import type { KnowledgeApiActions } from "../components/api-actions";

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
const SOURCES = ["人工导入", "平台业务", "巡检设备", "历史归档"];
const CATEGORIES = ["巡检报告", "构件档案", "维修记录", "设备运行", "规范方法", "历史归档", "修缮工艺", "政策法规", "保护规划"];
const STATES: { key: string; label: string }[] = [
  { key: "已覆盖", label: "已覆盖" },
  { key: "待更新", label: "待更新" },
  { key: "处理中", label: "处理中" },
  { key: "更新失败", label: "更新失败" },
  { key: "未纳入", label: "未纳入" },
];

export function AssetsView({
  page,
  filters,
  onFilters,
  onLoadMore,
  loading,
  error,
  actions,
  overview,
  onOpenAsset,
  onImport,
}: {
  page: AssetPage | null;
  filters: AssetFilters;
  onFilters: (filters: AssetFilters) => void;
  /** 加载下一页（游标分页）：与筛选变化分开，避免把「翻页」写成「改筛选」 */
  onLoadMore: () => void;
  loading: boolean;
  error: string | null;
  actions: KnowledgeApiActions;
  overview: Overview | null;
  onOpenAsset: (assetId: string) => void;
  onImport: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(false);

  const byType = new Map((overview?.coverage ?? []).map((row) => [row.type, row]));
  const hasFilters = Boolean(
    filters.type || filters.query || filters.indexState || filters.source || filters.category || filters.objectId || filters.timeFrom || filters.timeTo,
  );
  const items = page?.items ?? [];

  const toggle = (assetId: string) =>
    setSelected((current) => (current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]));

  return (
    <div className="kb-assets-view">
      <aside className="kb-sidebar" aria-label="资产分类">
        <button
          type="button"
          className={`kb-side-link ${!filters.type ? "is-active" : ""}`}
          onClick={() => onFilters({ ...filters, type: null, cursor: null })}>
          <span>全部资产</span>
          <strong>
            <NumberAnimation value={overview?.metrics.total ?? 0} />
          </strong>
        </button>
        {TYPE_ORDER.map((key) => {
          const row = byType.get(key);
          return (
            <button
              key={key}
              type="button"
              className={`kb-side-link ${filters.type === key ? "is-active" : ""}`}
              title={row?.scaleNote ?? undefined}
              onClick={() => onFilters({ ...filters, type: key, cursor: null })}>
              <span>{row?.label ?? key}</span>
              <strong>
                <NumberAnimation value={row?.total ?? 0} />
              </strong>
            </button>
          );
        })}
        <div className="kb-side-note kb-muted">
          <span>
            可展开明细 <NumberAnimation value={overview?.metrics.materialized ?? 0} />
          </span>
          <span>
            纳入索引 <NumberAnimation value={overview?.metrics.included ?? 0} />
          </span>
          <span>
            未纳入 <NumberAnimation value={overview?.metrics.excluded ?? 0} />
          </span>
        </div>
      </aside>

      <KbPanel
        title="资产列表"
        className="kb-assets-list"
        note={
          <span className="kb-muted" title="规模样本只参与统计，不提供逐条明细">
            {/* sampledHint() 返回纯字符串（含两个数量），装不下带动画的 span，保持原样；
                「已选 N 项」是本页自己的勾选计数，原来是裸插值（无千分位）→ group={false} */}
            {page ? sampledHint(page.total, page.materialized) : "—"} · 已选 <NumberAnimation value={selected.length} group={false} /> 项
          </span>
        }
        actions={
          <div className="kb-toolbar">
            <input
              className="kb-input"
              placeholder="关键词 / 编号"
              value={filters.query ?? ""}
              onChange={(event) => onFilters({ ...filters, query: event.target.value, cursor: null })}
            />
            <select
              className="kb-select"
              value={filters.indexState ?? ""}
              onChange={(event) => onFilters({ ...filters, indexState: (event.target.value || null) as AssetFilters["indexState"], cursor: null })}>
              <option value="">全部索引状态</option>
              {STATES.map((state) => (
                <option key={state.key} value={state.key}>
                  {state.label}
                </option>
              ))}
            </select>
            <select
              className="kb-select"
              value={filters.source ?? ""}
              onChange={(event) => onFilters({ ...filters, source: event.target.value || null, cursor: null })}>
              <option value="">全部来源</option>
              {SOURCES.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
            <input
              className="kb-input kb-input--tiny"
              placeholder="关联对象"
              value={filters.objectId ?? ""}
              onChange={(event) => onFilters({ ...filters, objectId: event.target.value || null, cursor: null })}
            />
            <button type="button" className="kb-link" onClick={() => setAdvanced((value) => !value)}>
              {advanced ? "收起高级筛选" : "高级筛选"}
            </button>
          </div>
        }>
        {advanced ? (
          <div className="kb-filters kb-filters--advanced">
            <label className="kb-field">
              <span>业务分类</span>
              <select
                className="kb-select"
                value={filters.category ?? ""}
                onChange={(event) => onFilters({ ...filters, category: event.target.value || null, cursor: null })}>
                <option value="">全部业务分类</option>
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label className="kb-field">
              <span>数据来源</span>
              <select
                className="kb-select"
                value={filters.source ?? ""}
                onChange={(event) => onFilters({ ...filters, source: event.target.value || null, cursor: null })}>
                <option value="">全部来源</option>
                {SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
            </label>
            <label className="kb-field">
              <span>版本更新时间起</span>
              <input
                type="date"
                className="kb-input"
                value={filters.timeFrom ?? ""}
                onChange={(event) => onFilters({ ...filters, timeFrom: event.target.value || null, cursor: null })}
              />
            </label>
            <label className="kb-field">
              <span>止</span>
              <input
                type="date"
                className="kb-input"
                value={filters.timeTo ?? ""}
                onChange={(event) => onFilters({ ...filters, timeTo: event.target.value || null, cursor: null })}
              />
            </label>
            <Btn onClick={() => onFilters({ limit: 50 })}>清除筛选</Btn>
          </div>
        ) : null}

        {filters.category || filters.source ? (
          <div className="kb-filter-chips">
            {filters.category ? (
              <button type="button" className="kb-chip kb-chip--active" onClick={() => onFilters({ ...filters, category: null })}>
                业务分类 · {filters.category} ✕
              </button>
            ) : null}
            {filters.source ? (
              <button type="button" className="kb-chip kb-chip--active" onClick={() => onFilters({ ...filters, source: null })}>
                来源 · {filters.source} ✕
              </button>
            ) : null}
          </div>
        ) : null}

        {selected.length ? (
          <div className="kb-bulkbar">
            <span>已选 <NumberAnimation value={selected.length} group={false} /> 项</span>
            <Btn
              onClick={() => void actions.sync({ scope: "changed", assetIds: selected, triggerSource: "批量更新" })}
              disabled={!actions.canIndex || actions.busy}>
              更新所选索引
            </Btn>
            <Btn onClick={() => setSelected([])}>取消选择</Btn>
          </div>
        ) : null}

        {error ? <StateBlock kind="error" title="读取失败" hint={error} /> : null}
        {loading && !items.length ? <StateBlock kind="loading" title="正在读取资产" hint="按版本更新时间倒序。" /> : null}

        {!loading && !items.length && !error ? (
          hasFilters ? (
            <KbEmpty
              title="暂无匹配资产"
              hint="当前筛选条件下没有资料。"
              action={<Btn onClick={() => onFilters({ limit: 50 })}>清除筛选</Btn>}
            />
          ) : (
            <KbEmpty
              title="还没有导入资料"
              hint="导入后会按内容就绪情况进入更新队列。"
              action={
                <Btn tone="primary" onClick={onImport} disabled={!actions.canManage}>
                  导入资料
                </Btn>
              }
            />
          )
        ) : null}

        {/*
          规模样本比明细多得多时的说明。这一条必须显式出现：用户按「扫描数据」筛选，
          看到「共 24,300 项」却只有两页列表，不解释就会以为是漏数据或分页坏了。
        */}
        {page && page.total > page.materialized && items.length ? (
          <p className="kb-detail-footnote">
            该范围内另有 <NumberAnimation value={page.total - page.materialized} /> 项规模样本（历史归档的同类资料），
            它们只参与统计，不逐条列出；在「数据说明」抽屉里可以看到每一类的规模与排除原因。
          </p>
        ) : null}

        {items.length ? (
          <div className="kb-table-wrap kb-table-wrap--scroll">
            <table className="kb-table">
              <thead>
                <tr>
                  <th className="is-check">
                    <input
                      type="checkbox"
                      aria-label="全选当前页"
                      checked={selected.length > 0 && selected.length === items.length}
                      onChange={(event) => setSelected(event.target.checked ? items.map((item) => item.id) : [])}
                    />
                  </th>
                  <th>名称</th>
                  <th>类型</th>
                  <th>关联对象</th>
                  <th>来源</th>
                  <th className="is-num">更新时间</th>
                  <th>当前版本</th>
                  <th>索引状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((asset) => {
                  const attachment = attachmentState(asset);
                  return (
                    <tr key={asset.id} className={selected.includes(asset.id) ? "is-selected" : ""}>
                      <td className="is-check">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${asset.title}`}
                          checked={selected.includes(asset.id)}
                          onChange={() => toggle(asset.id)}
                        />
                      </td>
                      <td>
                        <button type="button" className="kb-link kb-link--strong" onClick={() => onOpenAsset(asset.id)}>
                          {asset.title}
                        </button>
                        <span className="kb-cell-sub kb-muted">
                          {asset.filename ?? asset.id} · {formatBytes(asset.sizeBytes)}
                          {attachment.downloadable ? " · 可下载" : " · 无原始附件"}
                        </span>
                      </td>
                      <td>{asset.format}</td>
                      <td>{asset.primaryObjectId ?? "—"}</td>
                      <td>{asset.mainSource}</td>
                      <td className="is-num">{formatMoment(asset.updatedAt)}</td>
                      <td>
                        v{asset.contentRevision}
                        {asset.indexedRevision !== null && asset.indexedRevision !== asset.contentRevision ? (
                          <span className="kb-cell-sub kb-muted">索引 v{asset.indexedRevision}</span>
                        ) : null}
                      </td>
                      <td>
                        <KbState
                          text={asset.indexState}
                          tone={indexStateTone(asset.indexState)}
                          title={asset.excludedReason ?? undefined}
                        />
                      </td>
                      <td>
                        <button type="button" className="kb-link" onClick={() => onOpenAsset(asset.id)}>
                          详情
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {page?.hasMore ? (
              <div className="kb-more">
                <Btn onClick={onLoadMore} disabled={loading}>
                  {/*
                    按钮文案原本是模板串（含两个数量）。`.btn` 是 inline-flex + 8px gap，
                    拆成多个节点会变成多个 flex 项、每段之间多出 8px 间隙 ——
                    所以整句包进一个 span，保持「一个 flex 项 + 行内文本流」，数字在 span 内滚。
                    已显示条数原来是裸插值（无千分位）→ group={false}；总数原来走 formatCount（有千分位）→ 默认。
                  */}
                  {loading ? (
                    "正在加载…"
                  ) : (
                    <span>
                      加载更多（已显示 <NumberAnimation value={items.length} group={false} /> / <NumberAnimation value={page.total} />）
                    </span>
                  )}
                </Btn>
              </div>
            ) : null}
          </div>
        ) : null}
      </KbPanel>
    </div>
  );
}
