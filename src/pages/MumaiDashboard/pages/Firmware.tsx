/**
 * 固件及模型（`/firmware`）
 *
 * 由原「检测适配」页拆出，收**算法与版本侧**的五件事：
 *   1. 版本管理：平台使用的固件 / 配置 / 程序 / 模型 / Agent / 流水线 / 平台的发行历史
 *   2. 数据集：分组检查与冻结
 *   3. 训练验证：装载实验包，看训练配置、控制台、执行节点占用与验证结果
 *   4. 更新交付：量化、封装、下发、接收、回验
 *   5. 融合分析：雷达 / 视觉 / 融合三路按规则出优先级
 *
 * 版本管理为什么做成**两级**（摘要表 + 详情弹窗）：
 * 八个组件加起来七十多条发行记录，全部平铺在一页上，要看到最后那个组件
 * （平台版本）得往下滑很久；而日常要看的信息只有「现在跑的是哪个、
 * 有几个版本可退、设备回报对不对得上」。所以主页只留组件摘要，
 * 点进去才铺开完整历史 —— 列表负责扫，弹窗负责看全和操作。
 *
 * 页面上**不写「这个组件负责什么」这类解释文字**。版本表要陈述的是
 * 「哪个版本、什么时候发的、改了什么、依赖什么」，不是给读者介绍固件。
 * 约束信息放在结构化的「依赖与约束」字段里（如 `CFG-02 及以上`），
 * 不写成句子。
 *
 * 版本数据来自 `seed/versions.ts`，页面不硬编码任何版本号。
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Panel } from "../Panel";
import { Btn, Modal, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import { useMumai } from "../context";
import { DatasetTab, DeliveryTab, FusionTab } from "./adaptTabs";
import { TrainingTab } from "./TrainingRun";
import {
  VERSION_ITEMS,
  VERSION_RELEASE_COUNT,
  type Release,
  type VersionItem,
} from "../seed/versions";

const TABS = [
  { key: "config", label: "全局配置" },
  { key: "dataset", label: "数据集" },
  { key: "training", label: "训练验证" },
  { key: "delivery", label: "更新交付" },
  { key: "fusion", label: "融合分析" },
] as const;

const GROUPS: VersionItem["group"][] = ["硬件", "算法", "平台"];

/** 发行状态 → 语义色。只表达「现在能不能用」，不表达新旧 */
const RELEASE_TONE: Record<Release["status"], "ok" | "info" | "warn" | "muted"> = {
  当前生效: "ok",
  可回退: "info",
  候选: "warn",
  已弃用: "muted",
};

/** 摘要表里每行显示的最新发布日期 = 发行历史第一条 */
const latestOf = (item: VersionItem) => item.releases[0];

/**
 * 设备回报比对（PRD 11.4）。
 *
 * 两侧任一为 null 时不下结论 —— 「没回报」不等于「一致」。
 * 回报值里常带括号说明（如「FW-1.4.2（实机未变）」），比对时只取版本号部分。
 *
 * 文案用 ✓ / ≠ 前缀而不是「已回报 / 回报…≠…」整句：这一列只有 176px，
 * 整句会被折成两行，而一致与否本来就是这个前缀加颜色要说的事。
 * 完整说明放在 title 里，需要时悬停看。
 */
function reportState(item: VersionItem, effective: string) {
  const demo = item.reported.demo;
  if (demo === null) {
    return { tone: "muted" as const, text: "未回报", title: "演示侧尚未回报版本" };
  }
  const bare = demo.split("（")[0];
  const matched = demo.includes(effective) || effective.includes(bare);
  return matched
    ? { tone: "ok" as const, text: `✓ ${bare}`, title: `设备回报 ${bare}，与当前一致` }
    : {
        tone: "warn" as const,
        text: `≠ ${bare}`,
        title: `设备回报 ${bare}，与当前 ${effective} 不一致`,
      };
}

/* ------------------------------------------------------------------ *
 * 一级：组件摘要表
 * ------------------------------------------------------------------ */

function ComponentRow({
  item,
  draft,
  onOpen,
}: {
  item: VersionItem;
  draft: string | undefined;
  onOpen: () => void;
}) {
  const effective = draft ?? item.current;
  const dirty = effective !== item.current;
  const report = reportState(item, effective);
  const latest = latestOf(item);
  const rollback = item.releases.filter((release) => release.status === "可回退").length;

  return (
    <li className={dirty ? "is-dirty" : ""}>
      <button type="button" onClick={onOpen}>
        <span className="vm-list__name">
          <b>{item.label}</b>
          <i>{item.target}</i>
        </span>

        <span className="vm-list__now">
          {effective}
          {dirty ? <StatusChip text="待生效" tone="warn" /> : null}
        </span>

        <span className="vm-list__meta">
          {latest.artifactKind} · {latest.size}
        </span>

        <span className="vm-list__date">{latest.releasedAt}</span>

        <span className="vm-list__count">
          {item.releases.length} 个
          {rollback > 0 ? <i>可退 {rollback}</i> : null}
        </span>

        <span className="vm-list__report" title={report.title}>
          <StatusChip text={report.text} tone={report.tone} dot />
        </span>

        <span className="vm-list__act">查看</span>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * 二级：版本历史弹窗
 * ------------------------------------------------------------------ */

function VersionModal({
  item,
  draft,
  onPick,
  onClose,
}: {
  item: VersionItem;
  draft: string | undefined;
  onPick: (version: string) => void;
  onClose: () => void;
}) {
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const effective = draft ?? item.current;
  const report = reportState(item, effective);

  return (
    <Modal
      wide
      title={item.label}
      subtitle={
        <>
          <span>{item.target}</span>
          <span>·</span>
          <span>{item.releases.length} 个版本</span>
          <StatusChip text={report.text} tone={report.tone} dot />
        </>
      }
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {draft && draft !== item.current
              ? `已选 ${draft}，关闭后在「待生效改动」里统一应用`
              : "选择可回退或候选版本后统一应用"}
          </span>
          <Btn onClick={onClose}>关闭</Btn>
        </>
      }>
      <div className="vm-table">
        <div className="vm-table__head">
          <span>版本</span>
          <span>状态</span>
          <span>包类型</span>
          <span>构建时间</span>
          <span>大小</span>
          <span>变更</span>
          <span />
        </div>
        <ul>
          {item.releases.map((release) => {
            const expanded = openVersion === release.version;
            const isCurrent = release.version === effective;
            const selectable = item.switchable && release.status !== "已弃用";
            return (
              <li
                key={release.version}
                className={`${isCurrent ? "is-current" : ""}${expanded ? " is-open" : ""}`}>
                <div className="vm-table__row">
                  <button
                    type="button"
                    className="vm-table__version"
                    aria-expanded={expanded}
                    onClick={() => setOpenVersion(expanded ? null : release.version)}>
                    {release.version}
                  </button>
                  <StatusChip text={release.status} tone={RELEASE_TONE[release.status]} dot />
                  <span className="vm-table__kind">{release.artifactKind}</span>
                  <span className="vm-table__date">{release.releasedAt}</span>
                  <span className="vm-table__size">{release.size}</span>
                  <span className="vm-table__change" title={release.change}>
                    {release.change}
                  </span>
                  <span className="vm-table__act">
                    {isCurrent ? (
                      <em className="muted">使用中</em>
                    ) : selectable ? (
                      <Btn tone="ghost" onClick={() => onPick(release.version)}>
                        切换
                      </Btn>
                    ) : (
                      <em className="muted">—</em>
                    )}
                  </span>
                </div>
                {expanded ? (
                  <dl className="vm-table__detail">
                    <div>
                      <dt>依赖与约束</dt>
                      <dd>{release.depends || "无"}</dd>
                    </div>
                    <div>
                      <dt>加载位置</dt>
                      <dd>{release.target ?? item.target}</dd>
                    </div>
                    <div>
                      <dt>摘要</dt>
                      <dd>{release.digest}</dd>
                    </div>
                    <div>
                      <dt>变更说明</dt>
                      <dd>{release.change}</dd>
                    </div>
                  </dl>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 全局配置
 * ------------------------------------------------------------------ */

/**
 * 全局配置
 *
 * 只做一件事：把当前平台这一套版本摆清楚，并支持切换到可回退 / 候选版本。
 * 训练过程不在这里 —— 它属于「训练验证」页签。
 */
function ConfigTab() {
  const { toast } = useMumai();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);

  const open = VERSION_ITEMS.find((item) => item.key === openKey) ?? null;

  const pending = useMemo(
    () =>
      VERSION_ITEMS.filter((item) => draft[item.key] && draft[item.key] !== item.current).map(
        (item) => ({ item, to: draft[item.key] }),
      ),
    [draft],
  );

  const changed = pending.length > 0;

  return (
    <div className="fw-config">
      <Panel
        title="版本管理"
        extra={
          <span className="muted">
            {VERSION_ITEMS.length} 个组件 · {VERSION_RELEASE_COUNT} 个版本
            {changed ? ` · ${pending.length} 项待生效` : ""}
          </span>
        }
        className="fw-panel fw-panel--matrix">
        {GROUPS.map((group) => (
          <div key={group} className="vm-group">
            <h3 className="vm-group__title">{group}</h3>
            <div className="vm-list">
              <div className="vm-list__head">
                <span>组件</span>
                <span>当前版本</span>
                <span>包类型</span>
                <span>最近发布</span>
                <span>版本数</span>
                <span>设备回报</span>
                <span />
              </div>
              <ul>
                {VERSION_ITEMS.filter((item) => item.group === group).map((item) => (
                  <ComponentRow
                    key={item.key}
                    item={item}
                    draft={draft[item.key]}
                    onOpen={() => setOpenKey(item.key)}
                  />
                ))}
              </ul>
            </div>
          </div>
        ))}

        <div className="fw-actions">
          <Btn
            tone="primary"
            disabled={!changed}
            onClick={() => {
              toast(`已应用 ${pending.length} 项版本配置`, "ok");
              setDraft({});
            }}>
            应用
          </Btn>
          <Btn disabled={!changed} onClick={() => setDraft({})}>
            放弃改动
          </Btn>
          <span className="muted">改动在下一批采集与推理时生效</span>
        </div>
      </Panel>

      <Panel
        title="待生效改动"
        extra={changed ? <StatusChip text={`${pending.length} 项`} tone="warn" dot /> : undefined}
        className="fw-panel fw-panel--pending">
        {changed ? (
          <ul className="fw-pending">
            {pending.map(({ item, to }) => (
              <li key={item.key}>
                <b>{item.label}</b>
                <span className="fw-pending__from">{item.current}</span>
                <span className="fw-pending__arrow">→</span>
                <span className="fw-pending__to">{to}</span>
                <small>{item.target}</small>
              </li>
            ))}
          </ul>
        ) : (
          <StateBlock
            kind="empty"
            title="没有待生效改动"
            hint="在版本管理里点开组件，选择可回退或候选版本。"
          />
        )}
      </Panel>

      {open ? (
        <VersionModal
          item={open}
          draft={draft[open.key]}
          onPick={(version) => setDraft((prev) => ({ ...prev, [open.key]: version }))}
          onClose={() => setOpenKey(null)}
        />
      ) : null}
    </div>
  );
}

export default function Firmware() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? TABS[0].key;

  const setTab = (key: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    setParams(next, { replace: true });
  };

  /** 页面共用的来源标识：本页所有数据都是回放 / 模拟，PRD 1.2 要求常驻 */
  const sourceLabel = tab === "training" || tab === "delivery" ? "演示记录" : "演示回放";

  return (
    <div className="page page--adapt">
      <Toolbar
        note={
          <>
            <SourceTag label={sourceLabel} />
            <span>{VERSION_ITEMS.length} 个组件</span>
          </>
        }>
        {TABS.map((item) => (
          <Btn key={item.key} active={tab === item.key} onClick={() => setTab(item.key)}>
            {item.label}
          </Btn>
        ))}
      </Toolbar>

      <div className="adapt-body">
        {tab === "config" ? <ConfigTab /> : null}
        {tab === "dataset" ? <DatasetTab /> : null}
        {tab === "training" ? <TrainingTab /> : null}
        {tab === "delivery" ? <DeliveryTab /> : null}
        {tab === "fusion" ? <FusionTab /> : null}
      </div>
    </div>
  );
}
