/**
 * 方案 04 · 双层壳（外壳玻璃 + 内核发光）
 *
 * ── 怎么做出"渐变半透明" ──────────────────────────────────────────
 * 拆成**两层壳**，各管一半的事 —— 这是最容易被忽略、但最能拉开差距的一版：
 *   外层「玻璃壳」：极淡的冷蓝 + 菲涅尔控透明（中心几乎全透、边缘压亮），
 *       只负责"这是一层壳"和轮廓光、以及底部的**厚度压深**（视线穿过球下缘
 *       的玻璃最厚 → 那里最深，参考图球下缘那圈深蓝就是这么来的）。
 *   内层「发光核」：加色混合的径向渐变球，亮度随时间脉动，
 *       只负责"里面有光在流动"。
 * 两层叠加时，外壳的菲涅尔边缘 + 内核的柔和光晕在视觉上合成了
 * "渐变"：中心是核的暖青、往外过渡到壳的冷蓝、边缘是亮环。
 * **渐变来自两层透明度的乘积**，不是画一张渐变贴图。
 *
 * ── 与 01 的区别 ──────────────────────────────────────────────────
 * 01 是"一整块玻璃里有个核"，核是被折射看到的、边界清晰；
 * 这一版的壳**不做真折射**（省掉每帧一遍离屏渲染），
 * 换来了核的光可以任意溢出、更像"球里装了一盏灯"。
 *
 * ── 开销 ──────────────────────────────────────────────────────────
 * 低。两次绘制、无离屏缓冲、无 transmission。
 */

import { AdditiveBlending, Color, Mesh, MeshBasicMaterial, ShaderMaterial, SphereGeometry } from "three";
import {
  PALETTE,
  applyBlink,
  blinkScale,
  buildFace,
  disposeTempMesh,
  makeContactShadow,
  makeHalo,
  type Stage,
} from "../shared.ts";
import type { LabVariant, VariantOptions, VariantRuntime } from "../types.ts";

/** 外壳：只做"极淡的冷蓝 + 边缘亮环 + 底部厚度压深" */
const SHELL_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
void main() {
  vN = normalize(normalMatrix * normal);
  vP = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHELL_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uCool;
uniform vec3 uEdge;
varying vec3 vN;
varying vec3 vP;

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  float fres = pow(1.0 - abs(dot(N, V)), 2.2);

  // 底部厚度压深：视线穿过球下缘的壳最厚。用 vP.y 的负向做权重，
  // 再乘菲涅尔 —— 只有"下缘的掠射区"才压深，球心不压。
  float bottom = smoothstep(0.15, -0.95, vP.y);
  float thick = bottom * fres;

  vec3 col = uCool;
  col += uEdge * fres * 0.95;
  col = mix(col, vec3(0.16, 0.30, 0.58), thick * 0.75);

  // 壳上那道缓慢游走的高光（参考图左上的大面积反光）
  vec3 L = normalize(vec3(-0.52, 0.74, 0.6));
  float spec = pow(max(dot(N, L), 0.0), 30.0);
  col += vec3(1.0) * spec * 0.5;

  // 壳本身几乎全透：0.08 起步，靠菲涅尔在边缘收到 0.9
  float alpha = clamp(0.075 + fres * 0.72, 0.0, 0.95);
  alpha *= 0.9 + 0.1 * sin(uTime * 0.8);
  gl_FragColor = vec4(col, alpha);
}
`;

/** 内核：加色混合的径向渐变球，亮度脉动 */
const CORE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
void main() {
  vN = normalize(normalMatrix * normal);
  vP = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CORE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uHot;
uniform vec3 uCool;
varying vec3 vN;
varying vec3 vP;

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  // 正面（对着相机的那半边）最亮，背面衰减 = 发光核的"体积感"
  float facing = pow(max(dot(N, V), 0.0), 1.35);
  float fres = pow(1.0 - abs(dot(N, V)), 2.0);

  // 内部流动：两个错频正弦扫过，让核不是一颗均匀的球
  float flow = 0.5 + 0.5 * sin(vP.y * 4.2 + uTime * 1.25 + sin(vP.x * 3.1 - uTime * 0.7) * 1.2);
  vec3 col = mix(uCool, uHot, facing * 0.75 + flow * 0.35);
  col += uHot * fres * 0.5;

  float pulse = 0.72 + 0.28 * sin(uTime * 1.15);
  gl_FragColor = vec4(col * (0.85 + flow * 0.4) * pulse, facing * 0.62 + fres * 0.2);
}
`;

export const doubleShell: LabVariant = {
  id: "04",
  name: "双层壳 · 内核发光",
  oneLiner: "外面一层几乎全透的薄壳，里面一盏灯在脉动，中心暖青、边缘冷蓝",
  tech: "两个 ShaderMaterial：外壳菲涅尔透明度 + 底部厚度压深；内核加色混合 + 正面衰减 + 脉动",
  cost: "低：两次绘制、无离屏、无 transmission",
  fidelity: "mid",
  fidelityNote: "轮廓光与「壳里有灯」的气质很接近参考图，但中心偏亮偏冷、缺少参考图左下那团饱和青蓝的浓度",
  needsWebGL: true,
  create(_host: HTMLElement, _opts: VariantOptions, stage: Stage): VariantRuntime {
    const shellGeo = new SphereGeometry(1, 72, 52);
    const shellMat = new ShaderMaterial({
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCool: { value: new Color(0x9dc6f2) },
        uEdge: { value: new Color(PALETTE.irisCyan) },
      },
    });
    const shell = new Mesh(shellGeo, shellMat);
    shell.renderOrder = 9;

    const coreGeo = new SphereGeometry(0.66, 48, 36);
    const coreMat = new ShaderMaterial({
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uHot: { value: new Color(0xbfeaff) },
        uCool: { value: new Color(0x5fb8f5) },
      },
    });
    const core = new Mesh(coreGeo, coreMat);
    core.renderOrder = 3;

    const face = buildFace({ radius: 1.045 });
    face.group.renderOrder = 6;

    const halo = makeHalo(PALETTE.halo, 2.7, 0.5);
    const haloMat = halo.material as MeshBasicMaterial;
    const shadow = makeContactShadow();

    stage.scene.add(shadow, stage.floatGroup);
    stage.tiltGroup.add(core, shell, halo);
    stage.floatGroup.add(face.group);

    return {
      update: (t) => {
        shellMat.uniforms.uTime.value = t;
        coreMat.uniforms.uTime.value = t;
        const s = 1 + Math.sin(t * 1.35) * 0.034;
        shell.scale.setScalar(s);
        face.group.scale.setScalar(s);
        // 内核反向微缩放：外壳鼓的时候核瘪一点 —— 两层不同步才像"里面有东西"
        core.scale.setScalar(1 - Math.sin(t * 1.35) * 0.05);
        core.rotation.y = t * 0.22;
        core.rotation.z = Math.sin(t * 0.31) * 0.4;
        stage.floatGroup.position.y = Math.sin(t * 1.05 + 1.1) * 0.023;
        halo.scale.setScalar(1 + Math.sin(t * 1.35) * 0.05);
        haloMat.opacity = 0.6 + Math.sin(t * 1.35) * 0.14;
        applyBlink(face, blinkScale(t));
      },
      dispose: () => {
        shellGeo.dispose();
        shellMat.dispose();
        coreGeo.dispose();
        coreMat.dispose();
        face.dispose();
        disposeTempMesh(halo);
        disposeTempMesh(shadow);
      },
    };
  },
};
