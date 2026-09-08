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

/** 焦点退场曲线(第五批):成员沿二次贝塞尔(水平)+ u² 缓入(垂直)回首次落点 */
interface FocusExitCurve {
  i: number;
  /** 起点(环上位置) */
  x0: number;
  y0: number;
  z0: number;
  /** 贝塞尔控制点(弦中点 + 顺轨道切向垂直偏移 → 顺势螺旋回位) */
  cx: number;
  cy: number;
  /** 终点 = 该滴首次落点(出生锚点)与落水高度 */
  x1: number;
  y1: number;
  z1: number;
  /** 已进行/总时长(秒) */
  t: number;
  dur: number;
}

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
  // ---- 模块②意图状态 ----
  private waterHoverValid = false;
  private waterHoverX = 0;
  private waterHoverY = 0;
  private rippleAcc = 0;
  private dropletRippleAcc = 0;
  private focusGroup: number[] = [];
  // ---- 焦点模式编舞状态(第五批) ----
  /** off = 无焦点;hold = 聚焦保持(旋转/涟漪);out = 退场编舞(曲线回位) */
  private focusPhase: "off" | "hold" | "out" = "off";
  private focusCenter = -1;
  /** 等长环半径(= 等长后 spoke 桥长,viewer 相机拟合用) */
  private focusRingLen = 0;
  /** 中心直连桥槽位与进入时桥长(退出时还原) */
  private focusSpokes: number[] = [];
  private savedSpokeRestLen: number[] = [];
  /** 进入时切断的非 spoke 组相关桥槽位(收尾时恢复连接) */
  private cutSlots: number[] = [];
  /** 守护中的桥槽位(spokes ∪ cutSlots;收尾时清零) */
  private guardSlots: number[] = [];
  private focusRippleAcc = 0;
  private exitCurves: FocusExitCurve[] = [];
  private readonly bridgeScratch = new Int32Array(64);
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

  // ---- 模块②意图 API(交互系统注入;物理承接见 droplet.ts / 下方管线) ----

  /** 特性①:指针悬停水面 → 周期性微弱涟漪源(valid=false 取消) */
  setWaterHover(valid: boolean, x: number, y: number): void {
    this.waterHoverValid = valid;
    this.waterHoverX = x;
    this.waterHoverY = y;
  }

  /** 特性②:悬停液滴 → 升力浮出水面 + 波纹增强(-1 取消) */
  setDropletHover(i: number): void {
    this.droplets.setHovered(i);
  }

  /** 特性③:抓取液滴拖拽(x,y 为水面目标点) */
  beginDrag(i: number, x: number, y: number): void {
    this.droplets.beginDrag(i, x, y);
  }

  moveDrag(x: number, y: number): void {
    this.droplets.setDragTarget(x, y);
  }

  endDrag(): void {
    const i = this.droplets.dragIndex;
    const reanchored = this.droplets.endDrag();
    // 重锚定释放:拖拽造成的距离变化被桥吸收为新常态(连接保持,第三批②修订)
    if (i >= 0 && reanchored) this.bridges.rebaseRestLengths(i);
  }

  /**
   * 特性④:焦点模式(第五批编舞版)。
   * 分组 G = {i} ∪ 直连桥邻居;G 内液滴悬浮。需求①:中心直连桥(spoke)restLen
   * 强制等长为 L(= 最长 spoke 距,只外推不内拉),viewer 以 L 拟合相机使包围圈
   * 入画、中心滴居屏幕正中。需求②:G 内非 spoke 桥(包围圈内部 + 跨界)全部
   * 暂时切断;聚焦期成桥扫描冻结、组相关桥受守护、组内滴豁免侵入第三方。
   * 返回组成员(viewer 相机/高亮用)。
   */
  enterFocus(i: number): number[] {
    if (this.focusPhase !== "off") this.forceFinalizeFocus();
    const d = this.droplets.state;
    if (i < 0 || i >= d.count) return [];
    const group = [i];
    const seen = new Set<number>([i]);
    const scratch = this.bridgeScratch;
    // BFS 一层:直连邻居(液桥 = 关系网的直接关系)
    const nb = this.bridges.bridgesOf(i, scratch);
    for (let k = 0; k < nb; k++) {
      const bridgeIdx = scratch[k]!;
      const other =
        this.bridges.state.a[bridgeIdx] === i
          ? this.bridges.state.b[bridgeIdx]!
          : this.bridges.state.a[bridgeIdx]!;
      if (!seen.has(other)) {
        seen.add(other);
        group.push(other);
      }
    }
    this.focusGroup = group;
    this.focusCenter = i;
    this.focusPhase = "hold";
    this.focusRippleAcc = this.params.focusRipplePeriod; // 进入即先起一圈涟漪
    for (const m of group) this.droplets.setLevitate(m, true);
    // 需求①:spoke 桥长强行一致(取最长 spoke 距,只外推;下限 = 持距下限)
    this.focusSpokes = [];
    this.savedSpokeRestLen = [];
    let ring = 0;
    for (let k = 0; k < nb; k++) {
      const slot = scratch[k]!;
      const a = this.bridges.state.a[slot]!;
      const b = this.bridges.state.b[slot]!;
      const other = a === i ? b : a;
      const dist = Math.hypot(d.x[other]! - d.x[i]!, d.y[other]! - d.y[i]!);
      const minHold = (d.r[i]! + d.r[other]!) * (1 + this.params.bridgeRestGap);
      ring = Math.max(ring, dist, minHold);
      this.focusSpokes.push(slot);
      this.savedSpokeRestLen.push(this.bridges.state.restLen[slot]!);
    }
    this.focusRingLen = ring;
    for (const slot of this.focusSpokes) this.bridges.state.restLen[slot] = ring;
    // 需求②:非 spoke 组相关桥(包围圈内部 + 跨界)全部暂时切断
    this.cutSlots = [];
    for (let k = 0; k < this.bridges.state.count; k++) {
      const a = this.bridges.state.a[k]!;
      const b = this.bridges.state.b[k]!;
      const aIn = seen.has(a);
      const bIn = seen.has(b);
      const isSpoke = (a === i || b === i) && aIn && bIn;
      if (!isSpoke && (aIn || bIn)) {
        this.bridges.setCut(k, true);
        this.cutSlots.push(k);
      }
    }
    // 编舞期守护:成桥冻结;组相关桥不张力/不断桥/不复检侵入(退出后恢复连接的前提);
    // 组内滴悬浮/旋转/回场飞行,其 2D 投影不作为无关桥的侵入第三方
    this.bridges.formationFrozen = true;
    this.guardSlots = [...this.focusSpokes, ...this.cutSlots];
    for (const k of this.guardSlots) this.bridges.guardSlot[k] = 1;
    for (const m of group) this.bridges.intruderExempt[m] = 1;
    return group.slice();
  }

  /**
   * 需求③:退出聚焦。中心滴水平归位到首次落点(出生锚点)后改走空中段自由落体;
   * 成员记录退场曲线(引擎逐步编舞),全部到位后 finalizeFocusExit 恢复断桥与
   * 原桥长。恢复刻意延后到编舞收尾:立即恢复会让跨组桥在成员尚在环上时把组外
   * 端拉离原位。
   */
  exitFocus(): void {
    if (this.focusPhase !== "hold") return;
    const d = this.droplets.state;
    const c = this.focusCenter;
    this.focusPhase = "out";
    // 中心:直接自由落体回首落点(悬浮期位置≈进入位置≈锚点,归位是毫米级校正)
    this.droplets.setLevitate(c, false);
    d.x[c] = d.anchorX[c]!;
    d.y[c] = d.anchorY[c]!;
    d.vx[c] = 0;
    d.vy[c] = 0;
    // 成员:逐滴记录贝塞尔曲线,stepFixed 中推进
    this.exitCurves = [];
    const ccx = d.x[c]!;
    const ccy = d.y[c]!;
    for (const m of this.focusGroup) {
      if (m === c) continue;
      d.lev[m] = 0;
      this.droplets.setCurvedReturn(m, true);
      const x0 = d.x[m]!;
      const y0 = d.y[m]!;
      const z0 = d.z[m]!;
      const x1 = d.anchorX[m]!;
      const y1 = d.anchorY[m]!;
      // 控制点 = 弦中点 + 垂直偏移(偏转符号与轨道切向同向 → 顺势螺旋回位)
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      let px = -(y1 - y0);
      let py = x1 - x0;
      const pl = Math.hypot(px, py);
      if (pl < 1e-9) {
        px = 1;
        py = 0;
      } else {
        px /= pl;
        py /= pl;
      }
      const sgn = px * -(y0 - ccy) + py * (x0 - ccx) >= 0 ? 1 : -1;
      const bulge = Math.max(0.25 * Math.hypot(x1 - x0, y1 - y0), 0.01);
      const r = d.r[m]!;
      this.exitCurves.push({
        i: m,
        x0,
        y0,
        z0,
        cx: mx + sgn * px * bulge,
        cy: my + sgn * py * bulge,
        x1,
        y1,
        z1: this.field.totalHeight(x1, y1) + r * 0.95,
        t: 0,
        dur: this.params.focusReturnDur,
      });
    }
  }

  getFocusGroup(): readonly number[] {
    return this.focusGroup;
  }

  /** 焦点中心滴索引(无焦点 = −1;viewer 相机对中用) */
  getFocusCenter(): number {
    return this.focusCenter;
  }

  /** 等长环半径(= 等长 spoke 桥长;viewer 相机按此拟合包围圈入画) */
  getFocusRingLen(): number {
    return this.focusRingLen;
  }

  /** 需求②:聚焦期包围圈旋转 + 半径向等长环收敛(速度导向;位置由常规悬浮段积分) */
  private applyFocusOrbit(dt: number): void {
    const d = this.droplets.state;
    const c = this.focusCenter;
    if (c < 0 || c >= d.count) return;
    const cx = d.x[c]!;
    const cy = d.y[c]!;
    const omega = this.params.focusOrbitOmega;
    const kr = this.params.focusOrbitRadialK;
    const L = this.focusRingLen;
    for (const m of this.focusGroup) {
      if (m === c || m >= d.count) continue;
      const ex = d.x[m]! - cx;
      const ey = d.y[m]! - cy;
      const r = Math.hypot(ex, ey);
      if (r < 1e-6) continue;
      const radial = kr > 0 ? kr * (L - r) : 0;
      // engine 平面逆时针(ω>0)= 俯视屏幕顺时针(需求②)
      d.vx[m] = (radial * ex) / r - omega * ey;
      d.vy[m] = (radial * ey) / r + omega * ex;
    }
  }

  /** 需求③:推进退场曲线;单滴到位即恢复漂浮态并经弹坑通道溅落 */
  private advanceExitCurves(dt: number): void {
    const d = this.droplets.state;
    for (let n = this.exitCurves.length - 1; n >= 0; n--) {
      const cv = this.exitCurves[n]!;
      cv.t += dt;
      const u = Math.min(1, cv.t / cv.dur);
      const e = u * u * (3 - 2 * u); // smoothstep:水平缓入缓出
      const w0 = (1 - e) * (1 - e);
      const w1 = 2 * (1 - e) * e;
      const w2 = e * e;
      const i = cv.i;
      d.x[i] = w0 * cv.x0 + w1 * cv.cx + w2 * cv.x1;
      d.y[i] = w0 * cv.y0 + w1 * cv.cy + w2 * cv.y1;
      d.z[i] = cv.z0 + (cv.z1 - cv.z0) * u * u; // u²:起步缓、临近落水加速
      d.vx[i] = 0;
      d.vy[i] = 0;
      d.vz[i] = 0;
      if (u >= 1) {
        const r = d.r[i]!;
        const vzLand = (2 * (cv.z0 - cv.z1)) / cv.dur; // u² 末速
        const tContact = r / Math.max(vzLand, 0.1);
        this.scheduleImpact(
          d.x[i]!,
          d.y[i]!,
          IMPACT_SIGMA_RATIO * r,
          -this.params.impulseGain * r * r * vzLand * tContact,
        );
        d.d[i] = 0.05 * r;
        d.z[i] = this.field.totalHeight(d.x[i]!, d.y[i]!) + (r - d.d[i]!);
        this.droplets.setCurvedReturn(i, false);
        this.exitCurves[n] = this.exitCurves[this.exitCurves.length - 1]!;
        this.exitCurves.pop();
      }
    }
  }

  /** 退场收尾:恢复暂时切断的桥与原 spoke 桥长,解除守护/冻结/豁免 */
  private finalizeFocusExit(): void {
    for (const k of this.cutSlots) this.bridges.setCut(k, false);
    for (let n = 0; n < this.focusSpokes.length; n++) {
      this.bridges.state.restLen[this.focusSpokes[n]!] = this.savedSpokeRestLen[n]!;
    }
    for (const k of this.guardSlots) this.bridges.guardSlot[k] = 0;
    for (const m of this.focusGroup) this.bridges.intruderExempt[m] = 0;
    this.bridges.formationFrozen = false;
    this.exitCurves = [];
    this.focusGroup = [];
    this.focusSpokes = [];
    this.savedSpokeRestLen = [];
    this.cutSlots = [];
    this.guardSlots = [];
    this.focusCenter = -1;
    this.focusRingLen = 0;
    this.focusPhase = "off";
  }

  /** 异常路径收尾(编舞中重进聚焦/宿主复用):未完成曲线的成员就地归位锚点 */
  private forceFinalizeFocus(): void {
    if (this.focusPhase === "off") return;
    const d = this.droplets.state;
    for (const cv of this.exitCurves) {
      const i = cv.i;
      this.droplets.setCurvedReturn(i, false);
      d.x[i] = d.anchorX[i]!;
      d.y[i] = d.anchorY[i]!;
      d.d[i] = 0.05 * d.r[i]!;
      d.z[i] = this.field.totalHeight(d.x[i]!, d.y[i]!) + d.r[i]! - d.d[i]!;
      d.vx[i] = 0;
      d.vy[i] = 0;
      d.vz[i] = 0;
    }
    for (const m of this.focusGroup) {
      if (m >= 0 && m < d.count && d.lev[m] === 1) this.droplets.setLevitate(m, false);
    }
    this.finalizeFocusExit();
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
    // 1.5) 模块②意图:悬停水面周期涟漪(确定性计时)
    if (this.waterHoverValid) {
      this.rippleAcc += this.params.dt;
      if (this.rippleAcc >= this.params.ripplePeriod) {
        this.rippleAcc -= this.params.ripplePeriod;
        this.field.addVolumeSource(
          this.waterHoverX,
          this.waterHoverY,
          0.012,
          -this.params.rippleVolume,
          this.params.couplingClamp,
        );
      }
    }
    // 1.6) 特性②:悬停液滴持续强化波纹(比①更强烈明显)
    if (this.droplets.hovered >= 0) {
      this.dropletRippleAcc += this.params.dt;
      if (this.dropletRippleAcc >= this.params.ripplePeriod * 1.2) {
        this.dropletRippleAcc -= this.params.ripplePeriod * 1.2;
        const hd = this.droplets.state;
        const hi = this.droplets.hovered;
        if (hi < hd.count && hd.floating[hi] === 1) {
          const hr = hd.r[hi]!;
          this.field.addVolumeSource(
            hd.x[hi]!,
            hd.y[hi]!,
            this.params.kernelSigma * hr,
            -this.params.rippleVolume * 1.4 * ((hr / 0.02) ** 2),
            this.params.couplingClamp,
          );
        }
      }
    }
    // 1.7) 特性④聚焦(第五批):中心滴下方周期圈状涟漪(弹坑通道 → 扩散圆环)
    if (this.focusPhase === "hold") {
      this.focusRippleAcc += this.params.dt;
      if (this.focusRippleAcc >= this.params.focusRipplePeriod) {
        this.focusRippleAcc -= this.params.focusRipplePeriod;
        const fd = this.droplets.state;
        const fc = this.focusCenter;
        if (fc >= 0 && fc < fd.count) {
          const rC = fd.r[fc]!;
          this.scheduleImpact(
            fd.x[fc]!,
            fd.y[fc]!,
            this.params.kernelSigma * rC,
            -this.params.focusRippleVolume * (rC / 0.02) ** 2,
          );
        }
      }
    }
    // 2) 液滴单体:空中积分 / 浮态力求解 + 动态源注入(§4.4)
    this.droplets.update(this.params.dt);
    // 2.15) 焦点编舞(第五批):hold = 包围圈旋转;out = 退场曲线;全员到位即收尾
    if (this.focusPhase === "hold") {
      this.applyFocusOrbit(this.params.dt);
    } else if (this.focusPhase === "out") {
      const centerHome =
        this.focusCenter < 0 ||
        this.focusCenter >= this.droplets.state.count ||
        this.droplets.state.floating[this.focusCenter] === 1;
      this.advanceExitCurves(this.params.dt);
      if (this.exitCurves.length === 0 && centerHome) this.finalizeFocusExit();
    }
    // 2.2) 液滴间(M3):碰撞冲量+去穿透 → 毛细吸引 → 聚合判定与执行
    this.pairs.step(this.params.dt);
    // 2.4) 液桥(任务①):成桥扫描 + 张力/侵入治理(网络模式;无体积流动,第四批)
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
