import { MeshReflectorMaterial } from "@react-three/drei";

export default function Mirror() {
  return (
    <mesh receiveShadow rotation-x={-Math.PI / 2} position-y={-0.02}>
      {/*
        镜面尺寸必须远大于取景范围。
        Demo2 用 100×100 是因为它的相机恒定在约 13 个单位外、镜面直接铺出画面；
        这里的取景距离是按地图跨度反解的（中国约 95），100×100 的镜面会完整落进画面，
        露出一个深色菱形边界，还会把地图映出一个「重影」。
      */}
      <planeGeometry args={[400, 400]} />
      <MeshReflectorMaterial
        blur={[400, 100]}
        resolution={1024}
        mixBlur={10}
        mixStrength={8}
        depthScale={1}
        minDepthThreshold={0.85}
        color="#011024"
        metalness={0.6}
        roughness={1}
      />
    </mesh>
  );
}
