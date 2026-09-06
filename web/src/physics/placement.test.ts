import { describe, expect, it } from "vitest";
import { DROP_PLACEMENT } from "../contracts/params";
import { makeRng, placeDrops } from "./placement";

/** 独立转录 oracle:Lehmer RNG 数学定义(与实现文件零共享) */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
}

describe("Lehmer PRNG", () => {
  it("教科书首值:seed=1 → 48271/2147483647", () => {
    const rng = makeRng(1);
    expect(rng()).toBe(48271 / 2147483647);
  });

  it("与独立 oracle 连续对拍 100 步", () => {
    const impl = makeRng(DROP_PLACEMENT.seed);
    const oracle = lcg(DROP_PLACEMENT.seed);
    for (let i = 0; i < 100; i++) {
      expect(impl()).toBe(oracle());
    }
  });
});

describe("布点(封版 seed 20260948)", () => {
  const drops = placeDrops();

  it("数量 = dropCount", () => {
    expect(drops).toHaveLength(DROP_PLACEMENT.count);
  });

  it("确定性:两次布点逐字段相等", () => {
    const again = placeDrops();
    expect(again).toEqual(drops);
  });

  it("半径在 [sizeMin, sizeMax]", () => {
    for (const d of drops) {
      expect(d.r).toBeGreaterThanOrEqual(DROP_PLACEMENT.sizeMin);
      expect(d.r).toBeLessThanOrEqual(DROP_PLACEMENT.sizeMax);
    }
  });

  it("落位在安全区内(u∈[0.09,0.91], v∈[0.11,0.89]),相位 w∈[0,1)", () => {
    for (const d of drops) {
      expect(d.u).toBeGreaterThanOrEqual(0.09);
      expect(d.u).toBeLessThanOrEqual(0.91);
      expect(d.v).toBeGreaterThanOrEqual(0.11);
      expect(d.v).toBeLessThanOrEqual(0.89);
      expect(d.w).toBeGreaterThanOrEqual(0);
      expect(d.w).toBeLessThan(1);
    }
  });

  it("避让性质:全部两两满足间距比 > 2.1(40 次退化强放不得静默发生)", () => {
    for (let i = 0; i < drops.length; i++) {
      for (let j = i + 1; j < drops.length; j++) {
        const a = drops[i]!;
        const b = drops[j]!;
        const dist = Math.hypot((a.u - b.u) * 1.6, a.v - b.v);
        expect(dist).toBeGreaterThan((a.r + b.r) * 2.1);
      }
    }
  });

  // 回归钉:seed 20260948 经扫描选定的布点逐位冻结(TDD 例外:实现验收绿后生成的回归锚,
  // 防未来改动破坏 rand 消耗顺序/避让扫描)。改布点参数须重新扫描并更新此表。
  const GOLDEN: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.11493526383532922, 0.7854805661437476, 0.08045755887658222, 0.7210363139030692],
    [0.5845446264997798, 0.4178771966825599, 0.06363450490340335, 0.2566167485232543],
    [0.2517977055449959, 0.5447495155477662, 0.06382407796048749, 0.8639294951520532],
    [0.4362530549831004, 0.815060158057632, 0.09943962908556668, 0.28062769224896456],
    [0.3567054596667668, 0.24245120501725526, 0.06575995298603547, 0.8616889588822093],
    [0.8538881151768788, 0.7789048883360368, 0.09026405218768123, 0.7793139343984956],
    [0.10501941001742118, 0.22599261186830355, 0.07077564098675532, 0.30688140369340844],
    [0.7797274705999192, 0.2952341419389631, 0.08333426107109257, 0.38110966113447664],
  ];

  it("Golden 冻结:布点与扫描选定值逐位一致", () => {
    expect(drops).toHaveLength(GOLDEN.length);
    drops.forEach((d, i) => {
      const g = GOLDEN[i]!;
      expect(d.u).toBeCloseTo(g[0], 12);
      expect(d.v).toBeCloseTo(g[1], 12);
      expect(d.r).toBeCloseTo(g[2], 12);
      expect(d.w).toBeCloseTo(g[3], 12);
    });
  });
});
