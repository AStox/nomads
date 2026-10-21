// The order of a global relaxation of the water table (Unit 5b): a Gauss-Seidel sweep over the whole tier gives one answer whatever the tiling or the order the tiles are visited in only if
// the order is defined by a cell's identity, as colours: all the cells of one colour are updated at once from the cells of the other colours, so no update reads a cell that moves in the same
// dispatch. The grid of a face is two-coloured by the parity of X + Y; across a face's edge the neighbour's parity is not consistent (the 4-neighbour graph of a cube's faces is not
// bipartite: the three cells at a cube's corner are pairwise neighbours, and along four of the twelve edges the parity of both sides agree). So a cell whose neighbour across an edge has its
// own parity and a larger id is `late`: it is moved after the rest, in the colour 2 + its parity (two late cells that are neighbours then differ in parity, and a late cell's larger
// neighbour of its own parity is not late unless it has a still larger one, which only happens in a corner's triangle, where the parities differ again) [design: checked as a proper colouring
// of the whole graph by aquifer.test.ts at tiers 0 and 1; the late cells are 4 fn pairs, 16,384 at tier 4, 0.016% of the cells, a list a kernel visits apart from the grid].
import { FACES, tierGrid } from "./grid";
import { cellAcross } from "./patch";

export const COLOURS = 4;
export const neighbours4 = (tier: number, id: number): number[] => {
  const g = tierGrid(tier), n = g.fn, f = Math.floor(id / (n * n)), r = id - f * n * n, Y = Math.floor(r / n), X = r - Y * n, out: number[] = [];
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { const c = cellAcross(g, f, X + dx, Y + dy); if (c >= 0) out.push(c); }
  return out;
};
const parity = (n: number, id: number) => { const r = id % (n * n), Y = Math.floor(r / n); return (Y + r - Y * n) & 1; };
// The colour of a cell of the tier (0 to 3), a function of the cell's identity only.
export function colourOf(tier: number, id: number): number {
  const n = tierGrid(tier).fn, b = parity(n, id);
  for (const j of neighbours4(tier, id)) if (j > id && parity(n, j) === b) return 2 + b;
  return b;
}
export const colouring = (tier: number): Uint8Array => {
  const N = FACES * tierGrid(tier).fn ** 2, out = new Uint8Array(N);
  for (let id = 0; id < N; id++) out[id] = colourOf(tier, id);
  return out;
};
