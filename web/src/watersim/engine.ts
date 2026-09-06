// ============================================================
// WaterEngine 门面:固定步长累积器 + 每步管线(实施文档 §3/§4.4)
// M1 管线:输入事件(冲量队列)→ 场步进。液滴段在 M2/M3 插入同一管线。
// 确定性:固定 dt、类型化数组原地更新、固定顺序;同输入逐位可复现。
// ============================================================

import { WaterField } from "./field";
import { validateParams, type WaterSimParams } from "./params";
import type { EngineStats } from "./types";

interface PendingImpulse {
  x: number;
  y: number;
  sigma: number;
  depth: number;
}

export class WaterEngine {
  readonly params: WaterSimParams;
  readonly field: WaterField;
  readonly stats: EngineStats = { simTime: 0, stepCount: 0 };

  private acc = 0;
  private readonly pending: PendingImpulse[] = [];

  constructor(params: WaterSimParams) {
    validateParams(params);
    this.params = params;
    this.field = new WaterField(params);
  }

  /** 入队一个高斯冲量源,下一固定步生效(精确一次) */
  addImpulse(x: number, y: number, sigma: number, depth: number): void {
    this.pending.push({ x, y, sigma, depth });
  }

  /**
   * 渲染帧驱动入口:按真实帧时长累积,执行 0..maxSubsteps 个固定步。
   * 触顶时钳制累加器(防螺旋死亡:渲染跟不上时丢弃积压,时间不追赶)。
   */
  advance(frameDt: number): void {
    const dt = this.params.dt;
    this.acc += Math.max(0, frameDt);
    let steps = 0;
    while (this.acc >= dt && steps < this.params.maxSubsteps) {
      this.stepFixed();
      steps++;
      this.acc -= dt;
    }
    if (steps === this.params.maxSubsteps && this.acc > dt) {
      this.acc = dt;
    }
  }

  /** 恰好执行一个固定步(确定性测试与单步调试用) */
  stepFixed(): void {
    for (let k = 0; k < this.pending.length; k++) {
      const p = this.pending[k]!;
      this.field.addImpulse(p.x, p.y, p.sigma, p.depth);
    }
    this.pending.length = 0;
    this.field.step(this.params.dt);
    this.stats.simTime += this.params.dt;
    this.stats.stepCount++;
  }
}
