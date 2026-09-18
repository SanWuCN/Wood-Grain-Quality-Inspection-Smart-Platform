/**
 * 素材质检（`/materials`）· 剧本第二幕「全景视频与高斯场景重建」的素材检查页
 *
 * ── 剧本依据 ────────────────────────────────────────────────────────
 * 饶：「小木，检查这批重建素材，列出缺失文件和需要重看的画面」（B屏 = 全栈电脑，场景处理）；
 * 小木：「素材检查完成：视频1段，分辨率3840×1920。缺失文件0个，低清晰度片段2处，
 * 已在00:43和02:17标记。」+ 夹注「预设照片调出，给出采集建议」；
 * 饶：「首先检查对视频进行切片，然后检查清晰度和视角覆盖。连续影像需要有重叠……」
 *
 * ── 为什么是独立页面 ────────────────────────────────────────────────
 * 数字孪生页是**全屏三维视图**（`/twin`：泼溅渲染 + 构件标注），素材质检是一张清单页，
 * 两者放一起会互相挤（用户对"一级页面上堆元素、排版就乱了"有过明确意见）；
 * PRD 2.2 的一级导航又固定八项。所以与 `/workbench` 同一种做法：**有路由、不进导航**，
 * 入口是小木带路（⑩）与数字孪生页「场景版本」右上角的按钮。
 *
 * ── 三条边界 ────────────────────────────────────────────────────────
 *   1. **只读**：素材是相机与工作站侧的产物，平台只读结果、不改原始素材；
 *   2. **不编没测得的数**：清晰度检查读预置演示结果并**标明来源**，
 *      重叠率这类没有出处的数字不出现（只在检查项里说"人工重看"）；
 *   3. **不把预采当现场**：来源栏与页脚都写明本轮按预采素材演示、现场文件另行归档。
 */

import { Icon } from "../icons";
import { Panel } from "../Panel";
import { DataTable, KV, SourceTag, StateBlock, StatusChip } from "../ui";
import {
  currentSource,
  historySources,
  lowQualityMarks,
  materialAdvice,
  materialChecks,
  materialOrigin,
  materialSummary,
} from "./materialsData";
import "./materials/materials.css";

const CHECK_CHIP = {
  ok: { text: "通过", tone: "ok" as const },
  watch: { text: "需重看", tone: "warn" as const },
  todo: { text: "待处理", tone: "muted" as const },
};

export function Materials() {
  const summary = materialSummary();
  const marks = lowQualityMarks();
  const checks = materialChecks();
  const advice = materialAdvice();
  const origin = materialOrigin();
  const current = currentSource();
  const history = historySources();

  return (
    <div className="page mt">
      <Panel
        title="本轮重建素材"
        icon="asset-video"
        extra={
          <span className="mt-head">
            <SourceTag label="预采素材 · 预置检查结果" />
            <span className="muted">{origin.tool}</span>
          </span>
        }
        className="mt-panel">
        <ul className="mt-summary">
          {summary.map((row) => (
            <li key={row.key} className={row.value === "—" ? "is-missing" : ""}>
              <small>{row.label}</small>
              <b>{row.value}</b>
            </li>
          ))}
        </ul>
        {current ? (
          <KV
            columns={4}
            items={[
              { k: "来源视频", v: current.sourceVideo },
              { k: "场景版本", v: `${current.version}（${current.published}）` },
              { k: "已有场景关键帧", v: `${current.keyframes} 张` },
              { k: "采集批次", v: current.title },
            ]}
          />
        ) : (
          <StateBlock kind="empty" title="没有读到本轮场景素材" hint="场景文件由全栈开发工程师上传后再核对。" />
        )}
      </Panel>

      <Panel
        title="需要重看的画面（低清晰度标记）"
        icon="status-warning"
        extra={<StatusChip text={`${marks.length} 处`} tone={marks.length ? "warn" : "ok"} />}
        className="mt-panel">
        {marks.length ? (
          <ul className="mt-marks">
            {marks.map((mark) => (
              <li key={mark.at}>
                <time>{mark.at}</time>
                <div>
                  <b>{mark.note}</b>
                  <span>{mark.advice}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <StateBlock kind="empty" title="没有低清晰度标记" hint="全片清晰度达标时这一块是空的。" />
        )}
        {/* 脚本夹注要求「预设照片调出」：这里放的是标记点的取景说明，不伪造现场照片 */}
        <p className="note">
          标记点对应的画面由工作站侧调出（本轮结论取预置检查结果）；平台这一页只登记标记与处理建议，
          不把预置画面当作现场照片。
        </p>
      </Panel>

      <Panel title="切片与重建前检查" icon="biz-data-cleaning" className="mt-panel">
        <DataTable
          head={["检查项", "结论", "说明"]}
          rows={checks.map((check) => [
            check.label,
            <StatusChip key={`c-${check.key}`} text={CHECK_CHIP[check.state].text} tone={CHECK_CHIP[check.state].tone} />,
            check.detail,
          ])}
        />
        <h4 className="sub">采集与重建建议</h4>
        <ul className="mt-advice">
          {advice.map((item) => (
            <li key={item}>
              <Icon name="biz-manual-mark" size={16} aria-hidden />
              {item}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="同场景历史素材（对照）" icon="nav-report" className="mt-panel">
        <DataTable
          head={["场景", "来源视频", "关键帧", "版本", "状态"]}
          rows={history.map((item) => [
            item.title,
            item.sourceVideo,
            `${item.keyframes} 张`,
            item.version,
            <StatusChip key={`h-${item.id}`} text={item.published} tone={item.published === "已发布" ? "ok" : "muted"} />,
          ])}
        />
        <p className="note">{origin.note}</p>
      </Panel>
    </div>
  );
}

export default Materials;
