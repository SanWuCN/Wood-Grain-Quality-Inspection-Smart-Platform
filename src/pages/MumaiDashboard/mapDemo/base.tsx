import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Center, OrbitControls } from "@react-three/drei";
import {
  Box2,
  Fog,
  Mesh,
  ShaderMaterial,
  Shape,
  Vector2,
  Vector3,
  type Group,
  type Texture,
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
import { useImage } from "./useImage";

import chinaSurface from "@/assets/map/china_surface.png";
import shanghaiSurface from "@/assets/map/shanghai_surface.png";
import Cones from "./cone";

/**
 * Demo2 四川地图的投影半径约 6，它所有装饰（光锥 0.3 / 光圈 0.8 / 飞线拱高 5 /
 * 挤出厚度 1）都是相对这个尺度定的。中国半径约 30.8、上海约 0.63，
 * 直接照搬这些绝对值，中国会「装饰小到看不见」、上海会「装饰大到糊住地图」。
 * 所以统一按 `mapRadius / DEMO_RADIUS` 换算，让两种模式的装饰占画面的比例
 * 与 demo_2.jpg 一致。
 */
const DEMO_RADIUS = 17;

/**
 * 推镜头时长（秒）。Demo2 是 2.5s，这里保持一致 —— 左右面板的入场就是
 * 以这个时刻为起点的（见下面揭幕动画的注释），改这个值会一起改掉整段开场节奏。
 * 规范 §6.2 要求开场动画落在 2.4–3.2s，所以 2.5 + 1.0 的咬合节奏正好。
 */
const MAP_PUSH_DURATION = 2.5;

export type SurfaceKey = "china" | "shanghai";

export interface BaseProps {
  depth?: number;
  data: CityGeoJSON;
  outlineData?: CityGeoJSON;
  /** 开场时间线播完（含 mapPlayComplete 置位）后回调 */
  onReady?: () => void;
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
    const pinned = new Set(pinnedLabels ?? []);
    const candidates = toCandidates(regions, bbox).map((item) => ({
      ...item,
      pinned: pinned.has(item.name),
    }));
    // 11px 字 + 4px 内边距 ≈ 22~46px 宽；地图长边约占屏幕 700px
    return declutterLabels(candidates, {
      width: 0.056,
      height: 0.046,
    });
  }, [regions, bbox, pinnedLabels]);

  /**
   * 地表贴图：DEM 高程 → 冷色明暗 + 行政边界，整幅烤成一张贴图。
   * 顶面用不受光照影响的 MeshBasicMaterial，彻底解决「总览一片黑」。
   *
   * 用自带的 useImage 而不是 drei 的 useTexture：后者会让整个 <Suspense>
   * 边界挂起，一旦加载不 resolve 地图就整块消失（见 useImage.ts 的说明）。
   */
  const demImage = useImage(
    surfaceKey === "shanghai" ? shanghaiSurface : chinaSurface,
  );

  const mapTexture = useMemo(() => {
    if (!demImage) return null;
    return createMapSurfaceTexture({
      surface: demImage,
      regions: data.features.map((feature) => ({
        name: feature.properties.name,
        polygons: feature.geometry.coordinates,
      })),
      // 上海只有 922×1020，硬放大反而糊；按地图复杂度给不同精度
      maxSize: data.features.length > 20 ? 2048 : 1600,
      borderWidth: data.features.length > 20 ? 3.4 : 2.6,
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
    return Math.max((sphereRadius / Math.sin(halfAngle)) * fitPadding, 2);
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
    scene.fog = new Fog("#000000", fitDistance * 0.75, fitDistance * 2.4);
    return () => {
      scene.fog = null;
    };
  }, [scene, fitDistance]);

  /**
   * 只负责推镜头。取景距离在首帧后会随画布尺寸变化，所以这个时间线可能重建多次；
   * 重建只影响镜头，不会把下面的「揭幕」动画一起打断。
   */
  useLayoutEffect(() => {
    // 机位方向：Demo2 原值是 (-2,7,10)（俯角约 34°）。全国图比四川扁得多，
    // 34° 下南北向被压得太扁、省界挤在一起，所以把俯角抬到约 42°，
    // 让中国轮廓读起来更像一张地图；方位角仍保持 Demo2 的构图。
    const dir = new Vector3(-2, 9.2, 10).normalize();
    const target = dir.multiplyScalar(fitDistance);

    const tl = gsap.timeline();
    tl.to(camera.position, {
      x: target.x,
      y: target.y,
      z: target.z,
      duration: 2.5,
      ease: "circ.out",
    });

    return () => {
      tl.kill();
    };
  }, [camera, fitDistance]);

  /**
   * 揭幕动画：地图从压扁到立起 + 所有图元淡入。
   *
   * 时序**严格对齐 Demo2**：推镜头 0 → 2.5s；到 2.5s 时置位 mapPlayComplete
   * （左右面板从这一刻开始入场），同时地图用 1s 完成「立起 + 淡入」。
   * 也就是镜头还在推的时候面板就进来了，两段动画是咬合的，不是串行的。
   *
   * **依赖必须是空数组**。之前把这段和推镜头写在一个 effect 里、依赖 fitDistance，
   * 结果画布尺寸一确定、fitDistance 一变，旧时间线就被 kill 重建；
   * 而各材质的 opacity 起点是 0，只要时间线没跑完，整幅地图就是**完全透明**的
   * —— 看起来像「地图没渲染出来」，实际是淡入动画永远没结束。
   */
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const tl = gsap.timeline();
    tl.to(group.position, { x: 0, y: 0, z: 0, duration: 1 }, MAP_PUSH_DURATION);
    tl.to(
      group.scale,
      { x: 1, y: 1, z: 1, duration: 1, ease: "circ.out" },
      MAP_PUSH_DURATION,
    );
    group.traverse((obj) => {
      if (obj instanceof Mesh) {
        tl.to(
          obj.material,
          { opacity: 1, duration: 1, ease: "circ.out" },
          MAP_PUSH_DURATION,
        );
      }
    });

    const settle = () => {
      group.position.set(0, 0, 0);
      group.scale.set(1, 1, 1);
      group.traverse((obj) => {
        if (obj instanceof Mesh) {
          const list = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const material of list) material.opacity = 1;
        }
      });
    };

    // 与 Demo2 同一时刻通知外部：镜头推完 = 面板可以入场了
    const notify = window.setTimeout(() => {
      useConfigStore.setState({ mapPlayComplete: true });
      onReadyRef.current?.();
    }, MAP_PUSH_DURATION * 1000);

    // 兜底：万一 gsap 因为掉帧 / HMR / StrictMode 重挂没跑完，也把画面推到终态，
    // 否则各材质会永远停在 opacity 0，整幅地图完全透明。
    const safety = window.setTimeout(settle, (MAP_PUSH_DURATION + 1.4) * 1000);

    return () => {
      window.clearTimeout(notify);
      window.clearTimeout(safety);
      tl.kill();
      settle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
                  onClick={
                    region.name.startsWith("上海")
                      ? () => onSelectRegion?.(region.name)
                      : undefined
                  }
                />
              ))
            : null}
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
        enableDamping
        zoomSpeed={0.3}
        minDistance={fitDistance * 0.22}
        maxDistance={fitDistance * 2.2}
        maxPolarAngle={1.5}
      />
    </>
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
  /** 顶面贴图：DEM 明暗 + 行政边界，整幅共用一张；未加载完时为 null */
  texture: Texture | null;
  /** 仅上海区域挂载：点击下钻到上海 */
  onClick?: () => void;
}) {
  const { bbox, data, depth, texture, onClick } = props;
  const groupRef = useRef<Group>(null!);
  const materialRef = useRef<ShaderMaterial>(null!);
  const vector3 = useRef(new Vector3(1, 1, 1));

  const shape = useMemo(() => data.points.map((e) => new Shape(e)), [data.points]);

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
      <ShapeBox bbox={bbox} args={[shape, { depth, bevelEnabled: false }]}>
        {/*
          顶面改成不受光照影响的贴图。原 Demo2 用 meshStandardMaterial + 法线贴图，
          但方向光在地图背面，换个地区就没光了 —— 缩到总览整块地图一片死黑。
        */}
        <meshBasicMaterial
          attach="material-0"
          map={texture ?? undefined}
          color={texture ? "#ffffff" : "#28486e"}
          transparent
          opacity={0}
        />
        <ShiftMaterial
          transparent
          attach="material-1"
          ref={materialRef}
          opacity={0}
          depth={depth}
        />
      </ShapeBox>
    </object3D>
  );
}
