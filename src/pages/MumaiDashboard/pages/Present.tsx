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
import NumberAnimation from "@/components/numberAnimation";
import { useDashboardStore, requestMapMode } from "../map/store";
import Map from "../mapDemo";
import { Icon } from "../icons";
import { StatusChip, WaveChart } from "../ui";
import { useMumai } from "../context";
import { holderLabel, usePresentFocus, usePresentOnline, VIEW_LABEL } from "../focus";
import { buildLossOption } from "../trainingCurve";
import EChart from "./OverviewCharts";
import {
  COMPONENTS,
  CURRENT_RISKS,
  ENV_RECORD,
  EXPERIMENT,
  HISTORY_STATS,
  ARCHIVE_ITEMS,
  SCAN_BATCHES,
  SCENES,
  waveformFor,
  WORK_ORDER,
} from "../seed/scenario";
import { artifacts as artifactsOf, publishedScene, useSharedStore } from "../store/shared";

/**
 * 投屏上「读数」的显示口径。
 *
 * 响应得分与模型阈值原本写的是 `toFixed(2)`，这里固定成两位小数交给
 * `NumberAnimation`（`digits` 同时定最小 / 最大小数位），滚动过程中不会中途换写法。
 * 提成模块级常量是为了让「这一栏保留几位」一眼可查，而不是散在七处 JSX 里。
 *
 * 注意：`present__evidence` / `present__foot` 里的数字是成组出现的 KPI，
 * 组内要么整组走动效、要么整组静止（一个静止数字挨着三个滚动的会像坏了）；
 * 识别信息（工单号 / 构件号 / 批次号 / 版本串 / 时间戳 / SHA / 文件名）一律不滚。
 */
const SCORE_DIGITS = 2;

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
            <strong>
              {/* 风险得分是读数值：换构件 / 换场景就换一个数，走动效；无风险时 `undefined` 落成「—」 */}
              <NumberAnimation value={risk?.score} digits={SCORE_DIGITS} />
            </strong>
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
  /* 投屏讲的是主频/带宽/本底，取向取频谱（与小木台词同一口径） */
  const wave = waveformFor(batch?.batchId ?? "", "spectrum");
  const risk = CURRENT_RISKS.find((item) => item.componentId === component.id);

  return (
    <div className="present__view">
      <h2>采集作业 · 回波与测区</h2>
      <div className="present__capture">
        <div className="present__waveshot">
          {/*
            ⚠ 这里原来自己手写了一段 SVG 折线（把 points 映射到 0–1000 / 0–280）。
            两个问题：一是**同一张图两处实现**，波形口径（双极性、真实刻度、
            参数小字）一改就得记得两边都改；二是它按 min–max 铺满，负半周看不出零轴。
            现在统一走共享的 `WaveChart`：一处实现、投屏与页面看到的是同一条曲线。
          */}
          <WaveChart
            points={wave?.points ?? []}
            unit={wave?.unit}
            axisLabel={wave?.axisLabel}
            bipolar={wave?.bipolar}
            xTicks={wave?.xTicks}
            paramLine={wave?.paramLine}
            markers={wave?.markers ?? []}
            height={168}
          />
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
              {batch?.round ?? "—"} · {batch?.sourceMode === "replay" ? "归档回放" : "实采"}
            </em>
          </li>
          <li>
            <small>雷达响应</small>
            <strong>
              {/* 传感器读数：滚动计数；原有空值文案是「未采集」（不是「—」），用 fallback 保口径 */}
              <NumberAnimation value={component.radarScore} digits={SCORE_DIGITS} fallback="未采集" />
            </strong>
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

  /*
    投屏这张曲线原来是**另一段手画 SVG**：没有刻度、没有坐标轴名、鼠标放上去读不到值 ——
    大屏上给评委看的图比页面里的还简陋。现在与训练页共用同一份 option（`buildLossOption`），
    两条曲线画在同一个纵轴上（同一量纲才可比，这条口径原来只写在注释里）。
  */
  const option = useMemo(
    () =>
      buildLossOption({
        series: [
          { name: baseline.label, color: baseline.color, points: baseline.points },
          { name: candidate.label, color: candidate.color, points: candidate.points },
        ],
        drawn: baseline.points.length,
        epochCount: baseline.points.length,
        yName: "损失",
      }),
    [baseline, candidate],
  );

  const passed = EXPERIMENT.acceptance.filter((item) => item.pass).length;

  return (
    <div className="present__view">
      <h2>训练验证 · 新旧模型对比</h2>
      <div className="present__training">
        <div className="present__curves">
          <EChart
            className="tw-chart present__loss"
            option={option}
            ariaLabel={`新旧模型损失曲线：${baseline.label} 与 ${candidate.label}（同一纵轴，同一测试集）`}
            /* 投屏是静态结论，不需要入场动画 */
            animate={false}
          />
          <div className="present__curves-legend">
            <em>
              测试集 {EXPERIMENT.datasetVersion}（同一测试集 · 同一纵轴 · 共用量纲）
            </em>
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
              {/* 通过项与总项是同一个读数（n / m），整对一起滚，避免分母僵在旁边 */}
              <NumberAnimation value={passed} />
              <em>
                {" / "}
                <NumberAnimation value={EXPERIMENT.acceptance.length} />
              </em>
            </strong>
            <em>按同一测试集口径</em>
          </li>
          <li>
            <small>阈值</small>
            <strong>
              {/* 阈值本身是常量，但它和「验收项通过」同属一行 KPI：整行一致，这里跟着走 */}
              <NumberAnimation value={EXPERIMENT.threshold} digits={SCORE_DIGITS} />
            </strong>
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
                {/* 取用次数是共享服务里的计数（随时会被别的会话改），走动效 */}
                {current.data.downloadCount ? (
                  <>
                    取用 <NumberAnimation value={current.data.downloadCount} /> 次
                  </>
                ) : (
                  "尚未取用"
                )}
              </em>
            </li>
            <li>
              <small>模型版本</small>
              <strong>{current.data.modelVersion}</strong>
              <em>{current.data.demoOnly ? "受限资产，不可烧录" : "生产产物"}</em>
            </li>
            <li>
              <small>回验</small>
              <strong>
                {/* 通过数与提交数都来自产物的 receipts，共享服务一刷新就变 */}
                <NumberAnimation value={verified} />
              </strong>
              <em>
                {receipts.length ? (
                  <>
                    共 <NumberAnimation value={receipts.length} /> 次提交
                  </>
                ) : (
                  "等待接收方提交摘要"
                )}
              </em>
            </li>
          </ul>
          {/* 包摘要区：`sha256` 是哈希、`sizeText` 是预格式化文本，都不属于会变的读数 */}
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
        {/* 这一组证据卡是一整行 KPI（风险数 / 未关闭数 / 附件完整度），整组走动效；
            `WORK_ORDER.id` 与区县、站点名是识别信息，保持静止 */}
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
            <strong>
              <NumberAnimation value={CURRENT_RISKS.length} />
            </strong>
            <em>Z04 柱脚渗水待复核</em>
          </li>
          <li className={HISTORY_STATS.open ? "is-risk" : "is-ok"}>
            <small>历史未关闭</small>
            <strong>
              <NumberAnimation value={HISTORY_STATS.open} />
            </strong>
            <em>
              共 <NumberAnimation value={HISTORY_STATS.total} /> 项
            </em>
          </li>
          <li className={missing.length || mismatch.length ? "is-risk" : "is-ok"}>
            <small>附件完整</small>
            <strong>
              <NumberAnimation value={ok} />
              <em>
                {" / "}
                <NumberAnimation value={ARCHIVE_ITEMS.length} />
              </em>
            </strong>
            <em>
              缺失 <NumberAnimation value={missing.length} /> · 摘要不符{" "}
              <NumberAnimation value={mismatch.length} />
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
          <strong>
            {/* 与采集视图同一口径：传感器读数滚动，空值仍显示「未采集」 */}
            <NumberAnimation value={component.radarScore} digits={SCORE_DIGITS} fallback="未采集" />
          </strong>
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
            {/* 会话 ID 与投放时间是标识 / 时间戳，保持静止 */}
            归档回放 · 会话 {sessionId}
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

      {/* 页脚是一整行计数 KPI（已采集 / 异常区 / 未关闭），整行走动效；
          阶段名是文字、经纬度是常量字符串，保持静止 */}
      <footer className="present__foot">
        <span>当前阶段 {stageLabel}</span>
        <span>
          四柱已采集 <NumberAnimation value={scanned} /> /{" "}
          <NumberAnimation value={COMPONENTS.length} />
        </span>
        <span>
          本轮异常响应区 <NumberAnimation value={CURRENT_RISKS.length} />
        </span>
        <span>
          历史未关闭 <NumberAnimation value={HISTORY_STATS.open} />
        </span>
        <span className="present__foot-mono">实时位置 31.2304°N 121.4737°E</span>
      </footer>
    </div>
  );
}
