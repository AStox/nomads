#!/bin/bash
# The OLD law's region harness (main's scripts/globe-land-region.ts in the worktree wtold) on the OLD planet (key 1121d207f3b8), tier 4 then tier 5 (from the tier-4 run), in calls under the GPU lock
# of well under two minutes each (the restore bake holds the lock in long calls). NOMADS_BAKE=$T/old holds symlinks to the old bake and its coarse store and writes only old/land/<name>.
#   straight-oldreg.sh <name> <face> <tx> <ty> [tiles=8]     -> old/land/<name>4/state.i32 (150 m) and old/land/<name>5/state.i32 (75 m)
export PATH="$HOME/.bun/bin:$PATH" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
T=$HOME/.cache/nomads-scratch/t4; export NOMADS_BAKE=$T/old; cd $T/wtold
n=$1; face=$2; tx=$3; ty=$4; tiles=${5:-8}
common="--face $face --tx $tx --ty $ty --tiles $tiles --key 1121d207f3b8 --uniform-rain --stochastic --slide16 --budget 90"
for i in $(seq 1 60); do
  out=$(lockf /tmp/nomads-gpu.lock bun scripts/globe-land-region.ts --tier 4 --name ${n}4 $common --schedule 26x4,13x6,6.5x10,3.25x4,1.6x4 2>&1 | tail -1); echo "$n t4 call $i: $out"
  case "$out" in *"28 of 28"*) break;; esac
done
for i in $(seq 1 60); do
  out=$(lockf /tmp/nomads-gpu.lock bun scripts/globe-land-region.ts --tier 5 --name ${n}5 --from4 ${n}4 $common --schedule 6.5x2,3.25x2,1.6x2 2>&1 | tail -1); echo "$n t5 call $i: $out"
  case "$out" in *"6 of 6"*) break;; esac
done
