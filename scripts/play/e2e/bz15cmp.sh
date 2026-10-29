#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"; cd $HOME/.cache/nomads-scratch/e2e3/perf/scripts/play/audit/perf
E=$HOME/.cache/nomads-scratch/e2e3; L="lockf /tmp/nomads-gpu.lock bun"
for k in pub br; do
  if [ $k = pub ]; then S=http://127.0.0.1:8621; else S=http://127.0.0.1:8620; fi
  SITE=$S PROFILE=$E/chrome-tm-$k ZOOMS=1.5,-2 SHOTS=$E/tm-shots/$k $L tickmark.ts > $E/logs/tm-single-$k.log 2>&1
  SITE=$S PROFILE=$E/chrome-tm-$k ZOOMS=1.5 SEQ=6 ONLY=0,1,2 SHOTS=$E/tm-shots/${k}seq $L tickmark.ts > $E/logs/tm-seq-$k.log 2>&1
  SITE=$S PROFILE=$E/chrome-tm-$k ZOOMS=1.5,-2 TICKS=8 GAP=60 ONLY=0,1,2 $L tickmark.ts > $E/logs/tm-burst-$k.log 2>&1
done
echo done > $E/logs/bz15cmp.done
