/**
 * 地图投影与几何构建
 *
 * 把经纬度 GeoJSON 变成 Three.js 可用的挤出几何：
 *   经纬度 --geoMercator--> 平面(米) --等比归一化--> 世界单位(x, y) --rotateX(-90°)--> 世界(x, z)
 *
 * 几何在「整个地图」层面一次性构建：
 *   - 顶/底面：所有区域三角化后合并进 group 0，UV 直接由世界坐标归一化而来，
 *     因此顶面贴图与轮廓严格对齐，不需要在 shader 里反算经纬度
 *   - 侧壁：外轮廓点按累计边长展开 UV（U 沿周长、V 沿厚度），扫光沿厚度方向走
 *   - 描边线段：逐区域顶点属性 aWeight 区分「外轮廓 / 洞」
 *
 * 注意：不要「一个环一份 ExtrudeGeometry」。那样每个面都会产生独立的 material group，
 * 一个省就是十几组，整个地图上千组，three.js 只按 materialIndex 取材质，
 * 结果就是绝大多数面用不到材质、整幅地图几乎不显示。
 */

import { geoMercator } from "d3-geo";
import { Box2, BufferAttribute, BufferGeometry, Path, Shape, ShapeUtils, Vector2 } from "three";

/** 一条环的坐标数组：[lng, lat] */
export type Ring = [number, number][];

export interface RegionInput {
  name: string;
  adcode?: number;
  center?: [number, number] | null;
  centroid?: [number, number] | null;
  /** 第一个是外环，其余是洞 */
  polygons: Ring[][];
}

export interface RegionModel {
  name: string;
  /** 区域中心（世界坐标 x/y） */
  center: Vector2;
  /** 每个面的环（世界坐标，已归一化），[0] 是外环，其余是洞 */
  polygons: Vector2[][][];
  /** 纬度方向绕地轴一周的周长（米） */
  metersPerLng: number;
}

export interface MapModel {
  regions: RegionModel[];
  /** 归一化后的平面包围盒（世界单位） */
  bounds: Box2;
  lngLatToWorld: (lng: number, lat: number) => Vector2;
  worldToLngLat: (x: number, y: number) => [number, number];
  scaleFactor: number;
}

function allRings(regions: RegionInput[]): Ring[] {
  const rings: Ring[] = [];
  for (const region of regions) {
    for (const polygon of region.polygons) {
      for (const ring of polygon) if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

/**
 * 构建整幅地图的投影模型。
 * @param targetWidth 归一化后的地图宽度（世界单位），高度按真实比例推出来
 */
export function buildMapModel(regions: RegionInput[], targetWidth: number): MapModel {
  const rings = allRings(regions);
  if (!rings.length) throw new Error("地图数据为空");

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  const projection = geoMercator()
    .center([(minLng + maxLng) / 2, (minLat + maxLat) / 2])
    .translate([0, 0]);

  const bbox = new Box2();
  const projectedRings: Vector2[][] = [];
  for (const ring of rings) {
    const projected: Vector2[] = [];
    for (const coord of ring) {
      const p = projection(coord);
      if (!p) continue;
      // 经纬度北在上，世界坐标 y 也向上，保持一致
      const v = new Vector2(p[0], -p[1]);
      projected.push(v);
      bbox.expandByPoint(v);
    }
    projectedRings.push(projected.length >= 4 ? projected : []);
  }

  const size = bbox.getSize(new Vector2());
  const center = bbox.getCenter(new Vector2());
  const scaleFactor = targetWidth / size.x;

  const toWorld = (lng: number, lat: number) => {
    const p = projection([lng, lat]);
    if (!p) return new Vector2();
    return new Vector2((p[0] - center.x) * scaleFactor, (-p[1] - center.y) * scaleFactor);
  };

  // 已投影的点只需要做「平移 + 等比缩放」，绝对不能再投影一次
  // （那会把 -y 当成纬度传进投影函数，坐标彻底错乱）
  const projectToWorld = (p: Vector2) =>
    new Vector2((p.x - center.x) * scaleFactor, (p.y - center.y) * scaleFactor);

  const worldToLngLat = (x: number, y: number): [number, number] => {
    const inverted = projection.invert?.([x / scaleFactor + center.x, -y / scaleFactor + center.y]);
    if (inverted) return [inverted[0], inverted[1]];
    return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  };

  const worldRings = projectedRings.map((ring) => ring.map(projectToWorld));

  // 按输入顺序把环归回各自的区域与面
  const models: RegionModel[] = [];
  let cursor = 0;
  const midLat = (minLat + maxLat) / 2;
  const metersPerLng = 111320 * Math.cos((midLat * Math.PI) / 180);

  for (const region of regions) {
    const polygons: Vector2[][][] = [];
    for (const polygon of region.polygons) {
      const faces: Vector2[][] = [];
      for (const ring of polygon) {
        if (ring.length < 4) continue;
        const worldRing = worldRings[cursor] ?? [];
        cursor++;
        if (worldRing.length >= 4) faces.push(worldRing);
      }
      if (faces.length) polygons.push(faces);
    }
    const anchor = region.centroid ?? region.center ?? null;
    const centerWorld = anchor ? toWorld(anchor[0], anchor[1]) : polygons[0]?.[0]?.[0] ?? new Vector2();
    models.push({ name: region.name, center: centerWorld, polygons, metersPerLng });
  }

  const worldBox = new Box2();
  for (const region of models) {
    for (const polygon of region.polygons) {
      for (const point of polygon[0] ?? []) worldBox.expandByPoint(point);
    }
  }

  return {
    regions: models,
    bounds: worldBox,
    lngLatToWorld: toWorld,
    worldToLngLat,
    scaleFactor,
  };
}

/** 把一个区域的面转成 THREE.Shape（[0] 为外环，其余为洞） */
export function regionShapes(region: RegionModel): Shape[] {
  return region.polygons.map((faces) => {
    const shape = new Shape(faces[0]);
    for (let i = 1; i < faces.length; i++) shape.holes.push(new Path(faces[i]));
    return shape;
  });
}

/** 多边形有向面积（世界单位） */
function ringSignedArea(ring: Vector2[]) {
  let area = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/**
 * ShapeUtils.triangulateShape 内部会调用点的 equals()，
 * 所以传进去的必须是真正的 Vector2 实例，不能是 {x, y} 字面量。
 */
const toVector2List = (points: Vector2[]) => points.map((p) => new Vector2(p.x, p.y));

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 太小的碎屑面直接跳过：它们挤出后只有几个像素宽的细刺，纯属噪声 */
const MIN_FACE_AREA = 0.004;

/**
 * 一次性构建整幅地图的挤出几何。
 *
 * 输出两个 material group：
 *   group 0（materialIndex 0）—— 顶面 + 底面
 *   group 1（materialIndex 1）—— 侧壁
 */
export function buildMapGeometry(model: MapModel, depth: number) {
  const { bounds } = model;
  const size = bounds.getSize(new Vector2());

  const positions: number[] = [];
  const uvs: number[] = [];
  const caps: number[] = [];
  const walls: number[] = [];

  // 顶面贴图 UV：世界坐标线性映射到 [0,1]
  const uvOf = (x: number, y: number) => [
    clamp01((x - bounds.min.x) / size.x),
    clamp01((y - bounds.min.y) / size.y),
  ];

  const pushVertex = (x: number, y: number, z: number, u: number, v: number) => {
    positions.push(x, y, z);
    uvs.push(u, v);
    return positions.length / 3 - 1;
  };

  for (const region of model.regions) {
    for (const faces of region.polygons) {
      const outer = faces[0];
      const holes = faces.slice(1);
      if (Math.abs(ringSignedArea(outer)) < MIN_FACE_AREA) continue;

      let facesIndex: number[][];
      try {
        facesIndex = ShapeUtils.triangulateShape(
          toVector2List(outer),
          holes.map((hole) => toVector2List(hole)),
        );
      } catch {
        // 退化多边形直接跳过，避免整幅地图构建失败
        continue;
      }

      // 三角化的顶点表：外环 + 所有洞依次拼接，顺序必须与上面传参一致
      const flat: Vector2[] = [...outer];
      for (const hole of holes) flat.push(...hole);

      const capStart = positions.length / 3;
      for (const point of flat) {
        const [u, v] = uvOf(point.x, point.y);
        // 顶面
        pushVertex(point.x, point.y, depth, u, v);
      }
      for (const point of flat) {
        const [u, v] = uvOf(point.x, point.y);
        // 底面
        pushVertex(point.x, point.y, 0, u, v);
      }
      const n = flat.length;
      for (const [a, b, c] of facesIndex) {
        caps.push(capStart + a, capStart + b, capStart + c);
        // 底面反向绕序
        caps.push(capStart + n + c, capStart + n + b, capStart + n + a);
      }

      // 侧壁：沿外环 + 各洞分别拉一条带
      const loopList = [outer, ...holes];
      for (const loop of loopList) {
        const wallStart = positions.length / 3;
        let perimeter = 0;
        const lengths: number[] = [0];
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i];
          const b = loop[(i + 1) % loop.length];
          perimeter += a.distanceTo(b);
          lengths.push(perimeter);
        }
        const uvScale = perimeter > 0 ? 6 / perimeter : 1;
        for (let i = 0; i <= loop.length; i++) {
          const point = loop[i % loop.length];
          const u = lengths[i] * uvScale;
          pushVertex(point.x, point.y, 0, u, 0);
          pushVertex(point.x, point.y, depth, u, 1);
        }
        for (let i = 0; i < loop.length; i++) {
          const a0 = wallStart + i * 2;
          const a1 = a0 + 1;
          const b0 = wallStart + (i + 1) * 2;
          const b1 = b0 + 1;
          walls.push(a0, a1, b1, a0, b1, b0);
        }
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex([...caps, ...walls]);
  geometry.addGroup(0, caps.length, 0);
  geometry.addGroup(caps.length, walls.length, 1);
  geometry.computeBoundingSphere();
  return geometry;
}

/** 单个区域的描边几何（顶面一圈 + 洞） */
export function buildRegionOutline(region: RegionModel, z: number) {
  const main: number[] = [];
  const weight: number[] = [];

  const pushRing = (points: Vector2[], w: number) => {
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      main.push(a.x, a.y, z, b.x, b.y, z);
      weight.push(w, w);
    }
  };

  for (const faces of region.polygons) {
    pushRing(faces[0], 1);
    for (let i = 1; i < faces.length; i++) pushRing(faces[i], 0.55);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(main), 3));
  geometry.setAttribute("aWeight", new BufferAttribute(new Float32Array(weight), 1));
  return geometry;
}
