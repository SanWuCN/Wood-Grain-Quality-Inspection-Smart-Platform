import { useRef } from "react";

/**
 * 灯光：完全保持 Demo2 原值（ambientLight 2 + directionalLight 10 @ [0, 50, -50]）。
 *
 * 曾经想补两盏补充光来照亮顶面，但那会改变 Demo2 的光照关系（侧壁的明暗对比
 * 正是靠这两盏建立的）。改走另一条路：顶面额外挂一张**自发光地形细节贴图**
 * （见 terrainDetail.ts），用 emissive 提供与光照无关的层次，
 * 这样既不改原灯光，总览缩小时也不糊成黑影。
 */
export default function Lights() {
  const directionalRef = useRef(null!);

  //   useHelper(directionalRef, DirectionalLightHelper, 5, "red");

  return (
    <>
      <ambientLight color={0xffffff} intensity={2} />
      <directionalLight
        ref={directionalRef}
        color="#ffffff"
        intensity={10}
        position={[0, 50, -50]}
      />
    </>
  );
}
