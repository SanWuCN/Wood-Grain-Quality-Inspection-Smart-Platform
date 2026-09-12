/**
 * 中央光爆（数据汇聚核心）
 *
 * demo2 里最醒目的元素：地图中心有一团高强度白光，向外放射出一束束细光线，
 * 光线上还分布着亮点，周围散落白色小三角标记 —— 观感上像「全场数据都汇到这里」。
 *
 * 实现要点：
 *   - 放射光线：环形几何按角度分段，逐段生成一个「细长渐变三角」，
 *     用加性混合叠在顶面之上，中心最亮、外端透明
 *   - 光点：沿线随机分布的小圆点，做呼吸
 *   - 三角标记：InstancedMesh 的四面锥，纯白加性，散布在核心周围
 *   - 核心光团：一张径向渐变贴图 + 轻微脉动
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
} from "three";
import { mapUniforms } from "./materials";

/** 径向渐变贴图：中心纯白、边缘透明 */
let coreTexture: CanvasTexture | null = null;
function getCoreTexture() {
  if (coreTexture) return coreTexture;
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.08, "rgba(235,250,255,0.92)");
  g.addColorStop(0.22, "rgba(150,220,255,0.42)");
  g.addColorStop(0.5, "rgba(90,170,240,0.12)");
  g.addColorStop(1, "rgba(40,110,200,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  coreTexture = new CanvasTexture(canvas);
  coreTexture.needsUpdate = true;
  return coreTexture;
}

/** 中心亮、两端透明的细光线材质 */
function createRayMaterial(color: Color) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: color },
      uOpacity: mapUniforms.uOpacity,
      uTime: mapUniforms.uTime,
      uIntensity: { value: 1 },
    },
    vertexShader: `
      attribute float aProgress;
      varying float vProgress;
      void main() {
        vProgress = aProgress;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vProgress;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uIntensity;
      void main() {
        // 越靠外越透明，靠近中心最亮
        float fade = pow(1.0 - vProgress, 1.6);
        // 沿长度流动的亮块
        float flow = 0.6 + 0.4 * sin((vProgress * 4.0 - uTime * 1.1) * 3.14159);
        float a = fade * flow * uIntensity * uOpacity;
        if (a < 0.006) discard;
        gl_FragColor = vec4(uColor * (1.4 + flow), a);
      }
    `,
  });
}

export interface LightBurstProps {
  /** 光爆中心（地图分组的世界坐标平面位置） */
  center: [number, number];
  /** 光线向外延伸的长度 */
  radius: number;
  /** 顶面高度 */
  height: number;
  /** 射线数量 */
  rays?: number;
  /** 三角标记数量 */
  markers?: number;
  /** 强度（0..1），配合开场动画 */
  revealRef?: { value: number };
}

export default function LightBurst({
  center,
  radius,
  height,
  rays = 118,
  markers = 26,
  revealRef,
}: LightBurstProps) {
  const group = useRef<Group>(null!);
  const coreRef = useRef<Mesh>(null!);
  const markerRef = useRef<Mesh>(null!);

  const core = useMemo(() => getCoreTexture(), []);
  const rayMaterial = useMemo(() => createRayMaterial(new Color("#dff4ff")), []);

  /** 放射光线几何：每条光线一个细长三角，顶点带 aProgress 标记内外端 */
  const rayGeometry = useMemo(() => {
    const positions: number[] = [];
    const progress: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < rays; i++) {
      // 角度均匀分布 + 轻微抖动，避免过于机械
      const angle = (i / rays) * Math.PI * 2 + (Math.random() - 0.5) * 0.05;
      // 长度差异很大，形成「长短不一的放射束」
      const length = radius * (0.28 + Math.pow(Math.random(), 1.7) * 0.85);
      const halfWidth = 0.012 + Math.random() * 0.035;

      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const nx = -dy;
      const ny = dx;

      const base = positions.length / 3;
      // 内端（贴着中心）三个点，做成窄三角
      positions.push(dx * 0.06, dy * 0.06, 0);
      progress.push(0.08);
      positions.push(dx * 0.06 + nx * halfWidth, dy * 0.06 + ny * halfWidth, 0);
      progress.push(0.02);
      positions.push(dx * 0.06 - nx * halfWidth, dy * 0.06 - ny * halfWidth, 0);
      progress.push(0.02);
      // 外端收成一点
      positions.push(dx * length, dy * length, 0);
      progress.push(1);
      indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("aProgress", new BufferAttribute(new Float32Array(progress), 1));
    geometry.setIndex(indices);
    return geometry;
  }, [rays, radius]);

  /** 沿线分布的亮点 */
  const sparkGeometry = useMemo(() => {
    const positions: number[] = [];
    for (let i = 0; i < 150; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = radius * (0.12 + Math.pow(Math.random(), 1.5) * 0.95);
      positions.push(Math.cos(angle) * r, Math.sin(angle) * r, 0);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    return geometry;
  }, [radius]);

  /** 白色小三角标记：散布在核心周围 */
  const markerPositions = useMemo(() => {
    const list: [number, number, number][] = [];
    for (let i = 0; i < markers; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = radius * (0.2 + Math.random() * 0.85);
      list.push([Math.cos(angle) * r, Math.sin(angle) * r, 0]);
    }
    return list;
  }, [markers, radius]);

  useEffect(
    () => () => {
      rayGeometry.dispose();
      sparkGeometry.dispose();
      rayMaterial.dispose();
    },
    [rayGeometry, sparkGeometry, rayMaterial],
  );

  useFrame(({ clock }) => {
    const reveal = revealRef ? revealRef.value : 1;
    if (group.current) group.current.visible = reveal > 0.35;
    if (!group.current) return;

    // 出场：光爆从中心迅速张开
    const t = Math.min(1, Math.max(0, (reveal - 0.35) / 0.5));
    rayMaterial.uniforms.uIntensity.value = t;
    const pulse = 1 + Math.sin(clock.elapsedTime * 1.7) * 0.05;
    if (coreRef.current) {
      coreRef.current.scale.setScalar(t * pulse);
      const material = coreRef.current.material as { opacity: number };
      material.opacity = t * (0.85 + Math.sin(clock.elapsedTime * 2.3) * 0.12);
    }
    if (markerRef.current) {
      markerRef.current.rotation.y += 0.004;
    }
  });

  return (
    <group ref={group} position={[center[0], center[1], height + 0.03]}>
      {/* 核心光团 */}
      <mesh ref={coreRef}>
        <planeGeometry args={[radius * 0.9, radius * 0.9]} />
        <meshBasicMaterial
          map={core}
          transparent
          depthWrite={false}
          depthTest={false}
          blending={AdditiveBlending}
        />
      </mesh>

      {/* 放射光线 */}
      <mesh geometry={rayGeometry} renderOrder={20}>
        <primitive object={rayMaterial} attach="material" />
      </mesh>

      {/* 沿线亮点 */}
      <points geometry={sparkGeometry} renderOrder={21}>
        <pointsMaterial
          size={0.075}
          color="#ffffff"
          sizeAttenuation
          transparent
          depthWrite={false}
          depthTest={false}
          blending={AdditiveBlending}
        />
      </points>

      {/* 白色三角标记 */}
      <group ref={markerRef} position={[0, 0, 0.02]}>
        {markerPositions.map((p, index) => (
          <mesh key={index} position={p} rotation={[0, Math.PI / 4, 0]}>
            <coneGeometry args={[0.055, 0.16, 4]} />
            <meshBasicMaterial
              color="#ffffff"
              transparent
              opacity={0.9}
              depthWrite={false}
              depthTest={false}
              blending={AdditiveBlending}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}
