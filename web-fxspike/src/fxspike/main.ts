// ============================================================
// B 组效果验证页(一次性;建在 web/ 的副本 web-fxspike 上,生产源码零改动)
//
// 七效果:1 融合 · 2 拉扯 · 3 对撞 · 4 暗流 · 5 潜流 · 6 凝结 · 7 死亡 · 8 聚焦 · 0 关
//
// 场景:固定两滴 + 一条液桥(效果作用对象单一,便于判定「做没做到」)。
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
} from "./fxdriver";
import { LabelLayer, labelAlpha, type LabelSpec } from "./labels";

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
    "文字叠层(HTML):在场 → 名字;已退场 → 关系说明;未出场 → 「未知关系」且滴中无名字。\n" +
    "⚠ 半透明水柱仍按委托方裁决未做。",
];

function setupScene(e: WaterEngine, focus: boolean): void {
  roles = [];
  absentSet.fill(0);
  const spawn = (x: number, y: number, r: number, role: number): void => {
    const surf = e.field.totalHeight(x, y);
    if (!e.spawnDroplet(x, y, surf + r + params.dropHeight, r)) return;
    // spawnDroplet 是「下一固定步生效」的入队,滴号 = 生成次序(无合并/删除时成立)
    roles.push(role);
    if (role >= ROLE_ABSENT) absentSet[roles.length - 1] = 1;
  };
  if (focus) {
    spawn(FOCUS_CENTER.x, FOCUS_CENTER.y, FOCUS_CENTER.r, ROLE_PRESENT);
    for (const p of FOCUS_PRESENT) spawn(p.x, p.y, p.r, ROLE_NORMAL);
    FOCUS_ABSENT.forEach((p, i) => spawn(p.x, p.y, p.r, ROLE_ABSENT + i));
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

/** 逐帧摆放:投影液滴**渲染位**(灰滴带 lift 下沉量),灰滴标签随浮现渐显 */
function placeLabels(): void {
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
    if (s) labels?.place(String(i), s[0]!, s[1]!, alpha);
  }
}

/** 场景随模式切换:聚焦(8)用聚焦场景,其余用两滴一桥。切换时清场重建。 */
let sceneMode = -1;
/** 本场景应有多少滴(setupScene 入队后即定) */
let sceneExpect = 0;
/** 请求重建(进入「死亡」时置位):死亡会把主角滴**真的删掉**,不补回来
 *  重播就没得演了。只在真的缺滴时才重建,场景完好时不打扰。 */
let sceneResetRequest = false;
function ensureScene(e: WaterEngine, mode: number): void {
  const wantFocus = mode === 8;
  const first = sceneMode === -1; // ⚠ 首次必须建场,不能被下面的早返回吃掉
  const boundaryChanged = !first && wantFocus !== (sceneMode === 8);
  const requested = sceneResetRequest;
  sceneResetRequest = false;
  const depleted = requested && !first && e.droplets.state.count < sceneExpect;
  if (!first && !boundaryChanged && !depleted) return;
  if (!first) {
    while (e.droplets.state.count > 0) e.removeDroplet(e.droplets.state.count - 1);
  }
  sceneMode = mode;
  setupScene(e, wantFocus);
  sceneExpect = roles.length;
}

/** 效果驱动源适配:把 viewer 的通用接口接到本页的 FxDriver */
const source: FxSource = {
  bridgeKind: () => driver.bridgeKind(),
  bridgeFx: (seed) => driver.bridgeFx(seed),
  bridgeGrow: () => driver.bridgeGrow(),
  dropletFx: (i) => driver.dropletFx(roles[i] ?? ROLE_NORMAL),
  fogCue: (i, cx, cy) => driver.fogCue(i, cx, cy),
  // 颈径屏幕空间下限**常开**(不只是「拉扯」)。
  // 原因(实测):本机位下基线自身的桥颈径就 <2px,径向明暗带合并、只剩亮边剪影,
  // 桥读成「一片带亮边的扁平透镜」而不是管子 —— 亚像素问题影响的是所有模式。
  // 验证页的目的是验效果、不是重审基线,故统一抬到可读下限,让比较公平。
  neckFloorOn: () => true,
  bridgeThick: (seed) => driver.bridgeThick(seed),
  update: (dt, dist) => driver.update(dt, dist),
};

function setMode(mode: number): void {
  driver.reset(mode);
  driver.frozen = shotMode;
  // 死亡会把主角滴删掉 —— 再进这个模式得先把它补回来,否则没得演
  if (mode === 7) sceneResetRequest = true;
  updateCaption();
  for (const btn of fxBtns) {
    btn.classList.toggle("lux-active", Number(btn.dataset.fx) === mode);
  }
}

let captionNode: HTMLElement | null = null;
function updateCaption(): void {
  if (!captionNode) return;
  let text = FX_CAPTION[driver.mode] ?? "";
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

// ---- 取帧:同步预滚(不依赖墙钟) ----
let spawned = false;
let prerolled = false;

/** viewer 的调试探针(`__gray`;取帧时用来手动同步/读数) */
type GrayProbe = {
  pointerDist?: number;
  sync?: () => void;
  screenOf?: (i: number, lift?: number) => [number, number, number];
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

function tick(e: WaterEngine): void {
  // 每帧调:内部按「是否跨越聚焦边界」判断,没变就早返回。放在最前,保证
  // shot 模式的预滚跑在**已经建好的场景**上。
  ensureScene(e, driver.mode);
  settleDeath(e);
  suppressAbsentBridges(e);
  syncLabels();
  placeLabels();
  if (probe) updateProbe();
  if (!shotMode || prerolled) return;
  // 同步把仿真推到稳态:落滴 → 落定 → 成桥 → 水面静稳。
  // engine.advance 内部有 maxSubsteps 钳制(防螺旋死亡),故逐帧调用而非一次大 dt。
  for (let i = 0; i < PREROLL_STEPS; i++) e.advance(1 / 60);
  if (Number.isFinite(qT)) driver.t = qT;
  if (qReveal !== null) driver.reveal = qReveal;
  // ⚠ 顺序要紧:先让 viewer 同步一次(填主角滴坐标缓存),**再**执行退场删除。
  //    反过来则删除发生在本帧 syncFog 之前 → 残雾因「没有主角滴」整团消失
  //    (§4.2 要求「原位留下一团短暂的雾气」,雾必须比液滴活得久)。
  grayProbe()?.sync?.();
  settleDeath(e); // 置 t 之后再判一次(上面的调用发生在 t 还是 0 的时候)
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
}
