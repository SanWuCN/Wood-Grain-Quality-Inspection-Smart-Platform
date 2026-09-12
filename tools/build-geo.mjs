/**
 * build-geo.mjs — 地图轮廓数据整理工具
 *
 * 输入：src/assets/china.json（DataV 省级 FeatureCollection）
 *       src/assets/shanghai.json（DataV 上海区级 FeatureCollection）
 *
 * 输出（src/assets/map/）：
 *   china_geo.json       省级区域
 *   shanghai_geo.json    上海区级区域
 *
 * 每条区域记录的结构：
 *   { name, adcode, center, centroid, polygons: [ [outer, hole1, hole2, ...], ... ] }
 *   坐标是原始经纬度 [lng, lat]，投影与缩放全部交给 Three.js 侧处理，
 *   这样空间数据始终是「真值」，不依赖生成时的画布尺寸。
 *
 * 说明：
 *   - 丢弃面积过小的碎屑环，减少三角化/挤出压力
 *   - 边界描边不在这里生成：直接由 Three.js 用区域本身的外环/内环画 lineSegments，
 *     这样国界、省界、区界都是全精度且没有自交伪影（尝试过「多边形偏移求并集轮廓」，
 *     相邻省界外扩后会互相穿插形成大量尖刺，不适合做描边）。
 *
 * 用法：node tools/build-geo.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "src", "assets", "map");

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/** 取出所有 polygon（Polygon -> [coords]，MultiPolygon -> coords） */
const polygonsOf = (feature) =>
  feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;

const ringKey = (ring) => `${ring.length}:${ring[0][0].toFixed(5)},${ring[0][1].toFixed(5)}`;

/** 单环面积（经纬度平面，用于丢掉零面积碎屑） */
function ringArea(ring) {
  let area = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

/** 丢掉面积过小的碎屑环（主环必须够大，洞可以小一点） */
function dropTinyRings(polygons, minArea = 0.00002) {
  const out = [];
  for (const polygon of polygons) {
    const rings = polygon.filter((ring, i) => i === 0 || ringArea(ring) > minArea);
    if (rings.length && ringArea(rings[0]) > minArea) out.push(rings);
  }
  return out;
}

/** 环内部的连续重复点去掉，省 JSON 体积 */
function dedupeRing(ring) {
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push([p[0], p[1]]);
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) {
    out.pop();
  }
  return out;
}

const toRegion = (feature) => ({
  name: feature.properties.name,
  adcode: feature.properties.adcode,
  center: feature.properties.center ?? null,
  centroid: feature.properties.centroid ?? null,
  polygons: dropTinyRings(polygonsOf(feature)).map((polygon) => polygon.map(dedupeRing)),
});

/* ------------------------------------------------------------------ */

const chinaRaw = read("src/assets/china.json");
const shanghaiRaw = read("src/assets/shanghai.json");

const SHANGHAI_ADCODE = 310000;
const shanghaiProvince = chinaRaw.features.find((f) => f.properties.adcode === SHANGHAI_ADCODE);
if (!shanghaiProvince) throw new Error("china.json 中找不到上海市");

// 省级数据里的「上海市」只有陆地那一块，崇明岛在 shanghai.json 的崇明区里。
// 为了让下钻后的上海是完整轮廓，把区级面去重后并进省级的上海市。
{
  const seen = new Set();
  const merged = [];
  const push = (polygon) => {
    const k = ringKey(polygon[0]);
    if (seen.has(k)) return;
    seen.add(k);
    merged.push(polygon.map(dedupeRing));
  };
  for (const polygon of polygonsOf(shanghaiProvince)) push(polygon);
  for (const feature of shanghaiRaw.features) {
    for (const polygon of polygonsOf(feature)) push(polygon);
  }
  shanghaiProvince.geometry = { type: "MultiPolygon", coordinates: merged };
  console.log(`上海市合并后 polygon 数：${merged.length}`);
}

const provinces = chinaRaw.features.filter((f) => f.properties.name).map(toRegion);
const districts = shanghaiRaw.features.map(toRegion);

mkdirSync(OUT_DIR, { recursive: true });
const write = (file, data) => {
  const json = `${JSON.stringify(data)}\n`;
  writeFileSync(join(OUT_DIR, file), json);
  return `${file}  ${(json.length / 1024).toFixed(1)}KB`;
};

console.log(
  [
    write("china_geo.json", { kind: "regions", regions: provinces }),
    write("shanghai_geo.json", { kind: "regions", regions: districts }),
  ].join("\n"),
);

const countRings = (regions) => regions.reduce((a, r) => a + r.polygons.length, 0);
console.log(`省级区域 ${provinces.length} 个 / 面 ${countRings(provinces)} 个`);
console.log(`上海区级 ${districts.length} 个 / 面 ${countRings(districts)} 个`);
