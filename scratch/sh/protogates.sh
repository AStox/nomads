#!/bin/bash
# straight gates on the four proto places (tier 5, 1024 cells) of land dir $1 (label $2) -> out/pg-$2.jsonl
export PATH="$HOME/.bun/bin:$PATH" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
T=$HOME/.cache/nomads-scratch/t7; L=$1; V=$2; O=$T/out/pg-$V.jsonl; : > $O; cd $T/wt
for r in rA:4:24:20 rR:1:14:10 rK:1:6:6 rB:1:1:6; do
  IFS=: read n f tx ty <<< "$r"
  bun scripts/globe-gates.ts region --only straight --name $V-$n --state $L/$n/state.i32 --tier 5 --face $f --tx $tx --ty $ty --tiles 4 --key b4c6e7d1b819 --run $V --jsonl $O > /dev/null 2>>$T/out/pg-$V.err
done
echo done $V; wc -l $O
