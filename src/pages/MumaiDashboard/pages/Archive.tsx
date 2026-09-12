/**
 * 报告归档（`/archive`）
 *
 * PRD 3.8：
 *   - 归档页列出工单、环境、原始数据、图像、地图、场景、数据集、模型记录、更新日志与报告
 *   - 经理运行**实际 SHA-256 校验**，报告缺失和不一致文件
 *   - 完整性校验不替代内容审核
 *   - 报告输出 HTML 打印版
 *
 * 校验直接调用 lib.runArchiveCheck：逐项存在性检查 + SHA-256 摘要对比 + HTML 报告，
 * 结论由真实比对给出（演示清单里故意留了两项摘要不一致），不是把动画播完当成校验通过。
 */

import { useMemo, useState } from "react";
import { Panel } from "../Panel";
import { Btn, DataTable, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import { ARCHIVE_ITEMS, UPDATE_PACKAGE, WORK_ORDER } from "../seed/scenario";
import { runArchiveCheck } from "../lib";
import type { ArchiveCheckResult, ArchiveCheckRow } from "../lib";
import type { ArchiveItem } from "../seed/types";

const GROUPS: ArchiveItem["group"][] = [
  "工单",
  "环境",
  "原始数据",
  "图像",
  "地图",
  "场景",
  "数据集",
  "模型记录",
  "更新日志",
  "报告",
];

/** 报告文件名：工单号与执行时间都来自种子与实际执行时刻，不在页面写死 */
function reportFileName(result: ArchiveCheckResult): string {
  return `归档完整性报告_${WORK_ORDER.id}_${result.executedAt.replace(/[:\s]/g, "-")}.html`;
}

export default function Archive() {
  const [check, setCheck] = useState<ArchiveCheckResult | null>(null);
  const [running, setRunning] = useState(false);

  /** 校验行按资产 ID 索引，供左侧清单逐项取结论 */
  const rowByAsset = useMemo(() => {
    const map = new Map<string, ArchiveCheckRow>();
    check?.rows.forEach((row) => map.set(row.assetId, row));
    return map;
  }, [check]);

  const runCheck = async () => {
    setRunning(true);
    // PRD 3.8：逐项做存在性检查与 SHA-256 摘要对比，「一致 / 不一致」由真实比对给出
    const result = await runArchiveCheck(ARCHIVE_ITEMS);
    setCheck(result);
    setRunning(false);
  };

  /** PRD 3.8：报告输出 HTML 打印版；runArchiveCheck 已返回完整报告，直接下载 */
  const downloadReport = () => {
    if (!check) return;
    const blob = new Blob([check.reportHtml], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = reportFileName(check);
    link.click();
    URL.revokeObjectURL(url);
  };

  const byGroup = (group: ArchiveItem["group"]) => ARCHIVE_ITEMS.filter((item) => item.group === group);

  return (
    <div className="page page--archive">
      <Toolbar
        note={
          <>
            <SourceTag label="演示回放" />
            <span>完整性校验不替代内容审核；大文件应流式读取并缓存摘要</span>
          </>
        }>
        <Btn tone="primary" disabled={running} onClick={() => void runCheck()}>
          {running ? "校验中…" : "运行交付文件校验"}
        </Btn>
        <Btn disabled={!check} onClick={downloadReport} title="下载 runArchiveCheck 生成的 HTML 校验报告">
          下载校验报告
        </Btn>
        <Btn
          onClick={() => {
            window.print();
          }}>
          打印版 / PDF
        </Btn>
      </Toolbar>

      <div className="ar-layout">
        <Panel
          title="交付清单"
          extra={<span className="muted">{ARCHIVE_ITEMS.length} 项</span>}
          className="ar-list">
          <div className="ar-groups">
            {GROUPS.map((group) => {
              const items = byGroup(group);
              if (!items.length) return null;
              return (
                <section key={group}>
                  <h4 className="sub">
                    {group}
                    <span className="muted">{items.length} 项</span>
                  </h4>
                  <ul className="ar-items">
                    {items.map((item) => {
                      const checked = rowByAsset.get(item.assetId);
                      return (
                        <li
                          key={item.assetId}
                          className={
                            checked
                              ? checked.status === "通过"
                                ? "is-ok"
                                : "is-bad"
                              : item.present
                                ? ""
                                : "is-missing"
                          }>
                          <b>{item.name}</b>
                          <em>{item.sizeText}</em>
                          <span>{item.assetId}</span>
                          {checked ? (
                            <StatusChip
                              text={checked.status}
                              tone={checked.status === "通过" ? "ok" : "danger"}
                            />
                          ) : item.present ? (
                            <StatusChip text="待校验" tone="muted" />
                          ) : (
                            <StatusChip text="清单中缺失" tone="danger" />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </Panel>

        <div className="ar-side">
          <Panel
            title="校验结果"
            extra={check ? <StatusChip text={`${check.passed}/${check.total} 通过`} tone={check.missing + check.mismatch === 0 ? "ok" : "danger"} /> : null}>
            {check ? (
              <>
                <div className="ar-summary">
                  <span>
                    一致 <b className="is-ok">{check.passed}</b>
                  </span>
                  <span>
                    缺失 <b className="is-danger">{check.missing}</b>
                  </span>
                  <span>
                    摘要不一致 <b className="is-warn">{check.mismatch}</b>
                  </span>
                </div>
                <p className="note">
                  执行时间 {check.executedAt} · 校验方式：逐项存在性检查 + SHA-256 摘要对比（Web Crypto）
                </p>
                <DataTable
                  compact
                  head={["文件", "清单摘要", "重算摘要", "结论"]}
                  rows={check.rows.map((row) => {
                    const bad = row.status !== "通过";
                    return [
                      <b key={`n-${row.assetId}`}>{row.name}</b>,
                      <span key={`d-${row.assetId}`} className={bad ? "is-danger" : undefined}>
                        {row.declaredSha256}
                      </span>,
                      <span key={`c-${row.assetId}`} className={bad ? "is-danger" : undefined}>
                        {row.computed}
                      </span>,
                      <StatusChip
                        key={`s-${row.assetId}`}
                        text={row.status}
                        tone={row.status === "通过" ? "ok" : "danger"}
                      />,
                    ];
                  })}
                />
                {check.missing + check.mismatch > 0 ? (
                  <StateBlock
                    kind="error"
                    title="存在缺失或不一致文件"
                    hint={`缺失 ${check.missing} 项、摘要不一致 ${check.mismatch} 项：${check.rows
                      .filter((row) => row.status !== "通过")
                      .map((row) => row.name)
                      .join("、")}。补齐文件后重新运行校验；一致性不等于内容审核通过。`}
                  />
                ) : (
                  <StateBlock kind="success" title="清单一致" hint="所有登记文件均存在且摘要一致。" />
                )}
              </>
            ) : (
              <StateBlock
                kind="empty"
                title="尚未运行校验"
                hint="点击「运行交付文件校验」，程序会逐项检查存在性并用 SHA-256 比对摘要。"
              />
            )}
          </Panel>

          <Panel title="归档范围与更新包">
            <dl className="kv">
              <div>
                <dt>工单</dt>
                <dd>{WORK_ORDER.id}</dd>
              </div>
              <div>
                <dt>更新包</dt>
                <dd>{UPDATE_PACKAGE.id}</dd>
              </div>
              <div>
                <dt>固件类型</dt>
                <dd>
                  {UPDATE_PACKAGE.artifactKind === "demo_nonflashable"
                    ? "不可烧录演示包"
                    : UPDATE_PACKAGE.artifactKind}
                </dd>
              </div>
              <div>
                <dt>恢复版本</dt>
                <dd>{UPDATE_PACKAGE.fallbackVersion}</dd>
              </div>
              <div>
                <dt>设备回报版本</dt>
                <dd>{UPDATE_PACKAGE.deviceVersion.demoReported}</dd>
              </div>
              <div>
                <dt>包大小</dt>
                <dd>{UPDATE_PACKAGE.sizeText}</dd>
              </div>
            </dl>
            <p className="note">
              归档包按清单下载；完整性报告输出 HTML 打印版，可下载后打印或另存为 PDF。摘要计算绑定文件大小与更新时间，
              缓存失效后重新计算。
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
