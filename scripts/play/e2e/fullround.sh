#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e
./round.sh 202:1280x800 203:1920x1080 204:800x1000 205:1280x800
ONLY=EQ,PE,CO,CS ZS=-2,1.5,3 lockf /tmp/nomads-gpu.lock bun dragedge.ts dragedge-r26.json 2>&1 | cut -c1-200 > logs/dragedge-r26.log
lockf /tmp/nomads-gpu.lock bun burstx.ts 2>&1 | cut -c1-200 > logs/burst-r26.log
lockf /tmp/nomads-gpu.lock bun arrsettle.ts 2>&1 | cut -c1-260 > logs/arrsettle-r26.log
LATS=20,42,58,89.96 FR=0.5,0.9 lockf /tmp/nomads-gpu.lock bun orbitroll.ts orbitroll26 2>&1 | cut -c1-230 > logs/orbitroll-r26.log
lockf /tmp/nomads-gpu.lock bun treetest.ts tree-A26 4.35 -39.38 4.6 3.5 2>&1 | tail -1 > logs/tree-r26.log
echo fullround done > logs/fullround.done
