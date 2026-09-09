// ============================================================
// 深夜生物荧光海岸 GLSL 冒烟(2026-09-09 第九批;three-free 字符串断言)
// 第九批:第八批「各向同性脊状 fbm 等值线」方案形态还原失败(碎花纹 ≠ 参考图
// docs/水底夜晚.jpg 中数条平行、横贯画面的蜿蜒海岸线),整体废弃重做。
// 守护:
// - 形态 = 沿岸基线束 + 沿线 1D 蜿蜒谱 → 长而不规则弯曲的连续边界线;
// - 动态 = 法向推进(波列相位沿法线匀速扫描 + 涌浪进退,fract 循环)+ 局部线宽
//   调制(收缩/扩张)+ 蜿蜒相位慢漂移(弯曲),结构稳定;辉光慢速非同步呼吸(幅度深);
// - 亮度 = 蓝白窄核心 + 指数辉光裙摆 + 宽域弱蓝晕;颗粒 = 随动坐标系散点
//   (光点随边界线一同运动)/近密近亮外渐弱/热点/极低速随机漂浮(无统一方向)
//   /随机生命周期/尺寸高幂偏置;
// - 旧实现(biolumRidge/nightBiolum/脊状等值线)确认移除;
// - 水面/液滴色调时段化(uTint)与上方雾气层(清晨)继续存在。
// ============================================================

import { describe, expect, it } from "vitest";
import {
  LUX_BOTTOM_FRAG,
  LUX_DROPLET_FRAG,
  LUX_MIST_FRAG,
  LUX_MIST_VERT,
  LUX_SURFACE_FRAG,
} from "./luxShaders";

describe("深夜生物荧光海岸 · 海岸形态(2026-09-09 第九批重做)", () => {
  it("水底路径接入 nightCoast,第八批 nightBiolum/biolumRidge 整体移除", () => {
    expect(LUX_BOTTOM_FRAG).toContain("vec3 nightCoast(");
    expect(LUX_BOTTOM_FRAG).toContain("nightCoast(wxz");
    expect(LUX_BOTTOM_FRAG).not.toContain("nightBiolum");
    expect(LUX_BOTTOM_FRAG).not.toContain("biolumRidge");
    expect(LUX_BOTTOM_FRAG).not.toContain("1.0 - abs(2.0 * n - 1.0)"); // 脊状等值线已废弃
  });

  it("海岸形态:波列束(5 条等相位间隔)+ 沿线 1D 蜿蜒谱(非各向同性噪声)", () => {
    expect(LUX_BOTTOM_FRAG).toContain("float coastDist(");
    expect(LUX_BOTTOM_FRAG).toContain("for (int i = 0; i < 5; i++)"); // 5 条波列
    expect(LUX_BOTTOM_FRAG).toContain("0.2 * k"); // 等相位间隔 → 等间距波列
    expect(LUX_BOTTOM_FRAG).toContain("0.052 * sin(p.x * 3.4"); // 宽弧大弯(λ≈1.85m)
    expect(LUX_BOTTOM_FRAG).toContain("0.030 * sin(p.x * 8.0"); // 主蜿蜒(λ≈0.79m)
    expect(LUX_BOTTOM_FRAG).toContain("0.005 * sin(p.x * 33.0"); // 细弯点缀
  });

  it("动态:法向推进(海浪向岸)+ 涌浪进退 + 局部线宽调制 + 法向修正(结构稳定)", () => {
    expect(LUX_BOTTOM_FRAG).toContain(
      "fract(0.1 + 0.2 * k + 0.016 * t + 0.04 * sin(t * 0.16 + k * 2.7))",
    ); // 法向推进 = 相位匀速前进 + 涌浪余弦进退,fract 循环
    expect(LUX_BOTTOM_FRAG).toContain("s * 1.3 - 0.65"); // 扫过全水域
    expect(LUX_BOTTOM_FRAG).toContain("width = 0.0045 * (1.0 + 0.35"); // 局部收缩/扩张
    expect(LUX_BOTTOM_FRAG).toContain("0.12 * t"); // 蜿蜒相位慢漂移 → 局部弯曲
    expect(LUX_BOTTOM_FRAG).toContain("sqrt(1.0 + slope * slope)"); // 线宽不随坡度变化
  });

  it("亮度:蓝白窄核心 + 指数辉光裙摆 + 宽域弱蓝晕 + 慢速非同步呼吸(幅度深)", () => {
    expect(LUX_BOTTOM_FRAG).toContain("exp(-dn * dn * 0.7)"); // 高斯窄核心
    expect(LUX_BOTTOM_FRAG).toContain("exp(-dn * 0.18)"); // 指数辉光裙摆
    expect(LUX_BOTTOM_FRAG).toContain("exp(-dn * 0.055)"); // 宽域弱蓝晕(水体深蓝感)
    expect(LUX_BOTTOM_FRAG).toContain("0.55 + 0.45 * sin"); // 呼吸幅度深(局部近熄灭)
    expect(LUX_BOTTOM_FRAG).toContain("breathe");
    expect(LUX_BOTTOM_FRAG).toContain("kb * 2.6"); // 带间相位错开 → 非同步
    expect(LUX_BOTTOM_FRAG).toContain("wxz.x * 4.0"); // 沿线分段相位 → 非同步
  });

  it("颗粒:随边界线一同运动(随动坐标系)+ 紧贴亮线密集近白、向外缓慢稀疏变暗", () => {
    expect(LUX_BOTTOM_FRAG).toContain("out float kb, out float zeta"); // 输出随动坐标
    expect(LUX_BOTTOM_FRAG).toContain("vec2(wxz.x, zeta) / uDotCell"); // 格点取在随动坐标系 → 光点贴线同行
    expect(LUX_BOTTOM_FRAG).toContain("(0.10 + 0.90 * exp(-dn * 0.30)) * clump"); // 线处最密,向外缓慢稀疏
    expect(LUX_BOTTOM_FRAG).toContain("pBrt = (0.45 + 0.55 * exp(-dn * 0.25)) * 1.5"); // 线处最亮,缓慢变暗
    expect(LUX_BOTTOM_FRAG).toContain("whiteMix = clamp(0.3 + 0.6 * exp(-dn * 0.4)"); // 线处近白
    expect(LUX_BOTTOM_FRAG).toContain("mix(0.0015, 0.0045, big)"); // 半径绝对米数(≥1px 恒可见)
    expect(LUX_BOTTOM_FRAG).toContain("0.45 + 0.55 * vnoise"); // 低频热点(成片闪砾,随线同行)
    expect(LUX_BOTTOM_FRAG).toContain("wander"); // 低速随机漂浮(双频慢摆)
    expect(LUX_BOTTOM_FRAG).toContain("lifeT"); // 随机生命周期
    expect(LUX_BOTTOM_FRAG).toContain("pow(hash12(id + 91.3), 7.0)"); // 少量大而亮
  });

  it("折射视图(水面/液滴)共用同一 nightCoast(COMMON_HELPERS 注入)", () => {
    expect(LUX_SURFACE_FRAG).toContain("vec3 nightCoast(");
    expect(LUX_DROPLET_FRAG).toContain("vec3 nightCoast(");
    expect(LUX_SURFACE_FRAG).not.toContain("nightBiolum");
  });
});

describe("水面/液滴色调时段化(uTint,清晨部分为第八批成果,保留)", () => {
  it("水面使用 uTint/uTintAmt,写死淡蓝已移除", () => {
    expect(LUX_SURFACE_FRAG).toContain("mix(col, uTint, uTintAmt)");
    expect(LUX_SURFACE_FRAG).not.toContain("0.58, 0.79, 0.94");
  });

  it("液滴使用 uTint(uTintAmt 缩放保持旧观感),写死淡蓝已移除", () => {
    expect(LUX_DROPLET_FRAG).toContain("uTintAmt * 0.64");
    expect(LUX_DROPLET_FRAG).not.toContain("0.58, 0.79, 0.94");
  });
});

describe("上方雾气层(清晨蒸汽,第八批成果,保留)", () => {
  it("雾层 shader 存在,强度由 uMistLayer 驱动并做掠射/域边淡出", () => {
    expect(LUX_MIST_VERT).toContain("vXZ = wp.xz");
    expect(LUX_MIST_FRAG).toContain("uMistLayer");
    expect(LUX_MIST_FRAG).toContain("facing");
    expect(LUX_MIST_FRAG).toContain("uMistColor");
  });
});
