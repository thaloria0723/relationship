// ============================================================
// watersim 参数 · 唯一真源(docs/物理模型实施文档-2026-09-06.md §5,分册常量)
//
// ⚠ 对文档默认值的两处数值修正(M1 实施裁决,已汇报待计划会话背书):
// 1. dt = 1/150(文档 1/120):1/120 时 c·dt/dx = 0.6375,超出 cflSafety=0.85
//    的断言余量 0.85/√2 ≈ 0.601 → 默认参数会被启动断言拒绝。1/150 时比率
//    0.51,余量充足;60fps 下约 2.5 亚步/帧,与「双亚步」设计意图一致。
// 2. 流动层驱动力用 g_flow = c²/H(派生)而非原始 g = 9.81:浅水的第二波族
//    速度为 √(g·H),g=9.81、H=0.05 时达 0.70 m/s——既是文档 c=0.3 的 2.3 倍
//    (视觉双重波系),又直接超 CFL。取 c²/H 使耦合系统的可见波速恰为文档
//    规定的 c,单一波系;空中液滴段(M2)仍用原始 gravity。
// ============================================================

export type WaterSimParams = {
  // ---- §5.1 全局与数值 ----
  /** 正方形域边长(米) */
  domainSize: number;
  /** 场分辨率 N×N(范围 128–384) */
  gridN: number;
  /** 固定步长(秒) */
  dt: number;
  /** 启动 CFL 断言余量:c·dt/dx ≤ cflSafety/√2(范围 0.5–0.95) */
  cflSafety: number;
  /** 帧率跌落时的单帧亚步上限(防螺旋死亡) */
  maxSubsteps: number;
  /** 边界模式:absorb=sponge 吸收带 / reflect=刚性反射 */
  boundaryMode: BoundaryModeAlias;
  /** 演示与初扰确定性种子 */
  seed: number;

  // ---- §5.2 波场与流动 ----
  /** 波速 c(m/s,范围 0.1–0.6;两条演化路径的可见波速均为 c) */
  waveSpeed: number;
  /** 波幅阻尼 λ(s⁻¹,范围 0.3–3;能量衰减 e^{−2λt},环纹存续约 2s) */
  waveDamping: number;
  /** 流动层等效水深 H(m,范围 0.02–0.2) */
  meanDepth: number;
  /** 流动层开关(u/v 与质量守恒回耦同开关,flowOn=false 退化为纯波动方程) */
  flowOn: boolean;
  /** 流速衰减 μf(s⁻¹,范围 0.2–2) */
  flowFriction: number;
  /** 流速扩散 ν(m²/s,范围 0–1e-3) */
  flowViscosity: number;
  /** 示踪点数(Flow 可见性,M4 接入) */
  tracerCount: number;
  /** sponge 吸收带宽度(格,范围 4–16) */
  spongeWidth: number;

  // ---- §5.3 液滴单体(M2 接入) ----
  /** 密度比 ρ_d/ρ_w(范围 0.3–0.95;≥1 即沉,钳制。裁决 §12.2-A′:0.60→0.38 增浮力——
   *  阿基米德 V_sub=ratio·V_R 同步给出「露出更多」与「凹陷变浅」两个效果) */
  densityRatio: number;
  /** 液滴最小半径(m) */
  rMin: number;
  /** 液滴最大半径(m) */
  rMax: number;
  /** 重力加速度(空中段,M2) */
  gravity: number;
  /** 水的动力黏度(Pa·s,M2 阻力) */
  waterMu: number;
  /** 水的密度 ρ_w(kg/m³;物理常量非调参,Stokes 阻力质量项 m=ρ_d·V_R 所需) */
  waterRho: number;
  /** 浸深一阶弛豫时间常数 τ_b(秒,范围 0.01–0.1) */
  relaxTau: number;
  /** 坡度力增益(波推液滴,范围 0–1.5) */
  slopeCoupling: number;
  /** 形状回复劲度 k_st(s⁻²,范围 10–120) */
  shapeStiffness: number;
  /** 形状阻尼 c_st(s⁻¹,范围 2–15) */
  shapeDamping: number;
  /** 最大压扁 ε_max(范围 0.2–0.5;y 向缩放 1−ε) */
  epsMax: number;

  // ---- §5.4 液滴间(M3 接入) ----
  /** 碰撞恢复系数 e(范围 0–0.8) */
  restitution: number;
  /** 毛细吸引强度 A(N,风格化放大,范围 0–2e-3) */
  capillaryA: number;
  /** 毛细作用距离(×(r₁+r₂),范围 1–4) */
  capillaryRange: number;
  /** 桥接触发间隙(×(r₁+r₂),范围 0.05–0.25)。⚠ 仅近接触窗口语义(pairs.ts:
   *  碰撞弹开抑制/聚合计时);网络模式的成桥本身距离无关(连接语义,调优第三批①修订) */
  bridgeRange: number;
  /** 排液延迟(秒,防瞬聚,范围 0.03–0.2) */
  drainTime: number;
  /** 聚合后冷却(秒,范围 0.1–0.5) */
  mergeCooldown: number;
  /** 液滴上限(超限拒收新滴,范围 8–64) */
  maxDroplets: number;
  /** 聚合开关(裁决 §12.2-C′:默认 false=稳定化液滴网络,液桥连接互不融合;
   *  演示/验收合并机制的场景显式置 true) */
  mergeEnabled: boolean;
  /** 接触线钉扎恢复劲度 k_pin(N/m,裁决 §12.2-C′;近似接触角滞后 pinning,0=关) */
  pinStrength: number;
  /** 钉扎松弛半径(m):离出生锚点该距离内自由漂移,超出受恢复力 */
  pinRadius: number;

  // ---- 漂移治理(调优第三批 #2,2026-09-07) ----
  /** 漂浮滴水平速度漂移阻尼(s⁻¹,风格化线性阻尼叠加在 Stokes 上;0=仅物理 Stokes)。
   *  物理 Stokes 对厘米级液滴仅 ~0.05 s⁻¹,波浪推动下液滴长时间乱漂不归位 */
  driftDamping: number;
  /** 落点回位弹簧劲度(s⁻²,朝出生锚点;0=关)。与 driftDamping 组成欠阻尼回弹,
   *  波停后液滴回到初始落点 */
  homeK: number;
  /** 牵连位移圈(米;拖拽期非被控液滴离出生锚点的硬上限):被桥牵连的液滴
   *  移动阻力极大,只能在此圈内被轻微拽动,桥随之拉伸而不断裂(第三批②修订) */
  dragAnchorShift: number;

  // ---- 液桥(任务①,2026-09-07;物理模型收官项) ----
  /** 桥张力劲度(N/m,双侧弹簧:拉伸回拉、压缩推开,持距于 restLen;
   *  拖拽期单侧出力——被拖端零阻力(手感同无桥),只牵拉对端) */
  bridgeTensionK: number;
  /** 桥张力轴向阻尼(N·s/m) */
  bridgeTensionC: number;
  /** 桥内流动系数(m²/s):Q = k·π·r_neck²·(1/r_a − 1/r_b),小滴 → 大滴 */
  bridgeFlowK: number;
  /** 成桥持距下限间隙(×(r₁+r₂)):restLen = max(成桥距, rSum·(1+此值))。
   *  连接语义(调优第三批①修订,委托方裁决:液桥=关系的边,重点是连接而非毛细作用):
   *  - 成桥距离无关:任意两漂浮滴都能成桥,远距对保持当前距离(连接而非收缩);
   *  - 靠得过近的对被双侧弹簧推开到此净间距(「液滴间距过小」的根治) */
  bridgeRestGap: number;

  // ---- 交互意图 API(任务②,2026-09-07;模块②意图的物理承接) ----
  /** 悬停升力:有效平衡浸深 ×(1−hoverLift·lift) */
  hoverLift: number;
  /** 悬停升力平滑时间常数(秒) */
  hoverLiftTau: number;
  /** 拖拽跟随劲度(s⁻²,速度导向指针) */
  dragFollow: number;
  /** 拖拽跟随阻尼(s⁻¹;ζ = dragDamp/(2·√dragFollow) ≈ 0.63) */
  dragDamp: number;
  /** 释放回弹劲度(s⁻²,欠阻尼缓慢弹回,ζ ≈ 0.45) */
  returnK: number;
  /** 释放回弹阻尼(s⁻¹) */
  returnC: number;
  /** 悬停水面涟漪注入周期(秒) */
  ripplePeriod: number;
  /** 悬停水面涟漪单次注入体积(m³;σ=15mm 时峰深 ~0.3mm) */
  rippleVolume: number;
  /** 悬停液滴波纹增强倍率(叠加在 Δ浸深耦合上) */
  hoverRippleGain: number;
  /** 焦点悬浮高度(m,液滴中心离水面) */
  levitateHeight: number;

  // ---- §5.5 耦合(M2 接入) ----
  /** 凹陷核宽度(×r,3σ 截断、归一化 ∫=−V_sub,范围 0.8–2) */
  kernelSigma: number;
  /** 入水冲量增益(∝r²·v,范围 0.3–2) */
  impulseGain: number;
  /** Δ浸深→源项增益(范围 0.3–2) */
  depthRateGain: number;
  /** 聚合脉冲幅度系数(范围 0.2–1) */
  mergeRipple: number;
  /** 单点单步源项钳制(m/步,防反馈发散) */
  couplingClamp: number;

  // ---- §5.6 演示场景(M4 接入) ----
  /** 定时落滴周期(秒) */
  rainInterval: number;
  /** 左缘波源幅值(m,1.2Hz,验证 Wave) */
  waveSourceAmp: number;
  /** 左缘波源频率(Hz;文档 §5.6 含义列) */
  waveSourceFreq: number;
  /** 落滴初高(m,入水 v≈1.7 m/s) */
  dropHeight: number;
  /** 初始漂浮滴数(近距摆放→必然演示毛细+聚合) */
  initialFloaters: number;
};

type BoundaryModeAlias = import("./types").BoundaryMode;

/** 默认参数(文档 §5;两处修正见文件头注) */
export const defaultParams: Readonly<WaterSimParams> = Object.freeze({
  domainSize: 1.0,
  gridN: 256,
  dt: 1 / 150,
  cflSafety: 0.85,
  maxSubsteps: 4,
  boundaryMode: "absorb",
  seed: 20260906,

  waveSpeed: 0.3,
  waveDamping: 1.2,
  meanDepth: 0.05,
  flowOn: true,
  flowFriction: 0.8,
  flowViscosity: 1e-4,
  tracerCount: 400,
  spongeWidth: 8,

  densityRatio: 0.38,
  rMin: 0.01,
  rMax: 0.028,
  gravity: 9.81,
  waterMu: 1e-3,
  waterRho: 1000,
  relaxTau: 0.03,
  slopeCoupling: 1.0,
  shapeStiffness: 40,
  shapeDamping: 6,
  epsMax: 0.35,

  restitution: 0.3,
  /** 裁决 §12.2-B′:4e-4→1.2e-4(吸引减弱,防链式合并) */
  capillaryA: 1.2e-4,
  /** 裁决 §12.2-B′:2.5→1.6(作用近距化) */
  capillaryRange: 1.6,
  bridgeRange: 0.12,
  drainTime: 0.08,
  mergeCooldown: 0.25,
  maxDroplets: 32,
  mergeEnabled: false,
  pinStrength: 6e-3,
  /** 调优第三批 #2:0.06→0.03(自由漂移区过大是「乱飘」主因之一;回位主力交给 homeK) */
  pinRadius: 0.03,

  /** 调优第三批 #2:漂移阻尼 + 落点回位弹簧(委托方验收反馈「乱飘/阻力低/不回落点」) */
  driftDamping: 2.5,
  homeK: 4,
  /** 牵连位移圈 5mm(第三批②修订):位置级硬约束,不受桥张力大小影响 */
  dragAnchorShift: 0.005,

  /** 第三批②修订:连接语义下桥拉伸不断裂(只有侵入治理断桥);软化张力使
   *  被拖端可自由拉伸、牵连端只被轻微拽动 */
  bridgeTensionK: 4,
  bridgeTensionC: 1,
  bridgeFlowK: 1.6e-5,
  /** 净间距 = 1.0·rSum(液滴半径同量级的清晰间隔;「液滴间距过小」的根治) */
  bridgeRestGap: 1.0,

  hoverLift: 0.78,
  hoverLiftTau: 0.3,
  dragFollow: 400,
  dragDamp: 25,
  returnK: 6,
  returnC: 2.2,
  ripplePeriod: 0.09,
  rippleVolume: 1.5e-6,
  hoverRippleGain: 6,
  levitateHeight: 0.08,

  /** 凹陷核宽度(×r,3σ 截断;默认 0.8 为验收整改裁决 B:深陡可见,范围下限,§10 预案) */
  kernelSigma: 0.8,
  impulseGain: 1.0,
  depthRateGain: 1.0,
  mergeRipple: 0.5,
  couplingClamp: 3e-3,

  rainInterval: 4.0,
  waveSourceAmp: 2e-3,
  waveSourceFreq: 1.2,
  dropHeight: 0.15,
  initialFloaters: 3,
});

// 范围表:[参数名, [min, max]];越界报错含参数名(灰模红字直接可读)
const RANGES: readonly (readonly [keyof WaterSimParams, number, number])[] = [
  ["domainSize", 0.1, 10],
  ["gridN", 128, 384],
  ["dt", 1 / 1000, 1 / 30],
  ["cflSafety", 0.5, 0.95],
  ["maxSubsteps", 1, 32],
  ["seed", 0, Number.MAX_SAFE_INTEGER],
  ["waveSpeed", 0.1, 0.6],
  ["waveDamping", 0.3, 3],
  ["meanDepth", 0.02, 0.2],
  ["flowFriction", 0.2, 2],
  ["flowViscosity", 0, 1e-3],
  ["tracerCount", 0, 1000],
  ["spongeWidth", 4, 16],
  ["densityRatio", 0.3, 0.95],
  ["rMin", 0.001, 0.1],
  ["rMax", 0.002, 0.2],
  ["gravity", 1, 30],
  ["waterMu", 1e-5, 1e-1],
  ["waterRho", 500, 2000],
  ["relaxTau", 0.01, 0.1],
  ["slopeCoupling", 0, 1.5],
  ["shapeStiffness", 10, 120],
  ["shapeDamping", 2, 15],
  ["epsMax", 0.2, 0.5],
  ["restitution", 0, 0.8],
  ["capillaryA", 0, 2e-3],
  ["capillaryRange", 1, 4],
  ["bridgeRange", 0.05, 0.25],
  ["drainTime", 0.03, 0.2],
  ["mergeCooldown", 0.1, 0.5],
  ["maxDroplets", 8, 64],
  ["pinStrength", 0, 0.1],
  ["pinRadius", 0.005, 0.5],
  ["driftDamping", 0, 10],
  ["homeK", 0, 30],
  ["dragAnchorShift", 0.001, 0.05],
  ["kernelSigma", 0.8, 2],
  ["impulseGain", 0.3, 2],
  ["depthRateGain", 0.3, 2],
  ["mergeRipple", 0.2, 1],
  ["couplingClamp", 1e-4, 1e-2],
  ["rainInterval", 0.5, 60],
  ["waveSourceAmp", 0, 0.02],
  ["waveSourceFreq", 0.1, 5],
  ["dropHeight", 0.01, 1],
  ["initialFloaters", 0, 16],
  ["bridgeTensionK", 0, 200],
  ["bridgeTensionC", 0, 40],
  ["bridgeFlowK", 0, 1e-3],
  ["bridgeRestGap", 0.05, 2],
  ["hoverLift", 0, 0.9],
  ["hoverLiftTau", 0.05, 1],
  ["dragFollow", 50, 2000],
  ["dragDamp", 1, 100],
  ["returnK", 1, 30],
  ["returnC", 0.3, 10],
  ["ripplePeriod", 0.03, 0.5],
  ["rippleVolume", 0, 1e-5],
  ["hoverRippleGain", 0, 20],
  ["levitateHeight", 0.01, 0.3],
];

/**
 * 启动校验:非有限值、范围越界、相对约束、CFL。
 * 违规 throw(消息含参数名,viewer 捕获后红字显示)。
 */
export function validateParams(p: WaterSimParams): void {
  for (const [key, min, max] of RANGES) {
    const v = p[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new RangeError(`参数 ${String(key)} 非有限数值: ${String(v)}`);
    }
    if (v < min || v > max) {
      throw new RangeError(
        `参数 ${String(key)} = ${v} 超出允许范围 [${min}, ${max}]`,
      );
    }
  }
  if (p.boundaryMode !== "absorb" && p.boundaryMode !== "reflect") {
    throw new RangeError(
      `参数 boundaryMode = "${String(p.boundaryMode)}" 只允许 absorb/reflect`,
    );
  }
  if (p.rMin >= p.rMax) {
    throw new RangeError(`参数 rMin = ${p.rMin} 必须小于 rMax = ${p.rMax}`);
  }
  const dx = p.domainSize / (p.gridN - 1);
  const cfl = (p.waveSpeed * p.dt) / dx;
  const limit = p.cflSafety / Math.SQRT2;
  if (cfl > limit) {
    throw new RangeError(
      `CFL 违规:c·dt/dx = ${cfl.toFixed(4)} > cflSafety/√2 = ${limit.toFixed(4)}` +
        `(c=${p.waveSpeed}, dt=${p.dt.toFixed(6)}, dx=${dx.toFixed(6)});` +
        `请减小 dt 或 c,或增大 cflSafety 允许的余量`,
    );
  }
}
