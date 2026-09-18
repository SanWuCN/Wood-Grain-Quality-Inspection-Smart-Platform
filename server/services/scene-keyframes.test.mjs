/**
 * 场景「机位关键帧」—— 服务端行为验收（真起服务、走 HTTP，不走内存钩子）
 *
 * ── 这一组在防什么（用户 2026-09-17 口径）──────────────────────────
 * 「数字孪生那要加个操作点，添加打关键帧的功能，我把视角拉近木柱，然后可以打上关键帧」，
 * 并且明确「所有服务都要让别人也能用」—— 所以帧必须落在**服务端**（内网共享），
 * 三个账号都能打，且打了帧不能让场景的发布状态失效。
 *
 * 判据（每条都能证伪）：
 *   ① 提交场景后按构件各自编号（Z04 从 01 开始，Z01 也是 01）；
 *   ② 帧号同步进 `bookmarkIds`，于是场景检查的「视角书签已建立」由**真实数据**通过；
 *   ③ 发布之后**再打帧，发布状态不回退**（否则演示中随手标个机位就得重新检查+发布）；
 *   ④ 另一个账号（饶）也能打 —— 权限是 "*"（任意已登录账号）；
 *   ⑤ 坏机位（NaN / 距离 0）当场 422，不许写进实体（否则别人打开场景镜头会飞到不存在的位置）；
 *   ⑥ 删帧：实体里两层都清掉；删不存在的帧报 404。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("机位关键帧：按构件编号、进书签、发布后不回退、换账号也能打、坏机位拒收", async () => {
  const { startService } = await import("../index.mjs");
  const service = await startService({ port: 18081, host: "127.0.0.1", dbFile: ":memory:", quiet: true });
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
  const command = (token, body) =>
    fetch(`${base}/api/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "demo-01", ...body }),
    });

  try {
    const rao = await login("rao");
    const shi = await login("shi");

    /* 饶上传模型并绑定工单：锚点齐全，这样后面检查能整条通过 */
    const submitted = await command(rao, {
      commandId: "scene-submit-keyframe-test",
      action: "scene.submit",
      payload: {
        orderId: "SH-2026-0901",
        title: "机位关键帧测试场景",
        round: "本轮",
        assetId: "gs.sog",
        componentAnchors: ["Z01", "Z02", "Z03", "Z04"].map((componentId) => ({
          componentId,
          zoneId: `${componentId}-low`,
          position: null,
        })),
      },
    });
    assert.equal(submitted.status, 200);
    const scene = (await submitted.json()).entity;
    const sceneId = scene.id;
    assert.equal(scene.data.bookmarkIds.length, 0, "新场景一开始没有书签");

    const pose = (z) => ({
      azimuth: 32.5,
      polar: 88.25,
      distance: 1.4,
      focus: { x: 0.5, y: 1.2, z: -2 + z },
    });

    /* ---- ① 按构件各自编号 ---- */
    const first = await command(rao, {
      commandId: "kf-add-1",
      action: "scene.keyframe.add",
      entityId: sceneId,
      expectedRevision: scene.revision,
      payload: { componentId: "Z04", label: "Z04 柱脚近景", pose: pose(0) },
    });
    assert.equal(first.status, 200, "饶（全栈）也要能打帧");
    const afterFirst = (await first.json()).entity;
    assert.equal(afterFirst.data.keyframes.length, 1);
    assert.equal(afterFirst.data.keyframes[0].id, "KF-Z04-01");
    assert.equal(afterFirst.data.keyframes[0].addedBy, "rao", "帧上记的是谁打的");
    assert.equal(afterFirst.data.keyframes[0].label, "Z04 柱脚近景");
    assert.deepEqual(afterFirst.data.keyframes[0].pose, pose(0));

    const second = await command(shi, {
      commandId: "kf-add-2",
      action: "scene.keyframe.add",
      entityId: sceneId,
      expectedRevision: afterFirst.revision,
      payload: { componentId: "Z04", pose: pose(0.5) },
    });
    assert.equal(second.status, 200, "另一个账号（史）也能打帧");
    const afterSecond = (await second.json()).entity;
    assert.equal(afterSecond.data.keyframes[1].id, "KF-Z04-02", "同一构件往下排");
    assert.equal(afterSecond.data.keyframes[1].addedBy, "shi");
    assert.match(afterSecond.data.keyframes[1].label, /Z04 · 机位 2/, "没给标签就自动起一个带构件号的名字");

    const third = await command(shi, {
      commandId: "kf-add-3",
      action: "scene.keyframe.add",
      entityId: sceneId,
      expectedRevision: afterSecond.revision,
      payload: { componentId: "Z01", pose: pose(-1) },
    });
    const afterThird = (await third.json()).entity;
    assert.equal(afterThird.data.keyframes[2].id, "KF-Z01-01", "换个构件要从 01 重新数");

    /* ---- ② 帧号同步进 bookmarkIds，检查的「视角书签」由真实数据通过 ---- */
    assert.deepEqual(
      afterThird.data.bookmarkIds.sort(),
      ["KF-Z01-01", "KF-Z04-01", "KF-Z04-02"],
      "打的帧要同步成书签（检查项读的是它）",
    );
    const checked = await command(shi, {
      commandId: "kf-scene-check",
      action: "scene.check",
      entityId: sceneId,
    });
    assert.equal(checked.status, 200);
    const checkedEntity = (await checked.json()).entity;
    const bookmarkItem = checkedEntity.data.checkResult.checks.find((item) => item.key === "bookmarks");
    assert.equal(bookmarkItem.pass, true, "有了关键帧，书签那一条要过");
    assert.match(bookmarkItem.detail, /机位关键帧/, "读数里要说清其中有多少是机位关键帧");
    assert.equal(checkedEntity.data.checkResult.pass, true, "锚点/书签/资源齐了，整体应当通过");

    /* ---- ③ 发布之后再打帧：状态不回退（演示中随手标个机位不该让发布失效）---- */
    const published = await command(shi, {
      commandId: "kf-scene-publish",
      action: "scene.publish",
      entityId: sceneId,
      expectedRevision: checkedEntity.revision,
    });
    assert.equal(published.status, 200);
    const publishedEntity = (await published.json()).entity;
    assert.equal(publishedEntity.data.state, "已发布");

    const afterPublish = await command(shi, {
      commandId: "kf-add-after-publish",
      action: "scene.keyframe.add",
      entityId: sceneId,
      expectedRevision: publishedEntity.revision,
      payload: { componentId: "Z04", pose: pose(1) },
    });
    assert.equal(afterPublish.status, 200);
    const afterPublishEntity = (await afterPublish.json()).entity;
    assert.equal(afterPublishEntity.data.state, "已发布", "打帧不许把发布状态打回去");
    assert.equal(afterPublishEntity.data.checkResult.pass, true, "检查结论也不许被清掉");
    assert.equal(afterPublishEntity.data.keyframes.length, 4);

    /* ---- ⑤ 坏机位当场拒收 ---- */
    /*
     * ⚠ 这里**故意**用"传了 null"和"传了非数字字符串"两种：JSON 里 `NaN` 会变成 `null`，
     * 而 `Number(null)` 是 0 —— 老实现会把它当成"方位角 0°"悄悄存下来，
     * 别人打开场景时镜头停在一个"看起来正常、其实完全不对"的位置。
     */
    const nullPose = await command(shi, {
      commandId: "kf-add-null",
      action: "scene.keyframe.add",
      entityId: sceneId,
      payload: { componentId: "Z04", pose: { azimuth: null, polar: 90, distance: 1, focus: { x: 0, y: 0, z: 0 } } },
    });
    assert.equal(nullPose.status, 422, "漏传的字段（JSON 里是 null）不能当成 0 存下来");
    assert.equal((await nullPose.json()).code, "BAD_POSE");

    const nanPose = await command(shi, {
      commandId: "kf-add-nan",
      action: "scene.keyframe.add",
      entityId: sceneId,
      payload: { componentId: "Z04", pose: { azimuth: "不是数字", polar: 90, distance: 1, focus: { x: 0, y: 0, z: 0 } } },
    });
    assert.equal(nanPose.status, 422, "非数字要 422");
    assert.equal((await nanPose.json()).code, "BAD_POSE");

    const zeroDistance = await command(shi, {
      commandId: "kf-add-zero-distance",
      action: "scene.keyframe.add",
      entityId: sceneId,
      payload: { componentId: "Z04", pose: { azimuth: 0, polar: 90, distance: 0, focus: { x: 0, y: 0, z: 0 } } },
    });
    assert.equal(zeroDistance.status, 422, "距离 0 会让相机落在模型里，也要拒");
    assert.equal((await zeroDistance.json()).code, "BAD_POSE");

    /* ---- ⑥ 删帧：两层都清；删不存在的帧报 404 ---- */
    const removed = await command(shi, {
      commandId: "kf-remove-1",
      action: "scene.keyframe.remove",
      entityId: sceneId,
      payload: { keyframeId: "KF-Z04-02" },
    });
    assert.equal(removed.status, 200);
    const removedEntity = (await removed.json()).entity;
    assert.equal(removedEntity.data.keyframes.length, 3);
    assert.equal(
      removedEntity.data.keyframes.some((item) => item.id === "KF-Z04-02"),
      false,
    );
    assert.equal(removedEntity.data.bookmarkIds.includes("KF-Z04-02"), false, "书签里也要清掉");
    /* 别人打的那一帧不受影响（按 id 删，不会连坐） */
    assert.equal(removedEntity.data.bookmarkIds.includes("KF-Z04-01"), true);

    const missing = await command(shi, {
      commandId: "kf-remove-missing",
      action: "scene.keyframe.remove",
      entityId: sceneId,
      payload: { keyframeId: "KF-Z04-99" },
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "NO_KEYFRAME");

    /* ---- ⑦ 改帧：能改名、能用当前机位覆盖；帧号与书签不动；坏输入照样拒 ---- */
    const renamed = await command(shi, {
      commandId: "kf-rename-1",
      action: "scene.keyframe.update",
      entityId: sceneId,
      expectedRevision: removedEntity.revision,
      payload: { keyframeId: "KF-Z01-01", label: "Z01 柱脚虫道入口" },
    });
    assert.equal(renamed.status, 200, "改名要能成（讲解时要念得出来）");
    const renamedEntity = (await renamed.json()).entity;
    const renamedFrame = renamedEntity.data.keyframes.find((item) => item.id === "KF-Z01-01");
    assert.equal(renamedFrame.label, "Z01 柱脚虫道入口", "标签要真的改了");
    assert.equal(renamedFrame.componentId, "Z01", "改名不许动构件绑定（帧号是按它编的）");
    assert.deepEqual(renamedFrame.pose, pose(-1), "只改名时机位不许被碰");
    assert.equal(renamedFrame.addedBy, "shi", "谁打的帧这条记录不改");
    assert.equal(renamedFrame.updatedBy, "shi", "改的人要记下来（现场会问这帧谁改的）");
    assert.match(String(renamedFrame.updatedAt), /^\d{4}-\d{2}-\d{2}T/, "改的时间要记下来");
    assert.equal(renamedEntity.data.keyframes.length, 3, "改帧不能多出一帧");
    assert.equal(renamedEntity.data.bookmarkIds.includes("KF-Z01-01"), true, "书签不受影响");

    const repointed = await command(rao, {
      commandId: "kf-update-pose",
      action: "scene.keyframe.update",
      entityId: sceneId,
      expectedRevision: renamedEntity.revision,
      payload: { keyframeId: "KF-Z01-01", pose: pose(-2) },
    });
    assert.equal(repointed.status, 200, "换个人也能覆盖机位");
    const repointedEntity = (await repointed.json()).entity;
    const repointedFrame = repointedEntity.data.keyframes.find((item) => item.id === "KF-Z01-01");
    assert.deepEqual(repointedFrame.pose, pose(-2), "机位要换成新的");
    assert.equal(repointedFrame.label, "Z01 柱脚虫道入口", "只换机位时标签不许被清掉");
    assert.equal(repointedFrame.updatedBy, "rao");

    /* 原来的帧号还是原来的（讲稿上的 KF-Z01-01 不会因为改名/覆盖而变） */
    assert.deepEqual(
      repointedEntity.data.keyframes.map((item) => item.id),
      ["KF-Z04-01", "KF-Z01-01", "KF-Z04-03"],
      "改帧不许改帧号，也不许调顺序",
    );

    const badLabel = await command(shi, {
      commandId: "kf-rename-too-long",
      action: "scene.keyframe.update",
      entityId: sceneId,
      expectedRevision: repointedEntity.revision,
      payload: { keyframeId: "KF-Z01-01", label: "很长的名字".repeat(20) },
    });
    assert.equal(badLabel.status, 422, "标签超长要拒（列表一行放不下）");
    assert.equal((await badLabel.json()).code, "BAD_LABEL");

    const badPose = await command(shi, {
      commandId: "kf-update-bad-pose",
      action: "scene.keyframe.update",
      entityId: sceneId,
      expectedRevision: repointedEntity.revision,
      payload: { keyframeId: "KF-Z01-01", pose: { azimuth: null, polar: 90, distance: 1, focus: { x: 0, y: 0, z: 0 } } },
    });
    assert.equal(badPose.status, 422, "覆盖机位时同样不许把 null 当 0 存下来");
    assert.equal((await badPose.json()).code, "BAD_POSE");

    const updateMissing = await command(shi, {
      commandId: "kf-update-missing",
      action: "scene.keyframe.update",
      entityId: sceneId,
      payload: { keyframeId: "KF-Z04-99", label: "不存在的帧" },
    });
    assert.equal(updateMissing.status, 404);
    assert.equal((await updateMissing.json()).code, "NO_KEYFRAME");

  } finally {
    await service.close?.();
  }
});
