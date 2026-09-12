/**
 * 知识库 · Token 关系链三维视图
 *
 * 原来的「向量空间」是一张 2D 散点图：13 个点落在 0–1 的方格子里，看不出任何结构，
 * 用户反馈「太假」。这里换成三维关系链 —— 每个分块是一个 Token 节点，边是真算出来的
 * 余弦相似度（见 logic.ts 的 buildTokenGraph），位置由 3D 力导向布局给出。
 *
 * 三条渲染约定：
 *   1. **节点用 InstancedMesh，边用一条 LineSegments**。分块数会随上传增长，
 *      不能一个节点一个 <mesh>；射线拾取用 instanceId，也不需要在场景里挂 13 个对象。
 *   2. **边的明暗直接编码相似度**（颜色乘一个按相似度归一化的系数），配合加法混合，
 *      弱边自然暗下去 —— LineBasicMaterial 的 linewidth 在 WebGL 下是被忽略的，
 *      没法靠粗细表达权重。
 *   3. **无人操作时缓慢自转**。静态截图里一眼能看出是三维；一旦用户开始拖拽就停，
 *      否则会和 OrbitControls 抢镜头。用 state 记录「用户是否操作过」，
 *      不用 ref 计数 —— StrictMode 下挂载期 effect 会跑两遍，ref 守卫会被打穿。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import {
  AdditiveBlending,
  Color,
  InstancedMesh,
  MathUtils,
  Matrix4,
  Quaternion,
  Vector3,
  type Group,
} from "three";
import { categoryColor } from "./constants";
import type { TokenGraph } from "./logic";

/**
 * 节点半径按节点数缩放。
 * 布局永远被归一化到半径 1，所以半径写死的话，块一多就会挤成一片。
 */
function nodeBaseRadius(nodes: number): number {
  return MathUtils.clamp(0.095 / Math.cbrt(Math.max(nodes, 2)), 0.011, 0.05);
}

export type TokenGraphFocus = {
  /** 悬停 / 选中的节点序号，null 表示没有焦点 */
  index: number | null;
  /** 由检索命中的分块序号（命中集合为空时不区分） */
  hitIndices: Set<number>;
};

type Props = {
  graph: TokenGraph;
  /** 节点序号 → 类别，用来上色 */
  categories: string[];
  focus: TokenGraphFocus;
  onHover: (index: number | null) => void;
  onPick: (index: number) => void;
};

/* ------------------------------------------------------------------ *
 * 场景内容
 * ------------------------------------------------------------------ */

function GraphBody({ graph, categories, focus, onHover, onPick }: Props) {
  const nodes = graph.stats.nodes;
  const mesh = useRef<InstancedMesh>(null);

  /** 节点半径：连得越多、边越像的块画得越大，孤立块缩到最小 */
  const radii = useMemo(() => {
    const base = nodeBaseRadius(nodes);
    const max = Math.max(...graph.weights, 1e-6);
    return graph.weights.map((weight) => base * (0.72 + 0.62 * Math.sqrt(Math.max(weight, 0) / max)));
  }, [graph, nodes]);

  /** 节点颜色：类别色。命中的块走 --glow-cyan，未命中且存在命中集合时压暗 */
  const colors = useMemo(
    () =>
      categories.map((category, index) => {
        const color = new Color(categoryColor(category));
        if (focus.hitIndices.size && !focus.hitIndices.has(index)) color.multiplyScalar(0.34);
        return color;
      }),
    [categories, focus.hitIndices],
  );

  /**
   * 边：一条 BufferGeometry 装下全部端点，颜色按相似度从暗蓝渐变到青。
   * 与焦点相连的边单独一组，用高亮色覆盖画一遍。
   */
  const edgeGeometry = useMemo(() => {
    const edges = graph.edges;
    const positions = new Float32Array(edges.length * 6);
    const colors = new Float32Array(edges.length * 6);
    const span = graph.stats.simMax - graph.stats.simMin;
    const low = new Color("#1d4a7a");
    const high = new Color("#5de4ff");
    edges.forEach((edge, index) => {
      const weight = span > 1e-9 ? (edge.similarity - graph.stats.simMin) / span : 0.5;
      // 加法混合下，「暗」就等于「弱」：弱边不需要单独的半透明通道
      const shade = 0.3 + 0.7 * weight;
      positions.set(
        [
          graph.positions[edge.a * 3],
          graph.positions[edge.a * 3 + 1],
          graph.positions[edge.a * 3 + 2],
          graph.positions[edge.b * 3],
          graph.positions[edge.b * 3 + 1],
          graph.positions[edge.b * 3 + 2],
        ],
        index * 6,
      );
      const mid = low.clone().lerp(high, weight).multiplyScalar(shade);
      colors.set([mid.r, mid.g, mid.b, mid.r, mid.g, mid.b], index * 6);
    });
    return { positions, colors };
  }, [graph]);

  const focusGeometry = useMemo(() => {
    const index = focus.index;
    if (index === null) return null;
    const linked = graph.edges.filter((edge) => edge.a === index || edge.b === index);
    if (!linked.length) return null;
    const positions = new Float32Array(linked.length * 6);
    linked.forEach((edge, slot) => {
      positions.set(
        [
          graph.positions[edge.a * 3],
          graph.positions[edge.a * 3 + 1],
          graph.positions[edge.a * 3 + 2],
          graph.positions[edge.b * 3],
          graph.positions[edge.b * 3 + 1],
          graph.positions[edge.b * 3 + 2],
        ],
        slot * 6,
      );
    });
    return positions;
  }, [focus.index, graph]);

  /** 写入实例矩阵：位置 + 半径缩放 + 焦点节点的放大 */
  useEffect(() => {
    const instance = mesh.current;
    if (!instance || !nodes) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3();
    for (let index = 0; index < nodes; index += 1) {
      position.set(
        graph.positions[index * 3],
        graph.positions[index * 3 + 1],
        graph.positions[index * 3 + 2],
      );
      const boost = focus.index === index ? 1.75 : 1;
      const size = radii[index] * boost;
      scale.set(size, size, size);
      matrix.compose(position, new Quaternion(), scale);
      instance.setMatrixAt(index, matrix);
    }
    instance.instanceMatrix.needsUpdate = true;
  }, [focus.index, graph, nodes, radii]);

  useEffect(() => {
    const instance = mesh.current;
    if (!instance || !nodes) return;
    /*
     * `instanceColor` 要等第一次 setColorAt 才被创建，而材质是不是走实例色
     * 是**编译期**决定的 —— 不重编一次，节点会全是默认白。
     * 判断「刚创建」用 instanceColor 是否为空，而不是自己记一个 ref：
     * 分块数变化时 args 会换掉整个 InstancedMesh，ref 记不住这件事。
     */
    const fresh = instance.instanceColor === null;
    colors.forEach((color, index) => instance.setColorAt(index, color));
    if (instance.instanceColor) instance.instanceColor.needsUpdate = true;
    if (fresh) {
      const material = instance.material;
      if (Array.isArray(material)) material.forEach((entry) => (entry.needsUpdate = true));
      else material.needsUpdate = true;
    }
  }, [colors, nodes]);

  return (
    <group>
      <instancedMesh
        ref={mesh}
        args={[undefined, undefined, Math.max(nodes, 1)]}
        onPointerMove={(event) => {
          event.stopPropagation();
          onHover(event.instanceId ?? null);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(event) => {
          event.stopPropagation();
          if (event.instanceId !== undefined) onPick(event.instanceId);
        }}>
        <sphereGeometry args={[1, 14, 10]} />
        <meshStandardMaterial roughness={0.42} metalness={0.08} />
      </instancedMesh>

      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[edgeGeometry.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[edgeGeometry.colors, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.85}
          blending={AdditiveBlending}
          depthWrite={false}
        />
      </lineSegments>

      {focusGeometry ? (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[focusGeometry, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            color="#5de4ff"
            transparent
            opacity={0.9}
            blending={AdditiveBlending}
            depthWrite={false}
          />
        </lineSegments>
      ) : null}
    </group>
  );
}

/**
 * 缓慢自转：只有「用户还没操作过」时才转。
 *
 * 转的是**图的 group**，不是相机也不是 scene —— 相机跟着 OrbitControls 走，
 * scene 里还有方向光，转 scene 会把光的方位一起转掉，明暗关系会飘。
 *
 * 「用户是否操作过」用 state 而不是 ref 记录：StrictMode 下挂载期 effect 会执行两次，
 * 用 ref 做「首次不执行」的守卫会被第二遍打穿（这条坑文档里记过）。
 */
function SpinningGroup({ active, children }: { active: boolean; children: ReactNode }) {
  const group = useRef<Group>(null);
  useFrame((_, delta) => {
    if (active && group.current) group.current.rotation.y += delta * 0.16;
  });
  return <group ref={group}>{children}</group>;
}

/**
 * 取景：把整张图套进画幅。
 *
 * 不能写死机位距离 —— 面板是 1121×252 这种极扁的比例，同一段距离在面板里和
 * 在放大的弹窗里画幅完全不同，所以按实际尺寸反解。
 *
 * 反解的是「最坏自转角度」：视图会绕 Y 轴自转，节点在屏幕上的投影半径随角度变化，
 * 按当前这一帧取景会在转到某个角度时切边。这里对一圈角度采样，
 * 逐点解出**带透视**的必需距离 `a + perp/tan(半视角)`（a 是朝相机的分量，
 * perp 是垂直视线方向的分量），取其中的最大值 —— 于是任何角度都不会出画。
 */
function fitDistance(graph: TokenGraph, dir: Vector3, tanHalf: number): number {
  const nodes = graph.stats.nodes;
  if (!nodes) return 3;
  const steps = 48;
  let need = 0;
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let i = 0; i < nodes; i += 1) {
      const x = graph.positions[i * 3];
      const y = graph.positions[i * 3 + 1];
      const z = graph.positions[i * 3 + 2];
      const px = x * cos + z * sin;
      const pz = -x * sin + z * cos;
      const towards = px * dir.x + y * dir.y + pz * dir.z;
      const perp = Math.sqrt(Math.max(px * px + y * y + pz * pz - towards * towards, 0));
      need = Math.max(need, towards + perp / tanHalf);
    }
  }
  return need || 3;
}

function GraphFitter({ graph, margin = 1.04 }: { graph: TokenGraph; margin?: number }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const controls = useThree((state) => state.controls) as
    | { target: Vector3; update: () => void }
    | null;

  useEffect(() => {
    if (!graph.stats.nodes) return;
    const perspective = camera as unknown as {
      fov: number;
      near: number;
      far: number;
      updateProjectionMatrix: () => void;
    };
    const vFov = MathUtils.degToRad(perspective.fov);
    const aspect = size.width / Math.max(size.height, 1);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const direction = new Vector3(0.62, 0.42, 0.74).normalize();
    const distance = fitDistance(graph, direction, Math.tan(Math.min(vFov, hFov) / 2)) * margin;

    camera.position.copy(direction).multiplyScalar(distance);
    perspective.near = Math.max(0.01, distance / 200);
    perspective.far = distance * 40;
    perspective.updateProjectionMatrix();
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
    // camera / controls 是稳定引用，不进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, margin, size.width, size.height]);

  return null;
}

/* ------------------------------------------------------------------ *
 * 对外组件
 * ------------------------------------------------------------------ */

export function TokenGraph3D({ graph, categories, focus, onHover, onPick }: Props) {
  const [userActed, setUserActed] = useState(false);

  return (
    <Canvas
      data-kb3d=""
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true }}
      camera={{ position: [2.15, 1.45, 2.55], fov: 42, near: 0.05, far: 40 }}
      onPointerMissed={() => onHover(null)}>
      <ambientLight intensity={1.15} />
      <directionalLight position={[3.4, 4.6, 3.2]} intensity={1.5} />
      <directionalLight position={[-3.2, -1.4, -2.6]} intensity={0.45} color="#5de4ff" />
      <SpinningGroup active={!userActed}>
        <GraphBody graph={graph} categories={categories} focus={focus} onHover={onHover} onPick={onPick} />
      </SpinningGroup>
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        enablePan={false}
        zoomSpeed={0.75}
        rotateSpeed={0.75}
        onStart={() => setUserActed(true)}
      />
      <GraphFitter graph={graph} />
    </Canvas>
  );
}

export default TokenGraph3D;
