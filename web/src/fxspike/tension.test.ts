// 章节转场纯逻辑单测(张力公式 §8.1 + 滑块规则 §8.4;无渲染无 DOM)
import { describe, expect, it } from "vitest";
import {
  branchOf,
  deltaEvents,
  SLIDER_DEBOUNCE_MS,
  SliderGate,
  tensionOf,
  tensionTerm,
  TENSION_WEIGHTS,
  type AnchorEvent,
} from "./tension";

describe("§8.1 张力公式:逐项权重", () => {
  it("新人登场 = importance × 0.5", () => {
    expect(tensionTerm({ chapter: 2, kind: "enter", character: "甲", importance: 0.8 })).toBeCloseTo(0.4);
  });
  it("人物死亡 = importance × 1.5(最重)", () => {
    expect(tensionTerm({ chapter: 2, kind: "die", character: "甲", importance: 0.8 })).toBeCloseTo(1.2);
    const die = tensionTerm({ chapter: 2, kind: "die", character: "甲", importance: 0.9 });
    const enter = tensionTerm({ chapter: 2, kind: "enter", character: "甲", importance: 0.9 });
    expect(die).toBeGreaterThan(enter);
  });
  it("新关系 = strength × 双方平均 importance × 0.6", () => {
    expect(
      tensionTerm({
        chapter: 2,
        kind: "form",
        pair: ["甲", "乙"],
        strength: 0.9,
        importance: [0.6, 0.8],
      }),
    ).toBeCloseTo(0.9 * 0.7 * 0.6);
  });
  it("关系结束系数(0.8)高于新关系(0.6)", () => {
    const form = tensionTerm({ chapter: 2, kind: "form", pair: ["甲", "乙"], strength: 0.8, importance: [0.7, 0.7] });
    const end = tensionTerm({ chapter: 2, kind: "end", pair: ["甲", "乙"], strength: 0.8, importance: [0.7, 0.7] });
    expect(end).toBeCloseTo(form * (0.8 / 0.6));
  });
  it("类型变化 = 均值 × 1.0;敌友反转系数取上限 1.5", () => {
    const normal = tensionTerm({ chapter: 2, kind: "type", pair: ["甲", "乙"], importance: [0.6, 0.8] });
    const flip = tensionTerm({ chapter: 2, kind: "type", pair: ["甲", "乙"], importance: [0.6, 0.8], hostileFlip: true });
    expect(normal).toBeCloseTo(0.7);
    expect(flip).toBeCloseTo(0.7 * TENSION_WEIGHTS.hostileFlipCap); // 系数 1.5,仍乘均值
  });
  it("公式用 override 权重(可按书覆盖),不读死常量", () => {
    const w = { ...TENSION_WEIGHTS, die: 2.0 };
    expect(tensionTerm({ chapter: 2, kind: "die", character: "甲", importance: 1 }, w)).toBe(2);
  });
});

describe("§8.1 变化集与阈值分支", () => {
  const book: AnchorEvent[] = [
    { chapter: 1, kind: "enter", character: "甲", importance: 0.8 }, // 首章:不算转场
    { chapter: 2, kind: "enter", character: "乙", importance: 0.6 },
    { chapter: 3, kind: "form", pair: ["甲", "乙"], strength: 0.9, importance: [0.8, 0.6] },
    { chapter: 4, kind: "die", character: "乙", importance: 0.9 },
    { chapter: 5, kind: "end", pair: ["甲", "丙"], strength: 0.5, importance: [0.8, 0.4] },
  ];

  it("区间 = (from, to],前章事件不带入", () => {
    expect(deltaEvents(book, 1, 2)).toHaveLength(1);
    expect(deltaEvents(book, 0, 1)).toHaveLength(1); // 首章事件属于「初始状态」?不:首载不触发,此处只验区间数学
    expect(deltaEvents(book, 2, 3)).toHaveLength(1);
  });

  it("跳跃式切换 = 全区间一次结算(叠加,不逐章拆)", () => {
    const jump = tensionOf(deltaEvents(book, 1, 5));
    let stepwise = 0;
    for (let c = 1; c < 5; c++) stepwise += tensionOf(deltaEvents(book, c, c + 1));
    expect(jump).toBeCloseTo(stepwise);
    expect(jump).toBeGreaterThan(TENSION_WEIGHTS.threshold); // 死亡+关系足以越阈
  });

  it("阈值分支:≥T 大转折,<T 小变化", () => {
    expect(branchOf(TENSION_WEIGHTS.threshold)).toBe("major");
    expect(branchOf(TENSION_WEIGHTS.threshold - 0.01)).toBe("minor");
    expect(branchOf(0)).toBe("minor");
  });
});

describe("§8.4 滑块门:150ms 防抖 + 松手触发 + 跳跃一次 + 首载不触发", () => {
  it("拖动中不出章,松手才放行", () => {
    const gate = new SliderGate(1);
    gate.input(3, 0);
    expect(gate.release(10)).toEqual({ action: "wait" }); // 松手但未过防抖窗
    expect(gate.release(SLIDER_DEBOUNCE_MS + 1)).toEqual({ action: "fire", chapter: 3 });
  });

  it("快速甩动:防抖窗内最后一次 input 才算数(不逐章连播)", () => {
    const gate = new SliderGate(1);
    gate.input(2, 0);
    gate.input(3, 40);
    gate.input(4, 80);
    const r = gate.release(80 + SLIDER_DEBOUNCE_MS + 1);
    expect(r).toEqual({ action: "fire", chapter: 4 });
  });

  it("松手后继续拖动再松手:重新计防抖", () => {
    const gate = new SliderGate(1);
    gate.input(3, 0);
    expect(gate.release(200)).toEqual({ action: "fire", chapter: 3 });
    gate.input(2, 210);
    expect(gate.release(215)).toEqual({ action: "wait" });
    expect(gate.release(215 + SLIDER_DEBOUNCE_MS + 1)).toEqual({ action: "fire", chapter: 2 });
  });

  it("目标 = 当前章 → 不触发", () => {
    const gate = new SliderGate(2);
    gate.input(2, 0);
    expect(gate.release(SLIDER_DEBOUNCE_MS + 1)).toEqual({ action: "none" });
  });

  it("没拖动就松手 → none;构造时的章不经 release(首载不触发转场)", () => {
    const gate = new SliderGate(1);
    expect(gate.release(1000)).toEqual({ action: "none" });
  });
});
