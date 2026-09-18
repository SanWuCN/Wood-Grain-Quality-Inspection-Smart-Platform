/**
 * 素材质检页的数据装配（纯逻辑，Node 单测可覆盖）
 *
 * ── 这一页为什么存在（贴合剧本）────────────────────────────────────
 *   · 饶：「我准备接入全景视频，请确认项目目录和文件来源」/ 史：「目录中已有同场景的
 *     预采视频及重建成果，采集批次已标注。**请用预采数据演示处理流程**，现场文件稍后另行归档」；
 *   · 饶：「小木，检查这批重建素材，列出缺失文件和需要重看的画面」；
 *   · 小木：「正在检查素材，素材检查完成：视频1段，分辨率3840×1920。缺失文件0个，
 *     低清晰度片段2处，已在00:43和02:17标记。**（预设照片调出，给出采集建议）**」；
 *   · 饶：「我们使用 MipMap 软件进行全景影像的高斯场景重建。**首先检查对视频进行切片**，
 *     然后检查清晰度和视角覆盖。连续影像需要有重叠，才能稳定估计相机在不同姿态的位置」；
 *   · 剧本夹注：「图像清晰度检查使用已接通工具，**未接通时读取预置演示结果，页面保留来源**」。
 *
 * ── 数字从哪儿来 ────────────────────────────────────────────────────
 *   · 素材清单读 `DEMO_SCENARIO_V3.material`（`material.*` 那批键，脚本播报与浮层卡片同源）；
 *   · 来源视频与关键帧读 `SCENES`（`sourceVideo` / `keyframes` / `version`）——
 *     预采文件名与 214 关键帧在种子里本来就有，不另编；
 *   · 本文件不写任何数值：低清晰度标记点位、缺失数、分辨率全部按键取值。
 */

import { SCENES, scenarioValue } from "../seed/scenario";
import { formatValue, labelOf } from "../agent/demoSurfaceLabels";

/** 一行「标签 + 值」——与演示表面同一口径（`labelOf` + `formatValue`） */
export type MaterialRow = { key: string; label: string; value: string };

/** 素材清单要展示的数据键（顺序即屏幕顺序） */
const SUMMARY_KEYS: readonly string[] = [
  "material.videoCount",
  "material.resolutionText",
  "material.durationText",
  "material.keyFrames",
  "material.missingFiles",
  "material.lowQualityClips",
];

export function rowsOfKeys(keys: readonly string[] = SUMMARY_KEYS): MaterialRow[] {
  return keys.map((key) => {
    const raw = scenarioValue(key);
    const meta = labelOf(key);
    if (raw === undefined || meta === null) {
      return { key, label: meta ? meta.label : `〔标签缺失：${key}〕`, value: "—" };
    }
    return { key, label: meta.label, value: formatValue(raw, meta.unit) };
  });
}

/** 素材清单（小木那句播报里的每个数都在这里，一一对得上） */
export function materialSummary(): MaterialRow[] {
  return rowsOfKeys(SUMMARY_KEYS);
}

/**
 * 低清晰度标记：点位 + 「需要重看的画面」 + 采集建议。
 *
 * 点位来自 `material.lowQualityMarks`（00:43 / 02:17），一条不落；建议只说**怎么做**
 * （重看 / 补拍 / 换机位），不下"必须重采整段"这种结论 —— 是否重采由现场定。
 */
export type LowQualityMark = { at: string; note: string; advice: string };

export function lowQualityMarks(): LowQualityMark[] {
  const marks = scenarioValue("material.lowQualityMarks");
  if (!Array.isArray(marks)) return [];
  return marks.map((item, index) => ({
    at: String(item),
    note:
      index === 0
        ? "切片起始段的快速转头，画面运动模糊"
        : "中段的近距离遮挡，局部清晰度低于阈值",
    advice:
      index === 0
        ? "重看这一段：确认是运动模糊还是曝光不足；必要时在该机位放慢转速重录"
        : "重看这一段：确认遮挡来源（柱身/支架/人员），补拍时把机位外移并保持重叠",
  }));
}

/** 来源与关键帧：预采视频 / 场景版本 / 关键帧数（读 `SCENES`，不另写一套文件名） */
export type MaterialSource = {
  id: string;
  title: string;
  round: string;
  sourceVideo: string;
  keyframes: number;
  version: string;
  published: string;
};

/** 本轮素材（第一个「本轮」场景就是当前这批素材对应的成果版本） */
export function currentSource(): MaterialSource | null {
  const scene = SCENES.find((item) => item.round === "本轮") ?? null;
  if (!scene) return null;
  return {
    id: scene.id,
    title: scene.title,
    round: scene.round,
    sourceVideo: scene.sourceVideo,
    keyframes: scene.keyframes,
    version: scene.version,
    published: scene.published,
  };
}

/** 同场景的历史素材（用于对照：五月的离线预采） */
export function historySources(): MaterialSource[] {
  return SCENES.filter((item) => item.round === "历史").map((scene) => ({
    id: scene.id,
    title: scene.title,
    round: scene.round,
    sourceVideo: scene.sourceVideo,
    keyframes: scene.keyframes,
    version: scene.version,
    published: scene.published,
  }));
}

/**
 * 重建前的检查项（饶那句「首先检查对视频进行切片，然后检查清晰度和视角覆盖」）。
 *
 * `state`：ok = 这一项已经过了；watch = 需要人重看；todo = 还没做/由软件侧做。
 * 判据全部落在已有数据上（缺失文件数、低清晰度条数、关键帧数、来源标注），
 * **不编"重叠率 37%"这类没有出处的数字**。
 */
export type MaterialCheck = { key: string; label: string; state: "ok" | "watch" | "todo"; detail: string };

export function materialChecks(): MaterialCheck[] {
  const missing = Number(scenarioValue("material.missingFiles") ?? 0);
  const keyFrames = Number(scenarioValue("material.keyFrames") ?? 0);
  const clips = Number(scenarioValue("material.lowQualityClips") ?? 0);
  const marks = lowQualityMarks();
  return [
    {
      key: "files",
      label: "文件齐全性",
      state: missing === 0 ? "ok" : "watch",
      detail: missing === 0 ? "缺失文件 0 个：素材清单里列到的文件都能取到" : `缺失 ${missing} 个，需先补齐再切片`,
    },
    {
      key: "slice",
      label: "视频切片",
      state: keyFrames > 0 ? "ok" : "todo",
      detail: `已切出 ${keyFrames} 个关键帧（切片由 MipMap 侧完成，平台读结果）`,
    },
    {
      key: "sharpness",
      label: "清晰度检查",
      state: clips > 0 ? "watch" : "ok",
      detail:
        clips > 0
          ? `${clips} 处低于阈值，已标记：${marks.map((item) => item.at).join(" / ")}`
          : "全部片段清晰度达标",
    },
    {
      key: "coverage",
      label: "视角覆盖与重叠",
      state: "watch",
      detail: "连续影像需要有重叠才能稳定估计相机位姿；重叠充分与否按切片结果人工重看（本页不给未测得的重叠率）",
    },
    {
      key: "persons",
      label: "人物消除",
      state: "todo",
      detail: "重建前在软件侧勾选消除人物；平台只登记处理结果，不改原始素材",
    },
  ];
}

/**
 * 采集与重建建议（小木那句「给出采集建议」）。
 *
 * 全部是**动作建议**，且与检查项的结论一一对应；检查结论一律标明来自"预置结果"，
 * 因为清晰度检查工具在纯内网离线环境下不联网（剧本夹注）。
 *
 * ⚠ 面向观众的文案里**不许出现「演示」两个字**：`visibleCopy.test.ts` 会全仓扫描
 *   字符串字面量与 JSX 文本，命中「演示 / 非实 / 虚构样例 / 模拟采集」直接红
 *   （这是用户早就提过的口径 —— 界面自己说"这是在演"就是当场穿帮）。
 *   所以这里说的是"预采素材""预置结果""离线环境"，而不是"演示"。
 */
export function materialAdvice(): string[] {
  const advice = lowQualityMarks().map((mark) => `${mark.at} ${mark.advice}`);
  return [
    ...advice,
    "后续补拍时保持相邻画面重叠：连续影像的重叠是估计相机位姿的前提，重叠不足会出现重建空洞。",
    "现场录像仍在采集，本轮按预采素材走处理流程；现场文件稍后另行归档并单独质检。",
  ];
}

/** 来源声明（页面右上角与页脚都用它，避免把预置结果当成现场实测） */
export function materialOrigin(): { tool: string; note: string } {
  return {
    tool: "清晰度检查：预置结果",
    note:
      "剧本夹注：图像清晰度检查使用已接通工具，未接通时读取预置结果并保留来源。" +
      "本页显示的检查结论即该预置结果，不代表现场实测；纯内网离线环境下平台不发公网请求。",
  };
}
