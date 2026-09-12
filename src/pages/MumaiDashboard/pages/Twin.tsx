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

import { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useSearchParams } from "react-router";
import { DoubleSide, type Group } from "three";
import { useMumai } from "../context";
import { Panel } from "../Panel";
import { Btn, SourceTag, StateBlock, StatusChip, Toolbar, WaveChart } from "../ui";
import {
  COMPONENTS,
  CURRENT_RISKS,
  HISTORY_RISKS,
  HOTSPOTS,
  SCENES,
  SCENE_BOOKMARKS,
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

function TwinScene({
  selected,
  layers,
  onSelect,
}: {
  selected: string;
  layers: Record<LayerKey, boolean>;
  onSelect: (id: string) => void;
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

      <OrbitControls makeDefault minDistance={3} maxDistance={22} maxPolarAngle={1.45} />
    </Canvas>
  );
}

export default function Twin() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("component") ?? "Z04";
  const { componentById, domainPending, toast, pushEvent } = useMumai();

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
  const waveform = WAVEFORMS[0];
  const historyRisk = HISTORY_RISKS.find((item) => item.title.startsWith(selected));

  const selectComponent = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("component", id);
    setParams(next, { replace: true });
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
            toast("视角已复位到殿内总览", "info");
          }}>
          复位
        </Btn>
      </Toolbar>

      <div className="twin-layout">
        {/* 主视图：占页面 2/3 以上 */}
        <div className="twin-stage">
          <TwinScene selected={selected} layers={layers} onSelect={selectComponent} />

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
              onClick={() => {
                toast(`场景 ${scene.id} 已发布，各客户端收到通知`, "ok");
                pushEvent(`发布场景 ${scene.id}`, "ok");
              }}>
              检查并发布
            </Btn>
          </Panel>

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

            <h4 className="sub">雷达回波频谱</h4>
            <WaveChart
              points={waveform?.points ?? []}
              unit={waveform?.unit}
              axisLabel={waveform?.axisLabel}
              markers={waveform?.markers ?? []}
            />

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
