/**
 * 两个终端演示脚本的前端移植。
 *
 * 来源（用户提供，逐行对照移植）：
 *   · terminal_train_log.py  —— 模型训练流水（EFCW-YOLO + RadarNet 联合训练）
 *   · terminal_distill.py    —— 知识蒸馏 + INT8 量化 + TensorRT + 封装归档
 *
 * ⚠️ 这两个脚本本身就是**终端演示脚本**（distill 的 docstring 第一行就是
 * `Simulates:`），打印的是模拟日志，不是真实训练。平台这边同样按演示对待：
 * 任务选择器上标「演示脚本」，来源标识沿用「演示记录」。
 * PRD 11.2 说的「训练状态结束只代表演示产物已装载」在这里同样适用。
 *
 * 三条实现约束：
 *   1. **随机数调用顺序必须与 Python 一致**，否则 loss / mAP / 显存会和脚本打印的
 *      对不上。脚本里 `_animate_bar` 每画一帧都要一次 `random.uniform`（取 it/s），
 *      所以进度条的每一帧都是随机数消费者 —— 帧数写错，后面所有数字就全偏了。
 *      已用 `--epochs 3` 跑 Python 取基准，逐值比对通过。
 *   2. 所有帧**预先算好**再交给播放器（`buildSteps` 是纯函数），
 *      播放过程不再碰随机数 —— 否则暂停 / 重播会让序列错位。
 *   3. `\r` 原地刷新的行用 `replace: true` 标记，由控制台覆盖上一行而不是新增。
 */

import { makePyRandom, pyRound } from "../pyrandom";

/** 控制台一行 */
export type TerminalStep = {
  /** 这一帧的完整文本（进度条已渲染成 █░ 块字符，保持终端观感） */
  text: string;
  level: "CMD" | "INFO" | "WARN" | "ERROR" | "OK";
  /** true = 覆盖上一行（脚本里用 `\r` 原地刷新的进度条帧） */
  replace?: boolean;
  /** 这一帧停留多久（毫秒） */
  dwellMs: number;
};

export type TerminalScript = {
  key: string;
  /** 任务名，控制台选择器上用 */
  label: string;
  /** 脚本文件名，控制台标题上显示，方便对着终端核对 */
  command: string;
  /** 这个任务干什么，一句话 */
  summary: string;
  steps: TerminalStep[];
  /** 总时长（毫秒），用于进度显示 */
  totalMs: number;
};

const BLUE = "█";
const EMPTY = "░";

/** terminal_*.py 的 _bar()：filled = round(width * done / total) */
function bar(done: number, total: number, width = 20): string {
  const filled = pyRound((width * done) / Math.max(total, 1));
  return BLUE.repeat(filled) + EMPTY.repeat(width - filled);
}

/** 把一串「打印一行」的语句收成步骤：脚本里每行后 sleep(pause) */
function lines(texts: string[], pauseMs: number): TerminalStep[] {
  return texts.map((text) => ({ text, level: classify(text), dwellMs: pauseMs }));
}

/**
 * 分级。脚本只有 ANSI 颜色没有级别，这里按前缀与关键词归类，
 * 让控制台能用颜色把告警挑出来（终端里靠 ANSI 颜色做到同一件事）。
 */
function classify(text: string): TerminalStep["level"] {
  const t = text.trim();
  if (t.startsWith("(.venv)") || t.startsWith("python ")) return "CMD";
  if (/WARN|ELEVATED|threshold|not in standard DB|激活/i.test(t)) return "WARN";
  if (/ERROR|FAIL|Traceback/i.test(t)) return "ERROR";
  if (/Training complete|Complete\b|PASSED|RESULT/.test(t)) return "OK";
  return "INFO";
}

/* ------------------------------------------------------------------ *
 * ① terminal_train_log.py
 * ------------------------------------------------------------------ */

export type TrainScriptConfig = {
  epochs: number;
  lr: number;
  minLr: number;
  batchSize: number;
  imgSize: number;
  workers: number;
  device: string;
  project: string;
  name: string;
  datasetPath: string;
  weightsPath: string;
  radarWeightsPath: string;
  trainSteps: number;
  evalSteps: number;
};

export const TRAIN_DEFAULTS: TrainScriptConfig = {
  epochs: 16,
  lr: 8.8e-4,
  minLr: 4.2e-5,
  batchSize: 256,
  imgSize: 720,
  workers: 8,
  device: "cuda:0",
  project: "runs\\mumai",
  name: "old-fir-retrain",
  datasetPath: ".\\datasets\\pillar_v2",
  weightsPath: ".\\checkpoints\\efcw_yolo_v3.5.pt",
  radarWeightsPath: ".\\checkpoints\\radarnet_v2.4.pt",
  trainSteps: 2000,
  evalSteps: 250,
};

/**
 * 播放节奏。
 *
 * 脚本的默认单轮时长是 10 秒、16 轮 = 160 秒，完整跑一遍太长；
 * 这里按「整个任务 ~70 秒」压缩（脚本自己也有 `--duration` 参数做同一件事）。
 * 各阶段的比例照搬脚本的 `pre_budget = target * 0.25` 与
 * `t_training = target * 0.75`。
 */
const TRAIN_TOTAL_MS = 70_000;

function buildFakeCommand(cfg: TrainScriptConfig): string {
  return (
    `python .\\backend\\trainers\\train_multimodal_retrain.py ` +
    `--data ${cfg.datasetPath} ` +
    `--weights ${cfg.weightsPath} ` +
    `--radar-weights ${cfg.radarWeightsPath} ` +
    `--device ${cfg.device} --epochs ${cfg.epochs} --batch-size ${cfg.batchSize} ` +
    `--img-size ${cfg.imgSize} --workers ${cfg.workers} ` +
    `--lr ${cfg.lr.toFixed(6)} --min-lr ${cfg.minLr.toFixed(6)} ` +
    `--amp --cache ram --project ${cfg.project} --name ${cfg.name}`
  );
}

/** 脚本的 _lr_for_epoch：余弦式退火，指数 1.35 */
function lrForEpoch(epoch: number, lr: number, minLr: number, epochs: number): number {
  const progress = (epoch - 1) / Math.max(epochs - 1, 1);
  return minLr + (lr - minLr) * (1.0 - progress) ** 1.35;
}

export function buildTrainScript(cfg: TrainScriptConfig = TRAIN_DEFAULTS): TerminalScript {
  const rand = makePyRandom(3407);
  const steps: TerminalStep[] = [];

  const preBudget = TRAIN_TOTAL_MS * 0.25;
  const pauseInit = Math.min(150, Math.max(10, (preBudget * 0.4) / 10));
  const pauseSpecies = Math.min(120, Math.max(10, (preBudget * 0.3) / 18));
  const pauseState = Math.min(100, Math.max(10, (preBudget * 0.2) / 16));
  const pauseAdamw = Math.min(100, Math.max(10, (preBudget * 0.1) / 8));
  const trainingMs = TRAIN_TOTAL_MS * 0.75;

  /* -- phase_init：无随机数 -- */
  steps.push(...lines(
    [
      `(.venv) PS D:\\mumai> ${buildFakeCommand(cfg)}`,
      `launch: amp=True ema=True seed=3407`,
      `Device: ${cfg.device} | CUDA Graph Capture: off | Deterministic: False`,
      `Dataset path: ${cfg.datasetPath}`,
      `Dataset: pos_ratio~=0.5020 | samples=${cfg.trainSteps} | val=${cfg.evalSteps}`,
      "Model: EFCW-YOLO v3.6 + RadarNet v3.0 + LiDARAlign v1.5",
      `Loading backbone weights: ${cfg.weightsPath}`,
      `Loading radar weights:    ${cfg.radarWeightsPath}`,
      "Frozen layers: 0-7 (3.01 M params) | Trainable: neck + head (1.23 M params)",
      `First batch device: ${cfg.device}  shape=(${cfg.batchSize}, 14, ${cfg.imgSize})`,
    ],
    pauseInit,
  ));

  /* -- phase_species：无随机数 -- */
  steps.push({ text: "species: running YOLO inference on reference frames  conf=0.25  iou=0.45  img_size=640", level: "INFO", dwellMs: pauseSpecies * 0.8 });
  const detections: [string, string][] = [
    ["frame_0041.jpg", "crack:0.943  knot:0.881  resin_pocket:0.762"],
    ["frame_0042.jpg", "wood_borer:0.914  moisture_stain:0.758"],
    ["frame_0045.jpg", "crack:0.826  scab:0.791"],
    ["frame_0048.jpg", "rot:0.963  crack:0.852  knot:0.741"],
    ["frame_0051.jpg", "(clean)"],
    ["frame_0053.jpg", "crack:0.887  moisture_stain:0.801"],
  ];
  for (const [fname, det] of detections) {
    steps.push({ text: `  -> ${fname.padEnd(18)}  ${det}`, level: "INFO", dwellMs: pauseSpecies * 0.55 });
  }
  steps.push({ text: "species: YOLO complete  avg_conf=0.8871  throughput=41 img/s  latency=22 ms/frame", level: "OK", dwellMs: pauseSpecies * 0.6 });
  steps.push({ text: "species: CNN-1D micro-texture extraction", level: "INFO", dwellMs: pauseSpecies * 0.3 });
  const features: [string, number][] = [
    ["grain_density", 0.6981],
    ["pore_distribution", 0.5803],
    ["resin_canal_ratio", 0.2614],
    ["tracheid_width_avg", 0.5124],
    ["ray_cell_frequency", 0.3741],
    ["ring_width_cv", 0.1829],
  ];
  for (const [name, val] of features) {
    steps.push({ text: `  feature  ${name.padEnd(26)}  val=${val.toFixed(6)}`, level: "INFO", dwellMs: pauseSpecies * 0.3 });
  }
  steps.push({ text: "species: probability distribution", level: "INFO", dwellMs: pauseSpecies * 0.3 });
  const spScores: [string, number][] = [
    ["Old Douglas Fir (Pseudotsuga menziesii)", 0.9134],
    ["Western Larch (Larix occidentalis)", 0.0571],
    ["Sitka Spruce (Picea sitchensis)", 0.0191],
    ["Others", 0.0104],
  ];
  for (const [sp, sc] of spScores) {
    const filled = pyRound(sc * 28);
    const tag = sc > 0.5 ? " <- identified" : "";
    steps.push({
      text: `  |${"#".repeat(filled)}${".".repeat(28 - filled)}|  ${sc.toFixed(4)}  ${sp}${tag}`,
      level: "INFO",
      dwellMs: pauseSpecies * 0.45,
    });
  }
  steps.push({ text: "species: RESULT  Old Douglas Fir  confidence=0.9134", level: "OK", dwellMs: pauseSpecies * 0.45 });
  steps.push({ text: "species: WARN    not in standard DB - activating transfer-learning protocol", level: "WARN", dwellMs: pauseSpecies * 0.45 });

  /* -- phase_state：无随机数 -- */
  steps.push({ text: "state: MMWave dielectric analysis  freq=77 GHz  BW=4 GHz  rx_channels=4", level: "INFO", dwellMs: pauseState * 0.5 });
  for (let ch = 1; ch <= 4; ch += 1) {
    const epsR = 3.51 + ch * 0.23;
    const tanD = 0.032 + ch * 0.004;
    const pen = 14.3 + ch * 1.1;
    steps.push({
      text: `  rx_ch${ch}  eps_r=${epsR.toFixed(4)}  tan_d=${tanD.toFixed(4)}  pen_depth=${pen.toFixed(1)} mm  snr=27.${ch}dB`,
      level: "INFO",
      dwellMs: pauseState * 0.35,
    });
  }
  steps.push({ text: "state: SVR moisture estimation  kernel=rbf  C=1.0  eps=0.10  -> MC=21.47 %  (ELEVATED)", level: "WARN", dwellMs: pauseState * 0.6 });
  steps.push({ text: "state: LiDAR point-cloud analysis  n_pts=147382  voxel=2 mm  method=octree", level: "INFO", dwellMs: pauseState * 0.4 });
  for (const [name, val] of [
    ["growth_rings", "51"],
    ["density_estimate", "0.4831 g/cm3  model=rapid-growth-inversion  iter=200"],
    ["earlywood_ratio", "0.612  latewood_ratio=0.388"],
  ]) {
    steps.push({ text: `  ${name.padEnd(22)}  ${val}`, level: "INFO", dwellMs: pauseState * 0.32 });
  }
  steps.push({ text: "state: 1D-CNN internal anomaly  signal=decay+scatter  window=256  stride=64  thr=0.60", level: "INFO", dwellMs: pauseState * 0.5 });
  for (const [s, e, conf, label] of [
    [12, 18, 0.761, "moderate_rot"],
    [31, 35, 0.698, "moisture_pocket"],
    [47, 49, 0.634, "hairline_crack"],
  ] as [number, number, number, string][]) {
    steps.push({
      text: `  anomaly  depth=[${String(s).padStart(3)} cm - ${String(e).padStart(3)} cm]  conf=${conf.toFixed(4)}  class=${label}`,
      level: "INFO",
      dwellMs: pauseState * 0.38,
    });
  }
  steps.push({ text: "state: complete  moisture=21.47%  density=0.483 g/cm3  voids=3  rings=51", level: "OK", dwellMs: pauseState * 0.38 });
  steps.push({ text: "state: routing to adaptive-training  mode=transfer-learning", level: "INFO", dwellMs: pauseState * 0.38 });

  /* -- phase_adamw：无随机数 -- */
  steps.push(...lines(
    [
      `optim: AdamW(lr=${cfg.lr.toExponential(2)}, betas=(0.900,0.999), eps=1e-08, weight_decay=1e-04)`,
      `optim: CosineAnnealingLR(T_max=${cfg.epochs}, eta_min=${cfg.minLr.toExponential(2)})`,
      "optim: loss=CompositeWoodLoss[cls_w=0.41, bbox_w=0.38, obj_w=0.21]",
      "optim: strategy=freeze_backbone_layers_0-7  unfreeze=neck+head",
      "optim: augment=MixUp(0.20)+Mosaic(0.50)+RandomAffine+ColorJitter+GaussNoise",
      "optim: amp=GradScaler(init_scale=65536, growth_interval=100)  dtype=fp16",
      "optim: early_stop=patience(5)  monitor=val_loss  min_delta=1e-04",
      "optim: ready  trainable_params=1.23 M  overfitting_suppression=ACTIVE",
    ],
    pauseAdamw,
  ));

  /* -- phase_training_loop：随机数在这里，顺序必须与脚本一致 -- */
  const epMs = trainingMs / cfg.epochs;
  const epochSec = (epoch: number) => {
    // 脚本的 _epoch_budget：warmup / footer 占比固定，train:eval 比例随轮次微调
    const ratio = epoch <= Math.max(2, pyRound(cfg.epochs * 0.16))
      ? 0.78
      : epoch <= Math.max(3, pyRound(cfg.epochs * 0.7))
        ? 0.82
        : 0.86;
    return [epMs * ratio, epMs * (1 - ratio)] as const;
  };

  let loss = 0.624;
  let acc = 0.65;

  for (let epoch = 1; epoch <= cfg.epochs; epoch += 1) {
    const lr = lrForEpoch(epoch, cfg.lr, cfg.minLr, cfg.epochs);
    const gpuMem = 14.8 + epoch * 0.045 + rand.uniform(-0.18, 0.22); // R1
    const [trainMs, evalMs] = epochSec(epoch);
    const epochLoss = Math.max(0.195, loss * rand.uniform(0.94, 0.99)); // R2
    const stepLoss = epochLoss * rand.uniform(0.96, 1.04); // R3

    // train 进度条：steps=14 → 15 帧，每帧一次 uniform（脚本同）
    const trainFrames = 15;
    for (let i = 0; i < trainFrames; i += 1) {
      const current = Math.min(cfg.trainSteps, pyRound((cfg.trainSteps * i) / 14));
      const speed = rand.uniform(620.0, 910.0);
      const pct = (current * 100) / cfg.trainSteps;
      steps.push({
        text:
          `train epoch ${String(epoch).padStart(2, "0")}/${String(cfg.epochs).padStart(2, "0")} ` +
          `${current}/${cfg.trainSteps} ${speed.toFixed(1)}it/s lr=${lr.toFixed(6)} ` +
          `loss=${stepLoss.toFixed(4)} gpu=${gpuMem.toFixed(1)}G |${bar(current, cfg.trainSteps)}| ${pct.toFixed(2).padStart(6)}%`,
        level: "INFO",
        replace: i > 0,
        dwellMs: Math.max(1, trainMs / 14),
      });
    }
    steps.push({
      text: `Epoch ${String(epoch).padStart(2, "0")}/${String(cfg.epochs).padStart(2, "0")} loss=${epochLoss.toFixed(6)} lr=${lr.toFixed(6)} gpu=${gpuMem.toFixed(1)}G`,
      level: "INFO",
      dwellMs: 40,
    });

    const valAcc = Math.min(0.985, acc * rand.uniform(1.0, 1.012)); // R19
    const map50 = Math.min(0.993, valAcc * rand.uniform(1.01, 1.028)); // R20
    const f1 = Math.min(0.982, valAcc * rand.uniform(0.985, 1.01)); // R21

    const evalFrames = 9;
    for (let i = 0; i < evalFrames; i += 1) {
      const current = Math.min(cfg.evalSteps, pyRound((cfg.evalSteps * i) / 8));
      const speed = rand.uniform(1800.0, 3200.0);
      const pct = (current * 100) / cfg.evalSteps;
      steps.push({
        text:
          `eval val ${current}/${cfg.evalSteps} ${speed.toFixed(1)}it/s ` +
          `mAP50=${map50.toFixed(4)} f1=${f1.toFixed(4)} |${bar(current, cfg.evalSteps)}| ${pct.toFixed(2).padStart(6)}%`,
        level: "INFO",
        replace: i > 0,
        dwellMs: Math.max(1, evalMs / 8),
      });
    }
    steps.push({
      text: `val: accuracy=${valAcc.toFixed(4)} map50=${map50.toFixed(4)} f1=${f1.toFixed(4)} samples=${cfg.evalSteps}`,
      level: "OK",
      dwellMs: 40,
    });

    loss = epochLoss;
    acc = valAcc;
  }

  /* -- phase_postprocess -- */
  steps.push(...lines(
    [
      "post: export best.pt -> best_int8.engine",
      "post: package edge firmware -> fw_mumai_v3.6.0.bin",
      `post: archive logs -> ${cfg.project}\\${cfg.name}`,
    ],
    320,
  ));

  steps.push({
    text: `Training complete - final val accuracy=${acc.toFixed(4)}  final loss=${loss.toFixed(6)}`,
    level: "OK",
    dwellMs: 400,
  });
  steps.push({ text: `best checkpoint: ${cfg.project}\\${cfg.name}\\weights\\best.pt`, level: "INFO", dwellMs: 400 });

  return {
    key: "train",
    label: "全量重训",
    command: "train_multimodal_retrain.py",
    summary: `EFCW-YOLO v3.6 + RadarNet 联合训练 · ${cfg.epochs} epoch`,
    steps,
    totalMs: steps.reduce((sum, step) => sum + step.dwellMs, 0),
  };
}

/* ------------------------------------------------------------------ *
 * ② terminal_distill.py
 * ------------------------------------------------------------------ */

export type DistillScriptConfig = {
  kdEpochs: number;
  temperature: number;
  alpha: number;
  lr: number;
  calibSamples: number;
  device: string;
  outputDir: string;
  firmwareVersion: string;
  targetDevice: string;
};

export const DISTILL_DEFAULTS: DistillScriptConfig = {
  kdEpochs: 20,
  temperature: 4.0,
  alpha: 0.65,
  lr: 5e-4,
  calibSamples: 512,
  device: "cuda:0",
  outputDir: "runs\\mumai\\old-fir-retrain\\weights",
  firmwareVersion: "v3.6.0",
  targetDevice: "Jetson-Orin-NX",
};

const DISTILL_TOTAL_MS = 62_000;

export function buildDistillScript(cfg: DistillScriptConfig = DISTILL_DEFAULTS): TerminalScript {
  const rand = makePyRandom(3407);
  const steps: TerminalStep[] = [];

  // 脚本默认 timings = [2, 30, 5, 2, 1.5, 3]，按比例缩到 DISTILL_TOTAL_MS
  const scale = DISTILL_TOTAL_MS / 43.5;
  const tConfig = 2 * scale;
  const tLoop = 30 * scale;
  const tQuant = 5 * scale;
  const tVerify = 2 * scale;
  const tPack = 1.5 * scale;
  const tArchive = 3 * scale;

  /* -- phase_distill_config：无随机数 -- */
  steps.push(...lines(
    [
      `distill: Teacher  EFCW-YOLO-v3.6 + RadarNet-v2.4         params=18.47M`,
      `distill: Student  EF-Nano-v1.2 + RadarNet-Lite-v1.0       params=3.12M`,
      `distill: Compression ratio  target=5.9×  method=feature-mimicking + response-KD`,
      `distill: Temperature  T=${cfg.temperature}  alpha=${cfg.alpha}  loss=KL_div(T=${cfg.temperature.toFixed(0)})*${cfg.alpha} + task_CE*${(1 - cfg.alpha).toFixed(2)}`,
      `distill: Calibration set  old_fir_retrain_v3  samples=${cfg.calibSamples}`,
      `distill: Optimizer  AdamW(lr=${cfg.lr.toExponential(2)}  weight_decay=1e-04)  epochs=${cfg.kdEpochs}`,
      `distill: Initiating feature-alignment distillation loop  (phase 2/3) ...`,
    ],
    tConfig / 7,
  ));

  /* -- phase_distill_loop：随机数 -- */
  const epMs = tLoop / cfg.kdEpochs;
  let kdLoss = 1.84;
  let tskLoss = 0.621;

  for (let epoch = 1; epoch <= cfg.kdEpochs; epoch += 1) {
    const trainMs = epMs * 0.85;
    kdLoss = Math.max(0.012, kdLoss * rand.uniform(0.93, 0.975));
    tskLoss = Math.max(0.032, tskLoss * rand.uniform(0.94, 0.978));
    const align = kdLoss * rand.uniform(0.48, 0.56);
    const total = kdLoss * cfg.alpha + tskLoss * (1 - cfg.alpha) + align * 0.05;

    const frames = 11; // steps=10 → 11 帧
    for (let i = 0; i < frames; i += 1) {
      const current = Math.min(cfg.calibSamples, pyRound((cfg.calibSamples * i) / 10));
      const speed = rand.uniform(280.0, 420.0);
      steps.push({
        text:
          `distill epoch ${String(epoch).padStart(2, "0")}/${cfg.kdEpochs}  ${current}/${cfg.calibSamples}  ` +
          `${speed.toFixed(0)}it/s  kd=${kdLoss.toFixed(4)}  task=${tskLoss.toFixed(4)}  ` +
          `align=${align.toFixed(4)}  total=${total.toFixed(4)}  |${bar(current, cfg.calibSamples)}|`,
        level: "INFO",
        replace: i > 0,
        dwellMs: Math.max(1, trainMs / 10),
      });
    }
  }

  const studentMap50 = Math.min(0.96, 0.9389 * rand.uniform(0.994, 1.006));

  /* -- phase_int8_quant -- */
  const tScan = tQuant * 0.55;
  const tEngine = tQuant * 0.45;
  steps.push({ text: "distill: Feature transfer complete  -> switching to INT8 PTQ calibration", level: "INFO", dwellMs: Math.max(50, tQuant * 0.08) });

  const scanLayers: [string, "LOW" | "MEDIUM" | "HIGH", number][] = [
    ["conv_stem", "LOW", 0.0002],
    ["C2f_1", "LOW", 0.0008],
    ["C2f_2", "LOW", 0.0012],
    ["C2f_3", "MEDIUM", 0.0051],
    ["C2f_neck_1", "LOW", 0.0019],
    ["C2f_neck_2", "LOW", 0.0024],
    ["C2f_neck_3", "MEDIUM", 0.0047],
    ["radar_conv1", "LOW", 0.0006],
    ["radar_conv2", "LOW", 0.0009],
    ["radar_fusion", "MEDIUM", 0.0038],
    ["fusion_attention", "MEDIUM", 0.0063],
    ["neck_fpn_p3", "LOW", 0.0015],
    ["neck_fpn_p4", "LOW", 0.0018],
    ["detect_head_cls", "HIGH", 0.0241],
    ["detect_head_box", "HIGH", 0.0189],
  ];
  const pauseScan = tScan / (scanLayers.length + 2);
  steps.push({ text: `quant: Loading calibration data  samples=${cfg.calibSamples}  batch=32  device=${cfg.device}`, level: "INFO", dwellMs: pauseScan * 1.2 });
  steps.push({ text: "quant: Layer-wise sensitivity analysis  n_layers=47  method=mse-entropy", level: "INFO", dwellMs: pauseScan * 0.6 });
  for (const [layer, sens, delta] of scanLayers) {
    steps.push({
      text: `  layer  ${layer.padEnd(22)}  delta_mAP=-${delta.toFixed(4)}  sensitivity=${sens.padEnd(6)}  -> ${sens === "HIGH" ? "FP16" : "INT8"}`,
      level: sens === "HIGH" ? "WARN" : "INFO",
      dwellMs: pauseScan,
    });
  }
  const int8Count = scanLayers.filter(([, s]) => s !== "HIGH").length + 32;
  const fp16Count = scanLayers.filter(([, s]) => s === "HIGH").length;
  steps.push({ text: `quant: Sensitivity scan complete  INT8=${int8Count}/47 layers  FP16=${fp16Count}/47 layers`, level: "OK", dwellMs: pauseScan * 0.5 });

  const engineTotal = 512;
  for (let i = 0; i < 11; i += 1) {
    const current = pyRound((engineTotal * i) / 10);
    const speed = rand.uniform(85.0, 130.0);
    steps.push({
      text: `quant: TensorRT engine build  ${current}/${engineTotal}  ${speed.toFixed(0)}it/s  target=${cfg.targetDevice}  |${bar(current, engineTotal)}|`,
      level: "INFO",
      replace: i > 0,
      dwellMs: Math.max(1, tEngine / 10),
    });
  }
  steps.push({ text: "quant: Engine export complete  best_int8.engine  3.12 MB  latency=11 ms/frame", level: "OK", dwellMs: 200 });

  /* -- phase_verify -- */
  const teacherMap50 = 0.9641;
  const teacherAcc = 0.9418;
  const studentAcc = Math.min(0.98, studentMap50 * rand.uniform(0.975, 0.982));
  const dropMap = teacherMap50 - studentMap50;
  const dropAcc = teacherAcc - studentAcc;
  const pauseVerify = tVerify / 5;
  steps.push({ text: `verify: Running INT8 inference on val set  samples=250  device=${cfg.device}`, level: "INFO", dwellMs: pauseVerify });
  steps.push({ text: `verify: Teacher  mAP50=${teacherMap50.toFixed(4)}  acc=${teacherAcc.toFixed(4)}  latency=38 ms/frame  params=18.47M`, level: "INFO", dwellMs: pauseVerify });
  steps.push({ text: `verify: Student  mAP50=${studentMap50.toFixed(4)}  acc=${studentAcc.toFixed(4)}  latency=11 ms/frame  params=3.12M`, level: "INFO", dwellMs: pauseVerify });
  const passed = dropMap < 0.03 && dropAcc < 0.03;
  steps.push({ text: `verify: Accuracy drop  mAP50=-${dropMap.toFixed(4)}  acc=-${dropAcc.toFixed(4)}  (threshold 3%)`, level: passed ? "INFO" : "WARN", dwellMs: pauseVerify });
  steps.push({ text: "verify: Throughput gain  3.46×  Power reduction ~68%  Model size  3.12 MB  (was 18.47 MB)", level: "INFO", dwellMs: pauseVerify });
  steps.push({ text: `verify: ${passed ? "PASSED" : "WARN"}  edge deployment requirements satisfied`, level: passed ? "OK" : "WARN", dwellMs: pauseVerify });

  /* -- phase_pack -- */
  const pausePack = tPack / 5;
  steps.push(...lines(
    [
      `pack: Loading INT8 engine  ${cfg.outputDir}\\best_int8.engine  3.12 MB`,
      `pack: Appending metadata  version=${cfg.firmwareVersion}  target=${cfg.targetDevice}  species=old_fir`,
      `pack: Signing firmware  algo=SHA256-HMAC  key=mumai_edge_key_2024`,
      `pack: Output  fw_mumai_${cfg.firmwareVersion}.bin  4.08 MB`,
      `pack: Manifest written  fw_manifest_${cfg.firmwareVersion}.json`,
    ],
    pausePack,
  ));

  /* -- phase_archive -- */
  const stepMs = tArchive / 7;
  steps.push({ text: "archive: Connecting  mumai-cloud.storage/v2  tls=1.3  auth=token", level: "INFO", dwellMs: stepMs * 0.8 });
  const uploads: [string, string, string, number, [number, number]][] = [
    ["model weights", "best.pt + best_int8.engine", "21.6 MB", 380, [28.0, 42.0]],
    ["feature snapshot", "old_fir_snapshot_v3.pkl", " 1.8 MB", 80, [18.0, 28.0]],
    ["training log", `${cfg.outputDir}\\*.log`, " 3.2 MB", 120, [22.0, 36.0]],
    ["firmware bundle", `fw_mumai_${cfg.firmwareVersion}.bin`, " 4.1 MB", 96, [24.0, 38.0]],
  ];
  const perUpload = (stepMs * 0.85) / 8;
  for (const [label, path, size, total, speedRange] of uploads) {
    for (let i = 0; i < 9; i += 1) {
      const current = pyRound((total * i) / 8);
      const speed = rand.uniform(speedRange[0], speedRange[1]);
      steps.push({
        text: `archive: Uploading ${label.padEnd(18)}  ${path.padEnd(48)}  ${size}  ${current}/${total}  ${speed.toFixed(0)} KB/s  |${bar(current, total)}|`,
        level: "INFO",
        replace: i > 0,
        dwellMs: Math.max(1, perUpload),
      });
    }
  }
  steps.push({ text: `archive: Version tag  mumai-model-${cfg.firmwareVersion}  env=edge  species=old_fir`, level: "INFO", dwellMs: stepMs * 0.6 });
  steps.push({ text: "archive: Complete  session_id=MML-2026-0413  retention=180d", level: "OK", dwellMs: stepMs * 0.4 });
  steps.push({
    text: `Distillation & quantization complete  firmware=fw_mumai_${cfg.firmwareVersion}.bin  edge_model=3.12 MB  INT8`,
    level: "OK",
    dwellMs: 500,
  });

  return {
    key: "distill",
    label: "蒸馏与量化",
    command: "distill_int8_quant.py",
    summary: `知识蒸馏 ${cfg.kdEpochs} epoch → INT8 PTQ → TensorRT → 固件封装归档`,
    steps,
    totalMs: steps.reduce((sum, step) => sum + step.dwellMs, 0),
  };
}
