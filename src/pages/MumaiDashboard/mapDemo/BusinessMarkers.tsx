/**
 * 地图上的业务点位层：把「我们去勘察、检测过的古建点位」真正挂到地图上
 *
 * 点位数据来自 `seed/sites.ts`（平台唯一数据源，与工单 / 任务共用同一份），
 * 五类信息可见：点名的古建、状态分色、风险摘要、当前任务位置、悬停高亮。
 *   collected  已勘察（蓝）  inspected 已检测（绿）
 *   risk       有风险（红）  workorder 有工单（黄）
 *
 * 定位方式：沿用 base.tsx 里那一份 d3 geoMercator 投影，把点位经纬度投到
 * 与地图几何完全相同的坐标系上，所以点位永远贴着正确的省份。
 *
 * 尺寸：SiteMarker 的内部尺寸是按 Demo2 四川地图（投影半径约 17）设计的，
 * 这里统一乘 `deco = 地图半径 / 17`，保证中国与上海的标记占画面比例一致；
 * SiteMarker 内部再按同一个 scale 缩放拾取球，命中范围跟着一起变。
 *
 * 点击三种分支（由种子数据决定走哪一支，不在页面里写 if 名单）：
 *   1. 有任务 → `/mapping?site=<点位 id>`（建图巡检页按点位定位航点）
 *   2. 有工单 → `/orders?order=<工单号>`（订单页已支持 order 查询参数）
 *   3. 只有勘察 / 检测记录 → 在当前页打开详情浮层（不跳走）
 * 一个点位同时有两种关联时，任务优先（先看「这一轮怎么走的」，再看「单子怎么开」）。
 */

import { useMemo } from "react";
import { useNavigate } from "react-router";
import type { GeoProjection } from "d3-geo";
import { SiteMarker } from "../map/SiteMarker";
import { chinaSites, shanghaiSites, type Site } from "../data";
import { useDashboardStore } from "../map/store";
import { siteRegion } from "../seed/sites";
import type { SurfaceKey } from "./base";
import { useConfigStore } from "./stores";

export interface SiteMarkersProps {
  mode: SurfaceKey;
  projection: GeoProjection;
  /** 装饰缩放系数，见文件头说明 */
  deco: number;
  /** 地图挤出厚度（点位贴在顶面上） */
  slabDepth: number;
}

/** 当前巡检位置：智能巡检车正在示例寺松江区作业 */
const CURRENT_SITE_ID = "sh";

/**
 * 标签散开半径（px）：`基础值 + 按离心距离补的最多 EXTRA`。
 *
 * 上海 12 个点位里松江 / 普陀 / 徐汇 / 静安 / 黄浦挤在市中心约 50×50px 的范围里，
 * 每个点位都带「名字 + 状态」两行标签会整片糊在一起（实测 12 个标签落在
 * 一个约 100×110px 的方框里，文字互相压住）。点位本身必须留在真实经纬度上，
 * 所以只能把**标签**沿「离开所有点位重心」的方向推出去。
 *
 * 越靠重心的点位推得越远（1 - 距离/最大距离 线性加到 EXTRA），
 * 于是外圈的崇明 / 金山仍然贴着自己的点位，只有市中心那几个被拉开。
 * 全国图的城市彼此隔得远，不做这件事。
 */
const SHANGHAI_LABEL_BASE = 46;
const SHANGHAI_LABEL_EXTRA = 122;

export default function SiteMarkers(props: SiteMarkersProps) {
  const { mode, projection, deco, slabDepth } = props;
  const navigate = useNavigate();
  const selectedSiteId = useDashboardStore((state) => state.selectedSiteId);
  const selectSite = useDashboardStore((state) => state.selectSite);
  const setFocusRegion = useDashboardStore((state) => state.setFocusRegion);
  const mapPlayComplete = useConfigStore((state) => state.mapPlayComplete);

  const sites = mode === "shanghai" ? shanghaiSites : chinaSites;

  const placed = useMemo(() => {
    return sites
      .map((site) => {
        const projected = projection(site.coordinate);
        if (!projected) return null;
        return { site, x: projected[0], y: -projected[1] };
      })
      .filter((item): item is { site: Site; x: number; y: number } => item !== null);
  }, [sites, projection]);

  /**
   * 标签偏移：方向 = 点位相对「所有点位重心」的方向（每个点位都不同），
   * 距离 = 基础值 + 越靠重心补得越多。只有一个点位时退回正上方。
   */
  const labelOffsets = useMemo(() => {
    if (mode !== "shanghai") return null;
    const centroid = placed.reduce(
      (acc, item) => ({ x: acc.x + item.x / placed.length, y: acc.y + item.y / placed.length }),
      { x: 0, y: 0 },
    );
    const distances = placed.map(({ x, y }) => Math.hypot(x - centroid.x, y - centroid.y));
    const maxDistance = Math.max(...distances, 1e-6);
    return new Map(
      placed.map(({ site, x, y }, index) => {
        const len = distances[index];
        const [ux, uy] = len < 1e-6 ? [0, 1] : [(x - centroid.x) / len, (y - centroid.y) / len];
        const push = SHANGHAI_LABEL_BASE + SHANGHAI_LABEL_EXTRA * (1 - len / maxDistance);
        return [
          site.id,
          [Number((ux * push).toFixed(2)), Number((uy * push).toFixed(2))] as [number, number],
        ];
      }),
    );
  }, [mode, placed]);

  // HTML anchors and pulsing materials bypass the map's opacity tween.
  // Mount them after the terrain reveal so points never float over an empty map.
  if (!mapPlayComplete) return null;

  return (
    <group renderOrder={8}>
      {placed.map(({ site, x, y }) => {
        const isCurrent = site.id === CURRENT_SITE_ID;
        const isSelected = selectedSiteId === site.id;
        return (
          <SiteMarker
            key={`${mode}-${site.id}`}
            /**
             * 全国图上 27 个点位 + 34 个省名会糊成一片，所以只在图钉上标色，
             * 不写点位名（设计稿的全国态也只有上海带文字）；
             * 下钻到上海之后再显示点位名与状态摘要。
             */
            name={mode === "shanghai" ? site.name : ""}
            /**
             * 状态摘要只给**选中**的那个点位：上海 12 个点位的标签本来就挤，
             * 每个都带两行会把市中心糊成一团（实测两行标签互相压住）。
             * 未选中时只留一行点位名，选中后补上风险 / 工单号 / 区县。
             */
            caption={
              mode === "shanghai" && isSelected
                ? site.risk ?? site.orderId ?? siteRegion(site)
                : undefined
            }
            position={[x, y, slabDepth]}
            status={site.status}
            scale={deco * 0.8}
            selected={isSelected}
            current={isCurrent}
            labelOffset={labelOffsets?.get(site.id)}
            onSelect={() => {
              // 三处选中态收敛到 store 一处：地图高亮、右栏工单、详情浮层共用
              setFocusRegion(site.name);
              selectSite(site.id);
              // ① 有巡检任务 → 建图巡检页（按点位 id 定位这一轮的航点）
              if (site.missionId) {
                navigate(`/mapping?site=${site.id}`);
                return;
              }
              // ② 有工单 → 工单档案页（订单页已支持 order 查询参数）
              if (site.orderId) {
                navigate(`/orders?order=${site.orderId}`);
                return;
              }
              // ③ 只有勘察 / 检测记录：留在当前页，由 Overview 渲染详情浮层（不跳走）
            }}
          />
        );
      })}
    </group>
  );
}
