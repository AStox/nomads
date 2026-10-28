#!/bin/bash
# The region gates (scripts/globe-gates.ts region, with the straight-feature measures of branch globe-t4-straight, worktree wt7) on the four regions at tiers 4 and 5 for the old planet's harness
# (old/land), the new planet's unlimited carry (land, land2) and its limited carry (lim/land): one JSON-lines file per case in lim/gates/. CPU only, about 10 s a case.
export PATH="$HOME/.bun/bin:$PATH" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
T=$HOME/.cache/nomads-scratch/t4; G=$T/lim/gates; mkdir -p $G; cd $T/wt7
run() { # label bake key name tier face tx ty state
  [ -f "$9" ] || { echo "skip $1 $4 t$5: no $9"; return; }
  rm -f $G/$1-$4-t$5.jsonl
  NOMADS_BAKE=$2 bun scripts/globe-gates.ts region --name $4 --state $9 --tier $5 --face $6 --tx $7 --ty $8 --tiles 8 --key $3 --run $1 --jsonl $G/$1-$4-t$5.jsonl > /dev/null 2>&1 && echo "done $1 $4 t$5"
}
while read -r name face tx ty o4 o5 u4 u5 l4 l5; do
  run old $T/old 1121d207f3b8 $name 4 $face $tx $ty $T/old/land/$o4/state.i32
  run old $T/old 1121d207f3b8 $name 5 $face $tx $ty $T/old/land/$o5/state.i32
  run unlimited $T/lim b82ccfaeb552 $name 4 $face $tx $ty $T/$u4/state.i32
  run unlimited $T/lim b82ccfaeb552 $name 5 $face $tx $ty $T/$u5/state.i32
  run limited $T/lim b82ccfaeb552 $name 4 $face $tx $ty $T/lim/land/$l4/state.i32
  run limited $T/lim b82ccfaeb552 $name 5 $face $tx $ty $T/lim/land/$l5/state.i32
done <<'EOF'
home 4 23 21 home4 home5 land2/h4 land/home-t5 home4 home5
Rblk 1 9 16 Rblk4 Rblk5 land2/b4 land/Rblk-t5 Rblk4 Rblk5
R1 0 23 17 R14 R15 land2/r1t4 land/R1-t5 R14 R15
A 0 1 14 A4 A5 land2/a4 land/A-t5 A4 A5
EOF
