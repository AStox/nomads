#!/usr/bin/env bash
# The candidate "V13r with V14r" run, stage by stage, every GPU call under the shared lock in calls of under five minutes (resumable: run a stage again and it continues).
# Tier-0 chain with Rho8 receivers and the 10 km relief window (the store is made by globe-planet.ts under the same two knobs), tiers 1 to 3 without erosion (the carry), tiers 4 and 5 eroding
# under a band-limited hold of span 2. Run it from the worktree that holds the generator (WT); the gate tools themselves are CPU only.
#   run-v14r.sh wait-store                      wait for climate1.bin of the store
#   run-v14r.sh tiers                           tiers 1 to 3 streamed into $BAKE
#   run-v14r.sh region <name> <face> <tx> <ty>  tier 4 (28 steps) then tier 5 (6 steps) of the 8 x 8 tile region, then a 1 px a cell picture of each into $OUT/png
#   run-v14r.sh stream4                         the whole planet's tier 4 streamed from the tier-3 carry of $BAKE (t4-height.i32), for scripts/globe-overlap.ts
set -u
export PATH="$HOME/.bun/bin:$PATH" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
T4=${T4:-$HOME/.cache/nomads-scratch/t4}
WT=${WT:-$T4/wt}; KEY=${KEY:-b82ccfaeb552}; STORE=${STORE:-$T4/store/v13r}; BAKE=${BAKE:-$T4/bake/v14}; LAND=${LAND:-$T4/land}; OUT=${OUT:-$T4/out}
export NOMADS_T0_RHO8=1 NOMADS_T0_RELIEF_WINDOW=1 NOMADS_SKIP_TIERS=1,2,3 NOMADS_HOLD_OFF_TIERS=4,5 NOMADS_BAND_SPAN=2
mkdir -p "$OUT/logs" "$OUT/png" "$BAKE" "$LAND" "$T4/bake/stub5"
: > "$T4/bake/stub5/t5-height.i32"; : > "$T4/bake/stub5/t5-flooded.i32" # tier 5's ring is carried (--ring-carry) and its interior read from the state: the files are only opened
cd "$WT" || exit 1
log() { echo "$(date +%T) $*" | tee -a "$OUT/logs/run-v14r.log"; }
gpu() { lockf /tmp/nomads-gpu.lock "$@"; }

# one resumable harness call until its last line says `$1`
until_says() {
  local pat=$1; shift
  for _ in $(seq 1 200); do
    local out rc; out=$("$@" 2>&1); rc=$?; echo "$out" | tail -n 3 >> "$OUT/logs/run-v14r.log"
    echo "$out" | grep -q "$pat" && return 0
    [ $rc -ne 0 ] && { log "FAILED ($rc): $(echo "$out" | tail -n 5)"; return 1; }
  done
  return 1
}
regionrun() { # name tier face tx ty schedule steps extra...
  local name=$1 tier=$2 face=$3 tx=$4 ty=$5 sched=$6 steps=$7; shift 7
  until_says "$steps of $steps steps kept" gpu bun scripts/globe-land-region.ts --name "$name" --tier "$tier" --face "$face" --tx "$tx" --ty "$ty" --tiles 8 --schedule "$sched" \
    --uniform-rain --stochastic --slide16 --t3dir "$BAKE" --key "$KEY" --store "$STORE" --land-dir "$LAND" --budget 215 "$@"
}
render() { # name tier face tx ty size extra...
  local name=$1 tier=$2 face=$3 tx=$4 ty=$5 size=$6; shift 6
  gpu bun scripts/globe-land-region.ts --name "$name" --tier "$tier" --face "$face" --tx "$tx" --ty "$ty" --tiles 8 --uniform-rain --stochastic --slide16 --t3dir "$BAKE" --key "$KEY" \
    --store "$STORE" --land-dir "$LAND" --render --view "0,0,$size" --scale 1 --out "$OUT/png/$name.png" "$@" 2>&1 | tail -n 2 >> "$OUT/logs/run-v14r.log"
  rm -f "$LAND/$name"/flow-*.i32 "$LAND/$name"/flow.bin "$LAND/$name"/acc.bin
}

case ${1:-} in
  wait-store) until [ -f "$STORE/1-$KEY/climate1.bin" ]; do sleep 30; done; log "store ready" ;;
  tiers) until_says "of seed 1 done" gpu env NOMADS_STORE="$STORE" NOMADS_BAKE="$BAKE" bun scripts/globe-tiers-stream.ts --seed 1 --key "$KEY" --last 3 --budget 200 && log "tiers 1 to 3 done" ;;
  region)
    name=$2; face=$3; tx=$4; ty=$5
    regionrun "$name-t4" 4 "$face" "$tx" "$ty" 26x4,13x6,6.5x10,3.25x4,1.6x4 28 || exit 1
    render "$name-t4" 4 "$face" "$tx" "$ty" 1024
    regionrun "$name-t5" 5 "$face" "$tx" "$ty" 6.5x2,3.25x2,1.6x2 6 --from4 "$name-t4" --ring-carry --bake "$T4/bake/stub5" || exit 1
    render "$name-t5" 5 "$face" "$tx" "$ty" 2048 --from4 "$name-t4" --ring-carry --bake "$T4/bake/stub5"
    log "region $name done" ;;
  stream4)
    # tiers 1 to 3 are the carry already in $BAKE; tier 4 reads t3-height.i32 and writes t4-height.i32 (--last 5: it is not the last tier, so no to/acc/flooded files)
    until_says "of seed 1 done" gpu env NOMADS_STORE="$STORE" NOMADS_BAKE="$BAKE" bun scripts/globe-tiers-stream.ts --seed 1 --key "$KEY" --tier 4 --last 5 --budget 200 || exit 1
    log "streamed tier 4 done" ;;
  *) echo "usage: run-v14r.sh wait-store|tiers|region <name> <face> <tx> <ty>|stream4"; exit 2 ;;
esac
