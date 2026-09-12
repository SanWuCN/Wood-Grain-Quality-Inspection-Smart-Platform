/**
 * MapScene —— 3D 地图场景总装
 *
 * 结构（对应 demo2 的 map/index.tsx，按业务扩展）：
 *   Canvas
 *     ├─ Lights
 *     ├─ MapBase            镜面 + 旋转光环 + 径向辉光
 *     ├─ MapGroup(中国)      挤出地图 + 描边 + 侧壁扫光
 *     ├─ MapGroup(上海)      同上，转场时才可见
 *     ├─ SiteMarkers        业务点位（采集/风险/工单/当前任务）
 *     ├─ FlyLines           数据汇聚飞线
 *     ├─ BeamLights         环境光柱
 *     └─ OrbitControls
 *
 * 地图统一绕 X 轴 -90° 旋转，「平面 y」变成「世界 z」，挤出深度自然朝上。
 * 两个模式共用一套共享 uniform（mapUniforms），所以「整个地图淡入淡出」
 * 只需要 tween 一个数字。
 */

import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useTexture } from "@react-three/drei";
import { gsap } from "gsap";
import { Color, Group, Vector3, type PerspectiveCamera, type Texture } from "three";
import type { ComponentRef } from "react";

import { buildMapModel } from "./geometry";
import { chinaRegions, shanghaiRegions } from "./mapData";
import MapGroup from "./MapGroup";
import MapBase from "./MapBase";
import SiteMarker from "./SiteMarker";
import FlyLines from "./FlyLines";
import BeamLights from "./BeamLights";
import LightBurst from "./LightBurst";
import { mapUniforms } from "./materials";
import {
  cameraIntro,
  detailProgress,
  introProgress,
  MAP_MODE_EVENT,
  useDashboardStore,
  type MapMode,
} from "./store";
import type { Site } from "../data";

import chinaSurface from "@/assets/map/china_surface.png";
import chinaNormal from "@/assets/map/china_normal.png";
import shanghaiSurface from "@/assets/map/shanghai_surface.png";
import shanghaiNormal from "@/assets/map/shanghai_normal.png";

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

interface ModeConfig {
  width: number;
  depth: number;
  camera: { radius: number; height: number; fov: number };
  /** 轨道目标的纵向偏移：崇明岛在北侧，上海整体重心偏上，需要把视线中心往下压一点 */
  targetZ: number;
}

const MAP_CONFIG: Record<MapMode, ModeConfig> = {
  china: {
    // 地图是整页的绝对视觉中心：demo2 里地图横向约占屏宽 45%，
    // 这里按「接近中间栏满宽」取值，不做成小摆件
    width: 17.6,
    // 厚度：demo2 是「薄板 + 明显侧壁」，太厚会挡省界，太薄没有体积感
    depth: 0.66,
    camera: { radius: 17.4, height: 12.2, fov: 40 },
    targetZ: 0.4,
  },
  shanghai: {
    width: 17.0,
    depth: 0.56,
    camera: { radius: 17.0, height: 12.0, fov: 40 },
    targetZ: 0.9,
  },
};

/** 上海在中国地图上的位置，转场时镜头朝这里推进 */
const SHANGHAI_LNG_LAT: [number, number] = [121.47, 31.23];

/** 开场镜头的起点：高空远景 */
const INTRO_FAR = { y: 40, z: 44 };

/** drei OrbitControls 的实例类型（避免额外依赖 three-stdlib） */
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

interface SceneProps {
  sites: Site[];
  flyLineSeeds: { id: string; from: [number, number] }[];
  selectedSite: string;
  selectedDistrict: string;
  onSelectSite: (id: string) => void;
  onDistrictSelect: (name: string) => void;
  chinaTexture: MapTextures;
  shanghaiTexture: MapTextures;
}

interface MapTextures {
  surface: Texture;
  normal: Texture;
}

/**
 * 场景内容。
 *
 * 贴图由 MapScene 预先加载后传进来（见 useMapAssets），所以这里不再自行 useTexture。
 * 这一点很关键：如果让 Scene 自己 useTexture，它会在 <Suspense> 里先被挂载一次
 * （用于抛出 Promise），再被卸载、由 fallback 顶替，最后重新挂载；
 * 只在挂载时跑一次的 effect 会落在那份「已经被丢弃的实例」上，
 * 表现就是开场动画永远不开始、地图一直停在 opacity 0。
 */
function Scene(props: SceneProps) {
  const mode = useDashboardStore((state) => state.mode);
  const setMode = useDashboardStore((state) => state.setMode);
  const setTransitioning = useDashboardStore((state) => state.setTransitioning);
  const three = useThree();

  // 开发期调试钩子（生产构建里 import.meta.env.DEV 为 false，会被完全摇掉）
  if (import.meta.env.DEV) {
    (window as unknown as { __mumai?: unknown }).__mumai = {
      three,
      stores: useDashboardStore,
      progress: { introProgress, detailProgress, mapUniforms },
    };
  }

  const chinaTexture = props.chinaTexture;
  const shanghaiTexture = props.shanghaiTexture;

  // 两个模型只建一次（南海诸岛单独做插图，从主图里剔除，见 mapData.ts）
  const models = useMemo(
    () => ({
      china: buildMapModel(chinaRegions, MAP_CONFIG.china.width),
      shanghai: buildMapModel(shanghaiRegions, MAP_CONFIG.shanghai.width),
    }),
    [],
  );

  const chinaGroup = useRef<Group>(null);
  const shanghaiGroup = useRef<Group>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const shanghaiAnchor = useMemo(
    () => models.china.lngLatToWorld(SHANGHAI_LNG_LAT[0], SHANGHAI_LNG_LAT[1]),
    [models],
  );

  /**
   * 光爆中心：中国放在上海位置附近（演示的汇聚点是本轮工单所在地），
   * 上海则放在松江示例寺一带，避免盖住区界。
   */
  const burstCenter = useMemo(() => {
    if (mode === "shanghai") return models.shanghai.lngLatToWorld(121.2235, 31.032);
    return models.china.lngLatToWorld(SHANGHAI_LNG_LAT[0], SHANGHAI_LNG_LAT[1]);
  }, [mode, models]);

  /* -------------------- 中国 ⇄ 上海 转场 -------------------- */
  const runTransition = useCallback(
    (to: MapMode) => {
      const controls = controlsRef.current;
      if (!controls) return;
      if (useDashboardStore.getState().transitioning) return;
      if (useDashboardStore.getState().mode === to) return;

      setTransitioning(true);
      const config = MAP_CONFIG[to];
      const tl = gsap.timeline({ onComplete: () => setTransitioning(false) });
      const finalPos = new Vector3(0, config.camera.height, config.camera.radius);

      if (to === "shanghai") {
        // 1) 镜头朝上海推进，中国地图跟着淡出
        tl.to(camera.position, { x: shanghaiAnchor.x * 0.4, y: 9.6, z: 11.8, duration: 1.15, ease: "power2.in" }, 0);
        tl.to(controls.target, { x: shanghaiAnchor.x * 0.62, y: shanghaiAnchor.y * 0.62, z: 0.4, duration: 1.15, ease: "power2.in" }, 0);
        tl.to(mapUniforms.uOpacity, { value: 0, duration: 0.48, ease: "power2.in" }, 0.7);
        // 2) 露出的瞬间切到上海，并从略微放大收拢
        tl.add(() => {
          if (shanghaiGroup.current) shanghaiGroup.current.scale.setScalar(1.55);
          mapUniforms.uReveal.value = 0.12;
          setMode("shanghai");
        }, 1.18);
        tl.to(mapUniforms.uOpacity, { value: 1, duration: 0.72, ease: "power2.out" }, 1.22);
        tl.to(mapUniforms.uReveal, { value: 1, duration: 1.05, ease: "power2.out" }, 1.22);
        tl.to(shanghaiGroup.current?.scale ?? {}, { x: 1, y: 1, z: 1, duration: 1.25, ease: "power3.out" }, 1.22);
        tl.to(camera.position, { ...finalPos, duration: 1.25, ease: "power2.out" }, 1.22);
        tl.to(controls.target, { x: 0, y: 0, z: 0.4, duration: 1.25, ease: "power2.out" }, 1.22);
      } else {
        // 返回全国：上海放大淡出，中国地图从大收拢
        tl.to(mapUniforms.uOpacity, { value: 0, duration: 0.45, ease: "power2.in" }, 0.45);
        tl.to(shanghaiGroup.current?.scale ?? {}, { x: 1.45, y: 1.45, z: 1.45, duration: 0.9, ease: "power2.in" }, 0);
        tl.add(() => {
          if (chinaGroup.current) chinaGroup.current.scale.setScalar(1.45);
          mapUniforms.uReveal.value = 0.2;
          setMode("china");
        }, 0.9);
        tl.to(mapUniforms.uOpacity, { value: 1, duration: 0.72, ease: "power2.out" }, 0.94);
        tl.to(mapUniforms.uReveal, { value: 1, duration: 1.05, ease: "power2.out" }, 0.94);
        tl.to(chinaGroup.current?.scale ?? {}, { x: 1, y: 1, z: 1, duration: 1.25, ease: "power3.out" }, 0.94);
        tl.to(camera.position, { ...finalPos, duration: 1.25, ease: "power2.out" }, 0.94);
        tl.to(controls.target, { x: 0, y: 0, z: 0.4, duration: 1.25, ease: "power2.out" }, 0.94);
      }
    },
    [camera, setMode, setTransitioning, shanghaiAnchor],
  );

  // 通过自定义事件接收外部的模式请求（避免 prop 回环）
  useEffect(() => {
    const handler = (event: Event) => runTransition((event as CustomEvent<MapMode>).detail);
    window.addEventListener(MAP_MODE_EVENT, handler);
    return () => window.removeEventListener(MAP_MODE_EVENT, handler);
  }, [runTransition]);

  /* -------------------- 点位与飞线 -------------------- */
  const config = MAP_CONFIG[mode];
  const model = mode === "china" ? models.china : models.shanghai;

  const sitePoints = useMemo(
    () =>
      props.sites.map((site) => {
        const p = model.lngLatToWorld(site.coordinate[0], site.coordinate[1]);
        return { site, position: [p.x, p.y, config.depth + 0.02] as [number, number, number] };
      }),
    [props.sites, model, config.depth],
  );

  const flyLines = useMemo(() => {
    const source = models[mode];
    if (mode === "shanghai") {
      // 上海：区与区之间的数据汇聚
      const hub = source.lngLatToWorld(121.22, 31.02);
      return props.flyLineSeeds.slice(0, 6).map((line, index) => {
        const from = source.lngLatToWorld(line.from[0], line.from[1]);
        return {
          id: `sh-${index}`,
          from: [from.x, from.y] as [number, number],
          to: [hub.x, hub.y] as [number, number],
          primary: index < 2,
        };
      });
    }
    // 中国：各地数据汇聚到上海
    const hub = source.lngLatToWorld(SHANGHAI_LNG_LAT[0], SHANGHAI_LNG_LAT[1]);
    return props.flyLineSeeds.map((line, index) => {
      const from = source.lngLatToWorld(line.from[0], line.from[1]);
      return {
        id: `cn-${index}`,
        from: [from.x, from.y] as [number, number],
        to: [hub.x, hub.y] as [number, number],
        primary: index < 3,
      };
    });
  }, [mode, models, props.flyLineSeeds]);

  /* -------------------- 可视性同步 -------------------- */
  useEffect(() => {
    if (chinaGroup.current) chinaGroup.current.visible = mode === "china";
    if (shanghaiGroup.current) shanghaiGroup.current.visible = mode === "shanghai";
  }, [mode]);

  /* -------------------- 逐帧推进共享时间 uniform -------------------- */
  useFrame((_, delta) => {
    mapUniforms.uTime.value += delta;
  });

  /**
   * 开场镜头：起点是高空远景，终点是本模式的目标机位。
   *
   * 这里是「被动等待」模式：挂载时先把相机摆到远景，然后在 useFrame 里
   * watch cameraIntro.started；时间线把它置为 true 之后才开始推镜头。
   * 不用「注册回调」，是为了彻底避开注册时机与 effect 顺序错开的问题。
   */
  const introRunning = useRef(false);

  useEffect(() => {
    const config = MAP_CONFIG[useDashboardStore.getState().mode];
    camera.position.set(0, INTRO_FAR.y, INTRO_FAR.z);
    camera.lookAt(0, 0, config.targetZ);
    introRunning.current = false;
  }, [camera]);

  useFrame(() => {
    if (!cameraIntro.started || introRunning.current) return;
    introRunning.current = true;
    const config = MAP_CONFIG[useDashboardStore.getState().mode];
    const controls = controlsRef.current;
    if (controls) {
      controls.enabled = false;
      controls.target.set(0, 0, config.targetZ);
    }
    gsap.to(camera.position, {
      x: 0,
      y: config.camera.height,
      z: config.camera.radius,
      duration: 2.4,
      ease: "power2.inOut",
      onComplete: () => {
        if (controls) {
          // 交还给 OrbitControls 前，把 target 与当前机位对齐，
          // 否则控制器会按自己的球坐标把相机拉走
          controls.target.set(0, 0, config.targetZ);
          controls.update();
          controls.enabled = true;
        }
      },
    });
  });

  // 切换模式时把轨道目标挪到该模式的中心
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    gsap.to(controls.target, {
      x: 0,
      y: 0,
      z: MAP_CONFIG[mode].targetZ,
      duration: 0.6,
      ease: "power2.out",
    });
  }, [mode]);

  return (
    <>
      <fog attach="fog" args={["#01050c", 28, 68]} />
      <color attach="background" args={["#01050c"]} />

      <ambientLight intensity={0.6} />
      <directionalLight position={[-4, 12, 9]} intensity={2} color={new Color("#cfe8ff")} />
      <directionalLight position={[7, 6, -8]} intensity={0.75} color={new Color("#3f7fd0")} />
      <pointLight position={[0, 5, 6]} intensity={26} distance={28} color="#2f8fe0" />

      <MapBase width={config.width} />

      <MapGroup
        groupRef={chinaGroup}
        model={models.china}
        visible={mode === "china"}
        depth={MAP_CONFIG.china.depth}
        surfaceMap={chinaTexture.surface}
        normalMap={chinaTexture.normal}
        highlightPrefix="上海"
        onSelectRegion={() => runTransition("shanghai")}
        onHoverRegion={() => {}}
      />

      <MapGroup
        groupRef={shanghaiGroup}
        model={models.shanghai}
        visible={mode === "shanghai"}
        depth={MAP_CONFIG.shanghai.depth}
        surfaceMap={shanghaiTexture.surface}
        normalMap={shanghaiTexture.normal}
        clickableName={props.selectedDistrict}
        selectedName={props.selectedDistrict}
        onSelectRegion={(name) => props.onDistrictSelect(name)}
        onHoverRegion={() => {}}
      />

      <group rotation={[-Math.PI / 2, 0, 0]}>
        {sitePoints.map(({ site, position }) => (
          <SiteMarker
            key={site.id}
            name={site.name}
            caption={site.province ?? site.district}
            position={position}
            status={site.status}
            selected={site.id === props.selectedSite}
            current={site.status === "workorder"}
            scale={mode === "shanghai" ? 1.32 : 1}
            onSelect={() => props.onSelectSite(site.id)}
          />
        ))}
        <FlyLines lines={flyLines} depth={config.depth} revealRef={detailProgress} />
      </group>

      <BeamLights
        radius={config.width * 0.95}
        innerRadius={config.width * 0.5}
        count={20}
        top={15}
        revealRef={detailProgress}
      />

      {/* 中央光爆：demo2 最醒目的元素，整幅地图的数据都汇聚到这里 */}
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <LightBurst
          center={[burstCenter.x, burstCenter.y]}
          radius={config.width * 0.46}
          height={config.depth}
          rays={130}
          markers={config.width > 15 ? 30 : 12}
          revealRef={detailProgress}
        />
      </group>

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.07}
        rotateSpeed={0.5}
        zoomSpeed={0.45}
        // 默认机位到原点的距离约 19.4，maxDistance 必须明显大于它，
        // 否则 OrbitControls 一启用就会把相机沿视线方向拉远，开场「推近」白做
        minDistance={8}
        maxDistance={40}
        minPolarAngle={0.28}
        maxPolarAngle={1.3}
        target={[0, 0, config.targetZ]}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 对外组件
 * ------------------------------------------------------------------ */

export interface MapSceneProps {
  sites: Site[];
  flyLineSeeds: { id: string; from: [number, number] }[];
  selectedSite: string;
  selectedDistrict: string;
  onSelectSite: (id: string) => void;
  onDistrictSelect: (name: string) => void;
  onIntroDone: () => void;
}

/**
 * 资源加载层。
 *
 * useTexture 必须在 <Canvas> 内部（依赖 R3F 的 context），但 Scene 又不能自己加载：
 * 那样 Scene 会先被挂载一次（用于抛 Promise 触发 Suspense）、随即被卸载、
 * 最后重新挂载，只在挂载时跑一次的 effect 就落在了废掉的那次实例上。
 *
 * 所以这里单独抽一层：Suspense 只围住这个小的加载组件，
 * Scene 出现时贴图必然已就绪，且只会挂载一次。
 */
function SceneWithAssets(props: SceneShellProps) {
  const chinaTexture = useTexture({ surface: chinaSurface, normal: chinaNormal });
  const shanghaiTexture = useTexture({ surface: shanghaiSurface, normal: shanghaiNormal });
  const assets = useMemo(
    () => ({
      china: { surface: chinaTexture.surface, normal: chinaTexture.normal },
      shanghai: { surface: shanghaiTexture.surface, normal: shanghaiTexture.normal },
    }),
    [chinaTexture, shanghaiTexture],
  );

  return (
    <Scene
      {...props}
      chinaTexture={assets.china}
      shanghaiTexture={assets.shanghai}
    />
  );
}

/** Scene 的 props 去掉资源字段（由 SceneWithAssets 注入） */
type SceneShellProps = Omit<SceneProps, "chinaTexture" | "shanghaiTexture">;

export default function MapScene(props: MapSceneProps) {
  const setIntroDone = useDashboardStore((state) => state.setIntroDone);
  // 用 ref 存回调，避免「父组件每次渲染都传新函数」把开场时间线的依赖打穿、
  // 导致时间线反复重建、动画一播完就重头再来
  const introDoneCb = useRef(props.onIntroDone);
  introDoneCb.current = props.onIntroDone;

  const handleIntroDone = useCallback(() => {
    setIntroDone(true);
    introDoneCb.current();
  }, [setIntroDone]);

  // 开场总时间线：地图淡入 + 由中心向外揭幕 → 镜头推进 → 光柱与飞线生成
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      mapUniforms.uOpacity.value = 1;
      mapUniforms.uReveal.value = 1;
      introProgress.value = 1;
      detailProgress.value = 1;
      handleIntroDone();
      return;
    }

    mapUniforms.uOpacity.value = 0;
    mapUniforms.uReveal.value = 0;
    introProgress.value = 0;
    detailProgress.value = 0;

    const tl = gsap.timeline({ onComplete: handleIntroDone });
    tl.to(mapUniforms.uOpacity, { value: 1, duration: 1.5, ease: "power2.out" }, 0);
    tl.to(mapUniforms.uReveal, { value: 1, duration: 1.9, ease: "power2.inOut" }, 0.02);
    tl.to(introProgress, { value: 1, duration: 1.9, ease: "power2.inOut" }, 0.02);
    tl.add(() => {
      cameraIntro.started = true;
    }, 0.15);
    tl.to(detailProgress, { value: 1, duration: 1.1, ease: "power1.out" }, 1.35);

    return () => {
      tl.kill();
    };
  }, [handleIntroDone]);

  const shellProps: SceneShellProps = {
    sites: props.sites,
    flyLineSeeds: props.flyLineSeeds,
    selectedSite: props.selectedSite,
    selectedDistrict: props.selectedDistrict,
    onSelectSite: props.onSelectSite,
    onDistrictSelect: props.onDistrictSelect,
  };

  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ fov: MAP_CONFIG.china.camera.fov, position: [0, 26, 29], near: 0.5, far: 140 }}>
      <Suspense fallback={null}>
        <SceneWithAssets {...shellProps} />
      </Suspense>
    </Canvas>
  );
}
