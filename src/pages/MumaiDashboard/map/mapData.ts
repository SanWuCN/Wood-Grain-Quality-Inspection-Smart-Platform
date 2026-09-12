/**
 * 地图数据接入：把构建好的区域 JSON 转成场景可用的形状
 *
 * 南海诸岛（adcode 100000）在小比例尺下是一堆极小的岛礁，拉到 3.8°N，
 * 挤出后会在主图下方形成一长串细刺，既不像地图也不好看。
 * 标准做法是把它做成右下角的「南海诸岛」插图，这里就从主图里剔除，
 * 在场景里单独画一个小方框标注。
 */

import type { RegionInput } from "./geometry";
import chinaGeo from "@/assets/map/china_geo.json";
import shanghaiGeo from "@/assets/map/shanghai_geo.json";

/** 南海诸岛的 adcode */
export const SOUTH_SEA_ADCODE = 100000;

const toInputs = (regions: unknown): RegionInput[] =>
  (regions as RegionInput[]).filter((region) => region.adcode !== SOUTH_SEA_ADCODE);

export const chinaRegions: RegionInput[] = toInputs(chinaGeo.regions);
export const shanghaiRegions: RegionInput[] = toInputs(shanghaiGeo.regions);
