// The objects drawn straight from the sim's GPU buffers (plan Unit 14): WGSL for webgpu.js's cull, needs and canopy
// passes. Each drawn kind is a source: a body laid out as the store lays a kind (src/gpu/store.ts: C slot words, bit 0
// alive, then each field's C words) and the reader below, which gives every slot as an Obj; a placed kind also brings
// its spatial index (order and start, by the 75 m cells of src/terrain/grid.ts), so a frame culls only the cells under
// the view. A new kind plugs in by declaring a source: which fields hold its place, kind and species codes, size and
// variation, and how its size is held. Sources today (worker.js): the stems (store kind "plant", Unit 7's fields), the
// generator's static dormant members (stored nowhere by the sim, so the worker lays them out once in this shape), and
// the few things the CPU made or holds otherwise (stumps, logs a person cut, a changed tussock).
//
// An object's look is worked out here from its buffer every frame, as atlas.js Looks numbers it: its family (pair base
// from the tables, then layout, tint, the forest's darkness at its foot and its crown's width for a tree; layout, moss
// and berries for anything else) and its sprite's size at the level shown, as main.js collectLive drew it.
import { NS, META_WORDS, M_KIND, M_BASE, M_TSP, M_WB, M_CROWN, M_LEV, M_WRAP, M_PAGES, HSTEPS, CODES, K_TREE, K_GRASS, K_FLAT, K_MOSSY, K_DRAWN, NB, NONE } from "../atlas.js";
import { pageWGSL } from "../pages.js";
import { TREE_FADE_MIN } from "../canopy.js";

// A plant's pick is its slot with this bit, which the worker turns into its object number (flora.ts entry); one of the
// CPU's records' its slot with EXTRA_PICK, which the worker turns into the thing's id; anything else's pick is its
// object number. The page keeps the top bit for its own sprites (live.js PICK_LIVE).
export const PICK_SLOT = 0x40000000, EXTRA_PICK = 0x20000000;
// Any other source's objects (worker.js tagged): this bit, the source's tag in bits 24 to 27 and the slot below; a
// member of a bin or cell has no slot of its own, so all 24 bits set.
export const KIND_PICK = 0x10000000, NO_SLOT = 0xffffff;
// The 75 m cells of the sim's spatial index (src/terrain/grid.ts N, CELL).
export const CELLS_N = 256, CELL_M = 75;

const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

// A source's reader. spec: { cap, fields: { x, y, what, size, seed, pick?, nst? } (field numbers in the body), sizeMm
// (size in mm as a stem's, else f32 bits), marks (a bitset hiding slots the page or the CPU's records draw instead, then
// two bits a slot of berries: unknown, none, some), ordered (the index's order maps rows to slots; else rows are slots) }.
// A kind laid out otherwise (an animal, a log) brings read(at): WGSL setting o.kind, o.sp, o.size, o.seed, o.pick and
// o.nst (and o.ok, to skip it) from slot i, at(field) the word its field starts at, and decls, the WGSL that needs. A
// source of members brings member: memberCount(i) and member(i, k) for a body's slot i (bins: a stick bin's sticks), or
// for cells member(cell, k, ix, iy) (clasts: no body, a count each cell).
export function sourceWGSL(spec, ORIGIN) {
  if (spec.members === "cells") return `${spec.decls ?? ""}\n${spec.member}`;
  const C = spec.cap, F = spec.fields, at = (name) => `${(1 + F[name]) * C}u`;
  const hideWords = Math.ceil(C / 32);
  const cn = spec.n ?? CELLS_N;
  // spec.origin: where the source stands in the window's frame, two words after its columns (mm from the window corner, signed): x, then z; spec.thin: a third, the share drawn, as k or as the f32 bits of a fractional exponent (the body was made at a denser one)
  const tail = (1 + Object.keys(F).length) * C, shift = (axis) => (spec.origin ? ` + f32(bitcast<i32>(body[${tail + (axis === "x" ? 0 : 1)}u])) * 0.001` : "");
  const read = spec.read ? spec.read(at) : `
  let what = body[${at("what")} + i];
  o.kind = what & 255u;
  o.sp = what >> 8u;
  let sz = body[${at("size")} + i];
  o.size = ${spec.sizeMm ? "f32(sz) * 0.001" : "bitcast<f32>(sz)"};
  o.seed = body[${at("seed")} + i];
  o.pick = ${F.pick !== undefined ? `body[${at("pick")} + i]` : `${PICK_SLOT}u | i`};
  o.nst = ${F.nst !== undefined ? `body[${at("nst")} + i]` : spec.marks ? `(marks[${hideWords}u + (i >> 4u)] >> ((i & 15u) * 2u)) & 3u` : "0u"};`;
  return `${spec.decls ?? ""}
const CAP: u32 = ${C}u;
${spec.origin ? `// the source's corner in the window's cells (a whole number of them)
fn srcOc() -> vec2i { return vec2i(bitcast<i32>(body[${tail}u]) / ${CELL_M * 1000}, bitcast<i32>(body[${tail + 1}u]) / ${CELL_M * 1000}); }` : ""}
${spec.thin ? `// the murmur finaliser's mix of a seed (terrain-place.ts mixSeed): an object is of the share 2^-k when its top k bits are 0
fn mixSeed(seed: u32) -> u32 {
  var h = seed;
  h ^= h >> 16u; h *= 0x85ebca6bu; h ^= h >> 13u; h *= 0xc2b2ae35u; h ^= h >> 16u;
  return h;
}` : ""}
var<private> skipThin: bool = false;
fn readObj(i: u32) -> Obj {
  var o: Obj;
  o.ok = (body[i] & 1u) == 1u;
  ${spec.marks ? "if (((marks[i >> 5u] >> (i & 31u)) & 1u) == 1u) { o.ok = false; }" : ""}
  if (!o.ok) { return o; }
  o.x = f32(body[${at("x")} + i]) * 0.001 + (${f(ORIGIN)})${shift("x")};
  o.z = f32(body[${at("y")} + i]) * 0.001 + (${f(ORIGIN)})${shift("z")};${read}
  // the third tail word: a whole number up to 31 is k, only the objects whose hash has its top k bits 0 are drawn; any other nonzero word is the f32 bits of a share exponent e, and an object is drawn while its hash is under 2^(32 - e),
  // so the share grows an object at a time between whole numbers (a whole e draws what k = e does); 0 draws all of the body
  ${spec.thin ? `let thinW = body[${tail + 2}u];
  if (skipThin) {}
  else if (thinW > 0u && thinW < 32u) { if ((mixSeed(o.seed) >> (32u - thinW)) != 0u) { o.ok = false; } }
  else if (thinW != 0u && mixSeed(o.seed) >= u32(min(exp2(32.0 - bitcast<f32>(thinW)), 4294967040.0))) { o.ok = false; }` : ""}
  return o;
}
// the cell of the sim's spatial index a slot's place is in (src/gpu/wgsl/index.ts INDEX_KEYS)
fn cellOf(i: u32) -> u32 {
  let cx = min(body[${at("x")} + i] / ${CELL_M * 1000}u, ${cn - 1}u);
  let cy = min(body[${at("y")} + i] / ${CELL_M * 1000}u, ${cn - 1}u);
  return cy * ${cn}u + cx;
}
${spec.member ?? ""}`;
}

// A tree under a pixel is not dropped at once: from 1 art px down to TREE_FADE_MIN it is drawn as one speck when its
// seed's hash is under its share, so each tree keeps its fate as the zoom goes and none changes with another. The share
// is the tree's area in px (hpx squared), which holds the speck coverage of a wood as the trees shrink, times treeFade,
// which takes it down to none. canopy.js says the share the ground paints in their place.
const TREE_SHARE_WGSL = `
fn treeFade(hpx: f32) -> f32 { return smoothstep(${TREE_FADE_MIN}, 1.0, hpx); }
fn treeShare(hpx: f32) -> f32 { return min(hpx * hpx, 1.0) * treeFade(hpx); }
fn fateOf(seed: u32) -> f32 {
  var h = seed ^ 0x9E3779B9u;
  h = (h ^ (h >> 16u)) * 0x7FEB352Du;
  h = (h ^ (h >> 15u)) * 0x846CA68Bu;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) / 16777216.0;
}`;

// What every object pass shares: the Obj, the tables, and an object's look. g: ORIGIN; GN, WS the 12.5 m light grid
// (grid layer 1 its hollows' share of the sky); M, FSTART, FSTEP the fine ground (layer 4 its tree cover).
export function objectWGSL(g) {
  return `${TREE_SHARE_WGSL}
struct Obj { ok: bool, x: f32, z: f32, kind: u32, sp: u32, size: f32, seed: u32, pick: u32, nst: u32 }
struct Fam { f: u32, wb: u32, tree: bool }
const NONE: u32 = ${NONE}u;
const NB: u32 = ${NB}u;
// the island's west and north edge, metres
const ORIGIN_M: f32 = ${f(g.ORIGIN)};
// the sprite table, after the looks' tables in the same buffer
const TABLE0: u32 = ${META_WORDS}u;
fn kindOf(k: u32) -> u32 { return looks[${M_KIND}u + min(k, ${CODES - 1}u)]; }
// a layer of a grid of n texels a side, read between its texels at grid coordinates (u, v), held to [0, n - 1.001]; w the word of its shift in the looks' wrap words
// (the ground slid past its logical cell 0, ground.wgsl.js g_wr)
fn wrapI(v: vec2i, w: u32, n: i32) -> vec2i {
  let t = v + vec2i(i32(looks[${M_WRAP}u + w]), i32(looks[${M_WRAP}u + w + 1u]));
  return vec2i(select(t.x, t.x - n, t.x >= n), select(t.y, t.y - n, t.y >= n));
}
fn bilin(t: texture_2d_array<f32>, L: i32, n: i32, w: u32, u: f32, v: f32) -> f32 {
  let fu = clamp(u, 0.0, f32(n) - 1.001);
  let fv = clamp(v, 0.0, f32(n) - 1.001);
  let i = vec2i(i32(fu), i32(fv));
  let a = fu - f32(i.x);
  let b = fv - f32(i.y);
  let p = textureLoad(t, wrapI(i, w, n), L, 0).x;
  let q = textureLoad(t, wrapI(i + vec2i(1, 0), w, n), L, 0).x;
  let r = textureLoad(t, wrapI(i + vec2i(0, 1), w, n), L, 0).x;
  let s = textureLoad(t, wrapI(i + vec2i(1, 1), w, n), L, 0).x;
  return (p * (1.0 - a) + q * a) * (1.0 - b) + (r * (1.0 - a) + s * a) * b;
}
// the ground read through pages (pages.js), its table in the looks' words after the wrap's
fn pgOn() -> bool { return bitcast<i32>(looks[${M_PAGES}u]) != 0; }
fn pgTab(k: u32) -> i32 { return bitcast<i32>(looks[${M_PAGES}u + 1u + k]); }
${pageWGSL()}
// the share of the sky the ground's folds hide at a point (main.js worldAO), and the trees' cover there (flora.ts fine)
fn aoAt(x: f32, z: f32) -> f32 {
  let u = (x - (${f(g.ORIGIN)})) / ${f(g.WS)}; let v = (z - (${f(g.ORIGIN)})) / ${f(g.WS)};
  if (pgOn()) {
    let fu = clamp(u, 0.0, ${g.GN}.0 - 1.001); let fv = clamp(v, 0.0, ${g.GN}.0 - 1.001);
    let i = vec2i(i32(fu), i32(fv));
    return pgBil(pgGridQ(gridTex, 1, i), fu - f32(i.x), fv - f32(i.y));
  }
  return bilin(gridTex, 1, ${g.GN}, 4u, u, v);
}
fn treeAt(x: f32, z: f32) -> f32 {
  let u = (x - (${f(g.FSTART)})) / ${f(g.FSTEP)}; let v = (z - (${f(g.FSTART)})) / ${f(g.FSTEP)};
  if (pgOn()) {
    let fu = clamp(u, 0.0, ${g.M}.0 - 1.001); let fv = clamp(v, 0.0, ${g.M}.0 - 1.001);
    let i = vec2i(i32(fu), i32(fv));
    return pgBil(pgFineQ(fineTex, 4, i), fu - f32(i.x), fv - f32(i.y));
  }
  return bilin(fineTex, 4, ${g.M}, 0u, u, v);
}
// the size in meters an object is drawn at (px.js shown); grass by its width
fn hkOf(o: Obj, kf: u32) -> f32 {
  if ((kf & ${K_GRASS}u) != 0u || o.size >= 1.0) { return o.size; }
  return pow(max(o.size, 0.0), 0.55);
}
fn hpxOf(o: Obj, kf: u32, pv: f32, pw: f32) -> f32 { return hkOf(o, kf) * select(pv, pw, (kf & ${K_GRASS}u) != 0u); }
// the table's size index of a sprite hpx art px tall: a tree's whole pixels, anything else's half pixels under 8, then
// whole ones (main.js collectLive's hp and hq)
fn sizeIdx(hpx: f32, tree: bool) -> u32 {
  var si = 0u;
  if (tree) { si = u32(max(1.0, rnd(hpx))); } else if (hpx < 8.0) { si = u32(rnd(hpx * 2.0)); } else { si = 8u + u32(rnd(hpx)); }
  return min(si, ${NS - 1}u);
}
// an object's family as drawn unshrunk (a tree's shrunk family is the next one): atlas.js Looks.key undoes it
fn famOf(o: Obj, kf: u32) -> Fam {
  var F: Fam;
  F.f = NONE;
  F.tree = (kf & ${K_TREE}u) != 0u;
  let base = looks[${M_BASE}u + min(o.kind, ${CODES - 1}u) * ${CODES}u + min(o.sp, ${CODES - 1}u)];
  if (base == NONE) { return F; }
  let vr = o.seed % 8u;
  if (F.tree) {
    // sprites.js treeTint's steps by the seed's second byte: pine always the middle, aspen past 0.8 gold
    let b = (o.seed >> 8u) & 255u;
    let ts = looks[${M_TSP}u + min(o.sp, ${CODES - 1}u)];
    var ti = 1u;
    if (ts == 3u && b > 204u) { ti = 3u; } else if (ts != 0u) { ti = select(select(2u, 1u, b <= 170u), 0u, b <= 84u); }
    // the forest's darkness at its foot (main.js dimAt): the hollows' share of the sky, in quarter steps
    let q = clamp(0.05 - max(0.0, aoAt(o.x, o.z)) * 0.3, -0.75, 1.0);
    let di = u32(clamp(-floor(q * 4.0 + 0.5), 0.0, 3.0));
    F.wb = looks[${M_WB}u + ts * ${HSTEPS}u + min(${HSTEPS - 1}u, u32(max(o.size, 0.0) * 4.0))];
    F.f = base + (((vr * 4u + ti) * 4u + di) * NB + F.wb) * 2u;
    return F;
  }
  var moss = 0u;
  if ((kf & ${K_MOSSY}u) != 0u && treeAt(o.x, o.z) > 0.4) { moss = 1u; }
  F.f = base + (vr * 2u + moss) * 3u + min(o.nst, 2u);
  return F;
}
// the sprite (id + 1) of family f at size index si, the nearest size made should float rounding ask for one never made;
// 0 none, 0xFFFFFFFF made with nothing painted
fn spriteAt(f: u32, si: u32) -> u32 {
  if (TABLE0 + (f + 1u) * ${NS}u > arrayLength(&looks)) { return 0u; }
  let t0 = TABLE0 + f * ${NS}u;
  var sp = looks[t0 + si];
  for (var dd = 1u; sp == 0u && dd < 24u; dd++) {
    if (si >= dd) { sp = looks[t0 + si - dd]; }
    if (sp == 0u && si + dd < ${NS}u) { sp = looks[t0 + si + dd]; }
  }
  return sp;
}
// a tree whose crown's width has grown past every sprite made takes the nearest width made
fn spriteOf(F: Fam, f: u32, si: u32) -> u32 {
  var sp = spriteAt(f, si);
  if (!F.tree) { return sp; }
  for (var d = 1u; sp == 0u && d < 4u; d++) {
    if (F.wb >= d) { sp = spriteAt(f - 2u * d, si); }
    if (sp == 0u && F.wb + d < NB) { sp = spriteAt(f + 2u * d, si); }
  }
  return sp;
}`;
}

// ---------- cull ----------
// Every object of a source the view can show: its look as above, drawn at a pixel or more and able to reach into the
// view, stood on the tile map's ground with its sprite, listed for the indirect sprite draw with its shadow-casting
// rows (a one-pixel speck as a point for the splat). An indexed source walks only the rows of cells under the view
// (V.cx0..cx1, V.cy0..cy1), each row's run of the index split among the row's workgroups; any other walks its slots.
// A source of bins walks its bins the same way, a workgroup's threads sharing each bin's members; a source of cells
// takes a workgroup a cell of the view and walks the members its cache holds for the cell (CACHE_FILL_WGSL), a cell
// the view can't reach skipped whole. A flat source (nothing of it casts) lists no rows.
// The workgroup's threads take an object each a round and the round's sprites, specks and rows are given their places
// together (emitRound): each thread's place among the workgroup's in workgroup memory, then one atomic a list for the
// whole workgroup, rather than one a thread on the same three counters.
// front: "mark" or "keep", the two walks that build a far level's front list (FRONT_WGSL) in place of the cull's walk.
export function cullWGSL(spec, far = false, front = null) {
  const { N: CELLS_N, CELLS, FAR_LVL } = cellsOf(spec.n);
  const one = (k) => `{ let o = readObj(${k}); if (o.ok) { e = cullEval(o); } }`;
  const walk = far
    ? `
@compute @workgroup_size(64)
fn cullMain(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
${spec.origin ? `  // the dispatch covers the source's own part of the view's rectangle: from its first column and row
  let oc = srcOc();
  let gx = max(V.cx0, u32(max(oc.x, 0))) + wid.x;
  let gy = max(V.cy0, u32(max(oc.y, 0))) + wid.y;
  let cl = vec2i(i32(gx), i32(gy)) - oc;
  if (cl.x < 0 || cl.y < 0 || cl.x >= ${CELLS_N} || cl.y >= ${CELLS_N}) { return; }
  let c = u32(cl.y) * ${CELLS_N}u + u32(cl.x);` : `  let gx = V.cx0 + wid.x;
  let gy = V.cy0 + wid.y;
  let c = gy * ${CELLS_N}u + gx;`}
  if (lid.x == 0u) {
    let r = rowCells(gy);
    let cx = gx;
    wa = fidx[c]; wb = select(wa, wa + fidx[${FAR_LVL}u + V.farL * ${CELLS}u + c], cx >= r.x && cx <= r.y);
  }
  let a = workgroupUniformLoad(&wa);
  let b = workgroupUniformLoad(&wb);
  for (var r0 = a; r0 < b; r0 += 64u) {
    let r = r0 + lid.x;
    var e: Emit;
    if (r < b) { let k = flist[r]; if (k != NONE) ${one("k")} }
    emitRound(e, lid.x);
  }
}`
    : spec.members === "bins"
    ? `
@compute @workgroup_size(64)
fn cullMain(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let cy = V.cy0 + wid.y;
  if (lid.x == 0u) { let s = rowCells(cy); wa = start[cy * ${CELLS_N}u + s.x]; wb = select(wa, start[cy * ${CELLS_N}u + s.y + 1u], s.x <= s.y); }
  let a = workgroupUniformLoad(&wa);
  let b = workgroupUniformLoad(&wb);
  for (var r = a + wid.x; r < b; r += nw.x) {
    let i = order[r];
    let n = memberCount(i);
    if (lid.x == 0u) { wm = select(0u, n, (body[i] & 1u) == 1u); }
    let m = workgroupUniformLoad(&wm);
    for (var k0 = 0u; k0 < m; k0 += 64u) {
      let k = k0 + lid.x;
      var e: Emit;
      if (k < m) { let o = member(i, k); if (o.ok) { e = cullEval(o); } }
      emitRound(e, lid.x);
    }
  }
}`
    : spec.members === "cells"
    ? `
const CM: u32 = ${spec.cache.cm}u;
// whether any of a cell's objects, reaching at most reach px, can reach into the view (cullEval's first test, for the
// cell's corners)
fn cellSeen(cell: u32, reach: f32) -> bool {
  let x0 = f32(cell % ${CELLS_N}u) * ${f(CELL_M)} + ORIGIN_M;
  let z0 = f32(cell / ${CELLS_N}u) * ${f(CELL_M)} + ORIGIN_M;
  var lo = vec2f(1e30);
  var hi = vec2f(-1e30);
  for (var c = 0u; c < 4u; c++) {
    let d = rel(x0 + f32(c & 1u) * ${f(CELL_M)}, z0 + f32(c >> 1u) * ${f(CELL_M)});
    let s = vec2f((d.x - d.y) * V.H + V.offx, (d.x + d.y) * V.hb + V.offy);
    lo = min(lo, s);
    hi = max(hi, s);
  }
  return !(hi.x < -reach || lo.x > f32(V.aw) + reach || hi.y + V.levc * V.lp < -reach || lo.y - (V.peak - V.levc) * V.lp > f32(V.ah) + reach);
}
@compute @workgroup_size(64)
fn cullMain(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let cell = (V.cy0 + wid.y) * ${CELLS_N}u + V.cx0 + wid.x;
  let most = ${f(spec.most)};
  let hmost = select(most, pow(most, 0.55), most < 1.0) * max(V.pv, V.pw);
  if (!cellSeen(cell, hmost * 6.0 + 8.0)) { return; }
  if (lid.x == 0u) { wa = cslot[cell]; wb = select(min(ccntR[min(wa, arrayLength(&ccntR) - 1u)], CM), 0u, wa == NONE); }
  let s = workgroupUniformLoad(&wa);
  let n = workgroupUniformLoad(&wb);
  for (var j0 = 0u; j0 < n; j0 += 64u) {
    let j = j0 + lid.x;
    var e: Emit;
    if (j < n) {
      let at = (s * CM + j) * 3u;
      let w0 = cache[at];
      let w1 = cache[at + 1u];
      let x = (cell % ${CELLS_N}u) * ${CELL_M * 1000}u + (w0 & 0x1FFFFu);
      let y = (cell / ${CELLS_N}u) * ${CELL_M * 1000}u + (w1 & 0x1FFFFu);
      let o = rawObj(vec4u(x, y, w1 >> 17u, w0 >> 17u), cell, cache[at + 2u]);
      if (o.ok) { e = cullEval(o); }
    }
    emitRound(e, lid.x);
  }
}`
    : spec.indexed
    ? `
@compute @workgroup_size(256)
fn cullMain(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(num_workgroups) nw: vec3u) {
${spec.origin ? `  let oc = srcOc();
  let gy = max(V.cy0, u32(max(oc.y, 0))) + wid.y;
  let cyl = i32(gy) - oc.y;
  if (lid.x == 0u) {
    wa = 0u; wb = 0u;
    if (cyl >= 0 && cyl < ${CELLS_N}) {
      let s = rowCells(gy);
      let lo = max(i32(s.x) - oc.x, 0);
      let hi = min(i32(s.y) - oc.x, ${CELLS_N - 1});
      if (s.x <= s.y && lo <= hi) { wa = start[u32(cyl) * ${CELLS_N}u + u32(lo)]; wb = start[u32(cyl) * ${CELLS_N}u + u32(hi) + 1u]; }
    }
  }` : `  let cy = V.cy0 + wid.y;
  if (lid.x == 0u) { let s = rowCells(cy); wa = start[cy * ${CELLS_N}u + s.x]; wb = select(wa, start[cy * ${CELLS_N}u + s.y + 1u], s.x <= s.y); }`}
  let a = workgroupUniformLoad(&wa);
  let b = workgroupUniformLoad(&wb);
  for (var r0 = a + wid.x * 256u; r0 < b; r0 += nw.x * 256u) {
    let r = r0 + lid.x;
    var e: Emit;
    if (r < b) ${one(spec.ordered ? "order[r]" : "r")}
    emitRound(e, lid.x);
  }
}`
    : `
@compute @workgroup_size(256)
fn cullMain(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let k = gid.x + gid.y * nw.x * 256u;
  var e: Emit;
  if (k < CAP) ${one("k")}
  emitRound(e, lid.x);
}`;
  const rows = !spec.flat;
  return `
// The cells of row cy the view's tile window reaches, first and last (empty when the first is past the last): the
// window (u from i0 to i0 + ni and v from j0 to j0 + nj on the grid's bearing) crossed with the row's strip of z, as the
// hull of the x each of its bounds gives at the strip's two edges, within the cells under the window's corners. An
// object off the window has no ground under it and is never drawn (cullEval), so a walk skips the rest of the row.
fn rowCells(cy: u32) -> vec2u {
  let z0 = f32(cy) * ${f(CELL_M)} + ORIGIN_M;
  var lo = f32(V.cx0) * ${f(CELL_M)} + ORIGIN_M;
  var hi = f32(V.cx1 + 1u) * ${f(CELL_M)} + ORIGIN_M;
  for (var k = 0u; k < 2u; k++) {
    let e = select(vec2f(V.evbx, V.evby), vec2f(V.eubx, V.euby), k == 0u);
    let w0 = select(f32(V.j0), f32(V.i0), k == 0u);
    let w1 = w0 + f32(select(V.nj, V.ni, k == 0u));
    // a bound along x takes no x from the strip
    if (abs(e.x) < 1e-4) { continue; }
    var a = 1e30;
    var b = -1e30;
    for (var s = 0u; s < 4u; s++) {
      let z = z0 + f32(s & 1u) * ${f(CELL_M)};
      let w = select(w0, w1, s >= 2u);
      let x = V.obx + (w * V.tileM - (z - V.obz) * e.y) / e.x;
      a = min(a, x);
      b = max(b, x);
    }
    lo = max(lo, a - 0.01);
    hi = min(hi, b + 0.01);
  }
  if (lo > hi) { return vec2u(1u, 0u); }
  let c0 = u32(max(0.0, floor((lo - ORIGIN_M) / ${f(CELL_M)})));
  let c1 = u32(max(0.0, floor((hi - ORIGIN_M) / ${f(CELL_M)})));
  return vec2u(max(c0, V.cx0), min(c1, V.cx1));
}
// what an object makes: nothing (what 0), a sprite (1) with rows shadow-casting rows from the sprite's row0, or a speck (2)
struct Emit { what: u32, it: Inst, rows: u32, row0: u32 }
fn cullEval(o: Obj) -> Emit {
  var e: Emit;
  let kf = kindOf(o.kind);
  if ((kf & ${K_DRAWN}u) == 0u) { return e; }
  let tree = (kf & ${K_TREE}u) != 0u;
  let hpx = hpxOf(o, kf, V.pv, V.pw);
  if (hpx < 1.0 && (!tree || fateOf(o.seed) >= treeShare(hpx))) { return e; }
  let d = rel(o.x, o.z);
  // within reach whatever the ground's height: as tall and as wide as it is drawn, and its shadow
  let reach = hpx * 2.0 + 8.0 + select(0.0, hpx * 4.0, V.casting != 0u);
  let sx = (d.x - d.y) * V.H + V.offx;
  let base = (d.x + d.y) * V.hb + V.offy;
  if (sx < -reach || sx > f32(V.aw) + reach || base + V.levc * V.lp < -reach || base - (V.peak - V.levc) * V.lp > f32(V.ah) + reach) { return e; }
  let g = gridUV(o.x, o.z);
  let lev = groundLev(g.x, g.y);
  if (lev < -1e8) { return e; }
  let s = screen(d, lev);
  let ax = rnd(s.x);
  let ay = rnd(s.y);
  if (ax < -reach || ay < -reach || ax > f32(V.aw) + reach || ay - hpx * 2.0 > f32(V.ah) + reach) { return e; }
  let F = famOf(o, kf);
  if (F.f == NONE) { return e; }
  let sp = spriteOf(F, F.f + select(0u, V.shrunk, tree), sizeIdx(hpx, tree));
  if (sp == 0u || sp == 0xFFFFFFFFu) { return e; }
  let e0 = entries[(sp - 1u) * 2u];
  let foot = f32(i32((e0.w >> 8u) & 255u) - 128);
  e.it.sp = sp - 1u; e.it.x = i32(ax); e.it.y = i32(ay + foot); e.it.z = s.z + V.bias; e.it.flags = 1u | (((o.seed >> 3u) & 1u) << 4u); e.it.pick = o.pick; e.it.wx = o.x; e.it.wz = o.z;
  // a speck of one pixel, as far levels draw most trees, is one point, not a quad
  if (e0.y == 0x10001u) { e.what = 2u; return e; }
  e.what = 1u;${rows ? `
  let casts = (kf & ${K_FLAT}u) == 0u && hpx >= select(3.0, 8.0, tree);
  if (V.casting != 0u && casts) { let e1 = entries[(sp - 1u) * 2u + 1u]; e.rows = e1.y; e.row0 = e1.x; }` : ""}
  return e;
}
var<workgroup> wa: u32;
var<workgroup> wb: u32;
var<workgroup> wm: u32;
${front ? frontWalk(front, !!spec.origin, spec.n) : `var<workgroup> eN: array<atomic<u32>, 3>;
var<workgroup> eB: array<u32, 3>;
// A round's objects listed, every thread of the workgroup calling it together: sprites from args.ic, specks from
// args.pic, and the rows of the sprites that found room from args.ric, as many as the lists hold.
fn emitRound(e: Emit, l: u32) {
  if (l == 0u) { atomicStore(&eN[0], 0u); atomicStore(&eN[1], 0u); atomicStore(&eN[2], 0u); }
  workgroupBarrier();
  var at = 0u;
  if (e.what == 1u) { at = atomicAdd(&eN[0], 1u); } else if (e.what == 2u) { at = atomicAdd(&eN[1], 1u); }
  workgroupBarrier();
  if (l == 0u) {
    let ns = atomicLoad(&eN[0]);
    let np = atomicLoad(&eN[1]);
    if (ns > 0u) { eB[0] = atomicAdd(&args.ic, ns); }
    if (np > 0u) { eB[1] = atomicAdd(&args.pic, np); }
  }
  workgroupBarrier();
  var slot = 0u;
  if (e.what == 2u) { let ps = eB[1] + at; if (ps < V.maxinst) { inst[V.maxinst + ps] = e.it; } }
  if (e.what == 1u) { slot = eB[0] + at; if (slot < V.maxinst) { inst[slot] = e.it; } }${rows ? `
  let rn = select(0u, e.rows, e.what == 1u && slot < V.maxinst);
  var rat = 0u;
  if (rn > 0u) { rat = atomicAdd(&eN[2], rn); }
  workgroupBarrier();
  if (l == 0u) { let nr = atomicLoad(&eN[2]); if (nr > 0u) { eB[2] = atomicAdd(&args.ric, nr); } }
  workgroupBarrier();
  for (var r = 0u; r < rn; r++) { let ri = eB[2] + rat + r; if (ri < V.maxrows) { rowInst[ri] = vec2u(slot, e.row0 + r); } }` : ""}
}
${walk}`}`;
}

// ---------- the cells' caches ----------
// A source of cells (the clasts: a count a cell, each member made by its law from its identity) keeps the members it
// can ever draw, those of a size drawn at a pixel or more at some level (spec.cache.dmin mm and up), for the cells the
// views have shown lately, so a frame walks a few thousand a cell rather than making the hundreds of thousands a cell
// holds (webgpu.js cacheFrame picks the cells, fills them and lets the least lately shown go). Slot s of the cache
// holds a cell's members (ccnt[s] of them, at most CM): each three words, the place in mm within its cell (17 bits)
// with the low 15 bits of its seed above, the same with its diameter in mm above, and its number k in the cell. A
// member moved or taken since its cell was filled is left out as it is culled (rawObj reads the gone list).
// fillMain: workgroups (x) share a cell to fill (y: cfill's pairs of cell and slot after their count), the cell's count
// split into its 16 x 16 squares as the members' law does (src/gpu/wgsl/deadwood.ts clastBody: halved 8 times, x then
// y, each a binhalf on (seed, stream + 1, cell, node)), every member given its square by its place among them.
export function cacheFillWGSL(spec) {
  return `
var<workgroup> wn: u32;
var<workgroup> node: array<u32, 512>;
var<workgroup> pre: array<u32, 257>;
@compute @workgroup_size(64)
fn fillMain(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let cell = cfill[1u + 2u * wid.y];
  let slot = cfill[2u + 2u * wid.y];
  if (lid.x == 0u) { wn = counts[cell]; node[1] = wn; }
  let n = workgroupUniformLoad(&wn);
  if (n == 0u) { return; }
  for (var l = 0u; l < 8u; l++) {
    let first = 1u << l;
    for (var j = lid.x; j < first; j += 64u) {
      let nd = first + j;
      let m = node[nd];
      rinit(CL_SEED, CL_STREAM + 1u, cell, nd);
      let left = binhalf(m);
      node[2u * nd] = left;
      node[2u * nd + 1u] = m - left;
    }
    workgroupBarrier();
  }
  if (lid.x == 0u) { var s = 0u; for (var j = 0u; j < 256u; j++) { pre[j] = s; s += node[256u + j]; } pre[256] = s; }
  workgroupBarrier();
  for (var k = wid.x * 64u + lid.x; k < n; k += nw.x * 64u) {
    var lo = 0u;
    var hi = 255u;
    while (lo < hi) { let mid = (lo + hi + 1u) >> 1u; if (pre[mid] <= k) { lo = mid; } else { hi = mid - 1u; } }
    // the leaf's path from the root, its first halving the top bit: even halvings split x, odd ones y
    var ix = 0u;
    var iy = 0u;
    for (var l = 0u; l < 8u; l++) {
      let bit = (lo >> (7u - l)) & 1u;
      if ((l & 1u) == 0u) { ix = ix * 2u + bit; } else { iy = iy * 2u + bit; }
    }
    let v = rawMember(cell, k, ix, iy);
    if (v.z < ${spec.cache.dmin}u || rawGone(cell, k)) { continue; }
    let j = atomicAdd(&ccnt[slot], 1u);
    if (j >= ${spec.cache.cm}u) { continue; }
    let at = (slot * ${spec.cache.cm}u + j) * 3u;
    cache[at] = (v.x - (cell % ${CELLS_N}u) * ${CELL_M * 1000}u) | ((v.w & 0x7FFFu) << 17u);
    cache[at + 1u] = (v.y - (cell / ${CELLS_N}u) * ${CELL_M * 1000}u) | (v.z << 17u);
    cache[at + 2u] = k;
  }
}`;
}
export const CLAMP_WGSL = `
@compute @workgroup_size(1)
fn clampMain() {
  atomicStore(&args.ic, min(atomicLoad(&args.ic), V.maxinst));
  atomicStore(&args.ric, min(atomicLoad(&args.ric), V.maxrows));
  atomicStore(&args.pic, min(atomicLoad(&args.pic), V.maxinst));
  args.dx = (atomicLoad(&args.pic) + 63u) / 64u;
}`;

// ---------- the far levels' lists ----------
// The coarser levels (those that draw trees shrunk: atlas.js levels' shrunk) show a small share of the objects, as most
// are under a pixel there, so walking every object under the view would cost a far view most of its frame. Each indexed
// source keeps a list for them instead: every object drawn at a pixel or more at some far level, filed by its cell, a
// cell's objects in order of the coarsest far level that draws them, so far level L walks only the first
// fidx[FAR_LVL + L * CELLS + c] objects of cell c from fidx[c]. An object qualifies at a level if it is drawn there at
// FAR_MARGIN of its size, so stems that grow in the day between two lists (worker.js rebuilds them each sim day) are
// still in them; a stem that dies is skipped by its alive bit when culled, and a stem born since is far below a pixel
// at these levels. Built in three steps, the first and last a slice of slots at a time so no frame pays for a whole
// pass: farCount files each slot's cell and coarsest level (fkey) and counts them, farScan lays out the cells, and
// farFile puts every slot at its place.
export const FAR_LVL = CELLS_N * CELLS_N + 1, CELLS = CELLS_N * CELLS_N, FAR_MARGIN = 1.1;
// a source's cells a side (spec.n, 256 unless it says): its cell count and where the far index's levels start
export const cellsOf = (n = CELLS_N) => ({ N: n, CELLS: n * n, FAR_LVL: n * n + 1 });
export const FAR_COUNT_WGSL = `
@compute @workgroup_size(256)
fn farCount(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let i = Fp.base + gid.x + gid.y * nw.x * 256u;
  if (i >= min(CAP, Fp.base + Fp.n)) { return; }
  fkey[i] = NONE;
  let o = readObj(i);
  if (!o.ok) { return; }
  let kf = kindOf(o.kind);
  if ((kf & ${K_DRAWN}u) == 0u) { return; }
  var L = 0u;
  loop {
    if (L >= Fp.nf) { return; }
    let pv = bitcast<f32>(looks[${M_LEV}u + L * 4u]) * ${FAR_MARGIN};
    let pw = bitcast<f32>(looks[${M_LEV}u + L * 4u + 1u]) * ${FAR_MARGIN};
    if (hpxOf(o, kf, pv, pw) >= select(1.0, ${TREE_FADE_MIN}, (kf & ${K_TREE}u) != 0u)) { break; }
    L++;
  }
  let c = cellOf(i);
  fkey[i] = c * 8u + L;
  atomicAdd(&fcnt[c * 8u + L], 1u);
}`;
export const FAR_FILE_WGSL = `
@compute @workgroup_size(256)
fn farFile(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let i = Fp.base + gid.x + gid.y * nw.x * 256u;
  if (i >= Fp.base + Fp.n) { return; }
  let key = fkey[i];
  if (key == ${NONE}u) { return; }
  flist[atomicAdd(&fcnt[key], 1u)] = i;
}`;
// One workgroup: each cell's count over its levels, scanned into the cells' starts (fidx[c], the total at fidx[CELLS]),
// each far level's count per cell, and the counts turned into each (cell, level) run's first place for farFile.
export const farScanWGSL = (n = CELLS_N) => { const { CELLS, FAR_LVL } = cellsOf(n); return `
var<workgroup> part: array<u32, 256>;
@compute @workgroup_size(256)
fn farScan(@builtin(local_invocation_id) lid: vec3u) {
  let per = ${CELLS / 256}u;
  let c0 = lid.x * per;
  var sum = 0u;
  for (var c = c0; c < c0 + per; c++) { for (var L = 0u; L < Fp.nf; L++) { sum += fcntR[c * 8u + L]; } }
  part[lid.x] = sum;
  workgroupBarrier();
  if (lid.x == 0u) {
    var run = 0u;
    for (var t = 0u; t < 256u; t++) { let v = part[t]; part[t] = run; run += v; }
    fidx[${CELLS}u] = run;
  }
  workgroupBarrier();
  var at = part[lid.x];
  for (var c = c0; c < c0 + per; c++) {
    fidx[c] = at;
    var inCell = 0u;
    for (var L = 0u; L < 8u; L++) {
      let n = select(0u, fcntR[c * 8u + L], L < Fp.nf);
      fcntR[c * 8u + L] = at + inCell;
      inCell += n;
      if (L < Fp.nf) { fidx[${FAR_LVL}u + L * ${CELLS}u + c] = inCell; }
    }
    at += inCell;
  }
}`; };

// ---------- the far levels' front lists ----------
// At the coarsest far levels nearly every object is a speck of one pixel, many to a pixel, and only the nearest of a
// pixel's specks can show (webgpu.js splatA keeps it): a far level drawn at a whole bearing walks a front list instead
// of its far list, the far list's objects less every speck another speck of the same source stands in front of in the
// same pixel. Every level and whole bearing lays its art px on one lattice (webgpu.js fadePlan), so the pixel and depth
// a speck has in a view of the whole island are those it has in any view of that level and bearing. Built a slice of
// rows of cells at a time from such a view (live.js islandView): mark keeps in fkeys, for each pixel, the depth key of
// its nearest speck; after every slice has marked, keep lists each cell's objects but the specks behind another, in the
// cell's run from fout[c] (FRONT_SCAN_WGSL), their count at fout[FAR_LVL + L * CELLS + c] where a far list's index
// holds it, so the far cull walks a front list as it walks a far list. An object that is no speck now (not drawn,
// hidden, dead) is kept, so one that grows or shows again is drawn as before.
function frontWalk(mode, origin = false, n = CELLS_N) {
  const { N: CELLS_N, CELLS, FAR_LVL } = cellsOf(n);
  return `${mode === "keep" ? "var<workgroup> wk: atomic<u32>;" : ""}
// a speck's pixel in the view (its index and 1, 0 off the view) and its depth as a key that orders as the depth does,
// nearer larger (webgpu.js speck)
fn speckKey(e: Emit) -> vec2u {
  let e0 = entries[e.it.sp * 2u];
  let ax = i32(e0.z & 0xFFFFu) - 32768;
  let ay = i32(e0.z >> 16u) - 32768;
  let x = e.it.x - select(ax, -ax, ((e.it.flags >> 4u) & 1u) == 1u);
  let y = e.it.y - ay;
  if (x < 0 || y < 0 || x >= i32(V.aw) || y >= i32(V.ah)) { return vec2u(0u); }
  let b = bitcast<u32>(e.it.z + f32(ay));
  return vec2u(u32(y) * V.aw + u32(x) + 1u, select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u));
}
@compute @workgroup_size(64)
fn cullMain(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
${origin ? `  let oc = srcOc();
  let cl = vec2i(i32(V.cx0 + wid.x), i32(V.cy0 + wid.y)) - oc;
  if (cl.x < 0 || cl.y < 0 || cl.x >= ${CELLS_N} || cl.y >= ${CELLS_N}) { return; }
  let c = u32(cl.y) * ${CELLS_N}u + u32(cl.x);` : `  let c = (V.cy0 + wid.y) * ${CELLS_N}u + V.cx0 + wid.x;`}
  if (lid.x == 0u) { wa = fidx[c]; wb = wa + fidx[${FAR_LVL}u + V.farL * ${CELLS}u + c];${mode === "keep" ? " atomicStore(&wk, 0u);" : ""} }
  let a = workgroupUniformLoad(&wa);
  let b = workgroupUniformLoad(&wb);
  for (var r = a + lid.x; r < b; r += 64u) {
    let k = flist[r];
    if (k == NONE) { continue; }
    var e: Emit;
    let o = readObj(k);
    if (o.ok) { e = cullEval(o); }
    var q = vec2u(0u);
    if (e.what == 2u) { q = speckKey(e); }
${mode === "mark" ? "    if (q.x != 0u) { atomicMax(&fkeys[q.x - 1u], q.y); }" : "    if (q.x == 0u || fkeysR[q.x - 1u] == q.y) { flistOut[fout[c] + atomicAdd(&wk, 1u)] = k; }"}
  }${mode === "keep" ? `
  workgroupBarrier();
  if (lid.x == 0u) { fout[${FAR_LVL}u + V.farL * ${CELLS}u + c] = atomicLoad(&wk); }` : ""}
}`;
}
// One workgroup: the far list's count of each cell at level Fp.lvl (fidx[FAR_LVL + lvl * CELLS + c]) scanned into the
// cells' runs of a front list (fout[c], the total at fout[CELLS]).
export const frontScanWGSL = (n = CELLS_N) => { const { CELLS, FAR_LVL } = cellsOf(n); return `
var<workgroup> part: array<u32, 256>;
@compute @workgroup_size(256)
fn frontScan(@builtin(local_invocation_id) lid: vec3u) {
  let per = ${CELLS / 256}u;
  let c0 = lid.x * per;
  var sum = 0u;
  for (var c = c0; c < c0 + per; c++) { sum += fidx[${FAR_LVL}u + Fp.lvl * ${CELLS}u + c]; }
  part[lid.x] = sum;
  workgroupBarrier();
  if (lid.x == 0u) {
    var run = 0u;
    for (var t = 0u; t < 256u; t++) { let v = part[t]; part[t] = run; run += v; }
    fout[${CELLS}u] = run;
  }
  workgroupBarrier();
  var at = part[lid.x];
  for (var c = c0; c < c0 + per; c++) { fout[c] = at; at += fidx[${FAR_LVL}u + Fp.lvl * ${CELLS}u + c]; }
}`; };

// ---------- the sprites wanted ----------
// Kp.mode 0: every kind and species pair the source holds, a bit each (CODES x CODES), so the worker can number their
// families; mode 1: every family and size index any of the Kp.nl levels draws its objects at, a bit each (family x NS),
// so the worker makes exactly those sprites.
export const NEEDS_WGSL = `
@compute @workgroup_size(256)
fn needsMain(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  skipThin = true;
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= CAP) { return; }
  let o = readObj(i);
  if (!o.ok) { return; }
  let kf = kindOf(o.kind);
  if ((kf & ${K_DRAWN}u) == 0u) { return; }
  if (Kp.mode == 0u) {
    let p = min(o.kind, ${CODES - 1}u) * ${CODES}u + min(o.sp, ${CODES - 1}u);
    atomicOr(&need[p >> 5u], 1u << (p & 31u));
    return;
  }
  let F = famOf(o, kf);
  if (F.f == NONE) { return; }
  for (var L = Kp.l0; L < Kp.nl; L++) {
    let hpx = hpxOf(o, kf, bitcast<f32>(looks[${M_LEV}u + L * 4u]), bitcast<f32>(looks[${M_LEV}u + L * 4u + 1u]));
    if (hpx < select(1.0, ${TREE_FADE_MIN}, F.tree)) { continue; }
    let bit = (F.f + select(0u, looks[${M_LEV}u + L * 4u + 2u], F.tree)) * ${NS}u + sizeIdx(hpx, F.tree);
    if ((bit >> 5u) < arrayLength(&need)) { atomicOr(&need[bit >> 5u], 1u << (bit & 31u)); }
  }
}`;

// ---------- the trees' cover ----------
// The trees' cover of the ground as the light's ambient occlusion reads it (webgpu.js can0, can3, grid layer 5): every
// tree lays the disc its crown covers (Unit 7's crown, light.ts crownRadius), full within CORE of its radius and
// easing out to none at EDGE, in cells of Kp.canStep metres, a crown's full weight UNIT, two cells to a word as 16-bit
// counts; and each tree's height and a count go to the nearest cell of the 12.5 m light grid, for the trees' mean height.
const CORE = 0.55, EDGE = 1.2, UNIT = 64;
const CAN_COMMON = `
fn profile(i: u32) -> u32 {
  let r = sqrt(f32(i) / 255.0) * ${f(EDGE)};
  let t = clamp((r - ${f(CORE)}) / ${f(EDGE - CORE)}, 0.0, 1.0);
  return u32(rnd(${f(UNIT)} * select(1.0 - t * t * (3.0 - 2.0 * t), 1.0, r <= ${f(CORE)})));
}`;
export const CANOPY_WGSL = (ORIGIN) => `${CAN_COMMON}
// a crown's radius, m, by tree species and height, between the table's quarter metres
fn crownR(ts: u32, h: f32) -> f32 {
  let q = clamp(h * 4.0, 0.0, ${f(HSTEPS - 1.001)});
  let i = u32(q);
  let a = bitcast<f32>(looks[${M_CROWN}u + ts * ${HSTEPS}u + i]);
  let b = bitcast<f32>(looks[${M_CROWN}u + ts * ${HSTEPS}u + min(i + 1u, ${HSTEPS - 1}u)]);
  return a + (b - a) * (q - f32(i));
}
@compute @workgroup_size(256)
fn canopyMain(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let k = gid.x + gid.y * nw.x * 256u;
  if (k >= CAP) { return; }
  let o = readObj(k);
  if (!o.ok || (kindOf(o.kind) & ${K_TREE}u) == 0u) { return; }
  let N = i32(Kp.canN);
  let cx = (o.x - (${f(ORIGIN)})) / Kp.canStep;
  let cz = (o.z - (${f(ORIGIN)})) / Kp.canStep;
  let r = crownR(looks[${M_TSP}u + min(o.sp, ${CODES - 1}u)], o.size) * ${f(EDGE)} / Kp.canStep;
  let r2 = r * r;
  let i0 = max(0, i32(ceil(cx - r)));
  let i1 = min(N - 1, i32(floor(cx + r)));
  let j0 = max(0, i32(ceil(cz - r)));
  let j1 = min(N - 1, i32(floor(cz + r)));
  if (r2 > 0.0) {
    let kk = 255.0 / r2;
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        let d2 = (f32(i) - cx) * (f32(i) - cx) + (f32(j) - cz) * (f32(j) - cz);
        if (d2 < r2) {
          let idx = u32(j * N + i);
          atomicAdd(&canAcc[idx >> 1u], profile(min(255u, u32(d2 * kk))) << ((idx & 1u) * 16u));
        }
      }
    }
  }
  let G = i32(Kp.gn);
  // a tree off the window (a block reaches past it) has no cell of the grid to count in
  let gi = i32(floor((o.x - (${f(ORIGIN)})) / Kp.gs + 0.5));
  let gj = i32(floor((o.z - (${f(ORIGIN)})) / Kp.gs + 0.5));
  if (gi < 0 || gj < 0 || gi >= G || gj >= G) { return; }
  let gc = u32(gj * G + gi);
  atomicAdd(&canTall[gc * 2u], 1u);
  atomicAdd(&canTall[gc * 2u + 1u], u32(max(o.size, 0.0) * 100.0 + 0.5));
}`;
// The cover as the GPU reads it: a byte a cell, twice the count, at most 255 (two crowns deep), in rows of Kp.rp bytes
// for the copy into the r8uint texture; its 8 x 8 means (can3) and the trees' mean height over the 7 x 7 light-grid
// cells round each (a cell holds a tree or two or none), where they hold half a tree or more.
const BYTE_AT = "fn byteAt(idx: u32) -> u32 { return min(255u, ((canAccR[idx >> 1u] >> ((idx & 1u) * 16u)) & 0xFFFFu) << 1u); }";
export const CANOPY_BYTES_WGSL = `${BYTE_AT}
@compute @workgroup_size(64)
fn canBytesMain(@builtin(global_invocation_id) gid: vec3u) {
  let wpr = Kp.rp / 4u;
  if (gid.x >= wpr || gid.y >= Kp.canN) { return; }
  var w = 0u;
  for (var b = 0u; b < 4u; b++) { let i = gid.x * 4u + b; if (i < Kp.canN) { w |= byteAt(gid.y * Kp.canN + i) << (b * 8u); } }
  canBytes[gid.y * wpr + gid.x] = w;
}`;
export const CANOPY_WIDE_WGSL = `${BYTE_AT}
@compute @workgroup_size(8, 8)
fn canWideMain(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= Kp.n3 || gid.y >= Kp.n3) { return; }
  var s = 0u;
  for (var y = 0u; y < 8u; y++) { for (var x = 0u; x < 8u; x++) { s += byteAt((gid.y * 8u + y) * Kp.canN + gid.x * 8u + x); } }
  canWide[gid.y * Kp.rp3 + gid.x] = f32(s) / ${f(64 * 255)};
}`;
export const CANOPY_TALL_WGSL = `
@compute @workgroup_size(8, 8)
fn canTallMain(@builtin(global_invocation_id) gid: vec3u) {
  let G = i32(Kp.gn);
  if (i32(gid.x) >= G || i32(gid.y) >= G) { return; }
  var w = 0u;
  var h = 0u;
  for (var b = max(0, i32(gid.y) - 3); b <= min(G - 1, i32(gid.y) + 3); b++) {
    for (var a = max(0, i32(gid.x) - 3); a <= min(G - 1, i32(gid.x) + 3); a++) { let c = u32(b * G + a); w += canTallR[c * 2u]; h += canTallR[c * 2u + 1u]; }
  }
  canTallOut[gid.y * Kp.rpt + gid.x] = select(0.0, f32(h) / 100.0 / f32(w), w >= 1u);
}`;
