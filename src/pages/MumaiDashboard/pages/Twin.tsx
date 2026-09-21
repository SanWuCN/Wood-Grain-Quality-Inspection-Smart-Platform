/**
 * 数字孪生（`/twin`）
 *
 * PRD 3.3：
 *   - 场景库显示历史与本轮场景、来源视频、关键帧、版本与发布状态；
 *     全栈上传后为「待检查」，架构师检查并发布
 *   - **按工单显示**：先选工单，再显示该工单绑定的高斯重建模型
 *   - 工单还没有模型时显示「未收到模型文件」，并给上传入口；
 *     **只有全栈开发工程师（饶）可以上传**，其他人只能选择已上传的模型查看
 *   - 主视图占页面 2/3 以上：WASD 平移、QE 升降、Ctrl/Shift 调速、鼠标转视角与缩放
 *   - 点热点 → 展开原图、回波、初筛、融合结果与历史任务
 *   - 未完成坐标标定时以柱号与人工热点对应；内部异常以「示意响应区域」表达，
 *     不把手绘虫道、深度或承载能力当成扫描测量
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useMumai } from "../context";
import { Icon } from "../icons";
import NumberAnimation from "@/components/numberAnimation";
import { api, isApiError } from "../api/client";
import { actorShortName } from "../api/accounts";
import { isOnline, scenes as scenesOf, useSharedStore } from "../store/shared";
import { permissionHint } from "../auth";
import { Panel } from "../Panel";
import { Btn, Modal, PermNote, StateBlock, StatusChip, Toolbar, WaveChart } from "../ui";
import {
  FRAME_BLACK_LUMA,
  KEYFRAME_LABEL_MAX,
  keyframeTimeText,
  nextTourIndex,
  normalizeKeyframeLabel,
  posePositionText,
  poseReadout,
  poseToCamera,
  readKeyframes,
  type SplatPose,
  type TwinKeyframe,
} from "./splatPose";
/*
 * 渲染舞台的**类型**只导入（`import type`）：编译后被抹掉，不会把那个 4.85MB 的
 * 分包拉进主包 —— 上面"按需加载"的理由对类型同样成立。
 */
import type { SplatCapture } from "./SplatStage";
import {
  COMPONENTS,
  CURRENT_RISKS,
  DEMO_SCENARIO_V3,
  HISTORIC_ORDERS,
  HISTORY_RISKS,
  HOTSPOTS,
  SCAN_BATCHES,
  SCENES,
  WAVEFORMS,
  WORK_ORDER,
  /* 「预采场景」角标的判据（剧本 §134）：只看素材名，不猜标题 */
  isPrecollectedScene,
  /* 「打开标注原图」（剧本 §141）：按图片编号取标注框，取不到就不显示 */
  annotationsOfImage,
} from "../seed/scenario";
import { cancelTwinReveal } from "../twinReveal";
/* 内部点云：数据与口径在 internalPointCloud.ts（纯函数、可单测），这里只用它的合计 */
import { buildInternalCloud } from "./internalPointCloud";
/**
 * 内部点云视图（three + @react-three/fiber）。
 *
 * 与高斯那一屏一样**按需加载**：它引 three 与 drei，没切到"内部点云"之前不该下载。
 */
const InternalPointCloudView = lazy(() => import("./InternalPointCloudView"));
/*
  「证据对照」（剧本 ㉒ 的屏幕落点）：纯表格 + 列表，不引 3D 库，所以**静态引入** ——
  它是这一轮的"具体东西"，切过去不该先等一下分包。
*/
import { TwinEvidenceView } from "./TwinEvidenceView";
/* 本轮重建素材的来源（⑭ 预采场景角标与素材质检页同一份取值，不另写文件名） */
import { currentSource } from "./materialsData";
/* 「打开你标记的原图」（剧本 ⑫）：窗口本体 + 触发事件（executor 派发同一个事件） */
import { OriginalPhotoWindow } from "./OriginalPhotoWindow";
import { ORIGINAL_PHOTO_EVENT } from "./originalPhotoAction";
/* 「切到内部点云 / 证据对照」（㉒）：事件在 twinViewAction.ts，页面与 executor 共用 */
import { TWIN_EVIDENCE_EVENT, TWIN_INTERNAL_CLOUD_EVENT } from "./twinViewAction";
/* ⑫ 窗口里那张真实原片（照片批次里的人工标注原片） */
import { annotatedPhotoFor } from "./annotatedPhotos";
/** 成果质量报告（给项目经理的高斯泼溅报告）的登记表：页面、静态托管、工装共用一份地址 */
import { GAUSSIAN_REPORT } from "./reportPack";
/** 报告的平台内阅览窗口（点开在平台里展开、可关闭；关闭即卸载 iframe） */
import { ReportViewer } from "./ReportViewer";
import "./twinColumns.css";
/**
 * 泼溅渲染舞台（`SplatStage`）**异步加载**。
 *
 * ── 为什么必须异步（2026-09-17 实测）────────────────────────────
 * 它引的是 `@sparkjsdev/spark`：**单入口 5.2 MB 整包**（无子路径导出、无法按需），
 * 打包后 Twin 分包 **4.85 MB**，其中 2.07 MB 还是包内自带的内联 base64 WASM。
 * 静态 import 的后果是：**只要打开 /twin 就先下这 4.85 MB** ——
 * 而本页在"工单还没上传重建模型"时显示的只是空态（`hasModel === false`），
 * 那一刻根本不需要渲染器。
 *
 * 所以改成按需：渲染器只在**确实有模型文件**时才挂载（见下面 twin-stage 里的条件）。
 * 空态与错误态都是覆盖层，不依赖它内部状态，语义上本来就不该为它们下载渲染器。
 */
const SplatStage = lazy(() => import("./SplatStage"));

/** 首页工单清单：本轮 + 历史，与工单看板同一份来源 */
const ORDERS = [WORK_ORDER, ...HISTORIC_ORDERS];
/**
 * 场景库的行（服务端版本 ∪ 本地参照条目）
 *
 * 服务端那一份是权威（检查 / 发布状态只在它上面），`SCENES` 只补标题与素材描述 ——
 * 两边都不重写对方，避免又出现「第三份数据」。
 * `orderId` 是这一版新增的绑定字段：老数据没有它，所以这里按「有绑定才归到工单」
 * 处理，没有绑定的一律挂在「未绑定工单」下，不硬塞给某个工单。
 */
function useSceneRows() {
  const sharedScenes = useSharedStore(scenesOf);
  const online = useSharedStore(isOnline);
  return useMemo(() => {
    const rows: {
      id: string;
      title: string;
      round: string;
      version: string;
      meta: string;
      detail: string;
      state: string;
      orderId: string | null;
      assetFileId: string | null;
      assetName: string | null;
      /** 素材来源名（本地参照条目里有；服务端实体没有这个字段，靠 id 回查） */
      sourceVideo: string | null;
    }[] = [];
    for (const entity of sharedScenes) {
      const local = SCENES.find((item) => item.id === entity.id);
      rows.push({
        id: entity.id,
        title: entity.data.title || local?.title || entity.id,
        round: entity.data.round,
        version: `rev ${entity.revision}`,
        meta: `${entity.data.componentAnchors.length} 锚点 · ${entity.data.bookmarkIds.length} 书签`,
        detail: entity.data.publishedAt
          ? `发布 ${entity.data.publishedAt.slice(0, 19).replace("T", " ")}`
          : `提交 ${entity.data.submittedAt.slice(0, 19).replace("T", " ")}`,
        state: entity.data.state,
        orderId: entity.data.orderId ?? null,
        assetFileId: entity.data.assetFileId ?? null,
        assetName: entity.data.assetId ?? null,
        sourceVideo: local?.sourceVideo ?? null,
      });
    }
    /* 本地参照条目：只有标题与素材描述，没有实际模型文件，因此不能当作可显示的场景 */
    for (const local of SCENES) {
      if (sharedScenes.some((entity) => entity.id === local.id)) continue;
      rows.push({
        id: local.id,
        title: local.title,
        round: local.round,
        version: local.version,
        meta: `关键帧 ${local.keyframes} · ${local.format}`,
        detail: `${local.sourceVideo} · ${local.updatedAt}`,
        state: online ? "未提交" : local.published,
        orderId: null,
        assetFileId: null,
        assetName: null,
        sourceVideo: local.sourceVideo,
      });
    }
    return rows;
  }, [online, sharedScenes]);
}

/**
 * 操作说明（与泼溅场景的实际键位一一对应）
 *
 * 键位在 `SplatStage` 的 `FlyKeys` 里实现，这里只是说明 ——
 * 两处不一致比没有说明更糟，改键位时两边一起改。
 */
const CONTROLS: { keys: string[]; label: string }[] = [
  { keys: ["左键拖动"], label: "转动视角（水平 360°）" },
  { keys: ["W", "A", "S", "D"], label: "前后左右移动" },
  { keys: ["Q", "E"], label: "上下移动" },
  { keys: ["滚轮"], label: "前进 / 后退" },
  { keys: ["Ctrl"], label: "减速" },
  { keys: ["Shift"], label: "加速" },
];

/** 上传界面接受的模型格式：Spark 直接认这两种，其它格式不做转换、也不假装能看 */
const MODEL_EXTENSIONS = [".sog", ".spz"];

/**
 * 「模型文件解析完」之后还等多久就放开「打关键帧」（毫秒）。
 *
 * 正常路径不用等：渲染舞台探到画面里出现东西（`stagePainted`）当场放开按钮。
 * 这个计时是兜底 —— 产物本身很暗、或软件渲染下探测一直不亮时，不能让按钮永远点不了。
 * 放开之后打帧那一刻**还会再判一次全黑**（`FRAME_BLACK_LUMA`），所以不会静默记下黑帧，
 * 最坏情况是屏幕上多说一句"画面还是黑的，没有记帧"。
 */
const PAINT_WAIT_MS = 12000;

export default function Twin() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("component") ?? "Z04";
  const { componentById, domainPending, toast, pushEvent, can } = useMumai();

  /* ---- 工单：这一页的主入口。选中项进 URL，复制链接给别人打开是同一个工单 ---- */
  const orderId = params.get("order") ?? ORDERS[0]?.id ?? "";
  const order = ORDERS.find((item) => item.id === orderId) ?? ORDERS[0];
  const setOrderId = (id: string) => {
    /*
      人在工单选择框里换单时，**把四柱的揭示计划交回给人**（`cancelTwinReveal`）：
      计划是全局的一份（见 `twinReveal.ts` 里"键为什么不是工单号"那段），
      所以"换单就不该继续按剧本点亮"这条保证由这里给 —— 换完看到的是完整四柱。
    */
    cancelTwinReveal();
    const next = new URLSearchParams(params);
    next.set("order", id);
    setParams(next, { replace: true });
  };
  /**
   * 选构件（= 这一帧的标签，用户 2026-09-18：「然后我给他打标签，就是 Z01 那种」）。
   *
   * 为什么要"打帧前"选：帧号是 `KF-<构件>-NN`（按构件各自编号），而服务端把
   * **帧号与构件的绑定定为不可改**（帧号是讲稿与对照表的锚点）—— 事后改标签等于换帧号。
   * 所以标签在打帧这一刻就定下来；同时它决定右栏「热点详情」看哪根柱子。
   */
  const setComponent = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("component", id);
    setParams(next, { replace: true });
  };
  const componentIds = useMemo(() => COMPONENTS.map((item) => item.id), []);

  const sceneRows = useSceneRows();
  /** 当前工单绑定的场景（一份工单一份成果；重复上传统一替换到这一条） */
  const orderScene = useMemo(
    () => sceneRows.find((row) => row.orderId === orderId) ?? null,
    [orderId, sceneRows],
  );
  const hasModel = Boolean(orderScene?.assetFileId);
  /**
   * ── 这一版场景是不是**预采**来的（剧本 §134）─────────────────────────
   * 原文：「（B屏切回架构师电脑。**场景标题持续显示"预采场景"**。…）」
   *
   * 素材名以**本轮重建用的素材**为准（`currentSource()`，与素材质检页同一份取值）：
   * 现场上传的模型是 `scene.submit` 生成的（id 形如 `SCN-…`），服务端实体里
   * **没有素材名这个字段** —— 只看实体 id 去 `SCENES` 里找是找不到的，
   * 那样角标永远不会出现（第一版就是这么写的，验收当场红了）。
   * 只有当该行自己带素材名（种子里的参照条目）时才优先用它。
   */
  const roundSource = useMemo(() => currentSource(), []);
  const precollected = useMemo(
    () => isPrecollectedScene({ sourceVideo: orderScene?.sourceVideo ?? roundSource?.sourceVideo ?? null }),
    [orderScene?.sourceVideo, roundSource?.sourceVideo],
  );
  /** 角标提示里显示的素材名（行上的优先，没有就用本轮素材） */
  const sceneSourceVideo = orderScene?.sourceVideo ?? roundSource?.sourceVideo ?? "";
  /** 只有全栈开发工程师能上传：其他人选已上传的模型显示 */
  const canUpload = can("scene:upload");

  const [detailOpen, setDetailOpen] = useState(false);
  /**
   * 原图查看窗口（剧本 ⑫：「打开你标记的原图，把疑点区域放大」）。
   *
   * 两个入口开的是同一个窗口：本页热点面板上的「打开原图」按钮，
   * 以及 ⑫ 播完时 `executor` 派发的 `mumai:original-photo` 事件
   * （见 `originalPhotoAction.ts`；它不带构件号时按"当前选中的构件"开）。
   */
  const [photoOpen, setPhotoOpen] = useState(false);
  /**
   * 主视图看哪个：外观（高斯泼溅）还是内部点云。
   *
   * 默认外观 —— 这一页的主线是"场景已打开，可以移动视角"（剧本 §136）。
   * 内部点云是**用户 2026-09-30 追加的一项**，切换按钮在视图上方常驻可见。
   */
  const [stageView, setStageView] = useState<"splat" | "internal" | "evidence">("splat");
  /** 四根柱子的内部缺陷合计（切换按钮上那个数字；数据来自生成器，不另写常数） */
  const cloudDefectCount = useMemo(
    () => Object.values(buildInternalCloud().totals).reduce((sum, value) => sum + value, 0),
    [],
  );
  const [uploadOpen, setUploadOpen] = useState(false);
  /**
   * 成果质量报告的**阅览窗口**开着没有（用户口径 2026-10-02：「直接展开在平台上的窗口，
   * 可以点开关闭」）。关掉时 `ReportViewer` 整个卸载，里面那个 iframe 一起没 ——
   * 下次点开是一次干净加载（藏起来的话关了再开还是上次那页）。
   */
  const [reportOpen, setReportOpen] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  const [splatError, setSplatError] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState<string | null>(null);
  /** 模型文件解析完（加载覆盖层撤掉）——**还不代表画面画出来了** */
  const [stageReady, setStageReady] = useState(false);
  /** 画面里真的出现东西了（渲染舞台探到的）：这才是"打关键帧"该等的信号 */
  const [stagePainted, setStagePainted] = useState(false);
  /** 兜底：产物很暗时探测永远不亮，等够时间仍然放开按钮（按钮文案写明风险） */
  const [paintFallback, setPaintFallback] = useState(false);

  /*
    换工单/换模型要把这几个状态清掉：
      · 「加载失败」—— 否则上一个工单的失败会挂在新工单上；
      · `stageReady` / `stagePainted` —— 否则**旧产物的"已就绪"会被新模型沿用**，
        新模型还没画出来「打关键帧」就已经能点（实测就是这样打出一帧全黑机位的）；
      · 兜底计时 —— 同上，新产物重新计时。
  */
  useEffect(() => {
    setSplatError(null);
    setStageReady(false);
    setStagePainted(false);
    setPaintFallback(false);
  }, [orderId, orderScene?.assetFileId]);

  const sharedScenes = useSharedStore(scenesOf);
  const online = useSharedStore(isOnline);
  const currentSceneEntity = useMemo(
    () => sharedScenes.find((entity) => entity.id === orderScene?.id) ?? null,
    [orderScene?.id, sharedScenes],
  );
  const canPublishScene =
    Boolean(currentSceneEntity) &&
    currentSceneEntity!.data.state !== "已发布" &&
    currentSceneEntity!.data.checkResult?.pass === true;

  const runSceneCheck = useCallback(async () => {
    const entity = currentSceneEntity;
    if (!entity) return;
    setSceneBusy("scene.check");
    try {
      const result = await useSharedStore.getState().send({
        action: "scene.check",
        entityId: entity.id,
        expectedRevision: entity.revision,
      });
      const pass = result.result.pass === true;
      toast(pass ? `场景 ${entity.id} 检查通过` : `场景 ${entity.id} 检查未通过，先补齐缺项`, pass ? "ok" : "warn");
      pushEvent(`场景 ${entity.id} 检查${pass ? "通过" : "未通过"}`, pass ? "ok" : "warn");
    } catch (error) {
      toast(isApiError(error) ? error.message : "场景检查失败", "danger");
    } finally {
      setSceneBusy(null);
    }
  }, [currentSceneEntity, pushEvent, toast]);

  const publishScene = useCallback(async () => {
    const entity = currentSceneEntity;
    if (!entity) return;
    setSceneBusy("scene.publish");
    try {
      await useSharedStore.getState().send({
        action: "scene.publish",
        entityId: entity.id,
        expectedRevision: entity.revision,
      });
      toast(`场景 ${entity.id} 已发布`, "ok");
      pushEvent(`发布场景 ${entity.id}（rev ${entity.revision}）`, "ok");
    } catch (error) {
      toast(isApiError(error) ? error.message : "场景发布失败", "danger");
    } finally {
      setSceneBusy(null);
    }
  }, [currentSceneEntity, pushEvent, toast]);

  /* ---- 热点详情（面板与弹窗共用同一份取数） ---- */
  const component = componentById(selected);
  /*
    四柱构件条的揭示状态：计划按**工单**绑（换工单就不该继续点上一张单的柱子）。
    `null` = 没有计划 → 四根都显示。
  */
  
  
  
  const hotspot = useMemo(() => HOTSPOTS.find((item) => item.componentId === selected) ?? null, [selected]);
  /**
   * ── 这张原图对应的**标注框**（剧本 §140–141）─────────────────────────
   * 史：「小木，打开你标记的原图，把疑点区域放大。」
   * 文档旁注：「小木根据分析结果中的图片编号和标注框调用原图查看工具；
   * 没有标注坐标时只打开原图，**不虚构放大定位**。」
   *
   * 所以这里按**图片编号**去融合记录里取框（`annotationsOfImage`），
   * 取不到就如实显示"未附带标注框" —— 绝不按构件号猜一个框、更不编一个放大区域。
   * 这些框本身来自归档的标注 JSON（`source` 写着"归档标注"），页面上要标成
   * 「预置标注记录」（真实视觉模型未接通，见 `script.ts` ⑪ 的前置条件）。
   */
  const annotationBox = useMemo(
    () => annotationsOfImage(hotspot?.image.name)[0] ?? null,
    [hotspot?.image.name],
  );
  /** 这一根柱子的**真实原片**（照片批次里的人工标注原片；⑫ 的窗口用的就是它） */
  const evidencePhoto = useMemo(() => annotatedPhotoFor(selected), [selected]);
  const risks = useMemo(
    () => CURRENT_RISKS.filter((item) => item.componentId === selected),
    [selected],
  );
  /**
   * 历史对照：`HistoryRisk` 没有 `componentId`，它带的是 `sceneId`（历史场景）。
   * 原来这里按 `componentId` 匹配 —— 那个字段不存在，等于永远匹配不到，
   * 弹窗里「历史（2026-05）」一行永远是「无历史记录」。这里按场景里是否出现
   * 当前构件号匹配，并保留「找不到就写无」的行为。
   */
  const historyRisk = useMemo(
    () => HISTORY_RISKS.find((item) => item.sceneId.includes(selected)) ?? null,
    [selected],
  );
  const batches = useMemo(
    () => SCAN_BATCHES.filter((batch) => batch.componentId === selected),
    [selected],
  );
  const [waveBatchId, setWaveBatchId] = useState("");
  const waveBatch = useMemo(
    () => batches.find((batch) => batch.batchId === waveBatchId) ?? batches[batches.length - 1] ?? null,
    [batches, waveBatchId],
  );
  /** 这一批次的**全部**曲线（时域回波 + 它的频谱），按 kind 排序：先时域后频域 */
  const waveforms = useMemo(() => {
    const list = WAVEFORMS.filter((item) => item.batchId === waveBatch?.batchId);
    return [...list].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "echo" ? -1 : 1));
  }, [waveBatch?.batchId]);
  const [sideBySide, setSideBySide] = useState(true);

/** 巡场每一帧停留多久：飞行动画之外还要留出讲解时间（实测 4.5 秒念不完一句就飞走了） */
const TOUR_INTERVAL_MS = 5200;

  /* ---- 机位关键帧：把镜头拉近木柱 → 打一帧 → 谁都能点回来（用户 2026-09-17 口径）----
     数据存在**服务端**（`scene.keyframes`）：用户明确「所有服务都要让别人也能用」，
     所以内网任何一台机器、任何一个账号看到的是同一份，不是各存各的。
     换算与容错都在 `splatPose.ts`（纯函数 + 单测），这里只管交互。 */
  const poseRef = useRef<SplatPose | null>(null);
  /** 3D 画面的出口：打帧时用它截下"这一刻的画面"（见 SplatStage 的 SplatCanvasProbe） */
  const captureRef = useRef<SplatCapture | null>(null);
  const [keyframeBusy, setKeyframeBusy] = useState<string | null>(null);
  /** 点缩略图看大图的那一帧 */
  const [shotFrame, setShotFrame] = useState<TwinKeyframe | null>(null);
  const [flyTo, setFlyTo] = useState<{ pose: SplatPose; nonce: number } | null>(null);
  const [flying, setFlying] = useState<string | null>(null);
  /*
    巡场（讲解用）：按列表顺序自动一帧一帧飞过去。
    `paused` 只是停住不往下走，人还能手动点上一帧 / 下一帧；到头**停下**不绕回。
  */
  const [tour, setTour] = useState<{ index: number; paused: boolean } | null>(null);
  /** 正在改名的那一帧 + 草稿 */
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  /** 两段式删除：第一下只是「举起来」，再点一下才真删（避免演示中误删） */
  const [confirming, setConfirming] = useState<string | null>(null);
  const keyframes = useMemo(() => readKeyframes(currentSceneEntity?.data), [currentSceneEntity]);

  /**
   * 「打关键帧」什么时候才能点：**画面真的画出来了**，不是"文件解析完"。
   *
   * 实测（2026-09-18，真实浏览器）：`SplatMesh` 的加载回调触发时页面会撤掉加载覆盖层，
   * 但那一刻画布还是纯背景色 —— 6.4MB 的产物要再等 6~10 秒才出第一帧，58MB 的要 95 秒以上。
   * 原来按钮等的就是那个回调，于是现场"点一下打关键帧，3D 区是黑的，也不知道记的是哪儿"，
   * 打出来的还是一帧黑机位。所以改等渲染舞台探到的 `stagePainted`，
   * `paintFallback` 只作兜底（见 `PAINT_WAIT_MS`）。
   */
  const canShoot = hasModel && Boolean(currentSceneEntity) && (stagePainted || paintFallback);
  useEffect(() => {
    if (!stageReady || stagePainted) return undefined;
    const timer = window.setTimeout(() => setPaintFallback(true), PAINT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [stageReady, stagePainted]);

  /**
   * 把"这一刻的 3D 画面"存成服务端的图（用户 2026-09-18：「打关键帧右侧应该显示相应的图」）。
   *
   * 顺序是**先截图 → 再传文件 → 最后写帧**：反过来的话存进库的图就不是打帧那一刻的画面了。
   * 三种结果分开返回，让调用方各自决定怎么说：
   *   · `black`：画布还是背景色（模型没渲染出来）—— 这一帧**不能记**，记了就是黑帧；
   *   · `failed`：截图/上传出错（断网、文件过大）—— 机位照记，只是这一帧没有图；
   *   · 成功：拿到文件库里的 fileId。
   * 图**不进实体**（场景快照每台端都要收一遍，塞进去等于每次刷新重传所有图），
   * 帧里只存 fileId，右栏用带令牌的内联地址取字节；服务端 `normalizeKeyframeImage` 校验。
   */
  const captureFrameImage = useCallback(async (): Promise<
    { ok: true; fileId: string; size: number } | { ok: false; reason: "black" | "failed" }
  > => {
    try {
      const shot = captureRef.current?.snapshot() ?? null;
      if (!shot) return { ok: false, reason: "black" };
      /* 先判黑再上传：黑帧没有记的必要，也不该占一份文件字节 */
      if (shot.maxLuma <= FRAME_BLACK_LUMA) return { ok: false, reason: "black" };
      const blob = await (await fetch(shot.dataUrl)).blob();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
      const file = new File([blob], `KF-${selected}-${stamp}.jpg`, { type: "image/jpeg" });
      const uploaded = await api.upload(file, useSharedStore.getState().sessionId, "keyframes");
      return { ok: true, fileId: uploaded.fileId, size: uploaded.size };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }, [selected]);

  const addKeyframe = useCallback(async () => {
    const entity = currentSceneEntity;
    const pose = poseRef.current;
    if (!entity) return;
    if (!pose) {
      toast("还没读到当前机位：等模型加载完、镜头动一下再打帧", "warn");
      return;
    }
    setKeyframeBusy("add");
    try {
      /*
       * 打帧前**必须**确认画面是画出来的。按钮已经按这个置灰了，这里再挡一次：
       * 点击到执行之间模型可能刚好被换走、或第一帧还没出来 —— 那样记下来的就是
       * 一帧"画面全黑"的机位（用户 2026-09-18 报的正是这个）。
       */
      const image = await captureFrameImage();
      if (!image.ok && image.reason === "black") {
        toast("这一帧的画面还是黑的（模型还没渲染出来），没有记帧 —— 等木柱显示出来再点一次", "warn");
        pushEvent("打关键帧被拦下：3D 画面还是黑的（模型未出画）", "warn");
        return;
      }
      const result = await useSharedStore.getState().send({
        action: "scene.keyframe.add",
        entityId: entity.id,
        expectedRevision: entity.revision,
        payload: {
          componentId: selected,
          pose,
          ...(image.ok ? { imageFileId: image.fileId } : {}),
        },
      });
      const id = String(result.result.keyframeId ?? "");
      toast(
        image.ok ? `已记录机位关键帧 ${id}（${selected}，含画面图）` : `已记录机位关键帧 ${id}（${selected}，图没传上去）`,
        image.ok ? "ok" : "warn",
      );
      pushEvent(
        `打关键帧 ${id}：${selected} · ${poseReadout(pose)}${image.ok ? ` · 图 ${Math.round(image.size / 1024)} KB` : " · 无图"}`,
        "ok",
      );
    } catch (error) {
      toast(isApiError(error) ? error.message : "打关键帧失败", "danger");
    } finally {
      setKeyframeBusy(null);
    }
  }, [captureFrameImage, currentSceneEntity, pushEvent, selected, toast]);

  /** 用户自己动了镜头：高亮要清掉，否则「已回到该机位」会一直挂着骗人；巡场也跟着暂停 */
  const handleUserInput = useCallback(() => {
    setFlying(null);
    setTour((current) => (current ? { ...current, paused: true } : current));
  }, []);

  const flyToKeyframe = useCallback((frame: TwinKeyframe) => {
    /* nonce 每次都变：同一个机位连点两次也要重新飞一遍（相机字段没变，靠它触发动画） */
    setFlyTo({ pose: frame.pose, nonce: Date.now() });
    setFlying(frame.id);
    pushEvent(`镜头回到机位关键帧 ${frame.id}（${frame.componentId ?? "场景"}）`, "info");
  }, [pushEvent]);

  /** 改名（帧号不动：它是讲稿与对照表的锚点） */
  const renameKeyframe = useCallback(
    async (frame: TwinKeyframe) => {
      const entity = currentSceneEntity;
      const label = normalizeKeyframeLabel(renaming?.draft ?? "");
      if (!entity || !label) {
        setRenaming(null);
        return;
      }
      setKeyframeBusy(frame.id);
      try {
        await useSharedStore.getState().send({
          action: "scene.keyframe.update",
          entityId: entity.id,
          expectedRevision: entity.revision,
          payload: { keyframeId: frame.id, label },
        });
        toast(`${frame.id} 已改名为「${label}」`, "ok");
        pushEvent(`关键帧改名 ${frame.id} → ${label}`, "info");
        setRenaming(null);
      } catch (error) {
        toast(isApiError(error) ? error.message : "改名失败", "danger");
      } finally {
        setKeyframeBusy(null);
      }
    },
    [currentSceneEntity, pushEvent, renaming, toast],
  );

  /** 用当前机位覆盖这一帧：镜头微调后不用删了重打（重打会换帧号） */
  const updateKeyframePose = useCallback(
    async (frame: TwinKeyframe) => {
      const entity = currentSceneEntity;
      const pose = poseRef.current;
      if (!entity) return;
      if (!pose) {
        toast("还没读到当前机位：等模型加载完、镜头动一下再更新", "warn");
        return;
      }
      setKeyframeBusy(frame.id);
      try {
        const image = await captureFrameImage();
        if (!image.ok && image.reason === "black") {
          toast("画面还是黑的（模型没渲染出来），机位没有更新", "warn");
          return;
        }
        await useSharedStore.getState().send({
          action: "scene.keyframe.update",
          entityId: entity.id,
          expectedRevision: entity.revision,
          payload: {
            keyframeId: frame.id,
            pose,
            /*
             * 图必须跟着机位一起换：只换机位不换图，右栏那张缩略图就变成**上一版机位**
             * 拍的画面（图与机位对不上，比没有图更坏）。传空串 = 显式把旧图摘掉。
             */
            imageFileId: image.ok ? image.fileId : "",
          },
        });
        toast(
          image.ok
            ? `${frame.id} 的机位与画面图都已更新为当前镜头`
            : `${frame.id} 的机位已更新；这张图没传上去，旧图已摘掉（免得图和机位对不上）`,
          image.ok ? "ok" : "warn",
        );
        pushEvent(
          `更新关键帧机位 ${frame.id}：${poseReadout(pose)}${image.ok ? " · 换图" : " · 摘图"}`,
          "info",
        );
      } catch (error) {
        toast(isApiError(error) ? error.message : "更新机位失败", "danger");
      } finally {
        setKeyframeBusy(null);
      }
    },
    [captureFrameImage, currentSceneEntity, pushEvent, toast],
  );

  /** 走到第 index 帧（巡场与「上一帧 / 下一帧」共用） */
  const gotoFrame = useCallback(
    (index: number) => {
      const frame = keyframes[index];
      if (!frame) return false;
      flyToKeyframe(frame);
      setTour((current) => (current ? { ...current, index } : current));
      return true;
    },
    [flyToKeyframe, keyframes],
  );

  const startTour = useCallback(() => {
    if (!keyframes.length) return;
    setConfirming(null);
    setRenaming(null);
    setTour({ index: 0, paused: false });
    flyToKeyframe(keyframes[0]);
    pushEvent(`开始巡场：${keyframes.length} 个机位按顺序走一遍`, "info");
  }, [flyToKeyframe, keyframes, pushEvent]);

  /** 上一帧 / 下一帧（手动步进时自动暂停：人在控节奏） */
  const stepTour = useCallback(
    (delta: number) => {
      if (!tour) return;
      const next = nextTourIndex(tour.index, keyframes.length, delta);
      if (next === null) {
        setTour(null);
        pushEvent("巡场结束", "info");
        return;
      }
      gotoFrame(next);
      setTour({ index: next, paused: true });
    },
    [gotoFrame, keyframes.length, pushEvent, tour],
  );

  /** 巡场自动往下走：每 TOUR_INTERVAL_MS 一帧，走到头停住 */
  useEffect(() => {
    if (!tour || tour.paused) return undefined;
    const timer = window.setTimeout(() => {
      const next = nextTourIndex(tour.index, keyframes.length, 1);
      if (next === null) {
        setTour(null);
        pushEvent("巡场结束", "info");
        return;
      }
      gotoFrame(next);
      setTour({ index: next, paused: false });
    }, TOUR_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [gotoFrame, keyframes.length, pushEvent, tour]);

  /**
   * ⑫ 播完时打开原图窗口（`executor` 派发 `mumai:original-photo`）。
   *
   * 事件带构件号时先把它选上（`setComponent` 走 URL，与手选同一套），再开窗 ——
   * 这样窗口里的原片与页面选中的构件一定是同一根，不会出现"看的是 Z04、开的是 Z01"。
   * 依赖里带上 `setComponent` 会每次渲染都重建监听（它是内联箭头函数），
   * 所以这里只依赖 `params` 与开关状态，用 ref 之外最简单的方式：直接读闭包里的 setParams。
   */
  useEffect(() => {
    const onOpen = (event: Event) => {
      const componentId = String((event as CustomEvent<{ componentId?: string }>).detail?.componentId ?? "");
      if (componentId) setComponent(componentId);
      setPhotoOpen(true);
    };
    window.addEventListener(ORIGINAL_PHOTO_EVENT, onOpen);
    return () => window.removeEventListener(ORIGINAL_PHOTO_EVENT, onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setComponent 每次渲染都是新函数，进依赖会让监听反复重建
  }, [params]);

  /**
   * ㉒「证据对照与补核清单」播完时切到**证据对照**那一屏
   * （`executor` 派发 `mumai:twin-evidence`）。
   *
   * 为什么是"证据对照"而不是"内部点云"（用户 2026-10-01）：
   *   「证据对照已打开…这个对话，还是要做具体的东西，而不只是跳转」——
   * ㉒ 的台词讲的就是两路对照与补核清单，落点就该是那张表；
   * 内部点云是它的**下钻**（证据对照页上有「看内部点云」按钮）。
   * ⑪ 仍然什么都不切：那一轮台词写着「不能确认内部是否存在空洞」，
   * 提前把内部结论摆出来就是剧情矛盾。
   */
  useEffect(() => {
    const onEvidence = (event: Event) => {
      const componentId = String((event as CustomEvent<{ componentId?: string }>).detail?.componentId ?? "");
      if (componentId) setComponent(componentId);
      setStageView("evidence");
    };
    window.addEventListener(TWIN_EVIDENCE_EVENT, onEvidence);
    return () => window.removeEventListener(TWIN_EVIDENCE_EVENT, onEvidence);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上：setComponent 是内联箭头函数
  }, [params]);

  /**
   * 内部点云那一屏的入口：主视图页签、证据对照页上的「看内部点云」按钮，
   * 以及同一条事件（`验收-内部点云` 直接派发它验接线）。
   */
  useEffect(() => {
    const onInternal = (event: Event) => {
      const componentId = String((event as CustomEvent<{ componentId?: string }>).detail?.componentId ?? "");
      if (componentId) setComponent(componentId);
      setStageView("internal");
    };
    window.addEventListener(TWIN_INTERNAL_CLOUD_EVENT, onInternal);
    return () => window.removeEventListener(TWIN_INTERNAL_CLOUD_EVENT, onInternal);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上：setComponent 是内联箭头函数
  }, [params]);

  const removeKeyframe = useCallback(
    async (frame: TwinKeyframe) => {
      const entity = currentSceneEntity;
      if (!entity) return;
      setKeyframeBusy(frame.id);
      try {
        await useSharedStore.getState().send({
          action: "scene.keyframe.remove",
          entityId: entity.id,
          expectedRevision: entity.revision,
          payload: { keyframeId: frame.id },
        });
        toast(`已删除机位关键帧 ${frame.id}`, "ok");
        pushEvent(`删除关键帧 ${frame.id}`, "warn");
        setFlying((current) => (current === frame.id ? null : current));
      } catch (error) {
        toast(isApiError(error) ? error.message : "删除关键帧失败", "danger");
      } finally {
        setKeyframeBusy(null);
      }
    },
    [currentSceneEntity, pushEvent, toast],
  );

  return (
    <div className="page page--twin">
      <Toolbar
        note={
          <>
            <span>
              工单 {order?.id ?? "—"} · {order?.site ?? "—"} · {order?.title ?? ""}
            </span>
            <span>
              {orderScene
                ? `模型 ${orderScene.id} · ${orderScene.version}${precollected ? " · 预采场景" : ""}`
                : "该工单尚未收到模型文件"}
            </span>
          </>
        }>
        <label className="twin-order">
          <span>工单</span>
          <select value={orderId} onChange={(event) => setOrderId(event.target.value)} aria-label="选择工单">
            {ORDERS.map((item) => (
              /*
                ⚠ 显示**站名**（`item.site`），不是区县：工单页的列表用站名
                （「示例寺 / 寒山寺 / 报国寺 / 灵隐寺 / 崇圣寺三塔 / 应县木塔」），
                这里原来写的是 `district`（「上海市松江区 / 江苏省苏州市…」），
                于是同一张单在两页上名字不一样（用户口径：工单与数字孪生名称保持一致）。
              */
              <option key={item.id} value={item.id}>
                {item.id} · {item.site}
              </option>
            ))}
          </select>
        </label>
        {/* 构件 = 这一帧的标签（帧号按构件编号，打帧前必须定下来；见 setComponent 的说明） */}
        <label className="twin-order">
          <span>构件</span>
          <select
            value={selected}
            onChange={(event) => setComponent(event.target.value)}
            aria-label="选择构件（这一帧的标签）">
            {COMPONENTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.part}
              </option>
            ))}
            {/* URL 里带来一个没登记的构件号时也要显示出来，不能让选择框显示成空白 */}
            {componentIds.includes(selected) ? null : <option value={selected}>{selected}（未登记）</option>}
          </select>
        </label>
        <Btn disabled={!hasModel} onClick={() => setFitNonce((value) => value + 1)} title="把镜头重新对准模型">
          适应视图
        </Btn>
        {/*
          打关键帧这个操作点：把当前机位连同「当前选中的构件」与**这一刻的画面图**记一帧。
          置灰条件是**说得出原因**的：没有模型 / 模型还没就绪 / 画面还没画出来（黑的）/ 正忙。
        */}
        <Btn
          tone="primary"
          disabled={!canShoot || keyframeBusy !== null}
          title={
            !hasModel
              ? "该工单还没有模型文件，先上传"
              : !currentSceneEntity
                ? "该工单还没有场景版本，先上传模型"
                : !stageReady
                  ? "模型还在加载，加载完就能打帧"
                  : !stagePainted && !paintFallback
                    ? "模型文件已就绪，但 3D 画面还没渲染出来（区域是黑的）—— 等木柱显示出来再打帧"
                    : paintFallback && !stagePainted
                      ? `画面里一直没探到模型（已等 ${PAINT_WAIT_MS / 1000} 秒）：3D 区若确实还是黑的，打帧会被拦下并说明原因`
                      : `把当前机位记成一帧（构件 ${selected}），连同这一刻的画面图，内网所有人都能看到`
          }
          onClick={() => void addKeyframe()}>
          {keyframeBusy === "add" ? "记录中…" : "打关键帧"}
        </Btn>
        {canUpload ? (
          <Btn tone="primary" onClick={() => setUploadOpen(true)}>
            {hasModel ? "替换模型文件" : "上传模型文件"}
          </Btn>
        ) : null}
      </Toolbar>

      {/*
        ⚠ 2026-10-02 用户口径：「数字孪生上面 4 个大标签直接删」——
        原来这里是一排四张构件大卡片（Z01–Z04，剧本 ⑪ 的落点），已按口径删除。
        构件仍在**顶部构件选择器**里选（`构件 Z01 · 檐柱下部 …`），⑪ 的重点构件与重点区域
        由「热点详情」面板 + 画面上的热点表达；`twinReveal` 的 ⑪ 计划保留但不再有对应的
        页内门控（`demoActions.test.ts` 仍要求 revealOnly 轮次有 reveal 声明）。
      */}
      <div className="twin-layout">
        {/*
          ⚠ 页签必须待在 `.twin-stage` **外面**（用户 2026-10-01 问"3D 点云图去哪儿看"）：
            主视图那层 `.twin-view` 是 `position: absolute; inset: 0`，它在 stage 里铺满整块，
            页签若放在 stage 内就会被画布整个盖住 —— 脚本点得动（`element.click()` 不看层级），
            人却看不见也点不着。这一条是"真的能够操作"的判据，工装 `探-主视图页签` 用
            `elementFromPoint` 钉住：页签中心点上最顶层的必须是页签自己。
        */}
        <div className="twin-main">
          {/*
            ── 看外观还是看内部（用户 2026-09-30）──────────────────────────
            「我现在要他也可以展示内部点云，分一项作为内部点云」——
            所以主视图上面加一行切换：**外观·高斯场景** / **内部点云**。
            两者共用同一套场景坐标与包围盒，切过去柱子还在原来的位置，
            只是从"看表面"变成"看里面"（内部那一屏的来源说明写在它自己的右栏里）。

            ⚠ 开头那个「主视图」标签别省：只放两个页签时它们看着像画布上的一行小字说明，
              不像入口；加上"这是主视图的切换"这层意思，人才知道点得动。
          */}
          <div className="twin-views" role="tablist" aria-label="主视图">
            <span className="twin-views__label">主视图</span>
            {([
              ["splat", "外观 · 高斯场景"],
              ["internal", "内部点云"],
              ["evidence", "证据对照"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={stageView === key}
                className={`twin-view__tab${stageView === key ? " is-active" : ""}`}
                onClick={() => setStageView(key)}>
                {label}
                {key === "internal" ? <em>{cloudDefectCount} 处内部缺陷</em> : null}
                {/* 证据对照这一项挂 ㉒ 的角标：它是那一轮的屏幕落点（用户 2026-10-01） */}
                {key === "evidence" ? <em>㉒ 两路对照</em> : null}
              </button>
            ))}
          </div>

          {/* 主视图：占页面 2/3 以上 */}
          <div className="twin-stage">
            <div className="twin-view">
              {/*
                ⚠ 三块视图**互斥挂载**（不再是"三选一"）：高斯那一屏是 Spark 自己的 WebGL 画布，
                  内部点云是 three 的，各自的包在没切过来之前完全不加载。
                  证据对照那一屏里**内嵌一根柱子的内部点云**（用户 2026-10-01：
                  「数字孪生第一个是大场景，第二个才是单根柱子才对」）——
                  它在证据对照这一屏内部按需加载，与主视图的 three 画布不会同时存在。
              */}
              {stageView === "evidence" ? (
                <TwinEvidenceView
                  componentId={selected}
                  onOpenInternalCloud={() => setStageView("internal")}
                  onPickRisk={(riskId) => {
                    const componentId = riskId.match(/Z\d{2}/)?.[0] ?? "";
                    if (componentId) setComponent(componentId);
                    pushEvent(`证据对照：定位到 ${riskId}`, "info");
                  }}
                />
              ) : stageView === "internal" ? (
                <Suspense fallback={null}>
                  <InternalPointCloudView
                    focusComponentId={selected}
                    onPickDefect={({ componentId, defect }) => {
                      setComponent(componentId);
                      pushEvent(`内部点云：${componentId} ${defect.label}（${defect.source}）`, "info");
                    }}
                  />
                </Suspense>
              ) : hasModel ? (
                <Suspense fallback={null}>
                  <SplatStage
                    url={orderScene?.assetFileId ? api.modelUrl(orderScene.assetFileId, orderScene.assetName) : ""}
                    active={!splatError}
                    /* 回放：点某一帧就把它的机位喂回来，`cameraNonce` 保证同一帧再点也重飞 */
                    camera={flyTo ? poseToCamera(flyTo.pose) : null}
                    cameraNonce={flyTo?.nonce ?? 0}
                    poseRef={poseRef}
                    onUserInput={handleUserInput}
                    /* 打帧时截"这一刻的画面"（captureRef）；画面真出画了才放开按钮（onPainted） */
                    captureRef={captureRef}
                    onPainted={() => setStagePainted(true)}
                    fitNonce={fitNonce}
                    onLoaded={() => setStageReady(true)}
                    onError={(message) => {
                      setStageReady(false);
                      setSplatError(message);
                    }}
                  />
                </Suspense>
              ) : null}
            </div>

            {/*
              没有模型文件时的空态。这是**真实缺口**（该工单还没上传重建产物），
              不是加载失败 —— 所以文案与「加载失败」分开，且上传入口只对有权限的人出现。
            */}
            {!hasModel ? (
              <div className="twin-model-empty">
                <Icon name="nav-capture" size={32} aria-hidden />
                <b>未收到模型文件</b>
                <span>
                  工单 {order?.id ?? "—"} 还没有高斯重建模型。
                  {canUpload ? "上传后本页即可显示。" : "等待全栈开发工程师上传后即可显示。"}
                </span>
                {canUpload ? (
                  <Btn tone="primary" onClick={() => setUploadOpen(true)}>
                    上传模型文件
                  </Btn>
                ) : (
                  <PermNote permissions={["scene:upload"]} />
                )}
              </div>
            ) : null}

            {hasModel && splatError ? (
              <div className="twin-model-empty is-error">
                <Icon name="status-warning" size={32} tone="warning" aria-hidden />
                <b>模型文件无法渲染</b>
                <span>{splatError}</span>
                <Btn onClick={() => setSplatError(null)}>重试</Btn>
              </div>
            ) : null}

            <div className="twin-readout">
              <span>工单 {order?.id ?? "—"}</span>
              <span>模型 {orderScene?.assetFileId ? orderScene.id : "—"}</span>
              <span>WASD 移动 · QE 升降 · Ctrl/Shift 调速 · 鼠标转视角与缩放</span>
            </div>
          </div>
        </div>

        {/* 侧栏：操作说明 + 场景版本 + 热点详情 */}
        <div className="twin-side">
          {/*
            机位关键帧（用户 2026-09-17：「把视角拉近木柱，然后可以打上关键帧」）。
            放在操作说明上面：它是**现场要点的东西**，不是说明书。
            实现要点：帧存服务端（内网共享）、点一行飞回该机位、按构件各自编号。
          */}
          <Panel
            title="机位关键帧"
            extra={
              <span className="keyframe-head">
                <span className="muted">
                  {keyframes.length ? `${keyframes.length} 帧 · 本工单所有人共享` : "还没打帧"}
                </span>
                {keyframes.length > 1 && hasModel ? (
                  <Btn
                    tone={tour ? "primary" : "ghost"}
                    title="按列表顺序自动走一遍（讲解用）"
                    onClick={() => (tour ? setTour(null) : startTour())}>
                    {tour ? "停止巡场" : "按顺序巡场"}
                  </Btn>
                ) : null}
              </span>
            }>
            {tour ? (
              <div className="keyframe-tour" role="status">
                <b>
                  巡场 第 {tour.index + 1}/{keyframes.length} 帧 · {keyframes[tour.index]?.id ?? "—"}
                </b>
                <span className="muted">
                  {tour.paused ? "已暂停（你自己动了镜头也会暂停）" : "自动往下走"}
                </span>
                <span className="keyframe-tour__ops">
                  <Btn
                    disabled={tour.index === 0}
                    title="上一帧"
                    onClick={() => stepTour(-1)}>
                    上一帧
                  </Btn>
                  <Btn
                    title={tour.paused ? "继续自动往下走" : "先停在这里"}
                    onClick={() => setTour((current) => (current ? { ...current, paused: !current.paused } : current))}>
                    {tour.paused ? "继续" : "暂停"}
                  </Btn>
                  <Btn
                    disabled={tour.index >= keyframes.length - 1}
                    title="下一帧"
                    onClick={() => stepTour(1)}>
                    下一帧
                  </Btn>
                  <Btn onClick={() => setTour(null)}>结束巡场</Btn>
                </span>
              </div>
            ) : null}

            {keyframes.length ? (
              <ul className="keyframe-list">
                {keyframes.map((frame, index) => (
                  <li key={frame.id} className={flying === frame.id ? "is-active" : ""}>
                    <button
                      type="button"
                      className="keyframe-list__main"
                      disabled={!hasModel}
                      title={hasModel ? `镜头回到 ${frame.id}` : "该工单没有模型文件，回放不了"}
                      onClick={() => flyToKeyframe(frame)}>
                      <span className="keyframe-list__id">
                        {tour && tour.index === index ? `${index + 1}. ` : ""}
                        {frame.id}
                        {flying === frame.id ? " · 已回到该机位" : ""}
                      </span>
                      <span className="keyframe-list__meta">
                        {frame.label} · {actorShortName(frame.addedBy)} · {keyframeTimeText(frame.addedAt)}
                        {frame.updatedAt
                          ? ` · 改于 ${keyframeTimeText(frame.updatedAt)}（${actorShortName(frame.updatedBy ?? "")}）`
                          : ""}
                      </span>
                      <span className="keyframe-list__pose">
                        {poseReadout(frame.pose)}
                      </span>
                      {/* `posePositionText` 自己就带「位置」二字，这里别再拼一个 */}
                      <span className="keyframe-list__pose">{posePositionText(frame.pose)}</span>
                    </button>

                    {/*
                      这一帧的画面图（用户 2026-09-18：「打关键帧右侧应该显示相应的图」）。
                      `img` 加不了 Authorization 头，所以走**带令牌的内联地址** ——
                      与模型同一条路由（服务端 `/api/files/:id/model/:name` 只按扩展名给
                      content-type）：图存在服务端文件库里，帧里只有 fileId，内网共享。
                    */}
                    {frame.imageFileId ? (
                      <button
                        type="button"
                        className="keyframe-list__shot"
                        title={`看大图 · ${frame.id} 打帧时的画面`}
                        onClick={() => setShotFrame(frame)}>
                        <img
                          src={api.modelUrl(frame.imageFileId, frame.imageName)}
                          alt={`${frame.id} 打帧时的 3D 画面`}
                          loading="lazy"
                        />
                        <span>看大图</span>
                      </button>
                    ) : (
                      <span className="keyframe-list__shot is-missing" title="这一帧没有存图（打帧时截图失败）">
                        无图
                      </span>
                    )}

                    {renaming?.id === frame.id ? (
                      <span className="keyframe-list__rename">
                        <input
                          autoFocus
                          value={renaming.draft}
                          maxLength={KEYFRAME_LABEL_MAX}
                          aria-label={`给 ${frame.id} 改个名字`}
                          onChange={(event) => setRenaming({ id: frame.id, draft: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void renameKeyframe(frame);
                            if (event.key === "Escape") setRenaming(null);
                          }}
                        />
                        <Btn
                          tone="primary"
                          disabled={keyframeBusy !== null || !normalizeKeyframeLabel(renaming.draft)}
                          onClick={() => void renameKeyframe(frame)}>
                          保存
                        </Btn>
                        <Btn onClick={() => setRenaming(null)}>取消</Btn>
                      </span>
                    ) : (
                      <span className="keyframe-list__ops">
                        <Btn
                          title="改个能念出来的名字（帧号不变）"
                          disabled={keyframeBusy !== null || !hasModel}
                          onClick={() => setRenaming({ id: frame.id, draft: frame.label })}>
                          改名
                        </Btn>
                        <Btn
                          title="把这一帧的机位换成当前镜头（帧号不变）"
                          disabled={keyframeBusy !== null || !hasModel || !stageReady}
                          onClick={() => void updateKeyframePose(frame)}>
                          {keyframeBusy === frame.id ? "更新中…" : "更新机位"}
                        </Btn>
                        <Btn
                          tone={confirming === frame.id ? "danger" : "ghost"}
                          title="删掉这一帧（所有人都不再看到）"
                          disabled={keyframeBusy !== null}
                          onClick={() => {
                            if (confirming !== frame.id) {
                              setConfirming(frame.id);
                              window.setTimeout(() => setConfirming((current) => (current === frame.id ? null : current)), 4000);
                              return;
                            }
                            setConfirming(null);
                            void removeKeyframe(frame);
                          }}>
                          {keyframeBusy === frame.id
                            ? "删除中…"
                            : confirming === frame.id
                              ? "确认删除"
                              : "删除"}
                        </Btn>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <StateBlock
                kind="empty"
                title="还没有机位关键帧"
                hint="先在工具条上选构件（Z01–Z04，它就是这一帧的标签，帧号按它编号），把镜头拉近要讲的构件，等画面出来再点「打关键帧」。每一帧都会连同**打帧那一刻的画面图**一起存到平台上，内网其他人打开这一页既能看到图，也能点回同一个机位。"
              />
            )}
            {!hasModel ? (
              <p className="muted">该工单还没有模型文件：打帧与回放都要先有重建产物。</p>
            ) : null}
          </Panel>

          <Panel title="操作说明">
            <ul className="twin-keys">
              {CONTROLS.map((row) => (
                <li key={row.label}>
                  <span className="twin-keys__keys">
                    {row.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                  <span className="twin-keys__label">{row.label}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title="场景版本"
            extra={
              online ? (
                <span className="muted">
                  <NumberAnimation value={sceneRows.filter((row) => row.orderId === orderId).length} /> 个 · 本工单
                  {/*
                    通往「素材质检」（剧本 ⑩：检查重建素材、低清晰度标记）的入口。
                    那一页不进一级导航（PRD 2.2 固定八项），所以这里留一个手动入口 ——
                    现场漏触发小木那一轮时，人也能自己走过去看素材清单与需重看的画面。
                  */}
                  <Btn tone="ghost" onClick={() => (window.location.hash = "#/materials")}>
                    素材质检
                  </Btn>
                </span>
              ) : (
                <StatusChip text="未连接共享服务" tone="warn" />
              )
            }>
            {orderScene ? (
              <ul className="scene-list">
                <li className={orderScene.assetFileId ? "" : "is-missing"}>
                  <button type="button">
                    <b>
                      {orderScene.title}
                      {/*
                        ── 「预采场景」角标（剧本 §134）────────────────────────
                        原文：「场景标题持续显示"预采场景"」。现场录像要等活动结束
                        才归档，这一版场景用的是出发前预采的全景视频 —— 标题上不写
                        这一笔，观众会以为这是现场刚拍回来的画面（把预采当现场）。
                        判据在 `isPrecollectedScene`（只看素材名，两者有单测）。
                      */}
                      {precollected ? (
                        <span
                          className="scene-list__tag"
                          title={`素材 ${sceneSourceVideo} —— 现场录像活动结束后归档`}>
                          预采场景
                        </span>
                      ) : null}
                    </b>
                    <span>
                      {orderScene.round} · {orderScene.version} · {orderScene.meta}
                    </span>
                    <em>{orderScene.detail}</em>
                  </button>
                  <StatusChip text={orderScene.state} tone={orderScene.state === "已发布" ? "ok" : "warn"} />
                </li>
              </ul>
            ) : (
              <StateBlock kind="empty" title="该工单还没有场景版本" hint="由全栈开发工程师上传模型后生成。" />
            )}
            {/*
              检查与发布走服务端（评审 F06）：检查产出逐项结论，发布要检查通过才放行。
              这两个动作属于架构师，与「上传模型」不是同一个权限。
            */}
            <div className="scene-actions">
              <Btn
                disabled={!online || !can("scene:publish") || sceneBusy !== null || !currentSceneEntity}
                title={!can("scene:publish") ? permissionHint("scene:publish") : "核对锚点、书签与资源是否齐备"}
                onClick={() => void runSceneCheck()}>
                {sceneBusy === "scene.check" ? "检查中…" : "运行检查"}
              </Btn>
              <Btn
                tone="primary"
                disabled={!online || !can("scene:publish") || sceneBusy !== null || !canPublishScene}
                title={!can("scene:publish") ? permissionHint("scene:publish") : "发布这一版场景"}
                onClick={() => void publishScene()}>
                {sceneBusy === "scene.publish" ? "发布中…" : "发布场景"}
              </Btn>
            </div>
            {currentSceneEntity ? (
              <ul className="scene-checks">
                {(currentSceneEntity.data.checkResult?.checks ?? []).map((check) => (
                  <li key={check.key} className={check.pass ? "is-ok" : "is-bad"}>
                    <Icon
                      name={check.pass ? "status-success" : "status-warning"}
                      size={16}
                      tone={check.pass ? "success" : "warning"}
                      aria-hidden
                    />
                    {check.label}
                    <em>{check.detail}</em>
                  </li>
                ))}
                {currentSceneEntity.data.checkResult ? null : <li className="is-muted">尚未运行检查</li>}
              </ul>
            ) : null}
          </Panel>

          {/*
            ── 成果质量报告（用户口径 2026-10-02）─────────────────────────
            「作为高斯泼溅的报告，是给项目经理看的，放在数字孪生那块」，
            以及「不是点击下载，直接展开在平台上的窗口，可以点开关闭」——
            所以这里是**开关**：点「展开报告」在平台内开一个阅览窗口（`ReportViewer`），
            再点关闭即收起（关闭时连 iframe 一起卸掉，不是藏起来）。
            报告是给人读的，不该把讲解用的孪生页导航走，所以另留一个"新标签打开"的出口。
          */}
          <Panel
            title="成果质量报告"
            extra={<span className="muted">给项目经理 · PDF</span>}>
            <ul className="report-list">
              <li>
                <span className="report-list__name">
                  <b>{GAUSSIAN_REPORT.title}</b>
                  <i>
                    {GAUSSIAN_REPORT.subtitle} · {GAUSSIAN_REPORT.sizeText} · {GAUSSIAN_REPORT.date}
                  </i>
                </span>
                <button
                  type="button"
                  className={`btn btn--primary${reportOpen ? " is-active" : ""}`}
                  aria-expanded={reportOpen}
                  title={reportOpen ? "收起报告窗口" : "在平台内展开这份质量报告（可随时关闭）"}
                  onClick={() => setReportOpen((value) => !value)}>
                  {reportOpen ? "收起报告" : "展开报告"}
                </button>
              </li>
            </ul>
          </Panel>

          <Panel
            title={`热点详情 · ${component?.id ?? selected}`}
            extra={
              <span className="fw-console__actions">
                <StatusChip text={hotspot?.zoneId ?? "—"} tone="info" />
                {/*
                  「打开原图」（剧本 ⑫）：小木的那句「对应原图已打开，标注与构件编号一起显示」
                  对应的就是这个窗口。与 ⑫ 播完自动弹的是同一个组件，不是第二个实现。
                */}
                <Btn
                  disabled={!hotspot}
                  title="打开这批人工标注原片，按标注框放大疑点区域"
                  onClick={() => setPhotoOpen(true)}>
                  打开原图
                </Btn>
                <Btn disabled={!hotspot} onClick={() => setDetailOpen(true)}>
                  查看完整证据
                </Btn>
              </span>
            }>
            {/*
              ⚠ 2026-10-02：「四柱构件条」删掉后，那一排卡片上原有的
              「建议优先复核 · Z04 下部区域」这句话**不能跟着丢** —— 小木 ⑪ 的台词就是
              「建议优先复核 Z04 下部测区」，屏幕上要有对应读数（值仍取自数据包
              `components.focus` / `focusRegion`，页面不写死；当前构件就是重点构件时才显示）。
            */}
            {DEMO_SCENARIO_V3.components.focus === selected ? (
              <p className="twin-focus">
                <StatusChip text="建议优先复核" tone="warn" />
                <span>{DEMO_SCENARIO_V3.components.focusRegion}</span>
              </p>
            ) : null}
            {hotspot ? (
              <>
                <ul className="hotspot-brief">
                  <li>
                    <small>构件 / 部位</small>
                    <b>{(component?.name ?? selected) + " · " + (component?.part ?? "—")}</b>
                  </li>
                  {/*
                    ── 原图与标注框（剧本 §140–142）─────────────────────────
                    小木：「对应原图已打开，标注与构件编号一起显示。请核对这处表面缺损。」
                    所以图片编号与标注框要和构件编号一起在屏上 —— 这正是"原图查看工具"
                    调用的可见结果。框按**图片编号**取自融合记录（`annotationsOfImage`），
                    取不到就写"未附带标注框"，不按构件号猜。
                  */}
                  <li>
                    <small>原图</small>
                    <b>{evidencePhoto ? evidencePhoto.file : hotspot.image.name}</b>
                  </li>
                  <li>
                    <small>标注框</small>
                    <b>
                      {annotationBox
                        ? `${annotationBox.boxId} · ${annotationBox.label} · ${annotationBox.confidence.toFixed(2)}`
                        : "未附带标注框"}
                    </b>
                  </li>
                  <li>
                    <small>回波</small>
                    <b>
                      {hotspot.echo.amplitude.toFixed(2)} {hotspot.echo.unit}
                    </b>
                  </li>
                  <li>
                    <small>融合规则</small>
                    <b>{hotspot.fusion.ruleVersion}</b>
                  </li>
                </ul>
                {/*
                  剧本 §141 原文：「没有标注坐标时只打开原图，**不虚构放大定位**」。
                  现在两件事都是真的、都写在屏上：
                    · 有原片且检出到框 → 说明坐标是从**人工标注原片的红框**离线量出来的，
                      窗口按它放大（"放大"落在真坐标上，不是虚构的定位）；
                    · 没有原片或没有框 → 按原文只打开原图，并说明为什么不放大。
                */}
                <p className={`hotspot-origin${annotationBox || evidencePhoto?.box ? "" : " is-missing"}`}>
                  {evidencePhoto?.box
                    ? `预置标注记录（${annotationBox?.source ?? "归档标注"}）· 标注框坐标离线量自人工标注原片（${evidencePhoto.file}）：窗口按该框放大`
                    : annotationBox
                      ? `预置标注记录（${annotationBox.source}）· 未附图内坐标：只打开原图，不做放大定位`
                      : "该原图未附标注框：只打开原图，不做放大定位"}
                </p>
              </>
            ) : (
              <StateBlock kind="empty" title="未选中热点" />
            )}
          </Panel>
        </div>
      </div>

      {/*
        ── 原图查看窗口（剧本 ⑫）─────────────────────────────────────
        ⑫ 播完时 `executor` 派发 `mumai:original-photo`：带了构件号就用它，
        没带就按**当前选中的构件**开（台词是「打开你标记的原图」，选中的那根就是"你标记的"）。
      */}
      {photoOpen ? (
        <OriginalPhotoWindow
          componentId={selected}
          zoneId={hotspot?.zoneId ?? null}
          annotation={annotationBox}
          onClose={() => setPhotoOpen(false)}
        />
      ) : null}

      {/*
        帧的大图：缩略图只有 96px，讲解前要看清楚"这一帧到底拍到了什么"
        （也是判断"记的机位对不对"最直接的一眼）。
      */}
      {shotFrame ? (
        <Modal
          wide
          title={`${shotFrame.id} · 打帧时的画面`}
          subtitle={`${shotFrame.componentId ?? "场景"} · ${poseReadout(shotFrame.pose)} · ${posePositionText(shotFrame.pose)} · ${actorShortName(shotFrame.addedBy)} ${keyframeTimeText(shotFrame.addedAt)}`}
          onClose={() => setShotFrame(null)}
          footer={
            <Btn tone="primary" onClick={() => setShotFrame(null)}>
              关闭
            </Btn>
          }>
          {shotFrame.imageFileId ? (
            <img
              className="keyframe-shot-full"
              src={api.modelUrl(shotFrame.imageFileId, shotFrame.imageName)}
              alt={`${shotFrame.id} 打帧时的 3D 画面`}
            />
          ) : null}
        </Modal>
      ) : null}

      {uploadOpen ? (
        <UploadModelModal
          order={order}
          currentScene={orderScene}
          onClose={() => setUploadOpen(false)}
          onUploaded={(sceneId) => {
            setUploadOpen(false);
            toast(`工单 ${order?.id} 的模型文件已上传，场景 ${sceneId} 等待检查`, "ok");
            pushEvent(`上传工单 ${order?.id} 的高斯模型（场景 ${sceneId}）`, "ok");
          }}
        />
      ) : null}

      {detailOpen && hotspot ? (
        <Modal
          wide
          title={`热点详情 · ${component?.id ?? selected}`}
          subtitle={`${component?.name ?? selected} · ${component?.part ?? "—"} · 融合规则 ${hotspot.fusion.ruleVersion}`}
          onClose={() => setDetailOpen(false)}
          footer={
            <Btn tone="primary" onClick={() => setDetailOpen(false)}>
              关闭
            </Btn>
          }>
          <div className="hotspot">
            <dl className="kv">
              <div>
                <dt>构件</dt>
                <dd>{component?.name ?? selected}</dd>
              </div>
              <div>
                <dt>部位</dt>
                <dd>{component?.part ?? "—"}</dd>
              </div>
              <div>
                <dt>原图 / 标注框</dt>
                <dd>
                  {hotspot.image.name}
                  {annotationBox
                    ? ` · ${annotationBox.boxId}（${annotationBox.label} ${annotationBox.confidence.toFixed(2)}）`
                    : " · 未附带标注框"}
                </dd>
              </div>
              <div>
                <dt>回波</dt>
                <dd>
                  {hotspot.echo.amplitude.toFixed(2)} {hotspot.echo.unit}
                </dd>
              </div>
              <div>
                <dt>端侧初筛</dt>
                <dd>{hotspot.screening.material}</dd>
              </div>
              <div>
                <dt>融合规则</dt>
                <dd>{hotspot.fusion.ruleVersion}</dd>
              </div>
            </dl>
            <ul className="hotspot-branches">
              {hotspot.fusion.branches.map((branch) => (
                <li key={branch}>{branch}</li>
              ))}
            </ul>

            <h4 className="sub">融合结果（规则判定，不做分数相加平均）</h4>
            {risks.length ? (
              <ul className="hotspot-risks">
                {risks.map((risk) => (
                  <li key={risk.id}>
                    <b>{risk.id}</b>
                    <span>{risk.label}</span>
                    <StatusChip text={risk.priority} tone={risk.priority === "优先复核" ? "danger" : "warn"} />
                    <em>
                      {risk.branch} · {risk.score.toFixed(2)} · 质量 {risk.quality}
                    </em>
                    <p>{risk.recommendation}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <StateBlock kind="empty" title="该构件本轮无异常" />
            )}

            {domainPending ? (
              <StateBlock kind="partial" title="适用域待核验" />
            ) : null}

            <h4 className="sub">
              雷达回波频谱
              {waveBatch ? (
                <span className="muted">
                  {waveBatch.batchId} · {waveBatch.round}
                </span>
              ) : null}
            </h4>
            {batches.length > 1 ? (
              <div className="twin-wavepick">
                {batches.map((item) => (
                  <button
                    key={item.batchId}
                    type="button"
                    className={waveBatch?.batchId === item.batchId ? "is-active" : ""}
                    onClick={() => setWaveBatchId(item.batchId)}>
                    {item.round}
                    <em>{item.batchId}</em>
                  </button>
                ))}
              </div>
            ) : null}
            {/*
              两块一起给：**时域回波**（双极性 A-scan，mV / 双程走时 ns）
              与**它的频谱**（对上面那条回波做 FFT，dB / MHz）。
              用户口径 2026-09-18：「数字孪生的雷达回波频谱真实些」——
              频谱必须有出处，所以两条曲线由同一份回波生成（见 `seed/radarEcho.ts`），
              讲解时"时域这里一个反射、频域对应这个带"能对得上。
            */}
            {waveforms.length ? (
              waveforms.map((item) => (
                <div className="twin-wave" key={item.id}>
                  <p className="twin-wave__cap">
                    {item.kind === "echo" ? "回波（时域 · 双极性）" : "频谱（频域 · 对回波做 FFT）"}
                    <span className="muted">（{item.axisLabel} · {item.unit}）</span>
                  </p>
                  <WaveChart
                    points={item.points}
                    unit={item.unit}
                    axisLabel={item.axisLabel}
                    markers={item.markers}
                    bipolar={item.bipolar}
                    xTicks={item.xTicks}
                    paramLine={item.paramLine}
                  />
                </div>
              ))
            ) : (
              <StateBlock kind="empty" title="该构件未采集回波" />
            )}

            <h4 className="sub">
              处理记录
              {hotspot?.history.length ? <span className="muted">{hotspot.history.length} 条</span> : null}
            </h4>
            {hotspot?.history.length ? (
              <ol className="hotspot-history">
                {hotspot.history.map((item) => (
                  <li key={item.at + item.text}>
                    <time>{item.at}</time>
                    <b>{item.operator}</b>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <StateBlock kind="empty" title="该构件暂无处理记录" />
            )}

            <h4 className="sub">历史与当前对比</h4>
            <label className="twin-compare">
              <input
                type="checkbox"
                checked={sideBySide}
                onChange={(event) => setSideBySide(event.target.checked)}
              />
              并排查看同一构件的历史与当前状态
            </label>
            {sideBySide ? (
              <div className="twin-diff">
                <article>
                  <header>历史（2026-05）</header>
                  <strong>{historyRisk?.title ?? "无历史记录"}</strong>
                  <span>{historyRisk?.status ?? "—"}</span>
                  <em>{historyRisk?.next ?? ""}</em>
                </article>
                <article>
                  <header>当前（2026-09）</header>
                  <strong>{risks[0]?.label ?? "未发现异常"}</strong>
                  <span>{risks[0]?.priority ?? "—"}</span>
                  <em>
                    {risks.length} 处响应区 · 规则版本 {hotspot?.fusion.ruleVersion ?? "—"}
                  </em>
                </article>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {/* 成果质量报告：平台内的阅览窗口（点开关闭，关闭即卸载 iframe） */}
      {reportOpen ? <ReportViewer onClose={() => setReportOpen(false)} /> : null}
    </div>
  );
}


/**
 * 上传高斯模型（只有全栈开发工程师的按钮会打开它）
 *
 * 两步：先把文件传给 `/api/files`（服务端落盘并登记 sha256），
 * 再用 `scene.submit` 把「文件 id + 工单」绑成一个场景版本。
 * 顺序不能反：没有文件 id 就提交，会生成一个「有版本、没模型」的空场景，
 * 孪生页照样显示「未收到模型文件」，用户会以为上传失败了。
 *
 * 只接受 Spark 直接能渲染的格式（`.sog` / `.spz`）。其它格式不转换、也不假装能看 ——
 * 转换不在这个页面的职责里，硬塞进去只会在渲染时炸成一个看不懂的报错。
 */
function UploadModelModal({
  order,
  currentScene,
  onClose,
  onUploaded,
}: {
  order: (typeof ORDERS)[number] | undefined;
  currentScene: { id: string; assetFileId: string | null } | null;
  onClose: () => void;
  onUploaded: (sceneId: string) => void;
}) {
  const { toast } = useMumai();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const pick = (next: File | null) => {
    if (!next) return setFile(null);
    const lower = next.name.toLowerCase();
    if (!MODEL_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      setMessage(`只支持 ${MODEL_EXTENSIONS.join(" / ")} 格式，当前文件是 ${next.name}`);
      return;
    }
    setMessage("");
    setFile(next);
  };

  const submit = async () => {
    if (!file || !order) return;
    setBusy(true);
    try {
      /* 1) 文件落盘并登记 */
      const uploaded = await api.upload(file, useSharedStore.getState().sessionId, "scenes");
      /* 2) 绑定工单，生成场景版本（同一工单重复上传是替换） */
      const result = await useSharedStore.getState().send({
        action: "scene.submit",
        payload: {
          sceneId: currentScene?.id,
          orderId: order.id,
          title: `${order.site} · ${order.id} 高斯重建`,
          round: "本轮",
          assetFileId: uploaded.fileId,
          assetId: uploaded.name,
          format: file.name.toLowerCase().endsWith(".spz") ? "spz" : "sog",
          componentAnchors: [],
          bookmarkIds: [],
        },
      });
      onUploaded(result.result.sceneId as string);
    } catch (error) {
      const detail = isApiError(error) ? error.message : "上传失败，请重试";
      setMessage(detail);
      toast(detail, "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="上传高斯模型"
      subtitle={`绑定工单 ${order?.id ?? "—"} · ${order?.site ?? ""}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted">{message || (file ? `已选择 ${file.name}` : `支持 ${MODEL_EXTENSIONS.join(" / ")}`)}</span>
          <Btn onClick={onClose}>取消</Btn>
          <Btn tone="primary" disabled={!file || busy} onClick={() => void submit()}>
            {busy ? "上传中…" : currentScene?.assetFileId ? "替换并重新绑定" : "上传并绑定工单"}
          </Btn>
        </>
      }>
      <label className="twin-drop">
        <input
          type="file"
          accept={MODEL_EXTENSIONS.join(",")}
          onChange={(event) => pick(event.target.files?.[0] ?? null)}
        />
        <b>{file ? file.name : "选择模型文件"}</b>
        <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `点击选择 ${MODEL_EXTENSIONS.join(" / ")} 文件`}</span>
      </label>
    </Modal>
  );
}
