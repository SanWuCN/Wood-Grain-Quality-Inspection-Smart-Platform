/**
 * 「shi 权限全开」验收（用户口径 2026-09-28）
 *
 * 用户原话：「把我，shi的权限完全开放，所有功能都能直接用」。
 * 这条口径**覆盖** `docs/PRD-工单指派与扫描仪下发-v1.0.md` §6.2 L191
 * （原文禁止架构师因"全权限"拿到指派权），是当面拍板的口径变更。
 *
 * 为什么单写一个工装：`tools/验收-环境录入权限.mjs` 只盯环境录入与流程动作，
 * 看不出"是不是真的**全**开"。这里逐项核对，任意一项没给就会挂：
 *   ① 服务端：史登录返回的 `allowedActions` 必须包含**期望全集**；
 *      期望全集 = `ACTION_PERMISSION` 的全部取值 + 不在那张表里的五条
 *      （archive:verify/export、console:admin、workorder:assign、env:entry）
 *      + 知识中心四条（read/search/manage/index）。
 *   ② 前端与服务端同源：`auth.ts` 导出的 `PERMISSION_LABEL` 里，凡在服务端
 *      `ACTION_PERMISSION` 取值中出现的权限名，必须一条不差 —— 防的是
 *      "两边表各改一半"（这是这套双表结构最容易出的错）。
 *   ③ 真实接口抽查（不是只看权限数组）：模型上传到 `scenes/` 目录、数字孪生
 *      成果提交 `scene.submit`、工单指派 `PUT assignment` 三个接口史都拿到 2xx。
 *   ④ 反向：饶/马上传场景模型依然 403（证明不是把上传口对所有人放开）。
 *
 * 用法：node tools/验收-shi权限全开.mjs [--base http://192.168.31.202:8000]
 */
import { ACTION_PERMISSION, ROLE_PERMISSIONS } from "../server/services/permissions.mjs";
import { PERMISSION_LABEL } from "../src/pages/MumaiDashboard/auth.ts";

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

function client(account, presetToken = "") {
  let token = presetToken;
  const call = async (method, path, body, extraQuery = "") => {
    const r = await fetch(`${BASE}${path}${extraQuery}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON（例如字节流） */
    }
    return { status: r.status, json, text };
  };
  return {
    call,
    /** 当前令牌（原始 fetch 的场景要用，例如 rawBody 的文件上传） */
    token: () => token,
    async login() {
      const r = await call("POST", "/api/auth/login", { account, password: PASSWORD });
      token = r.json?.token ?? "";
      return r.status === 200 && Boolean(token);
    },
  };
}

/* 期望全集：动作表取值 + 不在动作表里的显式权限 + 知识中心四条 */
const PERMISSIONS_OUTSIDE_ACTIONS = [
  "archive:verify",
  "archive:export",
  "console:admin",
  "workorder:assign",
  "workorder:operate",
  "env:entry",
];
const KNOWLEDGE_PERMISSIONS = ["knowledge:read", "knowledge:search", "knowledge:manage", "knowledge:index"];
const EXPECTED = [...new Set([
  ...Object.values(ACTION_PERMISSION).filter((item) => item !== "*"),
  ...PERMISSIONS_OUTSIDE_ACTIONS,
  ...KNOWLEDGE_PERMISSIONS,
])].sort();

console.log(`目标服务器：${BASE}\n期望权限 ${EXPECTED.length} 条：${EXPECTED.join(", ")}\n`);

const SHI = client("shi");
const RAO = client("rao");
const MA = client("mayutian");

/*
  史先直接登录取令牌（① 要读登录响应里的 allowedActions），
  再把同一枚令牌交给 SHI 客户端 —— 否则后面的写接口是在"没带令牌"的情况下打的，
  第一版就是这么错的：明明权限齐了，建单却回 401。
*/
const shiLogin = await SHI.call("POST", "/api/auth/login", { account: "shi", password: PASSWORD });
const shiTokenOk = shiLogin.status === 200 && Boolean(shiLogin.json?.token);
check("史 登录", shiTokenOk);
check("饶 登录", await RAO.login());
check("马 登录", await MA.login());

/* ---------- ① 服务端权限数组 ---------- */
const granted = Array.isArray(shiLogin.json?.allowedActions) ? [...shiLogin.json.allowedActions] : [];
const missing = EXPECTED.filter((item) => !granted.includes(item));
check(
  `① 史的服务端权限覆盖期望全集（${EXPECTED.length} 条）`,
  missing.length === 0,
  missing.length ? `缺：${missing.join(", ")}` : `实得 ${granted.length} 条`,
);

/* 反向：权限集合是"给史放开"，不是"给所有人放开" —— 饶/马不该拿到指派权与流程动作 */
const raoPerms = ROLE_PERMISSIONS.rao ?? [];
const maPerms = ROLE_PERMISSIONS.ma ?? [];
check(
  "① 反向：饶/马都没有 workorder:assign（指派权只给沈与史）",
  !raoPerms.includes("workorder:assign") && !maPerms.includes("workorder:assign"),
  `rao=${raoPerms.includes("workorder:assign")} ma=${maPerms.includes("workorder:assign")}`,
);
check(
  "① 反向：马没有 scene:submit（模型上传仍不是人人可做）",
  !maPerms.includes("scene:submit"),
  `ma=${maPerms.includes("scene:submit")}`,
);

/* ---------- ② 前端表与服务端表同源 ---------- */
const frontendNames = new Set(Object.keys(PERMISSION_LABEL));
const actionNames = [...new Set(Object.values(ACTION_PERMISSION).filter((item) => item !== "*"))];
const notInFrontend = actionNames.filter((item) => !frontendNames.has(item));
check(
  "② 服务端动作表里的权限名前端都有（防两边各改一半）",
  notInFrontend.length === 0,
  notInFrontend.length ? `前端缺：${notInFrontend.join(", ")}` : `${actionNames.length} 条对齐`,
);
/* 单独盯几条最容易漏的：指派权在前端没有权限码（由 canAssign 下发），其余都要在 */
const frontendMust = ["scene:upload", "scene:submit", "env:entry", "console:admin", "knowledge:manage"];
const frontendMissing = frontendMust.filter((item) => !frontendNames.has(item));
check("② 前端的场景上传/提交、环境录入等权限名齐全", frontendMissing.length === 0, frontendMissing.join(", ") || "齐全");

/* ---------- ③ 真实接口抽查 ---------- */
const SHI_WRITE = client("shi", shiLogin.json?.token ?? "");
const eventId = `shiperm-${Date.now().toString(36)}`;
const created = await SHI_WRITE.call("POST", "/api/work-orders/trigger", { eventId });
const orderId = created.json?.orderId ?? "";
check("史 能建单（抽查写接口）", created.status === 200 && Boolean(orderId), created.json?.orderNo ?? `HTTP ${created.status}`);

let uploadedFileId = "";
try {
  if (orderId) {
    /* 3.1 场景模型上传：POST /api/files?dir=scenes（服务端按 scene:submit 判） */
    const bytes = Buffer.from("验收用假模型字节：只验权限，不验模型格式", "utf8");
    const upload = await fetch(`${BASE}/api/files?name=验收-shi权限.glb&dir=scenes&mediaType=model/gltf-binary`, {
      method: "POST",
      headers: { "content-type": "model/gltf-binary", authorization: `Bearer ${shiLogin.json.token}` },
      body: bytes,
    });
    const uploadJson = await upload.json().catch(() => null);
    uploadedFileId = uploadJson?.fileId ?? "";
    check("③ 史能上传场景模型到 scenes/（HTTP 200）", upload.status === 200, `HTTP ${upload.status}${uploadJson?.message ? `　${uploadJson.message}` : ""}`);

    /* 3.2 成果提交：scene.submit 绑到工单（payload 用 assetFileId，见 workflow.mjs） */
    if (uploadedFileId) {
      const submit = await SHI_WRITE.call("POST", "/api/commands", {
        action: "scene.submit",
        sessionId: "demo-01",
        payload: { orderId, assetFileId: uploadedFileId, title: "验收-shi权限" },
      });
      /* ⚠ 命令响应里场景状态在 `result.state`（不是 `entity.state`，实体是 `entity.data`）——
         第一版读错位置，HTTP 200 却被判成失败。 */
      check(
        "③ 史能提交场景成果（scene.submit → 待检查）",
        submit.status >= 200 && submit.status < 300 && submit.json?.result?.state === "待检查",
        `HTTP ${submit.status}　state=${submit.json?.result?.state ?? submit.json?.message ?? "?"}`,
      );
    }

    /* 3.3 工单指派：PUT /api/work-orders/{id}/assignment */
    const assign = await SHI_WRITE.call("PUT", `/api/work-orders/${orderId}/assignment`, {
      leaderAccountId: "shi",
      members: [{ accountId: "ma", duties: ["mapping_patrol"] }],
      expectedRevision: 0,
    });
    check(
      "③ 史能指派人员（PUT assignment → 200）",
      assign.status === 200 && assign.json?.assignment?.assignedBy === "shi",
      `HTTP ${assign.status}　assignedBy=${assign.json?.assignment?.assignedBy ?? "?"}`,
    );

    /* 3.4 反向：**马**仍然不能往 scenes/ 写字节。
       断言里**不含饶**：饶是全栈开发工程师，`scene:submit` 本来就是他的本职权限，
       拿他当反向对照会误报成"权限漏了"（第一版就是这么错的）。
       请求体必须真发：`/api/files` 是 rawBody 路由，空体容易卡在等流上，
       拿到的就不是 403 而是超时/挂起 —— 那是调用姿势问题，不是权限结论。 */
    for (const [label, c] of [["马", MA]]) {
      const denied = await fetch(`${BASE}/api/files?name=验收-反向.glb&dir=scenes&mediaType=model/gltf-binary`, {
        method: "POST",
        headers: { "content-type": "model/gltf-binary", authorization: `Bearer ${c.token()}` },
        body: Buffer.from("反向验收：这个账号不该能写 scenes/", "utf8"),
      });
      check(`③ 反向：${label} 仍不能上传场景模型（403）`, denied.status === 403, `HTTP ${denied.status}`);
    }
  }
} finally {
  if (uploadedFileId) {
    console.log(`\n  验收上传的文件留在 server/assets/uploads/scenes/（${uploadedFileId}），接口没有删除口，演示前可手工清掉`);
  }
  if (orderId) {
    const del = await SHI_WRITE.call("DELETE", `/api/work-orders/${orderId}`);
    console.log(`  清理临时工单：HTTP ${del.status}`);
    check("临时工单已清理（随单那份场景成果也一并断链）", del.status >= 200 && del.status < 300, `HTTP ${del.status}`);
  }
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项未通过`}（通过 ${pass}）`);
/* 用 exitCode 而不是 process.exit()：libuv 上强杀会把 WS/DB 句柄留在半关状态，
   控制台会多一条 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，看着像工具崩了。 */
process.exitCode = fail === 0 ? 0 : 1;
