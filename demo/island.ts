// The game's island generator, its fine ground and everything on it, and the seeded random stream, bundled for the
// browser so the demo grows the same islands the game does.
export { generateIsland } from "../src/terrain/island";
export { CELL, N } from "../src/terrain/grid";
export { COVERS, FLORA, K, M, RM, SIZE, SPECIES, START, STEP, clamp, fbm, fineGround, hash, noise, scatter, smooth } from "../src/terrain/flora";
export { COLORS, NAMES, rng } from "../src/sim/world";
