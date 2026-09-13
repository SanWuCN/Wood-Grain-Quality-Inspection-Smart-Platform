/**
 * 数据与知识中心 · 导入资料抽屉
 *
 * 依据：PRD §10.1（导入流程与完成提示）、§11.1（本期真实执行与场景模拟）、
 *      §12.6（文件与内容处理限制）。
 *
 * 这个抽屉要如实说明「哪些文件真的会被读取、哪些只会登记为待补充内容」：
 * 用户导入一个任意 PDF 时，平台**不会**凭大小估一个假正文（PRD §4.3）。
 */

import { useMemo, useRef, useState } from "react";
import { Btn } from "../../ui";
import type { AssetTypeKey } from "../types";
import { formatBytes } from "../selectors";
import { KbDrawer, KbEmpty, KbState } from "./KnowledgeUi";
import type { KnowledgeApiActions } from "./api-actions";

/** 真的能按文本读取的扩展名（PRD §11.1 表第一行的「受大小限制的真实读取」）。
 *
 * 清单之外的格式（PDF / Office / 图片 / 视频）本期先登记原始资产、状态为
 * 「待补充内容」——**不**按文件大小估算字符数，也不伪造正文（PRD §4.3）。
 * 所以这里只需要判断「能不能真读」，不需要一份不可读扩展名的白名单。
 */
const TEXT_EXTENSIONS = ["txt", "md", "markdown", "csv", "json", "jsonl", "log"];

/**
 * 结构化记录入口的字段模板（PRD §10.1：导入抽屉提供「文件 / 目录」和
 * 「结构化记录」两种入口）。模板与夹具里的 record 模板同名，检索时能对上口径。
 */
const RECORD_TEMPLATES = [
  { key: "采样", label: "木材含水率采样记录", fields: ["采样点", "深度", "含水率", "仪器编号"] },
  { key: "检测", label: "回弹法强度检测记录", fields: ["测区", "回弹值", "碳化深度", "推定强度"] },
  { key: "校准", label: "设备校准记录", fields: ["仪器编号", "校准日期", "标准件", "偏差"] },
  { key: "发布", label: "场景发布记录", fields: ["场景版本", "锚点", "书签", "发布人"] },
];

type Staged = {
  key: string;
  name: string;
  size: number;
  ext: string;
  /** text：真实读取正文；pending：登记为待补充内容 */
  mode: "text" | "pending";
  file: File | null;
  text?: string;
  duplicate: boolean;
  category: string;
  objectId: string;
  /** 资产主类：结构化记录不能按扩展名猜，必须显式带上（PRD §4.2 六个互斥主类） */
  type: AssetTypeKey;
};

const CATEGORIES = ["巡检报告", "构件档案", "维修记录", "设备运行", "规范方法", "历史归档"];

function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at >= 0 ? name.slice(at + 1).toLowerCase() : "";
}

function typeOf(ext: string): AssetTypeKey {
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv"].includes(ext)) return "video";
  if (["log", "jsonl"].includes(ext)) return "logBatch";
  return "document";
}
export function ImportDrawer({
  open,
  onClose,
  actions,
  knownNames,
}: {
  open: boolean;
  onClose: () => void;
  actions: KnowledgeApiActions;
  /** 已存在资产的文件名 / 编号，用于标识「同名已登记」而不是假装没看见 */
  knownNames: string[];
}) {
  const [staged, setStaged] = useState<Staged[]>([]);
  const [pasted, setPasted] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteObject, setPasteObject] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ registered: number; queued: number; pending: number } | null>(null);
  const [recordTemplate, setRecordTemplate] = useState(RECORD_TEMPLATES[0].key);
  const [recordObject, setRecordObject] = useState("");
  const [recordValues, setRecordValues] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement | null>(null);

  const known = useMemo(() => new Set(knownNames), [knownNames]);

  async function stageFiles(files: FileList | null) {
    if (!files?.length) return;
    const next: Staged[] = [];
    for (const file of Array.from(files).slice(0, 50)) {
      const ext = extensionOf(file.name);
      const readable = TEXT_EXTENSIONS.includes(ext) && file.size <= 5 * 1024 * 1024;
      const item: Staged = {
        key: `${file.name}-${file.size}-${next.length}`,
        name: file.name,
        size: file.size,
        ext,
        mode: readable ? "text" : "pending",
        file,
        duplicate: known.has(file.name),
        category: CATEGORIES[0],
        objectId: "",
        type: typeOf(ext),
      };
      if (readable) item.text = await file.text();
      next.push(item);
    }
    setStaged((current) => [...current, ...next]);
    setResult(null);
  }

  function stagePaste() {
    const text = pasted.trim();
    if (!text) return;
    setStaged((current) => [
      ...current,
      {
        key: `paste-${Date.now()}`,
        name: pasteTitle.trim() || "粘贴文本",
        size: new Blob([text]).size,
        ext: "txt",
        mode: "text",
        file: null,
        text,
        duplicate: false,
        category: CATEGORIES[0],
        objectId: pasteObject.trim(),
        type: "document",
      },
    ]);
    setPasted("");
    setPasteTitle("");
    setResult(null);
  }

  /**
   * 结构化记录入口（PRD §10.1）。
   *
   * 记录不落成文件，而是按字段模板拼成可读文本 —— 与夹具里的处理方式一致：
   * 「字段模板生成的可读记录」，来源定位是原业务实体 ID + revision（PRD §4.3）。
   * 只填了部分字段也允许登记：记录的可检索内容就是已填的那些字段。
   */
  function stageRecord() {
    const template = RECORD_TEMPLATES.find((item) => item.key === recordTemplate) ?? RECORD_TEMPLATES[0];
    const filled = template.fields.filter((field) => (recordValues[field] ?? "").trim());
    if (!filled.length) return;
    const object = recordObject.trim();
    const lines = [
      `${template.label}（手工登记）`,
      `字段：${template.fields.join("、")}`,
      ...filled.map((field) => `${field}：${recordValues[field].trim()}`),
      object ? `关联对象：${object}` : "",
      `登记时间：${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    ].filter(Boolean);
    const text = lines.join("\n");
    setStaged((current) => [
      ...current,
      {
        key: `record-${Date.now()}`,
        name: `${template.label}${object ? ` · ${object}` : ""}`,
        size: new Blob([text]).size,
        ext: "记录",
        mode: "text",
        file: null,
        text,
        duplicate: false,
        category: "设备运行",
        objectId: object,
        type: "record",
      },
    ]);
    setRecordValues({});
    setResult(null);
  }

  async function confirm() {
    if (!staged.length) return;
    setRunning(true);
    let registered = 0;
    let queued = 0;
    let pending = 0;
    try {
      for (const item of staged) {
        const outcome = await actions.register({
          type: item.type,
          title: item.name,
          format: item.ext ? item.ext.toUpperCase() : "TXT",
          businessCategories: [item.category],
          objectIds: item.objectId ? [item.objectId] : [],
          primaryObjectId: item.objectId || null,
          fileName: item.name,
          mainSource: "人工导入",
          sourceSystem: "人工导入",
          textMode: item.mode === "text" ? "uploaded" : "none",
          locatorKind: item.type === "image" ? "image" : item.type === "record" ? "record" : "section",
          // 没有正文时显式声明：服务端据此登记为「待补充内容」而不是报错
          ...(item.mode === "text" ? { text: item.text ?? "" } : { noContent: true }),
          sizeBytes: item.size,
        });
        if (!outcome.assetId) continue;
        registered += 1;
        if (outcome.indexState === "待更新") queued += 1;
        else pending += 1;
      }
      setResult({ registered, queued, pending });
      setStaged([]);
      // 登记完成后如果能更新，直接问一次是否进入索引队列（PRD §10.1 流程最后一步）
      if (queued > 0) await actions.sync({ scope: "backlog", triggerSource: "导入资料" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <KbDrawer
      open={open}
      title="导入资料"
      subtitle="文件与目录、结构化记录两类入口；粘贴文本在文件入口的二级操作里。"
      onClose={onClose}
      footer={
        <div className="kb-drawer-actions">
          <Btn onClick={() => fileInput.current?.click()} disabled={!actions.canManage}>
            选择文件
          </Btn>
          <Btn tone="primary" onClick={() => void confirm()} disabled={!staged.length || running || !actions.canManage}>
            {running ? "正在登记…" : `确认导入 ${staged.length ? `(${staged.length})` : ""}`}
          </Btn>
        </div>
      }>
      {!actions.canManage ? (
        <KbEmpty title="当前角色不能导入资产" hint="导入需要「资产管理」权限，可请项目经理或架构师完成。" />
      ) : (
        <>
          <div className="kb-drop" onClick={() => fileInput.current?.click()} role="presentation">
            <strong>选择文件或目录</strong>
            <em>
              单次最多 50 个文件、单文件 100 MiB；纯文本按 5 MiB 上限真实解析，其它格式先登记为
              「待补充内容」。
            </em>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => void stageFiles(event.target.files)}
            />
          </div>

          <details className="kb-collapse">
            <summary>
              粘贴文本 <span className="kb-collapse-caret" aria-hidden>▾</span>
            </summary>
            <div className="kb-collapse-body">
              <input
                className="kb-input"
                placeholder="标题（可选）"
                value={pasteTitle}
                onChange={(event) => setPasteTitle(event.target.value)}
              />
              <input
                className="kb-input"
                placeholder="关联对象编号（可选，例如 Z04）"
                value={pasteObject}
                onChange={(event) => setPasteObject(event.target.value)}
              />
              <textarea
                className="kb-textarea"
                rows={5}
                placeholder="把要入库的正文粘贴到这里"
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
              />
              <Btn onClick={stagePaste} disabled={!pasted.trim()}>
                加入清单
              </Btn>
            </div>
          </details>

          {/* 结构化记录：第二种入口。记录按字段模板转成可读文本，来源定位仍是原业务实体 */}
          <details className="kb-collapse">
            <summary>
              结构化记录 <span className="kb-collapse-caret" aria-hidden>▾</span>
            </summary>
            <div className="kb-collapse-body">
              <div className="kb-config-grid">
                <label className="kb-field">
                  <span>记录模板</span>
                  <select
                    className="kb-select"
                    value={recordTemplate}
                    onChange={(event) => {
                      setRecordTemplate(event.target.value);
                      setRecordValues({});
                    }}>
                    {RECORD_TEMPLATES.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="kb-field">
                  <span>关联对象编号</span>
                  <input
                    className="kb-input"
                    placeholder="例如 Z04 / WO-024"
                    value={recordObject}
                    onChange={(event) => setRecordObject(event.target.value)}
                  />
                </label>
                {RECORD_TEMPLATES.find((item) => item.key === recordTemplate)?.fields.map((field) => (
                  <label key={field} className="kb-field">
                    <span>{field}</span>
                    <input
                      className="kb-input"
                      value={recordValues[field] ?? ""}
                      onChange={(event) => setRecordValues((current) => ({ ...current, [field]: event.target.value }))}
                    />
                  </label>
                ))}
              </div>
              <Btn onClick={stageRecord} disabled={!(RECORD_TEMPLATES.find((item) => item.key === recordTemplate)?.fields ?? []).some((field) => (recordValues[field] ?? "").trim())}>
                加入清单
              </Btn>
            </div>
          </details>

          {result ? (
            <p className="kb-toast kb-toast--ok">
              已登记 {result.registered} 项，{result.queued} 项进入更新队列，{result.pending} 项待补充内容。
            </p>
          ) : null}

          {staged.length ? (
            <table className="kb-table kb-table--import">
              <thead>
                <tr>
                  <th>文件名</th>
                  <th className="is-num">大小</th>
                  <th>处理方式</th>
                  <th>重复</th>
                  <th>业务分类</th>
                  <th>关联对象</th>
                </tr>
              </thead>
              <tbody>
                {staged.map((item, index) => (
                  <tr key={item.key}>
                    <td title={item.name}>{item.name}</td>
                    <td className="is-num">{formatBytes(item.size)}</td>
                    <td>
                      <KbState
                        text={item.mode === "text" ? "真实读取文本" : "待补充内容"}
                        tone={item.mode === "text" ? "ok" : "warn"}
                      />
                    </td>
                    <td>{item.duplicate ? <KbState text="同名已登记" tone="warn" /> : <span className="kb-muted">—</span>}</td>
                    <td>
                      <select
                        className="kb-select"
                        value={item.category}
                        onChange={(event) =>
                          setStaged((current) =>
                            current.map((row, at) => (at === index ? { ...row, category: event.target.value } : row)),
                          )
                        }>
                        {CATEGORIES.map((category) => (
                          <option key={category}>{category}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="kb-input kb-input--tiny"
                        placeholder="对象编号"
                        value={item.objectId}
                        onChange={(event) =>
                          setStaged((current) =>
                            current.map((row, at) => (at === index ? { ...row, objectId: event.target.value } : row)),
                          )
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <KbEmpty title="导入清单为空" hint="选择文件或粘贴文本后，这里会列出处理方式与预期索引条件。" />
          )}

          <p className="kb-detail-footnote">
            文件传输进度与索引处理进度分开：登记完成不代表已经可检索，索引状态在资产列表里单独显示。
          </p>
        </>
      )}
    </KbDrawer>
  );
}
