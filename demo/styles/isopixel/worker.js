// The render worker: owns the WebGPU device and the page's canvas (an OffscreenCanvas), grows the island's fields once,
// keeps every object of the sim on the GPU with the atlas of their sprites, and draws each frame the page asks for
// (webgpu.js). The page (live.js) keeps the camera, the sky and the live sim, and sends what moves: the view, the light,
// the people, animals, fires and overlays, and the sim's changes.
import { generateIsland, fineGround, rng, SIZE, TILE_M, TILES } from "../island.js";
import { P, NCOL, HAZE, GLOW, TONE, TONE_S } from "./pal.js";
import { ObjBins } from "./px.js";
import * as SP from "./sprites.js";
import { Canopy, STEP as CAN_STEP, N as CAN_N } from "./canopy.js";
import { packGround } from "./ground.wgsl.js";
import { createRenderer, NS, ATLAS } from "./webgpu.js";
import { Families, LIVE, markNeeds, makeSprite, flat, castRows, Shelves, entryWords } from "./atlas.js";

const early = [];
onmessage = (e) => early.push(e);
const ORIGIN = -SIZE / 2, WS = 12.5, toM = (t) => t * TILE_M + ORIGIN;
// entries, rows and families kept for sprites made while the page runs (live sprites and objects the sim changed), and
// the atlas layers they go in
const DYN_ENTRIES = 32768, DYN_ROWS = 1 << 20, DYN_FAMILIES = 4096, DYN_LAYERS = 2;
let R = null, device = null, canvas = null, context = null, fields = null, TH = {};
let fam = null, objs = null, idx = new Map(), level = null;
let table = null, nStatic = 0, rowsStatic = 0, dyn = null, liveIds = new Map(), extrasMade = new Map();
// the page's live sprites as they came, by its ids: placed in the dynamic layers when a frame first draws them, and again
// after the layers are cleared
const liveSrc = new Map();
const post = (m, t) => postMessage(m, t ?? []);
const say = (what, d, n) => post({ type: "progress", what, d, n });

async function init(m) {
  const t0 = performance.now();
  if (!navigator.gpu) throw new Error("this browser gives no WebGPU");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("this browser found no WebGPU adapter");
  const timing = adapter.features.has("timestamp-query");
  device = await adapter.requestDevice({ requiredFeatures: timing ? ["timestamp-query"] : [], requiredLimits: { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize, maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers } });
  device.lost.then((info) => post({ type: "lost", why: info.message || info.reason }));
  device.addEventListener?.("uncapturederror", (e) => post({ type: "gpuerror", why: e.error.message }));
  canvas = m.canvas;
  context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  say("growing the island", 0, 1);
  const isle = generateIsland(rng(m.seed)), g = fineGround(isle);
  const t1 = performance.now();
  say("laying out the ground", 0, 1);
  const pack = packGround(isle, g);
  fields = { isle, g, pack, GN: pack.grid.size };
  const t2 = performance.now();
  say("building the shaders", 0, 1);
  R = await createRenderer({
    device, context, format, timing, ground: pack,
    pal: { P, NCOL, HAZE, GLOW, TONE, TONE_S, WATER: ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"].map((k) => P[k]), TILE_M, ORIGIN, TILES, TRAIL_N: Math.round(SIZE / 3), GRID_STEP: WS },
  });
  TH = await import("./things.js").catch((e) => (console.warn(`things.js not loaded: ${e.message}`), {}));
  let peak = 0;
  for (const h of isle.height) peak = Math.max(peak, h);
  // the page keeps the camera on the island's heights and the drawn ground under it: the fine heights and the cells'
  // water, from which live.js (ground.js) works out every level's tile map as the GPU does
  post({ type: "fields", info: adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null, peak, h: g.h, height: isle.height, water: isle.water, ms: { grow: t1 - t0, pack: t2 - t1 } });
  await new Promise((r) => setTimeout(r, 0));
  if (R.errors.length) throw new Error(R.errors.join("\n"));
  post({ type: "ready", ms: performance.now() - t0 });
}

// ---------- fields read on the CPU: a tree's darkness and a stone's moss ----------
const aoAt = (x, z) => {
  const GN = fields.GN, a = fields.pack.grid.data, o = GN * GN;
  const fx = Math.min(Math.max((x - ORIGIN) / WS, 0), GN - 1.001), fz = Math.min(Math.max((z - ORIGIN) / WS, 0), GN - 1.001), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = o + j * GN + i;
  return (a[k] * (1 - u) + a[k + 1] * u) * (1 - v) + (a[k + GN] * (1 - u) + a[k + GN + 1] * u) * v;
};
const treeAt = (x, z) => fields.g.fine(fields.g.cover.tree, x, z);

// ---------- objects ----------
// The sim's objects (live.js sync: sim.objects()), each a GPU object in the order of the grown arrays, then the things
// the sim made, as they come. levels: the zoom ladder's { pv, pw, shrunk }.
async function setObjects(m) {
  const t0 = performance.now(), o = m.objs, gr = o.grown, n = gr.n, spare = 1 << 16;
  level = m.levels;
  fam = new Families(SP.treeTint);
  objs = { words: new Uint32Array((n + spare) * 4), ids: new Uint32Array(n + spare), n, grownN: n, next: n, cap: n + spare, kinds: [...o.kindNames], species: [...o.speciesNames] };
  const W = objs.words, F = new Float32Array(W.buffer);
  for (let k = 0; k < n; k++) {
    objs.ids[k] = k + 1;
    const K = objs.kinds[gr.kind[k]], x = toM(gr.px[k]), z = toM(gr.py[k]), w = fam.word(K, objs.species[gr.species[k]], x, z, gr.size[k], gr.seed[k], undefined, { aoAt, treeAt });
    F[k * 4] = gr.px[k]; F[k * 4 + 1] = gr.py[k];
    if (!w) continue;
    F[k * 4 + 2] = w.hk; W[k * 4 + 3] = w.meta;
  }
  for (const id of o.gone) if (id >= 1 && id <= n) W[(id - 1) * 4 + 3] &= ~(1 << 24);
  idx = new Map();
  for (const t of o.things) upsert(t, false);
  const t1 = performance.now();
  // every family and size any level draws, made by a few workers at once
  const need = new Uint8Array((fam.keys.length + DYN_FAMILIES) * NS);
  markNeeds(W, 0, objs.next ?? n, level, (slot) => { need[slot] = 1; });
  const jobs = [];
  for (let f = 0; f < fam.keys.length; f++) for (let s = 0; s < NS; s++) if (need[f * NS + s]) jobs.push([fam.keys[f], s, f * NS + s]);
  const made = await makeAll(jobs);
  const t2 = performance.now();
  packAtlas(made);
  R.setObjects(W, objs.ids, objs.next);
  const t3 = performance.now();
  // the trees' cover for the ambient occlusion
  const bins = new ObjBins(o), c = await Canopy.build(bins, toM, { n: fields.GN, step: WS }, 1e9);
  R.setCanopy(CAN_N, CAN_STEP, c.bytes(), c.tall);
  canopyOf = { c, bins };
  post({ type: "objects", n, sprites: made.length, families: fam.keys.length, ms: { words: t1 - t0, sprites: t2 - t1, pack: t3 - t2, canopy: performance.now() - t3 } });
}
let canopyOf = null;
// sprites for every [family key, size index, slot] in jobs, by as many sprite workers as the machine spares
async function makeAll(jobs) {
  const nw = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)), out = [];
  const workers = await Promise.all(Array.from({ length: nw }, () => new Promise((ok, fail) => {
    const w = new Worker(new URL("./sprites-worker.js", import.meta.url), { type: "module" });
    w.onerror = (e) => fail(new Error(`sprite worker: ${e.message}`));
    w.onmessage = (e) => { if (e.data.ready) ok(w); };
  })));
  // the big ones first, dealt round, so every worker has about the same to draw
  jobs.sort((a, b) => b[1] - a[1]);
  const lists = workers.map(() => []);
  jobs.forEach((j, i) => lists[i % nw].push(j));
  let done = 0;
  await Promise.all(workers.map((w, i) => new Promise((ok) => {
    const list = lists[i], CH = 200;
    let at = 0;
    const next = () => {
      if (at >= list.length) { w.terminate(); ok(); return; }
      w.postMessage({ id: at, jobs: list.slice(at, at + CH) });
      at += CH;
    };
    w.onmessage = (e) => { for (const r of e.data.out) out.push(r); done += e.data.out.length; say("drawing the sprites", done, jobs.length); next(); };
    next();
  })));
  return out;
}
// The made sprites into atlas layers, the tallest first along shelves, and the tables that find them.
function packAtlas(made) {
  const families = fam.keys.length + DYN_FAMILIES;
  table = new Uint32Array(families * NS);
  const list = made.filter(([, s]) => s).sort((a, b) => b[1].h - a[1].h || b[1].w - a[1].w);
  for (const [slot, s] of made) if (!s) table[slot] = 0xffffffff;
  const sh = new Shelves(), at = list.map(([, s]) => sh.place(s.w, s.h));
  const layers = sh.layers, rows = [], entries = new Uint32Array((list.length + DYN_ENTRIES) * 8);
  list.forEach(([slot, s], i) => {
    const r = castRows(s);
    entries.set(entryWords(s, at[i], rows.length, r.length), i * 8);
    for (const v of r) rows.push(v);
    table[slot] = i + 1;
  });
  nStatic = list.length; rowsStatic = rows.length;
  const rowsAll = new Uint32Array(rows.length + DYN_ROWS);
  rowsAll.set(rows);
  R.setAtlas({ layers: layers + DYN_LAYERS, entries, rows: rowsAll, table });
  for (let l = 0; l < layers; l++) {
    const px = new Uint8Array(ATLAS * ATLAS).fill(255);
    list.forEach(([, s], i) => {
      if (at[i].l !== l) return;
      for (let y = 0; y < s.h; y++) px.set(s.p.subarray(y * s.w, y * s.w + s.w), (at[i].y + y) * ATLAS + at[i].x);
    });
    R.atlasPut(l, 0, 0, ATLAS, ATLAS, px);
  }
  dyn = { shelves: new Shelves(layers, DYN_LAYERS), next: nStatic, rows: rowsStatic, layers };
  liveIds = new Map(); extrasMade = new Map();
}
// A sprite made while the page runs, into the dynamic layers; null when they are full (dynReset clears them).
function putDynamic(s) {
  if (dyn.next >= nStatic + DYN_ENTRIES) return null;
  const at = dyn.shelves.place(s.w, s.h);
  if (!at) return null;
  const r = castRows(s), id = dyn.next++;
  if (dyn.rows + r.length > rowsStatic + DYN_ROWS) return null;
  R.atlasPut(at.l, at.x, at.y, s.w, s.h, s.p);
  R.entriesPut(id, Uint32Array.from(entryWords(s, at, dyn.rows, r.length)));
  if (r.length) R.rowsPut(dyn.rows, Uint32Array.from(r));
  dyn.rows += r.length;
  return id;
}
function dynReset() {
  dyn.shelves.reset(); dyn.next = nStatic; dyn.rows = rowsStatic;
  liveIds = new Map();
  for (const slot of extrasMade.keys()) { R.tablePut(slot, 0); table[slot] = 0; }
  extrasMade = new Map();
  // the page sends a sprite once; past this many kept the page is asked for them again as it next draws them
  if (liveSrc.size > 6000) { liveSrc.clear(); post({ type: "spritesReset" }); }
}
// the atlas id of the page's sprite `id`, placed now if it has not been since the layers were last cleared
function liveId(id) {
  let sp = liveIds.get(id);
  if (sp !== undefined || !dyn) return sp;
  const s = liveSrc.get(id);
  if (!s) return undefined;
  sp = putDynamic(s);
  if (sp === null) { dynReset(); sp = putDynamic(s); }
  if (sp === null) return undefined;
  liveIds.set(id, sp);
  return sp;
}
// One of the sim's things (an ObjBins record: numeric id, kind and species codes, px, py, size, seed, n) put on the GPU,
// a grown one in its own place, anything else in the next free one, with any sprite it needs that was never made.
function upsert(r, live = true) {
  const K = objs.kinds[r.kind], W = objs.words, F = new Float32Array(W.buffer);
  let k = r.id >= 1 && r.id <= objs.grownN ? r.id - 1 : idx.get(r.id);
  if (k === undefined) {
    k = objs.next;
    if (k >= objs.cap) return;
    objs.next++; idx.set(r.id, k);
  }
  const w = K && !LIVE.has(K) ? fam.word(K, objs.species[r.sp] ?? "", toM(r.px), toM(r.py), r.size ?? 1, r.seed >>> 0, r.n, { aoAt, treeAt }) : null;
  objs.ids[k] = r.id; F[k * 4] = r.px; F[k * 4 + 1] = r.py; F[k * 4 + 2] = w ? w.hk : 0; W[k * 4 + 3] = w ? w.meta : 0;
  if (!live) return;
  if (w) ensureSprites(k);
  R.updateObjects(k, W.subarray(k * 4, k * 4 + 4), objs.ids.subarray(k, k + 1));
}
function drop(id) {
  const k = id >= 1 && id <= objs.grownN ? id - 1 : idx.get(id);
  if (k === undefined) return;
  objs.words[k * 4 + 3] &= ~(1 << 24);
  R.updateObjects(k, objs.words.subarray(k * 4, k * 4 + 4), objs.ids.subarray(k, k + 1));
}
// the sprites changed object k wants at any level, made here at once
function ensureSprites(k) {
  const need = new Set();
  markNeeds(objs.words, k, k + 1, level, (slot) => need.add(slot));
  for (const slot of need) {
    if (slot >= table.length) continue;
    if (table[slot]) continue;
    const f = Math.floor(slot / NS), s = flat(makeSprite(fam.keys[f], slot % NS, SP, TH));
    const id = s ? putDynamic(s) : null;
    table[slot] = s ? (id === null ? 0 : id + 1) : 0xffffffff;
    if (id !== null || !s) { R.tablePut(slot, table[slot]); if (s) extrasMade.set(slot, id); }
  }
}

// ---------- worn paths ----------
// The sim's 3 m wear cells, each its drawn width step (0 to 4), and in bit 7 of the texel the GPU reads whether any worn
// cell lies within three of it (main.js trailNear), so the ground's painter looks the paths up only near one.
const TN = Math.round(SIZE / 3), NEAR = 3;
let wear = null;
function nearOf(x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, out = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      let near = 0;
      for (let b = Math.max(0, y - NEAR); b <= Math.min(TN - 1, y + NEAR) && !near; b++)
        for (let a = Math.max(0, x - NEAR); a <= Math.min(TN - 1, x + NEAR); a++) if (wear[b * TN + a]) { near = 128; break; }
      out[(y - y0) * w + x - x0] = wear[y * TN + x] | near;
    }
  return out;
}
function trailsAll(all) {
  wear = all;
  // the near flags by two passes of a running count, across and then down
  const across = new Uint8Array(TN * TN), out = new Uint8Array(TN * TN);
  for (let y = 0; y < TN; y++) {
    let n = 0;
    for (let x = 0; x < Math.min(TN, NEAR); x++) n += wear[y * TN + x] ? 1 : 0;
    for (let x = 0; x < TN; x++) {
      if (x + NEAR < TN && wear[y * TN + x + NEAR]) n++;
      if (x - NEAR - 1 >= 0 && wear[y * TN + x - NEAR - 1]) n--;
      across[y * TN + x] = n > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < TN; x++) {
    let n = 0;
    for (let y = 0; y < Math.min(TN, NEAR); y++) n += across[y * TN + x];
    for (let y = 0; y < TN; y++) {
      if (y + NEAR < TN) n += across[(y + NEAR) * TN + x];
      if (y - NEAR - 1 >= 0) n -= across[(y - NEAR - 1) * TN + x];
      out[y * TN + x] = wear[y * TN + x] | (n > 0 ? 128 : 0);
    }
  }
  R.setTrails(out);
}
// cells changed: [index, step]; the flags round each go up as one block
function trailCells(cells) {
  if (!wear) wear = new Uint8Array(TN * TN);
  for (const [i, q] of cells) wear[i] = q;
  for (const [i] of cells) {
    const x = i % TN, y = Math.floor(i / TN), x0 = Math.max(0, x - NEAR), y0 = Math.max(0, y - NEAR), x1 = Math.min(TN, x + NEAR + 1), y1 = Math.min(TN, y + NEAR + 1);
    R.setTrailRect(x0, y0, x1 - x0, y1 - y0, nearOf(x0, y0, x1, y1));
  }
}

// ---------- frames ----------
// The page's frame: views with their uniforms and live sprites by the page's sprite ids, which go into the dynamic
// layers the first time they come.
let pending = null, rendering = false, frames = 0;
const tmp = new ArrayBuffer(32 * 16384);
function liveInstances(list) {
  const n = list.length / 8, U = new Uint32Array(tmp, 0, n * 8), I = new Int32Array(tmp, 0, n * 8), F = new Float32Array(tmp, 0, n * 8);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const sp = liveId(list[i * 8]);
    if (sp === undefined) continue;
    U[m * 8] = sp; I[m * 8 + 1] = list[i * 8 + 1]; I[m * 8 + 2] = list[i * 8 + 2]; F[m * 8 + 3] = list[i * 8 + 3];
    U[m * 8 + 4] = list[i * 8 + 4]; U[m * 8 + 5] = list[i * 8 + 5]; F[m * 8 + 6] = list[i * 8 + 6]; F[m * 8 + 7] = list[i * 8 + 7];
    m++;
  }
  return new Uint8Array(tmp, 0, m * 32).slice();
}
function render() {
  const f = pending;
  if (!f || rendering) return;
  if (R.busy >= 2) { setTimeout(render, 1); return; }
  pending = null;
  rendering = true;
  const t0 = performance.now();
  for (const s of f.sprites ?? []) liveSrc.set(s.id, s);
  const views = f.views.map((v) => {
    const prims = v.prims ? Int32Array.from(v.prims) : null;
    // a sprite primitive names the page's sprite
    if (prims) for (let i = 0; i < prims.length; i += 8) if (prims[i] === 0) { const sp = liveId(prims[i + 3]); prims[i + 3] = sp ?? 0; if (sp === undefined) { prims[i] = 2; prims[i + 4] = 255; } }
    return { ...v, live: v.live?.length ? liveInstances(v.live) : null, prims };
  });
  R.frame({ ...f, views });
  frames++;
  const ms = performance.now() - t0;
  rendering = false;
  device.queue.onSubmittedWorkDone().then(() => {
    post({ type: "frameDone", id: f.id, cpuMs: ms, gpuMs: R.stats.gpuMs, passes: R.stats.passes, counts: R.stats.counts, at: performance.now() - t0 });
    if (pending) render();
  });
}

const handle = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") await init(m);
    else if (m.type === "objects") await setObjects(m);
    else if (m.type === "frame") { pending = m; render(); }
    else if (m.type === "changes") {
      if (!objs) return;
      if (m.kinds) objs.kinds = m.kinds;
      if (m.species) objs.species = m.species;
      for (const id of m.rm ?? []) { drop(id); }
      for (const r of m.up ?? []) upsert(r);
      if (canopyOf && (m.up?.length || m.rm?.length)) {
        for (const id of m.rm ?? []) { const old = canopyOf.bins.get(id); if (old) { canopyOf.bins.drop(id); canopyOf.c.change(old, null, objs.kinds, objs.species); } }
        for (const r of m.up ?? []) { const old = canopyOf.bins.get(r.id); canopyOf.bins.kinds = objs.kinds; canopyOf.bins.species = objs.species; canopyOf.bins.upsert(r); canopyOf.c.change(old, r, objs.kinds, objs.species); }
        const u = canopyOf.c.flush();
        if (u) R.updateCanopy(u.x, u.y, u.w, u.h, u.bytes);
      }
    } else if (m.type === "trails") { if (m.all) trailsAll(m.all); if (m.cells) trailCells(m.cells); }
    else if (m.type === "ice") R.setIce(m.flags);
    else if (m.type === "pick") { const r = await R.pick(m.x, m.y); post({ type: "pick", id: m.id, r }); }
    else if (m.type === "resize") { canvas.width = m.W; canvas.height = m.H; }
  } catch (err) {
    post({ type: "error", error: String((err && err.stack) || err) });
  }
};
onmessage = handle;
for (const e of early.splice(0)) await handle(e);
