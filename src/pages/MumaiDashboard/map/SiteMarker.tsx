/**
 * 业务点位标记（已勘察 / 已检测 / 有风险 / 有工单或任务 的古建点位）
 *
 * 每个点位由三层组成，各解决一个可读性问题：
 *   1. 3D 标记（地面光斑 + 旋转光圈 + 光柱）：给出「这里有个点位」的位置感，
 *      随地图缩放，与地图的装饰语言一致；
 *   2. 屏幕定尺的实心锚点圆（`Anchor`）：**状态色的唯一可靠载体**。地图是一块
 *      被 DEM 贴图铺亮的板，纯发光体压在亮地表上会被冲淡，只有屏幕定尺的
 *      实心圆点能在任何机位下读出红 / 黄 / 绿 / 蓝（规范 §5.2）；
 *   3. 可选文字标签 + 引线（`SiteLabel` / `Leader`）：上海密集区把标签推开后，
 *      用引线指回点位，避免「标签不知道属于谁」。
 *
 * 所有材质 `depthTest: false`（见 NO_DEPTH）：点位贴在挤出地图的顶面上，
 * 俯视时机位会把地图本身挡在点位前面 —— 不开这个开关，屏幕上将一个点位都看不到。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import styled from "styled-components";
import {
  AdditiveBlending,
  Camera,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  Object3D,
  ShaderMaterial,
  Vector3,
} from "three";
import { mapUniforms } from "./materials";
import { STATUS_COLOR } from "./status";
import type { SiteStatus } from "../data";

/** 一圈柔和的实心光斑，用来做地面光圈 */
let haloTexture: CanvasTexture | null = null;
function getHaloTexture() {
  if (haloTexture) return haloTexture;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.25, "rgba(255,255,255,0.5)");
  g.addColorStop(0.55, "rgba(255,255,255,0.14)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  haloTexture = new CanvasTexture(canvas);
  haloTexture.needsUpdate = true;
  return haloTexture;
}

/**
 * 点位的「锚点」：屏幕定尺的实心状态圆点。
 *
 * 为什么需要它：地图是一块被 DEM 贴图铺亮的板，3D 标记（光斑 / 光圈 / 光柱）
 * 都是半透明的发光体，压在亮地表上会被冲淡 —— 实测全国图上 27 个点位里
 * 能读出来的状态色只有几个像素，规范 §5.2 要求的「红=风险 / 黄=工单」
 * 根本看不出来。屏幕定尺的实心圆点不受缩放、距离、地表亮度影响，
 * 是唯一能保证「任何机位下都能一眼看出这是什么状态」的做法。
 *
 * 上海模式已经有点位名标签（标签左边框就是状态色），所以那里不再画锚点，
 * 避免一个点位出现两套标记；全国模式没有文字标签，锚点就是唯一的识别方式。
 */
const Anchor = styled.div`
  display: block;
  width: 10px;
  height: 10px;
  border: 2px solid rgba(232, 251, 255, 0.92);
  border-radius: 50%;
  box-sizing: border-box;
  transition: transform 120ms linear;
`;

/**
 * 引线短棒：从点位指向被推开的标签。
 *
 * 上海模式下标签会被推离点位几十像素（见 `BusinessMarkers` 的散开逻辑），
 * 没有这根线时「这个标签到底属于哪个点」会读不出来。线长固定 16px 左右、
 * 沿偏移方向摆放，只作指向提示，不追求和标签精确对接。
 */
const Leader = styled.span`
  display: block;
  width: 18px;
  height: 1px;
  background: linear-gradient(
    90deg,
    rgba(232, 251, 255, 0.75),
    rgba(232, 251, 255, 0.08)
  );
`;

/** 标签统一给一个左边框（状态色），锚点与标签共用同一个色源 */
const SiteLabel = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 3px var(--space-2);
  transform: translateY(-2px);
  background: var(--panel-surface);
  border-left: 2px solid var(--primary);
  white-space: nowrap;
  font-size: var(--fs-aux);
  line-height: 1.4;
  color: var(--text-primary);
  transition: background 120ms linear;

  strong {
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  small {
    font-family: var(--font-data);
    font-size: var(--fs-aux);
    color: var(--text-tertiary);
    letter-spacing: 0.02em;
  }

  /* 悬停：底色提亮，和「已经点开」的 is-selected 区分开 */
  &.is-hovered {
    background: var(--bg-panel-hover);
  }

  /* 选中：最高优先级，用 2px 主色投影把左边框加粗到 4px（不占布局） */
  &.is-selected {
    background: var(--bg-emphasis);
    box-shadow: -2px 0 0 0 var(--primary);
  }
`;

/**
 * 点位标记一律 `depthTest: false`：只按绘制顺序显示，不参与深度遮挡。
 *
 * 为什么必须这样：地图是一块**挤出**的板，点位贴在顶面上（z = slabDepth），
 * 而相机是俯视 + 旋转的。俯角下板体本身会挡在点位前面 —— 这也是
 * 「地图上明明有 27 个点位、屏幕上却一个都看不到、关掉地图层之后点位全出来」
 * 的原因（所有点位都被地图自己遮住了）。
 *
 * 业务点位是导航级的元素，必须在任何机位下都读得到；同图层内仍按
 * `renderOrder` 排序，所以点位之间、点位与标签之间的前后关系不变。
 */
const NO_DEPTH = { depthTest: false, depthWrite: false } as const;

/** 光柱：底部亮、顶部透明，外加一层沿高度流动的亮块 */
function createBeamMaterial(color: Color) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: color },
      uOpacity: mapUniforms.uOpacity,
      uTime: mapUniforms.uTime,
      uIntensity: { value: 1 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uIntensity;
      void main() {
        // 水平方向中间亮两侧虚
        float across = pow(1.0 - abs(vUv.x - 0.5) * 2.0, 1.8);
        // 垂直方向：底部实、顶部淡出
        float along = pow(1.0 - vUv.y, 2.2);
        // 向上流动的亮块
        float flow = 0.75 + 0.25 * sin((vUv.y * 6.0 - uTime * 1.6) * 3.14159);
        float a = across * along * flow * uIntensity * uOpacity;
        gl_FragColor = vec4(uColor * (0.9 + flow * 0.6), a * 1.35);
        if (a < 0.004) discard;
      }
    `,
  });
}

export interface SiteMarkerProps {
  name: string;
  caption?: string;
  position: [number, number, number];
  status: SiteStatus;
  selected?: boolean;
  current?: boolean;
  /** 缩放，上海模式下点位要更大一点 */
  scale?: number;
  /**
   * 标签在屏幕空间里的偏移（px）。上海 12 个点位里松江 / 普陀 / 徐汇 / 静安
   * 挤在市中心约 50×50px 的一小块，标签会整片糊在一起；由调用方按
   * 「离所有点位重心的方向」把标签推出去，点位本身不动、也不改标签去重叠
   * 算法（那份在 `mapDemo/labels.ts` 里，有并行任务在改）。
   */
  labelOffset?: [number, number];
  onSelect?: () => void;
}

/**
 * 拾取球半径（未缩放前）。
 *
 * 原值是写死的 `0.42`：SiteMarker 内部尺寸按 Demo2 四川地图（投影半径约 6）
 * 设计，全国图上 `scale ≈ 1.6`、上海图上是另一个量级，写死半径会出现
 * 「上海好点、全国点不中」。现在乘以同一个 `scale`，命中范围跟着标记一起缩放，
 * 再补一个最小值，保证任何模式下都还有可点的面积。
 */
const PICK_RADIUS = 0.42;
const PICK_RADIUS_MIN = 0.22;

/** 默认的标签像素偏移：不传时和原来的行为完全一致 */
const NO_LABEL_OFFSET: [number, number] = [0, 0];

/**
 * 标签定位：与 drei `Html` 的默认算法逐行一致，只在结果上叠加像素偏移。
 * （drei 的 `HtmlProps` 没有 `offset` 这个 prop，只能自己给 `calculatePosition`。）
 * 用同一条公式保证「偏移为 0 时画面与改动前完全相同」，不引入新的取景差异。
 */
function makeLabelPosition(
  offset: [number, number],
): (el: Object3D, camera: Camera, size: { width: number; height: number }) => [number, number] {
  return (el, camera, size) => {
    const objectPos = new Vector3().setFromMatrixPosition(el.matrixWorld);
    objectPos.project(camera);
    const widthHalf = size.width / 2;
    const heightHalf = size.height / 2;
    return [
      objectPos.x * widthHalf + widthHalf + offset[0],
      -(objectPos.y * heightHalf) + heightHalf + offset[1],
    ];
  };
}

export function SiteMarker(props: SiteMarkerProps) {
  const { position, status, selected = false, current = false, scale = 1 } = props;
  const color = useMemo(() => new Color(STATUS_COLOR[status]), [status]);
  const pulse = useRef<Group>(null!);
  const outer = useRef<Mesh>(null!);
  const core = useRef<Group>(null!);
  const halo = useMemo(() => getHaloTexture(), []);
  const beamMaterial = useMemo(() => createBeamMaterial(color), [color]);
  const labelOffset = props.labelOffset ?? NO_LABEL_OFFSET;
  const hasOffset = labelOffset[0] !== 0 || labelOffset[1] !== 0;
  const labelPosition = useMemo(() => makeLabelPosition(labelOffset), [labelOffset]);
  /** 引线放在「点位 → 标签」路径的 45% 处，只做指向提示 */
  const leaderOffset = useMemo(
    () => [labelOffset[0] * 0.45, labelOffset[1] * 0.45] as [number, number],
    [labelOffset],
  );
  const leaderPosition = useMemo(() => makeLabelPosition(leaderOffset), [leaderOffset]);
  /** 悬停反馈：指针变手型 + 标签高亮（同时给光柱加一点亮度） */
  const [hovered, setHovered] = useState(false);
  const pickRadius = Math.max(PICK_RADIUS_MIN, PICK_RADIUS * scale);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (pulse.current) {
      const s = 1 + ((t * 0.9 + position[0]) % 1) * 0.9;
      pulse.current.scale.setScalar(s);
      const material = (pulse.current.children[0] as Mesh)?.material as
        | { opacity: number }
        | undefined;
      if (material) material.opacity = Math.max(0, 0.55 * (1 - ((t * 0.9 + position[0]) % 1)));
    }
    if (outer.current) outer.current.rotation.z += 0.012;
    if (core.current) {
      core.current.rotation.z -= 0.02;
      core.current.position.z = 0.16 + Math.sin(t * 1.6 + position[1]) * 0.03;
    }
    beamMaterial.uniforms.uIntensity.value = current
      ? 1.5 + Math.sin(t * 3) * 0.35
      : selected
        ? 1.4
        : hovered
          ? 1.1
          : 0.85;
  });

  /** 指针离开时把 cursor 复位；点击后组件可能被卸载，所以卸载时也要复位 */
  const releaseCursor = () => {
    setHovered(false);
    document.body.style.cursor = "auto";
  };

  // 卸载兜底：点完点位就跳页时不会再有 pointerout，光标会一直停在手型
  useEffect(() => () => {
    document.body.style.cursor = "auto";
  }, []);

  return (
    <group
      position={position}
      scale={scale}
      onPointerOver={(event) => {
        event.stopPropagation();
        setHovered(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => releaseCursor()}>
      {/* 地面扩散脉冲环 */}
      <group ref={pulse} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh>
          <ringGeometry args={[0.3, 0.34, 48]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.5}
            {...NO_DEPTH}
            blending={AdditiveBlending}
            side={DoubleSide}
          />
        </mesh>
      </group>

      {/* 地面光斑：**普通混合**。地表贴图本身就亮，加色混合会把四态颜色
          一律叠成白色 —— 状态色就白给了（实测 additivie 下 27 个点位全是白点，
          规范 §5.2 要求的「红=风险 / 黄=工单」根本读不出来）。 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0.012]}>
        <planeGeometry args={[1.1, 1.1]} />
        <meshBasicMaterial
          map={halo}
          color={color}
          transparent
          opacity={current || selected ? 0.95 : hovered ? 0.85 : 0.7}
          {...NO_DEPTH}
        />
      </mesh>

      {/* 双层旋转光圈 */}
      <mesh ref={outer} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0.02]} renderOrder={2}>
        <ringGeometry args={[0.2, 0.235, 6, 1, 0, Math.PI * 1.6]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.95}
          {...NO_DEPTH}
          side={DoubleSide}
        />
      </mesh>

      {/* 选中点位的加粗外环：与「当前任务」的脉冲区分开，是静态的实体圈 */}
      {selected ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0.03]} renderOrder={3}>
          <ringGeometry args={[0.5, 0.56, 64]} />
          <meshBasicMaterial
            color="#e8fbff"
            transparent
            opacity={0.95}
            {...NO_DEPTH}
            side={DoubleSide}
          />
        </mesh>
      ) : null}

      {/* 中心菱形（四棱锥）+ 内核光点。
          尺寸比首版放大：首版 0.1×0.26 在 1920 宽的大屏上只有 3~4 个像素，
          叠加地表贴图后几乎读不出状态色（规范 §5.2 要求红黄绿一眼可辨）。 */}
      <group ref={core} position={[0, 0, 0.24]}>
        <mesh rotation={[0, Math.PI / 4, 0]} renderOrder={5}>
          <coneGeometry args={[0.13, 0.34, 4]} />
          <meshBasicMaterial color={color} {...NO_DEPTH} side={DoubleSide} />
        </mesh>
        <mesh renderOrder={6}>
          <sphereGeometry args={[0.055, 12, 12]} />
          <meshBasicMaterial color="#ffffff" {...NO_DEPTH} />
        </mesh>
      </group>

      {/* 光柱 */}
      <mesh position={[0, 0, 0.74]} renderOrder={4}>
        <cylinderGeometry args={[0.06, 0.13, 1.3, 12, 1, true]} />
        <primitive object={beamMaterial} attach="material" />
      </mesh>

      {/*
        锚点 +（有文字时）引线 + 文字标签。三者共用同一个 `Html` 定位函数：
        锚点落在点位正上方，引线与标签按像素偏移推到旁边（上海密集区），
        互不遮挡。
      */}
      <Html
        center
        position={[0, 0, 0.95]}
        zIndexRange={[60, 0]}
        calculatePosition={labelPosition}
        style={{ pointerEvents: "auto" }}>
        <Anchor
          className={selected ? "is-selected" : hovered ? "is-hovered" : ""}
          style={{
            background: STATUS_COLOR[status],
            transform: `scale(${selected ? 1.45 : hovered ? 1.25 : 1})`,
          }}
          onPointerOver={() => {
            setHovered(true);
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={releaseCursor}
          onClick={(event) => {
            event.stopPropagation();
            releaseCursor();
            props.onSelect?.();
          }}
        />
      </Html>

      {props.name ? (
        <>
          {hasOffset ? (
            <Html
              center
              position={[0, 0, 0.95]}
              zIndexRange={[59, 0]}
              calculatePosition={leaderPosition}
              style={{ pointerEvents: "none" }}>
              <Leader
                style={{
                  transform: `rotate(${(Math.atan2(labelOffset[1], labelOffset[0]) * 180) / Math.PI}deg)`,
                }}
              />
            </Html>
          ) : null}
          <Html
            center
            position={[0, 0, 0.95]}
            zIndexRange={[60, 0]}
            calculatePosition={labelPosition}
            style={{ pointerEvents: "none" }}>
            <SiteLabel
              className={`site-label site-label--${status} ${selected ? "is-selected" : ""} ${
                hovered ? "is-hovered" : ""
              }`}>
              <strong>{props.name}</strong>
              {props.caption ? <small>{props.caption}</small> : null}
            </SiteLabel>
          </Html>
        </>
      ) : null}

      {props.onSelect ? (
        <mesh
          position={[0, 0, 0.1]}
          visible={false}
          onPointerOver={(event) => {
            event.stopPropagation();
            setHovered(true);
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => releaseCursor()}
          onClick={(event) => {
            event.stopPropagation();
            releaseCursor();
            props.onSelect?.();
          }}>
          {/* 拾取球半径跟着 scale 走，见 PICK_RADIUS 的说明 */}
          <sphereGeometry args={[pickRadius / Math.max(scale, 0.0001), 8, 8]} />
        </mesh>
      ) : null}
    </group>
  );
}

export default SiteMarker;
