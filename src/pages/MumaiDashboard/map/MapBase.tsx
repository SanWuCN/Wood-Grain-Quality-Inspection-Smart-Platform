/**
 * 底部环境层：镜面地面 + 旋转光环 + 冷色辉光
 *
 * 对应 demo2 里 map/index.tsx 的 <Bottom /> 与 <Mirror />：
 *   - Mirror 用 drei 的 MeshReflectorMaterial 做湿润镜面
 *   - Bottom 用一张环形贴图 + AdditiveBlending 缓慢旋转，形成「大屏底座」
 * 这里额外做了多层同心环与径向辉光，让地图底部有更强的聚焦感。
 *
 * 环形/辉光贴图在运行时用 canvas 生成，不额外占用仓库资源。
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { MeshReflectorMaterial } from "@react-three/drei";
import { AdditiveBlending, CanvasTexture, DoubleSide, Mesh, type Group } from "three";
import { mapUniforms } from "./materials";

/** 生成一圈带虚线的环形贴图（外圈细、内圈亮） */
function createRingTexture(size = 1024) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;

  const ring = (
    radius: number,
    width: number,
    color: string,
    dash: [number, number] | null,
  ) => {
    ctx.save();
    ctx.translate(c, c);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  ctx.clearRect(0, 0, size, size);
  ring(size * 0.46, 1.5, "rgba(126,208,255,0.35)", null);
  ring(size * 0.4, 1.2, "rgba(126,208,255,0.28)", [size * 0.045, size * 0.075]);
  ring(size * 0.34, 10, "rgba(60,150,235,0.1)", null);
  ring(size * 0.3, 1.6, "rgba(150,225,255,0.4)", null);
  ring(size * 0.22, 1.1, "rgba(126,208,255,0.22)", [size * 0.02, size * 0.05]);
  ring(size * 0.16, 14, "rgba(70,165,240,0.1)", null);

  // 一条扫掠弧，旋转时像雷达
  const grad = ctx.createLinearGradient(c, 0, c, size);
  grad.addColorStop(0, "rgba(140,220,255,0.55)");
  grad.addColorStop(1, "rgba(140,220,255,0)");
  ctx.save();
  ctx.translate(c, c);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.3, -Math.PI * 0.42, -Math.PI * 0.08);
  ctx.stroke();
  ctx.restore();

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** 径向辉光贴图，用于地图下方的一团冷色光 */
function createGlowTexture(size = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(120,205,255,0.5)");
  g.addColorStop(0.35, "rgba(52,130,220,0.22)");
  g.addColorStop(0.7, "rgba(20,60,140,0.06)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export interface MapBaseProps {
  /** 地图宽度（世界单位），底部光环按它取尺寸 */
  width: number;
  /** 是否显示镜面 */
  mirror?: boolean;
}

export default function MapBase({ width, mirror = true }: MapBaseProps) {
  const spinSlow = useRef<Group>(null!);
  const spinFast = useRef<Mesh>(null!);

  const ringTexture = useMemo(() => createRingTexture(), []);
  const glowTexture = useMemo(() => createGlowTexture(), []);

  useEffect(
    () => () => {
      ringTexture.dispose();
      glowTexture.dispose();
    },
    [ringTexture, glowTexture],
  );

  useFrame((_, delta) => {
    if (spinSlow.current) spinSlow.current.rotation.z += delta * 0.02;
    if (spinFast.current) spinFast.current.rotation.z -= delta * 0.06;
    if (spinFast.current) {
      const material = spinFast.current.material as { opacity: number };
      material.opacity = 0.5 + 0.16 * Math.sin(performance.now() / 2600);
    }
  });

  const radius = width * 0.95;

  return (
    <group>
      {/* 镜面地面 */}
      {mirror ? (
        <mesh rotation-x={-Math.PI / 2} position-y={-0.32}>
          <planeGeometry args={[width * 6, width * 6]} />
          <MeshReflectorMaterial
            blur={[420, 120]}
            resolution={1024}
            mixBlur={9}
            mixStrength={7}
            depthScale={1}
            minDepthThreshold={0.85}
            color="#04101f"
            metalness={0.72}
            roughness={0.92}
          />
        </mesh>
      ) : null}

      <group rotation={[-Math.PI / 2, 0, 0]} position-y={-0.3}>
        {/* 地图下方的径向辉光 */}
        <mesh position-z={0.02}>
          <planeGeometry args={[radius * 2.4, radius * 2.4]} />
          <meshBasicMaterial
            map={glowTexture}
            transparent
            depthWrite={false}
            blending={AdditiveBlending}
            opacity={0.9}
          />
        </mesh>

        {/* 环：缓慢自转 */}
        <group ref={spinSlow}>
          <mesh>
            <planeGeometry args={[radius * 2.2, radius * 2.2]} />
            <meshBasicMaterial
              map={ringTexture}
              color="#7fd0ff"
              transparent
              opacity={0.72}
              depthWrite={false}
              blending={AdditiveBlending}
              side={DoubleSide}
            />
          </mesh>
        </group>

        {/* 环：反向自转 + 呼吸 */}
        <mesh ref={spinFast}>
          <planeGeometry args={[radius * 1.55, radius * 1.55]} />
          <meshBasicMaterial
            map={ringTexture}
            color="#a8e4ff"
            transparent
            opacity={0.6}
            depthWrite={false}
            blending={AdditiveBlending}
            side={DoubleSide}
          />
        </mesh>

        {/* 最外圈的一条极淡虚线，扩大视觉半径 */}
        <mesh position-z={-0.01}>
          <ringGeometry args={[radius * 1.28, radius * 1.283, 160]} />
          <meshBasicMaterial
            color="#2f7fc4"
            transparent
            opacity={0.34 * mapUniforms.uOpacity.value + 0.16}
            depthWrite={false}
            blending={AdditiveBlending}
            side={DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}
