import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import styled from "styled-components";
import { Canvas } from "@react-three/fiber";
import { gsap } from "gsap";
import Lights from "./lights";
import Mirror from "./mirror";
import Base from "./base";
import LoadingVeil from "../LoadingVeil";
import Bottom from "./bottom";
import BeamLight from "./beamLight";
import { useCanvasRoot } from "./useCanvasRoot";
import { MAP_MODE_EVENT, useDashboardStore, type MapMode } from "../map/store";
import { useConfigStore } from "./stores";
import { chinaSites, shanghaiSites } from "../data";
import type { CityGeoJSON } from "@/types/map";
import { geoMercator } from "d3-geo";

import chinaMapData from "@/assets/map/china.json";
import shanghaiMapData from "@/assets/map/shanghai.json";
import chinaOutlineData from "@/assets/map/china_outline.json";
import chinaSurface from "@/assets/map/china_surface.png";
import shanghaiSurface from "@/assets/map/shanghai_surface.png";

const chinaData = chinaMapData as CityGeoJSON,
  shanghaiData = shanghaiMapData as CityGeoJSON,
  chinaOutline = chinaOutlineData as CityGeoJSON;

/**
 * **贴图预取**（A01 的真正修法）。
 *
 * 实测：`china_surface.png`（1.5 MB）的请求是在 `Base` 挂载之后才发出的，
 * 而地表贴图要等它下载完才能烤 —— 整条链路 **17 秒**
 * （`performance.now()` 实测 imgAt = 17046）。这 17 秒画布上什么都没有，
 * 就是用户看到的「纯黑空屏」。
 *
 * 光加遮罩不够：遮罩只把「黑屏」换成「正在初始化」，17 秒的等待本身还在。
 * 所以把请求提到**模块求值阶段** —— 组件还没开始渲染，浏览器已经在下载；
 * `useImage` 之后再请求同一张图走 HTTP 缓存，`onload` 几乎立刻回调。
 *
 * 中国与上海都预取：下钻时同样不该等。
 */
void [chinaSurface, shanghaiSurface].map((src) => {
  const pre = new Image();
  pre.decoding = "async";
  pre.src = src;
  return pre;
});

/**
 * 中国模式：主体 + 国界外轮廓；上海模式：只换主体（上海不需要外轮廓）。
 *
 * fitPadding 说明：取景距离由 base.tsx 按投影包围盒自动反解，
 * 这里只给留白系数。中国与上海经纬跨度差 13 倍，靠这个把两者框到同样的画面比例；
 * 上海略多留一点边，避免崇明岛顶到画面上沿。
 */
/**
 * 量出某个数据集在**世界坐标**里的最大边。
 *
 * 与 base.tsx 用同一套 geoMercator + `new Vector2(x, -y)`，也乘同样的外层
 * scale 0.5 —— 两边口径必须一致，否则 Bottom / BeamLight 又会与地图对不上。
 *
 * 为什么需要它：Demo2 的 Bottom(16) 与 BeamLight(range 20) 都是为世界尺寸
 * 约 8.5 的四川写死的；我们的中国地图约 82 单位，照抄就小了一个数量级。
 */
function worldExtent(data: CityGeoJSON): number {
  const projection = geoMercator()
    .center(data.features[0].properties.centroid)
    .translate([0, 0]);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const feature of data.features) {
    for (const polygon of feature.geometry.coordinates) {
      for (const ring of polygon) {
        for (const coord of ring) {
          const p = projection(coord as [number, number]);
          if (!p) continue;
          const x = p[0];
          const y = -p[1];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  const OUTER_SCALE = 0.5; // 与 base.tsx 的 <group scale={[0.5,0.5,0.5]}> 对齐
  return Math.max(maxX - minX, maxY - minY) * OUTER_SCALE;
}

const DATASETS: Record<
  MapMode,
  { data: CityGeoJSON; outline?: CityGeoJSON; fitPadding: number }
> = {
  // 取景由 base.tsx 按投影包围盒反解距离，这里只给留白系数。
  // 两者跨度差 13 倍，但都留同样比例的余量，所以系数接近。
  /*
   * 留白系数。用户的目标构图（图 3）里地图是画面的主角，
   * 而「包围球」反解出来的距离本身偏保守（把地图当成圆来框，
   * 横长条的中国因此被推远）。收小一点，让地图真正占住中央。
   * 具体值靠 ?fit= 逐档截图比对定，这里先给一个起点。
   */
  /*
   * 1.14 → 0.92：用户看图 3 觉得中国还不够大。这个系数越小相机越近，
   * 0.92 在地图明显变大一档的同时仍留出左右面板的安全距离。
   */
  china: { data: chinaData, outline: chinaOutline, fitPadding: 0.74 },
  // 为上海纵向轮廓留出上下边距，避免崇明、奉贤与底部操作条相撞。
  shanghai: { data: shanghaiData, fitPadding: 1.08 },
};

/** 下钻 / 返回的淡出淡入时长 */
const FADE_DURATION = 0.4;

const CanvasWrapper = styled.div`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: #000000;
`;

// Updating the loading/panel signals must not rebuild all map geometries.
function MapStage({ children }: { children: ReactNode }) {
  const introStarted = useConfigStore((state) => state.introStarted);
  const mapPlayComplete = useConfigStore((state) => state.mapPlayComplete);
  useLayoutEffect(() => {
    useConfigStore.setState({ introStarted: false, mapPlayComplete: false, sceneReady: false, veiled: true });
  }, []);
  return (
    <CanvasWrapper data-map-phase={!introStarted ? "loading" : mapPlayComplete ? "ready" : "intro"} aria-busy={!introStarted}>
      {children}
      <LoadingVeil visible={!introStarted} />
    </CanvasWrapper>
  );
}

export interface MapProps {
  mode: MapMode;
  /** 开场时间线播完后回调一次，用于外部启动面板入场 */
  onReady?: () => void;
}

/**
 * 转场：整个地图淡出 → 换数据（重新取景）→ 淡入。
 * 作用在 CanvasWrapper 的 DOM 透明度上，不碰 Demo2 的任何材质参数。
 */
export default function Map(props: MapProps) {
  const { mode } = props;
  const setMode = useDashboardStore((state) => state.setMode);
  const setTransitioning = useDashboardStore((state) => state.setTransitioning);

  // 用 ref 存回调：父组件每次渲染都会传新函数，不能让回调打穿时间线的依赖
  const onReadyRef = useRef(props.onReady);
  onReadyRef.current = props.onReady;

  const { canvasRef, getRoot } = useCanvasRoot();
  const [loadedMode, setLoadedMode] = useState<MapMode>(mode);
  /**
   * 真正的切换：淡出 → 换数据（重新取景）→ 淡入。
   * 点上海轮廓、面包屑、按钮三条入口都收敛到这里。
   */
  const runTransition = useCallback(
    (next: MapMode) => {
      if (next === loadedMode) return;
      const wrapper = getRoot();
      if (!wrapper) {
        setLoadedMode(next);
        setMode(next);
        return;
      }

      setTransitioning(true);
      // 真的换图了：重新落遮罩并重新武装开场（揭幕 effect 会幂等地把它揭开）
      useConfigStore.setState({ veiled: true, introStarted: false, mapPlayComplete: false, sceneReady: false });
      const fade = { value: 1 };
      const tl = gsap.timeline({
        onComplete: () => setTransitioning(false),
        onUpdate: () => {
          wrapper.style.opacity = String(fade.value);
        },
      });
      tl.to(fade, { value: 0, duration: FADE_DURATION, ease: "power2.in" });
      tl.add(() => {
        setLoadedMode(next);
        setMode(next);
      });
      tl.to(fade, { value: 1, duration: FADE_DURATION, ease: "power2.out" });
      return () => tl.kill();
    },
    [loadedMode, getRoot, setMode, setTransitioning],
  );

  // 外部（面包屑 / 按钮 / 自定义事件）请求切换模式
  useEffect(() => {
    const handler = (event: Event) => {
      const next = (event as CustomEvent<MapMode>).detail;
      if (next === "china" || next === "shanghai") runTransition(next);
    };
    window.addEventListener(MAP_MODE_EVENT, handler);
    return () => window.removeEventListener(MAP_MODE_EVENT, handler);
  }, [runTransition]);

  // 父组件直接改 mode 时同样播放转场（不再瞬间切换）
  useEffect(() => {
    if (mode !== loadedMode) runTransition(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const dataset = DATASETS[loadedMode];

  /** 地图在世界坐标里的最大边；Bottom 与 BeamLight 的尺寸都由它派生 */
  const extent = useMemo(() => worldExtent(dataset.data), [dataset.data]);

  /**
   * 必须有名字的区域，**列表顺序就是放置优先级**（越靠前越先占位）。
   *
   * 两类东西必须显示，否则会「点位在图上、名字却没了」：
   *   1. 有古建点位的省份
   *   2. 彼此挨得过近、按面积排序时总被顶掉的小区域 —— 京津、沪苏浙、
   *      港澳、宁夏、江西。之前地图上少了「北京」就是被更小的天津顶掉的。
   */
  const pinnedLabels = useMemo(() => {
    if (loadedMode === "shanghai") {
      return shanghaiSites
        .map((site) => site.district)
        .filter((d): d is string => !!d);
    }
    const siteProvinces = chinaSites
      .map((site) => site.province)
      .filter((p): p is string => !!p);
    const mustShow = [
      "北京",
      "上海",
      "天津",
      "重庆",
      "河北",
      "江苏",
      "浙江",
      "安徽",
      "福建",
      "江西",
      "宁夏",
      "香港",
      "澳门",
      "海南",
    ];
    return [...new Set([...mustShow, ...siteProvinces])];
  }, [loadedMode]);

  // 诊断开关：?scene=no<图元名> 逐层关闭地图元素，见 base.tsx 的 debug prop
  const dbg = new URLSearchParams(window.location.search).get("scene") ?? "";
  const on = (name: string) => dbg !== `no${name}` && dbg !== "minimal";

  return (
    <MapStage>
      <Canvas
        ref={canvasRef}
        camera={{
          fov: 70,
          position: [3, 20, 10],
        }}
        dpr={[1, 2]}
        /*
         * 标定模式（?fit= / ?fitprobe=）下保留绘制缓冲。
         *
         * WebGL 默认在每帧提交后清掉缓冲，于是 `ctx.drawImage(glCanvas)` 有一半概率
         * 读到**全黑** —— 实测同一个 fit 连采两次，一次读到 69% 宽、一次 0 个亮像素。
         * 取景标定全靠这个回读，读数不稳就没法定值。
         *
         * `preserveDrawingBuffer` 有性能代价，所以只在标定模式下打开，
         * 正常运行时行为与之前完全一致。
         */
        gl={{
          antialias: true,
          alpha: false,
          preserveDrawingBuffer:
            typeof window !== "undefined" &&
            (new URLSearchParams(window.location.search).has("fit") ||
              new URLSearchParams(window.location.search).has("fitprobe")),
        }}>
        <color attach="background" args={["#000000"]} />
        {on("lights") ? <Lights /> : null}
        <Suspense fallback={null}>
          {on("base") ? (
            <Base
              key={loadedMode}
              data={dataset.data}
              outlineData={dataset.outline}
              fitPadding={dataset.fitPadding}
              surfaceKey={loadedMode}
              pinnedLabels={pinnedLabels}
              debug={dbg}
              onSelectRegion={() => runTransition("shanghai")}
              onReady={() => onReadyRef.current?.()}
            />
          ) : null}
          {on("bottom") ? <Bottom size={extent * 1.25} /> : null}
        </Suspense>
        {on("mirror") ? <Mirror /> : null}
        {on("beam") ? (
            /*
             * topScale 由 extent/20（中国约 4.1）改为 extent/70（约 1.2）。
             *
             * 4.1 让光柱升到 41~123 单位高，而相机在 96 单位外看向原点 ——
             * 它们绝大多数时间在画面上方之外，所以「好像没有光柱」。
             * 光柱是贴地表的环境光效，高度该与地图本身的尺度相称：
             * extent/70 把它们收在视野内的低空，持续可见。
             */
            <BeamLight range={extent * 1.15} topScale={extent / 70} />
          ) : null}
      </Canvas>
    </MapStage>
  );
}
