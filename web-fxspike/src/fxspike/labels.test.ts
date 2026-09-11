// B 组效果验证 · 文字叠层单测(纯逻辑部分;DOM 层由肉眼证据帧覆盖)
import { describe, expect, it } from "vitest";
import { labelAlpha } from "./labels";

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
