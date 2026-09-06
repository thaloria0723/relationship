// 物理模块共享类型。零依赖(three/DOM 严禁进入本目录)。

export interface Vec2 {
  x: number;
  y: number;
}

/** 液滴种子(布点产物,静态):位置=宽/高比例(resize 安全),r=短边比例,w=相位 */
export interface DropSeed {
  u: number;
  v: number;
  r: number;
  w: number;
}

export interface Viewport {
  width: number;
  height: number;
}
