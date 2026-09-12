/**
 * 排练控制台（`/console`）—— PRD §11 / 评审 F12
 *
 * 评审原文：「业务默认从融合阶段开始，缺少可用的统一分段恢复与新一轮隔离」，
 * 要求「新建演示会话从开场开始；设管理员排练控制台，恢复阶段快照」。
 *
 * 这一页只做四件事，每件都在服务端真实发生：
 *   1. **新建演示会话** —— 新 sessionId，上一轮的批次 / 产物 / 回执一条都不会串进来
 *   2. **捕获阶段快照** —— 把当前整场实体存一份，记下是谁在什么时候存的
 *   3. **恢复阶段快照** —— 排练走岔了退回去；历史事件流不动（PRD §11：不篡改历史）
 *   4. **导出诊断包** —— 会话 + 实体 + 快照 + 事件 + 预检，一份 JSON
 *
 * 刻意不放的东西：适配器切换、单任务重放、真实设备控制重置。
 * 这三件都需要尚不存在的设备适配器，摆一个点了没反应的按钮比不摆更糟
 * （评审反复强调「成功反馈必须对应实际动作」）。缺什么就写在页面下方。
 */

import { useCallback, useEffect, useState } from "react";
import { Panel } from "../Panel";
import { Btn, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import { api, isApiError, type RehearsalOverview } from "../api/client";
import { isOnline, useSharedStore } from "../store/shared";
import { useMumai } from "../context";
import { actorName } from "../api/accounts";

export default function Console() {
  const { toast } = useMumai();
  const online = useSharedStore(isOnline);
  const currentSessionId = useSharedStore((state) => state.sessionId);
  const [overview, setOverview] = useState<RehearsalOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState("P11");
  const [label, setLabel] = useState("");

  const refresh = useCallback(async () => {
    if (!online) return;
    try {
      setOverview(await api.consoleOverview(currentSessionId));
    } catch {
      /* 顶栏与状态块已经会说明连接问题，这里不重复报 */
    }
  }, [currentSessionId, online]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 统一包一层：忙态、错误提示、成功后重拉，避免三处各写一遍 */
  const run = useCallback(
    async (key: string, action: () => Promise<string>) => {
      setBusy(key);
      try {
        toast(await action(), "ok");
        await refresh();
      } catch (error) {
        toast(isApiError(error) ? error.message : "操作失败", "danger");
      } finally {
        setBusy(null);
      }
    },
    [refresh, toast],
  );

  const newSession = () =>
    run("new-session", async () => {
      const result = await api.consoleNewSession();
      return `已新建 ${result.session.id}（${result.entityCount} 个实体），从开场状态开始`;
    });

  const capture = () =>
    run("capture", async () => {
      const snapshot = await api.consoleCapture(currentSessionId, stage, label);
      setLabel("");
      return `已捕获快照「${snapshot.label}」（${snapshot.entityCount} 个实体）`;
    });

  const restore = (snapshotId: string, snapshotLabel: string) =>
    run(`restore:${snapshotId}`, async () => {
      const result = await api.consoleRestore(currentSessionId, snapshotId);
      return `已恢复到「${snapshotLabel}」：${result.restored} 个实体回到 ${result.stage}`;
    });

  const remove = (snapshotId: string) =>
    run(`delete:${snapshotId}`, async () => {
      await api.consoleDeleteSnapshot(currentSessionId, snapshotId);
      return "快照已删除";
    });

  const exportDiagnostics = () =>
    run("diagnostics", async () => {
      const bundle = await api.consoleDiagnostics(currentSessionId);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `诊断包_${currentSessionId}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      const counts = bundle as { entities?: unknown[]; events?: unknown[]; snapshots?: unknown[] };
      return `诊断包已导出（实体 ${counts.entities?.length ?? 0} / 事件 ${counts.events?.length ?? 0} / 快照 ${counts.snapshots?.length ?? 0}）`;
    });

  const preflight = overview?.preflight;

  return (
    <div className="page page--console">
      <Toolbar
        note={
          <>
            <SourceTag label="管理员排练控制" />
            <span>新建会话与回滚快照都会写进事件流；历史事件不会被抹掉</span>
          </>
        }>
        <Btn tone="primary" disabled={!online || busy !== null} onClick={() => void newSession()}>
          {busy === "new-session" ? "新建中…" : "新建演示会话"}
        </Btn>
        <Btn disabled={!online || busy !== null} onClick={() => void exportDiagnostics()}>
          {busy === "diagnostics" ? "导出中…" : "导出诊断包"}
        </Btn>
        <Btn disabled={!online || busy !== null} onClick={() => void refresh()}>
          重新读取
        </Btn>
      </Toolbar>

      {online ? null : (
        <StateBlock
          kind="offline"
          title="未连接共享服务"
          hint="排练控制台要读写服务端的会话与快照，连接恢复后本页自动可用。"
        />
      )}

      <div className="cs-layout">
        <Panel title="演示会话" extra={<span className="muted">{overview?.sessions.length ?? 0} 场</span>}>
          <ul className="cs-sessions">
            {(overview?.sessions ?? []).map((session) => (
              <li key={session.id} className={session.id === currentSessionId ? "is-current" : ""}>
                <b>{session.id}</b>
                <span>
                  场景 {session.scenarioId} · 阶段 {session.stage} · 实体 {session.entityCount} · 事件 {session.lastSeq}
                </span>
                <em>建立于 {session.createdAt.slice(0, 19).replace("T", " ")}</em>
                {session.id === currentSessionId ? <StatusChip text="当前会话" tone="ok" /> : null}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="阶段快照" extra={<span className="muted">{overview?.snapshots.length ?? 0} 个</span>}>
          <div className="cs-capture">
            <label>
              阶段
              <select value={stage} onChange={(event) => setStage(event.target.value)}>
                {(overview?.stages ?? []).map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              备注
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="例如：P05 巡检已下发"
              />
            </label>
            <Btn disabled={!online || busy !== null} onClick={() => void capture()} title="把当前整场实体存一份">
              {busy === "capture" ? "捕获中…" : "捕获当前状态"}
            </Btn>
          </div>

          {overview?.snapshots.length ? (
            <ul className="cs-snapshots">
              {overview.snapshots.map((snapshot) => (
                <li key={snapshot.id}>
                  <b>{snapshot.label}</b>
                  <span>
                    {snapshot.stage} · {snapshot.entityCount} 个实体 · {actorName(snapshot.createdBy)}
                  </span>
                  <em>{snapshot.createdAt.slice(0, 19).replace("T", " ")}</em>
                  <span className="cs-snapshots__ops">
                    <Btn
                      disabled={!online || busy !== null}
                      title="把整场实体换回这份快照；历史事件流不动"
                      onClick={() => void restore(snapshot.id, snapshot.label)}>
                      {busy === `restore:${snapshot.id}` ? "恢复中…" : "恢复"}
                    </Btn>
                    <Btn disabled={!online || busy !== null} onClick={() => void remove(snapshot.id)}>
                      删除
                    </Btn>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <StateBlock kind="empty" title="还没有快照" hint="排练走到一个稳定阶段时捕获一份。" />
          )}
        </Panel>

        <Panel
          title="启动预检"
          extra={preflight ? <StatusChip text={preflight.ok ? "全部通过" : "有未通过项"} tone={preflight.ok ? "ok" : "warn"} /> : null}>
          {preflight ? (
            <ul className="cs-preflight">
              {preflight.items.map((item) => (
                <li key={item.key} className={item.pass ? "is-ok" : "is-bad"}>
                  <b>{item.label}</b>
                  <span>{item.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <StateBlock kind="empty" title="尚未读取预检" />
          )}
        </Panel>
      </div>
    </div>
  );
}
