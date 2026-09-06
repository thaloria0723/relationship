// ============================================================
// WaterEngine 门面:固定步长累积器 + 每步管线(实施文档 §3/§4.4)
// M2 管线:输入事件(出生/冲量队列)→ 液滴单体(空中/浮态)→ 场动态源项
// → 浅水步进 → 重建准静态凹陷核列表 → 统计。液滴间(碰撞/毛细/聚合)M3
// 插入 droplets.update 之后。确定性:固定 dt、类型化数组原地更新、固定顺序。
// ============================================================

import { DropletSystem } from "./droplet";
import { WaterField } from "./field";
import { validateParams, type WaterSimParams } from "./params";
import type { EngineStats } from "./types";

interface PendingImpulse {
  x: number;
  y: number;
  sigma: number;
  depth: number;
}

interface PendingSpawn {
  x: number;
  y: number;
  z: number;
  r: number;
}

export class WaterEngine {
  readonly params: WaterSimParams;
  readonly field: WaterField;
  readonly droplets: DropletSystem;
  readonly stats: EngineStats = { simTime: 0, stepCount: 0, impacts: 0 };

  private acc = 0;
  private readonly pendingImpulses: PendingImpulse[] = [];
  private readonly pendingSpawns: PendingSpawn[] = [];

  constructor(params: WaterSimParams) {
    validateParams(params);
    this.params = params;
    this.field = new WaterField(params);
    this.droplets = new DropletSystem(params, this.field);
  }

  /** 入队一个高斯冲量源(脚本/调试戳点,峰值深度语义),下一固定步生效 */
  addImpulse(x: number, y: number, sigma: number, depth: number): void {
    this.pendingImpulses.push({ x, y, sigma, depth });
  }

  /** 入队出生一颗液滴(z 为中心高度),下一固定步生效;超限在生效时拒收 */
  spawnDroplet(x: number, y: number, z: number, r: number): boolean {
    if (this.droplets.state.count + this.pendingSpawns.length >= this.params.maxDroplets) {
      return false;
    }
    this.pendingSpawns.push({ x, y, z, r });
    return true;
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
    // 1) 输入事件
    for (let k = 0; k < this.pendingImpulses.length; k++) {
      const p = this.pendingImpulses[k]!;
      this.field.addImpulse(p.x, p.y, p.sigma, p.depth);
    }
    this.pendingImpulses.length = 0;
    for (let k = 0; k < this.pendingSpawns.length; k++) {
      const p = this.pendingSpawns[k]!;
      this.droplets.spawn(p.x, p.y, p.z, p.r);
    }
    this.pendingSpawns.length = 0;
    // 2) 液滴单体:空中积分 / 浮态力求解 + 动态源注入(§4.4;液滴间 M3)
    this.droplets.update(this.params.dt);
    // 3) 场步进(波动 + 流动;已含第 2 步写入的动态源)
    this.field.step(this.params.dt);
    // 4) 重建准静态凹陷核列表(漂浮滴 → 核)
    const d = this.droplets.state;
    let n = 0;
    for (let i = 0; i < d.count; i++) {
      if (d.floating[i] === 1) {
        this.field.setKernel(n, d.x[i]!, d.y[i]!, d.r[i]!, d.d[i]!);
        n++;
      }
    }
    this.field.setKernelCount(n);
    // 5) 统计(入水计数由 DropletSystem 累计)
    this.stats.simTime += this.params.dt;
    this.stats.stepCount++;
    this.stats.impacts = this.droplets.impacts;
  }
}
