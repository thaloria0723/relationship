// ============================================================
// 光影渲染 GLSL(模块③;docs/光影渲染设计-2026-09-08.md §5)
// 纯模板字符串(three-free),由 grayview/viewer.ts(全工程唯一 import three)
// 装配进 ShaderMaterial。所有光照按水的物理光学实现:
//   Fresnel(Schlick, F0=0.02)+ Snell 折射(1/1.33,池底解析求交)
//   + Beer–Lambert 吸收 + GGX 镜面 + 高度场拉普拉斯焦散 + 高度雾(Mie 风格化)。
// 风格化项(设计文档 §3 声明):夜晚金色光点(月光焦散点化)。
// 液桥常态透明度 30% 为委托方指定值(bridgeOpacity uniform)。
// ============================================================

// ============================================================
// 环境波涛(需求①,参考 docs/波纹2.jpg 的涌动碎波 + 焦散光网):
// 方向谱叠加(sum of directional waves)+ 深水色散 ω=√(g·k) 整体放慢——
// three.js 官方 Ocean(Water)与主流 Gerstner 实现同族的谱成分法,本实现
// 只取垂直位移(域扭曲/折射映射不破格),法线与拉普拉斯全部解析求导。
// 组件表是唯一真源:GLSL(下方生成)与 TS 侧 ambientWaveHeight 同源,
// 保证液滴贴浪与水面位移逐点一致。⚠ 两侧都不要手改数值。
// ============================================================

/** 单个波成分:方向(°)+ 波长(m)+ 振幅(m)+ 相速度缩放(1=深水色散) */
export interface AmbientWaveComponent {
  readonly dirDeg: number;
  readonly lambda: number;
  readonly amp: number;
  readonly speed: number;
}

/** 波谱:长波涌 → 短碎波五成分(域 1m;总幅 ~7mm,总斜率 ~0.24 rad)。
 *  速度整体减半(委托方 2026-09-09「波浪速度减缓」:0.55-0.75 → 0.28-0.38) */
export const AMBIENT_WAVES: readonly AmbientWaveComponent[] = [
  { dirDeg: 20, lambda: 0.36, amp: 0.0032, speed: 0.28 },
  { dirDeg: 65, lambda: 0.22, amp: 0.002, speed: 0.3 },
  { dirDeg: -30, lambda: 0.145, amp: 0.00115, speed: 0.33 },
  { dirDeg: 100, lambda: 0.09, amp: 0.0006, speed: 0.35 },
  { dirDeg: -70, lambda: 0.058, amp: 0.0003, speed: 0.38 },
];

const G_GRAVITY = 9.81;

interface AmbientWaveResolved {
  dx: number;
  dz: number;
  k: number;
  omega: number;
  amp: number;
}

const AMBIENT_RESOLVED: AmbientWaveResolved[] = AMBIENT_WAVES.map((w) => {
  const th = (w.dirDeg * Math.PI) / 180;
  const k = (2 * Math.PI) / w.lambda;
  return {
    dx: Math.cos(th),
    dz: Math.sin(th),
    k,
    omega: Math.sqrt(G_GRAVITY * k) * w.speed,
    amp: w.amp,
  };
});

/**
 * 环境波涛高度(GLSL ambientWaveField 的逐项同源镜像;viewer 给液滴贴浪用)。
 * ampScale 用于 λ 缩放实验,默认 1。
 */
export function ambientWaveHeight(
  x: number,
  z: number,
  t: number,
  ampScale = 1,
): number {
  let h = 0;
  for (const w of AMBIENT_RESOLVED) {
    h += w.amp * Math.sin((w.dx * x + w.dz * z) * w.k - w.omega * t);
  }
  return h * ampScale;
}

/** 由组件表生成 GLSL 逐项展开(ES1.00 无 const 数组,不可下标循环) */
const AMBIENT_WAVE_GLSL = [
  "// ---- 环境波涛:五成分方向谱,解析高度/斜率/拉普拉斯(与 TS 同源生成) ----",
  "float ambientWaveField(vec2 p, float t, out vec2 awSlope, out float awLap) {",
  "  float h = 0.0;",
  "  awSlope = vec2(0.0);",
  "  awLap = 0.0;",
  ...AMBIENT_RESOLVED.map((w) => {
    const phase = `dot(p, vec2(${w.dx.toFixed(6)}, ${w.dz.toFixed(6)})) * ${w.k.toFixed(4)} - ${w.omega.toFixed(4)} * t`;
    return [
      "  {",
      `    float ph = ${phase};`,
      `    h += ${w.amp.toFixed(6)} * sin(ph);`,
      `    awSlope += vec2(${w.dx.toFixed(6)}, ${w.dz.toFixed(6)}) * ${(w.amp * w.k).toFixed(6)} * cos(ph);`,
      `    awLap -= ${(w.amp * w.k * w.k).toFixed(6)} * sin(ph);`,
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
// 夜晚金色光点(细密化,委托方 2026-09-09:点径收小、点阵加密;
// 亮度仍受局部焦散调制——光点顺波纹亮带聚簇,参考 docs/水底夜晚.jpg 的点簇观感)
vec3 nightDotsGlow(vec2 wxz, float lap, vec3 col) {
  if (uNightDots <= 0.5) return col;
  vec2 cellUv = wxz / uDotCell;
  vec2 id = floor(cellUv);
  vec2 f = fract(cellUv);
  vec2 off = vec2(hash12(id + 13.1), hash12(id + 71.7)) * 0.6 + 0.2;
  float pd = length(f - off);
  float pt = smoothstep(0.105, 0.022, pd);
  float rnd = hash12(id + 5.2);
  float fl = pow(max(sin(uTime * (1.5 + 3.0 * rnd) + rnd * 40.0), 0.0), 8.0);
  float caust = clamp(0.6 + lap * uCausticScale * 0.05, 0.0, 1.6);
  return col + uNightDotColor * (pt * fl * caust * 1.35);
}
// 池底着色:反照率 × 光照 × 焦散(∇²h)× 液滴软影(+ 夜晚金色光点)
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
  col = nightDotsGlow(wxz, lap, col);
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
  // 透明式水面:淡蓝倾向加强 + 更透(委托方 2026-09-09「液面透明淡蓝」)
  vec3 lightBlueTint = vec3(0.58, 0.79, 0.94);
  vec3 col = mix(body, env, F);
  col = mix(col, lightBlueTint, 0.55);
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
            + vec3(0.58, 0.79, 0.94) * 0.35;
  vec3 env = skyColor(reflect(-v, n));
  vec3 col = mix(mix(body, env, F), vec3(0.58, 0.79, 0.94), 0.35);
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
  // ×2.15 标定:正午 albedo(≈0.78 灰)时与旧版浅蓝渐变亮度对齐
  float dist = distance(vUv, vec2(0.5)) * 1.4142; // 0(中心)→1(角点)
  vec3 base = uBottomAlbedo * 2.15;
  vec3 grad = mix(base, base * 0.55 + vec3(0.16), smoothstep(0.0, 1.0, dist));
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
  col = nightDotsGlow(wxz, lap, col);
  col = applyGrade(col);
  col = applyMist(col, vWorld);
  col *= mix(1.0, 0.42, uDim);
  gl_FragColor = vec4(col, 1.0);
}
`,
].join("\n");
