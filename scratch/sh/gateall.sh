#!/bin/bash
# straight gates of the shore stage's output dirs land-shore/y<years> (labels y<years>), one background process each: bash gateall.sh 10 30 100 [places]
T=$HOME/.cache/nomads-scratch/t7; P=""
for y in "$@"; do
  case "$y" in rA*|*,*) P=$y; continue;; esac
  nohup bash $T/wt/scratch/sh/shoregates.sh $T/land-shore/y$y y$y $P > $T/out/pgrun-y$y.log 2>&1 &
done
