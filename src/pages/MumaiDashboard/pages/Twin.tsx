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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMumai } from "../context";
import { Icon } from "../icons";
import NumberAnimation from "@/components/numberAnimation";
import { api, isApiError } from "../api/client";
import { isOnline, scenes as scenesOf, useSharedStore } from "../store/shared";
import { permissionHint } from "../auth";
import { Panel } from "../Panel";
import { Btn, Modal, PermNote, StateBlock, StatusChip, Toolbar, WaveChart } from "../ui";
import {
  CURRENT_RISKS,
  HISTORIC_ORDERS,
  HISTORY_RISKS,
  HOTSPOTS,
  SCAN_BATCHES,
  SCENES,
  WAVEFORMS,
  WORK_ORDER,
} from "../seed/scenario";
import SplatStage from "./SplatStage";

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

export default function Twin() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("component") ?? "Z04";
  const { componentById, domainPending, toast, pushEvent, can } = useMumai();

  /* ---- 工单：这一页的主入口。选中项进 URL，复制链接给别人打开是同一个工单 ---- */
  const orderId = params.get("order") ?? ORDERS[0]?.id ?? "";
  const order = ORDERS.find((item) => item.id === orderId) ?? ORDERS[0];
  const setOrderId = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("order", id);
    setParams(next, { replace: true });
  };

  const sceneRows = useSceneRows();
  /** 当前工单绑定的场景（一份工单一份成果；重复上传统一替换到这一条） */
  const orderScene = useMemo(
    () => sceneRows.find((row) => row.orderId === orderId) ?? null,
    [orderId, sceneRows],
  );
  const hasModel = Boolean(orderScene?.assetFileId);
  /** 只有全栈开发工程师能上传：其他人选已上传的模型显示 */
  const canUpload = can("scene:upload");

  const [detailOpen, setDetailOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  const [splatError, setSplatError] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState<string | null>(null);

  /* 换工单要把「加载失败」清掉：否则上一个工单的失败会挂在新工单上 */
  useEffect(() => setSplatError(null), [orderId, orderScene?.assetFileId]);

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
  const hotspot = useMemo(() => HOTSPOTS.find((item) => item.componentId === selected) ?? null, [selected]);
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
  const waveform = useMemo(
    () => WAVEFORMS.find((item) => item.batchId === waveBatch?.batchId) ?? null,
    [waveBatch?.batchId],
  );
  const [sideBySide, setSideBySide] = useState(true);

  return (
    <div className="page page--twin">
      <Toolbar
        note={
          <>
            <span>
              工单 {order?.id ?? "—"} · {order?.site ?? "—"} · {order?.title ?? ""}
            </span>
            <span>{orderScene ? `模型 ${orderScene.id} · ${orderScene.version}` : "该工单尚未收到模型文件"}</span>
          </>
        }>
        <label className="twin-order">
          <span>工单</span>
          <select value={orderId} onChange={(event) => setOrderId(event.target.value)} aria-label="选择工单">
            {ORDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.site}
              </option>
            ))}
          </select>
        </label>
        <Btn disabled={!hasModel} onClick={() => setFitNonce((value) => value + 1)} title="把镜头重新对准模型">
          适应视图
        </Btn>
        {canUpload ? (
          <Btn tone="primary" onClick={() => setUploadOpen(true)}>
            {hasModel ? "替换模型文件" : "上传模型文件"}
          </Btn>
        ) : null}
      </Toolbar>

      <div className="twin-layout">
        {/* 主视图：占页面 2/3 以上 */}
        <div className="twin-stage">
          <div className="twin-view">
            <SplatStage
              url={orderScene?.assetFileId ? api.modelUrl(orderScene.assetFileId, orderScene.assetName) : ""}
              active={hasModel && !splatError}
              camera={null}
              fitNonce={fitNonce}
              onError={(message) => setSplatError(message)}
            />
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

        {/* 侧栏：操作说明 + 场景版本 + 热点详情 */}
        <div className="twin-side">
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
                </span>
              ) : (
                <StatusChip text="未连接共享服务" tone="warn" />
              )
            }>
            {orderScene ? (
              <ul className="scene-list">
                <li className={orderScene.assetFileId ? "" : "is-missing"}>
                  <button type="button">
                    <b>{orderScene.title}</b>
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

          <Panel
            title={`热点详情 · ${component?.id ?? selected}`}
            extra={
              <span className="fw-console__actions">
                <StatusChip text={hotspot?.zoneId ?? "—"} tone="info" />
                <Btn disabled={!hotspot} onClick={() => setDetailOpen(true)}>
                  查看完整证据
                </Btn>
              </span>
            }>
            {hotspot ? (
              <ul className="hotspot-brief">
                <li>
                  <small>构件 / 部位</small>
                  <b>{(component?.name ?? selected) + " · " + (component?.part ?? "—")}</b>
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
            ) : (
              <StateBlock kind="empty" title="未选中热点" />
            )}
          </Panel>
        </div>
      </div>

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
                <dt>原图</dt>
                <dd>{hotspot.image.name}</dd>
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
            {waveform ? (
              <WaveChart
                points={waveform.points}
                unit={waveform.unit}
                axisLabel={waveform.axisLabel}
                markers={waveform.markers}
              />
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
