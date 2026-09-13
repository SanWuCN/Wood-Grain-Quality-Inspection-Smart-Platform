/**
 * 点位详情浮层（首页地图上「只有勘察 / 检测记录」的点位点击后出现）
 *
 * 用户要求：地图上要标出我们去勘察、检测过的古建点位，点击能进对应工单 / 任务。
 * 那么**没有工单也没有任务**的点位点开以后不能什么都不发生 —— 也不该跳走
 * （跳走会打断「在地图上连着看几个点位」的动线）。这里用一层轻量浮层就地说明：
 *   点位名 / 省份·区县 / 经纬度 / 最近一次勘察检测时间 / 检测项 / 结论
 * 底部给「去创建工单」入口，跳到工单档案页（带去创建工单的提示）。
 *
 * 数据全部来自 `seed/sites.ts`：`site.survey` 是种子里的记录，页面不造数。
 * 浮层自己不做取数，只按 `store.selectedSiteId` 在当前地图模式的点位里查；
 * 查不到（例如实例不在本模式）就什么都不渲染。
 *
 * 样式用 styled-components 就地定义：本任务不允许改 `pages.css` / `tokens.css`
 * （那两份文件有并行任务在改），用 CSS-in-JS 可以不碰全局样式表。
 *
 * 数字动效（`src/components/numberAnimation.tsx`）：本浮层出现的数字只有经纬度
 * （`siteCoordinateText`）与最近勘察时间（`site.survey.at`），两个都是 `seed/sites.ts`
 * 里的定值 —— 浮层打开期间不会变，按组件口径属于「定值常量 / 日期」，**不参与滚动**；
 * 检测项只以文字标签成列，没有以数字呈现的计数。因此这一份刻意一处都没动。
 */

import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import styled from "styled-components";
import { useDashboardStore } from "../map/store";
import { STATUS_ACTION, STATUS_COLOR, STATUS_TEXT } from "../map/status";
import { CHINA_SITES, SHANGHAI_SITES, siteCoordinateText, siteRegion } from "../seed/sites";

const Card = styled.aside`
  position: absolute;
  left: 50%;
  bottom: 118px;
  z-index: 12;
  width: 380px;
  max-width: calc(100% - 48px);
  transform: translateX(-50%);
  padding: 14px 16px 12px;
  background: var(--panel-surface);
  border-left: 2px solid var(--primary);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  color: var(--text-secondary);
  font-size: var(--fs-aux);
  line-height: 1.55;
`;

const Head = styled.header`
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;

  strong {
    font-size: var(--fs-panel);
    font-weight: 600;
    color: var(--text-primary);
  }

  em {
    font-style: normal;
    color: var(--text-tertiary);
  }

  button {
    margin-left: auto;
    padding: 0 4px;
    background: none;
    border: none;
    color: var(--text-tertiary);
    cursor: pointer;

    &:hover {
      color: var(--text-primary);
    }
  }
`;

const Status = styled.p`
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  color: var(--text-tertiary);

  i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
`;

const Facts = styled.dl`
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 4px 10px;
  margin: 0 0 8px;

  dt {
    color: var(--text-tertiary);
  }

  dd {
    margin: 0;
    color: var(--text-primary);
    font-family: var(--font-data);
  }

  dd.text {
    font-family: inherit;
  }
`;

const Items = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;

  li {
    padding: 1px 8px;
    background: var(--fill-soft);
    color: var(--text-secondary);
  }
`;

const Conclusion = styled.p`
  margin: 0 0 10px;
  padding-left: 8px;
  border-left: 1px solid var(--border-subtle);
  color: var(--text-primary);
`;

const Foot = styled.footer`
  display: flex;
  align-items: center;
  gap: 10px;

  small {
    color: var(--text-tertiary);
  }

  button {
    margin-left: auto;
  }
`;

export default function SiteDetailCard() {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedSiteId = useDashboardStore((state) => state.selectedSiteId);
  const mode = useDashboardStore((state) => state.mode);
  const clearSite = useDashboardStore((state) => state.clearSite);
  const cardRef = useRef<HTMLElement>(null);

  /** 只在首页地图上出现：从点位跳去 /orders 再返回时，浮层不该自己冒出来 */
  const onOverview = location.pathname === "/";

  const site = useMemo(() => {
    if (!onOverview || !selectedSiteId) return null;
    const list = mode === "shanghai" ? SHANGHAI_SITES : CHINA_SITES;
    return list.find((item) => item.id === selectedSiteId) ?? null;
  }, [onOverview, selectedSiteId, mode]);

  /**
   * 点空白处关闭。用 document 冒泡监听而不是加一层遮罩 div：
   * 遮罩会挡住地图的拖拽旋转与滚轮缩放，而「点一下就关」本来就不需要遮罩。
   */
  useEffect(() => {
    if (!site) return;
    const onDown = (event: MouseEvent) => {
      const node = event.target as Node | null;
      if (node && cardRef.current?.contains(node)) return;
      clearSite();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [site, clearSite]);

  if (!site) return null;

  return (
    <Card ref={cardRef} aria-label={`${site.name} 勘察检测记录`}>
      <Head>
        <strong>{site.name}</strong>
        <em>{siteRegion(site)}</em>
        <button type="button" onClick={clearSite} aria-label="关闭点位详情">
          ✕
        </button>
      </Head>

      <Status>
        <i style={{ background: STATUS_COLOR[site.status] }} />
        {STATUS_TEXT[site.status]} · {STATUS_ACTION[site.status]}
      </Status>

      <Facts>
        <dt>经纬度</dt>
        <dd>{siteCoordinateText(site)}</dd>
        <dt>最近勘察</dt>
        <dd>{site.survey.at}</dd>
        <dt>记录人</dt>
        <dd>{site.survey.by}</dd>
        {site.risk ? (
          <>
            <dt>风险描述</dt>
            <dd className="text">{site.risk}</dd>
          </>
        ) : null}
      </Facts>

      <Items>
        {site.survey.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </Items>

      <Conclusion>{site.survey.conclusion}</Conclusion>

      <Foot>
        <small>该点位尚无工单</small>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => navigate("/orders?create=1")}>
          去创建工单
        </button>
      </Foot>
    </Card>
  );
}
