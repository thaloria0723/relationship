// ============================================================
// 契约常量 · 物理分册(唯一真源)
// 来源:index-wave.html CONFIG @ 360a8f9(封版基线,数值逐字转录)
// 渲染册/交互册在模块③/②落地时加入本目录。
// ============================================================

/** 液滴布点与运动(index-wave.html :66-70) */
export const DROP_PLACEMENT = {
  count: 8,
  sizeMin: 0.055, // 最小半径 / 短边
  sizeMax: 0.115, // 最大半径 / 短边
  bob: 1.0, // 起伏晃动幅度倍率
  /** 经扫描选定:8 颗全部 try 内落位、最小间距比 2.26、无影子屏底裁切、象限均衡 [2,2,3,1]
   *  ⚠ 改 count / 尺寸范围后必须重新验证避让(40 次退化强放是静默失败) */
  seed: 20260948,
} as const;

/** 统一高度场(index-wave.html :74-76)
 *  注:封版代码注释称 dome 高度为 DOME_H·r·(1-d²)²,但按其梯度反推真实场无 r 因子——
 *  以梯度公式为准(封版像素即真值),见 docs/视觉系统模块规格-2026-09-05.md §2 */
export const WATER_FIELD = {
  domeH: 0.55, // dome 峰值系数(高度场单位)
  meniscusH: 0.035, // 弯月面凹陷深度 / 半径
} as const;

/** P1 波场运动学(index-wave.html :83-85;亮暗带 ringBright/Dark 是渲染册,不在此) */
export const RING_WAVE = {
  speed: 0.03, // 相位/s(一圈约 33s)
  inner: 0.6, // 环出生半径 / r
  outer: 2.0, // 环消亡半径 / r
} as const;

/** 共享几何常量:弯月面环带。「值与导数两处必须同步」在物理册靠同一常量引用强制;
 *  渲染侧 lightField/lightPool 的 1.03 环带也须引用此处 */
export const MENISCUS = {
  center: 1.03, // 环带中心 dist / r
  width: 36.0, // 高斯宽度(加宽=过渡柔和;改此值须两端同步引用)
} as const;
