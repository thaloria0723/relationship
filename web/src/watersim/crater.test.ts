import { describe, expect, it } from "vitest";
import { defaultParams, type WaterSimParams } from "./params";
import { WaterField, submergenceVolume, solveEquilibriumDepth } from "./field";
import { WaterEngine } from "./engine";

const DT = defaultParams.dt;

describe("整改 C:准静态核 dip+rim 形状(∫=−V_sub 合同不变)", () => {
  it("核积分仍 = −V_sub(离散 ±10%,同 droplet.test 注)", () => {
    const f = new WaterField(defaultParams);
    const r = 0.02;
    const d = solveEquilibriumDepth(r, defaultParams.densityRatio);
    f.setKernelCount(1);
    f.setKernel(0, 0.5, 0.5, r, d);
    const { N, dx, state } = f;
    let integral = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        integral += (f.totalHeight(i * dx, j * dx) - state.h[k]!) * dx * dx;
      }
    }
    const vSub = submergenceVolume(d, r);
    expect(Math.abs(integral + vSub) / vSub).toBeLessThan(0.1);
  });

  it("rim 存在:中心深凹,峰位 ρ≈3.21σ₁(解析解,§12.1-C)处为正抬升(>0.1mm)", () => {
    const f = new WaterField(defaultParams);
    const r = 0.02;
    const d = solveEquilibriumDepth(r, defaultParams.densityRatio);
    f.setKernelCount(1);
    f.setKernel(0, 0.5, 0.5, r, d);
    const center = f.totalHeight(0.5, 0.5) - f.sampleH(0.5, 0.5);
    // 解析峰位:d/dρ[β·G(ρ;2σ)−α·G(ρ;σ)]=0 ⇒ ρ_peak = σ·√((8/3)·ln(8α/β))
    // = 0.8r·√((8/3)·ln 24) ≈ 3.209σ₁ ≈ 5.13cm(α=1.5, β=0.5)
    const rimRho = 3.209 * defaultParams.kernelSigma * r;
    const rim = f.totalHeight(0.5 + rimRho, 0.5) - f.sampleH(0.5 + rimRho, 0.5);
    expect(center).toBeLessThan(-0.01); // 深凹 >1cm
    expect(rim).toBeGreaterThan(0.0001); // 外环抬升 >0.1mm(解析 ≈ +0.33mm)
    // 单调性佐证峰位正确:半峰位处仍为负(凹陷侧),峰位外开始回落
    const half =
      f.totalHeight(0.5 + 1.6 * defaultParams.kernelSigma * r, 0.5) -
      f.sampleH(0.5 + 1.6 * defaultParams.kernelSigma * r, 0.5);
    expect(half).toBeLessThan(0);
    const far =
      f.totalHeight(0.5 + 6 * defaultParams.kernelSigma * r, 0.5) -
      f.sampleH(0.5 + 6 * defaultParams.kernelSigma * r, 0.5);
    expect(Math.abs(far)).toBeLessThan(1e-5); // 3σ₂ 外归零
  });

  it("bakeTotalInto ≡ totalHeight(节点采样一致,渲染与检测同源)", () => {
    const f = new WaterField(defaultParams);
    const r = 0.02;
    const d = solveEquilibriumDepth(r, defaultParams.densityRatio);
    f.setKernelCount(1);
    f.setKernel(0, 0.5, 0.5, r, d);
    f.addImpulse(0.3, 0.7, 0.02, -0.02); // 动态场叠加扰动
    const { N, dx } = f;
    const out = new Float32Array(N * N);
    f.bakeTotalInto(out);
    for (const [gx, gy] of [
      [0.5, 0.5],
      [0.5 + 0.02, 0.5],
      [0.5 + 0.055, 0.5],
      [0.2, 0.3],
      [0.02, 0.02],
    ] as const) {
      const i = Math.round(gx / dx);
      const j = Math.round(gy / dx);
      expect(out[j * N + i]).toBeCloseTo(f.totalHeight(i * dx, j * dx), 9);
    }
  });
});

describe("整改 D′:分步弹坑发射器", () => {
  it("入水弹坑分步展开:峰值深度数 mm 量级、有界(峰深取过程中中心 min h;终点 h 因色散外传会回弹,不采终点)", () => {
    const engine = new WaterEngine(defaultParams);
    const r = 0.02;
    engine.spawnDroplet(0.5, 0.5, 0.15 + r, r);
    const { N, dx } = engine.field;
    const ci = Math.round(0.5 / dx);
    let minH = 0;
    for (let s = 0; s < 40 + 20; s++) {
      engine.stepFixed(); // 落地 + 弹坑全程展开
      minH = Math.min(minH, engine.field.state.h[ci * N + ci]!);
    }
    expect(minH).toBeLessThan(-0.008); // 弹坑+弛豫合计 >8mm
    expect(minH).toBeGreaterThan(-0.03); // 有界
    expect(Number.isFinite(minH)).toBe(true);
  });

  it("落雨稳定性:持续出生落滴 10k 步无 NaN、maxAbsH 有界(弹坑发射器回归)", () => {
    // capillaryA=0 + 5×4 唯一网格(间距 0.18 ≫ 2rMax+bridge):互不聚合,
    // count===20 才能同时锁定「弹坑发射器」与「聚合不误触发」两条回归线
    const params: WaterSimParams = {
      ...defaultParams,
      waveDamping: 0.3,
      capillaryA: 0,
    };
    const engine = new WaterEngine(params);
    let maxH = 0;
    let spawned = 0;
    for (let s = 0; s < 10000; s++) {
      if (s % 450 === 0 && spawned < 20) {
        const r = spawned % 2 === 0 ? params.rMin : params.rMax;
        const gx = 0.14 + (spawned % 5) * 0.18; // 5×4 网格,20 个唯一点
        const gy = 0.14 + Math.floor(spawned / 5) * 0.18;
        engine.spawnDroplet(gx, gy, 0.15 + r, r);
        spawned++;
      }
      engine.stepFixed();
      if (s % 25 === 0) maxH = Math.max(maxH, engine.field.maxAbsH());
    }
    expect(engine.stats.impacts).toBe(20);
    expect(engine.droplets.state.count).toBe(20);
    expect(engine.stats.merges).toBe(0);
    expect(Number.isFinite(maxH)).toBe(true);
    expect(maxH).toBeLessThan(0.2);
  }, 60000);
});
