import { describe, expect, it } from "vitest";
import { defaultParams, type WaterSimParams } from "./params";
import { WaterField } from "./field";
import { DropletSystem } from "./droplet";
import { BridgeSystem } from "./bridges";

const DT = defaultParams.dt;

/** 直连构造:两颗已漂浮滴 + 桥系统(绕过引擎管线,单元级) */
function makeSys(params: WaterSimParams = defaultParams) {
  const field = new WaterField(params);
  const drops = new DropletSystem(params, field);
  const bridges = new BridgeSystem(params, drops);
  return { field, drops, bridges, params };
}

/** 两颗漂浮滴:间隙 gap(默认 0.002m,须落在桥接区间 < 0.12·(r₁+r₂) 内) */
function spawnPair(
  drops: DropletSystem,
  r1 = 0.02,
  r2 = 0.02,
  gap = 0.002,
): void {
  drops.spawn(0.5 - (r1 + gap / 2), 0.5, 0.1, r1);
  drops.spawn(0.5 + (r2 + gap / 2), 0.5, 0.1, r2);
  drops.update(DT);
}

function floatPair(drops: DropletSystem): void {
  const d = drops.state;
  d.floating[0] = 1;
  d.floating[1] = 1;
  d.d[0] = d.dStar[0]!;
  d.d[1] = d.dStar[1]!;
}

/** 手工位置积分(桥产出速度;真实管线中由 droplets.update 积分) */
function integrate(drops: DropletSystem, dt: number): void {
  const d = drops.state;
  for (let i = 0; i < d.count; i++) {
    d.x[i] = d.x[i]! + d.vx[i]! * dt;
    d.y[i] = d.y[i]! + d.vy[i]! * dt;
  }
}

describe("watersim/bridges 液桥形成", () => {
  it("两漂浮滴持续 drainTime → 成桥;restLen = max(成桥距, rSum·(1+bridgeRestGap));mergeEnabled=false 模式", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops);
    floatPair(drops);
    const d = drops.state;
    const rSum = d.r[0]! + d.r[1]!;
    const steps = Math.ceil(defaultParams.drainTime / DT) + 2;
    for (let s = 0; s < steps; s++) bridges.step(DT);
    expect(bridges.state.count).toBe(1);
    expect(bridges.state.a[0]).toBe(0);
    expect(bridges.state.b[0]).toBe(1);
    // 调优第三批 #1:近距对成桥 → restLen 取持距下限(保证最小净间距)
    expect(bridges.state.restLen[0]!).toBeCloseTo(
      rSum * (1 + defaultParams.bridgeRestGap),
      4,
    );
  });

  it("远距成桥(连接语义,距离无关):任意间距的两漂浮滴成桥,且保持间距不收缩", () => {
    const { drops, bridges } = makeSys();
    drops.spawn(0.3, 0.5, 0.1, 0.02);
    drops.spawn(0.7, 0.5, 0.1, 0.02); // 相距 0.4m,远超毛细/桥接区间
    floatPair(drops);
    const steps = Math.ceil(defaultParams.drainTime / DT) + 2;
    for (let s = 0; s < steps; s++) bridges.step(DT);
    expect(bridges.state.count).toBe(1);
    // restLen = 成桥距(连接而非收缩:桥把当前距离固定下来)
    expect(bridges.state.restLen[0]!).toBeCloseTo(0.4, 3);
    const d = drops.state;
    for (let s = 0; s < Math.round(2.0 / DT); s++) {
      bridges.step(DT);
      integrate(drops, DT);
    }
    const dist = Math.hypot(d.x[1]! - d.x[0]!, d.y[1]! - d.y[0]!);
    expect(dist).toBeGreaterThan(0.395); // 不收缩(毛细聚合语义下会贴到一起)
    expect(dist).toBeLessThan(0.405);
  });

  it("成桥持距:靠得太近的成桥对被双侧弹簧推开到 restLen 附近(最小净间距)", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops, 0.02, 0.02, 0.002); // 成桥瞬距 0.042 < rest 下限 → 受压推开
    floatPair(drops);
    const d = drops.state;
    for (let s = 0; s < Math.round(2.0 / DT); s++) {
      bridges.step(DT);
      integrate(drops, DT);
    }
    expect(bridges.state.count).toBe(1);
    const rest = bridges.state.restLen[0]!;
    const dist = Math.hypot(d.x[1]! - d.x[0]!, d.y[1]! - d.y[0]!);
    expect(dist).toBeGreaterThan(rest - 0.002);
    expect(dist).toBeLessThan(rest + 0.002);
    // 净间距可见:dist − rSum ≥ 0.8·bridgeRestGap·rSum(不再贴合)
    expect(dist - (d.r[0]! + d.r[1]!)).toBeGreaterThan(
      0.8 * defaultParams.bridgeRestGap * (d.r[0]! + d.r[1]!),
    );
  });

  it("断桥防抖(侵入路径):侵入断桥后 pending 清零,冷却结束不会瞬间重桥(需重新累计 drainTime)", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops, 0.028, 0.028); // 长桥留侵入空间
    floatPair(drops);
    for (let s = 0; s < 40; s++) bridges.step(DT);
    expect(bridges.state.count).toBe(1);
    const d = drops.state;
    // 第三滴压上桥轴;cooldown 阻止它与两端成新桥,单独验证侵入断桥
    drops.spawn(0.5, 0.5, 0.1, 0.01);
    drops.update(DT);
    d.floating[2] = 1;
    d.d[2] = d.dStar[2]!;
    d.cooldown[2] = 1.0;
    for (let s = 0; s < Math.round(0.5 / DT); s++) bridges.step(DT);
    expect(bridges.state.count).toBe(0); // grace(0.2s)后断桥
    // 第三滴移走 → 胶囊不再被占据;手动递减 cooldown(真实管线由 pairs.step 负责)
    drops.removeAt(2);
    const decay = (): void => {
      const dd = drops.state;
      for (let m = 0; m < dd.count; m++) {
        if (dd.cooldown[m]! > 0) {
          dd.cooldown[m] = Math.max(0, dd.cooldown[m]! - DT);
        }
      }
    };
    // 0.30s 时仍未重桥(冷却 0.25s + 重新累计 drainTime 0.08s = 0.33s 才会重桥)
    for (let s = 0; s < Math.round(0.3 / DT); s++) {
      bridges.step(DT);
      decay();
    }
    expect(bridges.state.count).toBe(0);
    // 0.45s(> 0.33s)→ 已凭新鲜计时重桥
    for (let s = 0; s < Math.round(0.15 / DT); s++) {
      bridges.step(DT);
      decay();
    }
    expect(bridges.state.count).toBe(1);
  });

  it("mergeEnabled=true 时不成桥(聚合模式独占 drainTime 语义)", () => {
    const p: WaterSimParams = { ...defaultParams, mergeEnabled: true };
    const { drops, bridges } = makeSys(p);
    spawnPair(drops);
    floatPair(drops);
    for (let s = 0; s < 200; s++) bridges.step(DT);
    expect(bridges.state.count).toBe(0);
  });

  it("桥轴胶囊被第三方液滴占据 → 拒绝成桥(用户 bug 的设计答案:生成前排斥)", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops);
    floatPair(drops);
    // 第三滴骑在两滴连线上(间隙中央);cooldown 阻止它与两端合法成桥,
    // 从而单独验证「胶囊排斥」本身
    drops.spawn(0.5, 0.5, 0.1, 0.012);
    drops.update(DT);
    drops.state.floating[2] = 1;
    drops.state.d[2] = drops.state.dStar[2]!;
    drops.state.cooldown[2] = 1.0;
    for (let s = 0; s < 200; s++) bridges.step(DT);
    expect(bridges.state.count).toBe(0);
  });
});

describe("watersim/bridges 液桥力学", () => {
  it("张力:拉伸的桥把液滴拉回(restLen 附近),幅度 < 断桥阈不破", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops);
    floatPair(drops);
    for (let s = 0; s < 40; s++) {
      bridges.step(DT);
      integrate(drops, DT);
    }
    expect(bridges.state.count).toBe(1);
    // 拖远一颗(未超 breakStretch)
    const d = drops.state;
    const rest = bridges.state.restLen[0]!;
    d.x[1] = d.x[1]! + rest * 0.3;
    d.vx[1] = 0;
    d.vx[0] = 0;
    for (let s = 0; s < Math.round(1.5 / DT); s++) {
      bridges.step(DT);
      integrate(drops, DT); // 桥只产出力;位置积分由调用方(液滴系统)做
    }
    const dist = Math.hypot(d.x[1]! - d.x[0]!, d.y[1]! - d.y[0]!);
    expect(dist).toBeLessThan(rest * 1.15); // 明显回拉
    expect(bridges.state.count).toBe(1);
  });

  it("拉伸不断裂(连接语义,第三批②修订):拖远到 3×restLen 桥仍保持", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops);
    floatPair(drops);
    for (let s = 0; s < 40; s++) bridges.step(DT);
    expect(bridges.state.count).toBe(1);
    const d = drops.state;
    d.x[1] = d.x[1]! + bridges.state.restLen[0]! * 2.0; // ~3× restLen
    for (let s = 0; s < Math.round(1.0 / DT); s++) bridges.step(DT);
    expect(bridges.state.count).toBe(1); // 不断裂(断桥唯一途径 = 侵入)
  });

  it("拖拽期张力单侧:被拖端不受桥力(阻力同无桥),只牵拉未被拖的一端", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops, 0.02, 0.02, 0.01);
    floatPair(drops);
    for (let s = 0; s < 40; s++) bridges.step(DT);
    expect(bridges.state.count).toBe(1);
    const d = drops.state;
    // 拉开(拉伸态)并标记 0 号被拖;清零速度观察单侧作用
    d.x[1] = d.x[1]! + 0.06;
    d.vx[0] = 0;
    d.vx[1] = 0;
    d.drag[0] = 1;
    bridges.step(DT);
    // 被拖端(0):速度不变(手主导,桥零阻力)
    expect(d.vx[0]!).toBe(0);
    // 牵连端(1):受拉向 0 号(负 x 方向)
    expect(d.vx[1]!).toBeLessThan(0);
    d.drag[0] = 0;
  });

  it("rebaseRestLengths:重锚定释放后桥长重定为当前距离(连接吸收距离变化)", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops, 0.02, 0.02, 0.01);
    floatPair(drops);
    for (let s = 0; s < 40; s++) bridges.step(DT);
    const d = drops.state;
    d.x[1] = d.x[1]! + 0.1; // 拖拽把两滴拉开 0.1m
    const dist = Math.hypot(d.x[1]! - d.x[0]!, d.y[1]! - d.y[0]!);
    bridges.rebaseRestLengths(0);
    expect(bridges.state.restLen[0]!).toBeCloseTo(dist, 4); // > 持距下限 → 取当前距
  });

  it("生存期侵入复检:成桥后第三方压上桥轴,超过 grace → 断桥", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops, 0.028, 0.028); // 长桥(间隙 2mm),留侵入空间
    floatPair(drops);
    for (let s = 0; s < 40; s++) bridges.step(DT);
    expect(bridges.state.count).toBe(1);
    // 第三滴压到桥轴中央;cooldown 阻止它与两端成新桥,单独验证「复检断桥」
    drops.spawn(0.5, 0.5, 0.1, 0.01);
    drops.update(DT);
    drops.state.floating[2] = 1;
    drops.state.d[2] = drops.state.dStar[2]!;
    drops.state.cooldown[2] = 1.0;
    for (let s = 0; s < Math.round(0.5 / DT); s++) bridges.step(DT);
    expect(bridges.state.count).toBe(0); // grace(0.2s)后断桥
  });
});

describe("watersim/bridges 液桥流动", () => {
  it("体积从小滴流向大滴(Laplace 压差),总体积守恒", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops, 0.015, 0.028, 0.004);
    floatPair(drops);
    for (let s = 0; s < 40; s++) bridges.step(DT);
    expect(bridges.state.count).toBe(1);
    const d = drops.state;
    const v0 =
      (4 / 3) * Math.PI * (d.r[0]! ** 3 + d.r[1]! ** 3);
    for (let s = 0; s < Math.round(20 / DT); s++) bridges.step(DT);
    const v1 =
      (4 / 3) * Math.PI * (d.r[0]! ** 3 + d.r[1]! ** 3);
    expect(d.r[1]!).toBeGreaterThan(0.028); // 大滴更大(小→大流动)
    // 体积守恒:构造上守恒,断言容忍 Float32 半径存储的累计舍入(<0.1%)
    expect(Math.abs(v1 - v0) / v0).toBeLessThan(0.001);
    // 慢流动:20s 内不得把小滴抽干(风格化慢速率)
    expect(d.r[0]!).toBeGreaterThan(0.01);
  });

  it("流量记号供渲染粒子取用(方向:小→大)", () => {
    const { drops, bridges } = makeSys();
    spawnPair(drops, 0.015, 0.028, 0.004);
    floatPair(drops);
    for (let s = 0; s < 40; s++) bridges.step(DT);
    expect(bridges.flowRate[0]!).toBeGreaterThan(0); // a(小)→ b(大)
  });
});

describe("watersim/bridges 索引重映射(交换删除一致性)", () => {
  it("removeAt 语义镜像:endpoint=i → last,endpoint=last → i", () => {
    const { drops, bridges } = makeSys();
    drops.spawn(0.3, 0.3, 0.1, 0.02);
    drops.spawn(0.7, 0.7, 0.1, 0.02);
    drops.spawn(0.4, 0.6, 0.1, 0.02);
    drops.spawn(0.6, 0.4, 0.1, 0.02);
    // 手工建两座桥:(0,1) 与 (2,3)
    bridges.state.count = 2;
    bridges.state.a[0] = 0;
    bridges.state.b[0] = 1;
    bridges.state.restLen[0] = 0.1;
    bridges.state.a[1] = 2;
    bridges.state.b[1] = 3;
    bridges.state.restLen[1] = 0.1;
    // 删除 1 号(交换删除:last=3 → 1)
    drops.removeAt(1);
    bridges.remapOnRemove(1);
    expect(bridges.state.count).toBe(1);
    // 原 (0,1) 端点 1 已消失 → 桥销毁;原 (2,3) 重映射为 (2,1)
    expect(bridges.state.a[0]).toBe(2);
    expect(bridges.state.b[0]).toBe(1);
  });
});
