#!/bin/bash
# round 30 baseline on the published site :8197 (tester 3). Local-noon hour per place = 12 - (lon - 39.29)/15
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e3; mkdir -p logs
L="lockf /tmp/nomads-gpu.lock bun"
look() { hr=$1; shift; Q="hour=$hr&warm=0" $L look.ts st30 "$@" 2>&1 | tail -1; }
look 17.2 "4.35,-39.38,-2;-1;1;3;4;6"
look 11.7 "-35.9,43.59,-2;-1;1;3;6"
look 17.3 "-25.71,-40.51,-2;1;3;5"
look 8.7 "8.32,88.30,-1;1;3" "12.02,83.89,-1;1;2.5;4"
look 11.6 "13.27,45,-1;2;4;6"
look 12 "49.02,39.29,8.27;5;3;1;-1"
look 13.6 "25,15,-2;-1;0;2;5"
look 17 "-35.26,-135,3;4.5"
echo stills done > logs/st30.done
./round.sh 310:1280x800 311:1920x1080 312:800x1000 313:1280x800
ONLY=EQ,PE,CO,CS ZS=-2,1.5,3 $L dragedge.ts dragedge-r30.json 2>&1 | cut -c1-200 > logs/dragedge-r30.log
$L burstx.ts 2>&1 | cut -c1-200 > logs/burst-r30.log
$L arrsettle.ts 2>&1 | cut -c1-260 > logs/arrsettle-r30.log
LATS=20,42,58,89.96 FR=0.5,0.9 $L orbitroll.ts orbitroll30 2>&1 | cut -c1-230 > logs/orbitroll-r30.log
$L treetest.ts tree-A30 4.35 -39.38 4.6 3.5 2>&1 | tail -1 > logs/tree-r30.log
echo base30 done > logs/base30.done
