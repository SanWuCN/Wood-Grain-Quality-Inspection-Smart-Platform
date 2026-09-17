/**
 * 雷达回波：时域 A-scan 与它的频谱（纯函数，可单测）
 *
 * ── 这一层在解决什么（用户口径 2026-09-18）──────────────────────────
 * 「数字孪生的雷达回波频谱真实些」。原来那张图是**画出来的波浪线**：
 * `0.16 + 三条正弦 + 几个高斯鼓包`，横轴写"频点索引"、纵轴"归一化幅值" ——
 * 既不像真实回波，也说不清那条曲线是从哪来的。
 *
 * 现在按**探地雷达实际能测到的东西**生成，且两块**同源自洽**：
 *   · 时域：`buildEcho()` 造一条双极性 A-scan —— 直达波（天线耦合，最先、最强）
 *     → 表面反射 → 目标层反射（阻尼子波）→ 层间多次波，叠上白噪声与极小直流漂移；
 *   · 频域：`buildSpectrum()` 对**上面那条回波**做 FFT（加 Hann 窗、补零到 8192 点），
 *     再乘一条介质衰减（高频掉得更快）。所以频谱上的主频与带宽是从回波算出来的，
 *     不是另画一条 —— 讲解时"时域这里一个反射、频域对应这个带"能对得上。
 *
 * ── 口径（与平台既有规矩一致，别越线）────────────────────────────
 *   1. **不写深度、不写 mm**：`xMax`/`xTicks` 只给双程走时（ns）与频率（MHz）。
 *      平台明确「未标定距离轴，不写作深度」「不预画虫道深度与形状」；
 *      代码注释里可以写"6.8 ns 对应约 0.6 m"来交代物理来路，但**界面与台词一个字都不许出现**。
 *   2. **参数是公开量**：中心频率、等效采样率、时窗、材种相对介电常数 —— 都是仪器与材种的说明值，
 *      不是测量结论（`RADAR_PARAM_LINE` 就是给界面那行小字用的）。
 *   3. **确定性**：噪声走 `makePyRandom`（与 deviceLogs 同一套 Python 兼容随机数），
 *      同一个批次每次刷新得到同一条曲线 —— 否则每次打开画面都不一样，没法对照讲。
 */
import { makePyRandom } from "../pyrandom";

/** 光速（m/s）：只在代码注释与波速换算里用，不进界面 */
const C0 = 299792458;

/** 天线与采集参数（等效采样：512 点 / 20 ns 时窗 → 25.6 GS/s） */
export const RADAR_PARAMS = {
  /** 天线中心频率（MHz）——常见 400–900 MHz 屏蔽天线里取中间值 */
  centerMhz: 500,
  /** 时窗（ns，双程走时） */
  windowNs: 20,
  /** 采样点数（2 的幂，便于 FFT） */
  samples: 512,
} as const;

/** 等效采样率（GHz）= 采样点 / 时窗 */
export const RADAR_SAMPLE_RATE_GHZ = RADAR_PARAMS.samples / RADAR_PARAMS.windowNs;

/**
 * 界面那行参数小字。**只写仪器与材种层面的量**，不写任何测量结论、不写深度。
 * 数字全部由常量算出，改参数这里跟着变。
 */
export const RADAR_PARAM_LINE =
  `中心频率 ${RADAR_PARAMS.centerMhz} MHz · 等效采样 ${RADAR_SAMPLE_RATE_GHZ.toFixed(1)} GS/s · ` +
  `时窗 ${RADAR_PARAMS.windowNs} ns · 未标定距离轴（不写作深度）`;

/** 材种相对介电常数（干木材 2–3，受潮升高）→ 波速 v = c/√εr */
export const MATERIAL_ER = {
  杉木: 3.0,
  楠木: 3.4,
  参考件: 3.2,
} as const;

/** 相对介电常数 → 波速（m/s） */
export function velocityOf(er: number): number {
  return C0 / Math.sqrt(er);
}

/**
 * Ricker 子波（GPR 脉冲的常用模型）：`(1 - 2π²f²t²)·e^(−π²f²t²)`。
 * 双极性、零均值、峰值在 t=0，频谱是一个以 f 为中心的钟形 —— 这一条就决定了
 * "时域双极性 ↔ 频域带限"两边天然一致。
 */
export function ricker(tNs: number, f0Mhz = RADAR_PARAMS.centerMhz): number {
  const x = Math.PI * f0Mhz * 1e6 * (tNs * 1e-9);
  const x2 = x * x;
  return (1 - 2 * x2) * Math.exp(-x2);
}

/** 一个反射体：双程走时（ns）、反射系数（相对直达波，负号=极性反转） */
export type Reflector = { twoWayNs: number; coefficient: number; label?: string };

export type EchoSpec = {
  /** 材种相对介电常数（只影响波速/衰减，界面上不出现深度） */
  er: number;
  /** 直达波幅值（mV）：天线耦合，最先到也最强 */
  directMv?: number;
  /** 直达波到达时刻（ns） */
  directNs?: number;
  reflectors: Reflector[];
  /** 噪声幅值（mV，均匀分布 ±noiseMv） */
  noiseMv?: number;
  /** 确定性种子（取批次号的哈希） */
  seed: number;
};

export type EchoResult = {
  /** x = 双程走时（ns），y = 幅值（mV，双极性） */
  points: { x: number; y: number }[];
  /** 直达波幅值（mV） */
  directMv: number;
  /** 全曲线绝对值最大（mV） */
  peakMv: number;
  /** 最强反射体的双程走时（ns） */
  targetNs: number;
  /** 波速（m/s，由 εr 算出；只在文档/台词里作为"标定依据"提一句，不进深度换算） */
  velocity: number;
};

/** 衰减时间常数（ns）：木材这种有耗介质，越晚的反射越弱 */
const DECAY_NS = 9;

/**
 * 造一条时域回波（A-scan）。
 *
 * 每条反射用"子波 × 反射系数 × 走时衰减"叠加，再叠直达波、白噪声与极小直流漂移。
 * 输出 `points[].x` 是**双程走时 ns**（不是 0–1 占比）—— 这一层交给图表承担刻度。
 */
export function buildEcho(spec: EchoSpec): EchoResult {
  const dt = RADAR_PARAMS.windowNs / RADAR_PARAMS.samples;
  const directMv = spec.directMv ?? 1000;
  /*
   * 直达波放在 1.2 ns：**必须整条子波都在窗口里**。
   * 放得太靠前（0.5 ns）时，子波的前半个负瓣被窗口截掉，剩下的波形带着很大的
   * 低频不对称 —— 频谱会是一根贴着 0 Hz 的大鼓包，主频看着只有几 MHz（实测踩过）。
   * 真实设备也是把时零设在直达波之前一点，为的就是拿到完整的子波。
   */
  const directNs = spec.directNs ?? 1.2;
  const noiseMv = spec.noiseMv ?? 9;
  const rng = makePyRandom(spec.seed);
  const points: { x: number; y: number }[] = [];
  let peakMv = 0;
  for (let i = 0; i < RADAR_PARAMS.samples; i += 1) {
    const t = i * dt;
    /* 直达波（天线耦合）：最先到、最强，后续表面的第一次反射常与它连在一起 */
    let mv = directMv * ricker(t - directNs);
    for (const reflector of spec.reflectors) {
      /* 走时衰减：同一反射体的能量随双程走时指数下降（有耗介质） */
      const decay = Math.exp(-reflector.twoWayNs / DECAY_NS);
      mv += directMv * reflector.coefficient * decay * ricker(t - reflector.twoWayNs);
    }
    /* 白噪声 ±noiseMv + 极小直流漂移（真实采集卡的基线不会正好是 0） */
    mv += (rng.random() * 2 - 1) * noiseMv;
    mv += 1.2 * Math.sin((t / RADAR_PARAMS.windowNs) * Math.PI);
    const y = Number(mv.toFixed(2));
    peakMv = Math.max(peakMv, Math.abs(y));
    points.push({ x: Number(t.toFixed(4)), y });
  }
  const strongest = [...spec.reflectors].sort(
    (a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient),
  )[0];
  return {
    points,
    directMv,
    peakMv: Number(peakMv.toFixed(1)),
    targetNs: strongest?.twoWayNs ?? directNs,
    velocity: velocityOf(spec.er),
  };
}

export type SpectrumResult = {
  /** x = 频率（MHz），y = 幅值（dB，峰值 0 dB） */
  points: { x: number; y: number }[];
  /** 主频（MHz）＝谱的**能量重心**，与天线标称中心频率可比（见 buildSpectrum 的说明） */
  dominantMhz: number;
  /** 谱峰所在的 bin（保留作参考：它会被时窗展宽与材质衰减推来推去） */
  peakMhz?: number;
  /** −6 dB 带宽（MHz） */
  bandwidthMhz: number;
  /** 本底噪声（dB，取高频段的平均值） */
  floorDb: number;
};

/** 频谱显示到多高（MHz）：再往上只有噪声，画出来只会压扁主瓣 */
const SPECTRUM_MAX_MHZ = 1200;
/** 补零点数：512 点补到 8192，频率分辨率 3.125 MHz，曲线才不发折线 */
const FFT_SIZE = 8192;

/**
 * 对时域回波做 FFT，得到频谱（dB）。
 *
 * 步骤与真实处理链一致：**去均值 → 加 Hann 窗 → 补零 → FFT → 取模 → 归一化到峰值 0 dB
 * → 乘介质衰减（高频衰减更快）→ 截到 1200 MHz**。
 * 去均值与加窗是必须的：不去均值，直流与低频会顶出一个假的"主频"。
 */
export function buildSpectrum(
  points: { x: number; y: number }[],
  options: { attenuatePerGhz?: number; floorDb?: number; lowCutMhz?: number; floorSeed?: number } = {},
): SpectrumResult {
  const n = points.length;
  /*
   * ⚠ 空输入必须挡住：`dt = 窗口/0 = Infinity` 会让下面的频率分辨率变成 0、
   * 分箱数变成 Infinity —— 一个死循环把浏览器/Node 直接吃爆内存（实测踩过）。
   * 空数据返回一条"没有信号"的平坦谱，调用方按空态处理。
   */
  if (n < 2) {
    return { points: [], dominantMhz: 0, bandwidthMhz: 0, floorDb: options.floorDb ?? -46 };
  }
  const samples = points.map((point) => point.y);
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, n);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < n; i += 1) {
    /* Hann 窗：抑制截断带来的旁瓣，真实频谱仪也是这么做的 */
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = (samples[i] - mean) * w;
  }
  fft(re, im);

  const dt = RADAR_PARAMS.windowNs / n;
  const fsGhz = 1 / dt; // GHz（dt 单位 ns）
  const binMhz = (fsGhz * 1000) / FFT_SIZE;
  const bins = Math.floor(SPECTRUM_MAX_MHZ / binMhz);
  /*
   * 介质衰减 2 dB/GHz：木材对高频的衰减比空气明显，谱峰会略向低频偏几十一百 MHz ——
   * 这就是真实谱的形状。给大了（6 dB/GHz 试过）主峰会掉到中心频率的六成，
   * 和面板上"中心频率 500 MHz"那行小字自相矛盾。
   */
  const attenuatePerGhz = options.attenuatePerGhz ?? 2;
  const floorDb = options.floorDb ?? -46;
  /*
   * 低切（一阶高通，120 MHz）：真实雷达链路上必做的一步 ——
   * 收发耦合与天线感应会在 0–50 MHz 堆一大坨低频，不去掉的话谱峰会落在几 MHz 上，
   * 看起来"主频只有几 MHz"，跟 500 MHz 天线的说法自相矛盾。这一步是**处理**，
   * 不是"把数据修好看"：GPR 处理链里就叫背景去除 / 低切。
   */
  const lowCutMhz = options.lowCutMhz ?? 80;
  const mags: { mhz: number; mag: number }[] = [];
  for (let k = 1; k <= bins; k += 1) {
    const mhz = k * binMhz;
    const attenuation = Math.exp((-attenuatePerGhz * mhz) / 1000);
    const highPass = (mhz * mhz) / (mhz * mhz + lowCutMhz * lowCutMhz);
    mags.push({ mhz: Number(mhz.toFixed(1)), mag: Math.hypot(re[k], im[k]) * attenuation * highPass });
  }
  const peak = mags.reduce((best, item) => Math.max(best, item.mag), 0) || 1;
  /*
   * 本底噪声：真实频谱不会掉到 −100 dB 那种"干净"的样子，接收机本底就在那儿。
   *
   * ⚠ 起伏必须**逐 bin 随机**，不能拿几条正弦叠（第一版就是这么写的）：
   *   正弦叠出来是一条平滑的带，看着像"信号"而不像本底，还会把谱底压成一段平台
   *   （实测纯噪声那条谱的 −6 dB 带宽被抬到 594 MHz，完全不像噪声）。
   *   真实本底是逐点随机起落的，所以这里用同一套确定性随机数（同种子同结果）。
   */
  const floorRng = makePyRandom(options.floorSeed ?? 20260918);
  const pointsDb = mags.map((item) => {
    const raw = 20 * Math.log10(Math.max(item.mag / peak, 1e-6));
    const ripple = (floorRng.random() * 2 - 1) * 5;
    return { x: item.mhz, y: Number(Math.max(raw, floorDb + ripple).toFixed(2)) };
  });
  const dominant = mags.reduce((best, item) => (item.mag > best.mag ? item : best), mags[0]);
  /*
   * 「主频」取**能量重心**（谱的重心频率），不是谱峰那一根 bin。
   *
   * 为什么：高斯泼溅……不，是雷达脉冲的谱本身就**很宽**（GPR 的 Q 值低，
   * 一个 500 MHz 天线的 −6 dB 带宽常有 300–500 MHz），谱顶是一段平台；
   * 再叠上 20 ns 时窗的 Hann 窗展宽，argmax 落在哪一根 bin 上带偶然性
   * （实测同一支天线跑出过 319 / 459 MHz 两个"谱峰"，而重心稳定在 450 上下）。
   * 天线参数的意义本来就是"能量集中在哪个频段"，重心才对应得上。
   */
  const centroid = mags.reduce((sum, item) => sum + item.mhz * item.mag * item.mag, 0) /
    (mags.reduce((sum, item) => sum + item.mag * item.mag, 0) || 1);
  /* −6 dB 带宽：谱峰两侧第一次跌到 −6 dB 的位置之差 */
  const half = peak * 0.5;
  const above = mags.filter((item) => item.mag >= half);
  const bandwidth = above.length > 1 ? above[above.length - 1].mhz - above[0].mhz : 0;
  const tail = pointsDb.slice(-40);
  const floorAverage = Number((tail.reduce((sum, item) => sum + item.y, 0) / Math.max(1, tail.length)).toFixed(1));
  return {
    points: pointsDb,
    dominantMhz: Number(centroid.toFixed(0)),
    peakMhz: Number(dominant.mhz.toFixed(0)),
    bandwidthMhz: Number(bandwidth.toFixed(0)),
    floorDb: floorAverage,
  };
}

/**
 * 原地 radix-2 迭代 FFT（长度必须是 2 的幂）。
 *
 * 为什么自己写而不是引库：只需要这 30 行，纯函数好单测；引一个 FFT 依赖只为画一张种子数据图
 * 不划算（本仓库「不为几行代码加依赖」的一贯口径）。
 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * 横轴刻度（0–1 占比 + 真实单位文本）。
 *
 * 图表的 x 一律是 0–1 的占比（这样"人工标记"等功能不用改坐标口径），
 * 真实单位只体现在刻度文本上 —— 于是 `xMax`/`xUnit` 与刻度必须一起给。
 */
export function ticksFor(xMax: number, xUnit: string, count = 5): { at: number; label: string }[] {
  const out: { at: number; label: string }[] = [];
  for (let i = 0; i <= count; i += 1) {
    const at = i / count;
    const value = xMax * at;
    const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
    out.push({ at, label: i === count ? `${text} ${xUnit}` : text });
  }
  return out;
}

/** 把真实值换算成 0–1 占比（写数据、放标记都用它，避免各写一遍除法） */
export function fractionOf(value: number, xMax: number): number {
  const f = xMax > 0 ? value / xMax : 0;
  return Number(Math.min(1, Math.max(0, f)).toFixed(4));
}
