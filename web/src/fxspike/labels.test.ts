// B 组效果验证 · 文字叠层单测(纯逻辑部分;DOM 层由肉眼证据帧覆盖)
import { describe, expect, it } from "vitest";
import { labelAlpha, labelFontSize } from "./labels";

describe("labelAlpha:灰滴标签随浮现渐显(文字不能先于水滴出现)", () => {
  it("浮起 70% 前不显,就位时全显", () => {
    expect(labelAlpha(0)).toBe(0);
    expect(labelAlpha(0.69)).toBe(0);
    expect(labelAlpha(0.85)).toBeGreaterThan(0);
    expect(labelAlpha(0.85)).toBeLessThan(1);
    expect(labelAlpha(1)).toBe(1);
  });

  it("单调不减且不越界(渐显,不闪烁)", () => {
    let prev = -1;
    for (let r = 0; r <= 1.001; r += 0.01) {
      const a = labelAlpha(r);
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      prev = a;
    }
  });
});

describe("labelFontSize:v3 上滴自适应字号(委托方 2026-09-12「文字标到液滴上」)", () => {
  it("随投影半径走:滴大字大、滴小字小", () => {
    expect(labelFontSize(10)).toBeLessThan(labelFontSize(15));
    expect(labelFontSize(15)).toBeCloseTo(13.5, 1);
  });

  it("钳在可读区间 [10,16]:滴再小字不糊,滴再大字不失控", () => {
    expect(labelFontSize(0)).toBe(10);
    expect(labelFontSize(4)).toBe(10);
    expect(labelFontSize(40)).toBe(16);
    expect(labelFontSize(400)).toBe(16);
  });
});
