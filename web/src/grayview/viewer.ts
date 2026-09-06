// ============================================================
// 灰模查看器(M1:场核可视化)
// ★ 本文件是全工程唯一 import three 的文件(纪律红线)。
// 零灯光:MeshBasicMaterial(unlit)+ LineSegments 线框,灰模零颜色渲染;
// 场景内不创建任何 Light。错误提示文字的红色是灰模里唯一的「颜色」(§6)。
// ============================================================

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { WaterEngine } from "../watersim/engine";
import { defaultParams, type WaterSimParams } from "../watersim/params";

// 灰模色板(§6)
const COLOR_SURFACE = 0x9a9a9a; // 水面实体
const COLOR_WIRE = 0x6e6e6e; // 线框
const COLOR_BG = 0xc8c8c8; // 背景

const WIRE_N = 64; // 线框降采样(§6:防糊)

/** 确定性 PRNG(演示戳点序列;M4 演示脚本归入 demo.ts 后此处移除) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`灰模页缺少 DOM 节点 #${id}`);
  return node as T;
}

/**
 * 查看器钩子(演示页 demo.ts 使用;普通灰模页不传):
 * - tick:每渲染帧在物理步进后调用(拿到引擎实时句柄,驱动时间线事件)
 * - caption:返回当前字幕文本(null 隐藏),渲染到 #gray-caption(若页面存在)
 */
export interface ViewerHooks {
  /** 禁用内置随机戳点脚本(演示页用自己的时间线接管) */
  disablePokes?: boolean;
  tick?: (engine: WaterEngine, frameDt: number) => void;
  caption?: (simTime: number) => string | null;
  /** 重播/重置时调用:宿主复位自己的时间线状态(引擎已由 viewer 重建) */
  reset?: () => void;
}

export function mountGrayViewer(
  container: HTMLElement,
  params: WaterSimParams = defaultParams,
  hooks: ViewerHooks = {},
): void {
  // ---- HUD 引用 ----
  const hudError = el<HTMLDivElement>("gray-error");
  const hudFps = el<HTMLSpanElement>("gray-fps");
  const hudTime = el<HTMLSpanElement>("gray-time");
  const hudSteps = el<HTMLSpanElement>("gray-steps");
  const hudEnergy = el<HTMLSpanElement>("gray-energy");
  const hudDroplets = el<HTMLSpanElement>("gray-droplets");
  const hudMerges = el<HTMLSpanElement>("gray-merges");
  const btnPause = el<HTMLButtonElement>("gray-btn-pause");
  const btnStep = el<HTMLButtonElement>("gray-btn-step");
  const btnReset = el<HTMLButtonElement>("gray-btn-reset");
  const btnWire = el<HTMLButtonElement>("gray-btn-wire");
  const btnDrop = el<HTMLButtonElement>("gray-btn-drop");
  const btnPair = el<HTMLButtonElement>("gray-btn-pair");

  const showError = (message: string): void => {
    hudError.textContent = `启动失败:${message}`;
    hudError.style.display = "block";
  };

  // ---- 引擎(启动即断言 CFL/范围,违规 throw → 红字) ----
  let engine: WaterEngine;
  try {
    engine = new WaterEngine(params);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }

  const { N, dx } = engine.field;
  const half = params.domainSize / 2;
  const gridToWorld = (g: number): number => g * dx - half; // 域中心置于原点

  // ---- three 场景 ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLOR_BG);

  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.01,
    20,
  );
  camera.position.set(0, 1.0, 1.4);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  // ---- 水面实体:自建 N×N 网格,顶点 (i,j) ↔ 场格 (i,j),行主序一一对应 ----
  const surfaceGeo = new THREE.BufferGeometry();
  const surfacePos = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      surfacePos[k * 3] = gridToWorld(i);
      surfacePos[k * 3 + 1] = 0;
      surfacePos[k * 3 + 2] = gridToWorld(j);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const surfacePosAttr = new THREE.BufferAttribute(surfacePos, 3);
  surfaceGeo.setAttribute("position", surfacePosAttr);
  surfaceGeo.setIndex(index);
  const surface = new THREE.Mesh(
    surfaceGeo,
    new THREE.MeshBasicMaterial({
      color: COLOR_SURFACE,
      side: THREE.DoubleSide,
      // 把实体面往深度里推一点,防共面线框 z-fighting(线框是几何显示,必须可见)
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  scene.add(surface);

  // ---- 线框:64×64 降采样 LineSegments(几何显示,非光照) ----
  const wireIdx = (k: number): number =>
    Math.round((k * (N - 1)) / (WIRE_N - 1));
  const wireSegs: [number, number][] = [];
  for (let j = 0; j < WIRE_N; j++) {
    const r = wireIdx(j); // 采样行
    for (let i = 0; i < WIRE_N - 1; i++) {
      wireSegs.push([r * N + wireIdx(i), r * N + wireIdx(i + 1)]); // 横向(沿 x)
    }
  }
  for (let i = 0; i < WIRE_N; i++) {
    const c = wireIdx(i); // 采样列
    for (let j = 0; j < WIRE_N - 1; j++) {
      wireSegs.push([wireIdx(j) * N + c, wireIdx(j + 1) * N + c]); // 纵向(沿 z)
    }
  }
  const wireGeo = new THREE.BufferGeometry();
  const wirePos = new Float32Array(wireSegs.length * 6);
  // 端点 x/z 一次性构建(网格索引 → 世界坐标);y 由每帧同步写入
  for (let s = 0; s < wireSegs.length; s++) {
    const a = wireSegs[s]![0]!;
    const b = wireSegs[s]![1]!;
    wirePos[s * 6 + 0] = gridToWorld(a % N);
    wirePos[s * 6 + 2] = gridToWorld(Math.floor(a / N));
    wirePos[s * 6 + 3] = gridToWorld(b % N);
    wirePos[s * 6 + 5] = gridToWorld(Math.floor(b / N));
  }
  const wirePosAttr = new THREE.BufferAttribute(wirePos, 3);
  wireGeo.setAttribute("position", wirePosAttr);
  const wireMesh = new THREE.LineSegments(
    wireGeo,
    new THREE.LineBasicMaterial({ color: COLOR_WIRE }),
  );
  scene.add(wireMesh);

  // ---- 液滴:灰 #4A4A4A 球,InstancedMesh;y 向缩放 1−ε 的形变在 M3 接入 ----
  const dropletMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x4a4a4a }),
    params.maxDroplets,
  );
  dropletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dropletMesh.frustumCulled = false;
  dropletMesh.count = 0;
  scene.add(dropletMesh);

  const dropletMatrix = new THREE.Matrix4();
  const syncDroplets = (): void => {
    const d = engine.droplets.state;
    dropletMesh.count = d.count;
    for (let i = 0; i < d.count; i++) {
      const r = d.r[i]!;
      // y 向压扁形变(§4.3 Deformation):scale = (r, r·(1−ε), r)
      dropletMatrix.makeScale(r, r * (1 - d.eps[i]!), r);
      // 液滴坐标是米(非格索引):世界位 = 米 − 半域
      dropletMatrix.setPosition(
        d.x[i]! - half,
        d.z[i]!, // 引擎维护:总高 + (R − d)(空中段为积分高度)
        d.y[i]! - half,
      );
      dropletMesh.setMatrixAt(i, dropletMatrix);
    }
    dropletMesh.instanceMatrix.needsUpdate = true;
  };

  // ---- 液桥渲染(任务①):颈状管(两端宽、中间窄)+ 桥内流动粒子 ----
  const BRIDGE_LEN = 10; // 轴向环数
  const BRIDGE_RAD = 8; // 周向边数
  const bridgeMax = params.maxDroplets;
  const vertsPerBridge = (BRIDGE_LEN + 1) * BRIDGE_RAD;
  const bridgeGeo = new THREE.BufferGeometry();
  const bridgePos = new Float32Array(bridgeMax * vertsPerBridge * 3);
  const bridgeIdx: number[] = [];
  for (let b = 0; b < bridgeMax; b++) {
    const base = b * vertsPerBridge;
    for (let s = 0; s < BRIDGE_LEN; s++) {
      for (let r = 0; r < BRIDGE_RAD; r++) {
        const r2 = (r + 1) % BRIDGE_RAD;
        const a = base + s * BRIDGE_RAD + r;
        const bb = base + s * BRIDGE_RAD + r2;
        const c = base + (s + 1) * BRIDGE_RAD + r;
        const dd = base + (s + 1) * BRIDGE_RAD + r2;
        bridgeIdx.push(a, c, bb, bb, c, dd);
      }
    }
  }
  const bridgePosAttr = new THREE.BufferAttribute(bridgePos, 3);
  bridgePosAttr.setUsage(THREE.DynamicDrawUsage);
  bridgeGeo.setAttribute("position", bridgePosAttr);
  bridgeGeo.setIndex(bridgeIdx);
  const bridgeMesh = new THREE.Mesh(
    bridgeGeo,
    new THREE.MeshBasicMaterial({ color: 0x4a4a4a, side: THREE.DoubleSide }),
  );
  bridgeMesh.frustumCulled = false;
  scene.add(bridgeMesh);

  // 流动粒子:每桥 3 颗,沿桥轴迁移(方向 = 体积流量方向;速度风格化)
  const FLOW_PER_BRIDGE = 3;
  const flowT = new Float32Array(bridgeMax * FLOW_PER_BRIDGE);
  const flowGeo = new THREE.BufferGeometry();
  const flowPos = new Float32Array(bridgeMax * FLOW_PER_BRIDGE * 3);
  const flowPosAttr = new THREE.BufferAttribute(flowPos, 3);
  flowPosAttr.setUsage(THREE.DynamicDrawUsage);
  flowGeo.setAttribute("position", flowPosAttr);
  const flowPoints = new THREE.Points(
    flowGeo,
    new THREE.PointsMaterial({ color: 0x808080, size: 2, sizeAttenuation: false }),
  );
  flowPoints.frustumCulled = false;
  scene.add(flowPoints);

  const syncBridges = (dt: number): void => {
    const bs = engine.bridges.state;
    const d = engine.droplets.state;
    for (let k = 0; k < bridgeMax; k++) {
      const base = k * vertsPerBridge;
      const active = k < bs.count && bs.cut[k] === 0;
      if (!active) {
        // 收缩到原点(不可见)并隐藏该桥粒子
        for (let v = 0; v < vertsPerBridge; v++) {
          bridgePos[(base + v) * 3] = 0;
          bridgePos[(base + v) * 3 + 1] = 0;
          bridgePos[(base + v) * 3 + 2] = 0;
        }
        for (let f = 0; f < FLOW_PER_BRIDGE; f++) {
          flowPos[(k * FLOW_PER_BRIDGE + f) * 3 + 1] = -10;
        }
        continue;
      }
      const ia = bs.a[k]!;
      const ib = bs.b[k]!;
      const ax = d.x[ia]! - half;
      const az = d.y[ia]! - half;
      const ay = d.z[ia]!;
      const bx = d.x[ib]! - half;
      const bz = d.y[ib]! - half;
      const by = d.z[ib]!;
      // 轴与正交基
      let ux = bx - ax;
      let uy = by - ay;
      let uz = bz - az;
      const len = Math.hypot(ux, uy, uz) || 1;
      ux /= len;
      uy /= len;
      uz /= len;
      // n1 = axis × up(域内近水平轴,退化防护)
      let n1x = uy * 0 - uz * 1;
      let n1y = uz * 0 - ux * 0;
      let n1z = ux * 1 - uy * 0;
      let n1l = Math.hypot(n1x, n1y, n1z);
      if (n1l < 1e-6) {
        n1x = 1;
        n1y = 0;
        n1z = 0;
      } else {
        n1x /= n1l;
        n1y /= n1l;
        n1z /= n1l;
      }
      // n2 = axis × n1
      const n2x = uy * n1z - uz * n1y;
      const n2y = uz * n1x - ux * n1z;
      const n2z = ux * n1y - uy * n1x;
      const rEnd = 0.8 * Math.min(d.r[ia]!, d.r[ib]!);
      const rNeck = 0.45 * rEnd;
      for (let s = 0; s <= BRIDGE_LEN; s++) {
        const t = s / BRIDGE_LEN;
        const rr = rNeck + (rEnd - rNeck) * Math.abs(2 * t - 1) ** 1.5;
        const cx = ax + (bx - ax) * t;
        const cy = ay + (by - ay) * t;
        const cz = az + (bz - az) * t;
        for (let r = 0; r < BRIDGE_RAD; r++) {
          const ang = (r / BRIDGE_RAD) * Math.PI * 2;
          const ox = Math.cos(ang) * rr;
          const oy = Math.sin(ang) * rr;
          const vi = (base + s * BRIDGE_RAD + r) * 3;
          bridgePos[vi] = cx + n1x * ox + n2x * oy;
          bridgePos[vi + 1] = cy + n1y * ox + n2y * oy;
          bridgePos[vi + 2] = cz + n1z * ox + n2z * oy;
        }
      }
      // 流动粒子推进(方向随流量符号;速度风格化固定)
      const q = engine.bridges.flowRate[k]!;
      for (let f = 0; f < FLOW_PER_BRIDGE; f++) {
        const fi = k * FLOW_PER_BRIDGE + f;
        if (q !== 0) {
          flowT[fi] = (flowT[fi]! + (q > 0 ? 1 : -1) * 0.25 * dt + 1) % 1;
        }
        const ft = flowT[fi]!;
        const vi = fi * 3;
        flowPos[vi] = ax + (bx - ax) * ft;
        flowPos[vi + 1] = ay + (by - ay) * ft;
        flowPos[vi + 2] = az + (bz - az) * ft;
      }
    }
    bridgePosAttr.needsUpdate = true;
    flowPosAttr.needsUpdate = true;
  };

  const syncWireVisibility = (): void => {
    wireMesh.visible = wireOn;
    btnWire.textContent = wireOn ? "线框:开" : "线框:关";
  };

  // ---- 演示戳点脚本(M1 可视化驱动;seed 确定性,M4 由 demo.ts 接管) ----
  let rng: () => number;
  let nextPokeT: number;
  let pokeGapT: number;
  const scheduleReset = (): void => {
    rng = mulberry32(params.seed);
    nextPokeT = 0.5; // 首戳:场中心
    pokeGapT = 2.5;
  };
  const applyDuePokes = (): void => {
    const t = engine.stats.simTime;
    let guard = 0;
    while (nextPokeT <= t && guard++ < 64) {
      if (nextPokeT === 0.5) {
        engine.addImpulse(0.5, 0.5, 0.02, -0.02);
      } else {
        engine.addImpulse(
          0.2 + rng() * 0.6,
          0.2 + rng() * 0.6,
          0.012 + rng() * 0.008,
          -0.008 - rng() * 0.012,
        );
      }
      nextPokeT += pokeGapT;
    }
  };

  // ---- 几何同步(整改 A:面/线框位移 = 动态 h + 准静态核,烘焙总高度) ----
  const totalHeightBuf = new Float32Array(N * N);
  const bakeTotal = (): void => {
    engine.field.bakeTotalInto(totalHeightBuf);
  };
  const updateSurface = (): void => {
    for (let k = 0; k < N * N; k++) {
      surfacePos[k * 3 + 1] = totalHeightBuf[k]!;
    }
    surfacePosAttr.needsUpdate = true;
    surfaceGeo.computeBoundingSphere();
  };
  const updateWire = (): void => {
    for (let s = 0; s < wireSegs.length; s++) {
      const [a, b] = wireSegs[s]!;
      wirePos[s * 6 + 1] = totalHeightBuf[a]!;
      wirePos[s * 6 + 4] = totalHeightBuf[b]!;
    }
    wirePosAttr.needsUpdate = true;
  };

  // ---- HUD / 控制 ----
  let paused = false;
  let wireOn = true;
  syncWireVisibility();

  btnPause.addEventListener("click", () => {
    paused = !paused;
    btnPause.textContent = paused ? "继续" : "暂停";
  });
  btnStep.addEventListener("click", () => {
    paused = true;
    btnPause.textContent = "继续";
    engine.stepFixed();
    bakeTotal();
    updateSurface();
    updateWire();
    syncDroplets();
    syncBridges(0);
  });
  btnReset.addEventListener("click", () => {
    engine = new WaterEngine(params);
    scheduleReset();
    hooks.reset?.(); // 宿主时间线状态同步复位(否则重播后演示不再触发)
    bakeTotal();
    updateSurface();
    updateWire();
    syncDroplets();
  });
  btnWire.addEventListener("click", () => {
    wireOn = !wireOn;
    syncWireVisibility();
  });
  // 调试按钮(§1 非目标允许调试按钮):中心附近随机落一滴
  btnDrop.addEventListener("click", () => {
    const r = params.rMin + rng() * (params.rMax - params.rMin);
    const x = 0.35 + rng() * 0.3;
    const y = 0.35 + rng() * 0.3;
    engine.spawnDroplet(
      x,
      y,
      engine.field.totalHeight(x, y) + params.dropHeight + r,
      r,
    );
  });
  // 落桥对:两颗半径不等的液滴落在间隙 3mm 处 → drainTime 后必然成桥,
  // 半径差驱动拉普拉斯流动(小→大),供液桥与流动粒子验收
  btnPair.addEventListener("click", () => {
    const cx = 0.35 + rng() * 0.3;
    const cy = 0.35 + rng() * 0.3;
    const r1 = 0.016;
    const r2 = 0.026;
    const gap = 0.003;
    const z0 = engine.field.totalHeight(cx, cy) + params.dropHeight;
    engine.spawnDroplet(cx - (r1 + gap / 2), cy, z0 + r1, r1);
    engine.spawnDroplet(cx + (r2 + gap / 2), cy, z0 + r2, r2);
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---- 主循环:物理单一时间源(simTime),渲染只读 ----
  const clock = new THREE.Clock();
  let fpsAcc = 0;
  let fpsFrames = 0;
  let hudAt = performance.now();

  const updateHud = (): void => {
    hudTime.textContent = engine.stats.simTime.toFixed(2);
    hudSteps.textContent = String(engine.stats.stepCount);
    hudEnergy.textContent = engine.field.energy().toExponential(2);
    hudDroplets.textContent = String(engine.droplets.state.count);
    hudMerges.textContent = String(engine.stats.merges);
  };

  const captionNode = document.getElementById("gray-caption");
  const tick = (): void => {
    const frameDt = Math.min(clock.getDelta(), 0.1);
    if (!paused) {
      if (!hooks.disablePokes) applyDuePokes();
      engine.advance(frameDt);
      bakeTotal();
      updateSurface();
      updateWire();
      syncDroplets();
      syncBridges(frameDt);
      hooks.tick?.(engine, frameDt);
    }
    if (captionNode) {
      const text = paused
        ? null
        : (hooks.caption?.(engine.stats.simTime) ?? null);
      captionNode.textContent = text ?? "";
      captionNode.style.display = text ? "block" : "none";
    }
    controls.update();
    renderer.render(scene, camera);

    fpsAcc += frameDt;
    fpsFrames++;
    const now = performance.now();
    if (now - hudAt > 250) {
      hudFps.textContent = (fpsFrames / fpsAcc).toFixed(0);
      fpsAcc = 0;
      fpsFrames = 0;
      hudAt = now;
      updateHud();
    }
  };

  // WebGL 上下文丢失/恢复(§4 运行时要求):多标签/省电回收后画布会永久黑屏,
  // 必须显式处理。丢失 → 停循环 + 红字提示;恢复 → three 自动重建 GPU 资源,重启循环。
  renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    renderer.setAnimationLoop(null);
    showError("WebGL 上下文已丢失(常见于多标签切换或系统省电回收)。点击本提示或刷新页面即可恢复。");
  });
  hudError.addEventListener("click", () => {
    if (hudError.style.display !== "none") {
      hudError.style.display = "none";
    }
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    hudError.style.display = "none";
    clock.getDelta(); // 丢弃停循环期间积压的时长,避免时间跳跃
    renderer.setAnimationLoop(tick);
  });

  renderer.setAnimationLoop(tick);

  scheduleReset();
  bakeTotal();
  updateSurface();
  updateWire();
  syncDroplets();
  syncBridges(0);
  updateHud();
}

// 页面直挂:grayview.html 以本模块为入口
const app = document.getElementById("app");
if (app) {
  mountGrayViewer(app);
}
