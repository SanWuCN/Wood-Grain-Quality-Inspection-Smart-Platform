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

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { Box3, MathUtils, Vector3 } from "three";
import { useFrame } from "@react-three/fiber";
import { SPLAT_BOUNDS, SPLAT_TRANSFORM, type SplatCamera, type SplatTransform } from "./splat";

function SplatCameraRig({ target }: { target: SplatCamera | null }) {
  if (!target) return null;
  return <SplatCameraRigInner target={target} />;
}

function SplatCameraRigInner({ target }: { target: SplatCamera }) {
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
  }, [target.azimuth, target.polar, target.focus?.x, target.focus?.y, target.focus?.z]);

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
    if (current.t >= 1) anim.current = null;
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
  const distance = (maxDim / 2 / Math.tan(MathUtils.degToRad(fovDeg) / 2)) * 6;
  // 斜俯视：方向固定，避免每次适应视图后机位朝向乱跳
  const direction = new Vector3(0.72, 0.46, 0.92).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(0.02, distance / 400);
  camera.far = distance * 30;
  camera.updateProjectionMatrix();
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
    const current = box.current ?? declaredBounds();
    if (!current) return;
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
  }, [nonce, box.current]);

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
  active = true,
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
   * 是否正在显示。切到低模示意时传 false：
   * Canvas 必须**保持挂载**（只停渲染），原因见文件末尾关于卸载异常的说明。
   */
  active?: boolean;
}) {
  /*
   * 加载态自己维护一份：31 MB 的产物不给进度，演示时会被当成卡死。
   * 覆盖层做在这个组件里而不是甩给调用方 —— 每个用到它的页面都自己写一遍
   * 「转圈 + 百分比」既重复又容易写歪。
   */
  const [progress, setProgress] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** 实测包围盒。就绪后由 SplatFitter 用它取景 */
  const boxRef = useRef<Box3 | null>(null);
  const [boxNonce, setBoxNonce] = useState(0);

  return (
    <div className="splat-stage">
      <Canvas
        // 隐藏时停掉渲染循环：238 万点的排序不能白跑
        frameloop={active ? "always" : "never"}
        // Spark 明确建议关掉 MSAA：对高斯泼溅没有收益，且明显掉帧
        gl={{ antialias: false }}
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
            setBoxNonce((value) => value + 1);
          }}
          onError={onError}
        />
        <SplatFitter box={boxRef} nonce={boxNonce + (fitNonce ?? 0) * 1000} fov={50} />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.12}
          minDistance={0.4}
          maxDistance={40}
        />
        <SplatCameraRig target={camera} />
      </Canvas>

      {!loaded ? (
        <div className="splat-stage__load">
          <b>正在加载重建产物</b>
          <span className="splat-stage__bar">
            <i style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          </span>
          <em>
            gs.sog · 238 万高斯点 ·{" "}
            {progress === null ? "连接中" : `${Math.round(progress * 100)}%`}
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
