#!/bin/bash
# round 31: branch lead3-surf (:8472) against published (:8197), alternating per step
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e3; mkdir -p logs
L="lockf /tmp/nomads-gpu.lock bun"
declare -A S=([pub]=http://127.0.0.1:8197 [br]=http://127.0.0.1:8472)
for step in slowB fastB others bursts; do
 for k in br pub; do
  export SITE=${S[$k]}; O=logs/r31-$step-$k.log
  case $step in
   slowB) VP=1280x800 PLACES=B ZS=0,1 DIRS=N,NE,E,S $L dragscan.ts r31-slowB-$k.json > $O 2>&1 ;;
   fastB) SPD=3 STEPS=20 VP=1920x1080 PLACES=B ZS=-0.92,1 DIRS=N,NE,W $L dragscan.ts r31-fastB-$k.json > $O 2>&1 ;;
   others) VP=1280x800 PLACES=A,M,E2,R,H,D ZS=0 DIRS=N,S,W $L dragscan.ts r31-oth-$k.json > $O 2>&1 ;;
   bursts) $L burstx.ts > $O 2>&1; cp burst.json r31-burst-$k.json ;;
  esac
 done
done
for k in br pub; do export SITE=${S[$k]}; mkdir -p ds31-$k; $L dragshot.ts -35.9 43.59 1.8 0 -5 40 ds31-$k/B18N > logs/r31-shot-$k.log 2>&1; done
echo done > logs/r31.done
