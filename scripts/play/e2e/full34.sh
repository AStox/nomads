#!/bin/bash
# round 34: full round on the published arrival build 0f4ac71
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e3; mkdir -p logs; export SITE=http://127.0.0.1:8197
L="lockf /tmp/nomads-gpu.lock bun"
for rep in 1 2; do ARR=all $L arrsettle.ts 2>&1 | cut -c1-400 > logs/arr-all-r34-$rep.log; done
$L arrsettle.ts 2>&1 | cut -c1-260 > logs/arrsettle-r34.log
VP=1280x800 PLACES=B,A,H,R,M,E2,D ZS=0,1.8 DIRS=N,E,S $L dragscan.ts r34-slow.json > logs/r34-slow.log 2>&1
HOLD=0 SPD=3 STEPS=20 VP=1280x800 PLACES=B,A,H,R ZS=0,1.8 DIRS=N,E,W $L dragscan.ts r34-flick.json > logs/r34-flick.log 2>&1
HOLD=0 SPD=3 STEPS=20 VP=1920x1080 PLACES=B,A ZS=-0.92,1 DIRS=N,NE $L dragscan.ts r34-flick1920.json > logs/r34-flick1920.log 2>&1
VP=800x1000 PLACES=B,A ZS=0,1.8 DIRS=N,NE $L dragscan.ts r34-slow800.json > logs/r34-slow800.log 2>&1
ONLY=EQ,PE,CO,CS ZS=-2,1.5,3 $L dragedge.ts dragedge-r34.json 2>&1 | cut -c1-200 > logs/dragedge-r34.log
$L burstx.ts 2>&1 | cut -c1-200 > logs/burst-r34.log
SEED=34 N=24 $L randburst.ts randburst-r34.json > logs/randburst-r34.log 2>&1
$L burstinertia.ts > logs/burstinertia-r34.log 2>&1
for c in c1 c2 c3 c4 c5; do $L burstfresh.ts $c 2>&1 | cut -c1-260 >> logs/burstfresh-r34.log; done
LATS=20,42,58,89.96 FR=0.5,0.9 $L orbitroll.ts orbitroll34 2>&1 | cut -c1-230 > logs/orbitroll-r34.log
$L treetest.ts tree-A34 4.35 -39.38 4.6 3.5 2>&1 | tail -1 > logs/tree-r34.log
SITE=http://127.0.0.1:8197 PROFILE=$HOME/.cache/nomads-scratch/e2e3/chrome-perf REC=1 TAG=pub $L perf/scripts/play/audit/perf/inputhz.ts 2>&1 | cut -c1-600 > logs/inputhz-r34.log
./round.sh 350:1280x800 351:1920x1080 352:800x1000 353:1280x800
echo done > logs/full34.done
