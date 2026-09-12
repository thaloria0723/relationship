// ============================================================
// 章节转场 · 张力与滑块规则(产品规格 §8.1/§8.4 + 视觉规格 §6 ②)
//
// three-free、无渲染、无 DOM —— 视觉规格 §1 模块②独立性铁律。
// 内容:
//   - §8.1 变化集张力公式(权重常量集中此处,可按书覆盖);
//   - 跳跃式切换 = 全区间 delta 一次结算(不逐章连播);
//   - 阈值分支:张力 < T → 小变化;≥ T → 大转折(本轮只实施大转折演出);
//   - §8.4 滑块规则:150ms 防抖 + 松手触发 + 首载不触发(SliderGate 纯状态)。
//
// ⚠ 归属(2026-09-12):自验证页删除后**恢复为生产模块**(取自 05bce95)。
//   「大转折」演出本体(三阶段 fx=9)随验证页留档,接入时从 05bce95 取回重接 ——
//   本模块是它的触发/判定入口(张力分支 → 是否走大转折)。
// ============================================================

/** 变化权重表(§8.1;权重可被按书覆盖 = 传一份改过字段的本结构,见规格
 *  「权重与阈值集中在一个常量文件,设计为可按书设置」)。 */
export interface TensionWeights {
  /** 新人登场 = importance × 0.5 */
  enter: number;
  /** 人物死亡 = importance × 1.5(最重的事件) */
  die: number;
  /** 新关系 = strength × 双方平均 importance × 0.6 */
  form: number;
  /** 关系结束 = strength × 双方平均 importance × 0.8 */
  end: number;
  /** 类型变化 = 双方平均 importance × 1.0 */
  type: number;
  /** 敌友反转类(敌对↔亲密)类型变化的系数上限 */
  hostileFlipCap: number;
  /** 张力阈值 T(≥T 大转折,<T 小变化) */
  threshold: number;
}

export const TENSION_WEIGHTS: TensionWeights = {
  enter: 0.5,
  die: 1.5,
  form: 0.6,
  end: 0.8,
  type: 1.0,
  hostileFlipCap: 1.5,
  threshold: 1.0,
};

/** 单条章节锚定事件(字段位对齐规格 §3 六张表;验证页用 fixture) */
export type AnchorEvent =
  | { chapter: number; kind: "enter" | "die"; character: string; importance: number }
  | {
      chapter: number;
      kind: "form" | "end";
      pair: [string, string];
      strength: number;
      importance: [number, number];
    }
  | {
      chapter: number;
      kind: "type";
      pair: [string, string];
      importance: [number, number];
      /** 敌友反转(敌对↔亲密)= 按上限 1.5 取值,不按均值 */
      hostileFlip?: boolean;
    };

/** 变化集张力贡献的分项(测试对拍用) */
export interface TensionTerm {
  event: AnchorEvent;
  weight: number;
}

const avg = (a: number, b: number): number => (a + b) / 2;

/** 单事件的张力贡献(§8.1 公式逐项;权重表可覆盖) */
export function tensionTerm(ev: AnchorEvent, w: TensionWeights = TENSION_WEIGHTS): number {
  switch (ev.kind) {
    case "enter":
      return ev.importance * w.enter;
    case "die":
      return ev.importance * w.die;
    case "form":
      return ev.strength * avg(ev.importance[0], ev.importance[1]) * w.form;
    case "end":
      return ev.strength * avg(ev.importance[0], ev.importance[1]) * w.end;
    case "type": {
      const base = ev.hostileFlip ? w.hostileFlipCap : w.type;
      return avg(ev.importance[0], ev.importance[1]) * base;
    }
  }
}

/**
 * 区间 (from, to] 内的事件 = 章节转场的变化集。
 * 跳跃式切换(如 1→5)就是全区间一次结算 —— 权重同理叠加(§8.1 注意段),
 * 因此这里**不做**逐章拆分:调用方把 (from,to] 直接给进来。
 */
export function deltaEvents(
  events: readonly AnchorEvent[],
  from: number,
  to: number,
): AnchorEvent[] {
  return events.filter((ev) => ev.chapter > from && ev.chapter <= to);
}

/** 变化集张力 = Σ 各事件权重 */
export function tensionOf(
  delta: readonly AnchorEvent[],
  w: TensionWeights = TENSION_WEIGHTS,
): number {
  return delta.reduce((sum, ev) => sum + tensionTerm(ev, w), 0);
}

/** 阈值分支:张力 < T → 小变化;≥ T → 大转折 */
export function branchOf(
  tension: number,
  w: TensionWeights = TENSION_WEIGHTS,
): "minor" | "major" {
  return tension >= w.threshold ? "major" : "minor";
}

// ------------------------------------------------------------
// 章节滑块规则(§8.4;纯状态,DOM 由宿主接)
// ------------------------------------------------------------

/** 防抖窗口(毫秒;§6 ②:拖动 150ms 防抖) */
export const SLIDER_DEBOUNCE_MS = 150;

/**
 * 滑块门:input(拖动中反复喂)只在**松手**且距最后一次 input 足够久才放行。
 * - 「松手触发」:拖动中不出章(release 之前 input 只记目标);
 * - 「150ms 防抖」:松手后 150ms 内的最后一次值才算数 —— 快速甩动滑块不会
 *   把中途路过的章逐个触发;
 * - 「跳跃 = 一次」:放行的是**最终目标章**,转场由 (当前, 目标] 一次结算;
 * - 「首载不触发」:构造时的章即当前章,不经 release。
 * 返回 null = 不触发;返回章号 = 目标章(≠ 当前章才由宿主起转场)。
 */
export class SliderGate {
  /** 当前章(转场完成后由宿主写回) */
  current: number;
  /** 拖动中的目标章(未松手) */
  private pending: number | null = null;
  private lastInputAt = -Infinity;

  constructor(current: number) {
    this.current = current;
  }

  /** 拖动中:记录目标(release 前不出章) */
  input(chapter: number, nowMs: number): void {
    this.pending = chapter;
    this.lastInputAt = nowMs;
  }

  /**
   * 松手:距最后一次 input 不足防抖窗口 → 等待(返回 "wait",宿主稍后重询);
   * 否则放行最终目标;目标 = 当前章 → 不触发。
   */
  release(nowMs: number): { action: "wait" } | { action: "fire"; chapter: number } | { action: "none" } {
    if (this.pending === null) return { action: "none" };
    if (nowMs - this.lastInputAt < SLIDER_DEBOUNCE_MS) return { action: "wait" };
    const chapter = this.pending;
    this.pending = null;
    if (chapter === this.current) return { action: "none" };
    this.current = chapter;
    return { action: "fire", chapter };
  }

  /** 转场结束后写回(宿主责任;首载不经此路径 → 首载不触发转场) */
  settled(chapter: number): void {
    this.current = chapter;
  }
}
