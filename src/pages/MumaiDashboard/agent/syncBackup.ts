/**
 * 同步备份小窗 · 数据与时机（纯函数，可单测）
 *
 * ── 这是在做什么 ────────────────────────────────────────────────
 * 剧本第④轮小木说完「收到，我来核对范围…」之后，屏幕上弹一个小窗：
 * 逐条滚动列出**正在同步备份的对象**，然后自动收起。
 * 用户口径（2026-09-16）：「同时呼出一个小窗口显示数据流，同步备份确认，
 * 然后过一会儿自动消失，数据要有真实性和科技感，而且不要穿帮」。
 *
 * ── 「真实性」怎么落地（这是本文件的重点）──────────────────────────
 * 窗里的每一条都来自**平台里真实存在的清单**，没有一条是编的：
 *   · 备份对象 = 当前工单的 `attachments`（`SH-2026-0901` 上真有 7 个附件，
 *     含 38.4 MB 的图像包与 12.1 MB 的雷达原始数据）；
 *   · 末尾那条固定项 = 本地小木播报语音包（真实 mp3 段数）。
 * 三个"不做"（穿帮点，别加回来）：
 *   · 不写"云端 / 上传 / 联网"—— 平台是纯本地演示，写这些等于自曝；
 *   · 不做假进度条与假剩余时间 —— 进度只按"已列出几条 / 共几条"算，真实可数；
 *   · 不出现没有出处的数字（例如"共 2.4 GB""速度 12 MB/s"）。
 *
 * ── 时机为什么也放在这里 ────────────────────────────────────────
 * 「过一会儿自动消失」需要一个时长，而时长不是随便写的：
 * 条目多的面板要让观众读得完。所以由**条数**推出时长（`durationMsOf`），
 * 并夹在上下限之间；这样以后备份对象变多，小窗会自动多停留一会儿。
 * 纯函数放这里、DOM 放 `SyncBackupPanel.tsx`，与 `demoSurfaceRows.ts` 同一套分法。
 */
import { DEMO_SESSION, WORK_ORDER } from "../seed/scenario";

/** 小窗里的一行：同步了哪个对象、多大、结果如何 */
export type SyncBackupEntry = {
  /** 对象名（逐字取自工单附件名，不改写、不截断） */
  name: string;
  /** 体量文本（附件的 `sizeText`，非数值型附件如日志写实际大小） */
  size: string;
  /** 结果：本地归档完成 */
  state: "已同步";
};

export type SyncBackupStream = {
  /** 面板标题 */
  title: string;
  /** 逐条滚动的内容 */
  entries: SyncBackupEntry[];
  /** 末尾固定项：本地语音资源（真实段数） */
  voiceLine: { name: string; size: string };
  /** 结论文案（明确写"本地"） */
  summary: string;
  /** 自动收起时长 */
  autoCloseMs: number;
};

/**
 * 小窗自动收起的时长区间（按条数插值，夹在这里面）。
 *
 * 下限为什么是 7 秒而不是 5 秒：小窗从"小木念完"才开始计时（见 executor 的
 * 派发时机），此时观众是**第一次**看到这 8 行内容 —— 5 秒只够扫一眼文件名，
 * 读不完体量列。用户口径是"过一段时间消失"，实测 7 秒既读得完、又不拖场。
 */
export const SYNC_MIN_MS = 7000;
export const SYNC_MAX_MS = 12000;
/**
 * 每条对象读取的一拍时长。
 *
 * ⚠ 这个值**同时**决定两件事，改它就等于同时改两处：
 *   · 列表里第 n 条的浮现延迟（`SyncBackupPanel` 的 `perEntryMs` 用它作默认值）；
 *   · 小窗的总停留时长（`durationMsOf`）。
 * 两处必须同源：否则会出现"最后一条还没浮现，窗就关了"——
 * 8 行 × 620ms ≈ 5 秒，所以停留下限（7 秒）必须大于它。
 * `syncBackup.test.ts` 把"最后一行浮现完成 < 自动收起"和面板默认值钉在一起。
 */
export const SYNC_PER_ENTRY_MS = 620;

/**
 * 由条数推自动收起时长。
 *
 * 为什么不是固定值：备份对象是 7 条时 5 秒够读，将来变成 12 条就不够了。
 * 把"每条一拍"写成公式，加入新附件后不需要回来改时长。
 *
 * 下限还要**够读完最后一条**：`SYNC_MIN_MS` 大于"条数 × 一拍"时下限才生效，
 * 所以小条目数（1~8 条）的停留由下限兜底，9 条以上开始按条数线性增长。
 */
export function durationMsOf(entryCount: number): number {
  const raw = entryCount * SYNC_PER_ENTRY_MS;
  return Math.min(SYNC_MAX_MS, Math.max(SYNC_MIN_MS, raw));
}

/**
 * 组装这一次同步备份要展示的流。
 *
 * @param voiceSegments 本地播报语音包的真实段数（由调用方从语音包清单读，
 *                      取不到时传 0 —— 此时**不显示**这一行，而不是编一个数）
 */
export function buildSyncBackupStream(voiceSegments: number): SyncBackupStream {
  const entries: SyncBackupEntry[] = WORK_ORDER.attachments.map((item) => ({
    name: item.name,
    size: item.sizeText,
    state: "已同步",
  }));

  return {
    title: "同步备份",
    entries,
    voiceLine: {
      name: "小木播报语音包",
      /* 段数来自真实 mp3 清单；调用方取不到就传 0，下面 summary 会跟着变 */
      size: voiceSegments > 0 ? `${voiceSegments} 段` : "—",
    },
    summary:
      voiceSegments > 0
        ? `共 ${entries.length} 项工单附件与 ${voiceSegments} 段播报语音已同步到本地归档`
        : `共 ${entries.length} 项工单附件已同步到本地归档`,
    autoCloseMs: durationMsOf(entries.length),
  };
}

/** 小窗结论里要露出的事实（供测试核对，避免文案与数据分叉） */
export const SYNC_SOURCE_NOTE = `数据来源：${DEMO_SESSION.scenarioId} 工单附件清单与本地语音包，全部存放在本机`;
