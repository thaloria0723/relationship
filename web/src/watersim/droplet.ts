// ============================================================
// 液滴单体(§2.2 / §4.2 / §4.3):空中自由落体、接触检测、平衡浸深弛豫、
// 耦合注入(入水冲量 + Δ浸深源)、坡度漂移。液滴间行为(碰撞/毛细/聚合)
// 在 pairs.ts(M3)。零渲染依赖。
//
// 垂直方向免反馈设计(§4.2):接触后不显式积分 z——每步把 d 向 d* 一阶弛豫,
// 垂直变化的可见后果全部走「体积源注入场」;中心高度贴水面 = 总高 + (R − d)。
// ============================================================

import {
  solveEquilibriumDepth,
  submergenceVolume,
  type WaterField,
} from "./field";
import type { WaterSimParams } from "./params";
import type { DropletState } from "./types";

/**
 * 入水瞬态的调度出口(整改裁决 D′):引擎实现本接口,把冲击总量分摊到
 * 弹坑发射器(~10 步展开,峰值远低于 couplingClamp);无 host 时退化为
 * 单步注入(direct 使用的测试/工具路径,clamp 同样生效)。
 */
export interface DropletHost {
  scheduleImpact(x: number, y: number, sigma: number, volume: number): void;
}

/** 冲击源 σ(×r):窄于核(裁决 D′),弹坑深陡 */
export const IMPACT_SIGMA_RATIO = 0.7;

export class DropletSystem {
  readonly params: WaterSimParams;
  readonly field: WaterField;
  readonly state: DropletState;
  /** 累计入水次数(空中→漂浮转换,只增不减) */
  impacts = 0;

  /** 悬停液滴索引(−1 无;模块②意图) */
  hovered = -1;
  /** 拖拽液滴索引(−1 无)与指针目标点 */
  dragIndex = -1;
  dragTX = 0;
  dragTY = 0;
  /** 拖拽起始位置(重锚定判定位移用) */
  dragStartX = 0;
  dragStartY = 0;
  /** 拖拽累计步数(重锚定判定时长用) */
  dragSteps = 0;

  private readonly grad = new Float32Array(2);

  constructor(
    params: WaterSimParams,
    field: WaterField,
    private readonly host?: DropletHost,
  ) {
    this.params = params;
    this.field = field;
    const max = params.maxDroplets;
    this.state = {
      count: 0,
      x: new Float32Array(max),
      y: new Float32Array(max),
      z: new Float32Array(max),
      vz: new Float32Array(max),
      vx: new Float32Array(max),
      vy: new Float32Array(max),
      r: new Float32Array(max),
      d: new Float32Array(max),
      dStar: new Float32Array(max),
      floating: new Uint8Array(max),
      eps: new Float32Array(max),
      epsVel: new Float32Array(max),
      bridgeT: new Float32Array(max),
      cooldown: new Float32Array(max),
      anchorX: new Float32Array(max),
      anchorY: new Float32Array(max),
      lift: new Float32Array(max),
      homeX: new Float32Array(max),
      homeY: new Float32Array(max),
      drag: new Uint8Array(max),
      returning: new Uint8Array(max),
      lev: new Uint8Array(max),
    };
  }

  /** 出生一颗滴;超限拒收(§5.4 maxDroplets)。z 为中心高度(相对平均水面) */
  spawn(x: number, y: number, z: number, r: number): boolean {
    const d = this.state;
    if (d.count >= this.params.maxDroplets) return false;
    const i = d.count;
    const margin = 3 * this.field.dx;
    d.x[i] = Math.min(Math.max(x, margin), this.params.domainSize - margin);
    d.y[i] = Math.min(Math.max(y, margin), this.params.domainSize - margin);
    d.z[i] = z;
    d.vz[i] = 0;
    d.vx[i] = 0;
    d.vy[i] = 0;
    d.r[i] = r;
    d.d[i] = 0;
    d.dStar[i] = solveEquilibriumDepth(r, this.params.densityRatio);
    d.floating[i] = 0;
    d.eps[i] = 0;
    d.epsVel[i] = 0;
    d.bridgeT[i] = 0;
    d.cooldown[i] = 0;
    d.anchorX[i] = d.x[i];
    d.anchorY[i] = d.y[i];
    d.lift[i] = 0;
    d.homeX[i] = d.x[i];
    d.homeY[i] = d.y[i];
    d.drag[i] = 0;
    d.returning[i] = 0;
    d.lev[i] = 0;
    d.count = i + 1;
    return true;
  }

  /**
   * 交换删除第 i 颗滴(M3 聚合用):把最后一滴搬到 i 并 count−1。
   * 所有并行数组同步搬运;语义与「液滴个体状态(紧凑数组 + count,交换删除)」一致。
   */
  removeAt(i: number): void {
    const d = this.state;
    const last = d.count - 1;
    if (i !== last) {
      d.x[i] = d.x[last]!;
      d.y[i] = d.y[last]!;
      d.z[i] = d.z[last]!;
      d.vz[i] = d.vz[last]!;
      d.vx[i] = d.vx[last]!;
      d.vy[i] = d.vy[last]!;
      d.r[i] = d.r[last]!;
      d.d[i] = d.d[last]!;
      d.dStar[i] = d.dStar[last]!;
      d.floating[i] = d.floating[last]!;
      d.eps[i] = d.eps[last]!;
      d.epsVel[i] = d.epsVel[last]!;
      d.bridgeT[i] = d.bridgeT[last]!;
      d.cooldown[i] = d.cooldown[last]!;
      d.anchorX[i] = d.anchorX[last]!;
      d.anchorY[i] = d.anchorY[last]!;
      d.lift[i] = d.lift[last]!;
      d.homeX[i] = d.homeX[last]!;
      d.homeY[i] = d.homeY[last]!;
      d.drag[i] = d.drag[last]!;
      d.returning[i] = d.returning[last]!;
      d.lev[i] = d.lev[last]!;
    }
    d.count = last;
  }

  /**
   * 形状弹簧一步(§4.3 Deformation):ε'' = k_st(ε_eq−ε) − c_st·ε′,
   * ε_eq = ε_max·(V_sub/V)。半隐式 Euler;浮态滴每步调用。
   * 碰撞/聚合的 ε 踢振 = 直接给 epsVel 加冲量(由 pairs.ts 完成)。
   */
  stepShapeSpring(i: number, dt: number): void {
    const d = this.state;
    const p = this.params;
    const r = d.r[i]!;
    const vR = (4 / 3) * Math.PI * r * r * r;
    const vSub = submergenceVolume(d.d[i]!, r);
    const epsEq = p.epsMax * Math.min(vSub / vR, 1);
    // 半隐式 Euler:先更新速度再更新位置(弹簧稳定性:k·dt² < 4;dt=1/150、k=40 时 dt²k≈0.0018)
    const acc =
      p.shapeStiffness * (epsEq - d.eps[i]!) - p.shapeDamping * d.epsVel[i]!;
    d.epsVel[i] = d.epsVel[i]! + acc * dt;
    d.eps[i] = Math.min(Math.max(d.eps[i]! + d.epsVel[i]! * dt, 0), p.epsMax);
  }

  // ---- 模块②意图 API(引擎转发;物理在 update 内承接) ----
  setHovered(i: number): void {
    this.hovered = i;
  }

  beginDrag(i: number, x: number, y: number): void {
    const d = this.state;
    if (i < 0 || i >= d.count) return;
    this.dragIndex = i;
    d.drag[i] = 1;
    d.returning[i] = 0;
    this.dragTX = x;
    this.dragTY = y;
    this.dragStartX = d.x[i]!;
    this.dragStartY = d.y[i]!;
    this.dragSteps = 0;
  }

  setDragTarget(x: number, y: number): void {
    this.dragTX = x;
    this.dragTY = y;
  }

  /**
   * 结束拖拽。返回 true = 重锚定模式(锚点迁至松手处,引擎据此重定桥长)。
   * 拖拽双模式(调优第三批 #2 收紧门槛):重锚定须「拖住 ≥1.0s 且位移 ≥0.15m」
   * 同时成立(原 OR 判定下慢拖 1s 即重锚定,常见误触导致液滴滞留异处);
   * 其余一律弹回初始落点(出生锚点 anchor,调优第三批:不再用抓取位)
   */
  endDrag(): boolean {
    const i = this.dragIndex;
    if (i < 0) return false;
    const d = this.state;
    d.drag[i] = 0;
    const held = this.dragSteps * this.params.dt >= 1.0;
    const moved =
      Math.hypot(d.x[i]! - this.dragStartX, d.y[i]! - this.dragStartY) >= 0.15;
    if (held && moved) {
      d.anchorX[i] = d.x[i]!;
      d.anchorY[i] = d.y[i]!;
      d.homeX[i] = d.x[i]!;
      d.homeY[i] = d.y[i]!;
      d.returning[i] = 0;
      this.dragIndex = -1;
      return true;
    }
    d.homeX[i] = d.anchorX[i]!;
    d.homeY[i] = d.anchorY[i]!;
    d.returning[i] = 1;
    this.dragIndex = -1;
    return false;
  }

  setLevitate(i: number, on: boolean): void {
    const d = this.state;
    if (i < 0 || i >= d.count) return;
    d.lev[i] = on ? 1 : 0;
    if (!on && d.floating[i] === 1) {
      // 退出悬浮:改走空中段自然坠落(重新入水触发溅落)
      d.floating[i] = 0;
      d.vz[i] = 0;
      d.d[i] = 0;
    }
  }

  /** 推进一颗(dt = 固定步长) */
  update(dt: number): void {
    const { params: p, field, state: d, grad } = this;
    const margin = 3 * field.dx;
    const lo = margin;
    const hi = p.domainSize - margin;
    for (let i = 0; i < d.count; i++) {
      const r = d.r[i]!;
      const x = d.x[i]!;
      const y = d.y[i]!;

      // ---------- 空中段:显式积分 z、vz(§4.2) ----------
      if (d.floating[i] === 0) {
        const vzNew = d.vz[i]! - p.gravity * dt;
        const zNew = d.z[i]! + vzNew * dt;
        const surf = field.totalHeight(x, y);
        if (zNew - r <= surf) {
          // ---- 接触(§2.3):初浸深 → 浮态;入水冲量注入(∝ r²·|vz|·t_c) ----
          let d0 = surf - (zNew - r);
          if (d0 < 0.05 * r) d0 = 0.05 * r;
          if (d0 > 2 * r * 0.999) d0 = 2 * r * 0.999;
          d.d[i] = d0;
          d.vz[i] = vzNew;
          d.z[i] = zNew;
          d.floating[i] = 1;
          this.impacts++;
          const vzAbs = Math.abs(vzNew);
          const tContact = r / Math.max(vzAbs, 0.1); // 接触时间尺度 r/v
          const volume = p.impulseGain * r * r * vzAbs * tContact;
          const sigma = IMPACT_SIGMA_RATIO * r;
          if (this.host) {
            this.host.scheduleImpact(x, y, sigma, -volume);
          } else {
            field.addVolumeSource(x, y, sigma, -volume, p.couplingClamp);
          }
          d.z[i] = field.totalHeight(x, y) + (r - d0);
        } else {
          d.vz[i] = vzNew;
          d.z[i] = zNew;
        }
        continue;
      }

      // ---------- 焦点悬浮(模块②意图):脱离水面耦合,z 逼近悬浮高度 ----------
      if (d.lev[i] === 1) {
        const surfL = field.totalHeight(x, y);
        const zTarget = surfL + r + p.levitateHeight;
        d.z[i] = d.z[i]! + (zTarget - d.z[i]!) * Math.min(1, dt * 6);
        d.d[i] = 0.05 * r; // 近离水:静态核收缩,不注入 ΔV(免反馈)
        d.vx[i] = d.vx[i]! * Math.exp(-4 * dt);
        d.vy[i] = d.vy[i]! * Math.exp(-4 * dt);
        d.x[i] = Math.min(Math.max(x + d.vx[i]! * dt, lo), hi);
        d.y[i] = Math.min(Math.max(y + d.vy[i]! * dt, lo), hi);
        continue;
      }

      // ---------- 浮态段 ----------
      // 0) 悬停升力平滑(模块②):有效平衡浸深 = d*·(1 − hoverLift·lift)
      //    → 液滴浮出水面;Δ浸深经既有耦合自动辐射波纹(乘 hoverRippleGain 增强)
      const liftTarget = this.hovered === i ? 1 : 0;
      d.lift[i] =
        liftTarget + (d.lift[i]! - liftTarget) * Math.exp(-dt / p.hoverLiftTau);
      const dStarEff = d.dStar[i]! * (1 - p.hoverLift * d.lift[i]!);
      // 1) 浸深弛豫:d → d*_eff(一阶,τ_b,§4.2)(聚合冷却递减在 pairs.ts 统一做)
      const relax = dt / p.relaxTau;
      const dOld = d.d[i]!;
      const dNew = dOld + (dStarEff - dOld) * (relax < 1 ? relax : 1);
      const dDot = (dNew - dOld) / dt;
      // 2) Δ浸深 → 动态源:注入总量 = −depthRateGain·(dV/dd·ḋ)·dt(沉得更深→更凹)
      const dVdd = Math.PI * dOld * (2 * r - dOld);
      const envGain = 1 + p.hoverRippleGain * d.lift[i]!; // 悬停液滴波纹增强(模块②)
      field.addVolumeSource(
        x,
        y,
        p.kernelSigma * r,
        -p.depthRateGain * envGain * dVdd * dDot * dt,
        p.couplingClamp,
      );
      d.d[i] = dNew;
      // 2.7) 交互接管(模块②):拖拽中速度导向指针;释放后欠阻尼弹簧缓慢弹回
      //      抓取位;接管期间跳过钉扎/坡度(手的主导性)。回弹到位 → 锚点迁至回弹位。
      let skipEnv = false;
      if (d.drag[i] === 1) {
        d.vx[i] =
          d.vx[i]! + ((this.dragTX - x) * p.dragFollow - p.dragDamp * d.vx[i]!) * dt;
        d.vy[i] =
          d.vy[i]! + ((this.dragTY - y) * p.dragFollow - p.dragDamp * d.vy[i]!) * dt;
        this.dragSteps++;
        skipEnv = true;
      } else if (d.returning[i] === 1) {
        const rdx = d.homeX[i]! - x;
        const rdy = d.homeY[i]! - y;
        d.vx[i] = d.vx[i]! + (p.returnK * rdx - p.returnC * d.vx[i]!) * dt;
        d.vy[i] = d.vy[i]! + (p.returnK * rdy - p.returnC * d.vy[i]!) * dt;
        if (Math.hypot(rdx, rdy) < 0.002 && Math.hypot(d.vx[i]!, d.vy[i]!) < 0.02) {
          d.returning[i] = 0;
          d.anchorX[i] = d.homeX[i]!;
          d.anchorY[i] = d.homeY[i]!;
        }
        skipEnv = true;
      }
      if (!skipEnv) {
      // 2.45) 落点回位弹簧:始终朝出生锚点回拉(与钉扎死区语义互补:死区内
      //       也有回位,波停即归位)。与 driftDamping 组成欠阻尼回弹,
      //       波浪仍可推动液滴小幅晃动(物理感),停止扰动后回到初始落点。
      d.vx[i] = d.vx[i]! - p.homeK * (x - d.anchorX[i]!) * dt;
      d.vy[i] = d.vy[i]! - p.homeK * (y - d.anchorY[i]!) * dt;
      // 2.5) 接触线钉扎恢复力(裁决 §12.2-C′,近似接触角滞后 pinning):
      //      离出生锚点超过 pinRadius 后,受线性弹簧回拉(临界阻尼增稳);
      //      pinRadius 内自由漂移(波浪推动不受限),锚点固定不漂移。
      const ax0 = d.anchorX[i]!;
      const ay0 = d.anchorY[i]!;
      const pinDx = x - ax0;
      const pinDy = y - ay0;
      const pinDist = Math.hypot(pinDx, pinDy);
      if (p.pinStrength > 0 && pinDist > p.pinRadius) {
        const over = pinDist - p.pinRadius;
        const nx = pinDx / pinDist;
        const ny = pinDy / pinDist;
        // 临界阻尼:c_pin = 2·√(k_pin/m),回拉加速度 = −(k/m)·over − (c/m)·v_n
        const m = p.densityRatio * p.waterRho * ((4 / 3) * Math.PI * r * r * r);
        const kOverM = p.pinStrength / m;
        const cOverM = 2 * Math.sqrt(kOverM);
        const vn = d.vx[i]! * nx + d.vy[i]! * ny;
        d.vx[i] =
          d.vx[i]! - (kOverM * over + cOverM * Math.max(vn, 0)) * nx * dt;
        d.vy[i] =
          d.vy[i]! - (kOverM * over + cOverM * Math.max(vn, 0)) * ny * dt;
      }
      // 3) 坡度力(§4.3):a = −slopeCoupling·g_flow·(V_sub/V_R)/ratio·∇h。
      //    g 取 g_flow = c²/H(与风格化波动力学自洽,推导同 field.ts 头注/裁决②);
      //    只采样动态 h,不含核——准静态部分不走反馈回路(§2.3 数值设计)。
      field.sampleGradient(x, y, grad);
      const vR = (4 / 3) * Math.PI * r * r * r;
      const vSub = submergenceVolume(dNew, r);
      const aSlope =
        (-p.slopeCoupling * field.gFlow * (vSub / vR)) / p.densityRatio;
      // 4) Stokes 阻力 + 漂移阻尼:a = −6πμr·v / m,m = ratio·ρ_w·V_R。
      //    物理 Stokes 对厘米级液滴仅 ~0.05 s⁻¹,波浪推动下液滴长时间乱漂;
      //    driftDamping 为风格化线性阻尼(调优第三批 #2「移动阻力过低」)
      const aDrag =
        (6 * Math.PI * p.waterMu * r) / (p.densityRatio * p.waterRho * vR) +
        p.driftDamping;
      const vx = d.vx[i]! + aSlope * grad[0]! * dt - aDrag * d.vx[i]! * dt;
      const vy = d.vy[i]! + aSlope * grad[1]! * dt - aDrag * d.vy[i]! * dt;
      d.vx[i] = vx;
      d.vy[i] = vy;
      } // skipEnv(交互接管时跳过坡度/钉扎;速度已由接管分支直接写入)
      d.x[i] = Math.min(Math.max(x + d.vx[i]! * dt, lo), hi);
      d.y[i] = Math.min(Math.max(y + d.vy[i]! * dt, lo), hi);
      // 2.9) 牵连位移圈(第三批②修订):拖拽进行时,未被拖的漂浮滴(被牵连端)
      //      移动阻力极大——离出生锚点超过 dragAnchorShift 即投影回圈内并削掉
      //      外向径向速度。位置级硬约束,不依赖桥张力/弹簧刚度比,按构造保证
      //      「只能被轻微拽动」;被拖端走 skipEnv 分支不受影响,桥拉伸而不断裂。
      if (this.dragIndex >= 0 && d.drag[i] !== 1) {
        const adx = d.x[i]! - d.anchorX[i]!;
        const ady = d.y[i]! - d.anchorY[i]!;
        const aDist = Math.hypot(adx, ady);
        if (aDist > p.dragAnchorShift) {
          const s = p.dragAnchorShift / aDist;
          d.x[i] = d.anchorX[i]! + adx * s;
          d.y[i] = d.anchorY[i]! + ady * s;
          const nx = adx / aDist;
          const ny = ady / aDist;
          const vn = d.vx[i]! * nx + d.vy[i]! * ny;
          if (vn > 0) {
            // 只削外向分量(切向运动不干预),防约束边界上的速度蓄积
            d.vx[i] = d.vx[i]! - vn * nx;
            d.vy[i] = d.vy[i]! - vn * ny;
          }
        }
      }
      // 5) 贴水(第四批修订:一阶随动):中心朝「总高 + (R − d)」弛豫而非逐帧
      //    硬贴。硬贴会让液滴逐帧跟随自身悬停涟漪泵与入水高频纹波(~9Hz、
      //    ±1.3mm)→ 快速颤动;zFollowTau 一阶低通只削高频,慢速升力浮出
      //    (τ=0.3s)与波浪 riding 不受影响;zFollowTau=0 退回逐帧硬贴。
      const zTarget = field.totalHeight(d.x[i]!, d.y[i]!) + (r - dNew);
      d.z[i] =
        p.zFollowTau > 0
          ? d.z[i]! +
            (zTarget - d.z[i]!) * (1 - Math.exp(-dt / p.zFollowTau))
          : zTarget;
      // 6) 形状弹簧(§4.3 Deformation;碰撞/聚合踢振由 pairs.ts 注入 epsVel)
      this.stepShapeSpring(i, dt);
    }
  }
}
