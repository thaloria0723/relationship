import { describe, expect, it } from "vitest";
import { defaultParams } from "../watersim/params";
import { WaterEngine } from "../watersim/engine";

const DT = defaultParams.dt;

/** 出生即漂浮的滴(首步完成入水转换) */
function spawnAtRest(e: WaterEngine, x: number, y: number, r = 0.02): void {
  e.spawnDroplet(x, y, e.field.totalHeight(x, y) + r - 1e-4, r);
}

describe("引擎意图 API · 特性① 悬停水面微弱涟漪", () => {
  it("指针悬停处周期注入微源:峰深亚毫米级、有界", () => {
    const e = new WaterEngine(defaultParams);
    e.setWaterHover(true, 0.5, 0.5);
    for (let s = 0; s < Math.round(0.5 / DT); s++) e.stepFixed();
    const { N, dx } = e.field;
    const ci = Math.round(0.5 / dx);
    const h = e.field.state.h[ci * N + ci]!;
    // 连续注入后中心相位正负交替,断言「存在毫米以下但可观测的波纹」
    expect(Math.abs(h)).toBeGreaterThan(2e-4);
    expect(h).toBeGreaterThan(-0.003); // 微弱(远小于弹坑/戳点)
    e.setWaterHover(false, 0, 0);
    const e0 = e.field.energy();
    for (let s = 0; s < Math.round(1 / DT); s++) e.stepFixed();
    expect(e.field.energy()).toBeLessThan(e0); // 取消后衰减(无持续源)
  });
});

describe("引擎意图 API · 特性② 悬停液滴浮出水面", () => {
  it("升力使液滴中心升至水面之上,且波纹增强耦合有输出", () => {
    const e = new WaterEngine(defaultParams);
    spawnAtRest(e, 0.5, 0.5);
    for (let s = 0; s < Math.round(0.3 / DT); s++) e.stepFixed();
    const zBefore = e.droplets.state.z[0]!;
    e.setDropletHover(0);
    for (let s = 0; s < Math.round(1.0 / DT); s++) e.stepFixed();
    const zAfter = e.droplets.state.z[0]!;
    expect(zAfter).toBeGreaterThan(zBefore + 0.003); // 明显浮起(>3mm)
    expect(zAfter).toBeGreaterThan(0); // 中心越过水面线
    expect(e.field.energy()).toBeGreaterThan(0); // Δ浸深耦合辐射波纹
    e.setDropletHover(-1);
    for (let s = 0; s < Math.round(2 / DT); s++) e.stepFixed();
    expect(e.droplets.state.z[0]!).toBeLessThan(0); // 回落
  });
});

describe("引擎意图 API · 特性③ 拖拽与缓慢回弹", () => {
  it("快拖(<1s)松手 → 缓慢弹回抓取位(规格③)", () => {
    const e = new WaterEngine(defaultParams);
    spawnAtRest(e, 0.4, 0.5);
    for (let s = 0; s < 10; s++) e.stepFixed();
    const homeX = e.droplets.state.x[0]!;
    e.beginDrag(0, 0.55, 0.5);
    e.moveDrag(0.55, 0.5);
    for (let s = 0; s < Math.round(0.5 / DT); s++) e.stepFixed(); // 拖住 0.5s < 1s
    expect(Math.abs(e.droplets.state.x[0]! - 0.55)).toBeLessThan(0.01); // 跟随指针
    e.endDrag();
    let passedHome = false;
    for (let s = 0; s < Math.round(5 / DT); s++) {
      e.stepFixed();
      if (Math.abs(e.droplets.state.x[0]! - homeX) < 0.003) passedHome = true; // 弹回经过原位
    }
    expect(passedHome).toBe(true); // 欠阻尼回弹经过抓取位
    expect(e.droplets.state.returning[0]).toBe(0); // 回弹完成(锚点迁至原位)
    // 回弹完成后:钉扎半径内自由漂移(§12.2),残余波场上允许 ±1.5cm
    expect(Math.abs(e.droplets.state.x[0]! - homeX)).toBeLessThan(0.015);
  });

  it("拖住 ≥1s 松手 → 重锚定在松手处(关系网可布置)", () => {
    const e = new WaterEngine(defaultParams);
    spawnAtRest(e, 0.4, 0.5);
    for (let s = 0; s < 10; s++) e.stepFixed();
    e.beginDrag(0, 0.55, 0.5);
    e.moveDrag(0.55, 0.5);
    for (let s = 0; s < Math.round(1.2 / DT); s++) e.stepFixed(); // 拖住 1.2s ≥ 1s
    expect(Math.abs(e.droplets.state.x[0]! - 0.55)).toBeLessThan(0.01);
    e.endDrag();
    expect(e.droplets.state.returning[0]).toBe(0); // 不回弹
    for (let s = 0; s < Math.round(3 / DT); s++) e.stepFixed();
    expect(Math.abs(e.droplets.state.x[0]! - 0.55)).toBeLessThan(0.02); // 留在原地
    expect(e.droplets.state.anchorX[0]!).toBeCloseTo(e.droplets.state.x[0]!, 1); // 锚点已迁移
  });
});

describe("引擎意图 API · 特性④ 焦点模式(悬浮+切桥)", () => {
  function setupChain(): WaterEngine {
    const e = new WaterEngine(defaultParams);
    // 链:0-1、1-2 间隙 3mm → drainTime 后两桥成
    spawnAtRest(e, 0.42, 0.5);
    spawnAtRest(e, 0.42 + 0.043, 0.5);
    spawnAtRest(e, 0.42 + 0.086, 0.5);
    for (let s = 0; s < Math.round(0.5 / DT); s++) e.stepFixed();
    return e;
  }

  it("enterFocus:分组 = 自身∪直连邻居;组内悬浮;跨组桥切断", () => {
    const e = setupChain();
    expect(e.bridges.state.count).toBe(2);
    const group = e.enterFocus(0);
    expect(group).toHaveLength(2); // {0} ∪ {1}
    const d = e.droplets.state;
    expect(d.lev[0]).toBe(1);
    expect(d.lev[1]).toBe(1);
    expect(d.lev[2]).toBe(0);
    // 悬浮生效:组内滴升到水面之上
    for (let s = 0; s < Math.round(1 / DT); s++) e.stepFixed();
    expect(d.z[0]!).toBeGreaterThan(d.r[0]!); // 中心高于 r ⇒ 底部离水
    // 桥(0,1) 组内保留;(1,2) 跨组切断
    const b0 = e.bridges.pairBridged(0, 1);
    const b1 = e.bridges.pairBridged(1, 2);
    expect(e.bridges.state.cut[b0!]).toBe(0);
    expect(e.bridges.state.cut[b1!]).toBe(1);
    e.exitFocus();
    expect(d.lev[0]).toBe(0);
    expect(d.lev[1]).toBe(0);
    expect(d.floating[0]).toBe(0); // 改走坠落,重新入水触发溅落
    // 第五批:断桥恢复移至退场编舞收尾(成员曲线回位完成后),而非退出瞬间
    for (let s = 0; s < Math.round(2.0 / DT); s++) e.stepFixed();
    expect(e.bridges.state.cut[b0!]).toBe(0);
    expect(e.bridges.state.cut[b1!]).toBe(0);
  });

  it("焦点期间确定性与稳定:悬浮 5s 无 NaN、场面有界", () => {
    const e = setupChain();
    e.enterFocus(0);
    let maxH = 0;
    for (let s = 0; s < Math.round(5 / DT); s++) {
      e.stepFixed();
      if (s % 25 === 0) maxH = Math.max(maxH, e.field.maxAbsH());
    }
    expect(Number.isFinite(maxH)).toBe(true);
    expect(maxH).toBeLessThan(0.2);
    expect(e.droplets.state.lev[0]).toBe(1);
  });
});
