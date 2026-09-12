/**
 * build-map-json.mjs — 把整理好的区域数据转成 Demo2 直接可用的 GeoJSON
 *
 * 为什么要这一步：
 *   项目里的 `src/pages/Demo2/` 就是 sc-datav Demo2 的真实源码，它的地图组件
 *   （map/base.tsx、map/shape.tsx、map/boundary.tsx …）直接消费 DataV 形状的
 *   FeatureCollection。既然目标是「用 Demo2 的源码」，数据就应该喂成它认识的样子，
 *   而不是把它的组件改写成我们自己的数据结构。
 *
 * 输出（src/assets/map/，与 Demo2 的 sc.json / sc_outline.json 同形）：
 *   china.json          省级 FeatureCollection（34 个省级单位，已剔除南海诸岛）
 *   shanghai.json       上海市区级 FeatureCollection（下钻用）
 *   china_outline.json  中国外轮廓（供 GeoTrail 沿边界巡游）
 *
 * 与 Demo2 的区别只在数据：Sichuan 21 市 → 中国 34 省 / 上海 16 区。
 *
 * 用法：node tools/build-map-json.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_DIR = join(ROOT, "src", "assets", "map");

/** 南海诸岛：小比例尺挤出一堆细刺，主图剔除 */
const SOUTH_SEA_ADCODE = 100000;

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/** DataV 的 properties 字段，Demo2 依赖 name / center / centroid */
const toFeature = (region, level) => ({
  type: "Feature",
  properties: {
    adcode: region.adcode,
    name: region.name,
    center: region.center ?? region.centroid ?? null,
    centroid: region.centroid ?? region.center ?? null,
    level,
    childrenNum: 0,
  },
  geometry: { type: "MultiPolygon", coordinates: region.polygons },
});

/**
 * 生成外轮廓（GeoTrail 沿着它跑光点）。
 *
 * Demo2 的 sc_outline.json 是「一个 Feature、coordinates 是环的数组」这种特殊形状：
 * base.tsx 里对 outlineData.features[0].geometry.coordinates 做 map，每一项是
 * 一串点。所以这里保持同样的结构 —— 把各区域的外环按面积从大到小串起来。
 */
function buildOutline(regions) {
  const rings = [];
  for (const region of regions) {
    if (region.adcode === SOUTH_SEA_ADCODE) continue;
    for (const polygon of region.polygons) {
      const outer = polygon[0];
      if (outer && outer.length >= 4) rings.push(outer);
    }
  }
  rings.sort((a, b) => ringLength(b) - ringLength(a));
  // 只取最大的若干条，巡游光点沿着主要边界走即可
  const picked = rings.slice(0, 3);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { adcode: 100000, name: "中国", level: "country" },
        geometry: { type: "MultiPolygon", coordinates: picked.map((ring) => [ring]) },
      },
    ],
  };
}

const ringLength = (ring) => {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    sum += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  }
  return sum;
};

const china = read("src/assets/map/china_geo.json");
const shanghai = read("src/assets/map/shanghai_geo.json");

const provinces = china.regions.filter((r) => r.adcode !== SOUTH_SEA_ADCODE);
const districts = shanghai.regions;

const chinaFeatures = {
  type: "FeatureCollection",
  features: provinces.map((r) => toFeature(r, "province")),
};
const shanghaiFeatures = {
  type: "FeatureCollection",
  features: districts.map((r) => toFeature(r, "district")),
};
const chinaOutline = buildOutline(china.regions);

mkdirSync(MAP_DIR, { recursive: true });
const write = (file, data) => {
  const json = JSON.stringify(data);
  writeFileSync(join(MAP_DIR, file), json);
  return `${file}  ${(json.length / 1024).toFixed(1)}KB`;
};

console.log(
  [
    write("china.json", chinaFeatures),
    write("shanghai.json", shanghaiFeatures),
    write("china_outline.json", chinaOutline),
  ].join("\n"),
);
console.log(`省级 ${provinces.length} 个 / 区级 ${districts.length} 个 / 轮廓环 ${chinaOutline.features[0].geometry.coordinates.length} 条`);
