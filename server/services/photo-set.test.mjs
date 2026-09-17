/**
 * 照片处理批次素材挂载 —— 服务端行为验收（真起服务、走 HTTP）
 *
 * ── 这一组在防什么 ────────────────────────────────────────────────
 * 用户 2026-09-22 给了「处理」包（1,312 张处理后影像 + 27 张已标注原片 + 对照表），
 * 要求呈现到「固件及模型 → 训练验证 → 新旧对比」。素材留在工作区磁盘上（不进 git、
 * 不进 dist），由 `/photos/*` 只读映射给页面 —— 于是必须证明：
 *   ① 登录后 `/api/photo-set` 如实报出可用性与计数（页面据此决定贴图还是提示未挂载）；
 *   ② 四个挂载前缀都能取到文件，且 content-type 是图片、内容是原字节；
 *   ③ 素材缺失时回 **404 + JSON**（不是 SPA 兜底的一张 HTML —— 前端把 HTML 当图片解码，
 *      报出来的是"图挂了"，与真因无关）；
 *   ④ 目录穿越与非图片后缀一律挡掉；
 *   ⑤ 素材目录整个不在时 `available:false`，接口不抛异常；
 *   ⑥ 读接口要登录态：没令牌 401。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "mumai-photos-"));
  mkdirSync(join(root, "处理完毕"), { recursive: true });
  mkdirSync(join(root, "已标注照片"), { recursive: true });
  mkdirSync(join(root, "缩略图", "处理完毕"), { recursive: true });
  mkdirSync(join(root, "缩略图", "已标注照片"), { recursive: true });
  writeFileSync(join(root, "处理完毕", "sxs2026092200001.jpg"), JPG);
  writeFileSync(join(root, "处理完毕", "sxs2026092200002.jpg"), JPG);
  writeFileSync(join(root, "已标注照片", "IMG_0421.jpg"), JPG);
  writeFileSync(join(root, "缩略图", "处理完毕", "sxs2026092200001.jpg"), JPG);
  writeFileSync(join(root, "原文件名对照表.csv"), "新文件名,原文件名,源照片,位置\n");
  writeFileSync(join(root, "处理完毕", "note.txt"), "不是图片");
  return root;
}

test("照片素材挂载：可用性如实上报、四个前缀可取、缺失回 JSON 404、穿越与非图片挡住、没登录 401", async () => {
  const { startService } = await import("../index.mjs");
  const root = fixtureRoot();
  const previous = process.env.MUMAI_PHOTO_DIR;
  process.env.MUMAI_PHOTO_DIR = root;

  const service = await startService({ port: 18086, host: "127.0.0.1", dbFile: ":memory:", quiet: true });
  const base = service.url;

  const login = async (account) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, password: "123456" }),
    });
    assert.equal(response.status, 200, `${account} 登录失败`);
    return (await response.json()).token;
  };

  try {
    /* ⑥ 未登录读不到清单 */
    assert.equal((await fetch(`${base}/api/photo-set`)).status, 401, "未登录应 401");

    /* 内网同事（饶）能看：这批素材是给人核对的，不该只给管理员 */
    const rao = await login("rao");

    /* ① 可用性与计数 */
    const status = await (await fetch(`${base}/api/photo-set`, { headers: { authorization: `Bearer ${rao}` } })).json();
    assert.equal(status.available, true);
    assert.equal(status.processed, 2, "计数只数图片，.txt 不算");
    assert.equal(status.annotatedCount, 1);
    assert.deepEqual(status.annotated, ["IMG_0421.jpg"]);
    assert.equal(status.thumbs, true);
    assert.equal(status.csv, true);
    assert.equal(status.root, root);

    /* ② 四个前缀都取得到，且是原字节 */
    const cases = [
      ["/photos/processed/sxs2026092200001.jpg", "image/jpeg"],
      ["/photos/annotated/IMG_0421.jpg", "image/jpeg"],
      ["/photos/thumb/processed/sxs2026092200001.jpg", "image/jpeg"],
      ["/photos/thumb/annotated/IMG_0421.jpg", "application/json"],
    ];
    for (const [path, type] of cases) {
      const response = await fetch(`${base}${path}`);
      /* 缩略图那一份夹具里没放，应回 404 JSON；其余三份要回图 */
      if (type === "application/json") {
        assert.equal(response.status, 404, `${path} 应缺失`);
        assert.match(response.headers.get("content-type") ?? "", /application\/json/);
        continue;
      }
      assert.equal(response.status, 200, `${path} 取不到`);
      assert.equal(response.headers.get("content-type"), type);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(bytes, JPG, `${path} 内容被改过`);
    }

    /* ③ 缺失文件回 404 + JSON（不是 HTML 兜底） */
    const missing = await fetch(`${base}/photos/processed/sxs2026092299999.jpg`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type") ?? "", /application\/json/);
    const body = await missing.json();
    assert.equal(body.code, "PHOTO_NOT_FOUND");
    /* 未登记的 /photos/ 子路径同样不能落到 SPA 兜底（HTML）上 */
    const unknown = await fetch(`${base}/photos/nope`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, "PHOTO_NOT_FOUND");

    /* ④ 目录穿越与非图片后缀 */
    for (const path of [
      "/photos/processed/%2e%2e%2f原文件名对照表.csv",
      "/photos/processed/..%2f..%2f原文件名对照表.csv",
      "/photos/processed/note.txt",
      "/photos/processed/.hidden.jpg",
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, `${path} 不该被放出去`);
    }
  } finally {
    await service.close?.();
    if (previous === undefined) delete process.env.MUMAI_PHOTO_DIR;
    else process.env.MUMAI_PHOTO_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }

  /* ⑤ 素材目录整个不在：接口照常回，只是 available=false */
  process.env.MUMAI_PHOTO_DIR = join(tmpdir(), "mumai-photos-not-mounted");
  const empty = await startService({ port: 18087, host: "127.0.0.1", dbFile: ":memory:", quiet: true });
  try {
    const token = await (async () => {
      const response = await fetch(`${empty.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: "shi", password: "123456" }),
      });
      return (await response.json()).token;
    })();
    const status = await (await fetch(`${empty.url}/api/photo-set`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(status.available, false);
    assert.equal(status.processed, 0);
    assert.equal(status.annotatedCount, 0);
    assert.deepEqual(status.annotated, []);
    assert.equal(status.thumbs, false);
    assert.match(status.expect.processedDir, /处理完毕$/);
    assert.equal((await fetch(`${empty.url}/photos/processed/sxs2026092200001.jpg`)).status, 404);
  } finally {
    await empty.close?.();
    if (previous === undefined) delete process.env.MUMAI_PHOTO_DIR;
    else process.env.MUMAI_PHOTO_DIR = previous;
  }
});
