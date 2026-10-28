# e2e tester 2 scratch (moved from /tmp after the 2026-10-27 23:52 wipe)
Run each script under the GPU lock: `lockf /tmp/nomads-gpu.lock bun <script>` (PATH has ~/.bun/bin). Output stays in this folder. issues.json is the list, `python3 mkreport.py <12 hex> "<round label>"` writes ~/.cache/nomads-play/reports/e2e-<hex>.html and issues.md.
Rebuilt: lib, look, sheet, crop, glintcount, mkreport, watch, dragedge, treetest, latticetest, orbitroll, burstx, arrsettle, settle2.
LOST (first tester's): analyze.ts (pop/hole/seam detectors), anchortest.ts, dragtest.ts, report.py. REWRITTEN but UNTESTED (no GPU allowed yet): session.ts (seeded random user, detectors inline: stall, camera-snap, blank, night-dark, anchor-drift; thresholds are mine, not the original) and round.sh. Smoke-run session.ts once before trusting it.

## In the repo
These files are a backup copy (the tester's scratch is ~/.cache/nomads-scratch/e2e, and /tmp is wiped by a macOS restart). To run: copy this folder to ~/.cache/nomads-scratch/e2e (the scripts write runs/, evid/, logs/ and chrome/ next to themselves and lib.ts's HOME_E2E points there), `export PATH="$HOME/.bun/bin:$PATH"`, then `lockf /tmp/nomads-gpu.lock bun look.ts out "lat,lon,z1;z2"`. Evidence images are not in the repo (they live in the scratch folder and in ~/.cache/nomads-play/reports). issues.json is the current list, issues.md its readable form.
