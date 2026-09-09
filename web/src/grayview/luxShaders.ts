// ============================================================
// 光影渲染 GLSL(模块③;docs/光影渲染设计-2026-09-08.md §5)
// 纯模板字符串(three-free),由 grayview/viewer.ts(全工程唯一 import three)
// 装配进 ShaderMaterial。所有光照按水的物理光学实现:
//   Fresnel(Schlick, F0=0.02)+ Snell 折射(1/1.33,池底解析求交)
//   + Beer–Lambert 吸收 + GGX 镜面 + 动态焦散网(第十批,2026-09-09,见下)
//   + 高度雾(Mie 风格化)。
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
// 动态焦散网 v4(2026-09-09 第十批,委托方指令:删除清晨/正午/傍晚 ∇²h 光纹,
// 改为 docs/光纹.jpg 所示动态光纹;方案与引用:docs/水底光纹焦散网设计方案-2026-09-09.md)。
// **⚠ 现行实现 = 原型 index-wave.html「迭代折射焦散 + 去平铺三件套」原样移植**
// (委托方 2026-09-09 提供实例.png(即原型已验收观感)并裁决:此前的替代策略——
// v2 双层异向叠加、v3 哈希格点 Voronoi、v3.1 蜿蜒谱——均无法达成预期,全部废弃;
// 原型框架与本项目完全一致,按原型移植)。
// 原理(图形学经典技法,常量与结构为本项目自定):采样点在三角波场中迭代折叠
// (模拟折射路径),累积"光会聚度"→ 高会聚处即焦散细丝;丝网是折射的物理产物,
// 无胞/无多边形。mod+(-250) 大偏移是本技法数值区间的必要部分,不可省。
// **去平铺三件套**(消除重复单元的正解,原型已验收):
// ①域扭曲 warpP:慢变大尺度摆动,把瓷砖直边揉成水波曲线;
// ②双采样融合:同层两个大偏移副本(一旋转 30°)用慢变遮罩 mix 融合,接缝互相遮盖
//   → 周期性不可见;
// ③主/次层 seed 独立(相位/偏移/遮罩各自独立),两层反向慢漂 + 斑驳 patch 让局部
//   涟漪隐没。
// 本地化差异(仅两处):①采样域 = 世界坐标 wxz(原型为屏幕归一坐标,网纹钉在水底);
// ②加光走 uSunColor 时段色(原型为纯白),深夜 uNightDots 关断 + 液滴影吃光沿用。
// 纯 GPU 层(与 nightCoast 同纪律,无 TS 镜像),纯 ALU 零纹理。
#define CAUSTIC_SCALE 3.4   // 主网密度(世界米 → 模式空间;原型 webScale,胞径≈1/3.4 米)
#define CAUSTIC_SCALE2 1.9  // 次层密度(更疏、更淡,加深度;原型 webScale2)
#define CAUSTIC_SPEED 0.5   // 涟漪演化速度(原型 webSpeed;静水池=慢)
#define CAUSTIC_AMP 0.1     // 主网强度(原型 webAmp)
#define CAUSTIC_AMP2 0.08   // 次层强度(原型 webAmp2)
#define CAUSTIC_CLAMP 0.14  // 单层加光上限(原型 webClamp,防过曝死白)
#define CAUSTIC_WARP 0.3    // 域扭曲幅度(原型 warpAmp,打破平铺直边)
#define CAUSTIC_PATCH 0.34  // 斑驳(原型 patchAmp;部分水面安静无线,更疏更自然)
#define CAUSTIC_DRIFT vec2(0.006, -0.004) // 光网整体漂移(m/s;原型 drift)
// 迭代折射焦散核(Hoskins《Tileable Water Caustic》MdlXz8 量纲修正版,原型同名函数):
// 返回 0..1(1=焦散亮线);pow 11 = 细丝锐化(折射需要细节可折;底数经 abs 恒正)
float causticWeb(vec2 uv, float t) {
  vec2 p = mod(uv * 6.28318530718, 6.28318530718) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 5; n++) {
    float tt = t * (1.0 - (3.5 / (float(n) + 1.0)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y),
                 sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten),
                           p.y / (cos(i.y + tt) / inten)));
  }
  c /= 5.0;
  float shaped = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(shaped), 11.0), 0.0, 1.0);
}
// 去平铺三件套(原型同名函数原样移植)
// 1) 域扭曲:慢变大尺度摆动,把瓷砖直边揉成水波曲线
vec2 warpP(vec2 p, float t) {
  return p + CAUSTIC_WARP * vec2(
    sin(p.y * 1.7 + t * 0.40 + 2.0) + 0.60 * sin(p.y * 3.9 - t * 0.23),
    cos(p.x * 1.5 - t * 0.35 + 4.0) + 0.60 * cos(p.x * 3.3 + t * 0.19));
}
const mat2 CAUSTIC_ROT = mat2(0.866, 0.5, -0.5, 0.866); // 30°:次副本换个方向
// 2) 双采样融合:同层两个大偏移副本用慢变遮罩融合,接缝互相遮盖 → 周期性不可见
// 3) seed 让主/次层相位、偏移、遮罩各自独立
float aperiodicWeb(vec2 p, float t, float seed) {
  vec2 q = warpP(p, t);
  float w1 = causticWeb(q, t + seed);
  float w2 = causticWeb(CAUSTIC_ROT * (q + vec2(37.2, 11.7)), t + seed + 11.3);
  float m = 0.5 + 0.5 * sin(p.x * 1.1 + p.y * 0.8 + seed)
                 * sin(p.x * 0.6 - p.y * 0.9 - seed * 1.7);
  return mix(w1, w2, m);
}
// 焦散网上色(原型 sceneColor 焦散段;加光改 uSunColor 时段色:正午白/清晨暖金/
// 傍晚琥珀;夜间关断(第九批:亮度只允许来自荧光海岸)、液滴影吃光沿用)
vec3 applyCausticWeb(vec3 col, vec2 wxz, float shadow) {
  float gate = uCausticScale * (1.0 - uNightDots) * shadow;
  vec2 wp = wxz + CAUSTIC_DRIFT * uTime; // 光网整体漂移
  float web  = aperiodicWeb(wp * CAUSTIC_SCALE, uTime * CAUSTIC_SPEED, 0.0);
  float web2 = aperiodicWeb(wp * CAUSTIC_SCALE2 + 13.0,
                            -uTime * CAUSTIC_SPEED * 0.7 + 7.0, 5.0);
  // 斑驳:局部水面安静、涟漪隐没(更疏、更自然)。
  // ⚠ 变量名不可叫 patch(GLSL ES 保留字,第九批同坑;原型内合法但本项目编译器拒绝)
  float patchFade = 1.0 - CAUSTIC_PATCH * (0.5 + 0.5
    * sin(wxz.x * 2.6 + wxz.y * 3.4 + uTime * 0.10)
    * sin(wxz.x * 1.2 - wxz.y * 2.2 - uTime * 0.07));
  float ca = (min(web * CAUSTIC_AMP, CAUSTIC_CLAMP)
            + min(web2 * CAUSTIC_AMP2, CAUSTIC_CLAMP * 0.6)) * patchFade * gate;
  col += uSunColor * ca;
  return col;
}
// 接触环带光晕(2026-09-10 第十一批,实例.png 要素⑤:液滴贴水缘一圈亮环、
// 略外溢到水面;夜间液滴为自发光体 → 环带换暖黄,是「光晕落地」的一部分)。
// 与 dropShadowField 同源遍历 uDropPos/uDropRad,三消费面(水底直视/水面折射/
// 液滴透镜)经 shadeBottom 共享。
vec3 dropRingGlow(vec2 wxz) {
  if (uDropCountF < 0.5) return vec3(0.0);
  float g = 0.0;
  for (int i = 0; i < MAXD; i++) {
    float on = step(float(i) + 0.5, uDropCountF);
    vec2 rel = wxz - uDropPos[i];
    float r = max(uDropRad[i], 1e-4);
    float x = (length(rel) - r * 1.22) / (r * 0.6);
    g = max(g, exp(-x * x * 3.0) * on);
  }
  vec3 dayC = uSunColor * 0.16 + vec3(0.05, 0.06, 0.07);
  return mix(dayC, vec3(1.0, 0.70, 0.32) * 0.5, uNightDots) * g;
}
// 池底着色:反照率 × 光照 × 焦散网 × 液滴软影(+ 接触环带 + 深夜生物荧光海岸)
// 水面折射与"透过水看到的水底"共用同一函数(折射点 = 折射线与池底平面解析求交)
vec3 shadeBottom(vec2 wxz) {
  float shadow = 1.0 - dropShadowField(wxz);
  vec3 light = uSunColor * max(uSunDir.y, 0.0) + (uAmbSky + uAmbGround) * 0.5;
  vec3 col = uBottomAlbedo * light * shadow;
  col = applyCausticWeb(col, wxz, shadow);
  col += dropRingGlow(wxz);
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
  vec3 bottom = shadeBottom(bpos);
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
 *  接触角 33°→90° 正半球);实例 y 向缩放 r·(1−ε),法线按 y/x 缩放比修正。
 *  第十一批(2026-09-10)新增 varying:vCenter/vR(透镜采样基准与等效光程缩放,
 *  任务④放大扭曲水底光纹)、vLocalY(单位几何高度,接触亮环用)。 */
export const LUX_DROPLET_VERT = /* glsl */ `
#define LENS_H 1.0
attribute float aEps;
varying vec3 vN;
varying vec3 vW;
varying vec3 vTint;
varying vec2 vCenter;  // 滴心世界 xz(instance 平移分量;透镜以滴心为采样基准)
varying float vR;      // 实例半径(instance 基向量长;等效透镜光程 = vR×MAG)
varying float vLocalY; // 单位几何高度 y∈[0,1](0=底缘,1=顶)
void main() {
  vTint = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  vCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
  vR = length(instanceMatrix[0].xyz);
  vLocalY = position.y;
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
varying vec2 vCenter;
varying float vR;
varying float vLocalY;
// 透镜等效光程 / 半径(第十一批任务④):GPU Gems 2 ch.19「折射模拟 = 折射线 ×
// 等效光程」的光程缩放;原型 index-wave.html LENS_DEPTH(1.9)同一思想。液滴口径
// ~5cm 对焦散网胞 ~29cm,光程必须数倍于 r 才能在滴内铺开可读的网纹窗口(放大)。
#define CAUSTIC_LENS_MAG 3.2
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float nov = max(dot(n, v), 1e-4);
  float F = uF0 + (1.0 - uF0) * pow(1.0 - nov, 5.0);
  float ndl = max(dot(n, uSunDir), 0.0);
  // ---- 深夜:发光小球(第十一批任务③)——自成光源,暖黄 HDR(> bloom 阈值
  // 0.55)经 UnrealBloom 出光晕;边缘 rim + 白热 GGX 核。日间材质整体让位。 ----
  if (uNightDots > 0.5) {
    float core = 0.75 + 0.25 * ndl;
    float rim = pow(1.0 - nov, 2.0);
    vec3 col = vec3(1.0, 0.70, 0.30) * (1.9 * core)
             + vec3(1.0, 0.88, 0.62) * (rim * 1.1)
             + vec3(1.0, 0.85, 0.55) * ggxSpec(n, v, uSunDir, 0.22) * 2.5;
    col *= vTint;
    col = applyGrade(col);
    gl_FragColor = vec4(col, 0.96);
    return;
  }
  // ---- 白天:珍珠乳白小球(2026-09-10 第十一批,实例.png;修复清晨/正午
  // 可视程度低——旧材质与液面同套透明水公式,alpha 0.15-0.7 + uTint 洗色)----
  // 奶白体:uTint/uTintAmt 已时段化 → 清晨粉白/正午蓝白/傍晚亮白
  vec3 milkBase = mix(vec3(0.88, 0.90, 0.93), uTint * 1.25, uTintAmt * 0.45);
  vec3 milk = milkBase * ((0.55 + 0.45 * ndl) * 1.35);
  // 透镜折射:以滴心为基准的等效光程(任务④;边缘压缩全场景、中心放大光纹)
  vec3 rd = refract(-v, n, uEta);
  if (dot(rd, rd) < 1e-5) rd = normalize(vec3(n.x, -0.35, n.z)); // 掠射 TIR 兜底
  float lensPath = max(vR, 1e-4) * CAUSTIC_LENS_MAG;
  vec2 bpos = vCenter + rd.xz * (lensPath / max(-rd.y, 0.3));
  vec3 lensCol = shadeBottom(bpos) * 1.35; // ×1.35 透镜聚光(光纹过滴更亮)
  // 奶白为壳、折射水底为核(实例.png 蓝核):奶白占比 0.45,核心透出时段水色
  vec3 col = mix(lensCol, milk, 0.45);
  col = mix(col, skyColor(reflect(-v, n)), F); // Fresnel 边缘环境反射
  // 高光:锐 GGX(太阳侧亮斑)+ 宽域柔光(实例.png 亮部高光)
  col += uSunColor * ggxSpec(n, v, uSunDir, 0.14) * uGlint * 0.9;
  col += uSunColor * (pow(ndl, 8.0) * 0.10);
  // 接触亮环(实例.png 底缘一圈亮环;vLocalY 0=底缘)
  float ringM = smoothstep(0.28, 0.03, vLocalY);
  col += (milk * 1.4 + uSunColor * 0.15) * (ringM * (0.5 + 0.5 * F));
  col *= vTint;
  col = applyGrade(col);
  col = applyMist(col, vW);
  float alpha = mix(0.66, 0.94, F); // 珍珠不透明感(垂直俯视也实,不再透成隐形)
  gl_FragColor = vec4(col, alpha);
}
`,
].join("\n");

/** 液桥:透明 30%(委托方);高亮因子 aEmph → 提亮 + 提升不透明度。
 *  第十一批(2026-09-10):aFade = 内部段隐藏因子(CPU 逐顶点算:尖端 0 →
 *  液滴表面交点 1;任务②伸入液滴后隐藏滴内段,无深度写入也无缝)。 */
export const LUX_BRIDGE_VERT = /* glsl */ `
attribute float aEmph;
attribute float aFade;
varying vec3 vN;
varying vec3 vW;
varying float vEmph;
varying float vFade;
void main() {
  vEmph = aEmph;
  vFade = aFade;
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
varying float vFade;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float nov = max(dot(n, v), 1e-4);
  float F = uF0 + (1.0 - uF0) * pow(1.0 - nov, 5.0);
  float ndl = max(dot(n, uSunDir), 0.0);
  // ---- 深夜:暖黄边界线(第十一批任务③)——rim = 侧视轮廓亮线(委托方
  // 「为液桥加上暖黄色边界线」),HDR>阈值经 bloom 出辉光;体色微暖保可见 ----
  if (uNightDots > 0.5) {
    float rim = pow(1.0 - nov, 2.2);
    vec3 col = vec3(1.0, 0.72, 0.32) * (0.42 + 1.75 * rim)
             + vec3(1.0, 0.88, 0.60) * ggxSpec(n, v, uSunDir, 0.18) * 2.0;
    col = applyGrade(col);
    gl_FragColor = vec4(col, mix(0.38, 0.92, rim) * vFade);
    return;
  }
  // 液桥:透明淡蓝(委托方 2026-09-09「液桥改为透明淡蓝色」)。细水柱光程短 →
  // 内体按淡蓝水色调制、受光限幅;常态 alpha 0.30(委托方指定值不变)。
  // 夜晚天空近黑 → 内体随光照自动隐没,只剩月光镜面(深夜分支接管,见上)
  vec3 lit = uSunColor * (0.25 * ndl) + (uAmbSky + uAmbGround) * 0.6;
  vec3 body = vec3(0.55, 0.78, 0.95) * lit * 1.5;
  vec3 col = body + skyColor(reflect(-v, n)) * (F * 1.1 + 0.3);
  col += uSunColor * ggxSpec(n, v, uSunDir, 0.14) * uGlint;
  col = mix(col, col * 1.3, vEmph); // 高亮:温和变亮(减弱)
  col = applyGrade(col);
  col = applyMist(col, vW);
  // alpha × vFade:液滴内部段透明隐藏(任务②),表面交点外恢复满值
  float alpha = mix(uBridgeOpacity, uBridgeHiOpacity, vEmph) * vFade;
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
  float shadow = 1.0 - dropShadowField(wxz);
  vec3 light = uSunColor * max(uSunDir.y, 0.0) + (uAmbSky + uAmbGround) * 0.5;
  vec3 col = grad * light * shadow;
  col = applyCausticWeb(col, wxz, shadow);
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
  // ⚠ 变量名不可叫 patch(GLSL ES 保留字;第八批遗留,部分驱动下静默编译失败,已改名)
  float billowMask = smoothstep(0.38, 0.8, billow); // 团与团之间留空隙(非整片蒙板)
  // 掠射淡出 + 层下不可见:相机在层上方时 dot(+y, 视线) 大 → 最实
  vec3 v = normalize(cameraPosition - vW);
  float facing = clamp(dot(vec3(0.0, 1.0, 0.0), v), 0.0, 1.0);
  facing *= facing;
  // 域边淡出(雾只罩水体及周边;0.34→0.56 ≈ 水底平面半径 0.575)
  float edge = 1.0 - smoothstep(0.34, 0.56, length(vXZ));
  float alpha = uMistLayer * billowMask * facing * edge * 0.5;
  if (alpha < 0.004) discard;
  vec3 col = uMistColor * 1.12; // 与 applyMist 同族(雾在 grade 之后混合,不做 grade)
  col *= mix(1.0, 0.42, uDim);  // 荱焦压暗与其他材质一致
  gl_FragColor = vec4(col, alpha);
}
`,
].join("\n");
