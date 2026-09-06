// 大尺度缓涌场:全项目唯一公式源(封版代码曾同式写两处,:261/:284,此处收编)
import type { Vec2 } from "./types";

/** npx = px / 短边(归一坐标),返回 [0,1] */
export function swell(npx: Vec2, t: number): number {
  return 0.5 + 0.5 * Math.sin(npx.x * 1.8 + npx.y * 1.2 - t * 0.1);
}
