// ============================================================
// 液桥(任务①,物理模型收官):连接两颗漂浮滴的液柱实体。
// 形状合同(渲染侧同源):两端略宽(嵌入液滴)、中间收窄(颈部)。
// 连接语义(调优第三批①修订,委托方裁决:液桥=关系网的边,重点是连接而非毛细作用):
//   成桥距离无关——任意两颗漂浮滴持续 drainTime 即成桥,远距对保持当前距离
//   (restLen=成桥距,连接而非收缩),靠得过近的对被推开到持距下限(最小净间距)。
// 物理:张力弹簧(常态双侧持距;拖拽期单侧——被拖端零阻力,牵连端被轻微拽动;
//       拉伸不断裂:距离变化由 rebaseRestLengths 吸收为新常态,第三批②修订)。
//   拉普拉斯压差流动已移除(调优第四批,委托方要求:液滴落下后大小不再变化——
//   原压差流动使大滴持续吸附小滴直至抽干,与该要求冲突;桥只连接不搬运体积)。
// + 侵入治理(「液桥穿过第三方液滴」;断桥的唯一途径):
//   a) 生成前胶囊排斥:桥轴线段被第三方液滴占据(膨胀 5%)→ 拒绝成桥;
//   b) 生存期 0.2s 复检:侵入持续 > grace → 断桥,双端进冷却防抖
//      (断桥同时清 pending,防冷却结束后凭旧计时瞬间重桥);
//   c) 交换删除重映射。
// 确定性:预分配池、固定顺序扫描、无对象分配热路径。
// ============================================================

import type { DropletSystem } from "./droplet";
import type { WaterSimParams } from "./params";
import type { BridgeState } from "./types";

/** 侵入判定宽限(秒):瞬时几何噪声不断桥,持续占据才断 */
const INTRUDE_GRACE = 0.2;

export class BridgeSystem {
  readonly state: BridgeState;
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
    // 桥池容量 = 完全图的边数(连接语义:任意两漂浮滴都可成桥)
    const slots = (n * (n - 1)) / 2;
    this.state = {
      count: 0,
      a: new Int32Array(slots),
      b: new Int32Array(slots),
      restLen: new Float32Array(slots),
      cut: new Uint8Array(slots),
      intrudeT: new Float32Array(slots),
    };
    this.pending = new Float32Array(n * n);
  }

  /**
   * 推进一步(dt = 固定步长):
   * 1) 成桥扫描(mergeEnabled=false 的网络模式;聚合模式下 drainTime 归聚合独占)
   * 2) 生存期:张力持距 / 侵入复检(无体积流动,第四批)
   */
  step(dt: number): void {
    if (!this.params.mergeEnabled) {
      this.scanFormation(dt);
    }
    this.stepActive(dt);
  }

  /**
   * 成桥扫描(连接语义,距离无关):漂浮对 + 双方冷却完毕 + 未成桥 + 桥轴胶囊
   * 无第三方占据,持续 drainTime → 成桥。远近一律可连;远距对连接不收缩。
   */
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
        if (dist === 0) continue; // 恒重合病态对(引擎不会产生;防除零)
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
    const d = this.drops.state;
    if (s.count >= s.a.length) return;
    const k = s.count;
    s.a[k] = i;
    s.b[k] = j;
    // restLen(连接语义):远距对 = 成桥距(把当前距离固定下来,连接而非收缩);
    // 近距对 = 持距下限 rSum·(1+bridgeRestGap)(双侧弹簧推开,根治「间距过小」)
    const rSum = d.r[i]! + d.r[j]!;
    const rest = rSum * (1 + this.params.bridgeRestGap);
    s.restLen[k] = dist > rest ? dist : rest;
    s.cut[k] = 0;
    s.intrudeT[k] = 0;
    s.count++;
    this.pending[i * this.maxN + j] = 0;
    this.formedCount++;
  }

  private breakBridge(k: number): void {
    const s = this.state;
    const last = s.count - 1;
    const i = s.a[k]!;
    const j = s.b[k]!;
    if (k !== last) {
      s.a[k] = s.a[last]!;
      s.b[k] = s.b[last]!;
      s.restLen[k] = s.restLen[last]!;
      s.cut[k] = s.cut[last]!;
      s.intrudeT[k] = s.intrudeT[last]!;
    }
    s.count--;
    this.brokenCount++;
    // 清 pending(防抖闭环):成桥距离无关后没有距离门槛替它清零,
    // 不清会在冷却结束的瞬间凭旧计时立刻重桥(断裂形同虚设)
    this.pending[i * this.maxN + j] = 0;
  }

  /** 生存期:张力持距 + 侵入复检(拉伸不断裂,第三批②修订;无体积流动,第四批) */
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
      if (s.cut[k] === 0) {
        // 张力(第三批②修订:拖拽期单侧、常态双侧、拉伸不断裂):
        // F = k·ΔL + c·u(u=分离向相对速度)。阻尼隐式化(显式失稳,与场阻尼同一对策)。
        const nx = dx / dist;
        const ny = dy / dist;
        const ma = this.mass(i);
        const mb = this.mass(j);
        const iDrag = d.drag[i] === 1;
        const jDrag = d.drag[j] === 1;
        if (iDrag || jDrag) {
          // 单侧:被拖端由手主导(移动阻力同无桥),桥只牵拉未被拖的一端
          // (牵连端再受 dragAnchorK 强锚定 → 只被轻微拽动,桥拉伸而不断裂)。
          // 符号同双侧:i 端受 +n(拉向 j),j 端受 −n(拉向 i),拉伸时互相靠近。
          if (iDrag && !jDrag) {
            this.axialImpulse(j, nx, ny, mb, -p.bridgeTensionK * (dist - rest), dt);
          } else if (jDrag && !iDrag) {
            this.axialImpulse(i, nx, ny, ma, p.bridgeTensionK * (dist - rest), dt);
          }
        } else {
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
      }
      // 侵入复检:第三方占据桥轴,持续 > grace → 断桥(唯一的断桥途径)
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

  /**
   * 单侧轴向冲量(拖拽期桥张力):对端点 m 施加沿轴(+n)方向的弹簧加速度,
   * 轴向速度隐式阻尼。force>0 推向 +n(i→j 方向)。
   */
  private axialImpulse(
    m: number,
    nx: number,
    ny: number,
    mass: number,
    force: number,
    dt: number,
  ): void {
    const d = this.drops.state;
    const vn = d.vx[m]! * nx + d.vy[m]! * ny;
    const acc = force / mass;
    const damp = this.params.bridgeTensionC / mass;
    const vnNew = (vn + acc * dt) / (1 + damp * dt);
    const dvn = vnNew - vn;
    d.vx[m] = d.vx[m]! + dvn * nx;
    d.vy[m] = d.vy[m]! + dvn * ny;
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

  /**
   * 重定液滴 i 全部桥的 restLen = max(当前距, 持距下限)(重锚定释放后调用,
   * 第三批②修订):拖拽造成的距离变化被桥吸收为新常态——连接保持、不回弹、
   * 不把牵连端继续拽向旧距离。
   */
  rebaseRestLengths(i: number): void {
    const s = this.state;
    const d = this.drops.state;
    for (let k = 0; k < s.count; k++) {
      if (s.a[k] !== i && s.b[k] !== i) continue;
      const j = s.a[k] === i ? s.b[k]! : s.a[k]!;
      if (j >= d.count || d.floating[j] !== 1) continue;
      const dist = Math.hypot(d.x[j]! - d.x[i]!, d.y[j]! - d.y[i]!);
      if (dist === 0) continue;
      const rest =
        (d.r[i]! + d.r[j]!) * (1 + this.params.bridgeRestGap);
      s.restLen[k] = dist > rest ? dist : rest;
    }
  }

  /** 焦点模式:切断/恢复指定桥(cut = 张力关 + 不渲染) */
  setCut(k: number, cut: boolean): void {
    this.state.cut[k] = cut ? 1 : 0;
  }
}
