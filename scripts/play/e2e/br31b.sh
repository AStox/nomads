#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e3; mkdir -p logs
L="lockf /tmp/nomads-gpu.lock bun"
for step in slowB flick; do
 for k in pub br; do
  if [ $k = pub ]; then export SITE=http://127.0.0.1:8197; else export SITE=http://127.0.0.1:8472; fi
  O=logs/r31b-$step-$k.log
  if [ $step = slowB ]; then VP=1280x800 PLACES=B ZS=0,1 DIRS=N,NE,E,S $L dragscan.ts r31b-slowB-$k.json > $O 2>&1
  else HOLD=0 SPD=3 STEPS=20 VP=1280x800 PLACES=B,A,H,R ZS=0,1.8 DIRS=N,E,W $L dragscan.ts r31b-flick-$k.json > $O 2>&1; fi
 done
done
for k in pub br; do
  if [ $k = pub ]; then export SITE=http://127.0.0.1:8197; else export SITE=http://127.0.0.1:8472; fi
  mkdir -p ds31b-$k; $L dragshot.ts -35.9 43.59 1.8 0 -5 40 ds31b-$k/B18N > logs/r31b-shot-$k.log 2>&1
done
echo done > logs/r31b.done
