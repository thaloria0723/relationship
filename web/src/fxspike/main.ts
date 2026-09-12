// ============================================================
// B 组效果验证页(一次性;建在 web/ 的副本 web-fxspike 上,生产源码零改动)
//
// 九效果:1 融合 · 2 拉扯 · 3 对撞 · 4 暗流 · 5 潜流 · 6 凝结 · 7 死亡 · 8 聚焦
//        + 9 大转折(汇聚 → 过渡 → 迸发 → 定格;动效 §5 / 规格 §8.3)
//
// 场景:固定两滴 + 一条液桥(效果作用对象单一,便于判定「做没做到」);
//       8 聚焦 = 中心 + 邻居 + 灰滴;9 大转折 = 旧章网络 → 新章网络。
// 时间源:物理引擎是唯一时间源,效果驱动器由 viewer 主循环喂 dt,不引第二时钟。
//
// 取帧(步骤 6 用):headless Chrome 的 --virtual-time-budget **推不动 simTime**
// (实测 9 秒预算只到 0.06s),故本页支持 URL 参数**同步预滚**到目标时刻后冻结:
//   fxspike.html?fx=7&t=1.5&shot=1     → 预滚 → 置 t=1.5 → 冻结 → 渲一帧
//   fxspike.html?fx=5&reveal=1&shot=1  → 潜流:强制揭示度(无指针环境)
// ============================================================

import { defaultParams } from "../watersim/params";
import {
  BRIDGE_THICK,
  mountLuxViewer,
  setFxSource,
  type FxSource,
} from "../grayview/viewer";
import type { WaterEngine } from "../watersim/engine";
import {
  ABSENT_DEPTH,
  absentRise,
  DEATH,
  FxDriver,
  FX_MAX,
  FX_NAMES,
  revealTarget,
  ROLE_ABSENT,
  ROLE_HERO,
  ROLE_NORMAL,
  ROLE_PRESENT,
  ROLE_T_CORE,
  ROLE_T_NEW,
  ROLE_T_OLD,
  TRANSITION,
} from "./fxdriver";
import { LabelLayer, labelAlpha, type LabelSpec } from "../reader/labels";
import {
  FIXTURE_FIRST_CHAPTER,
  transitionReadout,
} from "../reader/transition-fixture";
import { SliderGate } from "../reader/tension";

const params = defaultParams;
const driver = new FxDriver();

/** 主角度色 = 液滴索引 1(凝结的新滴 / 死亡的将死滴) */
const HERO = 1;
/** 两滴布点(引擎域米;域边长 1.0) */
const DROP_A = { x: 0.38, y: 0.5 };
const DROP_B = { x: 0.62, y: 0.5 };
/** 预滚步数 × 1/60s ≈ 8 秒仿真(落定 + 成桥 + 水面静稳) */
const PREROLL_STEPS = 480;

/** 聚焦场景(动效 §2.3):中心 + 两个在场邻居 + 三颗未在场灰滴 */
const FOCUS_CENTER = { x: 0.5, y: 0.5, r: 0.026 };
const FOCUS_PRESENT = [
  { x: 0.422, y: 0.432, r: 0.018 },
  { x: 0.578, y: 0.436, r: 0.018 },
];
const FOCUS_ABSENT = [
  { x: 0.422, y: 0.578, r: 0.018 },
  { x: 0.503, y: 0.592, r: 0.018 },
  { x: 0.58, y: 0.575, r: 0.018 },
];

/**
 * 大转折(mode 9)场景:旧章网络 → 新章网络(动效 §5「定格为新章节的关系网」)。
 * 旧章 = 中心 + 六边形环(与 HUD「网络」按钮同款确定性布局);
 * 新章 = 一名成员退场(六边形 → 五边形)+ 一名成员外移(关系变淡)——
 * 差异肉眼可辨,证明迸发后定格的确实是「新章节」的关系网。
 * ⚠ 布点都给引擎坐标;spawn 次序 = 数组次序(索引 0 = 核心滴,雾锚点)。
 */
const NET_RING = 0.12;
const OLD_NET: { x: number; y: number; r: number; role: number }[] = [
  { x: 0.5, y: 0.5, r: 0.022, role: ROLE_T_CORE },
  ...Array.from({ length: 6 }, (_, k) => {
    const ang = (k / 6) * Math.PI * 2;
    return {
      x: 0.5 + Math.cos(ang) * NET_RING,
      y: 0.5 + Math.sin(ang) * NET_RING,
      r: k % 2 === 0 ? 0.016 : 0.013,
      role: ROLE_T_OLD,
    };
  }),
];
/** 新章:中心 + 五环(缺 0° 位)+ 一颗外移滴(30° 方向、半径 0.185,关系变淡) */
const NEW_NET: { x: number; y: number; r: number }[] = [
  { x: 0.5, y: 0.5, r: 0.022 },
  ...Array.from({ length: 5 }, (_, k) => {
    const ang = ((k + 1) / 6) * Math.PI * 2;
    return {
      x: 0.5 + Math.cos(ang) * NET_RING,
      y: 0.5 + Math.sin(ang) * NET_RING,
      r: 0.015,
    };
  }),
  { x: 0.5 + Math.cos(Math.PI / 6) * 0.185, y: 0.5 + Math.sin(Math.PI / 6) * 0.185, r: 0.012 },
];

/** 逐滴角色表(液滴索引 → fxdriver 角色)。液滴按入队次序编号,故与生成次序一一对应。 */
let roles: number[] = [];
/** 未在场灰滴索引的位图(抑制它们的桥用) */
const absentSet = new Uint8Array(params.maxDroplets);

const q = new URLSearchParams(location.search);
const shotMode = q.get("shot") === "1";
const qFx = Number(q.get("fx") ?? NaN);
const qT = Number(q.get("t") ?? NaN);
const qReveal = q.has("reveal") ? Number(q.get("reveal")) : null;
/** 合成指针位置(屏幕像素;headless 里没有真鼠标,潜流这类「受鼠标控制」的效果
 *  不注入指针就永远验不了)。*/
const qPx = q.has("px") ? Number(q.get("px")) : null;
const qPy = q.has("py") ? Number(q.get("py")) : null;
/** 探针:把「指针到桥轴的距离 / 揭示目标值 / 当前揭示度」叠到说明上(取帧可读)。*/
const probe = q.get("probe") === "1";
/** 粗细系数覆写(A-2 数据映射未接;验证「粗细可从唯一入口变化」用。
 *  viewer 侧钳在 BRIDGE_THICK 的 0.55~1.85 视觉安全区间,超给即被钳)。 */
const qThick = q.has("thick") ? Number(q.get("thick")) : null;
/** 预滚步数覆写(每步 1/60s):取帧时 simTime = 步数/60 —— 扫「周期性现象
 *  (如深夜频闪)的相位」用,不用改代码就能把冻结帧钉到周期上的不同时刻。 */
const qPt = q.has("pt") ? Number(q.get("pt")) : null;

/** 效果说明(取帧证据帧上叠字用;与动效文档原文对齐) */
const FX_CAPTION: readonly string[] = [
  "0 关(基线:无任何关系状态表达)",
  "1 融合(亲密/羁绊)\n液桥粗壮近似无边界;高光/微气泡双向缓慢流动。",
  "2 极限拉扯(疏远/冷漠)\n中间极细、濒临断裂;线上光泽黯淡。\n" +
    "⚠ 颈径设屏幕空间下限(≈2.6px):圆柱靠径向明暗带的空间分离才读作圆柱,\n" +
    "  宽度 <2px 时这些带合并被 MSAA 抹平 → 只能读成薄片(上版「黑刀片」根因)。\n" +
    "  「黯淡」走向背景色收敛 + 去饱和 + 镜面变钝,**不压暗**(亮背景下压暗反而更抢眼)。",
  "3 对撞(敌对/冲突)\n两端同时亮起,快速向中心推进;两斑接触后融合,\n" +
    "逐渐消散并冒出气泡。\n" +
    "⚠ 原「湍流」三项(极粗/水花飞溅/两滴颤动)已按委托方裁决作废。",
  "4 暗流(单向/利用)\n密集微小气泡/光点单向快速冲刷,无回流。",
  "5 潜流(隐藏/秘密)\n平时半透明融入背景;鼠标靠近才像搅动泥沙般浮现流动纹理。",
  "6 凝结登场(新人物加入)\n起雾 → 雾团聚拢 → 凝结成滴 → 向周围抽出液桥。",
  "7 死亡蒸发(退场)\n边缘沸腾 → 化作水蒸气上飘 → 液桥回缩断裂 → 原位残留雾气。",
  "8 聚焦:未在场灰滴(动效 §2.3)\n进入聚焦后数秒,灰滴**渐次从水底浮现**;\n" +
    "已退场/未出场 → 灰,无动态关系表达(不出桥)。\n" +
    "文字叠层(HTML):文字**标在液滴上**(v3),无底牌无边框;\n" +
    "已退场 → 关系说明;未出场 → 「未知关系」且滴中无名字。\n" +
    "⚠ 半透明水柱仍按委托方裁决未做。",
  "9 大转折(动效 §5 / 规格 §8.3,≈3.3s)\n" +
    "汇聚:旧网溃散成光点、光点漩涡向心凝聚成巨滴(从无到有)→ 巨滴凝滞一瞬后炸裂 →\n" +
    "迸发:爆散闪光,火花飞射-减速-悬停-被牵引 → 定格:新章滴物质化+新桥抽丝。\n" +
    "转场期间输入冻结(§8.4);章节滑块(左下)150ms 防抖+松手触发,跳跃=一次转场。",
];

function setupScene(e: WaterEngine, focus: boolean, trans: boolean): void {
  roles = [];
  absentSet.fill(0);
  const spawn = (x: number, y: number, r: number, role: number): void => {
    const surf = e.field.totalHeight(x, y);
    if (!e.spawnDroplet(x, y, surf + r + params.dropHeight, r)) return;
    // spawnDroplet 是「下一固定步生效」的入队,滴号 = 生成次序(无合并/删除时成立)
    roles.push(role);
    // 灰滴桥抑制只属聚焦场景。大转折角色(≥4)数值上落在这个区间,但 mode 9
    // 的新章桥**不能**被抑制 —— 故按场景开关,不按数值(实测级坑,勿「简化」)。
    if (focus && role >= ROLE_ABSENT) absentSet[roles.length - 1] = 1;
  };
  if (focus) {
    spawn(FOCUS_CENTER.x, FOCUS_CENTER.y, FOCUS_CENTER.r, ROLE_PRESENT);
    for (const p of FOCUS_PRESENT) spawn(p.x, p.y, p.r, ROLE_NORMAL);
    FOCUS_ABSENT.forEach((p, i) => spawn(p.x, p.y, p.r, ROLE_ABSENT + i));
    return;
  }
  if (trans) {
    for (const p of OLD_NET) spawn(p.x, p.y, p.r, p.role);
    return;
  }
  spawn(DROP_A.x, DROP_A.y, 0.022, ROLE_NORMAL);
  spawn(DROP_B.x, DROP_B.y, 0.022, ROLE_HERO);
}

/** 未在场灰滴**无动态关系表达**(§2.3):抑制任何牵到它们的桥。
 *  用 setCut(只标不渲染)而不是断桥 —— 断桥会搬动槽位、打乱索引。 */
function suppressAbsentBridges(e: WaterEngine): void {
  const bs = e.bridges.state;
  for (let k = 0; k < bs.count; k++) {
    if (bs.cut[k] !== 0) continue;
    const a = bs.a[k]!;
    const b = bs.b[k]!;
    if (absentSet[a] === 1 || absentSet[b] === 1) e.bridges.setCut(k, true);
  }
}

// ---- 文字叠层(仅聚焦场景;委托方 2026-09-11「文案用最佳方式」) ----
/** 验证页无真实人物数据,文案为**示例**:要验证的是「文字叠层」这一能力与
 *  §1.1/§2.3 的摆放规则,不是内容本身。已退场给一条关系说明示例,
 *  未出场统一「未知关系」。 */
const LABEL_TEXTS = {
  center: "中心 · 主角",
  neighbor: ["人物甲", "人物乙"],
  absent: ["已故 · 挚友", "未知关系", "未知关系"],
} as const;

/** 文字叠层。⚠ 必须在 `mountLuxViewer` **之后**创建(要排在 canvas 之后、
 *  HUD 之前,靠 DOM 顺序而不是 z-index 分层),故晚绑定。 */
let labels: LabelLayer | null = null;
/** 标签集合签名(模式 + 角色表长度);变了才重建 DOM,每帧只摆位置 */
let labelsSig = "";
function syncLabels(): void {
  const sig = `${driver.mode}:${roles.length}`;
  if (sig === labelsSig) return;
  labelsSig = sig;
  if (driver.mode !== 8) {
    labels?.sync([]); // 文字属聚焦/§2.3 范畴:其余模式一律无标签
    return;
  }
  const specs: LabelSpec[] = [];
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]!;
    const key = String(i);
    if (role >= ROLE_ABSENT) {
      const order = role - ROLE_ABSENT;
      specs.push({
        key,
        text: LABEL_TEXTS.absent[order] ?? "未知关系",
        kind: order === 0 ? "gone" : "unknown",
      });
    } else if (role === ROLE_PRESENT) {
      specs.push({ key, text: LABEL_TEXTS.center, kind: "name" });
    } else {
      specs.push({
        key,
        text: LABEL_TEXTS.neighbor[i - 1] ?? "人物",
        kind: "name",
      });
    }
  }
  labels?.sync(specs);
}

/** 逐帧摆放:投影液滴**渲染位**(灰滴带 lift 下沉量),灰滴标签随浮现渐显;
 *  投影半径一并传入 → v3 字号随滴自适应,文字压滴心。 */
function placeLabels(): void {
  if (driver.mode !== 8) return; // 文字属聚焦场景;大转折角色编码≥4,勿混入灰滴逻辑
  const g = grayProbe();
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]!;
    let alpha = 1;
    let lift = 0;
    if (role >= ROLE_ABSENT) {
      const rise = absentRise(driver.t, role - ROLE_ABSENT);
      alpha = labelAlpha(rise);
      lift = -ABSENT_DEPTH * (1 - rise);
    }
    const s = g?.screenOf?.(i, lift);
    if (s) labels?.place(String(i), s[0]!, s[1]!, s[2]!, alpha);
  }
}

/** 场景随模式切换:聚焦(8)用聚焦场景,大转折(9)用旧章网络,其余两滴一桥。
 *  切换时清场重建。 */
let sceneMode = -1;
/** 本场景应有多少滴(setupScene 入队后即定) */
let sceneExpect = 0;
/** 请求重建(进入「死亡」/「大转折」时置位):死亡会把主角滴**真的删掉**,
 *  大转折会把整张网换成新章 —— 不重建重播就没得演。只在真的请求时才重建。 */
let sceneResetRequest = false;
type SceneKind = "pair" | "focus" | "trans";
const sceneKindOf = (mode: number): SceneKind =>
  mode === 8 ? "focus" : mode === 9 ? "trans" : "pair";
function ensureScene(e: WaterEngine, mode: number): void {
  const want = sceneKindOf(mode);
  const first = sceneMode === -1; // ⚠ 首次必须建场,不能被下面的早返回吃掉
  const boundaryChanged = !first && want !== sceneKindOf(sceneMode);
  const requested = sceneResetRequest;
  sceneResetRequest = false;
  const depleted = requested && !first && e.droplets.state.count < sceneExpect;
  // 大转折重播:**无条件**重建 —— 转场中段的液滴数可能恰好等于期望值
  // (旧滴删了、新滴补上),组成却完全不同,按数量判断会漏。
  const forceTrans = requested && !first && want === "trans";
  if (!first && !boundaryChanged && !depleted && !forceTrans) return;
  if (!first) {
    while (e.droplets.state.count > 0) e.removeDroplet(e.droplets.state.count - 1);
  }
  sceneMode = mode;
  transSpawned = false; // 重建即回到「旧章完好」状态
  setupScene(e, want === "focus", want === "trans");
  sceneExpect = roles.length;
}

/** 效果驱动源适配:把 viewer 的通用接口接到本页的 FxDriver */
const source: FxSource = {
  bridgeKind: () => driver.bridgeKind(),
  bridgeFx: (seed) => driver.bridgeFx(seed),
  bridgeGrow: (seed) => driver.bridgeGrow(seed),
  dropletFx: (i, x, y) => driver.dropletFx(roles[i] ?? ROLE_NORMAL, x, y, i),
  fogCue: (i, cx, cy) => driver.fogCue(i, cx, cy),
  // 颈径屏幕空间下限**常开**(不只是「拉扯」)。
  // 原因(实测):本机位下基线自身的桥颈径就 <2px,径向明暗带合并、只剩亮边剪影,
  // 桥读成「一片带亮边的扁平透镜」而不是管子 —— 亚像素问题影响的是所有模式。
  // 验证页的目的是验效果、不是重审基线,故统一抬到可读下限,让比较公平。
  neckFloorOn: () => true,
  bridgeThick: (seed) => driver.bridgeThick(seed),
  update: (dt, dist) => driver.update(dt, dist),
  // ---- 大转折(mode 9)扩展通道 ----
  fogAnchor: () => (driver.mode === 9 ? 0 : 1), // 核心滴 = 旧章中心(索引 0)
  transitionMix: () => driver.transitionMix(),
  sparkAt: (i) => driver.spark(i),
};

function setMode(mode: number): void {
  driver.reset(mode);
  driver.frozen = shotMode;
  // 死亡会把主角滴删掉 / 大转折会把网换掉 —— 再进这个模式得重建场景
  if (mode === 7 || mode === 9) sceneResetRequest = true;
  if (mode === 9) {
    driver.setTransitionSlots(NEW_NET);
    // 旧章「源」布局(溃散排期 + 光点起飞点):索引 = 生成次序 = 液滴索引,
    // 核心滴标记 core(溃散压轴,随后物质化为巨滴)
    driver.setTransitionSources(
      OLD_NET.map((p) => ({ x: p.x, y: p.y, r: p.r, core: p.role === ROLE_T_CORE })),
    );
    // 规格 §8.4:转场期间输入冻结(1-3s 禁用拖拽/点击;时长 = 演出全长)
    const c = grayProbe()?.controller;
    if (c) c.freezeLeft = TRANSITION.duration;
  }
  updateCaption();
  for (const btn of fxBtns) {
    btn.classList.toggle("lux-active", Number(btn.dataset.fx) === mode);
  }
}

let captionNode: HTMLElement | null = null;
/** 最近一次滑块触发的转场读数(§8.1 张力公式;叠在 mode 9 说明框里,取帧可读) */
let transReadout = "";
function updateCaption(): void {
  if (!captionNode) return;
  let text = FX_CAPTION[driver.mode] ?? "";
  if (driver.mode === 9 && transReadout) text += `\n${transReadout}`;
  // 粗细覆写生效时把读数叠上(证据帧 ?cap=1 可读;行保持短,说明框不超宽)
  if (driver.thick !== 1) {
    text +=
      `\n[thick] 粗细系数=${driver.thick.toFixed(2)}` +
      `(钳 ${BRIDGE_THICK.min}~${BRIDGE_THICK.max})`;
  }
  captionNode.textContent = text;
  // 取帧时默认隐藏叠字(不挡画面);?cap=1 可强制显示,做带说明的证据帧
  const wantCap = !shotMode || q.get("cap") === "1";
  captionNode.style.display = text && wantCap ? "block" : "none";
}

// ---- 键盘 + 按钮 ----
const fxBtns: HTMLButtonElement[] = [];
function buildButtons(): void {
  const host = document.getElementById("fx-btns");
  if (!host) return;
  for (let m = 0; m <= FX_MAX; m++) {
    const b = document.createElement("button");
    b.textContent = m === 0 ? "关" : `${m} ${FX_NAMES[m]}`;
    b.dataset.fx = String(m);
    b.addEventListener("click", () => setMode(m));
    host.appendChild(b);
    fxBtns.push(b);
  }
}

window.addEventListener("keydown", (ev) => {
  if (ev.key >= "0" && ev.key <= String(FX_MAX)) {
    setMode(Number(ev.key));
    return;
  }
  if (ev.key === " ") {
    ev.preventDefault();
    setMode(driver.mode); // 重播
  }
});

// ---- 章节滑块(规格 §8.4;视觉规格 §6 ②的缺失项,本轮落实) ----
// 150ms 防抖 + **松手触发**(拖动中不出章);跳跃式切换 = 全区间 delta
// **一次**转场(不逐章连播);首载直接渲染当前章(gate 初值,不经 release);
// 转场期间输入冻结(拖动会被弹回当前章)。张力读数走 §8.1 公式(见
// transition-fixture.ts),证明分支判定不是拍的。
{
  const slider = document.getElementById(
    "chapter-slider",
  ) as HTMLInputElement | null;
  const readout = document.getElementById("chapter-readout");
  if (slider) {
    const gate = new SliderGate(FIXTURE_FIRST_CHAPTER);
    slider.value = String(FIXTURE_FIRST_CHAPTER);
    let gateTimer: number | null = null;
    const transitioning = (): boolean =>
      driver.mode === 9 && driver.t < TRANSITION.duration;
    const tryRelease = (): void => {
      const from = gate.current;
      const r = gate.release(performance.now());
      if (r.action === "wait") {
        // 防抖窗口未过:轮询到点再放行(快速甩动 = 最后一次 input 生效)
        if (gateTimer === null) {
          gateTimer = window.setTimeout(() => {
            gateTimer = null;
            tryRelease();
          }, 60);
        }
        return;
      }
      if (r.action === "fire") {
        transReadout = transitionReadout(from, r.chapter);
        setMode(9);
      }
    };
    slider.addEventListener("input", () => {
      if (transitioning()) {
        slider.value = String(gate.current); // §8.4:转场期输入冻结
        return;
      }
      gate.input(Number(slider.value), performance.now());
      if (readout) {
        readout.textContent = `章节 ${gate.current} → ${slider.value}(松手触发)`;
      }
    });
    slider.addEventListener("pointerup", tryRelease); // 松手触发(主路径)
    slider.addEventListener("change", tryRelease); // 键盘/自动化兜底(change 亦在松手后)
  }
}

// ---- 取帧:同步预滚(不依赖墙钟) ----
let spawned = false;
let prerolled = false;

/** viewer 的调试探针(`__gray`;取帧时用来手动同步/读数) */
type GrayProbe = {
  pointerDist?: number;
  sync?: () => void;
  screenOf?: (i: number, lift?: number) => [number, number, number];
  /** 交互控制器(转场期输入冻结用:置 freezeLeft,§8.4) */
  controller?: { freezeLeft: number };
};
function grayProbe(): GrayProbe | undefined {
  return (window as unknown as { __gray?: GrayProbe }).__gray;
}

/** 探针叠字(取帧可读):证明「鼠标真的驱动了揭示度」而不是自己动。 */
function updateProbe(): void {
  if (!probe || !captionNode) return;
  const g = grayProbe();
  const dist = g?.pointerDist ?? Number.POSITIVE_INFINITY;
  const tgt = Number.isFinite(dist) ? revealTarget(dist) : 0;
  // ⚠ 这里的行要短:说明框是 white-space:pre + translateX(-50%),行一长就比视口
  //   还宽、左边被裁掉(实测读数被切)。取帧时要保证整行可见。
  captionNode.textContent =
    `${FX_CAPTION[driver.mode] ?? ""}\n` +
    `[probe] dist=${Number.isFinite(dist) ? dist.toFixed(4) : "inf"}` +
    ` tgt=${tgt.toFixed(2)} reveal=${driver.reveal.toFixed(2)}`;
  captionNode.style.display = "block";
}

/** 死亡退场的收尾:溶解完成 → 把液滴**真的**从引擎删掉。
 *  只把网格 dissolve 掉是不够的 —— 它仍留在 uDropPos/uDropRad 里,水底软影
 *  与液滴焦散会留在原位(委托方实测:「液滴消失了,但投射在水底的光影未消失」)。
 *  ⚠ **不要用一次性标志位**:标志位一旦置位就再不重试,重播 / 切模式会让它
 *    卡在「网格没了但光影还在」的状态。这里改成幂等判断:索引越界就什么都不做。 */
function settleDeath(e: WaterEngine): void {
  if (driver.mode !== 7 || driver.t < DEATH.dissolve[1]) return;
  e.removeDroplet(HERO);
}

/**
 * 大转折的引擎侧收尾(阈值幂等;活播与取帧预滚走**同一条路**):
 *   溃散末:旧章环滴**逐颗**退场(渲染上已溶解干净,但水底软影/焦散吃的是
 *           **引擎半径**,渲染侧 dissolve 藏不掉它——不删就会「滴没了、影子还在」,
 *           死亡退场同一教训)。阈值 = 溃散末 + 余量(driver.transRemoveAt);
 *   爆散点:新章液滴入队(下一固定步生效,槽位 = NEW_NET,物理自然落定),
 *           角色表同步重建 —— 火花归位时真滴已在槽位等它(dissolve 物质化交接);
 *   爆散末:核心滴(巨滴)退场。⚠ removeDroplet(0) 是交换删除:**末位新滴**
 *           会搬到索引 0,角色表必须按同规则重排,否则错峰次序错乱。
 * ⚠ 环滴删除必须**从最高索引往低**且顺序进行:交换删除会搬动末位,降序删除时
 *   被删者恒为末位 → 索引 0..k 全程稳定,溃散排期(按索引)才成立。
 */
let transSpawned = false;
function transitionSettle(e: WaterEngine): void {
  if (driver.mode !== 9) return;
  const t = driver.t;
  const count = e.droplets.state.count;
  if (!transSpawned) {
    for (let i = count - 1; i >= 1; i--) {
      if (roles[i] !== ROLE_T_OLD) break; // 上面只剩核心滴(索引 0)即停
      if (t < driver.transRemoveAt(i)) break; // 未到点(降序:上面的没删完不删下面)
      e.removeDroplet(i);
      roles.pop(); // 被删者恒为末位
    }
    if (t < TRANSITION.burst[0]) return;
    transSpawned = true;
    for (const p of NEW_NET) {
      e.spawnDroplet(
        p.x,
        p.y,
        e.field.totalHeight(p.x, p.y) + params.dropHeight + p.r,
        p.r,
      );
    }
    roles = [ROLE_T_CORE, ...NEW_NET.map((_, k) => ROLE_T_NEW + k)];
    return;
  }
  if (
    t >= TRANSITION.burst[1] &&
    roles.length > 0 &&
    roles[0] === ROLE_T_CORE &&
    e.droplets.state.count > 0
  ) {
    e.removeDroplet(0);
    // 交换删除重排:末位元素搬到 0,其余相对次序不变
    roles =
      roles.length > 1
        ? [roles[roles.length - 1]!, ...roles.slice(1, -1)]
        : [];
  }
}

function tick(e: WaterEngine): void {
  // 每帧调:内部按「是否跨越聚焦边界」判断,没变就早返回。放在最前,保证
  // shot 模式的预滚跑在**已经建好的场景**上。
  ensureScene(e, driver.mode);
  settleDeath(e);
  transitionSettle(e);
  suppressAbsentBridges(e);
  syncLabels();
  placeLabels();
  if (probe) updateProbe();
  if (!shotMode || prerolled) return;
  // 同步把仿真推到稳态:落滴 → 落定 → 成桥 → 水面静稳。
  // engine.advance 内部有 maxSubsteps 钳制(防螺旋死亡),故逐帧调用而非一次大 dt。
  const steps = qPt !== null && Number.isFinite(qPt) ? Math.max(0, Math.floor(qPt)) : PREROLL_STEPS;
  for (let i = 0; i < steps; i++) e.advance(1 / 60);
  if (Number.isFinite(qT)) driver.t = qT;
  if (qReveal !== null) driver.reveal = qReveal;
  // ⚠ 顺序要紧:先让 viewer 同步一次(填主角滴坐标缓存),**再**执行退场删除。
  //    反过来则删除发生在本帧 syncFog 之前 → 残雾因「没有主角滴」整团消失
  //    (§4.2 要求「原位留下一团短暂的雾气」,雾必须比液滴活得久)。
  grayProbe()?.sync?.();
  settleDeath(e); // 置 t 之后再判一次(上面的调用发生在 t 还是 0 的时候)
  transitionSettle(e); // 同上:大转折的删除/生成也要在置 t 后补判一次
  // 大转折:爆散点已过 → 新章液滴已入队,再推一段仿真让它们**真的落定成桥**
  // (drainTime 0.08s 很快,但落滴溅起的水波要平;定格帧才有完整的网)。
  if (driver.mode === 9 && driver.t >= TRANSITION.burst[0]) {
    for (let i = 0; i < 150; i++) e.advance(1 / 60);
    transitionSettle(e); // 落定后补判:核心滴退场(爆散末阈值在推进一步后才到)
  }
  grayProbe()?.sync?.(); // 再同步一次:补删/生成之后的液滴、桥、雾、火花
  // 空场自检:建场逻辑一旦被早返回吃掉,画面会是一张空水——取帧时才看得出来。
  // 曾经真的踩过(ensureScene 首次调用被早返回),故这里留一个响亮的信号。
  if (e.droplets.state.count === 0) {
    console.error("[fxspike] 场景为空:液滴数为 0 —— 检查 ensureScene 是否被早返回吃掉");
  }
  // 探针模式:shot 会冻结驱动器,reveal 就永远停在 0 —— 先按注入的指针把
  // 揭示度同步推到稳态(4 秒驱动器时间),再冻。
  if (probe) {
    const g = (window as unknown as {
      __gray?: { pointerDist?: number; sync?: () => void };
    }).__gray;
    g?.sync?.(); // 先按注入的指针把距离算出来(hooks.tick 跑在 syncBridges 之前)
    const dist = g?.pointerDist ?? Number.POSITIVE_INFINITY;
    driver.frozen = false;
    for (let i = 0; i < 240; i++) driver.update(1 / 60, dist);
  }
  // 取帧冻结前的**补摆**:本次 tick 开头那次 placeLabels 跑在 t=0、相机矩阵
  // 未就绪之时(灰滴标签 alpha=0),而暂停后 hooks.tick 不再进来 —— 必须按
  // 最终 t 与上面 sync() 好的相机矩阵重摆一次,标签才与画面一致(实测踩到)。
  syncLabels();
  placeLabels();
  driver.frozen = true;
  // 冻结仿真:uTime = engine.stats.simTime,若继续推进则噪声图案逐帧变化 →
  // 每次截图抓到的是不同瞬间、不可复现。暂停后 sync+render 仍在跑(它们在
  // viewer tick 的 if(render) 分支里,与 paused 无关),故画面照常渲染。
  document.getElementById("gray-btn-pause")?.click();
  updateCaption();
  updateProbe(); // 必须在 updateCaption 之后(它会覆盖说明文字)
  prerolled = true;
}

// ---- 挂载(挂完后 __gray 立即可用:mountViewer 末尾同步赋值) ----
const app = document.getElementById("app");
if (app) {
  captionNode = document.getElementById("fx-caption");
  buildButtons();
  mountLuxViewer(app, params, {
    disablePokes: true,
    tick,
    caption: () => null,
  });
  setFxSource(source);
  // 文字叠层:排在 canvas 之后(HUD 是 #app 的后续兄弟,天然更靠上)
  labels = new LabelLayer(app);
  // 深夜换墨色(委托方:文字与画面风格一致 + 清晰):深夜水面近黑、液滴是
  // 大亮球,日间墨青字读不出。挂完时段参数后立刻判一次,再监听后续切换
  // (viewer 自己的监听先绑先跑,这里读到的类状态总是新的)。
  const updateLabelTint = (): void => {
    labels?.setNight(
      document.getElementById("lux-btn-night")?.classList.contains("lux-active") === true,
    );
  };
  for (const id of ["dawn", "noon", "dusk", "night"]) {
    document.getElementById(`lux-btn-${id}`)?.addEventListener("click", updateLabelTint);
  }
  // 粗细覆写要在首次 syncBridges 前生效;setMode→reset 不会清它(粗细不属于状态)
  if (qThick !== null && Number.isFinite(qThick)) driver.thick = qThick;

  // 近景机位(默认机位是全场俯瞰,看不清单条桥的细节)
  const g = (window as unknown as { __gray?: Record<string, unknown> }).__gray;
  if (g) {
    const cam = g.camera as { position: { set(x: number, y: number, z: number): void } };
    const tgt = g.camTarget as { set(x: number, y: number, z: number): void };
    const dist = Number(q.get("cam") ?? "0.42");
    // tx = 镜头横向对准位置:近景特写时对准主角滴(渲染系 x = DROP_B.x − 0.5 = 0.12)
    const tx = Number(q.get("tx") ?? "0");
    cam.position.set(tx, dist * 0.82, dist);
    tgt.set(tx, 0, 0);
  }
  setMode(Number.isFinite(qFx) ? qFx : 0);

  // 合成指针:验证「潜流受鼠标控制」用(headless 没有真鼠标)。
  // 事件派发在 canvas 上(监听器挂在 renderer.domElement,见 viewer.ts)。
  if (qPx !== null && qPy !== null) {
    const cv = document.querySelector("canvas");
    cv?.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: qPx,
        clientY: qPy,
        bubbles: true,
      }),
    );
    // ?pleave=1:紧接着让指针离开画布 —— 验证「离开后必须回落,不能冻结在最后一个
    // 距离上」(原实现被 pointerValid 整个门掉,桥会永远停在浮现态)。
    if (q.get("pleave") === "1") {
      cv?.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
    }
  }

  // 时段(viewer 的 lux 装配块会按 id 绑定时段按钮,故这里点一下即可)
  const tod = q.get("tod");
  if (tod) document.getElementById(`lux-btn-${tod}`)?.click();
  updateLabelTint(); // ?tod= 的点击已触发监听,这里兜底显式判一次
}
