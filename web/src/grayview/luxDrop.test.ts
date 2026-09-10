// ============================================================
// 液滴可视性与液桥融合 GLSL/参数冒烟(2026-09-10 第十一批;three-free 字符串断言
// + viewer 桥形常量导入)。方案与引用:docs/液滴可视性与液桥融合设计方案-2026-09-10.md
// 委托方五任务:
// ①白天三时段液滴 = 实例.png 珍珠乳白小球(奶白体/蓝核/亮部高光/接触亮环/不透明感),
//   修复清晨/正午隐形(旧 alpha 0.15-0.7 透明水公式是根因);
// ②液桥尖端伸入液滴内部 + 融合倒角(半径在表面交点处恰升满,切线连续)+
//   aFade 隐藏滴内段(lux 无深度写入也无缝);
// ③深夜液滴发光小球(暖黄 HDR 自发光 > bloom 阈值出光晕)+ 液桥暖黄边界线(rim);
// ④液滴透镜放大扭曲水底光纹(滴心基准 + 等效光程,GPU Gems 2 ch.19);
// ⑤傍晚水底米白偏米(DUSK.bottomAlbedo)。
// 引用:GPU Gems 2《Generic Refraction Simulation》/ three.js 阈值式 bloom+
// HDR 自发光 / BlobTree fillet(SMI 2010)/ 原型 index-wave.html LENS_DEPTH。
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LUX_BOTTOM_FRAG,
  LUX_BRIDGE_FRAG,
  LUX_BRIDGE_VERT,
  LUX_DROPLET_FRAG,
  LUX_DROPLET_VERT,
} from "./luxShaders";
import { LIGHTING_PRESETS } from "../lighting/presets";
import {
  BRIDGE_BLEND_EXTEND,
  BRIDGE_END_FRAC,
  BRIDGE_FADE_START,
  BRIDGE_NECK_FRAC,
  BRIDGE_TIP_DEEP,
  BRIDGE_TIP_SURF,
} from "./viewer";

/** 从着色器字符串截取 main() 函数体(COMMON_HELPERS 注入会使全文含同名定义) */
const mainBody = (shader: string): string =>
  shader.slice(shader.lastIndexOf("void main()"));

describe("任务① 白天珍珠乳白液滴(实例.png)", () => {
  it("奶白体:基色 × uTint 时段化(uTintAmt 参与混合),受光调制", () => {
    const drop = mainBody(LUX_DROPLET_FRAG);
    expect(drop).toContain("milkBase");
    expect(drop).toContain("uTint * 1.25");
    expect(drop).toContain("uTintAmt * 0.45");
    expect(drop).toContain("0.55 + 0.45 * ndl");
  });

  it("珍珠不透明感:alpha = mix(0.66, 0.94, F),旧隐形透明式已移除", () => {
    const drop = mainBody(LUX_DROPLET_FRAG);
    expect(drop).toContain("mix(0.66, 0.94, F)");
    expect(drop).not.toContain("mix(0.15, 0.7, F)");
  });

  it("亮部高光:锐 GGX + 宽域柔光;Fresnel 边缘环境反射保留", () => {
    const drop = mainBody(LUX_DROPLET_FRAG);
    expect(drop).toContain("ggxSpec(n, v, uSunDir, 0.14) * uGlint * 0.9");
    expect(drop).toContain("pow(ndl, 8.0) * 0.10");
    expect(drop).toContain("skyColor(reflect(-v, n))");
  });

  it("接触亮环(滴内):vLocalY 底缘环带 + 水面接触环带 dropRingGlow 三消费面共享", () => {
    expect(mainBody(LUX_DROPLET_FRAG)).toContain(
      "smoothstep(0.28, 0.03, vLocalY)",
    );
    expect(LUX_DROPLET_VERT).toContain("vLocalY = position.y");
    expect(LUX_BOTTOM_FRAG).toContain("vec3 dropRingGlow(vec2 wxz)");
    expect(LUX_BOTTOM_FRAG).toContain("col += dropRingGlow(wxz)");
    expect(mainBody(LUX_BOTTOM_FRAG)).not.toContain("dropRingGlow(vec2 wxz)"); // 定义在 helpers,消费面只调用
  });

  it("液滴透镜变长已删除(旧池底直视采样)", () => {
    expect(mainBody(LUX_DROPLET_FRAG)).not.toContain("uPoolDepth / max(-rd.y, 0.25)");
  });
});

describe("任务④ 液滴透镜放大扭曲水底光纹", () => {
  it("滴心基准 + 等效光程(CAUSTIC_LENS_MAG)采样 shadeBottom(同一张网)", () => {
    const drop = mainBody(LUX_DROPLET_FRAG);
    expect(LUX_DROPLET_FRAG).toContain("#define CAUSTIC_LENS_MAG 3.2");
    expect(drop).toContain("float lensPath = max(vR, 1e-4) * CAUSTIC_LENS_MAG");
    expect(drop).toContain("vec2 bpos = vCenter + rd.xz * (lensPath / max(-rd.y, 0.3))");
    expect(drop).toContain("shadeBottom(bpos)"); // 与 luxCaustic 守护一致:同一张网
    expect(drop).not.toContain("buv");
  });

  it("顶点提供 vCenter(滴心 xz)与 vR(实例半径)", () => {
    expect(LUX_DROPLET_VERT).toContain(
      "vCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz",
    );
    expect(LUX_DROPLET_VERT).toContain("vR = length(instanceMatrix[0].xyz)");
  });

  it("透镜聚光提亮(光纹过滴更亮)+ 蓝核配比(奶白为壳 0.45)", () => {
    expect(mainBody(LUX_DROPLET_FRAG)).toContain("shadeBottom(bpos) * 1.35");
    expect(mainBody(LUX_DROPLET_FRAG)).toContain("mix(lensCol, milk, 0.45)");
  });
});

describe("任务③ 深夜发光小球 + 液桥暖黄边界线", () => {
  it("液滴:uNightDots 分支 → 暖黄 HDR 自发光(> bloom 阈值出光晕),早退让位日间材质", () => {
    const drop = mainBody(LUX_DROPLET_FRAG);
    expect(drop).toContain("if (uNightDots > 0.5)");
    expect(drop).toContain("vec3(1.0, 0.70, 0.30) * (1.9 * core)");
    expect(drop).toContain("pow(1.0 - nov, 2.0)");
    expect(drop.indexOf("if (uNightDots > 0.5)")).toBeLessThan(
      drop.indexOf("milkBase"),
    ); // 夜晚分支先于日间材质
  });

  it("液桥:uNightDots 分支 → 暖黄 rim 边界亮线(委托方「暖黄色边界线」)", () => {
    const bridge = mainBody(LUX_BRIDGE_FRAG);
    expect(bridge).toContain("if (uNightDots > 0.5)");
    expect(bridge).toContain("vec3(1.0, 0.72, 0.32) * (0.42 + 1.75 * rim)");
    expect(bridge).toContain("pow(1.0 - nov, 2.2)");
    expect(bridge).toContain("mix(0.38, 0.92, rim) * vFade");
  });
});

describe("任务② 液桥伸入液滴 + 曲面化融合(第十一批整改:两端放大/深入/圆滑过渡)", () => {
  it("桥形常量:尖端深入(TIP_DEEP)、端径漏斗放大、倒角越过表面完成(圆滑过渡)", () => {
    expect(BRIDGE_TIP_SURF).toBeCloseTo(0.866, 3); // 半球面与轴高解析交点(√3/2)
    expect(BRIDGE_TIP_DEEP).toBeLessThan(BRIDGE_TIP_SURF);
    expect(BRIDGE_TIP_DEEP).toBeGreaterThanOrEqual(0.4); // 深入液滴内部
    // 滴内段完全隐藏(委托方二次整改):aFade 起升点 ≥0.7,滴内前 70% 全透明
    expect(BRIDGE_FADE_START).toBeGreaterThanOrEqual(0.7);
    expect(BRIDGE_FADE_START).toBeLessThan(1);
    // 两端适当放大(委托方第十一批整改):端径 ≥0.2r(非细杆)、≥3×颈径(漏斗形)
    expect(BRIDGE_END_FRAC).toBeGreaterThanOrEqual(0.2);
    expect(BRIDGE_END_FRAC).toBeLessThan(BRIDGE_TIP_SURF); // 仍远窄于半球直径
    expect(BRIDGE_END_FRAC).toBeGreaterThanOrEqual(3 * BRIDGE_NECK_FRAC);
    // 接触面圆滑过渡:倒角完成点越过表面交点(>1)但不越过 2 倍
    expect(BRIDGE_BLEND_EXTEND).toBeGreaterThan(1);
    expect(BRIDGE_BLEND_EXTEND).toBeLessThanOrEqual(2);
  });

  it("桥 shader 接入 aFade(出场边缘软化),倒角在表面交点完成", () => {
    expect(LUX_BRIDGE_VERT).toContain("attribute float aFade");
    expect(LUX_BRIDGE_VERT).toContain("vFade = aFade");
    expect(mainBody(LUX_BRIDGE_FRAG)).toContain("* vFade");
  });

  it("液滴写深度 = 滴内/滴后桥段真实遮挡(委托方二次整改「隐藏内部段」主遮挡)", () => {
    const src = readFileSync(fileURLToPath(new URL("./viewer.ts", import.meta.url)), "utf8");
    expect(src).toContain("depthWrite: true, // 珍珠近不透明");
  });

  it("悬浮态视觉抖动修复:渲染底面 = 物理平滑 z−r,不再直用原始场高 totalHeight", () => {
    // 委托方第十一批反馈:鼠标移到液滴上、液滴悬浮时异常抖动。根因 = 悬停涟漪泵
    // 在滴下激起 ±9mm@~10Hz 纹波,渲染层 lensBottomY 直用原始场高逐帧跟随;
    // 物理层第四批 zFollow 已平滑 d.z,渲染层必须同源(源码级守护)。
    const src = readFileSync(fileURLToPath(new URL("./viewer.ts", import.meta.url)), "utf8");
    expect(src).toContain("return d.z[i]! - d.r[i]! + amb;"); // 平滑水面(浮态分支)
    expect(src).not.toContain("const h = engine.field.totalHeight(d.x[i]!, d.y[i]!);");
  });
});

describe("任务⑤ 傍晚水底米白偏米", () => {
  it("DUSK.bottomAlbedo = 米白(r>g>b,高亮度);其余时段水底不动", () => {
    const dusk = LIGHTING_PRESETS.dusk;
    const [r, g, b] = dusk.bottomAlbedo;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(r).toBeGreaterThanOrEqual(0.85);
    expect(b).toBeGreaterThanOrEqual(0.6); // 米白不是纯白(偏米色)
    // 夜晚深蓝水底(第九批裁决)与清晨/正午不被波及
    expect(Math.max(...LIGHTING_PRESETS.night.bottomAlbedo)).toBeLessThan(0.2);
    expect(LIGHTING_PRESETS.dawn.bottomAlbedo).not.toEqual(dusk.bottomAlbedo);
  });

  it("正午水面 tintAmt 加深一档(委托方许可改水面色,增强液滴对比)", () => {
    expect(LIGHTING_PRESETS.noon.surfaceTintAmt).toBeCloseTo(0.68, 5);
    expect(LIGHTING_PRESETS.noon.surfaceTintAmt).toBeLessThanOrEqual(1);
  });
});
