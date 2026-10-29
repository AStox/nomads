#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e3/perf/scripts/play/audit/perf
E=$HOME/.cache/nomads-scratch/e2e3; L="lockf /tmp/nomads-gpu.lock bun"
for cur in "240,600:1" "640,400:2"; do
 c=${cur%%:*}; n=${cur##*:}
 for k in pub br; do
  if [ $k = pub ]; then S=http://127.0.0.1:8621; else S=http://127.0.0.1:8620; fi
  CURSOR=$c OUT=$E/wm/$k$n SITE=$S PROFILE=$E/chrome-wm-$k $L wheelmark.ts > $E/logs/wm-$k$n.log 2>&1
 done
done
# a slow continuous wheel (a tick every 400 ms) and a z -2 start
for k in pub br; do
  if [ $k = pub ]; then S=http://127.0.0.1:8621; else S=http://127.0.0.1:8620; fi
  mkdir -p $E/wm/${k}m2; CURSOR=240,600 Z0=-2 TICKS=14 GAP=150 OUT=$E/wm/${k}m2 SITE=$S PROFILE=$E/chrome-wm-$k $L wheelmark.ts > $E/logs/wm-${k}m2.log 2>&1
done
echo done > $E/logs/wm.done
