// Smith and Barstad's orographic rain in WGSL (src/gpu/terrain/rain.ts drives it; the rain comment in
// src/terrain/climate.ts gives the theory). Six passes, all integer, each invocation writing only its own
// words, so every GPU gives the same words:
//   coarse    the 16 fine cells of each 4x4 block summed (exactly the coarse height, in Q20 m)
//   rows      the Fourier transform along x of the 64 coarse rows, 256 frequencies each
//   cols      the transform along y: the height's spectrum on the 256 x 256 grid
//   transfer  the spectrum times the Smith-Barstad transfer, for each of 16 wind directions in each of 4 seasons
//   invA      the inverse transform along y, only the 64 rows the island occupies
//   invB      the inverse along x, only the 64 columns, real part, divided by M x M: the rain of a rain hour
//   fine      bilinear to the 256 x 256 cells, the positive part kept for each direction, summed by the wet rose
// The transforms are matrix sums, not an FFT: each runs over the 64 rows or columns the island occupies in the 256 x 256
// grid (the rest is zero, or not wanted) and all 256 frequencies, summed exactly in 64 bits with one rounding at the end,
// so a transform's error does not depend on a scaling schedule or on growth between stages. An FFT would need far fewer
// products (about 1e9 64-bit products here for the 64 inverses against some 3e7 butterflies) but also a per-stage
// shift and rounding in 32-bit words, whose headroom the island's spectrum would have to be checked against; it was
// not built, because the sums already take 20 ms for the whole island (a float FFT took 190 ms). The measured
// headroom of the words (seeds 1 to 3): the spectrum and the transfer's output stay under 2^28 of 2^31, and the sums
// of the inverses' terms under 2^31 of 2^35.
import { N } from "../../terrain/grid";
import { COARSE, DIRS, M, NC, SEASONS } from "../../terrain/climate";
import { FIXED } from "./fixed";

// What a kernel is made for: the fine grid's side `n` (cells), the side of the blocks the heights are averaged to `coarse`
// (a power of two) and, with `cells`, the per-cell inputs of a patch of the planet (src/gpu/globe/air.ts): each cell's own
// background rain and wind direction, in place of the one background and the one wet rose of the island's. The coarse grid is
// n / coarse blocks a side and the transforms' grid four times that [design: the island's own ratio]. The island's format
// gives the kernels' text as it was before the format existed.
export interface RainFormat { n: number; coarse: number; cells?: boolean; wide?: boolean }
export const ISLAND_RAIN: RainFormat = { n: N, coarse: COARSE };
export const rainDims = (f: RainFormat) => { const nc = f.n / f.coarse; return { nc, m: 4 * nc }; };
// The thread's index: the global id's x where one row of workgroups covers the passes; a `wide` format may need more than the dispatch limit (65,535 groups of 256) and
// reads the rows too (src/gpu/kernel.ts cover splits it so).
const thread = (f: RainFormat, group = 256) => (f.wide
  ? { sig: "@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nw: vec3u", idx: `g.x + g.y * nw.x * ${group}u` }
  : { sig: "@builtin(global_invocation_id) g: vec3u", idx: "g.x" });

// Q formats (a number x held as the integer round(x * 2^n)):
// - height z: Q16 m in, coarse height hc Q20 m; row transform r Q13 m, spectrum hh Q10 m (both unnormalised sums);
// - twiddles cos and sin of 2 pi n / M: Q28; the wind's cos and sin Q22; wave index times them: q Q22 (grid units of
//   the wind's wave number: sigma = U k + V l = wind dk q);
// - transfer pieces Q30 (every factor is at most 1 in size); the transfer times the spectrum times C_w sigma: s Q16
//   mm an hour (unnormalised); inverse along y: a Q8; the rain of a rain hour p: Q24 mm an hour;
// - the rain of the season out: Q16 mm.
export const BATCH = SEASONS.length * DIRS; // seasons times wind directions

const common = (f: RainFormat) => {
  const { nc: NC, m: M } = rainDims(f), N = f.n, COARSE = f.coarse;
  return /* wgsl */ `
${FIXED}
const N = ${N}u;
const COARSE = ${COARSE}u;
const NC = ${NC}u;
const M = ${M}u;
const MM = ${M * M}u;
const CELLS = ${N * N}u;
const SD = ${BATCH}u;
const DIRS = ${DIRS}u;
const NS = ${SEASONS.length}u;
const DIR_AT = NS * 8u;
const SHARE_AT = DIR_AT + 2u * DIRS;
// the coarse index is clamped to NC - 1.001, which leaves the last cell's fraction at 0.999
const FX_TOP = ${Math.round((NC - 1.001 - (NC - 2)) * 65536)}u;

// the signed 64-bit product, as two's complement words
fn smul64(a: i32, b: i32) -> vec2u {
  let ua = bitcast<u32>(a); let ub = bitcast<u32>(b);
  let p = mul64(ua, ub);
  return vec2u(p.x, p.y - select(0u, ub, a < 0i) - select(0u, ua, b < 0i));
}
// v / 2^sh rounded half up, as an i32 (saturating); 1 <= sh <= 63
fn shr64(v: vec2u, sh: u32) -> i32 {
  var s: vec2u;
  if (sh <= 32u) { s = add64(v, vec2u(1u << (sh - 1u), 0u)); } else { s = add64(v, vec2u(0u, 1u << (sh - 33u))); }
  let hi = bitcast<i32>(s.y);
  if (sh >= 32u) { return hi >> (sh - 32u); }
  let r = bitcast<i32>((s.x >> sh) | (s.y << (32u - sh)));
  if ((hi >> sh) != (r >> 31u)) { return select(0x7fffffffi, -0x7fffffffi, hi < 0i); }
  return r;
}
fn mulq(a: i32, b: i32, sh: u32) -> i32 { return shr64(smul64(a, b), sh); }
// floor(sqrt(n)) of a 64-bit n whose root is under 2 * top
fn sqrt64(n: vec2u, top: u32) -> u32 {
  var r = 0u;
  for (var bit = top; bit != 0u; bit = bit >> 1u) {
    let c = r | bit;
    if (!lt64(n, mul64(c, c))) { r = c; }
  }
  return r;
}
fn cmul30(a: vec2i, b: vec2i) -> vec2i {
  return vec2i(mulq(a.x, b.x, 30u) - mulq(a.y, b.y, 30u), mulq(a.x, b.y, 30u) + mulq(a.y, b.x, 30u));
}
// 1 / (1 + i x) for x = y0 q (y0 Q26, q Q22), as (re, im) in Q30: (1 - i x) / (1 + x^2). The word 1 + x^2 holds x up to
// 255 (Q16 in a u32), so a larger x is held at 254: there the factor is under 0.4% in size (1.6e-5 real, 3.9e-3
// imaginary) and the two delays together under 2e-5 of a wave's amplitude, and only waves near the coarse grid's own
// 600 m wavelength reach it (x = sigma tau: the longest delay, 2100 s, on the fastest wind), which the 4 x 4 block means
// carry least. The delays of 1000 s never reach it (x tops out at 200).
fn lag(y0: i32, q: i32) -> vec2i {
  let x = clamp(mulq(y0, q, 26u), -0x3f800000i, 0x3f800000i);
  let xa = mag(x);
  let p = add64(mul64(xa, xa), vec2u(1u << 27u, 0u));
  let d = 65536u + ((p.x >> 28u) | (p.y << 4u));
  let u = divw(1u << 14u, 0u, d).x;
  return vec2i(i32(u), -mulq(x, i32(u), 22u));
}
// a pixel's coarse neighbour and fraction (Q16) along one axis: clamp((c + 0.5) / ${COARSE} - 0.5, 0, NC - 1.001)
fn axis(c: u32) -> vec2u {
  let t = 2i * i32(c) - ${f.coarse - 1}i;
  if (t <= 0i) { return vec2u(0u, 0u); }
  if (t >= ${2 * f.coarse}i * i32(NC - 1u)) { return vec2u(NC - 2u, FX_TOP); }
  return vec2u(u32(t) >> ${Math.log2(2 * f.coarse)}u, (u32(t) & ${2 * f.coarse - 1}u) << ${16 - Math.log2(2 * f.coarse)}u);
}
`;
};

const bind = (names: { n: string; rw?: boolean }[]) =>
  names.map(({ n, rw }, i) => `@group(0) @binding(${i}) var<storage, ${rw ? "read_write" : "read"}> ${n}: array<i32>;`).join("\n");
// The twiddle index of a product of two indices: their product mod M (a mask where M is a power of two, as the island's is).
const wrap = (f: RainFormat, e: string) => { const { m } = rainDims(f); return Number.isInteger(Math.log2(m)) ? `(${e}) & (M - 1u)` : `(${e}) % M`; };
// The block's heights summed to hc, the sum of COARSE^2 heights as Q20 of the mean: the island's 16 are exact; a wider block sums
// each row, shifts it down to the words (rounding half up) and sums the rows (the sum of 256 of Q16 heights overflows a word).
const coarseSum = (f: RainFormat) => {
  if (f.coarse === 4) return "  for (var dy = 0u; dy < COARSE; dy++) { for (var dx = 0u; dx < COARSE; dx++) { s += zq[(cy * COARSE + dy) * N + cx * COARSE + dx]; } }\n  hc[n] = s;";
  const sh = Math.log2((f.coarse * f.coarse) / 16);
  return `  for (var dy = 0u; dy < COARSE; dy++) {\n    var row = 0i;\n    for (var dx = 0u; dx < COARSE; dx++) { row += zq[(cy * COARSE + dy) * N + cx * COARSE + dx]; }\n    s += (row + ${(1 << sh) >> 1}i) >> ${sh}u;\n  }\n  hc[n] = s;`;
};

// Bindings: zq (the heights, Q16 m), hc (out).
export const rainCoarse = (f = ISLAND_RAIN) => /* wgsl */ `${common(f)}
${bind([{ n: "zq" }, { n: "hc", rw: true }])}
@compute @workgroup_size(256)
fn main(${thread(f).sig}) {
  let n = ${thread(f).idx};
  if (n >= NC * NC) { return; }
  let cx = n % NC; let cy = n / NC;
  var s = 0i;
${coarseSum(f)}
}`;

// Bindings: hc, tw (cos then sin, M each, Q28), r (out: NC rows x M frequencies x re, im).
export const rainRows = (f = ISLAND_RAIN) => /* wgsl */ `${common(f)}
${bind([{ n: "hc" }, { n: "tw" }, { n: "r", rw: true }])}
@compute @workgroup_size(256)
fn main(${thread(f).sig}) {
  let n = ${thread(f).idx};
  if (n >= NC * M) { return; }
  let k = n % M; let y = n / M;
  var ar = vec2u(0u); var ai = vec2u(0u);
  for (var x = 0u; x < NC; x++) {
    let h = hc[y * NC + x]; let t = ${wrap(f, "k * x")};
    ar = add64(ar, smul64(h, tw[t])); ai = sub64(ai, smul64(h, tw[M + t]));
  }
  r[2u * n] = shr64(ar, 35u); r[2u * n + 1u] = shr64(ai, 35u);
}`;

// Bindings: r, tw, hh (out: M x M, index l * M + k, re and im).
export const rainCols = (f = ISLAND_RAIN) => /* wgsl */ `${common(f)}
${bind([{ n: "r" }, { n: "tw" }, { n: "hh", rw: true }])}
@compute @workgroup_size(256)
fn main(${thread(f).sig}) {
  let n = ${thread(f).idx};
  if (n >= MM) { return; }
  let k = n % M; let l = n / M;
  var ar = vec2u(0u); var ai = vec2u(0u);
  for (var y = 0u; y < NC; y++) {
    let t = ${wrap(f, "l * y")}; let c = tw[t]; let s = tw[M + t];
    let a = r[2u * (y * M + k)]; let b = r[2u * (y * M + k) + 1u];
    ar = add64(add64(ar, smul64(a, c)), smul64(b, s));
    ai = add64(sub64(ai, smul64(a, s)), smul64(b, c));
  }
  hh[2u * n] = shr64(ar, 31u); hh[2u * n + 1u] = shr64(ai, 31u);
}`;

// The transfer times the spectrum, for every wave and every (season, direction): C_w i sigma h / ((1 - i m H_w)
// (1 + i sigma tau_c)(1 + i sigma tau_f)) of climate.ts, with sigma = wind dk q and, writing e for
// a sqrt(|1 - u^2|), a = N_m H_w / wind, u = sigma / N_m and r for the share of the wave's length along the wind
// (q over the wave number's length in grid units): m H_w is e / r, real (the term is 1 - i sign(sigma) m H_w) where
// |u| <= 1 and imaginary (the term is 1 + m H_w) beyond.
// Bindings: hh, par (seasons: B, a, c1, y0c, y0f Q26 and the background rain Q24, 8 words each; directions: cos and sin
// Q22, from word 32; the wet rose's share of the season's rain hours, Q20, from word 64), s (out).
export const rainTransfer = (f = ISLAND_RAIN) => /* wgsl */ `${common(f)}
${bind([{ n: "hh" }, { n: "par" }, { n: "s", rw: true }])}
@compute @workgroup_size(256)
fn main(${thread(f).sig}) {
  let id = ${thread(f).idx};
  if (id >= SD * MM) { return; }
  let sd = id / MM; let n = id % MM;
  let season = sd / DIRS; let d = sd % DIRS; let sb = season * 8u;
  let ii = n % M; let jj = n / M;
  let o = id * 2u;
  var i = i32(ii); if (ii >= M / 2u) { i -= i32(M); }
  var j = i32(jj); if (jj >= M / 2u) { j -= i32(M); }
  let q = par[DIR_AT + 2u * d] * i + par[DIR_AT + 2u * d + 1u] * j;
  s[o] = 0i; s[o + 1u] = 0i;
  if (par[SHARE_AT + sd] == 0i || q == 0i) { return; }
  let neg = q < 0i;
  let aq = mag(q);
  // r: the wind's share of the wave number's length, Q30
  let rho = sqrt64(vec2u(0u, u32(i * i + j * j)), 1u << 24u);
  let rp = min(divw(aq >> 8u, aq << 24u, rho).x, 1u << 30u);
  // u = sigma / N_m, Q22, and e / a = sqrt(|1 - u^2|), Q22
  let uq = mulq(par[sb + 2u], q, 26u);
  let ua = mag(uq);
  let u2 = mul64(ua, ua);
  let one = vec2u(0u, 1u << 12u);
  let real = ua <= (1u << 22u);
  let z = select(sub64(u2, one), sub64(one, u2), real);
  let e22 = mulq(par[sb + 1u], i32(sqrt64(z, 1u << 28u)), 26u);
  var f1 = vec2i(0i, 0i);
  if (real) {
    let r = i32(rp >> 2u); let e = e22 << 6u;
    let rr = mulq(r, r, 28u); let ee = mulq(e, e, 28u); let re = mulq(r, e, 28u);
    let den = u32(rr + ee);
    if (den != 0u) {
      f1.x = i32(divw(u32(rr) >> 2u, u32(rr) << 30u, den).x);
      let fi = i32(divw(u32(re) >> 2u, u32(re) << 30u, den).x);
      f1.y = select(fi, -fi, neg);
    }
  } else {
    let r22 = i32((rp + 128u) >> 8u);
    let den = u32(r22 + e22);
    if (den != 0u) { f1.x = i32(divw(u32(r22) >> 2u, u32(r22) << 30u, den).x); }
  }
  let f = cmul30(cmul30(f1, lag(par[sb + 3u], q)), lag(par[sb + 4u], q));
  let hr = hh[2u * n]; let hi = hh[2u * n + 1u];
  let gr = mulq(hr, f.x, 30u) - mulq(hi, f.y, 30u);
  let gi = mulq(hr, f.y, 30u) + mulq(hi, f.x, 30u);
  let a = mulq(par[sb], q, 28u); // C_w 3600 sigma / h's unit: Q20 mm an hour a metre
  s[o] = mulq(-gi, a, 14u); s[o + 1u] = mulq(gr, a, 14u);
}`;

// One workgroup of 256 threads a (batch, row): a thread a frequency where M is 256 (the island's); more frequencies, each thread takes every 256th.
const invABody = (f: RainFormat) => {
  const inner = `  var ar = vec2u(0u); var ai = vec2u(0u);
  for (var jj = 0u; jj < M; jj++) {
    let t = ${wrap(f, "jj * y")}; let c = tw[t]; let sn = tw[M + t];
    let at = 2u * (sd * MM + jj * M + k);
    let sr = s[at]; let si = s[at + 1u];
    ar = sub64(add64(ar, smul64(sr, c)), smul64(si, sn));
    ai = add64(add64(ai, smul64(sr, sn)), smul64(si, c));
  }
  let o = 2u * ((sd * NC + y) * M + k);
  a[o] = shr64(ar, 36u); a[o + 1u] = shr64(ai, 36u);`;
  if (rainDims(f).m === 256) return `fn main(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_id) l: vec3u) {\n  let sd = w.x / NC; let y = w.x % NC; let k = l.x;\n${inner}\n}`;
  return `fn main(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_id) l: vec3u) {\n  let sd = w.x / NC; let y = w.x % NC;\n  for (var k = l.x; k < M; k += 256u) {\n${inner.replace(/^/gm, "  ")}\n  }\n}`;
};
// Bindings: s, tw, a (out: batch x NC rows x M frequencies x re, im). One workgroup a (batch, row).
export const rainInvA = (f = ISLAND_RAIN) => /* wgsl */ `${common(f)}
${bind([{ n: "s" }, { n: "tw" }, { n: "a", rw: true }])}
@compute @workgroup_size(256)
${invABody(f)}`;

// Bindings: a, tw, p (out: batch x NC x NC, Q24 mm an hour: the rain of a rain hour that the waves add).
export const rainInvB = (f = ISLAND_RAIN) => /* wgsl */ `${common(f)}
${bind([{ n: "a" }, { n: "tw" }, { n: "p", rw: true }])}
@compute @workgroup_size(256)
fn main(${thread(f).sig}) {
  let n = ${thread(f).idx};
  if (n >= SD * NC * NC) { return; }
  let x = n % NC; let y = (n / NC) % NC; let sd = n / (NC * NC);
  var sum = vec2u(0u);
  for (var k = 0u; k < M; k++) {
    let t = ${wrap(f, "k * x")};
    let at = 2u * ((sd * NC + y) * M + k);
    sum = sub64(add64(sum, smul64(a[at], tw[t])), smul64(a[at + 1u], tw[M + t]));
  }
  p[n] = shr64(sum, 28u);
}`;

// The orographic waves as a convolution with a finite response (the unit's one solve: a cell's rain is a function of the relief within `radius` coarse cells of it, under any
// tiling). Bindings: hc (the coarse heights, Q20 m), tab (the response of each (season, direction): 2 radius + 1 squared words, the rain of a rain hour that a 1,024 m impulse of
// one coarse cell makes at that offset, Q24 mm an hour: the impulse's coarse word is 2^30), p (out: BATCH x NC x NC, Q24 mm an hour, as rainInvB's). Cells past the patch's edge count as none.
export const rainConv = (f: RainFormat, radius: number) => /* wgsl */ `${common(f)}
${bind([{ n: "hc" }, { n: "tab" }, { n: "p", rw: true }])}
const RAD = ${radius}i;
const WID = ${2 * radius + 1}u;
@compute @workgroup_size(64)
fn main(${thread(f, 64).sig}) {
  let n = ${thread(f, 64).idx};
  if (n >= SD * NC * NC) { return; }
  let x = i32(n % NC); let y = i32((n / NC) % NC); let sd = n / (NC * NC);
  let t0 = sd * WID * WID;
  var acc = vec2u(0u);
  for (var dy = -RAD; dy <= RAD; dy++) {
    let yy = y - dy;
    if (yy < 0i || yy >= i32(NC)) { continue; }
    for (var dx = -RAD; dx <= RAD; dx++) {
      let xx = x - dx;
      if (xx < 0i || xx >= i32(NC)) { continue; }
      acc = add64(acc, smul64(hc[u32(yy) * NC + u32(xx)], tab[t0 + u32(dy + RAD) * WID + u32(dx + RAD)]));
    }
  }
  p[n] = shr64(acc, 30u);
}`;

// Bindings: p, par, cw, out (out: season x cells, Q16 mm): the orographic rain that a cell's waves add to its own background, summed over the directions by the wet rose as measured
// (par's shares: Q20 times the season's rain hours, bearing k of the island's code, read between two of them at the cell's turn): the sum over the directions of the share times
// (max(0, background + gain times the wave's rate) - background), the theory's cut at none (Smith and Barstad's eq. 40) per direction. cw holds, for each season in turn and then
// cell by cell: the background rain of an hour (Q20 mm, which holds 2,047 mm an hour), the turn of the rose (Q16 bearings), the gain (Q16: the cell's wind and humid air against the reference the table was
// made for, times the height scale of the coarse heights) [design: gpu/globe/air.ts].
export const rainFine = (f = ISLAND_RAIN) => /* wgsl */ `${common(f)}
${bind(f.cells ? [{ n: "p" }, { n: "par" }, { n: "cw" }, { n: "out", rw: true }] : [{ n: "p" }, { n: "par" }, { n: "out", rw: true }])}
@compute @workgroup_size(256)
fn main(${thread(f).sig}) {
  let id = ${thread(f).idx};
  if (id >= NS * CELLS) { return; }
  let season = id / CELLS; let cell = id % CELLS;
  let ax = axis(cell % N); let ay = axis(cell / N);
  let wx = i32(ax.y); let wy = i32(ay.y);
  var acc = 0i;
${f.cells ? `  let bg = cw[id]; let turn = cw[NS * CELLS + id]; let gain = cw[2u * NS * CELLS + id];
  for (var d = 0u; d < DIRS; d++) {
    let sd = season * DIRS + d;
    let u = u32((i32(d << 16u) - turn) & 0xfffff);
    let k0 = u >> 16u; let fr = i32(u & 65535u);
    let share = mulq(par[SHARE_AT + season * DIRS + k0], 65536i - fr, 16u) + mulq(par[SHARE_AT + season * DIRS + ((k0 + 1u) & 15u)], fr, 16u);
    if (share == 0i) { continue; }
    let b = sd * NC * NC + ay.x * NC + ax.x;
    let top = mulq(p[b], 65536i - wx, 16u) + mulq(p[b + 1u], wx, 16u);
    let bot = mulq(p[b + NC], 65536i - wx, 16u) + mulq(p[b + NC + 1u], wx, 16u);
    let wave = mulq(mulq(top, 65536i - wy, 16u) + mulq(bot, wy, 16u), gain, 20u);
    acc += mulq(max(-bg, wave), share, 24u);
  }` : `  for (var d = 0u; d < DIRS; d++) {
    let sd = season * DIRS + d;
    let share = par[SHARE_AT + sd];
    if (share == 0i) { continue; }
    let b = sd * NC * NC + ay.x * NC + ax.x;
    let top = mulq(p[b], 65536i - wx, 16u) + mulq(p[b + 1u], wx, 16u);
    let bot = mulq(p[b + NC], 65536i - wx, 16u) + mulq(p[b + NC + 1u], wx, 16u);
    let v = par[season * 8u + 5u] + mulq(top, 65536i - wy, 16u) + mulq(bot, wy, 16u);
    if (v > 0i) { acc += mulq(v, share, 28u); }
  }`}
  out[id] = acc;
}`;
