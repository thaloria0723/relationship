// ============================================================
// 水底动态焦散网 GLSL 冒烟(2026-09-09 第十批 v4;three-free 字符串断言)
// 方案与引用:docs/水底光纹焦散网设计方案-2026-09-09.md
// **现行实现 = 原型 index-wave.html「迭代折射焦散 + 去平铺三件套」原样移植**
// (委托方提供实例.png(原型已验收观感)并裁决:此前替代策略——v2 双层异向叠加、
// v3 哈希格点 Voronoi、v3.1 蜿蜒谱——均无法达成预期,全部废弃;原型框架与本项目
// 完全一致,按原型移植)。
// 守护:
// - 焦散核 = Hoskins 迭代折射(5 迭代域扭曲累积 + pow 11 细丝锐化,底数 abs 先行);
// - 去平铺三件套 = warpP 域扭曲 + 双大偏移副本(30° 旋转)慢变遮罩 mix + seed 独立
//   反向漂移 + 斑驳 patch(委托方认可的消除重复单元正解);
// - 组合 = additive 单层 clamp 防过曝,加光走 uSunColor 时段色;
// - 时段语义 = 日间按 causticScale 出网,深夜被 uNightDots 关断(第九批:荧光海岸独占);
// - 旧实现(∇²h 拉普拉斯光纹)与历次替代策略(v1 独有常量/v2 双层/v3 Voronoi/
//   v3.1 蜿蜒谱)确认移除,防复活。
// ============================================================

import { describe, expect, it } from "vitest";
import {
  LUX_BOTTOM_FRAG,
  LUX_DROPLET_FRAG,
  LUX_SURFACE_FRAG,
} from "./luxShaders";

/** 从着色器字符串截取 main() 函数体(COMMON_HELPERS 注入会使全文含同名定义) */
const mainBody = (shader: string): string =>
  shader.slice(shader.lastIndexOf("void main()"));

describe("动态焦散网 v4 · 焦散核(原型 index-wave.html 迭代折射,原样移植)", () => {
  it("causticWeb 定义存在并注明引用出处(Hoskins MdlXz8 + 原型)", () => {
    expect(LUX_BOTTOM_FRAG).toContain("float causticWeb(vec2 uv, float t)");
    expect(LUX_BOTTOM_FRAG).toContain("MdlXz8");
    expect(LUX_BOTTOM_FRAG).toContain("index-wave"); // 原型出处注明
  });

  it("迭代折射核:mod+(-250) 数值区间 + 5 迭代累积 + pow 11 细丝锐化", () => {
    expect(LUX_BOTTOM_FRAG).toContain(
      "mod(uv * 6.28318530718, 6.28318530718) - 250.0",
    ); // 本技法数值区间的必要部分,不可省
    expect(LUX_BOTTOM_FRAG).toContain("for (int n = 0; n < 5; n++)");
    expect(LUX_BOTTOM_FRAG).toContain("float shaped = 1.17 - pow(c, 1.4)");
    expect(LUX_BOTTOM_FRAG).toContain(
      "clamp(pow(abs(shaped), 11.0), 0.0, 1.0)",
    ); // 细丝锐化,底数 abs 先行
  });
});

describe("动态焦散网 v4 · 去平铺三件套(消除重复单元的正解,原型已验收)", () => {
  it("①域扭曲 warpP:慢变大尺度摆动,瓷砖直边揉成水波曲线", () => {
    expect(LUX_BOTTOM_FRAG).toContain("vec2 warpP(vec2 p, float t)");
    expect(LUX_BOTTOM_FRAG).toContain("CAUSTIC_WARP * vec2(");
  });

  it("②双采样融合:两个大偏移副本(一旋转 30°)用慢变遮罩 mix,接缝互相遮盖", () => {
    expect(LUX_BOTTOM_FRAG).toContain("float aperiodicWeb(vec2 p, float t, float seed)");
    expect(LUX_BOTTOM_FRAG).toContain(
      "const mat2 CAUSTIC_ROT = mat2(0.866, 0.5, -0.5, 0.866)",
    ); // 30°:次副本换个方向
    expect(LUX_BOTTOM_FRAG).toContain(
      "causticWeb(CAUSTIC_ROT * (q + vec2(37.2, 11.7)), t + seed + 11.3)",
    ); // 大偏移副本
    expect(LUX_BOTTOM_FRAG).toContain(
      "0.5 + 0.5 * sin(p.x * 1.1 + p.y * 0.8 + seed)",
    ); // 慢变遮罩
    expect(LUX_BOTTOM_FRAG).toContain("return mix(w1, w2, m)");
  });

  it("③主/次层 seed 独立、反向慢漂 + 斑驳 patch(局部涟漪隐没)", () => {
    expect(LUX_BOTTOM_FRAG).toContain(
      "aperiodicWeb(wp * CAUSTIC_SCALE, uTime * CAUSTIC_SPEED, 0.0)",
    );
    expect(LUX_BOTTOM_FRAG).toContain(
      "aperiodicWeb(wp * CAUSTIC_SCALE2 + 13.0,",
    );
    expect(LUX_BOTTOM_FRAG).toContain(
      "-uTime * CAUSTIC_SPEED * 0.7 + 7.0, 5.0",
    ); // 反向慢漂 + 独立 seed
    expect(LUX_BOTTOM_FRAG).toContain("1.0 - CAUSTIC_PATCH * (0.5 + 0.5");
  });

  it("组合 = additive 单层 clamp 防过曝,加光走 uSunColor 时段色", () => {
    expect(LUX_BOTTOM_FRAG).toContain(
      "min(web * CAUSTIC_AMP, CAUSTIC_CLAMP)",
    );
    expect(LUX_BOTTOM_FRAG).toContain(
      "min(web2 * CAUSTIC_AMP2, CAUSTIC_CLAMP * 0.6)",
    );
    expect(LUX_BOTTOM_FRAG).toContain("col += uSunColor * ca");
  });
});

describe("动态焦散网 · 时段语义与三消费面", () => {
  it("时段语义:夜间关断(gate=×(1−uNightDots)),日间强度 = uCausticScale,液滴影吃光", () => {
    expect(LUX_BOTTOM_FRAG).toContain(
      "float gate = uCausticScale * (1.0 - uNightDots) * shadow",
    );
    expect(LUX_BOTTOM_FRAG).toContain("col += uSunColor * ca");
  });

  it("水底直视:主函数走 applyCausticWeb,不再调 waterDerivs 算光纹", () => {
    const bottom = mainBody(LUX_BOTTOM_FRAG);
    expect(bottom).toContain("applyCausticWeb(col, wxz, shadow)");
    expect(bottom).toContain("nightCoast(wxz, col)"); // 深夜荧光海岸不动(第九批)
    expect(bottom).not.toContain("waterDerivs");
    expect(bottom).not.toContain("uvh");
  });

  it("水面折射视图:shadeBottom 收窄为世界坐标单参签名", () => {
    const surface = mainBody(LUX_SURFACE_FRAG);
    expect(surface).toContain("shadeBottom(bpos)");
    expect(LUX_SURFACE_FRAG).toContain("vec3 shadeBottom(vec2 wxz)");
    expect(LUX_SURFACE_FRAG).not.toContain("shadeBottom(vec2 uv");
    expect(surface).not.toContain("buv"); // 旧高度纹理采样点已随 ∇²h 链路删除
  });

  it("液滴折射视图:同一 shadeBottom(透过水滴看同一张网)", () => {
    const drop = mainBody(LUX_DROPLET_FRAG);
    expect(drop).toContain("shadeBottom(bpos)");
    expect(drop).not.toContain("buv");
  });
});

describe("动态焦散网 · 常量调参入口有界(原型手感参数,全部集中在 defines)", () => {
  it("密度/速度/强度/上限/扭曲/斑驳有界", () => {
    const read = (name: string): number =>
      Number(LUX_BOTTOM_FRAG.match(new RegExp(`#define ${name} ([0-9.]+)`))![1]);
    expect(read("CAUSTIC_SCALE")).toBeGreaterThan(0);
    expect(read("CAUSTIC_SCALE")).toBeLessThanOrEqual(10); // 胞径 ≈ 1/SCALE 米
    expect(read("CAUSTIC_SCALE2")).toBeGreaterThan(0);
    expect(read("CAUSTIC_SCALE2")).toBeLessThanOrEqual(10);
    expect(read("CAUSTIC_SPEED")).toBeGreaterThan(0);
    expect(read("CAUSTIC_SPEED")).toBeLessThanOrEqual(2);
    for (const name of ["CAUSTIC_AMP", "CAUSTIC_AMP2", "CAUSTIC_CLAMP"]) {
      expect(read(name)).toBeGreaterThan(0);
      expect(read(name)).toBeLessThanOrEqual(1);
    }
    expect(read("CAUSTIC_WARP")).toBeGreaterThan(0);
    expect(read("CAUSTIC_WARP")).toBeLessThanOrEqual(2);
    expect(read("CAUSTIC_PATCH")).toBeGreaterThanOrEqual(0);
    expect(read("CAUSTIC_PATCH")).toBeLessThanOrEqual(1);
  });
});

describe("历次方案确删(防复活)", () => {
  it("旧 ∇²h 光纹:CAUSTIC_GAIN 宏与拉普拉斯焦散公式全部移除", () => {
    for (const shader of [LUX_BOTTOM_FRAG, LUX_SURFACE_FRAG, LUX_DROPLET_FRAG]) {
      expect(shader).not.toContain("CAUSTIC_GAIN");
      expect(shader).not.toContain("lap * uCausticScale");
      expect(shader).not.toContain("1.0 + max(ca, 0.0) * 2.0");
      expect(shader).not.toContain("1.0 + min(ca, 0.0)");
    }
  });

  it("v1 独有形态(网眼调制)与 v2/v3/v3.1 替代策略全部移除", () => {
    expect(LUX_BOTTOM_FRAG).not.toContain("CAUSTIC_TILE"); // v1 平铺周期(含 TILE_A)
    expect(LUX_BOTTOM_FRAG).not.toContain("CAUSTIC_MULT"); // v1 乘法路
    expect(LUX_BOTTOM_FRAG).not.toContain("CAUSTIC_GAP"); // v1 暗隙项
    expect(LUX_BOTTOM_FRAG).not.toContain("pow(abs(c), 8.0)"); // v1 提锐(现行 pow 11)
    expect(LUX_BOTTOM_FRAG).not.toContain("causticLayer"); // v2 双层单层场
    expect(LUX_BOTTOM_FRAG).not.toContain("causticMeander"); // v3.1 蜿蜒谱
    expect(LUX_BOTTOM_FRAG).not.toContain("CAUSTIC_CELL"); // v3 格点
    expect(LUX_BOTTOM_FRAG).not.toContain("CAUSTIC_TIME_SCALE"); // 时间倍率
    expect(LUX_BOTTOM_FRAG).not.toContain("mat2(0.4472"); // v2 旋向矩阵
  });
});
