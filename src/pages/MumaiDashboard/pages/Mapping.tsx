/**
 * 建图巡航（`/mapping`）—— 平台对这台小车的全部操作面
 *
 * 这一页是**照着《木脉智检 · 小车端接口 v1.0》重做的**，取代原来那份用种子数据
 * 拼出来的「建图巡检」示意页。三条口径写在最前面，后面每一处都照它写：
 *
 *   1. **只有两个功能：建图、巡航。** 页面顶部一个模式开关，左边栏随之换内容，
 *      不做「巡检点位」「四柱构件」「禁入区」这些车上没有的概念 ——
 *      那些是平台其它页面的业务对象，不是这台车的能力。
 *   2. **真实数据，不编。** 地图是 `/api/map.png` 的栅格图，雷达点是
 *      `scan_points`，路径是真实 Nav2 规划结果，位姿是 `pose`，
 *      「屏幕画面」是小车 Xvfb 上那张 RViz 的 MJPEG，「现场视频」是摄像头 MJPEG。
 *      没有数据的通道就显示离线并说明，不用示意图顶替。
 *   3. **状态与动作分开。** 所有动作走 `/api/cart/action/*`（平台服务端带令牌
 *      转发），`ok:true` 只代表「这次操作被接收」，最终结果一律看 WS 推来的
 *      `mission.state` 与 `mode`（文档 §1 与 §5 反复强调这一点）。
 *
 * 交互上的一处取舍：地图下方的「屏幕画面」是**并排参考**，不是坐标来源。
 * 文档 §3 明确「不能直接把 RViz 视频像素当成世界坐标」，所以点图取点只在
 * 栅格地图这一层做，两套坐标系互不换算。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMumai } from "../context";
import { permissionHint } from "../auth";
import { Panel } from "../Panel";
import { Btn, Modal, PermNote, StateBlock, StatusChip } from "../ui";
import { apiRequest, isApiError } from "../api/client";
import { missions, useSharedStore } from "../store/shared";
import { acceptCruiseMission, activeCruiseMission, cancelCruiseMission, completeCruiseMission, cruiseRevisionOf } from "../store/cruise";
import { CruiseTaskBanner } from "./cart/CruiseTaskBanner";
/* 「通道巡查」按钮与 ⑨ 那一轮弹的是同一个窗口（剧本 §102） */
import { CHANNEL_PATROL_ROUND_NO } from "../agent/demoActions";
import { openDemoSurface } from "../agent/demoSurfaceAction";
import MapCanvas, { type MapCanvasMode } from "./cart/MapCanvas";
import ParameterStrip from "./cart/ParameterStrip";
import { DEFAULT_VIEW, fitView, missionStateText, type MapView } from "./cart/geometry";
import {
  cartApi,
  cartErrorText,
  liveMapUrl,
  newRequestId,
  savedMapPreviewUrl,
  sourceLabel,
  streamAspectRatio,
  streamUrl,
  voltageText,
  useCartLive,
  useStreamSize,
  type CartPose,
  type CartRoute,
  type CartSavedMap,
  type CartState,
} from "./cart/api";

/** 需求里的两个功能，页面的一切都围绕它们 */
type WorkMode = "mapping" | "cruise";
/** 中间画面的三块内容：栅格地图 / RViz 屏幕画面 / 现场摄像头 */
type WatchTab = "map" | "screen" | "both";

const MODE_COPY: Record<WorkMode, { label: string; hint: string }> = {
  mapping: { label: "建图", hint: "启动 gmapping，边走边建，完成后保存为地图版本" },
  cruise: { label: "巡航", hint: "加载地图 → 定位 → 编航点 → 预览 → 开始" },
};

/** 地图名称默认值：接口要求 1–40 字，这里给一个能直接用的 */
function defaultMapName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `一层大厅 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function formatTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 巡航速度允许区间（文档 §5：0.05–0.35 m/s；0 不是停止指令） */
const SPEED_MIN = 0.05;
const SPEED_MAX = 0.35;

export default function Mapping() {
  const { toast, pushEvent, can, sharedSessionId } = useMumai();
  const navigate = useNavigate();

  const cart = useCartLive({ sessionId: sharedSessionId });
  const state = cart.state;

  /* ---- 页面自身的状态（都只影响这一屏，不进共享会话） ---- */
  const [mode, setMode] = useState<WorkMode>("mapping");
  const [tab, setTab] = useState<WatchTab>("map");
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  const [mapName, setMapName] = useState(defaultMapName);
  const [savedMaps, setSavedMaps] = useState<CartSavedMap[]>([]);
  const [routes, setRoutes] = useState<CartRoute[]>([]);
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [lastAction, setLastAction] = useState<{ at: number; text: string; tone: "ok" | "warn" | "danger" } | null>(null);
  const [params, setParams] = useSearchParams();

  /*
    两路视频的原生输出尺寸：小车状态里只有摄像头的 size，RViz 那一路没有，
    所以各探一帧出来。画面按原生比例显示 —— 比例对不上才会出现黑边。
  */
  const rvizSize = useStreamSize("rviz", tab !== "map");
  const cameraSize = useStreamSize("camera", true);
  const rvizRatio = streamAspectRatio(state, "rviz", rvizSize);
  /** 数值版比例：窗口尺寸要拿它算，探测未完成时用 RViz 的常见输出比例兜底 */
  const rvizRatioSafe = useMemo(() => {
    const [w, h] = rvizRatio.split("/").map((part) => Number(part.trim()));
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h;
    return 694 / 434;
  }, [rvizRatio]);
  const cameraRatio = streamAspectRatio(state, "camera", cameraSize);

  /*
    屏幕画面的窗口尺寸：**按 RViz 画面的原始比例，尽量占满舞台的高度**。
      · 比例是定死的（探测到的原生宽高比），所以窗口只能整体缩放，不会被压扁；
      · 高度优先 —— 舞台有多高就用多高，宽度按比例反推；
      · 宽度不够时按宽度反推（两者取小）。
    这就是「优先保证 RViz 窗口尽量大」的落点：不是给它一个固定像素，
    而是让它跟着可用空间按固定比例长到最大。
  */
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const rvizBox = useMemo(() => {
    // 采样尺寸只用来定**比例**，不用来锁尺寸：这一块窗口按舞台可用空间
    // 等比放到最大 —— 容器变宽变高，它就跟着长大，永远填满可用区域。
    const ratio = rvizRatioSafe;
    if (!ratio || !stage.width || !stage.height) return null;
    const width = Math.round(Math.min(stage.width, stage.height * ratio));
    return { width, height: Math.round(width / ratio) };
  }, [rvizRatioSafe, stage.height, stage.width]);


  /* 巡航草稿：航点、模式、速度。**刷新页面不丢**，但绝不自动下发（文档 §5 最后一段） */
  const [waypoints, setWaypoints] = useState<CartPose[]>([]);
  const [routeMode, setRouteMode] = useState<"single" | "multi" | "loop">("multi");
  const [speed, setSpeed] = useState(0.2);
  const [selected, setSelected] = useState<number | null>(null);
  const [targetIndex, setTargetIndex] = useState<number | null>(null);
  const [locating, setLocating] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  /** 上一次预览的结论：点数或错误码。留在页面上，不靠会消失的 toast */
  const [previewNote, setPreviewNote] = useState<{ tone: "ok" | "warn" | "danger"; text: string } | null>(null);

  /* 草稿存本地：换页/刷新回来还能接着编，但**不会**因此自动开始巡航 */
  const draftKey = `mumai.cart.draft.${state?.device_id ?? "car"}`;
  const draftLoaded = useRef(false);
  useEffect(() => {
    if (draftLoaded.current) return;
    draftLoaded.current = true;
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { waypoints?: CartPose[]; mode?: typeof routeMode; speed?: number };
      if (Array.isArray(parsed.waypoints)) setWaypoints(parsed.waypoints.slice(0, 100));
      if (parsed.mode) setRouteMode(parsed.mode);
      if (typeof parsed.speed === "number") setSpeed(Math.min(SPEED_MAX, Math.max(SPEED_MIN, parsed.speed)));
    } catch {
      /* 草稿坏了就当没有，不影响页面 */
    }
  }, [draftKey]);
  useEffect(() => {
    if (!draftLoaded.current) return;
    try {
      window.localStorage.setItem(draftKey, JSON.stringify({ waypoints, mode: routeMode, speed }));
    } catch {
      /* 隐私模式下写不进去，忽略 */
    }
  }, [draftKey, routeMode, speed, waypoints]);

  /* ---- 服务器状态派生 ---- */
  const cartMode = state?.mode ?? "idle";
  const mission = state?.mission ?? null;
  const missionRunning = mission?.state === "running" || mission?.state === "accepting" || mission?.state === "pausing";
  const missionPaused = mission?.state === "paused";
  const missionActive = missionRunning || missionPaused || mission?.state === "stopping";
  const localizationReady = Boolean(state?.localization?.ready);
  const activeMapId = state?.active_map_id ?? null;
  const mapReady = Boolean(state?.map);
  const pose = state?.pose ?? null;
  const source = sourceLabel(state);
  const offline = !cart.live;

  /** 本地看到的任务是否就是本页草稿下发的（按航点数比对，够用且不会误判） */
  const missionPoints = mission?.points ?? [];
  const missionIsMine = missionPoints.length > 0 && missionPoints.length === waypoints.length;

  /*
    首屏取景：第一次拿到地图、或换了另一张图（origin / 尺寸变了）时，
    把视图对到 `bounds` 的已知区域上。之后完全交给用户 —— 只在
    `revision` 变化时重取图像，不动视图，否则建图中每来一帧就把人拖回原点。
  */
  const fittedFor = useRef<string | null>(null);
  const mapKey = state?.map
    ? `${state.map.width}x${state.map.height}@${state.map.resolution.toFixed(4)}@${state.map.origin.x},${state.map.origin.y}`
    : null;
  useEffect(() => {
    if (!state?.map || !mapKey || fittedFor.current === mapKey) return;
    fittedFor.current = mapKey;
    setView(fitView(state.map, 1480, 520));
  }, [mapKey, state?.map]);

  /* ---- 地图与路径数据 ---- */
  const mapImage = useMemo(() => (mapReady ? liveMapUrl(state?.map?.revision) : null), [mapReady, state?.map?.revision]);
  const scanPoints = state?.scan_points ?? [];
  const plannedPath = state?.path ?? [];
  const outline = state?.map?.bounds ?? null;

  /* ---- 列表：已保存地图与路线 ---- */
  const loadLists = useCallback(async () => {
    try {
      const [maps, routeList] = await Promise.all([cartApi.maps(), cartApi.routes()]);
      setSavedMaps(maps.maps ?? []);
      setRoutes(routeList.routes ?? []);
      setListError("");
    } catch (error) {
      setListError(cartErrorText(error));
    }
  }, []);

  /*
    只在挂载与显式刷新时读列表。**不能**挂 `cart.updatedAt` —— 那是 2 Hz 变化的
    状态帧计数器，挂上去等于每秒读两次地图列表，局域网里看着没事，车上多开两个
    页面就是白白的负担。
  */
  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  /* ---- 动作执行：统一处理忙碌、错误、刷新与事件流 ---- */
  const run = useCallback(
    async (
      key: string,
      action: string,
      args: Record<string, unknown>,
      successText: (result: Record<string, unknown>) => string,
    ) => {
      setBusy(key);
      setActionError("");
      // 一次逻辑操作一个编号；重试要复用，所以在这里生成并只在本次调用内使用
      const requestId = newRequestId();
      try {
        const result = await cartApi.action<Record<string, unknown>>(action, args, requestId);
        const text = successText(result);
        setLastAction({ at: Date.now(), text, tone: "ok" });
        pushEvent(text, "ok");
        toast(text, "ok");
        cart.refresh();
        void loadLists();
        return result;
      } catch (error) {
        const message = cartErrorText(error);
        setActionError(message);
        setLastAction({ at: Date.now(), text: `${action}：${message}`, tone: "danger" });
        pushEvent(`${action} 失败：${message}`, "danger");
        toast(message, "danger");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [cart, loadLists, pushEvent, toast],
  );

  /* ---- 建图动作 ---- */
  const startMapping = () =>
    void run("mapping/start", "mapping/start", {}, () => "已请求开始建图（ok:true 表示已接收，实际模式看 mode）");
  const restartMapping = () =>
    void run(
      "mapping/restart",
      "mapping/restart",
      {},
      (result) => `已请求重置建图，当前地图已先备份为 ${(result.backup as { name?: string } | null)?.name ?? "（无备份）"}`,
    );
  const stopMapping = () =>
    void run("mapping/stop", "mapping/stop", {}, () => "已请求结束建图（结束不自动保存地图）");
  const saveMap = () =>
    void run("mapping/save", "mapping/save", { name: mapName.trim() }, (result) => {
      const saved = result.map as CartSavedMap | undefined;
      return `地图已保存：${saved?.name ?? mapName}${saved?.area_m2 ? ` · 已知自由区域 ${saved.area_m2.toFixed(1)} m²` : ""}`;
    });

  /* ---- 巡航动作 ---- */
  const loadMap = (mapId: string) =>
    void run("navigation/load", "navigation/load", { map_id: mapId }, () => "已请求加载地图并切换 Nav2，正在自动定位");

  const autoLocalize = () =>
    void run("navigation/auto-localize", "navigation/auto-localize", {}, () => "已请求 AMCL 全局定位（约 30 秒静止更新）");

  const submitLocalize = (poseInput: CartPose) =>
    void run("navigation/localize", "navigation/localize", { pose: poseInput }, () =>
      "已发布初始位姿，等待 AMCL 收敛（提交成功不等于已定位）",
    );

  const preview = useCallback(
    async (points: CartPose[], previewMode: "single" | "multi" | "loop", quiet = false) => {
      if (!points.length) return;
      setPreviewBusy(true);
      try {
        const result = await cartApi.action<{ path?: unknown[]; point_count?: number }>("navigation/preview", {
          points,
          mode: previewMode,
        });
        const count = Array.isArray(result.path) ? result.path.length : (result.point_count ?? 0);
        setPreviewNote({ tone: "ok", text: `路径已生成 · ${count} 点` });
        if (!quiet) setActionError("");
        cart.refresh();
      } catch (error) {
        const message = cartErrorText(error);
        // NO_PATH 是正常结论（文档 §5：不要用两点直线替代真实路径），不当异常处理
        if (isApiError(error) && error.code === "NO_PATH") {
          setPreviewNote({ tone: "warn", text: "NO_PATH · 没有可行路径" });
          if (!quiet) toast(message, "warn");
        } else {
          setPreviewNote({ tone: "danger", text: message });
          if (!quiet) {
            setActionError(message);
            toast(message, "danger");
          }
        }
      } finally {
        setPreviewBusy(false);
        cart.refresh();
      }
    },
    [cart, toast],
  );

  const startMission = () =>
    void run(
      "navigation/start",
      "navigation/start",
      { map_id: activeMapId, points: waypoints, mode: routeMode, speed_mps: speed },
      () => `已提交巡航任务（${routeMode} · ${waypoints.length} 个航点 · ${speed.toFixed(2)} m/s），车辆开始运动`,
    );

  const pauseMission = () => void run("navigation/pause", "navigation/pause", {}, () => "已请求暂停：取消当前目标并保留航点下标");
  const resumeMission = () => void run("navigation/resume", "navigation/resume", {}, () => "已请求继续：重新前往被暂停的那个航点");
  const stopMission = () => void run("control/stop", "control/stop", {}, () => "已请求停止：取消任务并发布零速度");
  const applySpeed = () =>
    void run("navigation/speed", "navigation/speed", { speed_mps: speed }, (result) => `限速已更新为 ${Number(result.speed_mps ?? speed).toFixed(2)} m/s`);

  const saveRoute = () =>
    void run(
      "routes/save",
      "routes/save",
      { name: mapName.trim() || "未命名路线", map_id: activeMapId, points: waypoints, mode: routeMode, speed_mps: speed },
      (result) => `路线已保存：${(result.route as { id?: string } | undefined)?.id ?? ""}`,
    );

  /** 预览已保存的路线：先按它的地图走一遍加载流程，避免 MAP_MISMATCH */
  const applyRoute = async (route: CartRoute) => {
    if (route.map_id !== activeMapId) {
      const ok = await run("navigation/load", "navigation/load", { map_id: route.map_id }, () => `已请求加载路线绑定的地图 ${route.map_id}`);
      if (!ok) return;
    }
    setWaypoints(route.points);
    setRouteMode(route.mode);
    setSpeed(Math.min(SPEED_MAX, Math.max(SPEED_MIN, route.speed_mps || speed)));
    setMode("cruise");
    toast(`已载入路线「${route.name}」的 ${route.points.length} 个航点（尚未下发）`, "info");
  };

  /* ---- 地图交互 ---- */
  /*
    画布当前工具：人工定位 > 移动某个航点 > 巡航放航点 > 建图期只平移。
    最后那档是有意的 —— 建图时不编航点，左键拖动就是平移。
    少了「巡航 → waypoint」这一档，左键点击会被当成平移，一个航点也放不下。
  */
  const canvasMode: MapCanvasMode = locating
    ? "locate"
    : targetIndex !== null
      ? "target"
      : mode === "cruise"
        ? "waypoint"
        : "pan";

  const addWaypoint = (point: CartPose) => {
    setPreviewNote(null);
    if (targetIndex !== null) {
      setWaypoints((list) => list.map((item, index) => (index === targetIndex ? { ...point } : item)));
      setTargetIndex(null);
      setSelected(targetIndex);
      return;
    }
    setWaypoints((list) => {
      if (list.length >= 100) {
        toast("一条路线最多 100 个航点（文档 §5）", "warn");
        return list;
      }
      const next = [...list, { ...point }];
      setSelected(next.length - 1);
      return next;
    });
  };

  /* ---- 定位工具：进入后在地图上点位置、拖方向 ---- */
  const finishLocate = (value: CartPose) => {
    setLocating(false);
    void submitLocalize(value);
  };

  /* ---- 模式与页面参数的联动（`?mode=cruise` 可以直接打开巡航） ---- */
  useEffect(() => {
    const wanted = params.get("mode");
    if (wanted === "cruise" || wanted === "mapping") setMode(wanted);
  }, [params]);

  useEffect(() => {
    const wanted = params.get("view");
    if (wanted === "map" || wanted === "screen" || wanted === "both") setTab(wanted);
  }, [params]);

  const setModeAndUrl = (next: WorkMode) => {
    setMode(next);
    const copy = new URLSearchParams(params);
    copy.set("mode", next);
    setParams(copy, { replace: true });
  };
  const setTabAndUrl = (next: WatchTab) => {
    setTab(next);
    const copy = new URLSearchParams(params);
    copy.set("view", next);
    setParams(copy, { replace: true });
  };

  /* ---- 权限 ---- */
  const canMap = can("map:save");
  const canDispatch = can("mission:dispatch");
  const canMonitor = can("mission:monitor");
  const controlDenied = !cart.canControl;
  const controlReason = !cart.status?.configured
    ? "平台侧还没配置这台小车的地址与控制令牌（server/data/cart.json），当前只能查看"
    : "平台侧没有小车控制令牌，当前只能查看";

  /** 一个动作能不能点：链路活着 + 有令牌 + 有权限 + 不在忙 */
  const canAct = (permission: boolean, key?: string) => cart.live && cart.canControl && permission && (!key || busy !== key);

  /**
   * 按钮点不动时给出的原因。顺序很重要：**先权限、再令牌、最后断线** ——
   * 反过来会出现「明明是没权限，却告诉用户是网络断了」。
   */
  const blockHint = (permission: "map:save" | "mission:dispatch" | "mission:monitor") => {
    if (!can(permission)) return permissionHint(permission);
    if (controlDenied) return controlReason;
    if (offline) return "超过 3 秒没有新状态，已按断线处理，运动操作全部禁用（文档 §2）";
    return undefined;
  };

  /* ---- 底部参数带的展开 / 收起 ---- */
  const [paramsOpen, setParamsOpen] = useState(true);

  /*
    工单巡航任务的接受 / 完成 / 撤销：都在 `store/cruise.ts` 里（与工单页同一套命令），
    这里只负责忙态与报错 —— 页面不自己拼状态，服务端返回什么就显示什么。
  */
  const missionRecords = useSharedStore(missions);
  const cruiseMission = useMemo(() => activeCruiseMission(missionRecords), [missionRecords]);
  const [cruiseBusy, setCruiseBusy] = useState(false);
  const cruiseRun = useCallback(
    async (kind: "accept" | "complete" | "cancel") => {
      /* 读当前快照用 `missions(getState())`：与上面的选择器同一个收窄点，不各写一遍类型断言 */
      const records = missions(useSharedStore.getState());
      const mission = activeCruiseMission(records);
      if (!mission) {
        toast("当前没有进行中的工单巡航任务", "warn");
        return;
      }
      const revision = cruiseRevisionOf(records, mission.id);
      if (revision === null) {
        toast("这条任务已经不在快照里了，刷新后再试", "danger");
        return;
      }
      setCruiseBusy(true);
      try {
        if (kind === "accept") await acceptCruiseMission(mission, revision);
        else if (kind === "complete") await completeCruiseMission(mission, revision);
        else await cancelCruiseMission(mission, revision, "建图巡航页撤销");
        toast(
          kind === "accept" ? `已接受 ${mission.id}，可以去建图巡航了` : kind === "complete" ? `${mission.id} 已标记完成` : `${mission.id} 已撤销`,
          kind === "cancel" ? "warn" : "ok",
        );
      } catch (error) {
        toast(isApiError(error) ? error.message : "任务操作失败", "danger");
      } finally {
        setCruiseBusy(false);
      }
    },
    [toast],
  );

  return (
    <div className="page page--mapping page--cart">
      {/*
        工单派下来的自主巡航任务（用户 2026-09-18）：马从工单页点「去建图巡航」过来时，
        先看到"我接的是哪条任务、来自哪张工单、现在什么状态"，再往下才是车的控制台。
        放在最上面（在只读 / 断线提示之前）：它是这一趟作业的来由。
      */}
      <CruiseTaskBanner
        mission={cruiseMission}
        linkedTaskNo={params.get("task")}
        canDispatch={can("mission:dispatch")}
        canMonitor={can("mission:monitor")}
        busy={cruiseBusy}
        onAccept={() => cruiseRun("accept")}
        onComplete={() => cruiseRun("complete")}
        onCancel={() => cruiseRun("cancel")}
        onOpenOrder={(orderId) => navigate(`/orders?order=${encodeURIComponent(orderId)}`)}
      />
      {/*
        下面两条提示是页面可信度的一部分：
          · 没配令牌 → 说明「只能看」，而不是让人对着一排灰按钮猜；
          · 断线 → 按文档 §2 明确「禁用运动操作」。
      */}
      {controlDenied ? (
        <div className="cart-banner is-warn">
          <b>只读监视</b>
          <span>{controlReason}</span>
        </div>
      ) : null}
      {offline && cart.status?.configured !== false ? (
        <div className="cart-banner is-danger">
          <b>状态不新鲜</b>
          <span>
            {cart.link === "online"
              ? `最近一份状态已过去 ${Math.round((cart.ageMs ?? 0) / 1000)} 秒，运动操作已禁用`
              : "到小车的连接已断开，正在退避重连"}
          </span>
        </div>
      ) : null}
      {actionError ? (
        <div className="cart-banner is-danger">
          <b>操作失败</b>
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError("")}>
            知道了
          </button>
        </div>
      ) : null}

      <div className="cart-layout">
        {/* ---------------- 左栏：随模式切换的操作区 ---------------- */}
        <div className="cart-side">
          {mode === "mapping" ? (
            <>
              <Panel
                title="建图"
                extra={
                  <>
                    {/* 两个功能：建图 / 巡航。切换与刷新都收在这一栏里 */}
                    <div className="cart-modes" role="tablist" aria-label="小车功能">
                      {(Object.keys(MODE_COPY) as WorkMode[]).map((key) => (
                        <button
                          key={key}
                          type="button"
                          role="tab"
                          aria-selected={mode === key}
                          className={`cart-mode ${mode === key ? "is-active" : ""}`}
                          title={MODE_COPY[key].hint}
                          onClick={() => setModeAndUrl(key)}>
                          {MODE_COPY[key].label}
                          {key === "mapping" && cartMode === "mapping" ? <i className="cart-mode__dot" /> : null}
                          {key === "cruise" && missionActive ? <i className="cart-mode__dot" /> : null}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="cart-refresh"
                      title="重新读取已保存地图与路线"
                      onClick={() => void loadLists()}>
                      刷新
                    </button>
                    {/*
                      ── 通道巡查（剧本 §102）──────────────────────────────
                      原文：「（等待时选用：小车继续建图，**史在平台开启数据通道巡查**；
                      只检查已有通道状态，不替代车端避障。）」
                      所以这个窗口不能只有"小木说话时才弹"——人自己也要点得开。
                      它弹的就是 ⑨ 那一轮的那个窗口（同一轮声明、同一份实现）。
                    */}
                    <Btn
                      tone="ghost"
                      title="检查建图效果与视频通道状态，只提醒影响作业的异常；不替代车端避障"
                      onClick={() => openDemoSurface(CHANNEL_PATROL_ROUND_NO)}>
                      通道巡查
                    </Btn>
                    <StatusChip
                      text={cartMode === "mapping" ? "建图中" : cartMode === "navigation" ? "巡航中" : "待机"}
                      tone={cartMode === "mapping" ? "ok" : cartMode === "navigation" ? "warn" : "muted"}
                    />
                  </>
                }>
                <ul className="cart-facts">
                  <li>
                    <b>栅格</b>
                    <span>
                      {state?.map
                        ? `${state.map.width}×${state.map.height} px · ${state.map.resolution.toFixed(3)} m/px · rev ${state.map.revision}`
                        : "—"}
                    </span>
                  </li>
                  <li>
                    <b>已知区域</b>
                    <span>{outline ? `${outline[2] - outline[0]}×${outline[3] - outline[1]} px` : "—"}</span>
                  </li>
                  <li>
                    <b>雷达</b>
                    <span>
                      {state?.lidar?.state === "online" ? `在线 · ${state.lidar.hz?.toFixed(1) ?? "—"} Hz` : "离线"}
                    </span>
                  </li>
                  <li>
                    <b>雷达点</b>
                    <span>{scanPoints.length}</span>
                  </li>
                </ul>
                <div className="cart-actions">
                  <Btn
                    tone="primary"
                    disabled={!canAct(canMap, "mapping/start") || cartMode === "mapping" || missionActive}
                    title={
                      blockHint("map:save") ??
                      (cartMode === "mapping" ? "已经在建图中" : missionActive ? "需先停止巡航任务" : undefined)
                    }
                    onClick={startMapping}>
                    {busy === "mapping/start" ? "启动中…" : "开始建图"}
                  </Btn>
                  <Btn
                    disabled={!canAct(canMap, "mapping/stop") || cartMode !== "mapping"}
                    title={blockHint("map:save") ?? (cartMode !== "mapping" ? "当前不在建图模式" : "结束建图，不自动保存")}
                    onClick={stopMapping}>
                    {busy === "mapping/stop" ? "结束中…" : "结束建图"}
                  </Btn>
                  <Btn
                    disabled={!canAct(canMap, "mapping/restart") || missionActive}
                    title={blockHint("map:save") ?? "先备份当前地图，再重启建图"}
                    onClick={restartMapping}>
                    {busy === "mapping/restart" ? "重置中…" : "重置地图"}
                  </Btn>
                </div>
                <label className="cart-field">
                  <span>保存名称</span>
                  <input
                    value={mapName}
                    maxLength={40}
                    onChange={(event) => setMapName(event.target.value)}
                    placeholder="一层大厅"
                  />
                </label>
                <div className="cart-actions">
                  <Btn
                    tone="primary"
                    disabled={!canAct(canMap, "mapping/save") || !mapReady || mapName.trim().length === 0}
                    title={blockHint("map:save") ?? (!mapReady ? "还没有地图" : "保存为新地图，不覆盖旧地图")}
                    onClick={saveMap}>
                    {busy === "mapping/save" ? "保存中…" : "保存地图"}
                  </Btn>
                  <Btn
                    disabled={!canAct(canMap) || !mapReady}
                    title={blockHint("map:save") ?? "切到巡航，用这张图定位"}
                    onClick={() => {
                      setModeAndUrl("cruise");
                    }}>
                    去巡航
                  </Btn>
                </div>
              </Panel>

              <SavedMapsPanel
                maps={savedMaps}
                activeMapId={activeMapId}
                error={listError}
                busy={busy}
                disabled={!canAct(canDispatch) || missionActive}
                disabledReason={blockHint("mission:dispatch") ?? "巡航任务未结束"}
                onLoad={(id) => void loadMap(id)}
                onRefresh={() => void loadLists()}
              />
            </>
          ) : (
            <>
              <Panel
                title="① 地图与定位"
                extra={
                  <StatusChip
                    text={localizationReady ? "已定位" : activeMapId ? "未定位" : "未加载地图"}
                    tone={localizationReady ? "ok" : "warn"}
                  />
                }>
                <ul className="cart-facts">
                  <li>
                    <b>已加载</b>
                    <span>{activeMapId ?? "—"}</span>
                  </li>
                  <li>
                    <b>地图分辨率</b>
                    <span>{state?.map ? `${state.map.resolution.toFixed(3)} m/px · rev ${state.map.revision}` : "—"}</span>
                  </li>
                  <li>
                    <b>雷达匹配</b>
                    <span>
                      {state?.localization?.match === null || state?.localization?.match === undefined
                        ? "—"
                        : `${(state.localization.match * 100).toFixed(0)}%`}
                    </span>
                  </li>
                  <li>
                    <b>导航 / 规划服务</b>
                    <span>
                      {state?.navigation?.ready ? "导航就绪" : "导航未就绪"} · {state?.navigation?.planner_ready ? "规划就绪" : "规划未就绪"}
                    </span>
                  </li>
                  <li>
                    <b>map 位姿</b>
                    <span>
                      {pose ? `x ${pose.x.toFixed(2)} · y ${pose.y.toFixed(2)} · yaw ${((pose.yaw * 180) / Math.PI).toFixed(0)}°` : "—"}
                    </span>
                  </li>
                </ul>
                <div className="cart-actions">
                  <Btn
                    disabled={!canAct(canDispatch, "navigation/auto-localize") || !activeMapId}
                    title={blockHint("mission:dispatch") ?? (!activeMapId ? "先加载地图" : "重新调用 AMCL 全局定位")}
                    onClick={autoLocalize}>
                    {busy === "navigation/auto-localize" ? "定位中…" : "自动定位"}
                  </Btn>
                  <Btn
                    disabled={!canAct(canDispatch, "navigation/localize") || !activeMapId}
                    active={locating}
                    title={blockHint("mission:dispatch") ?? (!activeMapId ? "先加载地图" : "在地图上点位置、拖出车头方向")}
                    onClick={() => setLocating((value) => !value)}>
                    {locating ? "取消人工定位" : "人工定位"}
                  </Btn>
                </div>
                {locating ? <p className="cart-copy is-warn">点位置，拖出车头方向，松手发布位姿</p> : null}
                {!localizationReady && activeMapId ? (
                  <p className="cart-copy">未定位，自动定位约需 30 秒静止更新</p>
                ) : null}
              </Panel>

              <Panel
                title="② 航点"
                extra={
                  <span className="muted">
                    {waypoints.length} 个{targetIndex !== null ? ` · 正在移动第 ${targetIndex + 1} 个` : ""}
                  </span>
                }>
                <label className="cart-field">
                  <span>运动模式</span>
                  <select value={routeMode} onChange={(event) => setRouteMode(event.target.value as typeof routeMode)}>
                    <option value="single">single · 点到点</option>
                    <option value="multi">multi · 依次运动</option>
                    <option value="loop">loop · 循环</option>
                  </select>
                </label>
                {waypoints.length === 0 ? (
                  <p className="cart-copy">在地图上点击放下航点，按住拖动定车头朝向</p>
                ) : (
                  <ol className="cart-waypoints">
                    {waypoints.map((point, index) => (
                      <li
                        key={`${index}-${point.x.toFixed(3)}`}
                        className={`${selected === index ? "is-selected" : ""} ${
                          mission?.state === "running" && mission.index === index ? "is-current" : ""
                        }`}
                        onClick={() => setSelected(index)}>
                        <b>{index + 1}</b>
                        <span>
                          x {point.x.toFixed(2)} · y {point.y.toFixed(2)} · yaw {((point.yaw * 180) / Math.PI).toFixed(0)}°
                        </span>
                        <button
                          type="button"
                          title="在地图上重新点选"
                          className={targetIndex === index ? "is-active" : ""}
                          onClick={(event) => {
                            event.stopPropagation();
                            setTargetIndex(targetIndex === index ? null : index);
                          }}>
                          移动
                        </button>
                        <button
                          type="button"
                          title="删除这个航点"
                          onClick={(event) => {
                            event.stopPropagation();
                            setWaypoints((list) => list.filter((_, at) => at !== index));
                            setSelected(null);
                            setTargetIndex(null);
                          }}>
                          删除
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="cart-actions">
                  <Btn
                    disabled={!waypoints.length || previewBusy}
                    title="只规划，不运动"
                    onClick={() => void preview(waypoints, routeMode)}>
                    {previewBusy ? "规划中…" : "路线预览"}
                  </Btn>
                  <Btn
                    disabled={!waypoints.length}
                    title="清空航点"
                    onClick={() => {
                      setWaypoints([]);
                      setSelected(null);
                      setTargetIndex(null);
                    }}>
                    清空
                  </Btn>
                  <Btn
                    disabled={!canAct(canMap, "routes/save") || !waypoints.length || !activeMapId}
                    title={blockHint("map:save") ?? (!activeMapId ? "先加载地图" : "存为路线，绑定当前地图")}
                    onClick={saveRoute}>
                    {busy === "routes/save" ? "保存中…" : "保存为路线"}
                  </Btn>
                </div>
                {previewNote ? (
                  <p className={`cart-copy is-${previewNote.tone === "ok" ? "ok" : previewNote.tone}`}>{previewNote.text}</p>
                ) : null}
                {!localizationReady ? <p className="cart-copy is-warn">未定位，预览会返回 NOT_LOCALIZED</p> : null}
              </Panel>

              <Panel title="③ 速度与下发">
                <label className="cart-field">
                  <span>巡航限速 {speed.toFixed(2)} m/s</span>
                  <input
                    type="range"
                    min={SPEED_MIN}
                    max={SPEED_MAX}
                    step={0.01}
                    value={speed}
                    onChange={(event) => setSpeed(Number(event.target.value))}
                  />
                </label>
                <div className="cart-actions">
                  <Btn
                    disabled={!canAct(canDispatch, "navigation/speed")}
                    title={blockHint("mission:dispatch") ?? "更新 Nav2 SpeedLimit，绝对速度"}
                    onClick={applySpeed}>
                    {busy === "navigation/speed" ? "下发中…" : "下发限速"}
                  </Btn>
                  <Btn
                    tone="primary"
                    disabled={
                      !canAct(canDispatch, "navigation/start") ||
                      !activeMapId ||
                      !localizationReady ||
                      missionActive ||
                      waypoints.length === 0 ||
                      (routeMode === "single" && waypoints.length !== 1) ||
                      (routeMode === "loop" && waypoints.length < 2)
                    }
                    title={
                      blockHint("mission:dispatch") ??
                      (!activeMapId
                        ? "先加载地图"
                        : !localizationReady
                          ? "未定位，不能开始巡航"
                          : missionActive
                            ? "已有任务在跑"
                            : waypoints.length === 0
                              ? "先放航点"
                              : routeMode === "single" && waypoints.length !== 1
                                ? "single 需 1 个航点"
                                : routeMode === "loop" && waypoints.length < 2
                                  ? "loop 至少 2 个航点"
                                  : "向 Nav2 提交目标，车辆会运动")
                    }
                    onClick={startMission}>
                    {busy === "navigation/start" ? "下发中…" : "开始巡航"}
                  </Btn>
                  <Btn
                    disabled={!canAct(canMonitor, "navigation/pause") || !missionRunning}
                    title={blockHint("mission:monitor") ?? (missionRunning ? "取消当前目标，保留航点下标" : "只有执行中的任务可暂停")}
                    onClick={pauseMission}>
                    暂停
                  </Btn>
                  <Btn
                    disabled={!canAct(canMonitor, "navigation/resume") || !missionPaused}
                    title={blockHint("mission:monitor") ?? (missionPaused ? "重新前往被暂停的航点" : "当前没有暂停中的任务")}
                    onClick={resumeMission}>
                    继续
                  </Btn>
                </div>
                <ul className="cart-facts">
                  <li>
                    <b>任务状态</b>
                    <span>
                      {missionStateText(mission?.state)}
                      {mission ? ` · 航点 ${mission.index + 1}/${mission.points.length} · 已完成 ${mission.cycle} 圈` : ""}
                      {mission?.distance_remaining !== null && mission?.distance_remaining !== undefined
                        ? ` · 距当前目标 ${mission.distance_remaining.toFixed(2)} m`
                        : ""}
                    </span>
                  </li>
                  <li>
                    <b>本页航点</b>
                    <span>
                      {waypoints.length} 个 · {routeMode} · {speed.toFixed(2)} m/s
                      {missionPoints.length && !missionIsMine ? ` · 车上 ${missionPoints.length} 个` : ""}
                    </span>
                  </li>
                </ul>
                {lastAction ? <p className={`cart-copy is-${lastAction.tone}`}>{lastAction.text}</p> : null}
              </Panel>

              <Panel
                title="已保存地图与路线"
                extra={
                  <span className="muted">
                    {savedMaps.length} 张图 · {routes.length} 条路线
                  </span>
                }>
                <SavedMapsPanel
                  embedded
                  maps={savedMaps}
                  activeMapId={activeMapId}
                  error={listError}
                  busy={busy}
                  disabled={!canAct(canDispatch) || missionActive}
                  disabledReason={blockHint("mission:dispatch") ?? "巡航任务未结束"}
                  onLoad={(id) => void loadMap(id)}
                  onRefresh={() => void loadLists()}
                />
                {routes.length ? (
                  <ul className="cart-routes">
                    {routes.map((route) => (
                      <li key={route.id}>
                        <b>{route.name}</b>
                        <span>
                          {route.points.length} 点 · {route.mode} · {route.speed_mps.toFixed(2)} m/s · 地图 {route.map_id}
                        </span>
                        <button type="button" onClick={() => void applyRoute(route)}>
                          载入航点
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cart-copy">无已保存路线</p>
                )}
              </Panel>
            </>
          )}
        </div>

        {/* ---------------- 中间：建图 / 巡航画面（栅格地图 + RViz 屏幕画面） ---------------- */}
        <div className="cart-main">
          <Panel
            title={tab === "map" ? "栅格地图" : tab === "screen" ? "屏幕画面" : "地图与屏幕画面"}
            extra={
              <>
                <div className="cart-tabs" role="tablist" aria-label="画面选择">
                  {(
                    [
                      ["map", "栅格地图"],
                      ["screen", "屏幕画面"],
                      ["both", "并排"],
                    ] as [WatchTab, string][]
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={tab === key}
                      className={tab === key ? "is-active" : ""}
                      onClick={() => setTabAndUrl(key)}>
                      {label}
                    </button>
                  ))}
                </div>
                {tab === "map" ? (
                  <StatusChip
                    text={mapReady ? `rev ${state?.map?.revision ?? "—"}` : "无地图"}
                    tone={mapReady ? "ok" : "warn"}
                  />
                ) : (
                  <StatusChip
                    text={state?.streams?.rviz_state === "online" ? "在线" : "离线"}
                    tone={state?.streams?.rviz_state === "online" ? "ok" : "danger"}
                  />
                )}
                {/* 车况只留电压：其余传感器/主机读数在底部参数带里，这里不再铺一排卡片 */}
                <span className="cart-volt">{voltageText(state)}</span>
              </>
            }
            className="cart-view">
            <div className={`cart-view__area is-${tab}`}>
              {/* 地图始终挂载（切回来不用重新取图、视图也不丢），只是被隐藏 */}
              <div className={`cart-view__pane cart-view__pane--map ${tab === "map" || tab === "both" ? "" : "is-hidden"}`}>
                <MapCanvas
                  map={state?.map ?? null}
                  imageUrl={mapImage}
                  pose={pose}
                  scanPoints={scanPoints}
                  path={plannedPath}
                  waypoints={waypoints}
                  activeIndex={mission?.state === "running" ? mission.index : null}
                  mode={canvasMode}
                  onWaypoint={addWaypoint}
                  onLocate={finishLocate}
                  view={view}
                  onViewChange={setView}
                  onStageSize={setStage}
                />
              </div>

              {tab === "screen" || tab === "both" ? (
                <div className="cart-view__pane cart-view__pane--stream">
                  <div
                    className="cart-view__box"
                    style={{
                      aspectRatio: rvizRatio,
                      width: rvizBox ? `${rvizBox.width}px` : undefined,
                      height: rvizBox ? `${rvizBox.height}px` : undefined,
                    }}>
                    <img src={streamUrl("rviz")} alt="小车 RViz 屏幕画面" />
                    <span className="cart-view__tag">
                      RViz{rvizSize ? ` · ${rvizSize.width}×${rvizSize.height}` : ""}
                    </span>
                  </div>
                </div>
              ) : null}

            </div>
          </Panel>

          {/*
            现场视频**单独一块**，不并进上面的画面选择。
            两个原因：它和地图 / RViz 是三个用途不同的画面（一个是算法视角、
            一个是屏幕、一个是现场实景）；而且它的原始比例与前两者都不同，
            混在一个切换里，比例一变就要重排，看着像被压扁。
            画面按摄像头原始宽高比（4:3）显示，用 object-fit: contain 留黑边，不裁不拉。
          */}
          <Panel
            title="相机流"
            extra={
              <StatusChip
                text={
                  state?.camera?.state === "online"
                    ? `在线 · ${state.camera.fps?.toFixed(1) ?? "—"} fps`
                    : "离线"
                }
                tone={state?.camera?.state === "online" ? "ok" : "danger"}
              />
            }
            className="cart-video">
            <div className="cart-video__frame" style={{ aspectRatio: cameraRatio }}>
              <img src={streamUrl("camera")} alt="小车摄像头实时画面" />
            </div>
          </Panel>

        </div>
      </div>

      {/* ---------------- 底部：小车参数（车况与急停放在这一条的标题行里） ---------------- */}
      <section className={`cart-params-block ${paramsOpen ? "" : "is-collapsed"}`}>
        <header>
          <h3>小车参数</h3>
          {/*
            车况与急停放在这一条的标题行里，不再单独占一行工具栏：
            省下来的那一整行高度留给上面的 RViz 画面；急停固定在参数条的
            标题行中间，不随左栏滚动，任何时候都在同一个位置。
          */}
          <div className="cart-params-block__actions">
            <span className="cart-params-block__state">
              <span className={`cart-source is-${source.tone}`}>
                <i />
                {source.text}
              </span>
              <span className={`cart-link is-${offline ? "offline" : "online"}`}>
                <i />
                {cart.status?.configured === false
                  ? "未配置小车地址"
                  : cart.link === "online"
                    ? offline
                      ? `数据延迟 ${Math.round((cart.ageMs ?? 0) / 1000)} s`
                      : `实时 ${Math.round(cart.ageMs ?? 0)} ms`
                    : cart.link === "connecting"
                      ? "连接中"
                      : "链路断开"}
              </span>
              <span className="muted">协议 v{state?.schema_version ?? "1.0"}</span>
            </span>
            <Btn
              tone="danger"
              disabled={!canAct(canMonitor, "control/stop")}
              title={blockHint("mission:monitor") ?? "取消任务并发布零速度（文档 §5：0 不是停止指令）"}
              onClick={stopMission}>
              {busy === "control/stop" ? "停止中…" : "急停 / 停止"}
            </Btn>
            <PermNote permissions={["map:save", "mission:dispatch"]} />
          </div>
          <button type="button" className="cart-params-block__toggle" onClick={() => setParamsOpen((value) => !value)}>
            {paramsOpen ? "收起" : "展开"}
          </button>
        </header>
        {paramsOpen ? (
          <div className="cart-params-block__body">
            <ParameterStrip state={state} />
          </div>
        ) : null}
      </section>

      {/* 原始数据：排查「页面与车上不一致」时看这里 */}
      <InspectorModal state={state} maps={savedMaps} routes={routes} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 已保存地图
 * ------------------------------------------------------------------ */

function SavedMapsPanel({
  maps,
  activeMapId,
  error,
  busy,
  disabled,
  disabledReason,
  onLoad,
  onRefresh,
  embedded = false,
}: {
  maps: CartSavedMap[];
  activeMapId: string | null;
  error: string;
  busy: string | null;
  disabled: boolean;
  disabledReason?: string;
  onLoad: (id: string) => void;
  onRefresh: () => void;
  /** 嵌在巡航侧栏里时不再套一层 Panel */
  embedded?: boolean;
}) {
  /** 预览图取不到的地图：记下来，排版用纯文字顶掉那格，不留破图 */
  const [brokenPreview, setBrokenPreview] = useState<Record<string, true>>({});

  const body = (
    <>
      {error ? <p className="cart-copy is-danger">{error}</p> : null}
      {maps.length === 0 && !error ? (
        <p className="cart-copy">无已保存地图</p>
      ) : null}
      <ul className="cart-maps">
        {maps.map((item) => {
          const active = item.id === activeMapId;
          return (
            <li key={item.id} className={`${active ? "is-active" : ""} ${brokenPreview[item.id] ? "is-nopreview" : ""}`}>
              {brokenPreview[item.id] ? (
                <span className="cart-maps__nopreview">无预览</span>
              ) : (
                <img
                  src={savedMapPreviewUrl(item)}
                  alt=""
                  loading="lazy"
                  onError={() => setBrokenPreview((current) => ({ ...current, [item.id]: true }))}
                />
              )}
              <div className="cart-maps__meta">
                <b>{item.name}</b>
                <span>
                  {formatTime(item.created_at)} · {item.map.width}×{item.map.height} @ {item.map.resolution.toFixed(3)} m
                </span>
                <span>
                  {item.area_m2 === null || item.area_m2 === undefined ? "面积未记录" : `已知自由区域 ${item.area_m2.toFixed(1)} m²`}
                  {item.saved_pose
                    ? ` · 保存位姿 x ${item.saved_pose.x.toFixed(2)} y ${item.saved_pose.y.toFixed(2)}`
                    : ""}
                </span>
                <em>{item.id}</em>
              </div>
              <div className="cart-maps__actions">
                <Btn
                  tone={active ? "default" : "primary"}
                  disabled={disabled || busy === "navigation/load" || active}
                  title={active ? "这张图已经加载" : (disabledReason ?? "加载这张图并切换 Nav2（会先备份当前建图）")}
                  onClick={() => onLoad(item.id)}>
                  {busy === "navigation/load" ? "加载中…" : active ? "已加载" : "加载巡航"}
                </Btn>
                <a className="cart-maps__link" href={`/api/cart/maps/${encodeURIComponent(item.id)}/map.pgm`} download>
                  PGM
                </a>
                <a className="cart-maps__link" href={`/api/cart/maps/${encodeURIComponent(item.id)}/map.yaml`} download>
                  YAML
                </a>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="cart-actions">
        <Btn onClick={onRefresh}>重新读取</Btn>
      </div>
    </>
  );

  if (embedded) return <div className="cart-savedmaps">{body}</div>;
  return (
    <Panel
      title="已保存地图"
      extra={<span className="muted">{maps.length} 张</span>}>
      {body}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 状态对照弹窗（排查用）
 * ------------------------------------------------------------------ */

function InspectorModal({ state, maps, routes }: { state: CartState | null; maps: CartSavedMap[]; routes: CartRoute[] }) {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [sessionView, setSessionView] = useState<Record<string, unknown> | null>(null);
  const [configView, setConfigView] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      const [h, s, c] = await Promise.all([
        apiRequest<Record<string, unknown>>("/api/cart/read/health"),
        apiRequest<Record<string, unknown>>("/api/cart/read/session"),
        apiRequest<Record<string, unknown>>("/api/cart/read/config").catch(() => null),
      ]);
      setHealth(h);
      setSessionView(s);
      setConfigView(c);
    } catch (cause) {
      setError(cartErrorText(cause));
    }
  };

  /* 排查入口：浮动按钮，不占页面位置 */
  return (
    <>
      <button type="button" className="cart-inspector-open" onClick={() => { setOpen(true); void load(); }}>
        原始数据
      </button>
      {open ? (
        <Modal wide title="原始数据" onClose={() => setOpen(false)}
          footer={
            <Btn tone="primary" onClick={() => setOpen(false)}>
              关闭
            </Btn>
          }>
          {error ? <StateBlock kind="error" title="读取失败" hint={error} /> : null}
          <h4 className="sub">只读接口</h4>
          <div className="cart-inspector">
            <pre>{JSON.stringify({ health, session: sessionView, config: configView }, null, 2)}</pre>
          </div>
          <h4 className="sub">当前状态</h4>
          <div className="cart-inspector">
            <pre>
              {JSON.stringify(
                state
                  ? {
                      ...state,
                      scan_points: `… ${state.scan_points?.length ?? 0} 点`,
                      path: `… ${state.path?.length ?? 0} 点`,
                      imu_history: `… ${state.imu_history?.length ?? 0} 组`,
                    }
                  : null,
                null,
                2,
              )}
            </pre>
          </div>
          <h4 className="sub">清单</h4>
          <div className="cart-inspector">
            <pre>{JSON.stringify({ savedMaps: maps.map((item) => item.id), routes: routes.map((item) => item.id) }, null, 2)}</pre>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
