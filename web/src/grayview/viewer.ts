// ============================================================
// 灰模查看器(M1:场核可视化)
// ★ 本文件是全工程唯一 import three 的文件(纪律红线)。
// 零灯光:MeshBasicMaterial(unlit)+ LineSegments 线框,灰模零颜色渲染;
// 场景内不创建任何 Light。错误提示文字的红色是灰模里唯一的「颜色」(§6)。
// ============================================================

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { WaterEngine } from "../watersim/engine";
import { InteractionController, type SceneSnapshot } from "../interaction/controller";
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
  const btnNet = el<HTMLButtonElement>("gray-btn-net");

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
      const rEnd = 1.0 * Math.min(d.r[ia]!, d.r[ib]!);
      const rNeck = 0.62 * rEnd;
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

  // ---- 交互系统接线(模块②适配层:DOM 指针 → 意图 → 引擎;相机/灰度表现) ----
  const controller = new InteractionController();
  const snap: SceneSnapshot = {
    count: 0,
    cx: new Float32Array(params.maxDroplets),
    cy: new Float32Array(params.maxDroplets),
    cr: new Float32Array(params.maxDroplets),
  };
  let pointerValid = false;
  let pointerSX = 0;
  let pointerSY = 0;
  let pointerWorldX = 0;
  let pointerWorldY = 0;
  let pointerDown = false;
  let justDown = false;
  let focusGroup: number[] = [];
  let focusMix = 0;
  let savedCamPos: THREE.Vector3 | null = null;
  let savedCamTgt: THREE.Vector3 | null = null;
  let camAnim: {
    t: number;
    dur: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTgt: THREE.Vector3;
    toTgt: THREE.Vector3;
  } | null = null;

  const projV = new THREE.Vector3();
  const halfFov = (camera.fov * Math.PI) / 360;

  /** 指针射线与水面平面(世界 y=0)解析求交 → 引擎坐标(米) */
  const pointerToWorld = (sx: number, sy: number): { x: number; y: number } | null => {
    const ndcX = (sx / window.innerWidth) * 2 - 1;
    const ndcY = -(sy / window.innerHeight) * 2 + 1;
    projV.set(ndcX, ndcY, 0).unproject(camera);
    const nx = projV.x, ny = projV.y, nz = projV.z;
    projV.set(ndcX, ndcY, 1).unproject(camera);
    let dx = projV.x - nx, dy = projV.y - ny, dz = projV.z - nz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    if (Math.abs(dy) < 1e-6) return null;
    const t = -ny / dy;
    if (t < 0) return null;
    return { x: nx + dx * t + half, y: nz + dz * t + half };
  };

  const dimSurface = new THREE.Color(0x3c3c3c);
  const dimWire = new THREE.Color(0x242424);
  const dimBg = new THREE.Color(0x8f8f8f);
  const dimBridge = new THREE.Color(0x2e2e2e);
  const baseSurface = new THREE.Color(COLOR_SURFACE);
  const baseWire = new THREE.Color(COLOR_WIRE);
  const baseBg = new THREE.Color(COLOR_BG);
  const baseBridge = new THREE.Color(0x4a4a4a);
  const surfaceMat = surface.material as THREE.MeshBasicMaterial;
  const wireMat = wireMesh.material as THREE.LineBasicMaterial;
  const bridgeMat = bridgeMesh.material as THREE.MeshBasicMaterial;

  function startCamAnim(toPos: THREE.Vector3, toTgt: THREE.Vector3, dur: number): void {
    camAnim = {
      t: 0,
      dur,
      fromPos: camera.position.clone(),
      toPos,
      fromTgt: controls.target.clone(),
      toTgt,
    };
    controls.enabled = false;
  }

  function applyFocusMix(frameDt: number): void {
    const target = focusGroup.length > 0 ? 1 : 0;
    focusMix += (target - focusMix) * Math.min(1, frameDt * 3);
    surfaceMat.color.lerpColors(baseSurface, dimSurface, focusMix);
    wireMat.color.lerpColors(baseWire, dimWire, focusMix);
    bridgeMat.color.lerpColors(baseBridge, dimBridge, focusMix);
    (scene.background as THREE.Color).lerpColors(baseBg, dimBg, focusMix);
    // 液滴逐实例明暗:组内提亮,组外压暗(灰度,无彩色)
    const d = engine.droplets.state;
    for (let i = 0; i < d.count; i++) {
      const inGroup = focusGroup.includes(i);
      const f = inGroup ? 2.6 : 0.45;
      const k = 1 + (f - 1) * focusMix;
      colorScratch.setRGB(k, k, k);
      dropletMesh.setColorAt(i, colorScratch);
    }
    if (dropletMesh.instanceColor) dropletMesh.instanceColor.needsUpdate = true;
  }

  const colorScratch = new THREE.Color();

  function onResize2(): void {
    /* 占位:resize 逻辑复用既有监听 */
  }
  void onResize2;

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
    controller.reset();
    focusGroup = [];
    engine.setWaterHover(false, 0, 0);
    engine.setDropletHover(-1);
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
  // 网络场景(调优 #6):中心+六边形 7 滴确定性布点,辐射桥+环桥全成网
  btnNet.addEventListener("click", () => {
    const rc = 0.022;
    const rr = 0.016;
    const ring = 0.034; // 六边形半径:中心-辐条与相邻环边均落在桥接区间
    const z0 = engine.field.totalHeight(0.5, 0.5) + params.dropHeight;
    engine.spawnDroplet(0.5, 0.5, z0 + rc, rc);
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2;
      const x = 0.5 + Math.cos(ang) * ring;
      const y = 0.5 + Math.sin(ang) * ring;
      const r = k % 2 === 0 ? rr : rr * 0.82;
      engine.spawnDroplet(x, y, engine.field.totalHeight(x, y) + params.dropHeight + r, r);
    }
  });

  // ---- 模块②指针适配(DOM → 采样;Esc = 焦点退出) ----
  const dom = renderer.domElement;
  dom.addEventListener("pointermove", (e) => {
    pointerSX = e.clientX;
    pointerSY = e.clientY;
    pointerValid = true;
  });
  dom.addEventListener("pointerdown", (e) => {
    pointerSX = e.clientX;
    pointerSY = e.clientY;
    pointerValid = true;
    pointerDown = true;
    justDown = true;
  });
  window.addEventListener("pointerup", () => {
    pointerDown = false;
  });
  dom.addEventListener("pointerleave", () => {
    pointerValid = false;
    pointerDown = false;
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const intent = controller.escape();
    if (intent && intent.kind === "focusExit") {
      engine.exitFocus();
      focusGroup = [];
      if (savedCamPos && savedCamTgt) startCamAnim(savedCamPos, savedCamTgt, 0.6);
    }
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
  const tick = (render: boolean): void => {
    const frameDt = Math.min(clock.getDelta(), 0.1);
    if (!paused) {
      if (!hooks.disablePokes) applyDuePokes();
      // ---- 模块②:场景快照 → 控制器 → 意图 → 引擎 ----
      const dstate = engine.droplets.state;
      snap.count = dstate.count;
      for (let i = 0; i < dstate.count; i++) {
        projV.set(dstate.x[i]! - half, dstate.z[i]!, dstate.y[i]! - half);
        const dist = camera.position.distanceTo(projV);
        projV.project(camera);
        snap.cx[i] = ((projV.x + 1) / 2) * window.innerWidth;
        snap.cy[i] = ((1 - projV.y) / 2) * window.innerHeight;
        snap.cr[i] = (dstate.r[i]! * (window.innerHeight * 0.5)) / (halfFov * dist + 1e-6);
      }
      const wHit = pointerValid ? pointerToWorld(pointerSX, pointerSY) : null;
      if (wHit) {
        pointerWorldX = wHit.x;
        pointerWorldY = wHit.y;
      }
      const intents = controller.update(
        snap,
        {
          sx: pointerSX,
          sy: pointerSY,
          valid: pointerValid && wHit !== null,
          worldX: pointerWorldX,
          worldY: pointerWorldY,
          down: pointerDown,
        },
        engine.stats.simTime,
        justDown,
      );
      justDown = false;
      for (const it of intents) {
        switch (it.kind) {
          case "hoverWater":
            engine.setWaterHover(true, it.x, it.y);
            engine.setDropletHover(-1);
            break;
          case "hoverDroplet":
            engine.setWaterHover(false, 0, 0);
            engine.setDropletHover(it.index);
            break;
          case "dragStart":
            engine.setWaterHover(false, 0, 0);
            engine.beginDrag(it.index, it.x, it.y);
            break;
          case "dragMove":
            engine.moveDrag(it.x, it.y);
            break;
          case "dragEnd":
            engine.endDrag();
            break;
          case "focusEnter": {
            engine.setWaterHover(false, 0, 0);
            engine.setDropletHover(-1);
            focusGroup = engine.enterFocus(it.index);
            if (focusGroup.length > 0) {
              savedCamPos = camera.position.clone();
              savedCamTgt = controls.target.clone();
              let cxs = 0;
              let czs = 0;
              for (const m of focusGroup) {
                cxs += engine.droplets.state.x[m]!;
                czs += engine.droplets.state.y[m]!;
              }
              const ccx = cxs / focusGroup.length - half;
              const ccz = czs / focusGroup.length - half;
              startCamAnim(
                new THREE.Vector3(ccx, 0.3, ccz + 0.02),
                new THREE.Vector3(ccx, 0, ccz),
                0.6,
              );
            }
            break;
          }
          case "focusExit":
            engine.exitFocus();
            focusGroup = [];
            if (savedCamPos && savedCamTgt) {
              startCamAnim(savedCamPos, savedCamTgt, 0.6);
            }
            break;
        }
      }
      // 持续意图(相位驱动;事件只在校沿发,悬停态需逐帧供能)
      if (controller.phase === "idle" && pointerValid) {
        engine.setWaterHover(true, pointerWorldX, pointerWorldY);
      } else if (controller.phase !== "idle") {
        engine.setWaterHover(false, 0, 0);
      }
      if (controller.phase === "hover") {
        engine.setDropletHover(controller.target);
      } else {
        engine.setDropletHover(-1);
      }
      engine.advance(frameDt);
      // 相机缓动 + 灰度压暗/高亮
      if (camAnim) {
        camAnim.t += frameDt;
        const k = Math.min(1, camAnim.t / camAnim.dur);
        const ease = k * k * (3 - 2 * k);
        camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, ease);
        controls.target.lerpVectors(camAnim.fromTgt, camAnim.toTgt, ease);
        if (k >= 1) {
          camAnim = null;
          controls.enabled = focusGroup.length === 0;
        }
      }
      applyFocusMix(frameDt);
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
    camera.updateMatrixWorld(true);
    if (render) {
      bakeTotal();
      updateSurface();
      updateWire();
      syncDroplets();
      syncBridges(frameDt);
      renderer.render(scene, camera);
    }

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
    renderer.setAnimationLoop(() => tick(true));
  });

  let lastRafAt = performance.now();
  renderer.setAnimationLoop(() => {
    lastRafAt = performance.now();
    tick(true);
  });

  // 后台心跳(§4 运行时):隐藏标签与窗口遮挡都会停 rAF(document.hidden 检测
  // 不到遮挡);worker 拍子发现 rAF 断供 >250ms 即接管,只推进物理(渲染跳过),
  // demo 时间线与灰模验收不因标签切换/遮挡而冻结
  const heartbeat = new Worker(new URL("./heartbeat.ts", import.meta.url), {
    type: "module",
  });
  heartbeat.onmessage = () => {
    if (performance.now() - lastRafAt > 250) tick(false);
  };

  // dev 探针:控制台可 (window as any).__gray.engine / .screenOf(i) 观测引擎态
  (window as unknown as { __gray: object }).__gray = {
    get engine() {
      return engine;
    },
    get controller() {
      return controller;
    },
    get camera() {
      return camera;
    },
    get camTarget() {
      return controls.target;
    },
    screenOf(i: number): [number, number, number] {
      const d = engine.droplets.state;
      const v = new THREE.Vector3(
        d.x[i]! - half,
        d.z[i]!,
        d.y[i]! - half,
      );
      const dist = camera.position.distanceTo(v);
      v.project(camera);
      return [
        ((v.x + 1) / 2) * window.innerWidth,
        ((1 - v.y) / 2) * window.innerHeight,
        (d.r[i]! * (window.innerHeight * 0.5)) / (halfFov * dist),
      ];
    },
  };

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
