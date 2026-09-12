import { Color, DoubleSide, Shape } from "three";
import { extend } from "@react-three/fiber";
import { shaderMaterial } from "@react-three/drei";

const BoundaryMaterial = extend(
  shaderMaterial(
    {
      uColor: new Color("#63cbff"),
      uOpacity: 1,
      uDepth: 1,
    },
    `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying float vHeight;
          
    void main() {
        vUv=uv;
        vNormal=normal;
        vHeight = position.z;
            
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0 );
    }`,
    `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying vec2 vUv; 
    varying vec3 vNormal;
    uniform float uDepth;
    varying float vHeight;

    void main() {
        if(vNormal.z==1.0||vNormal.z==-1.0||vUv.y ==0.0){
            discard;
        } else{
            float h = mix(1.0,0.0,vHeight / uDepth);
            gl_FragColor = vec4(uColor, h * uOpacity);
        } 
    }`
  )
);

export interface BoundaryProps {
  data: Shape[];
  depth?: number;
  /** 装饰缩放系数 = 地图投影半径 / Demo2 四川半径(6)，见 cone.tsx 的说明 */
  deco?: number;
}

export default function Boundary(props: BoundaryProps) {
  const { data, depth = 3, deco = 1 } = props;
  return (
    <group renderOrder={11} position-z={1 * deco}>
      <mesh>
        <extrudeGeometry args={[data, { depth, bevelEnabled: false }]} />
        <BoundaryMaterial
          transparent
          depthTest={false}
          side={DoubleSide}
          uOpacity={0.2}
          uDepth={depth}
        />
      </mesh>
    </group>
  );
}
