/**
 * 小车参数带（建图巡航页底部一条）
 *
 * 这一块是**只读的车况**，数据全部取自 `/api/state`（平台服务端已判过新鲜度），
 * 一条规则贯穿始终：**缺失就是缺失**。
 *
 * 文档 §2 / §8 反复强调这一点，所以这里：
 *   · `null` 一律渲染成「—」，绝不写成 0（「没有数据」和「读到 0」是两件事：
 *     电压 0 V 和没有电压传感器，在运维眼里完全不同）；
 *   · 每个传感器各自标在线/离线，不因为别的通道正常就把它算作正常
 *     （文档 §2：「不能根据视频正在播放判断车辆在线」）；
 *   · 单位一律写出来（m/s、rad/s、°、V、Hz、℃、%），不写「速度 0.2」这种没头没尾的数。
 *
 * 分组与文档第 2、8 节的状态字段一一对应，不合并、不改名，方便和车上页面对照排查。
 */

import type { ReactNode } from "react";
import { batteryPercent, isCharging, voltageText, type CartState } from "./api";
import { missionStateText, modeStateText } from "./geometry";

const DASH = "—";

/** 数值格式化：null / 非有限值 → 「—」，其余按位数显示 */
function num(value: number | null | undefined, digits = 2, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(digits)}${suffix}`;
}

function age(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(1)} s`;
}

type Cell = { label: string; value: ReactNode; tone?: "ok" | "warn" | "danger" | "muted"; note?: string };

function Group({ title, extra, cells }: { title: string; extra?: ReactNode; cells: Cell[] }) {
  return (
    <section className="cart-param">
      <header>
        <h4>{title}</h4>
        {extra}
      </header>
      <dl>
        {cells.map((cell) => (
          <div key={cell.label} className={cell.tone ? `is-${cell.tone}` : undefined}>
            <dt>{cell.label}</dt>
            <dd title={cell.note}>{cell.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 通道状态灯：online / offline 用词与文档一致，不用「正常/异常」这种含糊说法 */
function ChannelChip({ state: value, label }: { state?: string | null; label: string }) {
  const online = value === "online";
  return (
    <span className={`cart-param__chip ${online ? "is-ok" : value ? "is-danger" : "is-muted"}`}>
      <i />
      {label}
      {value ? ` · ${online ? "在线" : "离线"}` : ` · ${DASH}`}
    </span>
  );
}

export default function ParameterStrip({ state }: { state: CartState | null }) {
  if (!state) {
    return (
      <div className="cart-params cart-params--empty">
        <p>无状态数据</p>
      </div>
    );
  }

  const pose = state.pose;
  const velocity = state.velocity;
  const odom = state.chassis?.odometry;
  const imu = state.imu;
  const battery = state.battery;
  const metrics = state.metrics;
  const mission = state.mission;
  const streams = state.streams;

  const charging = isCharging(state);
  const percent = batteryPercent(state);

  return (
    <div className="cart-params">
      <Group
        title="任务与模式"
        extra={
          <span className={`cart-param__chip ${state.mode === "idle" ? "is-muted" : "is-ok"}`}>
            <i />
            {modeStateText(state.mode)}
          </span>
        }
        cells={[
          { label: "当前模式", value: modeStateText(state.mode) },
          { label: "切换目标", value: state.transition ? modeStateText(state.transition) : DASH },
          { label: "模式计时", value: state.uptime_s === undefined ? DASH : `${Math.floor(state.uptime_s / 60)} 分 ${Math.round(state.uptime_s % 60)} 秒` },
          { label: "任务状态", value: missionStateText(mission?.state) },
          { label: "航点下标", value: mission ? `${mission.index} / ${Math.max(0, mission.points.length - 1)}` : DASH },
          { label: "已完成循环", value: mission ? `${mission.cycle} 圈` : DASH },
          { label: "剩余距离", value: num(mission?.distance_remaining, 2, " m") },
          { label: "巡航限速", value: num(state.speed_mps, 2, " m/s") },
          { label: "速度上限", value: num(state.max_speed_mps, 2, " m/s") },
          { label: "已加载地图", value: state.active_map_id ?? DASH },
          { label: "错误", value: state.error ?? DASH, tone: state.error ? "danger" : undefined },
          { label: "最近错误", value: state.last_error ?? DASH, tone: state.last_error ? "warn" : undefined },
        ]}
      />

      <Group
        title="位姿与运动"
        cells={[
          {
            label: "map 位姿 x",
            value: pose ? num(pose.x, 3, " m") : DASH,
          },
          { label: "map 位姿 y", value: pose ? num(pose.y, 3, " m") : DASH },
          { label: "车头朝向 yaw", value: pose ? num((pose.yaw * 180) / Math.PI, 1, "°") : DASH },
          { label: "线速度", value: num(velocity?.linear_mps, 3, " m/s") },
          { label: "角速度", value: num(velocity?.angular_rps, 3, " rad/s") },
          {
            label: "指令线速度",
            value: num(state.chassis?.commanded_velocity?.linear_mps, 3, " m/s"),
          },
          { label: "指令角速度", value: num(state.chassis?.commanded_velocity?.angular_rps, 3, " rad/s") },
          { label: "指令时效", value: age(state.chassis?.command_age_s) },
          { label: "里程计 x", value: odom?.pose ? num(odom.pose.x, 3, " m") : DASH },
          { label: "里程计 y", value: odom?.pose ? num(odom.pose.y, 3, " m") : DASH },
          { label: "里程计 yaw", value: odom?.pose ? num((odom.pose.yaw * 180) / Math.PI, 1, "°") : DASH },
          { label: "里程计横向速度", value: num(odom?.lateral_mps, 3, " m/s") },
          { label: "里程计坐标系", value: odom?.frame_id ?? DASH },
        ]}
      />

      <Group
        title="传感器"
        extra={
          <span className="cart-param__chips">
            <ChannelChip state={state.lidar?.state} label="雷达" />
            <ChannelChip state={state.camera?.state} label="相机" />
            <ChannelChip state={state.chassis?.state} label="底盘" />
          </span>
        }
        cells={[
          { label: "雷达频率", value: num(state.lidar?.hz, 1, " Hz") },
          { label: "雷达数据年龄", value: age(state.lidar?.age_s) },
          { label: "相机输出帧率", value: num(state.camera?.fps, 1, " fps") },
          { label: "相机数据年龄", value: age(state.camera?.age_s) },
          {
            label: "相机分辨率",
            value: state.camera?.size ? `${state.camera.size.width}×${state.camera.size.height}` : DASH,
          },
          { label: "IMU 横滚 roll", value: num(imu?.roll_deg, 2, "°") },
          { label: "IMU 俯仰 pitch", value: num(imu?.pitch_deg, 2, "°") },
          { label: "IMU 航向 yaw", value: num(imu?.yaw_deg, 2, "°") },
          { label: "IMU 角速度 z", value: num(imu?.angular_velocity?.z, 4, " rad/s") },
          { label: "IMU 加速度 z", value: num(imu?.linear_acceleration?.z, 3, " m/s²") },
          { label: "底盘型号", value: state.chassis?.model ?? DASH },
          { label: "驱动形式", value: state.chassis?.drive_type ?? DASH },
          { label: "底盘数据年龄", value: age(state.chassis?.age_s) },
        ]}
      />

      <Group
        title="电源与主机"
        cells={[
          {
            label: "电池电压",
            // 充电时电压被充电器抬高，读数没有参考意义 —— 直接显示「充电中」
            value: voltageText(state),
            tone: charging ? "warn" : undefined,
          },
          {
            label: "剩余电量",
            /*
              本地按 3S 锂电池的电压曲线推算（小车没有库仑计，只给电压）。
              界面上不写「估算」二字，但参数带标题里的口径说明已经交代过；
              充电时不给数字，因为此时的电压不是开路电压。
            */
            value: charging ? "充电中" : percent === null ? DASH : `${percent}%`,
            tone: charging ? "warn" : percent !== null && percent <= 20 ? "danger" : undefined,
          },
          { label: "充电电流", value: num(battery?.charging_current_a, 2, " A") },
          { label: "电池通道", value: battery?.state ?? DASH },
          { label: "电压数据年龄", value: age(battery?.age_s) },
          { label: "CPU", value: num(metrics?.cpu_percent, 1, " %") },
          { label: "内存", value: num(metrics?.memory_percent, 1, " %") },
          { label: "温度", value: num(metrics?.temperature_c, 1, " ℃") },
        ]}
      />

      <Group
        title="视频"
        extra={
          <span className="cart-param__chips">
            <ChannelChip state={streams?.rviz_state} label="RViz 画面" />
            <ChannelChip state={state.platform?.state === "online" ? "online" : state.platform?.state} label="平台上报" />
          </span>
        }
        cells={[
          { label: "RViz 画面通道", value: streams?.rviz_state ?? DASH },
          { label: "RViz RTMP", value: streams?.rtmp?.rviz ?? DASH },
          { label: "摄像头 RTMP", value: streams?.rtmp?.camera ?? DASH },
          { label: "状态协议版本", value: state.schema_version ?? DASH },
          { label: "数据形态", value: state.simulated ? "演示（--simulate）" : "实车", tone: state.simulated ? "warn" : "ok" },
          {
            label: "状态采样时刻",
            value: state.sampled_at ? new Date(state.sampled_at * 1000).toLocaleTimeString("zh-CN", { hour12: false }) : DASH,
          },
          { label: "建图点数（雷达抽样）", value: `${state.scan_points?.length ?? 0} 点` },
          { label: "规划路径点数", value: `${state.path?.length ?? 0} 点` },
        ]}
      />
    </div>
  );
}
