#!/bin/sh
# 两个连接名额已满时，第三台电脑能否把耳机拉过来（QC45 黑战士）
cd "$(dirname "$0")"
HP=02:00:00:00:45:01
MBP=0200000000c3; PC=0200000000a1; IPH=0200000000b2
LOG=../fixtures/qc45_full_slots.jsonl
STATE="04040100 04050106$MBP 04050106$PC 04050106$IPH"
send() { PYTHONIOENCODING=utf-8 timeout 90 python bmap_send.py $HP --log $LOG "$@" 2>&1; }
state() { send $STATE | grep -E "\[4\.(4|5)\] STATUS" | sed 's/^/   /'; }
pause() { python -c "import time; time.sleep($1)"; }

echo "=== a) 电脑把自己踢下线"; send --wait 5 "04020506$PC"; pause 6
echo "=== b) 电脑只开控制通道，让 iPhone 连上"; send --wait 10 "0401050700$IPH"; pause 3
echo "--- b 之后的状态"; state; pause 8
echo "=== c1) 名额满时打开通道，直接连接本机"; send --wait 10 "0401050700$PC"
echo "--- c1 之后的状态"; state
echo "=== c2) 踢掉 MBP，再连接本机"; send --wait 10 "04020506$MBP" "0401050700$PC"
echo "--- c2 之后的状态"; state
