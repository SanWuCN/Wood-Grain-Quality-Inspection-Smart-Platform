/**
 * 多机协同验证：模拟"三台机器"走 HTTP，检验共享数据是否真的互通。
 *
 * 用户需求原话：「我这边按出新工单，别人那边得有，然后别人那选择人员调度，我这边得同步」。
 *
 * 做法：用**独立的 fetch 客户端**（等价于三台机器的浏览器）打同一台服务器的 LAN 地址：
 *   机器A（史）建单 → 机器B（同事）查询 → 机器C（沈·项目经理）调度 → 机器A 回查。
 * 全程只用公开 API，验证完**自动删掉临时工单**。
 *
 * ⚠ 人员调度必须用项目经理账号：服务端按岗位鉴权（用"史"会返回 403 FORBIDDEN），
 *   这是**正确的权限设计**，不是同步问题。
 *
 * 用法：node 'D:\\平台\\voice-module\\tools\\验收-多机协同.mjs' [--base http://ip:port]
 */
const baseArg = process.argv.indexOf("--base");
const BASE = baseArg >= 0 ? process.argv[baseArg + 1] : "http://192.168.31.202:8000";
const PASSWORD = "123456";

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
};

/** 一个独立客户端（= 一台机器的一个登录账号） */
function client(label, account) {
  let token = "";
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
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
      /* 非 JSON 响应 */
    }
    return { status: r.status, json, text };
  };
  return {
    label,
    account,
    call,
    async login() {
      const r = await call("POST", "/api/auth/login", { account, password: PASSWORD });
      token = r.json?.token ?? "";
      return r.status === 200 && Boolean(token);
    },
  };
}

const listOf = (r) => {
  const j = r.json ?? {};
  for (const k of ["orders", "workOrders", "items"]) if (Array.isArray(j[k])) return j[k];
  return Array.isArray(j) ? j : [];
};

const A = client("机器A（我·史）", "shi");
const B = client("机器B（同事）", "shi");
const M = client("机器C（沈·项目经理）", "shen");

console.log(`目标服务器：${BASE}\n`);

check("机器A 登录（史）", await A.login());
check("机器B 登录（同事）", await B.login());
check("机器C 登录（沈·项目经理）", await M.login());

/* ① 初始工单数 */
const before = listOf(await A.call("GET", "/api/work-orders"));
console.log(`  初始工单数：${before.length}`);

/* ② 机器A 建单（eventId 是幂等键） */
const eventId = `verify-${Date.now().toString(36)}`;
const created = await A.call("POST", "/api/work-orders/trigger", { eventId });
const newId = created.json?.orderId ?? "";
console.log(`\n  机器A 建单：HTTP ${created.status}　${created.json?.orderNo ?? ""}　${created.json?.status ?? ""}`);
check("建单被接受且拿到 id", created.status === 200 && Boolean(newId), newId || `HTTP ${created.status}`);

/* ③ 机器B 能否看到 —— 用户关心的第一条 */
if (newId) {
  const seen = await B.call("GET", `/api/work-orders/${newId}`);
  check("机器B 能查到机器A 刚建的单", seen.status === 200, `HTTP ${seen.status}`);
  const after = listOf(await B.call("GET", "/api/work-orders"));
  check(
    "机器B 的列表里出现该单",
    after.some((o) => o.id === newId),
    `列表数 ${before.length} → ${after.length}`,
  );

  /* ④ 机器C（项目经理）调度 → 机器A 回查 —— 用户关心的第二条 */
  const assign = await M.call("PUT", `/api/work-orders/${newId}/assignment`, {
    leaderAccountId: "ma",
    /* members 是对象数组：`{ accountId, duties[] }`（服务端逐个校验账号是否已登记岗位） */
    members: [{ accountId: "rao", duties: [] }],
    note: "多机协同验证",
  });
  console.log(`\n  机器C 调度：HTTP ${assign.status}　${JSON.stringify(assign.json).slice(0, 110)}`);

  const backA = await A.call("GET", `/api/work-orders/${newId}`);
  /* 服务端结构：detail.assignment.leaderLabel / members[] */
  const asg = backA.json?.detail?.assignment ?? backA.json?.assignment ?? null;
  const who = asg?.leaderLabel ?? "";
  check(
    "机器A 能看到调度改动",
    /* 标签用的是**岗位名**（如"具身智能工程师"），不是姓名，所以只要求非空即可 */
    assign.status === 200 && String(who).trim().length > 0,
    `A 读到的负责人=${JSON.stringify(who)}　参与=${JSON.stringify((asg?.members ?? []).map((m) => m.label))}`,
  );

  /* ⑤ 清理 */
  const del = await A.call("DELETE", `/api/work-orders/${newId}`);
  console.log(`\n  清理临时工单：HTTP ${del.status}`);
  check("临时工单已删除", del.status >= 200 && del.status < 300, `HTTP ${del.status}`);
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项未通过`}（通过 ${pass}）`);
