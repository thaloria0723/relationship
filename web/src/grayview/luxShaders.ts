// ============================================================
// 光影渲染 GLSL(模块③;docs/光影渲染设计-2026-09-08.md §5)
// 纯模板字符串(three-free),由 grayview/viewer.ts(全工程唯一 import three)
// 装配进 ShaderMaterial。所有光照按水的物理光学实现:
//   Fresnel(Schlick, F0=0.02)+ Snell 折射(1/1.33,池底解析求交)
//   + Beer–Lambert 吸收 + GGX 镜面 + 高度场拉普拉斯焦散 + 高度雾(Mie 风格化)。
// 风格化项(设计文档 §3 声明):深夜生物荧光海岸(2026-09-09 第九批,严格还原
// docs/水底夜晚.jpg 海岸形态;取代旧金色光点阵与第八批等值线网方案)。
// 液桥常态透明度 30% 为委托方指定值(bridgeOpacity uniform)。
// ============================================================

// ============================================================
// 环境波涛(需求①,参考 docs/波纹2.jpg 的多方向交叉碎波 + 焦散光网):
// 九成分方向谱(方向覆盖 360°,含反向交叉波列)+ 三成分域扭曲(打破直条纹)
// + 深水色散 ω=√(g·k) 整体放慢——three.js 官方 Water(getNoise 多副本异向叠加)
// 与 Tessendorf/GPU Gems 方向谱同族;域扭曲取 Iñigo Quilez 手法(低频场扭曲
// 高频采样坐标,‖∇W‖<1 防折叠)。只取垂直位移,法线与拉普拉斯全部解析求导
// (链式法则)。组件表是唯一真源:GLSL(下方生成)与 TS 侧 ambientWaveHeight
// 同源,保证液滴贴浪与水面位移逐点一致。⚠ 两侧都不要手改数值。
// ============================================================

/** 单个波成分:方向(°)+ 波长(m)+ 振幅(m)+ 相速度缩放(1=深水色散)+ 相位偏移(rad) */
export interface AmbientWaveComponent {
  readonly dirDeg: number;
  readonly lambda: number;
  readonly amp: number;
  readonly speed: number;
  readonly phase: number;
}

/** 波谱:九成分方向谱(域 1m;方向覆盖 360°,长波夹角 135° 形成交叉网;
 *  总幅 ~9.3mm,总斜率 Σa·k ~0.32 rad;最短 λ 0.058m 在 256² 网格下 15 顶点/波长)。
 *  速度维持委托方 2026-09-09「波浪速度减缓」裁决(0.28-0.38)。
 *  phase 为固定随机相位,打破多成分同相对齐的周期性拍纹。 */
export const AMBIENT_WAVES: readonly AmbientWaveComponent[] = [
  { dirDeg: 15, lambda: 0.42, amp: 0.0022, speed: 0.28, phase: 0.0 },
  { dirDeg: 150, lambda: 0.34, amp: 0.0019, speed: 0.3, phase: 1.7 },
  { dirDeg: -95, lambda: 0.26, amp: 0.0015, speed: 0.3, phase: 3.6 },
  { dirDeg: 62, lambda: 0.19, amp: 0.0011, speed: 0.31, phase: 5.1 },
  { dirDeg: -38, lambda: 0.14, amp: 0.0009, speed: 0.32, phase: 2.4 },
  { dirDeg: 128, lambda: 0.1, amp: 0.00065, speed: 0.33, phase: 4.4 },
  { dirDeg: -8, lambda: 0.075, amp: 0.00045, speed: 0.35, phase: 0.9 },
  { dirDeg: 96, lambda: 0.066, amp: 0.00033, speed: 0.36, phase: 2.9 },
  { dirDeg: -165, lambda: 0.058, amp: 0.00024, speed: 0.38, phase: 5.9 },
];

/** 单个域扭曲成分:沿 dirDeg 方向既传播又位移(e=d),低频慢变 */
export interface AmbientWarpComponent {
  readonly dirDeg: number;
  readonly lambda: number;
  readonly amp: number;
  readonly speed: number;
  readonly phase: number;
}

/** 扭曲场:三成分低频慢变(波长 0.45-0.85m,位移 7-16mm,速度 0.22-0.28)。
 *  ‖∇W‖ 峰值 ≈0.33 < 1,坐标映射一一对应无折叠;对最短波 λ=0.058m 位移达 0.58λ
 *  → 直条纹显著弯折成网(参考 docs/波纹2.jpg 的蜿蜒涟漪)。 */
export const AMBIENT_WARPS: readonly AmbientWarpComponent[] = [
  { dirDeg: 30, lambda: 0.85, amp: 0.016, speed: 0.22, phase: 1.1 },
  { dirDeg: -120, lambda: 0.62, amp: 0.011, speed: 0.25, phase: 4.0 },
  { dirDeg: 78, lambda: 0.45, amp: 0.007, speed: 0.28, phase: 2.2 },
];

const G_GRAVITY = 9.81;

interface AmbientWaveResolved {
  dx: number;
  dz: number;
  k: number;
  omega: number;
  amp: number;
  phase: number;
}

const resolveAmbient = (
  w: AmbientWaveComponent | AmbientWarpComponent,
): AmbientWaveResolved => {
  const th = (w.dirDeg * Math.PI) / 180;
  const k = (2 * Math.PI) / w.lambda;
  return {
    dx: Math.cos(th),
    dz: Math.sin(th),
    k,
    omega: Math.sqrt(G_GRAVITY * k) * w.speed,
    amp: w.amp,
    phase: w.phase,
  };
};

const AMBIENT_RESOLVED: AmbientWaveResolved[] =
  AMBIENT_WAVES.map(resolveAmbient);
const AMBIENT_WARPS_RESOLVED: AmbientWaveResolved[] =
  AMBIENT_WARPS.map(resolveAmbient);

/**
 * 环境波涛高度(GLSL ambientWaveField 的逐项同源镜像;viewer 给液滴贴浪用)。
 * 含域扭曲:p' = p + W(p,t),h = Σ a·sin(k·(d·p') − ω·t + φ)。
 * ampScale 用于 λ 缩放实验,默认 1。
 */
export function ambientWaveHeight(
  x: number,
  z: number,
  t: number,
  ampScale = 1,
): number {
  let wx = 0;
  let wz = 0;
  for (const w of AMBIENT_WARPS_RESOLVED) {
    const q = (w.dx * x + w.dz * z) * w.k - w.omega * t + w.phase;
    wx += w.dx * w.amp * Math.sin(q);
    wz += w.dz * w.amp * Math.sin(q);
  }
  const qx = x + wx;
  const qz = z + wz;
  let h = 0;
  for (const w of AMBIENT_RESOLVED) {
    h +=
      w.amp * Math.sin((w.dx * qx + w.dz * qz) * w.k - w.omega * t + w.phase);
  }
  return h * ampScale;
}

/** 由组件表生成 GLSL 逐项展开(ES1.00 无 const 数组,不可下标循环)。
 *  含扭曲场 warpField + 主波场 ambientWaveField(链式法则解析导数)。 */
const AMBIENT_WAVE_GLSL = [
  "// ---- 环境波涛:九成分方向谱 + 三成分域扭曲,解析高度/斜率/拉普拉斯(与 TS 同源生成) ----",
  "// 扭曲场 W(p,t)=Σ b·d·sin(q), q=k·(d·p)−ω·t+φ;打包 wg=(∂Wx/∂x,∂Wx/∂z,∂Wz/∂x,∂Wz/∂z), wl=(∇²Wx,∇²Wz)",
  "void warpField(vec2 p, float t, out vec2 disp, out vec4 wg, out vec2 wl) {",
  "  disp = vec2(0.0);",
  "  wg = vec4(0.0);",
  "  wl = vec2(0.0);",
  ...AMBIENT_WARPS_RESOLVED.map((w) => {
    const dx = w.dx.toFixed(6);
    const dz = w.dz.toFixed(6);
    const k = w.k.toFixed(4);
    const om = w.omega.toFixed(4);
    const ph = w.phase.toFixed(4);
    const b = w.amp.toFixed(6);
    return [
      "  {",
      `    float q = dot(p, vec2(${dx}, ${dz})) * ${k} - ${om} * t + ${ph};`,
      "    float sn = sin(q);",
      "    float cs = cos(q);",
      `    disp += vec2(${dx}, ${dz}) * ${b} * sn;`,
      `    wg.xy += vec2(${dx}, ${dz}) * (${b} * ${dx} * ${k} * cs);`,
      `    wg.zw += vec2(${dx}, ${dz}) * (${b} * ${dz} * ${k} * cs);`,
      `    wl += vec2(${dx}, ${dz}) * (-${b} * ${k} * ${k} * sn);`,
      "  }",
    ];
  }).flat(),
  "}",
  "// 主波场:h=Σ a·sin(s), s=k·(d·p')−ω·t+φ, p'=p+disp;链式法则:",
  "// ∇h=Σ a·k·cos(s)·Mᵀd, ∇²h=Σ[a·k·cos(s)·(d·wl) − a·k²·sin(s)·|Mᵀd|²], Mᵀd=(d.x(1+wg.x)+d.z·wg.z, d.x·wg.y+d.z(1+wg.w))",
  "float ambientWaveField(vec2 p, float t, out vec2 awSlope, out float awLap) {",
  "  vec2 disp; vec4 wg; vec2 wl;",
  "  warpField(p, t, disp, wg, wl);",
  "  vec2 q = p + disp;",
  "  float h = 0.0;",
  "  awSlope = vec2(0.0);",
  "  awLap = 0.0;",
  ...AMBIENT_RESOLVED.map((w) => {
    const dx = w.dx.toFixed(6);
    const dz = w.dz.toFixed(6);
    const k = w.k.toFixed(4);
    const om = w.omega.toFixed(4);
    const ph = w.phase.toFixed(4);
    const a = w.amp.toFixed(6);
    return [
      "  {",
      `    float s = dot(q, vec2(${dx}, ${dz})) * ${k} - ${om} * t + ${ph};`,
      "    float sn = sin(s);",
      "    float cs = cos(s);",
      `    h += ${a} * sn;`,
      `    vec2 mtd = vec2(${dx} * (1.0 + wg.x) + ${dz} * wg.z, ${dx} * wg.y + ${dz} * (1.0 + wg.w));`,
      `    awSlope += ${a} * ${k} * cs * mtd;`,
      `    awLap += ${a} * ${k} * cs * (${dx} * wl.x + ${dz} * wl.y) - ${a} * ${k} * ${k} * sn * dot(mtd, mtd);`,
      "  }",
    ];
  }).flat(),
  "  return h;",
  "}",
].join("\n");

/** 所有 lux 材质共享的 uniform 声明(viewer 提供同源值对象) */
const COMMON_UNIFORMS = /* glsl */ `
#define MAXD 64
#define CAUSTIC_GAIN 0.03
#define MIST_HEIGHT_K 7.0
uniform sampler2D uHeightTex;
uniform vec2 uTexel;        // 1/N
uniform vec2 uUvK;          // 世界坐标 → 高度纹理 uv:x·scale + offset
uniform float uDomain;
uniform float uPoolDepth;
uniform float uEta;         // 1/1.33
uniform float uF0;          // Fresnel 正入射反射率 0.02
uniform vec3 uAbsorb;       // Beer–Lambert 吸收(/m,RGB)
uniform float uRough;       // GGX 粗糙度
uniform vec3 uSunDir;       // 指向太阳/月亮(单位向量)
uniform vec3 uSunColor;     // HDR(含强度)
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uMistColor;
uniform float uMistDensity;
uniform vec3 uWaterBody;    // 水体内散射色(风格化)
uniform vec3 uBottomAlbedo;
uniform float uCausticScale;
uniform float uGlint;
uniform float uShadow;      // 液滴软影强度
uniform float uNightDots;   // 0/1
uniform vec3 uNightDotColor;
uniform float uDotCell;     // 夜光点阵周期(m)
uniform float uTime;        // 物理时间源 simTime
uniform float uDim;         // 聚焦压暗(非成员环境面)
uniform float uExposure;
uniform float uSat;
uniform float uContrast;
uniform float uBridgeOpacity;
uniform float uBridgeHiOpacity;
uniform float uDropDarken;
uniform float uWaveAmp;       // 环境波涛全局幅度(RENDER_PARAMS.ambientWaveAmp)
uniform vec2 uDropPos[MAXD];   // 漂浮滴世界 xz(软影用)
uniform float uDropRad[MAXD];
uniform float uDropCountF;
uniform vec3 uTint;           // 水面/液滴统一色调(时段化:清晨粉紫/深夜深蓝)
uniform float uTintAmt;       // 色调混合量(LightingPreset.surfaceTintAmt)
uniform float uMistLayer;     // 上方雾气层强度(0=无)
uniform float uEdgeLift;      // 水底渐变边缘提亮(深夜≈0,保场景一致暗度)
`;

/** 共享光学函数库 */
const COMMON_HELPERS = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float heightAt(vec2 uv) { return texture2D(uHeightTex, uv).r; }
// 中心差分:斜率(x,z)+ 拉普拉斯(焦散聚焦度;凹面聚焦为正)
void heightDerivs(vec2 uv, out vec3 slope, out float lap) {
  vec2 e = uTexel;
  float hL = heightAt(uv - vec2(e.x, 0.0));
  float hR = heightAt(uv + vec2(e.x, 0.0));
  float hD = heightAt(uv - vec2(0.0, e.y));
  float hU = heightAt(uv + vec2(0.0, e.y));
  float hC = heightAt(uv);
  float dx = e.x * uDomain;
  slope = vec3((hR - hL) / (2.0 * dx), 0.0, (hD - hU) / (2.0 * dx));
  lap = (hL + hR + hD + hU - 4.0 * hC) / (dx * dx);
}
${AMBIENT_WAVE_GLSL}
// 合成水面导数 = 仿真高度纹理 + 环境波涛(解析导数;世界坐标 wxz)
// 水面法线/水底焦散/折射扭曲统一走这里,保证三层对同一波场一致
void waterDerivs(vec2 uv, vec2 wxz, out vec3 slope, out float lap) {
  heightDerivs(uv, slope, lap);
  vec2 awS;
  float awL;
  ambientWaveField(wxz, uTime, awS, awL);
  slope.x += uWaveAmp * awS.x;
  slope.z += uWaveAmp * awS.y;
  lap += uWaveAmp * awL;
}
// 程序化天空(反射环境)+ 光源圆盘辉光
vec3 skyColor(vec3 dir) {
  float t = pow(clamp(dir.y, 0.0, 1.0), 0.5);
  vec3 col = mix(uSkyHorizon, uSkyZenith, t);
  float s = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * (pow(s, 600.0) * 4.0 + pow(s, 8.0) * 0.08);
  return col;
}
// GGX 镜面高光(Torrance–Sparrow;水面 glitter 的物理来源)
float ggxSpec(vec3 n, vec3 v, vec3 l, float rough) {
  vec3 h = normalize(v + l);
  float a = rough * rough;
  float nh = max(dot(n, h), 0.0);
  float dd = nh * nh * (a * a - 1.0) + 1.0;
  float D = (a * a) / (3.14159265 * dd * dd + 1e-7);
  float nv = max(dot(n, v), 1e-4);
  float nl = max(dot(n, l), 0.0);
  float k = a * 0.5;
  float gv = nv / (nv * (1.0 - k) + k);
  float gl = nl / (nl * (1.0 - k) + k);
  return D * gv * gl / (4.0 * nv);
}
// 液滴投影软影(需求②:替代单一径向压暗——太阳方向投影 + 本影/半影两层):
// 影心沿太阳反方向平移(投高≈池深,风格化),本影紧、半影宽,细腻成锥
float dropShadowField(vec2 wxz) {
  float maxInfluence = 0.0;
  vec2 shift = uSunDir.xz / max(uSunDir.y, 0.4) * (uPoolDepth * 0.85);
  for (int i = 0; i < MAXD; i++) {
    float on = step(float(i) + 0.5, uDropCountF);
    vec2 rel = wxz - (uDropPos[i] - shift);
    float r = max(uDropRad[i], 1e-4);
    float dd = length(rel);
    float umbra = smoothstep(r * 1.05, r * 0.4, dd);
    float penumbra = smoothstep(r * 2.8, r * 0.85, dd);
    float infl = uShadow * (umbra * 0.9 + penumbra * 0.42) * on;
    maxInfluence = max(maxInfluence, infl);
  }
  return maxInfluence;
}
// 深夜生物荧光海岸(委托方 2026-09-09 第九批重做并二次整改,严格还原
// docs/水底夜晚.jpg 的海岸形态;第八批的「各向同性脊状 fbm 等值线」方案整体废弃
// ——等值线网呈碎花纹,不是参考图中数条大致平行、横贯画面的蜿蜒海岸线)。
// 手法对齐业界成熟做法(Cyanilux Shoreline Breakdown 的「距离场+滚动→成带+swash」
// / Shadertoy 距离辉光 / 哈希格点 sparkle):距离场 + 1D 振幅谱位移 → 按距离衰减成线。
// - 形态 = 波列束(5 条等相位间隔的海岸线)+ 沿线 1D 蜿蜒谱(λ 1.85/0.79/0.37/
//   0.19m,幅 52/30/13/5mm,宽弧大弯为主细弯点缀)→ 长而平滑不规则弯曲的连续边界;
//   距离按蜿蜒斜率做法向修正,线宽不随坡度变化。
// - 动态 = ①**法向推进**(2026-09-09 二次整改:海浪沿边界法线向岸推进,非沿 x 横滑):
//   波列相位匀速前进(fract 循环,周期 ~62s,推进 ~0.021 m/s,每 ~12.5s 一波到岸,
//   线束数恒定 → 结构稳定)+ 涌浪余弦进退(±0.052m,周期 ~39s,推进中带停顿回退);
//   ②蜿蜒相位慢漂移(0.09-0.21 rad/s)+ 局部线宽慢调制(±35%)→ 局部收缩/扩张/
//   弯曲,谱幅有界 → 波形随推进保持、整体结构稳定;
//   ③辉光呼吸(周期 ~19s)相位随带序 + 沿线位置,幅度加深(0.55±0.45)→
//   各段缓慢、非同步、局部近乎熄灭(参考图线亮度沿走向起伏大)。
// - 亮度 = 蓝白窄核心(高斯,σ=局部半宽 ~3-6mm)+ 蓝色辉光裙摆(指数 ~4-5cm)
//   + 宽域弱蓝晕(λ≈8cm,线间水体的深蓝感;随线距衰减保持局部性,非均匀蓝光);
//   环境光由 NIGHT 预设压至近黑。
// - 颗粒 = 格点取在最近波列的**随动坐标系 (x, ζ)**(ζ=有符号法向偏移)→ 光点随
//   边界线一同运动(推进/涌浪/蜿蜒全继承,委托方 2026-09-09 二次反馈);密度与
//   亮度在边界处峰值最强、向外快速渐弱(参考图);热点成片闪砾亦随线同行;
//   其上叠加极低速随机漂浮(双频慢摆,相位随机,无统一方向)与随机生命周期;
//   尺寸高幂偏置——多数极细小,仅少量更大更亮越过 bloom 阈值泛辉光。
// 纯 GPU 层:无 TS 镜像同步约束(与 AMBIENT_WAVES 纪律不同);冒烟 = luxNight.test.ts。
float coastDist(vec2 p, float t, out float kb, out float zeta) {
  float dmin = 1e3;
  zeta = 0.0;
  for (int i = 0; i < 5; i++) {
    float k = float(i);
    // 法向推进:相位匀速前进 + 涌浪余弦进退,fract 循环 → 波列一波波向岸推进
    float s = fract(0.1 + 0.2 * k + 0.016 * t + 0.04 * sin(t * 0.16 + k * 2.7));
    float zl = s * 1.3 - 0.65; // 扫过 [-0.65, 0.65](水域 ±0.5 全覆盖)
    float bend =
      0.052 * sin(p.x * 3.4 + k * 2.4 + 0.09 * t)
    + 0.030 * sin(p.x * 8.0 + k * 5.1 - 0.12 * t)
    + 0.013 * sin(p.x * 17.0 + k * 1.9 + 0.16 * t)
    + 0.005 * sin(p.x * 33.0 + k * 4.3 - 0.21 * t);
    float slope = // bend 对 x 的导数(法向距离修正)
      0.177 * cos(p.x * 3.4 + k * 2.4 + 0.09 * t)
    + 0.240 * cos(p.x * 8.0 + k * 5.1 - 0.12 * t)
    + 0.221 * cos(p.x * 17.0 + k * 1.9 + 0.16 * t)
    + 0.165 * cos(p.x * 33.0 + k * 4.3 - 0.21 * t);
    float width = 0.0045 * (1.0 + 0.35 * sin(p.x * 7.3 + k * 3.7 + 0.13 * t)); // 局部收缩/扩张
    zl += bend;
    float off = (p.y - zl) / sqrt(1.0 + slope * slope); // 有符号法向偏移(m)
    float dk = abs(off) / width;
    if (dk < dmin) { dmin = dk; kb = k; zeta = off; }
  }
  return dmin;
}
vec3 nightCoast(vec2 wxz, vec3 col) {
  if (uNightDots <= 0.5) return col;
  float kb = 0.0;
  float zeta = 0.0;
  float dn = coastDist(wxz, uTime, kb, zeta); // dn:到最近边界距离(单位=局部半宽)
  // 辉光呼吸:慢(周期 ~19s),相位随带序 + 沿线位置 → 各段非同步;
  // 幅度 0.55±0.45 → 局部可近乎熄灭(参考图线亮度沿走向起伏大)
  float breathe = 0.55 + 0.45 * sin(uTime * 0.33 + kb * 2.6 + wxz.x * 4.0);
  float core = exp(-dn * dn * 0.7);    // 蓝白窄核心(高斯)
  float halo = exp(-dn * 0.18) * 0.5;  // 外围蓝色辉光裙摆(指数)
  float wash = exp(-dn * 0.055) * 0.1; // 宽域弱蓝晕:线间水体深蓝感(随线距衰减)
  col += uNightDotColor * (halo * breathe + wash);
  col += mix(uNightDotColor, vec3(0.88, 0.95, 1.0), 0.72)
       * (core * (0.45 + 0.55 * breathe));
  // 发光颗粒:格点取在最近波列的**随动坐标系 (x, ζ)**(ζ=该线的有符号法向偏移)
  // → 线的法向推进/涌浪/蜿蜒全部被颗粒继承,光点贴线同行(委托方 2026-09-09);
  // 紧贴亮线处最密最白,向外缓慢稀疏变暗(委托方 2026-09-09 三次反馈:
  // 「光点紧贴亮线、密集近白,向外缓慢稀疏变暗」),再叠加极低速随机漂浮
  vec2 cellUv = vec2(wxz.x, zeta) / uDotCell;
  vec2 id = floor(cellUv);
  vec2 f = fract(cellUv);
  float ha = hash12(id + 3.1);
  float hb = hash12(id + 57.7);
  vec2 anchor = vec2(0.2 + 0.6 * ha, 0.2 + 0.6 * hb); // 格点内随机锚(破网格感)
  float big = pow(hash12(id + 91.3), 7.0); // 高幂偏置:少数大而亮
  // 随机生命周期:周期 6-20s,18% 淡入 / 22% 淡出
  float lifeT = fract(uTime * (0.05 + 0.11 * ha) + hb * 7.0);
  float life = smoothstep(0.0, 0.18, lifeT) * (1.0 - smoothstep(0.78, 1.0, lifeT));
  // 极低速随机漂浮(双频慢摆,各颗粒相位随机 → 无明显统一方向运动)
  vec2 wander = 0.22 * vec2(
    sin(uTime * (0.10 + 0.09 * hb) + ha * 6.2832),
    cos(uTime * (0.08 + 0.07 * ha) + hb * 6.2832));
  float pd = length(f - anchor - wander) * uDotCell; // 到颗粒心距离(米)
  float pr = mix(0.0015, 0.0045, big); // 半径绝对值 1.5-4.5mm(格点缩小时仍 ≥1px 恒可见)
  float pt = smoothstep(pr, 0.0, pd);
  // 热点(成片闪砾,随线同行)+ 近密近亮、向外缓慢稀疏变慢衰减
  float clump = 0.45 + 0.55 * vnoise(vec2(wxz.x * 2.9 + 7.3, zeta * 2.1)); // patch 为 GLSL 保留字
  float dens = (0.10 + 0.90 * exp(-dn * 0.30)) * clump; // 线处最密,向外缓慢稀疏
  float pBrt = (0.45 + 0.55 * exp(-dn * 0.25)) * 1.5;   // 线处最亮,向外缓慢变暗
  float whiteMix = clamp(0.3 + 0.6 * exp(-dn * 0.4), 0.0, 0.95); // 线处近白,远处蓝
  float tw = 0.6 + 0.4 * sin(uTime * (0.45 + 0.5 * hb) + ha * 40.0); // 亮度缓变
  vec3 pCol = mix(uNightDotColor, vec3(0.93, 0.97, 1.0), whiteMix);
  col += pCol * (pt * life * dens * tw * pBrt * (0.85 + 1.5 * big));
  return col;
}
// 池底着色:反照率 × 光照 × 焦散(∇²h)× 液滴软影(+ 深夜生物荧光海岸)
// 水面折射与"透过水看到的水底"共用同一函数(折射点 = 折射线与池底平面解析求交)
vec3 shadeBottom(vec2 uv, vec2 wxz) {
  vec3 slope;
  float lap;
  waterDerivs(uv, wxz, slope, lap);
  float ca = clamp(lap * uCausticScale * CAUSTIC_GAIN, -0.8, 3.0);
  float shadow = 1.0 - dropShadowField(wxz);
  vec3 light = uSunColor * max(uSunDir.y, 0.0) + (uAmbSky + uAmbGround) * 0.5;
  vec3 col = uBottomAlbedo * light * shadow * (1.0 + max(ca, 0.0) * 2.0);
  col *= 1.0 + min(ca, 0.0); // 凸脊发散 → 压暗
  col = nightCoast(wxz, col);
  return col;
}
// 时段 grade(曝光/饱和/对比)+ 高度雾(近水面指数衰减 × 低频漂移噪声)
vec3 applyGrade(vec3 c) {
  c *= uExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  c = (c - 0.5) * uContrast + 0.5;
  return max(c, vec3(0.0));
}
vec3 applyMist(vec3 c, vec3 wpos) {
  if (uMistDensity <= 0.0) return c;
  float d = distance(cameraPosition, wpos);
  float hf = exp(-max(wpos.y, -0.02) * MIST_HEIGHT_K);
  float n = vnoise(wpos.xz * 4.0 + vec2(uTime * 0.25, uTime * 0.11));
  float amt = 1.0 - exp(-d * uMistDensity * (0.55 + 0.9 * n) * hf);
  return mix(c, uMistColor, clamp(amt, 0.0, 0.9));
}
`;

/** 水面:顶点位移 = 高度纹理(格心精确采样)+ 环境波涛(与 TS 同源) */
export const LUX_SURFACE_VERT = /* glsl */ `
uniform sampler2D uHeightTex;
uniform float uTime;
uniform float uWaveAmp;
${AMBIENT_WAVE_GLSL}
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec3 p = position;
  vec2 awS;
  float awL;
  p.y = texture2D(uHeightTex, vUv).r
      + uWaveAmp * ambientWaveField(p.xz, uTime, awS, awL);
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

/** 水面片元:透明式浅蓝水面(Fresnel 反射 + Snell 折射看水底 + 焦散 + GGX 高光) */
export const LUX_SURFACE_FRAG = [
  COMMON_UNIFORMS,
  COMMON_HELPERS,
  /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vec3 slope;
  float lap;
  waterDerivs(vUv, vWorld.xz, slope, lap);
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.z));
  vec3 v = normalize(cameraPosition - vWorld);
  float nov = max(dot(n, v), 1e-4);
  float F = uF0 + (1.0 - uF0) * pow(1.0 - nov, 5.0);
  vec3 env = skyColor(reflect(-v, n));
  // 折射:与池底平面 y = -poolDepth 解析求交
  vec3 rd = refract(-v, n, uEta);
  float pathLen = uPoolDepth / max(-rd.y, 0.2);
  vec2 bpos = vWorld.xz + rd.xz * pathLen;
  vec2 buv = clamp(bpos * uUvK.x + uUvK.y, vec2(0.002), vec2(0.998));
  vec3 bottom = shadeBottom(buv, bpos);
  vec3 transmit = exp(-uAbsorb * pathLen);
  float tAvg = dot(transmit, vec3(0.3333));
  vec3 body = bottom * transmit + uWaterBody * (1.0 - tAvg) * 3.0;
  // 透明式水面统一色调(2026-09-09 第八批时段化:清晨粉紫/正午傍晚淡蓝/深夜深蓝;
  // 混合量 = 预设 surfaceTintAmt,正午 0.55 与旧写死淡蓝观感一致)
  vec3 col = mix(body, env, F);
  col = mix(col, uTint, uTintAmt);
  col += uSunColor * ggxSpec(n, v, uSunDir, uRough) * uGlint;
  col = applyGrade(col);
  col = applyMist(col, vWorld);
  col *= mix(1.0, 0.42, uDim);
  // 透明度:掠射角更不透明(Fresnel),垂直俯视最透明(看水底)
  float alpha = mix(0.15, 0.7, F);
  gl_FragColor = vec4(col, alpha);
}
`,
].join("\n");

/** 液滴:半球水滴(委托方 2026-09-09「z 轴拉长至 1.0」:高/半径比 0.3→1.0,
 *  接触角 33°→90° 正半球);实例 y 向缩放 r·(1−ε),法线按 y/x 缩放比修正 */
export const LUX_DROPLET_VERT = /* glsl */ `
#define LENS_H 1.0
attribute float aEps;
varying vec3 vN;
varying vec3 vW;
varying vec3 vTint;
void main() {
  vTint = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  // 实例变换 = 平移 · 缩放(r, r·LENS_H·(1−ε), r),无旋转 →
  // 法线修正 = y 除以 LENS_H·(1−ε)(透镜厚度方向非均匀缩放)
  vN = normalize(vec3(normal.x, normal.y / max(LENS_H * (1.0 - aEps), 0.075), normal.z));
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const LUX_DROPLET_FRAG = [
  COMMON_UNIFORMS,
  COMMON_HELPERS,
  /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying vec3 vTint;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float nov = max(dot(n, v), 1e-4);
  float F = uF0 + (1.0 - uF0) * pow(1.0 - nov, 5.0);
  float ndl = max(dot(n, uSunDir), 0.0);
  // 水材质(委托方 2026-09-09:不再是玻璃球——与液面同族:Snell 折射看水底
  // (半球透镜的放大扭曲)+ Fresnel 天空反射 + 淡蓝染色,透明度与液面一致)
  vec3 lit = uSunColor * (0.30 * ndl) + (uAmbSky + uAmbGround) * 0.55;
  vec3 rd = refract(-v, n, uEta);
  if (dot(rd, rd) < 1e-5) rd = normalize(vec3(n.x, -0.35, n.z)); // 掠射 TIR 兜底
  float pathLen = uPoolDepth / max(-rd.y, 0.25);
  vec2 bpos = vW.xz + rd.xz * pathLen;
  vec2 buv = clamp(bpos * uUvK.x + uUvK.y, vec2(0.002), vec2(0.998));
  vec3 bottom = shadeBottom(buv, bpos);
  vec3 transmit = exp(-uAbsorb * pathLen);
  vec3 body = bottom * transmit + uWaterBody * (1.0 - dot(transmit, vec3(0.3333))) * 3.0
            + uTint * 0.35;
  vec3 env = skyColor(reflect(-v, n));
  // 色调随预设(2026-09-09 第八批时段化;uTintAmt×0.64 ≈ 旧写死 0.35,
  // 正午/傍晚观感不变,深夜/清晨随预设变色)
  vec3 col = mix(mix(body, env, F), uTint, uTintAmt * 0.64);
  col += uSunColor * ggxSpec(n, v, uSunDir, 0.14) * uGlint * 0.8;
  col *= vTint;
  col = applyGrade(col);
  col = applyMist(col, vW);
  float alpha = mix(0.15, 0.7, F); // 与液面同式:垂直俯视最透,掠射角更实
  gl_FragColor = vec4(col, alpha);
}
`,
].join("\n");

/** 液桥:透明 30%(委托方);高亮因子 aEmph → 提亮 + 提升不透明度 */
export const LUX_BRIDGE_VERT = /* glsl */ `
attribute float aEmph;
varying vec3 vN;
varying vec3 vW;
varying float vEmph;
void main() {
  vEmph = aEmph;
  vN = normal; // CPU 顶点即世界系,径向 = 法线
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const LUX_BRIDGE_FRAG = [
  COMMON_UNIFORMS,
  COMMON_HELPERS,
  /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying float vEmph;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float nov = max(dot(n, v), 1e-4);
  float F = uF0 + (1.0 - uF0) * pow(1.0 - nov, 5.0);
  float ndl = max(dot(n, uSunDir), 0.0);
  // 液桥:透明淡蓝(委托方 2026-09-09「液桥改为透明淡蓝色」)。细水柱光程短 →
  // 内体按淡蓝水色调制、受光限幅;常态 alpha 0.30(委托方指定值不变)。
  // 夜晚天空近黑 → 内体随光照自动隐没,只剩月光镜面
  vec3 lit = uSunColor * (0.25 * ndl) + (uAmbSky + uAmbGround) * 0.6;
  vec3 body = vec3(0.55, 0.78, 0.95) * lit * 1.5;
  vec3 col = body + skyColor(reflect(-v, n)) * (F * 1.1 + 0.3);
  col += uSunColor * ggxSpec(n, v, uSunDir, 0.14) * uGlint;
  col = mix(col, col * 1.3, vEmph); // 高亮:温和变亮(减弱)
  col = applyGrade(col);
  col = applyMist(col, vW);
  float alpha = mix(uBridgeOpacity, uBridgeHiOpacity, vEmph); // 30% → 高亮
  gl_FragColor = vec4(col, alpha);
}
`,
].join("\n");

/** 水底平面:浅蓝(中心)→ 白(边缘)径向渐变,受光照 + 焦散 + 液滴软影 */
export const LUX_BOTTOM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const LUX_BOTTOM_FRAG = [
  COMMON_UNIFORMS,
  COMMON_HELPERS,
  /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  // 径向渐变:域中心亮 → 边缘暗。以 bottomAlbedo 调制(此前写死浅蓝渐变,
  // 时段预设的 albedo 只作用于折射视图 → 深夜水底压不暗,缺陷修复);
  // ×2.15 标定:正午 albedo(≈0.78 灰)时与旧版浅蓝渐变亮度对齐;
  // 边缘提亮量时段化(uEdgeLift):深夜≈0,保「水底与场景颜色一致」
  float dist = distance(vUv, vec2(0.5)) * 1.4142; // 0(中心)→1(角点)
  vec3 base = uBottomAlbedo * 2.15;
  vec3 grad = mix(base, base * 0.55 + vec3(uEdgeLift), smoothstep(0.0, 1.0, dist));
  vec2 wxz = vWorld.xz;
  vec2 uvh = clamp(wxz * uUvK.x + uUvK.y, vec2(0.002), vec2(0.998));
  vec3 slope;
  float lap;
  waterDerivs(uvh, wxz, slope, lap);
  float ca = clamp(lap * uCausticScale * CAUSTIC_GAIN, -0.8, 3.0);
  float shadow = 1.0 - dropShadowField(wxz);
  vec3 light = uSunColor * max(uSunDir.y, 0.0) + (uAmbSky + uAmbGround) * 0.5;
  vec3 col = grad * light * shadow * (1.0 + max(ca, 0.0) * 2.0);
  col *= 1.0 + min(ca, 0.0);
  col = nightCoast(wxz, col);
  col = applyGrade(col);
  col = applyMist(col, vWorld);
  col *= mix(1.0, 0.42, uDim);
  gl_FragColor = vec4(col, 1.0);
}
`,
].join("\n");

/** 上方雾气层(2026-09-09 第八批,参考图1清晨蒸汽):水平薄片 + 程序化团涌。
 *  位于液滴上方(viewer 设 y=0.055 > 滴顶 ~0.038);强度 = 预设 mistLayer
 *  (清晨 1.0,其余 0);掠射/层下 facing 淡出防「平板剪影」,域边淡出不出画。 */
export const LUX_MIST_VERT = /* glsl */ `
varying vec2 vXZ;
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vXZ = wp.xz;
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const LUX_MIST_FRAG = [
  COMMON_UNIFORMS,
  COMMON_HELPERS,
  /* glsl */ `
varying vec2 vXZ;
varying vec3 vW;
void main() {
  // 双层团涌:低频大团(域扭曲防直纹)+ 高频絮丝;慢速漂移(双频,无强方向感)
  vec2 p = vXZ * 3.1;
  vec2 q = vec2(
    vnoise(p + vec2(uTime * 0.05, uTime * 0.021)),
    vnoise(p + vec2(uTime * 0.037 + 5.2, -uTime * 0.026 + 1.3)));
  float n = vnoise(p + q * 1.6);
  float wisp = vnoise(vXZ * 8.5 + q * 0.8 + vec2(uTime * 0.09, -uTime * 0.05));
  float billow = n * 0.68 + wisp * 0.32;
  float patch = smoothstep(0.38, 0.8, billow); // 团与团之间留空隙(非整片蒙板)
  // 掠射淡出 + 层下不可见:相机在层上方时 dot(+y, 视线) 大 → 最实
  vec3 v = normalize(cameraPosition - vW);
  float facing = clamp(dot(vec3(0.0, 1.0, 0.0), v), 0.0, 1.0);
  facing *= facing;
  // 域边淡出(雾只罩水体及周边;0.34→0.56 ≈ 水底平面半径 0.575)
  float edge = 1.0 - smoothstep(0.34, 0.56, length(vXZ));
  float alpha = uMistLayer * patch * facing * edge * 0.5;
  if (alpha < 0.004) discard;
  vec3 col = uMistColor * 1.12; // 与 applyMist 同族(雾在 grade 之后混合,不做 grade)
  col *= mix(1.0, 0.42, uDim);  // 荱焦压暗与其他材质一致
  gl_FragColor = vec4(col, alpha);
}
`,
].join("\n");
