/**
 * 地图上的业务点位层
 *
 * 首页地图原来只有 Demo2 的装饰光锥，**没有任何业务信息** —— 工单点、风险点、
 * 文保单位、当前巡检位置都看不见。这里把它们真正挂到地图上：
 *   collected  已采集（青）  inspected 已巡检（绿）
 *   risk       有风险（红）  workorder 有工单（黄）
 *
 * 定位方式：沿用 base.tsx 里那一份 d3 geoMercator 投影，把点位经纬度投到
 * 与地图几何完全相同的坐标系上，所以点位永远贴着正确的省份。
 *
 * 尺寸：SiteMarker 的内部尺寸是按 Demo2 四川地图（投影半径约 6）设计的，
 * 这里统一乘 `deco = 地图半径 / 6`，保证中国与上海的标记占画面比例一致。
 */

import { useMemo } from "react";
import { useNavigate } from "react-router";
import type { GeoProjection } from "d3-geo";
import { SiteMarker } from "../map/SiteMarker";
import { chinaSites, shanghaiSites, type Site } from "../data";
import { useDashboardStore } from "../map/store";
import type { SurfaceKey } from "./base";

export interface SiteMarkersProps {
  mode: SurfaceKey;
  projection: GeoProjection;
  /** 装饰缩放系数，见文件头说明 */
  deco: number;
  /** 地图挤出厚度（点位贴在顶面上） */
  slabDepth: number;
}

/** 当前巡检位置：演示车正在示例寺松江区作业 */
const CURRENT_SITE_ID = "sh";

export default function SiteMarkers(props: SiteMarkersProps) {
  const { mode, projection, deco, slabDepth } = props;
  const navigate = useNavigate();
  const focusRegion = useDashboardStore((state) => state.focusRegion);
  const setFocusRegion = useDashboardStore((state) => state.setFocusRegion);

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

  return (
    <group renderOrder={8}>
      {placed.map(({ site, x, y }) => {
        const isCurrent = site.id === CURRENT_SITE_ID;
        return (
          <SiteMarker
            key={`${mode}-${site.id}`}
            /**
             * 全国图上 12 个点位 + 34 个省名会糊成一片，所以只在图钉上标色，
             * 不写点位名（设计稿的全国态也只有上海带文字）；
             * 下钻到上海之后再显示点位名。
             */
            name={mode === "shanghai" ? site.name : ""}
            caption={mode === "shanghai" ? site.risk ?? site.orderId ?? undefined : undefined}
            position={[x, y, slabDepth]}
            status={site.status}
            scale={deco * 0.62}
            selected={focusRegion === site.name}
            current={isCurrent}
            onSelect={() => {
              setFocusRegion(site.name);
              if (site.orderId) navigate(`/orders?order=${site.orderId}`);
            }}
          />
        );
      })}
    </group>
  );
}
