#!/bin/bash
# 大转场动画 · 证据帧(2026-09-12)
# 三条线:① 大转折三阶段序列(fx=9:汇聚 → 过渡 → 迸发 → 定格,动效 §5 / 规格 §8.3)
#         ② 文字上滴 v3(无底牌无边框;名字压滴心,日夜各一帧)
#         ③ fx=0 基线对照(未注入效果通道的行为不回归)
# 用法: bash tools/shots5.sh   → 输出到 docs/截图-2026-09-12-大转场/
set -u
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="/Users/jenny/projects/relationship"
OUT="${ROOT}/docs/截图-2026-09-12-大转场"
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

# ---- 第1条:大转折序列(傍晚;机位覆盖整张网;cap=1 带张力读数) ----
CAM9="shot=1&fx=9&cam=0.95&cap=1&tod=dusk"
shot "1-转折-t0.4-汇聚前段"   "${CAM9}&t=0.4"
shot "1-转折-t0.55-汇聚中段卷曲" "${CAM9}&t=0.55"
shot "1-转折-t0.8-汇聚后段"     "${CAM9}&t=0.8"
shot "1-转折-t1.4-巨滴悬停雾裹" "${CAM9}&t=1.4"
shot "1-转折-t1.82-爆散闪光"   "${CAM9}&t=1.82"
shot "1-转折-t2.15-火花飞射"   "${CAM9}&t=2.15"
shot "1-转折-t2.45-减速悬停"   "${CAM9}&t=2.45"
shot "1-转折-t2.75-牵引归位"   "${CAM9}&t=2.75"
shot "1-转折-t3.25-定格新网"   "${CAM9}&t=3.25"

# ---- 第2条:文字上滴 v3(无底牌无边框;名字压滴心) ----
shot "2-文字v3-傍晚-名字压滴心" "fx=8&t=5.0&shot=1&cam=0.62&cap=1&tod=dusk"
shot "2-文字v3-深夜-名字压滴心" "fx=8&t=5.0&shot=1&cam=0.62&cap=1&tod=night"

# ---- 第3条:基线对照(未注入效果;应与 B 组验证前的基线观感一致) ----
shot "3-基线-fx0" "fx=0&shot=1&cam=0.62&tod=dusk"

echo "→ $OUT"
