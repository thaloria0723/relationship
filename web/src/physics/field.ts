import { MENISCUS, WATER_FIELD } from "../contracts/params";
import { dropCenter } from "./kinematics";
import type { DropSeed, Vec2, Viewport } from "./types";

export { swell } from "./swell";

/** 场截止半径 / r(与 GLSL `dist > 2.2 continue` 对齐) */
const CUTOFF = 2.2;

/** 高度场参考实现(契约测试用):dome + 弯月面,与 fieldGrad 严格互为导数。
 *  dome 高度无 r 因子(封版注释有误,按梯度反推为准),弯月面含 r——见规格 §2 */
export function fieldHeight(
  px: Vec2,
  vp: Viewport,
  drops: readonly DropSeed[],
  t: number,
): number {
  const mn = Math.min(vp.width, vp.height);
  let h = 0;
  for (const d of drops) {
    if (d.r < 0.001) continue;
    const r = d.r * mn;
    const c = dropCenter(d, vp, t);
    const relX = (px.x - c.x) / r;
    const relY = (px.y - c.y) / r;
    const dist = Math.hypot(relX, relY);
    if (dist > CUTOFF) continue;
    if (dist < 1) {
      const d2 = dist * dist;
      h += WATER_FIELD.domeH * (1 - d2) * (1 - d2);
    }
    const ring = dist - MENISCUS.center;
    h += -WATER_FIELD.meniscusH * r * Math.exp(-ring * ring * MENISCUS.width);
  }
  return h;
}

/** 高度场解析梯度(px 单位):dome + 弯月面,对应 GLSL dropFieldGrad(:290-313)
 *  ⚠ 值与导数同步由契约测试(fieldHeight 数值差分)强制 */
export function fieldGrad(
  px: Vec2,
  vp: Viewport,
  drops: readonly DropSeed[],
  t: number,
): Vec2 {
  const mn = Math.min(vp.width, vp.height);
  const g = { x: 0, y: 0 };
  for (const d of drops) {
    if (d.r < 0.001) continue;
    const r = d.r * mn;
    const c = dropCenter(d, vp, t);
    const relX = (px.x - c.x) / r;
    const relY = (px.y - c.y) / r;
    const dist = Math.hypot(relX, relY);
    if (dist > CUTOFF) continue;
    const inv = 1 / Math.max(dist, 1e-4);
    const dirX = relX * inv;
    const dirY = relY * inv;
    if (dist < 1) {
      // dome:∇h = rel·(−4·DOME_H·(1−d²))/r(接触线斜率为零,与水面连续)
      const k = (-4 * WATER_FIELD.domeH * (1 - dist * dist)) / r;
      g.x += relX * k;
      g.y += relY * k;
    }
    // 弯月面:贴接触线的柔和凹陷(值含 r,梯度中 r 消去——与封版公式一致)
    const ring = dist - MENISCUS.center;
    const men =
      -WATER_FIELD.meniscusH * r * Math.exp(-ring * ring * MENISCUS.width);
    const k = (men * -2 * ring * MENISCUS.width) / r;
    g.x += dirX * k;
    g.y += dirY * k;
  }
  return g;
}
