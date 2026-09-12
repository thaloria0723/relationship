// ============================================================
// B 组效果验证 · shader 源码守护
//
// 工程既有纪律:每条 HDR/加性项必须有具名钳制,防止重蹈「夜闪三次整改」
// (网络内桥姿态相近 → 晃动时同时扫过半向量 → 整网同步白爆)。
// 新效果必须同步加断言,否则钳制会在后续调参里被悄悄改掉。
// ============================================================
import { describe, expect, it } from "vitest";
import {
  LUX_BRIDGE_FRAG,
  LUX_BRIDGE_VERT,
  LUX_DROPLET_FRAG,
  LUX_DROPLET_VERT,
  LUX_FOG_FRAG,
  LUX_FOG_VERT,
  LUX_POINT_FRAG,
  LUX_POINT_VERT,
} from "./luxShaders";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VIEWER_SRC = readFileSync(
  fileURLToPath(new URL("./viewer.ts", import.meta.url)),
  "utf8",
);

describe("效果通道:逐顶点属性(逐桥状态不能用 uniform —— 5 个材质共享同一份)", () => {
  it("液桥顶点着色器声明全部效果通道", () => {
    for (const attr of ["aUV", "aSeed", "aKind", "aState", "aGrow"]) {
      expect(LUX_BRIDGE_VERT).toContain(attr);
    }
  });

  it("aState 打包四通道(流动/气泡/湍流/状态量)", () => {
    expect(LUX_BRIDGE_VERT).toContain("attribute vec4 aState");
    expect(LUX_BRIDGE_FRAG).toContain("vState.x");
    expect(LUX_BRIDGE_FRAG).toContain("vState.y");
    expect(LUX_BRIDGE_FRAG).toContain("vState.z");
    expect(LUX_BRIDGE_FRAG).toContain("vState.w");
  });

  it("每桥相位 aSeed 传入片元(去同步:防整网同步扫过半向量)", () => {
    expect(LUX_BRIDGE_VERT).toContain("vSeed = aSeed");
    expect(LUX_BRIDGE_FRAG).toContain("vSeed");
    expect(LUX_FOG_VERT).toContain("aFogAmt");
    expect(LUX_FOG_FRAG).toContain("vFogAmt");
  });

  it("aGrow 默认必须是 1(为 0 会让整条桥透明消失)", () => {
    expect(VIEWER_SRC).toContain("gw[vi] = 1");
    expect(LUX_BRIDGE_FRAG).toContain("alpha * vGrow");
  });
});

describe("1 融合 / 4 暗流:流动与气泡", () => {
  it("流动调制**上下都夹**(只夹上限会把颜色乘成负数 → 桥上黑斑)", () => {
    expect(LUX_BRIDGE_FRAG).toContain(
      "(flowN - 0.75) * 1.4 * clamp(abs(fxFlow), 0.0, 1.0), -0.22, 0.30",
    );
  });

  it("气泡用减性暗体(读作气泡而非亮点)且限幅克制(过强会把细管打成暗斑)", () => {
    expect(LUX_BRIDGE_FRAG).toContain("col -= min(");
    expect(LUX_BRIDGE_FRAG).toContain("col * 0.35");
  });

  it("气泡数量由格子数硬性封顶(规格「融合气泡 ≤8/桥」)", () => {
    expect(LUX_BRIDGE_FRAG).toContain("float cells = mix(8.0, 16.0, oneWay)");
  });

  it("双向流动用相位往复,不是两层反向滚动(后者读作噪声)", () => {
    // 速率常量随「提高亮斑移动速度」(2026-09-11)由 0.35 提到 1.05 rad/s;
    // **意图不变**:融合仍是「相位往复」(单向冲刷走 mix 的另一支)。
    expect(LUX_BRIDGE_FRAG).toContain("sin(uTime * 1.05 + vSeed * 6.283)");
    expect(LUX_BRIDGE_FRAG).toContain("vUv.x * 9.0 - uTime * 1.8");
  });

  it("气泡必须有「贴边亮环」通道(只做减性暗体只能读成暗斑,委托方实测要「补气泡」)", () => {
    expect(LUX_BRIDGE_FRAG).toContain("vec2 fxBubbleField(");
    expect(LUX_BRIDGE_FRAG).toContain("float body = 1.0 - smoothstep(0.55, 1.0, d);");
    expect(LUX_BRIDGE_FRAG).toContain("float rim = smoothstep(0.55, 0.95, d)");
    expect(LUX_BRIDGE_FRAG).toContain("bf.y * bA");
  });

  it("亮环是加性项 → 必须钳制(夜闪纪律);泡体仍限幅保底", () => {
    expect(LUX_BRIDGE_FRAG).toContain("col += min(vec3(0.62, 0.72, 0.85) * (bf.y * bA), 0.20)");
    expect(LUX_BRIDGE_FRAG).toContain("col * 0.35");
  });
});

describe("2 拉扯:黯淡 = 失去光泽,不是失去亮度", () => {
  it("撤锐高光(湿感的唯一强证据)而不是压暗", () => {
    expect(LUX_BRIDGE_FRAG).toContain(
      "col -= uSunColor * (ggxSpec(n, v, uSunDir, 0.14) * uGlint) * fade * 0.85",
    );
  });

  it("不混合天空色(正午天空比水面亮,混过去等于给桥打光)", () => {
    // 该分支内不得出现 uSkyHorizon
    const kind2 = LUX_BRIDGE_FRAG.slice(
      LUX_BRIDGE_FRAG.indexOf("vKind < 2.5"),
      LUX_BRIDGE_FRAG.indexOf("vKind < 3.5"),
    );
    // 注释里提到 uSkyHorizon 是解释「为什么不混」,这里查的是**实际调用**
    expect(kind2).not.toContain("mix(col, uSkyHorizon");
    expect(kind2).toContain("alpha *= mix(1.0, 0.45, fade)");
  });
});

describe("3 对撞:两端亮斑相向推进 → 中心融合(原「湍流」三项已按裁决作废)", () => {
  const kind3 = LUX_BRIDGE_FRAG.slice(
    LUX_BRIDGE_FRAG.indexOf("vKind < 3.5"),
    LUX_BRIDGE_FRAG.indexOf("// ---- 5 潜流"),
  );

  it("亮斑是两个高斯,位置由 fxState 给出(head 与 1-head → 天然对称相向)", () => {
    expect(kind3).toContain("float dA = (vUv.x - head) * 13.0;");
    expect(kind3).toContain("float dB = (vUv.x - (1.0 - head)) * 13.0;");
    expect(kind3).toContain("(exp(-dA * dA) + exp(-dB * dB)) * clash");
  });

  it("平方用 d*d 而不是 pow(负底数在 GLSL 的 pow 里未定义)", () => {
    expect(kind3).not.toContain("pow(");
  });

  it("中心余晖是**第二团光**(与下一轮两端亮斑同时存在 → 持续对撞)", () => {
    expect(kind3).toContain("float dC = (vUv.x - 0.5) * 8.0;");
    expect(kind3).toContain("float after = exp(-dC * dC) * clamp(fxFlow, 0.0, 1.0);");
    expect(kind3).toContain("float lit = spots + after;");
  });

  it("亮斑是加性项 → 必须钳制(夜闪纪律)", () => {
    expect(kind3).toContain(
      "col += min(vec3(0.95, 0.97, 1.0) * lit * 0.55, 0.34)",
    );
    expect(kind3).toContain("alpha = min(alpha + 0.50 * lit, 1.0)");
  });

  it("融合后冒泡复用同一套「泡体暗 + 贴边亮环」", () => {
    expect(kind3).toContain("vec2 bf = fxBubbleField(vUv, 10.0, uTime, vSeed);");
    expect(kind3).toContain("bf.y * fxBubbleAmt), 0.20)");
  });

  it("旧湍流的轮廓侵蚀已随裁决删除(不得残留)", () => {
    expect(LUX_BRIDGE_FRAG).not.toContain("float edgeMask = rim");
  });
});

describe("7 死亡:抖动溶解而非 alpha 淡出(液滴写深度,alpha 淡出会留洞)", () => {
  it("溶解走 discard", () => {
    expect(LUX_DROPLET_FRAG).toContain("discard");
    expect(LUX_DROPLET_FRAG).toContain("hash12(floor(gl_FragCoord.xy)) < vDissolve");
  });

  it("沸腾的 HDR 边缘项钳制", () => {
    expect(LUX_DROPLET_FRAG).toContain(
      "min(vec3(1.0, 0.62, 0.30) * (hotRim * 1.5 * vBoil), 0.5)",
    );
  });

  it("沸腾只动顶点与 rim,不动 alpha(alpha 淡出 = 隐形球继续剔除身后的桥)", () => {
    expect(LUX_DROPLET_VERT).toContain("pos += normal *");
    const effectBlock = LUX_DROPLET_FRAG.slice(
      LUX_DROPLET_FRAG.indexOf("if (vBoil > 0.001)"),
      LUX_DROPLET_FRAG.indexOf("col *= vTint;"),
    );
    expect(effectBlock).not.toContain("alpha");
  });

  it("接触亮环用几何高度而非位移后高度(环带不该跟着沸腾抖)", () => {
    expect(LUX_DROPLET_VERT).toContain("vLocalY = position.y");
  });
});

describe("雾团(凝结的起雾 / 死亡的残雾)", () => {
  it("淡出用 discard 而非全透明混合", () => {
    expect(LUX_FOG_FRAG).toContain("if (vFogAmt < 0.004) discard");
    expect(LUX_FOG_FRAG).toContain("if (a < 0.006) discard");
  });

  it("「微弱的水汽」而非实心云:alpha 有上限(改动必须同时改此断言)", () => {
    expect(LUX_FOG_FRAG).toContain("vFogAmt * 0.44");
  });

  it("体色偏灰而非偏天空(正午水面近白,白雾落上去没有对比)", () => {
    expect(LUX_FOG_FRAG).toContain("mix(uMistColor, uSkyHorizon, 0.15)");
  });
});

describe("几何侧:颈径屏幕空间下限(「黑刀片」的真正解药)", () => {
  it("下限按「世界单位/像素」换算,而不是世界常数", () => {
    expect(VIEWER_SRC).toContain("2 * Math.tan((camera.fov * Math.PI) / 360)");
    expect(VIEWER_SRC).toContain("2.6 * worldPerPx");
  });

  it("下限只改轮廓参数 rNeck,**不得**夹最终半径 rr(会毁掉锥形、桥变粗圆棒)", () => {
    expect(VIEWER_SRC).toContain("BRIDGE_NECK_FRAC * Math.min(ra, rb) * thickK,");
    // rr 的 max 里只应有 1e-5 兜底
    const at = VIEWER_SRC.indexOf("free * rise * thin * thick * visK * bead");
    expect(at).toBeGreaterThan(0);
    const rrBlock = VIEWER_SRC.slice(at, at + 200);
    expect(rrBlock).not.toContain("neckFloor");
    expect(rrBlock).toContain("1e-5");
    // 抽出/回缩是几何生长(乘进半径),不是 alpha 淡入
    expect(rrBlock).toContain("growLocal");
  });

  it("珠化只调制中段(乘在 rise 已在两端归零的轮廓上),且只在「拉扯」", () => {
    expect(VIEWER_SRC).toContain("1 + 0.18 * Math.sin(t * 9.0 + seedK * 6.283)");
    expect(VIEWER_SRC).toContain("fxSource?.bridgeKind() === 2");
  });
});

// ============================================================
// 第二轮(2026-09-11)新增守护
// ============================================================

describe("几何侧:桥管细分(「扁片 + 硬台阶」的解药)", () => {
  it("周向/轴向环数足够(8×10 时剪影是八边形、端部圆角整个塞进一段 → 读成扁片)", () => {
    expect(VIEWER_SRC).toContain("const BRIDGE_RAD = 20;");
    expect(VIEWER_SRC).toContain("const BRIDGE_LEN = 48;");
  });

  it("周向三角函数预计算(提高环数后每顶点算 sin/cos 是白烧帧时间)", () => {
    expect(VIEWER_SRC).toContain("const ringCos = new Float32Array(BRIDGE_RAD);");
    expect(VIEWER_SRC).toContain("const s2 = ringSin[r]!;");
  });

  it("drawRange 限到已分配桥槽(否则每帧提交整池 95 万个退化三角形)", () => {
    expect(VIEWER_SRC).toContain("bridgeGeo.setDrawRange(");
    expect(VIEWER_SRC).toContain(
      "Math.min(bs.count, bridgeMax) * BRIDGE_LEN * BRIDGE_RAD * 6",
    );
  });

  it("不可见桥槽只在「由可见转不可见」那一帧清零(每帧无条件清 496 槽会白烧帧时间)", () => {
    expect(VIEWER_SRC).toContain("if (bridgeWasActive[k] === 0) continue;");
    expect(VIEWER_SRC).toContain("bridgeWasActive[k] = 1;");
  });
});

describe("粗细映射:适用于所有桥、不属于任何状态,且有硬性上下限(§1.3)", () => {
  it("唯一入口 bridgeThick,钳在 BRIDGE_THICK 区间内", () => {
    expect(VIEWER_SRC).toContain(
      "export const BRIDGE_THICK = { min: 0.55, max: 1.85, base: 1.0 }",
    );
    expect(VIEWER_SRC).toContain(
      "fxSource ? fxSource.bridgeThick(seedK) : BRIDGE_THICK.base",
    );
    expect(VIEWER_SRC).toContain("BRIDGE_THICK.max,");
    expect(VIEWER_SRC).toContain("BRIDGE_THICK.min,");
  });

  it("粗细同时作用于端径与颈径(不是只改一头),且不掺任何模式判断", () => {
    expect(VIEWER_SRC).toContain(
      "(t < 0.5 ? BRIDGE_END_FRAC * ra : BRIDGE_END_FRAC * rb) * thickK;",
    );
    expect(VIEWER_SRC).toContain("BRIDGE_NECK_FRAC * Math.min(ra, rb) * thickK,");
    const at = VIEWER_SRC.indexOf("const thickK = Math.min(");
    expect(at).toBeGreaterThan(0);
    const block = VIEWER_SRC.slice(at, at + 400);
    expect(block).not.toContain("bridgeKind");
    expect(block).not.toContain("driver.mode");
  });

  it("颈径屏幕空间下限仍然兜底(§1.3「关系再弱也不会细到无法分辨」)", () => {
    expect(VIEWER_SRC).toContain("2.6 * worldPerPx");
  });
});

describe("聚焦未在场灰滴(§2.3):灰 + 逐滴通道,不用 alpha", () => {
  it("aFx 升到 vec3(沸腾/溶解/未在场),并由顶点着色器读出", () => {
    expect(LUX_DROPLET_VERT).toContain("attribute vec3 aFx;");
    expect(LUX_DROPLET_VERT).toContain("vAbsent = aFx.z;");
  });

  it("灰在 vTint 之后施加(不得混进「沸腾只动顶点」的守护切片)", () => {
    expect(LUX_DROPLET_FRAG).toContain("if (vAbsent > 0.001) {");
    const at = LUX_DROPLET_FRAG.indexOf("col *= vTint;");
    expect(LUX_DROPLET_FRAG.indexOf("if (vAbsent > 0.001) {")).toBeGreaterThan(at);
    expect(LUX_DROPLET_FRAG).toContain(
      "col = mix(col, vec3(lum) * vec3(0.80, 0.84, 0.92), vAbsent * 0.92);",
    );
  });

  it("灰块里不得出现 alpha(液滴不透明且写深度,alpha 淡入会留洞)", () => {
    const at = LUX_DROPLET_FRAG.indexOf("if (vAbsent > 0.001) {");
    const block = LUX_DROPLET_FRAG.slice(at, LUX_DROPLET_FRAG.indexOf("col = applyGrade(col);"));
    expect(block).not.toContain("alpha");
  });
});

describe("5 潜流:浮现由指针驱动,不得由时间驱动", () => {
  // 末分支(kind 4):`vKind < 3.5` 之后到效果块结束
  const kind5 = LUX_BRIDGE_FRAG.slice(
    LUX_BRIDGE_FRAG.indexOf("vKind < 3.5"),
    LUX_BRIDGE_FRAG.indexOf("col = applyGrade(col);"),
  );

  it("浮现阈值取自**静态**噪声(按 uTime 滚动 → 没人碰鼠标桥也自己浮现/隐去)", () => {
    expect(kind5).toContain("float nza = vnoise(vUv * vec2(18.0, 4.0));");
    expect(kind5).not.toContain("vec2(18.0, 4.0) - vec2(uTime");
  });

  it("reveal=0 整条融入背景、reveal=1 整条浮现(阈值整体落在噪声值域之上)", () => {
    expect(kind5).toContain("float tau = 0.15 + 0.55 * nza + 0.18 * vUv.x;");
    expect(kind5).toContain("float m = 1.0 - emerge;");
  });

  it("§3.5「流动的纹理」乘 reveal(未搅动处完全静止)", () => {
    expect(kind5).toContain("* reveal * emerge, -0.12, 0.18)");
  });
});

describe("5 潜流(viewer):指针离开画布必须回落,不能冻结在最后一个距离", () => {
  it("距离计算不再被 pointerValid 整个门掉;失效时 best 保持 Infinity", () => {
    expect(VIEWER_SRC).toContain(
      "const n = pointerValid ? Math.min(bs.count, bridgeMax) : 0;",
    );
    expect(VIEWER_SRC).toContain("let best = Infinity;");
  });
});

describe("大转折「光点」(mode 9):纯光点 + 深夜发光(委托方 2026-09-12 两条整改)", () => {
  it("是光不是水珠:细亮核 + 宽淡晕两瓣廓线;无菲涅尔/无视线相关项/无折射", () => {
    expect(LUX_POINT_FRAG).toContain("0.55 * pow(1.0 - rl, 5.0) + 0.45 * pow(1.0 - rl, 1.6)");
    for (const banned of ["fres", "refract", "cameraPosition", "dot(n,"]) {
      expect(LUX_POINT_FRAG).not.toContain(banned);
    }
  });

  it("rgb 与 alpha **同一条廓线**(预乘 col·a / a)—— alpha 宽于颜色会把边缘压暗成暗环", () => {
    expect(LUX_POINT_FRAG).toContain("float a = vA * fall;");
    expect(LUX_POINT_FRAG).toContain("gl_FragColor = vec4(col * a, a);");
    expect(LUX_POINT_FRAG).not.toContain("smoothstep(1.0"); // 旧「宽 alpha + 细 core」写法
  });

  it("深夜发光:切暖橙,与液滴夜色分支**同色**(「和原液滴一样」)", () => {
    expect(LUX_POINT_FRAG).toContain("uNightDots");
    expect(LUX_POINT_FRAG).toContain("vec3(1.0, 0.70, 0.30)");
    expect(LUX_DROPLET_FRAG).toContain("vec3(1.0, 0.70, 0.30)"); // 液滴夜色分支同色
  });

  it("核亮度**具名常量**且量级受控(夜闪纪律:加性/调制项都要钳)", () => {
    expect(LUX_POINT_FRAG).toContain("vec3(1.0, 0.95, 0.85) * 1.5");
    expect(LUX_POINT_FRAG).toContain("vec3(1.0, 0.70, 0.30) * 1.25");
    expect(LUX_POINT_FRAG).toContain("mix(1.0, 0.42, uDim)"); // 压暗与其余材质一致
  });

  it("预乘 alpha 输出(柔边不产生暗环):片元 (col·a, a) + viewer 侧 One/OneMinusSrcAlpha", () => {
    expect(LUX_POINT_FRAG).toContain("gl_FragColor = vec4(col * a, a);");
    expect(VIEWER_SRC).toContain("blendSrc: THREE.OneFactor");
    expect(VIEWER_SRC).toContain("blendDst: THREE.OneMinusSrcAlphaFactor");
  });

  it("池容量与 fxdriver 的 POINT_POOL 同值(160;爆散段仍只用前 48 槽,由 driver 钳制)", () => {
    expect(VIEWER_SRC).toContain("const SPARK_MAX = 160;");
  });
});
