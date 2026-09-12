/**
 * 巡检飞线：数据汇聚到主线点位
 *
 * 对应 demo2 的 flyLine.tsx —— 用 QuadraticBezierCurve3 + TubeGeometry，
 * 贴一张可循环的流光贴图，通过 offset 平移产生「能量流动」的效果。
 *
 * 这里做了三点增强，用于比赛演示：
 *   1. 每条线单独缓入（delay 递增），配合开场动画「飞线依次生成」
 *   2. 线上跑一颗亮点，直观表示数据回流
 *   3. 主线（汇聚点）加粗、更亮
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  QuadraticBezierCurve3,
  RepeatWrapping,
  Vector3,
} from "three";
import { mapUniforms } from "./materials";

/** 流光贴图：一段渐隐的亮带，沿管道方向循环 */
let flowTexture: CanvasTexture | null = null;
function getFlowTexture() {
  if (flowTexture) return flowTexture;
  const width = 256;
  const height = 16;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, width, 0);
  g.addColorStop(0, "rgba(120,210,255,0)");
  g.addColorStop(0.42, "rgba(150,225,255,0.35)");
  g.addColorStop(0.5, "rgba(230,250,255,1)");
  g.addColorStop(0.58, "rgba(150,225,255,0.35)");
  g.addColorStop(1, "rgba(120,210,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(1.6, 1);
  texture.needsUpdate = true;
  flowTexture = texture;
  return texture;
}

export interface FlyLineDatum {
  id: string;
  from: [number, number];
  to: [number, number];
  /** 是否为主线（数据汇聚） */
  primary?: boolean;
}

export interface FlyLinesProps {
  lines: FlyLineDatum[];
  depth: number;
  /** 弧顶高度 */
  arcHeight?: number;
  color?: string;
  /** 出场动画进度（0..1），由外部时间线驱动 */
  revealRef?: { value: number };
}

interface LineState {
  mesh: Mesh;
  orb: Mesh;
}

export default function FlyLines({
  lines,
  depth,
  arcHeight = 1.5,
  color = "#7fd6ff",
  revealRef,
}: FlyLinesProps) {
  const texture = useMemo(() => getFlowTexture(), []);
  const stateRef = useRef<LineState[]>([]);
  const groupRef = useRef<Group>(null!);

  const curves = useMemo(
    () =>
      lines.map((line) => {
        const a = new Vector3(line.from[0], line.from[1], depth + 0.02);
        const b = new Vector3(line.to[0], line.to[1], depth + 0.02);
        const mid = a.clone().lerp(b, 0.5);
        const distance = a.distanceTo(b);
        mid.z += Math.min(arcHeight, 0.42 + distance * 0.24);
        return new QuadraticBezierCurve3(a, mid, b);
      }),
    [lines, depth, arcHeight],
  );

  useEffect(() => {
    // lines 变化（例如中国→上海）时，之前按索引缓存的 mesh 会失效，
    // 必须清空重建，否则会拿到 undefined 的曲线并在 useFrame 里抛异常——
    // useFrame 里抛异常会让整个渲染循环停摆，表现就是「地图突然不见了」。
    stateRef.current = [];
  }, [lines]);

  useEffect(() => {
    if (!texture) return;
    texture.offset.x = 0;
  }, [texture]);

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    if (texture) texture.offset.x -= delta / 5.5;

    const reveal = revealRef ? revealRef.value : 1;
    const count = Math.min(curves.length, lines.length, stateRef.current.length);
    for (let index = 0; index < count; index++) {
      const state = stateRef.current[index];
      const curve = curves[index];
      if (!state || !curve) continue;
      // 每条线按顺序出现
      const start = (index / Math.max(1, lines.length)) * 0.55;
      const local = Math.min(1, Math.max(0, (reveal - start) / 0.45));
      state.mesh.visible = local > 0.001;
      const material = state.mesh.material as { opacity: number };
      material.opacity = local * (lines[index]?.primary ? 0.95 : 0.6) * mapUniforms.uOpacity.value;
      if (state.orb) {
        state.orb.visible = local > 0.4;
        const speed = lines[index]?.primary ? 0.16 : 0.1;
        const progress = (t * speed + index * 0.21) % 1;
        state.orb.position.copy(curve.getPointAt(progress));
        const orbMaterial = state.orb.material as { opacity: number };
        orbMaterial.opacity = local * 0.9 * Math.sin(progress * Math.PI) * mapUniforms.uOpacity.value;
      }
    }
  });

  return (
    <group ref={groupRef} renderOrder={12}>
      {curves.map((curve, index) => {
        const primary = lines[index]?.primary ?? false;
        return (
          <group key={lines[index]?.id ?? index}>
            <mesh
              ref={(mesh) => {
                if (!mesh) return;
                stateRef.current[index] = { ...(stateRef.current[index] ?? {}), mesh } as LineState;
              }}>
              <tubeGeometry args={[curve, primary ? 48 : 32, primary ? 0.022 : 0.014, primary ? 8 : 6, false]} />
              <meshBasicMaterial
                map={texture}
                color={new Color(color)}
                transparent
                opacity={0}
                depthWrite={false}
                depthTest={false}
                blending={AdditiveBlending}
              />
            </mesh>
            <mesh
              ref={(mesh) => {
                if (!mesh) return;
                stateRef.current[index] = { ...(stateRef.current[index] ?? {}), orb: mesh } as LineState;
              }}>
              <sphereGeometry args={[primary ? 0.075 : 0.05, 10, 10]} />
              <meshBasicMaterial
                color="#e8fbff"
                transparent
                opacity={0}
                depthWrite={false}
                depthTest={false}
                blending={AdditiveBlending}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
