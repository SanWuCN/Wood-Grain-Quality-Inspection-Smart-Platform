/**
 * 演示控制（`/console`）
 *
 * PRD 2.2：演示控制是独立的一级页面，使用独立管理权限。
 * PRD 7.4：演示控制台。
 * 第二章剧本：按总计时节点（08:00 → 47:00）分段，附切页口令与关键台词。
 *
 * 这里只做「驱动演示状态」的动作，不伪造真实数据；每个事件都写明触发后置位的状态。
 */

import { useState } from "react";
import { useMumai } from "../context";
import { Panel } from "../Panel";
import { Btn, SourceTag, StatusChip, Timeline } from "../ui";
import { CLOCK_PHASES, DEMO_EVENTS, DEVICES, STAGES } from "../seed/scenario";

export default function Console() {
  const {
    stage,
    setStage,
    stageLabel,
    events,
    pushEvent,
    toast,
    domainPending,
    setDomainPending,
    presetAnnotation,
    setPresetAnnotation,
    deviceSource,
    setDeviceSource,
    resetDemo,
    mission,
    patchMission,
  } = useMumai();

  const [phaseKey, setPhaseKey] = useState(CLOCK_PHASES[0]?.key ?? "");
  const phase = CLOCK_PHASES.find((item) => item.key === phaseKey) ?? CLOCK_PHASES[0];

  const trigger = (key: string) => {
    const event = DEMO_EVENTS.find((item) => item.key === key);
    if (!event) return;
    switch (key) {
      case "domain_pending":
        setDomainPending(true);
        pushEvent("触发「适用域待核验」：scan-Z04-001 诊断输出已冻结", "danger");
        break;
      case "domain_cleared":
        setDomainPending(false);
        pushEvent("适用域核验通过，恢复诊断输出", "ok");
        break;
      case "preset_annotation":
        setPresetAnnotation(true);
        pushEvent("启用「预设标注演示」，界面标注来源为预设标注", "warn");
        break;
      case "switch_source_real":
        if (mission.state === "执行中") {
          toast("任务执行中不能切换数据来源", "danger");
          return;
        }
        setDeviceSource("real");
        pushEvent(`数据来源切换为 ${DEVICES.realCart.name}（未获运动权限，只读监视）`, "warn");
        break;
      case "switch_source_demo":
        if (mission.state === "执行中") {
          toast("任务执行中不能切换数据来源", "danger");
          return;
        }
        setDeviceSource("demo");
        pushEvent(`数据来源切换为 ${DEVICES.demoCart.name}`, "info");
        break;
      case "pause_mission":
        patchMission({ state: "已暂停" });
        pushEvent("小车在安全点暂停，保持状态监测", "warn");
        break;
      case "resume_mission":
        patchMission({ state: "执行中" });
        pushEvent("小车恢复执行巡检任务", "ok");
        break;
      default:
        pushEvent(`${event.label}：${event.effect}`, event.tone === "red" ? "danger" : event.tone === "amber" ? "warn" : "info");
    }
    toast(`${event.label} 已触发`, event.tone === "red" ? "danger" : "ok");
  };

  return (
    <div className="page page--console">
      <div className="cs-layout">
        {/* 左：剧本时间轴 */}
        <div className="cs-left">
          <Panel
            title="排练时间节点"
            extra={<SourceTag label="第二章剧本" />}
            className="cs-phases">
            <ol className="cs-phase-list">
              {CLOCK_PHASES.map((item) => (
                <li key={item.key} className={item.key === phaseKey ? "is-active" : ""}>
                  <button type="button" onClick={() => { setPhaseKey(item.key); setStage(item.stageKey); }}>
                    <time>
                      {item.start}–{item.end}
                    </time>
                    <b>{item.title}</b>
                    <span>
                      {item.slides} · 主讲 {item.speaker}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        {/* 中：当前阶段详情 */}
        <div className="cs-mid">
          <Panel
            title={`当前阶段 · ${phase?.title ?? stageLabel}`}
            extra={<StatusChip text={stageLabel} tone="info" />}>
            {phase ? (
              <>
                <dl className="kv">
                  <div>
                    <dt>计时</dt>
                    <dd>
                      {phase.start} – {phase.end}
                    </dd>
                  </div>
                  <div>
                    <dt>PPT</dt>
                    <dd>{phase.slides}</dd>
                  </div>
                  <div>
                    <dt>主讲</dt>
                    <dd>{phase.speaker}</dd>
                  </div>
                  <div>
                    <dt>平台阶段</dt>
                    <dd>{STAGES.find((item) => item.key === phase.stageKey)?.label ?? phase.stageKey}</dd>
                  </div>
                </dl>

                <h4 className="sub">关键台词（口播依据）</h4>
                <ul className="cs-lines">
                  {phase.keyLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>

                {phase.eventKey ? (
                  <Btn tone="primary" onClick={() => trigger(phase.eventKey as string)}>
                    触发本段事件
                  </Btn>
                ) : null}
              </>
            ) : (
              <p className="note">选择左侧时间节点查看台词与切页口令。</p>
            )}
          </Panel>

          <Panel title="阶段推进" extra={<span className="muted">{STAGES.length} 个阶段</span>}>
            <ol className="cs-stages">
              {STAGES.map((item) => (
                <li key={item.key} className={item.key === stage ? "is-active" : ""}>
                  <button type="button" onClick={() => setStage(item.key)}>
                    <b>{item.label}</b>
                    <span>{item.detail}</span>
                    <em>
                      {item.script} · {item.clock}
                    </em>
                  </button>
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        {/* 右：事件触发 + 状态 + 事件总线 */}
        <div className="cs-right">
          <Panel title="演示事件触发">
            <div className="cs-events">
              {DEMO_EVENTS.map((event) => (
                <button
                  key={event.key}
                  type="button"
                  className={`cs-event cs-event--${event.tone}`}
                  onClick={() => trigger(event.key)}>
                  <b>{event.label}</b>
                  <span>{event.detail}</span>
                  <em>{event.effect}</em>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="当前演示状态">
            <dl className="kv">
              <div>
                <dt>适用域</dt>
                <dd>
                  <StatusChip
                    text={domainPending ? "待核验（输出已冻结）" : "正常"}
                    tone={domainPending ? "warn" : "ok"}
                  />
                </dd>
              </div>
              <div>
                <dt>标注来源</dt>
                <dd>{presetAnnotation ? "预设标注演示" : "实时视觉推理"}</dd>
              </div>
              <div>
                <dt>数据来源</dt>
                <dd>{deviceSource === "demo" ? DEVICES.demoCart.name : DEVICES.realCart.name}</dd>
              </div>
              <div>
                <dt>巡检任务</dt>
                <dd>
                  <StatusChip text={mission.state} tone={mission.state === "执行中" ? "ok" : "warn"} />
                </dd>
              </div>
            </dl>
            <div className="cs-actions">
              <Btn
                onClick={() => {
                  setPresetAnnotation(!presetAnnotation);
                  pushEvent(
                    `标注来源切换为 ${!presetAnnotation ? "预设标注演示" : "实时视觉推理"}`,
                    "warn",
                  );
                }}>
                切换标注来源
              </Btn>
              <Btn tone="primary" onClick={() => window.open("#/present", "_blank", "noopener")}>
                投到展示窗口
              </Btn>
              <Btn tone="danger" onClick={resetDemo}>
                装载阶段快照
              </Btn>
            </div>
            <p className="note">
              投屏动作才改变大屏；小木普通打开只影响发起客户端。展示控制权同一时间只有一个持有人。
            </p>
          </Panel>

          <Panel title="事件总线" extra={<span className="muted">最近 {Math.min(events.length, 12)} 条</span>}>
            <Timeline
              items={events.slice(0, 12).map((item) => ({
                at: item.at,
                text: item.text,
                tone: item.tone,
              }))}
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}
