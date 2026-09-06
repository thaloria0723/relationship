// ============================================================
// 水面场:线性浅水(波 + 流)+ 源项 + 吸收/反射边界(实施文档 §4.1)
// 网格:顶点中心 N×N,dx = domainSize/(N−1);速度用交错 C 网格防棋盘失稳。
// 两条演化路径的可见波速均为参数 c:
//  - flowOn=true :一阶浅水 h_t = −H∇·u − λh;u_t = −g_flow∇h − μf·u + ν∇²u。
//    g_flow = c²/H(派生,见 params.ts 头注)使波速 √(g_flow·H) 恰为 c;
//    质量守恒回耦内建于该格式,与 flowOn 同开关。
//  - flowOn=false:纯波动方程 h_tt = c²∇²h − 2λh_t,leapfrog。
// 边界:absorb = sponge 吸收带(附加局部阻尼,二次坡形);reflect = 法向速度
// 置零 + h Neumann。全引擎热路径零对象分配(预分配 scratch,原地交换)。
// ============================================================

import { validateParams, type WaterSimParams } from "./params";
import type { FieldState } from "./types";

/** sponge 吸收带峰值附加阻尼(s⁻¹);带内二次坡形衰减到内缘为 0 */
const SPONGE_PEAK = 60;

/**
 * h 的网格尺度扩散系数(每步,五点拉普拉斯)。
 * 半隐式 Euler + C 网格在「对角 Nyquist 角点」(c·dt/dx·√2·π > 2)有轻微
 * 增率,线性浅水标准对策是给 h 加小扩散:角点每步衰减 ~8%,可见波长
 * (k·dx≈0.5)每步 <0.5%,波速测试与视觉不受影响。
 */
const H_GRID_DIFFUSION = 0.01;

export class WaterField {
  readonly params: WaterSimParams;
  readonly N: number;
  readonly dx: number;
  readonly state: FieldState;

  private readonly hScratch: Float32Array;
  private readonly hSmooth: Float32Array;
  private readonly uScratch: Float32Array;
  private readonly vScratch: Float32Array;
  /** 每格附加阻尼 λ_local(s⁻¹),absorb 模式边缘带内非零 */
  private readonly sponge: Float32Array;
  /** 流动层驱动重力 g_flow = c²/H */
  private readonly gFlow: number;

  constructor(params: WaterSimParams) {
    validateParams(params);
    this.params = params;
    const N = params.gridN;
    this.N = N;
    this.dx = params.domainSize / (N - 1);
    const n2 = N * N;
    this.state = {
      h: new Float32Array(n2),
      hPrev: new Float32Array(n2),
      u: new Float32Array(n2),
      v: new Float32Array(n2),
    };
    this.hScratch = new Float32Array(n2);
    this.hSmooth = new Float32Array(n2);
    this.uScratch = new Float32Array(n2);
    this.vScratch = new Float32Array(n2);
    this.sponge = new Float32Array(n2);
    this.gFlow = (params.waveSpeed * params.waveSpeed) / params.meanDepth;
    this.buildSponge();
  }

  private buildSponge(): void {
    if (this.params.boundaryMode !== "absorb") return;
    const { N, sponge } = this;
    const W = this.params.spongeWidth;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const d = Math.min(i, j, N - 1 - i, N - 1 - j);
        if (d < W) {
          const t = (W - d) / W;
          sponge[j * N + i] = SPONGE_PEAK * t * t;
        }
      }
    }
  }

  /**
   * 高斯冲量源:直接在 h 上叠加(3σ 截断)。depth < 0 为凹陷(戳水/落滴)。
   * 这是脚本/测试的显式源;液滴耦合源(M2)走钳制路径,不经此口。
   */
  addImpulse(cx: number, cy: number, sigma: number, depth: number): void {
    const { N, dx, state } = this;
    const cellSigma = sigma / dx;
    const r = Math.ceil(3 * cellSigma);
    const gx = cx / dx;
    const gy = cy / dx;
    const i0 = Math.max(0, Math.floor(gx) - r);
    const i1 = Math.min(N - 1, Math.ceil(gx) + r);
    const j0 = Math.max(0, Math.floor(gy) - r);
    const j1 = Math.min(N - 1, Math.ceil(gy) + r);
    const inv = 1 / (2 * cellSigma * cellSigma);
    const h = state.h;
    for (let j = j0; j <= j1; j++) {
      const ddy = j - gy;
      for (let i = i0; i <= i1; i++) {
        const ddx = i - gx;
        const q = (ddx * ddx + ddy * ddy) * inv;
        if (q <= 9) {
          const idx = j * N + i;
          h[idx] = h[idx]! + depth * Math.exp(-q);
        }
      }
    }
  }

  /** 场能量(相对量,焦耳量纲不保证):HUD 波场能量与单调衰减测试用 */
  energy(): number {
    const { N, dx, params, state } = this;
    const { h, hPrev, u, v } = state;
    const c = params.waveSpeed;
    let sum = 0;
    if (params.flowOn) {
      // 浅水能量 ½∫(g_flow·h² + H|u|²),g_flow = c²/H
      const gh = (c * c) / params.meanDepth;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = j * N + i;
          sum += gh * h[idx]! * h[idx]! + params.meanDepth * (u[idx]! * u[idx]! + v[idx]! * v[idx]!);
        }
      }
    } else {
      // 波动方程能量 ½∫(ḣ² + c²|∇h|²)
      const invDt = 1 / params.dt;
      const c2 = c * c;
      const inv2dx = 1 / (2 * dx);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = j * N + i;
          const hc = h[idx]!;
          const hL = i > 0 ? h[idx - 1]! : hc;
          const hR = i < N - 1 ? h[idx + 1]! : hc;
          const hD = j > 0 ? h[idx - N]! : hc;
          const hU = j < N - 1 ? h[idx + N]! : hc;
          const gx = (hR - hL) * inv2dx;
          const gy = (hU - hD) * inv2dx;
          const ht = (hc - hPrev[idx]!) * invDt;
          sum += ht * ht + c2 * (gx * gx + gy * gy);
        }
      }
    }
    return 0.5 * dx * dx * sum;
  }

  maxAbsH(): number {
    const { N, state } = this;
    const h = state.h;
    let m = 0;
    for (let idx = 0; idx < N * N; idx++) {
      const a = Math.abs(h[idx]!);
      if (a > m) m = a;
    }
    return m;
  }

  /** 推进一个固定步(dt 由引擎传 params.dt) */
  step(dt: number): void {
    if (this.params.flowOn) {
      this.stepShallowWater(dt);
    } else {
      this.stepWaveEquation(dt);
    }
  }

  /** flowOn=false:h_tt = c²∇²h − 2λh_t,leapfrog,Neumann 边界 */
  private stepWaveEquation(dt: number): void {
    const { N, dx, params, state, hScratch, sponge } = this;
    const { h, hPrev } = state;
    const cx = params.waveSpeed * dt;
    const c2 = (cx * cx) / (dx * dx);
    const base = params.waveDamping;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const hc = h[idx]!;
        const hp = hPrev[idx]!;
        const hL = i > 0 ? h[idx - 1]! : hc;
        const hR = i < N - 1 ? h[idx + 1]! : hc;
        const hD = j > 0 ? h[idx - N]! : hc;
        const hU = j < N - 1 ? h[idx + N]! : hc;
        const lamLoc = base + sponge[idx]!;
        hScratch[idx] =
          2 * hc - hp + c2 * (hL + hR + hD + hU - 4 * hc) - 2 * lamLoc * dt * (hc - hp);
      }
    }
    hPrev.set(h);
    h.set(hScratch);
  }

  /**
   * flowOn=true:C 网格半隐式 Euler(先 u/v 后 h,质量守恒回耦)。
   * u[i,j] 位于节点 (i,j)-(i+1,j) 之间的 x 面,末列恒 0;v 同理末行恒 0。
   */
  private stepShallowWater(dt: number): void {
    const { N, dx, params, state, hScratch, hSmooth, uScratch, vScratch, sponge } = this;
    const { h, u, v } = state;
    const gFlow = this.gFlow;
    const muF = params.flowFriction;
    const nu = params.flowViscosity;
    const depth = params.meanDepth;
    const base = params.waveDamping;
    const invDx = 1 / dx;
    const nuDtDx2 = (nu * dt) / (dx * dx);

    // --- 速度层:x 面(摩擦/sponge 阻尼隐式处理:边界角落的显式阻尼×
    //     半隐式回耦会形成 +8%/步的角落增长模式,隐式化为 contraction 根治) ---
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N - 1; i++) {
        const idx = j * N + i;
        const uc = u[idx]!;
        // reflect:靠墙法向面冻结;absorb:靠 sponge 阻尼
        if (params.boundaryMode === "reflect" && i === 0) {
          uScratch[idx] = 0;
          continue;
        }
        const gradH = (h[idx + 1]! - h[idx]!) * invDx;
        const uL = i > 0 ? u[idx - 1]! : uc;
        const uR = i < N - 2 ? u[idx + 1]! : uc;
        const uD = j > 0 ? u[idx - N]! : uc;
        const uU = j < N - 1 ? u[idx + N]! : uc;
        const lap = uL + uR + uD + uU - 4 * uc;
        const drag = muF + 0.5 * (sponge[idx]! + sponge[idx + 1]!);
        uScratch[idx] = (uc - dt * gFlow * gradH + nuDtDx2 * lap) / (1 + dt * drag);
      }
      uScratch[j * N + N - 1] = 0; // 域外面恒 0
    }

    // --- 速度层:y 面 ---
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const vc = v[idx]!;
        if (params.boundaryMode === "reflect" && j === 0) {
          vScratch[idx] = 0;
          continue;
        }
        const gradH = (h[idx + N]! - h[idx]!) * invDx;
        const vL = i > 0 ? v[idx - 1]! : vc;
        const vR = i < N - 1 ? v[idx + 1]! : vc;
        const vD = j > 0 ? v[idx - N]! : vc;
        const vU = j < N - 2 ? v[idx + N]! : vc;
        const lap = vL + vR + vD + vU - 4 * vc;
        const drag = muF + 0.5 * (sponge[idx]! + sponge[idx + N]!);
        vScratch[idx] = (vc - dt * gFlow * gradH + nuDtDx2 * lap) / (1 + dt * drag);
      }
    }
    // 末行(域外面)恒 0:Float32Array 初值即 0,且从不在内层写入
    for (let i = 0; i < N; i++) vScratch[(N - 1) * N + i] = 0;

    // --- 高度层:h_t = −H∇·u′ − (λ+λ_sp)h(用已更新的 u′/v′,质量守恒回耦;阻尼隐式) ---
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const divU = (uScratch[idx]! - (i > 0 ? uScratch[idx - 1]! : 0)) * invDx;
        const divV = (vScratch[idx]! - (j > 0 ? vScratch[idx - N]! : 0)) * invDx;
        const hc = h[idx]!;
        hScratch[idx] = (hc - dt * depth * (divU + divV)) / (1 + dt * (base + sponge[idx]!));
      }
    }

    // --- 网格尺度扩散(压对角 Nyquist 模式,见 H_GRID_DIFFUSION 注) ---
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const hc = hScratch[idx]!;
        const hL = i > 0 ? hScratch[idx - 1]! : hc;
        const hR = i < N - 1 ? hScratch[idx + 1]! : hc;
        const hD = j > 0 ? hScratch[idx - N]! : hc;
        const hU = j < N - 1 ? hScratch[idx + N]! : hc;
        hSmooth[idx] = hc + H_GRID_DIFFUSION * (hL + hR + hD + hU - 4 * hc);
      }
    }

    u.set(uScratch);
    v.set(vScratch);
    h.set(hSmooth);
    // hPrev 与 h 同步维护(能量/测试口径统一;仅 flowOn=false 路径读它)
    state.hPrev.set(hSmooth);
  }
}
