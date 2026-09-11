// ============================================================
// 焦点模式(第五批,2026-09-07):等长环 + 顺时针旋转 + 圈状涟漪 + 退场编舞。
// 委托方需求(2026-09-07):
//   1) 聚焦:中心滴正中(相机拟合在 viewer 侧);与中心相连的液桥长度强行一致;
//   2) 聚焦期:中心滴下方周期圈状涟漪;包围圈除 spoke 外的液桥全部暂时断裂;
//      包围圈液滴绕中心缓缓顺时针(俯视)转动;
//   3) 退出:中心滴自由落体回首次落点;成员曲线回各自首次落点;暂时断桥恢复。
// 坐标约定:engine 平面 (x, y);viewer 把 y 映到世界 Z、相机自 +Y 俯视,
// 故 engine 平面逆时针 = 屏幕俯视顺时针(focusOrbitOmega > 0 即顺时针)。
// ============================================================
import { describe, expect, it } from "vitest";
import { defaultParams } from "./params";
import { WaterEngine } from "./engine";

const DT = defaultParams.dt;
const OMEGA = defaultParams.focusOrbitOmega;

function spawnAtRest(e: WaterEngine, x: number, y: number, r = 0.02): void {
  e.spawnDroplet(x, y, e.field.totalHeight(x, y) + r - 1e-4, r);
}

function runFor(e: WaterEngine, sec: number): void {
  const n = Math.round(sec / DT);
  for (let s = 0; s < n; s++) e.stepFixed();
}

/** 星形场景:中心 0(大滴)+ 三个不等距邻居(东 0.06 / 北 0.08 / 西南 0.10) */
function spawnStar(e: WaterEngine): void {
  spawnAtRest(e, 0.5, 0.5, 0.024);
  spawnAtRest(e, 0.56, 0.5, 0.016);
  spawnAtRest(e, 0.5, 0.58, 0.016);
  spawnAtRest(e, 0.42, 0.44, 0.016);
}

/** 三角形场景:0-1-2 全连(切桥/恢复语义用) */
function spawnTriangle(e: WaterEngine): void {
  spawnAtRest(e, 0.5, 0.5, 0.02);
  spawnAtRest(e, 0.56, 0.5, 0.016);
  spawnAtRest(e, 0.5, 0.565, 0.016);
}

function angleOf(e: WaterEngine, m: number, c: number): number {
  const d = e.droplets.state;
  return Math.atan2(d.y[m]! - d.y[c]!, d.x[m]! - d.x[c]!);
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

describe("聚焦 · 需求1:进入聚焦 spoke 液桥长度强行一致", () => {
  it("直连桥 restLen 全部相等且 = 等长环半径;包围圈内部桥暂时切断", () => {
    const e = new WaterEngine(defaultParams);
    spawnStar(e);
    runFor(e, 0.6);
    // 星形布点预期成桥:3 条 spoke + 1-2、2-3(1-3 轴被中心滴胶囊排斥)
    expect(e.bridges.pairBridged(0, 1)).toBeGreaterThanOrEqual(0);
    expect(e.bridges.pairBridged(0, 2)).toBeGreaterThanOrEqual(0);
    expect(e.bridges.pairBridged(0, 3)).toBeGreaterThanOrEqual(0);
    expect(e.bridges.pairBridged(1, 2)).toBeGreaterThanOrEqual(0);
    expect(e.bridges.pairBridged(2, 3)).toBeGreaterThanOrEqual(0);

    const group = e.enterFocus(0);
    expect(group).toHaveLength(4);
    expect(e.getFocusCenter()).toBe(0);
    const L = e.getFocusRingLen();
    expect(L).toBeGreaterThan(0.095); // 最长 spoke(0.10)决定等长值
    expect(L).toBeLessThan(0.115);
    for (const [i, j] of [[0, 1], [0, 2], [0, 3]] as const) {
      const k = e.bridges.pairBridged(i, j)!;
      expect(e.bridges.state.restLen[k]).toBeCloseTo(L, 5);
      expect(e.bridges.state.cut[k]).toBe(0); // spoke 保留
    }
    // 包围圈液滴之间的桥(非 spoke)全部暂时断裂
    expect(e.bridges.state.cut[e.bridges.pairBridged(1, 2)!]).toBe(1);
    expect(e.bridges.state.cut[e.bridges.pairBridged(2, 3)!]).toBe(1);
  });
});

describe("聚焦 · 需求2:顺时针旋转 / 中心圈状涟漪 / 聚焦期冻结", () => {
  it("包围圈绕中心匀角速旋转(engine 平面逆时针 = 俯视顺时针),半径收敛到 L,中心不动", () => {
    const e = new WaterEngine(defaultParams);
    spawnStar(e);
    runFor(e, 0.6);
    e.enterFocus(0);
    const L = e.getFocusRingLen();
    const th0 = [angleOf(e, 1, 0), angleOf(e, 2, 0), angleOf(e, 3, 0)];
    const cx0 = e.droplets.state.x[0]!;
    const cy0 = e.droplets.state.y[0]!;
    const T = 3;
    runFor(e, T);
    const d = e.droplets.state;
    // 中心滴聚焦期水平不动(相机「正中」的前提)
    expect(Math.abs(d.x[0]! - cx0)).toBeLessThan(1e-3);
    expect(Math.abs(d.y[0]! - cy0)).toBeLessThan(1e-3);
    [1, 2, 3].forEach((m, n) => {
      const dth = wrapPi(angleOf(e, m, 0) - th0[n]!);
      expect(dth).toBeGreaterThan(OMEGA * T * 0.9); // 方向为正 = 俯视顺时针
      expect(dth).toBeLessThan(OMEGA * T * 1.1);
      const r = Math.hypot(d.x[m]! - d.x[0]!, d.y[m]! - d.y[0]!);
      expect(Math.abs(r - L)).toBeLessThan(0.003); // 收敛到等长环
    });
  });

  it("聚焦期中心下方持续受激圈状涟漪(对照:不聚焦同场景静默)", () => {
    // 单滴无桥场景;双方先等长预沉降(入水瞬态衰减),再对照 1s 观测窗
    const windowMax = (e: WaterEngine): number => {
      let m = 0;
      for (let s = 0; s < Math.round(1.0 / DT); s++) {
        e.stepFixed();
        if (s % 4 === 0) m = Math.max(m, e.field.maxAbsH());
      }
      return m;
    };
    const focus = new WaterEngine(defaultParams);
    spawnAtRest(focus, 0.5, 0.5, 0.024);
    runFor(focus, 2.5);
    focus.enterFocus(0);
    const hFocus = windowMax(focus);

    const base = new WaterEngine(defaultParams);
    spawnAtRest(base, 0.5, 0.5, 0.024);
    runFor(base, 2.5);
    const hBase = windowMax(base);

    expect(hFocus).toBeGreaterThan(1e-3); // 注入尖峰 ~2.5e-3
    expect(hFocus).toBeGreaterThan(5 * Math.max(hBase, 1e-6));
  });

  it("聚焦期成桥扫描冻结(不形成新桥),退出收尾后恢复扫描", () => {
    const e = new WaterEngine(defaultParams);
    spawnAtRest(e, 0.3, 0.3, 0.02);
    runFor(e, 0.3);
    e.enterFocus(0);
    spawnAtRest(e, 0.7, 0.7, 0.016);
    spawnAtRest(e, 0.742, 0.7, 0.016);
    runFor(e, 1.0);
    expect(e.bridges.pairBridged(1, 2)).toBe(-1); // 聚焦期冻结
    e.exitFocus();
    runFor(e, 0.6);
    expect(e.bridges.pairBridged(1, 2)).toBeGreaterThanOrEqual(0); // 恢复
  });
});

describe("聚焦 · 需求3:退出编舞(自由落体 + 曲线回位 + 断桥恢复)", () => {
  it("中心自由落体回首落点;成员曲线回各自锚点;cut 桥恢复、spoke 桥长还原", () => {
    const e = new WaterEngine(defaultParams);
    spawnStar(e);
    runFor(e, 0.6);
    e.enterFocus(0);
    runFor(e, 2.5);
    const d = e.droplets.state;
    // 成员已被转到等长环上,离开各自锚点
    const start1 = { x: d.x[1]!, y: d.y[1]! };
    const anchor1 = { x: d.anchorX[1]!, y: d.anchorY[1]! };
    expect(Math.hypot(start1.x - anchor1.x, start1.y - anchor1.y)).toBeGreaterThan(0.02);
    const restBefore = e.bridges.state.restLen[e.bridges.pairBridged(0, 1)!]!;

    e.exitFocus();
    expect(d.floating[0]).toBe(0); // 中心立即改走空中段(自由落体)
    expect(d.lev[0]).toBe(0);

    // 曲线运动反证:半程位置显著偏离「起点-锚点」弦中点(直线回位则重合)
    runFor(e, 0.5 * defaultParams.focusReturnDur);
    const chordMid = {
      x: (start1.x + anchor1.x) / 2,
      y: (start1.y + anchor1.y) / 2,
    };
    const dev = Math.hypot(d.x[1]! - chordMid.x, d.y[1]! - chordMid.y);
    expect(dev).toBeGreaterThan(0.005);

    // 曲线终点语义:97% 进度(尚离水,无落水波场干扰)时水平位置已收敛到锚点
    // (前面半程检查已消耗 0.5·dur,这里只补差量)
    runFor(e, 0.47 * defaultParams.focusReturnDur);
    for (const m of [1, 2, 3]) {
      expect(d.curve[m]).toBe(1); // 仍在编舞中
      expect(Math.hypot(d.x[m]! - d.anchorX[m]!, d.y[m]! - d.anchorY[m]!)).toBeLessThan(0.002);
    }
    // 落水完成:全员恢复漂浮态;中心停在首次落点(毫米级偏差 = 退出前涟漪波场的真实推挤)
    runFor(e, 0.06 * defaultParams.focusReturnDur + 0.02);
    expect(d.floating[0]).toBe(1);
    expect(Math.hypot(d.x[0]! - d.anchorX[0]!, d.y[0]! - d.anchorY[0]!)).toBeLessThan(0.004);
    for (const m of [1, 2, 3]) {
      expect(d.floating[m]).toBe(1);
      expect(d.curve[m]).toBe(0);
    }
    // 断桥恢复、spoke 桥长还原为聚焦前持距
    expect(e.bridges.state.cut[e.bridges.pairBridged(1, 2)!]).toBe(0);
    const k01 = e.bridges.pairBridged(0, 1)!;
    expect(e.bridges.state.restLen[k01]).toBeLessThan(restBefore); // ≠ 等长 L,已还原
    expect(e.bridges.state.restLen[k01]).toBeGreaterThan(0.075); // ≈ 持距下限 0.08
    // 网络弛豫后:桥网完整;位置仍在锚点邻域(多重桥持距下限推挤是连接语义
    // 固有物理,聚焦前网络平衡态同样偏离锚点这一量级)
    runFor(e, 3.0);
    expect(e.bridges.state.count).toBeGreaterThanOrEqual(5);
    for (const m of [0, 1, 2, 3]) {
      expect(
        Math.hypot(d.x[m]! - d.anchorX[m]!, d.y[m]! - d.anchorY[m]!),
      ).toBeLessThan(0.025);
    }
  });

  it("退场中重进聚焦:强制收尾后重新分组,全程无 NaN、桥网完整", () => {
    const e = new WaterEngine(defaultParams);
    spawnTriangle(e);
    runFor(e, 0.6);
    expect(e.bridges.state.count).toBe(3);
    e.enterFocus(0);
    runFor(e, 0.3);
    e.exitFocus();
    runFor(e, 0.3); // 曲线半途
    e.enterFocus(0); // 触发强制收尾 + 重新聚焦
    runFor(e, 2);
    const d = e.droplets.state;
    for (let i = 0; i < d.count; i++) {
      expect(Number.isFinite(d.x[i])).toBe(true);
      expect(Number.isFinite(d.z[i])).toBe(true);
    }
    expect(e.bridges.state.count).toBe(3); // 桥网完整(编舞不破坏桥)
    expect(d.lev[1]).toBe(1);
    expect(d.lev[2]).toBe(1);
    e.exitFocus();
    runFor(e, 2.4);
    expect(e.bridges.state.count).toBe(3);
    expect(e.bridges.state.cut[e.bridges.pairBridged(1, 2)!]).toBe(0);
    expect(e.droplets.state.floating[0]).toBe(1);
  });
});
