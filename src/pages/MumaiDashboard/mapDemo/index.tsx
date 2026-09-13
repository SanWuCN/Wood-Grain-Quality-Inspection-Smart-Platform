import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { Canvas } from "@react-three/fiber";
import { gsap } from "gsap";
import Lights from "./lights";
import Mirror from "./mirror";
import Base from "./base";
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
  china: { data: chinaData, outline: chinaOutline, fitPadding: 1.14 },
  /*
   * 上海 1.08 → 0.62。
   *
   * 实测下钻后上海只占 viewport **28% 宽**（同一次加载内量中国是 55%），
   * B05「不得出现过小」不达标。上一轮把取景距离下限从 2 放到 0.2，
   * 只把它从 12% 抬到 28% —— 说明还有一个与地图尺度无关的因子在推远相机。
   *
   * 既然量不出那个因子，就按实测比例直接标定：28% → 约 50% 需要距离缩到
   * 约 1/1.8，系数 1.08 / 1.8 ≈ 0.6，取 0.62 稍留余量，避免崇明岛顶到上沿。
   *
   * 这是**经验标定**，不是从几何推出来的 —— 注释写明，免得后面有人
   * 以为它与中国的 1.14 是同一套推导。
   */
  shanghai: { data: shanghaiData, fitPadding: 0.62 },
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

/**
 * 加载遮罩（A01）。
 *
 * 原来这里是 `<Suspense fallback={null}>` —— DEM 贴图加载 + 2048px 地表烘焙
 * 大约要 3 秒，这 3 秒画布是纯黑的、连一个像素的反馈都没有。
 * 用户的原话是「刚打开网页加载是黑屏状态，没有加载动画」。
 *
 * 现在盖一层与 Demo2 同语言的极简遮罩：深黑蓝底 + 极弱中心光 + 一行字 + 一条细线。
 * 它等的是 `onSceneReady`（贴图烤好）而不是 `onReady`（开场播完）——
 * 两者中间隔着整个 3.5 秒开场，等错了就等于把开场也遮掉。
 */
function LoadingVeil({ visible }: { visible: boolean }) {
  return (
    <div className={`map-veil${visible ? "" : " is-gone"}`} aria-hidden={!visible}>
      <div className="map-veil__core">
        <b>木脉智检</b>
        <span>MAP INITIALIZING</span>
        <i className="map-veil__line" />
      </div>
    </div>
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
   * 地表贴图烤好了没有：遮罩等它，不等开场动画。
   * 走 store 而不是 props 回调 —— 这套 setState 在本模块已经跑通。
   */
  /**
   * 遮罩撤掉的时刻 = `mapPlayComplete`（镜头推完 = 地图开始显形）。
   *
   * 试过用「贴图就绪」当信号，但它偏偏撤不干净（试了两套写法）。
   * 改用这个已经跑通的信号还有一个好处：遮罩盖住的是
   * 「加载 + 镜头飞行」整段 —— 这两段时间画面本来就没有地图主体，
   * 揭开时正好接上 2.5→3.5s 的材质淡入，中间不留暗场。
   */
  /**
   * 遮罩是否还盖着。**走 store 不走 useState** —— 组件重挂载时本地状态会丢，
   * 遮罩就会在地图已经画好之后又盖回来（实测 t=8s 有地图、t=12s 变黑）。
   */
  const veiled = useConfigStore((state) => state.veiled);

  /**
   * 换图（下钻 / 返回）时重新落遮罩。
   *
   * 不这么做的话，切到上海会先看到旧的中国地图被淡出、然后一小段空白 ——
   * 那正是加载遮罩要消掉的东西。
   */
  /**
   * 揭幕：挂载后 900ms 撤遮罩，**同一帧**置 introArmed 让开场开始。
   * 900ms 是留给预取命中的窗口；贴图万一还没到，base 的时间线会等它，
   * 不会出现「遮罩撤了但地图不来」。
   */
  useEffect(() => {
    /*
     * 幂等：已经揭开过就直接返回。
     *
     * 原来这里无条件 setVeiled(true) + 重设定时器，组件一重挂载（本项目有
     * 数百次重渲染量级）effect 就跑得比 900ms 更频繁，定时器永远等不到触发，
     * 遮罩永久留在屏幕上 —— 地图明明画好了却看不见。
     * 现在只有 runTransition 真的换图时才会把 veiled 置回 true。
     */
    if (!useConfigStore.getState().veiled) return;
    const timer = window.setTimeout(() => {
      useConfigStore.setState({ veiled: false });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [loadedMode]);

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
      useConfigStore.setState({ veiled: true });
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
    <CanvasWrapper>
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
        {on("beam") ? <BeamLight range={extent * 1.15} topScale={extent / 20} /> : null}
      </Canvas>
      <LoadingVeil visible={veiled} />
    </CanvasWrapper>
  );
}
