// ============================================================
// 液桥(任务①,物理模型收官):连接两颗漂浮滴的液柱实体。
// 形状合同(渲染侧同源):两端宽(嵌入液滴)、中间窄(颈部)。
// 物理:张力弹簧(绳式持距)+ 拉普拉斯压差流动(小滴 → 大滴,体积守恒)
// + 侵入治理(「液桥经过第三方液滴」三重对策,2026-09-07 裁决备案):
//   a) 桥本征短程:仅在桥接区间(间隙 < bridgeRange·(r₁+r₂))生成;
//   b) 生成前胶囊排斥:桥轴线段被第三方液滴占据(膨胀 5%)→ 拒绝成桥;
//   c) 生存期复检:侵入持续 > grace(0.2s)→ 断桥,双端进冷却防抖。
// 确定性:预分配池、固定顺序扫描、无对象分配热路径。
// ============================================================

import { solveEquilibriumDepth } from "./field";
import type { DropletSystem } from "./droplet";
import type { WaterSimParams } from "./params";
import type { BridgeState } from "./types";

/** 侵入判定宽限(秒):瞬时几何噪声不断桥,持续占据才断 */
const INTRUDE_GRACE = 0.2;

export class BridgeSystem {
  readonly state: BridgeState;
  /** 每桥体积流量(m³/s,>0 表示 a(小滴)→ b(大滴);渲染流动粒子取用) */
  readonly flowRate: Float32Array;
  /** 累计成桥/断桥次数(测试与 HUD 观测) */
  formedCount = 0;
  brokenCount = 0;

  /** 成桥等待累计:键 = i·maxN + j(i<j),O(n²) 预分配 */
  private readonly pending: Float32Array;
  private readonly maxN: number;

  constructor(
    private readonly params: WaterSimParams,
    private readonly drops: DropletSystem,
  ) {
    const n = params.maxDroplets;
    this.maxN = n;
    this.state = {
      count: 0,
      a: new Int32Array(n),
      b: new Int32Array(n),
      restLen: new Float32Array(n),
      cut: new Uint8Array(n),
      intrudeT: new Float32Array(n),
    };
    this.flowRate = new Float32Array(n);
    this.pending = new Float32Array(n * n);
  }

  /**
   * 推进一步(dt = 固定步长):
   * 1) 成桥扫描(mergeEnabled=false 的网络模式;聚合模式下 drainTime 归聚合独占)
   * 2) 生存期:张力持距 / 超限断桥 / 拉普拉斯流动 / 侵入复检
   */
  step(dt: number): void {
    if (!this.params.mergeEnabled) {
      this.scanFormation(dt);
    }
    this.stepActive(dt);
  }

  /** 成桥扫描:漂浮对 + 桥接区间 + 双方冷却完毕 + 桥轴胶囊无第三方占据 */
  private scanFormation(dt: number): void {
    const d = this.drops.state;
    const p = this.params;
    const n = d.count;
    for (let i = 0; i < n; i++) {
      if (d.floating[i] !== 1 || d.cooldown[i]! > 0) continue;
      for (let j = i + 1; j < n; j++) {
        if (d.floating[j] !== 1 || d.cooldown[j]! > 0) continue;
        const key = i * this.maxN + j;
        const dx = d.x[j]! - d.x[i]!;
        const dy = d.y[j]! - d.y[i]!;
        const dist = Math.hypot(dx, dy);
        const rSum = d.r[i]! + d.r[j]!;
        if (dist === 0 || dist >= rSum * (1 + p.bridgeRange)) {
          this.pending[key] = 0;
          continue;
        }
        if (this.pairBridged(i, j) >= 0) continue;
        // 生成前排斥:桥轴胶囊被第三方占据 → 不累计、不成桥
        if (this.capsuleIntruded(i, j, dist) >= 0) {
          this.pending[key] = 0;
          continue;
        }
        this.pending[key] = this.pending[key]! + dt;
        if (this.pending[key]! >= p.drainTime) {
          this.form(i, j, dist);
        }
      }
    }
  }

  private form(i: number, j: number, dist: number): void {
    const s = this.state;
    if (s.count >= this.params.maxDroplets) return;
    const k = s.count;
    s.a[k] = i;
    s.b[k] = j;
    s.restLen[k] = dist;
    s.cut[k] = 0;
    s.intrudeT[k] = 0;
    this.flowRate[k] = 0;
    s.count++;
    this.pending[i * this.maxN + j] = 0;
    this.formedCount++;
  }

  private breakBridge(k: number): void {
    const s = this.state;
    const last = s.count - 1;
    if (k !== last) {
      s.a[k] = s.a[last]!;
      s.b[k] = s.b[last]!;
      s.restLen[k] = s.restLen[last]!;
      s.cut[k] = s.cut[last]!;
      s.intrudeT[k] = s.intrudeT[last]!;
      this.flowRate[k] = this.flowRate[last]!;
    }
    s.count--;
    this.brokenCount++;
  }

  /** 生存期:张力持距 + 超限断桥 + 拉普拉斯流动 + 侵入复检 */
  private stepActive(dt: number): void {
    const d = this.drops.state;
    const p = this.params;
    const s = this.state;
    for (let k = s.count - 1; k >= 0; k--) {
      const i = s.a[k]!;
      const j = s.b[k]!;
      // 端点失效(被移除/非漂浮)→ 断桥
      if (i >= d.count || j >= d.count || d.floating[i] !== 1 || d.floating[j] !== 1) {
        this.breakBridge(k);
        continue;
      }
      const dx = d.x[j]! - d.x[i]!;
      const dy = d.y[j]! - d.y[i]!;
      const dist = Math.hypot(dx, dy);
      if (dist === 0) continue;
      const rest = s.restLen[k]!;
      // 超拉伸断桥(双端进冷却,防立即重桥抖动)
      if (dist > rest * (1 + p.bridgeBreakStretch)) {
        this.cooldownPair(i, j);
        this.breakBridge(k);
        continue;
      }
      if (s.cut[k] === 0) {
        // 张力:绳式(仅拉伸段出力),F = k·ΔL + c·u(u=分离向相对速度)。
        // 阻尼项隐式化(c·dt/m 在 4·dt/12.7g ≈ 2.1 > 2 会显式失稳,与场阻尼同一对策):
        // u′ = (u − A·k·ΔL·dt)/(1 + A·c·dt),A = 1/m_a + 1/m_b,冲量 J = (u − u′)/A
        if (dist > rest) {
          const nx = dx / dist;
          const ny = dy / dist;
          const ma = this.mass(i);
          const mb = this.mass(j);
          const mob = 1 / ma + 1 / mb;
          const u = (d.vx[j]! - d.vx[i]!) * nx + (d.vy[j]! - d.vy[i]!) * ny;
          const jImp =
            ((p.bridgeTensionK * (dist - rest) + p.bridgeTensionC * u) * dt) /
            (1 + mob * p.bridgeTensionC * dt);
          d.vx[i] = d.vx[i]! + (jImp / ma) * nx;
          d.vy[i] = d.vy[i]! + (jImp / ma) * ny;
          d.vx[j] = d.vx[j]! - (jImp / mb) * nx;
          d.vy[j] = d.vy[j]! - (jImp / mb) * ny;
        }
        // 拉普拉斯流动:Q = k·π·r_neck²·(1/r_a − 1/r_b);Q>0 ⇒ a(小)→ b(大)
        const ra = d.r[i]!;
        const rb = d.r[j]!;
        const rNeck = 0.45 * Math.min(ra, rb);
        const q = p.bridgeFlowK * Math.PI * rNeck * rNeck * (1 / ra - 1 / rb);
        this.flowRate[k] = q;
        if (q !== 0) {
          const vMin = (4 / 3) * Math.PI * Math.min(ra, rb) ** 3;
          const dv = Math.min(Math.abs(q) * dt, 0.02 * vMin); // 单步钳幅 2% 小滴体积
          this.transfer(i, j, q > 0 ? dv : -dv);
        }
      }
      // 侵入复检:第三方占据桥轴,持续 > grace → 断桥
      if (this.capsuleIntruded(i, j, dist) >= 0) {
        s.intrudeT[k] = s.intrudeT[k]! + dt;
        if (s.intrudeT[k]! > INTRUDE_GRACE) {
          this.cooldownPair(i, j);
          this.breakBridge(k);
          continue;
        }
      } else {
        s.intrudeT[k] = 0;
      }
    }
  }

  /** 桥内体积转移(守恒):from → to 为正;更新半径与平衡浸深(d* 只依赖 r) */
  private transfer(from: number, to: number, dv: number): void {
    const d = this.drops.state;
    const p = this.params;
    const vFrom = (4 / 3) * Math.PI * d.r[from]! ** 3 - dv;
    const vTo = (4 / 3) * Math.PI * d.r[to]! ** 3 + dv;
    const rFrom = Math.cbrt((3 * vFrom) / (4 * Math.PI));
    const rTo = Math.cbrt((3 * vTo) / (4 * Math.PI));
    if (!(rFrom > 0.002) || !(rTo > 0.002)) return; // 病态防护
    d.r[from] = rFrom;
    d.r[to] = rTo;
    d.dStar[from] = solveEquilibriumDepth(rFrom, p.densityRatio);
    d.dStar[to] = solveEquilibriumDepth(rTo, p.densityRatio);
  }

  private mass(i: number): number {
    const r = this.drops.state.r[i]!;
    return (
      this.params.densityRatio * this.params.waterRho * ((4 / 3) * Math.PI * r * r * r)
    );
  }

  private cooldownPair(i: number, j: number): void {
    const d = this.drops.state;
    d.cooldown[i] = this.params.mergeCooldown;
    d.cooldown[j] = this.params.mergeCooldown;
  }

  /** (i,j) 已有桥则返回桥槽位,否则 −1 */
  pairBridged(i: number, j: number): number {
    const s = this.state;
    for (let k = 0; k < s.count; k++) {
      const a = s.a[k]!;
      const b = s.b[k]!;
      if ((a === i && b === j) || (a === j && b === i)) return k;
    }
    return -1;
  }

  /** 桥轴胶囊侵入:第三方漂浮滴中心到线段 ij 距离 < 其半径(5% 容差) */
  private capsuleIntruded(i: number, j: number, dist: number): number {
    const d = this.drops.state;
    const n = d.count;
    const xi = d.x[i]!;
    const yi = d.y[i]!;
    const ux = (d.x[j]! - xi) / dist;
    const uy = (d.y[j]! - yi) / dist;
    for (let k = 0; k < n; k++) {
      if (k === i || k === j || d.floating[k] !== 1) continue;
      const px = d.x[k]! - xi;
      const py = d.y[k]! - yi;
      let t = px * ux + py * uy;
      t = t < 0 ? 0 : t > dist ? dist : t;
      const qx = xi + ux * t - d.x[k]!;
      const qy = yi + uy * t - d.y[k]!;
      if (Math.hypot(qx, qy) < d.r[k]! * 1.05) return k;
    }
    return -1;
  }

  /**
   * 交换删除重镜像(与 DropletSystem.removeAt 同步调用):
   * 触及被删滴的桥销毁;触及原末滴的桥端点重映射到换入位。
   * 「液桥经过第三方液滴」的完整策略 = 生成前排斥 + 生存期复检 + 本重映射。
   */
  remapOnRemove(removed: number): void {
    const s = this.state;
    const last = this.drops.state.count; // 删除后的 count = 原末位索引
    for (let k = s.count - 1; k >= 0; k--) {
      if (s.a[k] === removed || s.b[k] === removed) {
        this.breakBridge(k);
        continue;
      }
      if (s.a[k] === last) s.a[k] = removed;
      if (s.b[k] === last) s.b[k] = removed;
    }
    this.pending.fill(0, 0, this.maxN * this.maxN);
  }

  /** 液滴 i 的全部桥槽位(焦点模式分组用;写入 out,返回条数) */
  bridgesOf(i: number, out: Int32Array): number {
    const s = this.state;
    let n = 0;
    for (let k = 0; k < s.count; k++) {
      if (s.a[k] === i || s.b[k] === i) {
        if (n < out.length) out[n] = k;
        n++;
      }
    }
    return n;
  }

  /** 焦点模式:切断/恢复指定桥(cut = 张力关 + 不渲染 + 流量清零) */
  setCut(k: number, cut: boolean): void {
    this.state.cut[k] = cut ? 1 : 0;
    if (cut) this.flowRate[k] = 0;
  }
}
