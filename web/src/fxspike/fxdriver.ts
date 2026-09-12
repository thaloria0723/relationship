// ============================================================
// B 组效果验证 · 效果驱动(three-free,纯逻辑,可单测)
//
// 九效果(动效文档 §三/§四 + §2.3 聚焦灰滴 + §5 大转折):
//   1 融合   双向缓慢流动 + 微气泡(≤8/桥)
//   2 拉扯   颈径屏幕空间下限 + 向背景色收敛(不压暗) + Rayleigh–Plateau 珠化
//   3 对撞   两端亮斑相向急进 → 中心融合 → 消散冒泡(循环;原「湍流」已按裁决作废)
//   4 暗流   单向快速冲刷(速度符号同向)
//   5 潜流   指针靠近才搅动浮现(快进慢出)
//   6 凝结   起雾 → 聚拢 → 凝结成滴 → 抽桥
//   7 死亡   沸腾 → 汽化上飘 → 抖动溶解 → 残留雾
//   9 大转折 汇聚(旧滴溃散成光点 → 光点漩涡向心 → 凝聚成巨滴「从无到有」)
//            → 过渡(巨滴凝滞悬停+雾裹+压暗) → 迸发(爆散闪光+火花飞射-减速-悬停-牵引)
//            → 定格(新滴物质化+新桥生长)
//            委托方 2026-09-12 整改:汇聚段由「螺旋滑入」改为「溃散成光点→漩涡凝聚」;
//            爆散之后**逐参数不变**(R4)。
//
// 时间源:由物理 simTime 驱动(引擎是唯一时间源,不允许第二时钟)。
// ============================================================

/** 效果名(索引 = 模式号;0 = 关) */
export const FX_NAMES = [
  "关",
  "融合",
  "拉扯",
  "对撞",
  "暗流",
  "潜流",
  "凝结",
  "死亡",
  "聚焦",
  "大转折",
] as const;

/** 最大模式号 */
export const FX_MAX = 9;

// ---- 逐滴角色(验证页按场景表把液滴索引映射成角色;驱动只认角色) ----
/** 普通在场滴(有动态关系表达) */
export const ROLE_NORMAL = 0;
/** 演出主角(凝结的新滴 / 死亡的将死滴) */
export const ROLE_HERO = 1;
/** 在场的聚焦邻居 */
export const ROLE_PRESENT = 2;
/** 未在场灰滴:role = ROLE_ABSENT + 出场次序(0 起) */
export const ROLE_ABSENT = 3;
/**
 * 大转折(mode 9)角色。⚠ 编码必须 ≥ 4 且 mode 9 不与聚焦混用:
 * 上面 `role ≥ ROLE_ABSENT` 的灰滴判定只允许在 mode 8 生效(见 main.ts 的
 * isAbsentRole —— 大转折角色若落进灰滴区间,会被误抑制新章液桥)。
 */
/** 旧章普通滴(汇聚段螺旋滑入中心、缩尺被吞并) */
export const ROLE_T_OLD = 4;
/** 旧章核心滴(长成巨滴 → 爆散闪光) */
export const ROLE_T_CORE = 5;
/** 新章滴(槽位物质化):role = ROLE_T_NEW + 就位次序(0 起) */
export const ROLE_T_NEW = 6;

/**
 * 每桥状态 → 逐顶点属性 aState (vec4)。
 * 无状态分支:五状态用连续参数表达,切换靠平滑过渡(硬分支会「啪」地跳变)。
 *
 * - `flow`   流动强度:>0 双向往复(融合);<0 单向冲刷(暗流)
 * - `bubble` 气泡/光点量(融合 = 微气泡;暗流 = 密排短亮条)
 * - `turb`   湍流边缘侵蚀强度
 * - `state`  状态量:潜流 = 揭示度(0..1);拉扯 = 向背景收敛度(0..1);其余 = 0
 */
export interface BridgeFx {
  flow: number;
  bubble: number;
  turb: number;
  state: number;
}

/** 每滴状态 → 逐实例属性 aFx (vec3) + CPU 侧渲染变换 */
export interface DropletFx {
  /** 顶点沸腾强度 0..1(只动顶点与 rim,不动透明度) */
  boil: number;
  /** 抖动溶解进度 0..1(hashed discard;不写深度 → 不留洞) */
  dissolve: number;
  /** 渲染缩放系数(乘到 instanceMatrix;凝结 0→1,死亡 1→0.35) */
  scale: number;
  /** 浮升(米;正 = 汽化上飘,负 = 沉在水面之下) */
  lift: number;
  /** 凝结闪点强度 0..1(HDR,shader 内钳制) */
  flash: number;
  /** 未在场灰滴度 0..1(聚焦:已退场/未出场) */
  absent: number;
}

/** 一团雾(池化 billboard;凝结的起雾 / 死亡的残雾) */
export interface FogCue {
  /** 出现度 0..1 */
  appear: number;
  /** 团半径(米) */
  radius: number;
  /** 雾团中心(世界 xz,已含聚拢位移) */
  x: number;
  y: number;
}

/** 无效果的默认值(共享常量,避免每帧分配) */
const NO_BRIDGE: Readonly<BridgeFx> = Object.freeze({
  flow: 0,
  bubble: 0,
  turb: 0,
  state: 0,
});
const NO_DROPLET: Readonly<DropletFx> = Object.freeze({
  boil: 0,
  dissolve: 0,
  scale: 1,
  lift: 0,
  flash: 0,
  absent: 0,
});
const NO_FOG: Readonly<FogCue> = Object.freeze({
  appear: 0,
  radius: 0,
  x: 0,
  y: 0,
});

/** 凝结时间线(秒):起雾 → 聚拢 → 凝结 → 抽桥 */
export const CONDENSE = {
  fogIn: [0.0, 0.7],
  converge: [0.7, 1.2],
  form: [1.2, 1.5],
  grow: [1.5, 2.4],
} as const;

/** 死亡时间线(秒):沸腾 → 汽化 → 溶解 → 残雾 */
export const DEATH = {
  boil: [0.0, 1.1],
  vapor: [1.0, 1.9],
  dissolve: [1.9, 2.35],
  growBack: [1.0, 2.0],
} as const;

/**
 * 对撞时间线(秒):两端起斑 → 相向急进 → 中心融合 → 消散冒泡。
 *
 * B 组第二轮(2026-09-11)委托方裁决:原「湍流」的三项(液桥极粗 / 边界水花飞溅 /
 * 两滴高频颤动)**全部作废**,改为「液桥两端同时产生亮斑,快速向中心移动,两斑
 * 接触后融合,逐渐消失并产生气泡,模拟对撞」。故这里换成一条时间线。
 */
export const CLASH = {
  /** 亮斑在两端亮起 */
  born: [0.0, 0.22],
  /** 相向急进:head 从 0.86(两端)推进到 0.5(中心) */
  charge: [0.22, 0.90],
  /** 两斑重合于中心(最亮的一瞬) */
  merge: [0.90, 1.25],
  /**
   * 周期长度(秒)。取 `merge[1]` —— 委托方 2026-09-11:「液桥两端**持续**产生亮斑向
   * 中间移动,上一轮亮斑融合后下一轮亮斑开始」。故对撞是**循环**效果:t 不封顶,
   * 相位取 `t mod period`;上一轮刚在中心融合,下一轮的两端亮斑就已经亮起。
   */
  period: 1.25,
  /** 融合斑的余晖衰减时长(跨进下一轮里衰减 —— 读作连续对撞而非一次性演出) */
  afterglow: 0.85,
} as const;

/**
 * 聚焦(未在场灰滴)时间线 —— 动效 §2.3 注意段:
 * 「进入聚焦模式后**数秒,渐次**从水底浮现」;「所有灰色水滴**无动态关系表达**」
 * (故它们不出桥,那由验证页抑制,不在驱动里)。
 */
export const FOCUS = {
  /** 首颗灰滴的起始延时(秒) */
  start: 0.8,
  /** 相邻两颗之间错开(「渐次」) */
  stagger: 0.85,
  /** 单颗从水底浮到位的时长 */
  rise: 1.25,
  /** 全部到位后的停留段(取帧/观看用) */
  hold: 1.6,
} as const;

/** 灰滴起浮深度(米;负 = 水面之下)。域边长 1.0、滴径约 0.04 → 0.09 已两个多滴高 */
export const ABSENT_DEPTH = 0.09;

/**
 * 大转折时间线(秒)—— 动效 §5「大转折」三阶段 / 规格 §8.3,总长 3.30s
 * (规格给 ≈2.5-3.5s;节奏按 motionsites 口径「蓄力-冲击-悬停-归位」)。
 *
 * **委托方 2026-09-12 整改(汇聚段重做)**:旧滴不再「螺旋滑入被吞并」,改为
 * 「**液滴全部溃散成光点**(与爆散火花同款)→ 光点**漩涡向心汇聚** →
 * **凝聚成大液滴**(光点凝成、从无到有)→ 大液滴**凝滞一瞬** → 炸裂」;
 * **炸裂之后的动画逐参数不变**(R4)。
 *
 *   预兆 0→0.40     旧桥卷曲缠绕 + 卷入收缩(卷没必须早于第一次引擎删滴);
 *   溃散 0.16→0.63  7 滴按索引错峰 hashed-discard 溶解消失(核心滴压轴),
 *                  各自的光点从滴盘面起飞(颗数 ∝ 滴半径);
 *   漩涡 0.21→1.18  光点极坐标内旋:半径 easeInCubic 收缩、角度 p^1.7 加速
 *                  (差分自转 ω ∝ 1/r,即「漩涡」而不是直线收拢);
 *   凝聚 0.63→1.30  巨滴 dissolve 1→0 物质化,**尺度恒 4.2**(从无到有,不做生长),
 *                  与光点抵达窗(0.98-1.18)重叠 —— 光点飞入巨滴即被吸收;
 *   凝滞 1.30→1.75  巨滴微呼吸 + 微升 + 雾裹 + 压暗(与整改前一致);
 *   爆散/牵引/定格  与整改前**逐参数一致**(flash 峰值 + 缩零 + 48 颗火花…)。
 */
export const TRANSITION = {
  converge: [0.0, 1.05],
  merge: [1.05, 1.75],
  burst: [1.75, 2.05],
  attract: [2.05, 2.85],
  settle: [2.85, 3.3],
  /** 炸裂:首滴起始 / 相邻错峰 / 单滴炸开时长(秒;「炸」要快 —— 0.14s) */
  shatterT0: 0.16,
  shatterStagger: 0.045,
  shatterDur: 0.14,
  /** 旧桥必须全部卷没的时刻(早于第一次引擎删滴 = 0.16+0.14+0.06) */
  shatterClear: 0.36,
  /** 引擎删滴余量:溃散结束 + 本值(先让溶解彻底完成,再摘掉水底软影) */
  removeMargin: 0.06,
  /** 巨滴物质化窗口(从无到有;实起点取 max(本值, 核心滴溃散末)) */
  giantForm: [0.63, 1.3],
  /** 光点:出现淡入时长(**快闪 = 「炸」**)/ 抵达窗口(错峰;窗口越宽,同一时刻
   *  的半径分层越明显 —— 静帧里才读得出**螺旋**而不是一圈珠子)/ 抵达前融入窗 */
  pointIn: 0.035,
  pointArrive: [0.92, 1.22],
  pointVeil: [0.72, 1.0],
  /** 光点三段进程(占各自飞行窗的比例):[0, a] 炸开分散 → [a, b] **凝滞一瞬**
   *  (局部炸开量保持、漩涡未启动)→ [b, 1] 漩涡吸入。
   *  实测口径:飞行 ≈0.7–0.9s → 凝滞 ≈0.2s(「一瞬」)。 */
  pointHold: [0.2, 0.46],
  /** 爆散缩尺时长(巨滴 scale→0) */
  burstShrink: 0.16,
  /** 火花:飞射减速段 / 悬停段时长 */
  sparkFly: 0.34,
  sparkHover: 0.3,
  /** 火花归位消隐时长(与新滴物质化重叠,交接无缝) */
  sparkFade: 0.18,
  duration: 3.3,
} as const;

/** 大转折的引擎域中心(域边长 1.0,布点坐标即 [0,1]) */
export const DOMAIN_CENTER = 0.5;
/** 巨滴目标尺度(×核心滴 r≈0.022 → 有效半径 ≈0.092,画面里约 1/5 域宽) */
const CORE_GIANT_SCALE = 4.2;
/** 火花池容量(渲染侧 InstancedMesh 同值;「无数小水珠」的量级下限) */
export const SPARK_COUNT = 48;
/**
 * 光点池容量(渲染侧 InstancedMesh **同值**,`viewer.ts` 的 SPARK_MAX)。
 * 汇聚段炸裂出来的光点与爆散段飞射的光点**共用这一个池、同一材质**
 * ——「和大液滴爆发时溅射出来的光点一样」(委托方原文)在像素级成立。
 * 体积变小后以此为密度补偿(96→160);爆散段仍只用前 SPARK_COUNT 槽。
 */
export const POINT_POOL = 160;
/** 火花飞射最大半径(引擎域米;过冲到槽位半径之外,再被牵引拉回) */
export const SPARK_R_MAX = 0.3;

/** 一颗火花的渲染状态(x/y 引擎域坐标,h = 水面之上高度,米) */
export interface SparkState {
  x: number;
  y: number;
  /** 水面之上的高度(米) */
  h: number;
  /** 火花半径(米) */
  r: number;
  /** 出现度 0..1 */
  a: number;
}

/** 确定性 hash(火花每颗的方位/半径/相位;不引 PRNG 状态,任意调用序可复现) */
const hash01 = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const easeInCubic = (u: number): number => {
  const v = clamp01(u);
  return v * v * v;
};
const easeOutCubic = (u: number): number => {
  const v = clamp01(u);
  return 1 - (1 - v) ** 3;
};
const easeInOutCubic = (u: number): number => {
  const v = clamp01(u);
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
};

/**
 * 大转折汇聚段的「源」:旧章一颗滴(引擎域坐标 + 半径)。
 * `core: true` = 压轴那颗(溃散最后,随后物质化为巨滴)。
 */
export interface TransSource {
  x: number;
  y: number;
  r: number;
  core?: boolean;
}

/**
 * 光点颗数按源半径分配(纯函数,可单测):`n_s ∝ r_s`,每源保底 1 颗,
 * 余数按小数部分从大到小补满 `pool`(半径最大的核心滴自然分到最多)。
 * 约束:源数 ≤ pool(验证页布局 7 源,远小于池容量)。
 */
export function allocatePoints(radii: readonly number[], pool: number): number[] {
  const n = radii.length;
  if (n === 0) return [];
  const w = radii.map((r) => Math.max(r, 1e-9));
  const sum = w.reduce((a, b) => a + b, 0);
  const exact = w.map((x) => (pool * x) / sum);
  const out = exact.map((x) => Math.max(1, Math.floor(x)));
  let used = out.reduce((a, b) => a + b, 0);
  const byFrac = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; used < pool && k < pool * 2; k++, used++) out[byFrac[k % n]!.i]! += 1;
  return out;
}

/**
 * 第 `index` 个源滴的溃散起始时刻(秒)。环滴按**索引降序**错峰 —— 引擎删滴
 * 只能从最高索引往低(交换删除会搬动末位),演出顺序与删除顺序对齐;
 * 核心滴**压轴**:它的溃散末即巨滴物质化起点,中间没有可见的「空核」窗。
 */
export function shatterStartOf(index: number, sources: readonly TransSource[]): number {
  const ring: number[] = [];
  for (let i = 0; i < sources.length; i++) if (sources[i]!.core !== true) ring.push(i);
  const pos = ring.indexOf(index);
  if (pos >= 0) {
    return TRANSITION.shatterT0 + TRANSITION.shatterStagger * (ring.length - 1 - pos);
  }
  return TRANSITION.shatterT0 + TRANSITION.shatterStagger * ring.length;
}

/**
 * 光点计划步长:srcIdx, t0, t1, dθ, dr, hBase, hArc, rad0, burstK, wanderPh,
 * burstAng。(逐点预计算,全部来自 hash01;运行期只做算术,不做随机)
 */
const POINT_STRIDE = 11;
/** 光点旋臂总扭转角(弧度):角速度随半径减小而增大 —— 「漩涡」的读感来源 */
const POINT_TWIST = 3.4;
/** 角度加速指数(>1 = 后半程转得快;与半径的 easeInCubic 收缩配对) */
const POINT_SPIN_EXP = 1.7;
/**
 * **炸裂**(委托方 2026-09-12 关键词,二次整改:要**分散到原液滴四周**):
 * 起飞瞬间光点从**滴心沿各自方向**(burstAng,绕滴均匀铺开)炸开到
 * `POINT_BURST_R × 个体量`(≈1–4 倍滴径),到峰值后**凝滞一瞬**
 * (见 TRANSITION.pointHold),再被漩涡接管(位移收回 + 螺旋向心)。
 * 位移是「相对源滴」的局部量,不改变漩涡路径本身。
 */
const POINT_BURST_R = 0.032;
/** 凝滞期微颤(米):「时空静止」不是死帧(同爆散段悬停的口径) */
const POINT_HOLD_JIT = 0.0008;
/** 悬浮(米):基础离水高度区间 + 飞行中段抬升 —— 「易悬浮」 */
const POINT_H_BASE_MIN = 0.008;
const POINT_H_BASE_SPAN = 0.008;
const POINT_H_ARC = 0.01;
/** 飘散游移(米 / 角频率):中段最大、两端归零的横向摆动 —— 「易飘散」 */
const POINT_WANDER = 0.0035;
const POINT_WANDER_W = 2.6;
/** 光点半径(米):「纯粹的光点,体积小」—— 约为滴径的 1/3 */
const POINT_R_MIN = 0.004;
const POINT_R_SPAN = 0.003;

/**
 * 火花状态机(纯函数;确定性 —— 全部随机量来自 hash01(i))。
 *
 * 四拍(§8.3 迸发段原文:飞射 → 空中减速、悬停 → 被无形的线牵引 → 定格):
 *   飞射  t ∈ [burst0, burst0+fly]      径向 easeOutCubic 冲到 SPARK_R_MAX(减速感);
 *   悬停  +sparkHover                   停在过冲点,微幅颤动(时空静止);
 *   牵引  → attract[1]                  easeInOutCubic 飞向所属新章槽位,高度回落;
 *   消隐  +sparkFade                    alpha→0,与该槽位真滴的物质化重叠交接。
 * 目标槽位 = slots[i % slots.length](48 颗火花对 6 个槽位 = 每槽 8 颗汇聚)。
 */
export function sparkState(
  t: number,
  i: number,
  slots: readonly { x: number; y: number }[],
): SparkState {
  const t0 = TRANSITION.burst[0];
  const h01 = hash01(i * 2 + 1);
  const h02 = hash01(i * 2 + 2);
  const h03 = hash01(i * 7 + 3);
  // 所属槽位与过冲点(方位朝槽位方向 + 个体散布,读作「炸开」而不是「分列」)
  const slot = slots.length > 0 ? slots[i % slots.length]! : { x: DOMAIN_CENTER, y: DOMAIN_CENTER };
  const dirX = slot.x - DOMAIN_CENTER;
  const dirY = slot.y - DOMAIN_CENTER;
  const dirLen = Math.hypot(dirX, dirY) || 1;
  const baseAng = Math.atan2(dirY, dirX);
  const ang = baseAng + (h01 - 0.5) * 2.6;
  const rMax = SPARK_R_MAX * (0.55 + 0.9 * h02);
  const hoverX = DOMAIN_CENTER + Math.cos(ang) * rMax;
  const hoverY = DOMAIN_CENTER + Math.sin(ang) * rMax;
  // 三段位置(飞射减速 → 悬停 → 牵引;牵引从悬停段结束后起算)。
  // 飞射时长按颗错开(±20%):不然 48 颗同步走 → 读成一个规整圆环,不是炸裂。
  const fly = TRANSITION.sparkFly * (0.85 + 0.3 * h03);
  const p1 = easeOutCubic(span01(t, t0, t0 + fly));
  const p2 = span01(t, t0 + fly, t0 + fly + TRANSITION.sparkHover);
  const p3 = easeInOutCubic(
    span01(t, t0 + fly + TRANSITION.sparkHover, TRANSITION.attract[1]),
  );
  const inX = DOMAIN_CENTER + Math.cos(ang) * rMax * p1;
  const inY = DOMAIN_CENTER + Math.sin(ang) * rMax * p1;
  const pullX = hoverX + (slot.x - hoverX) * p3;
  const pullY = hoverY + (slot.y - hoverY) * p3;
  // 悬停微颤(时空静止不是死帧;颤幅 ≈ 半个滴径的 1/6)
  const jit = p2 > 0 && p2 < 1 ? 0.0012 : 0;
  const jx = jit * Math.sin(t * 47 + h03 * 6.28);
  const jy = jit * Math.cos(t * 41 + h01 * 6.28);
  const p4 = span01(t, TRANSITION.attract[1], TRANSITION.attract[1] + TRANSITION.sparkFade);
  // 高度:冲天 → 悬停 → 随牵引落回水面(与真滴物质化交接)
  const h = 0.052 * p1 * (1 - p3);
  return {
    x: (p3 > 0 ? pullX : inX) + jx,
    y: (p3 > 0 ? pullY : inY) + jy,
    h,
    // 光点半径:与汇聚段同物种(纯光点),从碎块收到更细的小点
    r: 0.009 - 0.004 * Math.max(p1, p3),
    a: Math.min(span01(t, t0, t0 + 0.06), 1 - p4),
  };
}

/** 潜流揭示的指针距离阈值(米):≤NEAR 全显,≥FAR 全隐 */
const REVEAL_NEAR = 0.06;
const FAR = 0.16;

/** 揭示快进慢出的时间常数(s⁻¹) */
const REVEAL_IN_K = 4.0;
const REVEAL_OUT_K = 0.5;

const clamp01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u);
/** clamp 到 [0,1] 后 smoothstep */
export const smooth01 = (u: number): number => {
  const v = clamp01(u);
  return v * v * (3 - 2 * v);
};
/** 区间归一化:区间内 0→1,区间外钳制 */
export const span01 = (t: number, a: number, b: number): number =>
  clamp01((t - a) / Math.max(b - a, 1e-6));

/** 指针距离 → 潜流揭示目标值(0..1) */
export function revealTarget(dist: number): number {
  return 1 - span01(dist, REVEAL_NEAR, FAR);
}

/** 聚焦总时长:`n` 颗灰滴渐次出完 + 停留段 */
export function focusDuration(n: number): number {
  const k = Math.max(0, n - 1);
  return FOCUS.start + k * FOCUS.stagger + FOCUS.rise + FOCUS.hold;
}

/** 第 `order` 颗灰滴的浮现进度 0..1(0 = 还在水底,1 = 已就位) */
export function absentRise(t: number, order: number): number {
  const t0 = FOCUS.start + order * FOCUS.stagger;
  return smooth01(span01(t, t0, t0 + FOCUS.rise));
}

/**
 * 效果驱动器:每帧喂入 dt 与指针-桥距离,产出逐桥/逐滴/雾团的参数。
 * 全部状态显式持有,`reset(mode)` 可重播 —— 无隐藏控制流,可单测。
 */
export class FxDriver {
  mode = 0;
  /** 效果本地时间(秒) */
  t = 0;
  /** 潜流揭示度(状态量:快进慢出) */
  reveal = 0;
  /** 取帧模式:播到 `t` 后不再推进(截图用) */
  frozen = false;
  /** 大转折的新章槽位布局(宿主在 reset(9) 时喂入;spark/物质化错峰用) */
  private transitionSlots: { x: number; y: number }[] = [];
  /** 大转折的旧章「源」布局(宿主喂入;溃散排期与光点起飞点同源) */
  private transitionSources: TransSource[] = [];
  /** 光点预计算计划(步长 POINT_STRIDE;pointCount = 实际颗数,≤ POINT_POOL) */
  private pointPlan: number[] = [];
  private pointCount = 0;
  /**
   * 源滴实时引擎位(每帧由 `dropletFx` 刷新;viewer 的同步顺序保证 syncDroplets
   * 先于 syncSparks)。液滴会随波微漂,光点必须从**滴体当前所在**起飞;
   * 源滴被删后缓存保留最后值(其光点此刻早已在飞)。
   */
  private liveX: number[] = [];
  private liveY: number[] = [];

  reset(mode: number): void {
    this.mode = mode;
    this.t = 0;
    this.reveal = 0;
    this.frozen = false;
    if (mode !== 9) {
      this.transitionSlots = [];
      this.transitionSources = [];
      this.pointPlan = [];
      this.pointCount = 0;
      this.liveX = [];
      this.liveY = [];
    }
  }

  /** 大转折:注入新章槽位布局(引擎域坐标;与新滴 spawn 槽位同源) */
  setTransitionSlots(slots: readonly { x: number; y: number }[]): void {
    this.transitionSlots = [...slots];
  }

  /**
   * 大转折:注入旧章「源」布局(索引 = 液滴索引 = 生成次序)。光点起飞点与
   * 溃散排期都从这里来;同时重建光点计划(分配/方位/排期全部确定性)。
   */
  setTransitionSources(sources: readonly TransSource[]): void {
    this.transitionSources = sources.map((s) => ({ ...s }));
    this.liveX = [];
    this.liveY = [];
    this.buildPointPlan();
  }

  /** 第 `index` 个源滴的溃散起始(秒;索引 = 源序号) */
  transShatterStart(index: number): number {
    return shatterStartOf(index, this.transitionSources);
  }
  /** 溃散结束(渲染上已溶解干净) */
  transShatterEnd(index: number): number {
    return this.transShatterStart(index) + TRANSITION.shatterDur;
  }
  /** 引擎删滴阈值(溃散末 + 余量):此刻溶解已彻底,水底软影随删随消 */
  transRemoveAt(index: number): number {
    return this.transShatterEnd(index) + TRANSITION.removeMargin;
  }
  /** 巨滴物质化起点 = max(常量, 核心滴溃散末):任何布局下都没有可见空核窗 */
  private giantFormStart(): number {
    let start: number = TRANSITION.giantForm[0];
    for (let i = 0; i < this.transitionSources.length; i++) {
      if (this.transitionSources[i]!.core === true) start = this.transShatterEnd(i);
    }
    return Math.max(TRANSITION.giantForm[0], start);
  }

  /** 重建光点计划(随机量全部来自 hash01(全局序号) → 任意调用序可复现) */
  private buildPointPlan(): void {
    const plan: number[] = [];
    const srcs = this.transitionSources;
    if (srcs.length > 0) {
      const counts = allocatePoints(
        srcs.map((s) => s.r),
        POINT_POOL,
      );
      const [a0, a1] = TRANSITION.pointArrive;
      for (let s = 0; s < srcs.length; s++) {
        const src = srcs[s]!;
        const n = counts[s] ?? 0;
        const t0Base = this.transShatterStart(s) + 0.05;
        // 源在域中心(核心滴)时方位无定义 → 角度按整圆铺开,不然所有点挤在一侧
        const atC = Math.hypot(src.x - DOMAIN_CENTER, src.y - DOMAIN_CENTER) < 1e-6;
        const spread = atC ? Math.PI * 2 : 0.7;
        for (let k = 0; k < n; k++) {
          const g = s * 211 + k; // 全局序号:与池槽位无关地确定每颗的相位
          const h1 = hash01(g * 6 + 1);
          const h2 = hash01(g * 6 + 2);
          const h3 = hash01(g * 6 + 3);
          const h4 = hash01(g * 6 + 4);
          const h5 = hash01(g * 6 + 5);
          const h6 = hash01(g * 6 + 6);
          plan.push(
            s,
            t0Base + 0.04 * h1, // t0:随源滴炸开错峰喷出(喷出窗 0.04s = 齐)
            a1 - (a1 - a0) * h2, // t1:错峰抵达(见 TRANSITION.pointArrive)
            (h3 - 0.5) * spread, // dθ:绕源方位散布(按源分旋臂,臂有宽度)
            (h4 - 0.5) * 1.8, // dr:×源半径,在滴盘面内散布
            POINT_H_BASE_MIN + POINT_H_BASE_SPAN * h5, // 悬浮基高(离水)
            POINT_H_ARC * hash01(g * 6 + 7), // 中段抬升
            POINT_R_MIN + POINT_R_SPAN * h6, // 光点半径(体积小)
            0.6 + 0.8 * hash01(g * 6 + 8), // burstK:炸裂外冲的个体量
            hash01(g * 6 + 9) * Math.PI * 2, // 飘散游移相位
            hash01(g * 6 + 10) * Math.PI * 2, // burstAng:炸开方向(绕滴心均匀 = 四周)
          );
        }
      }
    }
    this.pointPlan = plan;
    this.pointCount = plan.length / POINT_STRIDE;
  }

  /**
   * 第 `i` 颗光点的汇聚状态(纯读;t < 爆散点)。三段(委托方 2026-09-12 二次整改):
   *   **炸裂** 起飞瞬间从**滴心沿各自方向**炸开到 `POINT_BURST_R×个体量`
   *            (方向逐点均匀 → **分散到原液滴四周**,不是被推离域心);
   *   **凝滞** `[pointHold[0], pointHold[1]]` 进程窗内:炸开位移保持、漩涡未启动
   *            —— 「炸裂后有一瞬间的凝滞」(仅微颤,不是死帧);
   *   **漩涡** 之后位移收回、半径 r0·(1−easeInCubic(inp)) 收缩、角度
   *            θ0 + TWIST·inp^1.7 加速(差分自转);
   *   **悬浮飘散** h 全程离水(基高 + 中段抬升);横向游移两端归零、中段最大。
   * 源方位/距离取**实时引擎位**(液滴随波微漂,光点从滴体起飞);抵达前
   * (pointVeil)出现度归零 —— 光点飞入巨滴即被吸收,与物质化窗口重叠。
   */
  private convergePoint(i: number): SparkState | null {
    if (i < 0 || i >= this.pointCount) return null;
    const k = i * POINT_STRIDE;
    const s = this.pointPlan[k]!;
    const t0 = this.pointPlan[k + 1]!;
    const t1 = this.pointPlan[k + 2]!;
    const p = span01(this.t, t0, t1);
    if (p <= 0) return null;
    const src = this.transitionSources[s]!;
    const sx = this.liveX[s] ?? src.x;
    const sy = this.liveY[s] ?? src.y;
    const vx = sx - DOMAIN_CENTER;
    const vy = sy - DOMAIN_CENTER;
    const dist = Math.hypot(vx, vy);
    const phi = dist > 1e-6 ? Math.atan2(vy, vx) : 0;
    const th0 = phi + this.pointPlan[k + 3]!;
    const r0 = dist + this.pointPlan[k + 4]! * src.r;
    const bang = this.pointPlan[k + 10]!; // 炸开方向(绕滴心均匀)
    // 炸裂 → 凝滞 → 收回(局部位移,相对源滴;不改变漩涡路径)
    const [hIn, hOut] = TRANSITION.pointHold;
    const out = easeOutCubic(span01(p, 0, hIn));
    const back = easeInCubic(span01(p, hOut, 1));
    const local = POINT_BURST_R * this.pointPlan[k + 8]! * (out - back);
    // 漩涡:凝滞窗内不启动(inp 从 hOut 起算)
    const inp = span01(p, hOut, 1);
    const th = th0 + POINT_TWIST * Math.pow(inp, POINT_SPIN_EXP);
    const r = r0 * (1 - easeInCubic(inp));
    // 凝滞期微颤(时空静止不是死帧;同爆散段悬停的口径)
    const hold = out > 0.99 && back <= 0 ? POINT_HOLD_JIT : 0;
    const jx = hold * Math.sin(this.t * 39 + bang * 3.1);
    const jy = hold * Math.cos(this.t * 43 + bang * 2.3);
    // 悬浮飘散:中段最大、两端归零的横向游移(确定性相位;读「飘」不读「导航」)
    const drive = POINT_WANDER * Math.sin(Math.PI * p);
    const ph = this.pointPlan[k + 9]!;
    const wx = drive * Math.sin(this.t * POINT_WANDER_W + ph);
    const wy = drive * Math.cos(this.t * POINT_WANDER_W * 1.31 + ph * 1.7);
    return {
      x: DOMAIN_CENTER + Math.cos(th) * r + Math.cos(bang) * local + jx + wx,
      y: DOMAIN_CENTER + Math.sin(th) * r + Math.sin(bang) * local + jy + wy,
      h: this.pointPlan[k + 5]! + this.pointPlan[k + 6]! * Math.sin(Math.PI * p),
      r: this.pointPlan[k + 7]! * (1 - 0.45 * p),
      a: Math.min(
        span01(this.t, t0, t0 + TRANSITION.pointIn),
        1 - span01(p, TRANSITION.pointVeil[0], TRANSITION.pointVeil[1]),
      ),
    };
  }

  /** 当前模式是否需要时间推进(静场效果不需要) */
  get animated(): boolean {
    return this.mode === 6 || this.mode === 7 || this.mode === 8 || this.mode === 9;
  }

  /** 当前模式总时长(秒;静场/循环效果返回 0 = 不封顶) */
  get duration(): number {
    // 3 对撞是**循环**效果:t 不封顶,相位自己取模(见 CLASH.period)
    if (this.mode === 6) return CONDENSE.grow[1];
    if (this.mode === 7) return DEATH.dissolve[1] + 1.2;
    if (this.mode === 8) {
      // 3 颗灰滴的默认排期;验证页按实际颗数可覆盖(见 focusDuration)
      return focusDuration(3);
    }
    if (this.mode === 9) return TRANSITION.duration;
    return 0;
  }

  /** 推进一帧。`dt` 秒;`pointerDist` 为指针到桥轴的最近距离(米)。 */
  update(dt: number, pointerDist: number): void {
    if (this.frozen) return;
    if (this.animated) {
      this.t = Math.min(this.t + dt, this.duration);
    } else {
      this.t += dt; // 静场效果:t 只驱动流动相位
    }
    // 潜流揭示:进入快、退出慢(「被搅动后慢慢沉淀」)
    const target = this.mode === 5 ? revealTarget(pointerDist) : 0;
    if (target !== this.reveal) {
      const k = target > this.reveal ? REVEAL_IN_K : REVEAL_OUT_K;
      this.reveal += (target - this.reveal) * (1 - Math.exp(-k * dt));
      if (Math.abs(target - this.reveal) < 1e-4) this.reveal = target;
    }
  }

  /** 效果族:0=无 1=流动/气泡(融合·暗流) 2=黯淡(拉扯) 3=湍流 4=潜流 */
  bridgeKind(): number {
    switch (this.mode) {
      case 1:
      case 4:
        return 1;
      case 2:
        return 2;
      case 3:
        return 3;
      case 5:
        return 4;
      default:
        return 0;
    }
  }

  /**
   * 逐桥参数。`seed` 为每桥随机相位(0..1) —— **去同步**是防「整网同步白闪」
   * 的直接手段(夜闪三次整改的根因就是网络内桥姿态相近、同时扫过半向量)。
   */
  bridgeFx(seed: number): BridgeFx {
    switch (this.mode) {
      case 1: // 融合:双向流动 + 微气泡(速度已按委托方 2026-09-11 要求提高,见 shader)
        return { flow: 0.55, bubble: 1.0, turb: 0, state: 0 };
      case 2: // 拉扯:黯淡(向背景收敛) — 颈径下限由几何侧承担
        return { flow: 0.1, bubble: 0, turb: 0, state: 1 };
      case 3: {
        // 对撞(**循环**):两端亮斑相向急进 → 中心融合 → 余晖里下一轮已经开始。
        // 通道复用:turb = 两端亮斑的强度包络;state = 亮斑位置(0.86 两端 → 0.5 中心);
        //          flow = 中心余晖强度;bubble = 融合后冒出的气泡量。
        const p = this.t - Math.floor(this.t / CLASH.period) * CLASH.period;
        const born = smooth01(span01(p, CLASH.born[0], CLASH.born[1]));
        const charge = smooth01(span01(p, CLASH.charge[0], CLASH.charge[1]));
        // rising:本轮两斑在中心重合的过程(它在周期末达到 1)
        const rising = smooth01(span01(p, CLASH.merge[0], CLASH.merge[1]));
        // 中心余晖:融合完留下的一团,跨进下一轮头部衰减。两段取 max →
        // 周期首尾天然连续(末帧 rising=1,首帧 decay=1),不会「啪」地切断。
        const glow = Math.max(rising, 1 - smooth01(span01(p, 0, CLASH.afterglow)));
        // 位置:smoothstep 缓动读作「起动—加速—撞上」,而不是匀速平移。
        // ⚠ 起点取 0.86 而不是 1:u = 0/1 是桥的**尖端**,藏在液滴内部,亮斑放那儿
        //   会被液滴自身的辉光吃掉(实测两端只看到液滴的亮边)。桥的可见段约
        //   u ∈ [0.04, 0.96],0.86 已在可见段里、又足够靠端。
        const head = 0.86 - 0.36 * charge;
        return {
          flow: glow,
          bubble: 0.85 * glow,
          turb: born * (1 - rising), // 两斑并入中心余晖后,自己就不再是「两端亮斑」
          state: head,
        };
      }
      case 4: // 暗流:单向快速冲刷(flow < 0)
        return { flow: -0.9 - 0.1 * seed, bubble: 1, turb: 0, state: 0 };
      case 5: // 潜流:平时隐没,指针靠近才浮现
        return { flow: 0.25, bubble: 0.4 * this.reveal, turb: 0, state: this.reveal };
      case 9: {
        // 大转折:旧桥「卷曲、缠绕」(动效 §5)。
        // 通道复用:turb = 卷曲位移幅度(渲染侧 CPU 沿桥轴横向缠绕,两端固定);
        //           grow(见 bridgeGrow)= 卷入收缩,半径归零即「融为一体」。
        // ⚠ 整改后卷曲窗提前到**预兆段**(0.04→0.30):旧桥必须在 0.42(第一次
        //   引擎删滴)之前全部卷没 —— 桥「随之卷曲缠绕」的读法不变,只是与
        //   溃散段并行。汇聚段结束即归零(定格段新桥只由 grow 抽丝,不再缠绕)。
        if (this.t >= TRANSITION.converge[1]) return NO_BRIDGE;
        const g = this.bridgeGrow(seed);
        // 卷曲幅度随**剩余可见桥量**衰减:桥还饱满时缠绕最明显,卷没前收掉
        return { flow: 0, bubble: 0, turb: g * smooth01(span01(this.t, 0.04, 0.3)), state: 0 };
      }
      case 6: // 凝结:桥从 A 端抽出(几何侧 aGrow,不走 aState)
        return NO_BRIDGE;
      case 7: // 死亡:桥回缩隐没
        return NO_BRIDGE;
      default:
        return NO_BRIDGE;
    }
  }

  /**
   * 逐桥粗细系数(关系类型/强度 → 粗细;清单 A-2 的接入口)。
   *
   * ⚠ **粗细不属于任何状态**(委托方 2026-09-11 明确:粗细映射适用于所有液桥、
   * 必须限制在一定范围内、不是某个液桥状态专有)—— 所以这里**不看 mode**。
   * 钳制在 viewer 的 BRIDGE_THICK 视觉安全区间里,只能从这一个口进。
   *
   * 数据映射(A-2)仍待接入(无数据来源);委托方 2026-09-11:最佳效果里粗细
   * 范围变化不能过大,先验证「粗细可从这一个口变化」—— 故暴露 `thick` 可设值
   * (验证页用 URL 参数 `?thick=` 覆写),默认基准 1.0。
   */
  thick = 1.0;
  bridgeThick(seed: number): number {
    void seed; // A-2 接入后按桥取强度;当前与 seed 无关
    return this.thick;
  }

  /** 桥的「抽出/回缩」进度 0..1(1 = 完整桥)。`seed` = 每桥随机相位(去同步)。 */
  bridgeGrow(seed = 0.5): number {
    if (this.mode === 6) return smooth01(span01(this.t, CONDENSE.grow[0], CONDENSE.grow[1]));
    if (this.mode === 7) return 1 - smooth01(span01(this.t, DEATH.growBack[0], DEATH.growBack[1]));
    if (this.mode === 9) {
      // 预兆:旧桥卷入收缩(略错峰,seed 错开起卷时刻)—— 必须在第一次引擎
      // 删滴(首滴溃散末 + removeMargin = 0.42)之前**全部卷没**:渲染上还看得见
      // 的桥若被删滴硬切,会看到「桥凭空断一截」。定格:新桥抽丝生长。
      const t = this.t;
      if (t < TRANSITION.converge[1]) {
        return 1 - smooth01(span01(t, 0.06 + 0.1 * seed, TRANSITION.shatterClear));
      }
      if (t >= TRANSITION.settle[0]) {
        return smooth01(
          span01(t, TRANSITION.settle[0] + 0.04 + 0.08 * seed, TRANSITION.settle[1] - 0.04),
        );
      }
      return 0;
    }
    void seed;
    return 1;
  }

  /**
   * 逐滴参数。`role` 标记该滴在本效果里的角色;`(x,y)` = 引擎位;
   * `index` = 液滴索引(= 源序号;大转折按索引取溃散排期,其余模式忽略)。
   */
  dropletFx(role: number, x = DOMAIN_CENTER, y = DOMAIN_CENTER, index = -1): DropletFx {
    if (this.mode === 9) {
      const t = this.t;
      const idx = index >= 0 ? index : 0;
      if (index >= 0) {
        // 光点起飞点用**实时引擎位**(液滴随波微漂;见 liveX/liveY 注释)。
        // viewer 的同步顺序保证本函数先于 syncSparks 被调用。
        this.liveX[index] = x;
        this.liveY[index] = y;
      }
      if (role === ROLE_T_CORE) {
        // 核心滴:溃散(**压轴**)→ 隐形窗内尺度交接到巨滴 → 物质化(从无到有)
        // → 凝滞悬停(微呼吸)+ 微升 → 爆散 flash + 缩零。
        // ⚠ 长成窗整段落在**隐形窗**里(dissolve=1,屏幕上什么都没有):
        //   巨滴绝不出现「从小长到大」—— 与灰滴整改同一纪律(不能读成小滴扩大);
        //   可见段全程 scale 恒 4.2(凝滞段只有微呼吸)。
        const sh0 = this.transShatterStart(idx);
        const sh1 = sh0 + TRANSITION.shatterDur;
        const f0 = this.giantFormStart();
        const dis = smooth01(span01(t, sh0, sh1)); // 溃散:0→1
        const form = smooth01(span01(t, f0, TRANSITION.giantForm[1])); // 凝聚:0→1
        const giant = smooth01(span01(t, sh1, f0 + 0.02)); // 隐形窗内的尺度交接
        const mp = span01(t, TRANSITION.merge[0], TRANSITION.merge[1]);
        const wobble = 1 + 0.028 * Math.sin(t * 8.5);
        const shrink = easeOutCubic(
          span01(t, TRANSITION.burst[0], TRANSITION.burst[0] + TRANSITION.burstShrink),
        );
        const scale = (1 + (CORE_GIANT_SCALE - 1) * giant) * wobble * (1 - shrink);
        const charge = mp > 0 && mp < 1 ? 0.1 * Math.sin(Math.PI * mp) : 0; // 凝滞蓄力辉光
        return {
          boil: 0,
          dissolve: dis * (1 - form), // 溃散 0→1、凝聚 1→0(单一表达式,隐/现无缝)
          scale: Math.max(0, scale),
          lift: 0.02 * mp, // 「悬停」:离开水面一点点
          flash:
            t >= TRANSITION.burst[0]
              ? Math.max(0, 1 - span01(t, TRANSITION.burst[0], TRANSITION.burst[0] + 0.14))
              : charge, // 爆散闪 = 全程峰值(与整改前逐参数一致)
          absent: 0,
        };
      }
      if (role >= ROLE_T_NEW) {
        // 新章滴:槽位**物质化**(从无到有,dissolve 1→0;尺度恒 1——灰滴整改
        // 同一款纪律:不能读成「小液滴扩大」),按就位次序错峰,压着火花归位窗。
        const order = role - ROLE_T_NEW;
        const t0 = TRANSITION.attract[0] + 0.16 + order * 0.08;
        const mat = smooth01(span01(t, t0, t0 + 0.34));
        return {
          boil: 0,
          dissolve: 1 - mat,
          scale: 1,
          lift: 0,
          flash: 0.5 * Math.sin(Math.PI * mat),
          absent: 0,
        };
      }
      if (role === ROLE_T_OLD) {
        // 旧普通滴:**原地溃散** —— hashed-discard 溶解消失(不缩不涨、不位移),
        // 它的光点由 spark() 池从滴体位置起飞(「液滴全部溃散成光点」);
        // 溶解完由宿主从引擎删除(水底软影随删随消,渲染侧藏不掉它)。
        const sh0 = this.transShatterStart(idx);
        return {
          boil: 0,
          dissolve: smooth01(span01(t, sh0, sh0 + TRANSITION.shatterDur)),
          scale: 1,
          lift: 0,
          flash: 0,
          absent: 0,
        };
      }
      return NO_DROPLET;
    }
    if (this.mode === 6) {
      if (role !== 1) return NO_DROPLET;
      const form = span01(this.t, CONDENSE.form[0], CONDENSE.form[1]);
      const grow = span01(this.t, CONDENSE.form[0], CONDENSE.form[1]);
      // 弹簧过冲:0 → 1.06 → 1.0(「瞬间凝结」的弹性)
      const s = grow < 1 ? grow * 1.06 : 1.06 - 0.06 * Math.min(1, (this.t - CONDENSE.form[1]) / 0.3);
      return {
        boil: 0,
        dissolve: 0,
        scale: form <= 0 ? 0 : Math.max(0, s),
        lift: 0,
        flash: Math.max(0, 1 - Math.abs(this.t - (CONDENSE.form[0] + CONDENSE.form[1]) / 2) / 0.18),
        absent: 0,
      };
    }
    if (this.mode === 8) {
      // 聚焦:只有未在场灰滴需要逐滴演出(数秒内渐次从水底浮现);
      // 在场滴(中心 + 邻居)保持原样,动态关系表达交给它们自己的桥。
      if (role < ROLE_ABSENT) return NO_DROPLET;
      const rise = absentRise(this.t, role - ROLE_ABSENT);
      return {
        boil: 0,
        // 从无到有(委托方 2026-09-12:不能读成「小液滴扩大」)——尺度恒 1,
        // 浮现 = **整颗**从水底升上来;前 45% 进程用 hashed discard 物质化
        // (反向复用死亡的溶解通道:vDissolve 1→0,丢弃既不写色也不写深度,
        // 任意进度深度都正确,不留洞)。后段纯上升,不再有尺寸变化。
        dissolve: 1 - smooth01(span01(rise, 0, 0.45)),
        // ⚠ **不用 alpha 淡入**:液滴不透明且写深度,alpha 淡出会留洞
        //   (第十一批的教训)。
        scale: 1,
        lift: -ABSENT_DEPTH * (1 - rise),
        flash: 0,
        absent: 1,
      };
    }
    if (this.mode === 7) {
      if (role !== 1) return NO_DROPLET;
      const boil = smooth01(span01(this.t, DEATH.boil[0], DEATH.boil[1]));
      const vapor = span01(this.t, DEATH.vapor[0], DEATH.vapor[1]);
      const dissolve = smooth01(span01(this.t, DEATH.dissolve[0], DEATH.dissolve[1]));
      return {
        boil,
        dissolve,
        scale: 1 - 0.65 * vapor,
        // 上飘是**液滴尺度**的量:域边长 1.0、滴径约 0.044,故 0.05 已是「飘起一个多
        // 滴高」。曾误取 0.35(= 域的三分之一),液滴直接飞出画面(实测)。
        lift: 0.05 * vapor * vapor, // 加速上飘
        flash: 0,
        absent: 0,
      };
    }
    return NO_DROPLET;
  }

  /** 雾团(凝结:一团;死亡:一团残雾;大转折:巨滴悬停段的水汽包裹)。`index` = 雾团序号。 */
  fogCue(index: number, cx: number, cy: number): FogCue {
    if (this.mode === 9) {
      if (index >= 4) return NO_FOG;
      // 巨滴长成时雾起,爆散后散去;4 团围核心错方位(避免叠成一颗球)
      const inA = smooth01(span01(this.t, TRANSITION.converge[1] - 0.25, TRANSITION.merge[1]));
      const out = smooth01(span01(this.t, TRANSITION.burst[0], TRANSITION.burst[0] + 0.45));
      const ang = (index / 4) * Math.PI * 2 + 0.35;
      const rr = 0.1 + 0.02 * out;
      return {
        appear: inA * (1 - out),
        radius: 0.075,
        x: cx + Math.cos(ang) * rr,
        y: cy + Math.sin(ang) * rr,
      };
    }
    if (this.mode === 6) {
      // 起雾(淡入并收缩) → 凝结后散去
      const inA = smooth01(span01(this.t, CONDENSE.fogIn[0], CONDENSE.fogIn[1]));
      const conv = smooth01(span01(this.t, CONDENSE.converge[0], CONDENSE.converge[1]));
      const out = smooth01(span01(this.t, CONDENSE.form[0], CONDENSE.form[1]));
      return {
        appear: inA * (1 - out),
        // 半径比液滴直径(≈0.044)略大即可:0.075 时读成「气球」而不是「一团微弱水汽」
        radius: 0.032 * (1 - 0.8 * conv),
        x: cx,
        y: cy,
      };
    }
    if (this.mode === 7) {
      // 残雾:溶解后从中心散开、缓慢淡出(4 团错开方位,避免叠成一片)
      if (index >= 4) return NO_FOG;
      const inA = smooth01(span01(this.t, DEATH.dissolve[0], DEATH.dissolve[1]));
      const fade = smooth01(span01(this.t, DEATH.dissolve[1], this.duration));
      const ang = (index / 4) * Math.PI * 2 + 0.7;
      const rr = 0.018 + 0.045 * (1 - fade);
      return {
        appear: inA * (1 - fade),
        radius: 0.024 + 0.028 * (1 - fade),
        x: cx + Math.cos(ang) * rr,
        y: cy + Math.sin(ang) * rr,
      };
    }
    return NO_FOG;
  }

  /**
   * 过渡段整体压暗/增辉度 0..1(「水下视角的焦散式模糊」观感的一半:
   * viewer 侧把 uDim 抬到本值、bloom 增辉;另一半由雾团包裹承担)。
   * 过渡段(巨滴悬停)达峰,爆散后随火花牵引段回落。
   */
  transitionMix(): number {
    if (this.mode !== 9) return 0;
    const up = smooth01(span01(this.t, TRANSITION.converge[1] - 0.2, TRANSITION.merge[0] + 0.25));
    const down = smooth01(
      span01(this.t, TRANSITION.burst[1], TRANSITION.attract[1] + 0.2),
    );
    return up * (1 - down);
  }

  /**
   * 第 `i` 颗光点的渲染状态(mode 9 之外或未亮起 → null)。
   * 爆散点前 = **汇聚段光点**(溃散 → 漩涡 → 被巨滴吸收);爆散点后 = **火花**
   * (飞射-悬停-牵引)。两者共用同一池、同一材质 —— 委托方要求的「一样」即在此。
   */
  spark(i: number): SparkState | null {
    if (this.mode !== 9) return null;
    if (this.t < TRANSITION.burst[0]) {
      const p = this.convergePoint(i);
      return p && p.a > 0.001 ? p : null; // 被吸收后连槽一起消失(同爆散段口径)
    }
    if (this.transitionSlots.length === 0) return null;
    // ⚠ 爆散段**仍只用前 SPARK_COUNT 槽**:池扩容到 POINT_POOL 只为汇聚段的光点,
    //   不钳住这里 = 炸裂后火花从 48 变 96(实测证据帧抓到,违反 R4「之后不变」)。
    if (i >= SPARK_COUNT) return null;
    const s = sparkState(this.t, i, this.transitionSlots);
    return s.a <= 0.001 ? null : s;
  }
}
