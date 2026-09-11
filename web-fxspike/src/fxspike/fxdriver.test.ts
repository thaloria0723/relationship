// B 组效果验证 · 效果驱动单测(纯逻辑,无渲染依赖)
import { describe, expect, it } from "vitest";
import {
  ABSENT_DEPTH,
  absentRise,
  CLASH,
  CONDENSE,
  DEATH,
  FOCUS,
  focusDuration,
  FxDriver,
  FX_MAX,
  FX_NAMES,
  revealTarget,
  ROLE_ABSENT,
  ROLE_HERO,
  ROLE_NORMAL,
  ROLE_PRESENT,
  span01,
} from "./fxdriver";

const step = (d: FxDriver, dt: number, frames: number, dist = 1): void => {
  for (let i = 0; i < frames; i++) d.update(dt, dist);
};

describe("FX_NAMES / 模式表", () => {
  it("共 7 个效果,索引即模式号,0 为关", () => {
    expect(FX_NAMES.length).toBe(FX_MAX + 1);
    expect(FX_NAMES[0]).toBe("关");
    expect(FX_NAMES[6]).toBe("凝结");
    expect(FX_NAMES[7]).toBe("死亡");
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

  it("灰滴:从水底升起 + 由小渐大,落位后 absent = 1", () => {
    const t0 = at(0, ABS0);
    expect(t0.absent).toBe(1);
    expect(t0.lift).toBeCloseTo(-ABSENT_DEPTH, 6);
    expect(t0.scale).toBeCloseTo(0.45, 6);
    const done = at(FOCUS.start + FOCUS.rise, ABS0);
    expect(done.lift).toBeCloseTo(0, 6);
    expect(done.scale).toBeCloseTo(1, 6);
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
