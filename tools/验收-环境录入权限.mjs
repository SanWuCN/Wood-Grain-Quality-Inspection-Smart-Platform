/**
 * 环境录入/校验/指派权限验收（用户口径 2026-09-17 起，2026-09-28 扩到全量）
 *
 * 用户原话（2026-09-17）：「我，shi账号下，应该是有权限填写环境记录与配置校验录入数据的，
 * 你干脆给我shi账号权限拉满得了」；
 * 2026-09-28 追加：「把我，shi的权限完全开放，所有功能都能直接用」。
 *
 * 检验七条（含**反向**对照，证明不是把权限对所有人放开）：
 *   ① 史（人工智能架构师）打开工单详情：`canEditEnvironment`/`canValidate` 都为真；
 *   ② 史能**保存环境草稿**（HTTP 200，草稿 revision 递增、录入人记的是史）；
 *   ③ 史能**运行校验**并生成配置版本（HTTP 200，返回 CFG-WO-… 版本号）；
 *   ④ 史能跑流程动作（暂停/恢复这类 `workorder:operate` 范围内的动作）；
 *   ⑤ 反向：饶（全栈）与马（具身）**仍然**存不了草稿、也跑不了校验（403）——
 *      这一条最重要：权限是按权限码放的，不是"对所有人松绑"。
 *   ⑥ 史的 `canAssign` 为 true（2026-09-28 口径：指派权也给了架构师，覆盖 PRD §6.2 L191）；
 *   ⑦ 史真能**指派**（PUT assignment → HTTP 200，指派记录里 `assignedBy=shi`）——
 *      光看能力位不够，这里要的是接口真的放行。
 *
 * 用法：node tools/验收-环境录入权限.mjs [--base http://192.168.31.202:8000]
 */
const baseArg = process.argv.indexOf("--base");
const BASE = baseArg >= 0 ? process.argv[baseArg + 1] : "http://127.0.0.1:8000";
const PASSWORD = "123456";

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
};

function client(account) {
  let token = "";
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, json, text };
  };
  return {
    call,
    async login() {
      const r = await call("POST", "/api/auth/login", { account, password: PASSWORD });
      token = r.json?.token ?? "";
      return r.status === 200 && Boolean(token);
    },
  };
}

const SHI = client("shi");
const SHEN = client("shen");
const RAO = client("rao");
const MA = client("mayutian");

console.log(`目标服务器：${BASE}\n`);

check("史 登录", await SHI.login());
check("沈 登录", await SHEN.login());
check("饶 登录", await RAO.login());
check("马 登录", await MA.login());

/* ---------- 准备一张工单：史建单 → 沈指派（指派权仍只在项目经理手里） ---------- */
const eventId = `envperm-${Date.now().toString(36)}`;
const created = await SHI.call("POST", "/api/work-orders/trigger", { eventId });
const orderId = created.json?.orderId ?? "";
check("史 能建单", created.status === 200 && Boolean(orderId), created.json?.orderNo ?? `HTTP ${created.status}`);

let configVersion = "";
try {
  if (orderId) {
    const assign = await SHEN.call("PUT", `/api/work-orders/${orderId}/assignment`, {
      leaderAccountId: "ma",
      members: [{ accountId: "rao", duties: [] }],
      note: "环境录入权限验收",
    });
    check("沈（项目经理）能指派", assign.status === 200, `HTTP ${assign.status}`);

    /* ---------- ① 史的能力位 ---------- */
    const detail = await SHI.call("GET", `/api/work-orders/${orderId}`);
    const caps = detail.json?.detail?.capabilities ?? detail.json?.capabilities ?? {};
    check("① 史的 canEditEnvironment = true（以前是灰的）", caps.canEditEnvironment === true, JSON.stringify(caps.canEditEnvironment));
    check("① 史的 canValidate = true", caps.canValidate === true, JSON.stringify(caps.canValidate));
    check("⑥ 史的 canAssign = true（2026-09-28 口径：指派权也给了架构师）", caps.canAssign === true, JSON.stringify(caps.canAssign));
    check("④ 史的 canPause/canResume 至少一项为真（workorder:operate）", caps.canPause === true || caps.canResume === true, `pause=${caps.canPause} resume=${caps.canResume}`);

    /* ---------- ② 史保存环境草稿 ---------- */
    const draftBody = {
      expectedRevision: null,
      inputs: { airTempC: 26.4, relativeHumidityPct: 78, windSpeedMs: 1.6 },
      instruments: [],
      pressure: { value: 1008, unit: "hPa" },
      position: "Z04 下部测区",
      measuredAt: new Date(Date.now() - 60_000).toISOString().slice(0, 16),
    };
    const saved = await SHI.call("PUT", `/api/work-orders/${orderId}/environment-draft`, draftBody);
    const draft = saved.json?.environment ?? saved.json;
    check(
      "② 史能保存环境草稿（HTTP 200）",
      saved.status === 200,
      `HTTP ${saved.status}　rev=${draft?.draftRevision ?? "?"}　录入人=${draft?.updatedByLabel ?? "?"}`,
    );
    check(
      "② 草稿记录的录入人是史",
      String(draft?.updatedBy ?? "") === "shi" || String(draft?.updatedByLabel ?? "").includes("架构师"),
      `updatedBy=${draft?.updatedBy ?? "?"} / ${draft?.updatedByLabel ?? "?"}`,
    );

    /* ---------- ③ 史运行校验 ---------- */
    const validated = await SHI.call("POST", `/api/work-orders/${orderId}/environment/validate`, {
      expectedRevision: draft?.draftRevision ?? null,
    });
    configVersion = validated.json?.environment?.config?.configVersion ?? validated.json?.configVersion ?? "";
    check(
      "③ 史能运行校验并生成配置版本（HTTP 200）",
      validated.status === 200 && Boolean(configVersion),
      `HTTP ${validated.status}　${configVersion || JSON.stringify(validated.json).slice(0, 120)}`,
    );

    /* ---------- ⑤ 反向：饶 / 马 仍然不行 ---------- */
    for (const [label, c] of [
      ["饶（全栈）", RAO],
      ["马（具身）", MA],
    ]) {
      const denied = await c.call("PUT", `/api/work-orders/${orderId}/environment-draft`, {
        ...draftBody,
        inputs: { airTempC: 25, relativeHumidityPct: 70, windSpeedMs: 1.2 },
      });
      check(`⑤ 反向：${label} 仍**不能**保存环境草稿（403）`, denied.status === 403, `HTTP ${denied.status}`);
      const deniedValidate = await c.call("POST", `/api/work-orders/${orderId}/environment/validate`, {});
      check(`⑤ 反向：${label} 仍**不能**运行校验（403）`, deniedValidate.status === 403, `HTTP ${deniedValidate.status}`);
    }

    /* ---------- ④ 史跑一个流程动作：暂停 → 恢复 ----------
       ⚠ 状态接口收的是**动作名**（pause/resume/start/submit/accept/archive），
       不是目标状态；第一版按 `{to:"已暂停"}` 打过去拿到 422 BAD_ACTION，
       那不是权限问题，是调用姿势错了。
    */
    const paused = await SHI.call("POST", `/api/work-orders/${orderId}/status`, { action: "pause" });
    const resumed = await SHI.call("POST", `/api/work-orders/${orderId}/status`, { action: "resume" });
    check(
      "④ 史能执行流程动作（暂停 → 恢复）",
      paused.status === 200 && resumed.status === 200,
      `pause=${paused.status} resume=${resumed.status}${
        paused.status !== 200 ? `　${(paused.json?.message ?? "").slice(0, 40)}` : ""
      }`,
    );

    /* 反证：流程动作也不是对所有人放开 —— 饶没有 workorder:operate */
    if (orderId) {
      const deniedPause = await RAO.call("POST", `/api/work-orders/${orderId}/status`, { action: "pause" });
      check("⑤ 反向：饶不能执行流程动作（403）", deniedPause.status === 403, `HTTP ${deniedPause.status}`);
    }

    /* ---------- ⑦ 史真能指派（不只是能力位为真） ----------
       指派的 revision 是单调递增的（服务端没有"改回未指派"这个动作，
       `assign` 必须有负责人），所以这里接着沈那次 revision 1 传 expectedRevision: 1。
    */
    const shiAssign = await SHI.call("PUT", `/api/work-orders/${orderId}/assignment`, {
      leaderAccountId: "shi",
      members: [{ accountId: "rao", duties: ["environment_entry"] }],
      expectedRevision: 1,
    });
    const assignment = shiAssign.json?.assignment ?? {};
    check(
      "⑦ 史能指派（PUT assignment → HTTP 200）",
      shiAssign.status === 200,
      `HTTP ${shiAssign.status}${shiAssign.status !== 200 ? `　${(shiAssign.json?.message ?? "").slice(0, 60)}` : ""}`,
    );
    check(
      "⑦ 指派记录记的是史（assignedBy）",
      String(assignment.assignedBy ?? "") === "shi",
      `assignedBy=${assignment.assignedBy ?? "?"}　rev=${assignment.revision ?? "?"}`,
    );
  }
} finally {
  if (orderId) {
    const del = await SHI.call("DELETE", `/api/work-orders/${orderId}`);
    console.log(`\n  清理临时工单：HTTP ${del.status}`);
    check("临时工单已删除", del.status >= 200 && del.status < 300, `HTTP ${del.status}`);
  }
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项未通过`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
