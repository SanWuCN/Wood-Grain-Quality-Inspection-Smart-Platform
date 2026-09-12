/**
 * 环境光柱：地图外围缓缓上升的流光柱
 *
 * 对应 demo2 的 beamLight.tsx。区别是：
 *   - 只在「地图包围盒之外」的环形区域生成，避免光柱糊在省份上面
 *   - 高度更高、更细，接近 demo2 那种「数据流上升」的观感
 */

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, Color, DoubleSide, Group, ShaderMaterial } from "three";
import { mapUniforms } from "./materials";

export interface BeamLightsProps {
  /** 生成区域半径（世界单位） */
  radius: number;
  /** 内圈留空半径，避免挡住地图 */
  innerRadius?: number;
  count?: number;
  color?: string;
  /** 上限高度 */
  top?: number;
  /** 出场动画进度（0..1） */
  revealRef?: { value: number };
}

interface Beam {
  x: number;
  z: number;
  speed: number;
  reset: number;
  scaleY: number;
}

function createBeamMaterial(color: string) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: new Color(color) },
      uOpacity: mapUniforms.uOpacity,
      uTime: mapUniforms.uTime,
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
      void main() {
        float across = pow(1.0 - abs(vUv.x - 0.5) * 2.0, 1.6);
        float vertical = sin(vUv.y * 3.14159);
        vertical = pow(max(vertical, 0.0), 0.6);
        float a = across * vertical * uOpacity;
        gl_FragColor = vec4(uColor * (1.1 + vertical * 0.9), a);
        if (a < 0.003) discard;
      }
    `,
  });
}

export default function BeamLights({
  radius,
  innerRadius = 0,
  count = 22,
  color = "#8fd0ff",
  top = 12,
  revealRef,
}: BeamLightsProps) {
  const group = useRef<Group>(null!);
  const started = useRef(false);

  const material = useMemo(() => createBeamMaterial(color), [color]);

  const beams = useMemo<Beam[]>(() => {
    const list: Beam[] = [];
    for (let i = 0; i < count; i++) {
      // 环带内均匀撒点，加一点抖动避免太规则
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const r = innerRadius + Math.random() * Math.max(0.001, radius - innerRadius);
      list.push({
        x: Math.cos(angle) * r,
        z: Math.sin(angle) * r,
        speed: 0.9 + Math.random() * 1.5,
        reset: top * (0.7 + Math.random() * 0.6),
        scaleY: 1.6 + Math.random() * 2.6,
      });
    }
    return list;
  }, [count, radius, innerRadius, top]);

  useFrame((_, delta) => {
    if (!group.current) return;
    const reveal = revealRef ? revealRef.value : 1;
    const active = reveal > 0.12;
    group.current.visible = active;
    if (!active) return;

    // 出场：整体从下往上抬起来
    if (!started.current) {
      group.current.position.y = -top;
      started.current = true;
    }
    group.current.position.y += (0 - group.current.position.y) * Math.min(1, delta * 1.6);

    const limit = Math.min(delta, 0.05);
    group.current.children.forEach((child, index) => {
      const beam = beams[index];
      if (!beam) return;
      child.position.y += beam.speed * limit;
      if (child.position.y > beam.reset) {
        const angle = Math.random() * Math.PI * 2;
        const r = innerRadius + Math.random() * Math.max(0.001, radius - innerRadius);
        child.position.x = Math.cos(angle) * r;
        child.position.z = Math.sin(angle) * r;
        child.position.y = -2 - Math.random() * 3;
        beam.scaleY = 1.6 + Math.random() * 2.6;
        child.scale.y = beam.scaleY;
      }
    });
    material.uniforms.uTime.value = mapUniforms.uTime.value;
  });

  return (
    <group ref={group} visible={false}>
      {beams.map((beam, index) => (
        <mesh
          key={index}
          position={[beam.x, -2 - Math.random() * 4, beam.z]}
          scale={[1, beam.scaleY, 1]}>
          <cylinderGeometry args={[0.018, 0.018, 1, 6, 1, true]} />
          <primitive object={material} attach="material" />
        </mesh>
      ))}
    </group>
  );
}
