import { useRef, type Ref } from "react";
import { useFrame, extend, type ThreeElements } from "@react-three/fiber";
import { shaderMaterial } from "@react-three/drei";
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Points,
  Vector3,
  type ColorRepresentation,
} from "three";

const SparklesImplMaterial = extend(
  shaderMaterial(
    { uColor: new Color(), uOpacity: 1 },
    `
        varying vec2 vUv;
        varying vec3 vPosition;
        
        void main() {
            vUv = uv;
            vPosition = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    `
        uniform vec3 uColor;
        uniform float uOpacity;
        
        varying vec2 vUv;

        void main() {
            // 1. 水平发光核心 (中间亮，两侧虚)
            float strength = 1.0 - abs(vUv.x - 0.5) * 2.0;
            strength = pow(strength, 2.0);

            // 2. 垂直渐变 (关键修改：两端透明，模拟一段独立的光)
            // 使用抛物线或正弦波让中间最亮，两头淡出
            float verticalFade = sin(vUv.y * 3.14159); 
            // 让两端更锐利一点
            verticalFade = pow(verticalFade, 0.5);

            float brightness = strength * verticalFade * (0.6 + 0.4);

            // 4. 最终颜色
            vec3 finalColor = uColor * brightness * 2.0; // 增强一点亮度
            
            gl_FragColor = vec4(finalColor, brightness * uOpacity);
        }
    `
  )
);

export type SparklesProps = Omit<
  ThreeElements["points"],
  "ref" | "children"
> & {
  ref?: Ref<Points>;
  /** Number of particles (default: 100) */
  count?: number;
  /** Speed of particles (default: 1) */
  speed?: number | Float32Array;
  /** Opacity of particles (default: 1) */
  opacity?: number | Float32Array;
  /** Color of particles (default: 100) */
  color?: ColorRepresentation | Float32Array;
  /** Size of particles (default: randomized between 0 and 1) */
  size?: number | Float32Array;
  /** The space the particles occupy (default: 1) */
  scale?: number | [number, number, number] | Vector3;
};

/**
 * @param range    光柱散布的方形区域边长（世界单位）
 * @param topScale 上升高度与速度的倍率
 *
 * Demo2 写死 `range = 20`，那是为世界尺寸约 8.5 的四川定的 —— 20 单位能盖满
 * 整幅地图。我们的中国地图世界里约 82 单位，同样 20 单位就缩成原点附近一小撮，
 * 等于看不见。取值见 index.tsx：地图最大边 × 1.15。
 */
const BeamLight = ({
  range = 20,
  topScale = 1,
}: {
  range?: number;
  topScale?: number;
}) => {
  const ref = useRef<Group>(null!);

  useFrame((_, delta) => {
    ref.current.children.forEach((beam) => {
      // 向上移动
      beam.position.y += beam.userData.speed * delta;

      // 边界检查：如果飞得太高，就重置到底部
      if (beam.position.y > beam.userData.resetHeight) {
        // 随机水平位置：落在环带上，与初始分布一致（否则回落之后全挤到地图中心）
        const angle = Math.random() * Math.PI * 2;
        const radius = range * 0.62 + Math.random() * range * 0.3;
        beam.position.x = Math.cos(angle) * radius;
        beam.position.z = Math.sin(angle) * radius;

        // 从地底开始生成，避免直接突然出现在视野中
        beam.position.y = (1 - Math.random() * 5) * topScale;

        // 随机长度 (流光段的长度)
        beam.scale.y = (2.0 + Math.random() * 1.0) * topScale;
      }
    });
  });

  //   useImperativeHandle(forwardRef, () => ref.current, []);

  //   console.log(ref);

  return (
    <group ref={ref}>
      {Array.from({ length: 26 }, (_, k) => (
        <mesh
          key={k}
          /*
           * 环形分布（用户要求「光柱不应该在地图周边吗」）。
           *
           * 原来是方形散布、中心就在地图正中，一半光柱被地图本体挡住。
           * 现在按角度均分撒在环带上，内径 range*0.62 —— range 本身已是地图
           * 最大边的 1.15 倍，所以这个内径落在地图外缘之外，整圈围在地图周围。
           */
          position={[
            Math.cos((k / 26) * Math.PI * 2 + Math.random() * 0.24) *
              (range * 0.62 + Math.random() * range * 0.3),
            5 - Math.random() * 5,
            Math.sin((k / 26) * Math.PI * 2 + Math.random() * 0.24) *
              (range * 0.62 + Math.random() * range * 0.3),
          ]}
          scale={[1, 2.0 + Math.random() * 4.0, 1]}
          userData={{
            speed: 2 + Math.random(), // 上升速度
            resetHeight: 10 + Math.random() * 20, // 飞多高后消失
          }}>
          {/*
            半径 0.03 → 0.09。
            Demo2 的 0.03 是为世界尺寸约 8.5 的四川定的；我们的中国地图约 82 单位，
            同样 0.03 只有万分之一的宽度，在 1920 屏上不到一个像素 ——
            用户说「太细了，看不到」就是这个原因。
          */}
          <cylinderGeometry args={[0.09, 0.09, 1, 6, 1, true]} />
          <SparklesImplMaterial
            transparent
            depthWrite={false}
            side={DoubleSide}
            blending={AdditiveBlending}
            uColor={0x8fc2ff}
            uOpacity={0.5 + Math.random() * 0.2}
          />
        </mesh>
      ))}
    </group>
  );
};

export default BeamLight;
