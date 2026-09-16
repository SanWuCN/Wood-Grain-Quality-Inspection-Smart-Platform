import assert from "node:assert/strict";
import { test } from "node:test";

test("产物按真实文件摘要构建，发布后下载状态不会被重复发布回退", async () => {
  const { startService } = await import("../index.mjs");
  // Node fetch rejects the OS-selected X11 port 6000, so use a stable safe test port.
  const service = await startService({ port: 18080, host: "127.0.0.1", dbFile: ":memory:", quiet: true });
  const base = service.url;

  try {
    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: "shi", password: "123456" }),
    });
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();
    const headers = { authorization: `Bearer ${token}` };

    const bytes = Buffer.from("artifact bytes from focused workflow test", "utf8");
    const upload = await fetch(
      `${base}/api/files?name=model-v3.6.1.bin&sessionId=demo-01&dir=artifacts`,
      { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: bytes },
    );
    assert.equal(upload.status, 200);
    const file = await upload.json();

    const command = (body) => fetch(`${base}/api/commands`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "demo-01", ...body }),
    });

    const builtResponse = await command({
      commandId: "artifact-build-focused-test",
      action: "artifact.build",
      payload: {
        name: "model-v3.6.1.bin",
        target: "硬件侧端模型",
        modelVersion: "v3.6.1",
        files: [{ fileId: file.fileId, role: "整包" }],
      },
    });
    assert.equal(builtResponse.status, 200);
    const built = await builtResponse.json();
    assert.equal(built.entity.data.state, "checked");
    assert.equal(built.entity.data.sha256, file.sha256);
    assert.equal(built.entity.data.sizeText, "0.00 MB");

    const publishedResponse = await command({
      commandId: "artifact-publish-focused-test",
      action: "artifact.publish",
      entityId: built.entity.id,
      expectedRevision: built.entity.revision,
    });
    assert.equal(publishedResponse.status, 200);
    assert.equal((await publishedResponse.json()).entity.data.state, "已发布");

    const download = await fetch(`${base}/api/files/${file.fileId}/download`, { headers });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

    const repeatedPublishResponse = await command({
      commandId: "artifact-republish-after-download-focused-test",
      action: "artifact.publish",
      entityId: built.entity.id,
    });
    assert.equal(repeatedPublishResponse.status, 200);
    const repeatedPublish = await repeatedPublishResponse.json();
    assert.equal(repeatedPublish.entity.data.state, "已下载");
    assert.equal(repeatedPublish.entity.data.downloadCount, 1);
    assert.equal(repeatedPublish.entity.data.receivedFiles?.length, 1);
    assert.deepEqual(repeatedPublish.entity.data.receivedFiles?.[0], {
      fileId: file.fileId,
      actor: "shi",
      at: repeatedPublish.entity.data.downloadedAt,
      size: bytes.length,
      sha256: file.sha256,
    });
  } finally {
    await service.close?.();
  }
});
