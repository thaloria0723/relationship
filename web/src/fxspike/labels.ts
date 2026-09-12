// ============================================================
// B 组效果验证 · 文字叠层(委托方 2026-09-11:「文案用最佳方式」;
// 2026-09-12 二次裁定:**文字标到液滴上去**,重新解决可读性,不要背景边框)
//
// 方案 = **HTML 叠层**,不把文字烘进 3D/shader:
//  - 文字清晰度与分辨率/机位距离无关,中文排版零成本(不用建字体纹理图集);
//  - 每帧每标签只做一次「世界 → 屏幕」投影 + 一次 transform 写入,开销可忽略;
//  - 对宿主就是一个 pointer-events:none 的普通 DOM 层,后续组件线
//    (<droplet-net>)接入时照搬这一层即可。
//  v3 锚定:文字**标在液滴上**(动效 §1.1「水滴表面需清晰显示对应人物的名字」)
//  —— 锚点 = 液滴渲染位投影中心,字号随投影半径自适应(滴小字小,始终贴滴)。
//  可读性解法(无底牌无边框):对比度靠**光晕描边**而非底色 ——
//  名字落在珍珠亮滴上 → 深墨青字 + 米白微晕(日夜液滴都是亮球,通用);
//  灰滴(已退场/未出场)偏暗 → 月光淡银字 + 暗晕。样式见 fxspike.html .fx-label。
//  §2.3:已退场 → 文字关系说明;未出场 → 「未知关系」且**滴中无名字**(该滴
//  本身无名字标签,关系说明同锚在滴心)。
//
// ⚠ 已知边界:标签不做遮挡判断(被前景液滴挡住时仍在最上层)。液滴网络是
//  俯视浅景,互相遮挡罕见;真要做需读深度缓冲,代价与复杂度都不值(验证页)。
// ============================================================

import { span01 } from "./fxdriver";

/** 标签种类:name = 在场人名;gone = 已退场的关系说明;unknown = 未出场 */
export type LabelKind = "name" | "gone" | "unknown";

export interface LabelSpec {
  /** 稳定 key(= 液滴索引的字符串形式) */
  key: string;
  text: string;
  kind: LabelKind;
}

/** 灰滴标签渐显:浮起 70% 前不显,就位时全显(文字不能先于水滴出现) */
export function labelAlpha(rise: number): number {
  return span01(rise, 0.7, 1);
}

/** 字号随投影半径自适应(v3 上滴):下限保可读、上限防大滴字号失控。 */
export function labelFontSize(r: number): number {
  return Math.min(16, Math.max(10, r * 0.9));
}

export class LabelLayer {
  private root: HTMLDivElement;
  private items = new Map<string, { el: HTMLDivElement; spec: LabelSpec; lastFs: number }>();

  /** `host` 传挂载容器的兄弟位即可(验证页传 #app):层要在 canvas 之上、
   *  HUD 之下,靠 DOM 顺序而非 z-index 保证。 */
  constructor(host: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "fx-labels";
    host.appendChild(this.root);
  }

  /** 深夜换墨色(委托方 2026-09-12「文字与画面风格一致」):深夜水面近黑、
   *  液滴是大亮球,日间墨青字看不清 → 切月光淡银 + 暗晕;其余时段 = 墨青 +
   *  米白光晕。由宿主按时段按钮状态调。 */
  setNight(on: boolean): void {
    this.root.classList.toggle("night", on);
  }

  /** 同步标签集合(只在集合变化时增删 DOM;场景/模式切换时调) */
  sync(specs: LabelSpec[]): void {
    const want = new Set(specs.map((s) => s.key));
    for (const [key, it] of this.items) {
      if (!want.has(key)) {
        it.el.remove();
        this.items.delete(key);
      }
    }
    for (const spec of specs) {
      const cur = this.items.get(spec.key);
      if (cur) {
        if (cur.spec.text !== spec.text || cur.spec.kind !== spec.kind) {
          cur.el.textContent = spec.text;
          cur.el.className = `fx-label ${spec.kind}`;
          cur.spec = spec;
        }
        continue;
      }
      const el = document.createElement("div");
      el.textContent = spec.text;
      el.className = `fx-label ${spec.kind}`;
      this.root.appendChild(el);
      this.items.set(spec.key, { el, spec, lastFs: -1 });
    }
  }

  /** 摆一帧:`r` = 液滴投影半径(px);alpha ≤ 0 或出画 = 藏。
   *  v3:**文字标在液滴上** —— 锚点 = 滴心投影,字号随 r 自适应;
   *  字体行高按 1 排,靠 translate(-50%,-50%) 精确压滴心。 */
  place(key: string, sx: number, sy: number, r: number, alpha: number): void {
    const it = this.items.get(key);
    if (!it) return;
    // 出画(含边距)就藏。⚠ 相机背后的点投影后会翻到对面,单判象限不可靠;
    // 本页相机绕场景中心转、液滴都在中心附近,出画判定够用(见文件头边界说明)。
    const m = 80;
    if (
      alpha <= 0 ||
      sx < -m ||
      sy < -m ||
      sx > window.innerWidth + m ||
      sy > window.innerHeight + m
    ) {
      it.el.style.opacity = "0";
      return;
    }
    const fs = labelFontSize(r);
    if (it.lastFs !== fs) {
      it.el.style.fontSize = `${fs.toFixed(1)}px`;
      it.lastFs = fs;
    }
    it.el.style.opacity = alpha.toFixed(3);
    it.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%)`;
  }
}
