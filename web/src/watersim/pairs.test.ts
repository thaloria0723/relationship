import { describe, expect, it } from "vitest";
import { defaultParams, type WaterSimParams } from "./params";
import { WaterField, solveEquilibriumDepth } from "./field";
import { DropletSystem } from "./droplet";
import { DropletPairs, mergeRadius } from "./pairs";

/** 构造一个全部漂浮、指定位置/半径的液滴系统(测试脚手架) */
function makeFloaters(
  params: WaterSimParams,
  specs: { x: number; y: number; r: number }[],
): DropletSystem {
  const field = new WaterField(params);
  const drops = new DropletSystem(params, field);
  for (const s of specs) {
    expect(drops.spawn(s.x, s.y, 0.05 + s.r, s.r)).toBe(true);
  }
  const d = drops.state;
  for (let i = 0; i < d.count; i++) {
    d.floating[i] = 1;
    d.d[i] = solveEquilibriumDepth(d.r[i]!, params.densityRatio);
  }
  return drops;
}

describe("watersim/pairs 聚合几何", () => {
  it("mergeRadius:r=(r₁³+r₂³)^(1/3),体积守恒", () => {
    expect(mergeRadius(0.01, 0.01)).toBeCloseTo(0.01 * Math.cbrt(2), 12);
    expect(mergeRadius(0.01, 0.028)).toBeCloseTo(
      Math.cbrt(0.01 ** 3 + 0.028 ** 3),
      12,
    );
    expect(mergeRadius(0, 0.02)).toBeCloseTo(0.02, 12);
  });
});

describe("watersim/pairs 碰撞动量(§8:冲量公式+恢复系数)", () => {
  it("等质量对撞:法向相对速度反转 × e(动量守恒)。含空中滴的对走冲量路径(双方漂浮的重叠对归桥接/聚合管辖)", () => {
    const params: WaterSimParams = { ...defaultParams, capillaryA: 0 };
    const drops = makeFloaters(params, [
      { x: 0.5 - 0.019, y: 0.5, r: 0.02 }, // 重叠:gap = 0.038 − 0.04 = −0.002
      { x: 0.5 + 0.019, y: 0.5, r: 0.02 },
    ]);
    const d = drops.state;
    // 空中滴:不进桥接逻辑,碰撞冲量直接生效
    d.floating[0] = 0;
    d.floating[1] = 0;
    // 等质量相向运动:速度 ±1 m/s 沿 x
    d.vx[0] = 1;
    d.vx[1] = -1;
    const pairs = new DropletPairs(params, drops);
    pairs.step(params.dt);

    // 等质量 e 碰撞:各自法向速度 = 对称解 ×e ⇒ v′=±e·|v|
    expect(d.vx[0]!).toBeCloseTo(-params.restitution, 6);
    expect(d.vx[1]!).toBeCloseTo(params.restitution, 6);
    // 法向动量守恒(等质量)
    expect(d.vx[0]! + d.vx[1]!).toBeCloseTo(0, 6);
    // 去穿透:中心距 ≥ r₁+r₂
    const sep = Math.hypot(d.x[1]! - d.x[0]!, d.y[1]! - d.y[0]!);
    // 公差 1e-6:位置数组是 Float32Array,0.04 量级的存储精度 ~8e-9;1e-6 足以区分「未修正」
    expect(sep).toBeGreaterThanOrEqual(0.04 - 1e-6);
  });

  it("去穿透:深穿透对被推回到接触,速度不被冲量放大(纯位置修正为主)", () => {
    const params: WaterSimParams = { ...defaultParams, capillaryA: 0 };
    const drops = makeFloaters(params, [
      { x: 0.5 - 0.015, y: 0.5, r: 0.02 },
      { x: 0.5 + 0.015, y: 0.5, r: 0.02 },
    ]);
    const d = drops.state;
    const pairs = new DropletPairs(params, drops);
    pairs.step(params.dt);
    const sep = Math.hypot(d.x[1]! - d.x[0]!, d.y[1]! - d.y[0]!);
    expect(sep).toBeGreaterThanOrEqual(0.04 - 1e-6); // Float32 存储精度,同上注
  });
});

describe("watersim/pairs 毛细吸引(§4.3,风格化)", () => {
  it("近距漂浮滴互相加速靠拢,力随距离增大而衰减", () => {
    const params: WaterSimParams = { ...defaultParams };
    const drops = makeFloaters(params, [
      { x: 0.5 - 0.05, y: 0.5, r: 0.02 },
      { x: 0.5 + 0.05, y: 0.5, r: 0.02 },
    ]);
    const d = drops.state;
    const pairs = new DropletPairs(params, drops);
    pairs.step(params.dt);
    // 双方获得相向速度(对称)
    expect(d.vx[0]!).toBeGreaterThan(0);
    expect(d.vx[1]!).toBeLessThan(0);
    expect(d.vx[0]!).toBeCloseTo(-d.vx[1]!, 9);

    // 远距(超出 capillaryRange·(r₁+r₂))无毛细力
    const dropsFar = makeFloaters(params, [
      { x: 0.3, y: 0.5, r: 0.02 },
      { x: 0.7, y: 0.5, r: 0.02 },
    ]);
    const pairsFar = new DropletPairs(params, dropsFar);
    pairsFar.step(params.dt);
    expect(dropsFar.state.vx[0]!).toBe(0);
  });
});

describe("watersim/pairs 聚合(§8:V 前后相等、动量守恒、液滴数 −1)", () => {
  it("间隙<bridgeRange 持续 drainTime → 聚合:r 合并、动量守恒、场脉冲(mergeEnabled 显式开)", () => {
    const params: WaterSimParams = {
      ...defaultParams,
      capillaryA: 0,
      mergeEnabled: true, // 聚合机制验收场景(默认 false=液桥不融合,§12.2-C′)
    };
    const drops = makeFloaters(params, [
      { x: 0.5 - 0.021, y: 0.5, r: 0.02 }, // 中心距 0.042,间隙 = 0.042 − 0.04 = 0.002 < bridgeRange·0.04
      { x: 0.5 + 0.021, y: 0.5, r: 0.02 },
    ]);
    const d = drops.state;
    d.vx[0] = 0.5;
    d.vx[1] = -0.25;
    const vTotalBefore = 0.5 + -0.25; // 等质量动量守恒核对 Σv

    const pairs = new DropletPairs(params, drops);
    // drainTime = 0.08s = 12 步(1/150);走 drainTime+1 步
    for (let s = 0; s < 13; s++) pairs.step(params.dt);

    expect(d.count).toBe(1);
    expect(d.r[0]!).toBeCloseTo(0.02 * Math.cbrt(2), 9);
    expect(d.vx[0]!).toBeCloseTo(vTotalBefore / 2, 6); // 等质量动量守恒
    expect(pairs.mergeCount).toBe(1);
    // 形状踢振已注入(epsVel ≠ 0)
    expect(Math.abs(d.epsVel[0]!)).toBeGreaterThan(0);
  });

  it("排液未满 drainTime 不聚合;离开桥接区间计时清零(mergeEnabled 显式开)", () => {
    const params: WaterSimParams = {
      ...defaultParams,
      capillaryA: 0,
      mergeEnabled: true,
    };
    const drops = makeFloaters(params, [
      { x: 0.5 - 0.021, y: 0.5, r: 0.02 },
      { x: 0.5 + 0.021, y: 0.5, r: 0.02 },
    ]);
    const pairs = new DropletPairs(params, drops);
    for (let s = 0; s < 5; s++) pairs.step(params.dt); // 5/150 < 0.08
    expect(drops.state.count).toBe(2);
    expect(drops.state.bridgeT[0]!).toBeGreaterThan(0);

    // 拉开到桥接区间外一步 → 计时清零
    drops.state.x[0] = 0.3;
    drops.state.x[1] = 0.7;
    pairs.step(params.dt);
    expect(drops.state.bridgeT[0]!).toBe(0);
  });

  it("mergeEnabled=false(默认):桥接对靠拢但不融合(液桥网络,§12.2-C′)", () => {
    const params: WaterSimParams = { ...defaultParams, capillaryA: 0 };
    const drops = makeFloaters(params, [
      { x: 0.5 - 0.021, y: 0.5, r: 0.02 },
      { x: 0.5 + 0.021, y: 0.5, r: 0.02 },
    ]);
    const pairs = new DropletPairs(params, drops);
    for (let s = 0; s < 30; s++) pairs.step(params.dt);
    expect(drops.state.count).toBe(2); // 液滴数不变
    expect(pairs.mergeCount).toBe(0);
    expect(drops.state.bridgeT[0]!).toBe(0); // 不计时(不进入聚合管线)
  });

  it("冷却期内的滴不参与聚合(cooldown 防瞬聚)", () => {
    const params: WaterSimParams = { ...defaultParams, capillaryA: 0 };
    const drops = makeFloaters(params, [
      { x: 0.5 - 0.021, y: 0.5, r: 0.02 },
      { x: 0.5 + 0.021, y: 0.5, r: 0.02 },
    ]);
    drops.state.cooldown[0] = 1.0; // 长冷却覆盖整个测试时长(0.2s)
    drops.state.cooldown[1] = 1.0;
    const pairs = new DropletPairs(params, drops);
    for (let s = 0; s < 30; s++) pairs.step(params.dt);
    expect(drops.state.count).toBe(2);
    expect(pairs.mergeCount).toBe(0);
    expect(drops.state.bridgeT[0]!).toBe(0); // 冷却对不计时
  });
});
