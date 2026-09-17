/**
 * 数据键 → 中文标签 + 单位（工作清单 v1.0 §11.5、§11.10）
 *
 * ── 为什么要单独一份标签表 ──────────────────────────────────────────
 * 表面组件按**数据键**取值渲染（`demoActions.ts` 的 `dataKeys`），
 * 而键名是 `weather.rain.totalMm` 这种给机器看的路径。
 * 直接把它显示给观众等于没做界面；在组件里写 `if (key === "...") return "累计降雨"`
 * 又会让标签散落在渲染逻辑里、无法被测试核对。
 * 所以单独成表，并配一条测试：**每个被引用的键都必须有标签**
 * （漏了会退化成显示原始键名，观众看到 `weather.rain.totalMm` 会当场出戏）。
 *
 * §11.10 还要求「所有面向观众的状态要说清对象和数量」，
 * 所以标签里带单位与"相对什么"（如"测点距 Z04"），不带"效果良好"这类空话。
 */

export type FieldLabel = {
  /** 面向观众的中文标签 */
  label: string;
  /** 单位（数值型才有；显示在值后面） */
  unit?: string;
  /** 该值是否属于"本地演习数据"（§4.2：页面要能标注来源性质） */
  demoData?: boolean;
};

export const FIELD_LABELS: Record<string, FieldLabel> = {
  /* §6.1 时间与工单 */
  "clock.businessDate": { label: "业务日期" },
  "components.count": { label: "木构主体数量", unit: "根" },
  "components.codes": { label: "平台编号" },
  "components.focus": { label: "重点构件" },
  "components.focusRegion": { label: "重点区域" },
  "mission.id": { label: "巡检任务编号" },
  "mission.waypointCount": { label: "航点数", unit: "个" },
  "mission.routeLengthM": { label: "路线长度", unit: "m" },
  "map.version": { label: "建图版本" },
  "map.resolutionM": { label: "分辨率", unit: "m" },
  "map.coveragePct": { label: "地图覆盖率", unit: "%" },
  "map.fileSizeText": { label: "建图文件" },
  "twin.sceneId": { label: "三维场景编号" },
  "twin.boundingBoxText": { label: "场景包围盒" },
  "draftOrder.no": { label: "工单草稿编号" },

  /* §6.2 天气（本地演习数据） */
  "weather.panelTitle": { label: "档案标题" },
  "weather.rangeStart": { label: "统计起始日" },
  "weather.rangeEnd": { label: "统计截止日" },
  "weather.badge": { label: "数据性质" },
  "weather.rain.totalMm": { label: "累计降雨", unit: "mm", demoData: true },
  "weather.rain.rainyDays": { label: "降雨天数", unit: "天", demoData: true },
  "weather.rain.stormDays": { label: "暴雨天数", unit: "天", demoData: true },
  "weather.rain.longestWetSpellDays": { label: "最长连续降雨", unit: "天", demoData: true },
  "weather.rain.peakDailyMm": { label: "单日降雨峰值", unit: "mm", demoData: true },
  /*
    ①（三个月巡检与风险统计）挂着这个键：台词说的是"检索近三个月的巡检工单、
    风险记录和施工反馈"，这一行给出**降雨口径的风险项**（真实取自天气档案，
    不是台词里那组没有出处的统计数字）。
  */
  "weather.rain.risks": { label: "降雨风险项", demoData: true },
  "weather.humidity.avgPct": { label: "平均相对湿度", unit: "%", demoData: true },
  "weather.humidity.highHumidityDays": { label: "高湿日", unit: "天", demoData: true },
  "weather.humidity.maxDailyAvgPct": { label: "最高日均湿度", unit: "%", demoData: true },
  "weather.wind.maxGustMs": { label: "最大阵风", unit: "m/s", demoData: true },
  "weather.wind.strongWindDays": { label: "强风日", unit: "天", demoData: true },
  "weather.temperature.maxDailyDeltaC": { label: "最大日温差", unit: "°C", demoData: true },

  /* §6.3 现场与素材 */
  "siteEnv.airTempC": { label: "现场温度", unit: "°C" },
  "siteEnv.relativeHumidityPct": { label: "现场相对湿度", unit: "%" },
  "siteEnv.windSpeedMs": { label: "现场风速", unit: "m/s" },
  "siteEnv.distanceToZ04M": { label: "测点距 Z04", unit: "m" },
  "siteEnv.heightAboveGroundM": { label: "测点离地高", unit: "m" },
  "material.videoCount": { label: "视频段数", unit: "段" },
  "material.durationText": { label: "素材时长" },
  "material.resolutionText": { label: "分辨率" },
  "material.keyFrames": { label: "关键帧", unit: "张" },
  "material.missingFiles": { label: "缺失文件", unit: "个" },
  "material.lowQualityClips": { label: "低清晰度片段", unit: "处" },
  "material.lowQualityMarks": { label: "标记时间点" },

  /* §6.3 异常采集 */
  "anomaly.batchId": { label: "异常批次" },
  "anomaly.plannedFrames": { label: "计划帧数", unit: "帧" },
  "anomaly.receivedFrames": { label: "实际收到", unit: "帧" },
  "anomaly.missingFrames": { label: "缺失帧数", unit: "帧" },
  "anomaly.featureShiftSigma": { label: "特征偏移", unit: "σ" },
  "anomaly.conclusion": { label: "当前结论" },

  /* §6.3 清洗与模型 */
  "clean.rawCount": { label: "原始记录", unit: "条" },
  "clean.keptCount": { label: "保留", unit: "条" },
  "clean.excludedCount": { label: "排除", unit: "条" },
  "clean.physicalGroups": { label: "物理样本组", unit: "组" },
  "clean.split.train": { label: "训练集", unit: "组" },
  "clean.split.validation": { label: "验证集", unit: "组" },
  "clean.split.test": { label: "测试集", unit: "组" },
  "model.missedBefore": { label: "漏检（旧）", unit: "项" },
  "model.missedAfter": { label: "漏检（新）", unit: "项" },
  "model.falsePositiveBefore": { label: "误报（旧）", unit: "项" },
  "model.falsePositiveAfter": { label: "误报（新）", unit: "项" },
  "model.recallBefore": { label: "原有材种召回率（旧）" },
  "model.recallAfter": { label: "原有材种召回率（新）" },
  "model.deployChecksPassed": { label: "部署条件通过", unit: "项" },
  "model.deployChecksTotal": { label: "部署条件总数", unit: "项" },

  /* §6.3 端侧包与融合 */
  "package.id": { label: "端侧包编号" },
  "package.sizeMb": { label: "包大小", unit: "MB" },
  "package.targetVersion": { label: "目标版本" },
  "package.rollbackVersion": { label: "回退版本" },
  "package.selfCheckPassed": { label: "设备自检通过", unit: "项" },
  "fusion.recordId": { label: "融合记录编号" },
  "fusion.radarFrames": { label: "雷达帧", unit: "帧" },
  "fusion.imageFrames": { label: "表面图像帧", unit: "帧" },
  "fusion.edgeResults": { label: "端侧结果", unit: "份" },
  "fusion.preprocessVersion": { label: "预处理版本" },
  "fusion.reliableCount": { label: "两路一致（优先复核）", unit: "项" },
  "fusion.pendingCount": { label: "待补采", unit: "项" },
  "fusion.effectiveRatioPct": { label: "有效数据比例", unit: "%" },
  "fusion.effectiveRatioThresholdPct": { label: "有效比例阈值", unit: "%" },

  /* §6.3 归档交付 */
  "delivery.total": { label: "归档总数", unit: "项" },
  "delivery.passed": { label: "校验通过", unit: "项" },
  "delivery.missing": { label: "文件缺失", unit: "项" },
  "delivery.summaryMismatch": { label: "摘要不一致", unit: "项" },
};

/** 取标签；表里没有时返回 null（调用方据此决定是否报缺失，而不是显示原始键名） */
export function labelOf(key: string): FieldLabel | null {
  return FIELD_LABELS[key] ?? null;
}

/** 按单位格式化一个值（数组用「、」连接，数字保留原样） */
export function formatValue(value: unknown, unit?: string): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join("、");
  if (value === null || value === undefined) return "—";
  const text = String(value);
  return unit ? `${text} ${unit}` : text;
}
