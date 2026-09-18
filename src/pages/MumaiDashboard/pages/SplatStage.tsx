/**
 * 高斯泼溅主视图（Spark + SOG）
 *
 * 孪生页原来是一套手搓低模（庭院 + 四根圆柱），文档里被点名「不是孪生」。
 * 这里换成真实重建产物：`public/model/sog/gs.sog` —— SOG v2 压缩格式
 * （MipMap Software 生成，约 238 万个高斯点，包围盒约 ±3.5）。
 *
 * 为什么用 Spark：它是 Three.js 的插件式渲染器（`SparkRenderer` 进场景 +
 * `SplatMesh` 载数据），和本项目已有的 react-three-fiber 是同一套场景图，
 * 不用为了看一个重建产物再塞一个独立的 canvas / iframe 体系进来。
 * 它也直接认 `.sog`（`SplatFileType.PCSOGSZIP`），不需要先转格式。
 *
 * 三条工程约束：
 *   1. **31 MB 的产物必须给进度**。加载期间只转圈不报进度，演示时会被当成卡死。
 *   2. **加载失败要有降级**，且降级要说明是降级 —— PRD 3.3 要求加载失败时
 *      用明确的降级视图，不能假装还是高斯渲染。
 *   3. 238 万点的排序开销不能每帧全量重来，靠 Spark 的 LoD（`lod`）压住。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { Box3, Euler, MathUtils, Vector3 } from "three";
import { useFrame } from "@react-three/fiber";
import NumberAnimation from "@/components/numberAnimation";
import { SPLAT_BOUNDS, SPLAT_TRANSFORM, type SplatCamera, type SplatTransform } from "./splat";
import { FRAME_BLACK_LUMA, poseFromView, posePositionText, poseReadout, lookAheadFor, type SplatPose } from "./splatPose";

function SplatCameraRig({
  target,
  nonce = 0,
  onArrived,
}: {
  target: SplatCamera | null;
  /** 同一机位再点一次也要重新飞（`target` 的字段没变时靠它触发） */
  nonce?: number;
  onArrived?: () => void;
}) {
  if (!target) return null;
  return <SplatCameraRigInner target={target} nonce={nonce} onArrived={onArrived} />;
}

function SplatCameraRigInner({
  target,
  nonce = 0,
  onArrived,
}: {
  target: SplatCamera;
  nonce?: number;
  onArrived?: () => void;
}) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target: Vector3; update: () => void }
    | null;
  const anim = useRef<{
    from: Vector3;
    to: Vector3;
    fromTarget: Vector3;
    toTarget: Vector3;
    t: number;
  } | null>(null);

  useEffect(() => {
    const focus = target.focus;
    const toTarget = focus ? new Vector3(focus.x, focus.y, focus.z) : new Vector3(0, 0, 0);
    const distance = target.distance ?? (focus ? 3.2 : 8);
    const phi = MathUtils.degToRad(target.polar);
    const theta = MathUtils.degToRad(target.azimuth);
    const to = new Vector3(
      toTarget.x + distance * Math.sin(phi) * Math.sin(theta),
      toTarget.y + distance * Math.cos(phi),
      toTarget.z + distance * Math.sin(phi) * Math.cos(theta),
    );
    anim.current = {
      from: camera.position.clone(),
      to,
      fromTarget: controls ? controls.target.clone() : toTarget.clone(),
      toTarget,
      t: 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.azimuth, target.polar, target.focus?.x, target.focus?.y, target.focus?.z, nonce]);

  useFrame((_, delta) => {
    const current = anim.current;
    if (!current) return;
    current.t = Math.min(1, current.t + delta / 0.6);
    const k = current.t * current.t * (3 - 2 * current.t);
    camera.position.lerpVectors(current.from, current.to, k);
    if (controls) {
      controls.target.lerpVectors(current.fromTarget, current.toTarget, k);
      controls.update();
    }
    if (current.t >= 1) {
      anim.current = null;
      /*
       * 飞到位之后**必须**通知外面：`FirstPersonControls` 自己维护 yaw/pitch，
       * 外部动过相机不同步的话，用户下一次拖动的瞬间画面会跳回旧朝向
       * （现象是"一转视角就不知道飘到哪了"，见 FirstPersonControls 的注释）。
       * 「适应视图」是瞬时的所以当场同步；回放是动画，得等落地再同步。
       */
      onArrived?.();
    }
  });

  return null;
}

/**
 * 当前机位读表（数字孪生「打关键帧」要用）。
 *
 * ── 为什么放在 Canvas 里读 ────────────────────────────────────────
 * 相机是 Canvas 里的 three.js 对象，页面侧拿不到。这里每帧把相机**读成**
 * 声明式机位（`poseFromView`），写到外面给的 ref 上。
 *
 * ── 为什么读数直接写 DOM，而不是 setState ──────────────────────────
 * 每帧 setState 会让整个孪生页每秒重渲染 60 次（拖镜头直接卡）；
 * 而"节流 + setState"的写法实测踩了坑：第一版限流 400ms 一次，
 * 结果**推拉镜头之后读数不刷新**（画面对了、数字停在原处），
 * 现场就是"我明明动了镜头，读数还是老机位"。所以改成：
 *   机位走 ref（零重渲染），读数**直接改那一个文本节点**（只在文字变了才写）。
 * 这样读数永远是最新的，也不会让页面重渲染。
 */
function SplatPoseTracker({
  poseRef,
  lookAhead,
  textRef,
}: {
  poseRef: MutableRefObject<SplatPose | null> | undefined;
  lookAhead: number;
  textRef?: MutableRefObject<HTMLElement | null>;
}) {
  const camera = useThree((state) => state.camera);
  const forward = useRef(new Vector3());

  useFrame(() => {
    camera.getWorldDirection(forward.current);
    let pose: SplatPose;
    try {
      pose = poseFromView(
        {
          position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          forward: { x: forward.current.x, y: forward.current.y, z: forward.current.z },
        },
        lookAhead,
      );
    } catch {
      /* 位置算出 NaN（画布尺寸为 0 之类）时这一帧不读数，别让异常打断渲染循环 */
      return;
    }
    if (poseRef) poseRef.current = pose;
    const node = textRef?.current;
    if (!node) return;
    const text = `${poseReadout(pose)} · ${posePositionText(pose)}`;
    /* 只在变了才写：每帧写 DOM 虽然便宜，但会让开发者工具里的 DOM 断点没法用 */
    if (node.textContent !== text) node.textContent = text;
  });

  return null;
}

/**
 * 3D 画面的出口：**打帧时截一张图**，同时回答一个更要紧的问题 ——**画面到底画出来了没有**。
 *
 * ── 为什么需要"画出来了没有"这个信号（2026-09-18 实测）────────────────
 * `SplatMesh.onLoad`（页面据此撤掉加载覆盖层、放开「打关键帧」按钮）只代表
 * **文件解析完**，不代表**画面上有东西**：示例寺那份 6.4MB 产物在无头实测里解析完
 * 还要 6~10 秒才出第一帧，MAY 那份 58MB 的 95 秒都没出画。这段时间 3D 区是纯黑，
 * 而按钮已经能点 —— 现场于是"点一下打关键帧，画面是黑的，也不知道这一帧记的是哪儿"。
 * 所以这里每 400ms 把画布缩到 32×20 采一次亮度，**真的出现非背景像素**才上报 `onPainted`。
 * 阈值与"打帧时这一张图算不算全黑"是同一条（`FRAME_BLACK_LUMA`，在 `splatPose.ts`）。
 *
 * ── 为什么截图必须开 `preserveDrawingBuffer` ─────────────────────────
 * WebGL 默认在合成后丢掉绘制缓冲，`toDataURL()` / `drawImage(canvas)` 拿到的会是
 * 一张**全黑图**（这就是"图黑掉"的经典陷阱）。所以 `Canvas` 的 gl 上开了它：
 * 代价是每帧多一次拷贝（1070×621 ≈ 0.66MP），相对 238 万点的排序可忽略，
 * 换来截图与亮度探测都能拿到**当前这一帧**。
 */
export type SplatShot = {
  /** JPEG dataURL（已缩到宽 ≤1280：上传成文件时别把 1872px 的原图塞进去） */
  dataUrl: string;
  /** 画面里最亮的像素（0~255）：约等于背景值就说明什么都没画出来 */
  maxLuma: number;
};

export type SplatCapture = { snapshot: () => SplatShot | null };

/** 截图的最大宽度：够看清构件，又不至于每次打帧都传几百 KB */
const SHOT_MAX_WIDTH = 1280;
/** 探测频率：一次 1:1 中心块读取，400ms 一次对帧率没影响 */
const PROBE_INTERVAL_MS = 400;
/**
 * 探测读的是**画面正中 1:1 的一块**（不重采样）。
 *
 * ⚠ 这里踩过一个坑（2026-09-18 实测，值得留着）：最早把整帧缩到 32×20 再采样，
 * 结果**永远是背景色** —— 细高的木柱在 1070×621 里只占约 0.5%，
 * 默认的双线性缩放在 33 像素一步的采样里直接把它跳过去了。同一块画布三种读法：
 *   `32×20 默认` = 9（全黑）、`¼ 尺寸 + imageSmoothingQuality:"high"` = 219、`中心 1:1` = 230。
 * 所以探测**不做缩放**（取景后模型就在画面中心），少一层重采样就少一个假黑。
 */
const PROBE_W = 360;
const PROBE_H = 240;

function SplatCanvasProbe({
  captureRef,
  onPainted,
  active,
  armed,
}: {
  captureRef?: MutableRefObject<SplatCapture | null>;
  onPainted?: () => void;
  active: boolean;
  /**
   * 文件解析完了才开始探测。
   *
   * 两个理由：① 解析完成前画面上**不可能**有东西，探测只是白花一次全画布回读
   * （软件渲染下每次回读都要等当前帧画完，实测很贵）；② 探测报"画出来了"就等于
   * 放开按钮 —— 这个信号必须来自**真的出画**，不是"等得够久"。
   */
  armed: boolean;
}) {
  const gl = useThree((state) => state.gl);
  const painted = useRef(false);
  const lastProbe = useRef(0);
  const probeCanvas = useRef<HTMLCanvasElement | null>(null);

  /** 把画面正中一块**按 1:1** 读成像素（开了 preserveDrawingBuffer 才拿得到真画面） */
  const readCenter = useCallback(
    (wantW: number, wantH: number) => {
      const source = gl.domElement;
      if (!source || source.width < 8 || source.height < 8) return null;
      const width = Math.min(wantW, source.width);
      const height = Math.min(wantH, source.height);
      const sx = Math.floor((source.width - width) / 2);
      const sy = Math.floor((source.height - height) / 2);
      const canvas = (probeCanvas.current ??= document.createElement("canvas"));
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(source, sx, sy, width, height, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height).data;
    },
    [gl],
  );

  /** 一组像素里最亮的那个（0~255） */
  const peakLuma = (data: Uint8ClampedArray) => {
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (luma > max) max = luma;
    }
    return max;
  };

  /* 打帧时调用：这一帧的图 + 它有多亮（全黑说明模型没画出来，调用方据此拒收） */
  useEffect(() => {
    if (!captureRef) return undefined;
    captureRef.current = {
      snapshot: () => {
        const source = gl.domElement;
        if (!source || source.width < 8 || source.height < 8) return null;
        const scale = Math.min(1, SHOT_MAX_WIDTH / source.width);
        const width = Math.max(8, Math.round(source.width * scale));
        const height = Math.max(8, Math.round(source.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        /* 高 dpi 画布（dpr 1.75）会被缩到 1280：用高质量重采样，别把细构件缩没了 */
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, width, height);
        const data = ctx.getImageData(0, 0, width, height).data;
        return { dataUrl: canvas.toDataURL("image/jpeg", 0.82), maxLuma: peakLuma(data) };
      },
    };
    return () => {
      captureRef.current = null;
    };
  }, [captureRef, gl]);

  useFrame(() => {
    if (painted.current || !active || !armed) return;
    const now = performance.now();
    if (now - lastProbe.current < PROBE_INTERVAL_MS) return;
    lastProbe.current = now;
    const data = readCenter(PROBE_W, PROBE_H);
    if (!data) return;
    if (peakLuma(data) > FRAME_BLACK_LUMA) {
      painted.current = true;
      onPainted?.();
    }
  });

  return null;
}

/**
 * Spark 图层。
 *
 * `SparkRenderer` 与 `SplatMesh` 都是 Three.js 对象，直接挂进 R3F 的场景图，
 * 用 `<primitive>` 而不是在 effect 里手动 `scene.add` —— 后者在 R3F 下
 * 容易和它自己的挂载 / 卸载时序打架（挂两次、或卸载后没清掉）。
 */
function SparkLayer({
  url,
  transform,
  onProgress,
  onLoaded,
  onError,
  onReady,
}: {
  url: string;
  transform: SplatTransform;
  onProgress?: (fraction: number) => void;
  onLoaded?: () => void;
  onError?: (message: string) => void;
  /** 加载完成后上报真实包围盒，用于把视图取景到实际内容 */
  onReady?: (box: Box3) => void;
}) {
  const gl = useThree((state) => state.gl);

  const spark = useMemo(() => new SparkRenderer({ renderer: gl }), [gl]);

  /**
   * 回调放进 ref，`useMemo` 只依赖 url。
   *
   * 这不是洁癖：调用方（SplatStage）每次渲染都新建一次箭头函数，
   * 如果把它们写进依赖数组，SplatMesh 会被**每帧重建一次** ——
   * 现象是文件下完了、进度停在 100%，画面却一直是黑的，
   * 而且因为每次都在重建，`initialized` 永远等不到完成。
   */
  const handlers = useRef({ onProgress, onLoaded, onError, onReady });
  handlers.current = { onProgress, onLoaded, onError, onReady };

  const splats = useMemo(
    () =>
      new SplatMesh({
        url,
        // 238 万点：排序是主要开销，LoD 让远处不必全量参与
        lod: true,
        onProgress: (event: ProgressEvent) => {
          if (event.total > 0) handlers.current.onProgress?.(event.loaded / event.total);
        },
        onLoad: () => handlers.current.onLoaded?.(),
      }),
    [url],
  );

  useEffect(() => {
    // SplatMesh 的加载失败不会抛到 React，只能自己接住再往上报
    let cancelled = false;
    splats.initialized
      .then(() => {
        if (cancelled) return;
        handlers.current.onLoaded?.();
        /*
         * 取景用**实测包围盒**，不用 meta.json 里的 mins/maxs：
         * 那份是全部高斯点的极值，容易被少量离群点撑大，按它取景会把主体缩得很小。
         * `centers_only` 只算中心点，量级更贴近肉眼看到的那一团。
         */
        handlers.current.onReady?.(splats.getBoundingBox(true));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          handlers.current.onError?.(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
      // 注意：这里**不**调 splats.dispose()。Spark 在已加载完成后销毁会从
      // 内部 promise 链里抛一个 `Uncaught (in promise)`（切换视图时必现，
      // 且从外部接不住 —— 它不在 `initialized` 那条链上）。
      // 交给 GC：SplatMesh 脱离场景后没有别的引用，纹理与缓冲随之回收。
      // 代价是切换视图时内存释放晚一拍，换来切页不再往控制台丢未捕获异常。
    };
  }, [splats]);

  // 同 SplatMesh：卸载时不显式 dispose SparkRenderer，见上面那段说明。
  // （实测两者都试过，异常在任一 dispose 存在时都会出现，且从外部接不住。）

  return (
    <group>
      <primitive object={spark} />
      <primitive
        object={splats}
        rotation={[MathUtils.degToRad(transform.pitch), 0, 0]}
        scale={transform.scale}
        position={transform.offset}
      />
    </group>
  );
}

/**
 * 取景到包围盒。
 *
 * 重建产物的真实尺度事先不知道（这份大约 ±3.5，但也可能是别的量级），
 * 写死机位就只能靠一次次试。这里按实测包围盒反解距离：
 * 让最长边在垂直方向占约 80% 画幅，再留一点余量。
 */
function fitToBox(
  camera: { position: Vector3; near: number; far: number; updateProjectionMatrix: () => void },
  controls: { target: Vector3; update: () => void } | null,
  box: Box3,
  fovDeg: number,
) {
  if (box.isEmpty()) return;
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  /*
   * 取景距离 = 按包围盒反解 × 6。
   *
   * 系数是**这个产物的标定值**：meta.json 声明的包围盒约 7.3，但 Spark 渲染出来的
   * 实际尺度是它的 6 倍左右 —— 距离 47 时整个房间才入画（按声明包围盒反解只有 7.9，
   * 放到 9 相机就钻进模型内部、画面全黑）。
   *
   * 画面偏模糊是**高斯泼溅的正常表现**，不是取景问题：3DGS 只在接近采集视角时
   * 才清晰，站远看几百万个高斯会叠成色块。换其他重建产物时这个系数要重调。
   */
  /*
   * ×11 是**这个产物的标定系数**：按声明包围盒反解出来的是「正好贴住画面」，
   * 而高斯泼溅的每个高斯都有体积、实测包围盒又比可见范围小，×6 时相机会落在
   * 结构内部（画面上只有一片模糊色块）。×11 才能完整看到模型轮廓。
   * 换其它重建产物时这个系数要重调，判据是「能看见完整轮廓」。
   */
  const distance = (maxDim / 2 / Math.tan(MathUtils.degToRad(fovDeg) / 2)) * 11;
  // 斜俯视：方向固定，避免每次适应视图后机位朝向乱跳
  const direction = new Vector3(0.72, 0.46, 0.92).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(0.02, distance / 400);
  camera.far = distance * 30;
  camera.updateProjectionMatrix();
  /*
   * 第一人称：相机**看向**包围盒中心（不再维护 OrbitControls 的 target）。
   * 用 lookAt 设置初始朝向即可，之后由 FirstPersonControls 接管 yaw / pitch。
   */
  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
}

/** 产物自己声明的包围盒（见 splat.ts 里为什么不用 getBoundingBox） */
function declaredBounds(): Box3 {
  return new Box3(
    new Vector3(...SPLAT_BOUNDS.min),
    new Vector3(...SPLAT_BOUNDS.max),
  );
}

/** 负责在数据就绪与「适应视图」被点击时取景 */
function SplatFitter({
  box,
  nonce,
  fov,
}: {
  box: React.RefObject<Box3 | null>;
  nonce: number;
  fov: number;
}) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target: Vector3; update: () => void }
    | null;

  useEffect(() => {
    /*
     * 用哪一份包围盒取景：**量出来的那份为空就退回模型声明的**。
     *
     * ── 为什么要这一步（2026-09-17 用真实浏览器验出来的老 bug）──────────
     * 原来写的是 `box.current ?? declaredBounds()`：只在"还没有 Box3 对象"时兜底。
     * 但实测发现 Spark 交回来的那个 Box3 **存在却是空的**（`isEmpty() === true`）——
     * 于是 `fitToBox` 在 `if (box.isEmpty()) return;` 那里直接返回，
     * 表现就是**「适应视图」点了没反应**（画面只是 near/far 重算导致的一点点变化），
     * 而刚进页面时的机位其实来自 `declaredBounds()`（挂载那一刻 box.current 还是 null）。
     * 判定"能不能用"要看**空不空**，不是"有没有对象"。
     */
    const measured = box.current;
    const current = measured && !measured.isEmpty() ? measured : declaredBounds();
    fitToBox(
      camera as unknown as {
        position: Vector3;
        near: number;
        far: number;
        updateProjectionMatrix: () => void;
      },
      controls,
      current,
      fov,
    );
    // camera / controls 是稳定引用，不进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, box.current?.isEmpty()]);

  return null;
}

/**
 * 第一人称操作（鼠标决定方向 + WASD 沿朝向移动）
 *
 * 键位与鼠标：
 *   转动视角   鼠标左键拖动（相机**原地**转向，不绕任何中心点）
 *   前后左右   W / A / S / D（沿**当前朝向**，不是沿世界轴）
 *   上下移动   Q / E
 *   减速/加速  Ctrl / Shift
 *   前进后退   滚轮（相当于沿朝向推拉）
 *
 * 为什么不用 OrbitControls：轨道相机的语义是「绕 target 转」——
 * 视角变化时相机是绕着模型跑的，想去模型的另一侧只能绕着走。
 * 现场要看的是「站在这里往四周看」，所以这里自己实现：
 *   · yaw / pitch 自己维护，鼠标位移直接改这两个角；
 *   · 相机的世界朝向由 yaw / pitch 反解，不读 `getWorldDirection`
 *     （那会读到上一帧的结果，连续拖动时手感发飘）；
 *   · W/S/A/D 一律由 yaw 反解出水平前向与右向，所以「转过去再按 W」
 *     就是往新方向走。
 *
 * 拖动而不是指针锁定：演示时经常要在页面上点别的控件，
 * 指针锁定（Pointer Lock）会把鼠标藏起来还得按 Esc 退出，反而碍事。
 */
function FirstPersonControls({
  scale,
  syncNonce = 0,
  onUserInput,
}: {
  scale: number;
  syncNonce?: number;
  /** 用户自己动了镜头（拖动 / 滚轮 / WASD）时回调；回放飞行不触发 */
  onUserInput?: () => void;
}) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const pressed = useRef<Set<string>>(new Set());
  const angles = useRef<{ yaw: number; pitch: number } | null>(null);
  const dragging = useRef(false);

  /**
   * 外部动过相机之后重新同步朝向。
   *
   * 取景（`fitToBox`）会把相机搬到包围盒外侧并改朝向；控制器如果不同步，
   * yaw/pitch 还是旧值，用户第一次拖动的瞬间画面会「啪」地跳回去 ——
   * 现象是「一转视角就不知道飘到哪了」。
   */
  useEffect(() => {
    const euler = new Euler().setFromQuaternion(camera.quaternion, "YXZ");
    angles.current = { yaw: euler.y, pitch: euler.x };
  }, [camera, syncNonce]);

  useEffect(() => {
    const canvas = gl.domElement;

    /* 初值从当前相机朝向反解，避免第一帧跳一下 */
    const euler = new Euler().setFromQuaternion(camera.quaternion, "YXZ");
    angles.current = { yaw: euler.y, pitch: euler.x };

    const apply = () => {
      const value = angles.current;
      if (!value) return;
      /* 纵向留 2° 余量，避免正上/正下时出现万向节翻转；横向不限 */
      value.pitch = MathUtils.clamp(value.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
      camera.quaternion.setFromEuler(new Euler(value.pitch, value.yaw, 0, "YXZ"));
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging.current = true;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging.current = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging.current || !angles.current) return;
      /* 灵敏度按画布像素算：不同窗口大小拖同样的距离，转过的角度一致 */
      const perPixel = 0.0032;
      /*
       * 水平**不设上限**：一直往一个方向拖可以转满 360°（视角是「站着往四周看」，
       * 想看到背后就该能转过去）。纵向限制在 ±90° 内，避免翻顶时画面打滚。
       */
      angles.current.yaw -= event.movementX * perPixel;
      angles.current.pitch -= event.movementY * perPixel;
      apply();
      onUserInput?.();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      moveForward(Math.sign(event.deltaY) * -1 * 0.5);
      onUserInput?.();
    };

    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      pressed.current.add(event.code);
      if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"].includes(event.code)) {
        event.preventDefault();
        onUserInput?.();
      }
    };
    const up = (event: KeyboardEvent) => pressed.current.delete(event.code);
    const blur = () => {
      pressed.current.clear();
      dragging.current = false;
    };

    /** 滚轮：沿当前朝向推拉（不改变 yaw / pitch） */
    const moveForward = (factor: number) => {
      const direction = new Vector3();
      camera.getWorldDirection(direction);
      camera.position.addScaledVector(direction, scale * factor);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [camera, gl, scale, onUserInput]);

  useFrame((_, delta) => {
    const keys = pressed.current;
    if (keys.size === 0) return;
    const value = angles.current;
    if (!value) return;
    const fast = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const slow = keys.has("ControlLeft") || keys.has("ControlRight");
    const speed = scale * (fast ? 1.1 : slow ? 0.1 : 0.42) * delta;

    /* 由 yaw 反解水平前向与右向：转过去再按 W 就是往新方向走 */
    const forward = new Vector3(-Math.sin(value.yaw), 0, -Math.cos(value.yaw));
    const right = new Vector3(Math.cos(value.yaw), 0, -Math.sin(value.yaw));

    const move = new Vector3();
    if (keys.has("KeyW")) move.add(forward);
    if (keys.has("KeyS")) move.sub(forward);
    if (keys.has("KeyD")) move.add(right);
    if (keys.has("KeyA")) move.sub(right);
    if (keys.has("KeyE")) move.y += 1;
    if (keys.has("KeyQ")) move.y -= 1;
    if (move.lengthSq() === 0) return;
    camera.position.addScaledVector(move.normalize(), speed);
  });

  return null;
}

export function SplatStage({
  url,
  transform = SPLAT_TRANSFORM,
  camera,
  onProgress,
  onLoaded,
  onError,
  fitNonce,
  poseRef,
  cameraNonce,
  captureRef,
  onPainted,
  active = true,
  onUserInput,
}: {
  url: string;
  transform?: SplatTransform;
  camera: SplatCamera | null;
  onProgress?: (fraction: number) => void;
  onLoaded?: () => void;
  onError?: (message: string) => void;
  /** 变化即重新取景到重建产物（「适应视图」按钮） */
  fitNonce?: number;
  /**
   * 当前机位的出口（数字孪生「打关键帧」读它）。
   * 走 ref 不走 state：见 `SplatPoseTracker` 的说明。
   */
  poseRef?: MutableRefObject<SplatPose | null>;
  /**
   * 同一个机位再点一次也要重新飞：`camera` 的字段没变时靠这个 nonce 触发动画。
   */
  cameraNonce?: number;
  /** 截图的出口（打关键帧把它存成文件；见 `SplatCanvasProbe`） */
  captureRef?: MutableRefObject<SplatCapture | null>;
  /** **画面真的画出来了**（不是"文件解析完了"）：按钮据此才放开 */
  onPainted?: () => void;
  /**
   * 是否正在显示。切到低模示意时传 false：
   * Canvas 必须**保持挂载**（只停渲染），原因见文件末尾关于卸载异常的说明。
   */
  active?: boolean;
  /**
   * 用户自己动了镜头（拖动 / 滚轮 / WASD / QE）时回调。
   * 数字孪生用它清掉「已回到该机位」的高亮 —— 手动转开之后那一行不能还挂着。
   */
  onUserInput?: () => void;
}) {
  /*
   * 加载态自己维护一份：31 MB 的产物不给进度，演示时会被当成卡死。
   * 覆盖层做在这个组件里而不是甩给调用方 —— 每个用到它的页面都自己写一遍
   * 「转圈 + 百分比」既重复又容易写歪。
   */
  const [progress, setProgress] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** 实测包围盒。就绪后由 SplatFitter 用它取景，也用来换算按键移动速度 */
  const boxRef = useRef<Box3 | null>(null);
  const [boxNonce, setBoxNonce] = useState(0);
  const [flyScale, setFlyScale] = useState(6);
  /*
   * 当前机位读数那一格：由 `SplatPoseTracker` 每帧**直接写文本**（不走 state），
   * 所以这里只需要一个 DOM 引用。见 SplatPoseTracker 的说明。
   */
  const poseTextRef = useRef<HTMLElement | null>(null);
  /*
   * 回放落地后要让 `FirstPersonControls` 重新同步朝向。它与「适应视图」共用
   * `syncNonce`，所以这里也给它一个独立的计数：`boxNonce`/`fitNonce` 的倍率
   * 是既有写法（`* 1000`），回放计数用它下面那一档，互不覆盖。
   */
  const [flyArrived, setFlyArrived] = useState(0);
  const syncNonce = boxNonce + (fitNonce ?? 0) * 1000 + flyArrived;

  return (
    <div className="splat-stage">
      <Canvas
        // 隐藏时停掉渲染循环：238 万点的排序不能白跑
        frameloop={active ? "always" : "never"}
        /*
         * Spark 明确建议关掉 MSAA：对高斯泼溅没有收益，且明显掉帧。
         *
         * `preserveDrawingBuffer` 必须开：打关键帧要把"这一帧的画面"截下来存成图，
         * 而 WebGL 默认在合成后就丢掉绘制缓冲 —— 不开的话 toDataURL 拿到的是一张
         * **全黑图**（见 `SplatCanvasProbe` 的说明）。代价是每帧一次 0.66MP 的拷贝。
         */
        gl={{ antialias: false, preserveDrawingBuffer: true }}
        dpr={[1, 1.75]}
        /*
       * 取景：SOG 的包围盒约 ±3.5，斜对角约 12。fov 50° 下可视高度 ≈ 0.93×距离，
       * 想连边角一起收进来要 8 以上；初始机位放在距离 ≈ 8.9 的斜上方。
       * near 给到 0.05 是为了能贴到桌面看细节（重建产物尺度接近真实米制）。
       */
      camera={{ position: [8.2, 5.2, 9.2], fov: 50, near: 0.05, far: 400 }}>
        <color attach="background" args={["#05080d"]} />
        <SparkLayer
          url={url}
          transform={transform}
          onProgress={(fraction) => {
            setProgress(fraction);
            onProgress?.(fraction);
          }}
          onLoaded={() => {
            setLoaded(true);
            onLoaded?.();
          }}
          onReady={(box) => {
            boxRef.current = box;
            /* 移动速度跟着产物尺度走：最长边的一半，小模型不瞬移、大模型不挪不动 */
            const size = box.isEmpty() ? null : box.getSize(new Vector3());
            if (size) setFlyScale(Math.max(0.5, Math.max(size.x, size.y, size.z) / 2));
            setBoxNonce((value) => value + 1);
          }}
          onError={onError}
        />
        <SplatFitter box={boxRef} nonce={boxNonce + (fitNonce ?? 0) * 1000} fov={50} />
        {/* 第一人称操作：鼠标转视角、WASD 沿朝向走，见 FirstPersonControls 的说明 */}
        <FirstPersonControls scale={flyScale} syncNonce={syncNonce} onUserInput={onUserInput} />
        <SplatCameraRig target={camera} nonce={cameraNonce} onArrived={() => setFlyArrived((value) => value + 1)} />
        {/* 当前机位读数（打关键帧要用，也让讲解人知道自己站在哪） */}
        <SplatPoseTracker poseRef={poseRef} lookAhead={lookAheadFor(flyScale)} textRef={poseTextRef} />
        {/*
          截图的出口 + "画面画出来了没有"的探测。
          `key={url}`：换工单/换模型是一个新产物，探测要重新来一遍（否则上一份的
          "已出画"会被沿用到新模型上，按钮又变成"黑着也能打帧"）。
        */}
        <SplatCanvasProbe key={url} captureRef={captureRef} onPainted={onPainted} active={active} armed={loaded} />
      </Canvas>

      {loaded ? (
        <div className="splat-stage__pose" aria-live="off">
          <span>当前机位</span>
          <b ref={poseTextRef}>—</b>
        </div>
      ) : null}
      {!loaded ? (
        <div className="splat-stage__load">
          <b>正在加载重建产物</b>
          <span className="splat-stage__bar">
            <i style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          </span>
          <em>
            {url.split("/").pop()?.split("?")[0] || "模型文件"} ·{" "}
            {/*
              下载进度是这一页唯一的实时值（31 MB 的产物边下边报），交给
              `NumberAnimation` 平滑滚动，避免百分比一格格跳。`null` 表示还没收到
              第一个进度事件 —— 沿用原来的「连接中」文案，用 `fallback` 表达，
              `%` 与数字本来就在同一个文本节点里，所以走 `suffix`。
            */}
            <NumberAnimation
              value={progress === null ? null : Math.round(progress * 100)}
              suffix="%"
              fallback="连接中"
              /* 百分比是量测值，不是「多少个」：千分位会写出原界面没有的逗号 */
              group={false}
            />
          </em>
        </div>
      ) : null}
    </div>
  );
}

export default SplatStage;

/*
 * 关于「切换视图时的 Uncaught (in promise)」
 * ------------------------------------------------------------------
 * 现象：从高斯重建切到低模示意时，控制台会出现一次 `Uncaught (in promise)`，
 * 没有 message、也没有 stack，`window.addEventListener('unhandledrejection')`
 * 也接不到（它只在 CDP 的 console 事件里露一次脸）。
 *
 * 排查过程：先后去掉了 `SplatMesh.dispose()` 与 `SparkRenderer.dispose()`，
 * 异常都还在 —— 说明它不是某个 dispose 引起的，而是 **Canvas 卸载本身**
 * （R3F 销毁 WebGL 上下文时，Spark 内部还有异步任务在等它）。
 *
 * 结论：不做「切走就卸载」，改成**两边都保持挂载、隐藏的那一边停掉渲染循环**
 * （`frameloop="never"`）。代价是两个 canvas 常驻，换来切换不再往控制台丢
 * 未捕获异常，而且来回切换是瞬时的（重建产物不用重新走 31 MB 的加载）。
 */
