#!/bin/sh
# The nightly evals, for the always-on host: whole worlds held to the last good build, and the live world's own trace
# scored the same way, each kept as a file in evals/ and pushed. Run it from a checkout of its own, never the one the
# live service runs from (pulling there changes the live world), pointing at the live service's data:
#   NOMADS_LIVE_DATA=/path/to/live/checkout/data sh scripts/nightly.sh
# from cron or a systemd timer at a quiet hour, e.g.
#   0 4 * * * cd /path/to/evals/checkout && NOMADS_LIVE_DATA=/path/to/live/checkout/data sh scripts/nightly.sh >> data/evals/nightly.log 2>&1
# The probe gate runs with each sim change, by whoever makes it (bun scripts/evals.ts probes); this only watches.
cd "$(dirname "$0")/.." || exit 1
git pull --ff-only --quiet || { echo "nightly: couldn't fast-forward, leaving it"; exit 1; }
bun install --frozen-lockfile --silent
status=0
bun scripts/evals.ts worlds || status=$?
[ -n "$NOMADS_LIVE_DATA" ] && { bun scripts/evals.ts live --data "$NOMADS_LIVE_DATA" || status=$?; }
git add evals/*.json 2>/dev/null
if ! git diff --cached --quiet; then
  git commit --quiet -m "evals: nightly worlds and live" && { git push --quiet || { git pull --rebase --quiet && git push --quiet; }; }
fi
[ "$status" -eq 0 ] || echo "nightly: a tier failed (exit $status): bun scripts/evals.ts trend --tier worlds"
exit "$status"
