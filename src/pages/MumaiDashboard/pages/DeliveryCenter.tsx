/**
 * 更新交付（`/firmware?tab=delivery`）
 *
 * 形态是**产物提交与分发**，不是流程展示：
 *   训练侧把训好的东西提交到平台 → 硬件侧从平台取走下载、烧录。
 *
 * 原来的实现是一张「更新包清单」+「量化与兼容性」+ 底部一条「交付步骤」时间线
 * （量化记录 → 兼容性检查 → 封装 → 下发 → 接收 → 更新 → 重启自检 → 版本确认）。
 * 那条时间线是用户点名要去掉的「太假」—— 它把一次交付画成固定的八步仪式，
 * 而真实平台上这一步只有两个动作：**提交**、**取用**。步骤名再漂亮也不解决
 * 「我要的东西在不在平台上、能不能下」这个问题。
 *
 * 现在三块：
 *   ① 待提交产物 —— 训好但还没上平台的（含手工上传），逐项提交前校验；
 *   ② 提交前校验 —— 校验不通过的产物不给提交入口，并写明差在哪；
 *   ③ 已发布产物 —— 已在平台上，可下载 / 记录烧录，并留下取用记录。
 *
 * 三类目标分开列（硬件侧端模型 / 平台模型 / 小车 OTA）：它们的校验项、
 * 目标载体与回退方式都不一样，混成一张表就只能比大小了。
 */

import { useMemo, useState, type ReactNode } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Panel } from "../Panel";
import { Btn, Modal, StateBlock, StatusChip } from "../ui";
import { useMumai } from "../context";
import { permissionHint } from "../auth";
import { DELIVERY_ARTIFACTS } from "../seed/scenario";
import type { DeliveryArtifact, DeliveryTarget } from "../seed/types";
import { ACCOUNT_NAME } from "../api/accounts";
import { api, isApiError, type ArtifactEntity, type SharedEntity } from "../api/client";
import { artifacts as artifactsOf, isOnline, useSharedStore } from "../store/shared";

const TARGETS: DeliveryTarget[] = ["硬件侧端模型", "平台模型", "小车 OTA"];

/** 目标 → 语义色。三类产物在界面上要能一眼分开 */
const TARGET_TONE: Record<DeliveryTarget, "ok" | "info" | "warn"> = {
  硬件侧端模型: "ok",
  平台模型: "info",
  "小车 OTA": "warn",
};

/** 允许上传的产物格式 */
const ALLOWED_EXT = [".engine", ".bin", ".pt", ".onnx", ".tar", ".gz", ".zip"];

/** 从文件名推断产物给谁用 —— 推不出来就归平台模型，并让提交人自己确认 */
function inferTarget(name: string): DeliveryTarget {
  const lower = name.toLowerCase();
  if (lower.includes("cart") || lower.includes("ota") || lower.includes("slam")) return "小车 OTA";
  if (lower.includes("engine") || lower.includes("fw") || lower.includes(".bin")) return "硬件侧端模型";
  return "平台模型";
}

/** 文件名 → 展示用的版本号：去掉扩展名，够用且不会编造版本 */
function versionFromName(name: string): string {
  return name.replace(/\.(engine|bin|pt|onnx|tar|gz|zip)$/i, "");
}

/**
 * 「12.40 MB」这类**已经格式化好的大小串** → 数值 + 单位，交给数字动效组件滚。
 *
 * 两个刻意的选择：
 *   · 小数位从原串里数出来（`3.12` → 2 位、`86` → 0 位），滚动前后的文本与
 *     原串逐字一致，不改平台既有的显示精度；
 *   · `group={false}` —— 这些串本来就是 `toFixed` 口径、不带千分位，
 *     开着千分位会把「1234.50 MB」显示成「1,234.50 MB」，等于偷偷换了排版。
 * 串里没有数字（例如「—」）就原样渲染，不做任何事。
 */
const SIZE_TEXT = /^([\d.]+)(.*)$/;

function SizeText({ text }: { text: string }) {
  const matched = SIZE_TEXT.exec(text.trim());
  const value = matched ? Number(matched[1]) : Number.NaN;
  if (!matched || !Number.isFinite(value)) return <>{text}</>;
  return (
    <NumberAnimation
      value={value}
      digits={matched[1].split(".")[1]?.length ?? 0}
      group={false}
      suffix={matched[2]}
    />
  );
}

/**
 * 「本轮产物」四段轨道的一步。
 *
 * `detail` 放宽成 `ReactNode`：里面有「已取用 N 次」这种会变的数，
 * 数字要逐帧改自己那个文本节点，就不能先被拼成一个字符串。
 */
type TrackStep = {
  key: string;
  label: string;
  done: boolean;
  owner: string;
  detail: ReactNode;
};

/* ------------------------------------------------------------------ *
 * 上传产物
 * ------------------------------------------------------------------ */

function UploadModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (artifact: DeliveryArtifact) => void;
}) {
  const { toast } = useMumai();
  const [file, setFile] = useState<{ name: string; bytes: number } | null>(null);
  const [target, setTarget] = useState<DeliveryTarget>("硬件侧端模型");

  const extOk = file ? ALLOWED_EXT.some((ext) => file.name.toLowerCase().endsWith(ext)) : false;
  const sizeOk = Boolean(file && file.bytes > 0);
  const canSubmit = Boolean(file) && extOk && sizeOk;

  const submit = () => {
    if (!file || !canSubmit) return;
    onSubmit({
      id: `art-upload-${Date.now()}`,
      name: file.name,
      target,
      modelVersion: versionFromName(file.name),
      // 手工上传没有对应的训练任务，留空 —— 不编一个任务号上去
      fromJob: null,
      // 本机时间：上传发生在什么时候，用户看得见（评审 F09 要求真实日期时间）
      producedAt: new Date().toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-"),
      sizeText: `${(file.bytes / 1024 / 1024).toFixed(2)} MB`,
      sha256: "待平台计算",
      state: "待提交",
      checks: [
        { key: "ext", label: "文件格式", pass: true, detail: `识别为 ${ALLOWED_EXT.find((e) => file.name.toLowerCase().endsWith(e))}` },
        { key: "digest", label: "摘要", pass: false, detail: "上传后由平台计算，尚未复核" },
        { key: "verify", label: "提交前校验", pass: false, detail: "尚未跑目标侧校验，提交后进入待校验" },
      ],
    });
    toast(`${file.name} 已加入待提交产物`, "ok");
    onClose();
  };

  return (
    <Modal
      title="上传产物"
      subtitle={<span>上传后进入待提交列表，不会直接发布</span>}
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {!file ? "请选择文件" : !extOk ? "格式不在允许列表" : !sizeOk ? "空文件" : "可以提交"}
          </span>
          <Btn onClick={onClose}>取消</Btn>
          <Btn tone="primary" disabled={!canSubmit} onClick={submit}>
            上传
          </Btn>
        </>
      }>
      <label className="pkg-drop">
        <input
          type="file"
          accept={ALLOWED_EXT.join(",")}
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (!picked) return;
            setFile({ name: picked.name, bytes: picked.size });
            setTarget(inferTarget(picked.name));
          }}
        />
        <span>
          <b>{file ? file.name : "点击选择产物文件"}</b>
          <em>
            {file ? (
              <>
                {/*
                  数字动效渲染出来的是 `<span>`，而 `.pkg-drop span` 是
                  `display:flex; flex-direction:column` —— 那是给外层文案列的，
                  会把这个数字也变成块级 flex 盒，把「3.12 MB」拆成两行。
                  内联样式优先级高于那条选择器，这里把它退回行内、字号颜色继续继承。
                */}
                <NumberAnimation
                  value={file.bytes / 1024 / 1024}
                  digits={2}
                  group={false}
                  style={{ display: "inline", fontSize: "inherit", color: "inherit" }}
                />{" "}
                MB
              </>
            ) : (
              `支持 ${ALLOWED_EXT.join(" / ")}`
            )}
          </em>
        </span>
      </label>

      <h4 className="sub">产物用途</h4>
      <div className="art-targets">
        {TARGETS.map((item) => (
          <button
            key={item}
            type="button"
            className={target === item ? "is-active" : ""}
            onClick={() => setTarget(item)}>
            {item}
          </button>
        ))}
      </div>
      <p className="note">
        从文件名推断为「{file ? inferTarget(file.name) : "—"}」，可在这里改。
      </p>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 页签
 * ------------------------------------------------------------------ */

export function DeliveryTab() {
  const { toast, pushEvent, can } = useMumai();
  /** 产物清单放进 state：提交会就地把它从待提交挪到已发布 */
  const [artifacts, setArtifacts] = useState<DeliveryArtifact[]>(DELIVERY_ARTIFACTS);
  const [selectedId, setSelectedId] = useState<string>(
    DELIVERY_ARTIFACTS.find((item) => item.state === "待提交")?.id ?? "",
  );
  const [uploadOpen, setUploadOpen] = useState(false);

  /**
   * 已发布产物来自共享服务，不再来自本地 useState。
   *
   * 评审 F02 的现象是「点击下载只增加取用记录；切换页签再回来，已发布候选产物
   * 又重新待发布」—— 根因是「哪些产物在平台上」只活在这个组件的内存里。
   * 现在它由服务端持有：切页、刷新、换一台电脑都读到同一份。
   */
  const sharedArtifacts = useSharedStore(artifactsOf);
  const online = useSharedStore(isOnline);
  const [busy, setBusy] = useState<string | null>(null);

  const pending = artifacts.filter((item) => item.state === "待提交");
  const selected = pending.find((item) => item.id === selectedId) ?? pending[0] ?? null;

  const failed = useMemo(
    () => selected?.checks.filter((check) => !check.pass) ?? [],
    [selected],
  );

  const canSubmit = can("package:deliver");

  /** 提交：产物从「待提交」变成「已发布」，其他工程师这才看得到 */
  const submit = (artifact: DeliveryArtifact) => {
    setArtifacts((current) =>
      current.map((item) =>
        item.id === artifact.id
          ? {
              ...item,
              state: "已发布" as const,
              checks: item.checks.map((check) =>
                check.key === "verify" || check.key === "digest" ? { ...check, pass: true, detail: "提交时由平台校验通过" } : check,
              ),
            }
          : item,
      ),
    );
    pushEvent(`产物 ${artifact.name} 已提交到平台`, "ok");
    toast(`${artifact.name} 已发布，其他工程师可以下载`, "ok");
  };

  /**
   * 真实下载。
   *
   * 原来这里是 `recordUse(artifact, "已下载")`：只往本地列表塞一条取用记录，
   * 浏览器根本不会产生下载事件（评审 F02 第一条）。现在直接打到
   * `/api/files/{id}/download`，服务端返回真实字节 + Content-Disposition，
   * 并把产物的状态从「已发布」推到「已下载」—— 切页与刷新都不会回退，
   * 因为那条状态在服务端，不在这个组件的 useState 里。
   */
  const download = async (artifact: SharedEntity<ArtifactEntity>) => {
    const entry =
      artifact.data.files.find((item) => item.role === "整包") ??
      artifact.data.files.find((item) => item.role === "清单") ??
      artifact.data.files[0];
    if (!entry) {
      toast("这条产物没有登记文件，无法下载", "danger");
      return;
    }
    setBusy(`download:${artifact.id}`);
    try {
      const saved = await api.download(entry.fileId, artifact.data.name);
      pushEvent(
        `已下载 ${saved.name}（${(saved.size / 1024).toFixed(1)} KB，摘要 ${saved.sha256?.slice(0, 12) ?? "—"}…）`,
        "ok",
      );
      toast(`已下载 ${saved.name}`, "ok");
    } catch (error) {
      toast(isApiError(error) ? error.message : "下载失败", "danger");
    } finally {
      setBusy(null);
    }
  };

  /**
   * 回验：让操作员选回刚下载的那份文件，浏览器算它的 SHA-256 再提交。
   *
   * PRD §10.3 建议的做法就是 `crypto.subtle.digest` 读 ArrayBuffer 做小文件复核。
   * 这样「摘要一致」是真的算出来的，不是拿服务端自己的值回填一个通过 ——
   * 选错文件就会走失败分支（验收 T11 要的正是这个）。
   */
  const verify = async (artifact: SharedEntity<ArtifactEntity>, file: File) => {
    setBusy(`verify:${artifact.id}`);
    try {
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await useSharedStore.getState().send({
        action: "artifact.receipt",
        entityId: artifact.id,
        expectedRevision: artifact.revision,
        payload: { reportedVersion: artifact.data.modelVersion, verifiedHash: hash, deviceMode: "demo" },
      });
      const receipt = result.result.receipt as { pass: boolean; note: string } | undefined;
      toast(receipt?.note ?? "回验完成", receipt?.pass ? "ok" : "danger");
      pushEvent(
        `${artifact.data.name} 回验${receipt?.pass ? "通过" : "未通过"}：本地摘要 ${hash.slice(0, 12)}…`,
        receipt?.pass ? "ok" : "danger",
      );
    } catch (error) {
      toast(isApiError(error) ? error.message : "回验失败", "danger");
    } finally {
      setBusy(null);
    }
  };

  const renderRow = (artifact: DeliveryArtifact) => (
    <li
      key={artifact.id}
      className={`art-row${selected?.id === artifact.id ? " is-selected" : ""}`}>
      <button
        type="button"
        className="art-row__main is-static"
        onClick={() => setSelectedId(artifact.id)}>
        <span className="art-row__name">
          <b>{artifact.name}</b>
          <i>
            {artifact.fromJob ?? "手工上传"} · {artifact.producedAt}
          </i>
        </span>
        <StatusChip text={artifact.target} tone={TARGET_TONE[artifact.target] ?? "info"} />
        <span className="art-row__ver">{artifact.modelVersion}</span>
        <span className="art-row__num">
          <SizeText text={artifact.sizeText} />
        </span>
        <span className="art-row__num">{artifact.sha256}</span>
        <span className="art-row__checks">
          {artifact.checks.filter((check) => !check.pass).length > 0 ? (
            <StatusChip
              /* chip 是 `inline-flex + gap:5px`：整段文案包一层 span，数字才不会被 gap 撑开 */
              text={
                <span>
                  <NumberAnimation value={artifact.checks.filter((check) => !check.pass).length} /> 项待处理
                </span>
              }
              tone="warn"
            />
          ) : (
            <StatusChip text="校验通过" tone="ok" />
          )}
        </span>
      </button>
      <span className="art-row__act">
        <Btn
          tone="primary"
          disabled={!canSubmit || artifact.checks.some((check) => !check.pass)}
          title={
            !canSubmit
              ? permissionHint("package:deliver")
              : artifact.checks.some((check) => !check.pass)
                ? "有未通过的提交前校验，不能发布"
                : "提交到平台，其他工程师可下载"
          }
          onClick={() => submit(artifact)}>
          提交
        </Btn>
      </span>
    </li>
  );

  /**
   * 四段轨道：生成 → 校验 → 发布 → 接收。
   *
   * 评审 U04/V08 说这一页「字段横向分散，主操作混在长列表里」，PRD §4.5 要求
   * 「候选包、检查结果、发布和接收形成顺序；当前步骤展开详细内容，已完成步骤显示摘要」。
   * 所以把**当前产物**提到最上面，用一条轨道说明它走到哪一步、下一步该谁做什么 ——
   * 下面是全量表格，看细节时再往下翻。
   */
  /** 当前产物 = 最新一条已发布/已回验的产物 */
  const current = sharedArtifacts[0] ?? null;

  const track = useMemo(() => {
    if (!current) return null;
    const state = current.data.state;
    const receipts = current.data.receipts ?? [];
    const verified = receipts.some((item) => item.pass);
    const downloaded = (current.data.downloadCount ?? 0) > 0;
    const steps: TrackStep[] = [
      { key: "build", label: "生成", done: true, owner: "史 · 人工智能架构师", detail: current.data.fromJob ?? "手工上传" },
      { key: "check", label: "校验", done: true, owner: "平台", detail: `${current.data.sizeText} · 摘要 ${current.data.sha256.slice(0, 12)}…` },
      {
        key: "publish",
        label: "发布",
        done: state !== "待提交",
        owner: "史 · 人工智能架构师",
        detail: current.data.publishedAt ? `发布于 ${current.data.publishedAt.slice(0, 19).replace("T", " ")}` : "尚未发布",
      },
      {
        key: "receive",
        label: "接收",
        done: downloaded,
        owner: "饶 · 全栈开发工程师",
        detail: downloaded ? (
          <>
            已取用 <NumberAnimation value={current.data.downloadCount} /> 次
            {verified ? " · 摘要已回验" : " · 等待提交摘要"}
          </>
        ) : (
          "尚未取用"
        ),
      },
    ];
    return {
      name: current.data.name,
      version: current.data.modelVersion,
      target: current.data.target,
      demoOnly: current.data.demoOnly,
      steps,
      verified,
    };
  }, [current]);

  return (
    <div className="delivery">
      {track ? (
        <Panel
          title="本轮产物"
          extra={
            <StatusChip
              text={track.verified ? "已回验" : current?.data.state ?? "—"}
              tone={track.verified ? "ok" : "info"}
            />
          }
          className="dl-track-panel">
          <div className="dl-track__head">
            <b>{track.name}</b>
            <span>
              {track.target} · {track.version}
              {track.demoOnly ? " · 演示资产，不可烧录" : ""}
            </span>
          </div>
          <ol className="dl-track">
            {track.steps.map((step, index) => {
              const next = !step.done && track.steps.slice(0, index).every((item) => item.done);
              return (
                <li key={step.key} className={`${step.done ? "is-done" : next ? "is-next" : "is-wait"}`}>
                  <span className="dl-track__dot" />
                  <b>{step.label}</b>
                  <em>{step.owner}</em>
                  <span className="dl-track__detail">{step.detail}</span>
                </li>
              );
            })}
          </ol>
        </Panel>
      ) : null}

      <Panel
        title="待提交产物"
        extra={
          <span className="fw-console__actions">
            <Btn tone="ghost" onClick={() => setUploadOpen(true)}>
              上传产物
            </Btn>
          </span>
        }
        className="dl-panel">
        {pending.length > 0 ? (
          <>
            <div className="art-head">
              <span>产物</span>
              <span>用途</span>
              <span>版本</span>
              <span>大小</span>
              <span>摘要</span>
              <span>提交前校验</span>
              <span />
            </div>
            <ul className="art-list">{pending.map((item) => renderRow(item))}</ul>
          </>
        ) : (
          <StateBlock
            kind="empty"
            title="没有待提交产物"
            hint="训练产出的模型或手工上传的文件会出现在这里。"
          />
        )}
      </Panel>

      <Panel
        title="提交前校验"
        extra={
          selected ? (
            <StatusChip
              /*
                chip 是 `inline-flex + gap:5px`：整段文案包一层 span，数字才不会被 gap 撑开。
                「全部通过」那一支保持原样，不把 0 显示成「0 项未通过」。
              */
              text={
                failed.length > 0 ? (
                  <span>
                    <NumberAnimation value={failed.length} /> 项未通过
                  </span>
                ) : (
                  "全部通过"
                )
              }
              tone={failed.length > 0 ? "warn" : "ok"}
              dot
            />
          ) : undefined
        }
        className="dl-panel dl-panel--checks">
        {selected ? (
          <>
            <ul className="pkg-checks">
              {selected.checks.map((check) => (
                <li key={check.key} className={check.pass ? "is-ok" : "is-bad"}>
                  <b>{check.label}</b>
                  <span>{check.detail}</span>
                </li>
              ))}
            </ul>
            {failed.length > 0 ? (
              <p className="dl-block">
                有 <NumberAnimation value={failed.length} /> 项未通过，暂不能发布。校验不通过的产物不给提交入口 ——
                发布出去的是别人要烧进设备的东西，不能靠「先发了再说」。
              </p>
            ) : null}
          </>
        ) : (
          <StateBlock kind="empty" title="先选一份待提交产物" />
        )}
      </Panel>

      <Panel
        title="已发布产物"
        extra={
          online ? (
            <span className="muted">
              <NumberAnimation value={sharedArtifacts.length} /> 项 · 平台可下载
            </span>
          ) : (
            <StatusChip text="未连接共享服务" tone="warn" />
          )
        }
        className="dl-panel">
        <div className="art-head">
          <span>产物</span>
          <span>用途</span>
          <span>版本</span>
          <span>大小</span>
          <span>摘要</span>
          <span>状态</span>
          <span />
        </div>
        <ul className="art-list">
          {sharedArtifacts.length ? (
            sharedArtifacts.map((item) => (
              <li key={item.id} className="art-row">
                <span className="art-row__main">
                  <span className="art-row__name">
                    <b>{item.data.name}</b>
                    <i>
                      {item.data.fromJob ?? "手工上传"} · rev <NumberAnimation value={item.revision} />
                      {item.data.demoOnly ? " · 演示资产" : ""}
                    </i>
                  </span>
                  <StatusChip text={item.data.target} tone="info" />
                  <span className="art-row__ver">{item.data.modelVersion}</span>
                  <span className="art-row__num">
                    <SizeText text={item.data.sizeText} />
                  </span>
                  <span className="art-row__num">{item.data.sha256.slice(0, 16)}…</span>
                  <span className="art-row__checks">
                    <StatusChip
                      text={item.data.state}
                      tone={item.data.state === "已回验" ? "ok" : item.data.state === "已下载" ? "info" : "muted"}
                    />
                    {item.data.downloadCount ? (
                      <em className="muted">
                        取用 <NumberAnimation value={item.data.downloadCount} /> 次
                      </em>
                    ) : null}
                  </span>
                </span>
                <span className="art-row__act">
                  <Btn
                    disabled={!online || busy !== null}
                    title={online ? "下载真实产物文件" : "连接不上共享服务，无法下载"}
                    onClick={() => void download(item)}>
                    下载
                  </Btn>
                  {/* 回验：选回刚下载的文件，浏览器算摘要再提交 */}
                  <label className={`btn${!online || !can("deployment:receive") ? " is-disabled" : ""}`}>
                    回验
                    <input
                      type="file"
                      hidden
                      disabled={!online || !can("deployment:receive") || busy !== null}
                      onChange={(event) => {
                        const picked = event.target.files?.[0];
                        event.target.value = "";
                        if (picked) void verify(item, picked);
                      }}
                    />
                  </label>
                </span>
              </li>
            ))
          ) : (
            <li className="art-row">
              <StateBlock
                kind={online ? "empty" : "offline"}
                title={online ? "平台还没有已发布产物" : "未连接共享服务"}
                hint={online ? "提交一份待提交产物后，这里会出现可下载的产物。" : "交付状态保存在服务端，连接恢复后自动显示。"}
              />
            </li>
          )}
        </ul>

        {/* 回验记录：谁在什么时候提交了什么摘要。交付的闭环就在这张表上 */}
        <h4 className="sub">回验与取用记录</h4>
        <ol className="art-used">
          {sharedArtifacts
            .flatMap((item) =>
              item.data.receipts.map((receipt) => ({
                at: receipt.at,
                by: receipt.actor,
                action: receipt.pass ? "回验通过" : "回验未通过",
                name: item.data.name,
                note: receipt.note,
              })),
            )
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 6)
            .map((use, index) => (
              <li key={`${use.at}-${use.name}-${index}`}>
                <time>{use.at.slice(11, 19)}</time>
                <b>{ACCOUNT_NAME[use.by] ?? use.by}</b>
                <span>
                  {use.action} · {use.name}
                  {use.note ? ` · ${use.note}` : ""}
                </span>
              </li>
            ))}
        </ol>
      </Panel>

      {uploadOpen ? (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onSubmit={(artifact) => {
            setArtifacts((current) => [artifact, ...current]);
            setSelectedId(artifact.id);
          }}
        />
      ) : null}
    </div>
  );
}

export default DeliveryTab;
