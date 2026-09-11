// ============================================================
// B 组效果验证 · 效果驱动(three-free,纯逻辑,可单测)
//
// 八效果(动效文档 §三/§四 + §2.3 聚焦灰滴):
//   1 融合   双向缓慢流动 + 微气泡(≤8/桥)
//   2 拉扯   颈径屏幕空间下限 + 向背景色收敛(不压暗) + Rayleigh–Plateau 珠化
//   3 对撞   两端亮斑相向急进 → 中心融合 → 消散冒泡(循环;原「湍流」已按裁决作废)
//   4 暗流   单向快速冲刷(速度符号同向)
//   5 潜流   指针靠近才搅动浮现(快进慢出)
//   6 凝结   起雾 → 聚拢 → 凝结成滴 → 抽桥
//   7 死亡   沸腾 → 汽化上飘 → 抖动溶解 → 残留雾
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
] as const;

/** 最大模式号 */
export const FX_MAX = 8;

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

  reset(mode: number): void {
    this.mode = mode;
    this.t = 0;
    this.reveal = 0;
    this.frozen = false;
  }

  /** 当前模式是否需要时间推进(静场效果不需要) */
  get animated(): boolean {
    return this.mode === 6 || this.mode === 7 || this.mode === 8;
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

  /** 桥的「抽出/回缩」进度 0..1(1 = 完整桥) */
  bridgeGrow(): number {
    if (this.mode === 6) return smooth01(span01(this.t, CONDENSE.grow[0], CONDENSE.grow[1]));
    if (this.mode === 7) return 1 - smooth01(span01(this.t, DEATH.growBack[0], DEATH.growBack[1]));
    return 1;
  }

  /**
   * 逐滴参数。`role` 标记该滴在本效果里的角色:
   * 0 = 普通滴;1 = 主角(凝结的新滴 / 死亡的将死滴)。
   */
  dropletFx(role: number): DropletFx {
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
        dissolve: 0,
        // ⚠ **不用 alpha 淡入**:液滴不透明且写深度,alpha 淡出会留洞
        //   (第十一批的教训)。「浮现」改用「从水下升起来 + 由小渐大」。
        scale: 0.45 + 0.55 * rise,
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

  /** 雾团(凝结:一团;死亡:一团残雾)。`index` = 雾团序号。 */
  fogCue(index: number, cx: number, cy: number): FogCue {
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
}
