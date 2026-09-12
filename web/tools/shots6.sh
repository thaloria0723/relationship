#!/bin/bash
# 大转折 · 汇聚段整改证据帧(2026-09-12 第二段)
# 委托方整改点:旧滴**溃散成光点** → 光点**漩涡向心** → **凝聚成巨滴(从无到有)**
# → 巨滴**凝滞一瞬** → 炸裂;**炸裂之后不变**(本脚本用 t1.82/2.15/3.25 三帧对照)。
# 用法: bash tools/shots6.sh   → 输出到 docs/截图-2026-09-12-汇聚整改/
set -u
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="/Users/jenny/projects/relationship"
OUT="${ROOT}/docs/截图-2026-09-12-汇聚整改"
PORT="${PORT:-5177}"
BASE="http://localhost:${PORT}/fxspike.html"
mkdir -p "$OUT"

shot() {
  local name="$1" query="$2" size="${3:-1280,720}"
  rm -f "$OUT/$name.png"
  "$CH" --headless=new --no-sandbox --hide-scrollbars \
    --window-size="$size" --virtual-time-budget=25000 \
    --screenshot="$OUT/$name.png" "${BASE}?${query}" >/dev/null 2>&1
  if [ -f "$OUT/$name.png" ]; then echo "OK   $name"; else echo "FAIL $name"; fi
}

# ---- 汇聚段序列(傍晚;与上轮同一机位 cam=0.95&cap=1&tod=dusk,便于逐帧对照) ----
CAM9="shot=1&fx=9&cam=0.95&cap=1&tod=dusk"
shot "1-汇聚-t0.10-预兆桥卷曲"  "${CAM9}&t=0.10"
shot "1-汇聚-t0.30-溃散初"      "${CAM9}&t=0.30"
shot "1-汇聚-t0.50-溃散晚光点起飞" "${CAM9}&t=0.50"
shot "1-汇聚-t0.75-漩涡中段"    "${CAM9}&t=0.75"
shot "1-汇聚-t0.95-漩涡末凝聚初" "${CAM9}&t=0.95"
shot "1-汇聚-t1.15-凝聚中"      "${CAM9}&t=1.15"
shot "1-汇聚-t1.45-凝滞巨滴"    "${CAM9}&t=1.45"
shot "1-汇聚-t1.70-凝滞末"      "${CAM9}&t=1.70"
# ---- 特写(近机位):判「溃散质感 / 光点与爆散火花同款」用 ----
CAM6="shot=1&fx=9&cam=0.5&cap=1&tod=dusk"
shot "1-特写-t0.35-溃散中"      "${CAM6}&t=0.35"
shot "1-特写-t0.60-光点起飞"    "${CAM6}&t=0.60"
# ---- 漩涡序列(同机位、等间隔 0.1s):静帧逐帧读出「螺旋收紧」的运动 ----
shot "1-特写-t0.70-漩涡1"       "${CAM6}&t=0.70"
shot "1-特写-t0.80-漩涡2"       "${CAM6}&t=0.80"
shot "1-特写-t0.90-漩涡3"       "${CAM6}&t=0.90"
shot "1-特写-t1.00-漩涡4"       "${CAM6}&t=1.00"
# ---- 炸裂之后:应与上轮证据帧逐参数一致(不回归) ----
shot "2-之后-t1.82-爆散闪光"    "${CAM9}&t=1.82"
shot "2-之后-t2.15-火花飞射"    "${CAM9}&t=2.15"
shot "2-之后-t3.25-定格新网"    "${CAM9}&t=3.25"
# ---- 基线对照(未注入效果;fxSource=null 路径不回归) ----
shot "3-基线-fx0" "fx=0&shot=1&cam=0.62&tod=dusk"

echo "→ $OUT"
