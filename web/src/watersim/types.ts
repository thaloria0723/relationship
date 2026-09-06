// ============================================================
// watersim 状态类型(引擎本体零渲染依赖,three 只允许出现在 grayview/viewer.ts)
// ============================================================

export type BoundaryMode = "absorb" | "reflect";

/**
 * 水面场状态。N×N Float32Array,行主序,idx = j·N + i;
 * 顶点中心网格,(i,j) ↔ 世界坐标 (i·dx, j·dx),dx = domainSize/(N−1)。
 * 单位:米、秒。
 */
export interface FieldState {
  /** 波高 h(当前层) */
  h: Float32Array;
  /** 波高 h(上一层,flowOn=false 的 leapfrog 路径使用;flowOn=true 时与 h 同步维护) */
  hPrev: Float32Array;
  /** x 向流速,交错 C 网格(x 面,u[i,j] 位于 (i,j) 与 (i+1,j) 之间,末列恒 0) */
  u: Float32Array;
  /** y 向流速,交错 C 网格(y 面,末行恒 0) */
  v: Float32Array;
}

/** 引擎统计(HUD 消费) */
export interface EngineStats {
  /** 仿真时间(秒,物理唯一时间源) */
  simTime: number;
  /** 已执行固定步数 */
  stepCount: number;
  /** 累计入水次数(空中→漂浮转换) */
  impacts: number;
  /** 累计聚合次数(M3,只增不减) */
  merges: number;
}

/**
 * 液滴个体状态(紧凑数组 + count,交换删除)。
 * 水平坐标 (x,y) 米;垂直 z 为液滴中心相对平均水面的高度(向上为正)。
 * 浸深 d 为球缺深度(底部浸入水面的深度,§4.2)。
 */
export interface DropletState {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** 垂直速度(仅空中段积分) */
  vz: Float32Array;
  /** 水平速度(浮态段坡度力/阻力) */
  vx: Float32Array;
  vy: Float32Array;
  /** 半径(出生固定;聚合时按 r=(r₁³+r₂³)^(1/3) 合并) */
  r: Float32Array;
  /** 当前浸深 d */
  d: Float32Array;
  /** 平衡浸深 d*(出生时由浮力平衡解出,只依赖 r 与 densityRatio) */
  dStar: Float32Array;
  /** 0=空中 1=漂浮 */
  floating: Uint8Array;
  /** 当前压扁 ε(0=球形;渲染 y 向缩放 1−ε,§4.3 Deformation) */
  eps: Float32Array;
  /** ε′(形状弹簧速度) */
  epsVel: Float32Array;
  /** 桥接持续计时(排液延迟累计,聚合判定用;离开桥接区间即清零) */
  bridgeT: Float32Array;
  /** 聚合冷却剩余(秒;防合并后瞬聚,§5.4 mergeCooldown) */
  cooldown: Float32Array;
  /**
   * 出生锚点 x/y(裁决 §12.2-C′ 接触线钉扎:液滴在锚点附近相对固定,
   * 近似接触角滞后 pinning;锚点 = 首次接触入水位置)
   */
  anchorX: Float32Array;
  anchorY: Float32Array;
  /** 悬停升力系数 0..1(平滑;有效平衡浸深 = d*·(1−hoverLift·lift)) */
  lift: Float32Array;
  /** 拖拽回弹目标(抓取时位置) */
  homeX: Float32Array;
  homeY: Float32Array;
  /** 交互标志:拖拽中 / 回弹中 / 焦点悬浮 */
  drag: Uint8Array;
  returning: Uint8Array;
  lev: Uint8Array;
}

/** 液桥实体状态(紧凑数组 + count,交换删除) */
export interface BridgeState {
  count: number;
  /** 端点液滴索引 */
  a: Int32Array;
  b: Int32Array;
  /** 自然长度(成桥时两滴中心距,张力目标) */
  restLen: Float32Array;
  /** 焦点模式临时切断:张力关 + 不渲染 + 流量清零 */
  cut: Uint8Array;
  /** 侵入持续计时(秒;超 grace 断桥) */
  intrudeT: Float32Array;
}
