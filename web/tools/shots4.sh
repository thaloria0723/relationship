#!/bin/bash
# B 组效果验证 · 第三次会话增补证据帧(2026-09-12)
# 三条线:① 深夜白色频闪整改(岸线呼吸压缩 + 核心峰值钳制;跨相位应均匀)
#         ② 灰滴「从无到有」(物质化 + 整颗上升;无尺寸生长)
#         ③ 文案融入式重做(无底牌光晕字;日间墨青 / 深夜月光银)
# 用法: bash tools/shots4.sh   → 输出到 docs/截图-2026-09-12-文案灰滴夜闪/
set -u
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="/Users/jenny/projects/relationship"
OUT="${ROOT}/docs/截图-2026-09-12-文案灰滴夜闪"
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

CAM="shot=1&cam=0.62&cap=1"

# ---- 第1条:夜闪修复 —— 同一取景跨 simTime 相位(间隔 1s,共 4 帧);
#      整改前同机位的实测摆幅 ≈ ±13% 整帧均值,整改后应基本均匀 ----
for pt in 480 540 600 660; do
  shot "1-夜闪-pt${pt}" "fx=8&t=5.0&pt=${pt}&shot=1&tod=night&cam=0.42&cap=0"
done

# ---- 第2条:灰滴「从无到有」序列(傍晚;前 45% 物质化,全程尺度恒 1) ----
shot "2-灰滴-t0.9-第一颗物质化中" "fx=8&t=0.9&${CAM}&tod=dusk"
shot "2-灰滴-t1.5-渐次"           "fx=8&t=1.5&${CAM}&tod=dusk"

# ---- 第3条:文案(无底牌光晕字;日间墨青 / 深夜月光银) ----
shot "3-文字-傍晚-全部就位" "fx=8&t=5.0&${CAM}&tod=dusk"
shot "3-文字-深夜-全部就位" "fx=8&t=5.0&${CAM}&tod=night"

echo "→ $OUT"
