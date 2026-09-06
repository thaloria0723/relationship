// 物理模块门面:交互/渲染的唯一入口。渲染侧未来由此取快照注入 uniform 数组。
import { DROP_PLACEMENT } from "../contracts/params";
import { dropCenter, dropSquash } from "./kinematics";
import { fieldGrad } from "./field";
import { placeDrops } from "./placement";
import { swell } from "./swell";
import type { DropSeed, Vec2, Viewport } from "./types";

export interface WaterPhysics {
  readonly simTime: number;
  readonly drops: readonly DropSeed[];
  setViewport(vp: Viewport): void;
  step(dt: number): void;
  /** 无障碍时间策略(交互册调用):直接钉住模拟时间(如 reduced-motion 冻结帧) */
  setSimTime(t: number): void;
  dropCenterAt(i: number): Vec2;
  dropSquashAt(i: number): number;
  fieldGrad(px: Vec2): Vec2;
  swellAtPx(px: Vec2): number;
}

export function createPhysics(): WaterPhysics {
  const drops = placeDrops();
  let vp: Viewport = { width: 0, height: 0 };
  let simTime = 0;

  const seedAt = (i: number): DropSeed => {
    const d = drops[i];
    if (!d) throw new RangeError(`液滴索引越界: ${i}`);
    return d;
  };

  return {
    get simTime() {
      return simTime;
    },
    get drops() {
      return drops;
    },
    setViewport(v) {
      vp = v;
    },
    step(dt) {
      simTime += dt;
    },
    setSimTime(t) {
      simTime = t;
    },
    dropCenterAt(i) {
      return dropCenter(seedAt(i), vp, simTime, DROP_PLACEMENT.bob);
    },
    dropSquashAt(i) {
      return dropSquash(seedAt(i), simTime);
    },
    fieldGrad(px) {
      return fieldGrad(px, vp, drops, simTime);
    },
    swellAtPx(px) {
      const mn = Math.min(vp.width, vp.height);
      return swell({ x: px.x / mn, y: px.y / mn }, simTime);
    },
  };
}

export type { DropSeed, Vec2, Viewport } from "./types";
export { DROP_PLACEMENT };
