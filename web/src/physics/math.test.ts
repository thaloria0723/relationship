import { describe, expect, it } from "vitest";
import { clamp, fract, smoothstep } from "./math";

describe("math GLSL 兼容层", () => {
  it("clamp 钳制到区间", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-2, 0, 3)).toBe(0);
    expect(clamp(1.5, 0, 3)).toBe(1.5);
  });

  it("smoothstep 标准语义:0.5 中点、边界钳制", () => {
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0.1, 0.45, 0.1)).toBe(0);
    expect(smoothstep(0.1, 0.45, 0.45)).toBe(1);
  });

  it("smoothstep 反向边保持 GLSL de-facto 行为(封版代码有 smoothstep(1.08,1.0,dr))", () => {
    // 手算:t=(0.25-1)/(0-1)=0.75 → 0.75²(3-2·0.75)=0.84375
    expect(smoothstep(1, 0, 0.25)).toBeCloseTo(0.84375, 12);
  });

  it("fract 负数输入返回正分数", () => {
    expect(fract(-0.25)).toBeCloseTo(0.75, 12);
    expect(fract(2.5)).toBeCloseTo(0.5, 12);
    expect(fract(0)).toBe(0);
  });
});
