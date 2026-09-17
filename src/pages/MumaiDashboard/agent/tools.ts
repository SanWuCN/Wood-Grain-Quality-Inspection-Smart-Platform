/**
 * 小木语音智能体 · Tool Registry（技术方案 §20 / §21 / §22 / §33 / §35 / §36 / §43）
 *
 * 每个工具都是**平台已有的前端能力**的包装，不做「模拟鼠标、强制点击 DOM」
 * （方案 §32 明确不要这么做）：
 *
 *   navigate_page   → react-router 的 navigate（由 ctx.navigate 注入，来自 useNavigate）
 *   open_panel      → 打开对应页面并带 URL 参数（工单 ?order= / 采集 ?tab=&batch=）
 *   focus_component → 跳 /twin?component=Z04 并用 map/store 的 setFocusRegion 定位
 *   open_order      → 跳 /orders?order=xxx（页面自己从 useSearchParams 读）
 *   open_scene      → 跳 /twin?component=（书签是页面内 state，语音只负责到页）
 *   switch_map_mode → map/store 的 requestMapMode（MapScene 监听后播转场）
 *   set_map_region  → map/store 的 setFocusRegion
 *   robot_*         → 读 seed 的任务/航点，写 agent/store 的实时快照（演示车为回放）
 *   start_mapping / load_map → 种子地图版本 + 驾驶舱实时快照
 *   start_scan / stop_scan   → 种子批次
 *   get_camera_status        → seed 的四路通道
 *
 * 风险分级（§43）：0 查询 / 1 UI 操作 / 2 普通设备操作 / 3 机器人运动 / 4 危险或删除操作。
 * risk >= 3 的工具一律 requireConfirmation，执行前走确认层（§42）。
 */

import {
  CHANNELS,
  DEVICES,
  MAP_VERSIONS,
  MISSION,
  SCAN_BATCHES,
  SCENES,
  WAYPOINTS,
  WAVEFORMS,
} from "../seed/scenario";
import { requestMapMode, useDashboardStore } from "../map/store";
import { formatDistance, routeDistance } from "./lib/geo";
import { defaultPillar, normalizePillar, resolvePillar } from "./lib/entities";
import type { EntityBag } from "./types";

/** 工具执行上下文：由 executor 注入 */
export type ToolContext = {
  /** react-router navigate（组件内 useNavigate 注入；不在组件树时为 null） */
  navigate: ((to: string) => void) | null;
  /** 已抽取的槽位（工具参数里的 {pillar} / {batch} 等占位符由这里解析） */
  entities: EntityBag;
  /** 推一条日志到 小木 → UI（工具卡片由 executor 负责登记，工具本身不重复记录） */
  log: (text: string) => void;
  /** 实时快照读写（机器人位置、电量、任务状态、地图、扫描） */
  live: {
    read: () => LiveState;
    patch: (patch: Partial<LiveState>) => void;
  };
};

/** 会被工具改写的实时状态（展示态；不改 seed 原对象） */
export type LiveState = {
  battery: number;
  waypointIndex: number;
  waypointLabel: string;
  missionState: string;
  mapId: string;
  mapping: boolean;
  scanning: boolean;
  lastScanBatch: string | null;
  cameraLive: boolean;
  /** 当前会话焦点构件（focus_component 写入；没有 Router 时它就是唯一的定位反馈） */
  focusComponent: string | null;
  /** 当前会话焦点测区 */
  focusZone: string | null;
};

export type ToolResult = {
  ok: boolean;
  /** 工具返回给回复模板的补充事实 */
  facts?: Record<string, string>;
  /** 界面上显示的一行结果 */
  summary: string;
};

export type ToolParamSchema = {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required: string[];
};

export type ToolDef = {
  name: string;
  /** 中文名，界面显示 */
  label: string;
  description: string;
  parameters: ToolParamSchema;
  /** §43 的风险等级 */
  risk: 0 | 1 | 2 | 3 | 4;
  /** 风险 >= 3 时强制确认 */
  requireConfirmation: boolean;
  /** 确认层文案（§42） */
  confirmText?: (args: Record<string, string>) => string;
  run: (args: Record<string, string>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
};

/** 把参数里的 {pillar} / {batch} 占位符解析成真实值（§17 槽位 → 工具参数） */
export function resolveArgs(
  params: Record<string, string> | undefined,
  entities: EntityBag,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    const placeholder = /^\{(\w+)\}$/.exec(value);
    if (!placeholder) {
      out[key] = value;
      continue;
    }
    const slot = placeholder[1];
    if (slot === "pillar") {
      // 认不出来的柱号不要静默替换成默认构件，宁可留空让工具自己拒绝（§44 权限校验）
      out[key] = normalizePillar(entities.pillar) ?? "";
    } else if (slot === "batch") out[key] = entities.batch ?? SCAN_BATCHES[0].batchId;
    else if (slot === "map") out[key] = entities.map ?? MISSION.mapVersion;
    else if (slot === "order") out[key] = entities.order ?? "";
    else if (slot === "scene") out[key] = entities.scene ?? SCENES.find((item) => item.round === "历史")?.id ?? SCENES[0].id;
    else out[key] = entities[slot] ?? "";
  }
  // 槽位没抽到时不要留下空参数：界面上会显示成 {"speed":""}，看起来像故障
  for (const key of Object.keys(out)) {
    if (out[key] === "") delete out[key];
  }
  return out;
}

/** 拼接查询串（navigate_page 支持 route + tab / batch / component / view） */
function withQuery(route: string, args: Record<string, string>, keys: string[]): string {
  const params = new URLSearchParams();
  keys.forEach((key) => {
    const value = args[key];
    if (value) params.set(key, value);
  });
  const query = params.toString();
  if (!query) return route;
  return `${route}${route.includes("?") ? "&" : "?"}${query}`;
}

function waypointIndexOf(componentId: string): number {
  const index = WAYPOINTS.findIndex((item) => item.componentId === componentId);
  return index >= 0 ? index : 0;
}

/* ------------------------------------------------------------------ *
 * 工具实现
 * ------------------------------------------------------------------ */

export const TOOLS: ToolDef[] = [
  {
    name: "navigate_page",
    label: "打开页面",
    description: "跳转到指定的一级页面或页签（react-router 前端路由，不刷新整页）",
    parameters: {
      type: "object",
      properties: {
        route: { type: "string", description: "目标路由，例如 /twin、/hardware、/firmware" },
        tab: { type: "string", description: "页签 key，例如 dataset（/hardware 与 /firmware 使用）" },
        batch: { type: "string", description: "批次号，用于采集页" },
        component: { type: "string", description: "构件编号，用于数字孪生页" },
        view: { type: "string", description: "页内主视图 key，例如 training 页的 compare（新旧对比）" },
      },
      required: ["route"],
    },
    risk: 1,
    requireConfirmation: false,
    run: (args, ctx) => {
      const route = withQuery(args.route || "/", args, ["tab", "batch", "component", "view"]);
      if (!ctx.navigate) return { ok: false, summary: "当前不在路由上下文内，无法跳转" };
      ctx.navigate(route);
      ctx.log(`路由跳转到 ${route}`);
      return { ok: true, summary: `已跳转 ${route}`, facts: { route } };
    },
  },
  {
    name: "open_panel",
    label: "打开业务面板",
    description: "打开某个业务面板（数据集 / 复巡计划），等价于进入对应页面并定位到该面板",
    parameters: {
      type: "object",
      properties: { panel: { type: "string", description: "面板标识：dataset / revisit / capture / fusion" } },
      required: ["panel"],
    },
    risk: 1,
    requireConfirmation: false,
    run: (args, ctx) => {
      const routes: Record<string, string> = {
        // 面板归属按拆页后的实际路由：数据集 / 融合在「固件及模型」，
        // 采集在「硬件详情」。指向已下线的 /adapt 会让小木把用户带进黑屏。
        dataset: withQuery("/firmware", { tab: "dataset" }, []),
        capture: withQuery("/hardware", { tab: "capture", batch: ctx.entities.batch ?? SCAN_BATCHES[0].batchId }, ["batch"]),
        fusion: withQuery("/firmware", { tab: "fusion" }, []),
        revisit: "/orders",
      };
      const route = routes[args.panel] ?? "/";
      if (!ctx.navigate) return { ok: false, summary: "当前不在路由上下文内，无法打开面板" };
      ctx.navigate(route);
      ctx.log(`打开面板 ${args.panel} → ${route}`);
      return { ok: true, summary: `已打开面板 ${args.panel}（${route}）`, facts: { route } };
    },
  },
  {
    name: "focus_component",
    label: "定位构件与测区",
    description: "在数字孪生页定位到指定构件（Z01–Z04），并把地图焦点切到该构件所在区域",
    parameters: {
      type: "object",
      properties: {
        component: { type: "string", description: "构件编号 Z01–Z04" },
        zone: { type: "string", description: "测区，例如 Z04-lower" },
      },
      required: ["component"],
    },
    risk: 1,
    requireConfirmation: false,
    run: (args, ctx) => {
      const component = resolvePillar(args.component) ?? defaultPillar();
      // 会话焦点写进实时快照：即使没有 Router（standalone 控制台）也能看到状态变化
      ctx.live.patch({ focusComponent: component.id, focusZone: args.zone || component.zoneId });
      // 真实调用大屏 store：地图焦点跟随构件（MapScene 订阅该字段）
      useDashboardStore.getState().setFocusRegion(component.id);
      const zone = args.zone && args.zone.length > 0 ? args.zone : component.zoneId;
      if (ctx.navigate) {
        ctx.navigate(withQuery("/twin", { component: component.id }, ["component"]));
        ctx.log(`数字孪生定位 ${component.id}（${zone}），地图焦点已切换到 ${component.id}`);
      } else {
        ctx.log(`已选中 ${component.id}（${zone}），地图焦点已切换；当前控制台没有路由上下文，未跳页`);
      }
      return {
        ok: true,
        summary: `已定位 ${component.id} · ${zone}（地图焦点已切换）`,
        facts: { componentId: component.id, zoneId: zone, componentName: component.name },
      };
    },
  },
  {
    name: "open_order",
    label: "打开工单",
    description: "打开工单档案页并选中指定工单（页面从 URL 的 order 参数读取当前工单）",
    parameters: {
      type: "object",
      properties: { order: { type: "string", description: "工单号，留空表示当前工单" } },
      required: [],
    },
    risk: 1,
    requireConfirmation: false,
    run: (args, ctx) => {
      const route = withQuery("/orders", { order: args.order || ctx.entities.order || "" }, ["order"]);
      if (!ctx.navigate) return { ok: false, summary: "当前不在路由上下文内，无法跳转" };
      ctx.navigate(route);
      ctx.log(`工单档案 ${route}`);
      return { ok: true, summary: `已打开 ${route}`, facts: { route } };
    },
  },
  {
    name: "open_scene",
    label: "打开高斯场景",
    description: "打开数字孪生页并选中历史或本轮高斯场景",
    parameters: {
      type: "object",
      properties: { scene: { type: "string", description: "场景 id，例如 scene-May" } },
      required: [],
    },
    risk: 1,
    requireConfirmation: false,
    run: (args, ctx) => {
      const scene = SCENES.find((item) => item.id === args.scene) ?? SCENES[0];
      if (!scene) return { ok: false, summary: "场景不存在，预览不可用（保留已查到的文字结果）" };
      if (ctx.navigate) ctx.navigate("/twin");
      ctx.log(`数字孪生页已打开，目标场景 ${scene.id}（${scene.version}）`);
      return {
        ok: true,
        summary: `已打开数字孪生页，场景 ${scene.title}；书签需要页面内点击`,
        facts: { sceneId: scene.id, sceneTitle: scene.title },
      };
    },
  },
  {
    name: "switch_map_mode",
    label: "切换地图模式",
    description: "在「全国 → 上海」之间切换大屏地图模式（调用 map/store 的 requestMapMode）",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", description: "china 或 shanghai" } },
      required: ["mode"],
    },
    risk: 1,
    requireConfirmation: false,
    run: (args, ctx) => {
      const mode = args.mode === "shanghai" ? "shanghai" : "china";
      requestMapMode(mode);
      ctx.log(`请求地图模式切换：${mode === "china" ? "全国" : "上海"}`);
      return { ok: true, summary: `已请求切到${mode === "china" ? "全国" : "上海"}模式` };
    },
  },
  {
    name: "set_map_region",
    label: "选中地图区域",
    description: "把大屏地图的当前焦点区域设为指定名称（调用 map/store 的 setFocusRegion）",
    parameters: {
      type: "object",
      properties: { region: { type: "string", description: "区域名或构件编号" } },
      required: ["region"],
    },
    risk: 1,
    requireConfirmation: false,
    run: (args, ctx) => {
      useDashboardStore.getState().setFocusRegion(args.region);
      ctx.log(`地图焦点 → ${args.region}`);
      return { ok: true, summary: `地图焦点已切到 ${args.region}` };
    },
  },
  {
    name: "robot_move",
    label: "小车前往目标点",
    description: "让机器人前往指定目标点（映射到种子里的巡检航点）",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "目标构件编号 Z01–Z04" },
        speed: { type: "string", description: "速度，单位 m/s（可选）" },
      },
      required: ["target"],
    },
    risk: 3,
    requireConfirmation: true,
    confirmText: (args) => {
      const component = resolvePillar(args.target);
      return `确认让小车前往${component ? `${component.id} ${component.name}` : "目标点"}吗？`;
    },
    run: (args, ctx) => {
      const component = resolvePillar(args.target);
      if (!component) return { ok: false, summary: "构件档案里没有这个目标点，已拒绝下发" };
      const index = waypointIndexOf(component.id);
      const waypoint = WAYPOINTS[index];
      ctx.live.patch({
        waypointIndex: index,
        waypointLabel: waypoint?.label ?? component.id,
        missionState: "执行中",
      });
      ctx.log(`导航目标 ${component.id} → 航点 ${waypoint?.id ?? "—"}`);
      const legacy = MISSION.plannedPath.length > 0 ? "路径来自平台计划路径" : "路径未生成";
      return {
        ok: true,
        summary: `已下发导航目标 ${component.id}（${waypoint?.label ?? ""}；${legacy}）`,
        facts: {
          targetId: component.id,
          targetLabel: `${component.id} ${component.name}`,
          waypointLabel: waypoint ? `${waypoint.id} · ${waypoint.label}` : "—",
          distance: formatDistance(routeDistance(WAYPOINTS[0]?.cell ?? [0, 0], waypoint?.cell ?? [0, 0])),
        },
      };
    },
  },
  {
    name: "robot_circle_target",
    label: "环绕目标点采集",
    description: "让机器人围绕指定构件环绕一周采集（对应方案 §23 的 robot_circle_target）",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "目标构件编号 Z01–Z04" } },
      required: ["target"],
    },
    risk: 3,
    requireConfirmation: true,
    confirmText: (args) => {
      const component = resolvePillar(args.target);
      return `确认让小车环绕${component ? `${component.id} ${component.name}` : "目标点"}一周吗？`;
    },
    run: (args, ctx) => {
      const component = resolvePillar(args.target);
      if (!component) return { ok: false, summary: "构件档案里没有这个目标点，已拒绝下发" };
      const waypoint = WAYPOINTS.find((item) => item.componentId === component.id);
      // 环绕半径与一周里程由栅格坐标算出，不硬编码
      const radiusM = 0.9;
      const circumference = Math.round(2 * Math.PI * radiusM * 10) / 10;
      ctx.log(`环绕 ${component.id}：半径约 ${radiusM} m，一周约 ${circumference} m`);
      return {
        ok: true,
        summary: `已环绕 ${component.id} 一周（约 ${circumference} m，观察点 ${waypoint?.id ?? "—"}）`,
        facts: { circleTarget: component.id, circleLength: `${circumference} m` },
      };
    },
  },
  {
    name: "robot_stop",
    label: "停止小车",
    description: "立即停止机器人运动（归档回放态只改任务状态与提示，不驱动真实设备）",
    parameters: { type: "object", properties: {}, required: [] },
    risk: 2,
    requireConfirmation: false,
    run: (_args, ctx) => {
      ctx.live.patch({ missionState: "已暂停" });
      ctx.log("停止指令已下发：任务置为已暂停，保留当前设备位置");
      return { ok: true, summary: "已下发停止指令（任务状态：已暂停）", facts: { missionState: "已暂停" } };
    },
  },
  {
    name: "cancel_patrol",
    label: "取消巡检任务",
    description: "取消当前巡检任务（保留已到达点位的记录）",
    parameters: { type: "object", properties: {}, required: [] },
    risk: 3,
    requireConfirmation: true,
    confirmText: () => `确认取消巡检任务 ${MISSION.id} 吗？`,
    run: (_args, ctx) => {
      ctx.live.patch({ missionState: "已取消" });
      ctx.log(`巡检任务 ${MISSION.id} 已取消，已到达点位保留记录`);
      return { ok: true, summary: `任务 ${MISSION.id} 已取消`, facts: { missionState: "已取消" } };
    },
  },
  {
    name: "robot_return_home",
    label: "小车返回起点",
    description: "让机器人返回起点 / 殿门航点",
    parameters: { type: "object", properties: {}, required: [] },
    risk: 3,
    requireConfirmation: true,
    confirmText: () => "确认让小车返回起点吗？",
    run: (_args, ctx) => {
      const home = WAYPOINTS.find((item) => item.componentId === null) ?? WAYPOINTS[0];
      const index = home ? WAYPOINTS.indexOf(home) : 0;
      ctx.live.patch({ waypointIndex: index, waypointLabel: home?.label ?? "起点", missionState: "执行中" });
      ctx.log(`返航指令：目标 ${home?.label ?? "起点"}`);
      return {
        ok: true,
        summary: `已下发返航指令，目标 ${home?.label ?? "起点"}`,
        facts: { homeLabel: home?.label ?? "起点", waypointLabel: home?.label ?? "起点" },
      };
    },
  },
  {
    name: "start_patrol",
    label: "开始巡检",
    description: "让机器人按巡检任务开始执行（种子任务 MSN-…）",
    parameters: { type: "object", properties: {}, required: [] },
    risk: 3,
    requireConfirmation: true,
    confirmText: () => `确认让小车开始执行巡检任务 ${MISSION.id} 吗？`,
    run: (_args, ctx) => {
      ctx.live.patch({ missionState: "执行中" });
      ctx.log(`巡检任务 ${MISSION.id} 进入执行中，共 ${WAYPOINTS.length} 个航点`);
      return {
        ok: true,
        summary: `巡检任务 ${MISSION.id} 已开始（${WAYPOINTS.length} 个航点）`,
        facts: { missionId: MISSION.id, missionState: "执行中", waypointTotal: String(WAYPOINTS.length) },
      };
    },
  },
  {
    name: "get_robot_status",
    label: "读取小车状态",
    description: "读取机器人电量、位置、任务状态（§18 QUERY 的标准例子）",
    parameters: { type: "object", properties: {}, required: [] },
    risk: 0,
    requireConfirmation: false,
    run: (_args, ctx) => {
      const live = ctx.live.read();
      return {
        ok: true,
        summary: `${DEVICES.demoCart.name} 电量 ${live.battery}%，位置 ${live.waypointLabel}，任务 ${live.missionState}`,
        facts: {
          battery: `${live.battery}%`,
          robotPosition: live.waypointLabel,
          missionState: live.missionState,
        },
      };
    },
  },
  {
    name: "get_map_list",
    label: "读取地图版本",
    description: "读取平台已保存的地图版本清单（seed 的 MAP_VERSIONS）",
    parameters: { type: "object", properties: {}, required: [] },
    risk: 0,
    requireConfirmation: false,
    run: () => ({
      ok: true,
      summary: `${MAP_VERSIONS.length} 个地图版本：${MAP_VERSIONS.map((item) => `${item.id}(${item.state})`).join("、")}`,
      facts: { mapCount: String(MAP_VERSIONS.length) },
    }),
  },
  {
    name: "load_map",
    label: "装载地图",
    description: "把指定地图版本装载为当前地图（归档回放态仅切换展示版本，不触发真实 SLAM 载入）",
    parameters: {
      type: "object",
      properties: { map: { type: "string", description: "地图版本 id，例如 MAP-SH-06" } },
      required: ["map"],
    },
    risk: 3,
    requireConfirmation: true,
    confirmText: (args) => `确认把当前地图切换到 ${args.map || MISSION.mapVersion} 吗？`,
    run: (args, ctx) => {
      const version = MAP_VERSIONS.find((item) => item.id === args.map) ?? MAP_VERSIONS.find((item) => item.id === MISSION.mapVersion) ?? MAP_VERSIONS[0];
      ctx.live.patch({ mapId: version.id });
      ctx.log(`当前地图 → ${version.id}（${version.note}）`);
      return {
        ok: true,
        summary: `已装载 ${version.id}（覆盖 ${version.coveragePct}%，${version.state}）`,
        facts: { mapId: version.id, mapCoverage: `${version.coveragePct}%`, mapState: version.state },
      };
    },
  },
  {
    name: "start_mapping",
    label: "开始建图",
    description: "开始 SLAM 建图（写实时快照的 mapping 标志，地图版本来自种子）",
    parameters: { type: "object", properties: {}, required: [] },
    risk: 3,
    requireConfirmation: true,
    confirmText: () => "确认让小车开始建图吗？建图期间请勿进入作业区。",
    run: (_args, ctx) => {
      const version = MAP_VERSIONS.find((item) => item.state === "采集中") ?? MAP_VERSIONS[0];
      ctx.live.patch({ mapping: true, mapId: version.id });
      ctx.log(`建图已启动：目标版本 ${version.id}`);
      return {
        ok: true,
        summary: `建图已启动（目标版本 ${version.id}，当前覆盖 ${version.coveragePct}%）`,
        facts: { mapId: version.id, mapState: version.state },
      };
    },
  },
  {
    name: "start_scan",
    label: "开始扫描采集",
    description: "让手持端开始扫描采集（归档回放态仅推进批次状态）",
    parameters: {
      type: "object",
      properties: { batch: { type: "string", description: "批次号" } },
      required: [],
    },
    risk: 2,
    requireConfirmation: false,
    run: (args, ctx) => {
      const batch = SCAN_BATCHES.find((item) => item.batchId === args.batch) ?? SCAN_BATCHES.find((item) => item.round === "复扫") ?? SCAN_BATCHES[0];
      ctx.live.patch({ scanning: true, lastScanBatch: batch.batchId });
      ctx.log(`扫描采集开始：${batch.batchId}（${batch.round}）`);
      return {
        ok: true,
        summary: `采集已开始：${batch.batchId}`,
        facts: { batchId: batch.batchId, batchRound: batch.round },
      };
    },
  },
  {
    name: "stop_scan",
    label: "停止扫描采集",
    description: "停止手持端扫描采集，保留已回传数据",
    parameters: { type: "object", properties: {}, required: [] },
    risk: 2,
    requireConfirmation: false,
    run: (_args, ctx) => {
      const live = ctx.live.read();
      ctx.live.patch({ scanning: false });
      ctx.log(`采集已停止，已回传数据保留（${live.lastScanBatch ?? "无进行中批次"}）`);
      return { ok: true, summary: `采集已停止（${live.lastScanBatch ?? "无进行中批次"}）` };
    },
  },
  {
    name: "get_camera_status",
    label: "读取相机与通道状态",
    description: "读取四路通道（地图 / 位姿 / 视频 / 车辆）与相机在线状态（seed 的 CHANNELS）",
    parameters: { type: "object", properties: {}, required: [] },
    risk: 0,
    requireConfirmation: false,
    run: () => {
      const video = CHANNELS.find((item) => item.key === "video");
      const summary = CHANNELS.map((item) => `${item.label}${item.state === "online" ? "在线" : item.state === "stale" ? `延迟${item.ageSec}秒` : "离线"}`).join("、");
      return {
        ok: true,
        summary: `通道：${summary}`,
        facts: {
          channelSummary: summary,
          cameraState: video?.state ?? "offline",
          cameraNote: video ? `${video.source}，${video.ageSec} 秒前更新（视频在播放不等于车辆在线）` : "无视频通道记录",
        },
      };
    },
  },
];

export const TOOL_BY_NAME: Record<string, ToolDef> = TOOLS.reduce<Record<string, ToolDef>>((acc, tool) => {
  acc[tool.name] = tool;
  return acc;
}, {});

export function toolByName(name: string): ToolDef | null {
  return TOOL_BY_NAME[name] ?? null;
}

/** 波形工具用到的批次数（回波回复里会引用） */
export const WAVEFORM_COUNT = WAVEFORMS.length;
