// ============================================================
// 交互系统 · 模块②(设计文档:docs/交互系统设计-2026-09-07.md)
// 铁律(视觉规格 §1/§6):three-free、无颜色/GLSL、无 DOM;命中=解析圆;
// 转场期冻结输入。本模块只产出 Intent,物理效果由引擎意图 API 承接。
// ============================================================

/** 指针采样(viewer 适配层产出;worldX/Y 为指针与水面平面 y=0 的交点,米) */
export interface PointerSample {
  /** 屏幕像素坐标 */
  sx: number;
  sy: number;
  /** 水面世界坐标;valid=false 表示指针不在有效区 */
  valid: boolean;
  worldX: number;
  worldY: number;
  /** 主键按下 */
  down: boolean;
}

/** 场景快照:各液滴的屏幕空间解析圆(viewer 每帧投影产出) */
export interface SceneSnapshot {
  count: number;
  cx: Float32Array;
  cy: Float32Array;
  cr: Float32Array;
}

/** 意图(抽象数据,无视觉属性) */
export type Intent =
  | { kind: "hoverWater"; x: number; y: number }
  | { kind: "hoverDroplet"; index: number }
  | { kind: "dragStart"; index: number; x: number; y: number }
  | { kind: "dragMove"; x: number; y: number }
  | { kind: "dragEnd" }
  | { kind: "focusEnter"; index: number }
  | { kind: "focusExit" };

/** 双击判定窗口(秒)与位移容差(像素) */
const DOUBLE_CLICK_DT = 0.35;
const DOUBLE_CLICK_DXY = 14;
/** 命中拾取的屏幕容差(px) */
const GRAB_TOLERANCE = 14;
/** 悬停退出滞后(×容差圆):悬停中的液滴被升力抬升/波纹顶起时屏幕圆会移动
 *  数像素,若退出沿用进入容差会帧率级翻转悬停态 → 升力抖动(第三批 #2 抖动根因) */
const HOVER_EXIT_EXPAND = 1.6;
/** 焦点转场冻结时长(秒,§6 转场期冻结输入) */
export const FOCUS_FREEZE = 0.6;

type Phase = "idle" | "hover" | "drag" | "focus";

/**
 * 交互控制器:纯逻辑状态机。update() 每帧喂入指针采样与场景快照,
 * 返回本帧新产生的意图(justDown 为按键下降沿,由 DOM 适配层判定)。
 */
export class InteractionController {
  phase: Phase = "idle";
  /** 当前悬停/拖拽/聚焦的液滴索引(−1 = 无) */
  target = -1;
  /** 焦点转场剩余冻结时间(秒) */
  freezeLeft = 0;

  private lastDownT = -10;
  private lastDownX = 0;
  private lastDownY = 0;
  private prevNow = -1;

  update(
    snapshot: SceneSnapshot,
    pointer: PointerSample,
    now: number,
    justDown: boolean,
  ): Intent[] {
    const intents: Intent[] = [];
    const dt = this.prevNow < 0 ? 0 : Math.max(0, now - this.prevNow);
    this.prevNow = now;

    // ---- 转场期冻结(§6):意图丢弃,只维护按键沿;减到 0 的那一帧恢复 ----
    if (this.freezeLeft > 0) {
      this.freezeLeft = Math.max(0, this.freezeLeft - dt);
      if (this.freezeLeft > 0) {
        this.downEdge(pointer, now);
        return intents;
      }
    }

    const hit = pointer.valid ? this.pick(snapshot, pointer.sx, pointer.sy) : -1;

    // ---- 双击(沿触发):焦点模式进入/退出 ----
    if (justDown) {
      const isDouble =
        now - this.lastDownT <= DOUBLE_CLICK_DT &&
        Math.hypot(pointer.sx - this.lastDownX, pointer.sy - this.lastDownY) <=
          DOUBLE_CLICK_DXY;
      this.downEdge(pointer, now);
      if (isDouble) {
        this.lastDownT = -10;
        if (this.phase === "focus") {
          this.phase = "idle";
          this.target = -1;
          this.freezeLeft = FOCUS_FREEZE;
          intents.push({ kind: "focusExit" });
          return intents;
        }
        if (hit >= 0) {
          this.phase = "focus";
          this.target = hit;
          this.freezeLeft = FOCUS_FREEZE;
          intents.push({ kind: "focusEnter", index: hit });
          return intents;
        }
        return intents;
      }
    }

    // ---- 焦点期守卫:聚焦态不发任何拖拽/悬停意图(否则 hover 分支会立刻
    //      改写 phase 导致 Esc/双击退出全失效);退出仅经上方双击或 escape() ----
    if (this.phase === "focus") {
      this.downEdge(pointer, now);
      return intents;
    } else {
      this.downEdge(pointer, now);
    }

    // ---- 拖拽 ----
    if (this.phase === "drag") {
      if (pointer.valid) {
        intents.push({ kind: "dragMove", x: pointer.worldX, y: pointer.worldY });
      }
      if (!pointer.down) {
        this.phase = "hover";
        this.target = hit;
        intents.push({ kind: "dragEnd" });
      }
      return intents;
    }

    // ---- 按下命中 → 开始拖拽 ----
    if (justDown && hit >= 0) {
      this.phase = "drag";
      this.target = hit;
      intents.push({
        kind: "dragStart",
        index: hit,
        x: pointer.worldX,
        y: pointer.worldY,
      });
      return intents;
    }

    // ---- 悬停 ----
    if (pointer.valid) {
      // 滞后保持:已在悬停且指针仍在该滴的扩张圆内 → 维持目标不重判
      // (升力抬升/波纹顶起都会移动屏幕圆,无滞后会帧率级翻转悬停态)
      const held =
        this.phase === "hover" &&
        this.target >= 0 &&
        this.target < snapshot.count &&
        Math.hypot(
          snapshot.cx[this.target]! - pointer.sx,
          snapshot.cy[this.target]! - pointer.sy,
        ) <=
          (snapshot.cr[this.target]! + GRAB_TOLERANCE) * HOVER_EXIT_EXPAND;
      const picked = held
        ? this.target
        : this.pick(snapshot, pointer.sx, pointer.sy);
      if (picked >= 0) {
        if (this.phase !== "hover" || this.target !== picked) {
          this.phase = "hover";
          this.target = picked;
          intents.push({ kind: "hoverDroplet", index: picked });
        }
      } else {
        this.phase = "idle";
        this.target = -1;
        intents.push({ kind: "hoverWater", x: pointer.worldX, y: pointer.worldY });
      }
    } else if (this.phase === "hover") {
      this.phase = "idle";
      this.target = -1;
    }
    return intents;
  }

  /** 引擎/页面重置后调用:回到 idle,清冻结与目标 */
  reset(): void {
    this.phase = "idle";
    this.target = -1;
    this.freezeLeft = 0;
    this.lastDownT = -10;
  }

  /** Esc(适配层转接):焦点模式退出意图;非焦点返回 null */
  escape(): Intent | null {
    if (this.phase === "focus" && this.freezeLeft <= 0) {
      this.phase = "idle";
      this.target = -1;
      this.freezeLeft = FOCUS_FREEZE;
      return { kind: "focusExit" };
    }
    return null;
  }

  private downEdge(pointer: PointerSample, now: number): void {
    if (pointer.down) {
      this.lastDownT = now;
      this.lastDownX = pointer.sx;
      this.lastDownY = pointer.sy;
    }
  }

  /** 解析圆命中:圆 = cr + 拾取容差;包含者中取 dist/pr 最小,平局取索引小 */
  private pick(snapshot: SceneSnapshot, sx: number, sy: number): number {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < snapshot.count; i++) {
      const r = snapshot.cr[i]! + GRAB_TOLERANCE;
      const dist = Math.hypot(snapshot.cx[i]! - sx, snapshot.cy[i]! - sy);
      if (dist > r) continue;
      const score = dist / snapshot.cr[i]!;
      if (score < bestScore - 1e-9) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }
}
