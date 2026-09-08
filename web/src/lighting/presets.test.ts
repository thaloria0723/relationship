// ============================================================
// 四时段光系预设测试(docs/光影渲染设计-2026-09-08.md §6/§10)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  LIGHTING_PRESETS,
  RENDER_PARAMS,
  TIME_ORDER,
  sunDirection,
  type LightingPreset,
  type TimeOfDay,
} from "./presets";

/** 数值字段全量收集(含嵌套三元色),供有限性/范围断言 */
function collectNumbers(p: LightingPreset): number[] {
  const out: number[] = [];
  for (const v of Object.values(p)) {
    if (typeof v === "number") out.push(v);
    else if (Array.isArray(v)) out.push(...v);
  }
  return out;
}

describe("四时段光系预设", () => {
  it("恰好覆盖 清晨/正午/傍晚/深夜 四个时段", () => {
    expect(TIME_ORDER).toEqual(["dawn", "noon", "dusk", "night"]);
    expect(Object.keys(LIGHTING_PRESETS).sort()).toEqual(
      [...TIME_ORDER].sort(),
    );
  });

  it("全部数值有限;颜色三元色分量落在 [0,5](HDR 主光允许 >1)", () => {
    for (const key of TIME_ORDER) {
      const p = LIGHTING_PRESETS[key];
      for (const v of collectNumbers(p)) {
        expect(Number.isFinite(v), `${key} 字段非有限`).toBe(true);
      }
      for (const c of [
        p.sunColor,
        p.ambSky,
        p.ambGround,
        p.skyHorizon,
        p.skyZenith,
        p.mistColor,
        p.nightDotColor,
        p.waterBody,
        p.bottomAlbedo,
        p.background,
      ]) {
        for (const x of c) {
          expect(x, `${key} 颜色分量越界`).toBeGreaterThanOrEqual(0);
          expect(x, `${key} 颜色分量越界`).toBeLessThanOrEqual(5);
        }
      }
      expect(p.sunElevationDeg).toBeGreaterThanOrEqual(0);
      expect(p.sunElevationDeg).toBeLessThanOrEqual(90);
      expect(p.saturation).toBeGreaterThan(0);
      expect(p.exposure).toBeGreaterThan(0);
      expect(p.bloomStrength).toBeGreaterThanOrEqual(0);
    }
  });

  it("太阳方向为单位向量,且仰角换算正确", () => {
    for (const key of TIME_ORDER) {
      const p = LIGHTING_PRESETS[key];
      const d = sunDirection(p);
      const len = Math.hypot(d[0], d[1], d[2]);
      expect(len).toBeCloseTo(1, 6);
      const elev = Math.asin(d[1]);
      expect(elev).toBeCloseTo((p.sunElevationDeg * Math.PI) / 180, 6);
    }
  });

  it("委托方 b:正午近垂直且强度最强,清晨/傍晚低角度,夜晚最暗", () => {
    const { dawn, noon, dusk, night } = LIGHTING_PRESETS;
    expect(noon.sunElevationDeg).toBeGreaterThan(75);
    expect(dawn.sunElevationDeg).toBeLessThan(15);
    expect(dusk.sunElevationDeg).toBeLessThan(15);
    // 主光色相 ≤1,强度走 sunIntensity(HDR 倍率)
    for (const key of TIME_ORDER) {
      const p = LIGHTING_PRESETS[key];
      expect(Math.max(...p.sunColor)).toBeLessThanOrEqual(1);
      expect(p.sunIntensity).toBeGreaterThan(0);
    }
    expect(noon.sunIntensity).toBeGreaterThan(dusk.sunIntensity);
    expect(dusk.sunIntensity).toBeGreaterThan(dawn.sunIntensity);
    expect(dawn.sunIntensity).toBeGreaterThan(night.sunIntensity);
    expect(night.sunIntensity).toBeLessThan(1); // 整体光线暗
  });

  it("委托方 b:清晨唯晨雾最浓;正午涟漪/水底纹最明显;色彩最鲜明", () => {
    const ps = TIME_ORDER.map((k) => LIGHTING_PRESETS[k]);
    const dawn = LIGHTING_PRESETS.dawn;
    const noon = LIGHTING_PRESETS.noon;
    expect(dawn.mistDensity).toBeGreaterThan(0.1);
    for (const p of ps) {
      if (p !== dawn) expect(p.mistDensity).toBeLessThan(dawn.mistDensity);
    }
    for (const p of ps) {
      if (p !== noon) expect(p.causticScale).toBeLessThan(noon.causticScale);
    }
    expect(noon.saturation).toBeGreaterThan(1.05); // 色彩鲜明
  });

  it("委托方 b:傍晚 bloom 辉光最强且对比加深;夜晚 glitter 最强且唯一开金色光点", () => {
    const dusk = LIGHTING_PRESETS.dusk;
    const night = LIGHTING_PRESETS.night;
    for (const key of TIME_ORDER) {
      const p = LIGHTING_PRESETS[key];
      if (p !== dusk) expect(p.bloomStrength).toBeLessThan(dusk.bloomStrength);
      if (p !== night) expect(p.glintGain).toBeLessThan(night.glintGain);
      expect(p.nightDots).toBe(key === "night" ? 1 : 0);
    }
    expect(dusk.contrast).toBeGreaterThan(1.05); // 电影级强对比
    // 夜光点为金色:红 > 绿 > 蓝
    const [r, g, b] = night.nightDotColor;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
});

describe("渲染参数(RENDER_PARAMS)", () => {
  it("委托方 a:液桥常态透明度 = 30%,高亮后更亮更粗,液滴压暗 <1", () => {
    expect(RENDER_PARAMS.bridgeOpacity).toBeCloseTo(0.3, 6);
    expect(RENDER_PARAMS.bridgeHiOpacity).toBeGreaterThan(
      RENDER_PARAMS.bridgeOpacity,
    );
    expect(RENDER_PARAMS.bridgeHiThicken).toBeGreaterThan(0);
    expect(RENDER_PARAMS.dropletDarken).toBeLessThan(1);
  });

  it("物理常量与全部字段有限且范围合理", () => {
    expect(RENDER_PARAMS.refractiveIndex).toBeCloseTo(1.33, 6);
    expect(RENDER_PARAMS.fresnelF0).toBeCloseTo(0.02, 6);
    for (const v of Object.values(RENDER_PARAMS)) {
      const arr = Array.isArray(v) ? v : [v];
      for (const x of arr) expect(Number.isFinite(x)).toBe(true);
    }
    expect(RENDER_PARAMS.bridgeOpacity).toBeGreaterThan(0);
    expect(RENDER_PARAMS.bridgeOpacity).toBeLessThan(1);
    expect(RENDER_PARAMS.poolDepth).toBeGreaterThan(0.05);
    expect(RENDER_PARAMS.waterAbsorb.every((a) => a > 0)).toBe(true);
    // 吸收红光最快(水体呈蓝绿的物理依据)
    const [ar, ag, ab] = RENDER_PARAMS.waterAbsorb;
    expect(ar).toBeGreaterThan(ag);
    expect(ag).toBeGreaterThan(ab);
  });
});
