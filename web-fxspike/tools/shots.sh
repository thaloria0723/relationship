#!/bin/bash
# B 组效果验证 · 取帧(带说明叠字;确定性:驱动器冻结 + 仿真暂停)
set -u
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="/tmp/fxshots"
PORT="5177"
BASE="http://localhost:${PORT}/fxspike.html"
mkdir -p "$OUT"

shot() {
  local name="$1" query="$2" size="${3:-1280,720}"
  rm -f "$OUT/$name.png"
  # 用真实 GPU:SwiftShader 软件光栅在满载机器上约 150s/帧,GPU 约 2.6s/帧
  "$CH" --headless=new --no-sandbox --hide-scrollbars \
    --window-size="$size" --virtual-time-budget=25000 \
    --screenshot="$OUT/$name.png" "${BASE}?${query}" >/dev/null 2>&1
  if [ -f "$OUT/$name.png" ]; then echo "OK   $name"; else echo "FAIL $name"; fi
}

TOD="${1:-noon}"

# ---- 全景(两滴一桥,看效果在场景里的读感) ----
for m in 0 1 2 3 4; do
  shot "$TOD-pan-$m" "fx=$m&shot=1&tod=$TOD&cam=0.34&cap=1"
done
shot "$TOD-pan-5-hidden" "fx=5&shot=1&tod=$TOD&cam=0.34&cap=1&reveal=0"
shot "$TOD-pan-5-reveal" "fx=5&shot=1&tod=$TOD&cam=0.34&cap=1&reveal=1"

# ---- 凝结登场:起雾 → 成形 → 抽桥(近景对主角滴) ----
shot "$TOD-cx-6-fog"  "fx=6&shot=1&tod=$TOD&cam=0.17&tx=0.12&cap=1&t=0.55"
shot "$TOD-cx-6-form" "fx=6&shot=1&tod=$TOD&cam=0.17&tx=0.12&cap=1&t=1.35"
shot "$TOD-cx-6-grow" "fx=6&shot=1&tod=$TOD&cam=0.30&tx=0.06&cap=1&t=2.0"

# ---- 死亡蒸发:沸腾 → 汽化 → 溶解 → 残雾(近景) ----
shot "$TOD-cx-7-boil"     "fx=7&shot=1&tod=$TOD&cam=0.17&tx=0.12&cap=1&t=0.85"
shot "$TOD-cx-7-vapor"    "fx=7&shot=1&tod=$TOD&cam=0.17&tx=0.12&cap=1&t=1.55"
shot "$TOD-cx-7-dissolve" "fx=7&shot=1&tod=$TOD&cam=0.17&tx=0.12&cap=1&t=2.2"
shot "$TOD-cx-7-ash"      "fx=7&shot=1&tod=$TOD&cam=0.30&tx=0.06&cap=1&t=2.7"
