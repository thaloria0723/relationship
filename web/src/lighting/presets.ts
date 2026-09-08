// ============================================================
// 光影渲染 · 模块③ three-free 核心(docs/光影渲染设计-2026-09-08.md §6/§7)
// 四时段光系预设 + 渲染参数:本模块唯一常量真源。
// 铁律:不 import three、不挂 DOM;物理参数真源仍是 watersim/params.ts(只读)。
// 物理依据与风格化声明见设计文档 §3:
//   - Fresnel F0=0.02 / 折射率 1.33 / GGX 粗糙度 = 物理常量;
//   - waterAbsorb / poolDepth / 夜晚金色光点 = 风格化(与模块①毛细放大同类声明)。
// ============================================================

export type TimeOfDay = "dawn" | "noon" | "dusk" | "night";

export type RGB = readonly [number, number, number];

/** 单时段光系(全部 uniforms 的目标值;数值标定见设计文档 §6 表)
 *  颜色字段一律为「期望屏显 sRGB 值」(viewer 装载时转线性工作空间);
 *  主光 = sunColor(Hue,≤1)× sunIntensity(线性强度倍率,HDR)。 */
export interface LightingPreset {
  readonly key: TimeOfDay;
  readonly label: string;
  /** 太阳/月亮仰角(°,水平面起)与方位角(°,+x 起向 +z) */
  readonly sunElevationDeg: number;
  readonly sunAzimuthDeg: number;
  /** 主光色相(≤1)+ 线性强度倍率(清晨弱 → 正午全表最强 → 深夜最暗) */
  readonly sunColor: RGB;
  readonly sunIntensity: number;
  /** 半球环境:天空色 / 水体反照色 */
  readonly ambSky: RGB;
  readonly ambGround: RGB;
  /** 程序化天空反射:地平线色 / 天顶色 */
  readonly skyHorizon: RGB;
  readonly skyZenith: RGB;
  /** 高度雾:密度(0=无)与雾色 */
  readonly mistDensity: number;
  readonly mistColor: RGB;
  /** 焦散(∇²h 聚焦)强度:正午垂直入射透水能量最大 → 全表最强 */
  readonly causticScale: number;
  /** 镜面 glitter 增益:夜晚月光纯镜面亮部 → 全表最强 */
  readonly glintGain: number;
  /** 液滴在水底的解析软影强度 */
  readonly shadowStrength: number;
  /** 色调:曝光 / 饱和度 / 对比 */
  readonly exposure: number;
  readonly saturation: number;
  readonly contrast: number;
  /** bloom 辉光(傍晚氛围感辉光 → 全表最强) */
  readonly bloomStrength: number;
  readonly bloomThreshold: number;
  readonly bloomRadius: number;
  /** 夜晚水底金色光点(风格化月光焦散点化;委托方明示) */
  readonly nightDots: 0 | 1;
  readonly nightDotColor: RGB;
  /** 水体内散射色(风格化蓝绿)与池底反照率 */
  readonly waterBody: RGB;
  readonly bottomAlbedo: RGB;
  /** 场景背景色 */
  readonly background: RGB;
}

const DAWN: LightingPreset = {
  key: "dawn",
  label: "清晨",
  sunElevationDeg: 12,
  sunAzimuthDeg: 70,
  sunColor: [1.0, 0.78, 0.58],
  sunIntensity: 1.6,
  ambSky: [0.55, 0.62, 0.72],
  ambGround: [0.25, 0.24, 0.22],
  skyHorizon: [0.88, 0.78, 0.66],
  skyZenith: [0.45, 0.58, 0.72],
  mistDensity: 0.12,
  mistColor: [0.66, 0.7, 0.76],
  causticScale: 0.45,
  glintGain: 0.8,
  shadowStrength: 0.25,
  exposure: 1.05,
  saturation: 0.95,
  contrast: 1.0,
  bloomStrength: 0.12,
  bloomThreshold: 0.7,
  bloomRadius: 0.4,
  nightDots: 0,
  nightDotColor: [0, 0, 0],
  waterBody: [0.16, 0.34, 0.37],
  bottomAlbedo: [0.55, 0.52, 0.46],
  background: [0.6, 0.65, 0.72],
};

const NOON: LightingPreset = {
  key: "noon",
  label: "正午",
  sunElevationDeg: 78,
  sunAzimuthDeg: 15,
  sunColor: [1.0, 0.98, 0.94],
  sunIntensity: 3.3,
  ambSky: [0.45, 0.62, 0.85],
  ambGround: [0.18, 0.22, 0.25],
  skyHorizon: [0.72, 0.84, 0.98],
  skyZenith: [0.25, 0.48, 0.88],
  mistDensity: 0,
  mistColor: [0.8, 0.85, 0.9],
  causticScale: 1.35,
  glintGain: 1.5,
  shadowStrength: 0.6,
  exposure: 1.0,
  saturation: 1.15,
  contrast: 1.0,
  bloomStrength: 0.08,
  bloomThreshold: 0.85,
  bloomRadius: 0.4,
  nightDots: 0,
  nightDotColor: [0, 0, 0],
  waterBody: [0.1, 0.36, 0.43],
  bottomAlbedo: [0.78, 0.75, 0.68],
  background: [0.45, 0.63, 0.9],
};

const DUSK: LightingPreset = {
  key: "dusk",
  label: "傍晚",
  sunElevationDeg: 8,
  sunAzimuthDeg: 290,
  sunColor: [1.0, 0.62, 0.3],
  sunIntensity: 2.4,
  ambSky: [0.2, 0.22, 0.38],
  ambGround: [0.1, 0.08, 0.1],
  skyHorizon: [1.0, 0.55, 0.25],
  skyZenith: [0.16, 0.16, 0.34],
  mistDensity: 0.08,
  mistColor: [0.35, 0.28, 0.3],
  causticScale: 0.7,
  glintGain: 1.8,
  shadowStrength: 0.45,
  exposure: 1.0,
  saturation: 1.0,
  contrast: 1.12,
  bloomStrength: 0.65,
  bloomThreshold: 0.6,
  bloomRadius: 0.45,
  nightDots: 0,
  nightDotColor: [0, 0, 0],
  waterBody: [0.12, 0.17, 0.3],
  bottomAlbedo: [0.42, 0.36, 0.34],
  background: [0.38, 0.24, 0.21],
};

const NIGHT: LightingPreset = {
  key: "night",
  label: "深夜",
  sunElevationDeg: 42,
  sunAzimuthDeg: 200,
  sunColor: [0.62, 0.72, 1.0],
  sunIntensity: 0.55,
  ambSky: [0.05, 0.06, 0.12],
  ambGround: [0.02, 0.02, 0.04],
  skyHorizon: [0.1, 0.12, 0.2],
  skyZenith: [0.02, 0.03, 0.07],
  mistDensity: 0,
  mistColor: [0.1, 0.12, 0.18],
  causticScale: 0.12,
  glintGain: 2.2,
  shadowStrength: 0.35,
  exposure: 0.85,
  saturation: 1.0,
  contrast: 1.0,
  bloomStrength: 0.16,
  bloomThreshold: 0.85,
  bloomRadius: 0.35,
  nightDots: 1,
  nightDotColor: [1.0, 0.72, 0.28],
  waterBody: [0.02, 0.045, 0.07],
  bottomAlbedo: [0.08, 0.09, 0.12],
  background: [0.02, 0.025, 0.05],
};

/** 时段次序(页面按钮序) */
export const TIME_ORDER: readonly TimeOfDay[] = ["dawn", "noon", "dusk", "night"];

/** 四时段预设(唯一真源) */
export const LIGHTING_PRESETS: Readonly<Record<TimeOfDay, LightingPreset>> =
  Object.freeze({
    dawn: DAWN,
    noon: NOON,
    dusk: DUSK,
    night: NIGHT,
  });

/** 太阳/月亮方向(单位向量,指向光源;世界系 y 向上) */
export function sunDirection(p: LightingPreset): RGB {
  const elev = (p.sunElevationDeg * Math.PI) / 180;
  const azim = (p.sunAzimuthDeg * Math.PI) / 180;
  const ce = Math.cos(elev);
  return [ce * Math.cos(azim), Math.sin(elev), ce * Math.sin(azim)];
}

/** 渲染参数(设计文档 §7;物理常量与委托方指定值) */
export const RENDER_PARAMS = {
  /** 视觉池深(米):折射光程/水底平面位置用,风格化(物理流动层 H 是另一回事) */
  poolDepth: 0.14,
  /** 水折射率(物理) */
  refractiveIndex: 1.33,
  /** 正入射 Fresnel 反射率 = ((n−1)/(n+1))²(物理,由 1.33 派生 ≈0.0202) */
  fresnelF0: 0.02,
  /** 水体吸收系数(/m,RGB;风格化放大——真实 5cm 浅水几乎无色,红光衰减最快) */
  waterAbsorb: [2.2, 0.75, 0.45] as const,
  /** 液桥常态透明度(委托方指定:极度淡化 30%) */
  bridgeOpacity: 0.3,
  /** 液桥高亮透明度(变亮) */
  bridgeHiOpacity: 0.78,
  /** 高亮加粗:半径 ×(1 + 此值) */
  bridgeHiThicken: 0.6,
  /** 液滴内体压暗(委托方「颜色较深」的量化) */
  dropletDarken: 0.5,
  /** 水面 GGX 粗糙度(物理量级:清水低粗糙) */
  roughness: 0.09,
  /** 高亮因子平滑时间常数(秒) */
  emphLerpTau: 0.12,
  /** 时段切换渐变时间常数(秒):太阳不瞬移 */
  presetLerpTau: 0.45,
  /** 夜光点阵周期(米)与闪烁速度 */
  nightDotCell: 0.05,
  /** 雾漂移速度(m/s)与高度衰减(1/m) */
  mistDrift: 0.03,
  mistHeightK: 7.0,
} as const;
