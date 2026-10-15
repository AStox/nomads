// The animals' law in WGSL (src/gpu/animals.ts drives it; docs/research/animal-constants.md sec. 12). Deer, rabbits,
// wolves, foxes, herons, eagles, gulls and crows are each one object of store kind "animal", stepped every hour of
// island time (a day at a time in the twenty years before anyone wakes), and the ground they eat from is the tiles'
// standing crop. All of it integer arithmetic; where several animals want one thing (a sward, a carcass, a rabbit)
// they claim it and a second pass shares it out or names the one claimant that gets it, so nothing depends on the
// order in which invocations run.
//
// The step, in order (each line a pass; tiles are the 150 m tiles, 128 a side). A pass that does several things does
// them in one invocation, one after the other, each over its own range: none reads what another of the same pass
// writes, so it is the same as running them one by one.
// - front: grow (tiles): the carrion laid down last step joins the tile's dead; the ground layer and the browse grow,
//   die and rot by the day's drivers; the dead rot by the air's warmth; the shore's animals regrow; and what every
//   forager reads of the tile is set out (densities, shares, what the pickers weigh). Cells (tiles): the deer and
//   rabbits a predator could take on each tile, counted from the store's index. Census (animals): how many of each
//   kind are alive.
// - satRows, satCols: a summed-area table of each layer, so any box of tiles sums in four reads (the land's, which
//   never changes, only in a law's first step). satRows also sets how many workgroups the passes over the animals
//   take: those up to the kind's tail (no slot past it was ever born) or the tiles, whichever reach further.
// - act (animals): every animal pays its hour's field metabolic rate and takes in what people fed it; grazers ask the
//   sward and the browse for their intake; wolves and foxes on the hunt pick a prey by its biomass in their range and
//   claim it; scavengers and birds pick a tile of their range by its food and ask it for theirs.
// - claim: share (tiles): what each pool holds against what was asked of it. Resolve (animals): each claimed prey
//   goes to the claimant with the lowest key (a hashed priority and the slot), and dies; a wolf's kill goes into its
//   pack's pot, a fox's or an eagle's into itself, what is left lying as carrion.
// - eat (animals): each forager gets its ask times its pool's share; then a pack's wolves share its pot by what each
//   lacks.
// - fate: settle (tiles): the pools lose what was eaten; the fish eaten are counted for the CPU's stocks. Leftover
//   (pack slots): what a pack left of its kills lies as carrion. Fate (animals): starvation and the year's other
//   deaths, moving, leaving home at maturity, and the young.
// Births go through the store's births (store.ts), the parent's initialization below; young past the kind's room are
// not born.
import { CELL, N } from "../../terrain/grid";
import { FIXED } from "./fixed";
import { CTL } from "./alloc";
import { RAND } from "./rand";

// ---------- layouts shared with the host and the oracle ----------
export const TW = 128, T = TW * TW, TILE_MM = 150000, NONE = 0xffffffff;
export const SP = { deer: 0, rabbit: 1, wolf: 2, fox: 3, heron: 4, eagle: 5, gull: 6, crow: 7 } as const;
export const NSP = 8;
// The kind's fields after x and y, in order.
export const FIELDS = ["sp", "held", "e", "born", "preg", "grp", "hx", "hy", "fed", "fseen"] as const;
export const F = { x: 0, y: 1, sp: 2, held: 3, e: 4, born: 5, preg: 6, grp: 7, hx: 8, hy: 9, fed: 10, fseen: 11 } as const;
// The tile buffer's runs of T words: the ground (static), the browse (daily, from the stems), the pools (state), what
// the grow pass sets out for the foragers, the grazers' pulls, the fish (from the CPU each step), the layers the
// pickers weigh, the pools' shares, and the broadleaves' current-year twigs: their share of the tile within a deer's
// reach and its area (daily, from the stems), the twigs standing (g/m2 of that area, Q16), and what the deer read of
// them (g/m2 over their pools, Q16).
export const W_ = {
  land: 0, grass: 1, lit: 2, warren: 3, garea: 4, lake: 5, sw: 6, sa: 10,
  woody: 14, ever: 15, summer: 16, winter: 17, barea: 18,
  fg: 19, fd: 20, bg: 21, bd: 22, carr: 23, shore: 24, wasbare: 25,
  dgreen: 26, ddead: 27, gshg: 28, gshd: 29, bq: 30, stripg: 31, hresp: 32, shoreg: 33, open: 34, stripm2: 35,
  pdeer: 36, prabbit: 37, fish: 38, layer: 39, share: 47,
  twoody: 58, tarea: 59, tw: 60, dtw: 61,
} as const;
export const W_RUNS = 62;
export const STATIC_RUNS = 14;
// The layers a picker weighs, in decagrams (10 g) of food a tile, but for the deer and rabbits (heads) and the land
// (1 a land tile).
export const L = { deer: 0, rabbit: 1, carr: 2, strip: 3, fish: 4, shore: 5, worms: 6, land: 7 } as const;
export const NL = 8, SATW = (TW + 1) * (TW + 1);
// The pools asked of, shared and eaten from: the rabbits' and the deer's ground-layer green and dead, the deer's browse
// green and dead, the shallows' fish a heron wades, the open water's fish an eagle takes, the shore's animals, carrion,
// and the broadleaves' current-year twigs a deer browses while they stand bare.
export const PO_ = { rg: 0, rd: 1, dg: 2, dd: 3, dbg: 4, dbd: 5, strip: 6, water: 7, shore: 8, carr: 9, dtw: 10 } as const;
export const NPOOL = 11;
// The atomic buffer: asks, eaten, the fish eaten by water tile (g), carrion laid down this step (g), the census, the
// claims by prey slot, and five runs by pack (pot J, want J, eaten J, kill tile + 1, the breeder's slot inverted).
export const A_ = { ask: 0, eat: NPOOL * T, fish: 2 * NPOOL * T, carr: 2 * NPOOL * T + T, cen: 2 * NPOOL * T + 2 * T, claim: 2 * NPOOL * T + 2 * T + 16 } as const;
export const PACK = { pot: 0, want: 1, eaten: 2, tile: 3, breed: 4 } as const;
export const aWords = (cap: number) => A_.claim + cap + 5 * cap;
// Each animal's scratch for the step: its young (first, so the store's births read them as its counts), its prey's
// slot, the tile it acted on, up to five asks (mg) and its claim key.
export const Q_ = { cnt: 0, tgt: 1, pick: 2, a0: 3, key: 8 } as const;
export const Q_RUNS = 9;
// The territorial birds whose breeding the territories bound: heron, eagle, crow, a run of cap flags each.
export const TERR_SP = [SP.heron, SP.eagle, SP.crow];
// The constants buffer: KW words a species, then the global words, the browse class of every SPECIES index, the
// wolves' tables by head count (a step's chance of dying, Q32; a pup's keeping, Q16), then the step's parameters.
export const KW = 24, GK = NSP * KW, CLS = GK + 64, WTAB = CLS + 64, WTN = 1024, PO = WTAB + 2 * WTN, KP_WORDS = PO + 16;
export const K = {
  kg: 0, full: 1, fmr: 2, die: 3, capg: 4, capf: 5, half: 6, mature: 7, reach: 8, rate: 9, newe: 10, litter: 11,
  young: 12, move: 13, disp: 14, dreach: 15, chase: 16, prey: 17, terr: 18, half2: 19,
} as const;
export const G = {
  me: 0, med: 1, rots: 2, shrate: 3, shmost: 4, daysq: 5, rotdd: 6, flesh: 7, shorej: 8, ravens: 9, worms: 10, m2: 11,
  hhalf: 12, kitp: 13, rutlo: 14, rutsl: 15, rutmax: 16, kitfit: 17, most: 18, twig: 19, twme: 20, twndf: 21,
} as const;
export const P = { tick: 0, per: 1, day: 2, flags: 3, seed: 4, tps: 5 } as const;
export const FLAG = { rut: 1, calve: 2, whelp: 4, cub: 8, kits: 16, heron: 32, eagle: 64, gull: 128, crow: 256 } as const;
// The day drivers: DRIVERS runs of T words a day, for every day of the island's year.
export const DR = { grow: 0, leafk: 1, temp: 2, open: 3, bare: 4 } as const;
export const DRIVERS = 5;
// Random streams.
export const STREAM = { act: 0x414e0001, fate: 0x414e0002, birth: 0x414e0003, start: 0x414e0004 } as const;

const ACC = (cap: number) => /* wgsl */ `
const CAP = ${cap}u; const T = ${T}u; const TW = ${TW}u; const TMM = ${TILE_MM}u; const NONE = 0xffffffffu;
const KW = ${KW}u; const GK = ${GK}u; const CLS = ${CLS}u; const WTAB = ${WTAB}u; const PO = ${PO}u;
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }
fn tile_of(x: u32, y: u32) -> u32 { return min(y / TMM, TW - 1u) * TW + min(x / TMM, TW - 1u); }
fn sat_add(a: u32, b: u32) -> u32 { let s = a + b; if (s < a) { return NONE; } return s; }
fn sat_sub(a: u32, b: u32) -> u32 { if (a > b) { return a - b; } return 0u; }
fn smul(a: u32, b: u32) -> u32 { let p = mul64(a, b); if (p.y != 0u) { return NONE; } return p.x; }
fn mulq(a: u32, q: u32) -> u32 { let p = mul64(a, q); if (p.y >= 65536u) { return NONE; } return (p.x >> 16u) | (p.y << 16u); }
fn muldiv(a: u32, b: u32, c: u32) -> u32 { if (c == 0u) { return 0u; } let p = mul64(a, b); if (p.y >= c) { return NONE; } return divw(p.y, p.x, c).x; }
fn resp(s: u32, d: u32) -> u32 { let den = sat_add(s, d); if (den == 0u) { return 0u; } return muldiv(s, 65536u, den); }
fn q32of(a: u32, b: u32) -> u32 { if (b == 0u || a >= b) { return NONE; } return divw(a, 0u, b).x; }
fn bern16(p: u32) -> bool { let r = next32(); return p >= 65536u || r < (p << 16u); }
`;
const KREAD = /* wgsl */ `
fn kk(s: u32, w: u32) -> u32 { return KP[s * KW + w]; }
fn kg(w: u32) -> u32 { return KP[GK + w]; }
fn pp(w: u32) -> u32 { return KP[PO + w]; }
`;
const BODY = /* wgsl */ `
fn fo(f: u32) -> u32 { return (f + 1u) * CAP; }
fn fe(i: u32) -> i32 { return bitcast<i32>(b[fo(4u) + i]); }
`;
const SAT = /* wgsl */ `
fn sat(l: u32, Y: u32, X: u32) -> u32 { return S[l * ${SATW}u + Y * ${TW + 1}u + X]; }
fn box(l: u32, x0: u32, y0: u32, x1: u32, y1: u32) -> u32 {
  return sat(l, y1 + 1u, x1 + 1u) - sat(l, y0, x1 + 1u) - sat(l, y1 + 1u, x0) + sat(l, y0, x0);
}
fn bw(la: u32, wa: u32, lb: u32, wb: u32, x0: u32, y0: u32, x1: u32, y1: u32) -> u32 {
  return wa * box(la, x0, y0, x1, y1) + wb * box(lb, x0, y0, x1, y1);
}
// The tile of a box holding the u-th unit of the weighted layers (u below their total), rows first, and how far into
// that tile's weight u falls.
fn pick(la: u32, wa: u32, lb: u32, wb: u32, x0: u32, y0: u32, x1: u32, y1: u32, u: u32) -> vec2u {
  var lo = y0; var hi = y1;
  loop { if (lo >= hi) { break; } let mid = (lo + hi) / 2u; if (bw(la, wa, lb, wb, x0, y0, x1, mid) > u) { hi = mid; } else { lo = mid + 1u; } }
  let r = lo;
  var u2 = u;
  if (r > y0) { u2 = u - bw(la, wa, lb, wb, x0, y0, x1, r - 1u); }
  lo = x0; hi = x1;
  loop { if (lo >= hi) { break; } let mid = (lo + hi) / 2u; if (bw(la, wa, lb, wb, x0, r, mid, r) > u2) { hi = mid; } else { lo = mid + 1u; } }
  let c = lo;
  var u3 = u2;
  if (c > x0) { u3 = u2 - bw(la, wa, lb, wb, x0, r, c - 1u, r); }
  return vec2u(r * TW + c, u3);
}
// The box of tiles within r of tile t, clipped at the map's edge.
fn boxof(t: u32, r: u32) -> vec4u {
  let x = t % TW; let y = t / TW;
  return vec4u(select(0u, x - r, x > r), select(0u, y - r, y > r), min(x + r, TW - 1u), min(y + r, TW - 1u));
}
`;
const HEAD = (cap: number) => FIXED + RAND + ACC(cap);
const decl = (bs: [string, "r" | "rw" | "a"][]) =>
  bs.map(([n, m], i) => `@group(0) @binding(${i}) var<storage, ${m === "r" ? "read" : "read_write"}> ${n}: array<${m === "a" ? "atomic<u32>" : "u32"}>;`).join("\n");
const MAIN = (n: string, body: string) => /* wgsl */ `
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = flat(gid, nwg);
  if (i >= ${n}) { return; }
${body}
}`;
// A tile's word of a run of W: run a number, or a WGSL expression in u32.
const w = (run: number | string, t = "t") => (typeof run === "number" ? `W[${run}u * T + ${t}]` : `W[(${run}) * T + ${t}]`);
// A pass of several parts, each a function of the invocation's index over its own range (the tiles, T, or the animals
// and the pack slots, CAP), run one after the other in the order given; a part's return ends only that part.
const PARTS = (parts: [name: string, range: "T" | "CAP", body: string][]) => /* wgsl */ `
${parts.map(([n, , body]) => `fn ${n}(i: u32) {\n${body}\n}`).join("\n")}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = flat(gid, nwg);
${parts.map(([n, range]) => `  if (i < ${range}) { ${n}(i); }`).join("\n")}
}`;

// ---------- front: grow and cells (tiles), census (animals) ----------
// Bindings: b, W, D (drivers), KP, A, I (the index: start, CELLS + 1 words, then order). Dispatched over the room.
export function animalsFront(cap: number) {
  return `${HEAD(cap)}${decl([["b", "r"], ["W", "rw"], ["D", "r"], ["KP", "r"], ["A", "a"], ["I", "r"]])}
${KREAD}${BODY}${INDEX}
fn iced(j: u32, d0: u32) -> bool { return ${w(W_.lake, "j")} == 1u && bitcast<i32>(D[d0 + ${DR.temp}u * T + j]) < 0i; }
${PARTS([["grow", "T", /* wgsl */ `
  let t = i;
  let d0 = pp(${P.day}u) * ${DRIVERS}u * T; let per = pp(${P.per}u);
  let temp = bitcast<i32>(D[d0 + ${DR.temp}u * T + t]);
  for (var l = 0u; l < ${NL}u; l++) { ${w(`${W_.layer}u + l`)} = 0u; }
  let laid = atomicExchange(&A[${A_.carr}u + t], 0u);
  if (${w(W_.land)} == 0u) {
    if (!iced(t, d0)) { ${w(W_.layer + L.fish)} = ${w(W_.fish)} / 10u; }
    return;
  }
  ${w(W_.layer + L.land)} = 1u;
  // the ground layer and the browse
  let grown = D[d0 + ${DR.grow}u * T + t] / per;
  let dies = u32(65536i - qexp(-bitcast<i32>(D[d0 + ${DR.leafk}u * T + t] / per)));
  let keep = 65536u - dies;
  let rots = kg(${G.rots}u); let most = kg(${G.most}u);
  let fg = ${w(W_.fg)}; let fd = ${w(W_.fd)};
  let room = 65536i - bitcast<i32>((fg + fd) / most);
  let fnew = max(0i, bitcast<i32>(fg) + qmul(qmul(bitcast<i32>(grown), bitcast<i32>(${w(W_.lit)})), room));
  let fpos = u32(fnew);
  let fg2 = mulq(fpos, keep);
  let fd2 = mulq(fd + mulq(fpos, dies), rots);
  ${w(W_.fg)} = fg2; ${w(W_.fd)} = fd2;
  let bg = ${w(W_.bg)}; let bd = ${w(W_.bd)};
  let broom = 65536i - bitcast<i32>((bg + bd) / most);
  let bpos = u32(max(0i, bitcast<i32>(bg) + qmul(bitcast<i32>(grown), broom)));
  let bare = D[d0 + ${DR.bare}u * T + t];
  var fall = dies;
  // leaf fall: the broadleaves' leaves drop, and their year's twigs stand as browse, grown by now; at leaf-out they
  // are last year's wood, browse no more
  let was = ${w(W_.wasbare)};
  if (bare == 1u && was == 0u) { fall = 65536u - mulq(keep, ${w(W_.ever)}); ${w(W_.tw)} = kg(${G.twig}u); }
  if (bare == 0u && was == 1u) { ${w(W_.tw)} = 0u; }
  ${w(W_.wasbare)} = bare;
  let bg2 = mulq(bpos, 65536u - fall);
  let bd2 = mulq(bd + mulq(bpos, fall), rots);
  ${w(W_.bg)} = bg2; ${w(W_.bd)} = bd2;
  // the dead rot as the air is warm, the shore's animals regrow
  let warm = u32(max(0i, temp));
  let gone = mulq(warm, kg(${G.daysq}u)) / kg(${G.rotdd}u);
  let carr = mulq(sat_add(${w(W_.carr)}, laid), sat_sub(65536u, gone));
  ${w(W_.carr)} = carr;
  // the shallows: the fish a heron wades and the shore's animals, where no ice lies
  var stripg = 0u; var m2 = 0u; var any = false;
  for (var m = 0u; m < 4u; m++) {
    let j = ${w(`${W_.sw}u + m`)};
    if (j == NONE) { continue; }
    any = true;
    if (iced(j, d0)) { continue; }
    let sa = ${w(`${W_.sa}u + m`)};
    stripg = stripg + mulq(${w(W_.fish, "j")}, sa);
    m2 = m2 + mulq(kg(${G.m2}u), sa);
  }
  var shore = ${w(W_.shore)};
  if (any) { shore = shore + mulq(sat_sub(kg(${G.shmost}u), shore), kg(${G.shrate}u)); ${w(W_.shore)} = shore; }
  let shoreg = muldiv(mulq(shore, m2), kg(${G.shorej}u), kg(${G.flesh}u));
  ${w(W_.stripg)} = stripg; ${w(W_.stripm2)} = m2; ${w(W_.shoreg)} = shoreg;
  ${w(W_.hresp)} = resp(stripg, mulq(m2, kg(${G.hhalf}u)));
  // what the grazers read: the ground layer's reach under the snow, the deer's green and dead over their pools
  let open = D[d0 + ${DR.open}u * T + t];
  ${w(W_.open)} = open;
  let ga = mulq(${w(W_.grass)}, open);
  let woody = ${w(W_.woody)};
  let da = ga + woody;
  let gg = mulq(fg2, ga); let gd = mulq(fd2, ga); let wg = mulq(bg2, woody); let wd = mulq(bd2, woody);
  var dtw = 0u;
  if (da > 0u) { dtw = muldiv(mulq(${w(W_.tw)}, ${w(W_.twoody)}), 65536u, da); }
  ${w(W_.dtw)} = dtw;
  var dgreen = 0u; var ddead = 0u; var bq = ${w(W_.summer)};
  if (bare == 1u) { bq = ${w(W_.winter)}; }
  if (da > 0u) { dgreen = muldiv(gg + wg, 65536u, da); ddead = muldiv(gd + wd, 65536u, da); }
  var gshg = 65536u; var gshd = 65536u;
  if (gg + wg > 0u) { gshg = muldiv(gg, 65536u, gg + wg); }
  if (gd + wd > 0u) { gshd = muldiv(gd, 65536u, gd + wd); }
  ${w(W_.dgreen)} = dgreen; ${w(W_.ddead)} = ddead; ${w(W_.gshg)} = gshg; ${w(W_.gshd)} = gshd; ${w(W_.bq)} = bq;
  // where each would feed best: a deer by its response to the green, then the twigs and the dead, over its pools at
  // what each is worth (as it asks for them, act), a rabbit by its own on the ground its warren reaches
  let me = kg(${G.me}u); let med = kg(${G.med}u);
  var pd = 0u;
  if (da > 0u) {
    var q = me;
    if (gg + wg > 0u) { q = muldiv(gg, me, gg + wg) + muldiv(wg, bq, gg + wg); }
    let half = kk(${SP.deer}u, ${K.half}u);
    let gr = resp(dgreen, half);
    let rt = resp(dtw, half);
    let rest = mulq(rt, kg(${G.twme}u)) + mulq(mulq(65536u - rt, resp(ddead, half)), med);
    pd = mulq(gr, q) + mulq(65536u - gr, rest);
  }
  var pr = 0u;
  if (ga > 0u) {
    let half = kk(${SP.rabbit}u, ${K.half}u);
    let gr = resp(fg2, half);
    pr = mulq(${w(W_.warren)}, mulq(gr, me) + mulq(mulq(65536u - gr, resp(fd2, half)), med));
  }
  ${w(W_.pdeer)} = pd; ${w(W_.prabbit)} = pr;
  // the pickers' layers
  ${w(W_.layer + L.carr)} = carr / 10u;
  ${w(W_.layer + L.strip)} = stripg / 10u;
  ${w(W_.layer + L.shore)} = shoreg / 10u;
  if (temp > 0i) { ${w(W_.layer + L.worms)} = smul(kg(${G.worms}u), mulq(kg(${G.m2}u), ga)) / 10u; }
`], ["cells", "T", /* wgsl */ `
  // the deer and rabbits a predator could take, after grow has cleared the layers
  let t = i;
  var nd = 0u; var nr = 0u;
  for (var q = 0u; q < 4u; q++) {
    let r = cell_run(tcell(t, q));
    for (var p = r.x; p < r.y; p++) { let s = at(p); if (takeable(s, ${SP.deer}u)) { nd = nd + 1u; } if (takeable(s, ${SP.rabbit}u)) { nr = nr + 1u; } }
  }
  ${w(W_.layer + L.deer)} = nd; ${w(W_.layer + L.rabbit)} = nr;
`], ["census", "CAP", /* wgsl */ `
  if ((b[i] & 1u) == 0u) { return; }
  atomicAdd(&A[${A_.cen}u + (b[fo(2u) + i] & 15u)], 1u);
`]])}`;
}

// ---------- the index ----------
// The deer and rabbits on each tile a predator could take (alive and not held by people), from the store's index:
// the tile's four 75 m cells in order, each in slot order.
export const CELLS_N = N * N;
if (CELL * 2 !== TILE_MM / 1000) throw new Error("a tile is two cells a side");
const INDEX = /* wgsl */ `
fn cell_run(c: u32) -> vec2u { return vec2u(I[c], I[c + 1u]); }
fn at(p: u32) -> u32 { return I[${CELLS_N + 1}u + p]; }
fn takeable(s: u32, sp: u32) -> bool { return (b[s] & 1u) == 1u && b[fo(3u) + s] == 0u && (b[fo(2u) + s] & 15u) == sp; }
fn tcell(t: u32, q: u32) -> u32 { return (2u * (t / TW) + (q >> 1u)) * ${N}u + 2u * (t % TW) + (q & 1u); }
// The k-th takeable animal of kind sp on tile t, or NONE.
fn kth(t: u32, sp: u32, k: u32) -> u32 {
  var n = 0u;
  for (var q = 0u; q < 4u; q++) {
    let r = cell_run(tcell(t, q));
    for (var p = r.x; p < r.y; p++) { let s = at(p); if (takeable(s, sp)) { if (n == k) { return s; } n = n + 1u; } }
  }
  return NONE;
}
`;

// ---------- the summed-area tables ----------
// The land's layer, last of them, never changes, so a law builds it in its first step only and then the first
// LIVE_LAYERS. Rows: a workgroup a layer and row, its 128 invocations scanning the row together in workgroup memory
// (u32 sums wrap the same in any order). The workgroup of layer 0, row 0 also sets the workgroup count of the passes
// over the animals (N, three words, indirect): up to the kind's tail, or over the tiles where those reach further.
// Bindings: W, S, al (the kind's alloc), N. Dispatched as one workgroup a layer and row.
export const LIVE_LAYERS = NL - 1;
if (L.land !== LIVE_LAYERS) throw new Error("the land's layer is the last");
export function animalsSatRows(cap: number) {
  return `${HEAD(cap)}${decl([["W", "r"], ["S", "rw"], ["al", "r"], ["N", "rw"]])}
var<workgroup> row: array<u32, ${TW}>;
@compute @workgroup_size(${TW}) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) x: u32) {
  if (wid.x == 0u && x == 0u) { N[0] = (max(al[${CTL.tail}u], T) + 255u) / 256u; N[1] = 1u; N[2] = 1u; }
  let l = wid.x / TW; let y = wid.x % TW; let base = l * ${SATW}u;
  row[x] = W[(${W_.layer}u + l) * T + y * TW + x];
  workgroupBarrier();
  for (var d = 1u; d < TW; d <<= 1u) {
    var u = 0u;
    if (x >= d) { u = row[x - d]; }
    workgroupBarrier();
    row[x] += u;
    workgroupBarrier();
  }
  S[base + (y + 1u) * ${TW + 1}u + x + 1u] = row[x];
  if (x == 0u) { S[base + (y + 1u) * ${TW + 1}u] = 0u; }
  if (y == 0u) { S[base + x] = 0u; if (x == 0u) { S[base + TW] = 0u; } }
}`;
}
// Columns: one invocation a layer and column, over the first so many layers.
export function animalsSatCols(cap: number, layers: number) {
  return `${HEAD(cap)}${decl([["S", "rw"]])}
${MAIN(`${layers * (TW + 1)}u`, /* wgsl */ `
  let l = i / ${TW + 1}u; let x = i % ${TW + 1}u; let base = l * ${SATW}u;
  var acc = 0u;
  for (var y = 1u; y <= TW; y++) { acc = acc + S[base + y * ${TW + 1}u + x]; S[base + y * ${TW + 1}u + x] = acc; }
`)}`;
}

// ---------- census (animals), for the landing ----------
// Bindings: b, out (atomic; NSP words from word at).
export function animalsCensus(cap: number, at: number) {
  return `${HEAD(cap)}${decl([["b", "r"], ["C", "a"]])}
${BODY}
${MAIN("CAP", /* wgsl */ `
  if ((b[i] & 1u) == 0u) { return; }
  atomicAdd(&C[${at}u + (b[fo(2u) + i] & 15u)], 1u);
`)}`;
}

// ---------- act (animals) ----------
// Bindings: b, W, A, KP, S, I, Q, TERR.
export function animalsAct(cap: number) {
  const q = (run: number, x = "i") => `Q[${run}u * CAP + ${x}]`;
  const ask = (pool: number, t: string, v: string) => `atomicAdd(&A[${A_.ask}u + ${pool}u * T + ${t}], ${v});`;
  return `${HEAD(cap)}${decl([["b", "rw"], ["W", "r"], ["A", "a"], ["KP", "r"], ["S", "r"], ["I", "r"], ["Q", "rw"], ["TERR", "rw"]])}
${KREAD}${BODY}${SAT}${INDEX}
fn lay(l: u32, t: u32) -> u32 { return ${w(`${W_.layer}u + l`)}; }
// A uniformly drawn land tile of a box.
fn anyland(bx: vec4u) -> u32 {
  let n = box(${L.land}u, bx.x, bx.y, bx.z, bx.w);
  if (n == 0u) { return NONE; }
  return pick(${L.land}u, 1u, ${L.land}u, 0u, bx.x, bx.y, bx.z, bx.w, unif(n)).x;
}
fn cells(bx: vec4u) -> u32 { return (bx.z - bx.x + 1u) * (bx.w - bx.y + 1u); }
fn claim(i: u32, prey: u32) {
  if (prey == NONE) { return; }
  let key = (next32() & 0xfff00000u) | i;
  atomicMax(&A[${A_.claim}u + prey], ~key);
  ${q(Q_.tgt)} = prey; ${q(Q_.key)} = key;
}
${MAIN("CAP", /* wgsl */ `
  ${q(Q_.tgt)} = NONE; ${q(Q_.pick)} = NONE; ${q(Q_.key)} = 0u;
  for (var a = 0u; a < 5u; a++) { Q[(${Q_.a0}u + a) * CAP + i] = 0u; }
  for (var r = 0u; r < 3u; r++) { TERR[r * CAP + i] = 0u; }
  if ((b[i] & 1u) == 0u) { return; }
  let sw = b[fo(2u) + i]; let s = sw & 15u; let female = (sw >> 4u) & 1u;
  let held = b[fo(3u) + i];
  let full = kk(s, ${K.full}u); let fmr = kk(s, ${K.fmr}u);
  // what people fed it since the last step (fed counts up; fseen is how far the GPU has taken it in)
  let fed = b[fo(10u) + i];
  let more = min(fed - b[fo(11u) + i], full);
  b[fo(11u) + i] = fed;
  let e = fe(i) + bitcast<i32>(more) - bitcast<i32>(fmr);
  b[fo(4u) + i] = bitcast<u32>(e);
  let tick = pp(${P.tick}u); let flags = pp(${P.flags}u);
  let mature = tick - b[fo(5u) + i] >= kk(s, ${K.mature}u) && tick - b[fo(5u) + i] < 0x80000000u;
  // the territorial birds that could breed this step, and each pack's breeder (its lowest-slot grown female)
  if (female == 1u && mature) {
    if (s == ${SP.heron}u && (flags & ${FLAG.heron}u) != 0u) { TERR[i] = 1u; }
    if (s == ${SP.eagle}u && (flags & ${FLAG.eagle}u) != 0u) { TERR[CAP + i] = 1u; }
    if (s == ${SP.crow}u && (flags & ${FLAG.crow}u) != 0u) { TERR[2u * CAP + i] = 1u; }
  }
  let grp = b[fo(7u) + i];
  if (s == ${SP.wolf}u && grp > 0u && female == 1u && mature && held != 2u && (flags & ${FLAG.whelp}u) != 0u) {
    atomicMax(&A[${A_.claim}u + CAP * ${1 + PACK.breed}u + grp - 1u], ~i);
  }
  if (held == 2u) { return; }
  let want = u32(max(0i, bitcast<i32>(full) - e));
  let hungry = e + bitcast<i32>(fmr) < bitcast<i32>(full);
  rinit(pp(${P.seed}u), ${STREAM.act}u, i, tick);
  let me = kg(${G.me}u); let med = kg(${G.med}u); let flesh = kg(${G.flesh}u);
  let home = tile_of(b[fo(8u) + i], b[fo(9u) + i]);
  let here = tile_of(b[i + CAP], b[i + 2u * CAP]);
  if (s == ${SP.deer}u) {
    let t = here;
    if (${w(W_.land)} == 0u) { return; }
    // the green first, as its response to it has it; then, in what fibre the rumen has room for, the bare broadleaves'
    // twigs and then the dead (fibre: green 0.4, twigs twndf thousandths, dead 0.7)
    let half = kk(s, ${K.half}u);
    let g1 = mulq(min(kk(s, ${K.capg}u), muldiv(want, 1000u, me)), resp(${w(W_.dgreen)}, half));
    let fill = kk(s, ${K.capf}u); let used = g1 * 4u / 10u;
    let twme = kg(${G.twme}u); let twndf = kg(${G.twndf}u);
    var troom = 0u;
    if (fill > used) { troom = (fill - used) * 1000u / twndf; }
    let got = muldiv(g1, me, 1000u);
    let t1 = mulq(min(troom, muldiv(sat_sub(want, got), 1000u, twme)), resp(${w(W_.dtw)}, half));
    let used2 = used + t1 * twndf / 1000u;
    var room = 0u;
    if (fill > used2) { room = (fill - used2) * 10u / 7u; }
    let got2 = got + muldiv(t1, twme, 1000u);
    let d1 = mulq(min(room, muldiv(sat_sub(want, got2), 1000u, med)), resp(${w(W_.ddead)}, half));
    let ag = mulq(g1, ${w(W_.gshg)}); let ad = mulq(d1, ${w(W_.gshd)});
    ${ask(PO_.dg, "t", "ag")} ${ask(PO_.dd, "t", "ad")} ${ask(PO_.dbg, "t", "g1 - ag")} ${ask(PO_.dbd, "t", "d1 - ad")} ${ask(PO_.dtw, "t", "t1")}
    ${q(Q_.a0)} = ag; ${q(Q_.a0 + 1)} = ad; ${q(Q_.a0 + 2)} = g1 - ag; ${q(Q_.a0 + 3)} = d1 - ad; ${q(Q_.a0 + 4)} = t1; ${q(Q_.pick)} = t;
    return;
  }
  if (s == ${SP.rabbit}u) {
    let t = home;
    if (${w(W_.land)} == 0u || ${w(W_.grass)} == 0u) { return; }
    let most = kk(s, ${K.capf}u);
    let g1 = mulq(min(most, muldiv(want, 1000u, me)), resp(${w(W_.fg)}, kk(s, ${K.half}u)));
    let got = muldiv(g1, me, 1000u);
    let d1 = mulq(min(most - g1, muldiv(sat_sub(want, got), 1000u, med)), resp(${w(W_.fd)}, kk(s, ${K.half}u)));
    ${ask(PO_.rg, "t", "g1")} ${ask(PO_.rd, "t", "d1")}
    ${q(Q_.a0)} = g1; ${q(Q_.a0 + 1)} = d1; ${q(Q_.pick)} = t;
    return;
  }
  let bx = boxof(home, kk(s, ${K.reach}u));
  if (s == ${SP.wolf}u) {
    if (grp > 0u) { atomicAdd(&A[${A_.claim}u + CAP * ${1 + PACK.want}u + grp - 1u], want); }
    if (held != 0u) { return; }
    let wd = kk(${SP.deer}u, ${K.prey}u); let wr = kk(${SP.rabbit}u, ${K.prey}u);
    let tot = bw(${L.deer}u, wd, ${L.rabbit}u, wr, bx.x, bx.y, bx.z, bx.w);
    if (hungry && tot > 0u) {
      let land = box(${L.land}u, bx.x, bx.y, bx.z, bx.w);
      let rate = mulq(kk(s, ${K.rate}u), resp(tot, smul(land, kk(s, ${K.half}u))));
      let pk = pick(${L.deer}u, wd, ${L.rabbit}u, wr, bx.x, bx.y, bx.z, bx.w, unif(tot));
      ${q(Q_.pick)} = pk.x;
      let nd = wd * lay(${L.deer}u, pk.x);
      var prey = ${SP.deer}u; var k = pk.y / wd;
      if (pk.y >= nd) { prey = ${SP.rabbit}u; k = (pk.y - nd) / wr; }
      var p = q32of(rate, kk(prey, ${K.kg}u));
      if (prey == ${SP.rabbit}u) { p = min(p, kk(s, ${K.chase}u)); }
      if (next32() < p) { claim(i, kth(pk.x, prey, k)); }
    } else {
      ${q(Q_.pick)} = anyland(bx);
    }
    return;
  }
  if (s == ${SP.fox}u) {
    if (held != 0u) { return; }
    let land = box(${L.land}u, bx.x, bx.y, bx.z, bx.w);
    let nr = box(${L.rabbit}u, bx.x, bx.y, bx.z, bx.w);
    if (hungry && nr > 0u) {
      // Pech's type III on rabbits a ha: N^2 / (N^2 + I^2), as a over b with a = 100 rabbits and b = 297 land tiles
      let a = smul(nr, 100u); let bb = smul(land, kk(s, ${K.half}u));
      var rs = 0u;
      if (a >= bb) { let x = muldiv(bb, 65536u, a); rs = muldiv(65536u, 65536u, 65536u + mulq(x, x)); }
      else { let x = muldiv(a, 65536u, bb); let x2 = mulq(x, x); rs = muldiv(x2, 65536u, x2 + 65536u); }
      let rate = mulq(kk(s, ${K.rate}u), rs);
      if (next32() < q32of(rate, kk(${SP.rabbit}u, ${K.kg}u))) {
        let pk = pick(${L.rabbit}u, 1u, ${L.rabbit}u, 0u, bx.x, bx.y, bx.z, bx.w, unif(nr));
        ${q(Q_.pick)} = pk.x;
        claim(i, kth(pk.x, ${SP.rabbit}u, pk.y));
        return;
      }
    }
    // what the rabbits leave it short it makes up from the dead on its range
    let c = box(${L.carr}u, bx.x, bx.y, bx.z, bx.w);
    if (hungry && c > 0u) {
      let a = mulq(muldiv(want, 1000u, flesh), resp(c, smul(land, kk(s, ${K.half2}u))));
      let t = pick(${L.carr}u, 1u, ${L.carr}u, 0u, bx.x, bx.y, bx.z, bx.w, unif(c)).x;
      ${ask(PO_.carr, "t", "a")}
      ${q(Q_.a0)} = a; ${q(Q_.pick)} = t;
      return;
    }
    ${q(Q_.pick)} = anyland(bx);
    return;
  }
  let nc = cells(bx);
  let half = smul(nc, kk(s, ${K.half}u));
  if (s == ${SP.eagle}u) {
    let wr = kk(${SP.rabbit}u, ${K.prey}u);
    let tot = bw(${L.rabbit}u, wr, ${L.fish}u, 1u, bx.x, bx.y, bx.z, bx.w);
    let a = mulq(muldiv(want, 1000u, flesh), resp(tot, half));
    if (tot == 0u || a == 0u) { return; }
    let pk = pick(${L.rabbit}u, wr, ${L.fish}u, 1u, bx.x, bx.y, bx.z, bx.w, unif(tot));
    ${q(Q_.pick)} = pk.x;
    let nr = wr * lay(${L.rabbit}u, pk.x);
    if (pk.y < nr) {
      if (held == 0u && next32() < q32of(a, smul(kk(${SP.rabbit}u, ${K.kg}u), 1000u))) { claim(i, kth(pk.x, ${SP.rabbit}u, pk.y / wr)); }
      return;
    }
    let t = pk.x;
    ${ask(PO_.water, "t", "a")}
    ${q(Q_.a0)} = a;
    return;
  }
  if (s == ${SP.heron}u) {
    let st = box(${L.strip}u, bx.x, bx.y, bx.z, bx.w);
    if (st == 0u) { return; }
    let t = pick(${L.strip}u, 1u, ${L.strip}u, 0u, bx.x, bx.y, bx.z, bx.w, unif(st)).x;
    let a = mulq(muldiv(want, 1000u, flesh), ${w(W_.hresp)});
    ${ask(PO_.strip, "t", "a")}
    ${q(Q_.a0)} = a; ${q(Q_.pick)} = t;
    return;
  }
  // gulls: the shore's animals and the dead; crows: the dead and the worms
  var lb = ${L.shore}u;
  if (s == ${SP.crow}u) { lb = ${L.worms}u; }
  let tot = bw(${L.carr}u, 1u, lb, 1u, bx.x, bx.y, bx.z, bx.w);
  let a = mulq(muldiv(want, 1000u, flesh), resp(tot, half));
  if (tot == 0u || a == 0u) { return; }
  let t = pick(${L.carr}u, 1u, lb, 1u, bx.x, bx.y, bx.z, bx.w, unif(tot)).x;
  let lc = lay(${L.carr}u, t); let lo = lay(lb, t);
  let ac = muldiv(a, lc, lc + lo);
  ${ask(PO_.carr, "t", "ac")}
  if (s == ${SP.gull}u) { ${ask(PO_.shore, "t", "a - ac")} }
  ${q(Q_.a0)} = ac; ${q(Q_.a0 + 1)} = a - ac; ${q(Q_.pick)} = t;
`)}`;
}

// ---------- claim: resolve (animals), share (tiles) ----------
// Bindings: b, W, A, KP, Q. Dispatched as satRows set out.
export function animalsClaim(cap: number) {
  const askOf = (p: number) => `atomicLoad(&A[${A_.ask}u + ${p}u * T + t])`;
  return `${HEAD(cap)}${decl([["b", "rw"], ["W", "rw"], ["A", "a"], ["KP", "r"], ["Q", "r"]])}
${KREAD}${BODY}
fn part(ask: u32, avail: u32) -> u32 { if (ask <= avail) { return 65536u; } return muldiv(avail, 65536u, ask); }
${PARTS([["resolve", "CAP", /* wgsl */ `
  let prey = Q[${Q_.tgt}u * CAP + i];
  if (prey == NONE) { return; }
  if (atomicLoad(&A[${A_.claim}u + prey]) != ~Q[${Q_.key}u * CAP + i]) { return; }
  // the one claimant left: the prey dies, its carcass the claimant's
  b[prey] = b[prey] & ~1u;
  let ps = b[fo(2u) + prey] & 15u;
  let pt = tile_of(b[fo(0u) + prey], b[fo(1u) + prey]);
  let flesh = kg(${G.flesh}u);
  var g = kk(ps, ${K.kg}u);
  if (ps == ${SP.deer}u) { let rav = mulq(g, kg(${G.ravens}u)); atomicAdd(&A[${A_.carr}u + pt], rav); g = g - rav; }
  let e = g * flesh;
  let s = b[fo(2u) + i] & 15u;
  let grp1 = b[fo(7u) + i];
  if (s == ${SP.wolf}u && grp1 > 0u) {
    let grp = grp1 - 1u;
    atomicAdd(&A[${A_.claim}u + CAP * ${1 + PACK.pot}u + grp], e);
    atomicMax(&A[${A_.claim}u + CAP * ${1 + PACK.tile}u + grp], pt + 1u);
    return;
  }
  let full = kk(s, ${K.full}u); let mine = fe(i);
  let want = u32(max(0i, bitcast<i32>(full) - mine));
  let eat = min(e, want);
  b[fo(4u) + i] = bitcast<u32>(mine + bitcast<i32>(eat));
  atomicAdd(&A[${A_.carr}u + pt], (e - eat) / flesh);
`], ["share", "T", /* wgsl */ `
  let t = i;
  for (var p = 0u; p < ${NPOOL}u; p++) { ${w(`${W_.share}u + p`)} = 65536u; }
  if (${w(W_.land)} == 0u) {
    ${w(W_.share + PO_.water)} = part(${askOf(PO_.water)}, smul(${w(W_.fish)}, 1000u));
    return;
  }
  // the rabbits crop round their warrens first, the deer take what is left of the ground layer, and the browse
  let reach = mulq(${w(W_.garea)}, ${w(W_.open)});
  let rreach = mulq(reach, ${w(W_.warren)});
  let rg = ${askOf(PO_.rg)}; let rd = ${askOf(PO_.rd)};
  let arg = muldiv(${w(W_.fg)}, rreach, 65536u); let ard = muldiv(${w(W_.fd)}, rreach, 65536u);
  ${w(W_.share + PO_.rg)} = part(rg, arg); ${w(W_.share + PO_.rd)} = part(rd, ard);
  let adg = sat_sub(muldiv(${w(W_.fg)}, reach, 65536u), min(rg, arg));
  let add = sat_sub(muldiv(${w(W_.fd)}, reach, 65536u), min(rd, ard));
  ${w(W_.share + PO_.dg)} = part(${askOf(PO_.dg)}, adg); ${w(W_.share + PO_.dd)} = part(${askOf(PO_.dd)}, add);
  ${w(W_.share + PO_.dbg)} = part(${askOf(PO_.dbg)}, muldiv(${w(W_.bg)}, ${w(W_.barea)}, 65536u));
  ${w(W_.share + PO_.dbd)} = part(${askOf(PO_.dbd)}, muldiv(${w(W_.bd)}, ${w(W_.barea)}, 65536u));
  ${w(W_.share + PO_.dtw)} = part(${askOf(PO_.dtw)}, muldiv(${w(W_.tw)}, ${w(W_.tarea)}, 65536u));
  ${w(W_.share + PO_.strip)} = part(${askOf(PO_.strip)}, smul(${w(W_.stripg)}, 1000u));
  ${w(W_.share + PO_.shore)} = part(${askOf(PO_.shore)}, smul(${w(W_.shoreg)}, 1000u));
  ${w(W_.share + PO_.carr)} = part(${askOf(PO_.carr)}, smul(${w(W_.carr)}, 1000u));
`]])}`;
}

// ---------- eat (animals), then the packs ----------
// Each forager gets its ask times its pool's share; then each wolf takes from its pack's pot its share of what the
// pack lacks (a wolf's eat part changes nothing of it). Bindings: b, W, A, KP, Q. Dispatched as satRows set out.
export function animalsEat(cap: number) {
  const q = (run: number) => `Q[${run}u * CAP + i]`;
  const sh = (p: number) => `W[(${W_.share}u + ${p}u) * T + t]`;
  const ate = (p: number, v: string) => `atomicAdd(&A[${A_.eat}u + ${p}u * T + t], ${v});`;
  const pk = (run: number, g: string) => `A[${A_.claim}u + CAP * ${1 + run}u + ${g}]`;
  return `${HEAD(cap)}${decl([["b", "rw"], ["W", "r"], ["A", "a"], ["KP", "r"], ["Q", "r"]])}
${KREAD}${BODY}
${PARTS([["eat", "CAP", /* wgsl */ `
  if ((b[i] & 1u) == 0u || b[fo(3u) + i] == 2u) { return; }
  let t = ${q(Q_.pick)};
  if (t == NONE || ${q(Q_.tgt)} != NONE) { return; }
  let s = b[fo(2u) + i] & 15u;
  let me = kg(${G.me}u); let med = kg(${G.med}u); let flesh = kg(${G.flesh}u);
  let a0 = ${q(Q_.a0)}; let a1 = ${q(Q_.a0 + 1)}; let a2 = ${q(Q_.a0 + 2)}; let a3 = ${q(Q_.a0 + 3)};
  var j = 0u;
  if (s == ${SP.deer}u) {
    let gg = mulq(a0, ${sh(PO_.dg)}); let gd = mulq(a1, ${sh(PO_.dd)}); let bg = mulq(a2, ${sh(PO_.dbg)}); let bd = mulq(a3, ${sh(PO_.dbd)});
    let tw = mulq(${q(Q_.a0 + 4)}, ${sh(PO_.dtw)});
    ${ate(PO_.dg, "gg")} ${ate(PO_.dd, "gd")} ${ate(PO_.dbg, "bg")} ${ate(PO_.dbd, "bd")} ${ate(PO_.dtw, "tw")}
    j = muldiv(gg, me, 1000u) + muldiv(bg, W[${W_.bq}u * T + t], 1000u) + muldiv(gd + bd, med, 1000u) + muldiv(tw, kg(${G.twme}u), 1000u);
  } else if (s == ${SP.rabbit}u) {
    let gg = mulq(a0, ${sh(PO_.rg)}); let gd = mulq(a1, ${sh(PO_.rd)});
    ${ate(PO_.rg, "gg")} ${ate(PO_.rd, "gd")}
    j = muldiv(gg, me, 1000u) + muldiv(gd, med, 1000u);
  } else if (s == ${SP.fox}u) {
    let g = mulq(a0, ${sh(PO_.carr)}); ${ate(PO_.carr, "g")} j = muldiv(g, flesh, 1000u);
  } else if (s == ${SP.eagle}u) {
    let g = mulq(a0, ${sh(PO_.water)}); ${ate(PO_.water, "g")} j = muldiv(g, flesh, 1000u);
  } else if (s == ${SP.heron}u) {
    let g = mulq(a0, ${sh(PO_.strip)}); ${ate(PO_.strip, "g")} j = muldiv(g, flesh, 1000u);
  } else if (s == ${SP.gull}u) {
    let c = mulq(a0, ${sh(PO_.carr)}); let o = mulq(a1, ${sh(PO_.shore)});
    ${ate(PO_.carr, "c")} ${ate(PO_.shore, "o")}
    j = muldiv(c + o, flesh, 1000u);
  } else if (s == ${SP.crow}u) {
    // the worms it takes are too few to thin the worms
    let c = mulq(a0, ${sh(PO_.carr)}); ${ate(PO_.carr, "c")}
    j = muldiv(c + a1, flesh, 1000u);
  }
  b[fo(4u) + i] = bitcast<u32>(fe(i) + bitcast<i32>(j));
`], ["pack", "CAP", /* wgsl */ `
  if ((b[i] & 1u) == 0u || b[fo(3u) + i] == 2u || (b[fo(2u) + i] & 15u) != ${SP.wolf}u) { return; }
  let grp = b[fo(7u) + i];
  if (grp == 0u) { return; }
  let pot = atomicLoad(&${pk(PACK.pot, "grp - 1u")}); let want = atomicLoad(&${pk(PACK.want, "grp - 1u")});
  if (pot == 0u || want == 0u) { return; }
  let e = fe(i);
  let mine = u32(max(0i, bitcast<i32>(kk(${SP.wolf}u, ${K.full}u)) - e));
  let take = muldiv(min(pot, want), mine, want);
  b[fo(4u) + i] = bitcast<u32>(e + bitcast<i32>(take));
  atomicAdd(&${pk(PACK.eaten, "grp - 1u")}, take);
`]])}`;
}

// ---------- settle (tiles) and leftover (pack slots), the fate pass's first parts ----------
function settle() {
  const eat = (p: number) => `atomicLoad(&A[${A_.eat}u + ${p}u * T + t])`;
  return /* wgsl */ `
  let t = i;
  if (${w(W_.land)} == 0u) {
    let g = ${eat(PO_.water)} / 1000u;
    if (g > 0u) { atomicAdd(&A[${A_.fish}u + t], g); }
    return;
  }
  let ga = ${w(W_.garea)};
  if (ga > 0u) {
    ${w(W_.fg)} = sat_sub(${w(W_.fg)}, muldiv(${eat(PO_.rg)} + ${eat(PO_.dg)}, 65536u, ga));
    ${w(W_.fd)} = sat_sub(${w(W_.fd)}, muldiv(${eat(PO_.rd)} + ${eat(PO_.dd)}, 65536u, ga));
  }
  let ba = ${w(W_.barea)};
  if (ba > 0u) {
    ${w(W_.bg)} = sat_sub(${w(W_.bg)}, muldiv(${eat(PO_.dbg)}, 65536u, ba));
    ${w(W_.bd)} = sat_sub(${w(W_.bd)}, muldiv(${eat(PO_.dbd)}, 65536u, ba));
  }
  let ta = ${w(W_.tarea)};
  if (ta > 0u) { ${w(W_.tw)} = sat_sub(${w(W_.tw)}, muldiv(${eat(PO_.dtw)}, 65536u, ta)); }
  ${w(W_.carr)} = sat_sub(${w(W_.carr)}, (${eat(PO_.carr)} + 999u) / 1000u);
  let m2 = ${w(W_.stripm2)};
  if (m2 > 0u) {
    let afdw = muldiv(${eat(PO_.shore)}, kg(${G.flesh}u), kg(${G.shorej}u));
    ${w(W_.shore)} = sat_sub(${w(W_.shore)}, muldiv(afdw, 65536u, smul(m2, 1000u)));
  }
  // the fish a heron took from the shallows, from each water tile beside as its fish there stand in the strip
  let fg = ${eat(PO_.strip)} / 1000u; let sg = ${w(W_.stripg)};
  if (fg > 0u && sg > 0u) {
    for (var m = 0u; m < 4u; m++) {
      let j = ${w(`${W_.sw}u + m`)};
      if (j == NONE) { continue; }
      let part = mulq(${w(W_.fish, "j")}, ${w(`${W_.sa}u + m`)});
      let g = muldiv(fg, part, sg);
      if (g > 0u) { atomicAdd(&A[${A_.fish}u + j], g); }
    }
  }
`;
}
// What a pack left of its kills lies where it killed.
function leftover() {
  const pk = (run: number) => `A[${A_.claim}u + CAP * ${1 + run}u + i]`;
  return /* wgsl */ `
  let pot = atomicLoad(&${pk(PACK.pot)});
  if (pot == 0u) { return; }
  let left = pot - atomicLoad(&${pk(PACK.eaten)});
  let t = atomicLoad(&${pk(PACK.tile)}) - 1u;
  atomicAdd(&A[${A_.carr}u + t], left / kg(${G.flesh}u));
`;
}

// ---------- fate: settle (tiles), leftover (pack slots), fate (animals) ----------
// Bindings: b, W, A, KP, S, Q, TERR. Dispatched as satRows set out.
export function animalsFate(cap: number) {
  const q = (run: number) => `Q[${run}u * CAP + i]`;
  return `${HEAD(cap)}${decl([["b", "rw"], ["W", "rw"], ["A", "a"], ["KP", "r"], ["S", "r"], ["Q", "rw"], ["TERR", "r"]])}
${KREAD}${BODY}${SAT}
fn spot(t: u32) -> vec2u { return vec2u((t % TW) * TMM + unif(TMM), (t / TW) * TMM + unif(TMM)); }
fn anyland(bx: vec4u) -> u32 {
  let n = box(${L.land}u, bx.x, bx.y, bx.z, bx.w);
  if (n == 0u) { return NONE; }
  return pick(${L.land}u, 1u, ${L.land}u, 0u, bx.x, bx.y, bx.z, bx.w, unif(n)).x;
}
// One of nine tiles (this one, then its neighbours row by row) drawn as their pulls stand: a grazer's matching.
fn matching(t: u32, run: u32) -> u32 {
  let x = i32(t % TW); let y = i32(t / TW);
  var tot = W[run * T + t];
  for (var dy = -1i; dy <= 1i; dy++) { for (var dx = -1i; dx <= 1i; dx++) {
    let xx = x + dx; let yy = y + dy;
    if ((dx == 0i && dy == 0i) || xx < 0i || yy < 0i || xx >= ${TW}i || yy >= ${TW}i) { continue; }
    let j = u32(yy) * TW + u32(xx);
    if (W[j] == 1u) { tot = tot + W[run * T + j]; }
  } }
  if (tot == 0u) { return t; }
  var u = unif(tot);
  if (u < W[run * T + t]) { return t; }
  u = u - W[run * T + t];
  for (var dy = -1i; dy <= 1i; dy++) { for (var dx = -1i; dx <= 1i; dx++) {
    let xx = x + dx; let yy = y + dy;
    if ((dx == 0i && dy == 0i) || xx < 0i || yy < 0i || xx >= ${TW}i || yy >= ${TW}i) { continue; }
    let j = u32(yy) * TW + u32(xx);
    if (W[j] != 1u) { continue; }
    let v = W[run * T + j];
    if (u < v) { return j; }
    u = u - v;
  } }
  return t;
}
fn young(n: u32, p: u32) -> u32 { var c = 0u; for (var k = 0u; k < n; k++) { if (bern16(p)) { c = c + 1u; } } return c; }
${PARTS([["settle", "T", settle()], ["leftover", "CAP", leftover()], ["fate", "CAP", /* wgsl */ `
  ${q(Q_.cnt)} = 0u;
  if ((b[i] & 1u) == 0u) { return; }
  let sw = b[fo(2u) + i]; let s = sw & 15u; let female = (sw >> 4u) & 1u;
  let tick = pp(${P.tick}u); let flags = pp(${P.flags}u);
  rinit(pp(${P.seed}u), ${STREAM.fate}u, i, tick);
  let full = kk(s, ${K.full}u);
  var e = min(fe(i), bitcast<i32>(full));
  let wolves = min(atomicLoad(&A[${A_.cen}u + ${SP.wolf}u]), ${WTN - 1}u);
  var die = kk(s, ${K.die}u);
  if (s == ${SP.wolf}u) { die = KP[WTAB + wolves]; }
  let r = next32();
  let x = b[fo(0u) + i]; let y = b[fo(1u) + i];
  if (e < 0i || r < die) {
    b[i] = b[i] & ~1u;
    atomicAdd(&A[${A_.carr}u + tile_of(x, y)], kk(s, ${K.kg}u));
    return;
  }
  b[fo(4u) + i] = bitcast<u32>(e);
  let held = b[fo(3u) + i];
  var hx = b[fo(8u) + i]; var hy = b[fo(9u) + i];
  // moving: deer to a tile of nine as their pulls stand, rabbits round their warrens (now and then to a better one),
  // the rest to where they hunted or foraged
  if (held == 0u) {
    var to = vec2u(x, y);
    if (s == ${SP.deer}u) {
      to = spot(matching(tile_of(x, y), ${W_.pdeer}u));
    } else if (s == ${SP.rabbit}u) {
      if (next32() < kk(s, ${K.move}u)) { let h = spot(matching(tile_of(hx, hy), ${W_.prabbit}u)); hx = h.x; hy = h.y; }
      to = vec2u(u32(max(0i, i32(hx) + i32(unif(100001u)) - 50000i)), u32(max(0i, i32(hy) + i32(unif(100001u)) - 50000i)));
      to = min(to, vec2u(TW * TMM - 1u));
    } else {
      let t = Q[${Q_.pick}u * CAP + i];
      if (t != NONE) { to = spot(t); }
    }
    b[fo(0u) + i] = to.x; b[fo(1u) + i] = to.y;
  }
  // grown: off to a home of its own
  let age = tick - b[fo(5u) + i];
  let mature = kk(s, ${K.mature}u);
  let tps = pp(${P.tps}u);
  if (age < 0x80000000u && age >= mature && age < mature + tps && next32() < kk(s, ${K.disp}u)) {
    let dr = kk(s, ${K.dreach}u);
    var bx = vec4u(0u, 0u, TW - 1u, TW - 1u);
    if (dr != 0u) { bx = boxof(tile_of(hx, hy), dr); }
    let t = anyland(bx);
    if (t != NONE) { let h = spot(t); hx = h.x; hy = h.y; }
    if (s == ${SP.wolf}u) { b[fo(7u) + i] = i + 1u; }
  }
  b[fo(8u) + i] = hx; b[fo(9u) + i] = hy;
  // the young
  if (female == 0u || age >= 0x80000000u || age < mature || held == 2u) { return; }
  let fit = muldiv(u32(max(e, 0i)), 65536u, full);
  var n = 0u;
  let kidsp = kk(s, ${K.young}u);
  if (s == ${SP.deer}u) {
    if ((flags & ${FLAG.rut}u) != 0u && b[fo(6u) + i] == 0u) {
      if (bern16(min(kg(${G.rutmax}u), kg(${G.rutlo}u) + mulq(kg(${G.rutsl}u), fit)))) { b[fo(6u) + i] = 1u; }
    }
    if ((flags & ${FLAG.calve}u) != 0u && b[fo(6u) + i] == 1u) { n = 1u; b[fo(6u) + i] = 0u; }
  } else if (s == ${SP.rabbit}u) {
    if ((flags & ${FLAG.kits}u) != 0u && fit > kg(${G.kitfit}u)) {
      let r2 = next32();
      if (r2 < kg(${G.kitp}u)) { n = young(kk(s, ${K.litter}u), kidsp); }
    }
  } else if (s == ${SP.wolf}u) {
    let grp = b[fo(7u) + i];
    if ((flags & ${FLAG.whelp}u) != 0u && grp > 0u && atomicLoad(&A[${A_.claim}u + CAP * ${1 + PACK.breed}u + grp - 1u]) == ~i) {
      var litter = kk(s, ${K.litter}u);
      if (next32() < 0x80000000u) { litter = litter + 1u; }
      n = young(litter, mulq(KP[WTAB + ${WTN}u + wolves], fit));
    }
  } else if (s == ${SP.fox}u) {
    if ((flags & ${FLAG.cub}u) != 0u) { n = young(kk(s, ${K.litter}u), mulq(kidsp, fit)); }
  } else if (s == ${SP.gull}u) {
    if ((flags & ${FLAG.gull}u) != 0u) { n = young(kk(s, ${K.litter}u), mulq(kidsp, fit)); }
  } else {
    var r3 = 0u; var fl = ${FLAG.heron}u;
    if (s == ${SP.eagle}u) { r3 = 1u; fl = ${FLAG.eagle}u; }
    if (s == ${SP.crow}u) { r3 = 2u; fl = ${FLAG.crow}u; }
    if ((flags & fl) != 0u && TERR[r3 * CAP + i] - TERR[r3 * CAP] < kk(s, ${K.terr}u)) { n = young(kk(s, ${K.litter}u), mulq(kidsp, fit)); }
  }
  ${q(Q_.cnt)} = n;
`]])}`;
}

// ---------- births ----------
// The parent's initialization of each young (store.ts births, extra buffer KP): its kind, a sex drawn even, where its
// parent stands and its parent's home and pack, a reserve of NEWE, born now. Young past the kind's room are not born
// (the store's births dropping them, so the room never overflows).
export const BIRTH_KP = KREAD;
export const BIRTH_INIT = /* wgsl */ `
  let ps = parent_sp(parent) & 15u;
  let now = KP[${PO}u + ${P.tick}u];
  rinit(KP[${PO}u + ${P.seed}u], ${STREAM.birth}u, parent * 8u + min(k, 7u), now);
  let r = next32();
  child_set_sp(slot, ps | select(0u, 16u, r < 0x80000000u));
  child_set_x(slot, parent_x(parent)); child_set_y(slot, parent_y(parent));
  child_set_hx(slot, parent_hx(parent)); child_set_hy(slot, parent_hy(parent));
  child_set_grp(slot, parent_grp(parent));
  child_set_e(slot, bitcast<i32>(KP[ps * ${KW}u + ${K.newe}u]));
  child_set_born(slot, now);
`;
export const BIRTH_HEAD = FIXED + RAND;

// ---------- the browse, once a day from the stems ----------
// Each tile's woody browse from the crown raster the stems' law files (wgsl/stems.ts): every live stem's crown share
// of its texel, a bush's at 0.3 of it within a deer's reach and a tree's at 0.1, summed by its kind's browse class;
// the broadleaves' (class 1) on their own too, the share whose current-year twigs a deer browses once they are bare.
// Bindings: plant body, starts (texels + 1), list, W, KP. The class table: per SPECIES index, class (0 none, 1
// deciduous, 2 pine, 3 bramble, 4 heather); at KP[CLS + 32 + 2 c] each class's worth in and out of the growing season,
// J/g.
export function animalsBrowse(plantCap: number, whatField: number, texelsSide: number) {
  return `${FIXED}
const T = ${T}u; const TW = ${TW}u; const PCAP = ${plantCap}u; const CLS = ${CLS}u; const TS = ${texelsSide}u;
${decl([["pb", "r"], ["st", "r"], ["li", "r"], ["W", "rw"], ["KP", "r"]])}
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }
fn muldiv(a: u32, b: u32, c: u32) -> u32 { if (c == 0u) { return 0u; } let p = mul64(a, b); if (p.y >= c) { return 0xffffffffu; } return divw(p.y, p.x, c).x; }
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let t = flat(g, n) ;
  if (t >= T) { return; }
  let per = TS / TW;
  var all = 0u; var ever = 0u; var dec = 0u; var su = vec2u(0u); var wi = vec2u(0u);
  for (var dy = 0u; dy < per; dy++) { for (var dx = 0u; dx < per; dx++) {
    let tex = ((t / TW) * per + dy) * TS + (t % TW) * per + dx;
    for (var p = st[tex]; p < st[tex + 1u]; p++) {
      let s = li[3u * p];
      if ((pb[s] & 1u) == 0u) { continue; }
      let c = KP[CLS + ((pb[${whatField + 1}u * PCAP + s] >> 8u) & 31u)];
      if (c == 0u) { continue; }
      let m = li[3u * p + 2u] * select(3u, 1u, (li[3u * p + 1u] & 1u) == 1u) / 10u;
      all = all + m;
      su = add64(su, mul64(m, KP[CLS + 32u + 2u * c]));
      if (c >= 2u) { ever = ever + m; wi = add64(wi, mul64(m, KP[CLS + 33u + 2u * c])); } else { dec = dec + m; }
    }
  } }
  let woody = min(65536u, all / (per * per));
  W[${W_.woody}u * T + t] = woody;
  var e = 0u; var sj = KP[CLS + 34u]; var wj = KP[CLS + 35u];
  if (all > 0u) { e = muldiv(ever, 65536u, all); sj = divw(su.y, su.x, all).x; }
  if (ever > 0u) { wj = divw(wi.y, wi.x, ever).x; }
  W[${W_.ever}u * T + t] = e; W[${W_.summer}u * T + t] = sj; W[${W_.winter}u * T + t] = wj;
  W[${W_.barea}u * T + t] = muldiv(woody, KP[${GK + G.m2}u] * 1000u, 65536u);
  let twoody = min(65536u, dec / (per * per));
  W[${W_.twoody}u * T + t] = twoody;
  W[${W_.tarea}u * T + t] = muldiv(twoody, KP[${GK + G.m2}u] * 1000u, 65536u);
}`;
}
