import { describe, expect, it } from "vitest";
import { defaultParams, validateParams } from "./params";

// 浅拷贝即可:validateParams 只读
const clone = () => ({ ...defaultParams });

describe("watersim/params 校验", () => {
  it("默认参数通过校验(CFL 含 cflSafety 余量)", () => {
    expect(() => validateParams(clone())).not.toThrow();
  });

  it("CFL:c·dt/dx 超过 cflSafety/√2 时 throw", () => {
    // 0.5·255/150 ≈ 0.85 > 0.85/√2 ≈ 0.601
    expect(() => validateParams({ ...clone(), waveSpeed: 0.5 })).toThrow(/CFL/);
    // (1/60)·255 ≈ c·dt/dx = 0.3·255/60 = 1.275
    expect(() => validateParams({ ...clone(), dt: 1 / 60 })).toThrow(/CFL/);
  });

  it("CFL:恰好压线(>1/√2 硬上限)必 throw", () => {
    // dt 取范围上界 1/30:c·dt/dx = 0.3·255/30 = 2.55 ≫ 1/√2(硬上限)
    expect(() => validateParams({ ...clone(), dt: 1 / 30 })).toThrow(/CFL/);
  });

  it("参数范围越界 throw,报错含参数名", () => {
    expect(() => validateParams({ ...clone(), gridN: 100 })).toThrow(/gridN/);
    expect(() => validateParams({ ...clone(), gridN: 400 })).toThrow(/gridN/);
    expect(() => validateParams({ ...clone(), waveSpeed: 0.05 })).toThrow(/waveSpeed/);
    expect(() => validateParams({ ...clone(), waveDamping: 5 })).toThrow(/waveDamping/);
    expect(() => validateParams({ ...clone(), restitution: 0.9 })).toThrow(/restitution/);
    expect(() => validateParams({ ...clone(), spongeWidth: 2 })).toThrow(/spongeWidth/);
    expect(() => validateParams({ ...clone(), maxDroplets: 4 })).toThrow(/maxDroplets/);
  });

  it("相对约束:rMin < rMax", () => {
    expect(() => validateParams({ ...clone(), rMin: 0.03 })).toThrow(/rMin/);
  });

  it("边界模式只允许 absorb/reflect", () => {
    expect(() =>
      validateParams({ ...clone(), boundaryMode: "mirror" as never }),
    ).toThrow(/boundaryMode/);
  });

  it("非有限数值直接 throw", () => {
    expect(() => validateParams({ ...clone(), waveSpeed: Number.NaN })).toThrow(/waveSpeed/);
  });
});
