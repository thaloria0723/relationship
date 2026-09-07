// ============================================================
// 演示时间线(物理模型实施文档 §7 验收脚本 + §12.2 参数裁决):把「应看到」逐条演出来。
// 驱动:viewer 每帧 tick(engine) → 按 simTime 触发队列事件 + 持续源;
// 字幕 caption(simTime) 标注当前验收点。
// 液桥连接语义(调优第三批①修订):成桥距离无关——任意两漂浮滴 drainTime 后
// 即成桥(mergeEnabled=false:互不融合),远距对保持间距、近距对被推开来
// 最小净间距;落雨期钉扎固定。
// ============================================================

import type { WaterEngine } from "./watersim/engine";
import { defaultParams } from "./watersim/params";
import { mountGrayViewer, type ViewerHooks } from "./grayview/viewer";

/** 时间线事件:simTime ≥ t 时执行一次 */
interface TimelineEvent {
  t: number;
  label: string;
  captionUntil: number;
  run: (e: WaterEngine) => void;
}

const p = defaultParams;

/** 出生即接触入水的漂浮滴(z 取恰在水面下,首步浮态判定即成立) */
function spawnFloaterAtRest(
  e: WaterEngine,
  x: number,
  y: number,
  r: number,
): void {
  const surf = e.field.totalHeight(x, y);
  e.spawnDroplet(x, y, surf + r - 1e-4, r);
}

const events: TimelineEvent[] = [
  {
    t: 0,
    label:
      "静水 + 3 颗漂浮滴:任意两滴经 drainTime 后自动成桥(连接距离无关);观察凹陷(Distortion)与浸深(Buoyancy)",
    captionUntil: 3.5,
    run: (e) => {
      spawnFloaterAtRest(e, 0.45, 0.5, 0.02);
      spawnFloaterAtRest(e, 0.55, 0.5, 0.02);
      spawnFloaterAtRest(e, 0.72, 0.68, 0.016);
    },
  },
  {
    t: 3.5,
    label:
      "滴 A 自 0.15m 落下:加速下落(Gravity)→ 入水环纹扩散(Ripple)→ 落定后即与全网成桥(连接)",
    captionUntil: 6.5,
    run: (e) => {
      const r = 0.02;
      // 落点避开中央对的桥轴(侵入治理会剪断被穿过的桥);偏上方落下仍居场中
      e.spawnDroplet(
        0.5,
        0.64,
        e.field.totalHeight(0.5, 0.64) + p.dropHeight + r,
        r,
      );
    },
  },
  {
    t: 6.0,
    label:
      "左缘波源启动:等距波列横穿全场(Wave);液滴随波微晃、保持在落点附近(坡度力 + 钉扎回位)",
    captionUntil: 9.5,
    run: () => {
      waveSourceOn = true;
    },
  },
  {
    t: 9.5,
    label:
      "液桥网络:桥持最小净间距(靠太近被推开)、两端略宽中间收窄;相连但不融合(§12.2-C′)",
    captionUntil: 13.0,
    run: () => {},
  },
  {
    t: 13.0,
    label:
      "周期落滴持续(Ripple):液滴相对固定(钉扎 pinning)互不链式合并;场面不发散(稳定性)",
    captionUntil: 18.0,
    run: () => {
      rainOn = true;
      nextRainT = 13.0;
    },
  },
];

// ---- 持续性源(事件触发后每帧维持) ----
let waveSourceOn = false;
let rainOn = false;
let nextRainT = 13.0;
let lastWaveT = 0;

/** 波源:左缘中央,1.2Hz 高斯冲量脉冲列(等效周期波列,§5.6) */
function runWaveSource(e: WaterEngine, t: number): void {
  const period = 1 / p.waveSourceFreq;
  while (lastWaveT + period <= t) {
    lastWaveT += period;
    e.addImpulse(0.02, 0.5, 0.03, p.waveSourceAmp);
  }
}

/** 周期落滴:随机位(r~U[rMin,rMax],seed 由调用方控制;此处用确定性网格+相位抖动) */
function runRain(e: WaterEngine, t: number): void {
  while (nextRainT <= t) {
    const k = Math.round(nextRainT * 10); // 事件时刻→网格相位(确定性)
    const r = p.rMin + (((k * 37) % 100) / 100) * (p.rMax - p.rMin);
    const x = 0.2 + (((k * 53) % 100) / 100) * 0.6;
    const y = 0.2 + (((k * 71) % 100) / 100) * 0.6;
    e.spawnDroplet(x, y, e.field.totalHeight(x, y) + p.dropHeight + r, r);
    nextRainT += p.rainInterval;
  }
}

/** 演示主循环钩子:时间线事件 + 持续源 */
function tickDemo(e: WaterEngine): void {
  const t = e.stats.simTime;
  while (nextEvent < events.length && events[nextEvent]!.t <= t) {
    events[nextEvent]!.run(e);
    nextEvent++;
  }
  if (waveSourceOn) runWaveSource(e, t);
  if (rainOn) runRain(e, t);
}

let nextEvent = 0;

/** 字幕:最近一个已触发且未过期事件的 label */
function captionDemo(t: number): string | null {
  let text: string | null = null;
  for (let i = 0; i < nextEvent && i < events.length; i++) {
    const ev = events[i]!;
    if (t <= ev.captionUntil) text = ev.label;
  }
  return text;
}

/** 复位演示时间线状态(重播必须回到 §7 起点,否则事件队列已耗尽、演示不再触发) */
function resetDemoState(): void {
  nextEvent = 0;
  waveSourceOn = false;
  rainOn = false;
  nextRainT = 13.0;
  lastWaveT = 0;
}

const hooks: ViewerHooks = {
  disablePokes: true,
  tick: (e) => tickDemo(e),
  caption: (t) => captionDemo(t),
  reset: resetDemoState,
};

// 页面直挂(demo.html 以本模块为入口)
const app = document.getElementById("app");
if (app) {
  mountGrayViewer(app, defaultParams, hooks);
}
