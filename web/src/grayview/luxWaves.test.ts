// ============================================================
// 环境波涛谱表与域扭曲测试(docs/水面波多方向化设计方案-2026-09-09.md)
// 守护:方向覆盖、破格上界、折叠约束、镜像一致性、GLSL 生成冒烟
// ============================================================

import { describe, expect, it } from "vitest";
import { AMBIENT_WARPS, AMBIENT_WAVES, ambientWaveHeight } from "./luxShaders";
import { LUX_SURFACE_VERT } from "./luxShaders";

const TAU = Math.PI * 2;

describe("波谱 AMBIENT_WAVES(九成分方向谱)", () => {
  it("成分数为 9", () => {
    expect(AMBIENT_WAVES.length).toBe(9);
  });

  it("波长严格递减(长涌 → 短碎波)", () => {
    for (let i = 1; i < AMBIENT_WAVES.length; i++) {
      expect(AMBIENT_WAVES[i]!.lambda).toBeLessThan(
        AMBIENT_WAVES[i - 1]!.lambda,
      );
    }
  });

  it("最短波长 ≥ 0.055m(256² 网格采样约束)", () => {
    for (const w of AMBIENT_WAVES) {
      expect(w.lambda).toBeGreaterThanOrEqual(0.055);
    }
  });

  it("方向覆盖 360°:排序后最大方向间隙 < 90°", () => {
    const degs = AMBIENT_WAVES.map((w) => ((w.dirDeg % 360) + 360) % 360).sort(
      (a, b) => a - b,
    );
    let maxGap = 0;
    for (let i = 0; i < degs.length; i++) {
      const next = degs[(i + 1) % degs.length]!;
      const gap = (next - degs[i]! + 360) % 360;
      maxGap = Math.max(maxGap, gap);
    }
    expect(maxGap).toBeLessThan(90);
  });

  it("两个最长波夹角 ≥ 120°(强交叉网)", () => {
    const a = AMBIENT_WAVES[0]!.dirDeg;
    const b = AMBIENT_WAVES[1]!.dirDeg;
    const d = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    expect(d).toBeGreaterThanOrEqual(120);
  });

  it("相速度落在 [0.28, 0.38](委托方「波浪速度减缓」裁决)", () => {
    for (const w of AMBIENT_WAVES) {
      expect(w.speed).toBeGreaterThanOrEqual(0.28);
      expect(w.speed).toBeLessThanOrEqual(0.38);
    }
  });

  it("总斜率 Σa·k ≤ 0.35 rad(防法线翻转/焦散过爆)", () => {
    const totalSlope = AMBIENT_WAVES.reduce(
      (s, w) => s + w.amp * (TAU / w.lambda),
      0,
    );
    expect(totalSlope).toBeLessThanOrEqual(0.35);
  });

  it("总幅 Σa ≤ 12mm(水面位移量级)", () => {
    const totalAmp = AMBIENT_WAVES.reduce((s, w) => s + w.amp, 0);
    expect(totalAmp).toBeLessThanOrEqual(0.012);
  });

  it("相位非全齐(至少两个成分 phase 不同,打破拍纹)", () => {
    const phases = new Set(AMBIENT_WAVES.map((w) => w.phase));
    expect(phases.size).toBeGreaterThan(1);
  });
});

describe("扭曲场 AMBIENT_WARPS(域扭曲)", () => {
  it("成分数为 3", () => {
    expect(AMBIENT_WARPS.length).toBe(3);
  });

  it("‖∇W‖ 峰值上界 Σ b·k < 1(坐标映射一一对应,无折叠)", () => {
    const gradBound = AMBIENT_WARPS.reduce(
      (s, w) => s + w.amp * (TAU / w.lambda),
      0,
    );
    expect(gradBound).toBeLessThan(1);
  });

  it("位移幅度 Σ b < 40mm", () => {
    const dispBound = AMBIENT_WARPS.reduce((s, w) => s + w.amp, 0);
    expect(dispBound).toBeLessThan(0.04);
  });

  it("扭曲波长 > 最长波波长(低频慢变,扭曲长波而非短波)", () => {
    const minWarpLambda = Math.min(...AMBIENT_WARPS.map((w) => w.lambda));
    const maxWaveLambda = Math.max(...AMBIENT_WAVES.map((w) => w.lambda));
    expect(minWarpLambda).toBeGreaterThan(maxWaveLambda);
  });
});

describe("ambientWaveHeight 镜像", () => {
  const totalAmp = AMBIENT_WAVES.reduce((s, w) => s + w.amp, 0);

  it("振幅界:|h| ≤ Σa(域扭曲不改变每成分幅界)", () => {
    let maxAbs = 0;
    for (let i = 0; i < 40; i++) {
      const x = (i / 40) * 2 - 1;
      for (let j = 0; j < 40; j++) {
        const z = (j / 40) * 2 - 1;
        for (let k = 0; k < 8; k++) {
          const t = (k / 8) * 6;
          const h = ambientWaveHeight(x, z, t);
          maxAbs = Math.max(maxAbs, Math.abs(h));
        }
      }
    }
    expect(maxAbs).toBeLessThanOrEqual(totalAmp + 1e-9);
  });

  it("确定性:同参两次调用同值", () => {
    const a = ambientWaveHeight(0.3, -0.7, 1.234);
    const b = ambientWaveHeight(0.3, -0.7, 1.234);
    expect(a).toBe(b);
  });

  it("ampScale 线性:h(·,2) = 2·h(·,1)", () => {
    const x = 0.4;
    const z = -0.2;
    const t = 2.5;
    expect(ambientWaveHeight(x, z, t, 2)).toBeCloseTo(
      2 * ambientWaveHeight(x, z, t, 1),
      9,
    );
  });

  it("ampScale=0 退化为零", () => {
    // toBe 严格 Object.is:h<0 时 h*0 = -0,数值上即 0,用 closeTo 容忍零符号
    expect(ambientWaveHeight(0.5, 0.5, 3.0, 0)).toBeCloseTo(0, 15);
  });

  it("斜率数值界:单向差分 ≤ Σa·k·(1+‖∇W‖)·1.05", () => {
    const slopeBound =
      AMBIENT_WAVES.reduce((s, w) => s + w.amp * (TAU / w.lambda), 0) *
      (1 + AMBIENT_WARPS.reduce((s, w) => s + w.amp * (TAU / w.lambda), 0));
    const x = 0.3;
    const z = 0.4;
    const t = 1.5;
    const d = 1e-4;
    const dhx =
      (ambientWaveHeight(x + d, z, t) - ambientWaveHeight(x - d, z, t)) /
      (2 * d);
    const dhz =
      (ambientWaveHeight(x, z + d, t) - ambientWaveHeight(x, z - d, t)) /
      (2 * d);
    expect(Math.abs(dhx)).toBeLessThan(slopeBound * 1.05);
    expect(Math.abs(dhz)).toBeLessThan(slopeBound * 1.05);
  });
});

describe("GLSL 生成一致性冒烟", () => {
  it("顶点着色器含 warpField 与 ambientWaveField 定义", () => {
    expect(LUX_SURFACE_VERT).toContain("void warpField(");
    expect(LUX_SURFACE_VERT).toContain("float ambientWaveField(");
  });

  it("每个波成分的 k 与 ω 字面量出现在生成代码中", () => {
    for (const w of AMBIENT_WAVES) {
      const k = (TAU / w.lambda).toFixed(4);
      const omega = (Math.sqrt(9.81 * (TAU / w.lambda)) * w.speed).toFixed(4);
      expect(LUX_SURFACE_VERT).toContain(
        `* ${k} - ${omega} * t + ${w.phase.toFixed(4)}`,
      );
    }
  });

  it("每个扭曲成分的位移幅度字面量出现", () => {
    for (const w of AMBIENT_WARPS) {
      expect(LUX_SURFACE_VERT).toContain(`* ${w.amp.toFixed(6)} * sn;`);
    }
  });
});
