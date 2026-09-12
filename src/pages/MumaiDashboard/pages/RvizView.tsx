/**
 * 建图画面：RViz 风格占据栅格视图
 *
 * 需求来自实测反馈：建图页原来的自绘格子图太"示意"，要换成接近 RViz 的画面，
 * 并且**预留串流接口**，后续可以真实替换成 RViz 的投屏画面。
 *
 * 两种渲染路径：
 *   - 内置演示渲染（默认）：用 canvas 按占据栅格数据画出 RViz 那种观感 ——
 *     深灰底、白色占据栅格、红色激光扫描点、绿色当前位姿箭头、蓝色规划路径
 *   - 真实串流（预留）：给 `streamUrl` 就渲染 MJPEG / WebRTC 的 <img> / <video>，
 *     并在界面上标明来源；没有 streamUrl 时按钮置灰并说明原因
 *
 * 串流地址与设备名都来自配置，不硬编码在页面源码里。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { StatusChip } from "../ui";
import {
  ACTUAL_PATH,
  FORBIDDEN_ZONES,
  GRID_MAP,
  PLANNED_PATH,
  POSE_TRACK,
  WAYPOINTS,
} from "../seed/scenario";

/** 栅格编码 0 可通行 / 1 占据 / 2 未知 */
const OCCUPIED = 1;
const UNKNOWN = 2;

export interface RvizStreamConfig {
  /**
   * 静态参考画面（public 下的路径）。
   * 演示阶段直接用真实 RViz 的界面截图；接实机后把它留空、填 url。
   */
  image?: string;
  /** 真实串流地址（MJPEG/WebRTC 都行）。为空则退回静态画面 / 内置渲染。 */
  url?: string;
  /** 串流类型，决定用 img 还是 video 渲染 */
  kind?: "mjpeg" | "webrtc";
  /** 来源说明，显示在界面上 */
  source?: string;
}

export interface RvizViewProps {
  stream?: RvizStreamConfig;
  /** 是否显示机器人实际路径（与平台计划路径分开着色） */
  showActualPath?: boolean;
  /** 是否显示激光扫描点 */
  showLaser?: boolean;
  height?: number;
}

/** 内置演示渲染：把占据栅格画成 RViz 的观感 */
function DemoRvizCanvas({
  showActualPath,
  showLaser,
}: {
  showActualPath: boolean;
  showLaser: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  const geometry = useMemo(() => {
    const scale = 8;
    const width = GRID_MAP.width * scale;
    const height = GRID_MAP.height * scale;
    return { scale, width, height };
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { scale, width, height } = geometry;

    // RViz 的深灰底
    ctx.fillStyle = "#303030";
    ctx.fillRect(0, 0, width, height);

    // 1m 网格（GRID_MAP.resolutionM = 0.1m/格 → 每 10 格 1m）
    const cellPx = scale;
    const meterCells = Math.round(1 / GRID_MAP.resolutionM);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= GRID_MAP.width; x += meterCells) {
      ctx.beginPath();
      ctx.moveTo(x * cellPx + 0.5, 0);
      ctx.lineTo(x * cellPx + 0.5, height);
      ctx.stroke();
    }
    for (let y = 0; y <= GRID_MAP.height; y += meterCells) {
      ctx.beginPath();
      ctx.moveTo(0, y * cellPx + 0.5);
      ctx.lineTo(width, y * cellPx + 0.5);
      ctx.stroke();
    }

    // 占据栅格：白色（RViz 的 map 默认配色）
    ctx.fillStyle = "#d8d8d8";
    for (let y = 0; y < GRID_MAP.height; y++) {
      for (let x = 0; x < GRID_MAP.width; x++) {
        const code = GRID_MAP.cells[y * GRID_MAP.width + x] ?? 0;
        if (code === OCCUPIED) ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
        else if (code === UNKNOWN) {
          ctx.fillStyle = "rgba(120,120,120,0.35)";
          ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
          ctx.fillStyle = "#d8d8d8";
        }
      }
    }

    // 激光扫描点：红色（RViz LaserScan 默认）
    if (showLaser) {
      ctx.fillStyle = "rgba(255,64,64,0.85)";
      for (let y = 1; y < GRID_MAP.height - 1; y++) {
        for (let x = 1; x < GRID_MAP.width - 1; x++) {
          const code = GRID_MAP.cells[y * GRID_MAP.width + x] ?? 0;
          if (code !== OCCUPIED) continue;
          // 只在占据格边缘撒扫描点，模拟雷达打在墙面上的回波
          const isEdge =
            (GRID_MAP.cells[y * GRID_MAP.width + x - 1] ?? 0) === 0 ||
            (GRID_MAP.cells[y * GRID_MAP.width + x + 1] ?? 0) === 0 ||
            (GRID_MAP.cells[(y - 1) * GRID_MAP.width + x] ?? 0) === 0 ||
            (GRID_MAP.cells[(y + 1) * GRID_MAP.width + x] ?? 0) === 0;
          if (isEdge && (x + y) % 2 === 0) {
            ctx.fillRect(x * cellPx, y * cellPx, 2, 2);
          }
        }
      }
    }

    // 禁入区：半透明红框（RViz 里常作为 costmap 的禁区图层）
    ctx.strokeStyle = "rgba(255,80,80,0.8)";
    ctx.fillStyle = "rgba(255,80,80,0.1)";
    ctx.lineWidth = 1;
    for (const zone of FORBIDDEN_ZONES) {
      const [zx, zy] = zone.cell;
      ctx.fillRect(zx * cellPx, zy * cellPx, zone.w * cellPx, zone.h * cellPx);
      ctx.strokeRect(zx * cellPx + 0.5, zy * cellPx + 0.5, zone.w * cellPx, zone.h * cellPx);
    }

    // 平台计划路径：青色（Global Plan）
    ctx.strokeStyle = "#38e0c8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    PLANNED_PATH.forEach(([x, y], index) => {
      const px = x * cellPx + cellPx / 2;
      const py = y * cellPx + cellPx / 2;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // 机器人实际路径：蓝色（Local Plan / 实际轨迹）
    if (showActualPath) {
      ctx.strokeStyle = "#4a9eff";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ACTUAL_PATH.forEach(([x, y], index) => {
        const px = x * cellPx + cellPx / 2;
        const py = y * cellPx + cellPx / 2;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // 巡检点：RViz 的 PoseArray 箭头
    for (const point of WAYPOINTS) {
      const px = point.cell[0] * cellPx + cellPx / 2;
      const py = point.cell[1] * cellPx + cellPx / 2;
      const active = point.state === "当前目标";
      ctx.save();
      ctx.translate(px, py);
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fillStyle = active ? "rgba(62,227,164,0.35)" : "rgba(62,227,164,0.14)";
      ctx.fill();
      ctx.strokeStyle = active ? "#3ee3a4" : "rgba(62,227,164,0.6)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = active ? "#eafff6" : "rgba(234,255,246,0.75)";
      ctx.font = "10px ui-monospace, Consolas, monospace";
      ctx.fillText(point.id, px + 8, py - 6);
    }

    // 当前位姿：绿色箭头（RViz RobotModel / Pose 的观感）
    const robot = POSE_TRACK.at(-1);
    if (robot) {
      const px = robot.cell[0] * cellPx + cellPx / 2;
      const py = robot.cell[1] * cellPx + cellPx / 2;
      ctx.save();
      ctx.translate(px, py);
      // 车体
      ctx.fillStyle = "#3ee3a4";
      ctx.fillRect(-5, -4, 10, 8);
      // 朝向箭头
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(14, 0);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#3ee3a4";
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(10, -4);
      ctx.lineTo(10, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 比例尺
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "11px ui-monospace, Consolas, monospace";
    const meterPx = meterCells * cellPx;
    ctx.fillRect(14, height - 22, meterPx, 3);
    ctx.fillText("1 m", 14, height - 28);
  }, [geometry, showActualPath, showLaser]);

  return (
    <canvas
      ref={ref}
      width={geometry.width}
      height={geometry.height}
      className="rviz__canvas"
      aria-label="占据栅格地图（内置演示渲染）"
    />
  );
}

export default function RvizView({
  stream,
  showActualPath = true,
  showLaser = true,
}: RvizViewProps) {
  const [live, setLive] = useState(false);
  const hasStream = Boolean(stream?.url);
  const hasImage = Boolean(stream?.image);
  /** 有 url 且用户点了切换 → 真实串流；否则有静态画面用静态画面；再否则内置渲染 */
  const usingStream = hasStream && live;

  return (
    <div className="rviz">
      <div className="rviz__frame">
        {usingStream && stream ? (
          stream.kind === "webrtc" ? (
            <video className="rviz__stream" src={stream.url} autoPlay muted playsInline />
          ) : (
            <img className="rviz__stream" src={stream.url} alt="RViz 串流画面" />
          )
        ) : hasImage && stream?.image ? (
          <img className="rviz__stream" src={stream.image} alt="RViz 建图界面" />
        ) : (
          <DemoRvizCanvas showActualPath={showActualPath} showLaser={showLaser} />
        )}
      </div>

      <div className="rviz__bar">
        <div className="rviz__layers">
          <span>
            <i className="is-map" />
            Map /map
          </span>
          <span>
            <i className="is-laser" />
            LaserScan /scan
          </span>
          <span>
            <i className="is-plan" />
            Global Plan
          </span>
          <span>
            <i className="is-actual" />
            Local Plan
          </span>
          <span>
            <i className="is-pose" />
            Pose
          </span>
        </div>

        <div className="rviz__source">
          <StatusChip
            text={usingStream ? "真实串流" : hasImage ? "RViz 画面" : "内置演示渲染"}
            tone={usingStream ? "ok" : "info"}
          />
          <em>
            {usingStream
              ? `${stream?.kind === "webrtc" ? "WebRTC" : "MJPEG"} · ${stream?.source ?? stream?.url}`
              : hasImage
                ? `静态参考画面 · ${stream?.source ?? ""}`
                : "数据来自占据栅格种子；接入 RViz 后切换到真实串流"}
          </em>
          <button
            type="button"
            className="btn"
            disabled={!hasStream}
            title={
              hasStream
                ? "切换到真实串流画面"
                : "未配置串流地址：在 Mapping.tsx 的 RVIZ_STREAM.url 填入后端地址即可"
            }
            onClick={() => setLive((value) => !value)}>
            <Icon name="layers" />
            {usingStream ? "切回参考画面" : "切换真实串流"}
          </button>
        </div>
      </div>
    </div>
  );
}
