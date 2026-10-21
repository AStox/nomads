# The planet's bake driver (plan Unit 7b: the bake as resumable calls, driven in order)

Owner: AirStage.BakeDriver. Code: `scripts/globe-bake-driver.ts` (the stage table and the engine; `scripts/globe-bake.ts` is the viewer's planet export and is not touched). Tests: `src/gpu/globe/bake-driver.test.ts` (25 cases, 45 s, no GPU), fixture `src/gpu/globe/bake-driver-fixture/fake-stage.ts`. Chain: `docs/plans/2026-10-20-001-feat-seamless-globe-plan.md` Unit 7b, `2026-10-21-planet-75m-impl.md` (the tier-4 bake by hand: 31 calls, 1 h 55 min), `-water.md` (section 13: the water at tiers 4 and 5), `2026-10-22-planet-water-stream.md`, `-air.md`, `-ground.md` (what each stage reads and makes).

## 1. What it is

One process that runs every stage of one seed's bake in order as separate subprocess calls of at most `--budget` seconds each, and calls a stage again until the stage's own files say it is done. A GPU stage's call runs under `lockf /tmp/nomads-gpu.lock`, taken for that call and released when it ends (the driver holds nothing between calls); the CPU stages (the discharge and the lakes from tier 5, which are streamed, ground tiles, pyramid, maps) run without it. It never starts a stage whose inputs are not on disk. The water at tiers 4 and 5 is two parts in the one bake dir: a coarse global solve at tier 3 (`t3-*` stages and `coarse`), then the patch stage of the fine tier seeded from its heads.

```
bun scripts/globe-bake-driver.ts --seed 1 --key <planet key> [--tier 5] [--budget 240] [--from <stage>] [--stop-after <stage>] [--max-calls N]
     [--status | --dry-run] [--keep-all] [--min-free-gb 20] [--max-gb 100] [--grace 45] [--stages-file <json>]
```

- Run as a background job: `bun scripts/globe-bake-driver.ts --seed 1 --key <key> &`. It logs to stdout and to `<bake dir>/bake.log` (appended, one timestamped line per event, the child's own lines prefixed `| `), and writes `<bake dir>/bake-progress.json` (atomic, after every call).
- `--status` prints the table from the disk and the progress file and runs nothing (it works while a driver runs: the state `running` is the lock's stage). `--dry-run` prints the plan: each stage's command, state, the files it will delete; it writes nothing.
- Exit codes: 0 everything done; 1 failure (a stage that made no progress in 3 calls in a row, a stage with no script, an input or a stage it needs missing, a second driver, bad arguments); 2 stopped early (`--stop-after`, `--max-calls`, SIGINT, SIGTERM, SIGHUP: the signal is passed to the call in flight, the lock is released); 3 hard stop (disk).
- Disk guards, before every stage's first call and before every call: free space on the volume under `--min-free-gb` (20, GB = 2^30 bytes) or `du -sk` of the bake root (`/tmp/planet-75m`, `NOMADS_BAKE`) over `--max-gb` (100) stops with exit 3 and a line `HARD STOP: ... (before a call of stage <name>)`.
- A call has `--budget` (240) plus `--grace` (45) seconds from the moment its script runs; the wait for the GPU lock is not counted (the clock starts when `lockf` has forked the script, which the driver sees in the process tree). Over time: SIGTERM to the call's process group, SIGKILL 15 s later; it counts as a call that made no progress unless it moved something.
- Peak memory is the largest RSS of any process in the call's tree, `ps` sampled every 2 s (`--sample-ms`), kept as the maximum over all calls. RSS counts mapped file pages: a stage that maps the 1.6 GB stage files (ground tiles, ground, water) shows several GB that are page cache, not heap.

## 2. The stages (the table in `realStages(cfg)`)

Every command is `bun scripts/<x>.ts --seed S --key K [--tier T] --budget B` unless noted; `lockf /tmp/nomads-gpu.lock` in front for GPU. The table is the one place a command line lives. `--tier` is passed to every script that takes it; a script that does not (`takesTier`: its source has no `arg("tier"`) is refused for any tier but PLANET_TIER, because it would make the finest tier whatever it was asked.

| stage | kind | script and flags | done (read from the disk) | spent once it is done (the list is this stage's: it was their last reader) |
|---|---|---|---|---|
| `tiers` | GPU | `globe-tiers-stream.ts --last T` (tiers 1 to T, each resumable; `--tier` there means one tier, so it is not passed) | `t<T>-height.i32`, `-to.u32`, `-acc.u32`, `-flooded.i32` at 4 bytes a cell and `t<T>-run.json` | `t1`, `t2`, `t4`..`t<T-1>-height.i32` (read by the next tier only; **not `t3-height.i32`**, which `t3-flow` and `coarse` read), the work dirs `stream-t*` |
| `t3-flow` | GPU | `globe-water.ts --stage flow --tier 3` (in memory: the regional flood on `t3-height.i32`) | `t3-to.u32`, `t3-flooded.i32` at full size | |
| `t3-terrain`, `t3-air` | GPU | `globe-stage.ts --stage terrain\|air --tier 3` (air with `--block 4`: it divides the 8 tiles of a face edge) | `t3-<stage>-done.u8`: 384 bytes, all 1 | |
| `t3-surplus` | GPU | `globe-water.ts --stage surplus --tier 3` | `t3-surplus-done.u8` | |
| `t3-discharge` | GPU | `globe-water.ts --stage discharge --tier 3` (in memory: below tier 5) | `t3-q0..3-lo.u32`, `-hi.u16`, `t3-cells.u32` at full size | `t3-vs0..3.u32` |
| `t3-basin` | GPU | `globe-water.ts --stage basin --tier 3` | `t3-basin.u8` at full size | `t3-lakenet.i32` |
| `coarse` | GPU | `globe-water.ts --stage coarse --tier 3 --budget 230` (the cascade to the two heads; resumable, 2 to 4 calls) | `t3-g-head1.i32` and `t3-g-head2.i32` at full size (100,663,296 bytes) | every other `t3-*` file the tier-3 stages made (height, to, flooded, rock, drift, dd, the 36 air files, q, cells, basin) and the cascade's scratch: the family `t3-g-*` (its `-part` heads, `casc` marks, the passes' planes) except the two heads, and the family `g-*` (`g-solve<k>.json`) |
| `terrain`, `air` | GPU | `globe-stage.ts --stage terrain\|air --tier T` (air with `--block 4`) | `t<T>-<stage>-done.u8`: 6 4^T bytes, all 1 (the tier-less `<stage>-done.u8` of the first bakes is read when it holds that count) | |
| `surplus` | GPU | `globe-water.ts --stage surplus --tier T` | `t<T>-surplus-done.u8` | |
| `discharge` | CPU from tier 5 (GPU below) | `globe-water-stream.ts --stage discharge --tier T --block 4` (no GPU, no lock); below tier 5 `globe-water.ts --stage discharge` | `t<T>-q0..3-lo.u32`, `-hi.u16`, `t<T>-cells.u32` at their sizes | `t<T>-vs0..3.u32` (the surplus weights it sums), the work dir `discharge-stream-t<T>.work` |
| `basin` | CPU from tier 5 (GPU below) | `globe-water-stream.ts --stage basin --tier T --block 4`; below tier 5 `globe-water.ts --stage basin` | `t<T>-basin.u8` at 1 byte a cell | `t<T>-lakenet.i32`, the work dir `basin-stream-t<T>.work` |
| `water` | GPU | `globe-water.ts --stage water --tier T --coarse 3` (the patches seeded from `t3-g-head1/2.i32`, halo 128) | `t<T>-water-done.u8` | `t<T>-q0..3-lo.u32`, `-hi.u16`, `t<T>-cells.u32` |
| `ground` | GPU | `globe-stage.ts --stage ground --tier T` | `t<T>-ground-done.u8` | |
| `groundtiles` | CPU | `globe-groundtiles.ts --tier T` | 6 4^T files `groundtiles/f<face>/<ty>-<tx>.gt.gz` | |
| `pyramid` | CPU | `globe-pyramid.ts --tier T` (never `--faces`: `pyramid.json` is the done mark only for all six faces) | `pyramid.json` and 2 (4^(T+1) - 1) files `pyramid/t*/f*/*.tile.gz` (8,190 at tier 5) | |
| `maps` | CPU | `globe-maps75.ts --tier T` | `maps-done.json`, which the driver writes after the script's exit 0 (the script has no mark; its PNGs go to `/tmp/planet-75m/maps`, shared by all keys) | |

The coarse tier and the stream tier are the sources' constants (`water.ts` `WATER_SEEDED.coarse` = 3, `globe-water.ts` `STREAM_TIER` = 5; the test compares the table's with them). The driver's tier-3 stages are the same scripts at `--tier 3`; for a tier not finer than 3 they are `skipped`. The old whole-tier global solve (`--stage global`, `--water global|patch`) is dropped from the driver, the tests and these notes: its packed state of 21 GiB at tier 5 did not fit, and WaterStage's route is the cascade at tier 3 and seeded patches; the driver has no `--water` flag.

Done is the disk's: a stage is also done when a stage that reads its files is (`evaluate`: `needs` edges), so deleting a spent file never makes a finished stage look unfinished (`t3-discharge` and the other tier-3 stages are done once `coarse` is, `discharge` by `t<T>-basin.u8` once its q files are gone, `tiers` once `terrain` is done). The progress file shows it as `done*` in `--status`. On the real tier-4 bake of key `883a8d9387df` (whose water was made by the old unseeded patch route and never had tier-3 stages) the six tier-3 stages and `coarse` therefore read `done*` because `water` is done; to make the seeded water on that directory, remove `t4-water-done.u8` or `water-done.u8` and run `--from t3-flow`.

## 3. Which stage reads which stage's files

`needs` in the table; the files are `inputs`, checked to exist before a stage's first call. `T` is the tier.

planet store (/tmp/planet-small/store/<seed>-<key>/chain, ice, climate1: scripts/globe-planet.ts, not the driver's)
  tiers ......... reads the store; makes t1..tT height, tT to, acc, flooded, run.json
  --- tier 3 (in the same dir; every stage here is `--tier 3`) ---
  t3-flow ....... tiers (t3-height)                               -> t3-to, t3-flooded
  t3-terrain .... tiers (t3-height)                               -> t3 rock, drift, dd
  t3-air ........ t3-flow (t3-height, t3-flooded)                 -> t3 pr0..3 pe0..3 sun0..3 tmp0..3 hum0..3 snow wsh fog snp0..3
  t3-surplus .... t3-flow, t3-air (pr, pe)                        -> t3 vs0..3, lakenet
  t3-discharge .. t3-flow (to), t3-surplus (vs0..3)               -> t3 q0..3-lo/hi, cells
  t3-basin ...... t3-flow, t3-surplus (lakenet), t3-discharge     -> t3-basin
  coarse ........ all of the above (to, flooded, height, basin, q, cells, rock, drift, dd, pr, pe)   -> t3-g-head1, t3-g-head2 (+ scratch)
  --- tier T ---
  terrain ....... tiers (height)                                  -> rock, drift, dd
  air ........... tiers (height, flooded)                         -> pr0..3 pe0..3 sun0..3 tmp0..3 hum0..3 snow wsh fog snp0..3
  surplus ....... tiers (height, flooded), air (pr, pe: globe-water.ts takes them when t<T>-pr0.u16 EXISTS, so air must be whole first)
                                                                  -> vs0..3, lakenet
  discharge ..... tiers (to), surplus (vs0..3)                    -> q0..3-lo/hi, cells        (streamed from tier 5)
  basin ......... tiers (height, flooded, to), surplus (lakenet), discharge (q, cells)   -> basin   (streamed from tier 5)
  water ......... tiers (to, flooded, height), basin, discharge (q, cells), terrain (rock, drift, dd), air (pr, pe), coarse (t3-g-head1, t3-g-head2)
                                                                  -> the stored water files (water.u16 flow.u32 qwet.u32 base.u16 chn.u8 valley.u8 pwr.u16 stb0..3.u16 dry.u16 tab.u16 under.u16 quick.json)
  ground ........ terrain, air (pr pe sun tmp hum), water files (height, water, chn, valley, pwr, stb0..3, dry)   -> tree shr grs mar bare soil sflag sandy clayey fert moist sw0..3 ph org carb nit
  groundtiles ... height, water, rock, moist, covers, sflag, soil, clayey, ph, stb3, tab, sun, tmp, sw, pr1, pe1, wsh, fog, snp, to, chn, flow, base, under, quick.json
  pyramid ....... height, rock, drift, dd, tmp0..3, pr0..3, water, flow, tree shr grs mar bare, soil
  maps .......... height, acc, flooded (and, when there, flow, water, pr, the covers)

The viewer export (`scripts/demo.ts`) reads `pyramid/` and `pyramid.json` only; the ground tiles are read by the page. Nothing else reads a stage file after `maps`.

## 4. Spent files, and what is kept

Only the names in a stage's own list are ever deleted, and only after that stage's own done mark says it is done (also after a restart: the deletion is idempotent). A family (`t3-g-*`) has `except` names that stay. `--keep-all` deletes nothing. Each deletion is a log line naming the file, its bytes, who made it and who read it last. `bake-driver.test.ts` checks, at tiers 4 and 5, that no file of any list (a family minus its exceptions) is read (an input, or a done predicate) by a later stage, that no done marker is spent, and that the viewer's files (`pyramid`, `pyramid.json`, `groundtiles`) are in no list; and on fake stages that a family's exceptions survive and are read by every later tile.

Bytes at tier 5 (402,653,184 cells; a u8 plane is 402,653,184 B = 0.375 GiB, u16 0.75 GiB, u32 and i32 1.5 GiB) [derived]:

| file | each | count | made by | deleted when |
|---|---|---|---|---|
| `t1`, `t2`, `t4`..`t<T-1>-height.i32` | 6.3 MB, 25.2 MB, 402.7 MB (tier 5's list) | 3 | tiers | `tiers` done |
| `t3-height.i32` (and the other tier-3 files of the `coarse` row) | 100,663,296 (each u32 or i32 plane; u16 50,331,648; u8 25,165,824) | 1 | tiers | `coarse` done |
| `stream-t<k>/` work dirs | the script removes them on success; what a kill leaves | | tiers | `tiers` done |
| `t5-vs0..3.u32` | 1,610,612,736 | 4 = 6.0 GiB | surplus | `discharge` done |
| `t5-lakenet.i32` | 1,610,612,736 | 1.5 GiB | surplus | `basin` done |
| `t5-q0..3-lo.u32` | 1,610,612,736 | 4 | discharge | `water` done |
| `t5-q0..3-hi.u16` | 805,306,368 | 4 | discharge | same |
| `t5-cells.u32` | 1,610,612,736 | 1 | discharge | same (the three kinds: 10.5 GiB) |
| `discharge-stream-t5.work`, `basin-stream-t5.work` | work dirs of the streamed calls (the scripts remove them on success; sizes not measured) | | discharge, basin | their stage done |
| `t3-*` (all but the heads), `t3-g-*` (but the heads), `g-*` | the tier-3 stages' 2.6 GiB and the cascade's scratch (names and sizes are WaterStage's; not measured) | | tier-3 stages, coarse | `coarse` done |

Kept: `t3-g-head1.i32` and `t3-g-head2.i32` (100,663,296 bytes each, 0.19 GiB), which every tier-5 water tile reads.

Kept on purpose, though no stage reads them after the next one: `t5-acc.u32` (maps), `t5-basin.u8` (the water stage's lakes), `t5-snow.u8`, the ground's `sandy fert org carb nit` (the stage's products: the ground tiles format does not carry them yet, and ground is the cheap stage to redo, but the page may want them), `t5-pe0..3`, `t5-hum0..3`. They are 9.4 GiB together; deleting them is a list entry each if the disk asks for it. The tier-3 tile stages' done markers (384 bytes) stay.

Disk at tier 5 by stage (GiB, files only; sizes exact except those said otherwise) [derived]: tiers 6.5, terrain 1.5, air 17.6, surplus 7.5, discharge 10.5, basin 0.4, water 11.3 (14 files), ground 8.3 (19 files), ground tiles about 3.7 and pyramid about 1.3 [INFERENCE: the tier-4 sizes per tile, 0.65 MiB and 0.16 MiB, times the tile counts]. Tier 3 adds about 2.6 GiB of stage files (heights, receivers and flooded 0.28, terrain 0.09, air 1.1, surplus 0.47, discharge 0.66, basin 0.02) plus the cascade's scratch [INFERENCE: about 3 GiB, one quarter of the tier-4 chain's 5.2 GB; not measured], all gone but the 0.19 GiB of heads when `coarse` is done, which is before any tier-5 stage but `tiers`; so the tier-3 phase peaks near 12 GiB and does not touch the tier-5 peak. With the deletions the bake peaks at 47.5 GiB when the water stage is done (before the q files go) and ends at about 50 GiB with the ground tiles and pyramid; with `--keep-all` it ends at about 74 GiB. Both are under the 100 GB hard stop.

## 5. Killing it at any moment

- State is the disk's: done markers (`t<tier>-<stage>-done.u8`, the files at their sizes, tile counts), never the driver's memory. `bake-progress.json` is only what the disk cannot say (calls, seconds, peak RSS); if it is absent or torn it is rebuilt from the `call-end` lines of `bake.log` (tested), and the disk's state, tiles and bytes are re-read at every save.
- A kill of the driver leaves a lock file holding its pid and the command of its call in flight. The next driver sees the pid dead (or reused: `ps` must name `globe-bake-driver`), moves the lock aside, takes its own, and if a process with the dead driver's command line still runs (its call is not over: it holds the stage's files) waits for it (patience: budget + grace + 30 s, then SIGKILL) before it starts. A second driver on a live lock is refused (exit 1) and leaves the first's lock alone.
- A kill of a child: the call ends with the signal; if the stage moved anything (the measure, or the size or time of a file in the stage's `watch` list: a solve's steps) the count of calls without progress starts again, else it grows; 3 in a row stop the driver with the last 12 lines of the child's output.
- A whole-file output a kill cut short (written by one `writeFileSync`: the tier files, the discharge, the basin) has the wrong size; the stage's `whole` list names them with their sizes and the driver removes a wrong-sized one before the next call, so the script makes it again instead of trusting it.
- The tile stages (`stages.ts runTiles`) write their `t<tier>-<stage>-done.u8` to a `.part` file and rename it over the marker, so a SIGKILL leaves the old marker whole. The tier is in the name because tiers 3 and T share the bake dir (without it tier 5's `terrain` would have read tier 3's 384-byte marker as its first 384 tiles done: found while writing this table, fixed in `stages.ts` `doneFileOf`); the old tier-less name is read only when it holds the tier's tile count, as `runTiles` does, and the driver does the same (tested). The preallocated outputs are always at their full size.
- Tested with fake stages (the fixture: N tiles, a sleep, a done file, can fail or die): end to end with spent files deleted after their consumer's last call and the consumer reading them at every tile; a spent family that keeps its exceptions (the coarse heads) while every later tile reads them; SIGKILL of the driver (the orphan call is waited for) and of a child, each ending in the byte-identical directory of an undisturbed run; a stage that dies after each tile (6 calls), one that fails twice then works, one that fails always (3 calls, exit 1); a call over its time; `--stop-after`, `--from`, `--max-calls`, `--status` while running; SIGTERM; the free-space floor and the hard stop (exit 3, stage named, nothing lost: rerun finishes); a second driver refused, a dead pid's lock and a non-driver pid's lock taken over; the progress file rebuilt; a torn whole file removed; the lock wait not counted against the budget and the lock free after the run. The real table is tested for order, needs, kinds (CPU streamed from tier 5, GPU below), commands, marker names against `stages.ts`, and the spent lists against the inputs of every later stage.

## 6. Measured

On a real store: the tier-4 bake of key `883a8d9387df` (read-only, status and dry run; a symlinked copy in scratch for the real CPU stages). Every file of that directory belongs to a stage's list (test), every stage's inputs are there (the surplus weights, spent by that bake, and the tier-3 files and heads, which that bake never made, excepted), and the table reads it as a finished bake: tiers, terrain, air, surplus, discharge, basin, water, ground, ground tiles (1,536), pyramid (2,046) done, maps not; the tier-3 stages and `coarse` `done*` (implied by `water`). `--dry-run --tier 5` on it prints `discharge` and `basin` as `bun scripts/globe-water-stream.ts ...` with no `lockf`.

The two CPU stages run through the driver on that directory's stage files (calls of `--budget` 15 to 40 s, the real scripts, the real done predicates):

| stage | tiles | calls | seconds | s a tile | on disk | bytes a tile | peak RSS |
|---|---|---|---|---|---|---|---|
| ground tiles | 1,536 | 2 of 15 s, then 2 more | 89 | 0.058 | 0.97 GiB | 0.65 MiB | 4.9 GB (mapped stage files) |
| pyramid | 2,046 | 4 of 40 s | 113 | 0.055 | 0.33 GiB | 0.16 MiB | 0.13 GB |

At tier 5 that is 6,144 ground tiles (about 6 minutes, 2 calls, 4.0 GB) and 8,190 pyramid tiles (about 7.5 minutes, 2 to 3 calls, 1.3 GB) [INFERENCE: the cost of a tile does not change with the tier; the page cache holds four times more]. The GPU stages were not run by the driver here.

## 7. Gaps and what the driver does not do

- No script is missing for a stage the plan names. The planet's coarse stages (tier 0, `scripts/globe-planet.ts`) are not the driver's: `tiers` is refused, with the missing paths, if `chain`, `ice` and `climate1` of the key are not in `/tmp/planet-small/store`. The store's path is that script's constant; the test compares them.
- `scripts/globe-water.ts` takes `--tier` now (tier 3 and 5 both go through it), and `globe-stage.ts`, `globe-groundtiles.ts`, `globe-pyramid.ts`, `globe-maps75.ts` and `globe-water-stream.ts` do too; a script that does not is refused for any tier but PLANET_TIER.
- **Not verified (the scripts and stages were not run):** (1) that `t3-flow` needs only `t3-height.i32` of the bake dir (the script reads it; `tierTable` is built from the planet store); (2) the exact list of files `coarse` reads beyond the ones named (`water-global.ts` `globalWater` at tier 3: heights, receivers, flooded, basin, q, cells, rock, drift, dd, pr, pe; a file it reads that the table does not list would fail in the stage's own error, not in the driver's input check); (3) that `t3-g-head<k>-part.i32` and `t3-g-casc<k>.json` are the only scratch names: the family `t3-g-*` is spent whole except the heads, and the unprefixed `g-solve<k>.json` is in `g-*`, so a scratch name outside both families would stay on disk; (4) that the streamed discharge and basin leave no file the table does not name beyond their `.work` dirs and `.part` files; (5) the sizes and seconds of every tier-3 stage and of `coarse`'s calls (WaterStage's note: about 300 s a solve in calls of 230 s); (6) `globe-water.ts` acquires a GPU device for every stage, `flow` included, so the tier-3 calls run under the lock; the streamed script at tier 5 takes none.
- `tiers` shows 5 files, not steps, in the table (its steps are in the log: `tier 5: 7 of 12 steps`); `discharge` and `basin` have no tile counts (9 and 1 files).
- `--from X` assumes the stages before X are done: it refuses X (with the names) if a stage X needs is not.
- The progress file's `bytesOnDisk` is allocated bytes (`du`), so a sparse stage output that is half written counts half.
- Memory of the stages at tier 5 is the stage scripts' business and the driver only measures it (peak RSS column). The discharge and the lakes at tier 5 are streamed (RSS under 1 GB, DischargeStream's note), so the in-memory 22 GB is not a gap any more.

## Cost model (tier 5)

The planet at tier 5 has 6,144 tiles of 256 x 256 cells (4 times tier 4's 1,536) and 402.7 M cells. Seconds are what was measured on the M3 Pro with the GPU shared with other agents' jobs (**contended**: an upper bound; at tier 4 the same air tile took 2.9 s on a quiet GPU and 5 to 8 s on a busy one, so the quiet figure is about 0.4 to 0.6 of the contended one [INFERENCE from that one pair]). Nothing here was run on a real tier 5: the tile stages were run on a synthetic sparse tier-5 store (`tier5.test.ts`: terrain, air, `runTiles`, blocks), the rest are tier-4 measurements per tile carried over (a tile is 256 x 256 cells whatever the tier, and the stages' halos are in cells: [INFERENCE] the per-tile cost does not change; air's halo does, below).

| stage | s a tile (tier 5) | 6,144 tiles | calls of 240 s | disk (GiB, driver notes) | memory |
|---|---|---|---|---|---|
| tiers 1 to 5 (TierStream) | not measured here (tier 4: 15.9 s a step in memory, 12 steps) | | | 6.5 | GPU 5.6 GB at tier 4 for the in-memory solve; the streamed solve is TierStream's |
| terrain | 0.025 (tier 4) | 2.6 min | 1 | 1.5 | small (patch 288 x 288) |
| air, a tile a patch (block 1) | 5.2 (patch 1,056 x 1,056, halo 400) | 8.9 h | 133 | 17.6 | 1.7 GB RSS |
| air, 2 x 2 tiles a patch (block 2) | 2.24 (patch 1,312) | 3.8 h | 57 | | 2.4 GB RSS |
| **air, 4 x 4 tiles a patch (block 4, the driver's)** | **1.12 (patch 1,824)** | **1.9 h** | **29** (13 patches of 16 tiles a call) | | 2.1 GB RSS |
| surplus | 0.02 (tier 4) | 2 min | 1 | 7.5 (6.0 spent after discharge) | files mapped |
| discharge (streamed, CPU, no lock, block 4) | about 2 min whole (DischargeStream's note) | about 2 min | 1 | 10.5 | under 1 GB RSS |
| basin (streamed, CPU, block 4) | about 20 s whole | about 20 s | 1 | 0.4 | under 1 GB RSS |
| tier-3 stages and `coarse` (the cascade: about 300 s a solve, WaterStage's note section 13) | not measured here (384 tiles at tier 3) | | `coarse` 2 to 4 of 230 s | about 2.6 + scratch, then 0.19 kept | tier 3 in memory, 25 M cells |
| water on seeded patches (patch 512, halo 128, K = 48 sweeps, `--coarse 3`) | 0.5 (0.4 to 0.5; WaterStage's note section 13, contended) | about 0.9 h | 13 | 11.3 | mapped files |
| ground | 0.10 | 10 min | 3 | 8.3 | 0.4 to 0.5 GB |
| ground tiles (CPU) | 0.058 | 6 min | 2 | 3.7 | 0.5 GB heap, the stage files mapped |
| pyramid (CPU, 8,190 tiles) | 0.055 a tile | 7.5 min | 2 to 3 | 1.3 | 0.13 GB |

Total wall time with the quiet-GPU factor unknown: about **3.2 hours contended** from tiers' end to the pyramid (air 1.9 + water 0.9 + the rest 0.4), plus the tier-3 stages and `coarse` (unmeasured; the cascade about 10 to 20 minutes), the tiers (unmeasured) and the maps; peak disk 47.5 GiB, ending near 50 GiB (driver notes), far under the 100 GB stop.

**Air's halo is the one cost that changed with the tier.** The rain's blocks are the children of a tier-0 cell: 2^tier cells, so 32 at tier 5. The rain reaches `4 R + 8 + (2 B - 1) + B passes + (2 B - 1)` cells for B = 32: 390, a halo of 400 against tier 4's 320. A single tile's patch is 1,056 x 1,056 cells (1.1 M) for 65,536 interior cells: 17 cells computed for each one kept; the tier-4 patch was 12.3. Per tile that is 5.2 s at block 1 where tier 4 took 2.9 to 5 s.

**What dominates:** air (1.9 h at block 4) and water on seeded patches (0.9 h): about 90% of the wall time after the tiers. Both are halo-bound: the cost is the patch, not the interior (air: 400 of halo; water: 128).

**What cuts cost without changing a byte** (all of them leave every stored word the same, which is what tile independence is, tested):
1. *Air in blocks of tiles* (done, `--block 4`, the driver's default): the halo is shared by 16 tiles, 5.16 to 1.12 s a tile (4.6 times), 8.9 h to 1.9 h; byte for byte the same as single tiles (`tier5.test.ts`: four tiles one at a time against one block of 2 x 2, every stored file). A block of 8 (patch 2,848, 8.1 M cells, about 5.5 GB of kernel words) was not tried [INFERENCE: over the GPU's buffer limit].
2. *Water in blocks* (the water stage has no `block` yet; `stages.ts` makes any stage's block a one-word change): the seeded patch of 512 x 512 for 256 x 256 interior is 4.0 cells for each kept; block 2 (768) is 2.25, block 4 (1,152) is 1.7 [derived from the patch sizes; the sweep count is fixed (48), so it does not rise with the patch], so up to about 2 times faster than the 0.9 h; not tried.
3. *CPU work per patch* (the patch's metric 0.5 s, the planet's fields sampled to the cells 0.44 s at tier 4; once per process: the background 0.54 s, the response table 0.28 s) is per patch, so blocks share it too; the driver's 29 calls start 29 processes (about 2 s each).
4. *Ground tiles and the pyramid* read each source row per field; reading a row once for the fields that share a file, and a hoisted per-cell closure, would cut the CPU time without changing a byte (PyramidTiles' notes); the gzip level would change bytes and is left alone.
5. *Memory:* `globalField` maps the stage's input files (a tile touches the pages of its patch), so no stage holds a 1.6 GB plane (RSS counts the mapped pages: compare it to the 4 GB rule with that in mind).

**Not measured (stated, not estimated):** the tiers 1 to 5 at tier 5 (TierStream's), the real tier 5 of any stage, the maps, a quiet GPU's time for any stage but one tier-4 air tile.
