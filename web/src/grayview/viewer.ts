// ============================================================
// 查看器(模块③宿主):
//   灰模路径 —— grayview.html/demo.html:零灯光 MeshBasicMaterial + 线框,
//   零颜色渲染(§6 灰模纪律,字节级保持)。
//   光影路径 —— luxview.html:水的物理光学材质(Fresnel/Snell/Beer–Lambert/
//   GGX/焦散,见 docs/光影渲染设计-2026-09-08.md)+ 四时段光系 + bloom 辉光。
// ★ 本文件是全工程唯一 import three 的文件(纪律红线);
//   lighting/(预设+高亮策略)与 luxShaders.ts(GLSL 字符串)均 three-free。
// ============================================================

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { WaterEngine } from "../watersim/engine";
import { InteractionController, type SceneSnapshot } from "../interaction/controller";
import { defaultParams, type WaterSimParams } from "../watersim/params";
import type { DropletState } from "../watersim/types";
import {
  LIGHTING_PRESETS,
  RENDER_PARAMS,
  TIME_ORDER,
  sunDirection,
  type RGB,
  type TimeOfDay,
} from "../lighting/presets";
import { computeBridgeEmphasis } from "../lighting/emphasis";
import {
  LUX_BOTTOM_FRAG,
  LUX_BOTTOM_VERT,
  LUX_BRIDGE_FRAG,
  LUX_BRIDGE_VERT,
  LUX_DROPLET_FRAG,
  LUX_DROPLET_VERT,
  LUX_SURFACE_FRAG,
  LUX_SURFACE_VERT,
} from "./luxShaders";

// 灰模色板(§6)
const COLOR_SURFACE = 0x9a9a9a; // 水面实体
const COLOR_WIRE = 0x6e6e6e; // 线框
const COLOR_BG = 0xc8c8c8; // 背景

const WIRE_N = 64; // 线框降采样(§6:防糊)

/** 确定性 PRNG(演示戳点序列;M4 演示脚本归入 demo.ts 后此处移除) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`灰模页缺少 DOM 节点 #${id}`);
  return node as T;
}

// ============================================================
// 光影系统(模块③ lux 路径;灰模路径零接触)
// 装配 luxShaders 的四材质(水面/液滴/液桥共享同一 uniforms 对象)+
// 高度场 DataTexture(渲染与物理同源:bakeTotalInto 缓冲直接上传)+
// EffectComposer(RenderPass + UnrealBloomPass + OutputPass)。
// 时段切换 = 全部 uniforms 向预设一阶渐变(τ=presetLerpTau,太阳不瞬移)。
// ============================================================

interface LuxSystem {
  surfaceMat: THREE.ShaderMaterial;
  dropletMat: THREE.ShaderMaterial;
  bridgeMat: THREE.ShaderMaterial;
  bottomMat: THREE.ShaderMaterial;
  composer: EffectComposer;
  onTimeChange: ((tod: TimeOfDay) => void) | null;
  setTimeOfDay(tod: TimeOfDay): void;
  /** 烘焙缓冲(heightData)已更新后调用:置纹理上传标记 */
  updateHeight(): void;
  /** 每渲染帧:时段渐变 + bloom 参数 + 时间/压暗 uniforms */
  update(args: { dt: number; simTime: number; dim: number }): void;
  /** 漂浮液滴 → 水底解析软影 uniforms */
  setFloating(state: DropletState, half: number): void;
  resize(w: number, h: number): void;
}

/** 液滴软影 uniform 池容量(= maxDroplets 范围上限) */
const LUX_MAXD = 64;

function createLuxSystem(opts: {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  N: number;
  dx: number;
  domainSize: number;
  heightData: Float32Array;
}): LuxSystem {
  const { renderer, scene, camera, N, dx, domainSize, heightData } = opts;
  const half = domainSize / 2;

  // ---- 高度场纹理(网格顶点 ↔ 纹素一一对应;nearest 即精确格心采样) ----
  const floatLinear = renderer.extensions.has("OES_texture_float_linear");
  const heightTex = new THREE.DataTexture(
    heightData,
    N,
    N,
    THREE.RedFormat,
    THREE.FloatType,
  );
  heightTex.magFilter = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
  heightTex.minFilter = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
  heightTex.wrapS = THREE.ClampToEdgeWrapping;
  heightTex.wrapT = THREE.ClampToEdgeWrapping;
  heightTex.generateMipmaps = false;
  heightTex.needsUpdate = true;

  // 世界坐标 → 高度纹理 uv(格心对齐:x = i·dx − half ↔ uv = (i+0.5)/N)
  const uvScale = 1 / (N * dx);
  const uvOffset = (half + 0.5 * dx) * uvScale;

  const dropPosArr = Array.from({ length: LUX_MAXD }, () => new THREE.Vector2());
  const dropRadArr: number[] = new Array(LUX_MAXD).fill(0);

  // 具体类型推断(非 Record):属性访问保持 .value 的精确类型,免索引 undefined
  const uniforms = {
    uHeightTex: { value: heightTex },
    uTexel: { value: new THREE.Vector2(1 / N, 1 / N) },
    uUvK: { value: new THREE.Vector2(uvScale, uvOffset) },
    uDomain: { value: domainSize },
    uPoolDepth: { value: RENDER_PARAMS.poolDepth },
    uEta: { value: 1 / RENDER_PARAMS.refractiveIndex },
    uF0: { value: RENDER_PARAMS.fresnelF0 },
    uAbsorb: {
      value: new THREE.Vector3(
        RENDER_PARAMS.waterAbsorb[0],
        RENDER_PARAMS.waterAbsorb[1],
        RENDER_PARAMS.waterAbsorb[2],
      ),
    },
    uRough: { value: RENDER_PARAMS.roughness },
    uSunDir: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color() },
    uAmbSky: { value: new THREE.Color() },
    uAmbGround: { value: new THREE.Color() },
    uSkyHorizon: { value: new THREE.Color() },
    uSkyZenith: { value: new THREE.Color() },
    uMistColor: { value: new THREE.Color() },
    uMistDensity: { value: 0 },
    uWaterBody: { value: new THREE.Color() },
    uBottomAlbedo: { value: new THREE.Color() },
    uCausticScale: { value: 1 },
    uGlint: { value: 1 },
    uShadow: { value: 0.3 },
    uNightDots: { value: 0 },
    uNightDotColor: { value: new THREE.Color() },
    uDotCell: { value: RENDER_PARAMS.nightDotCell },
    uTime: { value: 0 },
    uDim: { value: 0 },
    uExposure: { value: 1 },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uBridgeOpacity: { value: RENDER_PARAMS.bridgeOpacity },
    uBridgeHiOpacity: { value: RENDER_PARAMS.bridgeHiOpacity },
    uDropDarken: { value: RENDER_PARAMS.dropletDarken },
    uDropPos: { value: dropPosArr },
    uDropRad: { value: dropRadArr },
    uDropCountF: { value: 0 },
  };

  const surfaceMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: LUX_SURFACE_VERT,
    fragmentShader: LUX_SURFACE_FRAG,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false, // 透明水面不写深度,让水底 mesh 透过可见
  });
  const dropletMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: LUX_DROPLET_VERT,
    fragmentShader: LUX_DROPLET_FRAG,
  });
  const bridgeMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: LUX_BRIDGE_VERT,
    fragmentShader: LUX_BRIDGE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const bottomMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: LUX_BOTTOM_VERT,
    fragmentShader: LUX_BOTTOM_FRAG,
    side: THREE.DoubleSide,
  });

  // ---- 后期:HDR MSAA 目标 + bloom(傍晚辉光主力)+ OutputPass(色调映射/sRGB) ----
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(size.clone(), 0.2, 0.4, 0.7);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---- 场景背景(时段渐变 × 聚焦压暗,lux 全权持有) ----
  const bgBase = new THREE.Color(); // 纯时段色(渐变收敛值)
  const bgDim = new THREE.Color(); // 实际呈现 = bgBase ×(1 − 0.55·聚焦压暗)
  scene.background = bgDim;

  // ---- 时段状态:cur 直接活在 uniforms,target 预转 three 对象 ----
  let target = LIGHTING_PRESETS.dawn;
  const tSunDir = new THREE.Vector3();
  const cSun = new THREE.Color();
  const cAmbSky = new THREE.Color();
  const cAmbGround = new THREE.Color();
  const cHorizon = new THREE.Color();
  const cZenith = new THREE.Color();
  const cMist = new THREE.Color();
  const cBody = new THREE.Color();
  const cAlbedo = new THREE.Color();
  const cDots = new THREE.Color();
  const cBg = new THREE.Color();

  const setTarget = (p: (typeof LIGHTING_PRESETS)[TimeOfDay]): void => {
    target = p;
    const d = sunDirection(p);
    tSunDir.set(d[0], d[1], d[2]);
    // 预设颜色 = 期望屏显 sRGB 值 → 转线性工作空间;sRGBToLinear(c>1) 发散,
    // 故主光按「色相(≤1)转线性 × 线性强度倍率」两步合成 HDR
    const srgb = (c: RGB, out: THREE.Color): void => {
      out.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    };
    srgb(p.sunColor, cSun);
    cSun.multiplyScalar(p.sunIntensity);
    srgb(p.ambSky, cAmbSky);
    srgb(p.ambGround, cAmbGround);
    srgb(p.skyHorizon, cHorizon);
    srgb(p.skyZenith, cZenith);
    srgb(p.mistColor, cMist);
    srgb(p.waterBody, cBody);
    srgb(p.bottomAlbedo, cAlbedo);
    srgb(p.nightDotColor, cDots);
    srgb(p.background, cBg);
  };

  /** 首帧直接就位(从 0 渐变会有黑场闪帧) */
  const snap = (): void => {
    uniforms.uSunDir.value.copy(tSunDir);
    uniforms.uSunColor.value.copy(cSun);
    uniforms.uAmbSky.value.copy(cAmbSky);
    uniforms.uAmbGround.value.copy(cAmbGround);
    uniforms.uSkyHorizon.value.copy(cHorizon);
    uniforms.uSkyZenith.value.copy(cZenith);
    uniforms.uMistColor.value.copy(cMist);
    uniforms.uWaterBody.value.copy(cBody);
    uniforms.uBottomAlbedo.value.copy(cAlbedo);
    uniforms.uNightDotColor.value.copy(cDots);
    uniforms.uMistDensity.value = target.mistDensity;
    uniforms.uCausticScale.value = target.causticScale;
    uniforms.uGlint.value = target.glintGain;
    uniforms.uShadow.value = target.shadowStrength;
    uniforms.uNightDots.value = target.nightDots;
    uniforms.uExposure.value = target.exposure;
    uniforms.uSat.value = target.saturation;
    uniforms.uContrast.value = target.contrast;
    bloom.strength = target.bloomStrength;
    bloom.threshold = target.bloomThreshold;
    bloom.radius = target.bloomRadius;
    bgBase.copy(cBg);
    bgDim.copy(bgBase);
  };
  setTarget(LIGHTING_PRESETS.dawn);
  snap();

  const sys: LuxSystem = {
    surfaceMat,
    dropletMat,
    bridgeMat,
    bottomMat,
    composer,
    onTimeChange: null,
    setTimeOfDay(tod: TimeOfDay): void {
      if (!TIME_ORDER.includes(tod)) return;
      setTarget(LIGHTING_PRESETS[tod]);
      sys.onTimeChange?.(tod);
    },
    updateHeight(): void {
      heightTex.needsUpdate = true;
    },
    update({ dt, simTime, dim }): void {
      const k = 1 - Math.exp(-Math.max(0, dt) / RENDER_PARAMS.presetLerpTau);
      uniforms.uSunDir.value.lerp(tSunDir, k).normalize();
      uniforms.uSunColor.value.lerp(cSun, k);
      uniforms.uAmbSky.value.lerp(cAmbSky, k);
      uniforms.uAmbGround.value.lerp(cAmbGround, k);
      uniforms.uSkyHorizon.value.lerp(cHorizon, k);
      uniforms.uSkyZenith.value.lerp(cZenith, k);
      uniforms.uMistColor.value.lerp(cMist, k);
      uniforms.uWaterBody.value.lerp(cBody, k);
      uniforms.uBottomAlbedo.value.lerp(cAlbedo, k);
      uniforms.uNightDotColor.value.lerp(cDots, k);
      const lerpTo = (u: { value: number }, v: number): void => {
        u.value += (v - u.value) * k;
      };
      lerpTo(uniforms.uMistDensity, target.mistDensity);
      lerpTo(uniforms.uCausticScale, target.causticScale);
      lerpTo(uniforms.uGlint, target.glintGain);
      lerpTo(uniforms.uShadow, target.shadowStrength);
      uniforms.uNightDots.value = target.nightDots; // 离散开关,直接切换
      lerpTo(uniforms.uExposure, target.exposure);
      lerpTo(uniforms.uSat, target.saturation);
      lerpTo(uniforms.uContrast, target.contrast);
      bloom.strength += (target.bloomStrength - bloom.strength) * k;
      bloom.threshold += (target.bloomThreshold - bloom.threshold) * k;
      bloom.radius += (target.bloomRadius - bloom.radius) * k;
      bgBase.lerp(cBg, k);
      bgDim.copy(bgBase).multiplyScalar(1 - 0.55 * Math.min(1, dim));
      uniforms.uTime.value = simTime;
      uniforms.uDim.value = dim;
    },
    setFloating(state: DropletState, h: number): void {
      let n = 0;
      for (let i = 0; i < state.count && n < LUX_MAXD; i++) {
        if (state.floating[i] !== 1) continue;
        dropPosArr[n]!.set(state.x[i]! - h, state.y[i]! - h);
        dropRadArr[n] = state.r[i]!;
        n++;
      }
      uniforms.uDropCountF.value = n;
    },
    resize(w: number, h: number): void {
      composer.setSize(w, h);
    },
  };
  return sys;
}

/**
 * 查看器钩子(演示页 demo.ts 使用;普通灰模页不传):
 * - tick:每渲染帧在物理步进后调用(拿到引擎实时句柄,驱动时间线事件)
 * - caption:返回当前字幕文本(null 隐藏),渲染到 #gray-caption(若页面存在)
 */
export interface ViewerHooks {
  /** 禁用内置随机戳点脚本(演示页用自己的时间线接管) */
  disablePokes?: boolean;
  tick?: (engine: WaterEngine, frameDt: number) => void;
  caption?: (simTime: number) => string | null;
  /** 重播/重置时调用:宿主复位自己的时间线状态(引擎已由 viewer 重建) */
  reset?: () => void;
}

/** 灰模查看器(grayview.html / demo.html;零灯光零彩色,§6) */
export function mountGrayViewer(
  container: HTMLElement,
  params: WaterSimParams = defaultParams,
  hooks: ViewerHooks = {},
): void {
  mountViewer(container, params, hooks, false);
}

/** 光影查看器(luxview.html;模块③四时段水材质光影) */
export function mountLuxViewer(
  container: HTMLElement,
  params: WaterSimParams = defaultParams,
  hooks: ViewerHooks = {},
): void {
  mountViewer(container, params, hooks, true);
}

function mountViewer(
  container: HTMLElement,
  params: WaterSimParams,
  hooks: ViewerHooks,
  lux: boolean,
): void {
  // ---- HUD 引用 ----
  const hudError = el<HTMLDivElement>("gray-error");
  const hudFps = el<HTMLSpanElement>("gray-fps");
  const hudTime = el<HTMLSpanElement>("gray-time");
  const hudSteps = el<HTMLSpanElement>("gray-steps");
  const hudEnergy = el<HTMLSpanElement>("gray-energy");
  const hudDroplets = el<HTMLSpanElement>("gray-droplets");
  const hudMerges = el<HTMLSpanElement>("gray-merges");
  const btnPause = el<HTMLButtonElement>("gray-btn-pause");
  const btnStep = el<HTMLButtonElement>("gray-btn-step");
  const btnReset = el<HTMLButtonElement>("gray-btn-reset");
  const btnWire = el<HTMLButtonElement>("gray-btn-wire");
  const btnDrop = el<HTMLButtonElement>("gray-btn-drop");
  const btnPair = el<HTMLButtonElement>("gray-btn-pair");
  const btnNet = el<HTMLButtonElement>("gray-btn-net");

  const showError = (message: string): void => {
    hudError.textContent = `启动失败:${message}`;
    hudError.style.display = "block";
  };

  // ---- 引擎(启动即断言 CFL/范围,违规 throw → 红字) ----
  let engine: WaterEngine;
  try {
    engine = new WaterEngine(params);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }

  const { N, dx } = engine.field;
  const half = params.domainSize / 2;
  const gridToWorld = (g: number): number => g * dx - half; // 域中心置于原点

  // ---- three 场景 ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // 光影路径:ACES 电影级色调映射(OutputPass 承担;灰模保持 NoToneMapping)
  if (lux) renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLOR_BG);

  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.01,
    20,
  );
  camera.position.set(0, 1.0, 1.4);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  // ---- 水面实体:自建 N×N 网格,顶点 (i,j) ↔ 场格 (i,j),行主序一一对应 ----
  const surfaceGeo = new THREE.BufferGeometry();
  const surfacePos = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      surfacePos[k * 3] = gridToWorld(i);
      surfacePos[k * 3 + 1] = 0;
      surfacePos[k * 3 + 2] = gridToWorld(j);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const surfacePosAttr = new THREE.BufferAttribute(surfacePos, 3);
  surfaceGeo.setAttribute("position", surfacePosAttr);
  surfaceGeo.setIndex(index);
  const surface = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
    surfaceGeo,
    new THREE.MeshBasicMaterial({
      color: COLOR_SURFACE,
      side: THREE.DoubleSide,
      // 把实体面往深度里推一点,防共面线框 z-fighting(线框是几何显示,必须可见)
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  scene.add(surface);

  // ---- 水底平面:浅蓝白渐变,在 y = -poolDepth(任务②) ----
  // 略大于域(×1.4)使边缘从水面外可见;灰模用灰色,lux 用渐变 shader。
  const bottomGeo = new THREE.PlaneGeometry(
    params.domainSize * 1.4,
    params.domainSize * 1.4,
  );
  const bottomMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
    bottomGeo,
    new THREE.MeshBasicMaterial({ color: 0x7a7a7a, side: THREE.DoubleSide }),
  );
  bottomMesh.rotation.x = -Math.PI / 2; // 水平铺设
  bottomMesh.position.y = -RENDER_PARAMS.poolDepth;
  scene.add(bottomMesh);

  // ---- 线框:64×64 降采样 LineSegments(几何显示,非光照) ----
  const wireIdx = (k: number): number =>
    Math.round((k * (N - 1)) / (WIRE_N - 1));
  const wireSegs: [number, number][] = [];
  for (let j = 0; j < WIRE_N; j++) {
    const r = wireIdx(j); // 采样行
    for (let i = 0; i < WIRE_N - 1; i++) {
      wireSegs.push([r * N + wireIdx(i), r * N + wireIdx(i + 1)]); // 横向(沿 x)
    }
  }
  for (let i = 0; i < WIRE_N; i++) {
    const c = wireIdx(i); // 采样列
    for (let j = 0; j < WIRE_N - 1; j++) {
      wireSegs.push([wireIdx(j) * N + c, wireIdx(j + 1) * N + c]); // 纵向(沿 z)
    }
  }
  const wireGeo = new THREE.BufferGeometry();
  const wirePos = new Float32Array(wireSegs.length * 6);
  // 端点 x/z 一次性构建(网格索引 → 世界坐标);y 由每帧同步写入
  for (let s = 0; s < wireSegs.length; s++) {
    const a = wireSegs[s]![0]!;
    const b = wireSegs[s]![1]!;
    wirePos[s * 6 + 0] = gridToWorld(a % N);
    wirePos[s * 6 + 2] = gridToWorld(Math.floor(a / N));
    wirePos[s * 6 + 3] = gridToWorld(b % N);
    wirePos[s * 6 + 5] = gridToWorld(Math.floor(b / N));
  }
  const wirePosAttr = new THREE.BufferAttribute(wirePos, 3);
  wireGeo.setAttribute("position", wirePosAttr);
  const wireMesh = new THREE.LineSegments(
    wireGeo,
    new THREE.LineBasicMaterial({ color: COLOR_WIRE }),
  );
  scene.add(wireMesh);

  // ---- 液滴:球冠透镜状(参考液滴浮于液面建模文档)----
  // 球冠参数化:接触半径 r_c、高度 H、曲率半径 R、接触角 θ
  //   H = R(1−cosθ),r_c = R·sinθ → R = (r_c² + H²)/(2H),θ = arcsin(r_c/R)
  // 取 r_c = 1(单位),H = LENS_H = 0.3(扁平透镜)→ R ≈ 1.817,θ ≈ 33.4°
  // 几何 = 上凸球冠(光滑曲面) + 下平圆盘,边缘相接成封闭透镜
  // 实例缩放 (r, r·LENS_H·(1−ε), r):r 控制水平展幅,y 向 ε 振荡 = 厚度压缩
  // 物理侧保留水面耦合反馈与凹陷核 → 液面呈内凹外微凸形态
  const LENS_H = 0.3; // 球冠高度(单位接触半径下)
  const LENS_R_CAP = (1 + LENS_H * LENS_H) / (2 * LENS_H); // 曲率半径 ≈1.817
  const LENS_THETA_MAX = Math.asin(1 / LENS_R_CAP); // 接触角 ≈0.583 rad
  const LENS_SEG_AZ = 32; // 周向分段(光滑圆周)
  const LENS_SEG_POL = 16; // 极角分段(顶 → 边缘,光滑曲面)
  // 构建球冠透镜 BufferGeometry(接触半径=1,底面 y=0,顶 y=LENS_H,中心 y=LENS_H/2)
  const lensGeo = new THREE.BufferGeometry();
  {
    const verts: number[] = [];
    const norms: number[] = [];
    const idx: number[] = [];
    // 球心在 y = R − H(冠顶 y = 球心.y + R = R − H + R = 2R − H... 不对)
    // 正确:球心在 y = −(R − H),冠顶 y = 球心.y + R = H,边缘 y = 球心.y + R·cosθ = 0
    const sphereCenterY = -(LENS_R_CAP - LENS_H); // 球心 y = H − R ≈ −1.517
    // 顶部单顶点(北极,theta=0)
    const topIdx = 0;
    verts.push(0, LENS_H, 0);
    norms.push(0, 1, 0);
    // 环带:theta 从 Δθ 到 θ_max(跳过 theta=0,顶部已建单顶点)
    const rings: number[][] = []; // rings[p] = 第 p 环的顶点索引数组(p=1..LENS_SEG_POL)
    for (let p = 1; p <= LENS_SEG_POL; p++) {
      const theta = (p / LENS_SEG_POL) * LENS_THETA_MAX;
      const ring: number[] = [];
      for (let a = 0; a < LENS_SEG_AZ; a++) {
        const phi = (a / LENS_SEG_AZ) * Math.PI * 2;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        const x = LENS_R_CAP * sinT * Math.cos(phi);
        const z = LENS_R_CAP * sinT * Math.sin(phi);
        const y = sphereCenterY + LENS_R_CAP * cosT;
        verts.push(x, y, z);
        norms.push(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
        ring.push(verts.length / 3 - 1);
      }
      rings.push(ring);
    }
    // 顶部三角形扇(顶点 → 第一环)
    // 绕序:从外部(上方)看顺时针 → 面法线朝上(向外,与顶点法线一致)
    const firstRing = rings[0]!;
    for (let a = 0; a < LENS_SEG_AZ; a++) {
      const a2 = (a + 1) % LENS_SEG_AZ;
      idx.push(topIdx, firstRing[a2]!, firstRing[a]!);
    }
    // 环带四边形(两个三角形)
    // 绕序:面法线朝外(径向外 + 上),与顶点法线一致
    for (let p = 0; p < LENS_SEG_POL - 1; p++) {
      const r0 = rings[p]!;
      const r1 = rings[p + 1]!;
      for (let a = 0; a < LENS_SEG_AZ; a++) {
        const a2 = (a + 1) % LENS_SEG_AZ;
        idx.push(r0[a]!, r0[a2]!, r1[a]!);
        idx.push(r0[a2]!, r1[a2]!, r1[a]!);
      }
    }
    // 下平圆盘:中心顶点 + 边缘环(复用最后一环 rings[LENS_SEG_POL-1])
    // 绕序:从外部(下方)看顺时针 → 面法线朝下(向外,与顶点法线一致)
    const bottomCenter = verts.length / 3;
    verts.push(0, 0, 0);
    norms.push(0, -1, 0);
    const edgeRing = rings[LENS_SEG_POL - 1]!;
    for (let a = 0; a < LENS_SEG_AZ; a++) {
      const a2 = (a + 1) % LENS_SEG_AZ;
      idx.push(bottomCenter, edgeRing[a]!, edgeRing[a2]!);
    }
    lensGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    lensGeo.setAttribute("normal", new THREE.Float32BufferAttribute(norms, 3));
    lensGeo.setIndex(idx);
  }
  const dropletMesh = new THREE.InstancedMesh<
    THREE.BufferGeometry,
    THREE.Material
  >(lensGeo, new THREE.MeshBasicMaterial({ color: 0x4a4a4a }), params.maxDroplets);
  dropletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dropletMesh.frustumCulled = false;
  dropletMesh.count = 0;
  scene.add(dropletMesh);

  // ---- lux 共享状态(luxSys 非空才启用;声明先于同步函数,赋值在光影装配块) ----
  let luxSys: LuxSystem | null = null;
  let epsAttr: THREE.InstancedBufferAttribute | null = null;
  let bridgeNrmAttr: THREE.BufferAttribute | null = null;
  let bridgeEmphAttr: THREE.BufferAttribute | null = null;
  const emphTarget = new Float32Array((params.maxDroplets * (params.maxDroplets - 1)) / 2);
  const emphCur = new Float32Array((params.maxDroplets * (params.maxDroplets - 1)) / 2);

  const dropletMatrix = new THREE.Matrix4();
  const syncDroplets = (): void => {
    const d = engine.droplets.state;
    dropletMesh.count = d.count;
    for (let i = 0; i < d.count; i++) {
      const r = d.r[i]!;
      // 透镜缩放:xz=r(水平展幅),y=r·LENS_H·(1−ε)(透镜厚度方向,ε 振荡=厚度压缩)
      // 几何体底面 y=0 → setPosition y = 底面世界 y(贴水面)
      const lensThick = r * LENS_H * (1 - d.eps[i]!);
      dropletMatrix.makeScale(r, lensThick, r);
      // 透镜完全托举在液面:底面贴水面总高度。
      // 漂浮态用水面总高度(含波纹);空中段(未入水)用物理 z 保持抛物线轨迹。
      const surfH = d.floating[i] === 1
        ? engine.field.totalHeight(d.x[i]!, d.y[i]!)
        : d.z[i]! - r; // 空中:底面 = 物理 z − R(球模型)
      dropletMatrix.setPosition(
        d.x[i]! - half,
        surfH,
        d.y[i]! - half,
      );
      dropletMesh.setMatrixAt(i, dropletMatrix);
      if (epsAttr) epsAttr.setX(i, d.eps[i]!);
    }
    dropletMesh.instanceMatrix.needsUpdate = true;
    if (epsAttr) epsAttr.needsUpdate = true;
  };

  // ---- 液桥渲染(任务①):颈状管(两端略宽、中间收窄;表面到表面跨距) ----
  const BRIDGE_LEN = 10; // 轴向环数
  const BRIDGE_RAD = 8; // 周向边数
  // 桥池 = 完全图边数(连接语义:任意两漂浮滴都可成桥;须与 BridgeSystem 容量一致)
  const bridgeMax = (params.maxDroplets * (params.maxDroplets - 1)) / 2;
  const vertsPerBridge = (BRIDGE_LEN + 1) * BRIDGE_RAD;
  const bridgeGeo = new THREE.BufferGeometry();
  const bridgePos = new Float32Array(bridgeMax * vertsPerBridge * 3);
  const bridgeIdx: number[] = [];
  for (let b = 0; b < bridgeMax; b++) {
    const base = b * vertsPerBridge;
    for (let s = 0; s < BRIDGE_LEN; s++) {
      for (let r = 0; r < BRIDGE_RAD; r++) {
        const r2 = (r + 1) % BRIDGE_RAD;
        const a = base + s * BRIDGE_RAD + r;
        const bb = base + s * BRIDGE_RAD + r2;
        const c = base + (s + 1) * BRIDGE_RAD + r;
        const dd = base + (s + 1) * BRIDGE_RAD + r2;
        bridgeIdx.push(a, c, bb, bb, c, dd);
      }
    }
  }
  const bridgePosAttr = new THREE.BufferAttribute(bridgePos, 3);
  bridgePosAttr.setUsage(THREE.DynamicDrawUsage);
  bridgeGeo.setAttribute("position", bridgePosAttr);
  bridgeGeo.setIndex(bridgeIdx);
  const bridgeMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
    bridgeGeo,
    new THREE.MeshBasicMaterial({ color: 0x4a4a4a, side: THREE.DoubleSide }),
  );
  bridgeMesh.frustumCulled = false;
  scene.add(bridgeMesh);

  const syncBridges = (): void => {
    const bs = engine.bridges.state;
    const d = engine.droplets.state;
    for (let k = 0; k < bridgeMax; k++) {
      const base = k * vertsPerBridge;
      const active = k < bs.count && bs.cut[k] === 0;
      if (!active) {
        // 收缩到原点(不可见)
        for (let v = 0; v < vertsPerBridge; v++) {
          bridgePos[(base + v) * 3] = 0;
          bridgePos[(base + v) * 3 + 1] = 0;
          bridgePos[(base + v) * 3 + 2] = 0;
        }
        continue;
      }
      const ia = bs.a[k]!;
      const ib = bs.b[k]!;
      const ax = d.x[ia]! - half;
      const az = d.y[ia]! - half;
      const ay = d.z[ia]!;
      const bx = d.x[ib]! - half;
      const bz = d.y[ib]! - half;
      const by = d.z[ib]!;
      // 轴与正交基
      let ux = bx - ax;
      let uy = by - ay;
      let uz = bz - az;
      const len = Math.hypot(ux, uy, uz) || 1;
      ux /= len;
      uy /= len;
      uz /= len;
      // n1 = axis × up(域内近水平轴,退化防护)
      let n1x = uy * 0 - uz * 1;
      let n1y = uz * 0 - ux * 0;
      let n1z = ux * 1 - uy * 0;
      let n1l = Math.hypot(n1x, n1y, n1z);
      if (n1l < 1e-6) {
        n1x = 1;
        n1y = 0;
        n1z = 0;
      } else {
        n1x /= n1l;
        n1y /= n1l;
        n1z /= n1l;
      }
      // n2 = axis × n1
      const n2x = uy * n1z - uz * n1y;
      const n2y = uz * n1x - ux * n1z;
      const n2z = ux * n1y - uy * n1x;
      // 桥管形(第三批②再收窄 + 本批颈径再收窄):
      // - 跨距表面到表面:两端各内嵌 0.75r(接头藏入液滴内部,同色不可见);
      // - 端径 0.36·r(两端按各自液滴比例张开,大滴端更粗)、颈径 0.18·min(r),
      //   颈/端比 ≈0.5——两端略宽、中间显著收窄的细颈(委托方「液桥中心宽度再收窄」);
      // - 拉伸变细:半径 ×√(restLen/dist)(体积守恒的观感,拉伸成细丝而不断裂)
      const ra = d.r[ia]!;
      const rb = d.r[ib]!;
      const rNeck = 0.18 * Math.min(ra, rb);
      const rEndA = 0.36 * ra;
      const rEndB = 0.36 * rb;
      const bsState = engine.bridges.state;
      const thin = Math.min(
        1.25,
        Math.max(0.5, Math.sqrt(bsState.restLen[k]! / len)),
      );
      const pax = ax + ux * (0.75 * ra);
      const pay = ay + uy * (0.75 * ra);
      const paz = az + uz * (0.75 * ra);
      const pbx = bx - ux * (0.75 * rb);
      const pby = by - uy * (0.75 * rb);
      const pbz = bz - uz * (0.75 * rb);
      for (let s = 0; s <= BRIDGE_LEN; s++) {
        const t = s / BRIDGE_LEN;
        const rEnd = t < 0.5 ? rEndA : rEndB;
        // lux:高亮加粗(委托方「变亮加粗」;灰模无此属性,因子=1)
        const emph = bridgeEmphAttr ? emphCur[k]! : 0;
        const thick = 1 + RENDER_PARAMS.bridgeHiThicken * emph;
        const rr =
          (rNeck + (rEnd - rNeck) * Math.abs(2 * t - 1) ** 1.5) * thin * thick;
        const cx = pax + (pbx - pax) * t;
        const cy = pay + (pby - pay) * t;
        const cz = paz + (pbz - paz) * t;
        for (let r = 0; r < BRIDGE_RAD; r++) {
          const ang = (r / BRIDGE_RAD) * Math.PI * 2;
          const c = Math.cos(ang);
          const s2 = Math.sin(ang);
          const ox = c * rr;
          const oy = s2 * rr;
          const vi = (base + s * BRIDGE_RAD + r) * 3;
          bridgePos[vi] = cx + n1x * ox + n2x * oy;
          bridgePos[vi + 1] = cy + n1y * ox + n2y * oy;
          bridgePos[vi + 2] = cz + n1z * ox + n2z * oy;
          if (bridgeNrmAttr) {
            const nrm = bridgeNrmAttr.array as Float32Array;
            nrm[vi] = n1x * c + n2x * s2;
            nrm[vi + 1] = n1y * c + n2y * s2;
            nrm[vi + 2] = n1z * c + n2z * s2;
          }
        }
      }
      if (bridgeEmphAttr) {
        const ea = bridgeEmphAttr.array as Float32Array;
        ea.fill(emphCur[k]!, base, base + vertsPerBridge);
      }
    }
    bridgePosAttr.needsUpdate = true;
    if (bridgeNrmAttr) bridgeNrmAttr.needsUpdate = true;
    if (bridgeEmphAttr) bridgeEmphAttr.needsUpdate = true;
  };

  const syncWireVisibility = (): void => {
    wireMesh.visible = wireOn;
    btnWire.textContent = wireOn ? "线框:开" : "线框:关";
  };

  // ---- 演示戳点脚本(M1 可视化驱动;seed 确定性,M4 由 demo.ts 接管) ----
  let rng: () => number;
  let nextPokeT: number;
  let pokeGapT: number;
  const scheduleReset = (): void => {
    rng = mulberry32(params.seed);
    nextPokeT = 0.5; // 首戳:场中心
    pokeGapT = 2.5;
  };
  const applyDuePokes = (): void => {
    const t = engine.stats.simTime;
    let guard = 0;
    while (nextPokeT <= t && guard++ < 64) {
      if (nextPokeT === 0.5) {
        engine.addImpulse(0.5, 0.5, 0.02, -0.02);
      } else {
        engine.addImpulse(
          0.2 + rng() * 0.6,
          0.2 + rng() * 0.6,
          0.012 + rng() * 0.008,
          -0.008 - rng() * 0.012,
        );
      }
      nextPokeT += pokeGapT;
    }
  };

  // ---- 几何同步(整改 A:面/线框位移 = 动态 h + 准静态核,烘焙总高度) ----
  const totalHeightBuf = new Float32Array(N * N);
  const bakeTotal = (): void => {
    engine.field.bakeTotalInto(totalHeightBuf);
  };
  const updateSurface = (): void => {
    for (let k = 0; k < N * N; k++) {
      surfacePos[k * 3 + 1] = totalHeightBuf[k]!;
    }
    surfacePosAttr.needsUpdate = true;
    surfaceGeo.computeBoundingSphere();
  };
  const updateWire = (): void => {
    for (let s = 0; s < wireSegs.length; s++) {
      const [a, b] = wireSegs[s]!;
      wirePos[s * 6 + 1] = totalHeightBuf[a]!;
      wirePos[s * 6 + 4] = totalHeightBuf[b]!;
    }
    wirePosAttr.needsUpdate = true;
  };

  // ---- 模块③光影装配(luxview.html;灰模路径零接触) ----
  // 依赖烘焙缓冲 totalHeightBuf(高度纹理与其同源,渲染与物理一个数据源)
  if (lux) {
    luxSys = createLuxSystem({
      renderer,
      scene,
      camera,
      N,
      dx,
      domainSize: params.domainSize,
      heightData: totalHeightBuf,
    });
    surface.material = luxSys.surfaceMat;
    dropletMesh.material = luxSys.dropletMat;
    bridgeMesh.material = luxSys.bridgeMat;
    bottomMesh.material = luxSys.bottomMat;
    bridgeMesh.renderOrder = 10; // 透明液桥最后画
    // 实例属性:压扁系数(法线修正)/ 桥逐顶点法线与高亮因子
    epsAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(params.maxDroplets),
      1,
    );
    dropletMesh.geometry.setAttribute("aEps", epsAttr);
    bridgeNrmAttr = new THREE.BufferAttribute(
      new Float32Array(bridgeMax * vertsPerBridge * 3),
      3,
    );
    bridgeGeo.setAttribute("normal", bridgeNrmAttr);
    bridgeEmphAttr = new THREE.BufferAttribute(
      new Float32Array(bridgeMax * vertsPerBridge),
      1,
    );
    bridgeGeo.setAttribute("aEmph", bridgeEmphAttr);
    // 预建 instanceColor 缓冲(USE_INSTANCING_COLOR 需在首帧编译前存在)
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < params.maxDroplets; i++) dropletMesh.setColorAt(i, white);
    // 时段按钮(lux 页专属;缺节点即跳过)
    const todBtns: [TimeOfDay, string][] = [
      ["dawn", "lux-btn-dawn"],
      ["noon", "lux-btn-noon"],
      ["dusk", "lux-btn-dusk"],
      ["night", "lux-btn-night"],
    ];
    for (const [tod, id] of todBtns) {
      document.getElementById(id)?.addEventListener("click", () => {
        luxSys?.setTimeOfDay(tod);
      });
    }
    luxSys.onTimeChange = (tod) => {
      for (const [t, id] of todBtns) {
        document.getElementById(id)?.classList.toggle("lux-active", t === tod);
      }
    };
    luxSys.onTimeChange("dawn");
  }

  // ---- 交互系统接线(模块②适配层:DOM 指针 → 意图 → 引擎;相机/灰度表现) ----
  const controller = new InteractionController();
  const snap: SceneSnapshot = {
    count: 0,
    cx: new Float32Array(params.maxDroplets),
    cy: new Float32Array(params.maxDroplets),
    cr: new Float32Array(params.maxDroplets),
  };
  let pointerValid = false;
  let pointerSX = 0;
  let pointerSY = 0;
  let pointerWorldX = 0;
  let pointerWorldY = 0;
  let pointerDown = false;
  let justDown = false;
  let focusGroup: number[] = [];
  let focusMix = 0;
  let savedCamPos: THREE.Vector3 | null = null;
  let savedCamTgt: THREE.Vector3 | null = null;
  let camAnim: {
    t: number;
    dur: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTgt: THREE.Vector3;
    toTgt: THREE.Vector3;
  } | null = null;

  const projV = new THREE.Vector3();
  const halfFov = (camera.fov * Math.PI) / 360;

  /** 指针射线与水面平面(世界 y=0)解析求交 → 引擎坐标(米) */
  const pointerToWorld = (sx: number, sy: number): { x: number; y: number } | null => {
    const ndcX = (sx / window.innerWidth) * 2 - 1;
    const ndcY = -(sy / window.innerHeight) * 2 + 1;
    projV.set(ndcX, ndcY, 0).unproject(camera);
    const nx = projV.x, ny = projV.y, nz = projV.z;
    projV.set(ndcX, ndcY, 1).unproject(camera);
    let dx = projV.x - nx, dy = projV.y - ny, dz = projV.z - nz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    if (Math.abs(dy) < 1e-6) return null;
    const t = -ny / dy;
    if (t < 0) return null;
    return { x: nx + dx * t + half, y: nz + dz * t + half };
  };

  const dimSurface = new THREE.Color(0x3c3c3c);
  const dimWire = new THREE.Color(0x242424);
  const dimBg = new THREE.Color(0x8f8f8f);
  const dimBridge = new THREE.Color(0x2e2e2e);
  const dimBottom = new THREE.Color(0x2a2a2a);
  const baseSurface = new THREE.Color(COLOR_SURFACE);
  const baseWire = new THREE.Color(COLOR_WIRE);
  const baseBg = new THREE.Color(COLOR_BG);
  const baseBridge = new THREE.Color(0x4a4a4a);
  const baseBottom = new THREE.Color(0x7a7a7a);
  const surfaceMat = surface.material as THREE.MeshBasicMaterial;
  const wireMat = wireMesh.material as THREE.LineBasicMaterial;
  const bridgeMat = bridgeMesh.material as THREE.MeshBasicMaterial;

  function startCamAnim(toPos: THREE.Vector3, toTgt: THREE.Vector3, dur: number): void {
    camAnim = {
      t: 0,
      dur,
      fromPos: camera.position.clone(),
      toPos,
      fromTgt: controls.target.clone(),
      toTgt,
    };
    controls.enabled = false;
  }

  function applyFocusMix(frameDt: number): void {
    const target = focusGroup.length > 0 ? 1 : 0;
    focusMix += (target - focusMix) * Math.min(1, frameDt * 3);
    if (luxSys) {
      // lux:环境面(水面/背景)压暗经 uDim/bgDim 由 update() 统一承担;
      // 液滴逐实例明暗 = 组内提亮,组外压暗(HDR 明度乘数)
      const d = engine.droplets.state;
      for (let i = 0; i < d.count; i++) {
        const inGroup = focusGroup.includes(i);
        const f = inGroup ? 1.6 : 0.42;
        const k = 1 + (f - 1) * focusMix;
        colorScratch.setRGB(k, k, k);
        dropletMesh.setColorAt(i, colorScratch);
      }
      if (dropletMesh.instanceColor) dropletMesh.instanceColor.needsUpdate = true;
      return;
    }
    surfaceMat.color.lerpColors(baseSurface, dimSurface, focusMix);
    wireMat.color.lerpColors(baseWire, dimWire, focusMix);
    bridgeMat.color.lerpColors(baseBridge, dimBridge, focusMix);
    (bottomMesh.material as THREE.MeshBasicMaterial).color.lerpColors(baseBottom, dimBottom, focusMix);
    (scene.background as THREE.Color).lerpColors(baseBg, dimBg, focusMix);
    // 液滴逐实例明暗:组内提亮,组外压暗(灰度,无彩色)
    const d = engine.droplets.state;
    for (let i = 0; i < d.count; i++) {
      const inGroup = focusGroup.includes(i);
      const f = inGroup ? 2.6 : 0.45;
      const k = 1 + (f - 1) * focusMix;
      colorScratch.setRGB(k, k, k);
      dropletMesh.setColorAt(i, colorScratch);
    }
    if (dropletMesh.instanceColor) dropletMesh.instanceColor.needsUpdate = true;
  }

  const colorScratch = new THREE.Color();

  function onResize2(): void {
    /* 占位:resize 逻辑复用既有监听 */
  }
  void onResize2;

  // ---- HUD / 控制 ----
  let paused = false;
  let wireOn = !lux; // 线框是灰模几何显示;光影模式默认纯水材质
  syncWireVisibility();

  btnPause.addEventListener("click", () => {
    paused = !paused;
    btnPause.textContent = paused ? "继续" : "暂停";
  });
  btnStep.addEventListener("click", () => {
    paused = true;
    btnPause.textContent = "继续";
    engine.stepFixed();
    bakeTotal();
    updateSurface();
    updateWire();
    syncDroplets();
    syncBridges();
  });
  btnReset.addEventListener("click", () => {
    engine = new WaterEngine(params);
    scheduleReset();
    hooks.reset?.(); // 宿主时间线状态同步复位(否则重播后演示不再触发)
    controller.reset();
    focusGroup = [];
    engine.setWaterHover(false, 0, 0);
    engine.setDropletHover(-1);
    emphTarget.fill(0);
    emphCur.fill(0);
    bakeTotal();
    updateSurface();
    updateWire();
    syncDroplets();
  });
  btnWire.addEventListener("click", () => {
    wireOn = !wireOn;
    syncWireVisibility();
  });
  // 调试按钮(§1 非目标允许调试按钮):中心附近随机落一滴
  btnDrop.addEventListener("click", () => {
    const r = params.rMin + rng() * (params.rMax - params.rMin);
    const x = 0.35 + rng() * 0.3;
    const y = 0.35 + rng() * 0.3;
    engine.spawnDroplet(
      x,
      y,
      engine.field.totalHeight(x, y) + params.dropHeight + r,
      r,
    );
  });
  // 落桥对:两颗半径不等的液滴近距落下 → drainTime 后成桥;持距下限把两滴推开到
  // 清晰净间距(桥颈可见),供液桥连接与「大小滴并存、尺寸恒定」验收(第四批:
  // 拉普拉斯流动已移除,大滴不再吸附小滴)
  btnPair.addEventListener("click", () => {
    const cx = 0.35 + rng() * 0.3;
    const cy = 0.35 + rng() * 0.3;
    const r1 = 0.016;
    const r2 = 0.026;
    const gap = 0.003;
    const z0 = engine.field.totalHeight(cx, cy) + params.dropHeight;
    engine.spawnDroplet(cx - (r1 + gap / 2), cy, z0 + r1, r1);
    engine.spawnDroplet(cx + (r2 + gap / 2), cy, z0 + r2, r2);
  });
  // 网络场景(调优 #6 + 第三批①修订):中心+六边形 7 滴确定性布点。
  // 连接语义下成桥距离无关:ring=0.12 展开成大间距网络——6 辐条 + 6 环边 +
  // 6 条次邻接长桥全部成桥,3 条穿过中心的直径桥被胶囊排斥自然剪枝(18 桥)
  btnNet.addEventListener("click", () => {
    const rc = 0.022;
    const rr = 0.016;
    const ring = 0.12;
    const z0 = engine.field.totalHeight(0.5, 0.5) + params.dropHeight;
    engine.spawnDroplet(0.5, 0.5, z0 + rc, rc);
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2;
      const x = 0.5 + Math.cos(ang) * ring;
      const y = 0.5 + Math.sin(ang) * ring;
      const r = k % 2 === 0 ? rr : rr * 0.82;
      engine.spawnDroplet(x, y, engine.field.totalHeight(x, y) + params.dropHeight + r, r);
    }
  });

  // ---- 模块②指针适配(DOM → 采样;Esc = 焦点退出) ----
  const dom = renderer.domElement;
  dom.addEventListener("pointermove", (e) => {
    pointerSX = e.clientX;
    pointerSY = e.clientY;
    pointerValid = true;
  });
  dom.addEventListener("pointerdown", (e) => {
    pointerSX = e.clientX;
    pointerSY = e.clientY;
    pointerValid = true;
    pointerDown = true;
    justDown = true;
  });
  window.addEventListener("pointerup", () => {
    pointerDown = false;
  });
  dom.addEventListener("pointerleave", () => {
    pointerValid = false;
    pointerDown = false;
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const intent = controller.escape();
    if (intent && intent.kind === "focusExit") {
      engine.exitFocus();
      focusGroup = [];
      if (savedCamPos && savedCamTgt) startCamAnim(savedCamPos, savedCamTgt, 0.6);
    }
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    luxSys?.resize(window.innerWidth, window.innerHeight);
  });

  // ---- 主循环:物理单一时间源(simTime),渲染只读 ----
  const clock = new THREE.Clock();
  let fpsAcc = 0;
  let fpsFrames = 0;
  let hudAt = performance.now();

  const updateHud = (): void => {
    hudTime.textContent = engine.stats.simTime.toFixed(2);
    hudSteps.textContent = String(engine.stats.stepCount);
    hudEnergy.textContent = engine.field.energy().toExponential(2);
    hudDroplets.textContent = String(engine.droplets.state.count);
    hudMerges.textContent = String(engine.stats.merges);
  };

  const captionNode = document.getElementById("gray-caption");
  const tick = (render: boolean): void => {
    const frameDt = Math.min(clock.getDelta(), 0.1);
    if (!paused) {
      if (!hooks.disablePokes) applyDuePokes();
      // ---- 模块②:场景快照 → 控制器 → 意图 → 引擎 ----
      const dstate = engine.droplets.state;
      snap.count = dstate.count;
      for (let i = 0; i < dstate.count; i++) {
        projV.set(dstate.x[i]! - half, dstate.z[i]!, dstate.y[i]! - half);
        const dist = camera.position.distanceTo(projV);
        projV.project(camera);
        snap.cx[i] = ((projV.x + 1) / 2) * window.innerWidth;
        snap.cy[i] = ((1 - projV.y) / 2) * window.innerHeight;
        snap.cr[i] = (dstate.r[i]! * (window.innerHeight * 0.5)) / (halfFov * dist + 1e-6);
      }
      const wHit = pointerValid ? pointerToWorld(pointerSX, pointerSY) : null;
      if (wHit) {
        pointerWorldX = wHit.x;
        pointerWorldY = wHit.y;
      }
      const intents = controller.update(
        snap,
        {
          sx: pointerSX,
          sy: pointerSY,
          valid: pointerValid && wHit !== null,
          worldX: pointerWorldX,
          worldY: pointerWorldY,
          down: pointerDown,
        },
        engine.stats.simTime,
        justDown,
      );
      justDown = false;
      for (const it of intents) {
        switch (it.kind) {
          case "hoverWater":
            engine.setWaterHover(true, it.x, it.y);
            engine.setDropletHover(-1);
            break;
          case "hoverDroplet":
            engine.setWaterHover(false, 0, 0);
            engine.setDropletHover(it.index);
            break;
          case "dragStart":
            engine.setWaterHover(false, 0, 0);
            engine.beginDrag(it.index, it.x, it.y);
            break;
          case "dragMove":
            engine.moveDrag(it.x, it.y);
            break;
          case "dragEnd":
            engine.endDrag();
            break;
          case "focusEnter": {
            engine.setWaterHover(false, 0, 0);
            engine.setDropletHover(-1);
            focusGroup = engine.enterFocus(it.index);
            if (focusGroup.length > 0) {
              savedCamPos = camera.position.clone();
              savedCamTgt = controls.target.clone();
              // 聚焦相机(第五批,需求①):中心滴 = 屏幕正中(视点目标即中心滴
              // 悬浮位);高度按等长环半径逐次拟合,保证包围圈完整入画
              const ds = engine.droplets.state;
              const cIdx = engine.getFocusCenter();
              let maxR = ds.r[cIdx]!;
              for (const m of focusGroup) {
                if (m !== cIdx) maxR = Math.max(maxR, ds.r[m]!);
              }
              const fitR =
                engine.getFocusRingLen() + maxR + params.focusFitMargin;
              // 取景半张角取垂直/水平较小者(竖窗时水平更窄)
              const hHalf = Math.atan(Math.tan(halfFov) * camera.aspect);
              const halfAngle = Math.min(halfFov, hHalf);
              const height = Math.max(0.1, (fitR / Math.tan(halfAngle)) * 1.12);
              const wx = ds.x[cIdx]! - half;
              const wz = ds.y[cIdx]! - half;
              const zc =
                engine.field.totalHeight(ds.x[cIdx]!, ds.y[cIdx]!) +
                ds.r[cIdx]! +
                params.levitateHeight;
              startCamAnim(
                new THREE.Vector3(wx, zc + height, wz + height * 0.12),
                new THREE.Vector3(wx, zc, wz),
                0.6,
              );
            }
            break;
          }
          case "focusExit":
            engine.exitFocus();
            focusGroup = [];
            if (savedCamPos && savedCamTgt) {
              startCamAnim(savedCamPos, savedCamTgt, 0.6);
            }
            break;
        }
      }
      // 持续意图(相位驱动;事件只在校沿发,悬停态需逐帧供能)
      if (controller.phase === "idle" && pointerValid) {
        engine.setWaterHover(true, pointerWorldX, pointerWorldY);
      } else if (controller.phase !== "idle") {
        engine.setWaterHover(false, 0, 0);
      }
      if (controller.phase === "hover") {
        engine.setDropletHover(controller.target);
      } else {
        engine.setDropletHover(-1);
      }
      engine.advance(frameDt);
      // 相机缓动 + 灰度压暗/高亮
      if (camAnim) {
        camAnim.t += frameDt;
        const k = Math.min(1, camAnim.t / camAnim.dur);
        const ease = k * k * (3 - 2 * k);
        camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, ease);
        controls.target.lerpVectors(camAnim.fromTgt, camAnim.toTgt, ease);
        if (k >= 1) {
          camAnim = null;
          controls.enabled = focusGroup.length === 0;
        }
      }
      applyFocusMix(frameDt);
      hooks.tick?.(engine, frameDt);
    }
    if (captionNode) {
      const text = paused
        ? null
        : (hooks.caption?.(engine.stats.simTime) ?? null);
      captionNode.textContent = text ?? "";
      captionNode.style.display = text ? "block" : "none";
    }
    controls.update();
    camera.updateMatrixWorld(true);
    if (render) {
      bakeTotal();
      if (luxSys) {
        luxSys.updateHeight(); // 高度纹理与物理同源(bakeTotalInto 缓冲直接上传)
      } else {
        updateSurface();
      }
      updateWire();
      syncDroplets();
      // 桥高亮目标(委托方需求 a):激活滴=拖拽/悬停目标,聚焦=中心直连桥
      if (luxSys) {
        const bs = engine.bridges.state;
        const activeDrop =
          controller.phase === "drag" || controller.phase === "hover"
            ? controller.target
            : -1;
        computeBridgeEmphasis(
          {
            count: bs.count,
            a: bs.a,
            b: bs.b,
            cut: bs.cut,
            activeDroplet: activeDrop,
            focusCenter: engine.getFocusCenter(),
          },
          emphTarget,
        );
        const ke =
          1 - Math.exp(-frameDt / RENDER_PARAMS.emphLerpTau);
        for (let k = 0; k < emphCur.length; k++) {
          emphCur[k] = emphCur[k]! + (emphTarget[k]! - emphCur[k]!) * ke;
        }
      }
      syncBridges();
      if (luxSys) {
        luxSys.update({
          dt: frameDt,
          simTime: engine.stats.simTime,
          dim: focusMix,
        });
        luxSys.setFloating(engine.droplets.state, half);
        luxSys.composer.render();
      } else {
        renderer.render(scene, camera);
      }
    }

    fpsAcc += frameDt;
    fpsFrames++;
    const now = performance.now();
    if (now - hudAt > 250) {
      hudFps.textContent = (fpsFrames / fpsAcc).toFixed(0);
      fpsAcc = 0;
      fpsFrames = 0;
      hudAt = now;
      updateHud();
    }
  };

  // WebGL 上下文丢失/恢复(§4 运行时要求):多标签/省电回收后画布会永久黑屏,
  // 必须显式处理。丢失 → 停循环 + 红字提示;恢复 → three 自动重建 GPU 资源,重启循环。
  renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    renderer.setAnimationLoop(null);
    showError("WebGL 上下文已丢失(常见于多标签切换或系统省电回收)。点击本提示或刷新页面即可恢复。");
  });
  hudError.addEventListener("click", () => {
    if (hudError.style.display !== "none") {
      hudError.style.display = "none";
    }
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    hudError.style.display = "none";
    clock.getDelta(); // 丢弃停循环期间积压的时长,避免时间跳跃
    renderer.setAnimationLoop(() => tick(true));
  });

  let lastRafAt = performance.now();
  renderer.setAnimationLoop(() => {
    lastRafAt = performance.now();
    tick(true);
  });

  // 后台心跳(§4 运行时):隐藏标签与窗口遮挡都会停 rAF(document.hidden 检测
  // 不到遮挡);worker 拍子发现 rAF 断供 >250ms 即接管,只推进物理(渲染跳过),
  // demo 时间线与灰模验收不因标签切换/遮挡而冻结
  const heartbeat = new Worker(new URL("./heartbeat.ts", import.meta.url), {
    type: "module",
  });
  heartbeat.onmessage = () => {
    if (performance.now() - lastRafAt > 250) tick(false);
  };

  // dev 探针:控制台可 (window as any).__gray.engine / .screenOf(i) 观测引擎态;
  // lux 调试另暴露三个网格(桥几何/材质诊断用)
  (window as unknown as { __gray: object }).__gray = {
    get engine() {
      return engine;
    },
    get controller() {
      return controller;
    },
    get camera() {
      return camera;
    },
    get camTarget() {
      return controls.target;
    },
    get meshes() {
      return { surface, dropletMesh, bridgeMesh, wireMesh };
    },
    get renderer() {
      return renderer;
    },
    get scene() {
      return scene;
    },
    screenOf(i: number): [number, number, number] {
      const d = engine.droplets.state;
      const v = new THREE.Vector3(
        d.x[i]! - half,
        d.z[i]!,
        d.y[i]! - half,
      );
      const dist = camera.position.distanceTo(v);
      v.project(camera);
      return [
        ((v.x + 1) / 2) * window.innerWidth,
        ((1 - v.y) / 2) * window.innerHeight,
        (d.r[i]! * (window.innerHeight * 0.5)) / (halfFov * dist),
      ];
    },
  };

  scheduleReset();
  bakeTotal();
  updateSurface();
  updateWire();
  syncDroplets();
  syncBridges();
  updateHud();
}

// 页面入口已拆分:grayview.html → src/grayview/main.ts(mountGrayViewer),
// luxview.html → src/luxview/main.ts(mountLuxViewer)。
// 两页共享本文件的 HUD 节点 id 约定(gray-*),各自入口显式挂载,互不误触。
