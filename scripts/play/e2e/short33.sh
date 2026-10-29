#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e3; mkdir -p logs; export SITE=http://127.0.0.1:8197
L="lockf /tmp/nomads-gpu.lock bun"
look() { hr=$1; shift; Q="hour=$hr&warm=0" $L look.ts st33 "$@" 2>&1 | tail -1; }
look 17.2 "4.35,-39.38,-2;-1;1;3;4;6"
look 11.7 "-35.9,43.59,-2;-1;1;3;6"
look 17.3 "-25.71,-40.51,-2;1;3;5"
look 8.7 "8.32,88.30,-1;1;3" "12.02,83.89,-1;1;2.5;4"
look 11.6 "13.27,45,-1;2;4;6"
look 12 "49.02,39.29,8.27;5;3;1;-1"
look 13.6 "25,15,-2;-1;0;2;5"
echo stills > logs/st33.done
VP=1280x800 PLACES=B,A,H,R,D ZS=0,1.8 DIRS=N,E $L dragscan.ts r33-slow.json > logs/r33-slow.log 2>&1
HOLD=0 SPD=3 STEPS=20 VP=1280x800 PLACES=B,A,H ZS=0,1.8 DIRS=N,E,W $L dragscan.ts r33-flick.json > logs/r33-flick.log 2>&1
$L burstx.ts 2>&1 | cut -c1-200 > logs/burst-r33.log
SEED=33 N=24 $L randburst.ts randburst-r33.json > logs/randburst-r33.log 2>&1
$L burstinertia.ts > logs/burstinertia-r33.log 2>&1
for c in c1 c2 c3 c4 c5; do $L burstfresh.ts $c 2>&1 | cut -c1-260 >> logs/burstfresh-r33.log; done
$L arrsettle.ts 2>&1 | cut -c1-260 > logs/arrsettle-r33.log
$L treetest.ts tree-A33 4.35 -39.38 4.6 3.5 2>&1 | tail -1 > logs/tree-r33.log
./round.sh 340:1280x800 341:1920x1080
echo done > logs/short33.done
