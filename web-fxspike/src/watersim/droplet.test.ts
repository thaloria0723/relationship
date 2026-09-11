import { describe, expect, it } from "vitest";
import { defaultParams } from "./params";
import { WaterField, submergenceVolume, solveEquilibriumDepth } from "./field";
import { DropletSystem } from "./droplet";
import { WaterEngine } from "./engine";

const DT = defaultParams.dt;

function steps(f: WaterField, n: number): void {
  for (let s = 0; s < n; s++) f.step(DT);
}

/** 直接构造一个已漂浮的液滴(落在水面上,立即完成入水转换) */
function spawnFloating(sys: DropletSystem, x: number, y: number, r: number): void {
  const z = sys.field.totalHeight(x, y) + r - 0.002; // 底部略插入水面
  expect(sys.spawn(x, y, z, r)).toBe(true);
  sys.update(DT);
}

describe("watersim/droplet 浮力解析(§8)", () => {
  it("平衡浸深满足 ρ_w·V(d*) = ρ_d·V_R(残差 <1e-9)", () => {
    for (const ratio of [0.3, 0.6, 0.95] as const) {
      for (const r of [defaultParams.rMin, 0.018, defaultParams.rMax]) {
        const dStar = solveEquilibriumDepth(r, ratio);
        const vR = (4 / 3) * Math.PI * r * r * r;
        const residual = submergenceVolume(dStar, r) / vR - ratio;
        expect(Math.abs(residual)).toBeLessThan(1e-9);
        expect(dStar).toBeGreaterThan(0);
        expect(dStar).toBeLessThan(2 * r);
      }
    }
  });

  it("密度比越大浸得越深;ratio=0.95 时 d* ≈ 1.73R(近全浸)", () => {
    const dLow = solveEquilibriumDepth(0.02, 0.3);
    const dHigh = solveEquilibriumDepth(0.02, 0.95);
    expect(dHigh).toBeGreaterThan(dLow);
    // V(1.73R) = 1.268πR³ = 0.95·(4/3)πR³ ✓
    expect(dHigh).toBeCloseTo(1.73 * 0.02, 4);
    expect(dLow).toBeLessThan(0.8 * 0.02);
  });
});

describe("watersim/field 准静态凹陷核(§8 排水体积不变量)", () => {
  it("核积分 = −V_sub(网格离散积分,±10%;σ₁≈4 格的离散误差,解析合同由 α−β=1 保证)", () => {
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
        const total = f.totalHeight(i * dx, j * dx);
        integral += (total - state.h[k]!) * dx * dx;
      }
    }
    const vSub = submergenceVolume(d, r);
    expect(Math.abs(integral + vSub) / vSub).toBeLessThan(0.10);
  });

  it("浸深越大凹陷越深;无核时 totalHeight ≡ h", () => {
    const f = new WaterField(defaultParams);
    const r = 0.02;
    const dSmall = 0.5 * r;
    const dBig = 1.5 * r;
    f.setKernelCount(1);
    f.setKernel(0, 0.5, 0.5, r, dBig);
    const deepCenter = f.totalHeight(0.5, 0.5) - f.state.h[(128 * 256 + 128)!]!;
    f.setKernel(0, 0.5, 0.5, r, dSmall);
    const shallowCenter = f.totalHeight(0.5, 0.5) - f.state.h[(128 * 256 + 128)!]!;
    expect(deepCenter).toBeLessThan(shallowCenter);
    expect(shallowCenter).toBeLessThan(0);
    f.setKernelCount(0);
    expect(f.totalHeight(0.5, 0.5)).toBeCloseTo(f.state.h[(128 * 256 + 128)!]!, 12);
  });
});

describe("watersim/droplet 空中段与入水", () => {
  it("自由落体:v = gt,z 与解析解一致(半隐式 Euler 误差内)", () => {
    const f = new WaterField(defaultParams);
    const sys = new DropletSystem(defaultParams, f);
    sys.spawn(0.5, 0.5, 0.15 + 0.02, 0.02); // 中心高度:底部离水面 0.15m
    const n = 15; // 0.1s
    for (let s = 0; s < n; s++) sys.update(DT);
    const t = n * DT;
    const d = sys.state;
    expect(d.floating[0]).toBe(0);
    expect(d.vz[0]!).toBeCloseTo(-defaultParams.gravity * t, 6);
    // 半隐式 Euler:z = z0 − g·dt²·n(n+1)/2
    const zExpect = 0.17 - defaultParams.gravity * DT * DT * (n * (n + 1)) / 2;
    expect(d.z[0]!).toBeCloseTo(zExpect, 6);
  });

  it("入水转换:计数+1、凹陷源注入、d 向 d* 弛豫(5τ_b 后误差 <10%)", () => {
    const engine = new WaterEngine(defaultParams);
    const r = 0.02;
    engine.spawnDroplet(0.5, 0.5, 0.15 + r, r);
    // 落地时间 ≈ √(2·0.15/g) ≈ 0.175s → 27 步,取 40 步余量
    for (let s = 0; s < 40; s++) engine.stepFixed();
    expect(engine.stats.impacts).toBe(1);
    expect(engine.droplets.state.floating[0]).toBe(1);
    // 入水冲量:落点附近 h < 0(溅落凹陷)
    const { N, dx } = engine.field;
    const ci = Math.round(0.5 / dx);
    expect(engine.field.state.h[ci * N + ci]!).toBeLessThan(0);
    // 弛豫:10·τ_b = 0.3s → 45 步
    for (let s = 0; s < 45; s++) engine.stepFixed();
    const d = engine.droplets.state.d[0]!;
    const dStar = engine.droplets.state.dStar[0]!;
    expect(Math.abs(d - dStar) / dStar).toBeLessThan(0.1);
  });

  it("maxDroplets 上限:超限拒收", () => {
    const f = new WaterField(defaultParams);
    const sys = new DropletSystem(defaultParams, f);
    const r = 0.01;
    for (let k = 0; k < defaultParams.maxDroplets; k++) {
      expect(sys.spawn(0.3 + 0.001 * k, 0.5, 0.5, r)).toBe(true);
    }
    expect(sys.spawn(0.7, 0.5, 0.5, r)).toBe(false);
  });
});

describe("watersim/droplet 坡度漂移(耦合链末环:波推液滴)", () => {
  it("漂浮滴向邻近凹陷下滑(F = −g_flow·V_sub·∇h),但漂移有界、波停后回到落点(调优第三批 #2)", () => {
    const engine = new WaterEngine(defaultParams);
    const r = defaultParams.rMin;
    const x0 = 0.35;
    spawnFloating(engine.droplets, x0, 0.5, r);
    // 右侧 25cm 处挖一个深凹(静态液面坡指向凹点)
    engine.addImpulse(0.6, 0.5, 0.03, -0.03);
    let maxX = x0;
    for (let s = 0; s < Math.round(5.0 / DT); s++) {
      engine.stepFixed();
      maxX = Math.max(maxX, engine.droplets.state.x[0]!);
    }
    // 方向:坡度响应仍存在(向凹点移动过)
    expect(maxX).toBeGreaterThan(x0);
    // 有界:不再乱飘(超出 pinRadius 即被钉扎+回位弹簧约束)
    expect(maxX - x0).toBeLessThan(defaultParams.pinRadius);
    // 回位:波幅衰减后回到初始落点附近(<4mm)
    const xEnd = engine.droplets.state.x[0]!;
    expect(Math.abs(xEnd - x0)).toBeLessThan(0.004);
    expect(Number.isFinite(xEnd)).toBe(true);
  });

  it("静水中漂浮滴位置稳定(无源则无漂移)", () => {
    const engine = new WaterEngine(defaultParams);
    const r = defaultParams.rMin;
    spawnFloating(engine.droplets, 0.5, 0.5, r);
    for (let s = 0; s < Math.round(1.0 / DT); s++) engine.stepFixed();
    const d = engine.droplets.state;
    expect(Math.abs(d.x[0]! - 0.5)).toBeLessThan(1e-4);
    expect(Math.abs(d.y[0]! - 0.5)).toBeLessThan(1e-4);
  });
});

describe("watersim/droplet 漂移治理(调优第三批 #2:乱飘/阻力低/不回落点)", () => {
  it("水平速度受漂移阻尼快速衰减(Stokes 单独 2s 后仍 ~91%,叠加阻尼后 <10%)", () => {
    const engine = new WaterEngine(defaultParams);
    spawnFloating(engine.droplets, 0.5, 0.5, 0.016);
    engine.droplets.state.vx[0] = 0.05;
    for (let s = 0; s < Math.round(2.0 / DT); s++) engine.stepFixed();
    expect(Math.abs(engine.droplets.state.vx[0]!)).toBeLessThan(0.005);
  });

  it("被挪离落点的漂浮滴自动弹回初始落点(homeK 回位弹簧)", () => {
    const engine = new WaterEngine(defaultParams);
    spawnFloating(engine.droplets, 0.5, 0.5, 0.016);
    engine.droplets.state.x[0] = 0.5 + 0.03; // 挪到落点 3cm 外
    for (let s = 0; s < Math.round(3.0 / DT); s++) engine.stepFixed();
    expect(Math.abs(engine.droplets.state.x[0]! - 0.5)).toBeLessThan(0.004);
  });
});

describe("watersim/droplet 拖拽释放(运动后弹回初始落点)", () => {
  /** 拖拽 index 0 到指定目标 dragSec 秒后释放,再推进 settleSec 秒 */
  function dragAndRelease(
    tx: number,
    dragSec: number,
    settleSec: number,
  ): number {
    const engine = new WaterEngine(defaultParams);
    spawnFloating(engine.droplets, 0.4, 0.5, 0.016);
    const drops = engine.droplets;
    drops.beginDrag(0, 0.4, 0.5);
    for (let s = 0; s < Math.round(dragSec / DT); s++) {
      drops.setDragTarget(tx, 0.5);
      engine.stepFixed();
    }
    drops.endDrag();
    for (let s = 0; s < Math.round(settleSec / DT); s++) engine.stepFixed();
    return drops.state.x[0]!;
  }

  it("快拖小幅释放 → 弹回初始落点(anchor,不再用抓取位)", () => {
    const x = dragAndRelease(0.44, 0.2, 3.0); // 拖 0.2s、挪 4cm
    expect(Math.abs(x - 0.4)).toBeLessThan(0.004);
  });

  it("拖住 ≥1s 但位移 <0.15m → 仍弹回初始落点(重锚定需同时满足大幅位移)", () => {
    const x = dragAndRelease(0.45, 1.5, 3.0); // 拖 1.5s、挪 5cm
    expect(Math.abs(x - 0.4)).toBeLessThan(0.004);
  });

  it("拖住 ≥1s 且位移 ≥0.15m → 重锚定留在松手处(用户布置关系网)", () => {
    const x = dragAndRelease(0.7, 1.5, 3.0); // 拖 1.5s、挪 30cm
    expect(Math.abs(x - 0.7)).toBeLessThan(0.004);
  });
});

describe("watersim/engine 拖拽分层阻力(第三批②:被控端自由/牵连端强阻力)", () => {
  it("拖拽被桥连接的液滴:牵连端只被轻微拽动(≤6mm),桥拉伸不断裂,重锚定后桥长吸收新距离", () => {
    const engine = new WaterEngine(defaultParams);
    spawnFloating(engine.droplets, 0.4, 0.5, 0.02);
    spawnFloating(engine.droplets, 0.5, 0.5, 0.02);
    for (let s = 0; s < Math.round(0.5 / DT); s++) engine.stepFixed();
    expect(engine.bridges.state.count).toBe(1);
    const d = engine.droplets.state;
    const x1a = d.x[1]!;
    // 拖 0 号到 0.18(位移 0.22m、1.5s ≥1s → 重锚定模式)
    engine.beginDrag(0, d.x[0]!, 0.5);
    for (let s = 0; s < Math.round(1.5 / DT); s++) {
      engine.moveDrag(0.18, 0.5);
      engine.stepFixed();
    }
    engine.endDrag();
    expect(Math.abs(d.x[1]! - x1a)).toBeLessThan(0.006); // 牵连端轻微拽动
    expect(engine.bridges.state.count).toBe(1); // 桥拉伸不断裂
    const dist = Math.abs(d.x[1]! - d.x[0]!);
    expect(dist).toBeGreaterThan(0.15); // 桥明显拉伸
    expect(engine.bridges.state.restLen[0]!).toBeCloseTo(dist, 2); // 桥长已重定
    // 之后 2s:牵连端不被继续拖向旧距离,被控端留在新位
    for (let s = 0; s < Math.round(2.0 / DT); s++) engine.stepFixed();
    expect(Math.abs(d.x[0]! - 0.18)).toBeLessThan(0.01);
    expect(Math.abs(d.x[1]! - x1a)).toBeLessThan(0.008);
  });
});

describe("watersim/engine 悬停稳定(第三批②引入;第四批收紧:贴水随动抑颤)", () => {
  it("持续悬停:升力稳定浮出(浮出量保留),稳态 z 高频颤动受贴水随动抑制(≤0.8mm)", () => {
    const engine = new WaterEngine(defaultParams);
    spawnFloating(engine.droplets, 0.5, 0.5, 0.02);
    for (let s = 0; s < Math.round(0.5 / DT); s++) engine.stepFixed();
    const zBase = engine.droplets.state.z[0]!;
    engine.setDropletHover(0);
    // 升力×耦合隆起的全程抬升约 2.5s 收敛(慢瞬态非颤动);取收敛后 2s 窗口量颤动
    for (let s = 0; s < Math.round(3.0 / DT); s++) engine.stepFixed();
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let s = 0; s < Math.round(2.0 / DT); s++) {
      engine.stepFixed();
      const z = engine.droplets.state.z[0]!;
      zMin = Math.min(zMin, z);
      zMax = Math.max(zMax, z);
    }
    // 浮出水面可见(特性②升力保留:0.78·d* ≈ 13mm,叠加悬停波纹隆起)
    expect(zMax - zBase).toBeGreaterThan(0.008);
    // 硬贴水时悬停涟漪泵(每 0.108s 一次 ~1.3mm 凹陷)使 z 以 ~9Hz 颤动
    // (稳态 p-p 实测 ~1.3mm);贴水随动(zFollowTau=0.1s)低通后 ≤0.8mm
    expect(zMax - zMin).toBeLessThan(0.0008);
  });
});

describe("watersim/droplet removeAt 字段完整性", () => {
  it("交换删除搬运全部交互字段(home/lift/drag/returning/lev 不残留被删滴的值)", () => {
    const engine = new WaterEngine(defaultParams);
    const drops = engine.droplets;
    spawnFloating(drops, 0.3, 0.3, 0.016);
    spawnFloating(drops, 0.7, 0.7, 0.016);
    spawnFloating(drops, 0.5, 0.5, 0.016);
    const d = drops.state;
    // 末滴(2 号)带全套交互状态
    d.homeX[2] = 0.9;
    d.homeY[2] = 0.8;
    d.lift[2] = 0.5;
    d.returning[2] = 1;
    d.lev[2] = 1;
    drops.removeAt(0); // last=2 换入 0
    expect(d.homeX[0]).toBeCloseTo(0.9, 6);
    expect(d.homeY[0]).toBeCloseTo(0.8, 6);
    expect(d.lift[0]).toBeCloseTo(0.5, 6);
    expect(d.returning[0]).toBe(1);
    expect(d.lev[0]).toBe(1);
  });
});

describe("watersim/engine 液滴集成", () => {
  it("确定性:同出生序列两实例 900 步,状态逐位相等", () => {
    const run = (): WaterEngine => {
      const e = new WaterEngine(defaultParams);
      const r = 0.015;
      e.spawnDroplet(0.4, 0.45, 0.15 + r, r);
      e.spawnDroplet(0.6, 0.55, 0.15 + r, r);
      for (let s = 0; s < 300; s++) {
        if (s === 150) e.spawnDroplet(0.5, 0.5, 0.2 + r, r);
        e.stepFixed();
      }
      return e;
    };
    const a = run();
    const b = run();
    const sa = a.droplets.state;
    const sb = b.droplets.state;
    expect(a.stats.impacts).toBe(3);
    expect(sa.count).toBe(3);
    const arrs = [
      sa.x, sa.y, sa.z, sa.vx, sa.vy, sa.vz, sa.r, sa.d, sa.dStar, sa.floating,
    ] as const;
    const arrsB = [
      sb.x, sb.y, sb.z, sb.vx, sb.vy, sb.vz, sb.r, sb.d, sb.dStar, sb.floating,
    ] as const;
    for (let k = 0; k < arrs.length; k++) {
      for (let i = 0; i < arrs[k]!.length; i++) {
        const va = arrs[k]![i]!;
        const vb = arrsB[k]![i]!;
        expect(va === vb || (Number.isNaN(va) && Number.isNaN(vb))).toBe(true);
      }
    }
    for (let i = 0; i < a.field.state.h.length; i++) {
      expect(a.field.state.h[i]).toBe(b.field.state.h[i]);
    }
  }, 30000);
});
