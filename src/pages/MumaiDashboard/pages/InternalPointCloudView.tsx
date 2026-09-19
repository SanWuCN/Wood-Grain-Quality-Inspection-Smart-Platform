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
 * 所以这里做成**切换**（外观 / 内部点云 / 并排），并排时是两块画布共享同一组相机参数。
 *
 * ── 画什么 ──────────────────────────────────────────────────────────
 *   · 外壳点：暖木色，看得出来是四根圆柱；
 *   · 内部芯点：深棕、稀疏，给体积感；
 *   · 缺陷：虫蛀空洞（橙）、内部裂痕（洋红）、缺损/破损（蓝灰）——配色与图例同源
 *     （`DEFECT_STYLE`），并且**每一处都带编号与出处**（`CURRENT_RISKS` 的编号或档案原话）；
 *   · 模型外框：用 `SPLAT_BOUNDS` 画一个线框盒 —— 这是"按原有外形生成"的参照物；
 *   · 地面网格：给出尺度感（每格 1 m）。
 */
import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls, Line } from "@react-three/drei";
import { Box3, Vector3 } from "three";

import {
  DEFECT_STYLE,
  INTERNAL_CLOUD_SOURCE_NOTE,
  buildInternalCloud,
  type CloudDefect,
  type ColumnCloud,
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

function Column({ cloud, focused }: { cloud: ColumnCloud; focused: boolean }) {
  return (
    <group>
      {/*
        ⚠ 外壳默认**半透明**（0.3）：这一屏是"看里面"的，壳要是实心的，
        虫蛀与裂痕全被自己的柱子挡住 —— 第一版 0.55 就这样，截图上只看得出柱形。
        「隐藏外表面（只看内部）」按钮再把壳整层收掉。
      */}
      <PointSet positions={cloud.shell} color={focused ? FOCUS_SHELL_COLOR : SHELL_COLOR} size={0.011} opacity={focused ? 0.3 : 0.16} />
      <PointSet positions={cloud.core} color={CORE_COLOR} size={0.013} opacity={0.4} />
      {cloud.defects.map((defect) => (
        <group key={`${defect.kind}-${defect.label}`}>
          <PointSet
            positions={defect.points}
            color={DEFECT_STYLE[defect.kind].color}
            size={defect.kind === "crack" ? 0.014 : 0.024}
          />
          {/*
            虫蛀空洞再加一层**半透明球**：空腔是"里面被掏空"，
            只靠一圈点看着像一撮火星；套个淡淡的球，它才读得出是个洞。
          */}
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
  const [showShell, setShowShell] = useState(true);
  const [pickedComponent, setPickedComponent] = useState<string>("");
  /**
   * 渲染器**实际画出来的点数**（`gl.info.render.points`，第一帧之后读一次）。
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
    相机初始机位。
    ⚠ 第一版按"包围盒对角线 × 1.15"取距离、并且抬得很高，结果四根柱子全被压成斜线
      （透视收敛太强），截图上像四根躺着的杆子。现在：退远一点、抬低一点、视场收窄，
      并把注视点放在柱身中部（OrbitControls 的 target 也一样），柱子才站得住。
  */
  const camera = useMemo(() => {
    const size = new Vector3(...cloud.bounds.max).sub(new Vector3(...cloud.bounds.min));
    const distance = Math.max(size.x, size.z) * 1.55;
    return {
      position: [distance * 0.62, cloud.bounds.min[1] + 2.6, distance * 0.72] as [number, number, number],
      fov: 34,
    };
  }, [cloud.bounds]);

  useEffect(() => {
    /* 页面切换构件时，把高亮同步过去（这里只做"点了缺陷再看哪个构件"） */
    if (focusComponentId) setPickedComponent(focusComponentId);
  }, [focusComponentId]);

  return (
    <div className="ipc">
      <div className="ipc__stage" data-points={drawnPoints} data-defects={defects.length}>
        <Canvas
          camera={camera}
          dpr={[1, 1.75]}
          gl={{ antialias: true }}
          onCreated={({ gl }) => {
            /* 第一帧之后再读：此时 info.render.points 才是这一帧真实提交的点数 */
            requestAnimationFrame(() => setDrawnPoints(gl.info.render.points));
          }}>
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
          {boxLines.map((points, index) => (
            <Line key={index} points={points} color="#3f5a7a" lineWidth={1} dashed dashSize={0.18} gapSize={0.12} />
          ))}
          {cloud.columns.map((column) => (
            <Column
              key={column.spec.componentId}
              cloud={showShell ? column : { ...column, shell: new Float32Array(), core: new Float32Array() }}
              focused={!pickedComponent || pickedComponent === column.spec.componentId}
            />
          ))}
          <OrbitControls makeDefault enablePan target={[0, cloud.bounds.min[1] + 1.5, 0]} />
        </Canvas>

        <div className="ipc__viewhint">左键拖动旋转 · 滚轮缩放 · 右键平移</div>
      </div>

      <aside className="ipc__side">
        <h4 className="sub">这一屏是什么</h4>
        <p className="ipc__note">{INTERNAL_CLOUD_SOURCE_NOTE}</p>

        <div className="ipc__row">
          <button type="button" className={`ipc__toggle${showShell ? " is-on" : ""}`} onClick={() => setShowShell((value) => !value)}>
            {showShell ? "隐藏外表面（只看内部）" : "显示外表面"}
          </button>
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
