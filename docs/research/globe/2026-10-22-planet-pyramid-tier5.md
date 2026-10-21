# The pyramid and ground tiles at tier 5 (391 km planet)

## What changed
- `bake.ts` `file` of every `GROUNDTILE_FIELDS` entry is tier-free (`height.i32`); the file of tier `t` is `tierFile(t, file)`. `scatter.ts` stageSource reads `tierFile(ctx.tier, ...)` (it read `t4-` literals).
- `makeGroundTile(dir, tile, {seed, key, tier})`, `buildGroundTiles(dir, {seed, key, tier, ...})` use `tileAt(tier, k)`, `patchOf(tier, ...)`, `tileCount(tier)`. Numbering `face * T * T + ty * T + tx`; at tier 4 unchanged.
- `buildPyramid` is resumable. Work unit = the subtree below one tile of `unitTier` (default `topTier - 3`: tier 5 gives tier 2 roots, 16 units a face, 96 units, 85 tiles each). Tiles are written depth first, each as `.part` then renamed, so a unit's root file exists only when its whole subtree is on disk. A unit whose root exists is kept; one without is made again whole. When a face's units all exist, tiers 0 to `unitTier - 1` (21 tiles a face at tier 5) are pooled from the roots' files read back; the face's tier 0 tile is written last and marks the face done. `pyramid.json` is written when every requested face is done. `budgetS` stops before a unit that would pass the budget (worst unit so far * 1.3); a call with a unit left always makes at least one. Returns `{done, unitsMade, unitsKept, units, counts, seconds}`.
- Scripts: `globe-pyramid.ts --tier --budget (240)`, `globe-groundtiles.ts --tier`, `--faces` expands to `tileCount(tier) / 6` tiles a face; `globe-maps75.ts --tier --radius` (radius default `fn * 75 m * 2 / pi` [derived]), memory-mapped fields (three whole tier-5 height/acc/flooded arrays would be 4.8 GB).

## Proof
- Tier-2 synthetic pyramid (126 tiles): hash `7a47ba4f4462aad` pinned from the old code before the edit; new code equals it with unit tier 0, 1 and 2, and after a bake stopped after every unit with a unit's root deleted and `.part` files planted.
- Real key 883a8d9387df, face 0 (341 tiles) baked by the new code is byte-identical to the files the old code wrote; real ground tiles 0, 458, 1535 are byte-identical to the files on disk.
- Tier 5 on a sparse store (fields hold the cell id): tiles 0, 15, 31, 992, 1023, 1024, 1500 have every halo cell equal to `cellAcross` ids; the 64 corner cells at the four face corners repeat the nearest cell with no channel; receivers decode.

## Cost model (tier 4 real, CPU, shared machine)
- Pyramid unit (85 tiles, 64 top): 5.5 s alone (cold), 4.6 s a unit in the next call; 0.086 s a top tile. Peak RSS 124 MB. Of a top tile: gzip + pack 10 ms, pooling 4 children 20 ms (a third of the tiles), so the rest, ~60 ms, is the 22 positional row reads per field-row and the per-cell `convert` [INFERENCE: not profiled finer].
- Pyramid bytes (gzip): t0 331 kB, t1 309, t2 275, t3 238, t4 199 kB a tile; whole tier-4 pyramid 345 MB for 2,046 tiles.
- Ground tile: 0.03 to 0.16 s making + 0.01 to 0.05 s gzip; raw 4.88 MB; gzip 0.23 to 1.95 MB (sea tiles small, land large), 1.0 GB for 1,536 tiles; RSS 523 MB.
- Tier 5 (6 * 4^k tiles: 6,144 / 1,536 / 384 / 96 / 24 / 6 = 8,190): ground tiles 6,144 * ~0.2 s = about 20 min, ~4 GB. Pyramid 96 units * ~6 s = about 10 min (3 calls of 240 s), ~1.4 GB (top tier 6,144 * ~200 kB). Cut with no byte changed: the conversion loop (hoist the closure call and `raw` array per cell, read each row once for the several fields sharing a file) is the larger share of the pyramid; gzip level is a bytes-for-time trade and would change the files, so leave it.

## Findings
- `groundtile.ts` reads the water stage's quick runoff from `quick.json`, but the water stage writes `t<tier>-quick.json` keyed by tile index: every ground tile's `meta.quick` is null (confirmed on tile 421 of the real bake). Left as it was, since the tier-4 bytes must not change; fix is `dir.json(tierFile(tier, "quick"))` and a re-bake of the ground tiles. WaterStage owns the file.

## Napkin
- A tile file's existence marks it whole only if written `.part` then renamed; resumable work is a subtree whose root is written last.
- `mappedField` (mmap) for global fields at tier 5; never `dir.i32(...)` of a 1.6 GB file.
