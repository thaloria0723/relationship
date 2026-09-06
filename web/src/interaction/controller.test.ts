import { describe, expect, it } from "vitest";
import {
  FOCUS_FREEZE,
  InteractionController,
  type PointerSample,
  type SceneSnapshot,
} from "./controller";

function ptr(opts: Partial<PointerSample> = {}): PointerSample {
  return {
    sx: 0,
    sy: 0,
    valid: true,
    worldX: 0.5,
    worldY: 0.5,
    down: false,
    ...opts,
  };
}

/** 快照:滴 0 圆心(200,200) r=40;滴 1 圆心(260,200) r=20 */
function snap(): SceneSnapshot {
  return {
    count: 2,
    cx: Float32Array.of(200, 260),
    cy: Float32Array.of(200, 200),
    cr: Float32Array.of(40, 20),
  };
}

const T0 = 10; // 起始时钟(秒)

describe("interaction/controller 命中(解析圆)", () => {
  it("空白 → hoverWater;圆内 → hoverDroplet", () => {
    const c = new InteractionController();
    const i1 = c.update(snap(), ptr({ sx: 100, sy: 100 }), T0, false);
    expect(i1).toContainEqual({ kind: "hoverWater", x: 0.5, y: 0.5 });
    const i2 = c.update(snap(), ptr({ sx: 200, sy: 210 }), T0 + 0.016, false);
    expect(i2).toContainEqual({ kind: "hoverDroplet", index: 0 });
  });

  it("拾取容差:圆外 12px 仍可抓取(容差 14px)", () => {
    const c = new InteractionController();
    // (240, 210):距滴0圆心 √(40²+10²)=41.2 > 40,距滴1 √(20²+10²)=22.4 > 20
    // 距滴0 = 41.2 ≤ 40+14 容差内;距滴1 = 22.4 > 20+14=34?否——22.4 < 34 也在容差内
    // 两滴都在容差内:score = dist/pr → 滴0: 41.2/40=1.03,滴1: 22.4/20=1.12 → 取滴0
    const i = c.update(snap(), ptr({ sx: 240, sy: 210 }), T0, false);
    expect(i).toContainEqual({ kind: "hoverDroplet", index: 0 });
  });

  it("指针无效区 → 不产生悬停意图", () => {
    const c = new InteractionController();
    const i = c.update(snap(), ptr({ valid: false }), T0, false);
    expect(i).toHaveLength(0);
  });
});

describe("interaction/controller 拖拽", () => {
  it("按下命中 → dragStart;移动 → dragMove;松开 → dragEnd", () => {
    const c = new InteractionController();
    c.update(snap(), ptr({ sx: 200, sy: 200 }), T0, false);
    const i1 = c.update(snap(), ptr({ sx: 200, sy: 200, down: true }), T0 + 0.1, true);
    expect(i1).toContainEqual({
      kind: "dragStart",
      index: 0,
      x: 0.5,
      y: 0.5,
    });
    const i2 = c.update(
      snap(),
      ptr({ sx: 220, sy: 200, down: true, worldX: 0.55 }),
      T0 + 0.2,
      false,
    );
    expect(i2).toContainEqual({ kind: "dragMove", x: 0.55, y: 0.5 });
    const i3 = c.update(
      snap(),
      ptr({ sx: 220, sy: 200, down: false }),
      T0 + 0.3,
      false,
    );
    expect(i3).toContainEqual({ kind: "dragEnd" });
  });
});

describe("interaction/controller 焦点模式与转场冻结", () => {
  /** 双击序列:down→up→down(第二次按下在双击窗口内)→ 触发后 up */
  function dblClick(
    c: InteractionController,
    s: SceneSnapshot,
    p: PointerSample,
    t: number,
  ): void {
    c.update(s, { ...p, down: true }, t, true);
    c.update(s, { ...p, down: false }, t + 0.03, false);
    c.update(s, { ...p, down: true }, t + 0.12, true);
    c.update(s, { ...p, down: false }, t + 0.15, false);
  }

  it("双击液滴 → focusEnter,冻结期意图被丢弃,冻结结束后恢复", () => {
    const c = new InteractionController();
    c.update(snap(), ptr({ sx: 200, sy: 200 }), T0, false);
    dblClick(c, snap(), ptr({ sx: 200, sy: 200 }), T0 + 1.0);
    // 冻结期:意图被丢弃(含 escape)
    const exit = c.escape();
    expect(c.phase).toBe("focus");
    expect(c.target).toBe(0);
    expect(exit).toBeNull();
    const i3 = c.update(snap(), ptr({ sx: 100, sy: 100 }), T0 + 1.3, true);
    expect(i3).toHaveLength(0);
    // 冻结结束但仍在聚焦:静默(不产悬停/拖拽意图,防 hover 分支改写焦点态)
    const i4 = c.update(snap(), ptr({ sx: 100, sy: 100 }), T0 + 1.75, false);
    expect(i4).toHaveLength(0);
    expect(c.phase).toBe("focus");
    // 双击空白退出 → 恢复悬停
    dblClick(c, snap(), ptr({ sx: 100, sy: 500 }), T0 + 1.9);
    expect(c.phase).toBe("idle");
    // 退出同样有 0.6s 转场冻结(§6),冻结后恢复悬停
    const i5 = c.update(snap(), ptr({ sx: 100, sy: 100 }), T0 + 2.9, false);
    expect(i5).toContainEqual({ kind: "hoverWater", x: 0.5, y: 0.5 });
  });

  it("焦点模式下双击空白 → focusExit", () => {
    const c = new InteractionController();
    c.update(snap(), ptr({ sx: 200, sy: 200 }), T0, false);
    dblClick(c, snap(), ptr({ sx: 200, sy: 200 }), T0 + 1.0);
    expect(c.phase).toBe("focus");
    // 冻结结束:跨 0.7s
    c.update(snap(), ptr({ sx: 100, sy: 500 }), T0 + 1.9, false);
    // 双击空白(距两滴均远:100,500)
    dblClick(c, snap(), ptr({ sx: 100, sy: 500 }), T0 + 2.0);
    expect(c.phase).toBe("idle");
  });

  it("escape() → focusExit;非焦点返回 null", () => {
    const c = new InteractionController();
    expect(c.escape()).toBeNull();
    c.update(snap(), ptr({ sx: 200, sy: 200 }), T0, false);
    dblClick(c, snap(), ptr({ sx: 200, sy: 200 }), T0 + 1.0);
    // 跨过冻结期(0.6s)后 Esc 生效
    c.update(snap(), ptr({ sx: 200, sy: 200, valid: false }), T0 + 2.0, false);
    const exit = c.escape();
    expect(exit).toEqual({ kind: "focusExit" });
  });
});
