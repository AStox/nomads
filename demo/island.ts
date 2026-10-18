// The game's island generator, its fine ground and everything on it, and the seeded random stream, bundled for the
// browser so the demo grows the same islands the game does.
export { generateIsland } from "../src/gpu/terrain/island";
export { theGpu } from "../src/gpu/device";
export { fineGroundGpu, sceneryGpu } from "../src/gpu/terrain/scenery";
export { CELL, N } from "../src/terrain/grid";
export { COVERS, FLORA, GROUND, K, LAKE, M, RIVER, RM, ROCKY, SEA, SIZE, SPECIES, START, STEP, TILES, TILE_M, clamp, crownShare, fbm, groundClass, hash, noise, riverSmooth, smooth, streamAt, waterAt, worldSlope } from "../src/terrain/flora";
export { LEPTOSOL, SC } from "../src/terrain/ground";
export { depthOf, flowNow, widthOf } from "../src/terrain/water";
export { COLORS, NAMES, rng } from "../src/sim/world";
