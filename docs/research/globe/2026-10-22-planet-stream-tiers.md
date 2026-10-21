# The tier chain out of core (plan Unit 7b, tiers 1 to 5 streamed from disk)

Chain: `docs/plans/2026-10-20-001-feat-seamless-globe-plan.md` Unit 7b, on `2026-10-21-planet-75m-impl.md` (the in-memory chain, `tiers.ts`, `regional.ts`). The planet is 391.1 km (8,192 cells a face, tier 5 at 75 m, 402.7 million cells). The in-memory `Regional` holds 15 words of 4 bytes a cell (64 bytes with the flooded surface): 6.4 GB at tier 4, 25.8 GB at tier 5 (peak process 38 GB), against 18 GB of memory and a 4.29 GB buffer binding limit. This note is the streamed solve that makes the **same bytes** with a memory that does not depend on the tier, what was proven, what it costs, and what is open.

## What was built

| file | what |
|---|---|
| `src/gpu/globe/tilestore.ts` (+ `.test.ts`) | a tier's planes on disk tile-major (one file a plane, 256 by 256 cells a tile, `tile = face * T * T + ty * T + tx`), positional reads and writes, a byte-bounded tile cache, halo `gather` and interior `scatter` over a patch (patch.ts `cellAcross`, no second copy of the cube-sphere neighbour rule), `swap`, `fromCells`/`toCells`/`putCells` to the chain's row-major files. The API WaterStage's fine level uses. |
| `src/gpu/globe/patch.ts` | a patch's interior may be a block of tiles (`interior`), and `patchAt` makes its ids by arithmetic inside the face (the ring only through `cellAcross`). |
| `src/gpu/wgsl/globe-regional.ts` | `regionalWgsl(edges, fn, nflow, patch?)`: **the same laws in a patch layout** (a cell's neighbours are its neighbours in the patch, its place is read from `IDS`, the halo is read and never written: `cid`, `nbr`, `interior`). The laws were split only where the streamed solve needs them apart (`incise_skip`/`incise_one`, `tally_count`/`tally_loss`); the in-memory entry points call the same functions with `interior` true. Patch-only kernels are plumbing (`todfrom`, `todir`, `resinit`, `incisep`, `inject`, `rescount`, `erzero`, `tallyc`, `tallyl`). No law was copied or changed. |
| `src/gpu/globe/regional-patch.ts` | the buffers of one patch (15 words a cell, `IDS`, the tier-0 tables in `AT` kept on the device across patches). |
| `src/gpu/globe/tiers-stream.ts` | `StreamedTier` (the stages, the progress kept between calls), `refineBlock` (the carry to the next tier a block at a time), `streamTier` (one tier of the chain into the files `tiers.ts` writes). |
| `src/gpu/globe/regional.ts`, `tiers.ts` | shared: `child4` (the stencil of `refineSmooth` and of `refineBlock`), `around3`, `creepSubsOf`, `tierParent`, `tierParams`, `TIER_STEPS` with tier 5. |
| `scripts/globe-tiers-stream.ts` | the resumable driver: `--budget`, `--tier`, `--last`, `--key`, `--block`, `--order`, `--steps`, `--max-steps`, `--mem` (the in-memory oracle), `--check <dir>` (compare the tier's files by hash). |

## The design: what is exact and why

A tier is solved a **block** at a time: a block of 4 by 4 tiles (1,024 by 1,024 cells; `--block`) and a halo of one cell, laid flat across the face's edges, run through the very kernels of the in-memory solve. Every stage of a step is one of three kinds, and for each the streamed order gives the in-memory bytes by an argument, not only by measurement:

1. **Local with a halo** (weights, cellmeans, recv, tally, lift passes 1 to 3, one creep substep): a cell's answer depends on the planes within one cell of it; blocks are visited in any order, one pass each. Jacobi stages (creep) read one plane and write another and swap them (`TileStore.swap`), so a visit never reads a neighbour's new value. The tier-0 cell's land cells never straddle a block (32 children at tier 5 divide 256), so the loss and land count of each tier-0 cell are tallied in one block and kept on the device (8 MB) from one block to the next; the lift's three passes need only that table.
2. **Monotone fixed points** (the flood, the landslides): the flood `f = max(h, least neighbour f + eps)` starts from infinity on land and only falls (`eps` is 1, above zero, so the fixed point is unique); the slide's `min(h, ...)` only falls from the heights. A decreasing chaotic iteration of a monotone map ends at the greatest fixed point below the start, whatever the order and however the updates are cut into blocks. Each block is run to its own fixed point with the halo as it stands, and a block whose edge cells changed puts its neighbours back on the list; the list empties at the global fixed point. Measured: 2.8 visits a block at tier 5 for the flood (about 1,000 rounds each in the global solve), 1.7 for the slides. The slide's loss (`ER`) is a telescoping sum, so it is booked per visit and added up per tier-0 cell, the same total.
3. **The tree stages** (depth, discharge area, the implicit incision): globally coupled, solved by two different exact methods.
   - *Discharge area* is a sum of u32 weights, so order does not matter. **Area1**: each block sums its own cells with the halo cells as roots (the same pointer jumps, depth sort and gather as the in-memory solve, in the patch). The cells that drain out of a block into another form a **forest across blocks** (22,758 cells at tier 4 for 1,024-cell blocks, 90,508 for 256-cell tiles; the deepest path crosses 7 blocks, 14 tiles): each exit's parent is the exit that carries its receiver's sum on (read from the pointer-jump root of the receiving cell). The forest is summed on the host from the leaves in exact integers (**skel**). **Area2**: each block sums again with what flows in from beyond its edge added to the weight of the cell it flows into. Exactly the in-memory sum; an overflow of 32 bits throws as it does there.
   - *Incision* is a recursion along each flow path, `h'(k) = F_k(h'(receiver))`, an integer map with rounding, a clamp and conditions: **it cannot be composed across blocks in closed form, so it is evaluated, not composed**. A cell is incised when its receiver's final height is known. Each block settles, in the order of the depth in the block, every cell whose chain reaches a settled cell (the sea, a lake, rock with no erodibility, a cell of another block already settled, kept as a bit a cell: `RES`); a block with cells whose chain leaves by an unsettled cell waits and is visited again when a neighbour settled a cell on its edge. Every cell's value is a function of its receiver's final value alone, so any order that settles receivers first gives the in-memory bytes (the in-memory solve is one such order, the global depth). Blocks are taken in the order of their lowest flooded surface, so a river is mostly settled in one visit of each block it crosses: 2.3 visits a block at tier 5, bounded by the crossing depth (7).
   - Why not the other options the assignment named: *disk-resident global TO/depth/H/ACC in depth order* needs 6 to 7 planes of 1.6 GB resident plus the ordering (about 11 GB) and a random read of H[TO[k]] for every cell of every depth level; *a tile-edge graph that composes the incisions* has no closed form (the rounding and the clamp); the waves cost a few visits and no extra memory.

**Bytes per cell.** Resident per cell of the tier: **0**. Resident per cell of a block: 17 words (15 fields, `IDS`, the flooded surface), 118 MB of GPU buffers in all for blocks of 1,024 (including the 44 MB table of tier-0 cells and the 8 MB of tier-0 tables), plus the tile cache (256 MB budget) plus the process (Bun, the planet, the table, the parent heights of the tier above for the start: 0.4 GB at tier 5). Disk per cell: H, F, ACC (4 bytes each) and TOD, RES (1 each) = 14 bytes, 5.6 GB at tier 5, plus a copy-on-write clone of H kept for the step (`H.bak`, up to 1.6 GB) and, for the final flow, the receivers' ids (1.6 GB); the finished files (height, to, acc, flooded) are 6.4 GB.

**Resume.** Progress (stage, blocks left, the skeleton, the tier-0 tables) is saved at the end of each call; the planes are on the disk. A call marks the progress as running when it starts; a call that dies inside a step leaves the mark, and the next call begins that step again from `H.bak` and the carries kept at the step's start (tested by spoiling a tile and setting the mark: bytes equal). A call that stops at its budget between visits loses nothing. Not tested: a real kill (the same path as the simulated one).

## What was proven (all against the in-memory chain, the code of the committed law)

The reference is the in-memory chain of seed 1 on the planet of key 883a8d9387df (`/tmp/planet-75m/exp/1-883a8d9387df`, made by `scripts/globe-tiers.ts`: tier 1 start, then 40, 40, 40 and 12 steps). The streamed chain starts from its tier 1 and carries every tier from the streamed tier above (`refineBlock`), the table from `tierTable`.

| what | streamed | in memory | |
|---|---|---|---|
| tier 2, 40 steps (4 calls of 40 s, blocks of 512) | height `3c089e17e2c3b42f` | the same | equal |
| tier 3, 40 steps (2 calls, blocks of 1,024) | height `9977835311c7cda9` | the same | equal |
| tier 4, 12 steps and the settled flow (3 calls, blocks of 1,024) | height `defd8eccba1765b3`, to `e122d0cbd38b9510`, acc `7ee7a48da2b491fd`, flooded `8d3b5d911e8dac7c` | the same four | equal |
| **two tilings** at tiers 3 and 4: blocks of 512 cells visited in reverse order, in 5 calls | the same five hashes | | equal |

All hashes are the first 16 hex of sha256 of the file. The unit tests (`tiers-stream.test.ts`, tier 2 on a staged ridge along the edge of faces 0 and 1): `refineBlock` equals `refineSmooth` word for word on every block of tier 1; 2 steps and the settled flow (heights, carries, receivers, area, flooded surface) equal the in-memory solve in blocks of 256, 512 and 1,024 cells, in reverse order and in a shuffled order; calls of 0.4 s (more than three) give the same bytes; a call that died inside a step is begun again and ends equal. `regional.test.ts` (the global layout) passes unchanged.

**Tier 5** cannot be compared (it does not fit). The synthetic tier 5 (the tier 4 heights above carried by `refineBlock`, one step, the settled flow, the four files written; `/tmp/planet-75m/exp-stream/syn5`, deleted after) checks the invariants: 87.2 million land cells and 315.4 million sea, **every land cell drains to a lower flooded neighbour and every sea cell to itself (bad 0)**, 13,948 receivers cross a face's edge and 358,207 a tile's (`tiers.ts drainage`); the largest discharge area is 0.23 of 2^32 (the in-memory `area` kernel throws past 2^32; the same here).

## Cost (measured on a GPU shared with two other agents, load average 3 to 5: upper bounds)

| | tier 2 (6.3 M) | tier 3 (25 M) | tier 4 (100.7 M) | tier 5 (402.7 M, synthetic) |
|---|---|---|---|---|
| in-memory step | 0.6 s | 4.5 s | 16 to 26 s | does not fit |
| streamed step (blocks of 1,024; tier 2 of 512) | 2.4 s | 8.4 s | 36 s | **263 s** |
| flood visits / blocks | 3.5 | 3.5 | 3.1 | 2.8 |
| incise visits / blocks | 2.9 | 3.0 | 2.6 | 2.3 |
| creep substeps | 1 | 2 | 7 | 28 |
| peak process memory | 0.8 GB | 1.3 GB | 1.6 GB | **1.7 GB** |

Tier 5, a step by stage (seconds; 384 blocks): init 8, flood 84, recv 13, area1 23, area2 29, incise 43, slide 24, creep 98 (10,752 visits: the substeps of a stiff creep law, one pass over the tier each), lift 8: 263 s. Disk traffic of the whole synthetic run (the start, one step, the flow and the four files): **88 GB read, 65 GB written**, the tile cache answering 99.7% of the row reads (so about 75 GB read and 50 GB written a step, a sixth of the time at an SSD's rates). Tier 5 start (the carry of 100.7 million parents, `refineBlock`, 384 blocks): 37 s.

Total chain on the new planet, calls of 200 s: tiers 1 to 3 in memory about 215 s (3 calls, as measured before; streamed, tier 2 would cost 95 s and tier 3 340 s, tier 1 was not run); tier 4 streamed 12 steps 7.2 min plus the flow (3 calls), or in memory 5 min; **tier 5: 12 steps of 263 s = 52.6 min, plus the start 37 s and the settled flow and the four files about 3 min: about 56 min in 17 calls**. About 75 min of GPU and 25 calls for tiers 1 to 5.

## Choice, and what is open

- **Exactness over IO**: nothing was traded; the visits repeat work (flood about 3 times, incision about 2.3 times a block) but the bytes are the global solve's. The in-memory path stays for tiers 1 to 3 (2 to 5 times faster than streaming there) and the streamed one writes the same files, so downstream stages do not care which made them.
- **Creep is 37% of a step at tier 5** (28 substeps, a pass each). A halo of 4 cells would do 4 substeps a visit (the garbage of the outer ring reaches one cell a substep inward), 7 passes instead of 28; it needs the patch's halo as a parameter through the stage code (the layout already carries `HALO`). Not built.
- Most of a creep visit's 9 ms is the visit's JavaScript and transfers (gather, upload of 4 MB, readback, scatter), not the kernel; and the incision gathers five planes at every visit although only blocks with unsettled cells matter. Both are measured costs, not worked on.
- A block must divide the face's tiles (`--block 1, 2, 4` at tier 2 and up); tier 1 streamed (24 tiles) was not run.
- Hard kill: recovered by restarting the step from its saved heights (simulated, not killed for real).
- `TIER_STEPS` has 12 steps for tier 5 as an unmeasured stand-in [design]: the plan sets the steps by what a step costs, and the number belongs to whoever tunes the erosion.
- The 32-bit area: the real 391 km planet's biggest basin against 2^32 is unknown until it exists (0.23 on the synthetic one).

## How to run

```
export PATH="$HOME/.bun/bin:$PATH"
lockf /tmp/nomads-gpu.lock bun scripts/globe-tiers-stream.ts --seed 1 --key <planet key> --last 5 --budget 200   # again until it says done
bun scripts/globe-tiers-stream.ts --seed 1 --key <key> --tier 4 --last 4 --check <other bake dir>              # hashes
lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/tiers-stream.test.ts -t "<name>" --timeout 280000
```

## Napkin note (for the repo's runbook, not edited here)

**[2026-10-22] A chaotic iteration of a monotone map gives the same bytes in any block order; a recursion with rounding along a flow path does not compose, but it can be evaluated in any order that settles the receiver first.** Do: to move a global solve out of core, classify each stage (halo-local, monotone fixed point, sum, path recursion) and give each its own exact schedule (blocks visited to a fixed point, an exit forest summed on the host, waves of settled cells); test against the in-memory solve word for word on a small tier, with two block sizes and an order reversed, and keep a step's start heights to begin it again after a dead call. Do not trust a block order that happens to give equal bytes once.
