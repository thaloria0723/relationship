// B 组效果验证 · 效果驱动单测(纯逻辑,无渲染依赖)
import { describe, expect, it } from "vitest";
import {
  ABSENT_DEPTH,
  absentRise,
  allocatePoints,
  CLASH,
  CONDENSE,
  DEATH,
  FOCUS,
  focusDuration,
  FxDriver,
  FX_MAX,
  FX_NAMES,
  POINT_POOL,
  revealTarget,
  ROLE_ABSENT,
  ROLE_HERO,
  ROLE_NORMAL,
  ROLE_PRESENT,
  ROLE_T_CORE,
  ROLE_T_NEW,
  ROLE_T_OLD,
  SPARK_COUNT,
  span01,
  sparkState,
  TRANSITION,
  type SparkState,
  type TransSource,
} from "./fxdriver";

const step = (d: FxDriver, dt: number, frames: number, dist = 1): void => {
  for (let i = 0; i < frames; i++) d.update(dt, dist);
};

describe("FX_NAMES / 模式表", () => {
  it("共 10 个状态,索引即模式号,0 为关", () => {
    expect(FX_NAMES.length).toBe(FX_MAX + 1);
    expect(FX_NAMES[0]).toBe("关");
    expect(FX_NAMES[6]).toBe("凝结");
    expect(FX_NAMES[7]).toBe("死亡");
    expect(FX_NAMES[9]).toBe("大转折");
  });
});

describe("基础推进", () => {
  it("reset 清空时间与揭示度", () => {
    const d = new FxDriver();
    d.update(0.5, 0);
    d.reset(3);
    expect(d.mode).toBe(3);
    expect(d.t).toBe(0);
    expect(d.reveal).toBe(0);
  });

  it("冻结后时间不再推进(取帧用)", () => {
    const d = new FxDriver();
    d.reset(6);
    d.update(0.4, 1);
    const t = d.t;
    d.frozen = true;
    step(d, 0.1, 20);
    expect(d.t).toBe(t);
  });

  it("关(0):全部归零,液滴不缩放", () => {
    const d = new FxDriver();
    d.reset(0);
    d.update(1, 0);
    const b = d.bridgeFx(0.5);
    expect([b.flow, b.bubble, b.turb, b.state]).toEqual([0, 0, 0, 0]);
    const p = d.dropletFx(1);
    expect(p.scale).toBe(1);
    expect(p.boil).toBe(0);
    expect(p.dissolve).toBe(0);
  });

  it("静场效果不被总时长截断(流动相位持续推进)", () => {
    const d = new FxDriver();
    d.reset(1);
    step(d, 0.1, 50);
    expect(d.t).toBeGreaterThan(4);
  });
});

describe("1 融合 / 4 暗流:流动方向靠 flow 符号区分", () => {
  it("融合 = 双向(flow > 0)且有微气泡", () => {
    const d = new FxDriver();
    d.reset(1);
    const b = d.bridgeFx(0.3);
    expect(b.flow).toBeGreaterThan(0);
    expect(b.bubble).toBeGreaterThan(0);
    expect(b.turb).toBe(0);
  });

  it("暗流 = 单向(flow < 0),气泡最密", () => {
    const d = new FxDriver();
    d.reset(4);
    const b = d.bridgeFx(0.3);
    expect(b.flow).toBeLessThan(0);
    expect(b.bubble).toBe(1);
  });

  it("暗流不同 seed 流速不同(去同步,防整网同步扫过半向量)", () => {
    const d = new FxDriver();
    d.reset(4);
    expect(d.bridgeFx(0.1).flow).not.toBe(d.bridgeFx(0.9).flow);
  });
});

describe("2 拉扯:向背景收敛量拉满,且不靠压暗", () => {
  it("state = 1(收敛度满),湍流/气泡关闭", () => {
    const d = new FxDriver();
    d.reset(2);
    const b = d.bridgeFx(0.2);
    expect(b.state).toBe(1);
    expect(b.turb).toBe(0);
    expect(b.bubble).toBe(0);
  });
});

describe("5 潜流:快进慢出", () => {
  it("距离越近揭示度越高,且单调", () => {
    expect(revealTarget(0)).toBe(1);
    expect(revealTarget(1)).toBe(0);
    expect(revealTarget(0.08)).toBeGreaterThan(revealTarget(0.14));
  });

  it("指针靠近 → 揭示度上升", () => {
    const d = new FxDriver();
    d.reset(5);
    expect(d.reveal).toBe(0);
    step(d, 1 / 60, 60, 0); // 1 秒贴近
    expect(d.reveal).toBeGreaterThan(0.9);
  });

  it("指针移开 → 揭示度缓慢回落(慢出),1 秒内不低于 0.3", () => {
    const d = new FxDriver();
    d.reset(5);
    step(d, 1 / 60, 60, 0); // 先贴近到 ~1
    const peak = d.reveal;
    expect(peak).toBeGreaterThan(0.9);
    step(d, 1 / 60, 60, 1); // 再远离 1 秒
    expect(d.reveal).toBeGreaterThan(0.3);
    expect(d.reveal).toBeLessThan(peak);
  });

  it("进入速率快于退出速率", () => {
    const a = new FxDriver();
    a.reset(5);
    step(a, 1 / 60, 15, 0); // 15 帧贴近
    const rise = a.reveal;
    const b = new FxDriver();
    b.reset(5);
    step(b, 1 / 60, 120, 0); // 先完全贴近
    step(b, 1 / 60, 15, 1); // 再 15 帧远离
    expect(rise).toBeGreaterThan(1 - b.reveal - 0.5);
  });

  it("非潜流模式下揭示度归零", () => {
    const d = new FxDriver();
    d.reset(5);
    step(d, 1 / 60, 60, 0);
    expect(d.reveal).toBeGreaterThan(0.9);
    d.reset(1);
    step(d, 1 / 60, 60, 0);
    expect(d.reveal).toBe(0);
  });
});

describe("6 凝结登场", () => {
  it("时间线单调:雾 → 聚拢 → 成形 → 抽桥", () => {
    const d = new FxDriver();
    d.reset(6);
    expect(d.dropletFx(1).scale).toBe(0);
    expect(d.bridgeGrow()).toBe(0);

    d.t = (CONDENSE.fogIn[1] + CONDENSE.converge[0]) / 2;
    expect(d.fogCue(0, 0, 0).appear).toBeGreaterThan(0);

    d.t = CONDENSE.converge[1];
    expect(d.dropletFx(1).scale).toBe(0); // 尚未成形

    d.t = CONDENSE.form[1];
    expect(d.dropletFx(1).scale).toBeGreaterThan(0.9);

    d.t = CONDENSE.grow[1];
    expect(d.bridgeGrow()).toBe(1);
    expect(d.fogCue(0, 0, 0).appear).toBeLessThan(0.05); // 雾已散
  });

  it("成形瞬间有过冲(不是线性爬升)", () => {
    const d = new FxDriver();
    d.reset(6);
    d.t = CONDENSE.form[1];
    expect(d.dropletFx(1).scale).toBeGreaterThan(1);
  });

  it("只有主角滴有凝结演出,配角滴无变化", () => {
    const d = new FxDriver();
    d.reset(6);
    d.t = CONDENSE.form[1];
    expect(d.dropletFx(0).scale).toBe(1);
    expect(d.dropletFx(0).flash).toBe(0);
    expect(d.dropletFx(1).flash).toBeGreaterThan(0);
  });

  it("雾团半径随聚拢收缩", () => {
    const d = new FxDriver();
    d.reset(6);
    d.t = CONDENSE.fogIn[1];
    const wide = d.fogCue(0, 0, 0).radius;
    d.t = CONDENSE.converge[1];
    const tight = d.fogCue(0, 0, 0).radius;
    expect(tight).toBeLessThan(wide);
  });

  it("播完即止(不会超过总时长)", () => {
    const d = new FxDriver();
    d.reset(6);
    step(d, 0.1, 100);
    expect(d.t).toBe(d.duration);
  });
});

describe("7 死亡蒸发", () => {
  it("三阶段依次发生:沸腾 → 汽化缩小 → 溶解", () => {
    const d = new FxDriver();
    d.reset(7);
    expect(d.dropletFx(1).boil).toBe(0);

    d.t = DEATH.boil[1];
    const p1 = d.dropletFx(1);
    expect(p1.boil).toBe(1);
    expect(p1.dissolve).toBe(0);

    d.t = DEATH.vapor[1];
    const p2 = d.dropletFx(1);
    expect(p2.scale).toBeLessThan(0.4); // 已经缩了
    expect(p2.lift).toBeGreaterThan(0); // 已经上飘

    d.t = DEATH.dissolve[1];
    expect(d.dropletFx(1).dissolve).toBe(1);
  });

  it("沸腾阶段不改透明度也不改尺寸(纪律:液滴写深度,只能靠顶点/rim)", () => {
    const d = new FxDriver();
    d.reset(7);
    d.t = DEATH.boil[0] + (DEATH.vapor[0] - DEATH.boil[0]) / 2; // 汽化开始前
    const p = d.dropletFx(1);
    expect(p.boil).toBeGreaterThan(0);
    expect(p.dissolve).toBe(0);
    expect(p.scale).toBe(1); // 尚未进入缩小阶段
  });

  it("抖动溶解必须等汽化结束才启动(只有它碰深度)", () => {
    const d = new FxDriver();
    d.reset(7);
    d.t = DEATH.dissolve[0];
    expect(d.dropletFx(1).dissolve).toBe(0);
    // 汽化全程 dissolve 恒为 0
    for (let t = DEATH.vapor[0]; t <= DEATH.vapor[1]; t += 0.05) {
      d.t = t;
      expect(d.dropletFx(1).dissolve).toBe(0);
    }
  });

  it("桥随汽化回缩(不是拉丝拉断)", () => {
    const d = new FxDriver();
    d.reset(7);
    d.t = DEATH.growBack[0];
    expect(d.bridgeGrow()).toBe(1);
    d.t = DEATH.growBack[1];
    expect(d.bridgeGrow()).toBe(0);
  });

  it("原位留残雾,且随时间淡出", () => {
    const d = new FxDriver();
    d.reset(7);
    d.t = DEATH.dissolve[1];
    const a = d.fogCue(0, 0.5, 0.5).appear;
    expect(a).toBeGreaterThan(0);
    d.t = d.duration;
    expect(d.fogCue(0, 0.5, 0.5).appear).toBeLessThan(a);
  });

  it("只有主角滴参与死亡", () => {
    const d = new FxDriver();
    d.reset(7);
    d.t = DEATH.boil[1];
    expect(d.dropletFx(0).boil).toBe(0);
    expect(d.dropletFx(1).boil).toBe(1);
  });
});

describe("时间线区间工具", () => {
  it("span01 区间外钳制、区间内线性", () => {
    expect(span01(0, 1, 2)).toBe(0);
    expect(span01(3, 1, 2)).toBe(1);
    expect(span01(1.5, 1, 2)).toBeCloseTo(0.5, 6);
  });

  it("零宽区间不除零", () => {
    expect(Number.isFinite(span01(1, 1, 1))).toBe(true);
  });
});

describe("3 对撞:两端亮斑相向推进,中心融合后消散冒泡", () => {
  const at = (t: number): ReturnType<FxDriver["bridgeFx"]> => {
    const d = new FxDriver();
    d.reset(3);
    d.t = t;
    return d.bridgeFx(0.3);
  };
  const mid = (r: readonly [number, number]): number => (r[0] + r[1]) / 2;

  it("亮斑从两端出发,收敛到中心(head: 0.86 → 0.5)", () => {
    // 起点不是 1:u=1 是藏在液滴里的尖端,亮斑放那儿会被液滴辉光吃掉(实测)
    expect(at(CLASH.born[1]).state).toBeCloseTo(0.86, 5);
    expect(at(mid(CLASH.charge)).state).toBeLessThan(0.86);
    expect(at(CLASH.charge[1]).state).toBeCloseTo(0.5, 5);
  });

  it("一个周期内位置单调不回头(相向推进,不回弹)", () => {
    let prev = at(CLASH.charge[0]).state;
    for (let t = CLASH.charge[0]; t <= CLASH.charge[1]; t += 0.03) {
      const h = at(t).state;
      expect(h).toBeLessThanOrEqual(prev + 1e-6);
      prev = h;
    }
  });

  it("**循环**:t 不封顶,同一相位在任意周期给出同一组值", () => {
    for (const ph of [0, 0.4, 0.95, 1.2]) {
      const a = at(ph);
      const b = at(ph + CLASH.period * 3);
      expect(b.state).toBeCloseTo(a.state, 9);
      expect(b.turb).toBeCloseTo(a.turb, 9);
      expect(b.flow).toBeCloseTo(a.flow, 9);
    }
  });

  it("上一轮融合后下一轮立刻开始:周期头部两端亮斑已在起、中心余晖尚在", () => {
    // p=0 就是「上一轮刚在中心融合完」那一瞬
    expect(at(0).flow).toBeCloseTo(1, 6);
    expect(at(CLASH.period).flow).toBeCloseTo(at(0).flow, 9); // 跨周期连续,不切断
    const head = at(CLASH.born[1]);
    expect(head.turb).toBeCloseTo(1, 6); // 新一轮两端亮斑已经亮起
    expect(head.flow).toBeGreaterThan(0); // 上一轮的融合光还没散完
  });

  it("中心余晖跨周期单调衰减到 0(不会长期糊在中心)", () => {
    expect(at(0).flow).toBeCloseTo(1, 6);
    expect(at(CLASH.afterglow).flow).toBeCloseTo(0, 6);
  });

  it("强度包络:起 → 并入中心 → 归零(两端起步与周期末尾都不亮)", () => {
    expect(at(0).turb).toBe(0);
    expect(at(CLASH.born[1]).turb).toBeCloseTo(1, 6);
    expect(at(CLASH.merge[1]).turb).toBeCloseTo(0, 6);
    expect(at(CLASH.period).turb).toBeCloseTo(0, 9);
  });

  it("气泡在融合后随余晖冒出(推进段为 0)", () => {
    expect(at(CLASH.charge[1]).bubble).toBe(0);
    expect(at(CLASH.merge[1]).bubble).toBeGreaterThan(0.5);
  });

  it("t 一直推进,不被总时长钳住(duration = 0 = 不封顶)", () => {
    const d = new FxDriver();
    d.reset(3);
    expect(d.duration).toBe(0);
    step(d, 0.1, 100);
    expect(d.t).toBeGreaterThan(CLASH.period * 4);
  });
});

describe("8 聚焦:未在场灰滴渐次从水底浮现(动效 §2.3)", () => {
  const at = (t: number, role: number): ReturnType<FxDriver["dropletFx"]> => {
    const d = new FxDriver();
    d.reset(8);
    d.t = t;
    return d.dropletFx(role);
  };
  const ABS0 = ROLE_ABSENT;

  it("在场滴(中心/邻居/普通)完全不受影响", () => {
    for (const role of [ROLE_NORMAL, ROLE_HERO, ROLE_PRESENT]) {
      const f = at(0, role);
      expect(f.scale).toBe(1);
      expect(f.lift).toBe(0);
      expect(f.absent).toBe(0);
    }
  });

  it("灰滴:从无到有 —— 尺度恒 1(不是小滴扩大),前段物质化,落位后完整", () => {
    const t0 = at(0, ABS0);
    expect(t0.absent).toBe(1);
    expect(t0.lift).toBeCloseTo(-ABSENT_DEPTH, 6);
    // 委托方 2026-09-12:「很明显能看见是从小液滴扩大」判不合格 → 尺度恒 1,
    // 「从无」由反向 dissolve(hashed discard 物质化)承担
    expect(t0.scale).toBe(1);
    expect(t0.dissolve).toBe(1); // 起点:完全不可见(全丢弃)
    const mid = at(FOCUS.start + FOCUS.rise * 0.22, ABS0);
    expect(mid.dissolve).toBeGreaterThan(0);
    expect(mid.dissolve).toBeLessThan(1); // 物质化中:部分丢弃
    expect(mid.scale).toBe(1); // 物质化中尺度也不变
    const done = at(FOCUS.start + FOCUS.rise, ABS0);
    expect(done.lift).toBeCloseTo(0, 6);
    expect(done.scale).toBe(1);
    expect(done.dissolve).toBe(0); // 落位:完整无丢弃
    // 物质化进程单调(dissolve 单调不增)
    let prev = 1.1;
    for (let k = 0; k <= 10; k++) {
      const f = at(FOCUS.start + FOCUS.rise * (k / 10), ABS0);
      expect(f.dissolve).toBeLessThanOrEqual(prev);
      prev = f.dissolve;
    }
  });

  it("渐次:后一颗晚于前一颗起步(同一时刻进度严格递减)", () => {
    const t = FOCUS.start + FOCUS.stagger + FOCUS.rise * 0.5;
    const r0 = absentRise(t, 0);
    const r1 = absentRise(t, 1);
    const r2 = absentRise(t, 2);
    expect(r0).toBeGreaterThan(r1);
    expect(r1).toBeGreaterThan(r2);
    expect(r0).toBeGreaterThan(0.5); // 第一颗已过半
    expect(r2).toBe(0); // 第三颗还没起步
  });

  it("浮现进度单调不减,且不超出 [0,1]", () => {
    let prev = -1;
    for (let t = 0; t <= 8; t += 0.1) {
      const r = absentRise(t, 1);
      expect(r).toBeGreaterThanOrEqual(prev);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
      prev = r;
    }
  });

  it("总时长覆盖全部灰滴的排期(3 颗)", () => {
    expect(focusDuration(3)).toBeLessThanOrEqual(FOCUS.start + 2 * FOCUS.stagger + FOCUS.rise + FOCUS.hold);
    const d = new FxDriver();
    d.reset(8);
    expect(d.duration).toBe(focusDuration(3));
    step(d, 0.1, 200);
    expect(d.t).toBe(d.duration);
    expect(absentRise(d.t, 2)).toBe(1); // 到末尾第三颗一定已就位
  });
});

describe("粗细系数(A-2 唯一入口;委托方 2026-09-11:变化不能过大,先验「可变」)", () => {
  it("默认基准 1.0,与 seed 无关", () => {
    const d = new FxDriver();
    expect(d.bridgeThick(0.1)).toBe(1.0);
    expect(d.bridgeThick(0.9)).toBe(1.0);
  });

  it("可整体设定:thick 置值后所有桥返回该值(粗细可变)", () => {
    const d = new FxDriver();
    d.thick = 0.7;
    expect(d.bridgeThick(0.3)).toBe(0.7);
    d.thick = 1.85;
    expect(d.bridgeThick(0.6)).toBe(1.85);
  });

  it("粗细不属于状态:reset(重播/切模式)不清设定,任何模式下返回值一致", () => {
    const d = new FxDriver();
    d.thick = 1.4;
    for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      d.reset(m);
      expect(d.bridgeThick(0.5)).toBe(1.4);
    }
  });
});

describe("9 大转折:三阶段时间线(动效 §5 / 规格 §8.3)", () => {
  /** 旧章七滴布局(与 main.ts OLD_NET 同构:核心滴 + 六边形环;索引 = 生成次序) */
  const NET_RING = 0.12;
  const OLD: TransSource[] = [
    { x: 0.5, y: 0.5, r: 0.022, core: true },
    ...Array.from({ length: 6 }, (_, k) => {
      const ang = (k / 6) * Math.PI * 2;
      return {
        x: 0.5 + Math.cos(ang) * NET_RING,
        y: 0.5 + Math.sin(ang) * NET_RING,
        r: k % 2 === 0 ? 0.016 : 0.013,
      };
    }),
  ];
  const drv = (t: number): FxDriver => {
    const d = new FxDriver();
    d.reset(9);
    d.setTransitionSources(OLD);
    d.t = t;
    return d;
  };
  /** 第 s 个源名下的池槽范围(池按源顺序连续分配) */
  const slotRange = (s: number): [number, number] => {
    const counts = allocatePoints(
      OLD.map((o) => o.r),
      POINT_POOL,
    );
    const start = counts.slice(0, s).reduce((a, b) => a + b, 0);
    return [start, start + (counts[s] ?? 0)];
  };

  it("总长落在规格区间 2.5-3.5s,五阶段首尾相接", () => {
    expect(TRANSITION.duration).toBeGreaterThanOrEqual(2.5);
    expect(TRANSITION.duration).toBeLessThanOrEqual(3.5);
    expect(TRANSITION.duration).toBe(TRANSITION.settle[1]);
    expect(TRANSITION.converge[1]).toBe(TRANSITION.merge[0]);
    expect(TRANSITION.merge[1]).toBe(TRANSITION.burst[0]);
    expect(TRANSITION.burst[1]).toBe(TRANSITION.attract[0]);
    expect(TRANSITION.attract[1]).toBe(TRANSITION.settle[0]);
    expect(drv(TRANSITION.duration).duration).toBe(TRANSITION.duration);
  });

  it("溃散:旧滴原地溶解(不缩不涨不位移),按索引降序错峰,核心滴压轴", () => {
    const x = 0.62;
    const y = 0.5;
    // 环滴(索引 1):溶解窗内 0→1 单调;尺度恒 1、不升不沉(原地溃散,不是滑入)
    let prev = -1;
    for (let k = 0; k <= 10; k++) {
      const t = 0.385 + (k / 10) * TRANSITION.shatterDur;
      const f = drv(t).dropletFx(ROLE_T_OLD, x, y, 1);
      expect(f.dissolve).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(f.scale).toBe(1);
      expect(f.lift).toBe(0);
      prev = f.dissolve;
    }
    expect(drv(0.385).dropletFx(ROLE_T_OLD, x, y, 1).dissolve).toBe(0);
    expect(drv(0.385 + TRANSITION.shatterDur).dropletFx(ROLE_T_OLD, x, y, 1).dissolve).toBe(1);
    // 索引降序错峰(与「从高索引往低删」对齐):索引 6 已溶解时索引 1 还没动
    const d6 = drv(0.2).dropletFx(ROLE_T_OLD, x, y, 6).dissolve;
    const d1 = drv(0.2).dropletFx(ROLE_T_OLD, x, y, 1).dissolve;
    expect(d6).toBeGreaterThan(0);
    expect(d1).toBe(0);
    // 核心滴压轴:起点(0.43)晚于全部环滴;同刻进度低于环滴;溃散末溶解满
    const ringMid = drv(0.53).dropletFx(ROLE_T_OLD, x, y, 1).dissolve;
    const coreMid = drv(0.53).dropletFx(ROLE_T_CORE, 0.5, 0.5, 0).dissolve;
    expect(drv(0.385).dropletFx(ROLE_T_CORE, 0.5, 0.5, 0).dissolve).toBe(0);
    expect(coreMid).toBeGreaterThan(0);
    expect(coreMid).toBeLessThan(ringMid);
    expect(
      drv(TRANSITION.shatterT0 + TRANSITION.shatterStagger * 6 + TRANSITION.shatterDur)
        .dropletFx(ROLE_T_CORE, 0.5, 0.5, 0).dissolve,
    ).toBeCloseTo(1, 5);
  });

  it("删滴时序:溃散末 + 余量、索引降序(交换删除安全)、全部早于爆散点;桥先卷没", () => {
    const d = drv(0);
    let prev = -Infinity;
    for (const i of [6, 5, 4, 3, 2, 1]) {
      const at = d.transRemoveAt(i);
      // 删除时刻随索引递减而**递增**:索引 6 最先到点、索引 1 最后 ——
      // 与 main.ts「从最高索引往低删」的循环同序,删者恒为末位、永不卡住。
      expect(at).toBeGreaterThan(prev);
      expect(at).toBeLessThan(TRANSITION.burst[0]); // 删滴全部发生在汇聚段内
      prev = at;
    }
    expect(d.transRemoveAt(6)).toBeCloseTo(
      TRANSITION.shatterT0 + TRANSITION.shatterDur + TRANSITION.removeMargin,
      6,
    );
    // 旧桥在任何 seed 下都必须先于第一次删滴卷没(否则渲染上还看得见的桥被硬切)
    for (const s of [0, 0.25, 0.5, 0.75, 1]) {
      expect(drv(TRANSITION.shatterClear).bridgeGrow(s)).toBe(0);
    }
    expect(TRANSITION.shatterClear).toBeLessThanOrEqual(d.transRemoveAt(6));
  });

  it("光点:炸裂分散到源滴四周 → 凝滞一瞬 → 漩涡吸入;体积小、悬浮、快闪", () => {
    const [s0, s1] = slotRange(6); // 索引 6 的源(环上最早炸开者)
    expect(s1).toBeGreaterThan(s0); // 该源分到了光点
    const slot = s0;
    const src = OLD[6]!;
    const d = drv(0);
    expect(d.spark(slot)).toBeNull(); // 未到起飞时刻
    const px: number[] = [];
    const py: number[] = [];
    let prevTh = 0;
    let turn = 0;
    let maxPointR = 0;
    let minH = Infinity;
    for (let k = 0; k <= 110; k++) {
      d.t = 0.25 + (k / 110) * 0.95; // 0.25 → 1.20
      const s = d.spark(slot);
      if (!s) continue;
      const th = Math.atan2(s.y - 0.5, s.x - 0.5);
      if (px.length > 0) turn += Math.atan2(Math.sin(th - prevTh), Math.cos(th - prevTh));
      prevTh = th;
      px.push(s.x);
      py.push(s.y);
      maxPointR = Math.max(maxPointR, s.r);
      minH = Math.min(minH, s.h);
    }
    expect(px.length).toBeGreaterThan(50);
    // 起飞点在源滴附近(尚未离开滴体)
    expect(Math.hypot(px[0]! - src.x, py[0]! - src.y)).toBeLessThan(0.03);
    // **炸裂**:起飞初期与源滴的距离迅速拉开(分散到四周;> 0.012 ≈ 一个滴径)
    const dsrc = px.map((x, i) => Math.hypot(x - src.x, py[i]! - src.y));
    expect(dsrc[0]!).toBeLessThan(0.03); // 起点在滴体上
    expect(Math.max(dsrc[2]!, dsrc[3]!, dsrc[4]!)).toBeGreaterThan(0.012);
    // **凝滞一瞬**:存在一段连续「几乎不动」的窗口(逐帧位移 < 1.5mm、≥8 帧 ≈0.07s)
    let still = 0;
    let longestStill = 0;
    for (let k = 0; k < px.length - 1; k++) {
      if (Math.hypot(px[k + 1]! - px[k]!, py[k + 1]! - py[k]!) < 0.0015) {
        still++;
        longestStill = Math.max(longestStill, still);
      } else {
        still = 0;
      }
    }
    expect(longestStill).toBeGreaterThan(8);
    // **四周**:同源光点在炸开峰后的方位铺开(不是同一方向的一条线)
    const angs: number[] = [];
    d.t = 0.40;
    for (let i = s0; i < s1; i++) {
      const s = d.spark(i);
      if (s) angs.push(Math.atan2(s.y - src.y, s.x - src.x));
    }
    expect(angs.length).toBeGreaterThan(4);
    angs.sort((a, b) => a - b);
    let gap = angs[0]! + Math.PI * 2 - angs[angs.length - 1]!; // 环形最大空隙
    for (let i = 1; i < angs.length; i++) gap = Math.max(gap, angs[i]! - angs[i - 1]!);
    expect(Math.PI * 2 - gap).toBeGreaterThan(1.2); // 铺开 > 1.2 rad(≈70°)
    // **漩涡**:转过 >1.5 rad(不是直线收拢);抵达后收到域中心
    expect(turn).toBeGreaterThan(1.5);
    expect(Math.hypot(px[px.length - 1]! - 0.5, py[py.length - 1]! - 0.5)).toBeLessThan(0.02);
    expect(maxPointR).toBeLessThan(0.008); // **体积小**:≤ 滴径(r 0.013+)的 ~60%
    expect(minH).toBeGreaterThan(0); // **悬浮**:全程离水
    expect(TRANSITION.pointIn).toBeLessThanOrEqual(0.04); // **「炸」**:出现是快闪
    // 抵达后被巨滴吸收:抵达窗上沿之后全池皆空
    d.t = TRANSITION.pointArrive[1] + 0.01;
    for (let i = 0; i < POINT_POOL; i++) expect(d.spark(i)).toBeNull();
  });

  it("光点池:按源半径比例分配、总数 = POOL、核心滴最多;重建逐槽复现", () => {
    expect(POINT_POOL).toBe(160); // 与 viewer 的 SPARK_MAX 同值(光点变小 → 密度补偿)
    const counts = allocatePoints(
      OLD.map((o) => o.r),
      POINT_POOL,
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(POINT_POOL);
    expect(counts.every((c) => c >= 1)).toBe(true);
    expect(counts[0]).toBeGreaterThan(Math.max(...counts.slice(1))); // 核心滴最多
    // 确定性:同布局两次构建,任意时刻逐槽一致
    const a = drv(0);
    const b = drv(0);
    for (const t of [0.5, 0.8, 1.05]) {
      a.t = t;
      b.t = t;
      for (let i = 0; i < POINT_POOL; i++) expect(a.spark(i)).toEqual(b.spark(i));
    }
    // 未注入源布局 → 无光点;非 mode 9 → 无光点
    const bare = new FxDriver();
    bare.reset(9);
    bare.t = 0.9;
    expect(bare.spark(0)).toBeNull();
    const off = new FxDriver();
    off.reset(1);
    off.setTransitionSources(OLD);
    off.t = 0.9;
    expect(off.spark(0)).toBeNull();
  });

  it("巨滴:光点凝聚而成(从无到有,dissolve 1→0 且尺度恒 4.2 不生长),凝滞后爆散缩零", () => {
    const coreEnd =
      TRANSITION.shatterT0 + TRANSITION.shatterStagger * 6 + TRANSITION.shatterDur; // 0.63
    expect(drv(coreEnd).dropletFx(ROLE_T_CORE, 0.5, 0.5, 0).dissolve).toBeCloseTo(1, 5);
    // 物质化:dissolve 单调 1→0;可见段尺度只在微呼吸幅度内(无生长)
    let prev = 1.1;
    const visibleScales: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = coreEnd + (k / 10) * (TRANSITION.giantForm[1] - coreEnd);
      const f = drv(t).dropletFx(ROLE_T_CORE, 0.5, 0.5, 0);
      expect(f.dissolve).toBeLessThanOrEqual(prev + 1e-9);
      if (f.dissolve < 0.99) visibleScales.push(f.scale);
      prev = f.dissolve;
    }
    expect(visibleScales.length).toBeGreaterThan(5);
    expect(Math.min(...visibleScales)).toBeGreaterThan(3.9); // 全程巨滴
    expect(Math.max(...visibleScales) - Math.min(...visibleScales)).toBeLessThan(0.5);
    expect(drv(TRANSITION.giantForm[1]).dropletFx(ROLE_T_CORE, 0.5, 0.5, 0).dissolve).toBe(0);
    // 凝滞段:悬停离水 + 蓄力辉光(与整改前一致)
    const hover = drv(1.45).dropletFx(ROLE_T_CORE, 0.5, 0.5, 0);
    expect(hover.lift).toBeGreaterThan(0);
    expect(hover.flash).toBeGreaterThan(0);
    // 爆散:闪 = 全程峰值、随后缩零(逐参数不变)
    const burstMid = drv(TRANSITION.burst[0] + 0.05).dropletFx(ROLE_T_CORE, 0.5, 0.5, 0);
    expect(burstMid.flash).toBeGreaterThan(hover.flash);
    const done = drv(TRANSITION.burst[0] + TRANSITION.burstShrink + 0.01).dropletFx(ROLE_T_CORE, 0.5, 0.5, 0);
    expect(done.scale).toBe(0);
  });

  it("新章滴:槽位物质化(从无到有),尺度恒 1,次序错峰", () => {
    const t0 = TRANSITION.attract[0] + 0.16;
    const first = drv(t0 + 0.17).dropletFx(ROLE_T_NEW);
    expect(first.scale).toBe(1); // 不是小滴扩大
    expect(first.dissolve).toBeGreaterThan(0);
    expect(first.dissolve).toBeLessThan(1);
    const done = drv(t0 + 0.34).dropletFx(ROLE_T_NEW);
    expect(done.dissolve).toBe(0);
    // 错峰:次序 1 在次序 0 的物质化中点还没起步,起步后进度落后
    const notYet = drv(t0 + 0.05).dropletFx(ROLE_T_NEW + 1);
    expect(notYet.dissolve).toBe(1);
    const later = drv(t0 + 0.17).dropletFx(ROLE_T_NEW + 1);
    expect(later.dissolve).toBeGreaterThan(first.dissolve);
  });

  it("桥:预兆段卷入(grow 1→0,seed 错峰,删滴前卷没),定格段抽丝生长(0→1)", () => {
    expect(drv(0).bridgeGrow(0.5)).toBe(1);
    const g1 = drv(0.25).bridgeGrow(0.1);
    const g2 = drv(0.25).bridgeGrow(0.9);
    expect(g1).toBeGreaterThan(0); // 未卷完
    expect(g1).toBeLessThan(1);
    expect(g2).toBeGreaterThan(g1); // seed 大 → 起卷更晚,剩余更多
    expect(drv(TRANSITION.merge[0]).bridgeGrow(0.5)).toBe(0);
    expect(drv(TRANSITION.attract[1]).bridgeGrow(0.5)).toBe(0); // 牵引段无桥
    const s0 = drv(TRANSITION.settle[0]).bridgeGrow(0.5);
    const s1 = drv(TRANSITION.duration - 0.05).bridgeGrow(0.5);
    expect(s1).toBeGreaterThan(s0);
    expect(drv(TRANSITION.duration).bridgeGrow(0.5)).toBe(1);
  });

  it("桥卷曲通道(turb):只在汇聚段非零,随剩余桥量衰减", () => {
    const early = drv(0.35).bridgeFx(0.5);
    expect(early.turb).toBeGreaterThan(0);
    expect(early.flow).toBe(0);
    expect(early.bubble).toBe(0);
    const late = drv(TRANSITION.merge[0] - 0.01).bridgeFx(0.5);
    expect(late.turb).toBeLessThan(early.turb); // 桥快卷完 → 卷曲随之收
    expect(drv(1.5).bridgeFx(0.5).turb).toBe(0); // 过渡段无旧桥
  });

  it("火花:飞射段半径减速外冲,悬停段位置稳定,牵引段逼近槽位,末段消隐", () => {
    const slots = [
      { x: 0.38, y: 0.42 },
      { x: 0.62, y: 0.42 },
      { x: 0.35, y: 0.6 },
      { x: 0.5, y: 0.63 },
      { x: 0.65, y: 0.6 },
      { x: 0.5, y: 0.32 },
    ];
    const t0 = TRANSITION.burst[0];
    const s = (t: number, i = 3): SparkState => sparkState(t, i, slots);
    // 飞射:位置半径单调增且增速递减(easeOut = 减速)
    const rAt = (t: number): number => Math.hypot(s(t).x - 0.5, s(t).y - 0.5);
    const r1 = rAt(t0 + 0.08);
    const r2 = rAt(t0 + 0.2);
    const r3 = rAt(t0 + TRANSITION.sparkFly);
    expect(r1).toBeLessThan(r2);
    expect(r2).toBeLessThan(r3);
    expect(r3 - r2).toBeLessThan(r2 - r1); // 减速感
    expect(r3).toBeGreaterThan(0.2); // 过冲到槽位(≈0.13)之外
    // 悬停:位置几乎不动(时空静止 + 微颤)
    const h1 = s(t0 + TRANSITION.sparkFly + 0.05);
    const h2 = s(t0 + TRANSITION.sparkFly + TRANSITION.sparkHover - 0.05);
    expect(Math.hypot(h1.x - h2.x, h1.y - h2.y)).toBeLessThan(0.004);
    // 牵引:终点逼近所属槽位
    const end = s(TRANSITION.attract[1]);
    const slot = slots[3 % slots.length]!;
    expect(Math.hypot(end.x - slot.x, end.y - slot.y)).toBeLessThan(0.01);
    expect(end.h).toBeCloseTo(0, 5); // 落回水面
    // 消隐:alpha 归零(真滴在槽位物质化交接)
    const fade = s(TRANSITION.attract[1] + TRANSITION.sparkFade);
    expect(fade.a).toBe(0);
    // 确定性:同参重复调用一致;亮度/高度有限
    expect(s(1.9)).toEqual(s(1.9));
    expect(h1.a).toBe(1);
  });

  it("transitionMix:过渡段达峰,爆散后回落;非 mode 9 恒 0", () => {
    expect(drv(0).transitionMix()).toBe(0);
    expect(drv(1.4).transitionMix()).toBeGreaterThan(drv(1.1).transitionMix());
    expect(drv(1.4).transitionMix()).toBeGreaterThan(0.9);
    expect(drv(TRANSITION.attract[1] + 0.3).transitionMix()).toBe(0);
    const off = new FxDriver();
    off.reset(8);
    off.t = 5;
    expect(off.transitionMix()).toBe(0);
  });

  it("spark 入口:爆散点前 = 光点(需源布局),爆散点后 = 火花(需槽位)", () => {
    const d = new FxDriver();
    d.reset(9);
    expect(d.spark(0)).toBeNull(); // 未注入源布局
    d.setTransitionSources(OLD);
    d.t = 0.9;
    expect(d.spark(0)).not.toBeNull(); // 汇聚段:光点已起飞
    d.t = 1.9;
    expect(d.spark(0)).toBeNull(); // 爆散段但没喂槽位
    d.setTransitionSlots([{ x: 0.4, y: 0.4 }]);
    expect(d.spark(0)).not.toBeNull();
    // ⚠ R4:爆散段仍只用前 SPARK_COUNT 槽(池扩到 96 是给汇聚段光点的)
    expect(SPARK_COUNT).toBe(48);
    expect(d.spark(SPARK_COUNT)).toBeNull();
    expect(d.spark(SPARK_COUNT + 1)).toBeNull();
    d.t = TRANSITION.attract[1] + TRANSITION.sparkFade + 0.01;
    expect(d.spark(0)).toBeNull(); // 消隐完
  });
});
