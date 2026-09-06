import { DROP_PLACEMENT } from "../contracts/params";
import type { DropSeed } from "./types";

/** Lehmer PRNG(与封版布点一致):seed = (seed·48271) mod 2147483647,返回 [0,1) */
export function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
}

/** 布点:与 index-wave.html :104-134 逐字等价(含 rand 消耗顺序,Golden 值依赖它) */
export function placeDrops(): DropSeed[] {
  const count: number = DROP_PLACEMENT.count; // 放宽字面量类型,保住单颗试验钩子的可达性
  const rand = makeRng(DROP_PLACEMENT.seed);
  const list: DropSeed[] = [];
  for (let i = 0; i < count; i++) {
    const r =
      DROP_PLACEMENT.sizeMin +
      rand() * (DROP_PLACEMENT.sizeMax - DROP_PLACEMENT.sizeMin);
    let u = 0.5;
    let v = 0.5;
    for (let tries = 0; tries < 40; tries++) {
      u = 0.09 + rand() * 0.82;
      v = 0.11 + rand() * 0.78;
      if (
        list.every(
          (d) => Math.hypot((u - d.u) * 1.6, v - d.v) > (r + d.r) * 2.1,
        )
      )
        break;
    }
    if (count === 1) {
      u = 0.36;
      v = 0.3;
    } // 单颗试验定点(封版钩子,保留)
    list.push({ u, v, r, w: rand() });
  }
  return list;
}
