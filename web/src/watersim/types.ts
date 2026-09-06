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
}
