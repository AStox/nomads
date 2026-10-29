#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e3; export SITE=http://127.0.0.1:8472
L="lockf /tmp/nomads-gpu.lock bun"
./round.sh 320:1280x800 321:1920x1080 322:800x1000 323:1280x800
ONLY=EQ,PE,CO,CS ZS=-2,1.5,3 $L dragedge.ts dragedge-br.json 2>&1 | cut -c1-200 > logs/dragedge-br.log
$L arrsettle.ts 2>&1 | cut -c1-260 > logs/arrsettle-br.log
LATS=20,42,58,89.96 FR=0.5,0.9 $L orbitroll.ts orbitroll-br 2>&1 | cut -c1-230 > logs/orbitroll-br.log
$L treetest.ts tree-br 4.35 -39.38 4.6 3.5 2>&1 | tail -1 > logs/tree-br.log
echo done > logs/br31c.done
