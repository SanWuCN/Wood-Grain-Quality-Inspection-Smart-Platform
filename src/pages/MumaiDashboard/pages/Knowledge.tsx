/**
 * 知识库（`/knowledge`）—— 资料上传 → 向量库更新 → 向量库可视化
 *
 * PRD 5：
 *   - 资料与业务状态分开读取：资料来自本地索引，状态来自结构化数据
 *   - 检索是本地轻量实现（lib.searchKnowledge：中文 2–4 元 TF-IDF + 余弦相似度）
 *   - 相似度标为「检索相似度」，不能标成病害置信度
 *   - 无命中时回答「当前资料未检索到」，不编造
 *   - 页面要体现 RAG：答案带来源与原文位置
 * PRD 5.3：文档上传、分类、索引状态、版本 —— 本页补齐上传渠道、更新状态机与版本历史
 *
 * 演示边界（页面显式写明）：
 *   不接后端、不上传文件、不引向量库依赖；文件只在浏览器内读取。
 *   但每一步的数字都由真实计算或种子得出：
 *     - 分块数：真分块器切出来的块数（块大小 420 / 重叠 60）
 *     - 向量：条数 = 分块数，维度 768（模拟）；分块数 × 768 是标量元素数，不是向量条数
 *     - 散点坐标：对 768 维向量做真的 PCA（幂迭代求前两个主成分）
 *     - 检索：复用 lib.searchKnowledge（真 TF-IDF + 余弦）
 *
 * 信息层级（规范 §3.3）：主任务（上传 → 更新）→ 状态（队列 / 六步流水线 / 终端日志）
 *   → 辅助（三个可视化视图）→ 历史（版本历史 / 资料清单）
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useMumai } from "../context";
import { Panel } from "../Panel";
import { Btn, Modal, SourceTag, StateBlock, StatusChip } from "../ui";
import {
  CURRENT_RISKS,
  HISTORY_STATS,
  KNOWLEDGE_DOCS,
  KNOWLEDGE_FILE_SEEDS,
  KNOWLEDGE_META,
  KNOWLEDGE_PIPELINE,
} from "../seed/scenario";
import { nowStamp } from "../lib";
import { EChart } from "../knowledge/KnowledgeCharts";
import { TokenGraph3D } from "../knowledge/TokenGraph3D";
import {
  KB_CATEGORIES,
  KB_CHART,
  PARSE_MODE_NOTE,
  QUEUE_TONE,
  categoryColor,
  formatBytes,
  formatCount,
  formatSeconds,
} from "../knowledge/constants";
import {
  KB_DEMO_NOTES,
  KB_SEED_SUMMARY,
  type IncomingDoc,
  type KbState,
  type KbVersion,
  type LogEntry,
  type QueueItem,
  type UpdateStep,
  type UpdateStepKey,
  advanceQueue,
  assertConsistency,
  buildInitialKbState,
  buildSteps,
  buildVectorSpace,
  commitQueue,
  distributionByCategory,
  distributionByDoc,
  distributionByMonth,
  extensionOf,
  isTextFile,
  makeChunksFor,
  nextVersionLabel,
  ngrams,
  runSearch,
  scalarElements,
  stepLogs,
  toQueueItem,
  vectorMeasure,
} from "../knowledge/logic";
import type { UpdateStats } from "../knowledge/logic";
// 本页样式（规范 §9：只写 var(--token)，不散落硬编码色值）
import "../knowledge/knowledge.css";

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 一次「更新向量库」的完整计划：候选文档、六步、待处理块数与字数 */
type PlanResult = {
  scanned: QueueItem[];
  changed: QueueItem[];
  steps: UpdateStep[];
  chunkCount: number;
  chars: number;
};

/* ------------------------------------------------------------------ *
 * 小工具（纯函数，放组件外）
 * ------------------------------------------------------------------ */

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

const KIND_TEXT: Record<string, string> = {
  md: "Markdown",
  markdown: "Markdown",
  txt: "纯文本",
  csv: "表格 CSV",
  json: "结构化 JSON",
  log: "日志",
  pdf: "PDF",
  png: "图像 PNG",
  jpg: "图像 JPEG",
  jpeg: "图像 JPEG",
  webp: "图像 WebP",
  gif: "图像 GIF",
  zip: "压缩包",
  doc: "Word",
  docx: "Word",
  xls: "表格",
  xlsx: "表格",
};

function kindOf(fileName: string): string {
  const ext = extensionOf(fileName);
  if (!ext) return "未知类型";
  return KIND_TEXT[ext] ?? `${ext.toUpperCase()} 文件`;
}

function todayStamp(): string {
  return nowStamp().slice(0, 10);
}

/** 命中片段里把查询词（2–4 元）标出来，方便肉眼核对命中原因 */
function highlightTerms(text: string, query: string): { text: string; hit: boolean }[] {
  const grams = [...new Set(ngrams(query))].filter((gram) => gram.length >= 2).sort((a, b) => b.length - a.length);
  if (!grams.length) return [{ text, hit: false }];
  const escaped = grams.map((gram) => gram.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "g");
  const hitSet = new Set(grams);
  return text
    .split(re)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, hit: hitSet.has(part) }));
}

const STEP_ORDER: UpdateStepKey[] = ["parse", "chunk", "embed", "write", "rebuild", "done"];

const STEP_LABELS: Record<UpdateStepKey, string> = {
  parse: "解析文档",
  chunk: "分块",
  embed: "生成向量",
  write: "写入索引",
  rebuild: "重建检索索引",
  done: "完成",
};

function overallProgress(step: UpdateStepKey, progress: number): number {
  const per = 100 / STEP_ORDER.length;
  return Math.min(100, Math.round(STEP_ORDER.indexOf(step) * per + (progress / 100) * per));
}

/** 六步摘要（按钮旁常显；数字一律来自 KNOWLEDGE_PIPELINE） */
function plannedSteps(mode: "incremental" | "rebuild"): UpdateStep[] {
  return [
    { key: "parse", label: "解析文档", detail: "读取段落结构（文本类真读，其它只登记清单）", ms: 700 },
    {
      key: "chunk",
      label: "分块",
      detail: `chunk_size ${KNOWLEDGE_PIPELINE.chunkMaxChars} 字 · overlap ${KNOWLEDGE_PIPELINE.chunkOverlapChars} 字`,
      ms: 900,
    },
    {
      key: "embed",
      label: "生成向量",
      detail: `维度 ${KNOWLEDGE_PIPELINE.embeddingDims}（模拟：TF-IDF 权重哈希投影，未加载模型）`,
      ms: 1300,
    },
    {
      key: "write",
      label: "写入索引",
      detail: mode === "incremental" ? "只追加新增 / 变更文档的向量" : "清空索引后全量写入",
      ms: 800,
    },
    { key: "rebuild", label: "重建检索索引", detail: "重算 DF/IDF 并生成新的索引版本号", ms: 900 },
    { key: "done", label: "完成", detail: "可视化与检索切到新版本", ms: 300 },
  ];
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

export default function Knowledge() {
  const { askAssistant, toast } = useMumai();

  /* ---------------- 索引状态（条目 / 分块 / 向量三者恒等） ---------------- */
  const [kb, setKb] = useState<KbState>(() => buildInitialKbState(nowStamp()));
  const [versions, setVersions] = useState<KbVersion[]>(() => [
    {
      label: KNOWLEDGE_PIPELINE.baseIndexVersion,
      at: "2026-09-11 09:20:00",
      mode: "seed",
      docCount: KNOWLEDGE_DOCS.length,
      chunkCount: KNOWLEDGE_DOCS.reduce((total, doc) => total + doc.chunks.length, 0),
      vectorCount: KNOWLEDGE_DOCS.reduce((total, doc) => total + doc.chunks.length, 0),
      added: 0,
      changed: 0,
      deleted: 0,
      note: `本地索引初版，由 ${KNOWLEDGE_DOCS.length} 份种子资料构建`,
    },
  ]);

  /* ---------------- 上传队列 ---------------- */
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [fold, setFold] = useState<"none" | "paste" | "folder">("none");
  const [pasteText, setPasteText] = useState("");
  const [pasteTitle, setPasteTitle] = useState("现场记录粘贴稿");
  const [pasteCategory, setPasteCategory] = useState<string>("巡检报告");

  /* ---------------- 更新向量库 ---------------- */
  const [mode, setMode] = useState<"incremental" | "rebuild">("incremental");
  const [phase, setPhase] = useState<{ step: UpdateStepKey | null; progress: number; done: boolean }>({
    step: null,
    progress: 0,
    done: false,
  });
  const [stepElapsed, setStepElapsed] = useState<Record<string, number>>({});
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      at: "",
      text: `本地索引 ${KNOWLEDGE_META.indexVersion} 就绪（${versions[0].chunkCount} 块 / 无向量文件），等待上传资料`,
      tone: "muted",
    },
  ]);
  const consoleRef = useRef<HTMLDivElement>(null);

  /* ---------------- 可视化 / 检索 ---------------- */
  const [tab, setTab] = useState<"space" | "dist" | "search">("space");
  const [distDim, setDistDim] = useState<"doc" | "category" | "month">("doc");
  const [picked, setPicked] = useState<string | null>(null);
  /** 关系链放大到弹窗看：面板里这块只有 250px 高，三维图需要更多画幅 */
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [query, setQuery] = useState("五月巡检 Z04 渗水");
  const [submitted, setSubmitted] = useState("五月巡检 Z04 渗水");
  const [filterCategory, setFilterCategory] = useState("全部");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const running = phase.step !== null;
  const consistency = useMemo(() => assertConsistency(kb), [kb]);
  const steps = useMemo(() => plannedSteps(mode), [mode]);

  const appendLog = useCallback((entries: LogEntry[]) => {
    if (!entries.length) return;
    const at = nowStamp().slice(11);
    setLogs((current) => [...current, ...entries.map((entry) => ({ ...entry, at }))].slice(-160));
  }, []);

  /* ---------------- 上传 → 队列 ---------------- */

  /** StrictMode 下开发环境会挂两个定时器，用它保证一格只推进一次 */
  const queueLock = useRef(0);

  const enqueue = useCallback(
    (incoming: IncomingDoc[]) => {
      if (!incoming.length) return;
      /**
       * 日志与建项都放在 updater 之外：StrictMode 会重复调用 updater，
       * 把副作用写在里面会让同一条日志写两遍。
       */
      const known = new Set([...kb.docs.map((doc) => doc.digest), ...queue.map((item) => item.digest)]);
      const added = incoming.map((item) => toQueueItem(item, known));
      setQueue((current) => {
        const seen = new Set(current.map((item) => item.digest));
        return [...current, ...added.filter((item) => !seen.has(item.digest))];
      });
      appendLog([
        { at: "", text: `收到 ${added.length} 份资料：${added.map((item) => item.fileName).join("、")}`, tone: "info" },
        {
          at: "",
          text: `入队：真读文本 ${added.filter((item) => item.parseMode === "text").length} 份 / 只登记清单 ${added.filter((item) => item.parseMode === "estimate").length} 份`,
          tone: "muted",
        },
        ...added
          .filter((item) => item.change === "unchanged")
          .map((item) => ({
            at: "",
            text: `摘要相同，标为未变更：${item.fileName}（更新时跳过）`,
            tone: "warn" as const,
          })),
      ]);
    },
    [appendLog, kb.docs, queue],
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const incoming: IncomingDoc[] = [];
      for (const file of files) {
        const text = isTextFile(file.name);
        incoming.push({
          id: nextId("q"),
          fileName: file.name,
          sizeBytes: file.size,
          sizeText: formatBytes(file.size),
          kindText: kindOf(file.name),
          isText: text,
          content: text ? await file.text() : "",
          category: "巡检报告",
          version: "v1.0",
          date: todayStamp(),
          source: "upload",
        });
      }
      enqueue(incoming);
      toast(`已加入入库队列：${incoming.length} 份资料（未上传到任何服务器）`, "info");
    },
    [enqueue, toast],
  );

  const importPaste = useCallback(() => {
    const trimmed = pasteText.trim();
    if (trimmed.length < 40) {
      toast("粘贴内容太短（少于 40 字），请补充后再导入", "warn");
      return;
    }
    const content = trimmed.startsWith("#") ? trimmed : `## 粘贴内容\n${trimmed}`;
    const size = new Blob([content]).size;
    enqueue([
      {
        id: nextId("q"),
        fileName: `${pasteTitle.trim() || "粘贴文本"}.md`,
        sizeBytes: size,
        sizeText: formatBytes(size),
        kindText: "粘贴文本 Markdown",
        isText: true,
        content,
        category: pasteCategory as IncomingDoc["category"],
        version: "v1.0",
        date: todayStamp(),
        source: "import",
      },
    ]);
    setPasteText("");
    setFold("none");
  }, [enqueue, pasteCategory, pasteText, pasteTitle, toast]);

  const importSeeds = useCallback(() => {
    enqueue(
      KNOWLEDGE_FILE_SEEDS.map((seed) => {
        const size = new Blob([seed.content]).size;
        return {
          id: nextId("q"),
          fileName: seed.path.split("/").pop() ?? seed.title,
          sizeBytes: size,
          sizeText: formatBytes(size),
          kindText: "Markdown",
          isText: true,
          content: seed.content,
          category: seed.category,
          version: seed.version,
          date: todayStamp(),
          source: "import" as const,
        };
      }),
    );
    setFold("none");
    toast(`已模拟从本地目录导入 ${KNOWLEDGE_FILE_SEEDS.length} 份资料`, "ok");
  }, [enqueue, toast]);

  const removeItem = useCallback((id: string) => {
    setQueue((current) => current.filter((item) => item.id !== id));
  }, []);

  const reparseItem = useCallback(
    (id: string) => {
      setQueue((current) =>
        current.map((item) =>
          item.id === id ? { ...item, status: "待解析", progress: 0, elapsedMs: 0, chunks: [], note: "已重新排入解析" } : item,
        ),
      );
      appendLog([{ at: "", text: "手动重新解析：队列项已回到「待解析」，重新走解析 → 分块 → 向量化", tone: "info" }]);
    },
    [appendLog],
  );

  /* ---------------- 队列自动推进（按真实经过的毫秒，非一步到位） ---------------- */

  useEffect(() => {
    const tick = 120;
    const timer = window.setInterval(() => {
      // StrictMode 下开发环境会挂两个定时器，用它保证一格只推进一次
      const now = Date.now();
      if (now - queueLock.current < tick * 0.6) return;
      queueLock.current = now;
      // 迁移事件在 setQueue 的 updater 里收集、在回调末尾统一写日志：
      // updater 会被 StrictMode 重复调用，日志写在里面会重复。
      const events: { item: QueueItem; from: QueueItem["status"]; to: QueueItem["status"] }[] = [];
      setQueue((current) => {
        const busy = current.some((item) => item.status === "待解析" || item.status === "解析中");
        if (!busy) return current;
        const advanced = advanceQueue(current, tick);
        events.push(...advanced.events);
        return advanced.queue;
      });
      events.forEach((event) => {
        if (event.to !== "已向量化") return;
        appendLog([
          {
            at: "",
            text: `解析完成：${event.item.fileName} · ${event.item.charsEstimated ? "估算" : "真读"} ${formatCount(event.item.chars)} 字 / ${event.item.sectionCount} 段`,
            tone: event.item.charsEstimated ? "warn" : "muted",
          },
          {
            at: "",
            text: `分块完成：${event.item.fileName} → ${event.item.chunkCount} 块（chunk_size=${KNOWLEDGE_PIPELINE.chunkMaxChars} overlap=${KNOWLEDGE_PIPELINE.chunkOverlapChars}）`,
            tone: "info",
          },
          {
            at: "",
            text: `已生成 ${vectorMeasure(event.item.chunkCount)}（${formatCount(scalarElements(event.item.chunkCount))} 个标量元素），等待「更新向量库」写入索引`,
            tone: "info",
          },
        ]);
      });
    }, tick);
    return () => window.clearInterval(timer);
  }, [appendLog]);

  /* ---------------- 日志自动滚到最新 ---------------- */

  useEffect(() => {
    const box = consoleRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs, phase.step]);

  /* ---------------- 更新向量库：六步状态机 ---------------- */

  const planRef = useRef<PlanResult | null>(null);
  const elapsedRef = useRef(0);
  const kbRef = useRef(kb);
  kbRef.current = kb;
  /** 本次流程用的模式（模式按钮在跑动中被禁用，用 ref 保证 tick 读到的是同一个值） */
  const currentModeRef = useRef<"incremental" | "rebuild">("incremental");
  /** 提交后的真实统计：让「完成」这条日志报的是入库后的数字，而不是入库前的 */
  const committedRef = useRef<UpdateStats | null>(null);
  /** 本次提交生成的版本号（后面两步的日志要报 KB-N → KB-N，不是 N-1 → N） */
  const committedVersionRef = useRef<string | null>(null);
  /** StrictMode 下开发环境会挂两个定时器，用它保证一步只走一次 */
  const tickLock = useRef(0);

  /** 规划：算清楚这次要处理几份 / 几块 / 几字，并算出六步的耗时与文案 */
  const planUpdate = useCallback(
    (items: QueueItem[], currentMode: "incremental" | "rebuild", force: boolean): PlanResult => {
      const scoped = force ? items : items.filter((item) => item.status !== "已入库");
      const pending = scoped.filter((item) => item.status !== "已向量化" && item.status !== "已入库");
      const scanned = scoped.map((item) => {
        if (!pending.some((candidate) => candidate.id === item.id)) return item;
        const chunks = makeChunksFor(item);
        return {
          ...item,
          chunks,
          chunkCount: chunks.length,
          status: "已分块" as const,
          progress: 100,
          note: item.parseMode === "text" ? "已重新解析并分块（真读文本）" : "按文件大小估算分块",
        };
      });
      const changed = scanned.filter((item) => item.change !== "unchanged");
      const chunkCount = changed.reduce((total, item) => total + item.chunks.length, 0);
      const chars = changed.reduce((total, item) => total + item.chars, 0);
      return {
        scanned,
        changed,
        steps: buildSteps(currentMode, changed.length, chunkCount, chars),
        chunkCount,
        chars,
      };
    },
    [],
  );

  /** 提交：把「已向量化」的队列项写进索引，条目 / 分块 / 向量一起涨，并记下真实统计 */
  const commitStage = useCallback(
    (items: QueueItem[], currentMode: "incremental" | "rebuild") => {
      const version = nextVersionLabel(kbRef.current.label);
      const result = commitQueue(kbRef.current, items, currentMode, nowStamp(), version);
      committedRef.current = result.stats;
      committedVersionRef.current = version;
      // 立刻更新 ref：同一个 tick 里后面的步骤要读到新版本号，不能等重渲染
      kbRef.current = result.state;
      setKb(result.state);
      setQueue((current) =>
        current.map((item) =>
          result.committedIds.includes(item.id) ? { ...item, status: "已入库", note: "已写入索引" } : item,
        ),
      );
      setVersions((list) => [
        ...list,
        {
          label: version,
          at: nowStamp(),
          mode: currentMode,
          docCount: result.state.docs.length,
          chunkCount: result.state.chunks.length,
          vectorCount: result.state.vectorCount,
          added: result.stats.docAdded,
          changed: result.stats.docChanged,
          deleted: result.stats.docDeleted,
          note: `${currentMode === "incremental" ? "增量" : "全量"}更新：新增 ${result.stats.docAdded} / 变更 ${result.stats.docChanged} / 删除 ${result.stats.docDeleted} 条，分块 +${result.stats.chunkAdded}`,
        },
      ]);
      appendLog([
        { at: "", text: `写入索引完成：条目 ${result.state.docs.length} 份 / 分块 ${result.state.chunks.length} / 向量 ${formatCount(result.state.vectorCount)} 条 · ${KNOWLEDGE_PIPELINE.embeddingDims} 维`, tone: "ok" },
        { at: "", text: `向量库版本 ${result.stats.versionFrom} → ${result.stats.versionTo}`, tone: "ok" },
      ]);
      if (result.committedIds.length) {
        toast(
          `向量库已更新到 ${version}：分块 ${result.state.chunks.length}、向量 ${formatCount(result.state.vectorCount)} 条 · ${KNOWLEDGE_PIPELINE.embeddingDims} 维`,
          "ok",
        );
      } else {
        toast("没有新的资料需要入库，索引与版本保持不变", "warn");
      }
      return result;
    },
    [appendLog, toast],
  );

  /** 主按钮：规划 → 起跑 */
  const handleUpdate = useCallback(
    (force = false) => {
      const currentMode: "incremental" | "rebuild" = force ? "rebuild" : mode;
      const plan = planUpdate(queue, currentMode, force);
      planRef.current = plan;
      currentModeRef.current = currentMode;
      committedRef.current = null;
      committedVersionRef.current = null;
      elapsedRef.current = 0;

      if (force) {
        // 全量重建：清空索引，全部文档重新处理
        setKb((current) => ({
          ...current,
          docs: [],
          chunks: [],
          vectorizedChunkIds: [],
          indexedChunkIds: [],
          vectorCount: 0,
        }));
        setPicked(null);
        setQueue((current) =>
          current.map((item) => ({
            ...item,
            status: "已向量化",
            progress: 100,
            chunks: makeChunksFor(item),
            chunkCount: makeChunksFor(item).length,
          })),
        );
        appendLog([{ at: "", text: "全量重建：清空索引条目，全部资料重新解析 → 分块 → 向量化", tone: "warn" }]);
      } else {
        setQueue(plan.scanned);
      }

      appendLog([
        {
          at: "",
          text:
            currentMode === "incremental"
              ? `增量更新：候选 ${plan.scanned.length} 份，新增 / 变更 ${plan.changed.length} 份，未变更 ${plan.scanned.length - plan.changed.length} 份跳过`
              : `全量重建：处理全部 ${plan.scanned.length} 份资料`,
          tone: "info",
        },
        { at: "", text: `待处理 ${plan.chunkCount} 块 / ${formatCount(plan.chars)} 字`, tone: "muted" },
      ]);
      if (!plan.scanned.length) {
        toast("队列为空：可在左侧上传资料，或用「全量重建」重算整个索引", "warn");
      }
      elapsedRef.current = 0;
      setPhase({ step: "parse", progress: 0, done: false });
    },
    [appendLog, mode, planUpdate, queue, toast],
  );

  /** 状态机推进：每 100ms 走一格；所有 setState 都在 interval 回调里，state updater 保持纯净 */
  useEffect(() => {
    if (!running) return;
    const tick = 100;
    tickLock.current = 0;
    const timer = window.setInterval(() => {
      // StrictMode 下开发环境会挂两个定时器，这里保证一步只走一次
      const now = Date.now();
      if (now - tickLock.current < tick * 0.6) return;
      tickLock.current = now;

      const plan = planRef.current;
      const stepKey = phase.step;
      if (!plan || !stepKey) return;
      const step = plan.steps.find((item) => item.key === stepKey);
      if (!step) return;
      const elapsed = elapsedRef.current + tick;
      elapsedRef.current = elapsed;
      setStepElapsed((prev) => ({ ...prev, [stepKey]: elapsed }));
      setPhase((current) => ({ ...current, progress: Math.min(99, Math.round((elapsed / step.ms) * 100)) }));
      if (elapsed < step.ms) return;

      const index = plan.steps.findIndex((item) => item.key === stepKey);
      const nextStep = plan.steps[index + 1];
      elapsedRef.current = 0;
      if (!nextStep) {
        appendLog([{ at: "", text: "流程结束：索引可用，可视化与检索已切到新版本", tone: "ok" }]);
        setPhase({ step: null, progress: 100, done: true });
        return;
      }
      /**
       * 第 2 步（分块）走完 = 分块数与向量数已经确定，此时就把新分块写进索引：
       * 这样「写入索引 / 重建检索索引」两步是带着新条目数在跑，页面上能直接看到
       * 条目 / 分块 / 向量在流水线中途涨上去，而不是等全部跑完才跳一次。
       */
      if (nextStep.key === "write") commitStage(plan.scanned, currentModeRef.current);
      const statsCarrier: UpdateStats = committedRef.current ?? {
        docAdded: plan.changed.length,
        docChanged: 0,
        docUnchanged: plan.scanned.length - plan.changed.length,
        docDeleted: 0,
        docTotal: kbRef.current.docs.length + plan.changed.length,
        estimatedDocs: plan.changed.filter((item) => item.parseMode === "estimate").length,
        chunkAdded: plan.chunkCount,
        chunkTotal: kbRef.current.chunks.length + plan.chunkCount,
        charsAdded: plan.chars,
        charsTotal: 0,
        vectorAdded: plan.chunkCount,
        vectorTotal: kbRef.current.chunks.length + plan.chunkCount,
        versionFrom: kbRef.current.label,
        versionTo: nextVersionLabel(kbRef.current.label),
      };
      if (committedVersionRef.current) {
        // 已经写过索引：这两步的版本号是「刚生成的版本 → 下一次重建」，不是旧版本 → 新版本
        statsCarrier.versionFrom = committedVersionRef.current;
        statsCarrier.versionTo = committedVersionRef.current;
      }
      appendLog(stepLogs(nextStep, currentModeRef.current, statsCarrier));
      setPhase({ step: nextStep.key, progress: 0, done: false });
    }, tick);
    return () => window.clearInterval(timer);
  }, [appendLog, commitStage, phase.step, running]);

  /* ---------------- 回滚 ---------------- */

  const rollback = useCallback(
    (target: KbVersion) => {
      const currentLabel = versions[versions.length - 1]?.label;
      if (target.label === currentLabel) {
        toast(`${target.label} 就是当前版本，无需回滚`, "warn");
        return;
      }
      setKb((current) => {
        // 回滚 = 把索引截断到目标版本的规模：保留前 target.chunkCount 个分块
        const keptChunks = current.chunks.slice(0, target.chunkCount);
        const keptIds = keptChunks.map((chunk) => chunk.chunkId);
        return {
          ...current,
          label: target.label,
          docs: current.docs.filter((doc) => keptChunks.some((chunk) => chunk.docId === doc.docId)),
          chunks: keptChunks,
          vectorizedChunkIds: [...keptIds],
          indexedChunkIds: [...keptIds],
          builtAt: nowStamp(),
          mode: "rollback",
          vectorCount: keptChunks.length,
        };
      });
      setVersions((list) => [
        ...list,
        {
          label: target.label,
          at: nowStamp(),
          mode: "rollback",
          docCount: target.docCount,
          chunkCount: target.chunkCount,
          vectorCount: target.vectorCount,
          added: 0,
          changed: 0,
          deleted: Math.max(0, (list[list.length - 1]?.chunkCount ?? 0) - target.chunkCount),
          note: `回滚到 ${target.label}：只切前端状态，新增资料回到待入库队列`,
        },
      ]);
      setQueue((items) =>
        items.map((item) => (item.status === "已入库" ? { ...item, status: "已向量化", note: "已回滚，等待重新更新" } : item)),
      );
      appendLog([
        { at: "", text: `回滚：向量库版本 ${currentLabel} → ${target.label}`, tone: "warn" },
        {
          at: "",
          text: `回滚后条目 ${target.docCount} / 分块 ${target.chunkCount} / 向量 ${formatCount(target.vectorCount)} 条 · ${KNOWLEDGE_PIPELINE.embeddingDims} 维`,
          tone: "warn",
        },
      ]);
      toast(
        `已回滚到 ${target.label}：分块 ${target.chunkCount}、向量 ${formatCount(target.vectorCount)} 条 · ${KNOWLEDGE_PIPELINE.embeddingDims} 维`,
        "warn",
      );
    },
    [appendLog, toast, versions],
  );

  /* ---------------- 向量空间（真算：TF-IDF → 768 维 → PCA 前三主成分 → 余弦关系链） ---------------- */

  const deferredChunks = useDeferredValue(kb.chunks);
  const space = useMemo(() => buildVectorSpace(deferredChunks), [deferredChunks]);
  /** 悬停只看，选中才落到 kb-picked；两者都算「焦点」，邻居边一起高亮 */
  const [hovered, setHovered] = useState<number | null>(null);

  /* ---------------- 检索（复用 lib.searchKnowledge） ---------------- */

  const search = useMemo(
    () =>
      runSearch(kb.chunks, submitted, KNOWLEDGE_META.topK, {
        category: filterCategory,
        from: filterFrom,
        to: filterTo,
      }),
    [filterCategory, filterFrom, filterTo, kb.chunks, submitted],
  );

  const hitKey = useMemo(
    () => search.hits.map((hit) => `${hit.chunkId}:${hit.similarity}`).join("|"),
    [search.hits],
  );
  /**
   * 命中集合从指纹解析出来：依赖是字符串，命中没变就不会重建 Set，
   * 也不会每帧重刷关系链的颜色。
   */
  const hitIds = useMemo(() => {
    const ids = new Set<string>();
    hitKey
      .split("|")
      .filter(Boolean)
      .forEach((entry) => {
        const separator = entry.lastIndexOf(":");
        if (separator <= 0) return;
        ids.add(entry.slice(0, separator));
      });
    return ids;
  }, [hitKey]);
  const activeHit = search.hits.find((hit) => hit.chunkId === picked) ?? search.hits[0] ?? null;

  /* ---------------- 关系链：节点序号 ↔ 分块 ---------------- */

  const focusIndex = hovered ?? (picked ? space.points.findIndex((point) => point.chunkId === picked) : -1);
  const focusPoint = focusIndex >= 0 ? space.points[focusIndex] : null;

  /** 检索命中的块在关系链里的序号：有命中时非命中节点压暗 */
  const hitIndices = useMemo(() => {
    const indices = new Set<number>();
    if (!hitIds.size) return indices;
    space.points.forEach((point, index) => {
      if (hitIds.has(point.chunkId)) indices.add(index);
    });
    return indices;
  }, [hitIds, space]);

  /**
   * 焦点节点的邻居及相似度：读数条里要写清「这条边为什么连上」，
   * 直接从 graph.edges 反查，不另存一份。
   */
  const focusLinks = useMemo(() => {
    if (focusIndex < 0) return [];
    return space.graph.edges
      .filter((edge) => edge.a === focusIndex || edge.b === focusIndex)
      .map((edge) => ({
        index: edge.a === focusIndex ? edge.b : edge.a,
        similarity: edge.similarity,
      }))
      .sort((left, right) => right.similarity - left.similarity);
  }, [focusIndex, space.graph.edges]);

  const graphFocus = useMemo(
    () => ({ index: focusIndex >= 0 ? focusIndex : null, hitIndices }),
    [focusIndex, hitIndices],
  );

  /* ---------------- 图表 option ---------------- */

  const distRows = useMemo(() => {
    if (distDim === "category") return distributionByCategory(kb.chunks, kb.docs);
    if (distDim === "month") return distributionByMonth(kb.chunks, kb.docs);
    return distributionByDoc(kb.chunks, kb.docs);
  }, [distDim, kb.chunks, kb.docs]);

  const distOption = useMemo(
    () =>
      ({
        backgroundColor: "transparent",
        animationDuration: 320,
        grid: { left: 104, right: 34, top: 14, bottom: 26 },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow", shadowStyle: { color: "rgba(78,168,255,0.06)" } },
          backgroundColor: KB_CHART.tooltipBg,
          borderColor: KB_CHART.tooltipBorder,
          borderWidth: 1,
          textStyle: { color: KB_CHART.textSecondary, fontSize: 11 },
          formatter: (params: unknown) => {
            const list = params as { dataIndex: number }[];
            const row = distRows[list[0]?.dataIndex ?? 0];
            if (!row) return "";
            return [
              `<b style="color:${KB_CHART.textPrimary}">${row.label}</b>`,
              `分块 ${row.chunks} · 资料 ${row.docs} 份`,
              `字符 ${formatCount(row.chars)}`,
              `占比 ${((row.chunks / Math.max(1, kb.chunks.length)) * 100).toFixed(1)}%`,
            ].join("<br/>");
          },
        },
        xAxis: {
          type: "value",
          axisLine: { lineStyle: { color: KB_CHART.axisLine } },
          axisLabel: { color: KB_CHART.axisText, fontSize: 11 },
          splitLine: { lineStyle: { color: KB_CHART.grid } },
        },
        yAxis: {
          type: "category",
          inverse: true,
          data: distRows.map((row) => row.label),
          axisLine: { lineStyle: { color: KB_CHART.axisLine } },
          axisTick: { show: false },
          axisLabel: { color: KB_CHART.axisText, fontSize: 11, width: 96, overflow: "truncate" },
        },
        series: [
          {
            name: "分块数",
            type: "bar",
            barMaxWidth: 14,
            itemStyle: {
              color: (params: unknown) => {
                const payload = params as { dataIndex: number };
                const row = distRows[payload.dataIndex];
                return row?.category ? categoryColor(row.category) : KB_CHART.palette[0];
              },
            },
            label: { show: true, position: "right", color: KB_CHART.textSecondary, fontSize: 11, formatter: "{c}" },
            data: distRows.map((row) => row.chunks),
          },
        ],
      }) as unknown as Record<string, unknown>,
    [distRows, kb.chunks.length],
  );

  /* ---------------- 业务状态（结构化数据，不来自资料） ---------------- */
  const liveFacts = [
    { k: "本轮风险", v: `${CURRENT_RISKS.length} 处（CUR-Z04-01~03）` },
    { k: "历史风险", v: `R01–R06 共 ${HISTORY_STATS.total} 处` },
    { k: "已关闭", v: `${HISTORY_STATS.closed} 处` },
    { k: "未关闭", v: `${HISTORY_STATS.open} 处` },
  ];

  const readyCount = queue.filter((item) => item.status === "已向量化").length;
  const totalChars = kb.chunks.reduce((total, chunk) => total + chunk.chars, 0);

  return (
    <div className="page page--knowledge">
      <div className="kb-body">
        {/* ============ 主任务：上传资料 → 更新向量库 ============ */}
        <div className="kb-main">
          {/* 左列：资料与索引管理（上传 + 更新），辅助区 */}
          <div className="kb-manage">
          <Panel
            title="上传资料"
            extra={
              <>
                <StatusChip text={`队列 ${queue.length}`} tone={queue.length ? "info" : "muted"} />
                <SourceTag label="本地读取，不上传" />
              </>
            }>
            <div className="kb-up">
              <div
                className={`kb-drop ${dragging ? "is-over" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  dragDepth.current += 1;
                  setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => {
                  dragDepth.current -= 1;
                  if (dragDepth.current <= 0) {
                    dragDepth.current = 0;
                    setDragging(false);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  dragDepth.current = 0;
                  setDragging(false);
                  void handleFiles([...event.dataTransfer.files]);
                }}>
                <span className="kb-drop__icon">⇪</span>
                <b>把资料拖到这里</b>
                <em>
                  Markdown / TXT / CSV 真读内容；PDF / 图片 / 压缩包只登记清单并标注「估算」
                  <br />
                  文件不离开本机，解析、分块、向量化都在浏览器内完成
                </em>
              </div>

              <div className="kb-actions kb-actions--nowrap">
                <label className="kb-openfile btn btn--primary">
                  选择文件上传
                  <input
                    type="file"
                    multiple
                    onChange={(event) => {
                      void handleFiles([...(event.target.files ?? [])]);
                      event.target.value = "";
                    }}
                  />
                </label>
                <Btn active={fold === "paste"} onClick={() => setFold(fold === "paste" ? "none" : "paste")}>
                  粘贴文本导入
                </Btn>
                <Btn active={fold === "folder"} onClick={() => setFold(fold === "folder" ? "none" : "folder")}>
                  选择本地目录导入
                </Btn>
                <span className="kb-actions__hint">
                  不上传任何服务器：解析 / 分块 / 向量化全部在浏览器内完成
                  <br />
                  {KB_DEMO_NOTES.scope}
                </span>
              </div>
            </div>

            {fold === "paste" ? (
              <div className="kb-fold">
                <div className="kb-fold__head">
                  <span>粘贴文本 → 生成一份 Markdown 资料</span>
                  <i>{pasteText.trim().length} 字</i>
                </div>
                <div className="kb-fold__body">
                  <textarea
                    value={pasteText}
                    onChange={(event) => setPasteText(event.target.value)}
                    placeholder={"例如：\n## 现场补充记录\n把现场记录或聊天结论粘贴进来，导入后同样要经过解析 → 分块 → 向量化。"}
                  />
                  <div className="kb-fold__row">
                    <label>
                      文件名
                      <input
                        className="kb-inline-input"
                        type="text"
                        value={pasteTitle}
                        onChange={(event) => setPasteTitle(event.target.value)}
                      />
                    </label>
                    <label>
                      类别
                      <select value={pasteCategory} onChange={(event) => setPasteCategory(event.target.value)}>
                        {KB_CATEGORIES.map((category) => (
                          <option key={category} value={category}>
                            {category}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Btn tone="primary" onClick={importPaste}>
                      加入待入库队列
                    </Btn>
                  </div>
                </div>
              </div>
            ) : null}

            {fold === "folder" ? (
              <div className="kb-fold">
                <div className="kb-fold__head">
                  <span>模拟目录导入 · {KB_SEED_SUMMARY.count} 份资料</span>
                  <i>批量</i>
                </div>
                <div className="kb-fold__body">
                  <ul className="kb-seeds">
                    {KNOWLEDGE_FILE_SEEDS.map((seed) => (
                      <li key={seed.fileId}>
                        <b>{seed.path}</b>
                        <span>
                          {seed.category} · {formatCount(seed.content.length)} 字
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="kb-actions__hint">
                    浏览器不允许网页自行遍历本地目录，所以这里用打包好的种子语料模拟「选择目录后整批导入」；
                    导入的仍是真实文本，字符数与分块数由分块器真算。
                  </p>
                  <div className="kb-fold__row">
                    <Btn tone="primary" onClick={importSeeds}>
                      导入这 {KB_SEED_SUMMARY.count} 份资料
                    </Btn>
                    <Btn onClick={() => setFold("none")}>取消</Btn>
                  </div>
                </div>
              </div>
            ) : null}
          </Panel>

          {/* 管理列的下一块：更新动作 + 六步 + 终端日志 */}
          <div className="kb-run">
            <Panel
              title="更新 RAG 向量库"
              extra={
                <>
                  <StatusChip
                    text={running ? "进行中" : phase.done ? "已完成" : "待更新"}
                    tone={running ? "info" : phase.done ? "ok" : "muted"}
                  />
                  <SourceTag label={`索引 ${kb.label}`} />
                </>
              }>
              <div className="kb-seg">
                <span className="kb-seg__label">更新模式</span>
                <Btn active={mode === "incremental"} onClick={() => setMode("incremental")} disabled={running}>
                  增量更新
                </Btn>
                <Btn active={mode === "rebuild"} onClick={() => setMode("rebuild")} disabled={running}>
                  全量重建
                </Btn>
                <span className="kb-actions__hint">{mode === "incremental" ? "只处理新增 / 变更" : "清空索引重算全部"}</span>
              </div>

              <div className="kb-actions kb-actions--nowrap">
                <Btn tone="primary" onClick={() => handleUpdate(mode === "rebuild")} disabled={running}>
                  更新向量库
                </Btn>
                <Btn onClick={() => handleUpdate(true)} disabled={running}>
                  全量重建索引
                </Btn>
                <span className="kb-actions__hint">
                  待入库 {queue.filter((item) => item.status !== "已入库").length} 份 · 未变更{" "}
                  {queue.filter((item) => item.change === "unchanged").length} 份
                </span>
              </div>

              <ol className="kb-steps">
                {steps.map((step, index) => {
                  const currentIndex = phase.step ? STEP_ORDER.indexOf(phase.step) : phase.done ? STEP_ORDER.length : -1;
                  const stepPhase = index < currentIndex ? "done" : index === currentIndex ? "active" : "wait";
                  return (
                    <li
                      key={step.key}
                      className={stepPhase === "done" ? "is-done" : stepPhase === "active" ? "is-active" : ""}>
                      <span className="kb-steps__dot" />
                      <div className="kb-steps__copy">
                        <b>
                          {index + 1}. {step.label}
                        </b>
                        <span>{step.detail}</span>
                      </div>
                      <div className="kb-steps__meta">
                        <em>
                          {stepPhase === "done" ? "已完成" : stepPhase === "active" ? `${phase.progress}%` : "等待"}
                        </em>
                        <span>
                          {(stepElapsed[step.key] ?? 0) > 0
                            ? formatSeconds(stepElapsed[step.key])
                            : `预计 ${(step.ms / 1000).toFixed(1)}s`}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>

              <div className="kb-overall">
                <div className="kb-overall__bar">
                  <i
                    style={{
                      width: `${phase.step ? overallProgress(phase.step, phase.progress) : phase.done ? 100 : 0}%`,
                    }}
                  />
                </div>
                <span className="kb-overall__text">
                  {phase.step
                    ? `${STEP_ORDER.indexOf(phase.step) + 1}/6 ${STEP_LABELS[phase.step]} · ${phase.progress}%`
                    : phase.done
                      ? "6/6 完成"
                      : "0/6 未开始 · 增量只处理新增 / 变更，全量重建会重算全部"}
                </span>
              </div>

              <h4 className="sub">
                待入库队列
                <span className="kb-actions__hint">
                  {" "}
                  · 待解析{" "}
                  {queue.filter((item) => item.status === "待解析" || item.status === "解析中").length} · 已向量化{" "}
                  {readyCount} · 已入库 {queue.filter((item) => item.status === "已入库").length}
                </span>
              </h4>
              {queue.length ? (
                <div className="kb-queue">
                  {queue.map((item) => {
                    const busy = item.status === "待解析" || item.status === "解析中";
                    return (
                      <div
                        key={item.id}
                        className={`kb-queue__item ${busy ? "is-running" : ""} ${
                          item.status === "已入库" ? "is-done" : ""
                        } ${item.change === "unchanged" ? "is-unchanged" : ""}`}>
                        <div className="kb-queue__name">
                          <b title={item.fileName}>{item.fileName}</b>
                          <span>
                            {item.kindText} · {item.sizeText} ·{" "}
                            {item.change === "unchanged" ? "摘要相同（未变更）" : "新增"} · {item.note}
                          </span>
                        </div>
                        <div className="kb-queue__stat">
                          <span className={item.charsEstimated ? "is-estimated" : ""}>
                            {item.charsEstimated ? "≈ " : ""}
                            {formatCount(item.chars)} 字
                          </span>
                          <em>
                            {item.chunks.length ? `实切 ${item.chunks.length} 块` : `预估 ${item.chunkCount} 块`}
                            {item.chunks.length ? ` · ${vectorMeasure(item.chunks.length)}` : ""}
                          </em>
                        </div>
                        <div className="kb-queue__ops">
                          <StatusChip text={item.status} tone={QUEUE_TONE[item.status] ?? "info"} />
                          <button type="button" onClick={() => reparseItem(item.id)} disabled={running}>
                            重新解析
                          </button>
                          <button type="button" onClick={() => removeItem(item.id)} disabled={running}>
                            移除
                          </button>
                        </div>
                        {busy ? (
                          <div className="kb-bar">
                            <i style={{ width: `${item.progress}%` }} />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="kb-queue__empty">
                  队列为空：拖入文件、粘贴一段文本，或点「选择本地目录导入」整批示例资料，再点上面的「更新向量库」。
                  上传只读取文件名 / 大小 / 类型，文本类会真读内容算字符数。
                </div>
              )}
            </Panel>

            <Panel title="流水线日志" extra={<SourceTag label="等宽输出 · 自动滚动" />}>
              <div className="kb-console kb-scroll" ref={consoleRef}>
                {logs.map((entry, index) => (
                  <div
                    key={`${entry.at}-${index}-${entry.text.slice(0, 10)}`}
                    className={`kb-console__line is-${entry.tone} ${running && index === logs.length - 1 ? "is-cursor" : ""}`}>
                    <time>{entry.at}</time>
                    <span>{entry.text}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
          </div>

          {/* ============ 主区：检索工作区（首屏要直接证明「从哪份资料找到什么答案」） ============ */}
          <Panel
            title="检索与回答"
            extra={
              <>
                <StatusChip
                  text={search.belowThreshold ? "未达阈值" : search.hits.length ? `命中 ${search.hits.length}` : "无命中"}
                  tone={search.belowThreshold ? "warn" : search.hits.length ? "ok" : "muted"}
                />
                <SourceTag label={`索引 ${kb.label}`} />
              </>
            }>
            <div className="kb-ask">
              <form
                className="kb-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSubmitted(query);
                  setPicked(null);
                }}>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="输入一句话，例如：复检 / 渗水痕迹 / 平衡含水率 / 验收关闭"
                  aria-label="检索资料"
                />
                <Btn
                  tone="primary"
                  onClick={() => {
                    setSubmitted(query);
                    setPicked(null);
                  }}>
                  检索
                </Btn>
              </form>

              <div className="kb-filters">
                <label>
                  类别
                  <select value={filterCategory} onChange={(event) => setFilterCategory(event.target.value)}>
                    <option value="全部">全部</option>
                    {KB_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  起始日期
                  <input type="date" value={filterFrom} onChange={(event) => setFilterFrom(event.target.value)} />
                </label>
                <label>
                  截止日期
                  <input type="date" value={filterTo} onChange={(event) => setFilterTo(event.target.value)} />
                </label>
                <span className="kb-ask__legend">本地 TF-IDF（中文字符 2–4 元）· 余弦相似度 · 阈值 {KNOWLEDGE_META.noHitThreshold}</span>
              </div>

              <div className="kb-viz__stats">
                <span>
                  过滤后候选 <b>{search.filtered}</b> / <b>{search.total}</b>
                </span>
                <span>
                  查询词 <b>{search.queryTokens}</b>
                </span>
                <span>
                  命中 <b>{search.hits.length}</b>
                </span>
                <span>
                  查询词 <b>「{submitted}」</b>
                </span>
              </div>

              {search.hits.length && search.belowThreshold ? (
                <StateBlock
                  kind="partial"
                  title={`最高检索相似度 ${search.hits[0].similarity.toFixed(4)} 低于阈值 ${KNOWLEDGE_META.noHitThreshold}`}
                  hint="未达命中阈值，仅作参考。"
                />
              ) : null}

              <div className="kb-ask__body">
                {search.hits.length ? (
                  <ul className="kb-hits kb-scroll">
                    {search.hits.map((hit) => (
                      <li
                        key={hit.chunkId}
                        className={activeHit?.chunkId === hit.chunkId ? "is-active" : ""}
                        onClick={() => setPicked(hit.chunkId)}>
                        <div className="kb-hits__copy">
                          <b>
                            #{hit.rank} {hit.docTitle}
                          </b>
                          <span>
                            {hit.section} · <code>{hit.chunkId}</code> · {hit.source}
                          </span>
                          <em>{hit.text.slice(0, 52)}…</em>
                        </div>
                        <div className="kb-hits__rank">
                          <b>{hit.similarity.toFixed(4)}</b>
                          <i>
                            <em style={{ width: `${Math.min(100, hit.similarity * 100)}%` }} />
                          </i>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <StateBlock
                    kind="empty"
                    title="当前资料未检索到"
                    hint="本地索引无命中，或已被筛选条件排除。"
                  />
                )}

                {activeHit ? (
                  <article className="kb-snippet">
                    <dl>
                      <div>
                        <dt>来源</dt>
                        <dd>{activeHit.docTitle}</dd>
                      </div>
                      <div>
                        <dt>位置</dt>
                        <dd>{activeHit.section}</dd>
                      </div>
                      <div>
                        <dt>分块</dt>
                        <dd>{activeHit.chunkId}</dd>
                      </div>
                      <div>
                        <dt>检索相似度</dt>
                        <dd>{activeHit.similarity.toFixed(4)}</dd>
                      </div>
                    </dl>
                    <p>{highlightTerms(activeHit.text, submitted).map((part, index) =>
                      part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
                    )}</p>
                  </article>
                ) : null}
              </div>

              <div className="kb-actions">
                <Btn onClick={() => askAssistant(submitted)}>把小木叫来一起看</Btn>
                <span className="kb-actions__hint">{KB_DEMO_NOTES.search}</span>
              </div>
            </div>
          </Panel>

          {/* ============ 观察列：技术观察 + 索引状态 ============ */}
          <div className="kb-side">
          <Panel
            /*
              标题只写「技术观察」：观察列只有 400px，原来「技术观察 · Token 关系链」
              加上两个页签按钮宽度合计 231px，标题栏放不下、被顶出面板 104px。
              具体看哪一张由页签表达，标题不重复一遍。
            */
            title="技术观察"
            extra={
              <>
                {/*
                  「相似度检索」原来是这里的第三个页签 —— 最有价值的东西被埋在
                  辅助面板的最后一页，首屏根本看不到（评审 U01/V03）。它现在移到
                  中列成了页面的主区，这里只留技术观察。
                */}
                {(["space", "dist"] as const).map((key) => (
                  <Btn key={key} active={tab === key} onClick={() => setTab(key)}>
                    {key === "space" ? "关系链" : "分块分布"}
                  </Btn>
                ))}
              </>
            }>
            {tab === "space" ? (
              <>
                {space.chunkCount ? (
                  <div className="kb3d">
                    <TokenGraph3D
                      graph={space.graph}
                      categories={space.points.map((point) => point.category)}
                      focus={graphFocus}
                      onHover={setHovered}
                      onPick={(index) => {
                        const chunk = space.points[index];
                        if (chunk) setPicked(chunk.chunkId);
                      }}
                    />

                    {/* 左上：这张图是怎么算出来的，用数字说话 */}
                    <div className="kb3d__hud">
                      <span>
                        节点 <b>{space.graph.stats.nodes}</b>
                      </span>
                      <span>
                        关系边 <b>{space.graph.stats.edges}</b>
                      </span>
                      <span>
                        平均余弦 <b>{space.graph.stats.simAvg.toFixed(3)}</b>
                      </span>
                      <span>
                        三主成分累计 <b>{(space.explainedTotal * 100).toFixed(1)}%</b>
                      </span>
                    </div>

                    {/* 右上：放大到弹窗看，面板里这块只有 250px 高 */}
                    <button type="button" className="kb3d__expand" onClick={() => setGraphExpanded(true)}>
                      放大
                    </button>

                    {/* 左下：类别图例 */}
                    <div className="kb3d__legend">
                      {KB_CATEGORIES.filter((category) =>
                        space.points.some((point) => point.category === category),
                      ).map((category) => (
                        <span key={category}>
                          <i style={{ background: categoryColor(category) }} />
                          {category}（{space.points.filter((point) => point.category === category).length}）
                        </span>
                      ))}
                    </div>

                    {/* 右下：焦点读数。悬停看邻居，点选后把块摘要也带出来 */}
                    <div className="kb3d__readout">
                      {focusPoint ? (
                        <>
                          <b>
                            <code>{focusPoint.chunkId}</code> · {focusPoint.docTitle}
                          </b>
                          <span>
                            {focusPoint.category} · {focusPoint.section} · {focusPoint.chars} 字 ·{" "}
                            {focusPoint.degree} 条关系 · 权重 {focusPoint.weight.toFixed(3)}
                          </span>
                          <span className="kb3d__links">
                            {focusLinks.map((link) => (
                              <button
                                key={link.index}
                                type="button"
                                onMouseEnter={() => setHovered(link.index)}
                                onMouseLeave={() => setHovered(null)}
                                onClick={() => setPicked(space.points[link.index].chunkId)}>
                                {space.points[link.index].chunkId}
                                <em>{link.similarity.toFixed(3)}</em>
                              </button>
                            ))}
                          </span>
                          {picked === focusPoint.chunkId ? (
                            <p className="kb3d__excerpt">{focusPoint.excerpt}</p>
                          ) : null}
                        </>
                      ) : (
                        <span className="kb3d__hint">拖动旋转 · 滚轮缩放 · 悬停看点，点选看块摘要</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <StateBlock kind="empty" title="向量库为空" hint="全量重建将清空现有索引。" />
                )}
              </>
            ) : null}

            {tab === "dist" ? (
              <>
                <div className="kb-viz__stats">
                  <span className="kb-seg__label">分布维度</span>
                  <Btn active={distDim === "doc"} onClick={() => setDistDim("doc")}>
                    按文档
                  </Btn>
                  <Btn active={distDim === "category"} onClick={() => setDistDim("category")}>
                    按类别
                  </Btn>
                  <Btn active={distDim === "month"} onClick={() => setDistDim("month")}>
                    按时间
                  </Btn>
                  <span>
                    合计 <b>{formatCount(totalChars)}</b> 字 / <b>{kb.chunks.length}</b> 块
                  </span>
                </div>
                <EChart option={distOption} height={240} />
                <p className="kb-actions__hint">
                  柱长为该维度下的分块数（真统计，不是估算）：按文档看每份资料切了多少块，按类别看六类资料的占比，
                  按时间看本次导入把哪个月份补了进来。
                </p>
              </>
            ) : null}


                {search.hits.length ? (
                  <ul className="kb-hits kb-scroll" style={{ maxHeight: 148 }}>
                    {search.hits.map((hit) => (
                      <li
                        key={hit.chunkId}
                        className={activeHit?.chunkId === hit.chunkId ? "is-active" : ""}
                        onClick={() => setPicked(hit.chunkId)}>
                        <div className="kb-hits__copy">
                          <b>
                            #{hit.rank} {hit.docTitle}
                          </b>
                          <span>
                            {hit.section} · <code>{hit.chunkId}</code> · {hit.source}
                          </span>
                          <em>{hit.text.slice(0, 52)}…</em>
                        </div>
                        <div className="kb-hits__rank">
                          <b>{hit.similarity.toFixed(4)}</b>
                          <i>
                            <em style={{ width: `${Math.min(100, hit.similarity * 100)}%` }} />
                          </i>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <StateBlock
                    kind="empty"
                    title="当前资料未检索到"
                    hint="本地索引无命中，或已被筛选条件排除。"
                  />
                )}

                {activeHit ? (
                  <div className="kb-snippet">
                    <dl>
                      <div>
                        <dt>文件</dt>
                        <dd>{activeHit.source}</dd>
                      </div>
                      <div>
                        <dt>版本</dt>
                        <dd>{activeHit.version}</dd>
                      </div>
                      <div>
                        <dt>章节</dt>
                        <dd>{activeHit.section}</dd>
                      </div>
                      <div>
                        <dt>原文位置</dt>
                        <dd>
                          {activeHit.chunkId} · 第{" "}
                          {kb.chunks.find((chunk) => chunk.chunkId === activeHit.chunkId)?.paragraphIndex ?? "—"} 段
                        </dd>
                      </div>
                      <div>
                        <dt>日期</dt>
                        <dd>{activeHit.date}</dd>
                      </div>
                      <div>
                        <dt>检索相似度</dt>
                        <dd>{activeHit.similarity.toFixed(4)}（不是病害置信度）</dd>
                      </div>
                    </dl>
                    <p>
                      {highlightTerms(activeHit.text, submitted).map((part, index) =>
                        part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
                      )}
                    </p>
                  </div>
                ) : null}

          </Panel>

          <Panel
            title="索引状态"
            extra={
              <StatusChip
                text={consistency.consistent ? "条目 / 分块 / 向量一致" : "不一致，需重建"}
                tone={consistency.consistent ? "ok" : "danger"}
              />
            }>
            <div className="kb-scrollpanel">
              <dl className="kv">
                <div>
                  <dt>索引版本</dt>
                  <dd>
                    {kb.label} <span className="kb-actions__hint">（{KNOWLEDGE_META.indexVersion}）</span>
                  </dd>
                </div>
                <div>
                  <dt>总条目数（资料）</dt>
                  <dd>{kb.docs.length} 份</dd>
                </div>
                <div>
                  <dt>总条目数（分块）</dt>
                  <dd>{kb.chunks.length} 块</dd>
                </div>
                <div>
                  <dt>向量条数</dt>
                  <dd>{vectorMeasure(kb.vectorCount)}</dd>
                </div>
                <div>
                  <dt>标量元素数</dt>
                  <dd>{formatCount(scalarElements(kb.vectorCount))} 个（向量条数 × 维度，不是向量条数）</dd>
                </div>
                <div>
                  <dt>已写入索引</dt>
                  <dd>{kb.indexedChunkIds.length} 块</dd>
                </div>
                <div>
                  <dt>字符总量</dt>
                  <dd>{formatCount(totalChars)} 字</dd>
                </div>
                <div>
                  <dt>分块参数</dt>
                  <dd>
                    chunk_size {KNOWLEDGE_PIPELINE.chunkMaxChars} / overlap {KNOWLEDGE_PIPELINE.chunkOverlapChars}
                  </dd>
                </div>
                <div>
                  <dt>向量维度</dt>
                  <dd>{KNOWLEDGE_PIPELINE.embeddingDims}（模拟）</dd>
                </div>
                <div>
                  <dt>构建时间</dt>
                  <dd>{kb.builtAt}</dd>
                </div>
                <div>
                  <dt>版本历史</dt>
                  <dd>{versions.length} 条</dd>
                </div>
              </dl>
              {/* 规范 v1.1 §6：向量按条计数、维度单列，条数不是资料质量的度量 */}
              <p className="kb-actions__hint">{KB_DEMO_NOTES.vectorCount}</p>

              <h4 className="sub">业务状态（结构化数据，不来自资料）</h4>
              <dl className="kv">
                {liveFacts.map((fact) => (
                  <div key={fact.k}>
                    <dt>{fact.k}</dt>
                    <dd>{fact.v}</dd>
                  </div>
                ))}
              </dl>
              <h4 className="sub">演示边界</h4>
              <p className="kb-actions__hint">{KB_DEMO_NOTES.scope}</p>
              <p className="kb-actions__hint">{KB_DEMO_NOTES.embedding}</p>
              <p className="kb-actions__hint">{KNOWLEDGE_META.note}</p>
            </div>
          </Panel>
        </div>
        </div>

        {/* ============ 历史：版本与资料清单 ============ */}
        <div className="kb-bottom">
          <Panel
            title="版本历史"
            extra={
              <>
                <StatusChip text={`当前 ${kb.label}`} tone="info" />
                <span className="kb-actions__hint">回滚只切前端状态</span>
              </>
            }>
            <div className="kb-versions kb-scroll">
              {[...versions].reverse().map((version, reverseIndex) => {
                const position = versions.length - 1 - reverseIndex;
                return (
                  <div
                    key={`${version.label}-${version.at}-${position}`}
                    className={`kb-versions__row ${position === versions.length - 1 ? "is-current" : ""}`}>
                    <b>{version.label}</b>
                    <div className="kb-versions__copy">
                      <span>
                        {version.at} ·{" "}
                        {version.mode === "seed"
                          ? "初始索引"
                          : version.mode === "incremental"
                            ? "增量更新"
                            : version.mode === "rebuild"
                              ? "全量重建"
                              : "回滚"}{" "}
                        · 条目 {version.docCount} / 分块 {version.chunkCount} / 向量 {formatCount(version.vectorCount)} 条
                        · {KNOWLEDGE_PIPELINE.embeddingDims} 维
                      </span>
                      <em>
                        新增 {version.added} · 变更 {version.changed} · 删除 {version.deleted} · {version.note}
                      </em>
                    </div>
                    {position === versions.length - 1 ? (
                      <StatusChip text="当前" tone="info" />
                    ) : (
                      <button
                        type="button"
                        className="kb-rollback"
                        title={`把索引切回 ${version.label}（前端状态，不落盘）`}
                        onClick={() => rollback(version)}>
                        回滚到此版本
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="kb-actions__hint">{KB_DEMO_NOTES.rollback}</p>
          </Panel>

          <Panel
            title="资料清单"
            extra={
              <>
                <StatusChip text={`${kb.docs.length} 份`} tone="muted" />
                <StatusChip text={`${kb.chunks.length} 块`} tone="muted" />
              </>
            }>
            <ul className="kb-docs kb-scroll">
              {kb.docs.map((doc) => (
                <li key={doc.docId}>
                  <b title={doc.title}>
                    {doc.title}
                    {doc.parseMode === "estimate" ? "（估算）" : ""}
                  </b>
                  <span>
                    {doc.category} · {doc.date} · {doc.chunkCount} 块 · {formatCount(doc.chars)} 字 ·{" "}
                    {doc.changeFlag === "seed" ? "初始" : doc.changeFlag === "changed" ? "本次变更" : "本次新增"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="kb-actions__hint">
              {KB_DEMO_NOTES.estimated} {PARSE_MODE_NOTE.estimated}
            </p>
            <p className="kb-actions__hint">{KB_DEMO_NOTES.incremental}</p>
          </Panel>
        </div>
      </div>

      {graphExpanded && space.chunkCount ? (
        <Modal
          wide
          title="向量库可视化 · Token 关系链"
          subtitle={KB_DEMO_NOTES.projection}
          onClose={() => setGraphExpanded(false)}>
          <div className="kb3d kb3d--large">
            <TokenGraph3D
              graph={space.graph}
              categories={space.points.map((point) => point.category)}
              focus={graphFocus}
              onHover={setHovered}
              onPick={(index) => {
                const chunk = space.points[index];
                if (chunk) setPicked(chunk.chunkId);
              }}
            />
            <div className="kb3d__hud">
              <span>
                节点 <b>{space.graph.stats.nodes}</b>
              </span>
              <span>
                关系边 <b>{space.graph.stats.edges}</b>
              </span>
              <span>
                平均余弦 <b>{space.graph.stats.simAvg.toFixed(3)}</b>
              </span>
              <span>
                最强边 <b>{space.graph.stats.simMax.toFixed(3)}</b>
              </span>
              <span>
                维度 <b>{space.dims}</b>
              </span>
              <span>
                三主成分 <b>{(space.explained[0] * 100).toFixed(1)}% / {(space.explained[1] * 100).toFixed(1)}% / {(space.explained[2] * 100).toFixed(1)}%</b>
              </span>
              <span>
                布局 <b>{space.graph.stats.iterations} 次迭代 · {space.graph.stats.layoutMs} ms</b>
              </span>
            </div>
            <div className="kb3d__legend">
              {KB_CATEGORIES.filter((category) => space.points.some((point) => point.category === category)).map(
                (category) => (
                  <span key={category}>
                    <i style={{ background: categoryColor(category) }} />
                    {category}（{space.points.filter((point) => point.category === category).length}）
                  </span>
                ),
              )}
            </div>
            <div className="kb3d__readout">
              {focusPoint ? (
                <>
                  <b>
                    <code>{focusPoint.chunkId}</code> · {focusPoint.docTitle}
                  </b>
                  <span>
                    {focusPoint.section} · {focusPoint.chars} 字 · {focusPoint.degree} 条关系
                  </span>
                  <p>{focusPoint.excerpt}</p>
                </>
              ) : (
                <span className="kb3d__hint">拖动旋转 · 滚轮缩放 · 悬停看点</span>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
