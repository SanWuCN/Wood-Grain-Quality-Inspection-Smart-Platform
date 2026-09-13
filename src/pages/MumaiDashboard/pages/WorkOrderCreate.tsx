/**
 * 生成工单 · 二级配置与确认弹窗
 *
 * 用户的要求是「生成工单……点击后优先弹出二级确认/配置窗口，在窗口中完成参数配置、
 * 人员确认和必要签署，一级页面不要为了一个操作动态堆出大量表单」。
 *
 * 所以工单表单在这里：地点与范围、精扫构件、风险等级、负责人、问题来源。
 * 一级页面只有一个「生成工单」按钮，点开是这个弹窗，确认后才落到 orders 列表。
 */

import { useMemo, useState } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Modal } from "../ui";
import { Btn } from "../ui";
import { COMPONENTS, CURRENT_RISKS } from "../seed/scenario";
import { nowStamp } from "../lib";
import type { NewOrderInput } from "../context";
import type { Order } from "../seed/types";

/** 可选站点：与地图点位、历史工单同一套地名，不另编 */
const SITES = [
  { site: "示例寺", district: "上海市松江区", location: "大雄宝殿东次间", scope: "CUR-Z04-01 / CUR-Z04-02 / CUR-Z04-03" },
  { site: "寒山寺", district: "江苏省苏州市", location: "待现场勘察", scope: "待定" },
];

export function WorkOrderCreateModal({
  onClose,
  onConfirm,
  nextId,
}: {
  onClose: () => void;
  onConfirm: (input: NewOrderInput) => Order;
  /** 工单号由调用方按已有列表推导，弹窗不自己编 */
  nextId: string;
}) {
  const [siteIndex, setSiteIndex] = useState(0);
  const [componentIds, setComponentIds] = useState<string[]>(COMPONENTS.map((item) => item.id));
  const [level, setLevel] = useState<Order["level"]>("高风险");
  const [owner, setOwner] = useState("沈 · 项目经理");
  const [riskIds, setRiskIds] = useState<string[]>(CURRENT_RISKS.map((item) => item.id));

  const site = SITES[siteIndex];
  const valid = componentIds.length > 0 && riskIds.length > 0 && site.scope !== "待定";

  /** 工单标题按「站点 + 构件范围 + 主要问题」生成，与既有工单同一读法 */
  const title = useMemo(() => `${site.site}构件内部响应检测与风险复核`, [site.site]);

  return (
    <Modal
      wide
      title="生成工单"
      subtitle={`编号 ${nextId} · 确认后进入待复核`}
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {valid ? (
              <>
                将登记 <NumberAnimation value={componentIds.length} /> 个构件、
                <NumberAnimation value={riskIds.length} /> 条来源风险
              </>
            ) : (
              "构件与来源风险至少各选一项"
            )}
          </span>
          <Btn onClick={onClose}>取消</Btn>
          <Btn
            tone="primary"
            disabled={!valid}
            onClick={() => {
              onConfirm({
                id: nextId,
                title,
                site: site.site,
                district: site.district,
                location: site.location,
                scope: site.scope,
                componentIds,
                owner,
                level,
                sourceRiskIds: riskIds,
                createdAt: nowStamp(),
              });
              onClose();
            }}>
            确认生成
          </Btn>
        </>
      }>
      <label className="field">
        <span>地点</span>
        <select value={siteIndex} onChange={(event) => setSiteIndex(Number(event.target.value))}>
          {SITES.map((item, index) => (
            <option key={item.site} value={index}>
              {item.site} · {item.district}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>复扫构件</span>
        <span className="woc-checks">
          {COMPONENTS.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={componentIds.includes(item.id)}
                onChange={(event) =>
                  setComponentIds((prev) =>
                    event.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id),
                  )
                }
              />
              {item.id} · {item.part}
            </label>
          ))}
        </span>
      </label>

      <label className="field">
        <span>来源风险</span>
        <span className="woc-checks">
          {CURRENT_RISKS.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={riskIds.includes(item.id)}
                onChange={(event) =>
                  setRiskIds((prev) =>
                    event.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id),
                  )
                }
              />
              {item.id} · {item.label}
            </label>
          ))}
        </span>
      </label>

      <label className="field">
        <span>风险等级</span>
        <select value={level} onChange={(event) => setLevel(event.target.value as Order["level"])}>
          <option value="高风险">高风险</option>
          <option value="中风险">中风险</option>
          <option value="低风险">低风险</option>
        </select>
      </label>

      <label className="field">
        <span>负责人</span>
        <select value={owner} onChange={(event) => setOwner(event.target.value)}>
          <option value="沈 · 项目经理">沈 · 项目经理</option>
          <option value="史 · 人工智能架构师">史 · 人工智能架构师</option>
        </select>
      </label>

      <p className="note">
        {site.scope === "待定"
          ? "该站点还没有勘察记录，范围与测区待现场确认后再建单。"
          : `范围 ${site.scope} · 位置 ${site.location}`}
      </p>
    </Modal>
  );
}

export default WorkOrderCreateModal;
