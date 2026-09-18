/**
 * 建图巡航页顶部的「工单派下来的巡航任务」横幅
 *
 * 用户 2026-09-18 口径：「……这边是 shi 派发的，然后 ma 这边接受任务去建图巡航」——
 * 马从工单页点「去建图巡航」跳过来（`/mapping?task=CR-…`），这一条要让他一眼看到
 * 「我接的是哪条任务、来自哪张工单、现在什么状态」，并把接受 / 完成这两个动作
 * 摆在手边（同一套命令，与工单页完全一致）。
 *
 * 两条不能含糊的口径：
 *   · 这条是**平台侧的任务单据**；车端执行仍然在小车自己的建图巡航控制台上做。
 *     小车没给控制令牌（`canControl=false`）时，下面的控制按钮本来就是灰的 ——
 *     横幅不再补一句"已下发到车"，那是平台证明不了的事。
 *   · 任务编号由服务端生成，横幅只显示，不自己编。
 */

import { Btn, StatusChip } from "../../ui";
import type { MissionEntity } from "../../api/client";
import { actorShortName } from "../../api/accounts";
import { cruisePeopleLine, cruiseTimeText, missionStateText, missionStateTone } from "../orders/cruiseTask";

export function CruiseTaskBanner({
  mission,
  linkedTaskNo,
  canDispatch,
  canMonitor,
  busy,
  onAccept,
  onComplete,
  onCancel,
  onOpenOrder,
}: {
  /** 当前进行中的工单巡航任务；没有就是 null（横幅不出现） */
  mission: MissionEntity | null;
  /** URL 上带过来的任务编号（`?task=`）：一致时强调一下，不一致时如实说 */
  linkedTaskNo?: string | null;
  canDispatch: boolean;
  canMonitor: boolean;
  busy: boolean;
  onAccept: () => Promise<void>;
  onComplete: () => Promise<void>;
  onCancel: () => Promise<void>;
  onOpenOrder: (orderId: string) => void;
}) {
  if (!mission) return null;
  const linked = Boolean(linkedTaskNo) && linkedTaskNo === mission.id;
  const mismatch = Boolean(linkedTaskNo) && linkedTaskNo !== mission.id;
  const canAccept = mission.state === "queued" && canDispatch;
  const canComplete = mission.state === "running" && canDispatch;
  const canCancel = ["queued", "running", "paused"].includes(mission.state) && (canMonitor || canDispatch);
  const cartMissionState = mission.state === "queued" ? "还没接受" : mission.state === "running" ? "已接受，等车端执行" : missionStateText(mission.state);

  return (
    <div className={`cruise-banner${linked ? " is-linked" : ""}`}>
      <div className="cruise-banner__main">
        <span className="cruise-banner__tag">工单巡航任务</span>
        <b className="cruise-banner__no">{mission.id}</b>
        <StatusChip text={missionStateText(mission.state)} tone={missionStateTone(mission.state)} />
        <span className="muted">{cartMissionState}</span>
        {mission.orderNo ? (
          <button
            type="button"
            className="cruise-banner__order"
            title="回到这张工单"
            onClick={() => mission.orderId && onOpenOrder(mission.orderId)}>
            来自 {mission.orderNo}
          </button>
        ) : null}
        {linked ? <span className="cruise-banner__hint">这一条就是工单页派给你的任务</span> : null}
        {mismatch ? <span className="cruise-banner__hint is-warn">地址里的任务号 {linkedTaskNo} 不是当前进行中的那条（可能已完成）</span> : null}
      </div>
      <div className="cruise-banner__meta">
        <span>{cruisePeopleLine(mission)}</span>
        <span className="muted">派发 {cruiseTimeText(mission.createdAt)}</span>
        <span className="muted">
          {mission.componentIds?.length ? `巡检构件 ${mission.componentIds.join(" · ")}` : "巡检构件 —"}
          {mission.laps && mission.laps > 1 ? ` · ${mission.laps} 圈` : ""}
        </span>
        <span className="muted">平台侧任务单据；车端执行用下面的建图 / 巡航控制台</span>
      </div>
      <div className="cruise-banner__ops">
        <Btn tone="primary" disabled={busy || !canAccept} title={canAccept ? "接受这条任务" : `当前是「${missionStateText(mission.state)}」`} onClick={() => void onAccept()}>
          接受任务
        </Btn>
        <Btn disabled={busy || !canComplete} title={canComplete ? "车端作业回来后在平台标记完成" : "只有执行中的任务能标记完成"} onClick={() => void onComplete()}>
          标记完成
        </Btn>
        <Btn tone="danger" disabled={busy || !canCancel} title={canCancel ? "撤销这条任务" : "已是终态"} onClick={() => void onCancel()}>
          撤销
        </Btn>
        <span className="muted">{actorShortName(mission.acceptedBy) === "—" ? "等马（具身智能工程师）接受" : `作业人 ${actorShortName(mission.acceptedBy)}`}</span>
      </div>
    </div>
  );
}
