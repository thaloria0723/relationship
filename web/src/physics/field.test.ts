import { describe, expect, it } from "vitest";
import { fieldGrad, fieldHeight, swell } from "./field";
import { dropCenter } from "./kinematics";
import type { DropSeed, Vec2 } from "./types";

const VP = { width: 1000, height: 1000 };
const DROPS: DropSeed[] = [
  { u: 0.5, v: 0.5, r: 0.1, w: 0 },
  { u: 0.68, v: 0.5, r: 0.08, w: 0.3 },
];

describe("swell 缓涌场(唯一公式源)", () => {
  it("手算特例:npx=(0,0), t=0 → 0.5", () => {
    expect(swell({ x: 0, y: 0 }, 0)).toBe(0.5);
  });

  it("手算特例:npx=(1,0), t=0 → 0.5+0.5·sin(1.8) ≈ 0.98692", () => {
    expect(swell({ x: 1, y: 0 }, 0)).toBeCloseTo(0.5 + 0.5 * Math.sin(1.8), 12);
  });

  it("值域 [0,1]", () => {
    for (let t = 0; t < 20; t += 0.7) {
      const s = swell({ x: 0.37, y: 0.62 }, t);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

/** 沿 +x 方向距滴心 d·r_px 的采样点 */
function atDist(c: Vec2, rPx: number, d: number): Vec2 {
  return { x: c.x + d * rPx, y: c.y };
}

describe("fieldGrad ↔ fieldHeight 值/导数同步(契约核心)", () => {
  const t = 1.9;
  const e = 1e-3;

  function checkSync(px: Vec2, label: string) {
    const g = fieldGrad(px, VP, DROPS, t);
    const hL = fieldHeight({ x: px.x - e, y: px.y }, VP, DROPS, t);
    const hR = fieldHeight({ x: px.x + e, y: px.y }, VP, DROPS, t);
    const hD = fieldHeight({ x: px.x, y: px.y - e }, VP, DROPS, t);
    const hU = fieldHeight({ x: px.x, y: px.y + e }, VP, DROPS, t);
    const scale = Math.max(1, Math.abs(g.x), Math.abs(g.y));
    expect(Math.abs(g.x - (hR - hL) / (2 * e)) / scale, `${label} ∂x`).toBeLessThan(1e-4);
    expect(Math.abs(g.y - (hU - hD) / (2 * e)) / scale, `${label} ∂y`).toBeLessThan(1e-4);
  }

  it("dome 内部 / 接触线内沿 / 弯月面谷 / 外沿裙部 同步", () => {
    const d0 = DROPS[0]!;
    const c = { x: d0.u * 1000, y: d0.v * 1000 }; // t=1.9 时锚点近似即可用于选点(同步检查与中心无关)
    const rPx = d0.r * 1000;
    for (const [dist, label] of [
      [0.5, "dome 内部"],
      [0.98, "接触线内沿"],
      [1.03, "弯月面谷"],
      [1.3, "外沿裙部"],
      [1.9, "波场范围边缘"],
    ] as const) {
      checkSync(atDist(c, rPx, dist), `${label}@${dist}r`);
    }
  });

  it("两滴叠加区同步", () => {
    const a = DROPS[0]!;
    const b = DROPS[1]!;
    const mid = { x: ((a.u + b.u) / 2) * 1000, y: 500 };
    checkSync(mid, "两滴之间");
  });

  it("方向性:dome 内梯度指内(负),弯月面外裙梯度指外(正)", () => {
    const d0 = DROPS[0]!;
    const c = { x: d0.u * 1000, y: d0.v * 1000 };
    const rPx = d0.r * 1000;
    const inside = fieldGrad(atDist(c, rPx, 0.5), VP, DROPS, t);
    expect(inside.x).toBeLessThan(0);
    const skirt = fieldGrad(atDist(c, rPx, 1.3), VP, DROPS, t);
    expect(skirt.x).toBeGreaterThan(0);
  });

  it("截止:d > 2.2 精确为零(与 GLSL continue 对齐)", () => {
    const d0 = DROPS[0]!;
    const c = { x: d0.u * 1000, y: d0.v * 1000 };
    const rPx = d0.r * 1000;
    const g = fieldGrad(atDist(c, rPx, 2.5), VP, [d0], t);
    expect(g.x).toBe(0);
    expect(g.y).toBe(0);
  });

  it("dome 中心梯度≈0(弯月面在 d=0 处 e^-38 可忽略)", () => {
    const d0 = DROPS[0]!;
    const c = dropCenter(d0, VP, t); // 必须用实时滴心,锚点已被 bob/sway 移开
    const g = fieldGrad(c, VP, [d0], t);
    expect(Math.abs(g.x)).toBeLessThan(1e-9);
    expect(Math.abs(g.y)).toBeLessThan(1e-9);
  });
});
