# The planet's discharge and lakes out of core (tier 5 at 402.7 M cells)

Chain: `2026-10-21-planet-75m-water.md` sections 1 and 2 (the in-memory `dischargeOf`, `basinOf`), `2026-10-22-planet-stream-tiers.md` (TierStream's blocks: area1, skeleton, area2). At tier 5 the in-memory discharge needs 22 GB of GPU buffers and `basinOf` holds a plane of state plus two Int32Arrays of the hollow count. Both are now exact streamed computations on the CPU with a memory that does not depend on the tier, giving the same bytes as the in-memory ones.

## What was built

| file | what |
|---|---|
| `src/gpu/globe/discharge-stream.ts` | `dischargeStream(dir, tier, fields, budgetS, log, {block, reverse, work})`: the same `t<T>-q<s>-lo.u32`, `-hi.u16`, `t<T>-cells.u32` as `dischargeOf`. Also `BlockGrid` (blocks of B x B tiles, the ring of a block laid flat across the face's edges by patch.ts `cellAcross`), `Plane`/`Planes` (positional reads with a band cache), `solveSkeleton`. |
| `src/gpu/globe/basin-stream.ts` | `basinStream(dir, tier, budgetS, log, {block, reverse, work, stems})`: the same `t<T>-basin.u8` as `basinOf`, and its count of lakes and dry hollows. |
| `scripts/globe-water-stream.ts` | `--stage discharge|basin --tier T --key K --block B --budget S [--reverse] [--dir D]`; no GPU. |
| `src/gpu/globe/water-stream-fixture.ts`, `discharge-stream.test.ts`, `basin-stream.test.ts` | the tests' staging (a forest of descent on a smooth potential, smooth hollows) and the cases below. |

## The discharge (exact, why)

A weight is a u32; a basin's sum is under 2^48 (thrown where not, as `dischargeOf` does) so every partial sum is an integer in a double: the order of the additions cannot change a bit, which is why a Kahn order on the CPU in doubles equals the GPU's two-word gather word for word. The count-of-cells weight is a sum of ones (under 2^32, stored as u32 like `dischargeOf`).
- **area1**: per block, the sums of every weight over each cell's in-block upstream (receivers inside the block; a cell whose receiver lies outside is an EXIT; the ring cells are roots). Kahn's order over the block's local receivers (`recv`), leaves first, `Float64Array` per weight. For each INFLOW edge (a ring cell whose receiver is a cell of the block) the exit at the end of the in-block downstream path of the cell it lands on (`end`, found roots first; -1 where the chain ends in a sea cell of the block).
- **skeleton**: the exits are a forest across blocks (an exit's parent is the exit of the block it flows into, or none); summed on the host from the leaves, per weight, in doubles (34,156 exits at tier 4 with 1,024-cell blocks, solved in under 0.1 s; about 2 to 3 times that at tier 5 [INFERENCE: the perimeter of blocks grows with the face's side]). It throws when the count of exits is not the count of inflow edges (a receiver that is not an 8-neighbour found in the ring would show here) or a total passes 48 bits.
- **area2**: the same sums with each inflow edge's exit total added at the cell it lands on, written into the output files' rows.
- Receivers are 8-neighbours in the data: the skeleton check passes on real tier 4 (8,939 receivers cross a face's edge, 8 of them next to a face's corner) and on the staged planets; the corner's missing diagonal is `cellAcross` returning -1 (a cube corner's three cells are all neighbours of each other).

## The lakes (exact, why)

`basinOf`'s rule over the whole tier: hollows are the 4-neighbour components (across tile and face edges) of cells with height > 0 and flooded - height >= 3 units; a component whose deepest cell passes 768 units is a candidate; it is a lake where the sum of its cells' lake net plus the four seasons' discharge of every cell `o` outside it (8-neighbours `around`) with `to[o]` a cell of it is >= 0.
- **label**: per block, a flood fill (explicit stack) of the block's own components with each one's deepest cell and lake net. A component with a cell on the block's edge next to a hollow cell across it is TOUCHING (it may continue in another block); the rest is whole. Per block the file keeps, for the touching ones, the deepest, the lake net and the labels along the four edges. The host joins them across every block and face edge in a union-find of size blocks x 4S (ids `block * 4S + k`), adds up deepest and lake net per joined component. At tier 4: 19,078 block components of which 216 touch (blocks of 1,024); the host holds a number bounded by the blocks' edges, never a plane.
- **inflow**: for every component whose lake is undecided (touching, or whole and deeper than 3 m) the original's loop, cell by cell: neighbour `o` of member `c` with `to[o] = c` adds the four seasons' discharge unless `o` is a member too, which is decided by the joined component's id (a ring cell is in another block: a member only if both are touching and joined; membership is by the merged id, not the local label). A whole component is decided here and its cells written; a touching one adds its inflow to the host's total.
- **write**: the joined components that hold a lake write their cells in every block they cover.
- Every sum is an integer far under 2^53 (checked in the tests by the byte-for-byte result and by mutation: disabling the ring-membership rule fails the staged and the real case).

## Resume

Per block a small file or a marker in the work directory (`discharge-stream-t<T>.work`, `basin-stream-t<T>.work` in the bake dir; deleted when done), the outputs as `.part` files renamed when every block is done, and a `meta.json` (a run of another block size or other fields is refused). A call does at least one block, stops before a block that would pass the budget (the worst block so far x 1.3), and the next call goes on; the bytes do not depend on where the calls were cut, the block size or the order (`reverse`). A block's results are written atomically (temp file and rename), a block made again is idempotent (tested by removing a marker).

## Memory and reads

No mapped files: `Bun.mmap`'d pages stay resident until the process ends (RSS grew to 2.5 GB at tier 4, would be 8 to 16 GB at tier 5). `Plane` reads a block's window as the whole band of rows it lies in, once, one large sequential read kept while the blocks along the band are made (and `at(id)` answers from the band when the cell lies in it, which serves the ring's left and right cells). First tried: 1,024 `pread`s of 4 KB rows a plane a block: 27 to 31 s for the basin on real tier 4 under page cache pressure (a 16 KB page was read four times; 5 to 8 ms a plane-block against 1 ms warm); mapped: 11 s warm; bands: 4.4 to 5 s.

## Tests (real tier 4 of planet 883a8d9387df; oracle: the in-memory files)

The weight files `t4-vs0..3.u32` were spent: they are found from the in-memory result as the forest's inverse (every cell's sum less the sums of the cells that drain into it; every result is a u32 under 2^21 and the ones come out as 1 everywhere, 0 cells wrong), which is exact and independent of the streamed scheme.

| case | result |
|---|---|
| synthetic forest, tier 1 (descent on a smooth potential: 1.5 M cells, basins past 2^32, thousands of receivers across face edges, some next to a corner), blocks of 1 and 2 tiles (2 by 2 and 1 face a block), forward and reverse | every word equals `gatherTwin` (CPU twin) |
| calls of no budget (30+ calls), a done marker removed after | same sha256 of all five files |
| a started run with another block size is refused; a sum past 48 bits throws | pass |
| **real tier 4, blocks of 4** | sha256 of the 9 files (`t4-q0..3-lo/hi`, `t4-cells`) equal to `dischargeOf`'s, 4,000 random cells word for word |
| **real tier 4, blocks of 2, reverse order** | same |
| **real tier 4, calls of 8 s** (5 calls, alternate orders) | same |
| synthetic hollows, tier 1 (smooth blobs, net on the scale of the inflows: 198 lakes, 94 dry), blocks of 1 and 2, forward and reverse | `t1-basin.u8` byte for byte equal to `basinOf`, same count of lakes and dry |
| staged planet tier 2 (GPU, pits over a tile's edge and a face's edge), blocks of 1, 2 and 4, discharge streamed too | discharge and lakes equal the in-memory |
| calls of no budget (40+), a write marker removed | same bytes and counts |
| **real tier 4, blocks of 4 and of 2 (reverse), calls of 1 s (16 calls)** | `t4-basin.u8` equal byte for byte (sha256 and 20,000 cells), 5,497 lakes and 1,437 dry hollows |

Mutation: changing an injected exit total by one fails the discharge case; calling every ring cell a non-member fails the staged and the real lakes (so the cases see what they claim to).

## Cost (tier 4: 100.7 M cells, 96 blocks of 1,024; machine shared with other agents, load average 4 to 6 on 12 cores, page cache under pressure at times)

| | per block | tier 4 whole | tier 5 whole (384 blocks, 4.0 x the blocks at the same block cost) |
|---|---|---|---|
| discharge area1 | 0.03 to 0.05 s | 3 to 5 s | 12 to 19 s |
| skeleton | | 0.0 s (34,156 exits) | under 1 s [INFERENCE] |
| discharge area2 | 0.20 to 0.26 s (25 ms Kahn, the rest the nine strided row writes) | 19 to 25 s | 77 to 100 s |
| **discharge total** | | **20 to 30 s** | **about 100 to 120 s, one call of 250 s** |
| basin label / inflow / write | 0.01 / 0.03 / 0.02 s (34 of 96 blocks write) | 3 to 5 s | **about 15 to 25 s** warm; the reads are about 26 GB, under a minute from a cold disk [INFERENCE] |

Blocks of 2 (512): discharge 31 s, basin 3 s (384 blocks at tier 4). Disk traffic at tier 5: discharge reads 16 GB (`to` 1.6 GB and four weights 6.4 GB, in each of the two passes) and writes 11.3 GB (4 x 1.6 lo, 4 x 0.8 hi, 1.6 cells); basin reads about 26 GB (h, f, net each twice, `to`, four q lo and hi) and writes 0.4 GB. Peak RSS measured at tier 4: **0.41 to 0.46 GB** for the discharge and 0.43 GB for the basin, which is the bands (16 MB a plane, 5 and 14 planes) and a block's arrays; at tier 5 a band is 33.5 MB a plane: about 0.6 GB [INFERENCE].

## What the driver should call (a note for the orchestrator; `scripts/globe-bake-driver.ts` was not edited)

```ts
const p = await dischargeStream(dir, tier, dischargeFields(tier), budgetS, log, { block: 4 }); // needs t<T>-to.u32, t<T>-vs0..3.u32; p.done, p.stage, p.blocksDone/p.blocks
const q = await basinStream(dir, tier, budgetS, log, { block: 4 });                              // needs height, flooded, lakenet, to and the discharge's t<T>-q0..3-lo/hi; q.done
```
Both are CPU only (no GPU lock needed), resumable, return `done` like `dischargeOf`; or run `bun scripts/globe-water-stream.ts --stage discharge|basin --tier 5 --key K --budget 250` until it says done. `dischargeFields` is water.ts'. Replace `dischargeOf`/`basinOf` at tier 5 only: they remain the oracles at tier 4 and below.

## Open

- Area2 is 65 to 70% strided row writes (nine planes, 1,024 writes of 2 to 4 KB each, 11 s of 15 s at tier 4). A band-buffered output (the band's blocks assembled and written once, flushed at a band change or a call's end) would cut it to about a third; not built (the discharge is about 2 minutes at tier 5).
- `WATER_TABLE_UNITS` and `HOLLOW_MIN_UNITS` are duplicated in `basin-stream.ts` (water.ts' are not exported and WaterStage was editing the file); the real tier 4 case fails if they drift. Suggest water.ts imports them from `basin-stream.ts`.
- Tier 5 itself was not run (its inputs do not exist yet); the extrapolation is from tier 4 with the same block cost. A killed process (not a stopped call) was simulated by removing a marker, not killed for real.
- The skeleton and the host union-find are in the heap: 34,156 exits and 19,164 block components at tier 4; they grow with the blocks' perimeter, not the cells.
- The synthetic receivers are 8-neighbour descent; a receiver farther than a neighbour makes the discharge throw (counts differ), the basin does not check `to`.

## How to run

```
export PATH="$HOME/.bun/bin:$PATH"
bun test ./src/gpu/globe/discharge-stream.test.ts -t "<name>" --timeout 280000
bun test ./src/gpu/globe/basin-stream.test.ts -t "<name>" --timeout 280000      # the staged planet's case under lockf /tmp/nomads-gpu.lock
bun scripts/globe-water-stream.ts --stage discharge --tier 5 --key 883a8d9387df --block 4 --budget 250
```
