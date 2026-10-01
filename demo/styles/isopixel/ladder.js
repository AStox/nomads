// The zoom ladder. Every level has a fixed bearing, scale and exaggeration, so nothing re-fits while panning.
// Neighbours are at most 2x apart in art pixels per meter, so a continuous zoom can always show one at 2 to 4 screen
// px per art px. The tuned levels are island, region, valley and close; the rest sit between them. The island levels
// halve their tiles from one that fits the whole island in about 48 tiles down to 50 m; everything finer is paged:
// each chunk builds its own map, so no bearing needs an island-wide one. One look at every level: the same textures
// from the same world fields, only the tile size and pixel scale differ. Its own module, so the page can read it
// without loading the bake's drawing code.
import { SIZE } from "../island.js";

const ISLE = [50];
while (SIZE / ISLE[0] > 48) ISLE.unshift(ISLE[0] * 2);
export const LADDER = [
  ...ISLE.map((tileM, i) => ({ name: i === 0 ? "island" : `isle${tileM}`, W: 12, lp: 2, tileM })),
  { name: "region", W: 16, lp: 2, tileM: 37.5, paged: true },
  { name: "vale", W: 24, lp: 3, tileM: 28.125, paged: true },
  { name: "valley", W: 32, lp: 4, tileM: 18.75, paged: true },
  { name: "near", W: 40, lp: 5, tileM: 11.71875, paged: true },
  { name: "yard", W: 48, lp: 6, tileM: 8, paged: true },
  { name: "close", W: 58, lp: 7, tileM: 6.25, paged: true },
];
// a level's index by name
export const levelOf = (name) => LADDER.findIndex((l) => l.name === name);
// the finest level with an island-wide map, which paged levels fall back on for water before their chunks are baked
export const FINEST_ISLE = LADDER.findLastIndex((l) => !l.paged);
