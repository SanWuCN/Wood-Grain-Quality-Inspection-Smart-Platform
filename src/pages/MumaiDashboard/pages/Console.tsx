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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Panel } from "../Panel";
import { Btn, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import {
  api,
  isApiError,
  type LanPeers,
  type RehearsalOverview,
  type SyncProbe,
  type WriteLogPage,
} from "../api/client";
import { agentTurns, isOnline, useSharedStore } from "../store/shared";
import { useMumai } from "../context";
import { actorName } from "../api/accounts";
import { addressGroups, endRows, hostOf, isLocalHost, probeVerdict, recommendedUrl, serverLine } from "./collabLogic";
import { followEnabled, setFollowEnabled } from "../agent/roundSync";
import { roundSyncView, selfEndIds } from "../lib/lanRoundSync";

/** 内网端数多久读一次：它是本页唯一会"自己变"的读数（别人开关页面） */
const PEERS_POLL_MS = 10000;
/**
 * 复制到剪贴板（**内网 http 下也能用**）。
 *
 * `navigator.clipboard` 与 `crypto.randomUUID` 一样**只在安全上下文**
 * （https / localhost）里存在 —— 同事从 `http://<局域网IP>:8000` 打开时它是 undefined，
 * 原来那句 `navigator.clipboard?.writeText(...)` 于是一个字都复制不到、也不报错
 * （可选链把失败吞了）。所以退回老办法：临时 textarea + `document.execCommand("copy")`，
 * 它在非安全上下文里照样工作。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 被拒绝（无手势/权限）就走下面的退路 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
/** 同步实测的回执是异步的：开完实测按这个间隔追结论，最多追这么久 */
const PROBE_POLL_MS = 400;
const PROBE_DEADLINE_MS = 8000;

export default function Console() {
  const { toast } = useMumai();
  const online = useSharedStore(isOnline);
  const currentSessionId = useSharedStore((state) => state.sessionId);
  const [overview, setOverview] = useState<RehearsalOverview | null>(null);
  const [peers, setPeers] = useState<LanPeers | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState("P11");
  const [label, setLabel] = useState("");
  /** 最近一次同步实测的结论（端回执是异步的，追到齐或超时为止） */
  const [probe, setProbe] = useState<SyncProbe | null>(null);
  const [probing, setProbing] = useState(false);
  /** 本机是否跟随讲解机（存本地；初值现场读，默认开） */
  const [following, setFollowing] = useState(() => followEnabled());
  /** 最近谁从哪台机器写了什么 */
  const [writeLog, setWriteLog] = useState<WriteLogPage | null>(null);
  const probeTimer = useRef(0);
  /*
    「本轮同步」读数（用户 2026-10-01 长期口径）：
    讲解机按下某一轮之后，各端有没有跟到这一轮的页面上 —— 现场被问
    「两台机器是同一屏吗」时，这里有一句可以直接念的话。
    数据：store 里的小木回合留痕（`agentTurn`）+ 内网协同面板的端明细（`peers.ends`）。
  */
  const turns = useSharedStore(agentTurns);
  const roundSync = useMemo(
    () =>
      roundSyncView(
        turns.map((entity) => entity.data),
        peers?.ends ?? [],
        selfEndIds(peers?.ends ?? []),
      ),
    [turns, peers],
  );

  const refresh = useCallback(async () => {
    if (!online) return;
    try {
      setOverview(await api.consoleOverview(currentSessionId));
    } catch {
      /* 顶栏与状态块已经会说明连接问题，这里不重复报 */
    }
  }, [currentSessionId, online]);

  /**
   * 读内网协同信息：本会话有几台端连着 + 同事该打开哪个地址。
   *
   * ⚠ 这一条是本页**唯一**的轮询（10 秒一次，一个极小的 GET）：
   *   端数是"别人开关页面"这件事的读数，不轮询就永远是打开本页那一刻的快照，
   *   而它恰恰是多机演示里最需要眼见为实的一格。其余面板仍然只在
   *   首次读取与动作之后更新。
   */
  const refreshPeers = useCallback(async () => {
    if (!online) {
      setPeers(null);
      return;
    }
    try {
      setPeers(await api.sessionPeers(currentSessionId));
    } catch {
      setPeers(null);
    }
  }, [currentSessionId, online]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshPeers();
    const timer = window.setInterval(() => void refreshPeers(), PEERS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshPeers]);

  /**
   * 写入来源：最近谁从哪台机器写了什么。
   *
   * 用户 2026-09-18「沈那边派发人员，我这边也同步不到」—— 这一格直接回答
   * "他到底写没写进来"：有他那台机器的地址就说明写到了这台服务器（那问题在实时通道），
   * 没有就说明他的写入**根本没到这台服务器**（问题在网络/地址，换多少台电脑都一样）。
   */
  const refreshWriteLog = useCallback(async () => {
    if (!online) {
      setWriteLog(null);
      return;
    }
    try {
      setWriteLog(await api.writeLog(12));
    } catch {
      setWriteLog(null);
    }
  }, [online]);

  useEffect(() => {
    void refreshWriteLog();
    /* 页面刷新后还能念出上一次实测的结论：不至于"刚才那条到底过没过"说不清 */
    void api
      .latestSyncProbe()
      .then((result) => setProbe(result.probe))
      .catch(() => setProbe(null));
  }, [refreshWriteLog]);

  useEffect(() => () => window.clearTimeout(probeTimer.current), []);

  /**
   * 开一次同步实测：服务端真写一条事件并广播，每台端回执后才算通过。
   *
   * 只追一段时间（8 秒）：端没回就是没回 —— 结论如实显示"只有 M/N 台收到"，
   * 比转圈转到天荒地老有用得多。
   */
  const runProbe = useCallback(async () => {
    if (!online) return;
    setProbing(true);
    window.clearTimeout(probeTimer.current);
    try {
      const opened = await api.syncProbe(currentSessionId);
      setProbe(opened);
      const deadline = Date.now() + PROBE_DEADLINE_MS;
      const follow = async () => {
        try {
          const next = await api.syncProbeStatus(opened.probeId);
          setProbe(next);
          if (next.ok || Date.now() > deadline) {
            setProbing(false);
            await refreshPeers();
            await refreshWriteLog();
            return;
          }
        } catch {
          /* 实测过期之类的：保留上一份读数，别把结论清成空白 */
        }
        probeTimer.current = window.setTimeout(() => void follow(), PROBE_POLL_MS);
      };
      probeTimer.current = window.setTimeout(() => void follow(), PROBE_POLL_MS);
    } catch (error) {
      toast(isApiError(error) ? error.message : "同步实测没开起来", "danger");
      setProbing(false);
    }
  }, [currentSessionId, online, refreshPeers, refreshWriteLog, toast]);

  /** 「重新读取」把两类读数一起刷新（端数平时自己轮询，不必等按钮） */
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshPeers()]);
  }, [refresh, refreshPeers]);

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
          {busy === "new-session" ? "新建中…" : "新建工作会话"}
        </Btn>
        <Btn disabled={!online || busy !== null} onClick={() => void exportDiagnostics()}>
          {busy === "diagnostics" ? "导出中…" : "导出诊断包"}
        </Btn>
        <Btn disabled={!online || busy !== null} onClick={() => void refreshAll()}>
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
        {/*
          三个面板头部的计数（场 / 个）与每行里的实体数、事件序号都走数字动效：
          本页没有轮询，数字只在「首次读取」和「新建 / 捕获 / 恢复 / 删除」之后变，
          即典型的**入场计数 + 动作后平滑更新**。保留 `?? 0`：
          第一次读取还没回来时这一格原本就写 0 场 / 0 个，动效只是把 0 → N 这一段补上。
          `场景 xxx`、`阶段 P05`、会话号是标识不是读数，保持静态。

          口径分两种：**数量**（场数 / 快照数 / 实体数）用组件默认的千分位；
          **序号**（`事件 1001` 这种从 1000 起算的单调序号）给 `group={false}` ——
          序号按标识书写，没有千分位，滚动起来也不能凭空变成「1,001」。
        */}
        <Panel title="工作会话" extra={<span className="muted"><NumberAnimation value={overview?.sessions.length ?? 0} /> 场</span>}>
          <ul className="cs-sessions">
            {(overview?.sessions ?? []).map((session) => (
              <li key={session.id} className={session.id === currentSessionId ? "is-current" : ""}>
                <b>{session.id}</b>
                <span>
                  场景 {session.scenarioId} · 阶段 {session.stage} · 实体 <NumberAnimation value={session.entityCount} /> · 事件{" "}
                  <NumberAnimation value={session.lastSeq} group={false} />
                </span>
                <em>建立于 {session.createdAt.slice(0, 19).replace("T", " ")}</em>
                {session.id === currentSessionId ? <StatusChip text="当前会话" tone="ok" /> : null}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="阶段快照" extra={<span className="muted"><NumberAnimation value={overview?.snapshots.length ?? 0} /> 个</span>}>
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
                    {snapshot.stage} · <NumberAnimation value={snapshot.entityCount} /> 个实体 · {actorName(snapshot.createdBy)}
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

        {/*
          ── 内网协同（用户口径 2026-09-17「完善平台内网同步」；
             2026-09-18「平台同步有问题」后补：服务器身份 / 端明细 / 同步实测 / 写入来源）
          多机演示现场只问四件事：
            「我连的是哪一台服务器」「别人连上了没有」「同事该打开哪个地址」
            「他说他写了，到底写进来了没有」。
          这四件都从服务端读，一处不猜：
            · 端数 = WebSocket 房间里的真实连接数；
            · 端明细的地址 = **TCP 对端地址**（不是页面自报的）；
            · 地址清单 = `os.networkInterfaces()` 分类后的结果（含虚拟局域网那条）；
            · 写入来源 = 服务端对每个写请求留的痕（含被拒的那些）。
        */}
        <Panel
          title="内网协同"
          className="cs-lan-panel"
          extra={
            peers ? (
              <StatusChip
                text={`${peers.peers} 台在线`}
                tone={peers.peers > 1 ? "ok" : "warn"}
              />
            ) : (
              <StatusChip text="未读取" tone="muted" />
            )
          }>
          <ul className="cs-lan">
            <li>
              <b>这一页从哪打开</b>
              <span>
                <code className="cs-lan__host">{typeof window === "undefined" ? "—" : window.location.host}</code>
                {typeof window !== "undefined" && isLocalHost(hostOf(window.location.host)) ? (
                  <em className="cs-lan__warn">
                    本机模式：同事打不开这个地址。把下面的地址发给他 —— 他要是也在自己电脑上开一份，两边数据不互通。
                  </em>
                ) : null}
              </span>
            </li>
            <li>
              <b>服务器</b>
              <span>{serverLine(peers?.server ?? null)}</span>
            </li>
            <li>
              <b>本会话在线端数</b>
              <span>
                <NumberAnimation value={peers?.peers ?? 0} /> 台
                {peers && peers.peers <= 1 ? "（只有本机；同事打开下面的地址后这里会加上去）" : ""}
              </span>
            </li>
            <li>
              <b>同事打开这个地址</b>
              <span>
                {peers?.addresses.length ? (
                  <>
                    {addressGroups(peers.addresses).lan.map((item) => (
                      <button
                        key={item.url}
                        type="button"
                        className="cs-lan__url"
                        title={`${item.iface} · 点一下复制`}
                        onClick={() => void copyToClipboard(item.url).then((ok) => toast(ok ? `已复制 ${item.url}` : "复制失败，请手动选中这段地址", ok ? "ok" : "warn"))}>
                        {item.url}
                      </button>
                    ))}
                    {addressGroups(peers.addresses).vpn.map((item) => (
                      <button
                        key={item.url}
                        type="button"
                        className="cs-lan__url cs-lan__url--vpn"
                        title={`${item.iface}（虚拟局域网）· 同在这个虚拟网里的同事用这条 · 点一下复制`}
                        onClick={() => void copyToClipboard(item.url).then((ok) => toast(ok ? `已复制 ${item.url}` : "复制失败，请手动选中这段地址", ok ? "ok" : "warn"))}>
                        {item.url}
                        <em>虚拟局域网</em>
                      </button>
                    ))}
                    {recommendedUrl(peers) ? (
                      <em className="cs-lan__hint">现场默认念第一条：{recommendedUrl(peers)}</em>
                    ) : null}
                  </>
                ) : (
                  <em>这一台没读到对内地址（可能没连局域网，也没进虚拟局域网）</em>
                )}
              </span>
            </li>
            <li>
              <b>现在连着的端</b>
              <span>
                {peers?.ends.length ? (
                  <ul className="cs-lan__ends">
                    {endRows(peers.ends).map((row) => (
                      <li key={row.key} className={row.alive ? "" : "is-stale"}>
                        <i aria-hidden>{row.alive ? "●" : "○"}</i>
                        {row.text}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <em>还没有端连上来 —— 同事那台不在这份列表里，说明他没连到这台服务器</em>
                )}
              </span>
            </li>
            <li>
              <b>本轮同步</b>
              <span>
                {roundSync ? (
                  <>
                    <StatusChip text={roundSync.verdict} tone={roundSync.tone} />
                    <em className="cs-lan__hint">
                      最近一轮：{roundSync.roundNo}（{roundSync.by} · {roundSync.at.slice(11, 19)}）
                      {roundSync.target ? ` · 落点 ${roundSync.target}` : " · 本轮不换页"}
                      {roundSync.lagging.length ? ` · ${roundSync.laggingLabel}：${roundSync.lagging.map((row) => row.label).join("；")}` : ""}
                    </em>
                  </>
                ) : (
                  <em className="cs-lan__hint">还没有小木回合留痕 —— 讲第一轮之后这里会显示各端跟没跟上。</em>
                )}
              </span>
            </li>
            <li>
              <b>实时通道</b>
              <span>
                {online ? "正常 · 新工单与调度会自己出现，无需刷新" : "未连接共享服务"}
                {peers ? `（会话 ${peers.sessionId}）` : ""}
              </span>
            </li>
            {/*
              跟随演示机（用户 2026-09-23：「项目就是面向结果展示的，但得做到内网多主机内容同步」）。
              开关存每台机器自己的 localStorage（**默认开**：新机器打开就能跟着看），
              讲小木那一轮时本机会同屏显示同一句台词、并把页面带到同一页；**不出声**。
              哪台机器要自己演示，就在这里关掉它（关掉后本机只做自己的操作，不跟随别人）。
            */}
            <li>
              <b>跟随讲解机</b>
              <span>
                <Btn
                  tone={following ? "primary" : "default"}
                  onClick={() => {
                    const next = !following;
                    setFollowEnabled(next);
                    setFollowing(next);
                  }}>
                  {following ? "已开启 · 点一下关闭" : "已关闭 · 点一下开启"}
                </Btn>{" "}
                <em className="cs-lan__hint">
                  {following
                    ? "本机会跟着讲解机的小木讲解同步切页，并显示同一句台词（不出声）；本机自己说话不受影响。"
                    : "本机不跟随任何其它机器：只显示自己在平台上的操作与数据同步。"}
                </em>
              </span>
            </li>
            <li>
              <b>同步实测</b>
              <span>
                <Btn tone="primary" disabled={!online || probing} onClick={() => void runProbe()}>
                  {probing ? "等端回执…" : "开一次实测"}
                </Btn>{" "}
                {probe ? (
                  (() => {
                    const verdict = probeVerdict(probe);
                    return (
                      <>
                        {/*
                          追回执期间显示「等端回执 M/N」：这时给结论会读到"只有 0/N 台收到"，
                          看着像"同步坏了"，其实只是端还没回 —— 中间态要说成中间态。
                        */}
                        <StatusChip
                          text={probing ? `等端回执 ${probe.acked.length}/${probe.ends}` : verdict.text}
                          tone={probing ? "info" : verdict.tone}
                        />
                        <em className="cs-lan__hint">{verdict.detail}</em>
                      </>
                    );
                  })()
                ) : (
                  <em className="cs-lan__hint">
                    开一次实测：服务端真写一条事件，看有几台端真的收到了 —— 「他那边收不到」从这里就能证实或排除。
                  </em>
                )}
              </span>
            </li>
          </ul>

          <div className="cs-lan__writes">
            <div className="cs-lan__writes-head">
              <b>最近写入来源</b>
              <span className="muted">谁 · 从哪台机器 · 写了什么（写请求级留痕，服务重启即清）</span>
              <Btn tone="ghost" onClick={() => void refreshWriteLog()}>
                刷新
              </Btn>
            </div>
            {writeLog?.entries.length ? (
              <table className="cs-lan__table">
                <thead>
                  <tr>
                    <th>时刻</th>
                    <th>谁</th>
                    <th>写入</th>
                    <th>来自</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {writeLog.entries.map((entry) => (
                    <tr key={`${entry.at}-${entry.method}-${entry.path}`}>
                      <td>{entry.at.slice(11, 19)}</td>
                      <td>{entry.actorId ? actorName(entry.actorId) : "—"}</td>
                      <td title={entry.action ?? undefined}>
                        {entry.method} {entry.path}
                        {entry.action ? ` · ${entry.action}` : ""}
                      </td>
                      <td>{entry.address}</td>
                      <td className={entry.status && entry.status >= 400 ? "is-fail" : ""}>
                        {entry.status ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <StateBlock
                kind="empty"
                title="还没有写请求记录"
                hint="这一格只记写操作（新增、指派、删除…）；有同事在别的机器上操作时，这里会按机器地址分开列出。"
              />
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
