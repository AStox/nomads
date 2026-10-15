// The seeds' and seedlings' daily law in WGSL (src/gpu/seedlings.ts drives it; docs/research/plant-constants.md sec. 13;
// the constants come from src/sim/seeds.ts). All of it integer arithmetic, every draw a pure function of the identity
// it belongs to, and every sum order-free, so every GPU gives the same words.
//
// Seeds are streamed: on each day of its kind's shed, every live parent stem with a crop sheds a share of its year's
// seed, and each seed is evaluated on its own. Seed k of the stem in slot i (generation g) in year y lives to come up
// when word k mod 4 of the Philox block (i, k / 4) under the key (seed ^ g G, SURV + y) falls below its kind's chance;
// block k / 4 sheds on day from + (k / 4) mod (to - from) of the window, so a parent that dies sheds nothing after.
// One that lives draws where it lands from its own stream (seed ^ g G, LAND + y, i, k): a distance by its kind's kernel
// and one of 1,024 bearings. Landing off the island or on water it is gone; else it joins its texel's count of that
// kind's seed in the soil (pend), which comes up on the kind's day as one group of seedlings (a bin) a texel.
//
// Seedlings are lumped: a bin is so many members of one kind that came up on one day in one texel, and every input of
// their law (the crowns over their texel, their cell's coefficients, their 600 m block's deer and rabbits) is shared, so
// they share one state (q, the most q has been). Each day a bin grows, starves when q falls to half its peak's mass (as
// the stems do), loses Bin(n, kill) members to browsing (the exact binomial, keyed by the bin and day), and is thinned
// with the bins of its texel: the larger first (ties by slot), each takes its members' crowns' shares of the texel, and
// a bin keeps as many as fit what the larger leave (the largest at least one). Members are numbered 0 to n0 - 1 as
// they came up; the live ones are ranks 0 to n - 1 of the bin's seeded Feistel permutation, so a member's identity is
// (bin, rank) and losses take the highest ranks. A bin of young trees as tall as its cell's own stand, or of brambles
// in their second summer at a bush's mass, is marked; the next day each member stands up as a stem of kind plant at a
// place in the texel drawn from its identity, and the bin is gone.
import { CELL, N } from "../../terrain/grid";
import { FIXED } from "./fixed";
import { RAND } from "./rand";
import { DIED, HALF_Q, HC, HQ, LAID, MAP, QSTEP, ROW_WORDS, RW, SSTEP, T1, T2, TEXELS, TEXELS_SIDE, TEXEL_MM, TREE_ROWS } from "./stems";

// The seedlings' kinds, in the stems' row order (plants.ts STEM_ROWS): their row is the stems' row.
export const SEED_ROWS = ["pine", "oak", "ash", "aspen", "berry"] as const;
export const ROW_OF = { pine: 0, oak: 1, ash: 2, aspen: 3, berry: 4 } as const;
export const BERRY = 4;
// The seed in the soil, a run of TEXELS counts a layer: ash's two (by the year it fell, as two winters pass before it
// comes up), and the brambles' seedlings, daughters and aspen's suckers, which come up the day they arrive.
export const LAYER = { pine: 0, oak: 1, ash0: 2, ash1: 3, berry: 4, daughter: 5, sucker: 6 } as const;
export const LAYERS = 7;
// How each layer's seed is shed: by its parents' crops, by a bramble's crown, by a bramble's chance of a daughter.
export const MODE = { seeds: 0, berry: 1, daughter: 2 } as const;
// The browsing densities' blocks: 8 x 8 cells, 600 m [design], 32 x 32 over the island.
export const BLOCK_CELLS = 8, BLOCKS_SIDE = N / BLOCK_CELLS, BLOCKS = BLOCKS_SIDE * BLOCKS_SIDE;
// The drivers buffer (sd), by word: each cell's growth coefficients, YOUNG_WORDS a cell (by row: the plant rule's
// alpha and beta, then the tree law's), each cell's stand height by tree row (mm), the browsing kills by count in a
// block (deer, then rabbits, Q16 a day), and the dry texels (a bit each).
export const YOUNG_WORDS = 4 * SEED_ROWS.length;
const CELLS_N = N * N;
export const SD = { young: 0, stand: CELLS_N * YOUNG_WORDS, browse: CELLS_N * (YOUNG_WORDS + 4), dry: CELLS_N * (YOUNG_WORDS + 4) + 2048 } as const;
export const SD_WORDS = SD.dry + TEXELS / 32;
// The work buffer: the day's deer and rabbits by block, then the census.
export const WORK = { blocks: 0, census: 2 * BLOCKS } as const;
// The census, by word: bins by row; members by row (two words each, low then high); bins marked to stand up and their
// members (two words); seed in the soil by layer (two words each).
export const CENSUS = { bins: 0, members: SEED_ROWS.length, grads: 3 * SEED_ROWS.length, gradMembers: 3 * SEED_ROWS.length + 1, pend: 3 * SEED_ROWS.length + 3 } as const;
export const CENSUS_WORDS = CENSUS.pend + 2 * LAYERS;
export const WORK_WORDS = WORK.census + CENSUS_WORDS;
// A bin's what word: its row, and GRAD once it is to stand up.
export const GRAD = 0x100;
// The counter streams (keys' second words; the shed's add the year).
export const STREAM = { surv: 0x53000000, land: 0x4c000000, berry: 0x42000000, daughter: 0x44000000, sucker: 0x2a000000, sland: 0x2b000000, browse: 0x62726f77, ident: 0x6964656e, place: 0x706c6163 } as const;
// A generation folded into the world seed, so a stem's slot reborn draws anew.
export const GMIX = 0x9e3779b1;
// The bearings, cos of 2 pi j / 1024 in Q16 (sin by a quarter turn back).
export const BEARINGS = 1024;
export const COS = Int32Array.from({ length: BEARINGS }, (_, j) => Math.round(Math.cos((2 * Math.PI * j) / BEARINGS) * 65536));
// A disc's area over its radius squared, Q16.
export const PI_Q16 = Math.round(Math.PI * 65536);

// The constants of the law (src/sim/seeds.ts seedLaw), as WGSL takes them.
export type SeedLawWords = {
  seed: number; dayTicks: number; survive: readonly number[]; pineMean: number; ashScale: number; ashShape: number; ashPow: number;
  oakMu: number; oakSigma: number; birdMean: number; cane: number; berryArea: number; daughter: number; suckerReach: number; suckerLam: number;
  pineLight: number; qup: readonly number[]; deerReach: number; rabbitReach: number; bushMm: number; bramDays: number;
  species: readonly number[]; tree: number; bush: number;
};
// The plant kind's layout (offsets of its fields' runs) and the bins'.
export type PlantLayout = { cap: number; x: number; y: number; what: number; size: number; seed: number; q: number; peak: number; crop: number };
export type BinLayout = { cap: number; texel: number; what: number; born: number; n: number; n0: number; q: number; peak: number };

const FLAT = /* wgsl */ `fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;
const u = (v: number) => `${v >>> 0}u`;
const i = (v: number) => `${v | 0}i`;
const arr = (a: readonly number[], t: "u32" | "i32") => `array<${t}, ${a.length}>(${a.map(t === "u32" ? u : i).join(", ")})`;

// Constants every kernel shares (no bindings).
function consts(L: SeedLawWords) {
  return /* wgsl */ `
const SEED = ${u(L.seed)}; const DAYT = ${u(L.dayTicks)}; const GM = ${u(GMIX)};
const TSIDE = ${TEXELS_SIDE}u; const TMM = ${TEXEL_MM}u; const NC = ${N}u; const CMM = ${CELL * 1000}u; const ISLE = ${N * CELL * 1000}i;
const NT = ${TEXELS}u; const BMM = ${BLOCK_CELLS * CELL * 1000}u; const BSIDE = ${BLOCKS_SIDE}u;
const HQ = ${HQ}u; const QSTEP = ${QSTEP}u; const HC = ${HC}u; const SSTEP = ${SSTEP}u; const MAPW = ${MAP}u; const RWS = ${ROW_WORDS}u;
const SURVIVE = ${arr(L.survive, "u32")};
const QUP = ${arr(L.qup, "u32")};
const SPECIES_OF = ${arr(L.species, "u32")};
const COS = ${arr([...COS], "i32")};
const PINE_MEAN = ${u(L.pineMean)}; const ASH_SCALE = ${u(L.ashScale)}; const ASH_SHAPE = ${i(L.ashShape)}; const ASH_POW = ${i(L.ashPow)};
const OAK_MU = ${i(L.oakMu)}; const OAK_SIGMA = ${i(L.oakSigma)}; const BIRD_MEAN = ${u(L.birdMean)}; const CANE = ${u(L.cane)};
const BERRY_AREA = ${i(L.berryArea)}; const DAUGHTER = ${u(L.daughter)}; const SUCKER_REACH = ${u(L.suckerReach)}; const SUCKER_LAM = ${i(L.suckerLam)};
const PINE_LIGHT = ${u(L.pineLight)}; const DEER_REACH = ${u(L.deerReach)}; const RABBIT_REACH = ${u(L.rabbitReach)};
const BUSH_MM = ${u(L.bushMm)}; const BRAM_DAYS = ${u(L.bramDays)}; const TREE_K = ${u(L.tree)}; const BUSH_K = ${u(L.bush)};
const BERRY = ${BERRY}u; const LAID = ${LAID}u; const GRAD = ${GRAD}u; const PI_Q = ${PI_Q16}i;
const SDY = ${SD.young}u; const SDS = ${SD.stand}u; const SDB = ${SD.browse}u; const SDD = ${SD.dry}u; const YW = ${YOUNG_WORDS}u;
const WB = ${WORK.blocks}u; const WC = ${WORK.census}u;
${FLAT}
fn cell_of(t: u32) -> u32 { return (t / TSIDE / 4u) * NC + (t % TSIDE) / 4u; }`;
}
// A tree's height in mm at q and a crown's Q16 share of a texel at a height, from the stems' tables (bound as tables),
// as wgsl/stems.ts reads them; a seedling's height (a bramble's a bush's, as the old cohorts had it).
const HEIGHTS = /* wgsl */ `
fn height_at(r: u32, q: u32) -> u32 {
  let j = min(q >> QSTEP, HQ - 2u);
  let lo = tables[r * HQ + j];
  let hi = tables[r * HQ + j + 1u];
  let t = min(q - (j << QSTEP), 1u << QSTEP);
  return lo + (((hi - lo) * t) >> QSTEP);
}
fn crown_at(r: u32, s: u32) -> u32 {
  let base = ${TREE_ROWS * HQ}u + r * HC;
  let j = min(s >> SSTEP, HC - 2u);
  let lo = tables[base + j];
  let hi = tables[base + j + 1u];
  let t = min(s - (j << SSTEP), 1u << SSTEP);
  return lo + (((hi - lo) * t) >> SSTEP);
}
fn young_height(r: u32, q: u32) -> u32 { if (r == BERRY) { return BUSH_MM; } return height_at(r, q); }`;
// The light at a height in a texel: the stems' crowns taller, and half of those as tall, from the stems' raster (bound as
// start and list), layered as the stems' law has it.
const LIGHT = /* wgsl */ `
fn light_at(t: u32, s: u32) -> u32 {
  var above = 0u;
  for (var p = start[t]; p < start[t + 1u]; p++) {
    let h = list[3u * p + 1u] >> 1u;
    let a = list[3u * p + 2u];
    if (h > s) { above += a; } else if (h == s) { above += a >> 1u; }
  }
  let layers = above >> 16u;
  let f = above & 0xffffu;
  if (layers == 0u) { return (65536u - f) + ((f * ${T1}u) >> 16u); }
  if (layers == 1u) { return (((65536u - f) * ${T1}u) >> 16u) + ((f * ${T2}u) >> 16u); }
  return ${T2}u;
}`;
// Where a seed lands: d mm from (x0, y0) on its stream's next bearing; its texel, or NT when off the island or on
// water (the dry bits bound in sd).
const PLACE = /* wgsl */ `
fn landing(x0: u32, y0: u32, d: u32) -> u32 {
  let j = next32() >> 22u;
  let c = COS[j];
  let s = COS[(j + 768u) & 1023u];
  let px = mul64(d, u32(abs(c)));
  let py = mul64(d, u32(abs(s)));
  let ax = i32((px.y << 16u) | (px.x >> 16u));
  let ay = i32((py.y << 16u) | (py.x >> 16u));
  let x = i32(x0) + select(ax, -ax, c < 0i);
  let y = i32(y0) + select(ay, -ay, s < 0i);
  if (x < 0i || y < 0i || x >= ISLE || y >= ISLE) { return NT; }
  let t = min(u32(y) / TMM, TSIDE - 1u) * TSIDE + min(u32(x) / TMM, TSIDE - 1u);
  if (((sd[SDD + (t >> 5u)] >> (t & 31u)) & 1u) == 0u) { return NT; }
  return t;
}
fn hi16(p: vec2u) -> u32 { return (p.y << 16u) | (p.x >> 16u); }
// How far a seed of row r lands from a parent h mm tall, from its stream.
fn reach(r: u32, h: u32) -> u32 {
  if (r == 0u) { return mulhi64(mul64(h, u32(qexpo())), PINE_MEAN).x; }
  if (r == 1u) { return hi16(mul64(u32(max(qlognormal(OAK_MU, OAK_SIGMA), 0i)), 1000u)); }
  let g = qgammav(ASH_SHAPE);
  if (g <= 0i) { return 0u; }
  return hi16(mul64(ASH_SCALE, u32(qpow(g, ASH_POW))));
}`;

// The animals' deer and rabbits counted into their blocks. Bindings: animal body, work. A: the animal kind's capacity
// and its x, y and sp runs.
export function seedBlocks(A: { cap: number; x: number; y: number; sp: number }) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> ab: array<u32>;
@group(0) @binding(1) var<storage, read_write> work: array<atomic<u32>>;
const BMM = ${BLOCK_CELLS * CELL * 1000}u; const BSIDE = ${BLOCKS_SIDE}u;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ${A.cap}u || (ab[i] & 1u) == 0u) { return; }
  let sp = ab[${A.sp}u + i] & 15u;
  if (sp > 1u) { return; }
  let blk = min(ab[${A.y}u + i] / BMM, BSIDE - 1u) * BSIDE + min(ab[${A.x}u + i] / BMM, BSIDE - 1u);
  atomicAdd(&work[${WORK.blocks}u + sp * ${BLOCKS}u + blk], 1u);
}`;
}

// The shedding parents, step one: 1 for each live stem of row P.r with a crop (mode seeds) or of any size (the
// brambles), into m and kept. Bindings: plant body, stems' rows, m, kept, P (r, mode).
export function seedFlag(k: PlantLayout) {
  return /* wgsl */ `
struct Params { r: u32, mode: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> rows: array<u32>;
@group(0) @binding(2) var<storage, read_write> m: array<u32>;
@group(0) @binding(3) var<storage, read_write> kept: array<u32>;
@group(0) @binding(4) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ${k.cap}u) { return; }
  var f = 0u;
  if ((b[i] & 1u) == 1u && rows[min(b[${k.what}u + i] >> 8u, ${MAP - 1}u)] == P.r) {
    let c = b[${k.crop}u + i];
    if (P.mode != ${MODE.seeds}u || (c > 0u && c != ${DIED}u)) { f = 1u; }
  }
  m[i] = f;
  kept[i] = f;
}`;
}
// Step two: each flagged stem's slot at its place in the scan, from word 1 of the list; word 0 the count, and the
// shed's workgroups (one a parent, over two dimensions past 65,535) in args. A list holds at most room parents (the
// most of a kind there can be; past it the rest shed nothing [gap]). Bindings: kept, m (scanned), total, list, args.
export function seedList(cap: number, room: number) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> kept: array<u32>;
@group(0) @binding(1) var<storage, read> m: array<u32>;
@group(0) @binding(2) var<storage, read> total: array<u32>;
@group(0) @binding(3) var<storage, read_write> plist: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: array<u32>;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i == 0u) {
    let t = min(total[0], ${room}u);
    plist[0] = t;
    args[0] = min(t, 65535u); args[1] = max(1u, (t + 65534u) / 65535u); args[2] = 1u;
  }
  if (i >= ${cap}u || kept[i] == 0u || m[i] >= ${room}u) { return; }
  plist[1u + m[i]] = i;
}`;
}

// A share of a day's shed, a workgroup to a parent: its seed (mode seeds) evaluated one by one, a bramble's seedlings
// (mode berry: Poisson(its crown's area x BERRY_AREA) a year, all on its day) or its daughter (mode daughter), each
// landing into the layer's counts. A day's seed blocks are shed over `slices` ticks, slice j taking the day's blocks
// whose number in the day is j mod slices (the sums at the day's end are the same however they are split); the
// brambles' in one. Bindings: plant body, list, sd, pend, P (r, layer, year, dd, S, mode, slice, slices).
export function seedShed(k: PlantLayout, L: SeedLawWords) {
  return /* wgsl */ `
struct Params { r: u32, layer: u32, year: u32, dd: u32, S: u32, mode: u32, slice: u32, slices: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> plist: array<u32>;
@group(0) @binding(2) var<storage, read> sd: array<u32>;
@group(0) @binding(3) var<storage, read_write> pend: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> P: Params;
${FIXED}
${RAND}
${consts(L)}
${PLACE}
var<workgroup> wc: u32;
fn drop_at(t: u32) { if (t < NT) { atomicAdd(&pend[P.layer * NT + t], 1u); } }
@compute @workgroup_size(256) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) l: u32) {
  let w = wid.x + wid.y * nwg.x;
  if (w >= plist[0]) { return; }
  let i = plist[1u + w];
  let mix = SEED ^ ((b[i] >> 1u) * GM);
  let x0 = b[${k.x}u + i];
  let y0 = b[${k.y}u + i];
  let h = b[${k.size}u + i];
  if (P.mode == ${MODE.seeds}u) {
    let c = b[${k.crop}u + i];
    let blocks = (c + 3u) / 4u;
    let step = P.S * P.slices;
    for (var bk = P.dd + (P.slice + l * P.slices) * P.S; bk < blocks; bk += 256u * step) {
      let w4 = philox(vec4u(i, bk, 0u, 0u), vec2u(mix, ${STREAM.surv}u + P.year));
      for (var j = 0u; j < 4u; j++) {
        let s = 4u * bk + j;
        if (s >= c) { break; }
        if (w4[j] < SURVIVE[P.r]) {
          rinit(mix, ${STREAM.land}u + P.year, i, s);
          drop_at(landing(x0, y0, reach(P.r, h)));
        }
      }
    }
    return;
  }
  if (l == 0u) {
    var c = 0u;
    if (P.mode == ${MODE.berry}u) {
      rinit(mix, ${STREAM.berry}u + P.year, i, 0u);
      let rq = i32((h << 16u) / 2000u);
      c = qpoisson(qmul(qmul(qmul(rq, rq), PI_Q), BERRY_AREA));
    } else {
      rinit(mix, ${STREAM.daughter}u + P.year, i, 0u);
      c = select(0u, 1u, next32() < DAUGHTER);
    }
    wc = c;
  }
  let c = workgroupUniformLoad(&wc);
  for (var s = l; s < c; s += 256u) {
    rinit(mix, ${STREAM.land}u + P.year, i, s);
    var d = CANE;
    if (P.mode == ${MODE.berry}u) { d = hi16(mul64(BIRD_MEAN, u32(qexpo()))); }
    drop_at(landing(x0, y0, d));
  }
}`;
}

// A day's suckers, a workgroup to a stump (requests: the count, then x, y and an identity word each): Poisson(the
// suckers over its roots) as four draws of a quarter (each Q16 limited), each sucker at reach sqrt(U) on a bearing.
// Bindings: requests, sd, pend, P (day).
export function seedSuckers(L: SeedLawWords) {
  return /* wgsl */ `
struct Params { day: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> req: array<u32>;
@group(0) @binding(1) var<storage, read> sd: array<u32>;
@group(0) @binding(2) var<storage, read_write> pend: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> P: Params;
${FIXED}
${RAND}
${consts(L)}
${PLACE}
var<workgroup> wc: u32;
@compute @workgroup_size(256) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) l: u32) {
  let w = wid.x;
  if (w >= req[0]) { return; }
  let x0 = req[1u + 3u * w];
  let y0 = req[2u + 3u * w];
  let id = req[3u + 3u * w];
  if (l == 0u) {
    rinit(SEED, ${STREAM.sucker}u, id, P.day);
    var c = 0u;
    for (var q = 0u; q < 4u; q++) { c += qpoisson(SUCKER_LAM); }
    wc = c;
  }
  let c = workgroupUniformLoad(&wc);
  for (var s = l; s < c; s += 256u) {
    rinit(SEED ^ id, ${STREAM.sland}u + P.day, id, s);
    let d = (SUCKER_REACH * isqrt64(vec2u(next32(), 0u))) >> 16u;
    let t = landing(x0, y0, d);
    if (t < NT) { atomicAdd(&pend[${LAYER.sucker}u * NT + t], 1u); }
  }
}`;
}

// The texels whose seed in a layer comes up today: 1 where it holds any, and for Scots pine only where the crowns over
// the texel leave the ground at least PINE_LIGHT. Bindings: pend, raster start, raster list, counts, P (layer, rule).
export function seedEmerge(L: SeedLawWords) {
  return /* wgsl */ `
struct Params { layer: u32, rule: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> pend: array<u32>;
@group(0) @binding(1) var<storage, read> start: array<u32>;
@group(0) @binding(2) var<storage, read> list: array<u32>;
@group(0) @binding(3) var<storage, read_write> counts: array<u32>;
@group(0) @binding(4) var<uniform> P: Params;
${consts(L)}
${LIGHT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let t = flat(g, n);
  if (t >= NT) { return; }
  var f = 0u;
  if (pend[P.layer * NT + t] > 0u && (P.rule == 0u || light_at(t, 0u) >= PINE_LIGHT)) { f = 1u; }
  counts[t] = f;
}`;
}
// The births' initialization of a layer's new bins (store.ts bear, a row a texel): its count, its row, today, and its
// kind's mass on coming up. Extra: pend.
export const emergeInit = (layer: number, row: number, q0: number, dayTicks: number) => /* wgsl */ `
  let nn = pend[${layer}u * ${TEXELS}u + parent];
  child_set_texel(slot, parent); child_set_what(slot, ${row}u); child_set_born(slot, tick / ${dayTicks}u);
  child_set_n(slot, nn); child_set_n0(slot, nn); child_set_q(slot, ${q0}u); child_set_peak(slot, ${q0}u);`;

// A day of every live bin: growth in its texel's light by its cell's coefficients, starving at half its peak's mass,
// browsing in reach of its block's deer and rabbits, and marked to stand up once grown. Bindings: bins, raster start,
// raster list, stems' tables, stems' rows, sd, work, P (day).
export function seedGrow(k: BinLayout, L: SeedLawWords) {
  return /* wgsl */ `
struct Params { day: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> start: array<u32>;
@group(0) @binding(2) var<storage, read> list: array<u32>;
@group(0) @binding(3) var<storage, read> tables: array<u32>;
@group(0) @binding(4) var<storage, read> rows: array<u32>;
@group(0) @binding(5) var<storage, read> sd: array<u32>;
@group(0) @binding(6) var<storage, read> work: array<u32>;
@group(0) @binding(7) var<uniform> P: Params;
${FIXED}
${RAND}
${consts(L)}
${HEIGHTS}
${LIGHT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ${k.cap}u || (b[i] & 1u) == 0u) { return; }
  let r = b[${k.what}u + i] & 255u;
  let t = b[${k.texel}u + i];
  let cell = cell_of(t);
  let q = i32(b[${k.q}u + i]);
  let L = light_at(t, young_height(r, u32(q)));
  let at = SDY + cell * YW + r * 4u;
  var nq = q;
  if (r == BERRY || u32(q) < QUP[r]) {
    let gain = i32((sd[at] * L) >> 16u) - i32(sd[at + 1u]);
    nq = q + ((i32(u32(q) >> 5u) * gain) >> 11u);
    if (r == BERRY) { nq = min(nq, i32(QUP[BERRY])); }
  } else {
    nq = q + i32((sd[at + 2u] * L) >> 16u) - i32(sd[at + 3u]);
  }
  nq = clamp(nq, 0i, i32(rows[MAPW + r * RWS + ${RW.qmax}u]));
  let peak = max(b[${k.peak}u + i], u32(nq));
  if (nq == 0i || u32(nq) < (((peak >> 8u) * ${HALF_Q}u) >> 8u)) { b[i] = b[i] & ~1u; return; }
  let s = young_height(r, u32(nq));
  var nn = b[${k.n}u + i];
  let blk = min(t / TSIDE * TMM / BMM, BSIDE - 1u) * BSIDE + min((t % TSIDE) * TMM / BMM, BSIDE - 1u);
  var kd = 0u;
  var kr = 0u;
  if (s < DEER_REACH) { kd = sd[SDB + min(work[WB + blk], 1023u)]; }
  if (s < RABBIT_REACH) { kr = sd[SDB + 1024u + min(work[WB + ${BLOCKS}u + blk], 1023u)]; }
  let kill = min(kd + kr - ((kd * kr) >> 16u), 65535u);
  if (kill > 0u) {
    rinit(SEED ^ ((b[i] >> 1u) * GM), ${STREAM.browse}u, i, P.day);
    nn -= binom(nn, kill << 16u);
  }
  if (nn == 0u) { b[i] = b[i] & ~1u; return; }
  b[${k.q}u + i] = u32(nq);
  b[${k.peak}u + i] = peak;
  b[${k.n}u + i] = nn;
  var up = false;
  if (r < 4u) { let st = sd[SDS + cell * 4u + r]; up = st > 0u && s >= st; }
  else { up = u32(nq) >= QUP[BERRY] && P.day - b[${k.born}u + i] >= BRAM_DAYS; }
  if (up) { b[${k.what}u + i] = r | GRAD; }
}`;
}

// Thinning, step one: every live bin counted into its texel. Bindings: bins, counts (TEXELS + 1, cleared).
export function seedCount(k: BinLayout) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read_write> count: array<atomic<u32>>;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ${k.cap}u || (b[i] & 1u) == 0u) { return; }
  atomicAdd(&count[b[${k.texel}u + i]], 1u);
}`;
}
// Step two: every live bin filed in its texel's run (counts scanned into starts), three words an entry: its slot, its
// height and the room its members' crowns take (saturating). Where in the run it lands is read by nothing.
// Bindings: bins, starts, cursors (TEXELS, cleared), list, stems' tables.
export function seedFile(k: BinLayout, L: SeedLawWords) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> tstart: array<u32>;
@group(0) @binding(2) var<storage, read_write> cursor: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> tlist: array<u32>;
@group(0) @binding(4) var<storage, read> tables: array<u32>;
${consts(L)}
${HEIGHTS}
fn room(n: u32, a: u32) -> u32 { if (a > 0u && n > 0x7fffffffu / a) { return 0x7fffffffu; } return n * a; }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ${k.cap}u || (b[i] & 1u) == 0u) { return; }
  let t = b[${k.texel}u + i];
  let p = tstart[t] + atomicAdd(&cursor[t], 1u);
  let r = b[${k.what}u + i] & 255u;
  let s = young_height(r, b[${k.q}u + i]);
  tlist[3u * p] = i;
  tlist[3u * p + 1u] = s;
  tlist[3u * p + 2u] = room(b[${k.n}u + i], crown_at(r, s));
}`;
}
// Step three: each bin keeps the members that fit what the larger bins of its texel leave. Bindings: bins, starts,
// list, stems' tables.
export function seedThin(k: BinLayout, L: SeedLawWords) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> tstart: array<u32>;
@group(0) @binding(2) var<storage, read> tlist: array<u32>;
@group(0) @binding(3) var<storage, read> tables: array<u32>;
${consts(L)}
${HEIGHTS}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ${k.cap}u || (b[i] & 1u) == 0u) { return; }
  let t = b[${k.texel}u + i];
  let r = b[${k.what}u + i] & 255u;
  let s = young_height(r, b[${k.q}u + i]);
  let a = crown_at(r, s);
  var used = 0u;
  var larger = false;
  for (var p = tstart[t]; p < tstart[t + 1u]; p++) {
    let j = tlist[3u * p];
    let sj = tlist[3u * p + 1u];
    if (j == i || sj < s || (sj == s && j > i)) { continue; }
    larger = true;
    used = min(used + tlist[3u * p + 2u], 0x7fffffffu);
  }
  let nn = b[${k.n}u + i];
  var keep = nn;
  if (a > 0u) {
    var fit = 0u;
    if (used < 65536u) { fit = (65536u - used) / a; }
    if (!larger) { fit = max(fit, 1u); }
    keep = min(nn, fit);
  }
  if (keep == 0u) { b[i] = b[i] & ~1u; } else { b[${k.n}u + i] = keep; }
}`;
}

// The census: bins and members by row, those marked to stand up, and the seed in the soil by layer, every sum exact in
// 64 bits by carrying. Bindings: bins, pend, work. Over max(capacity, TEXELS) invocations.
export function seedCensus(k: BinLayout) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> pend: array<u32>;
@group(0) @binding(2) var<storage, read_write> work: array<atomic<u32>>;
${FLAT}
fn add64at(w: u32, v: u32) { let old = atomicAdd(&work[w], v); if (old + v < old) { atomicAdd(&work[w + 1u], 1u); } }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  let C = ${WORK.census}u;
  if (i < ${TEXELS}u) {
    for (var l = 0u; l < ${LAYERS}u; l++) { let v = pend[l * ${TEXELS}u + i]; if (v > 0u) { add64at(C + ${CENSUS.pend}u + 2u * l, v); } }
  }
  if (i >= ${k.cap}u || (b[i] & 1u) == 0u) { return; }
  let w = b[${k.what}u + i];
  let r = w & 255u;
  let nn = b[${k.n}u + i];
  atomicAdd(&work[C + ${CENSUS.bins}u + r], 1u);
  add64at(C + ${CENSUS.members}u + 2u * r, nn);
  if ((w & ${GRAD}u) != 0u) { atomicAdd(&work[C + ${CENSUS.grads}u], 1u); add64at(C + ${CENSUS.gradMembers}u, nn); }
}`;
}

// Standing up, step one: each marked bin's members as its count of children (0 for the rest). Bindings: bins, counts.
export function seedGradCount(k: BinLayout) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read_write> cnt: array<u32>;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ${k.cap}u) { return; }
  var c = 0u;
  if ((b[i] & 1u) == 1u && (b[${k.what}u + i] & ${GRAD}u) != 0u) { c = b[${k.n}u + i]; }
  cnt[i] = c;
}`;
}
// Step two, the births' initialization (store.ts births, seedlings into plant): member k (a live rank) of the bin is
// member e = feistel(k, n0) as it came up, and stands at a place in the texel drawn from (bin, e): a tree of its kind as
// tall as its q, or a bramble bush as a bush is laid. Extra: the stems' tables, and these helpers.
export const gradExtra = (L: SeedLawWords) => `${FIXED}
${RAND}
${consts(L).replace(FLAT, "")}
${HEIGHTS}`;
export const GRAD_INIT = /* wgsl */ `
  let r = parent_what(parent) & 255u;
  let t = parent_texel(parent);
  let mix = SEED ^ (parent_gen(parent) * GM);
  let e = feistel(k, parent_n0(parent), fkeys(mix, ${STREAM.ident}u, parent, parent_born(parent)));
  rinit(mix, ${STREAM.place}u, parent, e);
  child_set_x(slot, (t % TSIDE) * TMM + unif(TMM));
  child_set_y(slot, (t / TSIDE) * TMM + unif(TMM));
  var q = parent_q(parent);
  var size = BUSH_MM;
  var kind = BUSH_K;
  if (r < 4u) { size = height_at(r, q); kind = TREE_K; } else { q = LAID; }
  child_set_what(slot, kind + 256u * SPECIES_OF[r]);
  child_set_size(slot, size);
  child_set_seed(slot, next32());
  child_set_q(slot, q);
  child_set_peak(slot, q);`;
// Step three: the marked bins are gone. Bindings: bins.
export function seedGradKill(k: BinLayout) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= ${k.cap}u || (b[i] & 1u) == 0u || (b[${k.what}u + i] & ${GRAD}u) == 0u) { return; }
  b[i] = b[i] & ~1u;
}`;
}

// For tests: where each of a parent's seeds k in [0, n) lands (no survival drawn), its distance in mm and texel (NT
// when lost). Bindings: plant body, sd, out (2 n), P (i, r, year, n).
export function seedLandings(k: PlantLayout, L: SeedLawWords) {
  return /* wgsl */ `
struct Params { i: u32, r: u32, year: u32, n: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> sd: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${FIXED}
${RAND}
${consts(L)}
${PLACE}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let s = flat(g, n);
  if (s >= P.n) { return; }
  let i = P.i;
  rinit(SEED ^ ((b[i] >> 1u) * GM), ${STREAM.land}u + P.year, i, s);
  let d = reach(P.r, b[${k.size}u + i]);
  out[2u * s] = d;
  out[2u * s + 1u] = landing(b[${k.x}u + i], b[${k.y}u + i], d);
}`;
}

// The same seed as an active object (the test of the streamed form): a seed of kind seed (its parent's slot and
// generation, its number k, and its texel: ON_TREE until shed, then where it lies) stepped a day at a time. On its
// day of the window it is shed while its parent stands: it dies or lands by the same draws the streamed shed makes.
// Bindings: seeds, plant body, sd, P (r, year, dd, S).
export const ON_TREE = TEXELS + 1;
export type SeedLayout = { cap: number; parent: number; pgen: number; k: number; texel: number };
export function seedStep(k: PlantLayout, sk: SeedLayout, L: SeedLawWords) {
  return /* wgsl */ `
struct Params { r: u32, year: u32, dd: u32, S: u32 }
@group(0) @binding(0) var<storage, read_write> sb: array<u32>;
@group(0) @binding(1) var<storage, read> b: array<u32>;
@group(0) @binding(2) var<storage, read> sd: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${FIXED}
${RAND}
${consts(L)}
${PLACE}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let j = flat(g, n);
  if (j >= ${sk.cap}u || (sb[j] & 1u) == 0u || sb[${sk.texel}u + j] != ${ON_TREE}u) { return; }
  let i = sb[${sk.parent}u + j];
  let s = sb[${sk.k}u + j];
  if ((b[i] & 1u) == 0u || (b[i] >> 1u) != sb[${sk.pgen}u + j]) { sb[j] = sb[j] & ~1u; return; }
  if ((s >> 2u) % P.S != P.dd) { return; }
  let mix = SEED ^ ((b[i] >> 1u) * GM);
  let w = philox(vec4u(i, s >> 2u, 0u, 0u), vec2u(mix, ${STREAM.surv}u + P.year))[s & 3u];
  if (w >= SURVIVE[P.r]) { sb[j] = sb[j] & ~1u; return; }
  rinit(mix, ${STREAM.land}u + P.year, i, s);
  let t = landing(b[${k.x}u + i], b[${k.y}u + i], reach(P.r, b[${k.size}u + i]));
  if (t >= NT) { sb[j] = sb[j] & ~1u; return; }
  sb[${sk.texel}u + j] = t;
}`;
}
