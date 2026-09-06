// ============================================================
// 液滴间(§2.2/§4.3/M3):碰撞冲量+去穿透、毛细吸引、聚合。
// 零渲染依赖;热路径无对象分配(全部就地改写速度/位置,预标记数组)。
//
// 桥接期语义(§10 风险对策「桥接期间禁碰撞弹开」):一对漂浮滴在桥接区间
// (间隙 < bridgeRange·(r₁+r₂))内时跳过碰撞冲量,只累计 bridgeT;
// 累计 ≥ drainTime → 聚合;未到就离开区间 → bridgeT 清零、恢复碰撞。
// 每固定步至多执行一次聚合(首个达标对),顺序确定 ⇒ 引擎确定性不破坏。
// ============================================================

import { solveEquilibriumDepth } from "./field";
import type { DropletSystem } from "./droplet";
import type { WaterSimParams } from "./params";

/**
 * 聚合半径:r = (r₁³+r₂³)^(1/3)(体积守恒,§4.3 Merge)。
 * 独立导出供测试对拍。
 */
export function mergeRadius(r1: number, r2: number): number {
  return Math.cbrt(r1 * r1 * r1 + r2 * r2 * r2);
}

/**
 * 液滴间系统。step(dt) 顺序(引擎管线第 2.2 步,droplets.update 之后):
 * 1. 全部滴 cooldown 递减(聚合判定用 ≤ 0)
 * 2. 配对扫描:桥接判定/聚合;非桥接对做碰撞(冲量+去穿透)与毛细吸引
 * 3. 桥接区间外的滴 bridgeT 清零
 */
export class DropletPairs {
  /** 累计聚合次数(HUD) */
  mergeCount = 0;
  /** 本步是否有滴处于任一桥接区间(bridgeT 清零判定用;构造期预分配) */
  private readonly bridging: Uint8Array;

  constructor(
    private readonly params: WaterSimParams,
    private readonly drops: DropletSystem,
    /** 聚合涟漪出口:引擎把 (x, y, 新半径) 转成场脉冲(经弹坑发射器通道) */
    private readonly onMerge?: (x: number, y: number, rNew: number) => void,
  ) {
    this.bridging = new Uint8Array(params.maxDroplets);
  }

  /** 推进一步(dt = 固定步长)。执行聚合时液滴数减少。 */
  step(dt: number): void {
    const d = this.drops.state;
    const p = this.params;
    const margin = 3 * this.drops.field.dx;
    const lo = margin;
    const hi = p.domainSize - margin;

    // ---------- 1) cooldown 递减 ----------
    for (let i = 0; i < d.count; i++) {
      if (d.cooldown[i]! > 0) {
        d.cooldown[i] = Math.max(0, d.cooldown[i]! - dt);
      }
    }

    // ---------- 2) 配对扫描(O(n²),n ≤ 32) ----------
    this.bridging.fill(0, 0, d.count);
    for (let i = 0; i < d.count; i++) {
      for (let j = i + 1; j < d.count; j++) {
        const dx = d.x[j]! - d.x[i]!;
        const dy = d.y[j]! - d.y[i]!;
        const dist = Math.hypot(dx, dy);
        const rSum = d.r[i]! + d.r[j]!;
        const gap = dist - rSum;
        const bothFloating = d.floating[i] === 1 && d.floating[j] === 1;
        if (dist === 0) continue; // 恒重合病态对(引擎不会产生;防除零)
        const inBridge = bothFloating && gap < p.bridgeRange * rSum;
        const cooling = d.cooldown[i]! > 0 || d.cooldown[j]! > 0;

        if (inBridge) {
          // ---- 桥接期(双方漂浮):禁碰撞弹开;冷却中的对不计时(防瞬聚,§10) ----
          // mergeEnabled=false(裁决 §12.2-C′,默认):稳定化液滴网络——
          // 液滴在桥接区互相靠拢但永不融合(液桥连接,互不合并);仅累计 bridgeT 供统计。
          this.bridging[i] = 1;
          this.bridging[j] = 1;
          if (p.mergeEnabled && !cooling) {
            d.bridgeT[i]! += dt;
            d.bridgeT[j]! += dt;
            if (d.bridgeT[i]! >= p.drainTime) {
              this.merge(i, j);
              return; // 每步至多一次聚合(确定性;其余对下步继续)
            }
          }
          if (gap <= 0) {
            // 桥接期位置修正(无冲量):按质量反比推回接触,防深穿透
            const mi0 = floatMass(d, i, p);
            const mj0 = floatMass(d, j, p);
            const push0 = -gap / (1 / mi0 + 1 / mj0);
            const nx0 = dx / dist;
            const ny0 = dy / dist;
            d.x[i] = clamp(d.x[i]! - (push0 / mi0) * nx0, lo, hi);
            d.y[i] = clamp(d.y[i]! - (push0 / mi0) * ny0, lo, hi);
            d.x[j] = clamp(d.x[j]! + (push0 / mj0) * nx0, lo, hi);
            d.y[j] = clamp(d.y[j]! + (push0 / mj0) * ny0, lo, hi);
          }
          continue;
        }

        // ---- 碰撞:重叠(gap ≤ 0)时施加冲量,并按等效质量比例去穿透 ----
        if (gap <= 0) {
          const mi = floatMass(d, i, p);
          const mj = floatMass(d, j, p);
          const nx = dx / dist;
          const ny = dy / dist;
          const vRelN = (d.vx[j]! - d.vx[i]!) * nx + (d.vy[j]! - d.vy[i]!) * ny;
          if (vRelN < 0) {
            // 法向冲量:j = −(1+e)·v_relN / (1/mi + 1/mj)(§8 碰撞动量合同)
            const jImp = (-(1 + p.restitution) * vRelN) / (1 / mi + 1 / mj);
            d.vx[i] = d.vx[i]! - (jImp / mi) * nx;
            d.vy[i] = d.vy[i]! - (jImp / mi) * ny;
            d.vx[j] = d.vx[j]! + (jImp / mj) * nx;
            d.vy[j] = d.vy[j]! + (jImp / mj) * ny;
            // ε 踢振(碰撞激发形状振荡;风格化增益,钳幅)
            const kick = Math.min(Math.abs(vRelN) * 0.5, 2);
            d.epsVel[i]! += kick;
            d.epsVel[j]! += kick;
          }
          // 去穿透:位置修正按质量反比推开(不做速度反弹)
          const invSum = 1 / mi + 1 / mj;
          const push = -gap / invSum;
          d.x[i] = clamp(d.x[i]! - (push / mi) * nx, lo, hi);
          d.y[i] = clamp(d.y[i]! - (push / mi) * ny, lo, hi);
          d.x[j] = clamp(d.x[j]! + (push / mj) * nx, lo, hi);
          d.y[j] = clamp(d.y[j]! + (push / mj) * ny, lo, hi);
        }

        // ---- 毛细吸引(§4.3,风格化):F = A·exp(−gap/ℓ),ℓ = (r₁+r₂)/2 ----
        if (gap < p.capillaryRange * rSum) {
          const F = p.capillaryA * Math.exp(-gap / (rSum * 0.5));
          const nx = dx / dist;
          const ny = dy / dist;
          const mi = floatMass(d, i, p);
          const mj = floatMass(d, j, p);
          // 沿连线互相吸引(i → j 方向为正)
          d.vx[i] = d.vx[i]! + (F / mi) * nx * dt;
          d.vy[i] = d.vy[i]! + (F / mi) * ny * dt;
          d.vx[j] = d.vx[j]! - (F / mj) * nx * dt;
          d.vy[j] = d.vy[j]! - (F / mj) * ny * dt;
        }
      }
    }

    // ---------- 3) 桥接区间外的滴计时清零 ----------
    for (let i = 0; i < d.count; i++) {
      if (this.bridging[i] === 0 && d.bridgeT[i]! !== 0) {
        d.bridgeT[i] = 0;
      }
    }
  }

  /**
   * 聚合执行(§4.3 Merge):i ← 合并结果,j 交换删除。
   * V 守恒(r 合并式)、动量守恒(质量加权)、d* 吸附、ε 踢振、场脉冲、冷却。
   */
  private merge(i: number, j: number): void {
    const d = this.drops.state;
    const p = this.params;
    const mi = floatMass(d, i, p);
    const mj = floatMass(d, j, p);
    const mT = mi + mj;
    const rNew = mergeRadius(d.r[i]!, d.r[j]!);
    // 质心位置 + 动量守恒速度(等效浮力质量加权)
    d.x[i] = (d.x[i]! * mi + d.x[j]! * mj) / mT;
    d.y[i] = (d.y[i]! * mi + d.y[j]! * mj) / mT;
    d.vx[i] = (d.vx[i]! * mi + d.vx[j]! * mj) / mT;
    d.vy[i] = (d.vy[i]! * mi + d.vy[j]! * mj) / mT;
    // 新半径 + 平衡浸深吸附(垂直免反馈设计,§4.2)
    d.r[i] = rNew;
    d.dStar[i] = solveEquilibriumDepth(rNew, p.densityRatio);
    d.d[i] = d.dStar[i]!;
    d.floating[i] = 1;
    // 形状踢振(阻尼弹簧自由振荡起点)+ 新冷却
    d.eps[i] = 0;
    d.epsVel[i] = 2 * p.mergeRipple;
    d.bridgeT[i] = 0;
    d.cooldown[i] = p.mergeCooldown;
    // 聚合涟漪(引擎出口 → 弹坑发射器通道,峰值受 couplingClamp 约束)
    this.onMerge?.(d.x[i]!, d.y[i]!, rNew);
    this.drops.removeAt(j);
    this.mergeCount++;
  }
}

/** 浮滴等效质量:m = ρ_d·V_R = densityRatio·ρ_w·(4/3)πr³(坡度力/阻力同款惯性) */
function floatMass(d: DropletStateLike, i: number, p: WaterSimParams): number {
  const r = d.r[i]!;
  return p.densityRatio * p.waterRho * ((4 / 3) * Math.PI * r * r * r);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** floatMass 的最小结构类型(避免仅为签名导入 DropletState) */
interface DropletStateLike {
  readonly r: Float32Array;
}
