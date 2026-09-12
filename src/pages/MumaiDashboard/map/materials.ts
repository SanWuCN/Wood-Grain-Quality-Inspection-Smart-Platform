/**
 * 地图材质
 *
 * 全部手写 shader，好处是：
 *   - 统一用一组共享 uniform 控制透明度，开场动画「整体淡入」只 tween 一个数字
 *   - 侧壁扫光、顶面边缘高光、边界流动都写在片元里，不依赖后期处理
 *
 * 顶面几何里 uHeightScale 已经不参与位移：地形起伏由 DEM 生成的
 * 法线贴图 + 表面贴图表现，这样既真实又不用担心顶点太密。
 */

import { AdditiveBlending, Color, DoubleSide, FrontSide, ShaderMaterial } from "three";

/** 全局共享 uniform：开场动画只 tween 这一组 */
export const mapUniforms = {
  uOpacity: { value: 0 },
  uTime: { value: 0 },
  /** 0→1 从中心向外「揭开」 */
  uReveal: { value: 0 },
};

/* ------------------------------------------------------------------ *
 * 顶面 / 底面
 * ------------------------------------------------------------------ */
export function createTopMaterial(options: {
  surfaceMap?: import("three").Texture | null;
  normalMap?: import("three").Texture | null;
  baseColor?: string;
  glowColor?: string;
}) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: true,
    side: DoubleSide,
    uniforms: {
      uOpacity: mapUniforms.uOpacity,
      uTime: mapUniforms.uTime,
      uReveal: mapUniforms.uReveal,
      uSurface: { value: options.surfaceMap ?? null },
      uNormalMap: { value: options.normalMap ?? null },
      uHasSurface: { value: options.surfaceMap ? 1 : 0 },
      uHasNormal: { value: options.normalMap ? 1 : 0 },
      uBaseColor: { value: new Color(options.baseColor ?? "#6b7885") },
      uDeepColor: { value: new Color("#16222e") },
      uGlowColor: { value: new Color(options.glowColor ?? "#7fe0ff") },
      uHighlight: { value: 0 },
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
      uniform sampler2D uSurface;
      uniform sampler2D uNormalMap;
      uniform float uHasSurface;
      uniform float uHasNormal;
      uniform vec3 uBaseColor;
      uniform vec3 uDeepColor;
      uniform vec3 uGlowColor;
      uniform float uOpacity;
      uniform float uHighlight;
      uniform float uReveal;

      void main() {
        // 地表配色：保留 DEM 的明暗层次，把颜色去饱和成「冷灰岩体」。
        // demo2 的地表是低饱和灰、山脊偏白、暗部沉蓝黑，不是饱和蓝。
        vec3 base = uBaseColor;
        if (uHasSurface > 0.5) {
          vec3 tex = texture2D(uSurface, vUv).rgb;
          float lum = dot(tex, vec3(0.3, 0.59, 0.11));
          vec3 high = vec3(0.93, 0.97, 1.0);
          base =
            lum < 0.5
              ? mix(uDeepColor, uBaseColor, pow(lum * 2.0, 0.9))
              : mix(uBaseColor, high, pow((lum - 0.5) * 2.0, 1.3));
        }

        // 地形法线扰动：山脊高光、沟谷压暗都来自真实高程
        vec3 n = vec3(0.0, 0.0, 1.0);
        if (uHasNormal > 0.5) {
          n = normalize(texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0);
        }
        vec3 lightDir = normalize(vec3(-0.42, 0.52, 0.75));
        float diff = clamp(dot(n, lightDir), 0.0, 1.0);
        float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 1.7);

        vec3 color = base * (0.76 + diff * 0.6);
        // 陡坡/沟谷补一点冷色，避免整块发灰
        color += uGlowColor * rim * 0.5 * (1.0 - base.g);
        color = mix(color, uGlowColor, uHighlight * 0.3);

        // 开场：从中心向外揭开。
        // 注意 radial 最大只有 0.707（角落），系数取 1.05 时
        // radial<0.16 恒可见、radial>0.85 恒隐藏，配合 uOpacity 一起形成入场。
        float radial = distance(vUv, vec2(0.5));
        float reveal = smoothstep(uReveal - 0.4, uReveal + 0.02, 1.0 - radial * 1.05);

        float alpha = uOpacity * clamp(reveal, 0.0, 1.0);
        if (alpha < 0.008) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

/* ------------------------------------------------------------------ *
 * 侧壁：垂直渐变 + 自下而上的扫光带
 * ------------------------------------------------------------------ */
export function createSideMaterial(options: { depth: number; baseColor?: string; scanColor?: string }) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: true,
    side: FrontSide,
    uniforms: {
      uOpacity: mapUniforms.uOpacity,
      uTime: mapUniforms.uTime,
      uDepth: { value: options.depth },
      uBaseBottom: { value: new Color("#07253f") },
      uBaseTop: { value: new Color(options.baseColor ?? "#63c6ff") },
      uScanColor: { value: new Color(options.scanColor ?? "#dff6ff") },
      uHighlight: { value: 0 },
    },
    vertexShader: `
      varying float vHeight;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vHeight = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vHeight;
      varying vec2 vUv;
      uniform vec3 uBaseBottom;
      uniform vec3 uBaseTop;
      uniform vec3 uScanColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uHighlight;

      void main() {
        // 竖向渐变：底部近黑、顶部亮青，厚度感全靠这条渐变
        vec3 base = mix(uBaseBottom, uBaseTop, pow(vHeight, 1.7));

        // 沿厚度方向循环的扫光带（只在中上部走，避免整片侧壁一起发亮）
        float band = 0.3;
        float progress = fract(uTime * 0.26) * (1.0 + band) - band;
        float d = (progress + band) - vHeight;
        float within = clamp(1.0 - d / band, 0.0, 1.0) * step(0.0, d);
        float core = pow(smoothstep(0.0, 1.0, within), 1.5);
        float edge = smoothstep(0.0, 0.5, within) * (1.0 - smoothstep(0.5, 1.0, within));
        float scan = core * 0.85 + edge * 0.4;

        // 只有贴近顶面的一条亮线，勾出厚度上沿
        float lid = smoothstep(0.86, 1.0, vHeight);

        vec3 color = base + uScanColor * scan * 0.85 + uScanColor * lid * 0.9;
        color = mix(color, uScanColor * 1.1, uHighlight * 0.35);

        float alpha = uOpacity;
        if (alpha < 0.008) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

/* ------------------------------------------------------------------ *
 * 边界描边：顶点权重 + 缓慢流动
 * ------------------------------------------------------------------ */
export function createBoundaryMaterial(options: { color?: string; intensity?: number } = {}) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uOpacity: mapUniforms.uOpacity,
      uTime: mapUniforms.uTime,
      uColor: { value: new Color(options.color ?? "#a8e6ff") },
      uIntensity: { value: options.intensity ?? 1 },
    },
    vertexShader: `
      attribute float aWeight;
      varying float vWeight;
      varying vec3 vLocal;
      void main() {
        vWeight = aWeight;
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vWeight;
      varying vec3 vLocal;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uIntensity;
      uniform float uTime;
      void main() {
        float flow = 0.78 + 0.22 * sin(vLocal.x * 1.6 + vLocal.y * 1.2 - uTime * 1.3);
        float a = vWeight * uIntensity * flow * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * (0.9 + vWeight * 0.5), a);
      }
    `,
  });
}
