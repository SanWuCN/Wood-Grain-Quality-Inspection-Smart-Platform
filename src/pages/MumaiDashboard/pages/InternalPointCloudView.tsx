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
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, Line } from "@react-three/drei";
import { Box3, Vector3 } from "three";

import {
  DEFECT_STYLE,
  INTERNAL_CLOUD_SOURCE_NOTE,
  buildInternalCloud,
  fitGroupDistance,
  type CloudDefect,
  type ColumnCloud,
  type ColumnSpec,
} from "./internalPointCloud";
import "./internalPointCloud.css";

export type InternalPointCloudViewProps = {
  /** 高亮的构件（页面上选中的那根）；传空表示四根一样 */
  focusComponentId?: string;
  /** 只显示这些构件；不传表示全部 */
  onlyComponentIds?: readonly string[];
  /** 点开某一处缺陷时告诉页面（页面据此把热点详情切过去） */
  onPickDefect?: (defect: { componentId: string; defect: CloudDefect }) => void;
};

/** 外壳 / 芯的点材质参数（同一个材质给四根柱子复用，省一遍编译） */
const SHELL_COLOR = "#d8b98a";
const CORE_COLOR = "#6b4b2c";
const FOCUS_SHELL_COLOR = "#f3d9a8";

/** 相机竖向视场角（度）—— 建相机与算取景距离必须是同一个数 */
const CAMERA_FOV_DEG = 34;
/**
 * 相机相对注视点的方向（斜前上方；水平分量的模约等于 1，所以"距离"就是水平退开的米数）。
 *
 * 抬高量刻意压到 0.16：抬高越多越俯视，柱脚就越容易被画面下沿切掉。
 * 第一版是 0.30，四根一起看时最近那根（Z03）的柱脚正好切在画外。
 */
const CAMERA_DIR = { x: 0.62, y: 0.16, z: 0.78 } as const;

/** 一个点集：BufferGeometry + PointsMaterial（three 最小用法，不引额外封装） */
function PointSet({
  positions,
  color,
  size,
  opacity = 1,
}: {
  positions: Float32Array;
  color: string;
  size: number;
  opacity?: number;
}) {
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color={color} size={size} sizeAttenuation transparent opacity={opacity} depthWrite={false} />
    </points>
  );
}

function Column({ cloud, focused, onlyDefects }: { cloud: ColumnCloud; focused: boolean; onlyDefects: boolean }) {
  return (
    <group>
      {/*
        ⚠ 三段分开画（用户口径：「木柱内部都是点云，破损可视化之类的」）：
          ① 壳：亮一点、点大一点，看得出柱形；
          ② 内部木料：**按体积填满**（实心点云柱），点小一点、暗一点，不抢缺陷；
          ③ 缺陷：大点 + 各自的颜色；虫蛀空腔上再套一层淡球，让"洞"读得出来。
        「只看破损」把 ①② 收掉，只剩 ③ —— 那时屏幕上就是"哪里有伤"。
      */}
      {onlyDefects ? null : (
        <>
          <PointSet
            positions={cloud.shell}
            color={focused ? FOCUS_SHELL_COLOR : SHELL_COLOR}
            size={0.01}
            opacity={focused ? 0.34 : 0.2}
          />
          {/* 内部木料：点比壳小、比壳暗 —— 实心但不抢缺陷；透明度留出"看得见里面"的余地 */}
          <PointSet positions={cloud.volume} color={CORE_COLOR} size={0.0075} opacity={focused ? 0.3 : 0.16} />
        </>
      )}
      {cloud.defects.map((defect) => (
        <group key={`${defect.kind}-${defect.label}`}>
          <PointSet
            positions={defect.points}
            color={DEFECT_STYLE[defect.kind].color}
            size={defect.kind === "crack" ? 0.016 : 0.024}
          />
          {/* 虫蛀空洞加一层半透明球：空腔是"里面被掏空"，只靠一圈点看着像一撮火星 */}
          {defect.kind === "borer" ? (
            <mesh position={[defect.centroid.x, defect.centroid.y, defect.centroid.z]}>
              <sphereGeometry args={[0.075, 20, 16]} />
              <meshBasicMaterial color={DEFECT_STYLE.borer.color} transparent opacity={0.16} depthWrite={false} />
            </mesh>
          ) : null}
        </group>
      ))}
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
    /* 机位方向：斜前上方看过去（水平分量约等于 1，所以 distance 就是水平退开的米数） */
    camera.position.set(cx + distance * CAMERA_DIR.x, cy + distance * CAMERA_DIR.y, cz + distance * CAMERA_DIR.z);
    if (controls?.target) {
      controls.target.set(cx, cy, cz);
      controls.update();
    } else {
      camera.lookAt(new Vector3(cx, cy, cz));
    }
  }, [camera, controls, cx, cy, cz, columns, size.width, size.height]);
  return null;
}

/**
 * 把渲染器**这一帧真正提交的点数**报给页面（写进 `data-points`）。
 *
 * 为什么要一直报、而不是第一帧报一次：切"只看破损"之后木料整层收掉，屏幕上的点数
 * 会掉到千级 —— 那个数字要是还挂着 23 万，它就不再是"画出来了多少"的证据了。
 * 所以按 0.5 s 一次、且变化超过 2% 才 setState（不然每帧都渲染一次 React）。
 */
function PointCounter({ onChange }: { onChange: (points: number) => void }) {
  const lastRef = useRef({ at: 0, points: 0 });
  useFrame(({ gl, clock }) => {
    const points = gl.info.render.points;
    const last = lastRef.current;
    const now = clock.elapsedTime * 1000;
    if (now - last.at < 500) return;
    if (points === last.points) return;
    if (last.points > 0 && Math.abs(points - last.points) / Math.max(points, last.points) < 0.02) return;
    lastRef.current = { at: now, points };
    onChange(points);
  });
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
  const cloud = useMemo(() => buildInternalCloud(visibleIds), [visibleIds]);
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
   * 渲染器**实际画出来的点数**（`gl.info.render.points`，由画布里的 `PointCounter` 持续上报）。
   *
   * 为什么要把这个数字写到 DOM 上：这一屏的可见结果就是"点"，而 WebGL 画布
   * 在验收里没法用 `innerText` 判断画没画（黑底和"没画"长得一样）。
   * 有了它，工装可以断言"真的画了一万多个点"，而不是"画布在那儿"。
   */
  const [drawnPoints, setDrawnPoints] = useState(0);

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

  return (
    <div className="ipc">
      <div className="ipc__stage" data-points={drawnPoints} data-defects={defects.length}>
        <Canvas
          camera={cameraProps}
          dpr={[1, 1.75]}
          gl={{ antialias: true }}>
          <color attach="background" args={["#080b11"]} />
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
              focused={!pickedComponent || pickedComponent === column.spec.componentId}
              onlyDefects={!showMaterial}
            />
          ))}
          <OrbitControls makeDefault enablePan target={frame.center} />
          {/* 取景与点数都跟着"你在看什么"走：切构件 / 切木料三态时重算 */}
          <FrameCamera frame={frame} />
          <PointCounter onChange={setDrawnPoints} />
        </Canvas>

        <div className="ipc__viewhint">左键拖动旋转 · 滚轮缩放 · 右键平移</div>
      </div>

      <aside className="ipc__side">
        <h4 className="sub">这一屏是什么</h4>
        <p className="ipc__note">{INTERNAL_CLOUD_SOURCE_NOTE}</p>

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
