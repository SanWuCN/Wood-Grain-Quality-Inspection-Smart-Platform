/**
 * 数字孪生 · 「证据对照」主视图（剧本 ㉒ 的屏幕落点）
 *
 * ── 用户口径（2026-10-01）────────────────────────────────────────────
 * 「证据对照已打开。两路共同提示的项目优先展示，结果不一致或资料不齐的项目已列入补核清单。
 *   这个对话，还是要做具体的东西，而不只是跳转」。
 * 所以这一屏把"对照"这两个字画出来：**左边视觉、右边雷达、中间凭什么算一致**，
 * 下面是补核清单与资料完整性；每行都带出处（标注框号 / 响应段号 / 图片文件名）。
 *
 * 数据全部来自 `twinEvidence.ts`（它只读 `FUSION_RECORD` / `CURRENT_RISKS`，
 * 一条都不编）；本组件只负责画，并且**不自己算结论**。
 */

import { Panel } from "../Panel";
import { Btn } from "../ui";
import { evidenceCrossCheck, evidenceModel, evidenceRules } from "./twinEvidence";
import "./twinEvidence.css";

export type TwinEvidenceViewProps = {
  /** 点「看内部点云」时切到内部点云那一屏（由 Twin 传入） */
  onOpenInternalCloud?: () => void;
  /** 点某一行的构件时告诉页面（页面据此选中构件） */
  onPickRisk?: (riskId: string) => void;
};

export function TwinEvidenceView({ onOpenInternalCloud, onPickRisk }: TwinEvidenceViewProps) {
  const model = evidenceModel();
  const rules = evidenceRules();
  const cross = evidenceCrossCheck();
  const incomplete = model.completeness.filter((item) => !item.ok);

  return (
    <div className="evd">
      <Panel
        title="两路共同提示（优先展示）"
        extra={
          <span className="muted">
            融合记录 {model.recordId} · 规则 {model.ruleVersion} · 批次 {model.batchId} · 测区 {model.zone}
          </span>
        }>
        <table className="evd__table">
          <thead>
            <tr>
              <th>项目</th>
              <th>视觉标注（图像）</th>
              <th>雷达响应（同测区）</th>
              <th>为什么算一致</th>
              <th>结论</th>
            </tr>
          </thead>
          <tbody>
            {model.priority.map((row) => (
              <tr key={row.riskId}>
                <td>
                  <button type="button" className="evd__risk" onClick={() => onPickRisk?.(row.riskId)}>
                    <b>{row.riskId}</b>
                    <span>{row.label}</span>
                  </button>
                </td>
                <td>
                  <b>{row.visual.boxId}</b>
                  <span>{row.visual.image}</span>
                  <em>
                    {row.visual.label} · 置信度 {row.visual.confidence.toFixed(2)}
                  </em>
                </td>
                <td>
                  <b>{row.radar.segment}</b>
                  <em>
                    幅值 {row.radar.amplitude.toFixed(2)} · 质量 {row.radar.quality}
                  </em>
                </td>
                <td>
                  <span>{row.rule}</span>
                  <em>{row.basis}</em>
                </td>
                <td>
                  <span className="evd__verdict is-priority">{row.verdict}</span>
                  <em>{row.nextAction}</em>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title={`补核清单（${model.supplement.length} 项）`}
        extra={<span className="muted">结果不一致或资料不齐的项目；不把两路置信度相加</span>}>
        {incomplete.length ? (
          <p className="evd__incomplete">
            资料不齐：{incomplete.map((item) => `${item.label} ${item.value}`).join("；")}
          </p>
        ) : null}
        <ul className="evd__supplement">
          {model.supplement.map((row, index) => (
            <li key={row.riskId}>
              <button type="button" className="evd__risk" onClick={() => onPickRisk?.(row.riskId)}>
                <b>{row.riskId}</b>
                <span>{row.label}</span>
              </button>
              <dl>
                <div>
                  <dt>视觉</dt>
                  <dd>
                    {row.visual.boxId} · {row.visual.image} · 置信度 {row.visual.confidence.toFixed(2)}
                  </dd>
                </div>
                <div>
                  <dt>雷达</dt>
                  <dd>
                    {row.radar.segment} · 幅值 {row.radar.amplitude.toFixed(2)} · 质量 {row.radar.quality}
                  </dd>
                </div>
                <div>
                  <dt>为什么补</dt>
                  <dd>{model.supplementReasons[index] ?? row.basis}</dd>
                </div>
                <div>
                  <dt>下一步</dt>
                  <dd>{row.nextAction}</dd>
                </div>
              </dl>
            </li>
          ))}
          {model.supplement.length === 0 ? <li className="muted">当前没有需要补核的项目</li> : null}
        </ul>
      </Panel>

      <div className="evd__two">
        <Panel title="资料完整性" extra={<span className="muted">两路能不能放在一起比的前提</span>}>
          <ul className="evd__complete">
            {model.completeness.map((item) => (
              <li key={item.label} className={item.ok ? "" : "is-bad"}>
                <b>{item.label}</b>
                <span>{item.value}</span>
                <em>{item.note}</em>
              </li>
            ))}
          </ul>
          <ul className="evd__branches">
            {model.branches.map((branch) => (
              <li key={branch.key} className={branch.state === "合格" ? "" : "is-bad"}>
                <b>{branch.label}</b>
                <span>{branch.state}</span>
                <em>{branch.detail}</em>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="判定规则" extra={<span className="muted">融合是规则判定，不做分数相加</span>}>
          <ul className="evd__rules">
            {rules.map((rule) => (
              <li key={rule.key}>
                <b>{rule.label}</b>
                <span>{rule.result}</span>
                <em>{rule.note}</em>
              </li>
            ))}
          </ul>
          <p className="evd__cross">
            与风险记录交叉核对：本轮优先复核 {cross.priorityInEvidence} 项 · 风险记录里 {cross.priorityInRisks} 项
            {cross.consistent ? "（一致）" : "（不一致，需要人工核对）"}
          </p>
          {onOpenInternalCloud ? (
            <Btn onClick={onOpenInternalCloud}>看内部点云（两路汇到的那一层）</Btn>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
