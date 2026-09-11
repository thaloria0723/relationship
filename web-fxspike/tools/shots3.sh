#!/bin/bash
# B 组效果验证 · 增补证据帧(2026-09-11 第三次会话)
# 两条线:① 粗细可变(A-2 唯一入口;fx=0 验证「不属于状态」)
#         ② 文字叠层(HTML 方案;fx=8 聚焦场景)
# 用法: bash tools/shots3.sh [tod]   → 输出到 docs/截图-2026-09-11-B组增补/
set -u
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="/Users/jenny/projects/relationship"
OUT="${ROOT}/docs/截图-2026-09-11-B组增补"
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

# ---- 第1条:粗细可变(同一机位、同一时刻,只改 ?thick=) ----
shot "1-粗细-0.70-下段"   "fx=0&thick=0.70&$CAM&cam=0.17&tx=0.12"
shot "1-粗细-1.00-基准"   "fx=0&thick=1.00&$CAM&cam=0.17&tx=0.12"
shot "1-粗细-1.85-上限"   "fx=0&thick=1.85&$CAM&cam=0.17&tx=0.12"
shot "1-粗细-3.00-超限被钳" "fx=0&thick=3.00&$CAM&cam=0.17&tx=0.12"

# ---- 第2条:文字叠层(HTML;fx=8 聚焦场景) ----
shot "2-文字-t1.8-渐显中"   "fx=8&t=1.8&$CAM&cam=0.62"
shot "2-文字-t5.0-全部就位" "fx=8&t=5.0&$CAM&cam=0.62"

echo "→ $OUT"
