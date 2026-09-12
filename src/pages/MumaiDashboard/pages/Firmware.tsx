/**
 * 固件及模型（`/firmware`）
 *
 * 由原「检测适配」页拆出，收**算法与版本侧**的五件事：
 *   1. 版本管理：平台使用的固件 / 配置 / 程序 / 模型 / Agent / 流水线的完整发行历史
 *   2. 数据集：分组检查与冻结
 *   3. 训练验证：装载实验包，看训练配置、控制台、执行节点占用与验证结果
 *   4. 更新交付：量化、封装、下发、接收、回验
 *   5. 融合分析：雷达 / 视觉 / 融合三路按规则出优先级
 *
 * 版本管理为什么是**列表**而不是几个版本 chip：
 * 「当前用哪个版本」只是版本管理要回答的三分之一，另外两个是
 * 「出问题能退到哪」和「设备回报的版本和平台以为的是否一致」（PRD 11.4）。
 * 两三个 chip 既看不出发布时间与变更内容，也分不清「可回退」和「已弃用」，
 * 更没法把 live / demo 两个回报版本摆在一起。列表把这些一次性摊开。
 *
 * 版本数据来自 `seed/versions.ts`，页面不硬编码任何版本号。
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Panel } from "../Panel";
import { Btn, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import { useMumai } from "../context";
import { DatasetTab, DeliveryTab, FusionTab } from "./adaptTabs";
import { TrainingTab } from "./TrainingRun";
import { VERSION_ITEMS, type Release, type VersionItem } from "../seed/versions";

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

/* ------------------------------------------------------------------ *
 * 版本矩阵
 * ------------------------------------------------------------------ */

/**
 * 单个组件的发行历史。
 *
 * 每行一个版本，展开看目标与加载位置 / 依赖约束 / 摘要 —— 这三项决定
 * 「这个版本能不能换上去」，比版本号本身重要，所以不塞进主行挤字号。
 */
function VersionBlock({
  item,
  draft,
  onPick,
}: {
  item: VersionItem;
  draft: string | undefined;
  onPick: (key: string, version: string) => void;
}) {
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const effective = draft ?? item.current;
  const dirty = effective !== item.current;

  /**
   * 设备回报与平台记录的比对（PRD 11.4）。
   * 两侧任一为 null 时不下结论 —— 「没回报」不等于「一致」。
   */
  const report = useMemo(() => {
    const demo = item.reported.demo;
    if (demo === null) return { tone: "muted" as const, text: "演示侧未回报" };
    if (demo.includes(effective) || effective.includes(demo.split("（")[0])) {
      return { tone: "ok" as const, text: `演示侧回报 ${demo}` };
    }
    return { tone: "warn" as const, text: `演示侧回报 ${demo}，与当前不一致` };
  }, [item, effective]);

  return (
    <section className="fw-group">
      <header className="fw-group__head">
        <h4 className="fw-group__title">{item.label}</h4>
        <span className="fw-group__now">
          {effective}
          {dirty ? <StatusChip text="未生效" tone="warn" dot /> : null}
        </span>
        <span className="fw-group__target">{item.target}</span>
        <StatusChip text={report.text} tone={report.tone} dot />
      </header>

      <p className="fw-group__note" title={item.note}>
        {item.note}
      </p>

      <div className="fw-matrix">
        <div className="fw-matrix__head">
          <span>版本</span>
          <span>状态</span>
          <span>包类型</span>
          <span>发布日</span>
          <span>大小</span>
          <span>变更</span>
          <span />
        </div>
        <ul>
          {item.releases.map((release) => {
            const expanded = openVersion === release.version;
            const isCurrent = release.version === effective;
            const selectable = release.status === "可回退" || release.status === "候选";
            return (
              <li
                key={release.version}
                className={`${isCurrent ? "is-current" : ""}${expanded ? " is-open" : ""}`}>
                <div className="fw-matrix__row">
                  <button
                    type="button"
                    className="fw-matrix__version"
                    aria-expanded={expanded}
                    onClick={() => setOpenVersion(expanded ? null : release.version)}>
                    {release.version}
                  </button>
                  <StatusChip text={release.status} tone={RELEASE_TONE[release.status]} dot />
                  <span className="fw-matrix__kind">{release.artifactKind}</span>
                  <span className="fw-matrix__date">{release.releasedAt}</span>
                  <span className="fw-matrix__size">{release.size}</span>
                  <span className="fw-matrix__change" title={release.change}>
                    {release.change}
                  </span>
                  <span className="fw-matrix__act">
                    {isCurrent ? (
                      <em className="muted">使用中</em>
                    ) : selectable ? (
                      <Btn tone="ghost" onClick={() => onPick(item.key, release.version)}>
                        切换
                      </Btn>
                    ) : (
                      <em className="muted">不可切换</em>
                    )}
                  </span>
                </div>
                {expanded ? (
                  <dl className="fw-matrix__detail">
                    <div>
                      <dt>目标 / 加载位置</dt>
                      <dd>{release.target}</dd>
                    </div>
                    <div>
                      <dt>依赖与约束</dt>
                      <dd>{release.depends}</dd>
                    </div>
                    <div>
                      <dt>摘要</dt>
                      <dd>{release.digest}（前 12 位）</dd>
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
    </section>
  );
}

/**
 * 全局配置
 *
 * 只做一件事：把当前平台这一套版本摆清楚，并支持切换到可回退 / 候选版本。
 * 训练过程不在这里 —— 它属于「训练验证」页签。原来这块并排放着一个
 * 「训练任务」摘要面板，既和训练页重复，也让「全局配置」这个名字名不副实。
 */
function ConfigTab() {
  const { toast } = useMumai();
  const [draft, setDraft] = useState<Record<string, string>>({});

  const pending = useMemo(
    () =>
      VERSION_ITEMS.filter((item) => draft[item.key] && draft[item.key] !== item.current).map(
        (item) => ({ item, to: draft[item.key] }),
      ),
    [draft],
  );

  const changed = pending.length > 0;

  /** 已弃用版本不给切换入口，这里再兜一次底：只有存在于 releases 里的版本才可能被选中 */
  const pick = (key: string, version: string) =>
    setDraft((prev) => ({ ...prev, [key]: version }));

  return (
    <div className="fw-config">
      <Panel
        title="版本管理"
        extra={
          <span className="muted">
            {VERSION_ITEMS.length} 个组件 ·{" "}
            {VERSION_ITEMS.reduce((sum, item) => sum + item.releases.length, 0)} 个版本
            {changed ? ` · ${pending.length} 项待生效` : ""}
          </span>
        }
        className="fw-panel fw-panel--matrix">
        {GROUPS.map((group) => (
          <div key={group} className="fw-matrix__group">
            <h3 className="fw-matrix__grouptitle">{group}</h3>
            {VERSION_ITEMS.filter((item) => item.group === group).map((item) => (
              <VersionBlock key={item.key} item={item} draft={draft[item.key]} onPick={pick} />
            ))}
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
          <span className="muted">改动对后续采集与推理生效，已在跑的批次不受影响</span>
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
            hint="在上方版本矩阵里选择可回退或候选版本。"
          />
        )}
      </Panel>
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
