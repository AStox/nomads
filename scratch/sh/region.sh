#!/bin/bash
#   region.sh <worktree> <t3 dir> <land dir> <name> <face> <tx> <ty> [tiles=4] [extra args]
T=$HOME/.cache/nomads-scratch/t7
W=$1; B=$2; L=$3; n=$4; f=$5; tx=$6; ty=$7; tl=${8:-4}; shift 8 2>/dev/null || shift $#
mkdir -p $L
for i in 1 2 3 4 5 6 7 8; do
  out=$(lockf /tmp/nomads-gpu.lock $T/sh/regionhold.sh $W $B $n $f $tx $ty $tl $L "$@")
  echo "$n hold $i: $(echo "$out" | tr '\n' ' ')"
  case "$out" in *"6 of 6"*) break;; esac
done
