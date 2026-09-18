/**
 * 数据接收页的数据装配（`receiveChannel.ts`）
 *
 * 纯函数，所以"这一页会显示什么"能被逐条断言。五条判据对着剧本与平台口径：
 *   · **三路通道就是剧本点名的那三路**（小车 / 手持 / 场景文件）；
 *   · **探针没数据时如实写「无自检结论」**，不许按"平台在跑"推断成在线；
 *   · **一个文件一条、采集时间各自独立**（剧本原话），不是把一批压成一行；
 *   · **补采清单只列非「可用」的条目**（⑯：已接收文件不会重复要求上传）；
 *   · 路径记录必须真的来自样本的 `path`，不另写一套目录名。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DATA_PACKAGES, SAMPLES } from "../seed/scenario.ts";
import {
  RECEIVE_CHANNELS,
  channelsOf,
  receiveNotes,
  receiveRows,
  receiveTally,
  referenceRows,
  rowsByBatch,
  sampleChecks,
  type ReadinessLike,
} from "./receiveChannel.ts";

/** `/api/device-readiness` 的一份最小样例（与「设备接入」页读到的是同一个接口） */
const READINESS: NonNullable<ReadinessLike> = {
  counts: { ok: 3, warn: 1, fail: 0 },
  sections: [
    {
      key: "cart",
      title: "小车",
      items: [
        { level: "ok", title: "状态通道", detail: "32ms 前有数据" },
        { level: "ok", title: "两路 MJPEG", detail: "RViz / 摄像头都在推流" },
      ],
    },
    {
      key: "device",
      title: "手持终端",
      items: [{ level: "warn", title: "预览帧", detail: "比阈值陈旧 22s" }],
    },
  ],
};

test("三路通道就是剧本点名的那三路，形态按代码里真实的通道写", () => {
  assert.deepEqual([...RECEIVE_CHANNELS], ["cart", "handheld", "scene"]);
  const channels = channelsOf(READINESS);
  assert.deepEqual(
    channels.map((item) => item.label),
    ["小车数据通道", "手持设备通道", "场景文件网络通道"],
  );
  /* 形态必须是真实通道：MJPEG / 逐帧 JPEG / 平台文件通道，不写 RTSP 这类平台没有的东西 */
  assert.match(channels[0].form, /MJPEG/);
  assert.match(channels[1].form, /JPEG/);
  assert.match(channels[2].form, /文件通道/);
  for (const channel of channels) assert.doesNotMatch(channel.form, /RTSP|RTMP|WebRTC|HLS/);
});

test("通道现状取最差一级：小车两路全通过 = 已接通，手持有提醒 = 部分可用", () => {
  const channels = channelsOf(READINESS);
  assert.equal(channels[0].state, "ok");
  assert.equal(channels[1].state, "warn");
  assert.equal(channels[2].state, "ok", "平台在跑 → 文件通道可用");
  assert.match(channels[1].detail, /比阈值陈旧/);
  assert.match(channels[0].detail, /全部通过/);
});

test("探针没数据时不推断在线：三路都写无自检结论，并说清原因", () => {
  const channels = channelsOf(null);
  assert.deepEqual(
    channels.map((item) => item.state),
    ["unknown", "unknown", "unknown"],
  );
  for (const channel of channels) {
    assert.doesNotMatch(channel.detail, /在线|已接通/);
  }
  assert.match(channels[0].detail, /未读到该通道的自检结论/);
  assert.match(channels[2].detail, /未读到平台自检结论/);
});

test("自检在路上时是「正在自检」而不是「无结论」——刚跳过来不该像设备坏了", () => {
  const checking = channelsOf(null, { checking: true });
  assert.deepEqual(
    checking.map((item) => item.state),
    ["checking", "checking", "checking"],
  );
  assert.match(checking[0].detail, /正在逐路自检/);
  /* 不能给出结论性措辞（"已接通/未接通"），只能说还在探 */
  assert.doesNotMatch(checking[0].detail, /已接通|未接通/);
  /* 已经有结论时不再显示"正在自检"（缓存命中或重探完成） */
  assert.equal(channelsOf(READINESS, { checking: true })[0].state, "ok");
});

test("接收清单：一个文件一条，采集时间各自独立，校验没过的原话照抄", () => {
  const rows = receiveRows();
  assert.equal(rows.length, DATA_PACKAGES.length);
  assert.ok(rows.length >= 3, "接收清单不该只有一两行");
  /* 每个文件都有自己的采集时刻（同一批次里的两个文件时间不同） */
  const firstBatch = rows.filter((row) => row.batchId === "scan-Z04-001");
  assert.ok(firstBatch.length >= 2);
  assert.notEqual(firstBatch[0].capturedAt, firstBatch[1].capturedAt, "同一批次里的文件采集时间应当各自独立");
  /* 校验没过的条目要带上原话 */
  const flagged = rows.find((row) => row.issues.length > 0);
  assert.ok(flagged, "样例数据里有校验未过的文件");
  assert.match(flagged.issues.join("；"), /缺 \d+ 帧/);
  assert.equal(flagged.checksPassed + flagged.issues.length, flagged.checksTotal);
});

test("清点与分组：状态用数据包自己的三种，分组按批次且批次号不丢", () => {
  const rows = receiveRows();
  const tally = receiveTally(rows);
  assert.equal(tally.total, rows.length);
  assert.equal(tally.stored + tally.toReview + tally.rejected, rows.length);
  assert.equal(tally.issueCount, rows.reduce((sum, row) => sum + row.issues.length, 0));

  const batches = rowsByBatch(rows);
  assert.ok(batches.length >= 2, "样例数据里至少两个采集批次");
  assert.equal(batches.reduce((sum, batch) => sum + batch.rows.length, 0), rows.length);
  for (const batch of batches) {
    for (const row of batch.rows) {
      assert.equal(row.batchId ?? "（未关联批次）", batch.batchId);
    }
  }
});

test("按样本编号核对：路径来自样本记录本身，补采清单只列非「可用」的", () => {
  const checks = sampleChecks();
  assert.ok(checks.length >= 4, `应至少有四个物理样本，实际 ${checks.length}`);
  assert.equal(checks.reduce((sum, item) => sum + item.records, 0), SAMPLES.length);

  for (const check of checks) {
    assert.equal(check.usable + check.toReview + check.unusable, check.records);
    for (const folder of check.folders) {
      assert.ok(
        SAMPLES.some((sample) => sample.physicalSampleId === check.physicalSampleId && sample.path.startsWith(folder)),
        `${check.physicalSampleId} 的目录 ${folder} 不是来自样本路径`,
      );
    }
    for (const follow of check.followUps) {
      const sample = SAMPLES.find((item) => item.recordId === follow.recordId);
      assert.ok(sample, `补采清单里的 ${follow.recordId} 不在样本里`);
      assert.notEqual(sample.quality, "可用", "可用的文件不该进补采清单");
      assert.equal(follow.reason, sample.qualityReason, "补采原因必须照抄样本记录的原话");
    }
  }

  /* 具体两条：空文件与格式损坏，都是"需要重看/补采"的真实记录 */
  const all = checks.flatMap((item) => item.followUps);
  assert.ok(all.some((item) => /空文件/.test(item.reason)));
  assert.ok(all.some((item) => /格式损坏/.test(item.reason)));
});

test("口径声明：同一工单编号 + 采集时间各自独立 + 不重复要求上传", () => {
  const notes = receiveNotes();
  const text = notes.join(" ");
  assert.match(text, /同一工单编号/);
  assert.match(text, /采集时间各自独立/);
  assert.match(text, /不会重复要求上传/);
  assert.match(text, /探针没数据时如实写/);
});

test("参考样本批次表：分组、来源、次数、方向都来自种子", () => {
  const rows = referenceRows();
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.match(row[0], /^ref-/);
    assert.match(row[1], /^G-SAMPLE-/);
    assert.match(row[4], /°/);
  }
});
