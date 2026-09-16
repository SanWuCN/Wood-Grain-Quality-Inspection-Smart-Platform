import type { FusionRecord } from "../seed/scenario";

export type CalibrationRow = {
  boxId: string;
  frameId: string;
  zone: string;
  label: string;
  confidence: number;
  coordinateState: "测区级关联";
  metricState: "物理尺度未提供";
  source: string;
};

export type EvidenceMatch = {
  annotation: FusionRecord["annotations"][number];
  radar: FusionRecord["radarFeatures"][number];
  output: FusionRecord["outputs"][number] | null;
  matched: boolean;
  note: string;
  quality: "已关联" | "待核对";
};

const compactSegment = (segment: string) => segment.replace(/^echo-[^-]+-[^-]+-/, "");

/**
 * 归档结果只提供了图像到测区的关联，没有相机内参、畸变系数或物理尺度。
 * 因此这里明确展示能证明的测区级标定，绝不借用旧脚本里的模拟参数。
 */
export function buildCalibrationRows(record: FusionRecord): CalibrationRow[] {
  return record.annotations.map((annotation) => ({
    boxId: annotation.boxId,
    frameId: annotation.image,
    zone: annotation.zone,
    label: annotation.label,
    confidence: annotation.confidence,
    coordinateState: "测区级关联",
    metricState: "物理尺度未提供",
    source: annotation.source,
  }));
}

/** 将现有三份归档证据按 zoneMatch 的确定性映射合并，不重新计算分数。 */
export function buildEvidenceMatches(record: FusionRecord): EvidenceMatch[] {
  return record.zoneMatch.map((match) => {
    const annotation = record.annotations.find((item) => item.boxId === match.visual);
    const radar = record.radarFeatures.find(
      (item) => item.segment === match.radar || compactSegment(item.segment) === match.radar,
    );

    if (!annotation || !radar) {
      throw new Error(`融合证据映射缺失：${match.visual} / ${match.radar}`);
    }

    const output = match.matched
      ? record.outputs.find((item) => item.basis.includes(compactSegment(radar.segment))) ?? null
      : null;

    return {
      annotation,
      radar,
      output,
      matched: match.matched,
      note: match.note,
      quality: !match.matched || output?.quality === "不合格" || radar.quality === "不合格" ? "待核对" : "已关联",
    };
  });
}

export function calibrationSummary(record: FusionRecord) {
  const rows = buildCalibrationRows(record);
  return {
    frameCount: rows.length,
    zoneCount: new Set(rows.map((row) => row.zone)).size,
    linkedCount: record.zoneMatch.filter((item) => item.matched).length,
    metricCalibratedCount: 0,
  };
}
