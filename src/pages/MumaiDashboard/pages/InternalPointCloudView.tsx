/**
 * 数字孪生 · 内部点云视图（用户 2026-09-30：「我现在要他也可以展示内部点云，
 * 分一项作为内部点云，有虫蛀或内部裂痕破损，你根据原有外形，生成一下」）
 *
 * ── 这一屏与高斯泼溅（外观）的关系 ──────────────────────────────────
 * 外观那一屏画的是**重建产物**（`gs.sog`，Spark 渲染器）；这一屏画的是**按外形生成的
 * 结构点云**（`internalPointCloud.ts` 算出来的坐标）。两者共用同一套场景坐标
 * （四柱 ±2.2 m）与同一个包围盒（`SPLAT_BOUNDS`），所以切过来时"柱子还在原来的位置"，
 * 只是从"看表面"变成"看里面"。
 *
 * ⚠ **不在同一张画布上叠加**：Spark 自己管一块 WebGL 画布，点云这块是 three 的画布，
 * 两套渲染器的相机各自维护；硬叠会出现"两层没对齐"这种最难解释的偏差。
 * 所以这里做成**切换**（外观 · 高斯场景 / 内部点云），一次只挂一块画布。
 *
 * ── 画什么（用户 2026-09-30 补的第二句：「做的是一个 3d 的点云展示，就是木柱内部
 *    都是点云，破损可视化之类的」）────────────────────────────────────
 *   · 木料：**柱体内是实心的点云**（柱壳 + 内部体积一起填），不是空壳；
 *   · 缺陷：虫蛀空洞（橙）、内部裂痕（洋红）、缺损/破损（蓝灰）——这三种是**从木料里
 *     挖掉的区域**（虫蛀腔内没有木点、裂痕是一条缝、缺损是柱脚被啃掉一块），
 *     配色与图例同源（`DEFECT_STYLE`），每一处都带编号与出处
 *     （`CURRENT_RISKS` 的编号或档案原话）；
 *   · 三种看法（`materialView`）：木料全显 / 只看内部（收壳）/ 只看破损（木料整层收掉）；
 *   · 模型外框：用 `SPLAT_BOUNDS` 画一个线框盒 —— 这是"按原有外形生成"的参照物
 *     （只在四根一起看时画，单看一根时它会挡住取景）；
 *   · 地面网格：给出尺度感（每格 1 m）。
 *
 * ⚠ 取景跟着"你在看什么"走（`FrameCamera`）：只看一根时按这一根取景。
 *   光改 `<Canvas camera>` 是没用的 —— R3F 只在创建相机时读它，见 `FrameCamera` 的说明。
 */
import { useEffect, useMemo, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, Line } from "@react-three/drei";
import { Box3, Vector3 } from "three";

import {
  DEFECT_STYLE,
  INTERNAL_CLOUD_SOURCE_NOTE,
  buildInternalCloud,
  cloudRefinement,
  columnPointBudget,
  fitGroupDistance,
  type CloudDefect,
  type ColumnCloud,
  type ColumnSpec,
} from "./internalPointCloud";
import { ColumnSplats, HoleMarks, SceneHandle, SparkRendererSlot } from "./columnSplats";
import "./internalPointCloud.css";

export type InternalPointCloudViewProps = {
  /** 高亮的构件（页面上选中的那根）；传空表示四根一样 */
  focusComponentId?: string;
  /** 只显示这些构件；不传表示全部 */
  onlyComponentIds?: readonly string[];
  /** 点开某一处缺陷时告诉页面（页面据此把热点详情切过去） */
  onPickDefect?: (defect: { componentId: string; defect: CloudDefect }) => void;
};

/**
 * 配色（用户 2026-09-20：「点云目前色彩太花了」→ 2026-10-01：「外壳像高斯泼溅的，内部缺陷也得真实点」）。
 *
 * ── 花在哪 ──────────────────────────────────────────────────────────
 * 原来柱面米黄 `#d8b98a`、内部深棕 `#6b4b2c`、高亮又是亮奶油 `#f3d9a8` ——
 * **三个不同色相**；而壳与芯都是半透明的，两层叠在一起互相串色，
 * 再叠上三类缺陷的半透明色（橙 / 洋红 / 蓝灰）与虫蛀那层淡球，整根柱子成了拼色。
 *
 * ── 现在：颜色**全部由几何层逐点给**，这里一个颜色常量都不留 ──────────
 * 材质给一个平涂色 + 硬边圆盘 = 一团彩色噪点，形状做得再准也读不出"洞 / 缝 / 断面"。
 * 所以只保留了一个配色常量 `DEFECT_STYLE`（**界面图例**用的名字与色标，
 * 与屏幕上点云的颜色不再是一回事 —— 点云的颜色在 `internalPointCloud.ts` 里按深度算）。
 */
/** 相机竖向视场角（度）—— 建相机与算取景距离必须是同一个数 */
const CAMERA_FOV_DEG = 34;
/**
 * 相机相对注视点的方向（斜前上方；水平分量的模约等于 1，所以"距离"就是水平退开的米数）。
 *
 * 抬高量刻意压到 0.16：抬高越多越俯视，柱脚就越容易被画面下沿切掉。
 * 第一版是 0.30，四根一起看时最近那根（Z03）的柱脚正好切在画外。
 */
const CAMERA_DIR = { x: 0.62, y: 0.16, z: 0.78 } as const;

function Column({ cloud, onlyDefects }: { cloud: ColumnCloud; onlyDefects: boolean }) {
  return (
    <group>
      {/*
        ⚠ 三段分开画（用户口径：「木柱内部都是点云，破损可视化之类的」）：
          ① 外壳：贴在柱面上的一层软高斯（读得出柱形与木纹）；
          ② 内部木料：**按体积填满**的各向同性小高斯，暗一档，不抢缺陷；
          ③ 缺陷：虫蛀腔壁 / 裂口两面 / 磕碰断面，各自带深度明暗。
        「只看破损」把 ①② 收掉，只剩 ③ —— 那时屏幕上就是"哪里有伤"。

        ── 为什么交给 `ColumnSplats`（Spark 泼溅）而不是继续用点 ─────────
        用户口径 2026-10-01：「外壳像高斯泼溅的，内部缺陷也得真实点」。
        `gl.POINTS` 画出来是**硬边圆盘**，加密到 3.5 mm 也还是一颗颗分得清；
        泼溅的基元是**有朝向的软高斯**，交叠成面。差别不在点数，在基元形状。
      */}
      <ColumnSplats cloud={cloud} showShell={!onlyDefects} showVolume={!onlyDefects} showDefects />
    </group>
  );
}

/** 取景用的目标物：注视点（米，场景坐标）+ 要框住的这些柱子 */
type FrameTarget = { center: [number, number, number]; columns: readonly ColumnSpec[] };

/**
 * 把相机**真的挪到**取景位上去。
 *
 * ⚠ 为什么不能只靠 `<Canvas camera={{ position, fov }}>`：R3F 只在**创建**相机时用它，
 *   后面改这个对象不会把已经存在的相机搬走。第一版就是踩在这儿：切到"只看 Z04"时
 *   只有 OrbitControls 的 `target` 跟着挪了（画面居中了），距离没变 —— 柱子还是四根
 *   一起看时那么远；后来只补了 target，距离仍按整个场景算，柱子只占屏幕中间一小条。
 *   这里用**画布的真实宽高比**（`useThree().size`）+ `fitGroupDistance`（每一根各算一次）
 *   算距离，显式 set 机位并把 `controls.target` 一起挪过去
 *   （`makeDefault` 之后能从 `useThree` 拿到它）。
 *
 * 依赖里带上画布尺寸：窗口变大/变小时按新的宽高比重新取景（不然会切头切尾）。
 */
function FrameCamera({ frame }: { frame: FrameTarget }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const controls = useThree((state) => state.controls) as { target: Vector3; update: () => void } | null;
  const { center, columns } = frame;
  const cx = center[0];
  const cy = center[1];
  const cz = center[2];
  useEffect(() => {
    const aspect = size.height > 0 ? size.width / size.height : 1.6;
    const distance = fitGroupDistance({
      columns,
      dirX: CAMERA_DIR.x,
      dirZ: CAMERA_DIR.z,
      fovDeg: CAMERA_FOV_DEG,
      aspect,
    });
    /*
      ⚠ 基准机位**必须与加探针之前逐位一致**（`distance × CAMERA_DIR`）：
      `CAMERA_DIR` 的约定是"水平分量的模约等于 1"，所以 distance 就是水平退开的米数。
      本轮第一次改这段时用 `polar/azimuth` 反算方向、又自己归一，默认机位跑了两次飞
      （一次柱子躺着、一次相机飞到 58 米）—— 都是**回归**。
      现在：先落到基准机位，再只对探针做**绕注视点的球面旋转**（相对量，不动基准）。
    */
    const baseX = cx + distance * CAMERA_DIR.x;
    const baseY = cy + distance * CAMERA_DIR.y;
    const baseZ = cz + distance * CAMERA_DIR.z;
    let probe: { polar?: number; azimuth?: number; scale?: number } | null = null;
    try {
      const raw = window.sessionStorage?.getItem("ipcProbePose");
      if (raw) {
        probe = JSON.parse(raw) as { polar?: number; azimuth?: number; scale?: number };
        /*
          ⚠ **只生效一次**：读完立刻删掉。
          这个键是给工装出"近看 / 俯视"样张用的，但它是会话级的 ——
          留在里面会让**下次打开这一屏**还是那个探针机位
          （本轮出过一次"验收截图是俯视角"，差点拿它当默认视角的证据）。
        */
        window.sessionStorage.removeItem("ipcProbePose");
      }
    } catch {
      /* sessionStorage 不可用（隐私模式等）时按产品取景走 */
    }
    if (probe) {
      /* 把基准机位换算成"绕注视点的球坐标"，再按探针给的 polar / azimuth / scale 重摆 */
      const dx = baseX - cx;
      const dy = baseY - cy;
      const dz = baseZ - cz;
      const baseRadius = Math.hypot(dx, dy, dz);
      const radius = baseRadius * (typeof probe.scale === "number" ? probe.scale : 1);
      const polar = typeof probe.polar === "number" ? probe.polar : Math.acos(dy / Math.max(1e-6, baseRadius));
      const azimuth = typeof probe.azimuth === "number" ? probe.azimuth : Math.atan2(dz, dx);
      camera.position.set(
        cx + radius * Math.sin(polar) * Math.cos(azimuth),
        cy + radius * Math.cos(polar),
        cz + radius * Math.sin(polar) * Math.sin(azimuth),
      );
    } else {
      camera.position.set(baseX, baseY, baseZ);
    }
    if (controls?.target) {
      controls.target.set(cx, cy, cz);
      controls.update();
    } else {
      camera.lookAt(new Vector3(cx, cy, cz));
    }
  }, [camera, controls, cx, cy, cz, columns, size.width, size.height]);
  return null;
}

export default function InternalPointCloudView({ focusComponentId = "", onlyComponentIds, onPickDefect }: InternalPointCloudViewProps) {
  /**
   * 「只看这一根」（用户口径里的"分一项"要能聚焦）。
   *
   * 默认四根都画；勾上之后只保留**当前聚焦的那一根** —— ㉒ 自动切过来时聚焦 Z04，
   * 讲解人一勾就能把 Z04 的两处虫蛀、一条裂痕、柱脚缺损看干净，不被另外三根挡视线。
   */
  const [soloComponent, setSoloComponent] = useState(false);
  const visibleIds = useMemo(() => {
    if (!soloComponent || !focusComponentId) return onlyComponentIds;
    return [focusComponentId];
  }, [soloComponent, focusComponentId, onlyComponentIds]);
  /**
   * 剖开看内部（用户口径 2026-10-02：「根本看不出内部问题，内部得有虫蛀之类的孔洞」）。
   *
   * 默认机位是斜前方，柱子朝相机那一面全是外皮 —— 内部有没有虫蛀、空到什么程度，
   * 从外面读不出来。勾上之后把朝相机那一面的扇形壳与木料收掉（生成期剖切，
   * 见 `internalPointCloud.ts` 的 `CUTAWAY_SPAN`），腔壁与虫道直接露出来。
   *
   * ⚠ `cutaway` 必须进 `useMemo` 依赖：构建结果按 `visibleIds` 缓存，
   * 只改模块里的开关不会触发重算（切一下屏幕上什么都不会变）。
   */
  const [cutaway, setCutaway] = useState(false);
  const cloud = useMemo(() => buildInternalCloud(visibleIds, cutaway), [visibleIds, cutaway]);
  /**
   * 两种"怎么看"的开关：
   *   · `showShell` —— 要不要画木料（壳 + 内部体积）。关掉就只剩缺陷点；
   *   · `onlyDefects` —— **只看破损**（用户口径里的"破损可视化"）：把木料整层收掉。
   * 两者语义有重叠（都把木料收掉），所以合并成一个三态：木料全显 / 只看内部 / 只看破损。
   */
  const [materialView, setMaterialView] = useState<"all" | "inner" | "defects">("all");
  const showMaterial = materialView !== "defects";
  const [pickedComponent, setPickedComponent] = useState<string>("");
  /**
   * **屏幕上这一刻真在画的高斯颗数**（用户 2026-10-01：「外壳像高斯泼溅的」之后，
   * 这一屏画的已经不是 `gl.POINTS` 而是泼溅基元，所以 `gl.info.render.points`
   * 恒为 0 —— 那个读数已经不适用了）。
   *
   * 写在 `data-splats` 上给工装断言，而且必须跟着**可见范围**变：
   * 「只看 Z04」与「只看破损」两个开关都会改变屏幕上画了多少 ——
   * 写成一个与开关无关的常量，那两条判据就永远看不出变化（等于没测）。
   */
  const splatCount = useMemo(
    () =>
      cloud.columns.reduce((sum, column) => {
        const defects = column.defectSplats.reduce((inner, defect) => inner + defect.count, 0);
        return sum + (showMaterial ? column.shellSplats.count + column.volumeSplats.count + column.hollowSplats.count : 0) + defects;
      }, 0),
    [cloud, showMaterial],
  );

  /* 外框盒：用 SPLAT_BOUNDS 画 —— "按原有外形生成"的参照 */
  const boxLines = useMemo(() => {
    const box = new Box3(new Vector3(...cloud.bounds.min), new Vector3(...cloud.bounds.max));
    const min = box.min;
    const max = box.max;
    const corners: [number, number, number][] = [
      [min.x, min.y, min.z], [max.x, min.y, min.z], [max.x, min.y, max.z], [min.x, min.y, max.z],
      [min.x, max.y, min.z], [max.x, max.y, min.z], [max.x, max.y, max.z], [min.x, max.y, max.z],
    ];
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    return edges.map(([a, b]) => [corners[a], corners[b]] as [[number, number, number], [number, number, number]]);
  }, [cloud.bounds]);

  const defects = useMemo(
    () => cloud.columns.flatMap((column) => column.defects.map((defect) => ({ column, defect }))),
    [cloud.columns],
  );

  /*
    取景依据：**当前看得见的这些柱子**，不是整个场景的包围盒。

    ⚠ 第一版一律按 `SPLAT_BOUNDS`（整个殿 ±3.2 m）取景，于是"只看 Z04"时
      柱子只占画面中间一小条，缺陷更看不清 —— 取景要跟着"你在看什么"走。
    只剩一两根时也不再画整个场景的线框盒（那盒子会把视野又撑回全场）。

    ⚠ 第二版只按"整组跨度 × 柱高"算一个距离，四根一起看时**斜前方最近那根的柱脚
      切在画外**：相机是斜着看的，Z03 比场地中心近 3.1 m，同样 3.2 m 高的柱子在屏幕上
      粗一圈。所以距离交给 `fitGroupDistance` —— 每一根各算一次、取最远的那个。

    注视点用这组柱子的水平中心与柱身中部（旋转时才不会绕场地中心转）。

    视场收窄到 34°（第一版 42° + 太近，柱子全被压成斜线）。
  */
  const frame = useMemo<FrameTarget>(() => {
    const specs = cloud.columns.map((column) => column.spec);
    const minX = Math.min(...specs.map((spec) => spec.x));
    const maxX = Math.max(...specs.map((spec) => spec.x));
    const minZ = Math.min(...specs.map((spec) => spec.z));
    const maxZ = Math.max(...specs.map((spec) => spec.z));
    const baseY = Math.min(...specs.map((spec) => spec.baseY));
    const topY = Math.max(...specs.map((spec) => spec.baseY + spec.heightM));
    return {
      center: [(minX + maxX) / 2, (baseY + topY) / 2, (minZ + maxZ) / 2],
      columns: specs,
    };
  }, [cloud.columns]);

  /*
    建相机时先给一个近似机位：这一刻画布还没量出宽高比（`FrameCamera` 在挂载后用
    `fitGroupDistance` + 真实宽高比把它摆正）。fov 与 `FrameCamera` 用的是同一个常量。
  */
  const cameraProps = useMemo(() => {
    const distance = fitGroupDistance({
      columns: frame.columns,
      dirX: CAMERA_DIR.x,
      dirZ: CAMERA_DIR.z,
      fovDeg: CAMERA_FOV_DEG,
    });
    return {
      position: [
        frame.center[0] + distance * CAMERA_DIR.x,
        frame.center[1] + distance * CAMERA_DIR.y,
        frame.center[2] + distance * CAMERA_DIR.z,
      ] as [number, number, number],
      fov: CAMERA_FOV_DEG,
    };
  }, [frame]);

  useEffect(() => {
    /* 页面切换构件时，把高亮同步过去（这里只做"点了缺陷再看哪个构件"） */
    if (focusComponentId) setPickedComponent(focusComponentId);
  }, [focusComponentId]);

  /**
   * 精度读数（`refinementOf`）：环向/轴向点距与体密度。
   *
   * 为什么要显示出来：用户要的是"更精细、轮廓能对上单根那根" ——
   * 把"精细"落成**毫米数**，现场才能一眼说清这是多细，而不是靠感觉；
   * 单测与验收工装也读同一份数字（`data-arc-mm` / `data-level-mm`）。
   */
  const refinement = useMemo(() => cloudRefinement(cloud), [cloud]);
  const coarsest = useMemo(
    () => refinement.reduce((worst, item) => (item.arcSpacingMm > worst.arcSpacingMm ? item : worst), refinement[0]),
    [refinement],
  );
  const budget = useMemo(() => cloud.columns.reduce((sum, column) => sum + columnPointBudget(column), 0), [cloud.columns]);

  return (
    <div className="ipc">
      <div
        className="ipc__stage"
        data-defects={defects.length}
        /* 精度读数也挂到 DOM 上：工装据此断言"点云到底多细"，不靠看图 */
        data-arc-mm={coarsest ? coarsest.arcSpacingMm.toFixed(2) : ""}
        data-level-mm={coarsest ? coarsest.levelSpacingMm.toFixed(2) : ""}
        data-budget={budget}
        /*
          这一屏画的是**高斯泼溅基元**（`gl.POINTS` 已经不用了），所以
          `data-points`（渲染器自报的 points）会一直是 0，工装要看的是 `data-splats`：
          屏幕上这一刻真在画的高斯颗数（跟着「只看 Z04」「只看破损」变）。
          `data-shell` 固定 `splat` —— 外壳本身就是泼溅，
          不再有"真实柱面 / 程序化兜底"两条路（那份 4.2 万点的资产经复核是噪声区）。
        */
        data-splats={splatCount}
        data-shell="splat">
        <Canvas
          camera={cameraProps}
          dpr={[1, 1.75]}
          gl={{ antialias: true }}>
          <color attach="background" args={["#080b11"]} />
          {/* 泼溅渲染器：与主视图「高斯场景」同一套（`SplatStage.tsx`），外观才同源 */}
          <SparkRendererSlot />
          {/* 场景句柄：只给工装诊断"到底有几份泼溅在画"用 */}
          <SceneHandle />
          {/*
            洞心的屏幕坐标（只给工装用）：工装据此量"洞口有多暗、多大"，
            不再在工装里写死坐标（机位 / 柱径 / 洞口方位角都会变）。
            洞口半径取 `defect.carve.radius`；`centroid` 是洞心。
          */}
          <HoleMarks
            columns={cloud.columns.map((column) => ({
              componentId: column.spec.componentId,
              axis: { x: column.spec.x, z: column.spec.z },
              defects: column.defects.map((defect) => ({
                label: defect.label,
                centroid: defect.centroid,
                radius: defect.carve.kind === "borer" ? defect.carve.radius : 0.06,
              })),
            }))}
          />
          <ambientLight intensity={1.1} />
          <Grid
            args={[20, 20]}
            position={[0, cloud.bounds.min[1] + 0.01, 0]}
            cellSize={1}
            cellColor="#2a3442"
            sectionSize={5}
            sectionColor="#3d4b5e"
            infiniteGrid
            fadeDistance={26}
            fadeStrength={1.2}
          />
          {/* 整个场景的线框盒只在"四根一起看"时画：它跨 ±3.2 m，单看一根时会把视野撑回全场 */}
          {cloud.columns.length >= 3
            ? boxLines.map((points, index) => (
                <Line key={index} points={points} color="#3f5a7a" lineWidth={1} dashed dashSize={0.18} gapSize={0.12} />
              ))
            : null}
          {cloud.columns.map((column) => (
            <Column
              key={column.spec.componentId}
              cloud={column}
              onlyDefects={!showMaterial}
            />
          ))}
          <OrbitControls makeDefault enablePan target={frame.center} />
          {/* 取景跟着"你在看什么"走：切构件 / 切木料三态时重算 */}
          <FrameCamera frame={frame} />
        </Canvas>

        <div className="ipc__viewhint">左键拖动旋转 · 滚轮缩放 · 右键平移</div>
      </div>

      <aside className="ipc__side">
        {/*
          ── 原来这里是一块「这一屏是什么」+ 整段来源说明（用户 2026-10-02 要求去掉）──
          用户原话：「『这一屏是什么 … 缺陷位置为预置结果。』这个东西不要有」。
          去掉的是**那一块标题 + 整段话**，口径本身不能丢（PRD 要求写明
          "按外形与档案记录生成、不是实测点云、缺陷为预置结果"），
          所以压成精度栏标题旁的一行小字 `ipc__sourcetag`：
          同样的三件事都还在，但不再占一屏的位置去解释自己。
        */}

        {/*
          精度读数（用户 2026-10：「3d 点云做得更精细一些，轮廓要能对上单根那根」）。
          「精细」在这里落成两个毫米数 + 一个体密度，读的就是生成器自己报的值
          （`cloudRefinement`），页面不另算一套 —— 免得显示的数字与画出来的点对不上。
        */}
        <h4 className="sub">
          点云精度
          <span className="muted">共 {budget.toLocaleString("zh-CN")} 点</span>
        </h4>
        <p className="ipc__sourcetag" title={INTERNAL_CLOUD_SOURCE_NOTE}>
          {INTERNAL_CLOUD_SOURCE_NOTE}
        </p>
        <ul className="ipc__legend ipc__legend--precision">
          <li>
            柱面环向点距
            <span className="muted">
              {coarsest ? `${coarsest.arcSpacingMm.toFixed(2)} mm（最粗的 ${coarsest.componentId}）` : "—"}
            </span>
          </li>
          <li>
            柱身轴向点距
            <span className="muted">{coarsest ? `${coarsest.levelSpacingMm.toFixed(2)} mm` : "—"}</span>
          </li>
          <li>
            内部木料密度
            <span className="muted">
              {coarsest ? `${Math.round(coarsest.volumePerM3 / 1000)}k 点/m³` : "—"}
            </span>
          </li>
          <li>
            柱面采样
            <span className="muted">
              {coarsest ? `环向 ${coarsest.shellRings} 点 × 轴向 ${coarsest.shellLevels} 层` : "—"}
            </span>
          </li>
        </ul>

        <div className="ipc__row">
          {/* 三态：木料全显 → 只看内部（收壳）→ 只看破损（木料整层收掉） */}
          {([
            ["all", "木料全显"],
            ["inner", "只看内部"],
            ["defects", "只看破损"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`ipc__toggle${materialView === key ? " is-on" : ""}`}
              title={
                key === "all"
                  ? "外壳 + 内部木料 + 缺陷，三层一起看"
                  : key === "inner"
                    ? "收掉外表壳，只留内部木料与缺陷"
                    : "木料整层收掉，屏幕上只剩破损/虫蛀/裂痕的位置"
              }
              onClick={() => setMaterialView(key)}>
              {label}
            </button>
          ))}
          {focusComponentId ? (
            <button
              type="button"
              className={`ipc__toggle${soloComponent ? " is-on" : ""}`}
              title="只画页面上选中的那一根，便于讲这一根的缺陷"
              onClick={() => setSoloComponent((value) => !value)}>
              {soloComponent ? `只看 ${focusComponentId}（已开）` : `只看 ${focusComponentId}`}
            </button>
          ) : null}
          {/*
            剖开看内部（用户口径 2026-10-02：「根本看不出内部问题」）：
            朝相机那一面的外壳与木料收掉，腔壁、虫道与道口直接露出来。
            只在「木料全显」时有意义 —— 「只看内部/只看破损」本来就把壳收掉了。
          */}
          <button
            type="button"
            className={`ipc__toggle${cutaway ? " is-on" : ""}`}
            title="把朝镜头那一面的外壳与木料剖掉，直接看腔壁与虫道（不改变缺陷本身）"
            onClick={() => setCutaway((value) => !value)}>
            {cutaway ? "剖开看内部（已开）" : "剖开看内部"}
          </button>
          <button type="button" className={`ipc__toggle${pickedComponent ? "" : " is-on"}`} onClick={() => setPickedComponent("")}>
            四根都亮
          </button>
        </div>

        <h4 className="sub">
          内部缺陷
          <span className="muted">{defects.length} 处</span>
        </h4>
        <ul className="ipc__legend">
          {Object.entries(DEFECT_STYLE).map(([kind, style]) => (
            <li key={kind}>
              <i style={{ background: style.color }} aria-hidden="true" />
              {style.label}
              <span className="muted">{cloud.totals[kind as keyof typeof cloud.totals]} 处</span>
            </li>
          ))}
        </ul>

        <ul className="ipc__defects">
          {defects.map(({ column, defect }) => (
            <li key={`${column.spec.componentId}-${defect.label}`}>
              <button
                type="button"
                className={pickedComponent === column.spec.componentId ? "is-on" : ""}
                onClick={() => {
                  setPickedComponent(column.spec.componentId);
                  onPickDefect?.({ componentId: column.spec.componentId, defect });
                }}>
                <b>{column.spec.componentId}</b>
                <span>{defect.label}</span>
                <em>
                  {DEFECT_STYLE[defect.kind].label} · {defect.source}
                </em>
              </button>
            </li>
          ))}
          {defects.length === 0 ? <li className="muted">当前筛选下没有内部缺陷记录</li> : null}
        </ul>

        <h4 className="sub">四根柱子的外形（档案值）</h4>
        <ul className="ipc__specs">
          {cloud.columns.map((column) => (
            <li key={column.spec.componentId} className={pickedComponent === column.spec.componentId ? "is-on" : ""}>
              <b>{column.spec.componentId}</b>
              <span>
                {column.spec.material} · 直径 {Math.round(column.spec.radiusM * 2000)} mm · {column.spec.name}
              </span>
              <em>
                {column.defects.length ? `内部缺陷 ${column.defects.length} 处` : "无内部缺陷记录"}
              </em>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
