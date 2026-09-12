/**
 * 大屏展示窗口（`/present`）
 *
 * PRD 2.2：大屏窗口单独具有 presentation 角色，通过「投到展示窗口」切换；
 * 四人浏览器各自导航，不因别人切页而被强制跳转。
 * 大屏承载「当前演示对象」（工单 / 构件 / 批次）与展示控制权持有人，
 * 两者都来自 focus.ts 的共享焦点，这里不另存一份。
 *
 * 这里刻意不渲染导航与外壳：只有地图 + 极简数据层，用于投影。
 */

import { useDashboardStore, requestMapMode } from "../map/store";
import Map from "../mapDemo";
import { Icon } from "../icons";
import { StatusChip } from "../ui";
import { useMumai } from "../context";
import { holderLabel, usePresentFocus } from "../focus";
import { COMPONENTS, CURRENT_RISKS, HISTORY_STATS, WORK_ORDER } from "../seed/scenario";

export default function Present() {
  const mode = useDashboardStore((state) => state.mode);
  const { stageLabel, channels, sessionId } = useMumai();
  /** 当前演示对象与控制权持有人：由本端「投到展示窗口」写入的共享焦点 */
  const focus = usePresentFocus();
  const focusComponent = COMPONENTS.find((item) => item.id === focus.componentId);
  const focusRisk = CURRENT_RISKS.find((item) => item.componentId === focus.componentId);

  const scanned = COMPONENTS.filter((item) => item.radarScore !== null);
  const risks = CURRENT_RISKS.length;

  return (
    <div className="present">
      <div className="present__map">
        <Map mode={mode} />
      </div>
      <div className="present__vignette" />

      <header className="present__head">
        <h1>木脉智检 · 古建筑智能巡检平台</h1>
        <div className="present__head-right">
          <span>
            演示回放 · 会话 {sessionId}
            {focus.deliveredAt ? ` · 投放于 ${focus.deliveredAt}` : ""}
          </span>
          {channels.map((channel) => (
            <StatusChip
              key={channel.key}
              text={channel.label}
              tone={channel.state === "online" ? "ok" : channel.state === "stale" ? "warn" : "danger"}
            />
          ))}
          <StatusChip text={`控制权持有人 ${holderLabel(focus.holderId)}`} tone="info" />
        </div>
      </header>

      <div className="present__stats">
        <article className={focusRisk ? "is-risk" : ""}>
          <small>当前演示对象</small>
          <strong>
            {focus.componentId}
            <em> · {focus.orderId}</em>
          </strong>
          <em>
            批次 {focus.batchId}
            {focusComponent ? ` · ${focusComponent.part}` : ""}
            {focusRisk ? ` · ${focusRisk.priority}` : ""}
          </em>
        </article>
        <article>
          <small>当前阶段</small>
          <strong>{stageLabel}</strong>
        </article>
        <article>
          <small>本轮工单</small>
          <strong>{WORK_ORDER.id}</strong>
          <em>
            {WORK_ORDER.district} · {WORK_ORDER.site}
          </em>
        </article>
        <article>
          <small>四柱已采集</small>
          <strong>
            {scanned.length}
            <em> / {COMPONENTS.length}</em>
          </strong>
        </article>
        <article className={risks ? "is-risk" : ""}>
          <small>本轮异常响应区</small>
          <strong>{risks}</strong>
          <em>规则融合，非分数相加</em>
        </article>
        <article>
          <small>历史风险</small>
          <strong>{HISTORY_STATS.total}</strong>
          <em>未关闭 {HISTORY_STATS.open}</em>
        </article>
      </div>

      <ul className="present__columns">
        {COMPONENTS.map((component) => {
          const risk = CURRENT_RISKS.find((item) => item.componentId === component.id);
          return (
            <li key={component.id} className={component.radarScore !== null ? "is-scanned" : "is-pending"}>
              <b>{component.id}</b>
              <span>{component.part}</span>
              {component.radarScore !== null ? (
                <em>回波 {component.radarScore.toFixed(2)}</em>
              ) : (
                <em className="is-pending">未采集</em>
              )}
              {risk ? <small>{risk.priority}</small> : null}
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="present__switch"
        onClick={() => requestMapMode(mode === "china" ? "shanghai" : "china")}>
        <Icon name="arrow" />
        {mode === "china" ? "上海" : "全国"}
      </button>
    </div>
  );
}
