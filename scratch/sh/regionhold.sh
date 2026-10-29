#!/bin/bash
# one lock hold of the region harness: tier 4 (unless done) then tier 5 (once tier 4 has 28 steps); run under the GPU lock by region.sh
#   regionhold.sh <worktree> <t3 dir (holds 1-<key>/t3-height.i32)> <name> <face> <tx> <ty> <tiles> <land dir> [extra args]
export PATH="$HOME/.bun/bin:$PATH" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
T=$HOME/.cache/nomads-scratch/t7; W=$1; B=$2; K=${KEY:-b4c6e7d1b819}; ST=${STORE:-$HOME/.cache/nomads-scratch/t5/bake/small/store}; n=$3; f=$4; tx=$5; ty=$6; tiles=$7; L=$8; shift 8
cd $W
a=$(bun scripts/globe-land-region.ts --tier 4 --name $n-t4 --face $f --tx $tx --ty $ty --tiles $tiles --t3dir $B --key $K --store $ST --land-dir $L --budget 130 "$@" 2>&1 | tail -1)
echo "$a"
case "$a" in
  *"28 of 28"*)
    bun scripts/globe-land-region.ts --tier 5 --name $n --from4 $n-t4 --ring-carry --face $f --tx $tx --ty $ty --tiles $tiles --t3dir $B --key $K --store $ST --land-dir $L --budget 130 "$@" 2>&1 | tail -1;;
esac
