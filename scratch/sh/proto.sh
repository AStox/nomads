#!/bin/bash
# proto.sh <variant> [places=rA,rR,rK,rB]: artificial shelf prototype end to end: store (scratch/proto.ts), tiers 1 to 3, region harness at the places, pictures
export PATH="$HOME/.bun/bin:$PATH" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
V=$1; PL=${2:-rA,rR,rK,rB}; T=$HOME/.cache/nomads-scratch/t7; W=$T/wt; K=b4c6e7d1b819
export NOMADS_BAKE=$T/bake-$V NOMADS_STORE=$T/store-$V KEY=$K STORE=$T/store-$V
cd $W
[ -f $T/store-$V/1-$K/climate1.bin ] || bun scratch/proto.ts $V
for i in $(seq 1 14); do
  [ -f $NOMADS_BAKE/1-$K/t3-run.json ] && break
  lockf /tmp/nomads-gpu.lock bun scripts/globe-tiers-stream.ts --seed 1 --key $K --last 3 --budget 150 2>&1 | tail -2
done
mkdir -p $T/land-$V $T/out
B=$NOMADS_BAKE/1-$K; [ -f $B/t3-height.i32 ] || { echo "no t3"; exit 1; }
for p in ${PL//,/ }; do
  case $p in rA) a="rA 4 24 20";; rR) a="rR 1 14 10";; rK) a="rK 1 6 6";; rB) a="rB 1 1 6";; *) echo "place $p"; continue;; esac
  [ -f $T/land-$V/$p/state.i32 ] && [ -f $T/land-$V/$p/.done ] && continue
  bash $T/sh/region.sh $W $NOMADS_BAKE $T/land-$V $a 4
  touch $T/land-$V/$p/.done
done
# pictures: old planet, A2 baseline, variant
for pl in spit river K3 B; do
  OUT=$T/out; TAG=$V bun scratch/pic.ts $pl 384 A2=$HOME/.cache/nomads-scratch/t5/bakeA2/land,$V=$T/land-$V 2>&1 | tail -1
done
echo proto $V done
