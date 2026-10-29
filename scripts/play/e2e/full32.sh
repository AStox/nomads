#!/bin/bash
# round 32: full round on the published site after the camera-follows-motion set
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e3; mkdir -p logs; export SITE=http://127.0.0.1:8197
L="lockf /tmp/nomads-gpu.lock bun"
look() { hr=$1; shift; Q="hour=$hr&warm=0" $L look.ts st32 "$@" 2>&1 | tail -1; }
$L frameseq.ts frameseq-r32.json > logs/frameseq-r32.log 2>&1
VP=1280x800 PLACES=B,A,R,H,M,E2,D ZS=0,1.8 DIRS=N,E,S $L dragscan.ts r32-slow.json > logs/r32-slow.log 2>&1
HOLD=0 SPD=3 STEPS=20 VP=1280x800 PLACES=B,A,H,R ZS=0,1.8 DIRS=N,E,W $L dragscan.ts r32-flick.json > logs/r32-flick.log 2>&1
HOLD=0 SPD=3 STEPS=20 VP=1920x1080 PLACES=B,A ZS=-0.92,1 DIRS=N,NE $L dragscan.ts r32-flick1920.json > logs/r32-flick1920.log 2>&1
VP=800x1000 PLACES=B,A ZS=0,1.8 DIRS=N,NE $L dragscan.ts r32-slow800.json > logs/r32-slow800.log 2>&1
ONLY=EQ,PE,CO,CS ZS=-2,1.5,3 $L dragedge.ts dragedge-r32.json 2>&1 | cut -c1-200 > logs/dragedge-r32.log
$L burstx.ts 2>&1 | cut -c1-200 > logs/burst-r32.log
SEED=11 N=24 $L randburst.ts randburst-r32.json > logs/randburst-r32.log 2>&1
$L burstinertia.ts > logs/burstinertia-r32.log 2>&1
for c in c1 c2 c3 c4 c5; do $L burstfresh.ts $c 2>&1 | cut -c1-260 >> logs/burstfresh-r32.log; done
$L arrsettle.ts 2>&1 | cut -c1-260 > logs/arrsettle-r32.log
LATS=20,42,58,89.96 FR=0.5,0.9 $L orbitroll.ts orbitroll32 2>&1 | cut -c1-230 > logs/orbitroll-r32.log
$L treetest.ts tree-A32 4.35 -39.38 4.6 3.5 2>&1 | tail -1 > logs/tree-r32.log
./round.sh 330:1280x800 331:1920x1080 332:800x1000 333:1280x800
look 17.2 "4.35,-39.38,-2;-1;1;3;4;6"
look 11.7 "-35.9,43.59,-2;-1;1;3;6"
look 17.3 "-25.71,-40.51,-2;1;3;5"
look 8.7 "8.32,88.30,-1;1;3" "12.02,83.89,-1;1;2.5;4"
look 11.6 "13.27,45,-1;2;4;6"
look 12 "49.02,39.29,8.27;5;3;1;-1"
look 13.6 "25,15,-2;-1;0;2;5"
echo done > logs/full32.done
