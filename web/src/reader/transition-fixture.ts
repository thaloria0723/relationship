// ============================================================
// 章节事件 fixture:三章锚定事件(规格 §8.1 张力公式 / §8.4 转场规则的演示数据)。
// ⚠ 归属(2026-09-12):自验证页删除后**恢复为生产模块**(取自 05bce95)。
//    **真实章节数据接入时替换本文件** —— 字段位已对齐规格 §3 六张表,照此产出即可。
// 真实数据接入时整份替换(A-5:一切带章节锚点,字段位对齐规格 §3 六张表)。
// 纯数据 + 纯函数,three-free。
// ============================================================

import {
  branchOf,
  deltaEvents,
  tensionOf,
  TENSION_WEIGHTS,
  type AnchorEvent,
} from "./tension";

/** 章节 1 = 初始状态(首载直接渲染,不经转场 —— 规格 §8.4) */
export const FIXTURE_FIRST_CHAPTER = 1;
export const FIXTURE_LAST_CHAPTER = 3;

/**
 * 示例书事件表(刻意设计成**每一跳都 ≥ 阈值 1.0**,让验证页总是演大转折;
 * 张力 < 1 的小变化分支由单测覆盖,页面不演出 —— 委托方本轮开题 = 大转折)。
 *
 * - 第 2 章:重要人物死亡(1.5 权重,最重事件)+ 一段新关系确立 → 张力 ≈ 1.71
 * - 第 3 章:新人登场 + 一段关系结束 + 旧敌转亲(敌友反转,系数 1.5)→ 张力 ≈ 1.81
 * - 跳跃 1→3 = 全区间一次结算(≈ 3.52 ≥ T)→ **一次**大转折,不逐章连播(§8.4)
 */
export const TRANSITION_FIXTURE_EVENTS: readonly AnchorEvent[] = [
  {
    chapter: 2,
    kind: "die",
    character: "人物丙",
    importance: 0.9,
  },
  {
    chapter: 2,
    kind: "form",
    pair: ["主角", "人物乙"],
    strength: 0.8,
    importance: [1.0, 0.5],
  },
  {
    chapter: 3,
    kind: "enter",
    character: "人物丁",
    importance: 0.8,
  },
  {
    chapter: 3,
    kind: "end",
    pair: ["主角", "人物甲"],
    strength: 0.5,
    importance: [1.0, 0.4],
  },
  {
    chapter: 3,
    kind: "type",
    pair: ["人物甲", "人物乙"],
    importance: [0.4, 0.6],
    hostileFlip: true,
  },
];

/** 滑块触发一次转场时的读数行(叠在说明框;取帧可读,证明走的是 §8.1 公式) */
export function transitionReadout(from: number, to: number): string {
  const delta = deltaEvents(TRANSITION_FIXTURE_EVENTS, from, to);
  const tension = tensionOf(delta);
  const branch = branchOf(tension);
  const branchText =
    branch === "major" ? `大转折(≥T)` : `小变化(<T,本轮不演出)`;
  return `[章节 ${from}→${to}] 变化 ${delta.length} 项 张力=${tension.toFixed(2)} ${branchText}(T=${TENSION_WEIGHTS.threshold})`;
}
