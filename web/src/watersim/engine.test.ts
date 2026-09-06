import { describe, expect, it } from "vitest";
import { defaultParams, type WaterSimParams } from "./params";
import { WaterEngine } from "./engine";

/** 确定性 PRNG(独立实现,§6:PRNG 确定性对拍) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sameArray(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    // 逐位相等:NaN 位置也必须一致(NaN !== NaN 会把一致的字面失败误报为不等)
    if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) return false;
  }
  return true;
}

describe("watersim/engine 固定步长门面", () => {
  it("累加器:1/60 帧步进 2~3 亚步,60 帧后 simTime ≈ 1s(±1 步调度相位)", () => {
    const e = new WaterEngine(defaultParams);
    for (let k = 0; k < 60; k++) e.advance(1 / 60);
    // 60×(1/60) 在浮点上略小于 1(2.4999…dt/帧),floor 语义下允许 ±1 步相位差
    expect(Math.abs(e.stats.simTime - 1)).toBeLessThanOrEqual(defaultParams.dt * 1.5);
    expect(e.stats.stepCount).toBeGreaterThanOrEqual(149);
    expect(e.stats.stepCount).toBeLessThanOrEqual(151);
  });

  it("maxSubsteps 封顶:大 frameDt 只走 maxSubsteps 步,累加器钳制防螺旋死亡", () => {
    const e = new WaterEngine(defaultParams); // maxSubsteps = 4
    e.advance(1.0);
    expect(e.stats.stepCount).toBe(4);
    e.advance(1 / 60);
    expect(e.stats.stepCount).toBeLessThanOrEqual(8);
  });

  it("冲量队列:排队源在下一固定步精确生效一次", () => {
    const e = new WaterEngine(defaultParams);
    const ci = (e.field.N >> 1) * e.field.N + (e.field.N >> 1);
    e.addImpulse(0.5, 0.5, 0.02, -0.01);
    expect(e.field.state.h[ci]).toBe(0);
    e.advance(1 / 60);
    expect(e.field.state.h[ci]!).toBeLessThan(-0.009);
  });

  it("确定性:同参数两实例 3600 步 + 同源戳点序列,状态逐位相等", () => {
    const rng = mulberry32(20260906);
    const pokes: { step: number; x: number; y: number; sigma: number; depth: number }[] = [];
    for (let k = 0; k < 20; k++) {
      pokes.push({
        step: Math.floor(rng() * 3400),
        x: 0.15 + rng() * 0.7,
        y: 0.15 + rng() * 0.7,
        sigma: 0.012 + rng() * 0.008,
        depth: -0.005 - rng() * 0.015,
      });
    }
    pokes.sort((a, b) => a.step - b.step);

    const run = (): WaterEngine => {
      const e = new WaterEngine(defaultParams);
      let pi = 0;
      for (let s = 0; s < 3600; s++) {
        while (pi < pokes.length && pokes[pi]!.step === s) {
          const p = pokes[pi]!;
          e.addImpulse(p.x, p.y, p.sigma, p.depth);
          pi++;
        }
        e.stepFixed();
      }
      return e;
    };

    const a = run();
    const b = run();
    expect(a.stats.stepCount).toBe(3600);
    expect(a.stats.simTime).toBeCloseTo(3600 * defaultParams.dt, 10);
    expect(sameArray(a.field.state.h, b.field.state.h)).toBe(true);
    expect(sameArray(a.field.state.u, b.field.state.u)).toBe(true);
    expect(sameArray(a.field.state.v, b.field.state.v)).toBe(true);
    expect(sameArray(a.field.state.hPrev, b.field.state.hPrev)).toBe(true);
  }, 60000);

  it("构造即校验:非法参数 throw", () => {
    const bad: WaterSimParams = { ...defaultParams, waveSpeed: 0.5 };
    expect(() => new WaterEngine(bad)).toThrow(/CFL/);
  });

  it("稳定性:absorb+sponge 下持续周期戳点 10k 步无 NaN、有界(防边界角落模式回归)", () => {
    // 回归背景:显式阻尼×半隐式回耦曾在 sponge 角落形成 +8%/步增长模式,
    // 单次冲击 5s 测试抓不到,持续扰动 ~12s 后爆炸。阻尼已改隐式,此测试守门。
    const params: WaterSimParams = { ...defaultParams, waveDamping: 0.3 }; // 弱阻尼最坏情形
    const e = new WaterEngine(params);
    let maxH = 0;
    for (let s = 0; s < 10000; s++) {
      if (s % 375 === 0) {
        // 2.5s 周期,幅值大于演示脚本
        e.addImpulse(0.3 + (s % 7) * 0.06, 0.4 + (s % 5) * 0.05, 0.015, -0.02);
      }
      e.stepFixed();
      if (s % 25 === 0) maxH = Math.max(maxH, e.field.maxAbsH());
    }
    expect(Number.isFinite(maxH)).toBe(true);
    expect(maxH).toBeLessThan(0.2);
  }, 60000);
});
