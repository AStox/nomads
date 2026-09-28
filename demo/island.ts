// The game's island generator, its fine ground and everything on it, and the seeded random stream, bundled for the
// browser so the demo grows the same islands the game does.
export { generateIsland } from "../src/terrain/island";
export { CELL, N } from "../src/terrain/grid";
export { COVERS, FLORA, GROUND, K, LAKE, M, RIVER, RM, ROCKY, SEA, SIZE, SPECIES, START, STEP, clamp, fbm, fineGround, groundClass, hash, noise, riverSmooth, scatter, smooth, waterAt, worldSlope } from "../src/terrain/flora";
export { COLORS, NAMES, rng } from "../src/sim/world";
