import { DROP_PLACEMENT } from "../contracts/params";
import { swell } from "./swell";
import type { DropSeed, Vec2, Viewport } from "./types";

/** 液滴实时中心 px:静态锚点 + 随缓涌起伏(bob)+ 自身相位晃动(sway)
 *  对应 GLSL dropCenterPx(index-wave.html :279-288) */
export function dropCenter(
  d: DropSeed,
  vp: Viewport,
  t: number,
  bobAmp: number = DROP_PLACEMENT.bob,
): Vec2 {
  const mn = Math.min(vp.width, vp.height);
  const cx = d.u * vp.width;
  const cy = d.v * vp.height;
  const s = swell({ x: cx / mn, y: cy / mn }, t);
  const bob =
    ((s - 0.5) * 0.55 + 0.3 * Math.sin(t * 0.9 + d.w * 6.2831)) *
    d.r *
    mn *
    bobAmp;
  const sway = 0.3 * Math.sin(t * 0.63 + d.w * 10.72) * d.r * mn * bobAmp;
  return { x: cx + sway, y: cy + bob };
}

/** 挤压呼吸标量(index-wave.html :416):渲染侧按 (1±squash) 构造椭圆 */
export function dropSquash(d: DropSeed, t: number): number {
  return 0.035 * Math.sin(t * 0.8 + d.w * 8.2);
}
