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
  ambientWaveHeight,
  LUX_BOTTOM_FRAG,
  LUX_BOTTOM_VERT,
  LUX_BRIDGE_FRAG,
  LUX_BRIDGE_VERT,
  LUX_FOG_FRAG,
  LUX_FOG_VERT,
  LUX_DROPLET_FRAG,
  LUX_DROPLET_VERT,
  LUX_MIST_FRAG,
  LUX_MIST_VERT,
  LUX_POINT_FRAG,
  LUX_POINT_VERT,
  LUX_SURFACE_FRAG,
  LUX_SURFACE_VERT,
} from "./luxShaders";

// 灰模色板(§6)
const COLOR_SURFACE = 0x9a9a9a; // 水面实体
const COLOR_WIRE = 0x6e6e6e; // 线框
const COLOR_BG = 0xc8c8c8; // 背景

/** 桥形常量(第十一批整改 2026-09-10 模块级导出供守护测试;语义见 syncBridges 注释)
 *  - TIP_SURF:液滴表面与桥轴高的解析交点(半球面高 = 中面 0.5r → ρ̂=√3/2≈0.866,
 *    缩放/ε 无关)
 *  - TIP_DEEP:尖端伸入液滴内部的比例(委托方任务②「液桥向内伸入液滴且隐藏内部段」;
 *    滴内段由 aFade 透明隐藏,lux 无深度写入也无缝;灰模有深度写入天然遮挡)
 *  - FADE_START:aFade 起升点(距表面交点轴向距离的占比,此前全透明)
 *  - END/NECK:端径/颈径(×r;端部适当放大成漏斗形,委托方第十一批整改)
 *  - BLEND_EXTEND:融合倒角完成点 = 表面交点距离 × 此值(>1 = 恰越过表面完成,
 *    接触面圆滑过渡,委托方第十一批整改) */
export const BRIDGE_TIP_SURF = 0.866;
export const BRIDGE_TIP_DEEP = 0.45;
/** aFade 起升点(距表面交点轴向距离的占比):0.8 = 滴内段前 80% 完全透明
 *  (委托方「隐藏进入液滴内部分」二次整改——旧 0.25 渐变横跨滴内段,ghost 可见;
 *  现仅出场边缘 ~20% 软化,主遮挡由液滴 depthWrite 深度剔除承担) */
/**
 * 液桥粗细的**视觉安全区间**(动效 §1.3「粗细限度·防失衡」)。
 *
 * 委托方 2026-09-11 明确:粗细映射**适用于所有液桥、不属于任何单个状态**,
 * 且**必须限制在一定范围内**。故它的入口只有 `FxSource.bridgeThick()` 一个,
 * 在 `syncBridges` 里对所有模式一律生效 —— 状态只改流动/气泡/光泽,不改粗细。
 *  - 上限:关系再强也不会粗到喧宾夺主;
 *  - 下限:真正的可读性下限是**颈径的屏幕空间下限**(screen-space floor),
 *    它按像素而非按强度兜底,「关系再弱也不会细到肉眼无法分辨」(§1.3)。
 */
export const BRIDGE_THICK = { min: 0.55, max: 1.85, base: 1.0 } as const;

export const BRIDGE_FADE_START = 0.8;
export const BRIDGE_END_FRAC = 0.3;
export const BRIDGE_NECK_FRAC = 0.05;
export const BRIDGE_BLEND_EXTEND = 1.35;

// ============================================================
// B 组效果验证(web-fxspike):外部效果驱动源
//
// 本副本 = 生产 web/ 的拷贝,**只用于验证**,生产目录零改动。效果以「外部注入
// 驱动源」的方式接入:未注入(null)时所有效果通道为 0,渲染路径与生产逐字节等价。
// ============================================================

/** 逐桥效果参数(与 fxspike/fxdriver.ts 的 BridgeFx 同形,此处不反向依赖) */
export interface FxBridgeParams {
  flow: number;
  bubble: number;
  turb: number;
  state: number;
}

/** 逐滴效果参数 */
export interface FxDropletParams {
  boil: number;
  dissolve: number;
  scale: number;
  lift: number;
  flash: number;
  /** 「未在场」灰滴度 0..1(聚焦模式:已退场/未出场 → 灰,且无动态关系表达)。
   *  ⚠ 灰是**规格 §2.3 专门留给已退场/未出场**的语义色,疏远/拉扯不得借用。 */
  absent: number;
}

/** 效果驱动源(由验证页注入;实现见 src/fxspike/) */
export interface FxSource {
  /** 效果族:0=无 1=流动/气泡 2=黯淡 3=湍流 4=潜流 */
  bridgeKind(): number;
  /** 逐桥参数(seed 为该桥随机相位) */
  bridgeFx(seed: number): FxBridgeParams;
  /** 桥抽出/回缩进度(0..1;seed 同上,大转折按桥错峰起卷/生长) */
  bridgeGrow(seed: number): number;
  /** 逐滴参数(index = 液滴索引;x/y = 引擎位域坐标,汇聚段螺旋偏移的出发点) */
  dropletFx(index: number, x: number, y: number): FxDropletParams;
  /** 雾团(凝结的「起雾」/ 死亡的「残留雾气」/ 大转折的「巨滴水汽包裹」;
   *  cx/cy = 锚点滴渲染坐标) */
  fogCue(
    index: number,
    cx: number,
    cy: number,
  ): { appear: number; radius: number; x: number; y: number };
  /** 是否启用颈径屏幕空间下限(仅「拉扯」需要) */
  neckFloorOn(): boolean;
  /** 逐桥粗细系数(关系类型/强度 → 粗细;清单 A-2 的接入口)。
   *  对所有桥、所有模式一律生效,并被 BRIDGE_THICK 的视觉安全区间钳住。 */
  bridgeThick(seed: number): number;
  /** 每帧推进(由 viewer 主循环调用) */
  update(dt: number, pointerDist: number): void;
  /** 雾团锚点滴索引(缺省 1 = 验证页主角滴;大转折的核心滴 = 0) */
  fogAnchor?(): number;
  /** 过渡整体压暗/增辉度 0..1(大转折过渡段;缺省 0) */
  transitionMix?(): number;
  /** 火花(大转折迸发段;缺省 = 无火花)。返回 null/不注入 → 该槽不画。 */
  sparkAt?(
    i: number,
  ): { x: number; y: number; h: number; r: number; a: number } | null;
}

let fxSource: FxSource | null = null;

/** 注入/清除效果驱动源(验证页专用;传 null 恢复生产路径) */
export function setFxSource(s: FxSource | null): void {
  fxSource = s;
}

/** 当前是否注入了效果驱动源 */
export function fxActive(): boolean {
  return fxSource !== null;
}

const WIRE_N = 64; // 线框降采样(§6:防糊)

/** 确定性 PRNG(演示戳点序列;M4 演示脚本归入 demo.ts 后此处移除) */
/** 点到线段距离(引擎域米;潜流揭示用)。桥轴 = 两端锚点线段,几乎笔直,
 *  故不必在 shader 里做样条距离场 —— CPU 算完逐桥写 reveal 属性即可。 */
function segDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const ux = bx - ax;
  const uy = by - ay;
  const ll = ux * ux + uy * uy;
  const t = ll < 1e-12 ? 0 : Math.min(1, Math.max(0, ((px - ax) * ux + (py - ay) * uy) / ll));
  return Math.hypot(px - (ax + ux * t), py - (ay + uy * t));
}

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
  /** 共享 uniforms 对象(五材质共用;大转折火花材质在装配块接入时用) */
  uniforms: Record<string, THREE.IUniform>;
  surfaceMat: THREE.ShaderMaterial;
  dropletMat: THREE.ShaderMaterial;
  bridgeMat: THREE.ShaderMaterial;
  bottomMat: THREE.ShaderMaterial;
  composer: EffectComposer;
  onTimeChange: ((tod: TimeOfDay) => void) | null;
  setTimeOfDay(tod: TimeOfDay): void;
  /** 烘焙缓冲(heightData)已更新后调用:置纹理上传标记 */
  updateHeight(): void;
  /** 每渲染帧:时段渐变 + bloom 参数 + 时间/压暗 uniforms。
   *  `glow` = B 组大转折的过渡增辉(直接加在 bloom 强度上;缺省 0)。 */
  update(args: { dt: number; simTime: number; dim: number; glow?: number }): void;
  /** 漂浮液滴 → 水底解析软影 uniforms */
  setFloating(state: DropletState, half: number): void;
  resize(w: number, h: number): void;
  /** B 组效果(web-fxspike):雾团 billboard 池 + 逐实例出现度(生产路径下恒 0) */
  fogMesh: THREE.InstancedMesh;
  fogAmt: THREE.InstancedBufferAttribute;
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
    uWaveAmp: { value: RENDER_PARAMS.ambientWaveAmp },
    uDropPos: { value: dropPosArr },
    uDropRad: { value: dropRadArr },
    uDropCountF: { value: 0 },
    uTint: { value: new THREE.Color() }, // 水面/液滴统一色调(时段化)
    uTintAmt: { value: 0.55 },
    uMistLayer: { value: 0 }, // 上方雾气层强度(清晨 1.0)
    uEdgeLift: { value: 0.16 }, // 水底渐变边缘提亮(深夜≈0)
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
    transparent: true, // 珍珠材质仍有少量透.mix(alpha 0.66-0.94)
    depthWrite: true, // 珍珠近不透明:写深度 → 真实遮挡。滴内桥段/滴后桥段与雾
    //   全部被深度测试剔除(委托方「隐藏进入液滴内部分」;透明画序无深度时,
    //   后画的桥叠在球面上 = 滴内可见液桥穿帮,2026-09-10 二次整改)。
    //   水面/水底在液滴之前渲染,不受影响;液滴间由 back-to-front 排序兜底。
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

  // ---- 上方雾气层(2026-09-09 第八批,参考图1清晨蒸汽;强度 = 预设 mistLayer) ----
  // y=0.055:液滴上方(滴顶 = 波高 + rMax ≈ 0.038)、透明队列最后(renderOrder 11:
  // 相机在层上方时它是最高透明物,最后画即正确 back-to-front;层下观察 facing 项
  // 淡出兜底,不会露出平板剪影)。共享同一 uniforms 对象 → 随时段自动渐变。
  const mistMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: LUX_MIST_VERT,
    fragmentShader: LUX_MIST_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mistMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(domainSize * 2.2, domainSize * 2.2),
    mistMat,
  );
  mistMesh.rotation.x = -Math.PI / 2;
  mistMesh.position.y = 0.055;
  mistMesh.renderOrder = 11;
  scene.add(mistMesh);

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
  const cTint = new THREE.Color();
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
    srgb(p.surfaceTint, cTint);
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
    uniforms.uTint.value.copy(cTint);
    uniforms.uTintAmt.value = target.surfaceTintAmt;
    uniforms.uMistLayer.value = target.mistLayer;
    uniforms.uEdgeLift.value = target.bottomEdgeLift;
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

  // ---- B 组效果:雾团 billboard 池(web-fxspike) ----
  // 池化 InstancedMesh + 单 draw call;renderOrder 7 = 液滴(5)之后、液桥(10)之前。
  // 生产路径(未注入 FxSource)下 fogMesh.count = 0 → 零开销、不可见。
  const FOG_MAX = 8;
  const fogGeo = new THREE.PlaneGeometry(1, 1);
  const fogAmt = new THREE.InstancedBufferAttribute(new Float32Array(FOG_MAX), 1);
  fogGeo.setAttribute("aFogAmt", fogAmt);
  const fogMat = new THREE.ShaderMaterial({
    uniforms, // 共享 uniforms 对象:时段配色/光照自动跟随
    vertexShader: LUX_FOG_VERT,
    fragmentShader: LUX_FOG_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const fogMesh = new THREE.InstancedMesh(fogGeo, fogMat, FOG_MAX);
  fogMesh.frustumCulled = false;
  fogMesh.renderOrder = 7;
  fogMesh.count = 0;
  scene.add(fogMesh);

  const sys: LuxSystem = {
    uniforms,
    fogMesh,
    fogAmt,
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
    update({ dt, simTime, dim, glow = 0 }): void {
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
      uniforms.uTint.value.lerp(cTint, k);
      const lerpTo = (u: { value: number }, v: number): void => {
        u.value += (v - u.value) * k;
      };
      lerpTo(uniforms.uTintAmt, target.surfaceTintAmt);
      lerpTo(uniforms.uMistLayer, target.mistLayer);
      lerpTo(uniforms.uEdgeLift, target.bottomEdgeLift);
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
      bloom.strength += glow; // 大转折过渡增辉(峰值 1.1,配置在验证页接线)
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
  // uv ↔ 高度纹理格心一一对应(uv=(i+0.5)/N,与 uUvK 世界→uv 约定一致)。
  // ⚠ 缺 uv 属性时 three 会把 shader 的 uv 绑定到默认值 (0,0) —— 整片水面
  // 恒采样角点纹素:顶点位移与法线全平,涟漪只在「水底着色」上可见(缺陷根因)
  const surfaceUv = new Float32Array(N * N * 2);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      surfaceUv[k * 2] = (i + 0.5) / N;
      surfaceUv[k * 2 + 1] = (j + 0.5) / N;
    }
  }
  surfaceGeo.setAttribute("uv", new THREE.BufferAttribute(surfaceUv, 2));
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

  // ---- 水底平面:albedo 调制渐变,在 y = -poolDepth(任务②) ----
  // 略大于域(×1.15)使边缘从水面外可见;过大时裸底外溢扎眼(第七批收敛)
  const bottomGeo = new THREE.PlaneGeometry(
    params.domainSize * 1.15,
    params.domainSize * 1.15,
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

  // ---- 液滴:半球水滴(委托方 2026-09-09「z 轴拉长至 1.0」:高/半径比 0.3→1.0)----
  // 球冠参数化:接触半径 r_c、高度 H、曲率半径 R、接触角 θ
  //   H = R(1−cosθ),r_c = R·sinθ → R = (r_c² + H²)/(2H),θ = arcsin(r_c/R)
  // 取 r_c = 1(单位),H = LENS_H = 1.0 → R = 1,θ = 90°(正半球)
  // 几何 = 上凸半球(光滑曲面) + 下平圆盘,边缘相接成封闭水滴
  // 实例缩放 (r, r·LENS_H·(1−ε), r):r 控制水平展幅,y 向 ε 振荡 = 厚度压缩
  const LENS_H = 1.0; // 球冠高度(单位接触半径下;1.0 = 半球)
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
  // lux:水材质为珍珠乳白(第十一批,实例.png;高不透明度修复清晨/正午隐形);
  // 液滴写深度(见 dropletMat),液桥滴内段/滴后段由深度测试真实遮挡(2026-09-10
  // 二次整改),aFade 仅承担出场边缘软化
  dropletMesh.renderOrder = 5;
  scene.add(dropletMesh);

  // ---- lux 共享状态(luxSys 非空才启用;声明先于同步函数,赋值在光影装配块) ----
  let luxSys: LuxSystem | null = null;
  let epsAttr: THREE.InstancedBufferAttribute | null = null;
  let bridgeNrmAttr: THREE.BufferAttribute | null = null;
  let bridgeEmphAttr: THREE.BufferAttribute | null = null;
  let bridgeFadeAttr: THREE.BufferAttribute | null = null;
  // B 组效果通道(web-fxspike)
  let bridgeUvAttr: THREE.BufferAttribute | null = null;
  let bridgeSeedAttr: THREE.BufferAttribute | null = null;
  let bridgeKindAttr: THREE.BufferAttribute | null = null;
  let bridgeStateAttr: THREE.BufferAttribute | null = null;
  let bridgeGrowAttr: THREE.BufferAttribute | null = null;
  let dropletFxAttr: THREE.InstancedBufferAttribute | null = null;
  // 大转折火花池(lux 装配块内建;render 路径的 syncSparks 用)
  let sparkMesh: THREE.InstancedMesh | null = null;
  let sparkAmt: THREE.InstancedBufferAttribute | null = null;
  /** 指针到最近桥轴的距离(引擎域米;潜流揭示用;每帧由 syncBridges 更新) */
  let fxPointerDist = Infinity;
  const emphTarget = new Float32Array((params.maxDroplets * (params.maxDroplets - 1)) / 2);
  const emphCur = new Float32Array((params.maxDroplets * (params.maxDroplets - 1)) / 2);

  const dropletMatrix = new THREE.Matrix4();

  // ---- 聚焦隐藏掩码(需求①:仅中心滴+包围圈滴可见;每帧由 focusGroup 重建) ----
  const focusMask = new Uint8Array(params.maxDroplets);
  const syncFocusMask = (): void => {
    focusMask.fill(0);
    for (const m of focusGroup) {
      if (m >= 0 && m < params.maxDroplets) focusMask[m] = 1;
    }
  };

  /**
   * 液滴渲染锚点 = 透镜底面世界 y(液桥端点与本体渲染共用,保证衔接同源):
   * - 贴水态:水面总高度(lux 叠加环境波涛,液滴随浪起伏);
   * - 悬浮(聚焦编舞)/退场曲线段:跟随物理 z(底面 = 球心 z − r)——此前悬浮滴
   *   被钉在水面而液桥按 d.z 升空,是「桥与滴脱节」在聚焦态的根源。
   */
  const lensBottomY = (i: number): number => {
    const d = engine.droplets.state;
    if (d.floating[i] === 1 && d.lev[i] !== 1 && d.curve[i] !== 1) {
      // 浮态渲染底面 = 物理平滑中心 z − r(≡ 第四批 zFollow 平滑后的「平滑水面 −
      // 浸深」;升力浮出与波浪 riding 全继承)。**不直接采样 totalHeight**:
      // 悬停涟漪泵在滴下激起 ±9mm@~10Hz 纹波,原始场高逐帧跟随 = 悬浮态视觉
      // 异常抖动(第十一批委托方反馈;物理层 zFollow 已平滑,渲染层此前未跟上,
      // 2026-09-10 实测 raw ±9mm vs 平滑 0.06mm/步)。环境波涛慢变,另行叠加。
      const amb = lux
        ? ambientWaveHeight(d.x[i]! - half, d.y[i]! - half, engine.stats.simTime)
        : 0;
      return d.z[i]! - d.r[i]! + amb;
    }
    return d.z[i]! - d.r[i]!;
  };

  /** 液桥端点锚 = 透镜中面 y(底面 + 半透镜厚;透镜高 = LENS_H·lensThick) */
  const lensMidY = (i: number): number => {
    const d = engine.droplets.state;
    const lensThick = d.r[i]! * LENS_H * (1 - d.eps[i]!);
    return lensBottomY(i) + 0.5 * LENS_H * lensThick;
  };

  const syncDroplets = (): void => {
    const d = engine.droplets.state;
    syncFocusMask();
    dropletMesh.count = d.count;
    for (let i = 0; i < d.count; i++) {
      const r = d.r[i]!;
      // 透镜缩放:xz=r(水平展幅),y=r·LENS_H·(1−ε)(透镜厚度方向,ε 振荡=厚度压缩)
      const lensThick = r * LENS_H * (1 - d.eps[i]!);
      // 聚焦隐藏:组外滴随 focusMix 平滑收缩到 0(几何消失;物理仍在仿真,退出即恢复)
      const vis = focusMask[i] === 1 ? 1 : 1 - focusMix;
      // B 组效果:凝结的成形缩放 / 死亡的汽化缩小与上飘 / 大转折的汇聚偏移。
      // ⚠ vCenter(透镜采样基准)与 vR(透镜光程)都由 instanceMatrix 导出,
      //    故缩放会同步带动透镜与接触环 —— 这是想要的(整颗滴一起变),
      //    但**上飘只改 y 平移**:若在 shader 里单独偏移顶点,透镜会与本体错开。
      let fxScale = 1;
      let fxLift = 0;
      if (fxSource) {
        const f = fxSource.dropletFx(i, d.x[i]!, d.y[i]!);
        fxScale = f.scale;
        fxLift = f.lift;
        if (dropletFxAttr) dropletFxAttr.setXYZ(i, f.boil, f.dissolve, f.absent);
      } else if (dropletFxAttr) {
        dropletFxAttr.setXYZ(i, 0, 0, 0);
      }
      const s = vis * fxScale;
      dropletMatrix.makeScale(r * s, lensThick * s, r * s);
      dropletMatrix.setPosition(
        d.x[i]! - half,
        lensBottomY(i) + fxLift,
        d.y[i]! - half,
      );
      dropletMesh.setMatrixAt(i, dropletMatrix);
      if (epsAttr) epsAttr.setX(i, d.eps[i]!);
    }
    dropletMesh.instanceMatrix.needsUpdate = true;
    if (epsAttr) epsAttr.needsUpdate = true;
    if (dropletFxAttr) dropletFxAttr.needsUpdate = true;
  };

  /** B 组效果:雾团同步(凝结的起雾 / 死亡的残雾)。billboard = 相机朝向的方片,
   *  故实例矩阵由「相机四元数 + 均匀缩放 + 位置」组装,保证任何机位都正对镜头。 */
  const fogMatrix = new THREE.Matrix4();
  const fogScale = new THREE.Vector3();
  /** 主角滴渲染坐标缓存(液滴被删后残雾仍要留在原位,见 syncFog 注释) */
  let heroX = 0;
  let heroY = 0;
  let heroZ = 0;
  let heroValid = false;
  const syncFog = (): void => {
    if (!luxSys) return;
    const mesh = luxSys.fogMesh;
    const amt = luxSys.fogAmt;
    if (!fxSource) {
      mesh.count = 0;
      return;
    }
    const d = engine.droplets.state;
    // 锚点滴 = 验证页主角滴(索引 1);大转折(核心滴 = 索引 0)可指定。
    // ⚠ 坐标要**缓存**:死亡退场会把液滴真的从引擎删掉(engine.removeDroplet),
    //   删掉之后不能改读幸存滴的坐标 —— 那会让残雾「跳」到另一颗滴头上;也不能
    //   用 d.count < 2 直接把雾掐掉 —— 「原位留下一团短暂的雾气」是死亡演出的
    //   收尾(§4.2),雾必须比液滴活得久。
    const hero = (fxSource?.fogAnchor?.() ?? 1) | 0;
    if (hero < d.count) {
      heroX = d.x[hero]! - half;
      heroZ = d.y[hero]! - half;
      heroY = lensBottomY(hero) + d.r[hero]! * 1.15;
      heroValid = true;
    } else if (!heroValid) {
      mesh.count = 0;
      return;
    }
    const hx = heroX;
    const hz = heroZ;
    const hy = heroY;
    const cap = mesh.instanceMatrix.count;
    let n = 0;
    for (let i = 0; i < cap; i++) {
      const cue = fxSource.fogCue(i, hx, hz);
      if (cue.appear <= 0.004 || cue.radius <= 1e-5) continue;
      fogMatrix.makeRotationFromQuaternion(camera.quaternion);
      fogScale.set(cue.radius * 2, cue.radius * 2, 1);
      fogMatrix.scale(fogScale);
      fogMatrix.setPosition(cue.x, hy, cue.y);
      mesh.setMatrixAt(n, fogMatrix);
      amt.setX(n, cue.appear);
      n++;
    }
    mesh.count = n;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      amt.needsUpdate = true;
    }
  };

  /** 大转折火花同步:每帧把驱动源给的第 i 颗火花(引擎域坐标 + 水上高度)
   *  写成实例矩阵(透镜几何按 r 缩放,贴 totalHeight 水位)。 */
  const sparkMatrix = new THREE.Matrix4();
  const syncSparks = (): void => {
    if (!sparkMesh || !sparkAmt) return;
    if (!fxSource?.sparkAt) {
      sparkMesh.count = 0;
      return;
    }
    let n = 0;
    const cap = sparkMesh.instanceMatrix.count;
    for (let i = 0; i < cap; i++) {
      const s = fxSource.sparkAt(i);
      if (!s || s.a <= 0.004 || s.r <= 1e-5) continue;
      const surf = engine.field.totalHeight(s.x, s.y);
      sparkMatrix.makeScale(s.r, s.r * LENS_H, s.r);
      sparkMatrix.setPosition(s.x - half, surf + s.h, s.y - half);
      sparkMesh.setMatrixAt(n, sparkMatrix);
      sparkAmt.setX(n, s.a);
      n++;
    }
    sparkMesh.count = n;
    if (n > 0) {
      sparkMesh.instanceMatrix.needsUpdate = true;
      sparkAmt.needsUpdate = true;
    }
  };

  // ---- 液桥渲染(任务①):颈状管(两端漏斗形放大、中间收窄;尖端在液滴内部) ----
  // ⚠ 原值 10 × 8 太粗,是「桥读成扁片 + 硬台阶」的根因(2026-09-11 B 组第二轮):
  //   - 周向 8 边 → 剪影是八边形,带一条平顶棱面 → 无论怎么打光都读成「扁片」;
  //   - 轴向 10 环 → 端部圆角(rise 只占跨距的 5.6%)与出场淡入(占 1.5%)都整个
  //     落在**一段**之内,平滑过渡退化成一道硬台阶。
  //   「拉扯」态看着平滑只是因为黯淡分支把棱面糊掉了 —— 不是它几何更好。
  //   故把两者一起提上来:真正让所有状态都读成圆管、端部平滑收细。
  const BRIDGE_LEN = 48; // 轴向环数
  const BRIDGE_RAD = 20; // 周向边数
  /** 周向单位圆 cos/sin 表(顶点布局静态 → 免掉每顶点三角函数;提高环数后必须) */
  const ringCos = new Float32Array(BRIDGE_RAD);
  const ringSin = new Float32Array(BRIDGE_RAD);
  for (let r = 0; r < BRIDGE_RAD; r++) {
    const ang = (r / BRIDGE_RAD) * Math.PI * 2;
    ringCos[r] = Math.cos(ang);
    ringSin[r] = Math.sin(ang);
  }
  /** clamp 到 [0,1] 后 smoothstep 缓动 */
  const smooth01 = (u: number): number => {
    const v = Math.min(1, Math.max(0, u));
    return v * v * (3 - 2 * v);
  };
  // 液滴中面锚缓存(syncBridges 每帧开头失效;避免桥对间重复 totalHeight 求值)
  const midCache = new Float32Array(params.maxDroplets);
  const midValid = new Uint8Array(params.maxDroplets);
  const lensMidYCached = (i: number): number => {
    if (midValid[i] === 0) {
      midCache[i] = lensMidY(i);
      midValid[i] = 1;
    }
    return midCache[i]!;
  };
  // 桥池 = 完全图边数(连接语义:任意两漂浮滴都可成桥;须与 BridgeSystem 容量一致)
  const bridgeMax = (params.maxDroplets * (params.maxDroplets - 1)) / 2;
  const vertsPerBridge = (BRIDGE_LEN + 1) * BRIDGE_RAD;
  // 逐桥「上一帧是否可见」。桥池按完全图容量分配(maxDroplets=32 → 496 条),
  // 实际几乎全是不可见的空槽;顶点数提高后每帧无条件清零 496×vertsPerBridge
  // 会白烧掉大半帧时间,故只在「由可见转不可见」那一帧清一次。
  const bridgeWasActive = new Uint8Array(bridgeMax);
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
    const focusOn = focusGroup.length > 0;
    // 液滴中面锚缓存(每帧失效;totalHeight 含逐核高斯,避免桥对间重复求值)
    midValid.fill(0);
    for (let k = 0; k < bridgeMax; k++) {
      const base = k * vertsPerBridge;
      const active = k < bs.count && bs.cut[k] === 0;
      if (!active) {
        if (bridgeWasActive[k] === 0) continue; // 本来就不可见:顶点已在原点,无需再清
        bridgeWasActive[k] = 0;
        // 收缩到原点(不可见)
        bridgePos.fill(0, base * 3, (base + vertsPerBridge) * 3);
        continue;
      }
      bridgeWasActive[k] = 1;
      const ia = bs.a[k]!;
      const ib = bs.b[k]!;
      // 聚焦隐藏(需求①):与包围圈无关的桥随 focusMix 收缩;≥0.98 直接折叠
      const visK =
        focusOn && focusMask[ia] !== 1 && focusMask[ib] !== 1
          ? 1 - focusMix
          : 1;
      if (visK <= 0.02) {
        for (let v = 0; v < vertsPerBridge; v++) {
          bridgePos[(base + v) * 3] = 0;
          bridgePos[(base + v) * 3 + 1] = 0;
          bridgePos[(base + v) * 3 + 2] = 0;
        }
        continue;
      }
      // 端点 = 液滴渲染锚点(透镜中面,与 syncDroplets 完全同源——液桥始终
      // 从液滴表面长出来,贴水/悬浮/退场曲线三态都不脱节)。
      const ax = d.x[ia]! - half;
      const az = d.y[ia]! - half;
      const ay = lensMidYCached(ia);
      const bx = d.x[ib]! - half;
      const bz = d.y[ib]! - half;
      const by = lensMidYCached(ib);
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
      // 桥管形(第十一批 2026-09-10 任务②整改「两端适当放大 + 深入液滴 + 隐藏
      // 内部段 + 接触面圆滑过渡」):
      // - 尖端伸入液滴内部 TIP_DEEP·r;半径从尖端 0 起 smoothstep 凹形舒展,在
      //   TIP_BLEND = 表面交点距离×BLEND_EXTEND(>1,恰越过液滴表面)处升到全径
      //   → 切线连续的融合倒角(BlobTree fillet 思想的网格等价),接触面圆滑过渡,
      //   桥「从液滴里长出来」,随起伏永不脱节;
      // - 端径 END·r(漏斗形放大)→ 颈径 NECK·min(r):两端宽中间收窄的液桥轮廓;
      // - 滴内段 aFade 透明隐藏(尖端 0 → 表面交点 1),lux 无深度写入也无缝;
      // - 拉伸变细:半径 ×√(restLen/dist)(体积守恒观感,拉伸成细丝而不断裂)
      const ra = d.r[ia]!;
      const rb = d.r[ib]!;
      // ---- 颈径屏幕空间下限(「拉扯」专用;B 组效果验证) ----
      // 圆柱之所以读作圆柱,靠的是径向明暗带(高光带/亮面/明暗交界/反光)在空间上
      // **分离**;宽度掉到 ~2px 以下这些带就合并、被 MSAA 抹平,只剩剪影 ——
      // 无论调成什么颜色都只能读成「薄片」。这正是「极限拉扯 = 又黑又扁的刀片」
      // 的真正根因:它不是调色问题,是几何/像素问题。
      // 故设下限 ≈2.6px,「极细」的**读法**改由「端/颈比」承担(端 3.8~10.6px
      // vs 颈 2.6px → 1.5~4×),而不是绝对变细。
      const worldPerPx =
        (2 * Math.tan((camera.fov * Math.PI) / 360) *
          camera.position.distanceTo(controls.target)) /
        Math.max(window.innerHeight, 1);
      const neckFloor =
        fxSource && fxSource.neckFloorOn() ? 2.6 * worldPerPx : 0;
      const seedK = bridgeSeedAttr
        ? (bridgeSeedAttr.array as Float32Array)[k * vertsPerBridge]!
        : 0;
      /** 桥的抽出/回缩进度(0..1;非效果态恒 1) */
      const fxGrow = fxSource ? fxSource.bridgeGrow(seedK) : 1;
      // 逐桥效果参数(seed 相同 → 与属性写入段一致;大转折的卷曲幅度从这取)
      const pFx = fxSource ? fxSource.bridgeFx(seedK) : null;
      /** 卷曲位移幅度(动效 §5 汇聚段「线条随之卷曲、缠绕」):横向正弦缠绕,
       *  两端固定(中段最大),相位含 seed 与 simTime —— 缠绕是活的。 */
      const curlAmp = pFx ? pFx.turb : 0;
      // 粗细系数:关系类型/强度 → 粗细的唯一入口(对所有桥、所有模式一律生效),
      // 被 §1.3 的视觉安全区间钳住 —— 「关系再强不会喧宾夺主」。
      const thickK = Math.min(
        BRIDGE_THICK.max,
        Math.max(
          BRIDGE_THICK.min,
          fxSource ? fxSource.bridgeThick(seedK) : BRIDGE_THICK.base,
        ),
      );
      const rNeck = Math.max(
        BRIDGE_NECK_FRAC * Math.min(ra, rb) * thickK,
        neckFloor,
      );
      const thin = Math.min(
        1.25,
        Math.max(0.5, Math.sqrt(bs.restLen[k]! / len)),
      );
      const tipA = BRIDGE_TIP_DEEP * ra;
      const tipB = BRIDGE_TIP_DEEP * rb;
      const span = Math.max(len - tipA - tipB, 1e-4); // 两尖端之间跨距
      // 尖端 → 表面交点 / → 倒角完成点的轴向距离(倒角略越过表面,圆滑过渡)
      const surfA = Math.max((BRIDGE_TIP_SURF - BRIDGE_TIP_DEEP) * ra, 1e-4);
      const surfB = Math.max((BRIDGE_TIP_SURF - BRIDGE_TIP_DEEP) * rb, 1e-4);
      const blendA = surfA * BRIDGE_BLEND_EXTEND;
      const blendB = surfB * BRIDGE_BLEND_EXTEND;
      const pax = ax + ux * tipA;
      const pay = ay + uy * tipA;
      const paz = az + uz * tipA;
      const pbx = bx - ux * tipB;
      const pby = by - uy * tipB;
      const pbz = bz - uz * tipB;
      for (let s = 0; s <= BRIDGE_LEN; s++) {
        const t = s / BRIDGE_LEN;
        const rEnd =
          (t < 0.5 ? BRIDGE_END_FRAC * ra : BRIDGE_END_FRAC * rb) * thickK;
        const free = rNeck + (rEnd - rNeck) * Math.abs(2 * t - 1) ** 1.5;
        // lux:高亮加粗(委托方「变亮加粗」;灰模无此属性,因子=1)
        const emph = bridgeEmphAttr ? emphCur[k]! : 0;
        const thick = 1 + RENDER_PARAMS.bridgeHiThicken * emph;
        // 融合倒角:尖端 0 → 越过表面交点 1(凹形舒展,接触面圆滑过渡)
        const dA = t * span; // 距 A 端尖端的轴向距离
        const dB = (1 - t) * span;
        const rise = Math.min(smooth01(dA / blendA), smooth01(dB / blendB));
        // Rayleigh–Plateau 珠化(「拉扯」专用):真实液柱断裂前会出现周期性
        // 颈缩-鼓包。它比「整体变细」更像液体(有体积、有明暗带、可读),且
        // **始终连着** —— 与「液桥拉伸不断裂」裁决完全兼容。
        // ⚠ 只调制中段:rise 在两端→0,乘上去天然不碰尖端,保住「两头粗中间细」。
        // (珠化只在「拉扯」启用;颈径下限可独立常开 —— 见 main.ts 的说明)
        const bead =
          fxSource?.bridgeKind() === 2
            ? 1 + 0.18 * Math.sin(t * 9.0 + seedK * 6.283)
            : 1;
        // 「抽出 / 回缩」= **几何生长**,不是 alpha 淡入。
        // 桥的半径每帧由 CPU 重建,所以生长必须做在这里:沿弧长从 A 端(t=0)向
        // B 端(t=1)推进,已长出的段取满径,未到的段半径为 0。
        // 效果态的 grow 由驱动源给出(凝结 0→1 抽出、死亡 1→0 回缩);非效果态恒 1。
        const growLocal =
          fxGrow >= 1
            ? 1
            : 1 - smooth01((t - (fxGrow - 0.18)) / 0.18);
        // ⚠ **不要**在这里对 rr 再夹 neckFloor:那会把锥形尖端一起抬到下限,
        //    整条桥变成粗圆棒(实测:锥形消失、桥明显变胖变匀)。颈径下限只应
        //    改轮廓参数 rNeck(见上方),不能夹最终半径。
        const rr = Math.max(
          free * rise * thin * thick * visK * bead * growLocal,
          1e-5,
        );
        // 出场边缘软化:交点前 FADE_START 段全透明 → 交点处升满(主遮挡由
        // 液滴 depthWrite 深度剔除承担,见 dropletMat)
        const fade = Math.min(
          smooth01(
            (dA / surfA - BRIDGE_FADE_START) / (1 - BRIDGE_FADE_START),
          ),
          smooth01(
            (dB / surfB - BRIDGE_FADE_START) / (1 - BRIDGE_FADE_START),
          ),
        );
        const cx0 = pax + (pbx - pax) * t;
        const cy0 = pay + (pby - pay) * t;
        const cz0 = paz + (pbz - paz) * t;
        // 卷曲缠绕(大转折汇聚段):沿正交基叠加双频横向位移,包络 sin(πt)
        // 让两端钉在液滴上;幅度 ∝ turb × 桥长,seed/simTime 各给一相。
        let cx = cx0;
        let cy = cy0;
        let cz = cz0;
        if (curlAmp > 1e-4) {
          const env = Math.sin(Math.PI * t);
          const ph = seedK * 6.2832 + engine.stats.simTime * 7.0;
          const amp = curlAmp * len * 0.16 * env;
          const w1 = Math.sin(ph + t * 8.5);
          const w2 = Math.cos(ph * 1.3 + t * 6.2);
          cx += n1x * amp * w1 + n2x * amp * 0.45 * w2;
          cy += n1y * amp * w1 + n2y * amp * 0.45 * w2;
          cz += n1z * amp * w1 + n2z * amp * 0.45 * w2;
        }
        for (let r = 0; r < BRIDGE_RAD; r++) {
          const c = ringCos[r]!;
          const s2 = ringSin[r]!;
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
          if (bridgeFadeAttr) {
            (bridgeFadeAttr.array as Float32Array)[
              base + s * BRIDGE_RAD + r
            ] = fade;
          }
        }
      }
      if (bridgeEmphAttr) {
        const ea = bridgeEmphAttr.array as Float32Array;
        ea.fill(emphCur[k]!, base, base + vertsPerBridge);
      }
      // ---- B 组效果通道写入(逐桥;未注入驱动源时 aKind=0 且各通道 0) ----
      if (bridgeKindAttr && bridgeStateAttr && bridgeGrowAttr) {
        const ka = bridgeKindAttr.array as Float32Array;
        const sa = bridgeStateAttr.array as Float32Array;
        const ga = bridgeGrowAttr.array as Float32Array;
        const p = pFx;
        const kind = fxSource ? fxSource.bridgeKind() : 0;
        const grow = fxGrow;
        for (let v = 0; v < vertsPerBridge; v++) {
          const vi = base + v;
          ka[vi] = kind;
          ga[vi] = grow;
          const q = vi * 4;
          sa[q] = p ? p.flow : 0;
          sa[q + 1] = p ? p.bubble : 0;
          sa[q + 2] = p ? p.turb : 0;
          sa[q + 3] = p ? p.state : 0;
        }
      }
    }
    // 只提交「已分配」的桥槽(索引按桥号连续排布)。桥池按完全图容量分配
    // (maxDroplets=32 → 496 条),不设 drawRange 时每帧要把整池的退化三角形
    // 都送进 GPU —— 环数提高后这是 95 万个三角形,必须限。
    bridgeGeo.setDrawRange(
      0,
      Math.min(bs.count, bridgeMax) * BRIDGE_LEN * BRIDGE_RAD * 6,
    );
    bridgePosAttr.needsUpdate = true;
    if (bridgeNrmAttr) bridgeNrmAttr.needsUpdate = true;
    if (bridgeEmphAttr) bridgeEmphAttr.needsUpdate = true;
    if (bridgeFadeAttr) bridgeFadeAttr.needsUpdate = true;
    if (bridgeKindAttr) bridgeKindAttr.needsUpdate = true;
    if (bridgeStateAttr) bridgeStateAttr.needsUpdate = true;
    if (bridgeGrowAttr) bridgeGrowAttr.needsUpdate = true;
    // 潜流用:指针到最近桥轴的距离(引擎域米)。桥轴 = 两端锚点线段,几乎笔直,
    // 用点到线段距离即可 —— 不必在 shader 里做样条距离场(那是纯浪费)。
    // ⚠ 指针失效时必须**回落成 Infinity**,不能沿用上一帧的值:原实现整个块被
    //   `pointerValid` 门掉,指针一离开画布 fxPointerDist 就冻结在最后那个距离上
    //   → 潜流「搅动后沉淀」永远不发生,桥停在浮现态(委托方实测:不受鼠标控制)。
    if (fxSource) {
      let best = Infinity;
      const n = pointerValid ? Math.min(bs.count, bridgeMax) : 0;
      for (let k = 0; k < n; k++) {
        if (bs.cut[k] !== 0) continue;
        const ia = bs.a[k]!;
        const ib = bs.b[k]!;
        best = Math.min(
          best,
          segDist(
            pointerWorldX,
            pointerWorldY,
            d.x[ia]!,
            d.y[ia]!,
            d.x[ib]!,
            d.y[ib]!,
          ),
        );
      }
      fxPointerDist = best;
    }
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
    // 滴内段隐藏因子(第十一批任务②;aFade 语义见 BRIDGE_TIP_DEEP 注释)
    bridgeFadeAttr = new THREE.BufferAttribute(
      new Float32Array(bridgeMax * vertsPerBridge),
      1,
    );
    bridgeGeo.setAttribute("aFade", bridgeFadeAttr);
    // ---- B 组效果通道(web-fxspike) ----
    // aUV / aSeed 是**静态**属性:顶点布局静态(每帧只改 position),故 init 填一次
    // 即可,每帧零成本。aState / aKind / aGrow 每帧写。
    bridgeUvAttr = new THREE.BufferAttribute(
      new Float32Array(bridgeMax * vertsPerBridge * 2),
      2,
    );
    bridgeSeedAttr = new THREE.BufferAttribute(
      new Float32Array(bridgeMax * vertsPerBridge),
      1,
    );
    bridgeKindAttr = new THREE.BufferAttribute(
      new Float32Array(bridgeMax * vertsPerBridge),
      1,
    );
    bridgeStateAttr = new THREE.BufferAttribute(
      new Float32Array(bridgeMax * vertsPerBridge * 4),
      4,
    );
    bridgeGrowAttr = new THREE.BufferAttribute(
      new Float32Array(bridgeMax * vertsPerBridge),
      1,
    );
    {
      const uv = bridgeUvAttr.array as Float32Array;
      const sd = bridgeSeedAttr.array as Float32Array;
      const gw = bridgeGrowAttr.array as Float32Array;
      const rngSeed = mulberry32(0x9e3779b9);
      for (let k = 0; k < bridgeMax; k++) {
        const base = k * vertsPerBridge;
        const seedK = rngSeed(); // 每桥不同相位 → 去同步(防整网同步扫过半向量)
        for (let s = 0; s <= BRIDGE_LEN; s++) {
          for (let r = 0; r < BRIDGE_RAD; r++) {
            const vi = base + s * BRIDGE_RAD + r;
            uv[vi * 2] = s / BRIDGE_LEN;
            uv[vi * 2 + 1] = r / BRIDGE_RAD;
            sd[vi] = seedK;
            // ⚠ 默认必须是 1:若该属性缺失或为 0,片元里 alpha × vGrow = 0 → 桥全隐
            gw[vi] = 1;
          }
        }
      }
    }
    bridgeGeo.setAttribute("aUV", bridgeUvAttr);
    bridgeGeo.setAttribute("aSeed", bridgeSeedAttr);
    bridgeGeo.setAttribute("aKind", bridgeKindAttr);
    bridgeGeo.setAttribute("aState", bridgeStateAttr);
    bridgeGeo.setAttribute("aGrow", bridgeGrowAttr);
    // 逐实例效果通道:aFx = (沸腾强度, 抖动溶解进度, 未在场灰滴度)
    dropletFxAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(params.maxDroplets * 3),
      3,
    );
    dropletMesh.geometry.setAttribute("aFx", dropletFxAttr);
    // ---- 大转折光点池(web-fxspike mode 9) ----
    // 两用:**汇聚段炸裂出来的光点**(漩涡向心、被巨滴吸收)与**爆散段的光点**
    // (巨滴炸裂后向四周飞射)。同一池、同一材质(纯光点:亮核 + 柔边,无菲涅尔/
    // 折射/高光;深夜暖橙发光 —— 委托方 2026-09-12 两条整改)。容量 = fxdriver 的
    // POINT_POOL(160;爆散段仍只用前 48 槽)。复用液滴透镜几何(clone:追加
    // aSparkA 属性,不污染液滴本体)。生产路径(sparkAt 未注入)count=0,零开销。
    {
      const SPARK_MAX = 160;
      const sparkGeo = lensGeo.clone();
      const amt = new THREE.InstancedBufferAttribute(
        new Float32Array(SPARK_MAX),
        1,
      );
      sparkGeo.setAttribute("aSparkA", amt);
      const mat = new THREE.ShaderMaterial({
        uniforms: luxSys!.uniforms, // 共享:时段配色/uNightDots/uDim 自动跟随
        vertexShader: LUX_POINT_VERT,
        fragmentShader: LUX_POINT_FRAG,
        transparent: true,
        depthWrite: false, // 光点是瞬时演出物,不参与遮挡
        // 预乘 alpha:片元输出 (col·a, a) → 柔边不产生暗环(soft particle 标准解法)
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      const mesh = new THREE.InstancedMesh(sparkGeo, mat, SPARK_MAX);
      mesh.frustumCulled = false;
      mesh.renderOrder = 6; // 液滴(5)之后、雾团(7)/液桥(10)之前
      mesh.count = 0;
      scene.add(mesh);
      sparkMesh = mesh;
      sparkAmt = amt;
    }
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
      // B 组效果:由**物理时间源**驱动(不引第二时钟;引擎是唯一时间源)。
      // 放在 engine.advance 之后、syncBridges 之前 —— 参数由上一帧 syncBridges
      // 算出的指针距离更新,一帧延迟对「靠近才浮现」的观感无影响。
      fxSource?.update(frameDt, fxPointerDist);
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
      syncFog();
      syncSparks();
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
        // 大转折过渡段:整体压暗(uDim)+ bloom 增辉 → 「巨滴悬停 + 水下焦散式
        // 模糊」的观感;未注入 transitionMix 时与原路径完全一致。
        const transMix = fxSource?.transitionMix?.() ?? 0;
        luxSys.update({
          dt: frameDt,
          simTime: engine.stats.simTime,
          dim: Math.max(focusMix, transMix),
          glow: transMix * 0.45, // 克制(夜闪纪律):曾用 1.1,整帧泛白(实测)
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
    /** 指针到最近桥轴的距离(引擎域米;Infinity = 指针不在画布内)。
     *  潜流验证用:取帧环境没有真鼠标,得能读到「鼠标驱动了什么」。 */
    get pointerDist() {
      return fxPointerDist;
    },
    /** 手动重算「指针世界坐标 + 液桥几何 + 指针距离」。
     *  取帧时需要:hooks.tick 跑在 syncBridges **之前**,暂停后又不再来新帧,
     *  不显式调一次的话驱动器读到的永远是上一帧(或初始)的距离。
     *  另外必须**先更新相机矩阵** —— camera.matrixWorld 是 render 时才刷新的,
     *  首帧 tick 之前它还是旧的,unproject 会解出域外坐标(实测 dist=9.29m)。 */
    sync(): void {
      camera.updateMatrixWorld(true);
      if (pointerValid) {
        const w = pointerToWorld(pointerSX, pointerSY);
        if (w) {
          pointerWorldX = w.x;
          pointerWorldY = w.y;
        }
      }
      // 顺序:先液滴(写逐滴偏移缓存)→ 再桥(端点读缓存)→ 最后雾/火花
      // (雾锚点要读液滴坐标)。原本桥在滴前,大转折的偏移会晚一帧,
      // 取帧路径整场压进一帧时会拿到全零偏移 → 桥留在原位(实测级风险)。
      syncDroplets();
      syncBridges();
      syncFog();
      syncSparks();
      // 液滴/雾也要一起同步:取帧路径把整场压进一帧,而「死亡退场」会在
      // hooks.tick 里删掉液滴 —— 删除发生在本帧 syncDroplets 之前的话,
      // 主角滴坐标缓存就永远填不上,残雾会整团消失(实测踩到)。
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
    /** 液滴 i 的屏幕投影 [x, y, 半径px]。`lift` = 该滴的浮升量(米)—— 灰滴从
     *  水底浮现时渲染位是引擎位 + lift(instanceMatrix 的 Y 平移),文字叠层要
     *  跟着**渲染位**走,不传则与引擎位一致(死亡上飘同理可传正值)。 */
    screenOf(i: number, lift = 0): [number, number, number] {
      const d = engine.droplets.state;
      const v = new THREE.Vector3(
        d.x[i]! - half,
        d.z[i]! + lift,
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
