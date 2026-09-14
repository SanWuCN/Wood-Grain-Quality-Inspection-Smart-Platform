/**
 * 小木形象方案展台 · WebGL 侧公用件
 *
 * ── 这个文件解决什么 ────────────────────────────────────────────────
 * 9 个方案要能**并排比**，就必须共用同一套「舞台参数」：同样的相机、
 * 同样的环境光、同样的接触阴影、同样尺寸/配色的脸。否则并排看到的差异
 * 会混进"光不一样、脸不一样"这些噪音，用户就没法判断材质本身好不好。
 *
 * 所以这里只放**跨方案共用**的东西：
 *   createStage()   渲染器 + 场景 + 相机 + 程序化环境贴图（PMREM）+ 光照
 *   drawFace/orbFace()  极简 kawaii 脸（深蓝椭圆眼 + 白高光点 + 小弧线微笑）
 *   drawContact()   球下那圈冷调接触阴影（参考图球下有，少了就"浮在半空"）
 *   blinkScale()    眨眼（不定周期，两个互质节拍）
 *   ibl/均匀变量   参考图采样出来的配色
 *
 * 每个方案各自负责自己的球体材质与动画 —— 那才是要比的东西。
 *
 * 注释里凡是写「参考图」的，指的都是
 * `voice-module/refs/小木形象参考-蓝色琉璃球体.png`（用户指定的最高优先参考）。
 */

import {
  AdditiveBlending,
  BackSide,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  CubeTexture,
  DataTexture,
  DirectionalLight,
  Float32BufferAttribute,
  HemisphereLight,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  UnsignedByteType,
  WebGLRenderer,
  type Material,
  type Object3D,
  type Texture,
  type WebGLRendererParameters,
} from "three";

/* ══════════════════════════════════════════════════════════════════
 * 配色（全部从参考图采样，不是"配"的）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 主体的倾斜角度（复刻参考图里"球不是正对相机"的那点偏转）。
 *
 *   y = -0.34 rad ≈ -19.5°：球转向画面左侧 → 脸略偏左、右侧露出更多暗面
 *   x =  0.10 rad ≈  5.7°：略微俯视 → 顶部高光带更宽、底部收窄
 *   z = -0.045 rad ≈ -2.6°：极轻微侧倾，让轮廓不是一条死水平线（参考图有）
 *   ySway：y 轴上一个很慢的 ±1.7° 摆动（周期约 15s）—— 静止的偏转看起来还是"摆拍"，
 *          给它一点游移才像悬浮的球在轻微自转
 */
export const SUBJECT_TILT = {
  y: -0.34,
  x: 0.1,
  z: -0.045,
  ySway: 0.03,
} as const;

export const PALETTE = {
  /** 球心附近：很淡的蓝（rgb(169,209,244)）——球心必须偏白，否则整颗球"发实" */
  core: 0xa9d1f4,
  /** 左下最艳的青蓝（rgb(121,221,253)） */
  cyan: 0x79ddfd,
  /** 正左那一档更饱和的蓝（rgb(75,189,249)） */
  blue: 0x4bbdf9,
  /** 边缘压深用的深蓝（玻璃厚度层） */
  deep: 0x3f6ba8,
  /** 虹彩：上半圈偏淡紫/粉（rgb(220,197,247)） */
  iris: 0xdcc5f7,
  /** 虹彩：下半圈偏青（rgb(186,241,253)） */
  irisCyan: 0xbaf1fd,
  /** 五官深海军蓝（参考图五官最深色采样 #203d78；纯黑在浅蓝球上显脏） */
  faceInk: 0x16295c,
  /** 外发光青（球浮在背景上的那一圈柔光） */
  halo: 0x8fe0ff,
} as const;

/* ══════════════════════════════════════════════════════════════════
 * 渲染舞台
 * ══════════════════════════════════════════════════════════════════ */

export interface StageOptions extends WebGLRendererParameters {
  /**
   * 画布要塞进哪个元素。
   *
   * ⚠ 这个字段是**踩过一次大坑**才加的：原先 `createStage` 只建渲染器、
   * 不把 `renderer.domElement` 挂进 DOM，于是 9 块 WebGL 画布全渲染到了
   * **离屏 canvas** 上 —— 页面上「9/9 就绪、34 FPS、无报错」，实际一片空白。
   * 把"画布进 DOM"做成 `createStage` 的职责，调用方就不可能忘。
   */
  host: HTMLElement;
  /** 画布 CSS 尺寸（像素）。渲染分辨率 = 画布尺寸 × 清晰度倍率 */
  width: number;
  height: number;
}

export interface Stage {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** 软环境贴图（PMREM）。所有方案共用同一份 —— 环境光不一样就没法比材质 */
  envMap: Texture;
  /** 脸与接触阴影挂这里：**不跟随倾斜**，永远正对相机（参考图就是这样） */
  floatGroup: Object3D;
  /**
   * 球壳 / 内核 / 外发光挂这里：承载"参考图那个角度"，每帧被 `tilt()` 旋转。
   *
   * ⚠ 这个字段必须出现在接口与 return 两处 —— 少一处，变体拿到 `undefined`，
   * 在 `create()` 里 `.add()` 直接抛，整格变成"初始化失败"。
   * （这个坑真踩过：接口忘了声明，10 个方案的壳全白了一轮。）
   */
  tiltGroup: Object3D;
  size: { width: number; height: number; dpr: number };
  /** 画布是否在视口里。false 时展台页会跳过这个方案的渲染与 update */
  visible: boolean;
  render: () => void;
  /** 每帧更新主体倾斜（复刻参考图角度）。变体不要自己动 floatGroup 的 rotation */
  tilt: (t: number) => void;
  resize: (width: number, height: number, dpr: number) => void;
  dispose: () => void;
}

/**
 * 程序化环境贴图：**不加载 HDR 文件**，用一个临时场景烘出来。
 *
 * 为什么需要它：参考图的"琉璃感"一大半来自**曲面上的环境反射**——
 * 左上那片大面积高光、右上那道细边、底部一圈回光。没有环境光时，
 * 任何 transmission / clearcoat 材质都会糊成一颗灰球，怎么做都不像玻璃。
 *
 * 为什么不用 three 自带的 RoomEnvironment：那个盒子是**冷白室内灯箱**，
 * 烘出来的球是"白玻璃"；参考图是**偏蓝的通透琉璃**，得自己给环境上色。
 * 所以这里自己搭一个小场景：淡蓝的天空球 + 一块很强的白色柔光板（左上前上方）
 * + 两块冷蓝补光，正好对上参考图的高光位置。
 *
 * 只在展台启动时烘一次，9 个方案共用。
 *
 * ── 9 块画布怎么共用这一份（2026-09-14 修正）─────────────────────────
 * 环境贴图烘的是**纯函数式的场景**（自发光板 + 渐变球，无随机数、不依赖画布尺寸），
 * 9 个渲染器要的是同一份。但 WebGL 纹理属于**各自独立的上下文**，不能跨上下文共享
 * 同一个 GPU 纹理。所以共用的是**中间产物**而不是最终纹理：
 *
 *   第 1 次：搭临时场景 → PMREM 卷一次 → 用 readRenderTargetPixels 把烘好的
 *           立方体数据（RGBE）读回 CPU 缓存 → 拆掉临时场景
 *   第 2~9 次：用缓存数据造一张 DataTexture → `fromCubemap` 在本渲染器里重放
 *
 * 省掉的是 8 次「搭场景 + 卷积」，而不是 8 次纹理上传（那个省不掉）。
 *
 * ⚠ 这里踩过一个坑：最初缓存的是 `WebGLRenderTarget` 本身，再拿它喂 `fromCubemap`
 * —— 类型上编译不过（`fromCubemap` 要 `CubeTexture`），而且那个 target 属于第一个
 * 渲染器的上下文，硬塞给第二个渲染器是错的。缓存 **CPU 侧的像素数据**才既类型正确
 * 又上下文无关。
 */
function buildEnvironmentTexture(renderer: WebGLRenderer): Texture {
  // ── 第 2~9 次：用缓存的数据在本渲染器里重放一次 PMREM
  const cached = envCache;
  if (cached) {
    const source = new DataTexture(cached.data, cached.size, cached.size, RGBAFormat, UnsignedByteType);
    source.colorSpace = LinearSRGBColorSpace;
    source.generateMipmaps = false;
    source.flipY = true;
    const asCube = new CubeTexture([source, source, source, source, source, source] as unknown as HTMLImageElement[]);
    asCube.needsUpdate = true;

    const reuse = new PMREMGenerator(renderer);
    const rebuilt = reuse.fromCubemap(asCube);
    reuse.dispose();
    asCube.dispose();
    source.dispose();
    return rebuilt.texture;
  }

  const pmrem = new PMREMGenerator(renderer);
  const envScene = buildEnvironmentScene();
  const target = pmrem.fromScene(envScene);
  pmrem.dispose();
  disposeScene(envScene);

  // 把烘好的立方体读回 CPU（PMREM 的输出是一张铺成"6 面网格"的 2D 图）
  const size = target.width;
  const data = new Uint8Array(size * size * 4);
  try {
    renderer.readRenderTargetPixels(target, 0, 0, size, size, data);
    envCache = { data, size };
  } catch {
    /**
     * 读不回来（个别驱动拒绝读浮点/半浮点 target）→ 不缓存，每个渲染器各烘一次。
     * 这是**正确的降级**：慢一点，但画面一定对；绝不为了快把环境贴图搞黑。
     */
    envCache = null;
  }
  return target.texture;
}

/** 缓存下来的环境立方体数据（CPU 侧，跨渲染器复用） */
let envCache: { data: Uint8Array; size: number } | null = null;

/**
 * 临时环境场景。只在第一次烘的时候搭一次，用完立刻拆 ——
 * 留着它就是 9 份常驻的几何 + 材质。
 */
function buildEnvironmentScene(): Scene {
  const envScene = new Scene();

  // 天空：BackSide 球体 + 上下渐变（上淡蓝、下近白 —— 参考图球的下缘是被地面反光提亮的）
  const skyGeo = new SphereGeometry(12, 24, 16);
  const skyMat = new MeshBasicMaterial({ side: BackSide, toneMapped: false });
  // 顶点色：手写，避免为一个渐变再引一个着色器
  const colors: number[] = [];
  const pos = skyGeo.getAttribute("position");
  const top = new Color(0x9dc4f0);
  const bottom = new Color(0xf4f8ff);
  for (let i = 0; i < pos.count; i += 1) {
    const t = (pos.getY(i) / 12 + 1) / 2;
    const c = bottom.clone().lerp(top, t);
    colors.push(c.r, c.g, c.b);
  }
  skyGeo.setAttribute("color", new Float32BufferAttribute(colors, 3));
  skyMat.vertexColors = true;
  envScene.add(new Mesh(skyGeo, skyMat));

  /**
   * 主柔光板：放在**左上前方**。
   * 位置是照着参考图定的 —— 参考图那片大面积高光在球面左上 10~11 点钟方向，
   * 也就是世界坐标的 (-x, +y, +z)。板子越大越柔，这里给到 5×5 并对准相机侧。
   */
  const plate = (color: number, intensity: number, w: number, h: number, pos: [number, number, number], lookAtOrigin = true) => {
    const m = new MeshBasicMaterial({ toneMapped: false });
    m.color.setHex(color).multiplyScalar(intensity);
    const mesh = new Mesh(new PlaneGeometry(w, h), m);
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (lookAtOrigin) mesh.lookAt(0, 0, 0);
    envScene.add(mesh);
    return mesh;
  };

  plate(0xffffff, 5.2, 5.0, 5.0, [-4.2, 4.0, 4.6]);
  // 右上细高光（参考图右上有第二处较小的镜面点）
  plate(0xffffff, 2.6, 2.6, 3.4, [5.0, 2.2, 3.6]);
  // 冷蓝补光：给暗面一点蓝，别让下半球发灰
  plate(0x8fc8ff, 1.1, 6.0, 3.0, [3.4, -4.2, 2.0]);
  // 左侧回光（参考图最左那一档饱和蓝 #4bbdf9 就是这么来的）
  plate(0x4bbdf9, 1.5, 3.2, 4.4, [-5.2, -0.6, 2.6]);
  // 背后一圈，让轮廓有 thin rim
  plate(0xcfe6ff, 1.2, 4.0, 4.0, [0.0, 1.2, -6.0], false);

  return envScene;
}

/** 拆掉临时环境场景的几何与材质（烘完就没用了，留着就是常驻开销） */
function disposeScene(scene: Scene): void {
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      (o.material as Material).dispose();
    }
  });
}

/**
 * 释放 hal/接触阴影这类"临时贴图网格"。
 * 这四行要写 8 遍（每个方案各有一份外发光 + 一份接触阴影），
 * 漏一个就是一处显存泄漏 —— 所以抽出来，只在具体方案里调一次。
 */
export function disposeTempMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
  const mat = mesh.material as MeshBasicMaterial;
  mat.map?.dispose();
  mat.dispose();
}

/**
 * 画布的显示尺寸：**CSS 说了算**。
 *
 * 为什么不在 JS 里写 `canvas.style.width = width + "px"`：格子尺寸由布局决定
 * （`aspect-ratio: 1/1` + 网格列宽），缩放窗口时 CSS 立刻是对的，而 JS 要等
 * resize 事件跑完才追上 —— 中间那几帧就会被拉变形。所以只声明"填满宿主盒子"，
 * 让布局系统去算；`setSize(w, h, false)` 负责的只是**渲染分辨率**。
 */
function applyCanvasCss(canvas: HTMLCanvasElement): void {
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
}

/**
 * 建一块方案画布对应的渲染舞台。
 *
 * 关于 `preserveDrawingBuffer`：
 *   截图工装用 CDP Page.captureScreenshot，**不走** canvas.toDataURL，
 *   所以理论上不需要它。但"点开放大 / 全部暂停"之后同一个画布不再重绘，
 *   浏览器合成器需要上一帧还在 —— 开着它最稳，代价可以忽略（画布才 110~1000px）。
 */
export function createStage(opts: StageOptions): Stage {
  const { host, width, height, ...params } = opts;
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: true,
    // 预乘 alpha + 透明底：球体的半透明边缘才能和页面底色正确合成
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
    ...params,
  });
  applyCanvasCss(renderer.domElement);
  /**
   * ⚠ 这一行是**踩过一次大坑**才补上的：原先只建渲染器、不把
   * `renderer.domElement` 挂进 DOM，于是 9 块 WebGL 画布全都渲染到了
   * **离屏 canvas** 上 —— 页面上显示「9/9 就绪、34 FPS、无报错」，实际一片空白。
   * 这类 bug 最恶劣的地方是**每一层检查都过**：渲染器建成功、方案 create 没抛、
   * rAF 在跑、FPS 表有数，唯独没有像素进到页面里。
   * 所以"画布进 DOM"是 `createStage` 的职责，不能指望调用方"记得去 append"。
   */
  host.append(renderer.domElement);
  renderer.outputColorSpace = SRGBColorSpace;
  /**
   * 关掉色调映射。
   * three r152 之后默认是 ACESFilmic，它会把饱和的青色压成灰调，
   * 参考图那种"很艳的左下青蓝"就出不来了。这里要的是**和参考图一致的发色**，
   * 所以走线性输出。
   */
  renderer.toneMapping = NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  // 排序交给每个方案自己声明的 renderOrder（透明球体 + 发光内核必须可控）
  renderer.sortObjects = true;

  const scene = new Scene();
  const envMap = buildEnvironmentTexture(renderer);

  /**
   * 机位距离：**按 fov 反推**，而不是写一个"看着差不多"的数。
   *
   * ⚠ 这里踩过一个坑：原来是 `camera.position.z = 3.3`（resize 里又收成 3.06）。
   * 30° 垂直 fov 在 z=3.06 处的可视高度只有 `2·tan(15°)·3.06 = 1.64` 世界单位，
   * 而球（含外发光/背面色晕）的直径是 **2.0** —— 也就是球必然被上下裁掉一截。
   * 这是探针量出来才发现的（`worldH=2.001` vs `visH=1.64`）：光看截图只会觉得
   * "这版球好像有点大"，看不出是机位算错了。
   *
   * 现在按目标占屏反推距离：想让球占画面高度的 `FILL` 左右（参考图里球约占七成，
   * 上下各留一圈呼吸空间），就取 `z = 半径 / (FILL/2 · tan(fov/2))`。
   * 另外再按"窄格子"往后退一点：格子不是正方形时（放大态、窄屏单列），
   * 垂直可视高度不变而水平可视宽度收窄，球会被左右切到。
   */
  const FOV_DEG = 30;
  const camera = new PerspectiveCamera(FOV_DEG, width / height, 0.1, 40);
  /** 球体（含外发光）的外接半径：球 1.0 + 上下浮动 0.03 + 外发光余量 */
  const SUBJECT_RADIUS = 1.12;
  /** 目标：主体占画面高度的比例 */
  const FILL = 0.82;
  const BASE_Z = SUBJECT_RADIUS / ((FILL / 2) * Math.tan((FOV_DEG * Math.PI) / 360));
  camera.position.set(0, 0, BASE_Z);
  camera.lookAt(0, 0, 0);
  // 环境光是"玻璃感"的主光；下面的平行光是给高光/光泽一个明确方向（参考图光在左上）
  const hemi = new HemisphereLight(0xdcecff, 0x9fb6d8, 1.65);
  scene.add(hemi);
  const key = new DirectionalLight(0xffffff, 1.45);
  key.position.set(-2.6, 3.2, 3.4);
  scene.add(key);
  const fill = new DirectionalLight(0xa8ccff, 0.5);
  fill.position.set(3.0, -1.4, 1.6);
  scene.add(fill);

  const floatGroup = new Scene() as unknown as Object3D;
  /**
   * 复刻参考图的**倾斜角度**。
   *
   * 参考图里那颗球不是正对相机的：球体轮廓略斜、左上高光更宽、
   * 右下角那几块虹彩斑也是"转过头一点"才露出来的。正对相机的球看起来
   * 像一张平面贴纸，正是少了这个偏转。
   *
   * ── ⚠ 为什么会多出一个 tiltGroup（踩过一次才拆出来）────────────────
   * 第一版直接转 `floatGroup`（球、内核、**脸**都挂在它下面）。结果是
   * **脸被横着转走了**：眼睛在 x≈±0.33r 的球面切点上，绕 y 轴转 19.5° 之后
   * 位置变成 `z ← x·sinθ`，也就是**朝画面里侧退进去了 0.11r**。
   * 那是几何上正确的行为，但看起来就是"眼睛陷进球侧面、糊成一团斜斑" ——
   * 因为**参考图里脸是正对镜头的，只有球壳是斜的**。
   *
   * 所以拆成两层：
   *   floatGroup（不转）：脸、接触阴影 —— 永远正对相机
   *   tiltGroup（转）    ：球壳、内核、外发光 —— 承载"角度"
   * 变体建场景时把**壳类**物体挂 `stage.tiltGroup`、**脸**挂 `stage.floatGroup`。
   *
   * ⚠ 各变体在 `update()` 里只允许写 `floatGroup.position.y`（上下浮动），
   *    **不许覆盖它自己的 rotation**，否则这个偏转会被逐帧抹掉。
   */
  const tiltGroup = new Scene() as unknown as Object3D;
  floatGroup.add(tiltGroup);
  const tilt = (t: number) => {
    tiltGroup.rotation.y = SUBJECT_TILT.y + Math.sin(t * 0.42) * SUBJECT_TILT.ySway;
    tiltGroup.rotation.x = SUBJECT_TILT.x;
    tiltGroup.rotation.z = SUBJECT_TILT.z;
  };
  tilt(0);
  scene.add(floatGroup);

  const size = { width, height, dpr: 1 };

  const resize = (w: number, h: number, dpr: number) => {
    size.width = w;
    size.height = h;
    size.dpr = dpr;
    renderer.setPixelRatio(dpr);
    // 第二个参数 false：**不要**让 three 写内联 style，尺寸交给 CSS（见 applyCanvasCss）
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    /**
     * 窄格子（宽高比 < 1，比如手机单列或放大态）时再往后退一点：
     * 垂直可视高度由 fov 定死，横向收窄时球的左右会被切到。
     * `narrow` 在 aspect ≥ 1 时为 0（方格子不动），越窄越接近 1。
     */
    const aspect = w / h;
    const narrow = Math.max(0, Math.min(1, (1 - aspect) / 0.45));
    camera.position.z = BASE_Z + narrow * 0.42;
    camera.updateProjectionMatrix();
    applyCanvasCss(renderer.domElement);
  };
  resize(width, height, 1);

  return {
    renderer,
    scene,
    camera,
    envMap,
    floatGroup,
    tiltGroup,
    size,
    visible: true,
    render: () => renderer.render(scene, camera),
    resize,
    /** 每帧更新主体的倾斜/摆动。变体不该自己动这一层（见 SUBJECT_TILT 的说明） */
    tilt,
    dispose: () => {
      renderer.domElement.remove();
      envMap.dispose();
      renderer.dispose();
    },
  };
}

/** 让材质吃环境贴图。玻璃/反射类材质漏了这行就等于没开环境光。 */
export function withEnv<T extends Material & { envMap?: Texture | null; envMapIntensity?: number }>(
  material: T,
  stage: Stage,
  intensity = 1.35,
): T {
  material.envMap = stage.envMap;
  material.envMapIntensity = intensity;
  return material;
}

/* ══════════════════════════════════════════════════════════════════
 * 纹理绘制工具
 * ══════════════════════════════════════════════════════════════════ */

export function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("拿不到 2d 上下文");
  return { canvas, ctx };
}

export function canvasTexture(canvas: HTMLCanvasElement, srgb = true): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 接触阴影：参考图球下面那圈**冷紫蓝**的椭圆（不是黑影）。
 *
 * 做法是画进 canvas 再贴到一个水平面上，而不是开真实阴影贴图：
 *   9 个方案各开一张 shadowMap 直接翻倍开销，而这里要的只是一圈柔和的
 *   "落地感"——一张径向渐变就够，还能让它在球呼吸时跟着轻微缩放。
 */
export function makeContactShadow(): Mesh {
  const { canvas, ctx } = makeCanvas(256, 128);
  const g = ctx.createRadialGradient(128, 64, 0, 128, 64, 120);
  g.addColorStop(0, "rgba(74,95,150,0.46)");
  g.addColorStop(0.45, "rgba(91,111,168,0.24)");
  g.addColorStop(0.75, "rgba(107,127,184,0.08)");
  g.addColorStop(1, "rgba(107,127,184,0)");
  ctx.fillStyle = g;
  ctx.save();
  ctx.translate(128, 64);
  ctx.scale(1, 0.5);
  ctx.beginPath();
  ctx.arc(0, 0, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const mesh = new Mesh(
    new PlaneGeometry(1.85, 0.62),
    new MeshBasicMaterial({ map: canvasTexture(canvas), transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -1.0;
  mesh.renderOrder = 0;
  return mesh;
}

/**
 * 柔和外发光：一张 billboard 径向渐变。
 * 参考图球外有一圈很窄的青色柔光 —— 它负责"球浮在背景上不糊在一起"。
 * 用加色混合 + 球体半径略大，比后期 bloom 便宜一个数量级。
 */
export function makeHalo(color: number = PALETTE.halo, size = 2.5, strength = 0.5): Mesh {
  const { canvas, ctx } = makeCanvas(256, 256);
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  const c = new Color(color);
  const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  g.addColorStop(0, `rgba(${rgb},0)`);
  g.addColorStop(0.82, `rgba(${rgb},0)`);
  g.addColorStop(0.9, `rgba(${rgb},${strength})`);
  g.addColorStop(0.96, `rgba(${rgb},${strength * 0.5})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const mesh = new Mesh(
    new PlaneGeometry(size, size),
    new MeshBasicMaterial({ map: canvasTexture(canvas), transparent: true, depthWrite: false, blending: AdditiveBlending }),
  );
  mesh.renderOrder = 1;
  return mesh;
}

/* ══════════════════════════════════════════════════════════════════
 * 脸：极简 kawaii（只有眼 + 嘴，没有眉毛鼻子 —— 参考图就是这样）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 眼：竖向椭圆，**上深下亮**的一枚深蓝渐变 + 左上白色高光点 + 下缘一道青边。
 *
 * 三个细节都不能省（都是照着参考图对的）：
 *   1. 上深(#132148)下亮(#38669f)：参考图的眼睛不是一块死平色，
 *      下缘有一层被球内反光提亮的蓝 —— 少了它眼睛就是两个贴纸。
 *   2. 高光点在**左上偏内**：两颗高光点朝脸中心偏，视线才聚在中间，不自散。
 *   3. 底部一道极淡的青弧：模拟"眼珠浸在通透球体里、下缘吃到内部亮带"。
 */
export function makeEyeTexture(): CanvasTexture {
  /*
    ⚠ 画布比例必须与 `FACE_GEOM.eyeW : eyeH`（0.225 : 0.238）**一致**，
    否则平面贴图时会把眼睛非等比拉伸 —— 而"眼睛变扁/变胖"恰恰是最刺眼的失真。
    实测参考图的眼是 104×110 px（高/宽 1.06），所以这里用 104×110 的等比画布，
    再乘 2 倍分辨率（208×220）留出抗锯齿余量。
  */
  const w = 104 * 2;
  const h = 110 * 2;
  const { canvas, ctx } = makeCanvas(w, h);
  const cx = w / 2;
  const cy = h / 2;
  /*
    参考图的眼睛是**几乎正圆**（104×110），这里只留一点点余量：
    眼形本身仍画满画布，但瞳孔/高光的分布按"圆眼"来。
    上一版用的是 0.42w × 0.43h 的扁椭圆（画布 128×160），扁得和参考图对不上。
  */
  const rx = w * 0.48;
  const ry = h * 0.47;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();

  const g = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
  g.addColorStop(0, "#0d1b3e");
  g.addColorStop(0.16, "#132148");
  g.addColorStop(0.58, "#203d78");
  g.addColorStop(0.88, "#35619b");
  g.addColorStop(1, "#4a7fbb");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // 内部上方再压一道更深的蓝：让眼"有厚度"，不是平面渐变
  const g2 = ctx.createLinearGradient(0, cy - ry, 0, cy - ry * 0.1);
  g2.addColorStop(0, "rgba(9,18,44,0.85)");
  g2.addColorStop(1, "rgba(9,18,44,0)");
  ctx.fillStyle = g2;
  ctx.fillRect(0, cy - ry, w, ry);

  // 下缘的青边（内部亮带透进来）
  const g3 = ctx.createLinearGradient(0, cy + ry * 0.35, 0, cy + ry);
  g3.addColorStop(0, "rgba(143,224,255,0)");
  g3.addColorStop(1, "rgba(160,229,255,0.55)");
  ctx.fillStyle = g3;
  ctx.fillRect(0, cy + ry * 0.35, w, ry);

  // 白色高光点：左上、略偏内
  const gl = ctx.createRadialGradient(cx - rx * 0.34, cy - ry * 0.42, 0, cx - rx * 0.34, cy - ry * 0.42, rx * 0.42);
  gl.addColorStop(0, "rgba(255,255,255,1)");
  gl.addColorStop(0.55, "rgba(255,255,255,0.9)");
  gl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gl;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // 椭圆路径本来就裁在这个形状里，画布其余部分是透明的 —— 不需要额外做遮罩，
  // 球形边缘的抗锯齿由 canvas 的路径描边自带。
  return canvasTexture(canvas);
}

/**
 * 嘴：一条细而宽的小弧线，两端上翘。
 *
 * ⚠ 这里改成**紧贴弧线本身**的画布（88×35，与 `FACE_GEOM.mouthW:mouthH` 同比例）。
 * 上一版是 256×128 的 2:1 画布、弧线只画在中间 30%~70% 那一段，
 * 再把整张 0.5r×0.25r 的平面贴上去 —— 结果是**可见弧线只有 0.1r 宽、
 * 四周全是透明留白**，嘴看起来比设计值小一半还多，而且改 `mouthW` 也不见效
 * （改的是留白，不是弧线）。紧贴弧线的画布让"平面尺寸 = 看得见的宽度"，
 * 一个参数只对应一件事。
 *
 * 线宽 11/88 ≈ 0.125 倍嘴宽，对应参考图实测的 11px 描边 / 88px 嘴宽。
 */
export function makeSmileTexture(): CanvasTexture {
  const w = 88 * 3;
  const h = 35 * 3;
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = PALETTE_INK_CSS;
  ctx.lineWidth = 33; // = 11 × 3（与画布同倍率）
  ctx.lineCap = "round";
  ctx.beginPath();
  // 二次贝塞尔：两端高、中间沉 —— 就是参考图那条笑弧。
  // 起点/终点/控制点按"弧线的实际包围盒"铺满画布，不留额外留白。
  ctx.moveTo(w * 0.17, h * 0.34);
  ctx.quadraticCurveTo(w * 0.5, h * 0.9, w * 0.83, h * 0.34);
  ctx.stroke();
  return canvasTexture(canvas);
}

const PALETTE_INK_CSS = "#16295c";

export interface FaceParts {
  group: Object3D;
  /** 左眼（眨眼就是把它 scaleY 压扁） */
  eyeL: Mesh;
  eyeR: Mesh;
  mouth: Mesh;
  dispose: () => void;
}

export interface FaceOptions {
  /** 两眼的水平半间距（弧度）。参考图眼睛在球宽 38.5% / 61.5% → 约 ±20° */
  eyeAngle?: number;
  /** 眼的摆放半径（球半径的倍数）。>1 表示浮在球面外一点 */
  radius?: number;
  /** 材料：默认不透明贴图；发光方案可以传自发光/加色材质 */
  eyeMaterial?: () => Material;
  mouthMaterial?: () => Material;
  /** 嘴的整体缩放（等离子/薄膜等方案嘴用另一种材质时仍走这里） */
  mouthScale?: number;
  /**
   * 整体色调 + 透明度。
   * 给「泡泡/发光」这类方案用：它们要的是**同一张 kawaii 五官贴图**，
   * 只是更淡或换个色。传自定义材质再手工补贴图是错的做法 —— 那会把
   * 贴图丢掉、脸变成两个实心方块，所以这两个参数必须在 buildFace 里就支持。
   */
  tint?: number;
  opacity?: number;
}

/**
 * 脸相对球半径 1.0 的**固定几何** —— **全部由参考图逐像素量出来的**。
 *
 * ── 量法（可复核）────────────────────────────────────────────────────
 * 参考图 1195×1316，球心 (599,623)、半径 R=463（见 tasks.md 的探针记录）。
 * 在球内 0.75R 范围里按"深海军蓝"（`r<130 且 b>r+25`）提取墨迹，
 * 再按行/列投影切出三个组件，实测：
 *   · 左眼 bbox 104×110 px（x≈403..506、y≈522..632）
 *   · 右眼 bbox  99×107 px
 *   · 嘴   bbox  88×35  px（居中线附近，y≈666..700）
 * 换成"除以 R"的无量纲比例就是下面这些数。
 *
 * ── 这次重定标修掉了什么 ─────────────────────────────────────────────
 * 上一版是 `eyeW: 0.6 / eyeH: 0.62 / mouthW: 0.5`，比实测**大了 2.6~2.7 倍**，
 * 于是并排图里眼睛糊满整格、五官整个"贴脸"。根因不是手滑，而是当初这几个数
 * 是"照着参考图看着配"的 —— 而"看着配"在比例上会错得很离谱：
 * 球面 ±20° 的**弦长**是 0.64r，可参考图的眼睛只有 0.22r 宽。
 * 所以这套值现在必须来自像素测量，改动前请重新跑探针（`tmp-ref-face.mjs` 的同款口径）。
 *
 * ── 为什么眼高略大于眼宽 ─────────────────────────────────────────────
 * 104×110 是**竖直略长**的椭圆（高/宽 = 1.06），这也是参考图里那种
 * "微微竖长的圆眼"，不是正圆也不是扁圆。贴图保持同一比例，
 * 平面就按同一比例建，避免非等比拉伸把眼睛拉变形。
 */
export const FACE_GEOM = {
  /** 眼心水平半间隔（弧度）。实测眼心 ±153px / R=463 → sin θ = 0.330 */
  eyeAngle: 0.336,
  /** 眼心相对球心的竖直偏移（球半径倍数）。实测在球心**上方** 22px → 0.048R */
  eyeLat: 0.048,
  /** 单只眼宽 / 球半径。实测 104/463 = 0.225 */
  eyeW: 0.225,
  /** 单只眼高 / 球半径。实测 110/463 = 0.238 */
  eyeH: 0.238,
  /** 嘴心相对球心的竖直偏移。实测嘴心 y≈683 → 球心下方 60px → -0.130R */
  mouthLat: -0.13,
  /** 嘴的可见宽度 / 球半径。实测 88/463 = 0.190 */
  mouthW: 0.19,
  /** 嘴的弧线所占高度 / 球半径。实测 35/463 = 0.076 */
  mouthH: 0.076,
  /** 脸的摆放半径（球半径的倍数）。>1 = 浮在球面外一点点，避免切进球体 */
  radius: 1.032,
} as const;

/**
 * 在球坐标系里竖直移动 `dy`（世界单位）之后，为了**贴着球面**水平方向要乘的系数。
 *
 * 球面方程 x²+y²+z²=r² 在 y 固定的截面上是半径 √(r²-y²) 的圆，
 * 所以"往上一格"必须按这个系数收窄，否则脸会朝上散开成一个球面三角。
 * 着色器里那几版（虹彩流动 / 等离子 / 薄膜）用同一个公式在顶点着色器里
 * 算 vFacePos，这里再算一遍，两边**必须一致** —— 否则脸和着色器认定的
 * "脸的位置"会差一点，光带就会切到眼睛上。
 */
export function faceRadiusAt(dy: number, r = 1): number {
  return Math.sqrt(Math.max(0, r * r - dy * dy));
}

/**
 * 建一张贴在**球面**上的脸。
 *
 * ── 关键决定：脸不是一块平面贴片，而是「贴到球面切线上的三块小板」
 * 直接用一块 1.3×1.3 的平面贴在球前面会在**边缘切进球体**：
 * 平面到球心的距离在四个角只有 1.02·r/√2 ≈ 0.72r，而球面在那里是 0.72r 以外，
 * 于是眼睛的四角会被球"吃掉"，看起来像贴纸被剪了角。
 * 正确做法是把每块板放到它自己的球面点上（参考图眼睛所在纬度约 20°），
 * 板心正好在球面外侧 1.03r 处 —— 板只有 0.6r 见方，四个角离球心
 * 约 1.07r，仍然在球外，**永不切进球体**，而且自然带上了球面的朝向。
 *
 * 板还会绕自己的 Z 轴转出经度，法线指向球外 —— 所以侧看时眼睛是
 * "贴在球面上"的，不是"浮在球前面的一块牌"。
 */
export function buildFace(opts: FaceOptions = {}): FaceParts {
  const eyeAngle = opts.eyeAngle ?? FACE_GEOM.eyeAngle;
  const radius = opts.radius ?? FACE_GEOM.radius;
  const mouthScale = opts.mouthScale ?? 1;
  const tint = opts.tint;
  const opacity = opts.opacity ?? 1;

  const group = new Scene() as unknown as Object3D;

  const eyeTex = makeEyeTexture();
  const smileTex = makeSmileTexture();
  /**
   * ⚠ 眼片尺寸**直接取 FACE_GEOM**，不要在这里再乘一个"尺寸"参数。
   *
   * 原先写的是 `new PlaneGeometry(FACE_GEOM.eyeW * eyeSize / FACE_GEOM.eyeH, eyeSize)`，
   * 其中 `eyeSize` 默认取 `FACE_GEOM.eyeH` —— 两个 `eyeH` 一约，
   * 宽就变成了 `FACE_GEOM.eyeW`，看着"没问题"；可高度取的是那个参数，
   * 而**没有任何调用方传过它**，于是实际尺寸变成 0.602 × 0.62 世界单位 ——
   * 也就是"球面上 ±18° 的弦长"被当成了板宽，比设计值大 4.33 倍。
   * 现象就是并排图里那两只糊满整格的大眼睛（探针量出来的 `worldW=0.602`，
   * 而按 FACE_GEOM 应当是 0.6 × 0.62 = 0.372 × 0.384）。
   * 一个"默认值恰好让它看起来对"的参数是陷阱：删掉它，几何只有一个来源。
   */
  const eyeGeo = new PlaneGeometry(FACE_GEOM.eyeW, FACE_GEOM.eyeH);
  const mouthGeo = new PlaneGeometry(FACE_GEOM.mouthW * mouthScale, FACE_GEOM.mouthH * mouthScale);

  const madeMaterials: Material[] = [];
  const matFor = (factory: (() => Material) | undefined, map: Texture) => {
    if (factory) {
      const m = factory();
      madeMaterials.push(m);
      return m;
    }
    const m = new MeshBasicMaterial({ map, transparent: true, depthWrite: false });
    if (tint !== undefined) m.color.setHex(tint);
    m.opacity = opacity;
    madeMaterials.push(m);
    return m;
  };

  const eyeMatProto = matFor(opts.eyeMaterial, eyeTex);
  const mouthMatProto = matFor(opts.mouthMaterial, smileTex);

  /**
   * 按「竖直偏移 dy + 水平角 ax」摆到球面上。
   * dy 与 ax 两个自由度正好对应参考图里量出来的"上下位置 / 左右间距"。
   */
  const place = (mesh: Mesh, dy: number, ax: number, extraR = 0) => {
    const r = faceRadiusAt(dy, radius + extraR);
    const x = r * Math.sin(ax);
    const z = r * Math.cos(ax);
    mesh.position.set(x, dy, z);
    // 让板面朝外：看向"从球心穿过板心再往外"的那个点
    mesh.lookAt(x * 2, dy * 2, z * 2);
    mesh.renderOrder = 6;
    return mesh;
  };

  // 眼：两只镜像摆放
  const eyeL = new Mesh(eyeGeo, eyeMatProto.clone());
  const eyeR = new Mesh(eyeGeo, eyeMatProto.clone());
  madeMaterials.push(eyeL.material as Material, eyeR.material as Material);
  place(eyeL, FACE_GEOM.eyeLat, -eyeAngle);
  place(eyeR, FACE_GEOM.eyeLat, eyeAngle);

  // 嘴：中央偏下
  const mouth = new Mesh(mouthGeo, mouthMatProto.clone());
  madeMaterials.push(mouth.material as Material);
  place(mouth, FACE_GEOM.mouthLat, 0);

  group.add(eyeL, eyeR, mouth);

  return {
    group,
    eyeL,
    eyeR,
    mouth,
    dispose: () => {
      eyeTex.dispose();
      smileTex.dispose();
      eyeGeo.dispose();
      mouthGeo.dispose();
      madeMaterials.forEach((m) => m.dispose());
    },
  };
}

/**
 * 眨眼：返回该时刻眼皮的"睁多大"（1 = 全睁，0.04 = 闭上）。
 *
 * 为什么是两个互质周期（5.2s / 7.6s）：单个周期会让眨眼像节拍器。
 * 两个周期的最小公倍数约 39.5s，也就是**四十秒内不会重复同一套节拍**，
 * 看上去才是自然眨眼。
 *
 * 每次合眼只占一个周期的 4% 左右（约 0.2~0.3s）—— 眨眼本来就该这么快。
 */
export function blinkScale(t: number): number {
  const close = (period: number, at: number, spread = 0.022) => {
    const phase = (t / period) % 1;
    let d = phase - at;
    // 环回：让周期首尾相接，避免跨 0 时闪一下
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    const a = Math.abs(d);
    if (a > spread) return 0;
    return 1 - a / spread;
  };
  const k = Math.max(close(5.2, 0.35), close(7.6, 0.72));
  // 用 ease 曲线压成"快合慢开"，比线性自然
  const eased = k * k * (3 - 2 * k);
  return 1 - eased * 0.96;
}

/** 把眨眼下发到脸上（主板与备用板共用同一个通道，所以一起动） */
export function applyBlink(face: FaceParts, scale: number): void {
  const s = Math.max(0.04, scale);
  face.eyeL.scale.set(1, s, 1);
  face.eyeR.scale.set(1, s, 1);
}

/**
 * 呼吸 + 浮动的统一节奏。
 * 参考图球是"静止悬停"的，所以幅度要小（缩放 ±3.5%、上下 ±0.02 世界单位），
 * 大了就变成"弹跳"，不是琉璃。
 */
export function breathe(t: number): { scale: number; floatY: number } {
  return {
    scale: 1 + Math.sin(t * 1.35) * 0.035,
    floatY: Math.sin(t * 1.05 + 1.1) * 0.022,
  };
}
