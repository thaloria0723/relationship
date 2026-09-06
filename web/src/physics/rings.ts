// P1 波场运动学(相位/半径/包络)。亮暗带辐射量在渲染侧,不在此。
import { RING_WAVE } from "../contracts/params";
import { fract, smoothstep } from "./math";

/** 第 k 子环、滴相位 w、时间 t → 循环外扩相位 [0,1) */
export function ringPhase(k: number, w: number, t: number): number {
  return fract(t * RING_WAVE.speed + k * 0.33 + w);
}

/** 相位 → 环半径 / r:inner → outer 线性外扩 */
export function ringRadius(phase: number): number {
  return RING_WAVE.inner + phase * (RING_WAVE.outer - RING_WAVE.inner);
}

/** 包络 × 距离衰减(弱-强-弱):出生淡入(接触线附近弱)→ 峰值 → 远端淡出 */
export function ringFade(phase: number, dist: number): number {
  const birth = smoothstep(0.1, 0.45, phase);
  const decay = 1 - smoothstep(0.55, 1, phase);
  return (birth * decay) / (0.55 + dist * 0.6);
}
