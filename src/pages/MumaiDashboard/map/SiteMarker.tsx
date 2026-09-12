/**
 * 业务点位标记（古建采集点 / 风险点 / 工单点 / 当前任务）
 *
 * 参考 demo2 的 cone.tsx：地面菱形光锥 + 旋转光圈 + 光柱。
 * 这里按业务状态分色，并加上「当前任务」的醒目脉冲环。
 *
 * 所有标记共用一个 InstancedMesh 之外的普通 mesh（数量在几十个量级，
 * 分组渲染更简单，也方便单独控制某个点的选中态）。
 */

import { useMemo, useRef } from "react";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
} from "three";
import { mapUniforms } from "./materials";
import { STATUS_COLOR } from "./status";
import type { SiteStatus } from "../data";

/** 一圈柔和的实心光斑，用来做地面光圈 */
let haloTexture: CanvasTexture | null = null;
function getHaloTexture() {
  if (haloTexture) return haloTexture;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.25, "rgba(255,255,255,0.5)");
  g.addColorStop(0.55, "rgba(255,255,255,0.14)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  haloTexture = new CanvasTexture(canvas);
  haloTexture.needsUpdate = true;
  return haloTexture;
}

/** 光柱：底部亮、顶部透明，外加一层沿高度流动的亮块 */
function createBeamMaterial(color: Color) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: color },
      uOpacity: mapUniforms.uOpacity,
      uTime: mapUniforms.uTime,
      uIntensity: { value: 1 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uIntensity;
      void main() {
        // 水平方向中间亮两侧虚
        float across = pow(1.0 - abs(vUv.x - 0.5) * 2.0, 1.8);
        // 垂直方向：底部实、顶部淡出
        float along = pow(1.0 - vUv.y, 2.2);
        // 向上流动的亮块
        float flow = 0.75 + 0.25 * sin((vUv.y * 6.0 - uTime * 1.6) * 3.14159);
        float a = across * along * flow * uIntensity * uOpacity;
        gl_FragColor = vec4(uColor * (0.9 + flow * 0.6), a);
        if (a < 0.004) discard;
      }
    `,
  });
}

export interface SiteMarkerProps {
  name: string;
  caption?: string;
  position: [number, number, number];
  status: SiteStatus;
  selected?: boolean;
  current?: boolean;
  /** 缩放，上海模式下点位要更大一点 */
  scale?: number;
  onSelect?: () => void;
}

export function SiteMarker(props: SiteMarkerProps) {
  const { position, status, selected = false, current = false, scale = 1 } = props;
  const color = useMemo(() => new Color(STATUS_COLOR[status]), [status]);
  const pulse = useRef<Group>(null!);
  const outer = useRef<Mesh>(null!);
  const core = useRef<Group>(null!);
  const halo = useMemo(() => getHaloTexture(), []);
  const beamMaterial = useMemo(() => createBeamMaterial(color), [color]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (pulse.current) {
      const s = 1 + ((t * 0.9 + position[0]) % 1) * 0.9;
      pulse.current.scale.setScalar(s);
      const material = (pulse.current.children[0] as Mesh)?.material as
        | { opacity: number }
        | undefined;
      if (material) material.opacity = Math.max(0, 0.55 * (1 - ((t * 0.9 + position[0]) % 1)));
    }
    if (outer.current) outer.current.rotation.z += 0.012;
    if (core.current) {
      core.current.rotation.z -= 0.02;
      core.current.position.z = 0.16 + Math.sin(t * 1.6 + position[1]) * 0.03;
    }
    beamMaterial.uniforms.uIntensity.value = current
      ? 1.5 + Math.sin(t * 3) * 0.35
      : selected
        ? 1.25
        : 0.85;
  });

  return (
    <group position={position} scale={scale}>
      {/* 地面扩散脉冲环 */}
      <group ref={pulse} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh>
          <ringGeometry args={[0.3, 0.34, 48]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.5}
            depthWrite={false}
            blending={AdditiveBlending}
            side={DoubleSide}
          />
        </mesh>
      </group>

      {/* 地面光斑 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0.012]}>
        <planeGeometry args={[1.1, 1.1]} />
        <meshBasicMaterial
          map={halo}
          color={color}
          transparent
          opacity={current ? 0.95 : 0.7}
          depthWrite={false}
          depthTest={false}
          blending={AdditiveBlending}
        />
      </mesh>

      {/* 双层旋转光圈 */}
      <mesh ref={outer} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0.02]}>
        <ringGeometry args={[0.2, 0.235, 6, 1, 0, Math.PI * 1.6]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.85}
          depthWrite={false}
          depthTest={false}
          blending={AdditiveBlending}
          side={DoubleSide}
        />
      </mesh>

      {/* 中心菱形（四棱锥）+ 内核光点 */}
      <group ref={core} position={[0, 0, 0.16]}>
        <mesh rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[0.1, 0.26, 4]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.95}
            depthWrite={false}
            blending={AdditiveBlending}
            side={DoubleSide}
          />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.045, 12, 12]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.95} depthWrite={false} />
        </mesh>
      </group>

      {/* 光柱 */}
      <mesh position={[0, 0, 0.62]}>
        <cylinderGeometry args={[0.05, 0.11, 1.15, 12, 1, true]} />
        <primitive object={beamMaterial} attach="material" />
      </mesh>

      {props.name ? (
        <Html
          center
          position={[0, 0, 0.95]}
          zIndexRange={[60, 0]}
          style={{ pointerEvents: "none" }}>
          <div className={`site-label site-label--${status} ${selected ? "is-selected" : ""}`}>
            <strong>{props.name}</strong>
            {props.caption ? <small>{props.caption}</small> : null}
          </div>
        </Html>
      ) : null}

      {props.onSelect ? (
        <mesh
          position={[0, 0, 0.1]}
          visible={false}
          onClick={(event) => {
            event.stopPropagation();
            props.onSelect?.();
          }}>
          <sphereGeometry args={[0.42, 8, 8]} />
        </mesh>
      ) : null}
    </group>
  );
}

export default SiteMarker;
