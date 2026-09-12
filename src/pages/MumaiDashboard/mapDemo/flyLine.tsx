import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import {
  AdditiveBlending,
  QuadraticBezierCurve3,
  RepeatWrapping,
  Vector2,
  Vector3,
} from "three";

import flyLine from "@/assets/fly_line.png";

export interface FlyLineProps {
  data: {
    name: string;
    center: Vector3;
    points: Vector2[][];
  }[];
  /** 装饰缩放系数 = 地图投影半径 / Demo2 四川半径(6)，见 cone.tsx 的说明 */
  deco?: number;
}

export default function FlyLine(props: FlyLineProps) {
  const { data, deco = 1 } = props;
  const texture = useTexture(flyLine, (tex) => {
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.repeat.set(0.5, 2);
  });

  const curve = useMemo(() => {
    const centerPoint = data[0].center;

    return data.map((el) => {
      const point = el.center;
      const center = new Vector3()
        .addVectors(centerPoint, point)
        .multiplyScalar(0.5)
        .setZ(5 * deco);
      return new QuadraticBezierCurve3(centerPoint, center, point);
    });
  }, [data, deco]);

  useFrame((_, delta) => {
    texture.offset.x -= delta / 5;
  });

  return (
    <group renderOrder={10} position-z={1.1 * deco}>
      {curve.map((el, idx) => (
        <mesh key={idx}>
          <tubeGeometry args={[el, 32, 0.1 * deco, 2, false]} />
          <meshBasicMaterial
            transparent
            color={0x4ea8ff}
            fog={false}
            map={texture}
            opacity={0}
            depthTest={false}
            blending={AdditiveBlending}
          />
        </mesh>
      ))}
    </group>
  );
}
