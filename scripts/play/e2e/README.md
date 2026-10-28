# e2e tester 2 scratch (moved from /tmp after the 2026-10-27 23:52 wipe)
Run each script under the GPU lock: `lockf /tmp/nomads-gpu.lock bun <script>` (PATH has ~/.bun/bin). Output stays in this folder. issues.json is the list, `python3 mkreport.py <12 hex> "<round label>"` writes ~/.cache/nomads-play/reports/e2e-<hex>.html and issues.md.
Rebuilt: lib, look, sheet, crop, glintcount, mkreport, watch, dragedge, treetest, latticetest, orbitroll, burstx, arrsettle, settle2.
LOST (first tester's): analyze.ts (pop/hole/seam detectors), anchortest.ts, dragtest.ts, report.py. REWRITTEN but UNTESTED (no GPU allowed yet): session.ts (seeded random user, detectors inline: stall, camera-snap, blank, night-dark, anchor-drift; thresholds are mine, not the original) and round.sh. Smoke-run session.ts once before trusting it.

## Harness notes (round 26)
- session.ts: camera-snap and anchor-drift use the API pick, which is only valid below zoom 2.9 (above it the pick is in window x,z that move at a window swap), so both detectors are limited to zoom < 2.9. Sentinel distances of 1.4e9 mean "pick missed", ignore. blank/night-dark are luma statistics of 320 px shots taken every ~150 ms.
- Seams, ground-slip and stuck-texture detectors do not exist any more (the first tester's analyze.ts is lost): use stills.
- fullround.sh = round.sh with 4 sessions + dragedge, burstx, arrsettle, orbitroll, treetest (logs in logs/).
