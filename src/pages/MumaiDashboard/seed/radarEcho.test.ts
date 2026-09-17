/**
 * 雷达回波与频谱 —— 单测
 *
 * ── 这一组在防什么（用户口径 2026-09-18）──────────────────────────
 * 「数字孪生的雷达回波频谱真实些」。原来那张图是**画出来的波浪线**
 * （三条正弦 + 高斯鼓包，横轴"频点索引"、纵轴"归一化幅值"）——
 * 看着就不像雷达数据，而且没有出处。现在由物理模型生成，所以这里钉住
 * "像不像真的"这件事本身：形状、量纲、衰减、噪声底、频域与时域一致。
 *
 * ⚠ 还有一条**平台规矩**必须一起钉：横轴只能是双程走时（ns）与频率（MHz），
 *   **不许出现深度**（平台明确「未标定距离轴，不写作深度」「不预画虫道深度与形状」）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MATERIAL_ER,
  RADAR_PARAMS,
  RADAR_PARAM_LINE,
  buildEcho,
  buildSpectrum,
  fractionOf,
  ricker,
  ticksFor,
  velocityOf,
} from "../seed/radarEcho.ts";
import { WAVEFORMS, waveformFor } from "../seed/scenario.ts";

const Z04 = buildEcho({
  er: MATERIAL_ER.杉木,
  reflectors: [
    { twoWayNs: 1.6, coefficient: -0.34 },
    { twoWayNs: 6.8, coefficient: 0.22 },
  ],
  seed: 1234,
});

test("时域回波是双极性的：有正有负、直达波最强、后面越来越弱", () => {
  const ys = Z04.points.map((point) => point.y);
  const max = Math.max(...ys);
  const min = Math.min(...ys);
  assert.ok(max > 0 && min < 0, `回波必须有正有负（实测 ${min}…${max}）`);

  /* 直达波在前 1/10 窗口内达到全曲线最大值（天线耦合最先到、最强） */
  const peakIndex = ys.indexOf(max);
  const windowStart = RADAR_PARAMS.samples / 10;
  assert.ok(peakIndex < windowStart, `首个峰值应当出现在最前面（第 ${peakIndex} 点）`);

  /* 目标层反射（6.8 ns）附近应当有一次明显振荡，且幅度小于直达波 */
  const dt = RADAR_PARAMS.windowNs / RADAR_PARAMS.samples;
  const targetIndex = Math.round(6.8 / dt);
  const around = ys.slice(targetIndex - 12, targetIndex + 12);
  const targetPeak = Math.max(...around.map((value) => Math.abs(value)));
  assert.ok(targetPeak > 30, `目标层应当有可辨的反射（实测 ${targetPeak.toFixed(1)} mV）`);
  assert.ok(targetPeak < Math.abs(max), "目标层反射必须弱于直达波（走时衰减）");
});

test("确定性：同一个种子每次得到同一条曲线（现场每次刷新画面都不一样就没法讲）", () => {
  const again = buildEcho({
    er: MATERIAL_ER.杉木,
    reflectors: [
      { twoWayNs: 1.6, coefficient: -0.34 },
      { twoWayNs: 6.8, coefficient: 0.22 },
    ],
    seed: 1234,
  });
  assert.deepEqual(again.points, Z04.points);
  const other = buildEcho({ er: MATERIAL_ER.杉木, reflectors: [{ twoWayNs: 6.8, coefficient: 0.22 }], seed: 999 });
  assert.notDeepEqual(other.points, Z04.points, "换种子必须换噪声（否则同一张图到处复用）");
});

test("Ricker 子波：零均值、双极、峰值在 0、以中心频率为谱峰", () => {
  assert.equal(Number(ricker(0).toFixed(6)), 1, "峰值在 t=0 处为 1");
  /* 负半周在 |t| ≈ 0.45–1.2 ns（500 MHz 天线的子波就这么宽），取 0.9 ns 一定在负瓣里 */
  assert.ok(ricker(0.9) < 0, `两侧必须有负半周（ricker(0.9)=${ricker(0.9).toFixed(3)}）`);
  assert.ok(ricker(-0.9) < 0, "负半周两侧对称");
  /* 零均值：正负面积抵消（GPR 脉冲没有直流分量）。在**对称网格**上求和，
     免得把"窗口截掉一半子波"造成的残留当成"脉冲有直流" */
  let sum = 0;
  const dt = RADAR_PARAMS.windowNs / RADAR_PARAMS.samples;
  for (let k = -200; k <= 200; k += 1) sum += ricker(k * dt);
  assert.ok(Math.abs(sum) < 0.05, `零均值（对称求和实测 ${sum.toFixed(4)}）`);
});

test("频谱：主频落在天线中心频率附近，带宽合理，本底不离谱", () => {
  const spectrum = buildSpectrum(Z04.points);
  assert.ok(
    Math.abs(spectrum.dominantMhz - RADAR_PARAMS.centerMhz) <= 150,
    `主频（能量重心）应当贴近中心频率 ${RADAR_PARAMS.centerMhz} MHz（实测 ${spectrum.dominantMhz} MHz）`,
  );
  assert.ok(
    spectrum.bandwidthMhz > 0.3 * RADAR_PARAMS.centerMhz && spectrum.bandwidthMhz < 1.6 * RADAR_PARAMS.centerMhz,
    `−6 dB 带宽应当在中心频率的 0.3–1.6 倍之间（实测 ${spectrum.bandwidthMhz} MHz）`,
  );
  /*
   * 本底：不能深得像"接收机没有噪声"（−80 dB 那种），也不能高到把主瓣盖住。
   * 参考量级：噪声 ±9 mV 对直达波 1000 mV ≈ −41 dB。
   */
  assert.ok(spectrum.floorDb > -60 && spectrum.floorDb < -20, `本底应当在 −60…−20 dB 之间（实测 ${spectrum.floorDb}）`);
  /* 峰值归一到 0 dB，其余都不高于它 */
  const maxDb = Math.max(...spectrum.points.map((point) => point.y));
  assert.ok(Math.abs(maxDb) < 0.01, "谱峰应当是 0 dB（归一化）");
});

test("时域与频域同源：频谱就是这条回波的 FFT —— 换成纯噪声后主瓣就没了", () => {
  /*
   * ⚠ 不能拿两边的"绝对电平"或"−6 dB 带宽"比：
   *   · 每张谱都归一到自己的峰值（0 dB），噪声谱的"峰值"也是它自己的一根 bin；
   *   · 纯白噪声的谱本来就能占到整段频宽，bandwidth 判不出"有没有主瓣"。
   * 判据用**能量集中度**：主频 ±150 MHz 这个带里占总能量（100–1200 MHz）的比例。
   * 有主瓣时能量集中（实测 0.7 上下），纯噪声摊平（实测 0.3 上下）。
   */
  const energyShare = (spectrum: { points: { x: number; y: number }[]; dominantMhz: number }) => {
    const linear = spectrum.points.map((point) => ({ f: point.x, e: 10 ** (point.y / 10) }));
    const total = linear.filter((item) => item.f >= 100 && item.f <= 1200).reduce((sum, item) => sum + item.e, 0);
    const band = linear
      .filter((item) => Math.abs(item.f - spectrum.dominantMhz) <= 150)
      .reduce((sum, item) => sum + item.e, 0);
    return band / (total || 1);
  };
  const echoSpectrum = buildSpectrum(Z04.points);
  const noiseOnly = buildEcho({ er: MATERIAL_ER.杉木, directMv: 0, reflectors: [], seed: 777 });
  const noiseSpectrum = buildSpectrum(noiseOnly.points);
  const echoShare = energyShare(echoSpectrum);
  const noiseShare = energyShare(noiseSpectrum);
  assert.ok(echoShare > 0.55, `回波的能量应当集中在主瓣附近（实测集中度 ${echoShare.toFixed(2)}）`);
  assert.ok(noiseShare < 0.5, `纯噪声的能量应当摊开（实测集中度 ${noiseShare.toFixed(2)}）`);
  assert.ok(echoShare - noiseShare > 0.2, "两者必须拉得开，判据才有意义");
  /* 回波那条的主频要落在天线的频段里 */
  assert.ok(echoSpectrum.dominantMhz > 300 && echoSpectrum.dominantMhz < 650);
});

test("空输入不许把程序算死（曾经是死循环：分辨率 0 → 分箱数 Infinity）", () => {
  const empty = buildSpectrum([]);
  assert.deepEqual(empty.points, []);
  assert.equal(empty.dominantMhz, 0);
  assert.equal(empty.bandwidthMhz, 0);
});

test("量纲与刻度：横轴只出现 ns 与 MHz，参数行里没有任何长度单位", () => {
  assert.match(RADAR_PARAM_LINE, /中心频率 \d+ MHz/);
  assert.match(RADAR_PARAM_LINE, /等效采样 [\d.]+ GS\/s/);
  assert.match(RADAR_PARAM_LINE, /时窗 \d+ ns/);
  assert.match(RADAR_PARAM_LINE, /不写作深度/);
  /* 平台规矩：不许出现深度/mm/m 这类距离量 */
  assert.equal(/深度\s*[:：]?\s*\d/.test(RADAR_PARAM_LINE), false);
  assert.equal(/\d+\s*(mm|厘米|cm|米|m)\b/.test(RADAR_PARAM_LINE), false);

  const nsTicks = ticksFor(RADAR_PARAMS.windowNs, "ns");
  const mhzTicks = ticksFor(1200, "MHz");
  assert.equal(nsTicks[0].label, "0");
  assert.equal(nsTicks[nsTicks.length - 1].label, `${RADAR_PARAMS.windowNs} ns`);
  assert.equal(mhzTicks[mhzTicks.length - 1].label, "1200 MHz");
});

test("波速：木材里约 0.5–0.6 倍光速（说明为什么纵向分辨率有限，也说明为什么不报深度）", () => {
  for (const er of Object.values(MATERIAL_ER)) {
    const ratio = velocityOf(er) / 299792458;
    assert.ok(ratio > 0.5 && ratio < 0.62, `εr=${er} 时 v/c=${ratio.toFixed(3)} 应当在 0.5–0.62`);
  }
});

test("种子里的每一条曲线都自洽：量纲/刻度/双极性/占比区间", () => {
  assert.ok(WAVEFORMS.length >= 6, `至少要有回波与频谱各若干条（实测 ${WAVEFORMS.length}）`);
  for (const wave of WAVEFORMS) {
    assert.ok(wave.points.length > 100, `${wave.id} 点数太少（${wave.points.length}）`);
    /* x 一律是 0–1 占比；刻度与量程必须一起给 */
    for (const point of wave.points) {
      assert.ok(point.x >= 0 && point.x <= 1, `${wave.id} 的 x=${point.x} 必须在 0–1`);
    }
    assert.ok(wave.xMax && wave.xMax > 0, `${wave.id} 缺少 xMax`);
    assert.ok(wave.xUnit === "ns" || wave.xUnit === "MHz", `${wave.id} 的横轴单位可疑：${wave.xUnit}`);
    assert.ok((wave.xTicks ?? []).length >= 3, `${wave.id} 缺少横轴刻度`);
    assert.match(wave.paramLine ?? "", /中心频率/, `${wave.id} 缺少参数行`);
    if (wave.kind === "echo") {
      assert.equal(wave.bipolar, true, `${wave.id} 是时域回波，必须是双极性`);
      assert.equal(wave.unit, "mV");
      const ys = wave.points.map((point) => point.y);
      assert.ok(Math.min(...ys) < 0 && Math.max(...ys) > 0, `${wave.id} 必须有正有负`);
    } else {
      assert.equal(wave.unit, "dB", `${wave.id} 是频谱，单位应当是 dB`);
      assert.ok(wave.stats && wave.stats.dominantMhz > 0, `${wave.id} 缺少频域派生量`);
      const minDb = Math.min(...wave.points.map((point) => point.y));
      assert.ok(minDb > -90, `${wave.id} 本底掉到 ${minDb} dB，看着不像实测谱`);
    }
    /* 标记点的位置也必须在 0–1 内（否则画到图外） */
    for (const marker of wave.markers) {
      assert.ok(marker.x >= 0 && marker.x <= 1, `${wave.id} 的标记 ${marker.label} 跑到图外`);
    }
  }
  /* 孪生页演示的那个批次必须两块都有（时域 + 频域） */
  const focusKinds = WAVEFORMS.filter((wave) => wave.batchId === "scan-Z04-002").map((wave) => wave.kind).sort();
  assert.deepEqual(focusKinds, ["echo", "spectrum"], "复扫批次要同时给回波与频谱");
});

test("fractionOf：真实值换算成占比时钳在 0–1（标记不会画到图外）", () => {
  assert.equal(fractionOf(6.8, 20), 0.34);
  assert.equal(fractionOf(0, 20), 0);
  assert.equal(fractionOf(20, 20), 1);
  assert.equal(fractionOf(999, 20), 1);
  assert.equal(fractionOf(-5, 20), 0);
  assert.equal(fractionOf(5, 0), 0, "量程为 0 时不许产生 NaN/Infinity");
});

test("waveformFor：取向由调用方声明（讲数据取频谱、看原始波形取回波）", () => {
  /* 同一批次两条曲线，取哪条必须显式说 —— 原来各页面各写一遍 .find()，取到哪条看数组顺序 */
  assert.equal(waveformFor("scan-Z04-002", "spectrum").kind, "spectrum");
  assert.equal(waveformFor("scan-Z04-002", "echo").kind, "echo");
  assert.equal(waveformFor("scan-Z04-002").kind, "spectrum", "缺省取频谱（台词口径）");
  /* 只有频谱的老批次：要回波也退回一条能画的，而不是 undefined */
  assert.equal(waveformFor("env-2026-0911-01", "echo").batchId, "env-2026-0911-01");
  /* 完全不存在的批次：退回全表第一条（与老代码的兜底一致，页面不会空白） */
  assert.ok(waveformFor("no-such-batch", "echo").points.length > 0);
});
