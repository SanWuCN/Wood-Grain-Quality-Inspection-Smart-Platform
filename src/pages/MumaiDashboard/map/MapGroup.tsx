/**
 * 地图分组：一整块挤出网格 + 逐区域描边 + 射线拾取
 *
 * 几何在「整幅地图」层面合并成一个 mesh（只有 2 个 material group），
 * 交互则用射线拾取点反查所属区域——区域包围盒命中测试足够快（30 多个区域）。
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Box3, Group, Raycaster, Vector2, Vector3, type Texture } from "three";
import { buildMapGeometry, buildRegionOutline, type MapModel, type RegionModel } from "./geometry";
import { createBoundaryMaterial, createSideMaterial, createTopMaterial } from "./materials";

export interface MapGroupProps {
  groupRef: React.RefObject<Group | null>;
  model: MapModel;
  /** 当前模式是否可见 */
  visible: boolean;
  depth: number;
  surfaceMap: Texture;
  normalMap: Texture;
  /** 高亮的区域名（前缀匹配，例如「上海」匹配「上海市」） */
  highlightPrefix?: string;
  /** 可点击的区域名（精确匹配） */
  clickableName?: string;
  /** 选中的区域名 */
  selectedName?: string | null;
  onSelectRegion?: (name: string) => void;
  onHoverRegion?: (name: string | null) => void;
}

interface RegionBox {
  region: RegionModel;
  box: Box3;
}

function buildRegionBoxes(model: MapModel): RegionBox[] {
  return model.regions.map((region) => {
    const box = new Box3();
    const point = new Vector3();
    for (const polygon of region.polygons) {
      for (const ring of polygon) {
        for (const p of ring) {
          point.set(p.x, p.y, 0);
          box.expandByPoint(point);
        }
      }
    }
    return { region, box };
  });
}

export default function MapGroup(props: MapGroupProps) {
  const {
    model,
    visible,
    depth,
    surfaceMap,
    normalMap,
    highlightPrefix,
    clickableName,
    selectedName,
  } = props;

  const meshRef = useRef<import("three").Mesh>(null);
  const hiRef = useRef(0);
  const hovered = useRef<string | null>(null);

  const geometry = useMemo(() => buildMapGeometry(model, depth), [model, depth]);
  const outlines = useMemo(
    () =>
      model.regions.map((region) => ({
        name: region.name,
        geometry: buildRegionOutline(region, depth + 0.006),
        hiGeometry: buildRegionOutline(region, depth + 0.013),
      })),
    [model, depth],
  );
  const regionBoxes = useMemo(() => buildRegionBoxes(model), [model]);

  const topMaterial = useMemo(
    () => createTopMaterial({ surfaceMap, normalMap }),
    [surfaceMap, normalMap],
  );
  const sideMaterial = useMemo(() => createSideMaterial({ depth }), [depth]);
  const boundaryMaterial = useMemo(() => createBoundaryMaterial({ color: "#cdf1ff", intensity: 1.6 }), []);
  const hiMaterial = useMemo(() => createBoundaryMaterial({ color: "#f4feff", intensity: 1.7 }), []);
  const edgeMaterial = useMemo(
    () => createBoundaryMaterial({ color: "#f8ffff", intensity: 0.6 }),
    [],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      outlines.forEach((o) => {
        o.geometry.dispose();
        o.hiGeometry.dispose();
      });
      topMaterial.dispose();
      sideMaterial.dispose();
      boundaryMaterial.dispose();
      hiMaterial.dispose();
      edgeMaterial.dispose();
    },
    [geometry, outlines, topMaterial, sideMaterial, boundaryMaterial, hiMaterial, edgeMaterial],
  );

  useEffect(() => {
    topMaterial.uniforms.uHighlight.value = 0;
    sideMaterial.uniforms.uHighlight.value = 0;
  }, [topMaterial, sideMaterial]);

  useFrame((_, delta) => {
    const active = highlightedName ?? null;
    const target = active ? 1 : 0;
    hiRef.current += (target - hiRef.current) * Math.min(1, delta * 5);
    topMaterial.uniforms.uHighlight.value = hiRef.current;
    sideMaterial.uniforms.uHighlight.value = hiRef.current * 0.7;
  });

  /* -------------------- 射线拾取 -------------------- */
  const { camera, raycaster, gl } = useThree();
  const localPoint = useMemo(() => new Vector3(), []);
  const ndc = useMemo(() => new Vector2(), []);

  const pick = (clientX: number, clientY: number) => {
    const mesh = meshRef.current;
    if (!mesh) return null;
    const rect = gl.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const activeRaycaster = (raycaster as Raycaster) ?? new Raycaster();
    activeRaycaster.setFromCamera(ndc, camera);
    const hit = activeRaycaster.intersectObject(mesh, false)[0];
    if (!hit) return null;
    // 命中的是网格本地坐标，直接和区域包围盒比
    localPoint.copy(hit.point);
    mesh.worldToLocal(localPoint);
    for (const { region, box } of regionBoxes) {
      if (localPoint.x >= box.min.x && localPoint.x <= box.max.x && localPoint.y >= box.min.y && localPoint.y <= box.max.y) {
        return region.name;
      }
    }
    return null;
  };

  const highlightedName = useMemo(() => {
    if (highlightPrefix) {
      const found = model.regions.find((r) => r.name.startsWith(highlightPrefix));
      return found?.name ?? null;
    }
    if (clickableName) return clickableName;
    return selectedName ?? null;
  }, [model, highlightPrefix, clickableName, selectedName]);

  /** 哪些区域算「可交互」的 */
  const isInteractive = (name: string) => {
    if (highlightPrefix) return name.startsWith(highlightPrefix);
    if (clickableName) return name === clickableName;
    return false;
  };

  return (
    <group ref={props.groupRef} rotation={[-Math.PI / 2, 0, 0]} visible={visible}>
      <mesh
        ref={meshRef}
        geometry={geometry}
        onPointerMove={(event) => {
          if (!visible) return;
          const name = pick(event.clientX, event.clientY);
          const hit = name && isInteractive(name) ? name : null;
          if (hit !== hovered.current) {
            hovered.current = hit;
            document.body.style.cursor = hit ? "pointer" : "auto";
            props.onHoverRegion?.(hit);
          }
        }}
        onPointerOut={() => {
          if (hovered.current) {
            hovered.current = null;
            document.body.style.cursor = "auto";
            props.onHoverRegion?.(null);
          }
        }}
        onClick={(event) => {
          if (!visible) return;
          event.stopPropagation();
          const name = pick(event.clientX, event.clientY);
          if (name && isInteractive(name)) props.onSelectRegion?.(name);
        }}>
        <primitive object={topMaterial} attach="material-0" />
        <primitive object={sideMaterial} attach="material-1" />
      </mesh>

      {outlines.map((outline) => (
        <group key={outline.name}>
          <lineSegments raycast={() => null} renderOrder={4}>
            <primitive object={outline.geometry} attach="geometry" />
            <primitive object={boundaryMaterial} attach="material" />
          </lineSegments>
          <lineSegments raycast={() => null} renderOrder={6}>
            <primitive object={outline.hiGeometry} attach="geometry" />
            <primitive object={hiMaterial} attach="material" />
          </lineSegments>
          <lineSegments raycast={() => null} renderOrder={3}>
            <primitive object={outline.geometry} attach="geometry" />
            <primitive object={edgeMaterial} attach="material" />
          </lineSegments>
        </group>
      ))}
    </group>
  );
}
