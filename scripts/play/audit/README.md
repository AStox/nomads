# Audit gates (2026-10-24)

The three auditors' scripts (perf, far, close; their findings were in /tmp/globe-audit, summarised in docs/plans/2026-10-20-001-feat-seamless-globe-plan.md Unit 9) and the lead's own, kept here
because /tmp is not. They are scratch scripts, not suites: each launches headless Chrome with its own profile, so every one is run as `lockf /tmp/nomads-gpu.lock bun <script>` and closes its browser in
`finally`. Paths inside them (`/tmp/globe-fix-lead/chrome`, `/tmp/globe-fix-lead/out`, the site port) are the lead's: change them or keep that directory.

- `mksite.sh <worktree> <outdir>`: builds the styles demo and injects the perf instrument (`perfprelude.js`, which the perf auditor wrote into its frozen site: copy it from there or rewrite it as
  `isopixel/perfprelude.js` wrapping GPUDevice, queue and buffers) as the render worker's first import. `perf/server.ts <port> <dir>` serves such a site (no-store, request log).
- perf/lib.ts is the harness (launch, load, take, summarize, drag, settleTo). Gates by item: `dive.ts` (load, wheel out to orbit and back: ready, errors, rates; `SITE=` picks the site), `idle.ts` and
  `spikes.ts` (frame skipping; a long pan's GPU frames), `cuts.ts` (largest ladder grid and views cut, per place), `dcost.ts` (D's cost), `det.ts`, `still.ts`, `cmp.ts`, `open.ts` (same picture
  between loads and builds; scripts/play/loadsame.ts is the gate), `bloss.ts`, `badge.ts`, `soak.ts`, `arrive.ts`, `band.ts`, `profpan.ts`, `loadtest.ts`, `netdive.ts` (the auditor's), `lakes.ts`
  (old against new site stills at a lake), `edge.ts`, `spritejump.ts`, `probe*.ts`.
- far/lostcheck.ts: 30 wheel ticks out from the opening view, losses in N runs. close/t3.ts, t3b.ts: drift of sprites against ground after a pan; t10.ts: window builds after a jump.
