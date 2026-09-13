import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Center, OrbitControls } from "@react-three/drei";
import {
  Box2,
  ClampToEdgeWrapping,
  DoubleSide,
  Fog,
  LineSegments,
  Mesh,
  NoColorSpace,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  Texture,
  Vector2,
  Vector3,
  type Group,
  type Material,
  type ExtrudeGeometryOptions,
} from "three";
import { geoMercator } from "d3-geo";
import { useFrame, useThree } from "@react-three/fiber";
import { gsap } from "gsap";
import ShiftMaterial from "./shaderMaterial";
import GeoTrail from "./geoTrail";
import type { CityGeoJSON } from "@/types/map";
import ShapeBox from "./shape";
import FlyLine from "./flyLine";
import Boundary from "./boundary";
import Label from "./label";
import SiteMarkers from "./BusinessMarkers";
import { useConfigStore } from "./stores";
import { declutterLabels, shortRegionName, toCandidates } from "./labels";
import { createMapSurfaceTexture } from "./mapSurface";
import { chinaSites, shanghaiSites } from "../data";
import { useImageState } from "./useImage";
import ringImage from "@/assets/quan1.png";

import chinaSurface from "@/assets/map/china_surface.png";
import chinaNormal from "@/assets/map/china_normal.png";
import shanghaiSurface from "@/assets/map/shanghai_surface.png";
import shanghaiNormal from "@/assets/map/shanghai_normal.png";
import Cones from "./cone";

/**
 * Demo2 四川地图的投影半径约 6，它所有装饰（光锥 0.3 / 光圈 0.8 / 飞线拱高 5 /
 * 挤出厚度 1）都是相对这个尺度定的。中国半径约 30.8、上海约 0.63，
 * 直接照搬这些绝对值，中国会「装饰小到看不见」、上海会「装饰大到糊住地图」。
 * 所以统一按 `mapRadius / DEMO_RADIUS` 换算，让两种模式的装饰占画面的比例
 * 与 demo_2.jpg 一致。
 */
const DEMO_RADIUS = 17;

/** 可见开场：镜头 2.5s；轮廓 0.45s、地形 0.95s、白线 1.6s 起；面板约 3.5s 就位。 */
const MAP_PUSH_DURATION = 2.5;

export type SurfaceKey = "china" | "shanghai";

export interface BaseProps {
  depth?: number;
  data: CityGeoJSON;
  outlineData?: CityGeoJSON;
  /** 开场时间线播完（含 mapPlayComplete 置位）后回调 */
  onReady?: () => void;
  /**
   * **场景真正可以看了**：DEM 贴图已加载、地表贴图已烤好。
   *
   * 与 `onReady`（开场动画播完）是两件事，中间差着整个 3.5 秒的开场。
   * 加载遮罩要等的是这一个 —— 贴图没就绪就撤遮罩，观众看到的是黑屏，
   * 那正是「Hard Reload 后一片纯黑」的来源。
   */
  onSceneReady?: () => void;
  /**
   * 取景留白系数：1.0 = 刚好内接，越大留白越多。
   * 中国与上海跨度差 13 倍，靠这个系数把两者框到同样的画面比例。
   */
  fitPadding?: number;
  /** 点某个区域名时下钻（前缀匹配，例如「上海」） */
  onSelectRegion?: (name: string) => void;
  /** 用哪套 DEM 地表贴图（与 data 同源） */
  surfaceKey?: SurfaceKey;
  /** 业务上必须显示名称的区域（例如有古建点位的区） */
  pinnedLabels?: string[];
  /**
   * 诊断开关：?scene=no<图元名> 可逐层关掉地图元素（nocities / nocones /
   * noflyLine / noboundary / nomarkers ...），用来定位是哪个图元出的问题。
   * 正常运行时为空字符串，不影响任何行为。
   */
  debug?: string;
}

export default function Base(props: BaseProps) {
  const {
    data,
    outlineData,
    depth = 1,
    fitPadding = 1.06,
    onSelectRegion,
    surfaceKey = "china",
    pinnedLabels,
    debug = "",
  } = props;
  const on = (name: string) => debug !== `no${name}` && debug !== "minimal";

  const groupRef = useRef<Group>(null!);
  const camera = useThree((state) => state.camera);
  const canvasSize = useThree((state) => state.size);

  const projection = useMemo(() => {
    return geoMercator()
      .center(data.features[0].properties.centroid)
      .translate([0, 0]);
  }, [data]);

  const { regions, bbox, boundary } = useMemo(() => {
    const regions: {
      name: string;
      center: Vector3;
      points: Vector2[][];
    }[] = [];
    const bbox = new Box2();

    const toV2 = (coord: number[]) => {
      const [x, y] = projection(coord as [number, number])!;
      const projected = new Vector2(x, -y);
      bbox.expandByPoint(projected);
      return projected;
    };

    data.features.forEach((feature) => {
      const [x, y] = projection(
        feature.properties.centroid ?? feature.properties.center
      )!;

      const points = feature.geometry.coordinates.reduce<Vector2[][]>(
        (pre, cur) => [
          ...pre,
          ...cur.map<Vector2[]>((coordinates) => coordinates.map(toV2)),
        ],
        []
      );

      regions.push({
        name: feature.properties.name,
        center: new Vector3(x, -y),
        points,
      });
    });

    let boundary: Shape[] = [];

    outlineData?.features.forEach((feature) => {
      const points = feature.geometry.coordinates.map<Shape>((cur) => {
        return new Shape(
          cur.reduce<Vector2[]>(
            (pre, coordinates) => [...pre, ...coordinates.map(toV2)],
            []
          )
        );
      });

      boundary = boundary.concat(points);
    });

    return { regions, bbox, boundary };
  }, [projection, data, outlineData]);

  const mapRadius = useMemo(() => {
    const size = bbox.getSize(new Vector2());
    return Math.max(size.x, size.y) / 2;
  }, [bbox]);

  /** 装饰缩放：让中国与上海的装饰都保持 demo_2.jpg 的比例 */
  const deco = mapRadius / DEMO_RADIUS;

  /**
   * 光锥只画在「真的有古建点位」的省份上。
   *
   * 原来 34 个省级区域各插一个光锥，可地图上本来就有 12 个业务点位标记，
   * 两套标记叠在同一片区域纯属装饰冗余，东半部被糊成一片白斑。
   * 规范 §0：所有元素都不能同时抢注意力 —— 让装饰只出现在有业务含义的位置。
   */
  const coneRegions = useMemo(() => {
    const sites = surfaceKey === "shanghai" ? shanghaiSites : chinaSites;
    const keys = sites
      .map((site) => (surfaceKey === "shanghai" ? site.district : site.province))
      .filter((key): key is string => !!key);
    return regions.filter((region) =>
      keys.some((key) => region.name.startsWith(key)),
    );
  }, [regions, surfaceKey]);
  /** 挤出厚度同样按比例，否则上海会变成一块厚板、中国是一张纸 */
  const slabDepth = depth * deco;

  // 用 ref 存回调，避免父组件每次渲染传新函数导致时间线依赖被打穿
  const onReadyRef = useRef(props.onReady);
  onReadyRef.current = props.onReady;

  /**
   * 标签：demo2 的 <Html distanceFactor> 会让字号随距离变化，
   * 一幅 34 个省的地图上近处大字、远处小字，看起来「文字大小不一致」。
   * 这里改成不定 distanceFactor（屏幕定尺），再按地图包围盒做一次
   * 屏幕空间去重叠，保证所有省名字号一致、且尽量都显示出来。
   */
  const labelNames = useMemo(() => {
    const pinned = [...(pinnedLabels ?? [])];
    const candidates = toCandidates(regions, bbox).map((item) => {
      // 用前缀匹配：全国模式的区域名带后缀（"北京市" / "上海市"），
      // 而传入的是简称（"北京" / "上海"），全等比较会一个都匹配不上。
      // 优先级取它在列表里的序号 —— 列表顺序就是放置顺序。
      const index = pinned.findIndex((key) => item.name.startsWith(key));
      return { ...item, priority: index >= 0 ? index : undefined };
    });
    // 标签实际尺寸：11px 字 × 2~3 个字 ≈ 22~36px 宽、15px 高；
    // 地图长边在屏幕上约 700px，所以归一化后约 0.036 × 0.021。
    // 纵向再乘前缩补偿：相机俯角约 42°，南北向在屏幕上被压扁，
    // 所以高度要放大到约 0.030，否则南北相邻的省名会视觉重叠。
    //
    // 之前用的是 0.056 × 0.046（比实际大了约 1.6 倍），把大量本来放得下的
    // 省名误判成冲突丢掉了 —— 「安徽、重庆、上海、福建、北京没有字」就是这么来的。
    return declutterLabels(candidates, {
      width: 0.036,
      height: 0.030,
    });
  }, [regions, bbox, pinnedLabels]);

  /**
   * 地表贴图：DEM 高程 → 冷色明暗 + 行政边界，整幅烤成一张贴图。
   * 顶面用不受光照影响的 MeshBasicMaterial，彻底解决「总览一片黑」。
   *
   * 用自带的 useImage 而不是 drei 的 useTexture：后者会让整个 <Suspense>
   * 边界挂起，一旦加载不 resolve 地图就整块消失（见 useImage.ts 的说明）。
   */
  const { image: demImage, settled: demSettled } = useImageState(
    surfaceKey === "shanghai" ? shanghaiSurface : chinaSurface,
  );

  /**
   * 法线贴图（⑦）：Demo2 的顶面靠它出金属起伏。
   *
   * 法线贴图是**线性**数据，不能按 sRGB 解释 —— 设错会让起伏方向整体偏掉，
   * 看起来像「地形被压平了」。
   */
  const { image: normalImage, settled: normalSettled } = useImageState(
    surfaceKey === "shanghai" ? shanghaiNormal : chinaNormal,
  );
  const { settled: ringSettled } = useImageState(ringImage);
  const resourcesReady = demSettled && normalSettled && ringSettled;
  const normalTexture = useMemo(() => {
    if (!normalImage) return null;
    const tex = new Texture(normalImage);
    tex.colorSpace = NoColorSpace;
    tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }, [normalImage]);

  useEffect(
    () => () => {
      normalTexture?.dispose();
    },
    [normalTexture],
  );

  /** 起伏强度。Demo2 用默认 1；我们叠了 DEM 底图，0.9 更不容易出噪点 */
  /**
   * 起伏强度由 0.9 提到 1.15。
   *
   * 上一轮截图里顶面读起来像一块平白 —— 地形是有了但不够"立"。
   * 提到 1.15 让山脊与河谷的明暗差更明确，同时还没到出噪点的程度。
   */
  const normalScale = useMemo(() => new Vector2(1.15, 1.15), []);

  const mapTexture = useMemo(() => {
    if (!demImage) return null;
    return createMapSurfaceTexture({
      surface: demImage,
      // 上海只有 922×1020，硬放大反而糊；按地图复杂度给不同精度
      maxSize: data.features.length > 20 ? 2048 : 1600,
    });
  }, [demImage, data]);

  useEffect(
    () => () => {
      mapTexture?.dispose();
    },
    [mapTexture],
  );

  /**
   * 取景距离：按地图实际尺寸反解。
   *
   * 为什么必须这么做：中国与上海的经纬跨度差了 13 倍（中国 mercator 宽度约 164，
   * 上海只有约 3.4），而外层统一 `scale 0.5`。上游 Demo2 只有四川一张图，
   * 相机距离写死没关系；换成两张跨度差一个数量级的地图后，
   * 同一个机位必然一张爆框、一张缩成小块。
   *
   * 做法：由投影包围盒算出「地图在 XY 平面上的外接圆半径 + 厚度」，
   * 再按竖直视角与画布宽高比反解距离。相机朝向保持 Demo2 的 `x: -2, y: 7`
   * （保留原构图角度），只调距离。
   */
  const fitDistance = useMemo(() => {
    const size = bbox.getSize(new Vector2());
    const radius = Math.max(size.x, size.y) / 2;
    const sphereRadius = Math.hypot(radius, slabDepth) * 0.5;

    // 竖直视角与水平视角取小者：宽屏时由高度决定，窄屏时由宽度决定
    const cameraFov = (camera as { fov?: number }).fov ?? 70;
    const aspect = canvasSize.width / Math.max(1, canvasSize.height);
    const vFov = (cameraFov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const halfAngle = Math.min(vFov, hFov) / 2;
    /*
     * 标定用：`?fit=0.8` 直接缩放取景距离（正常运行时为 1）。
     * 地图是斜置平面，投影尺寸与「包围球半径」差得远，公式推不准，
     * 只能量出来再定；量的时候也用这个参数逐档对比。
     */
    const fitScale =
      typeof window === "undefined"
        ? 1
        : Number(new URLSearchParams(window.location.search).get("fit") ?? "1") || 1;
    /*
     * 下限由 2 降到 0.2。
     *
     * 原来写死 2 —— 那是按中国地图（世界里约 82 单位、取景距离约 96）定的一个
     * 「别把相机塞进地图里」的保护值。但上海投影跨度只有中国的 1/48，
     * 反解出来的取景距离本来就小于 2，于是**每张上海图都被这个下限顶住**，
     * 相机被迫停在两倍远的地方。实测上海地图稳定态只占 viewport **12% 宽**
     * （中国是 55%），B05「下钻后自动重新 Fit，不得出现过小」不达标。
     *
     * 0.2 只是一个防零保护，真正的下限由 OrbitControls 的 minDistance 负责。
     */
    return Math.max((sphereRadius / Math.sin(halfAngle)) * fitPadding * fitScale, 0.2);
  }, [bbox, slabDepth, camera, canvasSize.width, canvasSize.height, fitPadding]);

  /**
   * 雾的远近必须跟着取景距离走。
   *
   * Demo2 写死 `args={["#000000", 10, 30]}`，因为它的相机恒定在约 13 个单位外，
   * 10~30 只是一层轻微的纵深提示。但这里的取景距离是按地图跨度反解的：
   * 中国约 96、上海约 4 —— 固定 10~30 会让中国整幅地图落在雾区之外，
   * 被**全雾成纯黑**，只有滚轮放大、相机凑近之后才看得见。
   * 这正是「地图乌漆嘛黑、放大才看得见」的根因。
   * 所以改成按取景距离等比缩放，两种模式都保留同样比例的纵深。
   */
  const scene = useThree((state) => state.scene);
  useLayoutEffect(() => {
    /*
     * 雾的起点由 0.75 推到 1.05 倍取景距离。
     *
     * 0.75 意味着地图**近端**就已经在雾里，整幅图被压暗 ——
     * 换回金属材质之后这一条尤其明显。推到 1.05 之后，
     * 地图完整落在雾外，只有远端留一点纵深提示（这正是 Demo2 里
     * 写死 10~30 想要的效果：轻雾，不是把主体吃掉）。
     */
    /*
     * 雾再推远一档（1.05 → 1.7 倍取景距离）。
     *
     * 地图是斜置的，远端比近端远出一大截；起点 1.05 倍时地图中段就已经在雾里，
     * 整幅图被均匀压暗 —— 这是"灰蒙蒙"的直接来源。推到 1.7 倍之后只有最远端
     * 吃到一点雾，保留纵深提示但不吃主体。
     */
    /*
     * 雾起点由 1.7 收回 1.3 倍。
     *
     * 1.7 时雾几乎不起作用，地图远端与近端一样亮，整块顶面糊成一片白。
     * 1.3 让远端有一点纵深衰减 —— 顶面的明度差由此建立，
     * 侧壁的深蓝也才压得住顶面。
     */
    scene.fog = new Fog("#000000", fitDistance * 1.3, fitDistance * 2.8);
    return () => {
      scene.fog = null;
    };
  }, [scene, fitDistance]);

  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const framesRef = useRef(0);
  const targetOpacityRef = useRef(new WeakMap<Material, number>());
  const [introComplete, setIntroComplete] = useState(false);
  const introFinishedRef = useRef(false);
  const sceneReadyRef = useRef(props.onSceneReady);
  sceneReadyRef.current = props.onSceneReady;

  useLayoutEffect(() => {
    useConfigStore.setState({ introStarted: false, mapPlayComplete: false, sceneReady: false, veiled: true });
  }, []);

  // One timeline owns camera, surface, borders and the panel-ready signal.
  // Resource-driven rerenders must finish before its first visible frame.
  useLayoutEffect(() => {
    if (!resourcesReady) return;
    const group = groupRef.current;
    if (!group) return;
    const direction = new Vector3(-2, 17, 10).normalize();
    const target = direction.clone().multiplyScalar(fitDistance);
    if (introFinishedRef.current) {
      camera.position.copy(target);
      camera.lookAt(0, 0, 0);
      return;
    }
    const start = direction.clone().multiplyScalar(fitDistance * 2.4);
    start.y += fitDistance * 0.55;
    camera.position.copy(start);
    camera.lookAt(0, 0, 0);
    group.position.set(0, 0, -0.01);
    group.scale.set(1, 1, 0.02);
    framesRef.current = 0;

    const tl = gsap.timeline({ paused: true, onComplete: () => {
      introFinishedRef.current = true;
      setIntroComplete(true);
    } });
    timelineRef.current = tl;
    tl.to(camera.position, { x: target.x, y: target.y, z: target.z,
      duration: MAP_PUSH_DURATION, ease: "power2.out",
      onUpdate: () => camera.lookAt(0, 0, 0),
    }, 0);
    tl.to(group.position, { z: 0, duration: 1.2, ease: "power2.out" }, 0.45);
    tl.to(group.scale, { z: 1, duration: 1.2, ease: "power2.out" }, 0.45);
    const seen = new Set<Material>();
    group.traverse((obj) => {
      if (!(obj instanceof Mesh || obj instanceof LineSegments)) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) {
        if (seen.has(material)) continue;
        seen.add(material);
        const opacityUniform = material instanceof ShaderMaterial ? material.uniforms.uOpacity : undefined;
        if (!targetOpacityRef.current.has(material)) {
          targetOpacityRef.current.set(material, opacityUniform?.value ?? (material.opacity || 1));
        }
        const targetOpacity = targetOpacityRef.current.get(material)!;
        if (!material.transparent) {
          material.transparent = true;
          material.needsUpdate = true;
        }
        // Includes the invisible top of OutlineBody. No timeout may override this.
        material.opacity = 0;
        if (opacityUniform) opacityUniform.value = 0;
        if (material.userData.skipReveal) continue;
        const at = typeof material.userData.revealAt === "number" ? material.userData.revealAt : 1.8;
        tl.to(material, { opacity: targetOpacity, duration: 0.75, ease: "power1.inOut" }, at);
        if (opacityUniform) {
          tl.to(opacityUniform, { value: targetOpacity, duration: 0.75, ease: "power1.inOut" }, at);
        }
        if (obj instanceof LineSegments && material.userData.drawBorder) {
          const count = obj.geometry.index?.count ?? obj.geometry.attributes.position.count;
          const draw = { count: 0 };
          obj.geometry.setDrawRange(0, 0);
          tl.to(draw, { count, duration: 0.75, ease: "none",
            onUpdate: () => obj.geometry.setDrawRange(0, Math.floor(draw.count / 2) * 2),
          }, at);
        }
      }
    });
    // Terrain is visible before the side panels start their 0.5 s stagger.
    tl.call(() => {
      useConfigStore.setState({ mapPlayComplete: true });
      onReadyRef.current?.();
    }, [], 2.1);
    useConfigStore.setState({ sceneReady: true });
    sceneReadyRef.current?.();
    return () => {
      tl.kill();
      if (timelineRef.current === tl) timelineRef.current = null;
    };
  }, [resourcesReady, camera, fitDistance]);

  // Advance with rendered frames instead of wall time. Shader compilation and
  // background tabs must not consume the intro while the user sees no frames.
  useFrame((_, delta) => {
    const tl = timelineRef.current;
    if (!tl || introFinishedRef.current) return;
    if (++framesRef.current <= 2) return;
    if (framesRef.current === 3) {
      useConfigStore.setState({ introStarted: true, veiled: false });
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    tl.time(reduced ? tl.duration() : Math.min(tl.duration(), tl.time() + Math.min(delta, 0.05)), false);
  });

  return (
    <>
      <Center top>
        <group
          castShadow
          receiveShadow
          rotation={[-Math.PI / 2, 0, 0]}
          scale={[0.5, 0.5, 0.5]}
          position={[0, 0.2, 0]}>
          <group ref={groupRef} scale={[1, 1, 0]} position={[0, 0, -0.01]}>
          {on("cities")
            ? regions.map((region, idx) => (
                <City
                  key={region.name + idx}
                  depth={slabDepth}
                  bbox={bbox}
                  data={region}
                  texture={mapTexture}
                  normalTexture={normalTexture}
                  normalScale={normalScale}
                  /* 有国界外轮廓时省侧壁不点亮，厚度交给下面的 OutlineBody */
                  plainSide={boundary.length > 0}
                  onClick={
                    region.name.startsWith("上海")
                      ? () => onSelectRegion?.(region.name)
                      : undefined
                  }
                />
              ))
            : null}
          {on("outlineBody") && boundary.length ? (
            <OutlineBody shapes={boundary} bbox={bbox} depth={slabDepth} />
          ) : null}
          {outlineData && on("geoTrail") ? (
            <GeoTrail
              projection={projection}
              feature={outlineData.features[0]}
            />
          ) : null}
          {on("cones") ? <Cones data={coneRegions} deco={deco} /> : null}
          {on("flyLine") ? <FlyLine data={regions} deco={deco} /> : null}
          {on("boundary") ? (
            <Boundary data={boundary} depth={slabDepth * 3} deco={deco} />
          ) : null}
          {on("markers") ? (
            <SiteMarkers
              mode={surfaceKey}
              projection={projection}
              deco={deco}
              slabDepth={slabDepth}
            />
          ) : null}
          {on("cities")
            ? regions.map((region, idx) =>
                labelNames.has(region.name) ? (
                  <Label
                    key={`label-${region.name}-${idx}`}
                    center
                    position={[
                      region.center.x,
                      region.center.y,
                      slabDepth + 0.2 * deco,
                    ]}
                    zIndexRange={[100, 0]}>
                    {shortRegionName(region.name)}
                  </Label>
                ) : null,
              )
            : null}
          </group>
        </group>
      </Center>
      {/*
        轨道控制必须放在这里，不能用写死的 min/maxDistance。
        取景距离是按地图跨度反解的（中国约 96、上海约 4），
        Demo2 那套 4~44 的固定范围会把中国强行拉近 2 倍多，
        地图直接爆框 —— 这也是「中国地图显示得太大」的原因。
      */}
      <OrbitControls
        enabled={introComplete}
        enableDamping
        zoomSpeed={0.3}
        minDistance={fitDistance * 0.22}
        maxDistance={fitDistance * 3}
        maxPolarAngle={1.5}
      />
    </>
  );
}

/**
 * 国境线侧壁：用**外轮廓**单独挤出一层，提供地图厚度。
 *
 * 为什么需要它：省份各自挤出时，每条省界都带一圈发光侧壁，
 * 看起来就是「省与省之间有光屏」（用户报的内蒙古 / 新疆）。现在省侧壁不点亮，
 * 厚度只能由这一层提供 —— 它沿国界走一圈，所以光只出现在该出现的地方。
 *
 * 上海没有 outlineData，走不到这里；它的区界尺度小，沿用省份那套即可。
 */
function OutlineBody({
  shapes,
  bbox,
  depth,
}: {
  shapes: Shape[];
  bbox: Box2;
  depth: number;
}) {
  const materialRef = useRef<ShaderMaterial>(null!);
  const shapeArgs = useMemo<[Shape[], ExtrudeGeometryOptions]>(
    () => [shapes, { depth, bevelEnabled: false }], [shapes, depth],
  );

  useFrame((_, delta) => {
    if (materialRef.current) materialRef.current.uniforms.time.value += delta / 3;
  });

  return (
    <ShapeBox bbox={bbox} args={shapeArgs}>
      {/* material-0（顶面）不画：顶面由各省自己铺，这里只要侧壁 */}
      <meshBasicMaterial attach="material-0" transparent opacity={0} depthWrite={false} userData={{ skipReveal: true }} />
      <ShiftMaterial
        transparent
        attach="material-1"
        ref={materialRef}
        opacity={0}
        depth={depth}
        userData={{ revealAt: 0.45 }}
      />
    </ShapeBox>
  );
}

function City(props: {
  depth: number;
  bbox: Box2;
  data: {
    name: string;
    center: Vector3;
    points: Vector2[][];
  };
  /** 顶面贴图：DEM 地形明暗，整幅共用一张；未加载完时为 null */
  texture: Texture | null;
  /** 法线贴图：金属起伏（⑦） */
  normalTexture: Texture | null;
  normalScale: Vector2;
  /** 仅上海区域挂载：点击下钻到上海 */
  onClick?: () => void;
  /**
   * 省侧壁是否**不点亮**。
   *
   * 有国界外轮廓时传 true：每个省都是一块独立挤出的 City，各自带一圈发光侧壁，
   * 于是每条省界之间都出现「光屏」（用户报的内蒙古 / 新疆与邻省之间）。
   * 厚度改由外轮廓那一层单独提供，省侧壁保持全透明，只留顶面与白线。
   */
  plainSide?: boolean;
}) {
  const { bbox, data, depth, texture, normalTexture, normalScale, onClick, plainSide } = props;
  const groupRef = useRef<Group>(null!);
  const materialRef = useRef<ShaderMaterial>(null!);
  const vector3 = useRef(new Vector3(1, 1, 1));

  /**
   * 顶面几何。白线用它的边（⑥），所以必须留一份。
   * Demo2 也是这么做的：shapeGeometry 既给 ShapeBox 也给 edgesGeometry。
   */
  const [shape, shapeGeometry] = useMemo<[Shape[], ShapeGeometry]>(() => {
    const shapes = data.points.map((e) => new Shape(e));
    return [shapes, new ShapeGeometry(shapes)];
  }, [data.points]);
  const shapeArgs = useMemo<[Shape[], ExtrudeGeometryOptions]>(
    () => [shape, { depth, bevelEnabled: false }], [shape, depth],
  );

  useFrame((_, delta) => {
    groupRef.current.scale.lerp(vector3.current, 0.1);
    if (materialRef.current) materialRef.current.uniforms.time.value += delta / 3;
  });

  return (
    <object3D
      ref={groupRef}
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      onPointerOver={(e) => {
        e.stopPropagation();
        vector3.current.setZ(1.5);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        vector3.current.setZ(1);
        document.body.style.cursor = "auto";
      }}>
      <ShapeBox bbox={bbox} args={shapeArgs}>
        {/*
          顶面：Demo2 的冷灰金属语言（⑦）。

          两处**有意**的偏离，都因为我们的地图与 Demo2 规模不同：
            · 保留 DEM 贴图当 diffuse。用户要求「保留山脉起伏细节」
              「青藏高原、西南山地必须能清楚看到地形纹理」，
              Demo2 那种纯 #293b41 平色做不到。
            · 基色由 #293b41 提到 #8ea6bd。Demo2 场景里只有四川一块，
              我们的地图大 13 倍、还带雾，照抄会整体压暗成黑影 ——
              上一轮就是撞上这个才退回了 basic 材质。
          metalness / roughness / normalMap 保持 Demo2 原值。
        */}
        <meshStandardMaterial
          attach="material-0"
          map={texture ?? undefined}
          normalMap={normalTexture ?? undefined}
          normalScale={normalScale}
          /*
           * 基色由 #b9cbdc 收回 #93aabf。
           *
           * 上一轮为救回可见性提到了接近白；能看见之后立刻显出问题：
           * 顶面太亮，与侧壁的蓝糊成一片，四层分不开。收回一档冷灰蓝，
           * 顶面才回到 Demo2 那种「冷灰金属」的语气。
           */
          color={texture ? "#93aabf" : "#28486e"}
          /* 第二阶段揭示：轮廓之后才铺地形 */
          userData={{ revealAt: 0.95 }}
          /*
           * metalness / roughness 相对 Demo2 调过（0.5/0.7 → 0.32/0.55）。
           *
           * Demo2 那组值是在「只有四川一块、相机恒定 13 单位、无雾」下调的。
           * 我们的地图大 13 倍、带雾，照抄的结果是金属反射把亮度吃掉、
           * 地块糊成一块暗斑 —— 实测默认取景下地图宽 55%（尺寸达标）
           * 却仍然"看着小"，就是因为明度差不够。
           * 降金属度让漫反射起来，降粗糙度让方向光打出明确的地形明暗。
           */
          metalness={0.32}
          roughness={0.55}
          side={DoubleSide}
          transparent
          opacity={0}
        />
        <ShiftMaterial
          transparent
          attach="material-1"
          ref={materialRef}
          opacity={0}
          depth={depth}
          /*
           * 侧壁不参与开场淡入（见 Base 时间线里 skipReveal 的说明）。
           * 用 userData 打标而不是加 prop：ShiftMaterial 是 extend 出来的
           * shaderMaterial，多传一个未知 prop 会被透传到材质上，不如打标干净。
           */
          userData={plainSide ? { skipReveal: true } : { revealAt: 0.45 }}
        />
      </ShapeBox>
      {/*
        行政区内部边界（⑥）—— Demo2 base.tsx 的同款做法：
        edgesGeometry 取顶面几何的边，lineBasicMaterial 纯白细线。
        position.z 抬到 depth 之上，否则会被顶面 z-fighting 吃掉。
      */}
      <lineSegments position={[0, 0, depth + 0.05]} raycast={() => null}>
        <edgesGeometry args={[shapeGeometry]} />
        {/* 第三阶段：省界白线最后描上，让边界落在已经铺好的地形上 */}
        <lineBasicMaterial
          transparent
          color="#ffffff"
          opacity={0}
          userData={{ revealAt: 1.6, drawBorder: true }}
        />
      </lineSegments>
    </object3D>
  );
}
