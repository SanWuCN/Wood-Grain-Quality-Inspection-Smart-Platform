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
import { api, isApiError } from "../api/client";
import { archiveItems as archiveItemsOf, isOnline, useSharedStore } from "../store/shared";
import { useMumai } from "../context";
import { buildArchiveReportHtml } from "../lib";
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
  const [busyAsset, setBusyAsset] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * 清单与校验都走服务端（评审 F11）。
   *
   * 原来页面读种子里的 ARCHIVE_ITEMS，拿 `actualSha256` 和 `declaredSha256` 比 ——
   * 两个值都写在种子里，等于自己跟自己比：文件删了、改坏了、换台机器，
   * 结论都是同一份。现在清单来自服务端的 archiveItem 实体，校验由服务端
   * 逐项流式读字节重算。
   */
  const sharedItems = useSharedStore(archiveItemsOf);
  const online = useSharedStore(isOnline);
  const toast = useMumai().toast;

  const items: ArchiveItem[] = useMemo(
    () =>
      sharedItems.length
        ? sharedItems.map((entity) => ({
            assetId: entity.data.assetId,
            group: entity.data.group as ArchiveItem["group"],
            name: entity.data.name,
            sizeText: entity.data.sizeText,
            declaredSha256: entity.data.declaredSha256,
            // 服务端不再提供「实际摘要」这种预置值：它就是校验算出来的
            actualSha256: entity.data.present ? "" : "—",
            present: entity.data.present,
            sourceMode: "simulation" as const,
          }))
        : ARCHIVE_ITEMS,
    [sharedItems],
  );

  /** 校验行按资产 ID 索引，供左侧清单逐项取结论 */
  const rowByAsset = useMemo(() => {
    const map = new Map<string, ArchiveCheckRow>();
    check?.rows.forEach((row) => map.set(row.assetId, row));
    return map;
  }, [check]);

  const runCheck = async () => {
    if (!online) {
      setError("连接不上共享服务，归档校验需要服务端读取实际文件");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const report = await api.archiveCheck(useSharedStore.getState().sessionId);
      const rows: ArchiveCheckRow[] = report.rows.map((row) => ({
        assetId: row.assetId,
        group: row.group as ArchiveItem["group"],
        name: row.name,
        sizeText: row.sizeText,
        declaredSha256: row.declaredSha256,
        actualSha256: row.computedSha256 ?? "—",
        present: row.status !== "缺失",
        sourceMode: "simulation" as const,
        computed: row.computedSha256 ?? "—",
        match: row.status === "通过",
        status: row.status,
      }));
      setCheck({
        executedAt: report.executedAt.slice(0, 19).replace("T", " "),
        total: report.total,
        missing: report.missing,
        mismatch: report.mismatch,
        passed: report.passed,
        rows,
        // 报告是展示层，数据全部来自服务端那次真实比对
        reportHtml: buildArchiveReportHtml(rows, report.executedAt.slice(0, 19).replace("T", " "), report.missing, report.mismatch),
      });
    } catch (err) {
      setError(isApiError(err) ? err.message : "校验失败");
    } finally {
      setRunning(false);
    }
  };

  /**
   * 补传 / 重选副本（评审 F11 要求「提供补传或重选副本入口；完成后能全部通过」）。
   *
   * 上传的是真实字节，服务端把该项的登记摘要更新为这份文件的**真实摘要**，
   * 所以修复之后重新校验能全部通过不是把结论改成通过，而是字节与登记值真的对上了。
   */
  const repair = async (assetId: string, file: File) => {
    setBusyAsset(assetId);
    setError(null);
    try {
      const sessionId = useSharedStore.getState().sessionId;
      const uploaded = await api.upload(file, sessionId, `archive/${assetId}`);
      await api.archiveRepair(sessionId, assetId, uploaded.fileId);
      await useSharedStore.getState().refresh();
      toast(`${assetId} 已重新登记：${uploaded.name}（${(uploaded.size / 1024).toFixed(1)} KB）`, "ok");
      await runCheck();
    } catch (err) {
      setError(isApiError(err) ? err.message : "补传失败");
    } finally {
      setBusyAsset(null);
    }
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

  const byGroup = (group: ArchiveItem["group"]) => items.filter((item) => item.group === group);

  return (
    <div className="page page--archive">
      <Toolbar
        note={
          <>
            <SourceTag label="演示回放" />
            <span>完整性校验不替代内容审核；大文件应流式读取并缓存摘要</span>
          </>
        }>
        <Btn tone="primary" disabled={running || !online} onClick={() => void runCheck()}
          title={online ? "服务端逐项读取实际文件字节重算摘要" : "连接不上共享服务，无法读取实际文件"}>
          {running ? "校验中…" : "运行交付文件校验"}
        </Btn>
        <Btn disabled={!check} onClick={downloadReport} title="下载校验报告">
          下载校验报告
        </Btn>
        <Btn
          onClick={() => {
            window.print();
          }}>
          打印版 / PDF
        </Btn>
      </Toolbar>

      {error ? <p className="ar-error">{error}</p> : null}
      {online ? null : (
        <StateBlock
          kind="offline"
          title="未连接共享服务"
          hint="归档校验要读服务器上的实际文件字节，连接恢复后本页自动可用。"
        />
      )}

      <div className="ar-layout">
        <Panel
          title="交付清单"
          extra={<span className="muted">{items.length} 项</span>}
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
                          {/*
                            补传 / 重选副本（评审 F11：「提供补传或重选副本入口」）。
                            只在确实有问题时出现：缺失的补一份，摘要不符的重选一份。
                          */}
                          {checked && checked.status !== "通过" ? (
                            <label className="ar-repair" title="上传一份真实副本，服务端按它的字节重新登记摘要">
                              {busyAsset === item.assetId ? "上传中…" : checked.status === "缺失" ? "补传" : "重选副本"}
                              <input
                                type="file"
                                hidden
                                disabled={busyAsset !== null || !online}
                                onChange={(event) => {
                                  const picked = event.target.files?.[0];
                                  event.target.value = "";
                                  if (picked) void repair(item.assetId, picked);
                                }}
                              />
                            </label>
                          ) : null}
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
                hint="尚未执行校验。"
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
          </Panel>
        </div>
      </div>
    </div>
  );
}
