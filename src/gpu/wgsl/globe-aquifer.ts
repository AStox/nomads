// The water table's relaxation over the whole tier as one grid (Unit 5b): the island's own step (terrain-water.ts `aq_cell_n`, with the plants' draw `gw_et` and everything they call, taken
// from the island's kernel text by name, so there is one law) applied to every cell in the order of aquifer.ts's four colours, the neighbours of a cell found from its place across tile and
// face edges as globe-regional.ts finds them (its `nbr`, taken from that text). Fields are one i32 word a cell in GFIELDS order, `LEN` = the tier's cell count apart: `col` is the colour.
// The answer of a sweep is the same for any tiling of the work and any order of the cells of one colour.
import { EDGES } from "../globe/grid";
import { FIXED } from "./fixed";
import { constsOf, kernelsOf, planetWater, type WaterFormat } from "./terrain-water";
import { regionalWgsl } from "./globe-regional";

// The fields of the global state: the head, the fixed-head flag and the cap of a channel's head, the ground, the five weights of a cell's balance, the plants' draw's constants and the
// seasons' bucket (sh) and potential evaporation (pe), then the colour. sh0..3 and pe0..3 are contiguous.
export const GFIELDS = ["head", "isf", "fxv", "h", "ww", "we", "wn", "ws", "wd", "evk", "sso", "eaf", "evd", "evb", "eve", "evs", "evw", "evu", "sh0", "sh1", "sh2", "sh3", "pe0", "pe1", "pe2", "pe3", "col"] as const;

// The top-level function called `name` of a WGSL text, to its closing brace.
function fnOf(src: string, name: string): string {
  const at = src.indexOf(`fn ${name}(`);
  if (at < 0) throw new Error(`globe-aquifer: no function ${name} in the water kernels`);
  let depth = 0, seen = false;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") { depth++; seen = true; } else if (src[i] === "}" && --depth === 0 && seen) return src.slice(at, i + 1);
  }
  throw new Error(`globe-aquifer: ${name} does not close`);
}
const lineOf = (src: string, start: string) => {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`globe-aquifer: no ${start} in the regional kernels`);
  return src.slice(at, src.indexOf("\n", at));
};

export const globalFormat = (cells: number, omega?: number): WaterFormat => ({ ...planetWater(256), len: cells, omega });
export function aquiferWgsl(tier: number, omega?: number): string {
  const fn = 256 * 2 ** tier, cells = 6 * fn * fn, kernels = kernelsOf(globalFormat(cells, omega)), regional = regionalWgsl(EDGES, fn);
  const water = ["gi", "gu", "wi", "wu", "gs", "s64", "smul64", "sat32", "mulshr", "exp2n", "gw_frac", "reed_fit", "wet_extra", "gw_et", "aq_cell_n"].map((n) => fnOf(kernels, n));
  return /* wgsl */ `${FIXED}
${constsOf(globalFormat(cells, omega), GFIELDS)}
const FN = ${fn}u; const FNI = ${fn}i; const CELLS = ${fn * fn}u;
${lineOf(regional, "const EDGE_FACE")}
${lineOf(regional, "const EDGE_SIDE")}
${lineOf(regional, "const EDGE_FLIP")}
${lineOf(regional, "const DXY")}
${lineOf(regional, "const NONE")}
@group(0) @binding(0) var<storage, read_write> F: array<i32>;
@group(0) @binding(1) var<storage, read_write> C: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> P: array<u32>;
${fnOf(regional, "nbr")}
${water.join("\n")}
// P[0] the colour to move, P[1] the word of C to keep the largest change in, P[2] 1 to visit the cells from the last to the first (the answer is the same: a colour's cells do not read each other)
@compute @workgroup_size(256)
fn aqg(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  _ = arrayLength(&F); _ = arrayLength(&C); _ = arrayLength(&P);
  let k0 = gid.x + gid.y * nwg.x * 256u;
  if (k0 >= LEN) { return; }
  let k = select(k0, LEN - 1u - k0, P[2] == 1u);
  if (gu(f_col, k) != P[0]) { return; }
  let d0 = gi(f_h, k) - F[f_head + k];
  let c = aq_cell_n(k, nbr(k, 2u), nbr(k, 0u), nbr(k, 3u), nbr(k, 1u));
  if (c != 0u) { atomicMax(&C[P[1]], c); if (d0 < ${8 * 2 ** 17}i) { atomicMax(&C[2u + P[1]], c); } }
}
`;
}
