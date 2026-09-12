/**
 * 数字孪生（`/twin`）
 *
 * PRD 3.3：
 *   - 场景库显示历史与本轮场景、来源视频、关键帧、版本与发布状态；
 *     全栈上传后为「待检查」，架构师检查并发布
 *   - 孪生主视图优先占页面 2/3 以上，可自由移动、旋转、复位，按 Z01–Z04 快速跳转
 *   - 图层分别开关：构件标签 / 表面疑点 / 雷达响应 / 巡检路线 / 历史记录
 *   - 点 Z04 下部热点 → 展开原图、回波、初筛、融合结果与历史任务
 *   - 同构件历史与当前可并排对比，支持视角书签
 *   - 未完成坐标标定时以柱号与人工热点对应；内部异常以「示意响应区域」表达，
 *     不把手绘虫道、深度或承载能力当成扫描测量
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useSearchParams } from "react-router";
import { DoubleSide, MathUtils, Vector3, type Group } from "three";
import { useMumai } from "../context";
import { permissionHint } from "../auth";
import { Panel } from "../Panel";
import { Btn, PermNote, SourceTag, StateBlock, StatusChip, Toolbar, WaveChart } from "../ui";
import {
  COMPONENTS,
  CURRENT_RISKS,
  HISTORY_RISKS,
  HOTSPOTS,
  SCAN_BATCHES,
  SCENES,
  SCENE_BOOKMARKS,
  TWIN_ROUTE,
  WAVEFORMS,
} from "../seed/scenario";

const LAYERS = [
  { key: "labels", label: "构件标签" },
  { key: "surface", label: "表面疑点" },
  { key: "radar", label: "雷达响应" },
  { key: "route", label: "巡检路线" },
  { key: "history", label: "历史记录" },
] as const;

type LayerKey = (typeof LAYERS)[number]["key"];

/**
 * 场地：地砖 + 四周围栏 + 北侧照壁 —— 对齐参考图（四柱立于方形石台，
 * 三面木栏杆、一面照壁，地面是方形石板）。
 */
function Courtyard() {
  // 四柱按 2×2 布置于 ±2.2，院子略大于柱阵，留出过道
  const half = 3.7;
  const railColor = "#7a5a3c";

  /** 一段栏杆：上下横杆 + 立柱 */
  const Rail = ({ position, rotation, length }: {
    position: [number, number, number];
    rotation?: [number, number, number];
    length: number;
  }) => (
    <group position={position} rotation={rotation}>
      <mesh position={[0, 0.62, 0]}>
        <boxGeometry args={[length, 0.09, 0.1]} />
        <meshStandardMaterial color={railColor} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.3, 0]}>
        <boxGeometry args={[length, 0.07, 0.08]} />
        <meshStandardMaterial color={railColor} roughness={0.85} />
      </mesh>
      {Array.from({ length: Math.max(2, Math.round(length / 0.7)) }, (_, i) => {
        const step = length / Math.max(2, Math.round(length / 0.7));
        return (
          <mesh key={i} position={[-length / 2 + step * (i + 0.5), 0.45, 0]}>
            <boxGeometry args={[0.06, 0.5, 0.06]} />
            <meshStandardMaterial color={railColor} roughness={0.9} />
          </mesh>
        );
      })}
    </group>
  );

  return (
    <group>
      {/* 地面石板 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <planeGeometry args={[half * 2, half * 2]} />
        <meshStandardMaterial color="#6c6a63" roughness={0.95} />
      </mesh>
      {/* 石板缝：横向 + 纵向若干条 */}
      {Array.from({ length: 7 }, (_, i) => {
        const pos = -half + (i + 1) * ((half * 2) / 8);
        return (
          <group key={i}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[pos, 0.03, 0]}>
              <planeGeometry args={[0.03, half * 2]} />
              <meshBasicMaterial color="#4a4842" />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, pos]}>
              <planeGeometry args={[half * 2, 0.03]} />
              <meshBasicMaterial color="#4a4842" />
            </mesh>
          </group>
        );
      })}

      {/* 台基 */}
      <mesh position={[0, -0.06, 0]}>
        <boxGeometry args={[half * 2 + 0.4, 0.12, half * 2 + 0.4]} />
        <meshStandardMaterial color="#8a8880" roughness={0.9} />
      </mesh>

      {/* 三面木栏杆（南 / 东 / 西） */}
      <Rail position={[0, 0, half]} length={half * 2} />
      <Rail position={[half, 0, 0]} rotation={[0, Math.PI / 2, 0]} length={half * 2} />
      <Rail position={[-half, 0, 0]} rotation={[0, Math.PI / 2, 0]} length={half * 2} />

      {/* 北侧照壁：墙身 + 花窗 */}
      <group position={[0, 0, -half]}>
        <mesh position={[0, 1.15, 0]}>
          <boxGeometry args={[half * 2, 2.3, 0.24]} />
          <meshStandardMaterial color="#b9b3a6" roughness={0.95} />
        </mesh>
        {/* 墙顶瓦檐 */}
        <mesh position={[0, 2.36, 0]}>
          <boxGeometry args={[half * 2 + 0.3, 0.14, 0.44]} />
          <meshStandardMaterial color="#3f3a34" roughness={0.8} />
        </mesh>
        {/* 花窗：外框 + 井字棂条 */}
        <mesh position={[0.2, 1.2, 0.14]}>
          <boxGeometry args={[2.1, 1.5, 0.06]} />
          <meshStandardMaterial color="#5d5346" roughness={0.9} />
        </mesh>
        <mesh position={[0.2, 1.2, 0.18]}>
          <boxGeometry args={[1.86, 1.26, 0.03]} />
          <meshStandardMaterial color="#1b1712" roughness={1} />
        </mesh>
        {[-0.62, -0.21, 0.2, 0.61].map((offset) => (
          <mesh key={`v${offset}`} position={[0.2 + offset * 0.75, 1.2, 0.2]}>
            <boxGeometry args={[0.04, 1.26, 0.03]} />
            <meshStandardMaterial color="#6d6152" roughness={0.9} />
          </mesh>
        ))}
        {[-0.42, 0, 0.42].map((offset) => (
          <mesh key={`h${offset}`} position={[0.2, 1.2 + offset, 0.2]}>
            <boxGeometry args={[1.86, 0.04, 0.03]} />
            <meshStandardMaterial color="#6d6152" roughness={0.9} />
          </mesh>
        ))}
        {/* 墙脚绿化 */}
        {[-1.6, -0.9, 0.9, 1.7].map((x) => (
          <mesh key={x} position={[x, 0.16, 0.2]}>
            <sphereGeometry args={[0.26, 10, 10]} />
            <meshStandardMaterial color="#3d5236" roughness={1} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** 一根木柱：柱础 + 柱身 + 可选图层标记（对齐参考图的石础木柱） */
function Column({
  x,
  z,
  selected,
  showSurface,
  showRadar,
  onSelect,
}: {
  x: number;
  z: number;
  selected: boolean;
  showSurface: boolean;
  showRadar: boolean;
  onSelect: () => void;
}) {
  const boom = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (!boom.current) return;
    boom.current.position.y = Math.sin(clock.elapsedTime * 0.9 + x) * 0.05;
  });

  return (
    <group position={[x, 0, z]}>
      {/* 柱础：方形石座 */}
      <mesh position={[0, 0.13, 0]}>
        <boxGeometry args={[0.78, 0.26, 0.78]} />
        <meshStandardMaterial color="#8f8b82" roughness={0.92} />
      </mesh>
      <mesh position={[0, 0.32, 0]}>
        <cylinderGeometry args={[0.42, 0.46, 0.14, 18]} />
        <meshStandardMaterial color="#7d7970" roughness={0.92} />
      </mesh>

      {/* 柱身：偏木色，选中时提亮 */}
      <mesh position={[0, 1.75, 0]} onClick={onSelect}>
        <cylinderGeometry args={[0.34, 0.37, 2.8, 22]} />
        <meshStandardMaterial
          color={selected ? "#b08a5e" : "#8a6a48"}
          roughness={0.78}
          metalness={0.06}
          emissive={selected ? "#2a6ea8" : "#120c06"}
          emissiveIntensity={selected ? 0.5 : 0.2}
        />
      </mesh>

      {/* 表面疑点：示意响应区域，不画确定的虫道形状 */}
      {showSurface ? (
        <mesh position={[0.37, 1.35, 0.08]} rotation={[0, 0, Math.PI / 2]}>
          <circleGeometry args={[0.15, 18]} />
          <meshBasicMaterial color="#ff8a5c" transparent opacity={0.85} side={DoubleSide} />
        </mesh>
      ) : null}

      {/* 雷达响应区域：半透明圆柱段 */}
      {showRadar ? (
        <mesh position={[0, 1.45, 0]}>
          <cylinderGeometry args={[0.44, 0.44, 0.74, 22, 1, true]} />
          <meshBasicMaterial color="#4fd8ff" transparent opacity={0.22} side={DoubleSide} />
        </mesh>
      ) : null}

      {/* 柱头浮动指示点 */}
      <group ref={boom}>
        <mesh position={[0, 3.35, 0]}>
          <sphereGeometry args={[0.08, 10, 10]} />
          <meshBasicMaterial color={selected ? "#ffffff" : "#7fd6ff"} />
        </mesh>
      </group>
    </group>
  );
}

/** 一次运镜请求：目标机位。只有在用户点书签 / 换构件 / 复位时才产生 */
type CameraTarget = {
  azimuth: number;
  polar: number;
  /** 目标构件的场景坐标；为空表示看整个院子 */
  focus: { x: number; z: number } | null;
};

/**
 * 相机机位控制。
 *
 * 原来「复位」和视角书签只弹一个 toast，相机一动不动 —— 用户点了「复位」，
 * 画面没变，等于这个按钮是假的。这里按书签的方位角 / 俯仰角反解相机位置，
 * 用 600ms 平滑过渡过去（直接跳会很晕，也看不出「移动了」）。
 *
 * 角度口径：`polar` 是从 +Y 轴量起的极角（78° ≈ 平视柱身下部，62° ≈ 略俯视），
 * `azimuth` 绕 Y 轴，0° 朝 +Z（殿门方向，即从南往北看）。
 * 目标点取「该构件柱身中部」，总览书签（componentId 为空）取院子中心。
 */
function CameraRig({ target }: { target: CameraTarget | null }) {
  // 没有运镜请求时直接不挂载：页面保持 Canvas 自己的开场取景。
  // 这里刻意不用「首次跳过」的 ref —— StrictMode 会把挂载期 effect 跑两遍，
  // 第二遍就会当成用户操作而运镜（实测过：只点了个图层开关，镜头自己动了）。
  // 用一个显式的请求状态，「相机什么时候动」就只有用户动作一个来源。
  if (!target) return null;
  return <CameraRigInner target={target} />;
}

function CameraRigInner({ target }: { target: CameraTarget }) {
  const { azimuth, polar, focus } = target;
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
    const toTarget = focus ? new Vector3(focus.x, 1.45, focus.z) : new Vector3(0, 1.2, 0);
    /*
     * 取景距离：看单根柱子 5.2、看整座院子 11。
     *
     * 距离不由书签给 —— `SCENE_BOOKMARKS` 只有方位角与俯仰角，那是**方向**；
     * 多远由这里按「看什么」定：柱身高 2.8，fov 42° 下距离 5.2 时可视高度约 4.0，
     * 柱身加柱础正好占满又不顶格；院子 7.4 见方，总览要 11 才收得进栏杆。
     * 7.5 的时候南排两根柱子横在镜头和照壁之间，近处几乎怼到脸上，
     * 那不是「殿内总览」。
     */
    const distance = focus ? 5.2 : 11;
    const phi = MathUtils.degToRad(polar);
    const theta = MathUtils.degToRad(azimuth);
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
    // camera / controls 是稳定引用，不进依赖数组，否则每次渲染都会重启动画
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [azimuth, polar, focus?.x, focus?.z]);

  useFrame((_, delta) => {
    const current = anim.current;
    if (!current) return;
    current.t = Math.min(1, current.t + delta / 0.6);
    // smoothstep：两端慢、中间快，比线性像「运镜」
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

/** 巡航线图层：示意路线 + 航点编号标记 */
function RouteLayer() {
  const points = TWIN_ROUTE.map((item) => new Vector3(item.x, 0.06, item.z));
  const geometry = useMemo(() => {
    const positions: number[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      positions.push(points[i].x, points[i].y, points[i].z);
      positions.push(points[i + 1].x, points[i + 1].y, points[i + 1].z);
    }
    return positions;
    // points 由常量种子推出，长度固定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <group>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[new Float32Array(geometry), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#38e0c8" transparent opacity={0.85} />
      </lineSegments>
      {TWIN_ROUTE.map((item) => (
        <group key={item.id} position={[item.x, 0.05, item.z]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.11, 0.15, 20]} />
            <meshBasicMaterial color="#38e0c8" transparent opacity={0.9} side={DoubleSide} />
          </mesh>
          <mesh position={[0, 0.42, 0]}>
            <sphereGeometry args={[0.05, 8, 8]} />
            <meshBasicMaterial color="#8ff5e4" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** 历史记录图层：有历史处理记录的柱位标一圈琥珀色环 */
function HistoryLayer({ componentIds }: { componentIds: string[] }) {
  return (
    <group>
      {COMPONENTS.filter((item) => componentIds.includes(item.id)).map((item) => (
        <group key={item.id} position={[item.scene.x, 0.04, item.scene.z]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.62, 0.72, 40]} />
            <meshBasicMaterial color="#f2b84b" transparent opacity={0.8} side={DoubleSide} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function TwinScene({
  selected,
  layers,
  onSelect,
  camera,
  historyComponents,
}: {
  selected: string;
  layers: Record<LayerKey, boolean>;
  onSelect: (id: string) => void;
  camera: CameraTarget | null;
  historyComponents: string[];
}) {
  return (
    <Canvas shadows camera={{ position: [5.4, 3.8, 6.4], fov: 42 }} dpr={[1, 2]}>
      <color attach="background" args={["#02060e"]} />
      <fog attach="fog" args={["#02060e", 13, 28]} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[4, 8, 6]} intensity={2.1} />
      <directionalLight position={[-6, 4, -5]} intensity={0.7} color="#3f7fd0" />

      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#14181c" roughness={1} />
      </mesh>

      <Courtyard />

      {COMPONENTS.map((component) => (
        <Column
          key={component.id}
          x={component.scene.x}
          z={component.scene.z}
          selected={selected === component.id}
          showSurface={layers.surface}
          showRadar={layers.radar}
          onSelect={() => onSelect(component.id)}
        />
      ))}

      {layers.route ? <RouteLayer /> : null}
      {layers.history ? <HistoryLayer componentIds={historyComponents} /> : null}

      <OrbitControls makeDefault minDistance={2} maxDistance={22} maxPolarAngle={1.45} />
      <CameraRig target={camera} />
    </Canvas>
  );
}

export default function Twin() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("component") ?? "Z04";
  const { componentById, domainPending, toast, pushEvent, can } = useMumai();

  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    labels: true,
    surface: true,
    radar: true,
    route: false,
    history: true,
  });
  const [sceneId, setSceneId] = useState(SCENES[1]?.id ?? SCENES[0].id);
  const [bookmarkId, setBookmarkId] = useState(SCENE_BOOKMARKS[0]?.id ?? "");
  const [sideBySide, setSideBySide] = useState(true);

  const scene = useMemo(() => SCENES.find((item) => item.id === sceneId) ?? SCENES[0], [sceneId]);
  const component = componentById(selected);
  const hotspot = HOTSPOTS.find((item) => item.componentId === selected) ?? HOTSPOTS[0];
  const risks = CURRENT_RISKS.filter((item) => item.componentId === selected);
  const historyRisk = HISTORY_RISKS.find((item) => item.title.startsWith(selected));

  /**
   * 波形按**当前构件**取，不再永远是 `WAVEFORMS[0]`。
   *
   * 原来写死 `WAVEFORMS[0]`（Z04 初扫 wf-Z04-001），于是：换到 Z01/Z02/Z03
   * 看到的还是 Z04 的频谱；而复扫批次 wf-Z04-002 的另两处标记（0.71 / 0.84）
   * 在孪生页永远看不到 —— 那恰恰是复扫要看的三个异常段。
   *
   * 现在按构件的批次列表给一个批次选择器，默认选**最后一个**（复扫在后），
   * 没有波形的构件显示未采集，不拿别的构件的波形顶上。
   */
  const batches = useMemo(
    () => SCAN_BATCHES.filter((item) => item.componentId === selected),
    [selected],
  );
  const [waveBatchId, setWaveBatchId] = useState<string>("");

  const waveBatch = useMemo(() => {
    const picked = batches.find((item) => item.batchId === waveBatchId);
    // 默认取最后一个批次：同一构件有初扫与复扫时，复扫是更新的那份
    return picked ?? batches[batches.length - 1] ?? null;
  }, [batches, waveBatchId]);

  const waveform = useMemo(
    () => (waveBatch ? WAVEFORMS.find((item) => item.batchId === waveBatch.batchId) ?? null : null),
    [waveBatch],
  );

  /** 有历史处理记录的构件（历史图层在场景里标出来） */
  const historyComponents = useMemo(
    () => HOTSPOTS.filter((item) => item.history.length > 0).map((item) => item.componentId),
    [],
  );

  /**
   * 相机运镜请求。初始为 null = 保持开场取景，不做任何运镜。
   *
   * 只有三个来源会设置它：点视角书签、切构件、点复位。
   * 用一个状态而不是「书签变了就跟随」，是为了让「相机什么时候动」
   * 只有一个来源 —— 挂载、改图层、切场景都不该动镜头。
   */
  const [camera, setCamera] = useState<CameraTarget | null>(null);

  /** 按书签算一次目标机位并入队运镜 */
  const flyToBookmark = (id: string) => {
    const item = SCENE_BOOKMARKS.find((entry) => entry.id === id) ?? SCENE_BOOKMARKS[0];
    const target = item.componentId ? componentById(item.componentId) : null;
    setCamera({
      azimuth: item.azimuth,
      polar: item.polar,
      focus: target ? { x: target.scene.x, z: target.scene.z } : null,
    });
  };

  const selectComponent = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("component", id);
    setParams(next, { replace: true });
    // 换构件要清掉批次选择，否则会带着上一个构件的 batchId 去查（查不到就退回默认）
    setWaveBatchId("");
    // 当前构件变了，机位跟着切到它自己的默认书签：否则从 Z04 点到 Z01，
    // 相机还停在 Z04，读数写着 Z01，两边对不上
    const own = SCENE_BOOKMARKS.find((item) => item.componentId === id);
    if (own) {
      setBookmarkId(own.id);
      flyToBookmark(own.id);
    }
  };

  return (
    <div className="page page--twin">
      <Toolbar
        note={
          <>
            <SourceTag label={scene.sourceMode === "replay" ? "演示回放" : scene.sourceMode} />
            <span>
              场景 {scene.id} · {scene.version} · {scene.format}
            </span>
            <span>未完成坐标标定：以柱号与人工热点对应，不让车辆直接追踪三维点击位置</span>
          </>
        }>
        {COMPONENTS.map((item) => (
          <Btn key={item.id} active={selected === item.id} onClick={() => selectComponent(item.id)}>
            {item.id}
          </Btn>
        ))}
        <Btn
          onClick={() => {
            setBookmarkId("BM-hall-overview");
            flyToBookmark("BM-hall-overview");
            toast("视角已复位到殿内总览", "info");
          }}>
          复位
        </Btn>
      </Toolbar>

      <div className="twin-layout">
        {/* 主视图：占页面 2/3 以上 */}
        <div className="twin-stage">
          <TwinScene
            selected={selected}
            layers={layers}
            onSelect={selectComponent}
            camera={camera}
            historyComponents={historyComponents}
          />

          <div className="twin-layers">
            <small>图层</small>
            {LAYERS.map((layer) => (
              <label key={layer.key} className="twin-layer">
                <input
                  type="checkbox"
                  checked={layers[layer.key]}
                  onChange={() =>
                    setLayers((current) => ({ ...current, [layer.key]: !current[layer.key] }))
                  }
                />
                {layer.label}
              </label>
            ))}
          </div>

          {layers.labels ? (
            <div className="twin-labels">
              {COMPONENTS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={selected === item.id ? "is-active" : ""}
                  onClick={() => selectComponent(item.id)}>
                  {item.name}
                  <em>
                    {item.radarScore !== null ? `回波 ${item.radarScore.toFixed(2)}` : "未采集"}
                  </em>
                </button>
              ))}
            </div>
          ) : null}

          <div className="twin-bookmarks">
            {SCENE_BOOKMARKS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={bookmarkId === item.id ? "is-active" : ""}
                onClick={() => {
                  setBookmarkId(item.id);
                  flyToBookmark(item.id);
                  toast(`切换到视角书签 ${item.label}`, "info");
                }}>
                {item.label}
                <em>
                  方位 {item.azimuth}° / 俯仰 {item.polar}°
                </em>
              </button>
            ))}
          </div>

          <div className="twin-readout">
            <span>当前构件 {component?.id ?? selected}</span>
            <span>测区 {component?.zoneId ?? "—"}</span>
            <span>书签 {SCENE_BOOKMARKS.find((item) => item.id === bookmarkId)?.label ?? "—"}</span>
          </div>
        </div>

        {/* 侧栏：场景库 + 热点详情 */}
        <div className="twin-side">
          <Panel title="场景库" extra={<span className="muted">{SCENES.length} 个</span>}>
            <ul className="scene-list">
              {SCENES.map((item) => (
                <li key={item.id} className={item.id === sceneId ? "is-active" : ""}>
                  <button type="button" onClick={() => setSceneId(item.id)}>
                    <b>{item.title}</b>
                    <span>
                      {item.round} · {item.version} · 关键帧 {item.keyframes}
                    </span>
                    <em>
                      {item.sourceVideo} · {item.updatedAt}
                    </em>
                  </button>
                  <StatusChip
                    text={item.published}
                    tone={item.published === "已发布" ? "ok" : "warn"}
                  />
                </li>
              ))}
            </ul>
            <Btn
              tone="primary"
              disabled={!can("scene:publish")}
              title={
                can("scene:publish")
                  ? "检查该场景并发布版本，通知各客户端"
                  : permissionHint("scene:publish")
              }
              onClick={() => {
                toast(`场景 ${scene.id} 已发布，各客户端收到通知`, "ok");
                pushEvent(`发布场景 ${scene.id}`, "ok");
              }}>
              检查并发布
            </Btn>
          </Panel>
          <PermNote permissions={["scene:publish"]} />

          <Panel
            title={`热点详情 · ${component?.id ?? selected}`}
            extra={<StatusChip text={hotspot?.zoneId ?? "—"} tone="info" />}>
            {hotspot ? (
              <div className="hotspot">
                <dl className="kv">
                  <div>
                    <dt>构件</dt>
                    <dd>{component?.name ?? selected}</dd>
                  </div>
                  <div>
                    <dt>部位</dt>
                    <dd>{component?.part ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>原图</dt>
                    <dd>{hotspot.image.name}</dd>
                  </div>
                  <div>
                    <dt>回波</dt>
                    <dd>
                      {hotspot.echo.amplitude.toFixed(2)} {hotspot.echo.unit}
                    </dd>
                  </div>
                  <div>
                    <dt>端侧初筛</dt>
                    <dd>{hotspot.screening.material}</dd>
                  </div>
                  <div>
                    <dt>融合规则</dt>
                    <dd>{hotspot.fusion.ruleVersion}</dd>
                  </div>
                </dl>
                <p className="note">{hotspot.image.note}</p>
                <p className="note">{hotspot.echo.note}</p>
                <ul className="hotspot-branches">
                  {hotspot.fusion.branches.map((branch) => (
                    <li key={branch}>{branch}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <StateBlock kind="empty" title="该构件暂无热点" />
            )}

            {risks.length ? (
              <>
                <h4 className="sub">融合结果（规则判定，不做分数相加平均）</h4>
                <ul className="hotspot-risks">
                  {risks.map((risk) => (
                    <li key={risk.id}>
                      <b>{risk.id}</b>
                      <span>{risk.label}</span>
                      <StatusChip
                        text={risk.priority}
                        tone={risk.priority === "优先复核" ? "danger" : "warn"}
                      />
                      <em>
                        {risk.branch} · {risk.score.toFixed(2)} · 质量 {risk.quality}
                      </em>
                      <p>{risk.recommendation}</p>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <StateBlock
                kind="empty"
                title="该构件本轮无异常"
                hint="未精扫部分不写成内部正常。"
              />
            )}

            {domainPending ? (
              <StateBlock
                kind="partial"
                title="适用域待核验"
                hint="该批次诊断输出已冻结；内部异常以示意响应区域表达，不代表实际虫道深度与形状。"
              />
            ) : null}

            <h4 className="sub">
              雷达回波频谱
              {waveBatch ? (
                <span className="muted">
                  {waveBatch.batchId} · {waveBatch.round}
                </span>
              ) : null}
            </h4>
            {batches.length > 1 ? (
              <div className="twin-wavepick">
                {batches.map((item) => (
                  <button
                    key={item.batchId}
                    type="button"
                    className={waveBatch?.batchId === item.batchId ? "is-active" : ""}
                    onClick={() => setWaveBatchId(item.batchId)}>
                    {item.round}
                    <em>{item.batchId}</em>
                  </button>
                ))}
              </div>
            ) : null}
            {waveform ? (
              <WaveChart
                points={waveform.points}
                unit={waveform.unit}
                axisLabel={waveform.axisLabel}
                markers={waveform.markers}
              />
            ) : (
              <StateBlock
                kind="empty"
                title="该构件未采集回波"
                hint="只有做过手持毫米波扫描的构件才有频谱。"
              />
            )}

            {/*
              热点处理记录。`HOTSPOTS[].history` 一直有数据（Z04 三条、Z01/Z03 各一条），
              但此前没有任何页面渲染它 —— 点开热点看不到「这根柱子以前处理过什么」，
              而 PRD 3.3 要求热点展开后要给历史任务。
            */}
            <h4 className="sub">
              处理记录
              {hotspot?.history.length ? (
                <span className="muted">{hotspot.history.length} 条</span>
              ) : null}
            </h4>
            {hotspot?.history.length ? (
              <ol className="hotspot-history">
                {hotspot.history.map((item) => (
                  <li key={item.at + item.text}>
                    <time>{item.at}</time>
                    <b>{item.operator}</b>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <StateBlock kind="empty" title="该构件暂无处理记录" />
            )}

            <h4 className="sub">历史与当前对比</h4>
            <label className="twin-compare">
              <input
                type="checkbox"
                checked={sideBySide}
                onChange={(event) => setSideBySide(event.target.checked)}
              />
              并排查看同一构件的历史与当前状态
            </label>
            {sideBySide ? (
              <div className="twin-diff">
                <article>
                  <header>历史（2026-05）</header>
                  <strong>{historyRisk?.title ?? "无历史记录"}</strong>
                  <span>{historyRisk?.status ?? "—"}</span>
                  <em>{historyRisk?.next ?? ""}</em>
                </article>
                <article>
                  <header>当前（2026-09）</header>
                  <strong>{risks[0]?.label ?? "未发现异常"}</strong>
                  <span>{risks[0]?.priority ?? "—"}</span>
                  <em>
                    {risks.length} 处响应区 · 规则版本 {hotspot?.fusion.ruleVersion ?? "—"}
                  </em>
                </article>
              </div>
            ) : null}
          </Panel>
        </div>
      </div>
    </div>
  );
}
