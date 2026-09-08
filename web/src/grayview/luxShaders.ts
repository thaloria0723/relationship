// ============================================================
// 光影渲染 GLSL(模块③;docs/光影渲染设计-2026-09-08.md §5)
// 纯模板字符串(three-free),由 grayview/viewer.ts(全工程唯一 import three)
// 装配进 ShaderMaterial。所有光照按水的物理光学实现:
//   Fresnel(Schlick, F0=0.02)+ Snell 折射(1/1.33,池底解析求交)
//   + Beer–Lambert 吸收 + GGX 镜面 + 高度场拉普拉斯焦散 + 高度雾(Mie 风格化)。
// 风格化项(设计文档 §3 声明):夜晚金色光点(月光焦散点化)。
// 液桥常态透明度 30% 为委托方指定值(bridgeOpacity uniform)。
// ============================================================

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
// 池底着色:反照率 × 光照 × 焦散(∇²h)× 液滴软影(+ 夜晚金色光点)
// 水面折射与"透过水看到的水底"共用同一函数(折射点 = 折射线与池底平面解析求交)
vec3 shadeBottom(vec2 uv, vec2 wxz) {
  vec3 slope;
  float lap;
  heightDerivs(uv, slope, lap);
  float ca = clamp(lap * uCausticScale * CAUSTIC_GAIN, -0.8, 3.0);
  // 液滴软影:取最近一颗的影响(非累乘,避免落滴越多水底越暗)
  float shadow = 1.0;
  float maxInfluence = 0.0;
  for (int i = 0; i < MAXD; i++) {
    float on = step(float(i) + 0.5, uDropCountF);
    float dd = distance(wxz, uDropPos[i]);
    float r = max(uDropRad[i], 1e-4);
    float infl = uShadow * smoothstep(r * 2.2, r * 0.6, dd) * on;
    maxInfluence = max(maxInfluence, infl);
  }
  shadow = 1.0 - maxInfluence;
  vec3 light = uSunColor * max(uSunDir.y, 0.0) + (uAmbSky + uAmbGround) * 0.5;
  vec3 col = uBottomAlbedo * light * shadow * (1.0 + max(ca, 0.0) * 2.0);
  col *= 1.0 + min(ca, 0.0); // 凸脊发散 → 压暗
  if (uNightDots > 0.5) {
    vec2 cellUv = wxz / uDotCell;
    vec2 id = floor(cellUv);
    vec2 f = fract(cellUv);
    vec2 off = vec2(hash12(id + 13.1), hash12(id + 71.7)) * 0.6 + 0.2;
    float pd = length(f - off);
    float pt = smoothstep(0.16, 0.03, pd);
    float rnd = hash12(id + 5.2);
    float fl = pow(max(sin(uTime * (1.5 + 3.0 * rnd) + rnd * 40.0), 0.0), 8.0);
    float caust = clamp(0.6 + lap * uCausticScale * 0.05, 0.0, 1.6);
    col += uNightDotColor * (pt * fl * caust * 1.5);
  }
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

/** 水面:顶点位移自高度纹理(格心精确采样) */
export const LUX_SURFACE_VERT = /* glsl */ `
uniform sampler2D uHeightTex;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec3 p = position;
  p.y = texture2D(uHeightTex, vUv).r;
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
  heightDerivs(vUv, slope, lap);
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
  // 透明式水面:浅蓝 tint + 折射水底混合,低 alpha 让水底 mesh 透过可见
  vec3 lightBlueTint = vec3(0.6, 0.8, 0.92);
  vec3 col = mix(body, env, F);
  col = mix(col, lightBlueTint, 0.35); // 浅蓝倾向
  col += uSunColor * ggxSpec(n, v, uSunDir, uRough) * uGlint;
  col = applyGrade(col);
  col = applyMist(col, vWorld);
  col *= mix(1.0, 0.42, uDim);
  // 透明度:掠射角更不透明(Fresnel),垂直俯视最透明(看水底)
  float alpha = mix(0.22, 0.85, F);
  gl_FragColor = vec4(col, alpha);
}
`,
].join("\n");

/** 液滴:扁平透镜状水滴(上凸下平球冠 + 下平圆面);实例 y 向缩放 LENS_H·(1−ε) */
export const LUX_DROPLET_VERT = /* glsl */ `
#define LENS_H 0.3
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
  // 内体受光限幅(直射只按小比例进入内体散射,防高光过曝成白团);
  // 内体深色 = 吸收腔(委托方「液滴颜色较深」= uDropDarken)
  vec3 lit = uSunColor * (0.22 * ndl) + (uAmbSky + uAmbGround) * 0.55;
  vec3 body = (uWaterBody * 1.6 + vec3(0.03, 0.07, 0.09)) * lit * uDropDarken * 2.0;
  vec3 env = skyColor(reflect(-v, n));
  vec3 col = mix(body, env, min(F * 2.2, 1.0));
  col += uSunColor * ggxSpec(n, v, uSunDir, 0.16) * uGlint * 0.9;
  col *= vTint;
  col = applyGrade(col);
  col = applyMist(col, vW);
  gl_FragColor = vec4(col, 1.0);
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
  // 液桥:细水柱光程短 → 内体极淡,受光限幅同液滴;常态 alpha 0.30(委托方)。
  // 桥与水面同为水材质,镜面项同构会「水隐于水」;细柱曲率小、全方位受天光,
  // 环境裹挟项 (+0.45·sky) 使其读作一缕微亮水丝(风格化,声明见设计文档 §3);
  // 夜晚天空近黑 → 自动隐没,只剩月光镜面
  vec3 lit = uSunColor * (0.25 * ndl) + (uAmbSky + uAmbGround) * 0.6;
  vec3 body = (uWaterBody * 1.5 + vec3(0.04, 0.08, 0.1)) * lit * 1.6;
  vec3 col = body + skyColor(reflect(-v, n)) * (F * 1.2 + 0.45);
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
  // 径向渐变:域中心浅蓝 → 边缘白(uv 0.5 为中心)
  float dist = distance(vUv, vec2(0.5)) * 1.4142; // 0(中心)→1(角点)
  vec3 lightBlue = vec3(0.55, 0.78, 0.92); // 浅蓝(sRGB 屏显值)
  vec3 white = vec3(0.92, 0.95, 0.98);     // 近白
  vec3 grad = mix(lightBlue, white, smoothstep(0.0, 1.0, dist));
  // 焦散(∇²h 聚焦)+ 液滴软影(复用 shadeBottom 的光照逻辑)
  vec2 wxz = vWorld.xz;
  vec2 uvh = clamp(wxz * uUvK.x + uUvK.y, vec2(0.002), vec2(0.998));
  vec3 slope;
  float lap;
  heightDerivs(uvh, slope, lap);
  float ca = clamp(lap * uCausticScale * CAUSTIC_GAIN, -0.8, 3.0);
  // 液滴软影:取最近一颗的影响(非累乘,避免落滴越多水底越暗)
  float shadow = 1.0;
  float maxInfluence = 0.0;
  for (int i = 0; i < MAXD; i++) {
    float on = step(float(i) + 0.5, uDropCountF);
    float dd = distance(wxz, uDropPos[i]);
    float r = max(uDropRad[i], 1e-4);
    float infl = uShadow * smoothstep(r * 2.2, r * 0.6, dd) * on;
    maxInfluence = max(maxInfluence, infl);
  }
  shadow = 1.0 - maxInfluence;
  vec3 light = uSunColor * max(uSunDir.y, 0.0) + (uAmbSky + uAmbGround) * 0.5;
  vec3 col = grad * light * shadow * (1.0 + max(ca, 0.0) * 2.0);
  col *= 1.0 + min(ca, 0.0);
  // 夜晚金色光点(同 shadeBottom)
  if (uNightDots > 0.5) {
    vec2 cellUv = wxz / uDotCell;
    vec2 id = floor(cellUv);
    vec2 f = fract(cellUv);
    vec2 off = vec2(hash12(id + 13.1), hash12(id + 71.7)) * 0.6 + 0.2;
    float pd = length(f - off);
    float pt = smoothstep(0.16, 0.03, pd);
    float rnd = hash12(id + 5.2);
    float fl = pow(max(sin(uTime * (1.5 + 3.0 * rnd) + rnd * 40.0), 0.0), 8.0);
    float caust = clamp(0.6 + lap * uCausticScale * 0.05, 0.0, 1.6);
    col += uNightDotColor * (pt * fl * caust * 1.5);
  }
  col = applyGrade(col);
  col = applyMist(col, vWorld);
  col *= mix(1.0, 0.42, uDim);
  gl_FragColor = vec4(col, 1.0);
}
`,
].join("\n");
