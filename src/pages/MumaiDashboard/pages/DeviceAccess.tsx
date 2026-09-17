/**
 * 设备接入 · 链路自检（硬件详情 → 设备接入）
 *
 * ── 用户给的交接包（2026-09-22）────────────────────────────────────
 * 「木脉智检-设备接入交接包」的结论是：**代码是全的，缺的是三份故意不入库的本地配置
 * + 一种正确的启动方式**（`docs/部署-设备画面排查交付-v1.0.md` 是它的主文档）。
 * 原包的 `smoke-devices.sh` 从外面发 HTTP 请求自检；这一页把同一套判据搬进平台，
 * 于是现场可以直接看到「小车地址没配 —— 去写 server/data/cart.json，改完重启后端」，
 * 而不是先怀疑平台代码。
 *
 * 判据与结论**不在前端算**：`GET /api/device-readiness` 从既有服务
 * （小车 `status()/streamProbe()`、网关 `hardwareView()`、屏幕 `status()`）现取事实，
 * 页面只负责把 5 节结论、三份配置的落盘状态与修法渲染出来。
 */

import { useCallback, useEffect, useState } from "react";
import { Panel } from "../Panel";
import { Btn, DataTable, StatusChip } from "../ui";
import { apiRequest, isApiError } from "../api/client";

type Level = "ok" | "fail" | "warn";

type ReadinessItem = { level: Level; title: string; detail?: string; hints?: string[] };

type ReadinessSection = { key: string; title: string; items: ReadinessItem[] };

type ReadinessConfig = {
  key: string;
  file: string;
  present: boolean;
  placeholder: boolean;
  purpose: string;
  env: string;
};

type Readiness = {
  generatedAt: string;
  sections: ReadinessSection[];
  counts: { ok: number; fail: number; warn: number };
  exitCode: 0 | 1;
  verdict: "ok" | "fail";
  configs: ReadinessConfig[];
};

/** 结论 → 语义色与文案（与交接包脚本的 `[ OK ]/[FAIL]/[WARN]` 一一对应） */
const LEVEL_CHIP: Record<Level, { text: string; tone: "ok" | "danger" | "warn" }> = {
  ok: { text: "通过", tone: "ok" },
  fail: { text: "失败", tone: "danger" },
  warn: { text: "提醒", tone: "warn" },
};

/** 三份本地配置的落盘状态：不存在 / 还是模板占位符 / 已填 */
function configState(config: ReadinessConfig) {
  if (!config.present) return { text: "不存在", tone: "warn" as const, hint: "克隆后的正常状态：按下面「怎么修」写一份" };
  if (config.placeholder) return { text: "还是占位符", tone: "warn" as const, hint: "拷了模板但没换成真实值 —— 等于没配" };
  return { text: "已填", tone: "ok" as const, hint: "改完这份文件必须重启后端（启动时只读一次）" };
}

export function DeviceAccessTab() {
  const [data, setData] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await apiRequest<Readiness>("/api/device-readiness"));
      setError(null);
    } catch (cause) {
      setError(isApiError(cause) ? cause.message : "自检读取失败：连不上共享服务");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = data?.counts;

  return (
    <>
      <Panel
        title="设备链路自检"
        icon="status-device-offline"
        extra={
          <span className="fw-console__actions">
            <span className="muted">{data ? `自检于 ${data.generatedAt.slice(11, 19)}` : busy ? "自检中…" : "—"}</span>
            <Btn tone="ghost" onClick={() => void load()} disabled={busy}>
              重新自检
            </Btn>
          </span>
        }
        className="fw-panel fw-panel--wide">
        {error ? <p className="da-alert">{error}</p> : null}

        {counts ? (
          <ul className="da-summary">
            <li className={counts.fail ? "is-fail" : "is-ok"}>
              <small>总体结论</small>
              <b>
                <StatusChip
                  text={counts.fail ? `有 ${counts.fail} 项失败` : "设备链路自检通过"}
                  tone={counts.fail ? "danger" : "ok"}
                  dot
                />
              </b>
              <span>{counts.fail ? "按下面每一条的提示修，修完重启后端再自检" : "交接包脚本同一口径：退出码 0"}</span>
            </li>
            <li>
              <small>通过</small>
              <b>{counts.ok}</b>
              <span>项</span>
            </li>
            <li className={counts.warn ? "is-warn" : ""}>
              <small>提醒</small>
              <b>{counts.warn}</b>
              <span>项（含可选的采集屏幕那一路）</span>
            </li>
            <li>
              <small>失败</small>
              <b>{counts.fail}</b>
              <span>项</span>
            </li>
          </ul>
        ) : null}

        {data?.sections.map((section) => (
          <section key={section.key} className="da-section" aria-label={section.title}>
            <header>
              <b>{section.title}</b>
              <span>
                {section.items.filter((item) => item.level === "ok").length}/{section.items.length} 通过
              </span>
            </header>
            <ul>
              {section.items.map((item, index) => (
                <li key={`${section.key}-${index}`} className={`is-${item.level}`}>
                  <StatusChip text={LEVEL_CHIP[item.level].text} tone={LEVEL_CHIP[item.level].tone} />
                  <span className="da-copy">
                    <b>{item.title}</b>
                    {item.detail ? <small>{item.detail}</small> : null}
                    {item.hints?.length ? (
                      <small className="da-hints">→ {item.hints.join("；")}</small>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <p className="note">
          判据与交接包的 <code>smoke-devices.sh</code> 同一套，只是从**服务内部**取数：
          小车配置与两路 MJPEG 来自 <code>cart.status()/streamProbe()</code>，设备上报新鲜度来自设备网关
          （阈值 6s 在线 / 15s 离线也是它自己报的），屏幕状态来自 <code>screenStatus()</code> ——
          页面与脚本不会各说一套。
        </p>
      </Panel>

      <Panel title="三份本地配置（故意不入库）" icon="asset-file">
        <p className="note">
          <code>server/data/</code> 在 <code>.gitignore</code> 里：真实设备的地址与密钥不跟着 Git 走，
          所以**新克隆下来一定看不到小车和扫描仪，这不是 bug**。
          现成的模板在 <code>docs/设备接入-配置模板/</code>（含树莓派终端那两份），拷过去把值换掉即可。
        </p>
        <DataTable
          head={["文件", "用途", "状态", "也可用环境变量"]}
          rows={(data?.configs ?? []).map((config) => {
            const state = configState(config);
            return [
              <b key={`f-${config.key}`}>{config.file}</b>,
              config.purpose,
              <StatusChip key={`s-${config.key}`} text={state.text} tone={state.tone} />,
              config.env,
            ];
          })}
        />
        <p className="note">
          改完任一份都要**重启后端**（三份都是启动时读一次）。占位符（<code>REPLACE_WITH…</code>）没换掉等于没配。
        </p>
      </Panel>

      <Panel title="最容易踩的三个坑" icon="status-warning">
        <ol className="da-pitfalls">
          <li>
            <b>只部署了前端</b>（nginx / <code>vite preview</code> / 只传了 dist）→ 页面能开，
            但 <code>/api</code> 与 <code>/ws</code> 都不存在，所有实时数据都不动。
            必须 <code>node server/index.mjs --static dist</code>。
          </li>
          <li>
            <b>设备令牌 0 组</b> → 任何令牌都拒绝，终端注册直接 401，硬件监看页退回种子数据。
            启动日志里看「设备网关 令牌 N 组」，<code>0 组</code> 就是它。
          </li>
          <li>
            <b>终端改了地址没重启</b> → 注册握手只在终端开机时做一次；不重启的话数据也许能通，
            但配置版本、时钟偏差、台账版本号会缺。
          </li>
        </ol>
        <p className="note">
          验收命令（与交接包 §8 一致）：<code>bash tools/smoke-devices.sh http://127.0.0.1:8000</code> ·
          <code>node tools/验收-设备接入.mjs</code> · <code>node tools/preflight.mjs</code> ·
          <code>node --test tools/test-device-gateway.mjs</code>。
          完整排查表见 <code>docs/部署-设备画面排查交付-v1.0.md</code>。
        </p>
      </Panel>
    </>
  );
}

export default DeviceAccessTab;
