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

export class DropletSystem {
  readonly params: WaterSimParams;
  readonly field: WaterField;
  readonly state: DropletState;
  /** 累计入水次数(空中→漂浮转换,只增不减) */
  impacts = 0;

  private readonly grad = new Float32Array(2);

  constructor(params: WaterSimParams, field: WaterField) {
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
    d.count = i + 1;
    return true;
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
          field.addVolumeSource(x, y, p.kernelSigma * r, -volume, p.couplingClamp);
          d.z[i] = field.totalHeight(x, y) + (r - d0);
        } else {
          d.vz[i] = vzNew;
          d.z[i] = zNew;
        }
        continue;
      }

      // ---------- 浮态段 ----------
      // 1) 浸深弛豫:d → d*(一阶,τ_b,§4.2)
      const relax = dt / p.relaxTau;
      const dOld = d.d[i]!;
      const dNew = dOld + (d.dStar[i]! - dOld) * (relax < 1 ? relax : 1);
      const dDot = (dNew - dOld) / dt;
      // 2) Δ浸深 → 动态源:注入总量 = −depthRateGain·(dV/dd·ḋ)·dt(沉得更深→更凹)
      const dVdd = Math.PI * dOld * (2 * r - dOld);
      field.addVolumeSource(
        x,
        y,
        p.kernelSigma * r,
        -p.depthRateGain * dVdd * dDot * dt,
        p.couplingClamp,
      );
      d.d[i] = dNew;
      // 3) 坡度力(§4.3):a = −slopeCoupling·g_flow·(V_sub/V_R)/ratio·∇h。
      //    g 取 g_flow = c²/H(与风格化波动力学自洽,推导同 field.ts 头注/裁决②);
      //    只采样动态 h,不含核——准静态部分不走反馈回路(§2.3 数值设计)。
      field.sampleGradient(x, y, grad);
      const vR = (4 / 3) * Math.PI * r * r * r;
      const vSub = submergenceVolume(dNew, r);
      const aSlope = (-p.slopeCoupling * field.gFlow * (vSub / vR)) / p.densityRatio;
      // 4) Stokes 阻力:a = −6πμr·v / m,m = ratio·ρ_w·V_R
      const aDrag = (6 * Math.PI * p.waterMu * r) / (p.densityRatio * p.waterRho * vR);
      const vx = d.vx[i]! + aSlope * grad[0]! * dt - aDrag * d.vx[i]! * dt;
      const vy = d.vy[i]! + aSlope * grad[1]! * dt - aDrag * d.vy[i]! * dt;
      d.vx[i] = vx;
      d.vy[i] = vy;
      d.x[i] = Math.min(Math.max(x + vx * dt, lo), hi);
      d.y[i] = Math.min(Math.max(y + vy * dt, lo), hi);
      // 5) 贴水:中心 = 总高 + (R − d)
      d.z[i] = field.totalHeight(d.x[i]!, d.y[i]!) + (r - dNew);
    }
  }
}
