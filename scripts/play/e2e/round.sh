#!/bin/bash
# round.sh <seed:WxH> ... : run each session under the GPU lock, 150 s each
export PATH="$HOME/.bun/bin:$PATH"
cd $HOME/.cache/nomads-scratch/e2e3; mkdir -p logs runs
for spec in "$@"; do
  seed=${spec%%:*}; vp=${spec#*:}
  lockf /tmp/nomads-gpu.lock bun session.ts $seed --vp $vp --dur 150 > logs/s$seed-$vp.log 2>&1
  echo "chrome left: $(pgrep -x 'Google Chrome' | wc -l)" >> logs/s$seed-$vp.log
  tail -2 logs/s$seed-$vp.log
done
