// ============================================================
// WaterEngine 门面:固定步长累积器 + 每步管线(实施文档 §3/§4.4)
// M2 管线:输入事件(出生/冲量队列)→ 液滴单体(空中/浮态)→ 场动态源项
// → 浅水步进 → 重建准静态凹陷核列表 → 统计。液滴间(碰撞/毛细/聚合)M3
// 插入 droplets.update 之后。确定性:固定 dt、类型化数组原地更新、固定顺序。
// ============================================================

import { BridgeSystem } from "./bridges";
import { DropletSystem, IMPACT_SIGMA_RATIO, type DropletHost } from "./droplet";
import { WaterField } from "./field";
import { DropletPairs } from "./pairs";
import { validateParams, type WaterSimParams } from "./params";
import type { EngineStats } from "./types";

/** 弹坑展开步数(裁决 D′):~67ms,每步峰值 ≪ couplingClamp,数值柔和拒平顶 */
const CRATER_STEPS = 10;

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

/** 弹坑发射器:一次性瞬态体积源,分 CRATER_STEPS 步摊完(预分配池) */
interface CraterEmitter {
  active: boolean;
  x: number;
  y: number;
  sigma: number;
  volumeLeft: number;
  stepsLeft: number;
}

export class WaterEngine implements DropletHost {
  readonly params: WaterSimParams;
  readonly field: WaterField;
  readonly droplets: DropletSystem;
  readonly pairs: DropletPairs;
  readonly bridges: BridgeSystem;
  readonly stats: EngineStats = {
    simTime: 0,
    stepCount: 0,
    impacts: 0,
    merges: 0,
  };

  private acc = 0;
  private readonly pendingImpulses: PendingImpulse[] = [];
  private readonly pendingSpawns: PendingSpawn[] = [];
  private readonly craters: CraterEmitter[];

  constructor(params: WaterSimParams) {
    validateParams(params);
    this.params = params;
    this.field = new WaterField(params);
    // 每颗液滴至多入水一次 ⇒ 并发弹坑 ≤ maxDroplets,池不会溢出
    this.craters = Array.from({ length: params.maxDroplets }, () => ({
      active: false,
      x: 0,
      y: 0,
      sigma: 0,
      volumeLeft: 0,
      stepsLeft: 0,
    }));
    this.droplets = new DropletSystem(params, this.field, this);
    // 聚合涟漪:与入水弹坑同通道(分步展开,峰值受 clamp 约束)。
    // 脉冲体积 ∝ mergeRipple·rNew³(体积量纲,风格化幅度系数 §5.5)
    this.pairs = new DropletPairs(
      params,
      this.droplets,
      (x, y, rNew) => {
        this.scheduleImpact(
          x,
          y,
          IMPACT_SIGMA_RATIO * rNew,
          -this.params.mergeRipple * rNew * rNew * rNew,
        );
      },
      (removedIdx) => this.bridges.remapOnRemove(removedIdx),
    );
    this.bridges = new BridgeSystem(params, this.droplets);
  }

  /** 入水冲击 → 激活弹坑发射器(总量不变,分摊展开;clamp 语义不变) */
  scheduleImpact(x: number, y: number, sigma: number, volume: number): void {
    for (let k = 0; k < this.craters.length; k++) {
      const c = this.craters[k]!;
      if (!c.active) {
        c.active = true;
        c.x = x;
        c.y = y;
        c.sigma = sigma;
        c.volumeLeft = volume;
        c.stepsLeft = CRATER_STEPS;
        return;
      }
    }
    // 池满(理论不可达):退化为单步注入,clamp 兜底
    this.field.addVolumeSource(x, y, sigma, volume, this.params.couplingClamp);
  }

  /** 推进全部活跃弹坑一步(管线第 1.5 步,场步进之前) */
  private advanceCraters(): void {
    const clamp = this.params.couplingClamp;
    for (let k = 0; k < this.craters.length; k++) {
      const c = this.craters[k]!;
      if (!c.active) continue;
      this.field.addVolumeSource(
        c.x,
        c.y,
        c.sigma,
        c.volumeLeft / c.stepsLeft,
        clamp,
      );
      c.stepsLeft--;
      if (c.stepsLeft <= 0) c.active = false;
    }
  }

  /** 入队一个高斯冲量源(脚本/调试戳点,峰值深度语义),下一固定步生效 */
  addImpulse(x: number, y: number, sigma: number, depth: number): void {
    this.pendingImpulses.push({ x, y, sigma, depth });
  }

  /** 入队出生一颗液滴(z 为中心高度),下一固定步生效;超限在生效时拒收 */
  spawnDroplet(x: number, y: number, z: number, r: number): boolean {
    if (
      this.droplets.state.count + this.pendingSpawns.length >=
      this.params.maxDroplets
    ) {
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
    // 2) 液滴单体:空中积分 / 浮态力求解 + 动态源注入(§4.4)
    this.droplets.update(this.params.dt);
    // 2.2) 液滴间(M3):碰撞冲量+去穿透 → 毛细吸引 → 聚合判定与执行
    this.pairs.step(this.params.dt);
    // 2.4) 液桥(任务①):成桥扫描 + 张力/流动/侵入治理(网络模式)
    this.bridges.step(this.params.dt);
    // 2.5) 弹坑发射器(入水/聚合冲击分步展开,§4.4 输入事件层)
    this.advanceCraters();
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
    // 5) 统计(入水计数由 DropletSystem 累计,聚合计数由 DropletPairs 累计)
    this.stats.simTime += this.params.dt;
    this.stats.stepCount++;
    this.stats.impacts = this.droplets.impacts;
    this.stats.merges = this.pairs.mergeCount;
  }
}
