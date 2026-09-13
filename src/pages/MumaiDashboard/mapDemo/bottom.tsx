import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, CanvasTexture, SRGBColorSpace, type Mesh } from "three";

import quan1 from "@/assets/quan1.png";
import { useImage } from "./useImage";

/**
 * @param size 圆盘边长（世界单位）。
 *
 * 不再是写死的 16 —— 那个值是为 Demo2 的四川（世界尺寸约 8.5）定的。
 * 现在的取值见 index.tsx：地图最大边 × 1.25。
 */
export default function Bottom({ size = 16 }: { size?: number }) {
  const meshRef1 = useRef<Mesh>(null!);
  const image = useImage(quan1);

  const texture = useMemo(() => {
    if (!image) return null;
    const tex = new CanvasTexture(image);
    tex.colorSpace = SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }, [image]);

  useEffect(
    () => () => {
      texture?.dispose();
    },
    [texture],
  );

  useFrame((_state, delta) => {
    meshRef1.current.rotation.z += delta / 5;
  });

  return (
    <group rotation={[-Math.PI / 2, 0, 0]} position-y={-0.01}>
      <mesh ref={meshRef1}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial
          transparent
          map={texture ?? undefined}
          color="#4ea8ff"
          fog={false}
          opacity={texture ? 1 : 0}
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </mesh>
    </group>
  );
}
