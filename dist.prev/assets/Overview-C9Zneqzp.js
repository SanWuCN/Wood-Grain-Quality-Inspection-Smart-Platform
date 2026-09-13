import{i as e,t}from"./react-fUea0rnc.js";import"./client-DMoT_y_x.js";import{o as n,s as r}from"./chunk-4WY6JWTD-vAOiIUKR.js";import{$ as i,At as a,F as o,V as s,mt as c,n as l,r as u,tt as d,ut as f,wt as p}from"./context-PMTNcRR9.js";import{A as m,P as h,_ as g,d as _,f as v,g as y,h as b,l as x,m as S,p as C,u as w,y as T}from"./index-Dfn0bzdi.js";import{t as E}from"./Panel-P-zJY3-o.js";import"./OrbitControls-CzSFiWgJ.js";import{i as D,n as O,r as k,t as A}from"./mapDemo-C7xbSQTK.js";var j=e(t(),1),M=u(),N=T.aside`
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
`,P=T.header`
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
`,F=T.p`
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
`,I=T.dl`
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
`,L=T.ul`
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
`,R=T.p`
  margin: 0 0 10px;
  padding-left: 8px;
  border-left: 1px solid var(--border-subtle);
  color: var(--text-primary);
`,z=T.footer`
  display: flex;
  align-items: center;
  gap: 10px;

  small {
    color: var(--text-tertiary);
  }

  button {
    margin-left: auto;
  }
`;function B(){let e=r(),t=n(),i=w(e=>e.selectedSiteId),a=w(e=>e.mode),o=w(e=>e.clearSite),s=(0,j.useRef)(null),c=t.pathname===`/`,l=(0,j.useMemo)(()=>!c||!i?null:(a===`shanghai`?C:v).find(e=>e.id===i)??null,[c,i,a]);return(0,j.useEffect)(()=>{if(!l)return;let e=e=>{let t=e.target;t&&s.current?.contains(t)||o()};return document.addEventListener(`mousedown`,e),()=>document.removeEventListener(`mousedown`,e)},[l,o]),l?(0,M.jsxs)(N,{ref:s,"aria-label":`${l.name} 勘察检测记录`,children:[(0,M.jsxs)(P,{children:[(0,M.jsx)(`strong`,{children:l.name}),(0,M.jsx)(`em`,{children:b(l)}),(0,M.jsx)(`button`,{type:`button`,onClick:o,"aria-label":`关闭点位详情`,children:`✕`})]}),(0,M.jsxs)(F,{children:[(0,M.jsx)(`i`,{style:{background:k[l.status]}}),D[l.status],` · `,O[l.status]]}),(0,M.jsxs)(I,{children:[(0,M.jsx)(`dt`,{children:`经纬度`}),(0,M.jsx)(`dd`,{children:S(l)}),(0,M.jsx)(`dt`,{children:`最近勘察`}),(0,M.jsx)(`dd`,{children:l.survey.at}),(0,M.jsx)(`dt`,{children:`记录人`}),(0,M.jsx)(`dd`,{children:l.survey.by}),l.risk?(0,M.jsxs)(M.Fragment,{children:[(0,M.jsx)(`dt`,{children:`风险描述`}),(0,M.jsx)(`dd`,{className:`text`,children:l.risk})]}):null]}),(0,M.jsx)(L,{children:l.survey.items.map(e=>(0,M.jsx)(`li`,{children:e},e))}),(0,M.jsx)(R,{children:l.survey.conclusion}),(0,M.jsxs)(z,{children:[(0,M.jsx)(`small`,{children:`该点位尚无工单`}),(0,M.jsx)(`button`,{type:`button`,className:`btn btn--primary`,onClick:()=>e(`/orders?create=1`),children:`去创建工单`})]})]}):null}var V=`让古建被看见 · 让历史有未来`,H={lat:31.2304,lon:121.4737},U={高风险:`danger`,中风险:`warn`,低风险:`info`},W={草稿:`muted`,待复核:`warn`,待处理:`warn`,处理中:`info`,待验收:`warn`,已关闭:`ok`},G=[{key:`high`,label:`高风险`,tone:`danger`,match:e=>e.level===`高风险`},{key:`pending`,label:`待处理`,tone:`warn`,match:e=>e.status===`待处理`||e.status===`待复核`},{key:`running`,label:`处理中`,tone:`info`,match:e=>e.status===`处理中`}],K=[a,...i],q=T.div`
  span b {
    font-family: var(--font-data);
    font-weight: 600;
    color: var(--text-primary);
  }
`,J=f.mapVersion;function Y({open:e,moreText:t,onClick:n}){return(0,M.jsx)(`button`,{type:`button`,className:`ov-more`,"aria-expanded":e,onClick:n,children:e?`收起`:t})}function X(){let e=(0,j.useMemo)(()=>g(v),[]),t=e.byStatus.inspected+e.byStatus.workorder,n=Math.round(t/Math.max(1,e.total)*100);return(0,M.jsxs)(E,{title:`巡检态势`,extra:(0,M.jsxs)(`span`,{className:`muted`,children:[`全国 `,_,` 个省级区域`]}),className:`ov__panel`,children:[(0,M.jsxs)(`div`,{className:`ov-tally`,children:[(0,M.jsxs)(`div`,{children:[(0,M.jsx)(`strong`,{children:_}),(0,M.jsx)(`span`,{children:`已覆盖省份`})]}),(0,M.jsxs)(`div`,{children:[(0,M.jsx)(`strong`,{children:e.total}),(0,M.jsx)(`span`,{children:`古建点位`})]}),(0,M.jsxs)(`div`,{children:[(0,M.jsx)(`strong`,{children:t}),(0,M.jsx)(`span`,{children:`完成巡检`})]}),(0,M.jsxs)(`div`,{children:[(0,M.jsxs)(`strong`,{children:[n,(0,M.jsx)(`em`,{children:`%`})]}),(0,M.jsx)(`span`,{children:`完成率`})]})]}),(0,M.jsx)(`div`,{className:`ov-tally__rate`,title:`完成率 ${n}%`,children:(0,M.jsx)(`i`,{style:{width:`${n}%`}})}),(0,M.jsx)(`ul`,{className:`ov-tally__bar`,children:[`inspected`,`workorder`,`risk`,`collected`].map(t=>(0,M.jsxs)(`li`,{children:[(0,M.jsx)(`i`,{style:{background:k[t]}}),(0,M.jsx)(`span`,{children:D[t]}),(0,M.jsx)(`b`,{children:e.byStatus[t]})]},t))}),(0,M.jsxs)(`p`,{className:`ov-tally__foot`,children:[`本轮任务 `,a.id,` · `,a.site]})]})}function Z(){let{channels:e}=l(),t=[{...s.scanner,source:`模拟采集`,tone:`warn`},{...s.demoCart,source:`回放`,tone:`info`},{...s.realCart,source:`只读监视`,tone:`muted`}],n=e=>e===`online`?`ok`:e===`stale`?`warn`:`danger`,r=e=>e===`online`?`正常`:e===`stale`?`延迟`:`断开`;return(0,M.jsxs)(E,{title:`设备状态`,extra:(0,M.jsx)(`span`,{className:`muted`,children:f.mapVersion}),className:`ov__panel`,children:[(0,M.jsx)(`ul`,{className:`ov-devices`,children:t.map(e=>(0,M.jsxs)(`li`,{children:[(0,M.jsxs)(`div`,{className:`ov-devices__id`,children:[(0,M.jsx)(`b`,{children:e.name}),(0,M.jsx)(`em`,{children:e.id})]}),(0,M.jsx)(m,{text:e.source,tone:e.tone,dot:!0})]},e.id))}),(0,M.jsx)(`h4`,{className:`ov-sec`,children:`数据通道`}),(0,M.jsx)(`ul`,{className:`ov-channels`,children:e.map(e=>(0,M.jsxs)(`li`,{children:[(0,M.jsx)(`span`,{children:e.label}),(0,M.jsx)(m,{text:r(e.state),tone:n(e.state),dot:!0}),(0,M.jsx)(`em`,{children:e.updatedAt})]},e.key))})]})}function Q(){let e=r(),t=w(e=>e.selectedOrderId),n=w(e=>e.selectOrder),i=w(e=>e.selectedSiteId),[s,c]=(0,j.useState)(!1),[l,u]=(0,j.useState)(!1),d=K.find(e=>e.id===t)??a,f=(0,j.useMemo)(()=>i?[...v,...C].find(e=>e.id===i)??null:null,[i]),p=(0,j.useMemo)(()=>G.map(e=>({...e,value:K.filter(e.match).length})),[]),g=(0,j.useMemo)(()=>{if(s)return K;let e=K.slice(0,4);return e.some(e=>e.id===d.id)?e:K.filter((e,t)=>t<3||e.id===d.id)},[s,d]),_=(0,j.useMemo)(()=>o.filter(e=>d.sourceRiskIds.includes(e.id)).reduce((e,t)=>e===null||t.score>e.score?t:e,null)?.label??d.scope,[d]),y=(0,j.useMemo)(()=>{if(d.id!==a.id)return;let e=a.componentIds[a.componentIds.length-1];return o.filter(t=>t.componentId===e).reduce((e,t)=>e===void 0||t.score>e.score?t:e,void 0)},[d]);return(0,M.jsxs)(M.Fragment,{children:[(0,M.jsx)(`div`,{className:`ov-counts`,children:p.map(e=>(0,M.jsx)(`div`,{className:`ov-count ov-count--${e.tone}`,children:(0,M.jsxs)(`strong`,{children:[e.value,(0,M.jsx)(`small`,{children:e.label})]})},e.key))}),(0,M.jsxs)(`h4`,{className:`ov-sec`,children:[`工单列表`,(0,M.jsx)(Y,{open:s,moreText:`共 ${K.length} 条 · 更多`,onClick:()=>c(e=>!e)})]}),(0,M.jsxs)(`div`,{className:`ov-orders${s?` is-open`:``}`,children:[(0,M.jsxs)(`div`,{className:`ov-orders__head`,children:[(0,M.jsx)(`span`,{children:`工单 · 点位`}),(0,M.jsx)(`span`,{children:`风险`}),(0,M.jsx)(`span`,{children:`状态`})]}),(0,M.jsx)(`div`,{className:`ov-orders__list`,children:g.map(e=>(0,M.jsxs)(`button`,{type:`button`,className:e.id===d.id?`is-active`:``,onClick:()=>n(e.id),children:[(0,M.jsxs)(`span`,{className:`ov-orders__id`,children:[e.id,(0,M.jsx)(`i`,{children:e.site})]}),(0,M.jsx)(m,{text:e.level,tone:U[e.level]}),(0,M.jsx)(m,{text:e.status,tone:W[e.status]})]},e.id))})]}),(0,M.jsxs)(`article`,{className:`ov-coc`,children:[(0,M.jsxs)(`h3`,{children:[d.id,(0,M.jsx)(`i`,{children:d.title})]}),(0,M.jsxs)(`div`,{className:`ov-coc__chips`,children:[(0,M.jsx)(m,{text:d.level,tone:U[d.level]}),(0,M.jsx)(m,{text:d.status,tone:W[d.status]})]}),(0,M.jsxs)(`p`,{className:`ov-coc__sum`,children:[`问题类型 `,_,` · 构件 `,y?y.componentId:d.componentIds.join(`/`),y?(0,M.jsx)(`em`,{children:y.score.toFixed(2)}):null]}),l?(0,M.jsxs)(`dl`,{className:`ov-coc__dl`,children:[(0,M.jsxs)(`div`,{children:[(0,M.jsx)(`dt`,{children:`点位`}),(0,M.jsxs)(`dd`,{children:[d.site,` · `,d.componentIds.join(`/`)]})]}),(0,M.jsxs)(`div`,{children:[(0,M.jsx)(`dt`,{children:`区县`}),(0,M.jsx)(`dd`,{children:f?f.district??f.province??d.district:d.district})]}),(0,M.jsxs)(`div`,{children:[(0,M.jsx)(`dt`,{children:`发现时间`}),(0,M.jsx)(`dd`,{children:d.discoveredAt})]}),(0,M.jsxs)(`div`,{children:[(0,M.jsx)(`dt`,{children:`地图点位`}),(0,M.jsx)(`dd`,{children:f?`${f.name} · ${D[f.status]}（地图上已高亮）`:`该工单未关联地图点位`})]})]}):null,(0,M.jsxs)(`div`,{className:`ov-coc__foot`,children:[(0,M.jsx)(Y,{open:l,moreText:`详情`,onClick:()=>u(e=>!e)}),(0,M.jsxs)(`button`,{type:`button`,className:`btn btn--primary ov-coc__go`,onClick:()=>e(`/orders?order=${d.id}`),children:[`查看工单`,(0,M.jsx)(h,{name:`arrow`})]})]})]})]})}function $(){let[e,t]=(0,j.useState)(!1),[n,r]=(0,j.useState)(!1),i=e?p:p.slice(0,3),a=n?c:c.slice(0,3);return(0,M.jsxs)(E,{title:`待办与最近事件`,className:`ov__panel ov__panel--todo`,children:[(0,M.jsxs)(`h4`,{className:`ov-sec`,children:[`待办事项`,(0,M.jsx)(Y,{open:e,moreText:`共 ${p.length} 项 · 更多`,onClick:()=>t(e=>!e)})]}),(0,M.jsx)(`ul`,{className:`ov-todo`,children:i.map(e=>(0,M.jsx)(`li`,{className:`is-${e.level}`,children:(0,M.jsxs)(`span`,{className:`ov-todo__text`,children:[(0,M.jsxs)(`b`,{children:[e.id,` · `,e.text]}),(0,M.jsxs)(`i`,{children:[e.owner,` · `,e.due.slice(5)]})]})},e.id))}),(0,M.jsxs)(`h4`,{className:`ov-sec`,children:[`最近事件`,(0,M.jsx)(Y,{open:n,moreText:`共 ${c.length} 条 · 更多`,onClick:()=>r(e=>!e)})]}),(0,M.jsx)(`ol`,{className:`ov-events`,children:a.map(e=>(0,M.jsxs)(`li`,{children:[(0,M.jsx)(`time`,{children:e.at}),e.text]},e.at+e.text))}),(0,M.jsxs)(`div`,{className:`ov-stats`,children:[(0,M.jsxs)(`span`,{children:[`历史风险`,(0,M.jsx)(`b`,{children:d.total})]}),(0,M.jsxs)(`span`,{children:[`已关闭`,(0,M.jsx)(`b`,{className:`is-ok`,children:d.closed})]}),(0,M.jsxs)(`span`,{children:[`未关闭`,(0,M.jsx)(`b`,{className:`is-danger`,children:d.open})]})]})]})}function ee(){let e=w(e=>e.mode),t=w(e=>e.transitioning),{currentOrder:n,toast:r}=l(),i=(0,j.useCallback)(()=>x(`shanghai`),[]),a=(0,j.useCallback)(()=>x(`china`),[]),o=e===`shanghai`?C:v,s=(0,j.useMemo)(()=>y(o),[o]),c=(0,j.useMemo)(()=>g(o),[o]);return(0,M.jsxs)(`div`,{className:`ov`,children:[(0,M.jsx)(`div`,{className:`ov__map`,children:(0,M.jsx)(A,{mode:e})}),(0,M.jsx)(`div`,{className:`ov__vignette`}),(0,M.jsx)(B,{}),(0,M.jsxs)(`div`,{className:`ov__side ov__side--left`,children:[(0,M.jsx)(X,{}),(0,M.jsx)(Z,{})]}),(0,M.jsxs)(`div`,{className:`ov__side ov__side--right`,children:[(0,M.jsx)(E,{title:`风险与工单`,className:`ov__panel`,children:(0,M.jsx)(Q,{})}),(0,M.jsx)($,{})]}),(0,M.jsxs)(`div`,{className:`ov__crumb`,children:[(0,M.jsx)(`button`,{type:`button`,className:e===`china`?`is-current`:``,onClick:a,children:`全国总览`}),(0,M.jsx)(`button`,{type:`button`,className:e===`shanghai`?`is-current`:``,onClick:i,children:`上海市`})]}),(0,M.jsxs)(`div`,{className:`ov__actions`,children:[(0,M.jsxs)(q,{className:`legend`,title:`${e===`shanghai`?`上海市`:`全国`}勘察检测点位 ${c.total} 处`,children:[(0,M.jsxs)(`span`,{children:[`勘察检测点位 `,(0,M.jsx)(`b`,{children:c.total})]}),s.map(e=>(0,M.jsxs)(`span`,{title:O[e],children:[(0,M.jsx)(`i`,{style:{background:k[e]}}),D[e],(0,M.jsx)(`b`,{children:c.byStatus[e]})]},e))]}),(0,M.jsxs)(`button`,{type:`button`,className:`btn btn--primary`,disabled:t,onClick:()=>{e===`china`?(i(),r(`镜头推进中，进入上海市区级地图`,`info`)):(a(),r(`返回全国总览`,`info`))},children:[e===`china`?`进入上海`:`返回全国`,(0,M.jsx)(h,{name:`arrow`})]})]}),(0,M.jsxs)(`div`,{className:`ov__hint`,children:[(0,M.jsx)(h,{name:`pin`}),` 点击点位查看工单与勘察记录`]}),(0,M.jsxs)(`footer`,{className:`ov__foot`,children:[(0,M.jsx)(`span`,{className:`ov__motto`,children:V}),(0,M.jsxs)(`span`,{children:[`数据源 `,n.sourceMode===`replay`?`演示回放`:n.sourceMode,` · 地图版本 `,J]}),(0,M.jsxs)(`span`,{children:[`实时位置 `,H.lat.toFixed(4),`°N `,H.lon.toFixed(4),`°E`]})]})]})}export{ee as default};