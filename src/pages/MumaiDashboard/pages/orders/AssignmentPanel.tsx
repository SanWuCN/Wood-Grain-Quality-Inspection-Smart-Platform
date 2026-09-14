/**
 * 负责人及参与人员（PRD-工单指派与扫描仪下发-v1.0 §5.1 第 3 项 / §6）
 *
 * 只做展示与交互：写操作通过 `onAssign` 抛给调用方，本组件不 import 页面上下文、
 * 不直接调接口 —— 权限判定、并发版本（expectedRevision）与错误提示都由父组件负责。
 *
 * 三条口径（PRD 点名的验收项）：
 *   · 界面只显示岗位与非实名编号，不出现真实姓名；数据里也只有 label（A08）。
 *   · 指派入口只对项目经理出现（`capabilities.canAssign`，§6.2）；其他账号看到的是一行
 *     「仅项目经理可指派」，而不是一个点不动的灰按钮。
 *   · 未指派员工提示「尚未指派到此工单」，不获得本单写权限（§6.1 / A03）。
 *
 * 页面文案只留「标签 + 值 + 按钮 + 状态」：解释性小字不进 UI，空态只留一行标题
 * （StateBlock 不给 hint 会掉进 ui.tsx 的兜底解释句，所以显式传空串）。
 */

import { useState } from "react";
import { Panel } from "../../Panel";
import { Btn, KV, Modal, StateBlock, StatusChip } from "../../ui";
import type { AssignmentCandidate, WorkOrderDetail } from "../../api/client";
import "./orders.css";

/** 提交体：与服务端 `PUT /api/work-orders/:id/assignment` 一一对应 */
type AssignmentBody = {
  leaderAccountId: string;
  members: { accountId: string; duties: string[] }[];
  expectedRevision: number;
};

type AssignRoleGroup = { roleCode: string; label: string; candidates: AssignmentCandidate[] };

/**
 * 候选项按 `roleCode` 分组。
 *
 * 候选结构里只有 roleCode 与 displayLabel（岗位 + 「· 01」编号），没有中文岗位名，
 * 所以组标题从 `detail.accounts`（服务端的岗位清单）里取；取不到就退回 roleCode，
 * 不编一个中文名出来。
 */
function groupCandidates(candidates: AssignmentCandidate[], roleLabels: Map<string, string>): AssignRoleGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, AssignmentCandidate[]>();
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.roleCode);
    if (bucket) bucket.push(candidate);
    else {
      buckets.set(candidate.roleCode, [candidate]);
      order.push(candidate.roleCode);
    }
  }
  return order.map((roleCode) => ({
    roleCode,
    label: roleLabels.get(roleCode) ?? roleCode,
    candidates: buckets.get(roleCode) ?? [],
  }));
}

export function AssignmentPanel({
  detail,
  busy,
  onAssign,
}: {
  detail: WorkOrderDetail;
  busy: boolean;
  onAssign: (body: AssignmentBody) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const assignment = detail.assignment;
  const canAssign = detail.capabilities.canAssign;
  /*
    服务端在每次指派时都会把负责人也写进成员表（负责人按其岗位拿默认职责），
    所以成员列表里必然含负责人本人 —— 展示与勾选都要把他排除，否则同一个人出现两次。
  */
  const participants = (assignment?.members ?? []).filter(
    (member) => member.accountId !== assignment?.leaderAccountId,
  );
  const leaderDuties =
    (assignment?.members ?? []).find((member) => member.accountId === assignment?.leaderAccountId)?.duties ?? [];
  /** 未指派员工（非项目经理）才提示「尚未指派到此工单」：项目经理看到的是「尚未指派负责人」+ 指派入口 */
  const showNotAssigned = !detail.capabilities.assigned && !canAssign;

  return (
    <Panel
      title="负责人及参与人员"
      icon="identity-user"
      extra={<StatusChip text={assignment ? "已指派" : "待指派"} tone={assignment ? "ok" : "warn"} />}>
      {assignment ? (
        <>
          <KV
            columns={3}
            items={[
              { k: "指派时间", v: assignment.assignedAt },
              { k: "指派操作者岗位", v: assignment.assignedByLabel },
              { k: "指派版本", v: `rev ${assignment.revision}` },
            ]}
          />
          <h4 className="sub">负责人</h4>
          <ul className="wo-people">
            <li>
              <b>{assignment.leaderLabel}</b>
              <small>负责人</small>
              <span className="wo-tags">
                {leaderDuties.length ? (
                  leaderDuties.map((duty) => (
                    <span key={duty.code} className="wo-tag">
                      {duty.label}
                    </span>
                  ))
                ) : (
                  <span className="wo-tag wo-tag--none">未登记职责</span>
                )}
              </span>
            </li>
          </ul>

          <h4 className="sub">参与人员</h4>
          {participants.length ? (
            <ul className="wo-people">
              {participants.map((member) => (
                <li key={member.accountId}>
                  <b>{member.label}</b>
                  <span className="wo-tags">
                    {member.duties.length ? (
                      member.duties.map((duty) => (
                        <span key={duty.code} className="wo-tag">
                          {duty.label}
                        </span>
                      ))
                    ) : (
                      <span className="wo-tag wo-tag--none">未分配职责</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <StateBlock kind="empty" title="暂无参与人员" hint="" />
          )}
        </>
      ) : (
        <StateBlock kind="empty" title="尚未指派负责人" hint="" />
      )}

      {showNotAssigned ? <StateBlock kind="empty" title="尚未指派到此工单" hint="" /> : null}

      <div className="wo-actions">
        {canAssign ? (
          <Btn tone={assignment ? "default" : "primary"} disabled={busy} onClick={() => setOpen(true)}>
            {assignment ? "调整指派" : "指派人员"}
          </Btn>
        ) : (
          <small className="muted">仅项目经理可指派</small>
        )}
      </div>

      {open ? (
        <AssignModal detail={detail} busy={busy} onAssign={onAssign} onClose={() => setOpen(false)} />
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 指派弹窗（二级）：负责人 + 参与人员 + 每人职责
 *
 * 只在打开时挂载，因此表单初值直接取当前 detail —— 不需要「props 变了再同步」
 * 那种容易把用户正在改的勾选冲掉的 effect。
 * ------------------------------------------------------------------ */

function AssignModal({
  detail,
  busy,
  onAssign,
  onClose,
}: {
  detail: WorkOrderDetail;
  busy: boolean;
  onAssign: (body: AssignmentBody) => Promise<void>;
  onClose: () => void;
}) {
  const assignment = detail.assignment;
  const roleLabels = new Map(detail.accounts.map((group) => [group.roleCode, group.label]));
  const groups = groupCandidates(detail.assignmentCandidates, roleLabels);
  const existing = new Map((assignment?.members ?? []).map((member) => [member.accountId, member]));
  const candidateIds = new Set(detail.assignmentCandidates.map((candidate) => candidate.accountId));

  const [leaderId, setLeaderId] = useState(assignment?.leaderAccountId ?? "");
  const [checked, setChecked] = useState<string[]>(() =>
    (assignment?.members ?? [])
      .filter((member) => member.accountId !== assignment?.leaderAccountId && candidateIds.has(member.accountId))
      .map((member) => member.accountId),
  );
  const [duties, setDuties] = useState<Record<string, string[]>>(() =>
    Object.fromEntries((assignment?.members ?? []).map((member) => [member.accountId, member.duties.map((d) => d.code)])),
  );
  const [submitting, setSubmitting] = useState(false);

  const pending = busy || submitting;
  /** 负责人不在参与人员里重复勾选（服务端也会去重，负责人按其岗位取默认职责） */
  const selected = checked.filter((accountId) => accountId !== leaderId);
  const missingDuties = selected.filter((accountId) => (duties[accountId] ?? []).length === 0);
  /**
   * 已有成员里不在当前候选名单里的账号：界面无从渲染，也不能因此卡住提交。
   * 它们原样带回提交（不静默删除历史参与关系），职责沿用当前值。
   */
  const carried = (assignment?.members ?? []).filter(
    (member) => member.accountId !== assignment?.leaderAccountId && !candidateIds.has(member.accountId),
  );

  /**
   * 职责候选项 = 该岗位的建议职责 ∪ 该账号当前已有的职责。
   *
   * 取并集是为了「可改但不丢」：项目经理上一轮给某人加过非常规职责时，
   * 重新打开弹窗仍能看到并保留它，而不是被建议列表静默删掉。
   */
  const dutyOptions = (candidate: AssignmentCandidate) => {
    const options = new Map(candidate.suggestedDuties.map((duty) => [duty.code, duty.label]));
    for (const duty of existing.get(candidate.accountId)?.duties ?? []) {
      if (!options.has(duty.code)) options.set(duty.code, duty.label);
    }
    return [...options].map(([code, label]) => ({ code, label }));
  };

  const toggleMember = (candidate: AssignmentCandidate, next: boolean) => {
    setChecked((current) =>
      next ? [...new Set([...current, candidate.accountId])] : current.filter((id) => id !== candidate.accountId),
    );
    if (next) {
      // 首次勾选时带上建议职责；之后用户改过的不覆盖
      setDuties((current) =>
        current[candidate.accountId]
          ? current
          : { ...current, [candidate.accountId]: candidate.suggestedDuties.map((duty) => duty.code) },
      );
    }
  };

  const toggleDuty = (accountId: string, code: string, next: boolean) => {
    setDuties((current) => {
      const list = current[accountId] ?? [];
      return { ...current, [accountId]: next ? [...new Set([...list, code])] : list.filter((item) => item !== code) };
    });
  };

  const blockedReason = !leaderId
    ? "请先选择负责人"
    : missingDuties.length
      ? "每位参与人员至少选择一项职责"
      : null;

  const submit = async () => {
    if (blockedReason) return;
    setSubmitting(true);
    try {
      await onAssign({
        leaderAccountId: leaderId,
        members: [
          ...selected.map((accountId) => ({ accountId, duties: duties[accountId] ?? [] })),
          ...carried.map((member) => ({ accountId: member.accountId, duties: member.duties.map((duty) => duty.code) })),
        ],
        expectedRevision: assignment?.revision ?? 0,
      });
    } catch {
      // 错误由父组件显示在别处；这里保持弹窗打开，已填的指派不丢（PRD §6.3 冲突要能重试）
      setSubmitting(false);
      return;
    }
    onClose();
  };

  return (
    <Modal
      wide
      title={assignment ? "调整指派" : "指派人员"}
      subtitle={`${detail.order.orderNo} · ${assignment ? `当前指派版本 rev ${assignment.revision}` : "首次指派"}`}
      onClose={onClose}
      footer={
        <Btn
          tone="primary"
          disabled={pending || blockedReason !== null}
          title={blockedReason ?? "提交本次指派"}
          onClick={() => void submit()}>
          确认提交
        </Btn>
      }>
      <div className="wo-form">
        <div className="wo-form__item wo-form__full">
          <span>负责人</span>
          <select
            className="wo-select"
            value={leaderId}
            disabled={pending}
            aria-label="负责人"
            onChange={(event) => setLeaderId(event.target.value)}>
            <option value="">请选择负责人</option>
            {groups.map((group) => (
              <optgroup key={group.roleCode} label={group.label}>
                {group.candidates.map((candidate) => (
                  <option key={candidate.accountId} value={candidate.accountId}>
                    {candidate.displayLabel}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      <h4 className="sub">参与人员与职责</h4>
      <ul className="wo-picker">
        {groups.map((group) => {
          const candidates = group.candidates.filter((candidate) => candidate.accountId !== leaderId);
          if (candidates.length === 0) return null;
          return (
            <li key={group.roleCode} className="wo-picker__group">
              <b>{group.label}</b>
              {candidates.map((candidate) => {
                const isChecked = selected.includes(candidate.accountId);
                const options = dutyOptions(candidate);
                const picked = duties[candidate.accountId] ?? [];
                return (
                  <div key={candidate.accountId} className="wo-picker__row">
                    <label className="wo-check">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={pending}
                        onChange={(event) => toggleMember(candidate, event.target.checked)}
                      />
                      <span>{candidate.displayLabel}</span>
                    </label>
                    {isChecked ? (
                      <div className="wo-duties">
                        {options.length ? (
                          <>
                            {options.map((duty) => {
                              const on = picked.includes(duty.code);
                              return (
                                <label key={duty.code} className="wo-check">
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    disabled={pending}
                                    onChange={(event) => toggleDuty(candidate.accountId, duty.code, event.target.checked)}
                                  />
                                  <span>{duty.label}</span>
                                </label>
                              );
                            })}
                            {/* 校验结论贴在被校验的字段旁：只写一句，不解释后果 */}
                            {picked.length === 0 ? <em className="wo-form__hint">请选择职责</em> : null}
                          </>
                        ) : (
                          <small className="muted">无可选职责</small>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
