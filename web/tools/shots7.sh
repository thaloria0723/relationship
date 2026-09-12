#!/bin/bash
# 大转折 · 光点整改证据帧(2026-09-12 第二段续)
# 委托方二次整改点:① 原液滴**炸裂**成**纯粹的光点**(体积小、易悬浮飘散);
#                    ② **深夜**模式下光点要**发光**,和原液滴一样;
#                    ③ 爆散段一起换成同一种光点(同日裁定;数量/时序/运动不动)。
# 用法: bash tools/shots7.sh   → 输出到 docs/截图-2026-09-12-光点整改/
set -u
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="/Users/jenny/projects/relationship"
OUT="${ROOT}/docs/截图-2026-09-12-光点整改"
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

# ---- 第1条:白天(傍晚)汇聚序列 + 特写 + 漩涡序列 ----
CAM9="shot=1&fx=9&cam=0.95&cap=1&tod=dusk"
shot "1-汇聚-t0.10-预兆"        "${CAM9}&t=0.10"
shot "1-汇聚-t0.30-炸裂初"      "${CAM9}&t=0.30"
shot "1-汇聚-t0.50-炸裂晚"      "${CAM9}&t=0.50"
shot "1-汇聚-t0.75-漩涡中段"    "${CAM9}&t=0.75"
shot "1-汇聚-t0.95-漩涡末凝聚初" "${CAM9}&t=0.95"
shot "1-汇聚-t1.15-凝聚中"      "${CAM9}&t=1.15"
shot "1-汇聚-t1.45-凝滞巨滴"    "${CAM9}&t=1.45"
CAM6="shot=1&fx=9&cam=0.5&cap=1&tod=dusk"
shot "1-特写-t0.35-炸裂中"      "${CAM6}&t=0.35"
shot "1-特写-t0.60-光点起飞"    "${CAM6}&t=0.60"
shot "1-特写-t0.80-漩涡2"       "${CAM6}&t=0.80"
shot "1-特写-t1.00-漩涡4"       "${CAM6}&t=1.00"

# ---- 第2条:**深夜**——光点要发光(和原液滴一样) ----
CAMN="shot=1&fx=9&cam=0.95&cap=1&tod=night"
shot "2-深夜-t0.50-炸裂晚"      "${CAMN}&t=0.50"
shot "2-深夜-t0.80-漩涡"        "${CAMN}&t=0.80"
shot "2-深夜-t1.00-凝聚中"      "${CAMN}&t=1.00"
shot "2-深夜-t1.45-凝滞巨滴"    "${CAMN}&t=1.45"
shot "2-深夜-t2.15-爆散光点"    "${CAMN}&t=2.15"
CAMN6="shot=1&fx=9&cam=0.5&cap=1&tod=night"
shot "2-深夜特写-t0.80-光点"    "${CAMN6}&t=0.80"

# ---- 第3条:炸裂之后(外观换成同种光点;运动/时序/数量不动) ----
shot "3-之后-t1.82-爆散闪光"    "${CAM9}&t=1.82"
shot "3-之后-t2.15-光点飞射"    "${CAM9}&t=2.15"
shot "3-之后-t3.25-定格新网"    "${CAM9}&t=3.25"
# ---- 基线对照 ----
shot "4-基线-fx0" "fx=0&shot=1&cam=0.62&tod=dusk"

echo "→ $OUT"
