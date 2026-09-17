/**
 * 小木 · 失败降级与真实状态（PRD FR-10 / FR-02 第 5 条）
 *
 * ── 这个文件解决什么问题 ────────────────────────────────────────────
 *
 * FR-10 的四处降级**现在都能跑**（下面这段是它们各自当初缺什么，留着是为了
 * 说明"为什么这几条降级必须存在"，**不代表当前实现还缺**）：
 *   · 未听清    —— 服务端会回一条空命令，链路必须**照常收下**：喊醒了、
 *                  说了句没人听懂的话，界面上要有可见提示而不是一片安静。
 *                  ⚠ 这一点**已经修好**：空串照常派发到 `executor.ask("")`，
 *                  由 `replyNotHeard()` 给出一条不调用任何工具的提示。
 *                  现状说明在 `wakeChannel.ts` 派发处（搜「原先这里是」）与
 *                  本文件的 `replyNotHeard`。**不要再去找"把 `if (text)` 去掉"** ——
 *                  那个 `if (text)` 早就不存在了，历史注释曾把后来人指向那里。
 *   · 低置信    —— 除了「不执行高风险动作」，回复里还要给出「识别成了什么」
 *                  「应该怎么说」，用户才有纠正的抓手。
 *   · 服务断开  —— wakeChannel 会自己重连，界面必须**进入错误态**，
 *                  否则用户看到的是「正在听 / 待机」而实际一条帧都推不上去。
 *   · FR-02 第5条 —— 服务不可用 / 麦克风被拒绝 / KWS 退化时界面必须显示真实状态。
 *
 * 本文件只做这三件事，且**只通过已有入口**改状态（不新增 UI）：
 *   1. 把「未听清」变成一条可见的提示气泡，并且**一个工具都不调用**；
 *   2. 把「低置信」的识别文本、建议标准说法、不确定标注挂到已有的回复视图上；
 *   3. 订阅 `wakeChannel`，把真实的音频链路状态翻译成 store 的 `ERROR` 态
 *      （右下角小木的徽标随即变成「出错了」），并给出一条带重连办法的提示。
 *
 * ── 为什么单独一个文件，而不是塞进 executor.ts ──────────────────────
 *
 * executor.ts 是「理解 → 执行」的纯链路，它现在的全部依赖是 store / intents /
 * facts / tools；而本文件要订阅一个**有生命周期的外部通道**（wakeChannel）。
 * 把订阅写进 executor 会让「执行器」和「通道」互相绑死，之后想单独测执行器
 * 就得起一个假通道。这里用 `installDegradeGuard()` 显式安装，安装点在 executor.ts
 * 末尾一次性调用 —— 谁 import 执行器谁就装上守卫，不依赖任何组件挂载。
 *
 * ── 不属于本文件的（需要别的 owner 改）──────────────────────────────
 *   · 界面侧「一个真正的重连按钮」需要 XiaomuDock.tsx（现在只有 Alt+W 与
 *     「开启常驻唤醒」按钮这条现有路径可用，本文件不新增 UI）。
 */

import { FALLBACK_HINT, FALLBACK_TEXT, INTENT_BY_ID, type Intent } from "./intents";
import { clockStamp } from "../lib";
import {
  getAgentState,
  nextId,
  pushTurn,
  setAgent,
  updateLastBot,
  type AgentStoreState,
} from "./store";
import { wakeChannel } from "./wakeChannel";
import type { BotTurn } from "./types";

/* ------------------------------------------------------------------ *
 * 文案（唯一来源；验收脚本直接断言这些字符串）
 * ------------------------------------------------------------------ */

/**
 * FR-10 第 1 条：未听清（麦克风拿到空文本 / 没有可用的识别文本）。
 *
 * 用户口径（2026-09-17）：「小木没识别出来的回复」统一改成这一句，
 * 并且**只说这一句** —— 不再在后面追加"例如可以说「…」"。
 * 为什么去掉举例：远场演示时用户就站在几米外，一句短话更容易一次说清、
 * 也便于整句录音逐字命中（长句要被逐字念对才命中，命中率低）。
 */
export const NOT_HEARD_TEXT = "不好意思，请再说一遍";
/** 未听清时的可选动作：复用 Fallback 的提示，不另写一套说法（界面 note 用，不进播报） */
export const NOT_HEARD_HINT = FALLBACK_HINT;
/**
 * 兜底（未命中意图）时真正播报出去的整句。
 *
 * 用户口径（2026-09-17）：**只说这一句**，不再在后面追加"可查询巡检资料、查看构件…"
 * 这类长附加语 —— 远场演示时短句更容易一次说清，也便于整句录音逐字命中。
 * `FALLBACK_HINT` 继续保留：它仍出现在气泡的 note（给用户看的可选动作）里，只是不进播报。
 * 文字入口与语音入口共用本常量，避免两处各写一套。
 */
export const FALLBACK_SPOKEN = FALLBACK_TEXT;
/**
 * 未听清时给用户一个"照着说"的样本 —— **只用于界面提示，不进播报**。
 *
 * ⚠ 这里**不再硬编码**那句样本（原来写的是 `"查近三个月天气"`）：
 * 它是 `intents.ts` 的 `site_weather` 首条例句的副本 —— 意图目录改一个字，
 * 这句就悄悄漂移，而注释还写着"不硬编码"（自相矛盾）。
 * 现在从**意图目录本身**取：有 `site_weather` 就用它的首条例句；
 * 意图改名/删除时退回一句与业务无关的通用说法，不会指着一个不存在的意图。
 *
 * 这句也被 `suggestPhraseOf()` 用作**没有命中意图时**的兜底建议
 * （命中意图时用那个意图自己的首条例句）。
 */
export const NOT_HEARD_EXAMPLE =
  INTENT_BY_ID.site_weather?.examples[0] ?? "请再说一次刚才那句话";

/** FR-10 第 2 条：低置信 */
export const LOW_CONFIDENCE_LABEL = "不确定";
/** 低置信时给用户的标准说法前缀 */
export const SUGGEST_PREFIX = "建议说法：";
/** 低置信且高风险时的说明 */
export const HIGH_RISK_BLOCKED = "这是高风险操作，低置信下不会执行";

/** FR-10 第 4 条：服务断开 */
export const RECONNECT_HINT = "重连：按 Alt+W，或点击右下角「开启常驻唤醒」";

/** FR-02 第 5 条：界面状态与真实音频链路对不上时的说明 */
export const AUDIO_LINK_DOWN_NOTE = "音频链路当前不在线（界面状态以此为准，不显示「正在听」）";

/**
 * 唤醒应答：喊两遍「小木小木」被判定唤醒后，小木先回一句「我在」。
 *
 * ── 为什么要有这一句 ────────────────────────────────────────────
 * 唤醒到可见反馈之间有一个"该我说话了"的空档。界面有「正在听」的状态词，
 * 但用户此时是**背对屏幕喊话**的，看不到状态词 —— 没有声音回应就只能再喊一遍，
 * 反而把命令说乱（与 `WakeSnapshot.collecting` 那段记录的是同一个坑）。
 *
 * ── 文案与音频的约束（改这里必须同步改语音包）──────────────────
 * `VoiceOutput.speak()` 是**按文本逐字**去 `public/voice/manifest.json` 找音频的，
 * 所以这句一旦改动，`我在` → `/voice/wake-ack.mp3` 那条键就失配、自动回退浏览器合成音。
 * `wakeReply.test.ts` 会核对"文案与语音包的键一致"，避免静默失配。
 */
export const WAKE_REPLY_TEXT = "我在";

/* ------------------------------------------------------------------ *
 * 未听清 / 低置信 的回复组装（供 executor.ts 调用）
 * ------------------------------------------------------------------ */

/**
 * 未听清回复：**不执行任何工具**，只提示重说。
 *
 * 返回值里没有任何 intentId / toolRuns，本函数也不调用 understand() ——
 * 这就是"不执行任何工具"这句话在代码上的落点：整条函数没有通向 Tool Registry 的路径。
 */
export function replyNotHeard(via: "text" | "mic" | "example"): BotTurn {
  const turn: BotTurn = {
    kind: "bot",
    id: nextId(),
    at: clockStamp(),
    /*
      只播这一句，**不再追加**"例如可以说「…」"（用户口径 2026-09-17）：
      远场演示时短句更容易一次说清，也便于整句录音逐字命中。
      `NOT_HEARD_EXAMPLE` 仍然保留给界面提示（suggestPhraseOf）使用，不在这里拼。
    */
    text: `${NOT_HEARD_TEXT}。`,
    intentId: null,
    intentName: "未听清",
    type: "RESPONSE",
    confidence: 0,
    // 与 FR-10 的四种降级一一对应：未听清自成一档，界面据此着色，
    // 不与 fallback（未命中意图）混成同一个 level
    level: "unheard",
    rule: null,
    facts: [],
    entities: [],
    steps: [],
    voice: "—",
    toolRuns: [],
    note: `${NOT_HEARD_HINT}；语音/${via} 入口都没有拿到可用的识别文本，本轮未调用任何工具`,
  };
  pushTurn(turn);
  setAgent({
    agentState: "FINISHED",
    stateNote: "未听清，未执行工具",
    partial: "",
    finalText: "",
    // 工具调用记录保持原样（本轮没有新增），这里显式清空步骤清单，避免上一轮的
    // 多步任务清单挂在这一轮回复下面
    steps: [],
  });
  return turn;
}

/** 低置信时该建议用户怎么说的"标准说法"（取意图目录里的示例，不另写字面量） */
export function suggestPhraseOf(intent: Intent | null): string {
  if (!intent) return NOT_HEARD_EXAMPLE;
  return intent.examples[0] ?? NOT_HEARD_EXAMPLE;
}

/**
 * 给低置信回复补上「识别文本 + 建议标准说法 + 不确定标注」。
 *
 * 为什么改的是**已有那一轮回复**而不是再推一条气泡：FR-07 要求"识别定稿后就地更新，
 * 不重复新增相同文本"，而低置信恰恰是"识别文本已经定稿、只是不敢肯定"，再推一条
 * 会让用户看到两条几乎一样的话，分不清哪条算数。
 *
 * @param recognized 识别的原话（executor 里就是 final text）
 */
export function annotateLowConfidence(recognized: string, intent: Intent | null): void {
  const suggestion = suggestPhraseOf(intent);
  updateLastBot((turn) => ({
    level: "low",
    note: [
      `低置信：识别为「${recognized}」，${SUGGEST_PREFIX}「${suggestion}」`,
      `${LOW_CONFIDENCE_LABEL}：本轮不是确定性命中，我可能理解错了`,
      turn.note,
    ]
      .filter(Boolean)
      .join("；"),
  }));
}

/** 高风险拦截时的说明（在 annotateLowConfidence 之后追加） */
export function annotateHighRiskBlocked(): void {
  updateLastBot((turn) => ({ note: `${turn.note}；${HIGH_RISK_BLOCKED}` }));
}

/**
 * 「未命中意图」的兜底回复（FR-10 第 3 条：用现有 Fallback，不猜答案）。
 *
 * 与原先 executor 里的 replyFallback 行为一致，挪到这里是为了让四种降级
 * 在**同一处**可读、可断言；Fallback 文本仍然只有 intents.ts 一个来源。
 *
 * @param judge 这一轮的匹配判据。只用来把「Top1 到底多低、阈值是多少」如实写进
 *              note（原来阈值 0.68 是硬编码在文案里的字面量，容易和
 *              `SEMANTIC_THRESHOLDS` 漂移）。
 * @param speak 播报回调。**必须传** —— 见下面那段说明。
 */
export type MatchJudge = { confidence: number; margin: number; lowThreshold: number };

export function replyFallback(judge?: MatchJudge, speak?: (text: string) => void): void {
  const judgeNote = judge
    ? `Top1 相似度 ${judge.confidence.toFixed(3)} 低于低置信阈值 ${judge.lowThreshold}`
    : "未达到任何置信档";
  const turn: BotTurn = {
    kind: "bot",
    id: nextId(),
    at: clockStamp(),
    text: FALLBACK_TEXT,
    intentId: null,
    intentName: "未命中意图目录",
    type: "RESPONSE",
    confidence: judge?.confidence ?? 0,
    level: "fallback",
    rule: null,
    facts: [],
    entities: [],
    steps: [],
    voice: "—",
    toolRuns: [],
    note: `${FALLBACK_HINT}；${judgeNote}，本轮未调用任何工具`,
  };
  pushTurn(turn);
  setAgent({ agentState: "FINISHED", stateNote: "未命中意图目录，未执行工具", steps: [] });
  /**
   * ⚠ 播报不能省 —— 这是搬移 `replyFallback` 时漏掉的一行，实测代价是
   * **兜底回复变成静音**（AC-01 录音验证里"播报 0 次"就是这么来的）。
   *
   * 为什么它重要：用户说了一句没听懂的话，气泡里出现一行字但他**没听见任何回应**，
   * 第一反应是"设备死了"而不是"它没听懂"。语音助手的兜底必须出声。
   *
   * 播报内容是主回答 + 可选动作（`FALLBACK_SPOKEN`）—— 与旧实现一致，
   * 且**不含** note 里的诊断信息（那是我写给开发者看的，不该念给用户）。
   */
  speak?.(FALLBACK_SPOKEN);
}

/* ------------------------------------------------------------------ *
 * 音频链路真实状态（FR-02 第 5 条 / FR-10 第 4 条）
 * ------------------------------------------------------------------ */

/** 当前是不是真的有一条在听的音频链路：只有 wakeChannel 说 live 才算 */
export function audioLinkLive(): boolean {
  return wakeChannel().snapshot().state === "live";
}

/** 一句话说明音频链路现在到底怎么了（界面与验收脚本共用） */
export function audioLinkNote(): string {
  const snapshot = wakeChannel().snapshot();
  const sent = wakeChannel().currentStats.sentFrames;
  switch (snapshot.state) {
    case "live":
      // 状态是 live 但一帧都没推上去 = 典型"看起来在听"，如实标出来（见文件头说明）
      return sent === 0 ? `${AUDIO_LINK_DOWN_NOTE}：状态为 live，但尚未推送任何音频帧` : "";
    case "starting":
      return `${AUDIO_LINK_DOWN_NOTE}：正在申请麦克风`;
    case "reconnecting":
      return `${AUDIO_LINK_DOWN_NOTE}：本地语音服务连接已断开，正在重连`;
    case "error":
      return `${AUDIO_LINK_DOWN_NOTE}：${snapshot.note || "唤醒通道出错"}`;
    case "stopped":
      return `${AUDIO_LINK_DOWN_NOTE}：常驻唤醒已被用户关闭`;
    default:
      return `${AUDIO_LINK_DOWN_NOTE}：常驻唤醒未开启`;
  }
}

/**
 * 断开时的提示气泡 + 错误态。
 *
 * ── 为什么走 store 而不是自己画一个浮层 ──────────────────────────────
 * 「小木进入错误态」在现有实现里只有一个落点：`AgentState = "ERROR"`，
 * 右下角小木据此显示「出错了」徽标（XiaomuDock 的 dockState 推导）。
 * 自己再挂一个 DOM 浮层会变成第二个状态来源 —— 之前删掉 WakeOverlay 正是这个原因。
 */
let lastErrorNote = "";

/**
 * 同一种断开的**稳定签名**：把会变的计数与参数抹掉。
 *
 * ── 这是一个实测出来的真缺陷（用户："窗口关不掉，一直弹回来"）──────
 * 原来的去重是 `lastErrorNote === note`，而 note 里带着重连计数
 * （「8000ms 后第 75 次重试」）—— 每重试一次文字就变一次，
 * 于是**每次重连都被当成一种新的断开**：
 *   · 往会话里再 push 一条错误（用户看到的就是卡片反复弹回来）；
 *   · 连续重试时错误卡会一直往上长。
 * 现在按抹掉数字后的骨架比较：「第 1 次重试」与「第 75 次重试」是同一种断开，
 * 只提示一次；而「重连中」变成「麦克风权限被拒绝」这种**真的换了原因**的情况，
 * 骨架不同，仍会照常提示。
 */
export function errorSignatureOf(note: string): string {
  return note.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/**
 * 唤醒通道出错时，**给人看的那一句**（原因 + 怎么办）。
 *
 * ── 为什么需要它（用户 2026-09-17 实测报的）──────────────────────────
 * 用户原话：「为什么我点击开启常驻唤醒就报错」。
 *
 * 实测复现：浏览器没给麦克风权限时，点「开启常驻唤醒」→ 小木徽标变成「出错了」，
 * 而界面上**只有一句与原因无关的**「音频链路当前不在线…重连：按 Alt+W…」——
 * 真正的原因（「麦克风权限被拒绝，唤醒不可用」）只打在控制台里，
 * 用户看不到，于是只能来问"为什么报错"。
 *
 * 这个函数把 `wakeChannel` 记下的原因翻成一句可操作的话：说清是哪一类问题、
 * 当场该怎么绕过去（绝大多数情况就是改用快捷键）。三类原因分开写，
 * 因为它们要用户做的事完全不同：改权限 / 换地址 / 起服务。
 *
 * ⚠ 判据按**关键词**匹配而不是等值比较：`wakeChannel` 的原文会带上浏览器给的
 *   `error.name`（`NotAllowedError` / `NotFoundError` / …），逐字比较会漏。
 */
export function wakeErrorHint(note: string): string {
  const text = String(note ?? "");
  if (text.includes("权限被拒绝") || /NotAllowedError/i.test(text)) {
    return "浏览器拒绝了麦克风（权限被拒）。点地址栏左边的图标，把「麦克风」改成「允许」，再按 Alt+W 重开；这期间可以直接用下面「快捷键一览」里的键按轮次播放。";
  }
  if (text.includes("不支持") || text.includes("不可用")) {
    /*
      ⚠ 措辞避开「演示」二字：`visibleCopy.test.ts` 明令运行时展示文案里不许出现
      「演示 / 非实 / 虚构样例」，那是给观众看的界面，不能自我拆台。
    */
    return "本机浏览器不给麦克风（内网 http 不是安全上下文 —— 浏览器只在 localhost 或 https 下开麦）。开服务的那台用 http://localhost:8000 打开就能用语音；其它机器请用下面「快捷键一览」里的键。";
  }
  if (text.includes("连接") || text.includes("服务") || text.includes("重连")) {
    return "本机语音服务不可达（识别服务 8770 / 语音桥 8780 没起或刚重启）。看启动窗口里那一行「语音通道 …」是否 ready；期间可用下面「快捷键一览」里的键。";
  }
  return `${text || "唤醒通道出错"}。期间可用下面「快捷键一览」里的键按轮次播放。`;
}

/**
 * 去掉重连参数，只留「断开原因」。
 *
 * `wakeChannel.scheduleReconnect` 写的 note 里带退避参数
 * （「唤醒通道断开，正在重连…（8000ms 后第 9 次重试）」），这两个数字**每次都变**：
 *   · 徽标上的错误说明会一直抖；
 *   · 更要命的是「用户已按 × 确认过这条错误」的判据也会随计数变化 ——
 *     重试一次就变成一条"新"错误，刚关掉的面板立刻又弹回来。
 * 所以归一化放在这里，degrade 与气泡共用同一套规则。
 */
export function stableNote(note: string): string {
  return note
    .replace(/（[^）]*后第\s*\d+\s*次重试）/g, "")
    .replace(/第\s*\d+\s*次重试/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function enterServiceError(note: string): void {
  /*
   * 只把状态机切到 ERROR（徽标变「出错了」、形象换成错误帧），
   * **不主动把气泡顶开**。
   *
   * 状态机切 ERROR 会让 `dockState` 变 `error`，气泡本来就可见
   * （用户此刻正在看它）；用户按 × 关掉之后，`active` 由关闭态压住，
   * 后续的重连不会再把面板顶回来。想再看那条错误，点一下形象即可
   * （`reopen()` 会清掉「已确认」）。
   */
  const stable = stableNote(note);
  /* 状态里也放归一化后的文本：徽标不再随重试次数跳动 */
  setAgent({ agentState: "ERROR", stateNote: stable });
  const signature = errorSignatureOf(stable);
  if (lastErrorNote === signature) return; // 同一种断开只提示一次，别刷屏
  lastErrorNote = signature;
  pushTurn({
    kind: "bot",
    id: nextId(),
    at: clockStamp(),
    text: `本地语音服务当前不可用：${stable}。文字入口和 COM4 语音串口入口不受影响，仍然可用。${RECONNECT_HINT}。`,
    intentId: null,
    intentName: "语音服务不可用",
    type: "ERROR",
    confidence: 0,
    level: "error",
    rule: null,
    facts: [],
    entities: [],
    steps: [],
    voice: "—",
    toolRuns: [],
    note: `${AUDIO_LINK_DOWN_NOTE}；${RECONNECT_HINT}`,
  });
}

function leaveServiceError(): void {
  lastErrorNote = "";
  // 只把 ERROR 收回 IDLE；正在跑的那一轮（UNDERSTANDING/EXECUTING…）不要打断
  if (getAgentState().agentState === "ERROR") {
    setAgent({ agentState: "IDLE", stateNote: "音频链路已恢复" });
  }
}

let installed = false;

/**
 * 安装降级守卫：订阅唤醒通道的真实状态。
 *
 * 订阅回调在订阅时会**立即**收到一次当前快照（wakeChannel.subscribe 的实现如此），
 * 所以安装即校准，不需要额外读一次初值。
 *
 * 幂等：executor 被多个入口 import（右下角气泡、全屏控制台、standalone 兜底），
 * 但安装只会发生一次。
 */
export function installDegradeGuard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  let wasError = false;
  wakeChannel().subscribe((snapshot) => {
    if (snapshot.state === "error" || snapshot.state === "reconnecting") {
      wasError = true;
      enterServiceError(snapshot.note || (snapshot.state === "error" ? "通道出错" : "连接断开，正在重连"));
      return;
    }
    if (snapshot.state === "live" && wasError) {
      wasError = false;
      leaveServiceError();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 供验收脚本使用的只读快照 / 入口（照项目里 __mumaiWake 的惯例挂到 window）
 * ------------------------------------------------------------------ */

/** 一次读出界面要判定的全部真实状态，避免验收脚本自己拼装 */
export function degradeSnapshot(): {
  wakeState: string;
  wakeNote: string;
  sentFrames: number;
  audioLinkLive: boolean;
  audioNote: string;
  agentState: AgentStoreState["agentState"];
  agentNote: string;
  toolRuns: number;
  lastTurn: { level: string; intentId: string | null; text: string; note: string; confidence: number } | null;
} {
  const snapshot = wakeChannel().snapshot();
  const state = getAgentState();
  const lastBot = [...state.turns].reverse().find((turn) => turn.kind === "bot") as BotTurn | undefined;
  return {
    wakeState: snapshot.state,
    wakeNote: snapshot.note,
    sentFrames: wakeChannel().currentStats.sentFrames,
    audioLinkLive: audioLinkLive(),
    audioNote: audioLinkNote(),
    agentState: state.agentState,
    agentNote: state.stateNote,
    toolRuns: state.toolRuns.length,
    lastTurn: lastBot
      ? {
          level: lastBot.level,
          intentId: lastBot.intentId,
          text: lastBot.text,
          note: lastBot.note,
          confidence: lastBot.confidence,
        }
      : null,
  };
}

if (typeof window !== "undefined") {
  (window as unknown as { __mumaiDegrade?: unknown }).__mumaiDegrade = {
    snapshot: degradeSnapshot,
    audioLinkNote,
    constants: {
      NOT_HEARD_TEXT,
      NOT_HEARD_HINT,
      LOW_CONFIDENCE_LABEL,
      SUGGEST_PREFIX,
      HIGH_RISK_BLOCKED,
      RECONNECT_HINT,
      FALLBACK_TEXT,
      FALLBACK_HINT,
    },
    /** 建议说法：给定意图 id 返回它语料里的第一条标准说法（验收脚本用来做对照） */
    suggestOf: (intentId: string) => suggestPhraseOf(INTENT_BY_ID[intentId] ?? null),
  };
}
