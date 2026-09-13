import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Center, OrbitControls } from "@react-three/drei";
import {
  Box2,
  Box3,
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
  const demImage = useImage(
    surfaceKey === "shanghai" ? shanghaiSurface : chinaSurface,
  );

  /**
   * 法线贴图（⑦）：Demo2 的顶面靠它出金属起伏。
   *
   * 法线贴图是**线性**数据，不能按 sRGB 解释 —— 设错会让起伏方向整体偏掉，
   * 看起来像「地形被压平了」。
   */
  const normalImage = useImage(
    surfaceKey === "shanghai" ? shanghaiNormal : chinaNormal,
  );
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

  /**
   * 只负责推镜头。取景距离在首帧后会随画布尺寸变化，所以这个时间线可能重建多次；
   * 重建只影响镜头，不会把下面的「揭幕」动画一起打断。
   */
  useLayoutEffect(() => {
    /*
     * 机位方向：Demo2 原值是 (-2,7,10)（俯角约 34°）。
     *
     * 用户反馈「角度也太小了，稍微正视一些」—— 要更接近俯视。由 9.2 抬到 13.5，
     * 仰角从约 42° 到约 53°：中国轮廓更接近「摊在眼前」的读法，南北向不再被压扁。
     * 方位角仍保持 Demo2 的构图。
     */
    const dir = new Vector3(-2, 13.5, 10).normalize();
    const target = dir.clone().multiplyScalar(fitDistance);

    /*
     * **先把相机摆到远处，再推进来。**
     *
     * 原来只写了 `tl.to(camera.position, target)` —— 从 Canvas 写死的初始机位
     * `[0, 26, 29]`（距原点约 39）补间到 `fitDistance`（中国约 96）。
     * 那是**往外飞**，镜头在后退，观众看到的不是推近而是地图不断缩小；
     * 而且起点 39 远小于地图尺寸，开场瞬间相机几乎贴在地图上。
     * Demo2 是反过来的：`[3,20,10]`（22.6）→ `[-2,7,10]`（12.4），推近。
     *
     * 所以起手把相机按同一方向放到 `fitDistance × 2.4`（远景），
     * 俯角略高一点形成下压的弧线，再 `circ.out` 收到最终机位 —— 这才是「推镜头」。
     */
    const start = dir.clone().multiplyScalar(fitDistance * 2.4);
    // 起点抬高一档：镜头从高处俯冲下来，比同角度平移更有推进感
    start.y += fitDistance * 0.55;
    camera.position.set(start.x, start.y, start.z);

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
    /*
     * **贴图没就绪就不许开场。**
     *
     * 原来这个 effect 依赖是 `[]`，组件一挂载时间线就跑：2.5 秒推镜头 +
     * 1 秒展开 + 1 秒淡入，而 DEM 贴图的加载与 2048px 地表烘焙是异步的、
     * 要 3 秒上下。于是**动画在黑屏里演完了**，贴图一到，整幅地图直接以终态出现
     * —— 现象就是「黑屏几秒，然后所有东西突然一起出现」，也正是用户报的 A01/A02。
     *
     * 现在门控在 `mapTexture` 上：贴图就绪的那一帧才开始推镜头，
     * 遮罩同时撤掉，观众看到的是完整开场。
     */
    /*
     * **挂载就开场，不等任何东西。**
     *
     * 走过两次弯路，都记在这里：
     *   · 先是门控在 `mapTexture` 上 —— 贴图来得慢，时间线一直不跑，
     *     各材质 opacity 停在 0，顶面全透明（实测 opacity:0 / hasMap:false），
     *     屏幕只剩侧壁与白线。
     *   · 再是门控在 `introArmed` 上 —— 那是 Map 挂载后 900ms 才翻真的，
     *     加上路由懒加载，时间线推到 8 秒开外；而且依赖变化会让 effect 重建，
     *     cleanup 里 `tl.kill()` 把 588 条 opacity tween 反复重置。
     *
     * 遮罩揭开由**这里**置位 —— Base 挂载、时间线建立的那一刻才算「可以看了」。
     * 用户在 dev 下打开页面看到十几秒蓝屏、然后地图一次性出现，就是因为遮罩
     * 原来按「Map 挂载后 900ms」撤，而 Base（连同贴图与几何）要晚得多才就绪，
     * 中间那段就是空白画布。
     */
    useConfigStore.setState({ introStarted: true });

    const tl = gsap.timeline();
    tl.to(group.position, { x: 0, y: 0, z: 0, duration: 1 }, MAP_PUSH_DURATION);
    tl.to(
      group.scale,
      { x: 1, y: 1, z: 1, duration: 1, ease: "circ.out" },
      MAP_PUSH_DURATION,
    );
    /*
     * 淡入要连 LineSegments 一起推（⑥）。
     *
     * Demo2 的判据是 `obj instanceof Mesh || obj instanceof LineSegments`，
     * 我们的移植版只写了 Mesh —— 于是省界白线的 opacity 永远停在 0，
     * 这也是「Demo2 那三行白线在这个项目里丢了」的直接原因。
     *
     * **还要处理 `material` 是数组的情况。** `ShapeBox` 是双材质网格
     * （material-0 顶面 / material-1 侧壁），它的 `obj.material` 是**数组**；
     * 对数组调 `gsap.to(..., { opacity: 1 })` 是**静默无效**的 —— 不报错、
     * 不生效。于是地图主体从来没被这条时间线点亮过，一直是靠 5 秒后的
     * `settle()` 兜底才出现。这就是「开场动画没做出来」的真正原因：
     * 时间线确实在跑，但它只点亮了单材质的白线，主体没被碰到。
     */
    group.traverse((obj) => {
      if (obj instanceof Mesh || obj instanceof LineSegments) {
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const material of list) {
          /*
           * 标了 `skipReveal` 的材质**不参与淡入**，永远保持 opacity 0。
           *
           * 用途：省份的侧壁。每个省都被当成一块独立挤出的 City，
           * 于是**每条省界都带了一圈发光侧壁** —— 用户看到内蒙古、新疆
           * 与邻省之间有「光屏」。侧壁只该出现在国境线上，
           * 所以省侧壁不点亮，另用外轮廓单独挤出一层来提供厚度。
           */
          if (material.userData?.skipReveal) continue;
          /*
           * 分段揭示（Demo2 的加载流程）：底圈 → 地图轮廓 → 细节/贴图。
           *
           * 用户的原话是「一开始是一个底圈圈，然后是地图轮廓，然后是地图细节、
           * 贴图」。所以各图元按 `userData.revealAt` 错开落位，而不是一起淡入：
           *   OutlineBody 的侧壁（国境线轮廓）最先，紧跟镜头推完
           *   省份顶面与地表贴图随后
           *   省界白线最后，让边界「描」在已经铺好的地形上
           * 没标 revealAt 的沿用 MAP_PUSH_DURATION（与 Demo2 同一时刻）。
           */
          const at =
            typeof material.userData?.revealAt === "number"
              ? (material.userData.revealAt as number)
              : MAP_PUSH_DURATION;
          tl.to(material, { opacity: 1, duration: 1, ease: "circ.out" }, at);
        }
      }
    });

    /*
     * 临时诊断（?fitprobe=1）：把地图的世界包围盒投影到屏幕，量出实际占比。
     * 取景不能靠公式猜 —— 地图是斜置的平面，透视下的投影尺寸与「包围球半径」
     * 差得远。量出来再标定 fitPadding。
     */
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("fitprobe")) {
      window.setTimeout(() => {
        const box = new Box3().setFromObject(group);
        const w = window as unknown as Record<string, unknown>;
        const pts: [number, number][] = [];
        for (const x of [box.min.x, box.max.x])
          for (const y of [box.min.y, box.max.y])
            for (const z of [box.min.z, box.max.z]) {
              const v = new Vector3(x, y, z).project(camera);
              pts.push([v.x, v.y]);
            }
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        w.__fit = {
          widthPct: Math.round(((Math.max(...xs) - Math.min(...xs)) / 2) * 100),
          heightPct: Math.round(((Math.max(...ys) - Math.min(...ys)) / 2) * 100),
          fitDistance: Math.round(fitDistance),
          box: {
            x: Math.round(box.max.x - box.min.x),
            y: Math.round(box.max.y - box.min.y),
            z: Math.round(box.max.z - box.min.z),
          },
        };
      }, 4200);
    }

    const settle = () => {
      group.position.set(0, 0, 0);
      group.scale.set(1, 1, 1);
      group.traverse((obj) => {
        if (obj instanceof Mesh || obj instanceof LineSegments) {
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
    /*
     * 兜底推迟到 5.4s。
     *
     * 分段揭示最晚一段（省界白线）在 3.35s 起、4.35s 完；原来 3.9s 的兜底
     * 会把最后一段硬切掉，前两段也就白分了。
     */
    const safety = window.setTimeout(settle, (MAP_PUSH_DURATION + 2.9) * 1000);

    return () => {
      window.clearTimeout(notify);
      window.clearTimeout(safety);
      tl.kill();
      settle();
    };
    // 依赖只有 mapTexture：它由 null 变成贴图的那一刻跑一次。
    // 不能再带上 fitDistance —— 画布尺寸一确定 fitDistance 就变，
    // 时间线会被 kill 重建，而各材质 opacity 起点是 0，重建没跑完地图就整幅透明。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * **与时间线解耦的终态兜底。**
   *
   * 上面那条 `safety` 挂在时间线 effect 里，effect 一旦重建就会被 clearTimeout
   * 清掉 —— 项目里有数百次量级的重渲染，实测地图**渲染出来之后又会消失**
   * （画布像素：t=8s 有 rgb(170,193,219)、t=12s 变 rgb(13,22,40)），
   * 而且时有时无。各材质的 opacity 起点是 0，只要停在 0 整幅地图就是全透明。
   *
   * 这一条依赖写死 `[]`：只在挂载时注册一次，`clearTimeout` 只在卸载时发生，
   * 任何重渲染都动不了它。5 秒后无条件把画面推到终态。
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const g = groupRef.current;
      if (!g) return;
      g.position.set(0, 0, 0);
      g.scale.set(1, 1, 1);
      g.traverse((obj) => {
        if (obj instanceof Mesh || obj instanceof LineSegments) {
          const list = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const material of list) material.opacity = 1;
        }
      });
    }, 5600);
    return () => window.clearTimeout(timer);
  }, []);

  /** 贴图就绪 = 遮罩可以撤了；与开场动画同帧发生，中间不留黑屏 */
  const sceneReadyRef = useRef(props.onSceneReady);
  sceneReadyRef.current = props.onSceneReady;
  useEffect(() => {
    if (mapTexture) useConfigStore.setState({ sceneReady: true });
  }, [mapTexture]);

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
        enableDamping
        zoomSpeed={0.3}
        minDistance={fitDistance * 0.22}
        maxDistance={fitDistance * 2.2}
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

  useFrame((_, delta) => {
    if (materialRef.current) materialRef.current.uniforms.time.value += delta / 3;
  });

  return (
    <ShapeBox bbox={bbox} args={[shapes, { depth, bevelEnabled: false }]}>
      {/* material-0（顶面）不画：顶面由各省自己铺，这里只要侧壁 */}
      <meshBasicMaterial attach="material-0" transparent opacity={0} depthWrite={false} />
      <ShiftMaterial
        transparent
        attach="material-1"
        ref={materialRef}
        opacity={0}
        depth={depth}
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
  const [shape, shapeGeometry] = useMemo(() => {
    const shapes = data.points.map((e) => new Shape(e));
    return [shapes, new ShapeGeometry(shapes)];
  }, [data.points]);

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
          userData={{ revealAt: 3.05 }}
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
          userData={plainSide ? { skipReveal: true } : undefined}
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
          userData={{ revealAt: 3.35 }}
        />
      </lineSegments>
    </object3D>
  );
}
