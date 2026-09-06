import { describe, expect, it } from "vitest";
import { dropCenter, dropSquash } from "./kinematics";
import { fieldGrad, swell } from "./field";
import { createPhysics } from "./index";
import { DROP_PLACEMENT } from "../contracts/params";

describe("物理门面", () => {
  it("初始态:8 颗、simTime=0", () => {
    const p = createPhysics();
    expect(p.drops).toHaveLength(DROP_PLACEMENT.count);
    expect(p.simTime).toBe(0);
  });

  it("step 累积模拟时间", () => {
    const p = createPhysics();
    p.step(0.5);
    p.step(0.25);
    expect(p.simTime).toBeCloseTo(0.75, 12);
  });

  it("setSimTime 钉住(无障碍冻结入口),后续 step 在其上累积", () => {
    const p = createPhysics();
    p.setSimTime(47);
    expect(p.simTime).toBe(47);
    p.step(1);
    expect(p.simTime).toBe(48);
  });

  it("采样委托与模块函数一致(同 vp/t 输入)", () => {
    const p = createPhysics();
    p.setViewport({ width: 800, height: 600 });
    p.step(0.75);
    const t = p.simTime;
    const vp = { width: 800, height: 600 };
    expect(p.dropCenterAt(0)).toEqual(dropCenter(p.drops[0]!, vp, t, DROP_PLACEMENT.bob));
    expect(p.dropSquashAt(0)).toBe(dropSquash(p.drops[0]!, t));
    const px = { x: 413, y: 287 };
    expect(p.fieldGrad(px)).toEqual(fieldGrad(px, vp, p.drops, t));
    expect(p.swellAtPx({ x: 800, y: 0 })).toBeCloseTo(swell({ x: 800 / 600, y: 0 }, t), 12);
  });
});
