/**
 * 交付平台批次 B · 分片上传与批次清单回归（《交付平台-新增接口清单》§3.7 / §3.8）
 *
 * 这份用例是按终端侧联调踩过的坑写的，重点不在"接口能通"，而在几条**不能让步**的规则：
 *   · 空 `sha256` 必须 422 —— 放过去的表现就是终端那句"最后一个文件永远传不上去"；
 *   · `batchId + name` 再建单必须回**同一个 uploadId 与已有进度**，否则永远续不上；
 *   · 重复 offset 的分片按幂等处理，且**不能把字节写两遍**（写两遍会让整文件摘要对不上，
 *     而那时已经看不出是哪一片写坏的）；
 *   · `complete` 的 `sha256` 必须是平台自己流式读盘重算的，不是把声明值回显 ——
 *     回显等于自己跟自己比，`match` 就永远是 true；
 *   · 没传完就 complete 要 4xx，不能被当成"摘要不符"；
 *   · `datasetHash` 两端同算法重算并回显，未知字段原样收下不报错也不丢弃。
 *
 * 跑法：node --test tools/test-uploads.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';

const DEVICE_ID = 'handheld-02';
const DEVICE_TOKEN = 'demo-token';
const BATCH_ID = 'scan-Z04-002';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * `datasetHash` 的重算口径与终端 `storage.commit_manifest` 一致：
 * 按路径字典序拼接 `path\0sha256\n` 再取 sha256，不含 `manifest.json`。
 * 用例里自己独立算一遍，才能验出平台是不是真的重算了（而不是回显）。
 */
function datasetHashOf(files) {
  const hash = createHash('sha256');
  for (const item of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (item.path === 'manifest.json') continue;
    hash.update(item.path, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(item.sha256, 'utf8');
    hash.update('\n');
  }
  return hash.digest('hex');
}

test('批次 B：分片上传三步 + 批次清单（断点续传 / 幂等 / 平台重算摘要 / datasetHash）', async () => {
  const { startService } = await import('../server/index.mjs');
  const service = await startService({ port: 0, host: '127.0.0.1', dbFile: ':memory:', quiet: true });
  const base = service.url;

  // 终端 HttpClient 两个头都带（platform_client.HttpClient._headers），平台两条身份都要认
  const deviceHeaders = {
    'content-type': 'application/json',
    'x-device-token': DEVICE_TOKEN,
    'x-device-id': DEVICE_ID,
  };

  try {
    const asDevice = (path, init = {}) =>
      fetch(`${base}${path}`, { ...init, headers: { ...deviceHeaders, ...(init.headers ?? {}) } });

    const login = async (account) => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, password: '123456' }),
      });
      const body = await response.json();
      assert.equal(response.status, 200, `登录 ${account} 失败：${JSON.stringify(body)}`);
      return body.token;
    };
    const browserToken = await login('rao');
    const asBrowser = (path, init = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      });

    /* ---------------- 1. 缺 sha256 → 422 ---------------- */

    const noSha = await asDevice('/api/files/uploads', {
      method: 'POST',
      body: JSON.stringify({ name: 'frames.csv', size: 10, batchId: BATCH_ID, role: 'frames', schemaVersion: '1.0' }),
    });
    assert.equal(noSha.status, 422, '空 sha256 必须被挡在门外（终端「最后一个文件永远传不上去」就是这里放过去的）');
    const noShaBody = await noSha.json();
    assert.equal(noShaBody.retryable, false);
    assert.ok(
      Array.isArray(noShaBody.fieldErrors) && noShaBody.fieldErrors.some((item) => item.field === 'sha256'),
      '422 要说清是哪个字段：sha256',
    );

    const blankSha = await asDevice('/api/files/uploads', {
      method: 'POST',
      body: JSON.stringify({ name: 'frames.csv', size: 10, sha256: '   ', batchId: BATCH_ID }),
    });
    assert.equal(blankSha.status, 422, '只有空白字符的 sha256 同样要拒');

    /* ---------------- 2. 建单 + 断点续传（同一个 uploadId 与进度） ---------------- */

    const payload = Buffer.from('木脉智检 · frames.csv 的演示字节'.repeat(64), 'utf8');
    const whole = sha256(payload);
    const createBody = {
      name: 'frames.csv',
      size: payload.length,
      sha256: whole,
      batchId: BATCH_ID,
      role: 'frames',
      schemaVersion: '1.0',
    };

    const created = await asDevice('/api/files/uploads', { method: 'POST', body: JSON.stringify(createBody) });
    assert.equal(created.status, 201, `建单应回 201：${await created.clone().text()}`);
    const order = await created.json();
    assert.ok(order.uploadId, '响应必须带 uploadId');
    assert.equal(order.receivedOffset, 0, '新单进度从 0 开始');

    /* ---------------- 3. 分两片上传（中途重复 offset 幂等） ---------------- */

    const half = Math.floor(payload.length / 2);
    const chunks = [
      { offset: 0, data: payload.subarray(0, half) },
      { offset: half, data: payload.subarray(half) },
    ];

    const putChunk = (uploadId, offset, data, extra = {}) =>
      asDevice(`/api/files/uploads/${uploadId}/chunks`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'x-chunk-offset': String(offset),
          'x-chunk-sha256': sha256(data),
          ...extra,
        },
        body: data,
      });

    const first = await putChunk(order.uploadId, chunks[0].offset, chunks[0].data);
    assert.equal(first.status, 200, `第一片应成功：${await first.clone().text()}`);
    assert.equal((await first.json()).receivedOffset, half, 'receivedOffset 要累计到第一片末尾');

    // 断线重连后终端会重发同一片：必须 200，且不能再往文件里追加一遍
    const duplicate = await putChunk(order.uploadId, chunks[0].offset, chunks[0].data);
    assert.equal(duplicate.status, 200, '重复 offset 的分片按幂等处理，不能报错');
    const duplicateBody = await duplicate.json();
    assert.equal(duplicateBody.receivedOffset, half, '幂等重发不能推进进度（推进了就是字节写了两遍）');

    const second = await putChunk(order.uploadId, chunks[1].offset, chunks[1].data);
    assert.equal(second.status, 200, `第二片应成功：${await second.clone().text()}`);
    assert.equal((await second.json()).receivedOffset, payload.length, 'receivedOffset 要等于整文件长度');

    // offset 与已收进度不一致：4xx + 明确原因 + 平台当前进度（终端据此续传，而不是重传整份）
    const gap = await putChunk(order.uploadId, payload.length + 4096, Buffer.from('gap'));
    assert.ok(gap.status >= 400 && gap.status < 500, 'offset 跳空必须 4xx，不能静默丢');
    const gapBody = await gap.json();
    assert.equal(gapBody.receivedOffset, payload.length, '4xx 里要带上平台当前进度，终端才知道从哪继续');

    // 分片摘要对不上：4xx，且不落盘（后续 complete 仍能通过）
    const badChunk = await putChunk(order.uploadId, payload.length, Buffer.from('tampered'), {
      'x-chunk-sha256': sha256(Buffer.from('something else')),
    });
    assert.equal(badChunk.status, 422, '分片摘要不符要明确拒绝');
    assert.equal((await badChunk.json()).code, 'CHUNK_SHA_MISMATCH');

    /* ---------------- 4. 未传完就 complete → 4xx ---------------- */

    const partialPayload = Buffer.from('只传了一半的内容', 'utf8');
    const partialOrder = await (
      await asDevice('/api/files/uploads', {
        method: 'POST',
        body: JSON.stringify({
          name: 'quality.json',
          size: partialPayload.length,
          sha256: sha256(partialPayload),
          batchId: BATCH_ID,
          role: 'quality',
        }),
      })
    ).json();
    const halfOfPartial = Math.floor(partialPayload.length / 2);
    await putChunk(partialOrder.uploadId, 0, partialPayload.subarray(0, halfOfPartial));

    const tooEarly = await asDevice(`/api/files/uploads/${partialOrder.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sha256: sha256(partialPayload), size: partialPayload.length }),
    });
    assert.ok(tooEarly.status >= 400 && tooEarly.status < 500, '没传完就 complete 必须 4xx');
    const tooEarlyBody = await tooEarly.json();
    assert.equal(tooEarlyBody.code, 'UPLOAD_INCOMPLETE');
    assert.equal(tooEarlyBody.receivedOffset, halfOfPartial, '要报出平台实际收到多少，终端才能接着传');

    // 补完剩下半片后就能通过：证明上面那次 4xx 没有把上传单弄坏
    await putChunk(partialOrder.uploadId, halfOfPartial, partialPayload.subarray(halfOfPartial));
    const partialDone = await asDevice(`/api/files/uploads/${partialOrder.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sha256: sha256(partialPayload), size: partialPayload.length }),
    });
    assert.equal(partialDone.status, 200, `补齐后 complete 应成功：${await partialDone.clone().text()}`);
    assert.equal((await partialDone.json()).match, true);

    /* ---------------- 5. complete 平台自己重算摘要 ---------------- */

    // 声明一个错的摘要：平台要按磁盘字节算出真值并与声明值比对，回 match:false（不是 500，也不能回显声明值）
    const wrongDeclared = `${'0'.repeat(63)}1`;
    const mismatch = await asDevice(`/api/files/uploads/${order.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sha256: wrongDeclared, size: payload.length }),
    });
    assert.equal(mismatch.status, 200, '摘要不符要回 200 + match:false（终端据此标失败），不是 5xx');
    const mismatchBody = await mismatch.json();
    assert.equal(mismatchBody.match, false, '声明摘要错误必须 match:false');
    assert.equal(mismatchBody.sha256, whole, 'sha256 必须是平台重算的真值，不能把声明值回显');
    assert.notEqual(mismatchBody.sha256, wrongDeclared);

    // 声明正确摘要：match:true，且 sha256 就是整文件摘要
    const completed = await asDevice(`/api/files/uploads/${order.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sha256: whole, size: payload.length }),
    });
    assert.equal(completed.status, 200, `complete 应成功：${await completed.clone().text()}`);
    const completedBody = await completed.json();
    assert.equal(completedBody.ok, true);
    assert.equal(completedBody.match, true, '摘要正确必须 match:true');
    assert.equal(completedBody.sha256, whole, '平台重算的整文件摘要要与终端算的一致');

    /*
      第 5 条断言（重复 offset 不改变文件字节）的兜底：
      再 complete 一次并自己算一遍 payload 的摘要 —— 上面那次 match:true 必须能复现，
      说明磁盘上那份字节真的等于 payload，而不是平台把声明值抄了回来。
    */
    const recheck = await asDevice(`/api/files/uploads/${order.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sha256: whole, size: payload.length }),
    });
    assert.equal((await recheck.json()).sha256, sha256(payload), '重算结果要可重复（同一份字节同一个摘要）');

    // 同一 batchId + name 再建单：必须回同一个 uploadId 与已有进度
    const resumed = await asDevice('/api/files/uploads', { method: 'POST', body: JSON.stringify(createBody) });
    // 200/201 都算对：终端判的是 2xx，关键是拿回同一个 uploadId 与进度
    assert.ok(resumed.status === 200 || resumed.status === 201, `已有上传单时重新建单不能报错，实得 ${resumed.status}`);
    const resumedBody = await resumed.json();
    assert.equal(resumedBody.uploadId, order.uploadId, '同一 batchId + name 必须回同一个 uploadId，否则永远续不上');
    assert.equal(resumedBody.receivedOffset, payload.length, '断点续传要把已有进度带回来');

    // 文件还在传一半时重新建单：进度要是当前进度，不是 0（"每次新建就永远续不上"的反面）
    const midOrder = await (
      await asDevice('/api/files/uploads', {
        method: 'POST',
        body: JSON.stringify({
          name: 'segments.bin',
          size: payload.length,
          sha256: whole,
          batchId: BATCH_ID,
          role: 'segments',
        }),
      })
    ).json();
    await putChunk(midOrder.uploadId, 0, chunks[0].data);
    const midResume = await (
      await asDevice('/api/files/uploads', {
        method: 'POST',
        body: JSON.stringify({
          name: 'segments.bin',
          size: payload.length,
          sha256: whole,
          batchId: BATCH_ID,
          role: 'segments',
        }),
      })
    ).json();
    assert.equal(midResume.uploadId, midOrder.uploadId, '半途重连要复用同一张单');
    assert.equal(midResume.receivedOffset, half, '断点续传要报回真实进度，终端从那里接着传');

    // 声明变了（同名不同摘要）不能接着写：必须 409 让终端重开单
    const changed = await asDevice('/api/files/uploads', {
      method: 'POST',
      body: JSON.stringify({ ...createBody, sha256: sha256(Buffer.from('另一个人改过的内容')) }),
    });
    assert.equal(changed.status, 409, '同名但摘要变了要拒绝续传，否则会把两个文件拼成一个');

    /* ---------------- 6. 批次清单 ---------------- */

    /*
      这一节要验的是「平台确认收到的是终端封存的那一份」，所以三件事必须同批：
      frames.csv 与 result.json 在同一个 batchId 下传完，marks.csv 故意不传。
      于是 missing 应当只有 marks.csv，datasetHash 也能对上（它按清单里声明的摘要算）。
    */
    const ready = Buffer.from('{"mark":"Z04-002","value":41}', 'utf8');
    const readySha = sha256(ready);

    const uploadWhole = async (batchId, name, role, data) => {
      const digest = sha256(data);
      const order = await (
        await asDevice('/api/files/uploads', {
          method: 'POST',
          body: JSON.stringify({ name, size: data.length, sha256: digest, batchId, role }),
        })
      ).json();
      const put = await putChunk(order.uploadId, 0, data);
      assert.equal(put.status, 200, `${name} 上传分片应成功：${await put.clone().text()}`);
      const done = await asDevice(`/api/files/uploads/${order.uploadId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ sha256: digest, size: data.length }),
      });
      assert.equal(done.status, 200, `${name} complete 应成功：${await done.clone().text()}`);
      assert.equal((await done.json()).match, true, `${name} 的摘要平台重算后应一致（真值必须来自磁盘字节）`);
      return order;
    };

    // frames.csv 已经在 scan-Z04-002 下传完；这里换一张单把两份同批文件放一起
    await uploadWhole('scan-Z04-009', 'frames.csv', 'frames', payload);
    await uploadWhole('scan-Z04-009', 'result.json', 'result', ready);

    const missingName = 'marks.csv';
    const manifestFiles = [
      { role: 'frames', path: 'frames.csv', bytes: payload.length, sha256: whole },
      { role: 'result', path: 'result.json', bytes: ready.length, sha256: readySha },
      { role: 'marks', path: missingName, bytes: 12, sha256: sha256(Buffer.from('never uploaded')) },
    ];
    const manifest = {
      batchId: 'scan-Z04-009',
      orderId: 'WO-2026-0914-001',
      componentId: 'Z04',
      zoneId: 'Z04-lower',
      configVersion: 'CFG-02-L3',
      modelVersion: 'DEMO-M02',
      scenarioId: 'chapter2',
      datasetHash: datasetHashOf(manifestFiles),
      files: manifestFiles,
      // 未知字段：不校验也不丢弃（整份 manifest 原样存库）
      futureField: { nested: ['未', '来', '字段'], n: 1 },
      operatorNote: '现场补采一轮',
    };

    const submitted = await asDevice('/api/batches', { method: 'POST', body: JSON.stringify(manifest) });
    assert.equal(submitted.status, 200, `提交清单应成功：${await submitted.clone().text()}`);
    const batch = await submitted.json();
    assert.equal(batch.ok, true);
    assert.equal(batch.batchId, 'scan-Z04-009');
    assert.equal(batch.received.files, 2, '同批传完的两个文件要算在 received.files 里');
    assert.equal(batch.received.bytes, payload.length + ready.length, 'received.bytes 要是两份文件的真实字节和');
    assert.ok(Array.isArray(batch.missing), 'missing 必须是数组（终端按它显示「部分接收」）');
    assert.deepEqual(batch.missing, ['marks.csv'], '没上传的 marks.csv 要出现在 missing 里');

    // 未上传的那个文件不参与重算（它的 sha256 只是终端声明），所以 datasetHash 仍能对上
    assert.equal(batch.datasetHash, manifest.datasetHash, '要回显终端声明的 datasetHash');
    assert.equal(batch.computedDatasetHash, datasetHashOf(manifestFiles), '平台要按同一算法重算 datasetHash');
    assert.equal(batch.datasetHashMatch, true, '两端各自算过的摘要必须一致');

    // 篡改一位：平台必须报 datasetHashMatch:false（不拦截，但要说出来）
    const tampered = { ...manifest, batchId: 'scan-Z04-010', datasetHash: `${'a'.repeat(63)}${manifest.datasetHash.endsWith('a') ? 'b' : 'a'}` };
    const tamperedResult = await (
      await asDevice('/api/batches', { method: 'POST', body: JSON.stringify(tampered) })
    ).json();
    assert.equal(tamperedResult.datasetHashMatch, false, 'datasetHash 被改过要报不一致');

    // 摘要不符的文件（传完了但 complete 时 match:false）也不能算「已收到」
    const badHashName = 'quality.json';
    const badBytes = Buffer.from('实际内容与清单声明不一致', 'utf8');
    const badOrder = await (
      await asDevice('/api/files/uploads', {
        method: 'POST',
        body: JSON.stringify({
          name: badHashName,
          size: badBytes.length,
          sha256: sha256(badBytes),
          batchId: 'scan-Z04-011',
          role: 'quality',
        }),
      })
    ).json();
    await putChunk(badOrder.uploadId, 0, badBytes);
    // 故意用一个错的声明摘要走 complete（模拟传输被改，平台重算后 match:false）
    await asDevice(`/api/files/uploads/${badOrder.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sha256: sha256(Buffer.from('别的内容')), size: badBytes.length }),
    });
    const withBadHash = await (
      await asDevice('/api/batches', {
        method: 'POST',
        body: JSON.stringify({
          batchId: 'scan-Z04-011',
          datasetHash: '',
          files: [{ role: 'quality', path: badHashName, bytes: badBytes.length, sha256: sha256(Buffer.from('别的内容')) }],
        }),
      })
    ).json();
    assert.ok(withBadHash.missing.includes(badHashName), '摘要不符的文件不能算已收到，要进 missing');
    assert.equal(withBadHash.complete, false, '有缺件时整批不算完整接收');

    // 未知字段不报错：上面那份 manifest 带了 futureField / operatorNote，仍然 200
    assert.equal(submitted.status, 200, '未知字段不能被当成校验失败');
    // 而且真的存下来了（不是校验通过就丢掉）
    const ledger = await asBrowser('/api/batches');
    assert.equal(ledger.status, 200, '页面用登录令牌读台账必须通');
    const ledgerBody = await ledger.json();
    assert.ok(Array.isArray(ledgerBody.batches) && ledgerBody.batches.length >= 1, 'GET /api/batches 要回 { batches }');
    const stored = ledgerBody.batches.find((item) => item.batchId === 'scan-Z04-009');
    assert.ok(stored, '刚提交的批次要出现在台账里');
    assert.deepEqual(stored.manifest.futureField, manifest.futureField, '未知字段要原样存库，不能丢弃');
    assert.equal(stored.manifest.operatorNote, manifest.operatorNote);
    assert.equal(stored.datasetHash, manifest.datasetHash, '台账里也要能看到 datasetHash 与比对结论');
    assert.equal(stored.datasetHashMatch, true);

    /* ---------------- 7. 身份：两条都要认 ---------------- */

    const anonymous = await fetch(`${base}/api/files/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    assert.equal(anonymous.status, 401, '两条身份都没有要 401');

    const badToken = await fetch(`${base}/api/files/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-token': 'not-the-token' },
      body: JSON.stringify({ ...createBody, name: 'other.csv' }),
    });
    assert.equal(badToken.status, 401, '设备令牌不对要拒绝，不能静默接受');

    const asPage = await asBrowser('/api/files/uploads', {
      method: 'POST',
      body: JSON.stringify({ ...createBody, name: 'from-page.csv' }),
    });
    assert.equal(asPage.status, 201, '页面登录令牌也要能建单（设备与页面两条身份都认）');
  } finally {
    await service.close?.();
  }
});

test('批次 B：空 sha256 / 空分片 / 重复提交等边界（服务级）', async () => {
  const { startService } = await import('../server/index.mjs');
  const service = await startService({ port: 0, host: '127.0.0.1', dbFile: ':memory:', quiet: true });
  const base = service.url;
  const headers = { 'content-type': 'application/json', 'x-device-token': DEVICE_TOKEN, 'x-device-id': DEVICE_ID };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  try {
    // 同一份 manifest 重发（终端退避重试）按幂等回放，不能报冲突
    const first = await post('/api/batches', { batchId: 'scan-replay-001', files: [], datasetHash: '' });
    assert.equal(first.status, 200);
    const replay = await post('/api/batches', { batchId: 'scan-replay-001', files: [], datasetHash: '' });
    assert.equal(replay.status, 200, '同一份清单重发要幂等，不能被当成冲突');
    assert.equal((await replay.json()).replayed, true);

    // 但内容变了必须拦：批次是"封存后交付"，允许改写等于 datasetHash 校验白做
    const conflict = await post('/api/batches', { batchId: 'scan-replay-001', files: [], datasetHash: '', note: '改过了' });
    assert.equal(conflict.status, 409, '同一 batchId 换了清单内容要拒绝');

    // 既没有 files[] 也没有 fileIds[]：不报错，只是没什么可核对的
    const empty = await post('/api/batches', { batchId: 'scan-empty-001' });
    assert.equal(empty.status, 200);
    const emptyBody = await empty.json();
    assert.deepEqual(emptyBody.missing, []);
    assert.equal(emptyBody.datasetHashMatch, null, '没有声明 datasetHash 就没有结论，不能编一个 true');

    // 缺 batchId 要 422（批次台账的主键）
    const noBatch = await post('/api/batches', { files: [] });
    assert.equal(noBatch.status, 422);

    /*
      超限要 413 而不是静默截断。
      这里挑文件条数上限来测（4097 > MAX_BATCH_FILES）而不是真造一个 64 MiB 的分片：
      上限定成多少是取舍，但「超了必须明确回 413」是行为，得有用例钉住。
    */
    const tooManyFiles = await post('/api/batches', {
      batchId: 'scan-too-many-001',
      files: Array.from({ length: 4097 }, (_, i) => ({ path: `images/frame_${i}.png`, role: 'image', bytes: 1, sha256: 'a'.repeat(64) })),
    });
    assert.equal(tooManyFiles.status, 413, '超过清单文件数上限要回 413，不能截断后当成功');
    assert.equal((await tooManyFiles.json()).code, 'TOO_MANY_FILES');

    // 单文件 size 超上限：同样 413（脏输入不能把磁盘配额吃掉）
    const tooBig = await post('/api/files/uploads', {
      name: 'huge.bin',
      size: 8 * 1024 * 1024 * 1024 + 1,
      sha256: 'a'.repeat(64),
      batchId: 'scan-too-many-001',
    });
    assert.equal(tooBig.status, 413, '单文件超过上限要回 413');

    // 空分片：终端的切片循环不会发空片，真发了说明调用方有问题，明确拒绝
    const order = await (
      await post('/api/files/uploads', {
        name: 'empty-chunk.bin',
        size: 4,
        sha256: sha256(Buffer.from('abcd')),
        batchId: 'scan-empty-001',
      })
    ).json();
    const emptyChunk = await fetch(`${base}/api/files/uploads/${order.uploadId}/chunks`, {
      method: 'PUT',
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-chunk-offset': '0',
        'x-chunk-sha256': sha256(Buffer.alloc(0)),
      },
      body: Buffer.alloc(0),
    });
    assert.equal(emptyChunk.status, 422, '空分片要明确拒绝，不能当成一片收下');

    // 缺分片头要 422 且指出是哪个头
    const noHeader = await fetch(`${base}/api/files/uploads/${order.uploadId}/chunks`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: Buffer.from('abcd'),
    });
    assert.equal(noHeader.status, 422, '缺 X-Chunk-Offset / X-Chunk-Sha256 要明确拒绝');
    const noHeaderBody = await noHeader.json();
    assert.ok(noHeaderBody.fieldErrors.length >= 1, '要指出缺的是哪个头');

    // 不存在的 uploadId：404（终端据此重开上传单）
    const goneOrder = await fetch(`${base}/api/files/uploads/up-does-not-exist/chunks`, {
      method: 'PUT',
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-chunk-offset': '0',
        'x-chunk-sha256': sha256(Buffer.from('x')),
      },
      body: Buffer.from('x'),
    });
    assert.equal(goneOrder.status, 404, '上传单不存在要 404');

    // 未知 role 只记录不拒绝（终端的枚举以后可能扩）
    const oddRole = await post('/api/files/uploads', {
      name: 'odd.bin',
      size: 1,
      sha256: sha256(Buffer.from('z')),
      batchId: 'scan-empty-001',
      role: 'not-in-the-contract-yet',
    });
    assert.equal(oddRole.status, 201, '未知 role 不该被拒绝，契约枚举是"终端会用的"而不是白名单');
  } finally {
    await service.close?.();
  }
});
