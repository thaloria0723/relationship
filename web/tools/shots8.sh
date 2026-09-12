#!/bin/bash
# 大转折 · 光点二次整改证据帧(2026-09-12 第二段续)
# 委托方二次整改两点:① 炸裂光点**分散到原液滴四周** + 炸裂后**凝滞一瞬**;
#                    ② **正午水面偏亮** —— 按「量—调—再量」做正午组合标定。
# 用法: bash tools/shots8.sh   → 输出到 docs/截图-2026-09-12-光点二次整改/
set -u
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="/Users/jenny/projects/relationship"
OUT="${ROOT}/docs/截图-2026-09-12-光点二次整改"
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

# ---- 第1条:炸裂 → 四周分散 → 凝滞 → 吸入(傍晚;近机位看编排) ----
CAM6="shot=1&fx=9&cam=0.5&cap=1&tod=dusk"
shot "1-编排-t0.30-炸裂初"      "${CAM6}&t=0.30"
shot "1-编排-t0.45-四周分散"    "${CAM6}&t=0.45"
shot "1-编排-t0.60-凝滞"        "${CAM6}&t=0.60"
shot "1-编排-t0.75-收拢入涡"    "${CAM6}&t=0.75"
shot "1-编排-t0.90-漩涡"        "${CAM6}&t=0.90"
shot "1-编排-t1.05-吸入末"      "${CAM6}&t=1.05"
CAM9="shot=1&fx=9&cam=0.95&cap=1&tod=dusk"
shot "1-全net-t0.50-分散"       "${CAM9}&t=0.50"
shot "1-全net-t1.15-凝聚中"     "${CAM9}&t=1.15"
shot "1-全net-t1.45-凝滞巨滴"   "${CAM9}&t=1.45"

# ---- 第2条:深夜(光点发光;分散/凝滞/吸入) ----
CAMN="shot=1&fx=9&cam=0.5&cap=1&tod=night"
shot "2-深夜-t0.45-四周分散"    "${CAMN}&t=0.45"
shot "2-深夜-t0.60-凝滞"        "${CAMN}&t=0.60"
shot "2-深夜-t0.90-漩涡"        "${CAMN}&t=0.90"
shot "2-深夜-t2.15-爆散光点"    "${CAMN}&t=2.15"

# ---- 第3条:正午降亮(整改前基线在 /tmp/tod/noon.png,同机位同参数) ----
shot "3-正午-基线fx0"           "fx=0&shot=1&cam=0.62&tod=noon"
shot "3-正午-光点t0.60"         "shot=1&fx=9&cam=0.5&cap=1&tod=noon&t=0.60"
shot "3-正午-光点t0.90"         "shot=1&fx=9&cam=0.5&cap=1&tod=noon&t=0.90"
shot "3-正午-全net-t1.45"       "shot=1&fx=9&cam=0.95&cap=1&tod=noon&t=1.45"

# ---- 第4条:炸裂之后(外观同物种;运动/时序不动) + 傍晚基线对照 ----
shot "4-之后-t2.15-光点飞射"    "${CAM9}&t=2.15"
shot "4-之后-t3.25-定格新网"    "${CAM9}&t=3.25"
shot "4-基线-fx0-傍晚"          "fx=0&shot=1&cam=0.62&tod=dusk"

echo "→ $OUT"
