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
import { shanghaiSites } from "../data";
import type { CityGeoJSON } from "@/types/map";

import chinaMapData from "@/assets/map/china.json";
import shanghaiMapData from "@/assets/map/shanghai.json";
import chinaOutlineData from "@/assets/map/china_outline.json";

const chinaData = chinaMapData as CityGeoJSON,
  shanghaiData = shanghaiMapData as CityGeoJSON,
  chinaOutline = chinaOutlineData as CityGeoJSON;

/**
 * 中国模式：主体 + 国界外轮廓；上海模式：只换主体（上海不需要外轮廓）。
 *
 * fitPadding 说明：取景距离由 base.tsx 按投影包围盒自动反解，
 * 这里只给留白系数。中国与上海经纬跨度差 13 倍，靠这个把两者框到同样的画面比例；
 * 上海略多留一点边，避免崇明岛顶到画面上沿。
 */
const DATASETS: Record<
  MapMode,
  { data: CityGeoJSON; outline?: CityGeoJSON; fitPadding: number }
> = {
  // 取景由 base.tsx 按投影包围盒反解距离，这里只给留白系数。
  // 两者跨度差 13 倍，但都留同样比例的余量，所以系数接近。
  china: { data: chinaData, outline: chinaOutline, fitPadding: 1.14 },
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

  /**
   * 上海模式必须有名字的区：有古建点位的区不能被去重叠算法挤掉，
   * 否则「点位在图上、名字却没了」。
   */
  const pinnedLabels = useMemo(
    () =>
      loadedMode === "shanghai"
        ? shanghaiSites.map((site) => site.district).filter((d): d is string => !!d)
        : undefined,
    [loadedMode],
  );

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
        dpr={[1, 2]}>
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
          {on("bottom") ? <Bottom /> : null}
        </Suspense>
        {on("mirror") ? <Mirror /> : null}
        {on("beam") ? <BeamLight /> : null}
      </Canvas>
    </CanvasWrapper>
  );
}
