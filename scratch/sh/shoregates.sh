#!/bin/bash
# straight gates on region places of land dir $1 (label $2, places $3 comma list, default the four proto places) -> out/pg-$2.jsonl; pooled with sh/shoresum.ts
export PATH="$HOME/.bun/bin:$PATH" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
T=$HOME/.cache/nomads-scratch/t7; L=$1; V=$2; P=${3:-rA,rR,rK,rB}; O=$T/out/pg-$V.jsonl; rm -f $O; touch $O; cd $T/wt
for r in rA:4:24:20 rR:1:14:10 rK:1:6:6 rB:1:1:6; do
  IFS=: read n f tx ty <<< "$r"
  case ",$P," in *",$n,"*) ;; *) continue;; esac
  bun scripts/globe-gates.ts region --only straight --name $V-$n --state $L/$n/state.i32 --tier 5 --face $f --tx $tx --ty $ty --tiles 4 --key b4c6e7d1b819 --run $V --jsonl $O > /dev/null 2>>$T/out/pg-$V.err
done
echo done $V; wc -l $O
