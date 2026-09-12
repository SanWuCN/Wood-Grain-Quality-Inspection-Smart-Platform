import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, CanvasTexture, SRGBColorSpace, type Mesh } from "three";

import quan1 from "@/assets/quan1.png";
import { useImage } from "./useImage";

export default function Bottom() {
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
        <planeGeometry args={[16, 16]} />
        <meshBasicMaterial
          transparent
          map={texture ?? undefined}
          color="#4ea8ff"
          opacity={texture ? 1 : 0}
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </mesh>
    </group>
  );
}
