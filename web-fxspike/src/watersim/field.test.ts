import { describe, expect, it } from "vitest";
import { defaultParams, type WaterSimParams } from "./params";
import { WaterField } from "./field";

const DT = defaultParams.dt; // 1/150

function steps(f: WaterField, n: number): void {
  for (let s = 0; s < n; s++) f.step(DT);
}

/** 沿过场中心的 +x 射线,在期望半径 ±9cm 窗口内找最深点(外行波前),返回其半径 */
function peakRadiusAlongX(f: WaterField, tExpect: number, c: number): number {
  const { N, dx } = f;
  const h = f.state.h;
  const i0 = N >> 1;
  const j0 = N >> 1;
  const lo = Math.max(2, (c * tExpect - 0.09) / dx);
  const hi = Math.min(N - 2 - i0, (c * tExpect + 0.09) / dx);
  let best = 0;
  let bestR = -1;
  for (let i = i0 + Math.ceil(lo); i <= i0 + Math.floor(hi); i++) {
    const val = h[j0 * N + i]!;
    if (bestR < 0 || val < best) {
      best = val;
      bestR = (i - i0) * dx;
    }
  }
  expect(bestR).toBeGreaterThan(0);
  return bestR;
}

describe("watersim/field 波动核(浅水,flowOn=true)", () => {
  it("波速:高斯脉冲外行环 Δx/Δt = c(±5% 网格色散容差)", () => {
    const f = new WaterField(defaultParams);
    f.addImpulse(0.5, 0.5, 0.02, -0.02);
    steps(f, Math.round(1.0 / DT));
    const r1 = peakRadiusAlongX(f, 1.0, 0.3);
    steps(f, Math.round(0.4 / DT));
    const r2 = peakRadiusAlongX(f, 1.4, 0.3);
    const v = (r2 - r1) / 0.4;
    expect(Math.abs(v - 0.3) / 0.3).toBeLessThan(0.05);
  });

  it("能量:无源场单调不增并收敛到 0", () => {
    const f = new WaterField(defaultParams);
    f.addImpulse(0.5, 0.5, 0.02, -0.03);
    const e0 = f.energy();
    expect(e0).toBeGreaterThan(0);
    let prev = e0;
    for (let k = 0; k < 12; k++) {
      steps(f, 100);
      const e = f.energy();
      // 噪声地板:能量降到 e0·1e-7 以下是 Float32 舍入回吐区,单调性只在该地板之上要求
      expect(e).toBeLessThanOrEqual(prev * 1.000001 + e0 * 1e-7);
      prev = e;
    }
    expect(prev / e0).toBeLessThan(1e-6);
  });

  it("边界:absorb 基本吸净,reflect 驻留能量显著更高", () => {
    const run = (mode: WaterSimParams["boundaryMode"]): number => {
      const f = new WaterField({
        ...defaultParams,
        boundaryMode: mode,
        waveDamping: 0.3, // 弱阻尼,凸显 sponge 的作用
      });
      f.addImpulse(0.5, 0.5, 0.02, -0.03);
      const e0 = f.energy();
      steps(f, Math.round(3.0 / DT));
      return f.energy() / e0;
    };
    const absorb = run("absorb");
    const reflect = run("reflect");
    // 理论量级:reflect 受 λ+μf 联合衰减 ≈ e^{−(0.3+0.8)·3} ≈ 3.7%;
    // absorb 再叠加 sponge 吸收(实测 ~3e-4),两者相差两个量级
    expect(absorb).toBeLessThan(0.005);
    expect(reflect).toBeGreaterThan(0.01);
    expect(reflect).toBeGreaterThan(absorb * 20);
  });

  it("冲量源:高斯凹陷立即成形,3σ 截断外零扰动", () => {
    const f = new WaterField(defaultParams);
    f.addImpulse(0.3, 0.3, 0.012, -0.01);
    const { N, dx } = f;
    const h = f.state.h;
    const ci = Math.round(0.3 / dx);
    const cj = Math.round(0.3 / dx);
    expect(h[cj * N + ci]!).toBeLessThan(-0.009);
    expect(h[0]!).toBe(0);
    expect(h[N * N - 1]!).toBe(0);
  });

  it("稳定性:大幅扰动 5s 后仍有限且有界", () => {
    const f = new WaterField(defaultParams);
    f.addImpulse(0.5, 0.5, 0.02, -0.05);
    steps(f, Math.round(5.0 / DT));
    const m = f.maxAbsH();
    expect(Number.isFinite(m)).toBe(true);
    expect(m).toBeLessThan(0.1);
  });
});

describe("watersim/field 波动核(flowOn=false 纯波动方程路径)", () => {
  it("波速同为 c", () => {
    const f = new WaterField({ ...defaultParams, flowOn: false });
    f.addImpulse(0.5, 0.5, 0.02, -0.02);
    steps(f, Math.round(1.0 / DT));
    const r1 = peakRadiusAlongX(f, 1.0, 0.3);
    steps(f, Math.round(0.4 / DT));
    const r2 = peakRadiusAlongX(f, 1.4, 0.3);
    const v = (r2 - r1) / 0.4;
    expect(Math.abs(v - 0.3) / 0.3).toBeLessThan(0.05);
  });

  it("能量单调不增", () => {
    const f = new WaterField({ ...defaultParams, flowOn: false });
    f.addImpulse(0.5, 0.5, 0.02, -0.03);
    const e0 = f.energy();
    let prev = e0;
    for (let k = 0; k < 6; k++) {
      steps(f, 100);
      const e = f.energy();
      expect(e).toBeLessThanOrEqual(prev * 1.000001);
      prev = e;
    }
  });
});
