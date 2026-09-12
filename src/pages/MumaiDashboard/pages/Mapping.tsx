/**
 * 建图巡检（`/mapping`）
 *
 * PRD 3.2：
 *   - 主视图是可缩放平移的占据栅格地图，叠加小车、轨迹、巡检点、四柱和禁入区
 *   - 旁侧以视频和通信状态辅助判断，不做一屏全是仪表盘
 *   - 工具栏：地图保存、版本选择、路线预览、任务下发、暂停与取消
 *   - 先选地图版本与点位序列 → 预览 → 下发 → 收到机器人确认才进入执行中
 *   - 平台计划路径与机器人实际路径**分开着色**
 *   - 通信状态分别显示地图 / 位姿 / 视频 / 车辆更新时间，任一路断流只影响该通道
 */

import { useMemo, useState } from "react";
import { useMumai } from "../context";
import { permissionHint } from "../auth";
import { Panel } from "../Panel";
import { Btn, PermNote, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import RvizView from "./RvizView";
import {
  DEVICES,
  FORBIDDEN_ZONES,
  MAP_VERSIONS,
  WAYPOINTS,
} from "../seed/scenario";

/**
 * RViz 画面配置。
 *
 * 当前：直接使用 `public/rviz-reference.png` —— 那正是实际 RViz 的界面截图，
 * 用于演示阶段"建图画面就是 RViz"的观感。
 *
 * 后续接实机时，把下面的 image 换成空、把 url 换成后端串流地址即可，
 * 页面其它部分不用改（这是「预留串流接口」的落点）：
 *   { image: "", url: "http://<host>:8080/stream?topic=/map", kind: "mjpeg", source: "rosbridge" }
 */
const RVIZ_STREAM = {
  /** 静态参考画面（实际 RViz 截图） */
  image: "rviz-reference.png",
  /** 真实串流地址，留空则用上面的静态画面 */
  url: "",
  kind: "mjpeg" as const,
  source: "后端 /api/rviz/stream 占位（接实机后替换 url）",
};

/** 栅格编码 → 类名（用于禁入区与参数的文案展示） */
const CELL_HINT = "10 cm / 格";

export default function Mapping() {
  const { mission, patchMission, channels, toast, pushEvent, deviceSource, setDeviceSource, can } =
    useMumai();
  const [versionId, setVersionId] = useState(MAP_VERSIONS[0]?.id ?? "");
  const [compare, setCompare] = useState(true);
  const [showLaser, setShowLaser] = useState(true);

  const version = useMemo(
    () => MAP_VERSIONS.find((item) => item.id === versionId) ?? MAP_VERSIONS[0],
    [versionId],
  );

  const robot = useMemo(() => WAYPOINTS.find((item) => item.state === "当前目标"), []);
  const videoChannel = channels.find((item) => item.key === "video");
  const running = mission.state === "执行中";

  return (
    <div className="page page--mapping">
      <Toolbar
        note={
          <>
            <SourceTag
              label={deviceSource === "demo" ? "演示车 DEMO-CART-01 · 回放" : "实机 · 实时"}
            />
            <span>
              地图版本 {version?.label ?? "—"} · 分辨率 {version?.resolutionM ?? "—"} m ·{" "}
              {CELL_HINT}
            </span>
          </>
        }>
        <label className="field">
          <span>地图版本</span>
          <select value={versionId} onChange={(event) => setVersionId(event.target.value)}>
            {MAP_VERSIONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.state}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>数据来源</span>
          <select
            value={deviceSource}
            onChange={(event) => {
              // PRD 3.2：切换来源只能在任务停止后进行
              if (running) {
                toast("任务执行中不允许切换数据来源，请先暂停", "danger");
                return;
              }
              setDeviceSource(event.target.value as "demo" | "real");
              pushEvent(
                `数据来源切换为 ${event.target.value === "demo" ? "演示车" : "实机"}`,
                "warn",
              );
            }}>
            <option value="demo">演示车（回放）</option>
            <option value="real">实机（只读监视）</option>
          </select>
        </label>
        <Btn
          active={compare}
          onClick={() => setCompare((value) => !value)}>
          {compare ? "隐藏实际路径" : "叠加实际路径"}
        </Btn>
        <Btn active={showLaser} onClick={() => setShowLaser((value) => !value)}>
          {showLaser ? "隐藏激光点" : "显示激光点"}
        </Btn>
        <Btn onClick={() => { patchMission({ state: "已完成" }); toast("地图版本已保存", "ok"); }}>
          保存地图
        </Btn>
        <Btn onClick={() => { patchMission({ state: "已预览" }); toast("路线预览已生成", "info"); }}>
          路线预览
        </Btn>
        {/* PRD 2.1 / S11：任务下发与监视由具身智能工程师与架构师负责 */}
        <Btn
          tone="primary"
          disabled={running || !can("mission:dispatch")}
          title={can("mission:dispatch") ? "下发巡检任务，等待机器人确认" : permissionHint("mission:dispatch")}
          onClick={() => {
            patchMission({ state: "等待机器人确认" });
            pushEvent("巡检任务已下发，等待机器人确认", "info");
            toast("任务已下发，等待机器人确认", "info");
            window.setTimeout(() => {
              patchMission({ state: "执行中" });
              pushEvent("机器人已接收任务，进入执行中", "ok");
            }, 1500);
          }}>
          任务下发
        </Btn>
        <Btn
          disabled={!can("mission:dispatch")}
          title={can("mission:dispatch") ? "暂停任务" : permissionHint("mission:dispatch")}
          onClick={() => { patchMission({ state: "已暂停" }); pushEvent("巡检任务暂停", "warn"); }}>
          暂停
        </Btn>
        <Btn
          tone="danger"
          disabled={!can("mission:dispatch")}
          title={can("mission:dispatch") ? "取消任务并记录反馈" : permissionHint("mission:dispatch")}
          onClick={() => { patchMission({ state: "已取消" }); pushEvent("巡检任务取消", "danger"); }}>
          取消
        </Btn>
        <PermNote permissions={["mission:dispatch"]} />
      </Toolbar>

      <div className="map-layout">
        <Panel
          title="建图视图"
          extra={
            <>
              <StatusChip text={version?.state ?? "—"} tone="info" />
              <span className="muted">更新 {version?.updatedAt ?? "—"}</span>
            </>
          }
          className="map-view">
          <RvizView stream={RVIZ_STREAM} showActualPath={compare} showLaser={showLaser} />
        </Panel>

        <div className="map-side">
          <Panel
            title="现场视频"
            extra={
              <StatusChip
                text={videoChannel?.state === "online" ? "在线" : "延迟"}
                tone={videoChannel?.state === "online" ? "ok" : "warn"}
              />
            }>
            <div className="video-slot">
              <strong>摄像头画面占位</strong>
              <em>
                更新于 {videoChannel?.updatedAt ?? "—"}；视频在播放不等于车辆在线，四路通道独立判断
              </em>
            </div>
          </Panel>

          <Panel title="通信状态">
            <ul className="channel-list">
              {channels.map((channel) => (
                <li key={channel.key} className={`is-${channel.state}`}>
                  <b>{channel.label}</b>
                  <StatusChip
                    text={
                      channel.state === "online" ? "正常" : channel.state === "stale" ? "延迟" : "断开"
                    }
                    tone={
                      channel.state === "online" ? "ok" : channel.state === "stale" ? "warn" : "danger"
                    }
                  />
                  <em>{channel.updatedAt}</em>
                  <span>{channel.source}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title="巡检任务"
            extra={<StatusChip text={mission.state} tone={running ? "ok" : "warn"} />}>
            <dl className="mission">
              <div>
                <dt>任务编号</dt>
                <dd>{mission.id}</dd>
              </div>
              <div>
                <dt>地图版本</dt>
                <dd>{mission.mapVersion}</dd>
              </div>
              <div>
                <dt>速度档位</dt>
                <dd>{mission.speedProfile}</dd>
              </div>
              <div>
                <dt>设备</dt>
                <dd>{DEVICES.demoCart.name}</dd>
              </div>
              <div>
                <dt>当前目标</dt>
                <dd>{robot ? `${robot.id} · ${robot.label}` : "—"}</dd>
              </div>
              <div>
                <dt>禁入区</dt>
                <dd>{FORBIDDEN_ZONES.length} 处</dd>
              </div>
            </dl>

            <h4 className="sub">点位序列</h4>
            <ol className="waypoint-list">
              {WAYPOINTS.map((point) => (
                <li
                  key={point.id}
                  className={`is-${point.state === "当前目标" ? "current" : point.state === "已到达" ? "done" : "todo"}`}>
                  <b>{point.id}</b>
                  <span>{point.label}</span>
                  <em>{point.state}</em>
                </li>
              ))}
            </ol>

            <h4 className="sub">执行步骤</h4>
            <ol className="mission-steps">
              {mission.steps.map((step, index) => (
                <li
                  key={step.at + step.label}
                  className={`is-${index === mission.steps.length - 1 ? "running" : "done"}`}>
                  <i />
                  <b>{step.label}</b>
                  <time>{step.at}</time>
                  <span>
                    {step.actor} · {step.result}
                  </span>
                </li>
              ))}
            </ol>

            {mission.state === "等待机器人确认" ? (
              <StateBlock
                kind="loading"
                title="等待机器人确认"
                hint="收到机器人确认后才进入执行中；未接入实机时显示为等待操作员确认。"
              />
            ) : null}

            {mission.anomalies.length ? (
              <ul className="mission-anomalies">
                {mission.anomalies.map((item) => (
                  <li key={item.at}>
                    <time>{item.at}</time>
                    {item.text}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="mission-takeover">
              <small>接管记录（{mission.takeover.length} 次）</small>
              {mission.takeover.map((item) => (
                <span key={item.at}>
                  {item.at} · {item.operator}：{item.reason}
                </span>
              ))}
            </div>

          </Panel>
        </div>
      </div>
    </div>
  );
}

