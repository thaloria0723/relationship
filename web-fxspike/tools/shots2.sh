#!/bin/bash
# B 组效果验证 · 第二轮证据帧(2026-09-11)
# 用法: bash tools/shots2.sh [tod]   → 输出到 docs/截图-2026-09-11-B组第二轮/
set -u
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="/Users/jenny/projects/relationship"
OUT="${ROOT}/docs/截图-2026-09-11-B组第二轮"
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

TOD="${1:-dusk}"
CAM="shot=1&tod=$TOD&cap=1"

# ---- 第1条:剖面读法——同一机位下各状态的桥(近景特写) ----
for m in 0 1 2 3 4 7; do
  shot "1-剖面-$m" "fx=$m&$CAM&cam=0.17&tx=0.12"
done

# ---- 第2条:融合提速 + 气泡 ----
shot "2-融合-气泡环" "fx=1&$CAM&cam=0.17&tx=0.12"
shot "2-融合-全景"   "fx=1&$CAM&cam=0.34"

# ---- 第3条:潜流受鼠标控制(探针同时给出读数) ----
shot "3-潜流-指针在桥上"   "fx=5&$CAM&probe=1&px=640&py=388&cam=0.42"
shot "3-潜流-指针在远处"   "fx=5&$CAM&probe=1&px=640&py=180&cam=0.42"
shot "3-潜流-指针离开画布" "fx=5&$CAM&probe=1&px=640&py=388&pleave=1&cam=0.42"

# ---- 第4条:对撞是**循环**(周期 1.25s) ----
shot "4-对撞-0.05s-本轮两端亮起"     "fx=3&$CAM&t=0.05"
shot "4-对撞-0.60s-相向推进中"       "fx=3&$CAM&t=0.60"
shot "4-对撞-1.05s-中心融合"         "fx=3&$CAM&t=1.05"
shot "4-对撞-1.30s-下一轮两端又亮起" "fx=3&$CAM&t=1.30"

# ---- 第5条:死亡后的水底光影(溶解完成 → 退场收尾 → 残雾散尽) ----
shot "5-死亡-a-溶解完成-水底还有影" "fx=7&$CAM&t=2.34"
shot "5-死亡-b-退场收尾-影消失雾仍在" "fx=7&$CAM&t=2.36"
shot "5-死亡-c-残雾散尽-水底干净"   "fx=7&$CAM&t=3.20"

# ---- 第6条:聚焦未在场灰滴 ----
for s in "0.40:未浮现" "1.30:第一颗在起" "2.60:渐次浮现中" "5.00:全部就位"; do
  IFS=: read -r t lbl <<< "$s"
  shot "6-聚焦-$t-$lbl" "fx=8&$CAM&t=$t&cam=0.62"
done

echo "→ $OUT"
