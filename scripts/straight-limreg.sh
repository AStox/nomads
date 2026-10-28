#!/bin/bash
# The region harness (final law, TIER_LAWS) from the limited tier-3 carry of the new planet (~/.cache/nomads-scratch/t4/lim, made by globe-tiers-stream.ts --last 3 with the limiter): tier 4 (28 steps)
# then tier 5 (6 steps, from the tier-4 run, the ring carried down from it), in calls of at most 100 s under the GPU lock.
#   straight-limreg.sh <name> <face> <tx> <ty> [tiles=8]   -> lim/land/<name>4/state.i32 and lim/land/<name>5/state.i32
export PATH="$HOME/.bun/bin:$PATH" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
T=$HOME/.cache/nomads-scratch/t4; mkdir -p $T/lim/land; cd $T/wt9
n=$1; face=$2; tx=$3; ty=$4; tiles=${5:-8}
common="--face $face --tx $tx --ty $ty --tiles $tiles --t3dir $T/lim --key b82ccfaeb552 --store $T/store/v13r --land-dir $T/lim/land --budget 100"
for i in $(seq 1 20); do
  out=$(lockf /tmp/nomads-gpu.lock bun scripts/globe-land-region.ts --tier 4 --name ${n}4 $common 2>&1 | tail -1); echo "$n t4 call $i: $out"
  case "$out" in *"28 of 28"*) break;; esac
done
for i in $(seq 1 20); do
  out=$(lockf /tmp/nomads-gpu.lock bun scripts/globe-land-region.ts --tier 5 --name ${n}5 --from4 ${n}4 --ring-carry --bake $T/bake/stub5 $common 2>&1 | tail -1); echo "$n t5 call $i: $out"
  case "$out" in *"6 of 6"*) break;; esac
done
