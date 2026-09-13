/**
 * 大屏展示窗口（`/present`）
 *
 * PRD 2.2：大屏窗口单独具有 presentation 角色，通过「投到展示窗口」切换；
 * 四人浏览器各自导航，不因别人切页而被强制跳转。展示控制权有一个当前持有人。
 *
 * 评审 F13 的原文是「展示窗口始终是全国地图与统计卡，没有同步当前场景、曲线或
 * 训练页」，要求「投屏传递 viewType 和对象 ID，展示窗口渲染对应业务视图」。
 * 所以这里按 `focus.viewType` 分成七种视图：
 *
 *   map      全国地图（开场与总览）
 *   scene    数字孪生场景与选中测区
 *   capture  采集作业：测区进度、表面图、回波
 *   training 训练验证：损失曲线与新旧对比
 *   delivery 更新交付：本轮产物与回执
 *   report   报告归档：结论与附件完整性
 *   workspace 其余页面：把当前焦点（工单 / 构件 / 批次）讲清楚
 *
 * 字号按 v1.1 §3.3「展示窗口」：正文 18–24px 起，关键结果 28–40px 起，
 * 并隐藏操作控件与技术日志 —— 投屏是给人看的，不是给人点的。
 */

import { useMemo } from "react";
import { useDashboardStore, requestMapMode } from "../map/store";
import Map from "../mapDemo";
import { Icon } from "../icons";
import { StatusChip } from "../ui";
import { useMumai } from "../context";
import { holderLabel, usePresentFocus, usePresentOnline, VIEW_LABEL } from "../focus";
import {
  COMPONENTS,
  CURRENT_RISKS,
  ENV_RECORD,
  EXPERIMENT,
  HISTORY_STATS,
  ARCHIVE_ITEMS,
  SCAN_BATCHES,
  SCENES,
  WAVEFORMS,
  WORK_ORDER,
} from "../seed/scenario";
import { artifacts as artifactsOf, publishedScene, useSharedStore } from "../store/shared";

/* ------------------------------------------------------------------ *
 * 各视图
 * ------------------------------------------------------------------ */

function MapView() {
  const mode = useDashboardStore((state) => state.mode);
  return (
    <div className="present__map">
      <Map mode={mode} />
      <button
        type="button"
        className="present__switch"
        onClick={() => requestMapMode(mode === "china" ? "shanghai" : "china")}>
        {/* PRD §3.3：arrow 保留原图标；展示窗口按钮比操作界面大一档（PRD §4 工具栏 16–20px） */}
        <Icon name="arrow" size={20} aria-hidden />
        {mode === "china" ? "上海" : "全国"}
      </button>
    </div>
  );
}

function SceneView({ componentId, sceneId }: { componentId: string; sceneId: string | null }) {
  const sharedScene = useSharedStore(publishedScene);
  const local = SCENES.find((item) => item.id === (sceneId ?? sharedScene?.id)) ?? SCENES[0];
  const component = COMPONENTS.find((item) => item.id === componentId) ?? COMPONENTS[0];
  const risk = CURRENT_RISKS.find((item) => item.componentId === component.id);

  return (
    <div className="present__view">
      <h2>数字孪生场景</h2>
      <div className="present__scene">
        <div className="present__scene-hero">
          <b>{local?.title ?? "—"}</b>
          <span>
            {local?.version ?? "—"} · {local?.format ?? "—"}
          </span>
          <span>
            场景版本 {sharedScene ? `${sharedScene.id}（${sharedScene.data.state}）` : "尚未发布"}
          </span>
        </div>
        <ul className="present__evidence">
          <li>
            <small>当前测区</small>
            <strong>{component.id}</strong>
            <em>
              {component.part} · {component.zoneId}
            </em>
          </li>
          <li className={risk ? "is-risk" : ""}>
            <small>本轮响应</small>
            <strong>{risk ? risk.score.toFixed(2) : "—"}</strong>
            <em>{risk ? risk.priority : "未提示异常"}</em>
          </li>
          <li>
            <small>默认书签</small>
            <strong>{component.defaultBookmark}</strong>
            <em>{component.defaultBookmark} 为默认机位</em>
          </li>
        </ul>
      </div>
    </div>
  );
}

function CaptureView({ componentId, batchId }: { componentId: string; batchId: string }) {
  const component = COMPONENTS.find((item) => item.id === componentId) ?? COMPONENTS[0];
  const batch = SCAN_BATCHES.find((item) => item.batchId === batchId) ?? SCAN_BATCHES[0];
  const wave = WAVEFORMS.find((item) => item.batchId === batch?.batchId) ?? WAVEFORMS[0];
  const risk = CURRENT_RISKS.find((item) => item.componentId === component.id);

  /** 回波折线：把 points 映射成 viewBox 内的折线，投屏上只表达形状与标记位置 */
  const path = useMemo(() => {
    if (!wave?.points.length) return "";
    const xs = wave.points.map((point) => point.x);
    const ys = wave.points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    return wave.points
      .map((point, index) => {
        const x = ((point.x - minX) / spanX) * 1000;
        const y = 260 - ((point.y - minY) / spanY) * 240;
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [wave]);

  return (
    <div className="present__view">
      <h2>采集作业 · 回波与测区</h2>
      <div className="present__capture">
        <div className="present__waveshot">
          <svg viewBox="0 0 1000 280" preserveAspectRatio="none" aria-label="回波曲线">
            <path d={path} fill="none" stroke="var(--glow-cyan)" strokeWidth="3" />
          </svg>
          <span className="present__waveshot-axis">
            {wave?.axisLabel ?? "—"}（{wave?.unit ?? "—"}）
          </span>
        </div>
        <ul className="present__evidence">
          <li>
            <small>构件 / 测区</small>
            <strong>{component.id}</strong>
            <em>{component.zoneId}</em>
          </li>
          <li>
            <small>采集批次</small>
            <strong>{batch?.batchId ?? "—"}</strong>
            <em>
              {batch?.round ?? "—"} · {batch?.sourceMode === "replay" ? "演示回放" : "实采"}
            </em>
          </li>
          <li>
            <small>雷达响应</small>
            <strong>{component.radarScore === null ? "未采集" : component.radarScore.toFixed(2)}</strong>
            <em>{risk ? risk.priority : "—"}</em>
          </li>
        </ul>
      </div>
    </div>
  );
}

function TrainingView() {
  const baseline = EXPERIMENT.curveOld;
  const candidate = EXPERIMENT.curveNew;

  /**
   * 两条曲线必须共用一套坐标范围。
   *
   * 一开始让每条各自按自己的 min/max 铺满画框，结果是两条形状不同的曲线
   * 在屏幕上长得一模一样 —— 投屏上的「新旧对比」反而成了误导。
   * 这与文档反复强调的口径是同一条：比较必须在同一量纲下做。
   */
  const toPath = useMemo(() => {
    const all = [...baseline.points, ...candidate.points];
    if (!all.length) return () => "";
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    return (points: { x: number; y: number }[]) =>
      points
        .map((p, i) => {
          const x = ((p.x - minX) / spanX) * 1000;
          const y = 300 - ((p.y - minY) / spanY) * 270;
          return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
  }, [baseline.points, candidate.points]);

  const passed = EXPERIMENT.acceptance.filter((item) => item.pass).length;

  return (
    <div className="present__view">
      <h2>训练验证 · 新旧模型对比</h2>
      <div className="present__training">
        <div className="present__curves">
          <svg viewBox="0 0 1000 320" preserveAspectRatio="none" aria-label="新旧模型损失曲线">
            <path d={toPath(baseline.points)} fill="none" stroke="var(--text-muted)" strokeWidth="2.5" />
            <path d={toPath(candidate.points)} fill="none" stroke="var(--primary)" strokeWidth="3" />
          </svg>
          <div className="present__curves-legend">
            <span>
              <i style={{ background: "var(--text-muted)" }} />
              {baseline.label}
            </span>
            <span>
              <i style={{ background: "var(--primary)" }} />
              {candidate.label}
            </span>
            <em>测试集 {EXPERIMENT.datasetVersion}（同一测试集 · 共用量纲）</em>
          </div>
        </div>
        <ul className="present__evidence">
          <li>
            <small>候选版本</small>
            <strong>{EXPERIMENT.candidateVersion}</strong>
            <em>基线 {EXPERIMENT.baselineVersion}</em>
          </li>
          <li className={passed === EXPERIMENT.acceptance.length ? "is-ok" : ""}>
            <small>验收项通过</small>
            <strong>
              {passed}
              <em> / {EXPERIMENT.acceptance.length}</em>
            </strong>
            <em>按同一测试集口径</em>
          </li>
          <li>
            <small>阈值</small>
            <strong>{EXPERIMENT.threshold.toFixed(2)}</strong>
            <em>{EXPERIMENT.stopCondition}</em>
          </li>
        </ul>
      </div>
    </div>
  );
}

function DeliveryView() {
  const shared = useSharedStore(artifactsOf);
  const current = shared[0];
  const receipts = current?.data.receipts ?? [];
  const verified = receipts.filter((item) => item.pass).length;

  return (
    <div className="present__view">
      <h2>更新交付 · 本轮产物</h2>
      {current ? (
        <div className="present__training">
          <ul className="present__evidence">
            <li>
              <small>当前产物</small>
              <strong>{current.data.name}</strong>
              <em>
                {current.data.kind} · {current.data.target}
              </em>
            </li>
            <li className={current.data.state === "已回验" ? "is-ok" : ""}>
              <small>状态</small>
              <strong>{current.data.state}</strong>
              <em>
                {current.data.downloadCount ? `取用 ${current.data.downloadCount} 次` : "尚未取用"}
              </em>
            </li>
            <li>
              <small>模型版本</small>
              <strong>{current.data.modelVersion}</strong>
              <em>{current.data.demoOnly ? "演示资产，不可烧录" : "生产产物"}</em>
            </li>
            <li>
              <small>回验</small>
              <strong>{verified}</strong>
              <em>{receipts.length ? `共 ${receipts.length} 次提交` : "等待接收方提交摘要"}</em>
            </li>
          </ul>
          <div className="present__scene-hero">
            <b>包摘要</b>
            <span className="present__mono">{current.data.sha256}</span>
            <span>{current.data.sizeText} · 清单与逐文件摘要随包发布</span>
          </div>
        </div>
      ) : (
        <p className="present__empty">连接不上共享服务，或平台还没有已发布产物。</p>
      )}
    </div>
  );
}

function ReportView() {
  const missing = ARCHIVE_ITEMS.filter((item) => !item.present);
  const mismatch = ARCHIVE_ITEMS.filter(
    (item) => item.present && item.declaredSha256 !== item.actualSha256,
  );
  const ok = ARCHIVE_ITEMS.length - missing.length - mismatch.length;

  return (
    <div className="present__view">
      <h2>报告归档 · 结论与完整性</h2>
      <div className="present__scene">
        <ul className="present__evidence">
          <li>
            <small>本轮工单</small>
            <strong>{WORK_ORDER.id}</strong>
            <em>
              {WORK_ORDER.district} · {WORK_ORDER.site}
            </em>
          </li>
          <li className="is-risk">
            <small>本轮风险</small>
            <strong>{CURRENT_RISKS.length}</strong>
            <em>Z04 柱脚渗水待复核</em>
          </li>
          <li className={HISTORY_STATS.open ? "is-risk" : "is-ok"}>
            <small>历史未关闭</small>
            <strong>{HISTORY_STATS.open}</strong>
            <em>共 {HISTORY_STATS.total} 项</em>
          </li>
          <li className={missing.length || mismatch.length ? "is-risk" : "is-ok"}>
            <small>附件完整</small>
            <strong>
              {ok}
              <em> / {ARCHIVE_ITEMS.length}</em>
            </strong>
            <em>
              缺失 {missing.length} · 摘要不符 {mismatch.length}
            </em>
          </li>
        </ul>
        <div className="present__scene-hero">
          <b>处置建议</b>
          <span>Z04 柱脚渗水在雨季前后分别复测，其余风险已闭环或待验收</span>
          <span>环境配置 {ENV_RECORD.configVersion} · 采集与模型版本随报告附出</span>
        </div>
      </div>
    </div>
  );
}

function WorkspaceView({ focus }: { focus: ReturnType<typeof usePresentFocus> }) {
  const component = COMPONENTS.find((item) => item.id === focus.componentId) ?? COMPONENTS[0];
  const risk = CURRENT_RISKS.find((item) => item.componentId === component.id);
  const batch = SCAN_BATCHES.find((item) => item.batchId === focus.batchId);

  return (
    <div className="present__view">
      <h2>当前工作区 · 焦点对象</h2>
      <ul className="present__evidence present__evidence--wide">
        <li>
          <small>工单</small>
          <strong>{focus.orderId}</strong>
          <em>
            {WORK_ORDER.district} · {WORK_ORDER.site}
          </em>
        </li>
        <li>
          <small>构件 / 测区</small>
          <strong>{component.id}</strong>
          <em>
            {component.part} · {component.zoneId}
          </em>
        </li>
        <li>
          <small>批次</small>
          <strong>{batch?.batchId ?? "—"}</strong>
          <em>{batch ? `${batch.round} · ${batch.modelVersion}` : "未选批次"}</em>
        </li>
        <li className={risk ? "is-risk" : ""}>
          <small>响应</small>
          <strong>{component.radarScore === null ? "未采集" : component.radarScore.toFixed(2)}</strong>
          <em>{risk ? risk.priority : "未提示异常"}</em>
        </li>
      </ul>
      {focus.sceneId ? (
        <div className="present__scene-hero">
          <b>当前场景</b>
          <span>{focus.sceneId}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 大屏
 * ------------------------------------------------------------------ */

export default function Present() {
  const { stageLabel, channels, sessionId } = useMumai();
  const focus = usePresentFocus();
  const online = usePresentOnline();
  const scanned = COMPONENTS.filter((item) => item.radarScore !== null).length;

  return (
    <div className={`present${focus.viewType === "map" ? " present--map" : ""}`}>
      {focus.viewType === "map" ? (
        <>
          <div className="present__map">
            <MapView />
          </div>
          <div className="present__vignette" />
        </>
      ) : (
        <div className="present__stage">
          {focus.viewType === "scene" ? (
            <SceneView componentId={focus.componentId} sceneId={focus.sceneId} />
          ) : null}
          {focus.viewType === "capture" ? (
            <CaptureView componentId={focus.componentId} batchId={focus.batchId} />
          ) : null}
          {focus.viewType === "training" ? <TrainingView /> : null}
          {focus.viewType === "delivery" ? <DeliveryView /> : null}
          {focus.viewType === "report" ? <ReportView /> : null}
          {focus.viewType === "workspace" ? <WorkspaceView focus={focus} /> : null}
        </div>
      )}

      <header className="present__head">
        <h1>木脉智检 · 古建筑智能巡检平台</h1>
        <div className="present__head-right">
          <StatusChip text={VIEW_LABEL[focus.viewType]} tone="info" />
          {online ? null : <StatusChip text="未连接共享服务" tone="danger" />}
          <span>
            演示回放 · 会话 {sessionId}
            {focus.deliveredAt ? ` · 投放于 ${focus.deliveredAt.slice(11, 19)}` : ""}
          </span>
          {focus.viewType === "map"
            ? channels.map((channel) => (
                <StatusChip
                  key={channel.key}
                  text={channel.label}
                  tone={channel.state === "online" ? "ok" : channel.state === "stale" ? "warn" : "danger"}
                />
              ))
            : null}
          <StatusChip text={`持有人 ${holderLabel(focus.holderId)}`} tone={focus.holderId ? "ok" : "warn"} />
        </div>
      </header>

      <footer className="present__foot">
        <span>当前阶段 {stageLabel}</span>
        <span>
          四柱已采集 {scanned} / {COMPONENTS.length}
        </span>
        <span>本轮异常响应区 {CURRENT_RISKS.length}</span>
        <span>历史未关闭 {HISTORY_STATS.open}</span>
        <span className="present__foot-mono">实时位置 31.2304°N 121.4737°E</span>
      </footer>
    </div>
  );
}
