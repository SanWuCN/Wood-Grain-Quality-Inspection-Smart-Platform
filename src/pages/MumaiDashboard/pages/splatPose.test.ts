/**
 * 数字孪生 · 机位关键帧的位姿换算 —— 单测
 *
 * ── 这一组在防什么 ────────────────────────────────────────────────
 * "打关键帧 → 回到那一帧"要求位姿换算**往返一致**：角度口径或符号错一点，
 * 镜头就飞到模型另一侧，而页面不报错、只是"看起来不对"，现场根本查不出来。
 * 所以这里把口径钉住：
 *   · 与 `SplatCameraRig` 同一套公式（x = fx + d·sinφ·sinθ，y = fy + d·cosφ，
 *     z = fz + d·sinφ·cosθ；φ=极角从 +Y 量、θ=方位角从 +Z 向 +X 量）；
 *   · 打帧 → 回帧必须回到原来的位置与朝向；
 *   · 边界（正上/正下、零向量、坏数据）不许产生 NaN。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KEYFRAME_LABEL_MAX,
  keyframeTimeText,
  nextTourIndex,
  normalizeKeyframeLabel,
  lookAheadFor,
  parsePose,
  poseFromView,
  posePositionText,
  poseReadout,
  poseToCamera,
  poseToPosition,
  readKeyframes,
  type CameraView,
} from "./splatPose.ts";

/** 单位朝向：由方位角/极角描述的"看向的方向"（与实现同一套口径） */
const forwardOf = (azimuthDeg: number, polarDeg: number) => {
  /* 相机在 focus + d·(sinφsinθ, cosφ, sinφcosθ)，那么朝向就是 -(那个单位向量) */
  const phi = (polarDeg * Math.PI) / 180;
  const theta = (azimuthDeg * Math.PI) / 180;
  return {
    x: -Math.sin(phi) * Math.sin(theta),
    y: -Math.cos(phi),
    z: -Math.sin(phi) * Math.cos(theta),
  };
};

test("往返一致：从机位算出的视角，能还原回同一个机位", () => {
  const cases: [number, number][] = [
    [0, 90],
    [32, 88],
    [-135, 95],
    [180, 60],
    [270, 120],
  ];
  for (const [azimuth, polar] of cases) {
    const forward = forwardOf(azimuth, polar);
    const distance = 2.4;
    const position = { x: 1.5, y: 0.8, z: -3.2 };
    const pose = poseFromView({ position, forward }, distance);

    /* 1) 角度与距离对得上（浮点比较留 1e-3 的余量） */
    assert.ok(Math.abs(pose.distance - distance) < 1e-3, `距离 ${pose.distance}`);
    assert.ok(
      Math.abs(((pose.azimuth - azimuth + 540) % 360) - 180) < 1e-2,
      `方位角 ${pose.azimuth} 应当等于 ${azimuth}`,
    );
    assert.ok(Math.abs(pose.polar - polar) < 1e-2, `极角 ${pose.polar} 应当等于 ${polar}`);

    /* 2) focus = 相机位置 + 朝向 × 距离（这是"看向的点"的定义） */
    assert.ok(Math.abs(pose.focus.x - (position.x + forward.x * distance)) < 1e-3);
    assert.ok(Math.abs(pose.focus.y - (position.y + forward.y * distance)) < 1e-3);
    assert.ok(Math.abs(pose.focus.z - (position.z + forward.z * distance)) < 1e-3);

    /* 3) 由机位反算出的镜头位置 = 原来的相机位置（回放动画的终点） */
    const back = poseToPosition(pose);
    assert.ok(Math.abs(back.x - position.x) < 1e-2, `x ${back.x} vs ${position.x}`);
    assert.ok(Math.abs(back.y - position.y) < 1e-2, `y ${back.y} vs ${position.y}`);
    assert.ok(Math.abs(back.z - position.z) < 1e-2, `z ${back.z} vs ${position.z}`);
  }
});

test("朝向会被归一化：非单位向量不影响结果", () => {
  const forward = forwardOf(45, 90);
  const scaled: CameraView = {
    position: { x: 0, y: 0, z: 0 },
    forward: { x: forward.x * 12, y: forward.y * 12, z: forward.z * 12 },
  };
  const a = poseFromView({ position: { x: 0, y: 0, z: 0 }, forward }, 3);
  const b = poseFromView(scaled, 3);
  assert.deepEqual(b, a);
});

test("正上方 / 正下方不会算出 NaN，极角被留出 2° 余量", () => {
  const up = poseFromView({ position: { x: 0, y: 1, z: 0 }, forward: { x: 0, y: 1, z: 0 } }, 2);
  const down = poseFromView({ position: { x: 0, y: 1, z: 0 }, forward: { x: 0, y: -1, z: 0 } }, 2);
  for (const pose of [up, down]) {
    assert.ok(Number.isFinite(pose.azimuth), "方位角必须是有限数字");
    assert.ok(Number.isFinite(pose.polar));
    assert.ok(pose.polar >= 2 && pose.polar <= 178, `极角 ${pose.polar} 应当在 2–178 之间`);
  }
  assert.equal(up.polar, 178, "看向正上方 → 相机在下方，极角应当贴到 178°");
  assert.equal(down.polar, 2, "看向正下方 → 相机在上方，极角应当贴到 2°");
});

test("退化朝向（零向量）按 -Z 处理，不抛错、不出 NaN", () => {
  const pose = poseFromView({ position: { x: 2, y: 3, z: 4 }, forward: { x: 0, y: 0, z: 0 } }, 1);
  assert.ok(Number.isFinite(pose.azimuth) && Number.isFinite(pose.polar));
  /* 朝向 -Z：focus 落在 z 更小的一侧，方位角 0 */
  assert.equal(pose.azimuth, 0);
  assert.equal(pose.focus.z, 3);
});

test("看前方的距离有上下限：太近会把点放进相机里，太远插值没方向感", () => {
  assert.equal(lookAheadFor(null), 1, "量不出尺度时给 1 m");
  assert.equal(lookAheadFor(0), 1);
  assert.equal(lookAheadFor(-3), 1);
  assert.equal(lookAheadFor(NaN), 1);
  assert.equal(lookAheadFor(0.1), 0.4, "太小 → 抬到下限");
  assert.equal(lookAheadFor(50), 6, "太大 → 压到上限");
  assert.equal(lookAheadFor(3), 1.8, "常用区间按 0.6 倍走");
});

test("坏机位一律拒收（NaN / 距离非正 / 缺 focus / 漏字段的 null）", () => {
  assert.equal(parsePose(null), null);
  assert.equal(parsePose({}), null);
  assert.equal(parsePose({ azimuth: 1, polar: 2, distance: 0, focus: { x: 0, y: 0, z: 0 } }), null, "距离 0 会让相机落在模型里");
  assert.equal(parsePose({ azimuth: NaN, polar: 2, distance: 3, focus: { x: 0, y: 0, z: 0 } }), null);
  assert.equal(parsePose({ azimuth: 1, polar: 2, distance: 3 }), null, "缺 focus");
  assert.equal(parsePose({ azimuth: 1, polar: 2, distance: 3, focus: { x: 0, y: 0 } }), null);
  /*
    ⚠ 漏字段的 `null` 也必须拒：`Number(null)` 是 0，放过去会变成"方位角 0°"这种
    看起来完全合法的机位 —— 现场点一下就飞到完全不对的方向。服务端有同一条口径。
  */
  assert.equal(parsePose({ azimuth: null, polar: 2, distance: 3, focus: { x: 0, y: 0, z: 0 } }), null);
  assert.equal(parsePose({ azimuth: 1, polar: 2, distance: 3, focus: { x: null, y: 0, z: 0 } }), null);
  assert.equal(parsePose({ azimuth: "", polar: 2, distance: 3, focus: { x: 0, y: 0, z: 0 } }), null);
  const ok = parsePose({ azimuth: 1, polar: 2, distance: 3, focus: { x: 0, y: 1, z: 2 } });
  assert.deepEqual(ok, { azimuth: 1, polar: 2, distance: 3, focus: { x: 0, y: 1, z: 2 } });
});

test("服务端那串 keyframes：坏帧丢掉，好帧照收（老库/手改都不至于把页面打崩）", () => {
  const frames = readKeyframes({
    keyframes: [
      { id: "KF-Z04-01", componentId: "Z04", label: "Z04 · 机位 1", pose: { azimuth: 10, polar: 88, distance: 1.4, focus: { x: 0, y: 1, z: 2 } }, addedBy: "shi", addedAt: "2026-09-17T13:03:00.000Z" },
      { id: "KF-Z04-02", componentId: "Z04", label: "坏帧", pose: { azimuth: "x", polar: 88, distance: 1.4, focus: { x: 0, y: 1, z: 2 } } },
      { id: "", pose: { azimuth: 1, polar: 88, distance: 1.4, focus: { x: 0, y: 1, z: 2 } } },
      "不是对象",
    ],
  });
  assert.equal(frames.length, 1, "只留合法的那一帧");
  assert.equal(frames[0].id, "KF-Z04-01");
  assert.equal(frames[0].pose.distance, 1.4);
  assert.equal(readKeyframes(null).length, 0);
  assert.equal(readKeyframes({ keyframes: "nope" }).length, 0);
});

test("回放入参会把角度钳到安全范围（不会把镜头转到正上/正下的退化点）", () => {
  const camera = poseToCamera({ azimuth: 720, polar: 0, distance: 0, focus: { x: 1, y: 2, z: 3 } });
  assert.equal(camera.azimuth, 360);
  assert.equal(camera.polar, 2);
  assert.equal(camera.distance, 0.02);
  assert.deepEqual(camera.focus, { x: 1, y: 2, z: 3 });
});

test("帧上的时间与读数：解析不了就写占位符，不显示 NaN", () => {
  assert.equal(keyframeTimeText("not-a-date"), "—");
  assert.match(keyframeTimeText("2026-09-17T13:03:00.000Z"), /^\d{2}:\d{2}$/);
  assert.equal(
    poseReadout({ azimuth: 32.4, polar: 87.6, distance: 2.44, focus: { x: 0, y: 0, z: 0 } }),
    "方位 32° · 仰角 88° · 2.4 m",
  );
});

test("位置读数：平移看得见（只报方位/仰角/距离的话，走一段路读数一点不变）", () => {
  /* 同一个朝向、同一个距离，只是位置不同 → 读数必须不同，这正是"回到那一帧"的判据 */
  const near = poseFromView({ position: { x: 0, y: 1, z: 5 }, forward: { x: 0, y: 0, z: -1 } }, 2);
  const far = poseFromView({ position: { x: 0, y: 1, z: 9 }, forward: { x: 0, y: 0, z: -1 } }, 2);
  assert.equal(poseReadout(near), poseReadout(far), "朝向与距离一样，角度读数本来就该一样");
  assert.notEqual(posePositionText(near), posePositionText(far), "位置读数必须区分开");
  assert.equal(posePositionText(near), "位置 0.0, 1.0, 5.0");
});

test("改名：去掉首尾与多余空白、按 40 字截断，全空白视为取消", () => {
  assert.equal(normalizeKeyframeLabel("  柱脚虫道入口  "), "柱脚虫道入口");
  assert.equal(normalizeKeyframeLabel("柱脚\n\t 虫道   入口"), "柱脚 虫道 入口", "换行/制表/多空格都并成一个空格");
  assert.equal(normalizeKeyframeLabel("   "), null, "全是空白 = 取消，不提交（空名字在列表里没法念）");
  assert.equal(normalizeKeyframeLabel(""), null);
  assert.equal(normalizeKeyframeLabel("名".repeat(60))?.length, KEYFRAME_LABEL_MAX, "超长截断，与服务端 40 字上限一致");
});

test("巡场步进：一帧一帧往下走，到头停下（不绕回第 1 帧）", () => {
  assert.equal(nextTourIndex(0, 3, 1), 1);
  assert.equal(nextTourIndex(1, 3, 1), 2);
  assert.equal(nextTourIndex(2, 3, 1), null, "最后一帧再往下 = 结束（台上绕回会让人以为讲完了又从头开始）");
  assert.equal(nextTourIndex(0, 3, -1), 0, "第一帧往前夹回第 0 帧，不越界");
  assert.equal(nextTourIndex(2, 3, 1, true), 0, "需要循环时（wrap）才绕回");
  assert.equal(nextTourIndex(0, 0, 1), null, "没有帧就没有巡场");
});

test("读帧：带上「改于谁、什么时候」，老数据没有这两个字段也不影响", () => {
  const pose = { azimuth: 10, polar: 90, distance: 2, focus: { x: 0, y: 0, z: 0 } };
  const frames = readKeyframes({
    keyframes: [
      { id: "KF-Z04-01", componentId: "Z04", label: "柱脚", pose, addedBy: "shi", addedAt: "2026-09-22T02:00:00.000Z", updatedBy: "rao", updatedAt: "2026-09-22T02:05:00.000Z" },
      { id: "KF-Z04-02", componentId: "Z04", label: "旧帧", pose, addedBy: "shi", addedAt: "2026-09-22T02:00:00.000Z" },
    ],
  });
  assert.equal(frames[0].updatedBy, "rao");
  assert.equal(frames[1].updatedBy, undefined, "没改过的帧不会凭空多出「改于」");
});

test("读帧的配图：有图才带字段，空串 / 缺字段 / 非字符串都按「无图」处理（老帧不该显示一个裂图）", () => {
  const pose = { azimuth: 10, polar: 90, distance: 2, focus: { x: 0, y: 0, z: 0 } };
  const frames = readKeyframes({
    keyframes: [
      { id: "KF-Z01-01", componentId: "Z01", label: "有图", pose, addedBy: "shi", addedAt: "2026-09-18T03:00:00.000Z", imageFileId: "file-abc", imageName: "KF-Z01-01.jpg" },
      { id: "KF-Z01-02", componentId: "Z01", label: "截图失败", pose, addedBy: "shi", addedAt: "2026-09-18T03:01:00.000Z", imageFileId: "", imageName: "" },
      { id: "KF-Z01-03", componentId: "Z01", label: "老帧", pose, addedBy: "shi", addedAt: "2026-09-17T03:01:00.000Z" },
      { id: "KF-Z01-04", componentId: "Z01", label: "半个字段", pose, addedBy: "shi", addedAt: "2026-09-18T03:02:00.000Z", imageFileId: "file-def" },
    ],
  });
  assert.equal(frames.length, 4);
  assert.equal(frames[0].imageFileId, "file-abc");
  assert.equal(frames[0].imageName, "KF-Z01-01.jpg");
  assert.equal(frames[1].imageFileId, undefined, "空串 = 没有图");
  assert.equal(frames[2].imageFileId, undefined, "老帧没有这个字段");
  assert.equal(frames[3].imageName, "KF-Z01-04.jpg", "只有 id 没有名字时兜一个带扩展名的默认名（地址里要靠它给 content-type）");
});
