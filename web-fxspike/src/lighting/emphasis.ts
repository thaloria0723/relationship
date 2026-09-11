// ============================================================
// 桥高亮策略(委托方需求 a,docs/光影渲染设计-2026-09-08.md §8)
// 纯函数:激活液滴(悬停或点击/拖拽)/ 聚焦中心 → 每桥高亮因子 ∈ [0,1]。
// - 悬停或点击某液滴:仅该滴出发的桥高亮(变亮加粗),其余不变;
// - 聚焦模式:默认高亮全部与中心液滴直连的桥(spoke);
// - cut 桥恒 0(引擎语义:张力关+不渲染,viewer 跳过)。
// 零渲染属性(抽象数组进出),与模块②同款可测性。
// ============================================================

export interface BridgeEmphasisQuery {
  /** 桥数(与引擎 BridgeState.count 同源) */
  count: number;
  /** 端点液滴索引(a[k], b[k]) */
  a: ArrayLike<number>;
  b: ArrayLike<number>;
  /** 焦点临时切断标记(≠0 = 切断) */
  cut: ArrayLike<number>;
  /** 激活液滴:拖拽(点击)目标优先,否则悬停目标;−1 = 无 */
  activeDroplet: number;
  /** 聚焦中心滴;−1 = 无 */
  focusCenter: number;
}

/**
 * 写出每桥高亮因子(高亮=1,不变=0)到 out[0..count)。
 * out 由 viewer 持有(每帧向目标值一阶平滑),本函数只算目标值。
 */
export function computeBridgeEmphasis(
  q: BridgeEmphasisQuery,
  out: Float32Array,
): void {
  const active =
    q.activeDroplet >= 0 ? q.activeDroplet : -1;
  const center = q.focusCenter >= 0 ? q.focusCenter : -1;
  for (let k = 0; k < q.count; k++) {
    if (q.cut[k] !== 0) {
      out[k] = 0;
      continue;
    }
    if (center >= 0) {
      // 聚焦期:中心直连桥全高亮;其余桥(组内非 spoke)已被引擎切断,
      // 组外桥保持常态——聚焦编排的静态语义,无需悬停叠加
      out[k] = q.a[k] === center || q.b[k] === center ? 1 : 0;
      continue;
    }
    out[k] = active >= 0 && (q.a[k] === active || q.b[k] === active) ? 1 : 0;
  }
}
