/**
 * 真实栅格地图视图（建图巡航页的主画面）
 *
 * 画面内容全部来自小车 `/api/state` 与 `/api/map.png`，没有一格是示意图：
 *   · 底图   —— 小车当前的占据栅格 PNG（`map.revision` 变了才重取，文档 §3）
 *   · 雷达点 —— `scan_points`，map 坐标下的抽样点
 *   · 规划路径 —— `path`，真实 Nav2 规划结果（预览之后才有）
 *   · 机器人 —— `pose`，base_footprint 在 map 下的位姿
 *   · 航点   —— 巡航页自己编的，编号与右侧列表一一对应
 *
 * 坐标口径严格按文档 §3，换算函数（worldToImage / imageToWorld）统一放在
 * `geometry.ts`，这里只做「视图变换 + 绘制」。**不能**把 RViz 视频像素当世界
 * 坐标：视频画面只作为并排的参考视图，两套坐标互不换算。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CartMapMeta, CartPose } from "./api";
import {
  DEFAULT_VIEW,
  clampScale,
  clampView,
  imageToWorld,
  insideMap,
  worldToImage,
  type MapView,
} from "./geometry";

/**
 * 画面的「视口」：画布 CSS 尺寸里的一个矩形。
 *
 * 为什么要单独算：栅格图是正方形（小车当前 800×800），而画布是宽扁的，
 * 直接把图按画布尺寸拉过去就**变形**了。所以底图与所有叠加层（雷达点、
 * 路径、位姿、航点）都换算到这个矩形里 —— 它的宽高比恒等于
 * `map.width : map.height`，也就是永远按原始比例显示。
 * 矩形之外留白，正好放比例尺与状态条。
 */
type Viewport = { left: number; top: number; width: number; height: number };

function viewportOf(map: CartMapMeta | null, width: number, height: number): Viewport {
  if (!map || map.width <= 0 || map.height <= 0) return { left: 0, top: 0, width, height };
  const ratio = map.width / map.height;
  let w = width;
  let h = w / ratio;
  if (h > height) {
    h = height;
    w = h * ratio;
  }
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

/** 视图变换：图像像素 → 屏幕像素（在视口矩形内） */
function toScreen(view: MapView, map: CartMapMeta, u: number, v: number, viewport: Viewport) {
  return {
    x: (u - map.width / 2) * view.scale + viewport.width / 2 + viewport.left + view.dx,
    y: (v - map.height / 2) * view.scale + viewport.height / 2 + viewport.top + view.dy,
  };
}

/** 屏幕像素 → 图像像素（视图变换的逆） */
function toImage(view: MapView, map: CartMapMeta, x: number, y: number, viewport: Viewport) {
  return {
    u: (x - viewport.left - viewport.width / 2 - view.dx) / view.scale + map.width / 2,
    v: (y - viewport.top - viewport.height / 2 - view.dy) / view.scale + map.height / 2,
  };
}

export type MapCanvasMode = "pan" | "waypoint" | "locate" | "target";

export type MapCanvasProps = {
  map: CartMapMeta | null;
  /** 底图地址（`/api/cart/map.png?v=revision`）；未就绪时为 null，画布显示等待建图 */
  imageUrl: string | null;
  pose: CartPose | null;
  scanPoints?: [number, number][];
  path?: CartPose[];
  waypoints: CartPose[];
  /** 航点里当前正在前往的那个下标（mission.index），没有则 null */
  activeIndex?: number | null;
  mode: MapCanvasMode;
  /** 定位拖拽的临时位姿（松手前的预览） */
  pendingPose?: CartPose | null;
  onWaypoint?: (pose: CartPose) => void;
  onLocate?: (pose: CartPose) => void;
  view: MapView;
  onViewChange: (view: MapView) => void;
  /**
   * 画布容器尺寸变化时回调（父级用它算「屏幕画面按比例能占多大」）。
   * 父级是 flex/grid 里的一个格子，宽度由布局决定，所以只能在这里量。
   */
  onStageSize?: (size: { width: number; height: number }) => void;
  className?: string;
};

/**
 * 车体顶视照片（绿幕已抠掉，public/cart/car-top.png）。
 *
 * 用实车照片代替箭头，是为了让「图上那个点」和停在你面前的这台车一眼对上：
 * 车身轮廓、云台、雷达、屏幕的位置都对得上，不用再解释「这个绿三角是什么」。
 * 图片按车长等比缩放（不写死像素），朝向按 pose.yaw 旋转。
 * 文件由 `tmp-cart-asset/cutout.mjs` 从绿幕原图生成（一次性工具）。
 */
const CAR_SPRITE_URL = "/cart/car-top.png";
/**
 * 车体在屏幕上的长度（m，按地图比例换算）。真车约 0.32 m，这里给 0.45 ——
 * 地图缩到 0.05 m/px 时，0.32 m 只有 6 个像素，照片糊成一个黑点；
 * 位姿指示宁可略大于实物也要看得清（RViz 的 RobotModel 也是这个口径）。
 */
const CAR_LENGTH_M = 0.45;

/** 位姿箭头（对齐 RViz 的 Pose 显示习惯）：**照片加载不出来时的兜底**。
 *
 * 三点是从实测反馈里来的，不是装饰：
 *   · **尺寸有下限**：车体按真实车长（mini_akm 约 34 cm）换算，缩到看不见时
 *     用固定像素兜底 —— 一开始只按比例画，地图缩小时整台车不到两个像素，
 *     看起来就是「地图上没有这个箭头」；
 *   · **朝向做成实心三角**：RViz 里一眼能认出车头朝哪，比一条细线可靠；
 *   · **先描白边再填色**：底图是浅灰的栅格，没有描边时绿色车体在自由区域上
 *     几乎看不出来。
 */
function drawRobot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  yaw: number,
  scale: number,
  tone: "live" | "stale",
  sprite: HTMLImageElement | null,
) {
  const color = tone === "live" ? "#39d5a3" : "#70849c";

  /*
    有照片就画照片：长度按真实车长换算，最短 26px 兜底（缩得太小时
    照片会糊成一团，反而看不见车在哪）。照片是「车头朝上」拍的，
    而地图上 +x 是车头，所以旋转时要先补 90°。
  */
  if (sprite) {
    const length = Math.max(34, CAR_LENGTH_M * scale);
    const width = length * (sprite.naturalWidth / sprite.naturalHeight);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-yaw + Math.PI / 2);
    /*
      先垫一层柔光：照片是深色金属车身，直接画在浅灰的自由区域上，
      第一眼找不到车在哪。光晕跟着车体形状走，不改变照片本身。
    */
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, length * 0.72);
    glow.addColorStop(0, "rgba(93,228,255,0.42)");
    glow.addColorStop(0.6, "rgba(93,228,255,0.16)");
    glow.addColorStop(1, "rgba(93,228,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, length * 0.72, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(sprite, -length / 2, -width / 2, length, width);
    ctx.restore();
    return;
  }
  // 真实车长换算后不小于 22px，保证任何缩放下都看得见
  const length = Math.max(22, 0.34 * scale);
  const width = length * 0.65;
  const head = length * 0.55;

  ctx.save();
  ctx.translate(x, y);
  // 画布 y 轴向下，世界的 yaw 逆时针为正 → 屏幕上取负
  ctx.rotate(-yaw);

  // 车体（圆角矩形）+ 白色描边
  ctx.beginPath();
  ctx.roundRect(-length / 2, -width / 2, length, width, Math.max(2, width * 0.25));
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, length * 0.07);
  ctx.strokeStyle = "rgba(234,243,255,0.9)";
  ctx.stroke();

  // 车头：实心三角，指 +x（车头方向）
  ctx.beginPath();
  ctx.moveTo(length / 2 + head, 0);
  ctx.lineTo(length / 2 - head * 0.35, -width * 0.5);
  ctx.lineTo(length / 2 - head * 0.35, width * 0.5);
  ctx.closePath();
  ctx.fillStyle = "#eaf3ff";
  ctx.fill();
  ctx.lineWidth = Math.max(1, length * 0.05);
  ctx.strokeStyle = color;
  ctx.stroke();

  ctx.restore();
}

export default function MapCanvas({
  map,
  imageUrl,
  pose,
  scanPoints = [],
  path = [],
  waypoints,
  activeIndex = null,
  mode,
  pendingPose = null,
  onWaypoint,
  onLocate,
  view,
  onViewChange,
  onStageSize,
  className,
}: MapCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  /**
   * 回调放进 ref：父级每次渲染都会传一个新的函数进来，直接写进依赖数组
   * 会让 ResizeObserver 每帧重建 —— 观察器一重建，量到的尺寸就不稳定，
   * 屏幕画面的尺寸会跟着抖。
   */
  const stageCb = useRef(onStageSize);
  stageCb.current = onStageSize;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageState, setImageState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  /** 车体照片；取不到就退回位姿箭头（底图与其它图层照常工作） */
  const [sprite, setSprite] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    let alive = true;
    const next = new Image();
    next.onload = () => {
      if (alive) setSprite(next);
    };
    next.src = CAR_SPRITE_URL;
    return () => {
      alive = false;
    };
  }, []);
  /** 正在进行的拖拽：平移 / 画航点方向 / 设定位姿 */
  const drag = useRef<
    | { kind: "pan"; startX: number; startY: number; dx: number; dy: number }
    | { kind: "waypoint"; at: { x: number; y: number } }
    | { kind: "locate"; at: { x: number; y: number } }
    | null
  >(null);
  const [preview, setPreview] = useState<CartPose | null>(null);

  /* 画布尺寸跟随容器（ResizeObserver，窗口缩放与栏宽变化都要跟上） */
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      const next = { width: Math.max(240, Math.floor(rect.width)), height: Math.max(200, Math.floor(rect.height)) };
      setSize(next);
      stageCb.current?.(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /* 底图：revision 换一次取一次 */
  useEffect(() => {
    if (!imageUrl) {
      setImage(null);
      setImageState("idle");
      return undefined;
    }
    let alive = true;
    setImageState("loading");
    const next = new Image();
    next.onload = () => {
      if (!alive) return;
      setImage(next);
      setImageState("ready");
    };
    next.onerror = () => {
      if (!alive) return;
      setImage(null);
      setImageState("error");
    };
    next.src = imageUrl;
    return () => {
      alive = false;
    };
  }, [imageUrl]);

  const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);

  /* ---- 绘制 ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = size;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // 底色：RViz 的深灰（与「屏幕画面」并排时观感统一）
    ctx.fillStyle = "#1b2430";
    ctx.fillRect(0, 0, width, height);

    if (!map) {
      ctx.fillStyle = "rgba(112,132,156,0.85)";
      ctx.font = "13px system-ui, -apple-system, 'PingFang SC', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("无地图", width / 2, height / 2);
      ctx.textAlign = "left";
      return;
    }

    const viewport = viewportOf(map, width, height);
    const places = (u: number, v: number) => toScreen(view, map, u, v, viewport);

    // 地图外框（让「已知区域」在地图里的位置看得见）
    const topLeft = places(0, 0);
    const mapW = map.width * view.scale;
    const mapH = map.height * view.scale;

    if (image) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, topLeft.x, topLeft.y, mapW, mapH);
    } else {
      ctx.fillStyle = "#232f3d";
      ctx.fillRect(topLeft.x, topLeft.y, mapW, mapH);
      ctx.strokeStyle = "rgba(112,132,156,0.6)";
      ctx.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, mapW, mapH);
      ctx.fillStyle = "rgba(145,165,188,0.9)";
      ctx.font = "13px system-ui, -apple-system, 'PingFang SC', sans-serif";
      const text = imageState === "loading" ? "读取地图…" : "地图图像不可用";
      ctx.fillText(text, topLeft.x + 12, topLeft.y + 22);
    }

    // 1 m 网格：分辨率任意时按取整米画，缩放太小时不画（避免糊成一片）
    if (view.scale * map.resolution >= 3) {
      ctx.strokeStyle = "rgba(93,228,255,0.10)";
      ctx.lineWidth = 1;
      const step = 1; // 米
      const left = map.origin.x;
      const right = map.origin.x + map.width * map.resolution;
      const bottom = map.origin.y;
      const top = map.origin.y + map.height * map.resolution;
      ctx.beginPath();
      for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
        const { u } = worldToImage(map, { x, y: bottom });
        const screenX = places(u, 0).x;
        ctx.moveTo(screenX, topLeft.y);
        ctx.lineTo(screenX, topLeft.y + mapH);
      }
      for (let y = Math.ceil(bottom / step) * step; y <= top; y += step) {
        const { v } = worldToImage(map, { x: left, y });
        const screenY = places(0, v).y;
        ctx.moveTo(topLeft.x, screenY);
        ctx.lineTo(topLeft.x + mapW, screenY);
      }
      ctx.stroke();
    }

    // 规划路径（真实 Nav2 path，青色）
    if (path.length > 1) {
      ctx.strokeStyle = "#5de4ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      path.forEach((point, index) => {
        const { u, v } = worldToImage(map, point);
        const p = places(u, v);
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }

    // 雷达点（红色，半径按缩放走，缩小时不至于糊成实心块）
    if (scanPoints.length) {
      const r = Math.max(1, Math.min(2.2, view.scale * 0.02));
      ctx.fillStyle = "rgba(255,92,112,0.9)";
      for (const [x, y] of scanPoints) {
        const { u, v } = worldToImage(map, { x, y });
        const p = places(u, v);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 航点：编号 + 朝向箭头；当前目标加深
    waypoints.forEach((point, index) => {
      const { u, v } = worldToImage(map, point);
      const p = places(u, v);
      const active = activeIndex === index;
      const radius = Math.max(7, Math.min(15, view.scale * 0.16));
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = active ? "rgba(57,213,163,0.28)" : "rgba(78,168,255,0.18)";
      ctx.fill();
      ctx.strokeStyle = active ? "#39d5a3" : "#4ea8ff";
      ctx.lineWidth = 2;
      ctx.stroke();
      // 朝向
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(-point.yaw) * radius * 1.6, p.y + Math.sin(-point.yaw) * radius * 1.6);
      ctx.strokeStyle = active ? "#39d5a3" : "#4ea8ff";
      ctx.stroke();
      ctx.fillStyle = "#eaf3ff";
      ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText(String(index + 1), p.x + radius + 3, p.y - radius - 1);
    });

    // 临时位姿预览（正在拖方向）
    const ghost = pendingPose ?? preview;
    if (ghost) {
      const { u, v } = worldToImage(map, ghost);
      const p = places(u, v);
      drawRobot(ctx, p.x, p.y, ghost.yaw, view.scale, "stale", sprite);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#f2b84b";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(-ghost.yaw) * 44, p.y + Math.sin(-ghost.yaw) * 44);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 机器人当前位姿
    if (pose) {
      const { u, v } = worldToImage(map, pose);
      const p = places(u, v);
      drawRobot(ctx, p.x, p.y, pose.yaw, view.scale, "live", sprite);
    }

    // 比例尺：随缩放变化，取一个整米数
    const targetPx = 90;
    const meters = Math.max(0.5, Math.round((targetPx / (map.resolution * view.scale)) * 2) / 2);
    const px = meters / map.resolution * view.scale;
    ctx.fillStyle = "rgba(234,243,255,0.9)";
    ctx.fillRect(14, height - 22, px, 3);
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`${meters} m`, 14, height - 28);
    ctx.fillStyle = "rgba(145,165,188,0.9)";
    ctx.fillText(`${map.width}×${map.height} px · ${map.resolution.toFixed(3)} m/px`, 14, height - 40);
    if (map.bounds) {
      ctx.textAlign = "right";
      ctx.fillText(`已知区域 ${map.bounds[2] - map.bounds[0]}×${map.bounds[3] - map.bounds[1]} px · rev ${map.revision}`, width - 14, height - 40);
      ctx.textAlign = "left";
    }
  }, [dpr, image, imageState, map, pendingPose, path, pose, preview, scanPoints, size, sprite, view, waypoints, activeIndex]);

  /* ---- 交互 ---- */

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): CartPose | null => {
      const canvas = canvasRef.current;
      if (!canvas || !map) return null;
      const rect = canvas.getBoundingClientRect();
      const { u, v } = toImage(
        view,
        map,
        clientX - rect.left,
        clientY - rect.top,
        viewportOf(map, size.width, size.height),
      );
      // 整数像素中心取 u+0.5 / v+0.5（文档 §3）
      const world = imageToWorld(map, Math.floor(u) + 0.5, Math.floor(v) + 0.5);
      return { x: world.x, y: world.y, yaw: 0 };
    },
    [map, size.height, size.width, view],
  );

  /**
   * 指针按下。
   *
   * 按键分工是这一页最容易做拧的地方，写清楚：
   *   · 左键 = **当前模式的动作**（放航点 / 定初始位姿），拖出去就是定朝向；
   *   · 右键、中键、Shift+左键 = 平移。
   * 之前把左键也当平移，结果「点击放航点」永远放不下 —— 指针捕获把这次
   * 点击吃成了平移，用户看到的是图不动、航点也不出现。
   */
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!map) return;
    const canvas = canvasRef.current;
    /*
      捕获指针只是为了让拖拽移出画布也继续跟手，**它失败不能吃掉这次点击**：
      没有活跃指针时（自动化脚本、部分触屏）`setPointerCapture` 会抛
      NotFoundError，异常一冒出去，后面的分支根本不会执行 ——
      表现是「点地图没反应」，而不是一个能看见的报错。
    */
    try {
      canvas?.setPointerCapture(event.pointerId);
    } catch {
      /* 不捕获也能用：指针在画布内移动时事件照样来 */
    }
    const wantsPan = event.button === 1 || event.button === 2 || event.shiftKey;
    const placeable = (mode === "waypoint" || mode === "target") && onWaypoint;
    const locatable = mode === "locate" && onLocate;
    const at = screenToWorld(event.clientX, event.clientY);

    if (wantsPan || (!placeable && !locatable) || !at || !insideMap(map, at)) {
      drag.current = { kind: "pan", startX: event.clientX, startY: event.clientY, dx: view.dx, dy: view.dy };
      return;
    }
    drag.current = { kind: locatable ? "locate" : "waypoint", at };
    setPreview({ ...at, yaw: 0 });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    if (!current) return;
    if (current.kind === "pan") {
      const fallback: CartMapMeta = {
        width: 1,
        height: 1,
        resolution: 1,
        origin: { x: 0, y: 0, yaw: 0 },
        frame_id: "map",
        bounds: null,
        revision: 0,
      };
      const port = viewportOf(map ?? fallback, size.width, size.height);
      onViewChange(
        clampView(
          { scale: view.scale, dx: current.dx + (event.clientX - current.startX), dy: current.dy + (event.clientY - current.startY) },
          map ?? fallback,
          port.width,
          port.height,
        ),
      );
      return;
    }
    const at = screenToWorld(event.clientX, event.clientY);
    if (!at) return;
    const yaw = Math.atan2(at.y - current.at.y, at.x - current.at.x);
    // 拖得太短视为「只取位置」，yaw 保持 0（避免手抖出来一个随机朝向）
    const distance = Math.hypot(at.x - current.at.x, at.y - current.at.y);
    setPreview({ x: current.at.x, y: current.at.y, yaw: distance > 0.12 ? yaw : 0 });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    drag.current = null;
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      /* 没捕获成功过，释放自然也会抛；无妨 */
    }
    if (!current || current.kind === "pan") return;
    const final = preview ?? { ...current.at, yaw: 0 };
    setPreview(null);
    if (!map || !insideMap(map, final)) return;
    if (current.kind === "waypoint") onWaypoint?.(final);
    else if (current.kind === "locate") onLocate?.(final);
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!map) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextScale = clampScale(view.scale * factor);
    // 以鼠标位置为锚点缩放：先算出锚点对应的图像坐标，缩放后让它仍落在同一屏幕位置
    const anchor = toImage(view, map, cx, cy, viewportOf(map, size.width, size.height));
    const dx = cx - size.width / 2 - (anchor.u - map.width / 2) * nextScale;
    const dy = cy - size.height / 2 - (anchor.v - map.height / 2) * nextScale;
    const port = viewportOf(map, size.width, size.height);
    onViewChange(clampView({ scale: nextScale, dx, dy }, map, port.width, port.height));
  };

  const actionable = Boolean(onWaypoint) || Boolean(onLocate);
  const cursor = actionable && mode !== "pan" ? "crosshair" : "grab";

  /*
    画布元素按**地图原始宽高比**居中占位（`aspect-ratio`），首帧还没画出来时
    也不会先被容器拉成一个变形的方块；绘制里再用同一个比例做视口。
    地图还没到手时没有比例可用，退回铺满。
  */
  return (
    <div className={className ?? "cart-map"} ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="cart-map__canvas"
        style={{ width: "100%", height: "100%", cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(event) => event.preventDefault()}
      />
      <MapOverlay
        waypoints={waypoints.length}
        activeIndex={activeIndex}
        mode={mode}
        onReset={() => onViewChange({ ...DEFAULT_VIEW })}
      />
    </div>
  );
}

/** 画面右下角的提示条：当前交互模式 + 恢复视图 */
function MapOverlay({
  waypoints,
  activeIndex,
  mode,
  onReset,
}: {
  waypoints: number;
  activeIndex: number | null;
  mode: MapCanvasMode;
  onReset: () => void;
}) {
  const hint =
    mode === "waypoint"
      ? "左键放航点 · 拖出朝向 · 右键平移"
      : mode === "locate"
        ? "左键定位置 · 拖出车头方向"
        : mode === "target"
          ? "左键点新位置 · 拖出朝向"
          : "拖动平移 · 滚轮缩放";
  return (
    <div className="cart-map__hint">
      <span>{hint}</span>
      <span className="cart-map__count">
        航点 {waypoints}
        {activeIndex !== null ? ` · 前往第 ${activeIndex + 1} 个` : ""}
      </span>
      <button type="button" className="cart-map__reset" onClick={onReset}>
        重置视图
      </button>
    </div>
  );
}
