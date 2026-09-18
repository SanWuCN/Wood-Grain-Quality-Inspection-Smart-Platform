/**
 * 现场环境（`/hardware?tab=env`）· 剧本第一幕的「环境记录页」
 *
 * ── 谁在用这一页 ────────────────────────────────────────────────────
 * 剧本第一幕：史说「平台已关联本次工单。设备页、**环境记录页**和数据接收页准备完成」；
 * 沈让小木「查找一下现场情况，提供近三个月的天气数据，评估该地古建可能存在的风险」；
 * 小木「给出本次环境补偿参数建议……显示当前值、建议值与依据」。
 * 三条都落在这一页上，所以它按这个顺序排：现场与工单 → 天气档案 → 风险清单 →
 * 本次读数与校验结论 → 参数建议对照。
 *
 * ── 三条边界（都由结构保证，不靠自觉）──────────────────────────────
 *   1. **只读**：本页没有任何写入口。环境读数的录入与校验只有工单详情页一个入口
 *      （`EnvironmentPanel`），两处都能写同一份草稿必然分叉（服务端按 revision 乐观锁）；
 *   2. **数字只从数据包与服务端来**：天气走 `siteEnvironment.ts` 的数据键，
 *      读数走 `/api/work-orders/{id}` 的 `environment` 实体，本组件不写数值；
 *   3. **不联网**：来源栏固定写「归档天气档案 · 当前未启用联网查询」——
 *      纯内网演示下不允许出现公网请求，也不允许把归档写成"实时"。
 *
 * ── 为什么挂在「硬件详情」下 ────────────────────────────────────────
 * PRD 2.2 的一级导航是**八项**且不许加第九项（`design.ts` 与 `Header.tsx` 都注明）；
 * 而剧本把「设备页、环境记录页、数据接收页」放在同一句里说 —— 与平台现有的
 * 「硬件详情 → 采集作业 / 异常排查 / 硬件监看 / 设备接入」是同一组东西，
 * 所以按既有页签的样式接在这里，导航项数量与风格都不动。
 */

import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import { Panel } from "../Panel";
import { Icon } from "../icons";
import { DataTable, KV, StateBlock, StatusChip } from "../ui";
import type { EnvironmentView } from "../api/client";
import { commissionBinding } from "../commissionBinding";
import { isOnline, useSharedStore } from "../store/shared";
import { useWorkOrderStore } from "../store/workOrders";
import {
  compensationCompare,
  currentEnvReadings,
  humidityPrior,
  orderSiteRows,
  riskChecklist,
  weatherCategories,
  weatherSource,
} from "./siteEnvironmentData";
import "./siteEnvironment.css";

export function SiteEnvironmentTab() {
  const [params, setParams] = useSearchParams();

  const orders = useWorkOrderStore((state) => state.orders);
  const detail = useWorkOrderStore((state) => state.detail);
  const online = useSharedStore(isOnline);

  /* 未登录 / 刚进页面时那一次刷新会拿到 401，登录完成后再补一次（与工单页同一口径） */
  useEffect(() => {
    if (!online) return;
    void useWorkOrderStore.getState().refresh();
  }, [online]);

  /**
   * 选哪张工单：`?order=` 显式指定 → **已绑定**的那张（点通知查看时绑上的）
   * → 列表最新一张。前两级与 `agent/executor.ts` 的 `scriptEntities()` 同一优先级，
   * 于是"小木读哪张单"和"这一页显示哪张单"不会各说一套（防幻觉规则 3）。
   */
  const paramOrder = params.get("order");
  const activeId = useMemo(() => {
    const list = orders.map((item) => item.id);
    const byParam = paramOrder && list.includes(paramOrder) ? paramOrder : null;
    const bound = commissionBinding.get();
    return byParam ?? (bound && list.includes(bound) ? bound : (orders[0]?.id ?? null));
  }, [orders, paramOrder]);

  useEffect(() => {
    if (!activeId) return;
    if (detail?.order.id === activeId) return;
    void useWorkOrderStore.getState().select(activeId);
  }, [activeId, detail?.order.id]);

  const shown = detail && detail.order.id === activeId ? detail : null;
  const env: EnvironmentView | null = shown?.environment ?? null;

  const source = weatherSource();
  const categories = weatherCategories();
  const risks = riskChecklist();
  const current = currentEnvReadings(env);
  const advice = compensationCompare(env);
  const prior = humidityPrior();

  const selectOrder = (orderId: string) => {
    const next = new URLSearchParams(params);
    next.set("order", orderId);
    next.set("tab", "env");
    setParams(next, { replace: true });
  };

  return (
    <>
      <Panel
        title="现场与工单"
        icon="nav-orders"
        extra={
          shown ? (
            <span className="se-pick">
              <StatusChip text={shown.order.status} tone="info" />
              <select
                aria-label="切换工单"
                value={shown.order.id}
                onChange={(event) => selectOrder(event.target.value)}>
                {orders.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.orderNo} · {item.location}
                  </option>
                ))}
              </select>
            </span>
          ) : (
            <StatusChip text={online ? "未选中工单" : "未连接共享服务"} tone={online ? "muted" : "warn"} />
          )
        }>
        {shown ? (
          <KV columns={4} items={orderSiteRows(shown)} />
        ) : (
          <StateBlock
            kind={online ? "empty" : "offline"}
            title={online ? "当前没有可关联的工单" : "未连接共享服务"}
            hint={
              online
                ? "现场环境按工单绑定地点与日期；先按 Ctrl+Q+L 建单，或到工单档案里选中一张。"
                : "这一页的读数与参数都来自服务端工单实体，连上共享服务后自动出现。"
            }
          />
        )}
      </Panel>

      <Panel
        title={`近三个月天气档案 · ${source.range}`}
        icon="nav-report"
        extra={
          <span className="se-source" title={source.note}>
            <Icon name="asset-file" size={16} aria-hidden />
            {source.source}
          </span>
        }>
        <div className="se-weather">
          {categories.map((category) => (
            <section key={category.key} className={`se-weather__card se-weather__card--${category.key}`}>
              <header>
                <b>{category.title}</b>
                <small>{category.rows.length} 项</small>
              </header>
              <dl>
                {category.rows.map((row) => (
                  <div key={row.key}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
              {category.risks.length ? (
                <ul className="se-risks" aria-label={`${category.title}类风险项`}>
                  {category.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
        <p className="note">{source.note}</p>
      </Panel>

      <Panel
        title="该地古建可能存在的风险 · 建议优先检查项"
        icon="status-warning"
        extra={<StatusChip text={`${risks.length} 项`} tone="warn" />}>
        {/* 只列"优先检查什么"与依据来自哪一类档案，不下"哪里有病害"的判断（那是精扫与复核的事） */}
        <DataTable
          head={["优先检查项", "依据", "本轮安排"]}
          rows={risks.map((risk) => [
            risk.item,
            risk.from,
            risk.item.includes("返潮") || risk.item.includes("含水率")
              ? "环境记录 + 表面影像"
              : "表面影像 + 重点测区精扫",
          ])}
        />
        <p className="note">
          风险项由归档天气档案的四类指标推导，属**采集条件**层面的提示；是否形成病害，
          以现场实测与后续精扫结果为准。
        </p>
      </Panel>

      <Panel
        title="本次环境读数与校验结论"
        icon="biz-multimodal"
        extra={
          current.configVersion ? (
            <StatusChip text={`已生成 ${current.configVersion}`} tone="ok" />
          ) : (
            <StatusChip text="未生成配置版本" tone="muted" />
          )
        }>
        {current.state === "recorded" ? (
          <ul className="se-readings">
            {current.readings.map((row) => (
              <li key={row.key}>
                <small>{row.label}</small>
                <b>{row.value}</b>
              </li>
            ))}
          </ul>
        ) : (
          <StateBlock
            kind="empty"
            title="本次工单还没有环境读数"
            hint="读数在工单详情页的「环境记录与配置校验」里录入 —— 本页只做核对与展示，不重复一个写入口。"
          />
        )}
        <KV columns={4} items={current.meta} />
        {current.checks.length ? (
          <ul className="se-checks">
            {current.checks.map((check) => (
              <li key={check.key} className={check.ok ? "is-ok" : "is-bad"}>
                <Icon name={check.ok ? "status-success" : "status-warning"} size={16} aria-hidden />
                <span>{check.label}</span>
                <em>{check.message}</em>
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">尚无校验结论：草稿 rev {current.draftRevision}，运行校验后生成配置版本。</p>
        )}
      </Panel>

      <Panel
        title="环境补偿参数建议"
        icon="action-settings"
        extra={
          advice.state === "ready" ? (
            <StatusChip text={advice.methodVersion ?? "已校验"} tone="ok" />
          ) : (
            <StatusChip text="待核验" tone="warn" />
          )
        }>
        <DataTable
          head={["参数", "当前录入（草稿）", "已校验配置版本", "依据"]}
          rows={advice.rows}
          empty="尚未录入任何读数"
          emptyHint="先录入读数并运行校验，这里才会给出对照。"
        />
        <p className="note">{advice.note}</p>
        <p className="note">
          {prior.model}：{prior.note}
          {prior.windNote}
        </p>
        <p className="note">
          {current.configValidatedAt
            ? `配置版本 ${current.configVersion} 生成于 ${current.configValidatedAt}。`
            : "该工单尚未生成配置版本。"}
        </p>
      </Panel>

      {/* 本页是只读页：写入口只有一个（工单详情），说清这一点免得现场在这里找按钮 */}
      <p className="se-tip">
        <Icon name="biz-manual-mark" size={16} aria-hidden />
        本页只读：环境读数的录入与校验在「工单档案 → 环境记录与配置校验」，两处不重复写同一份草稿。
      </p>
    </>
  );
}

export default SiteEnvironmentTab;
