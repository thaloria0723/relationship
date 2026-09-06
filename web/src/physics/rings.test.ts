import { describe, expect, it } from "vitest";
import { ringFade, ringPhase, ringRadius } from "./rings";

describe("ringPhase 波场相位", () => {
  it("零点:k=0,w=0,t=0 → 0;值域 [0,1)", () => {
    expect(ringPhase(0, 0, 0)).toBe(0);
    for (let t = 0; t < 80; t += 1.3) {
      for (const k of [0, 1, 2]) {
        const p = ringPhase(k, 0.42, t);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(1);
      }
    }
  });

  it("随时间单调增(未越界区间)", () => {
    expect(ringPhase(0, 0, 10)).toBeGreaterThan(ringPhase(0, 0, 5));
  });
});

describe("ringRadius 线性外扩", () => {
  it("手算:phase 0 → 0.6,0.5 → 1.3,1 → 2.0", () => {
    expect(ringRadius(0)).toBeCloseTo(0.6, 12);
    expect(ringRadius(0.5)).toBeCloseTo(1.3, 12);
    expect(ringRadius(1)).toBeCloseTo(2.0, 12);
  });

  it("单调不减", () => {
    expect(ringRadius(0.7)).toBeGreaterThan(ringRadius(0.3));
  });
});

describe("ringFade 弱-强-弱包络 × 距离衰减", () => {
  it("两端为零:出生前(0)与消亡后(1)", () => {
    expect(ringFade(0, 1)).toBe(0);
    expect(ringFade(1, 1)).toBe(0);
  });

  it("手算:phase=0.5(两侧包络均为 1)→ 1/(0.55+dist·0.6)", () => {
    expect(ringFade(0.5, 1)).toBeCloseTo(1 / 1.15, 12);
    expect(ringFade(0.5, 2)).toBeCloseTo(1 / 1.75, 12);
  });

  it("峰在区间内部,两端更低", () => {
    const mid = ringFade(0.35, 1);
    expect(mid).toBeGreaterThan(ringFade(0.05, 1));
    expect(mid).toBeGreaterThan(ringFade(0.95, 1));
  });

  it("距离衰减单调", () => {
    expect(ringFade(0.5, 2)).toBeLessThan(ringFade(0.5, 1));
  });
});
