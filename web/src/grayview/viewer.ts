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

export function mountGrayViewer(
  container: HTMLElement,
  params: WaterSimParams = defaultParams,
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
  });
  btnReset.addEventListener("click", () => {
    engine = new WaterEngine(params);
    scheduleReset();
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

  renderer.setAnimationLoop(() => {
    const frameDt = Math.min(clock.getDelta(), 0.1);
    if (!paused) {
      applyDuePokes();
      engine.advance(frameDt);
      bakeTotal();
      updateSurface();
      updateWire();
      syncDroplets();
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
  });

  scheduleReset();
  bakeTotal();
  updateSurface();
  updateWire();
  updateHud();
}

// 页面直挂:grayview.html 以本模块为入口
const app = document.getElementById("app");
if (app) {
  mountGrayViewer(app);
}
