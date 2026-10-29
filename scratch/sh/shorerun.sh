#!/bin/bash
# the shore stage on the A2 states of the harness regions, to 30, 100, 300 and 1000 years, one background process each: logs in out/shore-<region>.log
export PATH="$HOME/.bun/bin:$PATH" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
T=$HOME/.cache/nomads-scratch/t7; A2=$HOME/.cache/nomads-scratch/t5/bakeA2/land; cd $T/wt
YEARS=${YEARS:-10,30,100,300,1000}
for r in "$@"; do nohup bun scratch/shore.ts $r $A2 $T/land-shore/y $YEARS 1 > $T/out/shore-$r.log 2>&1 & done
