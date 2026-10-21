# The planet's bake driver (plan Unit 7b: the bake as resumable calls, driven in order)

Owner: AirStage.BakeDriver. Code: `scripts/globe-bake-driver.ts` (the stage table and the engine; `scripts/globe-bake.ts` is the viewer's planet export and is not touched). Tests: `src/gpu/globe/bake-driver.test.ts` (22 cases, 46 s, no GPU), fixture `src/gpu/globe/bake-driver-fixture/fake-stage.ts`. Chain: `docs/plans/2026-10-20-001-feat-seamless-globe-plan.md` Unit 7b, `2026-10-21-planet-75m-impl.md` (the tier-4 bake by hand: 31 calls, 1 h 55 min), `-water.md`, `-air.md`, `-ground.md` (what each stage reads and makes).

## 1. What it is

One process that runs every stage of one seed's bake in order as separate subprocess calls of at most `--budget` seconds each, and calls a stage again until the stage's own files say it is done. A GPU stage's call runs under `lockf /tmp/nomads-gpu.lock`, taken for that call and released when it ends (the driver holds nothing between calls); the CPU stages (ground tiles, pyramid, maps) run without it. It never starts a stage whose inputs are not on disk.

```
bun scripts/globe-bake-driver.ts --seed 1 --key <planet key> [--tier 5] [--budget 240] [--from <stage>] [--stop-after <stage>] [--max-calls N]
     [--water global|patch] [--status | --dry-run] [--keep-all] [--min-free-gb 20] [--max-gb 100] [--grace 45] [--stages-file <json>]
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
| `tiers` | GPU | `globe-tiers-stream.ts --last T` (tiers 1 to T, each resumable; `--tier` there means one tier, so it is not passed) | `t<T>-height.i32`, `-to.u32`, `-acc.u32`, `-flooded.i32` at 4 bytes a cell and `t<T>-run.json` | `t1`..`t<T-1>-height.i32` (read by the next tier only), the work dirs `stream-t*` |
| `terrain` | GPU | `globe-stage.ts --stage terrain --tier T` | `terrain-done.u8`: 6 4^T bytes, all 1 | |
| `air` | GPU | `globe-stage.ts --stage air --tier T` | `air-done.u8` | |
| `surplus` | GPU | `globe-water.ts --stage surplus --tier T` | `surplus-done.u8` | |
| `discharge` | GPU | `globe-water.ts --stage discharge --tier T` | `t<T>-q0..3-lo.u32`, `-hi.u16`, `t<T>-cells.u32` at their sizes | `t<T>-vs0..3.u32` (the surplus weights it sums) |
| `basin` | GPU | `globe-water.ts --stage basin --tier T` (one call: the script takes a device though `basinOf` is CPU) | `t<T>-basin.u8` at 1 byte a cell | `t<T>-lakenet.i32` |
| `global` | GPU | `globe-water.ts --stage global --tier T` (the water as one solve; `--water global`, the default) | `g-final-done.u8` | `t<T>-q0..3-lo.u32`, `-hi.u16`, `t<T>-cells.u32`, and the family `t<T>-g-*` (the chain's scratch) |
| `water` | GPU | `globe-water.ts --stage water --tier T` (the same stored files made on patches; `--water patch`) | `water-done.u8` | the same q files and cells |
| `ground` | GPU | `globe-stage.ts --stage ground --tier T` | `ground-done.u8` | |
| `groundtiles` | CPU | `globe-groundtiles.ts --tier T` | 6 4^T files `groundtiles/f<face>/<ty>-<tx>.gt.gz` | |
| `pyramid` | CPU | `globe-pyramid.ts --tier T` (never `--faces`: `pyramid.json` is the done mark only for all six faces) | `pyramid.json` and 2 (4^(T+1) - 1) files `pyramid/t*/f*/*.tile.gz` (8,190 at tier 5) | |
| `maps` | CPU | `globe-maps75.ts --tier T` | `maps-done.json`, which the driver writes after the script's exit 0 (the script has no mark; its PNGs go to `/tmp/planet-75m/maps`, shared by all keys) | |

`global` and `water` make the same stored water files (`water.u16 flow.u32 qwet.u32 base.u16 chn.u8 valley.u8 pwr.u16 stb0..3.u16 dry.u16 tab.u16 under.u16 quick.json`): the driver runs one of them, `--water global|patch`, and shows the other as `skipped`. The task's order named both; running both would make the second overwrite the first. Default `global`, the plan's Unit 5b (one solve, the same bytes under any tiling). **Open: at tier 5 the packed global state is 14 planes of 1.5 GiB = 21 GiB (the tier-4 plan in `-water.md` section 10 times four), over the 4.29 GB buffer binding and the machine's memory, so `global` cannot run as built; `--water patch` is the route that runs at any tier today.** Decide with WaterStage; the driver needs no change either way.

Done is the disk's: a stage is also done when a stage that reads its files is (`evaluate`: `needs` edges), so deleting a spent file never makes a finished stage look unfinished (`discharge` is done by `t<T>-basin.u8` once its q files are gone, `tiers` once `terrain` is done). The progress file shows it as `done*` in `--status`.

## 3. Which stage reads which stage's files

`needs` in the table; the files are `inputs`, checked to exist before a stage's first call. `T` is the tier.

```
planet store (/tmp/planet-small/store/<seed>-<key>/chain, ice, climate1: scripts/globe-planet.ts, not the driver's)
  tiers ......... reads the store; makes t1..tT height, tT to, acc, flooded, run.json
  terrain ....... tiers (height)                                  -> rock, drift, dd
  air ........... tiers (height, flooded)                         -> pr0..3 pe0..3 sun0..3 tmp0..3 hum0..3 snow wsh fog snp0..3
  surplus ....... tiers (height, flooded), air (pr, pe: globe-water.ts takes them when t<T>-pr0.u16 EXISTS, so air must be whole first)
                                                                  -> vs0..3, lakenet
  discharge ..... tiers (to), surplus (vs0..3)                    -> q0..3-lo/hi, cells
  basin ......... tiers (height, flooded, to), surplus (lakenet), discharge (q, cells)   -> basin
  global | water  tiers (to, flooded, height), basin, discharge (q, cells), terrain (rock, drift, dd), air (pr, pe)
                                                                  -> the stored water files (above)
  ground ........ terrain, air (pr pe sun tmp hum), water files (height, water, chn, valley, pwr, stb0..3, dry)   -> tree shr grs mar bare soil sflag sandy clayey fert moist sw0..3 ph org carb nit
  groundtiles ... height, water, rock, moist, covers, sflag, soil, clayey, ph, stb3, tab, sun, tmp, sw, pr1, pe1, wsh, fog, snp, to, chn, flow, base, under, quick.json
  pyramid ....... height, rock, drift, dd, tmp0..3, pr0..3, water, flow, tree shr grs mar bare, soil
  maps .......... height, acc, flooded (and, when there, flow, water, pr, the covers)
```

The viewer export (`scripts/demo.ts`) reads `pyramid/` and `pyramid.json` only; the ground tiles are read by the page. Nothing else reads a stage file after `maps`.

## 4. Spent files, and what is kept

Only the names in a stage's own list are ever deleted, and only after that stage's own done mark says it is done (also after a restart: the deletion is idempotent). `--keep-all` deletes nothing. Each deletion is a log line naming the file, its bytes, who made it and who read it last. `bake-driver.test.ts` checks that no file of any list is read (an input, or a done predicate) by a later stage, that no done marker is spent, and that the viewer's files (`pyramid`, `pyramid.json`, `groundtiles`) are in no list.

Bytes at tier 5 (402,653,184 cells; a u8 plane is 402,653,184 B = 0.375 GiB, u16 0.75 GiB, u32 and i32 1.5 GiB) [derived]:

| file | each | count | made by | deleted when |
|---|---|---|---|---|
| `t1`..`t4-height.i32` | 6.3 MB, 25.2 MB, 100.7 MB, 402.7 MB | 4 | tiers | `tiers` done |
| `stream-t<k>/` work dirs | the script removes them on success; what a kill leaves | | tiers | `tiers` done |
| `t5-vs0..3.u32` | 1,610,612,736 | 4 = 6.0 GiB | surplus | `discharge` done |
| `t5-lakenet.i32` | 1,610,612,736 | 1.5 GiB | surplus | `basin` done |
| `t5-q0..3-lo.u32` | 1,610,612,736 | 4 | discharge | `global` (or `water`) done |
| `t5-q0..3-hi.u16` | 805,306,368 | 4 | discharge | same |
| `t5-cells.u32` | 1,610,612,736 | 1 | discharge | same (the three kinds: 10.5 GiB) |
| `t5-g-*` | the global water's scratch, names are WaterStage's | a family | global | `global` done |

Kept on purpose, though no stage reads them after the next one: `t5-acc.u32` (maps), `t5-basin.u8` (the water stage's lakes), `t5-snow.u8`, the ground's `sandy fert org carb nit` (the stage's products: the ground tiles format does not carry them yet, and ground is the cheap stage to redo, but the page may want them), `t5-pe0..3`, `t5-hum0..3`. They are 9.4 GiB together; deleting them is a list entry each if the disk asks for it.

Disk at tier 5 by stage (GiB, files only; sizes exact except the last two) [derived, INFERENCE for the last two]: tiers 6.5, terrain 1.5, air 17.6, surplus 7.5, discharge 10.5, basin 0.4, water 11.3 (14 files), ground 8.3 (19 files), ground tiles about 3.7 and pyramid about 1.3 (the tier-4 sizes per tile, 0.65 MiB and 0.16 MiB, times the tile counts). With the deletions the bake peaks at 47.3 GiB when the water stage is done (before the q files go) and ends at about 50 GiB with the ground tiles and pyramid; with `--keep-all` it ends at about 69 GiB. Both are under the 100 GB hard stop; the `global` route adds its `t5-g-*` scratch (about 21 GiB for one set of packed planes, more for the pass files: not measured).

## 5. Killing it at any moment

- State is the disk's: done markers (`<stage>-done.u8`, the files at their sizes, tile counts), never the driver's memory. `bake-progress.json` is only what the disk cannot say (calls, seconds, peak RSS); if it is absent or torn it is rebuilt from the `call-end` lines of `bake.log` (tested), and the disk's state, tiles and bytes are re-read at every save.
- A kill of the driver leaves a lock file holding its pid and the command of its call in flight. The next driver sees the pid dead (or reused: `ps` must name `globe-bake-driver`), moves the lock aside, takes its own, and if a process with the dead driver's command line still runs (its call is not over: it holds the stage's files) waits for it (patience: budget + grace + 30 s, then SIGKILL) before it starts. A second driver on a live lock is refused (exit 1) and leaves the first's lock alone.
- A kill of a child: the call ends with the signal; if the stage moved anything (the measure, or the size or time of a file in the stage's `watch` list: a solve's steps) the count of calls without progress starts again, else it grows; 3 in a row stop the driver with the last 12 lines of the child's output.
- A whole-file output a kill cut short (written by one `writeFileSync`: the tier files, the discharge, the basin) has the wrong size; the stage's `whole` list names them with their sizes and the driver removes a wrong-sized one before the next call, so the script makes it again instead of trusting it.
- Not the driver's, noted: the tile stages (`stages.ts runTiles`) rewrite their `<stage>-done.u8` with `writeFileSync` (truncate, then write) after every tile, so a SIGKILL inside it can leave a short marker; the tiles past its end are made again (right, wasteful). The preallocated outputs are always at their full size.
- Tested with fake stages (the fixture: N tiles, a sleep, a done file, can fail or die): end to end with spent files deleted after their consumer's last call and the consumer reading them at every tile; SIGKILL of the driver (the orphan call is waited for) and of a child, each ending in the byte-identical directory of an undisturbed run; a stage that dies after each tile (6 calls), one that fails twice then works, one that fails always (3 calls, exit 1); a call over its time; `--stop-after`, `--from`, `--max-calls`, `--status` while running; SIGTERM; the free-space floor and the hard stop (exit 3, stage named, nothing lost: rerun finishes); a second driver refused, a dead pid's lock and a non-driver pid's lock taken over; the progress file rebuilt; a torn whole file removed; the lock wait not counted against the budget and the lock free after the run.

## 6. Measured

On a real store: the tier-4 bake of key `883a8d9387df` (read-only, status and dry run; a symlinked copy in scratch for the real CPU stages). Every file of that directory belongs to a stage's list (test), every stage's inputs are there (the surplus weights, spent by that bake, excepted), and the table reads it as a finished bake: tiers, terrain, air, surplus, discharge, basin, water, ground, ground tiles (1,536), pyramid (2,046) done, maps not.

The two CPU stages run through the driver on that directory's stage files (calls of `--budget` 15 to 40 s, the real scripts, the real done predicates):

| stage | tiles | calls | seconds | s a tile | on disk | bytes a tile | peak RSS |
|---|---|---|---|---|---|---|---|
| ground tiles | 1,536 | 2 of 15 s, then 2 more | 89 | 0.058 | 0.97 GiB | 0.65 MiB | 4.9 GB (mapped stage files) |
| pyramid | 2,046 | 4 of 40 s | 113 | 0.055 | 0.33 GiB | 0.16 MiB | 0.13 GB |

At tier 5 that is 6,144 ground tiles (about 6 minutes, 2 calls, 4.0 GB) and 8,190 pyramid tiles (about 7.5 minutes, 2 to 3 calls, 1.3 GB) [INFERENCE: the cost of a tile does not change with the tier; the page cache holds four times more]. The GPU stages were not run by the driver here.

## 7. Gaps and what the driver does not do

- No script is missing for a stage the plan names. The planet's coarse stages (tier 0, `scripts/globe-planet.ts`) are not the driver's: `tiers` is refused, with the missing paths, if `chain`, `ice` and `climate1` of the key are not in `/tmp/planet-small/store`. The store's path is that script's constant; the test compares them.
- When this was written `scripts/globe-water.ts` did not take `--tier` (it reads PLANET_TIER), so the water stages are refused at any other tier (the dry run shows `BLOCKED`) and run at tier 5 as they are; `globe-stage.ts`, `globe-groundtiles.ts`, `globe-pyramid.ts` and `globe-maps75.ts` take it.
- `tiers` shows 5 files, not steps, in the table (its steps are in the log: `tier 5: 7 of 12 steps`); `discharge` and `basin` have no tile counts (9 and 1 files).
- `--from X` assumes the stages before X are done: it refuses X (with the names) if a stage X needs is not.
- The progress file's `bytesOnDisk` is allocated bytes (`du`), so a sparse stage output that is half written counts half.
- Memory of the stages at tier 5 is the stage scripts' business and the driver only measures it (peak RSS column): the GPU buffers of discharge (5.6 GB at tier 4) and the tier solver, and the global water's state, are four times larger.

## Cost model (tier 5)

(AirStage: the cost model goes here.)
