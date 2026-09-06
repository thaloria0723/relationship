// GLSL 兼容数学层:与 GLSL de-facto 语义逐位对齐,供 TS 参考实现与契约测试共用。
export function clamp(x: number, min: number, max: number): number {
  return Math.min(Math.max(x, min), max);
}

/** GLSL smoothstep(含反向边 de-facto 行为:除法方向翻转,如 smoothstep(1.08,1.0,dr)) */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** GLSL fract:x - floor(x)(负数输入返回正分数) */
export function fract(x: number): number {
  return x - Math.floor(x);
}
