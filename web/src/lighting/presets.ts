// ============================================================
// 光影渲染 · 模块③ three-free 核心(docs/光影渲染设计-2026-09-08.md §6/§7)
// 四时段光系预设 + 渲染参数:本模块唯一常量真源。
// 铁律:不 import three、不挂 DOM;物理参数真源仍是 watersim/params.ts(只读)。
// 物理依据与风格化声明见设计文档 §3:
//   - Fresnel F0=0.02 / 折射率 1.33 / GGX 粗糙度 = 物理常量;
//   - waterAbsorb / poolDepth / 深夜生物荧光海岸 / 清晨粉紫色调+上方雾气层 = 风格化
//     (与模块①毛细放大同类声明;清晨=2026-09-09 第八批,深夜=同日第九批按参考图
//     docs/水底夜晚.jpg 重做——第八批等值线网方案形态不符已废弃)。
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
  /** 深夜生物荧光海岸层开关(风格化;第九批:平行蜿蜒海岸线束,见 luxShaders nightCoast) */
  readonly nightDots: 0 | 1;
  /** 荧光辉光基色(生物荧光蓝;蓝白核心与颗粒色由 shader 从它派生) */
  readonly nightDotColor: RGB;
  /** 水体内散射色(风格化蓝绿)与池底反照率 */
  readonly waterBody: RGB;
  readonly bottomAlbedo: RGB;
  /** 场景背景色 */
  readonly background: RGB;
  /** 水面/液滴统一色调(透明水时段色;此前写死淡蓝,2026-09-09 第八批时段化:
   *  清晨粉紫 / 正午傍晚淡蓝 / 深夜深蓝——深夜靠它压掉均匀淡蓝洗白)与混合量 */
  readonly surfaceTint: RGB;
  readonly surfaceTintAmt: number;
  /** 上方雾气层强度(0=无;清晨水面蒸汽层,参考委托方 2026-09-09 参考图1) */
  readonly mistLayer: number;
  /** 水底径向渐变边缘提亮量(灰白池壁感;深夜压至近 0,保「水底与场景颜色一致」) */
  readonly bottomEdgeLift: number;
}

const DAWN: LightingPreset = {
  key: "dawn",
  label: "清晨",
  sunElevationDeg: 12,
  sunAzimuthDeg: 70,
  sunColor: [1.0, 0.8, 0.62], // 暖金晨光(参考图1:顶部暖阳光晕)
  sunIntensity: 1.6,
  ambSky: [0.56, 0.52, 0.7], // 天穹粉紫倾向(2026-09-09 第八批:粉紫色调)
  ambGround: [0.26, 0.23, 0.27],
  skyHorizon: [0.92, 0.72, 0.78], // 地平线粉(参考图1水面粉色反射的来源)
  skyZenith: [0.45, 0.42, 0.72], // 天顶紫蓝
  mistDensity: 0.16, // 晨雾最浓(全表最大,测试锁定;0.12→0.16 加浓配合雾气层)
  mistColor: [0.85, 0.75, 0.87], // 雾:粉紫白(参考图1上方雾气)
  causticScale: 0.45,
  glintGain: 0.8,
  shadowStrength: 0.25,
  exposure: 1.05,
  saturation: 0.98,
  contrast: 1.0,
  bloomStrength: 0.14,
  bloomThreshold: 0.7,
  bloomRadius: 0.4,
  nightDots: 0,
  nightDotColor: [0, 0, 0],
  waterBody: [0.17, 0.32, 0.38],
  bottomAlbedo: [0.44, 0.52, 0.64],
  background: [0.6, 0.57, 0.72], // 粉紫灰背景
  surfaceTint: [0.82, 0.65, 0.86], // 水面粉紫色调(委托方 2026-09-09 参考图1)
  surfaceTintAmt: 0.4,
  mistLayer: 1.0, // 上方雾气层全开(参考图1水面蒸汽)
  bottomEdgeLift: 0.16,
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
  /** 浅蓝水底(委托方 2026-09-09)。正午光照强,albedo×光照在 ACES 前达 2-3
   *  必然压成惨白;按强光标定取深系数,屏显(色调映射后)才是浅蓝 */
  bottomAlbedo: [0.1, 0.22, 0.42],
  background: [0.45, 0.63, 0.9],
  surfaceTint: [0.58, 0.79, 0.94], // 淡蓝(原 shader 写死值时段化,观感不变)
  surfaceTintAmt: 0.55,
  mistLayer: 0,
  bottomEdgeLift: 0.16,
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
  bottomAlbedo: [0.34, 0.4, 0.52],
  background: [0.38, 0.24, 0.21],
  surfaceTint: [0.58, 0.79, 0.94], // 淡蓝(原 shader 写死值时段化,观感不变)
  surfaceTintAmt: 0.55,
  mistLayer: 0,
  bottomEdgeLift: 0.16,
};

const NIGHT: LightingPreset = {
  key: "night",
  label: "深夜",
  // 第九批(2026-09-09,参考 docs/水底夜晚.jpg):全场景黑+深蓝、冷白月光、
  // 水底与场景同色;亮度只允许来自荧光海岸边界及其辉光与颗粒(局部发光)。
  sunElevationDeg: 42, // 月亮仰角
  sunAzimuthDeg: 200,
  sunColor: [0.8, 0.87, 1.0], // 月光冷白:色相近白、蓝分量最高(委托方明示)
  sunIntensity: 0.5, // 整体最暗(<1,测试锁定 dawn>night)
  ambSky: [0.035, 0.045, 0.09], // 环境压至近黑深蓝(禁止均匀蓝光铺满)
  ambGround: [0.015, 0.018, 0.035],
  skyHorizon: [0.06, 0.08, 0.15], // 反射环境近黑(深蓝)
  skyZenith: [0.015, 0.02, 0.05],
  mistDensity: 0,
  mistColor: [0.1, 0.12, 0.18],
  causticScale: 0.1, // 月光焦散极弱,视觉主导让位荧光海岸
  glintGain: 2.2, // 月光 glitter 全表最强(测试锁定)
  shadowStrength: 0.35,
  exposure: 0.85,
  saturation: 1.0,
  contrast: 1.08,
  bloomStrength: 0.38, // 荧光核心与少量亮颗粒泛辉光(< dusk 0.65,测试锁定 dusk 最强)
  bloomThreshold: 0.55, // 低阈值:蓝白核心与少量大颗粒进入 bloom
  bloomRadius: 0.45,
  nightDots: 1,
  nightDotColor: [0.25, 0.55, 1.0], // 生物荧光蓝(b>g>r 测试锁定)
  waterBody: [0.014, 0.034, 0.068],
  /** 深蓝水底,与场景颜色一致(参考图水体为可感知深蓝,非纯黑) */
  bottomAlbedo: [0.05, 0.09, 0.19],
  background: [0.012, 0.016, 0.035], // 全场景黑色+深蓝
  surfaceTint: [0.05, 0.08, 0.17], // 水面统一深蓝(压掉淡蓝洗白 → 场景整体黑蓝)
  surfaceTintAmt: 0.5,
  mistLayer: 0,
  bottomEdgeLift: 0.02, // 边缘不灰白提亮,保「水底层与场景颜色一致」
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
  /** 环境波涛全局幅度倍率(波谱真源在 luxShaders.AMBIENT_WAVES;1=谱默认) */
  ambientWaveAmp: 1.0,
  /** 水折射率(物理) */
  refractiveIndex: 1.33,
  /** 正入射 Fresnel 反射率 = ((n−1)/(n+1))²(物理,由 1.33 派生 ≈0.0202) */
  fresnelF0: 0.02,
  /** 水体吸收系数(/m,RGB;风格化放大——真实 5cm 浅水几乎无色,红光衰减最快) */
  waterAbsorb: [2.2, 0.75, 0.45] as const,
  /** 液桥常态透明度(委托方指定:极度淡化 30%) */
  bridgeOpacity: 0.3,
  /** 液桥高亮透明度(变亮,减弱) */
  bridgeHiOpacity: 0.55,
  /** 高亮加粗:半径 ×(1 + 此值)(减弱) */
  bridgeHiThicken: 0.35,
  /** 液滴内体压暗(委托方「颜色较深」的量化) */
  dropletDarken: 0.5,
  /** 水面 GGX 粗糙度(物理量级:清水低粗糙) */
  roughness: 0.09,
  /** 高亮因子平滑时间常数(秒) */
  emphLerpTau: 0.12,
  /** 时段切换渐变时间常数(秒):太阳不瞬移 */
  presetLerpTau: 0.45,
  /** 深夜荧光颗粒格点周期(米)(0.006 ≈ 6mm;半径按绝对米数 1.5-4.5mm 与格点解耦,
   *  保证屏显 ≥1px;贴线密集成带,参考 docs/水底夜晚.jpg) */
  nightDotCell: 0.006,
  /** 雾漂移速度(m/s)与高度衰减(1/m) */
  mistDrift: 0.03,
  mistHeightK: 7.0,
} as const;
