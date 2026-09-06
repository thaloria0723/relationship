import { describe, expect, it } from "vitest";
import { dropCenter, dropSquash } from "./kinematics";
import type { DropSeed, Vec2 } from "./types";

const VP = { width: 800, height: 600 };

/** 独立转录 oracle:GLSL dropCenterPx(:279-288)公式的测试内副本 */
function oracleCenter(d: DropSeed, vp: { width: number; height: number }, t: number): Vec2 {
  const mn = Math.min(vp.width, vp.height);
  const c = { x: d.u * vp.width, y: d.v * vp.height };
  const swell = 0.5 + 0.5 * Math.sin((c.x / mn) * 1.8 + (c.y / mn) * 1.2 - t * 0.1);
  const bob = ((swell - 0.5) * 0.55 + 0.3 * Math.sin(t * 0.9 + d.w * 6.2831)) * d.r * mn;
  const sway = 0.3 * Math.sin(t * 0.63 + d.w * 10.72) * d.r * mn;
  return { x: c.x + sway, y: c.y + bob };
}

describe("dropCenter 漂浮运动学", () => {
  it("零点特例:锚点(0,0)、w=0、t=0 → swell=0.5 → bob/sway 全零,中心=锚点", () => {
    const c = dropCenter({ u: 0, v: 0, r: 0.08, w: 0 }, { width: 1000, height: 1000 }, 0);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
  });

  it("与独立 oracle 对拍(t=0 与 t=3.7 两个时刻 × 8 颗)", () => {
    const seeds: DropSeed[] = [
      { u: 0.3, v: 0.4, r: 0.06, w: 0.13 },
      { u: 0.7, v: 0.2, r: 0.11, w: 0.77 },
      { u: 0.5, v: 0.5, r: 0.08, w: 0.5 },
    ];
    for (const d of seeds) {
      for (const t of [0, 3.7]) {
        const got = dropCenter(d, VP, t);
        const want = oracleCenter(d, VP, t);
        expect(got.x).toBeCloseTo(want.x, 9);
        expect(got.y).toBeCloseTo(want.y, 9);
      }
    }
  });

  it("振幅界:|dx| ≤ 0.30·r·mn,|dy| ≤ 0.575·r·mn", () => {
    const d = { u: 0.5, v: 0.5, r: 0.1, w: 0.33 };
    const mn = Math.min(VP.width, VP.height);
    for (let t = 0; t < 60; t += 0.37) {
      const c = dropCenter(d, VP, t);
      expect(Math.abs(c.x - 400)).toBeLessThanOrEqual(0.3 * d.r * mn + 1e-9);
      expect(Math.abs(c.y - 300)).toBeLessThanOrEqual(0.575 * d.r * mn + 1e-9);
    }
  });
});

describe("dropSquash 挤压呼吸", () => {
  it("零点:t=0,w=0 → 0;t=π/1.6,w=0 → sin(π/2)=1 → 0.035", () => {
    expect(dropSquash({ u: 0.5, v: 0.5, r: 0.1, w: 0 }, 0)).toBe(0);
    expect(dropSquash({ u: 0.5, v: 0.5, r: 0.1, w: 0 }, Math.PI / 1.6)).toBeCloseTo(0.035, 9);
  });

  it("振幅界:|squash| ≤ 0.035", () => {
    const d = { u: 0.5, v: 0.5, r: 0.1, w: 0.81 };
    for (let t = 0; t < 30; t += 0.23) {
      expect(Math.abs(dropSquash(d, t))).toBeLessThanOrEqual(0.035 + 1e-12);
    }
  });
});
