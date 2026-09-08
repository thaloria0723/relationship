// ============================================================
// 桥高亮策略测试(委托方需求 a,docs/光影渲染设计-2026-09-08.md §8/§10)
// ============================================================

import { describe, expect, it } from "vitest";
import { computeBridgeEmphasis, type BridgeEmphasisQuery } from "./emphasis";

/** 构造桥快照:edges = [a, b, cut?] 列表 */
function makeQuery(
  edges: [number, number, number?][],
  activeDroplet = -1,
  focusCenter = -1,
): BridgeEmphasisQuery {
  const n = edges.length;
  return {
    count: n,
    a: Int32Array.from(edges.map((e) => e[0])),
    b: Int32Array.from(edges.map((e) => e[1])),
    cut: Uint8Array.from(edges.map((e) => e[2] ?? 0)),
    activeDroplet,
    focusCenter,
  };
}

describe("computeBridgeEmphasis", () => {
  const edges: [number, number][] = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [2, 4],
    [3, 5],
  ];

  it("无悬停无聚焦:全部为 0(其余液桥不变)", () => {
    const out = new Float32Array(8);
    computeBridgeEmphasis(makeQuery(edges), out);
    expect([...out]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("悬停滴 0:仅 0 出发的三条桥高亮,其余不变", () => {
    const out = new Float32Array(6);
    computeBridgeEmphasis(makeQuery(edges, 0), out);
    expect([...out]).toEqual([1, 1, 1, 0, 0, 0]);
  });

  it("悬停滴 2(多条且作为 b 端):含 2 的全部高亮", () => {
    const out = new Float32Array(6);
    computeBridgeEmphasis(makeQuery(edges, 2), out);
    expect([...out]).toEqual([0, 1, 0, 1, 1, 0]);
  });

  it("拖拽(点击)目标与悬停同策略", () => {
    const hover = new Float32Array(6);
    computeBridgeEmphasis(makeQuery(edges, 4), hover);
    const drag = new Float32Array(6);
    computeBridgeEmphasis(makeQuery(edges, 4, -1), drag);
    expect([...hover]).toEqual([...drag]);
    expect([...hover]).toEqual([0, 0, 0, 0, 1, 0]);
  });

  it("聚焦中心 0:中心直连桥全部高亮(委托方:默认高亮所有与中心相连的桥)", () => {
    const out = new Float32Array(6);
    computeBridgeEmphasis(makeQuery(edges, -1, 0), out);
    expect([...out]).toEqual([1, 1, 1, 0, 0, 0]);
  });

  it("cut 桥恒为 0(不渲染),即使端点匹配激活滴/聚焦中心", () => {
    const q = makeQuery(
      [
        [0, 1, 1],
        [0, 2, 0],
        [1, 2, 0],
      ],
      0,
      0,
    );
    const out = new Float32Array(3);
    computeBridgeEmphasis(q, out);
    expect([...out]).toEqual([0, 1, 0]);
  });

  it("越界激活滴/聚焦中心按无激活处理;输出超长部分保持 0", () => {
    const out = new Float32Array(6);
    computeBridgeEmphasis(makeQuery(edges, 99), out);
    expect([...out]).toEqual([0, 0, 0, 0, 0, 0]);
    computeBridgeEmphasis(makeQuery(edges, -5, 42), out);
    expect([...out]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
