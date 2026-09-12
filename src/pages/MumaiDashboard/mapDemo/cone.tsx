import { useRef } from "react";
import { useFrame, type ThreeElements } from "@react-three/fiber";
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Vector2,
  Vector3,
  type Mesh,
} from "three";
import { Instance, Instances, useTexture } from "@react-three/drei";

import guangquan01 from "@/assets/guangquan01.png";

export interface ConesProps {
  color?: Color;
  data: {
    name: string;
    center: Vector3;
    points: Vector2[][];
  }[];
  /**
   * 装饰缩放系数 = 当前地图投影半径 / Demo2 四川半径(6)。
   * 上游这些尺寸（光锥 0.3 / 光圈 0.8 / 高度偏移 1）都是按四川定的绝对值，
   * 不加换算的话中国会小到看不见、上海会大到糊住整幅地图。
   */
  deco?: number;
}

export default function Cones(props: ConesProps) {
  // 规范 §5.2：地图上的数据汇聚色用 PRIMARY #4EA8FF，不用青色光效色
  const { color = new Color(0x4ea8ff), deco = 1 } = props;
  const texture1 = useTexture(guangquan01);

  return (
    <group position-z={1 * deco} renderOrder={5}>
      <Instances
        limit={props.data.length}
        position-z={0.3 * deco}
        raycast={() => null}>
        <coneGeometry args={[0.3 * deco, 0.5 * deco, 4]} />
        {/*
          这里刻意**不用** AdditiveBlending：地图底色提亮之后，加色混合会把光锥
          直接叠成纯白，一片白菱形糊在东半部，比地图本身还抢眼
          （违反规范 §0「所有元素都不能同时抢注意力」）。
          改成普通混合，光锥就是一枚干净的主色小标记。
        */}
        <meshBasicMaterial color={color} side={DoubleSide} />
        {props.data.map((data, i) => (
          <Cone key={i} position={data.center} deco={deco} />
        ))}
      </Instances>
      <Instances limit={props.data.length} raycast={() => null}>
        <planeGeometry args={[0.58 * deco, 0.58 * deco]} />
        <meshBasicMaterial
          transparent
          color={color}
          alphaMap={texture1}
          // 34 个省份同时点亮光圈会盖过地图本身，压到半透明只作为弱提示
          opacity={0.5}
          depthTest={false}
          fog={false}
          blending={AdditiveBlending}
        />
        {props.data.map((data, i) => (
          <Quan key={i} position={data.center} />
        ))}
      </Instances>
    </group>
  );
}

export interface ConeProps {
  position?: ThreeElements["group"]["position"];
  deco?: number;
}

function Cone(props: ConeProps) {
  const { position, deco = 1 } = props;
  const ref = useRef<Mesh>(null!);
  let dirRef = useRef<1 | -1>(1);

  useFrame((_, delta) => {
    if (ref.current.position.z >= deco) {
      dirRef.current = -1;
      ref.current.position.z = deco;
    }
    if (ref.current.position.z <= 0) {
      dirRef.current = 1;
      ref.current.position.z = 0;
    }
    ref.current.rotation.y += delta;
    ref.current.position.z += (dirRef.current * delta * deco) / 2;
  });

  return <Instance ref={ref} rotation-x={-Math.PI / 2} position={position} />;
}

function Quan(props: ConeProps) {
  const { position } = props;
  const ref = useRef<Mesh>(null!);
  useFrame((_, delta) => {
    ref.current.rotation.z += delta + 0.02;
  });
  return <Instance ref={ref} position={position} />;
}
