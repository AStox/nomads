// The render worker: owns the WebGPU device and the page's canvas (an OffscreenCanvas), grows the island's fields once,
// runs the game's sim on the same device (play/sim.js), draws every object of the sim straight from the sim's own GPU
// buffers with the atlas of their sprites, and draws each frame the page asks for (webgpu.js). The page (live.js) keeps
// the camera, the sky and the UI; it sends what moves (the view, the light, the people, animals, fires and overlays),
// asks for each tick, and gets the sim's state after it (play/remote.js).
import { generateIsland, fineGroundGpu, rng, crownShare, SIZE, START, STEP, TILE_M, TILES, CELL } from "../island.js";
import * as PAL from "./pal.js";
import { P, NCOL, HAZE, GLOW, TONE, TONE_S } from "./pal.js";
import { createPlanet } from "./planet.js";
import { planetCam } from "./planet-cam.js";
import { LIVE, shown, ANIMAL_BODY, ANIMAL_DRAWN } from "./px.js";
import { packGround } from "./ground.wgsl.js";
import { createRenderer, NS, ATLAS, LEVELS } from "./webgpu.js";
import { Looks, CODES, NONE, castRows, Shelves, entryWords } from "./atlas.js";
import { PICK_SLOT, EXTRA_PICK, KIND_PICK, NO_SLOT, CELLS_N, CELL_M } from "./wgsl/objects.js";
import { closeGround } from "./ground-at.js";
import { openPyramid } from "./pyramid.js";
import { createWindows } from "./groundwin.js";

const early = [];
onmessage = (e) => early.push(e);
const ORIGIN = -SIZE / 2, WS = 12.5;
// entries and rows kept for sprites made while the page runs (live sprites, and objects' sprites the world grew into
// since the atlas was laid out), and the atlas layers they go in
const DYN_ENTRIES = 32768, DYN_ROWS = 1 << 20, DYN_LAYERS = 4;
let R = null, device = null, gpuName = "", canvas = null, context = null, planet = null, planetLayer = null, planetLift = 0;
// each sprite's foot (rows its anchor sits above the ground), by atlas id, for the checks
let table = null, nStatic = 0, rowsStatic = 0, dyn = null, liveIds = new Map(), dynMade = new Set(), feet = new Int16Array(0);
// the page's live sprites as they came, by its ids: placed in the dynamic layers when a frame first draws them, and again
// after the layers are cleared
const liveSrc = new Map();
const post = (m, t) => postMessage(m, t ?? []);
const say = (what, d, n) => post({ type: "progress", what, d, n });
// when each step of the first view was reached, ms from init (reported with the objects)
const T0 = performance.now(), timeline = {};
const mark = (k) => { timeline[k] = Math.round(performance.now() - T0); };
// A task boundary: a frame the page sent meanwhile is drawn before the work goes on (a message port's task, as a
// timer's would be held to a few ms once nested). Long work here (the sim's tick, the sprites put in the atlas) awaits
// it between its parts, so no part holds a frame back long.
const turn = new MessageChannel(), turnWaiting = [];
turn.port1.onmessage = () => turnWaiting.shift()();
const nextTask = () => new Promise((ok) => { turnWaiting.push(ok); turn.port2.postMessage(0); });
// the most a part of such work runs before it lets a frame in [design: a quarter of a 60 Hz frame]
const PART_MS = 4;
// the most of a frame the sim's due ticks run in before their state goes to the page; the rest wait for the next frame
// [design: half a 60 Hz frame, until the renderer's share of a worker frame is measured (real-time tick plan, Unit 8)]
const SIM_BUDGET_MS = 8;
// the same while the world warms, when nothing on the page waits for the ticks but the warm's count: they run on between
// the frames, which are drawn between ticks all the same (nextTask), and their state goes to the page ten times a
// second [design]
const WARM_BUDGET_MS = 100;

// The seed's baked planet, if one is: its manifest (planets/<seed>.json, written by scripts/demo.ts: the pyramid's tiers, the faces
// that have tiles and where they are) and the tile pyramid, tier 0 held whole. The planet's radius is the cells' own: a face is
// 256 << (tiers - 1) cells of CELL metres along its edge, so the sphere's circumference is four of them [derived], and the highest
// ground a tier-0 cell holds, with a margin for the peaks a mean hides, bounds the relief the planet layer marches.
async function openPlanet(seed, device) {
  const res = await fetch(new URL(`../planets/${seed}.json`, import.meta.url));
  if (!res.ok) return null;
  const manifest = await res.json(), G = await import("../globe.js");
  const pyramid = await openPyramid({ device, base: new URL(`../planets/${manifest.tiles}/pyramid`, import.meta.url).href, tiers: manifest.tiers, faces: manifest.faces, across: G.cellAcross });
  let hmax = 0;
  for (const f of manifest.faces) for (const h of pyramid.planes0(f).height) hmax = Math.max(hmax, h * 0.25);
  const T = manifest.groundtiles ? await import("../tile.js") : null, base = new URL(`../planets/${manifest.tiles}`, import.meta.url).href;
  return { G, T, base, manifest, pyramid, radiusM: ((256 << (manifest.tiers - 1)) * CELL * 2) / Math.PI, hmax: hmax * 1.5 + 300 };
}

async function init(m) {
  const t0 = performance.now();
  if (!navigator.gpu) throw new Error("this browser gives no WebGPU");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("this browser found no WebGPU adapter");
  const timing = adapter.features.has("timestamp-query");
  device = await adapter.requestDevice({ requiredFeatures: timing ? ["timestamp-query"] : [], requiredLimits: { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize, maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers } });
  device.lost.then((info) => post({ type: "lost", why: info.message || info.reason }));
  // as src/gpu/device.ts names an adapter, for the sim that runs on this device
  gpuName = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(" ") || "unknown adapter";
  device.addEventListener?.("uncapturederror", (e) => post({ type: "gpuerror", why: e.error.message }));
  canvas = m.canvas;
  context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  say("growing the island", 0, 1);
  const simB = m.sim ? await import("../sim.js") : null, simC = m.sim ? await import("../play/sim.js") : null;
  const gpu = { device, adapter: gpuName };
  if (simB) simB.useGpu(gpu);
  planet = m.planet ? await openPlanet(m.seed, device) : null;
  const ground = await closeGround(simB, m.seed, gpu, planet);
  const { isle, fine: g } = ground;
  const t1 = performance.now();
  say("laying out the ground", 0, 1);
  const pack = packGround(isle, g);
  const t2 = performance.now();
  // the world takes up residence on the GPU while the shaders build; it draws once the renderer is ready
  if (m.sim) startSim(simB, simC.createSim, m.seed, m.sim).catch((err) => post({ type: "simError", error: String((err && err.stack) || err) }));
  say("building the shaders", 0, 1);
  R = await createRenderer({
    device, context, format, timing, ground: pack,
    pal: { P, NCOL, HAZE, GLOW, TONE, TONE_S, WATER: ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"].map((k) => P[k]), TILE_M, ORIGIN, TILES, TRAIL_N: Math.round(SIZE / 3), GRID_STEP: WS, FINE: { start: START, step: STEP } },
  });
  if (planet && ground.place) planetLayer = Object.assign(await createPlanet({ device, format, G: planet.G, pyramid: planet.pyramid, pal: PAL, radiusM: planet.radiusM, hmax: planet.hmax, levels: LEVELS }), { radiusM: planet.radiusM });
  let peak = 0;
  for (const h of isle.height) peak = Math.max(peak, h);
  home = { pack, fields: { peak, h: g.h, height: isle.height, water: isle.water } };
  if (planet?.T && simB) {
    // the most objects a window's body holds: 28 bytes a slot must fit the device's storage binding, and at most 8.4 million [design: 235 MB]
    const room = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / 28;
    planet.wins = createWindows({ G: planet.G, T: planet.T, gpu, base: planet.base, tier: planet.manifest.tiers - 1, seed: m.seed, radiusM: planet.radiusM, quick: isle.quick, top: Math.min(1 << 23, 2 ** Math.floor(Math.log2(room))) });
    // the window source's passes for each size its body comes in, compiled now on the GPU process's own threads (a first window then does not wait on them)
    for (const cap of [1 << 23, 1 << 22, 1 << 21, 1 << 20].filter((c) => c <= Math.min(1 << 23, 2 ** Math.floor(Math.log2(room))))) void R.warmSpec("win", winSpec(cap)).catch((err) => console.warn("warm window passes", err));
  }
  // the page keeps the camera on the island's heights and the drawn ground under it: the fine heights and the cells'
  // water, from which live.js (ground.js) works out every level's tile map as the GPU does
  post({ type: "fields", info: adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null, peak, h: g.h, height: isle.height, water: isle.water, ms: { grow: t1 - t0, pack: t2 - t1 }, place: ground.place && { ...ground.place, windows: !!planet?.wins } });
  await new Promise((r) => setTimeout(r, 0));
  if (R.errors.length) throw new Error(R.errors.join("\n"));
  mark("renderer");
  rendererIn.resolve();
  post({ type: "ready", ms: performance.now() - t0 });
}

// ---------- objects ----------
// Every object is drawn from a GPU buffer (wgsl/objects.js): the stems from the sim's store kind "plant" itself, with
// its spatial index; the generator's static dormant members (which the sim stores nowhere: their state is the
// generator's) from one buffer laid out here once, by cell, in the store's shape; and the few things the CPU made or
// holds otherwise (a stump, a cut log, a grazed tussock, a bush whose berries were picked) as records kept here as the
// sim changes them. A grown object the page draws itself (burning, carried) or that a record stands for is hidden in
// its buffer: a stem by a bit beside the store's body, a static member by its own slot word.
const STEP_MM = (TILE_M * 1000) / 1e4, CELL_MM = CELL_M * 1000;
const mmOf = (p) => Math.round(p * 1e4) * STEP_MM;
let S = null, looks = null, level = null, spritesP = null, FLORA_N = null;
const words32 = (n) => Math.ceil(n / 32);
const buffer = (data, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) => {
  const b = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage });
  device.queue.writeBuffer(b, 0, data);
  return b;
};

// The world's objects as GPU sources, once its flora lives on the GPU (play/sim.js onWorld), and the sprites every
// level draws them at made while the world warms.
async function setupObjects(sim, w) {
  const t0 = performance.now(), flora = sim.flora(), plant = flora.store.kind("plant"), C = plant.capacity, F = plant.field;
  FLORA_N = sim.FLORA;
  const marks = new Uint32Array(words32(C) + Math.ceil(C / 16));
  S = {
    flora, w,
    plant: {
      name: "plant", body: plant.body, order: plant.order, start: plant.start, marks: buffer(marks), cpu: marks,
      spec: { cap: C, fields: { x: F.x, y: F.y, what: F.what, size: F.size, seed: F.seed }, sizeMm: true, marks: true, ordered: true, indexed: true, canopy: true },
    },
    statics: staticsOf(flora),
    extras: extrasOf(1 << 14),
    hidden: new Set(), // object numbers hidden in their buffers
    hiddenSlots: new Map(), // plant slots hidden in marks, to the generation they were hidden at (-1 until read back)
  };
  await R.setSources(sources());
  const t1 = performance.now();
  looks = new Looks(sim.FLORA, sim.SPECIES, level, crownShare);
  R.setMeta(looks.meta());
  looks.addAll(await R.survey(0, 0, (CODES * CODES) / 32));
  R.setMeta(looks.meta());
  growTable();
  const jobs = await wanted();
  mark("survey");
  spritesP = makeAll(jobs).then((made) => { mark("sprites"); return made; });
  S.ms = { sources: t1 - t0, survey: performance.now() - t1 };
}
const sources = () => (S.win ? [S.win] : [S.plant, ...(S.statics.cap ? [S.statics] : []), S.extras, ...(S.animals ? [S.animals] : []), ...(S.dead ?? [])]);

// The generator's objects that aren't stems (src/gpu/flora.ts: static dormant), counted into the spatial index's cells
// and laid out cell by cell in entry order, fields as the store holds a piece's: x, y (mm), what, size (f32 bits),
// seed, and the object number as its pick.
function staticsOf(flora) {
  const f = flora.f, n = f.n, plantKind = new Uint8Array(256), cells = CELLS_N * CELLS_N;
  plantKind[FLORA_N.indexOf("tree")] = plantKind[FLORA_N.indexOf("bush")] = 1;
  const cellOf = (k) => Math.min(CELLS_N - 1, Math.floor(mmOf(f.py[k]) / CELL_MM)) * CELLS_N + Math.min(CELLS_N - 1, Math.floor(mmOf(f.px[k]) / CELL_MM));
  const start = new Uint32Array(cells + 1);
  let m = 0;
  for (let k = 0; k < n; k++) if (!plantKind[f.kind[k]]) { start[cellOf(k) + 1]++; m++; }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const cur = start.slice(0, cells), body = new Uint32Array(7 * Math.max(1, m)), B = new Float32Array(body.buffer);
  body.fill(1, 0, m);
  for (let k = 0; k < n; k++) {
    if (plantKind[f.kind[k]]) continue;
    const s = cur[cellOf(k)]++;
    body[m + s] = mmOf(f.px[k]); body[2 * m + s] = mmOf(f.py[k]); body[3 * m + s] = f.kind[k] + 256 * f.species[k];
    B[4 * m + s] = f.size[k]; body[5 * m + s] = f.seed[k]; body[6 * m + s] = k + 1;
  }
  return {
    name: "static", cap: m, e: body.slice(6 * m, 7 * m), cellStart: start, cellOf: (e) => cellOf(e - 1),
    body: buffer(body), start: buffer(start),
    spec: { cap: Math.max(1, m), fields: { x: 0, y: 1, what: 2, size: 3, seed: 4, pick: 5 }, sizeMm: false, marks: false, ordered: false, indexed: true, canopy: false },
  };
}
// a static member's slot, or -1: its cell's run holds the cell's members in entry order
function staticSlot(e) {
  const st = S.statics, c = st.cellOf(e);
  let lo = st.cellStart[c], hi = st.cellStart[c + 1] - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1, v = st.e[mid]; if (v === e) return mid; if (v < e) lo = mid + 1; else hi = mid - 1; }
  return -1;
}

// The CPU's records: a buffer in the store's shape (slot words, then x, y, what, size, seed, pick, berries) with its
// copy here; slots reused as records go.
function extrasOf(cap, old) {
  const cpu = new Uint32Array(8 * cap);
  if (old) for (let f = 0; f < 8; f++) cpu.set(old.cpu.subarray(f * old.cap, (f + 1) * old.cap), f * cap);
  return {
    name: "extra", cap, cpu, body: buffer(cpu), ids: old?.ids ?? [], slot: old?.slot ?? new Map(), free: old?.free ?? [], next: old?.next ?? 0,
    spec: { cap, fields: { x: 0, y: 1, what: 2, size: 3, seed: 4, pick: 5, nst: 6 }, sizeMm: false, marks: false, ordered: false, indexed: false, canopy: true },
  };
}
const nstOf = (n) => (n == null ? 0 : n > 0 ? 2 : 1);

// ---------- the sim's other kinds ----------
// The kinds the store holds in layouts of their own, drawn straight from their buffers (wgsl/objects.js sourceWGSL's
// read and member): the animals (src/gpu/animals.ts); the logs and snags and those people touched, the sticks of every
// stick bin and those people touched, and every cell's clasts and those moved (src/gpu/deadwood.ts, its own WGSL for
// a piece's state and place). The deadwood is resident only after the world's first tick, so its sources come then.
// A pick of one names its source by a tag (wgsl/objects.js KIND_PICK): tags[tag](slot) gives the thing's id, or null.
let B = null;
const tags = [], tagName = [];
const pickBits = (tag, slot = NO_SLOT) => `${(KIND_PICK | (tag << 24) | slot) >>> 0}u`;
const flt = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);
// a slot's word of a kind's body (bit 0 alive, then its generation), read back from the GPU
async function slotWord(body, slot) {
  const rb = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(body, slot * 4, rb, 0, 4);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const w = new Uint32Array(rb.getMappedRange().slice(0))[0];
  rb.destroy();
  return w;
}
// a source of a store kind: its buffers, and a tag naming its things by prefix and their GPU ids (store.ts idOf)
function kindSource(k, name, spec, prefix) {
  const tag = tags.push(prefix ? async (slot) => { const w = await slotWord(k.body, slot); return w & 1 ? `${prefix}${B.idOf(k.n, slot, w >>> 1)}` : null; } : async () => null) - 1;
  tagName[tag] = name;
  return { name, body: k.body, order: k.order, start: k.start, tag, spec: { cap: k.capacity, indexed: true, ordered: true, ...spec(tag) } };
}
// The animals: species by the sp field's low four bits (src/gpu/wgsl/animals.ts SP), drawn standing at their body's
// size (px.js), each with variation from its slot and birth.
function animalSource(store) {
  const k = store.kinds.find((x) => x.name === "animal");
  if (!k) return null;
  const names = Object.entries(B.ANIMAL_SP).sort((a, b) => a[1] - b[1]).map(([n]) => n), n = names.length, F = k.field;
  const kind = looks.code(looks.kinds, "animal"), sp = names.map((s) => looks.code(looks.species, s));
  // the size whose shown size (px.js shown) is the body's drawn one
  const size = names.map((s) => { const t = shown(ANIMAL_BODY[s] ?? 0.5) * ANIMAL_DRAWN; return t >= 1 ? t : t ** (1 / 0.55); });
  return kindSource(k, "animal", (tag) => ({
    fields: { x: F.x, y: F.y, sp: F.sp, born: F.born }, moves: true,
    decls: `const A_SP = array<u32, ${n}>(${sp.map((c) => `${c}u`).join(", ")});\nconst A_SIZE = array<f32, ${n}>(${size.map(flt).join(", ")});`,
    read: (at) => `
  let s = min(body[${at("sp")} + i] & 15u, ${n - 1}u);
  o.kind = ${kind}u; o.sp = A_SP[s]; o.size = A_SIZE[s];
  var h = ((i + 1u) * 2654435761u) ^ body[${at("born")} + i];
  h = (h ^ (h >> 15u)) * 2246822519u;
  o.seed = h ^ (h >> 13u);
  o.pick = ${pickBits(tag, 0)} | i; o.nst = 0u;`,
  }), "a");
}
// Logs and snags as their state stands at the newest committed hour (src/gpu/wgsl/deadwood.ts LOG_STATE): a snag stands
// as tall as its tree, a log lies as long; one rotted away is not drawn.
function logSource(store, D, name, prefix) {
  const k = store.kind(name), F = k.field, LOG = looks.code(looks.kinds, "fallen_log"), SNAG = looks.code(looks.kinds, "snag");
  const s = kindSource(k, name, (tag) => ({
    fields: { x: F.x, y: F.y, what: F.what, born: F.born, arot: F.arot, len: F.len, u: F.u, uf: F.uf, fr: F.fr },
    binds: ["drv"],
    decls: `${B.FIXED}\n${B.deadCommon(D.law)}\n${B.LOG_STATE}\n${B.drvAccess(D.drv.layout)}`,
    read: (at) => `
  let hr = drv_hour();
  let st = log_state(body[${at("what")} + i], body[${at("born")} + i], drv_sum(CH_ROT, cell_of(body[${at("x")} + i], body[${at("y")} + i]), hr) - body[${at("arot")} + i], body[${at("u")} + i], body[${at("uf")} + i], body[${at("fr")} + i], hr);
  o.ok = st != 0u;
  o.kind = select(${LOG}u, ${SNAG}u, st == 1u); o.sp = min(body[${at("what")} + i], 63u);
  o.size = f32(body[${at("len")} + i]) * 0.001; o.seed = body[${at("u")} + i];
  o.pick = ${pickBits(tag, 0)} | i; o.nst = 0u;`,
  }), prefix);
  s.over = { drv: { buffer: D.drv.ring } };
  return s;
}
// The sticks of every stick bin, as many as it was born with, each lying while its word outlasts the rot over its cell
// since the bin's birth and not taken (STICK_MEMBER's stick and taken); those people moved, as kind stickup holds them.
function stickSources(store, D, dw) {
  const k = store.kind("stickbin"), F = k.field, STICK = looks.code(looks.kinds, "stick"), none = looks.code(looks.species, "");
  const law = `${B.FIXED}\n${B.RAND}\n${B.deadCommon(D.law)}\n${B.drvAccess(D.drv.layout)}`;
  const bins = kindSource(k, "stickbin", (tag) => ({
    fields: { x: F.x, y: F.y, born: F.born, arot: F.arot, n: F.n }, members: "bins", flat: true, most: B.STICK_LEN,
    needs: { kind: STICK, sp: none, lo: B.STICK_LEN, hi: B.STICK_LEN, mossy: false },
    binds: ["drv", "gone"], decls: `${law}\n${B.STICK_MEMBER}`,
    read: () => "\n  o.ok = false;",
    member: `
var<private> sCell: u32;
var<private> sBorn: u32;
var<private> sLast: u32;
fn memberCount(i: u32) -> u32 {
  sCell = cell_of(body[${(1 + F.x) * k.capacity}u + i], body[${(1 + F.y) * k.capacity}u + i]);
  sBorn = body[${(1 + F.born) * k.capacity}u + i];
  sLast = bitcast<u32>(qexp(-lam(drv_sum(CH_ROT, sCell, drv_hour()) - body[${(1 + F.arot) * k.capacity}u + i], KSTICK)));
  return body[${(1 + F.n) * k.capacity}u + i];
}
fn member(i: u32, k: u32) -> Obj {
  var o: Obj;
  let m = stick(sCell, sBorn, k);
  o.ok = (m.u >> 16u) < sLast && !taken(sCell, sBorn, k);
  if (!o.ok) { return o; }
  o.x = f32(m.x) * 0.001 + ORIGIN_M; o.z = f32(m.y) * 0.001 + ORIGIN_M;
  o.kind = ${STICK}u; o.sp = ${none}u; o.size = ${flt(B.STICK_LEN)}; o.seed = m.u; o.pick = ${pickBits(tag)}; o.nst = 0u;
  return o;
}`,
  }), null);
  bins.dyn = () => ({ gone: { buffer: dw.drawBuffers().gone } });
  bins.over = { drv: { buffer: D.drv.ring } };
  const u = store.kind("stickup"), G = u.field;
  const up = kindSource(u, "stickup", (tag) => ({
    fields: { x: G.x, y: G.y, u: G.u }, flat: true,
    read: (at) => `
  o.kind = ${STICK}u; o.sp = ${none}u; o.size = ${flt(B.STICK_LEN)}; o.seed = body[${at("u")} + i]; o.pick = ${pickBits(tag, 0)} | i; o.nst = 0u;`,
  }), null);
  return [bins, up];
}
// Every cell's clasts of a class (src/gpu/wgsl/deadwood.ts clastBody: the placing that follows the halvings, taken from
// it as written), but those moved or taken (the class's sorted gone list); those moved, as the class's kind holds them.
// The renderer keeps each shown cell's members of a size some level draws in a cache (wgsl/objects.js cacheFillWGSL):
// dmin, the least diameter in mm drawn at a pixel at the nearest level, and cm, a cell's room, the fullest cell's count
// when every member is that big, else its expected share of them and twelve standard deviations more [design].
function clastSources(store, c, counts) {
  const L = c.law, body = B.clastBody(L), place = body.slice(body.indexOf(`rinit(${L.seed >>> 0}u, ${L.stream >>> 0}u, k, cell);`));
  const kind = looks.code(looks.kinds, c.kind), none = looks.code(looks.species, ""), mm = CELL_M * 1000;
  const tag = tags.push(async () => null) - 1;
  tagName[tag] = c.kind;
  const pv = Math.max(...level.map((l) => Math.max(l.pv, l.pw))), dim = 65536 / L.dimq;
  const dmin = pv >= 1 ? Math.max(0, Math.floor((1 / pv) ** (1 / 0.55) * 1000 * 0.999) - 1) : L.hi;
  const share = dmin <= L.lo ? 1 : Math.max(0, ((dmin / L.lo) ** -dim - (L.hi / L.lo) ** -dim) / (1 - (L.hi / L.lo) ** -dim));
  const most = counts.reduce((a, b) => Math.max(a, b), 0);
  const cm = share >= 1 ? most : Math.min(most, Math.ceil(most * share + 12 * Math.sqrt(most * share * (1 - share)) + 64));
  const cells = {
    name: c.kind, tag, over: { counts: { buffer: c.counts } },
    spec: {
      cap: 1, members: "cells", flat: c.kind === "pebble", most: L.hi / 1000, binds: ["gone"], cache: { dmin, cm: Math.max(1, cm), counts },
      needs: { kind, sp: none, lo: L.lo / 1000, hi: L.hi / 1000, mossy: c.kind !== "pebble" },
      decls: `${B.FIXED}\n${B.RAND}`,
      member: `
const CL_SEED = ${L.seed >>> 0}u;
const CL_STREAM = ${L.stream >>> 0}u;
fn rawGone(cell: u32, k: u32) -> bool {
  var lo = 0u; var hi = gone[0];
  loop {
    if (lo >= hi) { return false; }
    let m = (lo + hi) / 2u; let c = gone[1u + 2u * m]; let j = gone[2u + 2u * m];
    if (c == cell && j == k) { return true; }
    if (c < cell || (c == cell && j < k)) { lo = m + 1u; } else { hi = m; }
  }
}
// member k of a cell in square (ix, iy): its place in mm, its diameter in mm and its seed
fn rawMember(cell: u32, k: u32, ix: u32, iy: u32) -> vec4u {
  let x0 = (cell % ${CELLS_N}u) * ${mm}u; let y0 = (cell / ${CELLS_N}u) * ${mm}u;
  var out_x: u32; var out_y: u32; var out_dia: u32; var out_seed: u32;
  {
  ${place}
  }
  return vec4u(out_x, out_y, out_dia, out_seed);
}
fn rawObj(v: vec4u, cell: u32, k: u32) -> Obj {
  var o: Obj;
  o.ok = !rawGone(cell, k);
  o.x = f32(v.x) * 0.001 + ORIGIN_M; o.z = f32(v.y) * 0.001 + ORIGIN_M;
  o.kind = ${kind}u; o.sp = ${none}u; o.size = f32(v.z) * 0.001; o.seed = v.w; o.pick = ${pickBits(tag)}; o.nst = 0u;
  return o;
}`,
    },
  };
  const dw = deadwoodOf();
  cells.dyn = () => ({ gone: { buffer: dw.drawBuffers().clasts.find((d) => d.kind === c.kind).gone } });
  const m = store.kind(c.kindName), G = m.field;
  const moved = kindSource(m, `${c.kind} moved`, (t) => ({
    fields: { x: G.x, y: G.y, dia: G.dia, seed: G.seed }, flat: c.kind === "pebble",
    read: (at) => `
  o.kind = ${kind}u; o.sp = ${none}u; o.size = f32(body[${at("dia")} + i]) * 0.001; o.seed = body[${at("seed")} + i]; o.pick = ${pickBits(t, 0)} | i; o.nst = 0u;`,
  }), null);
  return [cells, moved];
}
const deadwoodOf = () => B.deadwoodOf(S.w);
// The kinds' sources added once the store holds them: the animals at once, the deadwood once it is resident. True
// when something was added (its kinds and species numbered, its passes made).
async function setupKinds() {
  const store = S.flora.store;
  let added = false;
  if (!S.animals && (S.animals = animalSource(store))) added = true;
  const dw = !S.dead && deadwoodOf();
  if (dw) {
    const D = dw.drawBuffers();
    S.dead = [logSource(store, D, "log", "l"), logSource(store, D, "logup", null), ...stickSources(store, D, dw), ...D.clasts.flatMap((c) => clastSources(store, c, dw.counts[c.kind]))];
    added = true;
  }
  if (!added) return false;
  // the member sources' pairs, which no survey sees, then every source's
  for (const s of sources()) if (s.spec.needs) looks.add(s.spec.needs.kind, s.spec.needs.sp);
  R.setMeta(looks.meta());
  await R.setSources(sources());
  if (looks.addAll(await R.survey(0, 0, (CODES * CODES) / 32))) R.setMeta(looks.meta());
  growTable();
  return true;
}
const f32w = new Float32Array(1), u32w = new Uint32Array(f32w.buffer);
// a thing (as the sim holds it or its clients see it) drawn from a record
function putExtra(t) {
  let X = S.extras;
  const kind = looks.code(looks.kinds, t.kind), sp = looks.code(looks.species, t.species ?? "");
  if (kind === null || sp === null) { console.warn(`no code left for ${t.kind} ${t.species}: not drawn`); return; }
  if (looks.add(kind, sp)) { R.setMeta(looks.meta()); growTable(); }
  let s = X.slot.get(t.id);
  if (s === undefined) {
    s = X.free.pop() ?? X.next++;
    // a bigger buffer, its passes made again; the old one draws until they are ready
    if (s >= X.cap) { X = S.extras = extrasOf(X.cap * 2, X); R.setSources(sources()).catch((err) => post({ type: "error", error: String(err) })); }
    X.slot.set(t.id, s); X.ids[s] = t.id;
    S.newLooks = true;
  }
  f32w[0] = t.size ?? 1;
  const v = [1, Math.round(t.px * TILE_M * 1000), Math.round(t.py * TILE_M * 1000), kind + 256 * sp, u32w[0], t.seed >>> 0, EXTRA_PICK | s, nstOf(t.n)];
  for (let f = 0; f < 8; f++) X.cpu[f * X.cap + s] = v[f];
  device.queue.writeBuffer(X.body, s * 4, X.cpu.subarray(s, s + 1));
  for (let f = 1; f < 8; f++) device.queue.writeBuffer(X.body, (f * X.cap + s) * 4, X.cpu.subarray(f * X.cap + s, f * X.cap + s + 1));
  S.dirty = true;
}
function dropExtra(id) {
  const X = S.extras, s = X.slot.get(id);
  if (s === undefined) return;
  X.slot.delete(id); X.ids[s] = undefined; X.free.push(s);
  X.cpu[s] = 0;
  device.queue.writeBuffer(X.body, s * 4, X.cpu.subarray(s, s + 1));
  S.dirty = true;
}
// Object e of the flora shown in its buffer or not, and a stem's berries (nst) as the CPU last saw them; only a change
// goes to the GPU.
function showGrown(e, on, nst = 0) {
  if (S.flora.isPlant(e)) return showSlot(S.flora.slot(e), on, nst);
  if (on !== S.hidden.has(e)) return;
  if (on) S.hidden.delete(e); else S.hidden.add(e);
  const s = staticSlot(e);
  if (s >= 0) device.queue.writeBuffer(S.statics.body, s * 4, Uint32Array.of(on ? 1 : 0));
}
// Plant slot j shown in its buffer or not, with its berries.
function showSlot(j, on, nst = 0) {
  const M = S.plant.cpu, h = j >> 5, b = words32(S.plant.spec.cap) + (j >> 4), sh = (j & 15) * 2;
  const hv = on ? M[h] & ~(1 << (j & 31)) : M[h] | (1 << (j & 31)), bv = (M[b] & ~(3 << sh)) | (nst << sh);
  if (hv !== M[h]) { M[h] = hv; device.queue.writeBuffer(S.plant.marks, h * 4, M.subarray(h, h + 1)); S.dirty = true; }
  if (bv !== M[b]) { M[b] = bv; device.queue.writeBuffer(S.plant.marks, b * 4, M.subarray(b, b + 1)); }
  // a hidden slot's generation, so the stem a later birth puts in it (store.ts) is not hidden with it
  if (on) S.hiddenSlots.delete(j);
  else if (!S.hiddenSlots.has(j)) { S.hiddenSlots.set(j, -1); slotWord(S.plant.body, j).then((w) => { if (S.hiddenSlots.get(j) === -1) S.hiddenSlots.set(j, w >>> 1); }); }
}
// The hidden plant slots born again since they were hidden (their generation moved on): shown, berries unknown. Run
// after each day's step, when the stems' births land.
async function showReborn() {
  const slots = [...S.hiddenSlots.keys()];
  if (!slots.length) return;
  const rb = device.createBuffer({ size: slots.length * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), enc = device.createCommandEncoder();
  slots.forEach((j, i) => enc.copyBufferToBuffer(S.plant.body, j * 4, rb, i * 4, 4));
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const w = new Uint32Array(rb.getMappedRange().slice(0));
  rb.destroy();
  const M = S.plant.cpu, B0 = words32(S.plant.spec.cap);
  slots.forEach((j, i) => {
    const gen = S.hiddenSlots.get(j);
    if (gen === undefined || gen === -1 || w[i] >>> 1 === gen) return;
    S.hiddenSlots.delete(j);
    const h = j >> 5, b = B0 + (j >> 4);
    M[h] &= ~(1 << (j & 31)); M[b] &= ~(3 << ((j & 15) * 2));
    device.queue.writeBuffer(S.plant.marks, h * 4, M.subarray(h, h + 1));
    device.queue.writeBuffer(S.plant.marks, b * 4, M.subarray(b, b + 1));
    S.dirty = true;
  });
}
// How a thing the sim reports is drawn: by the page (live kinds, anything burning), by nobody (carried or gone), from
// its buffer (a grown object standing as its buffer holds it), or from a record.
const pageDraws = (t) => LIVE.has(t.kind) || !!t.bed || !!t.blaze;
function place(t) {
  const num = /^t\d+$/.test(t.id) ? +t.id.slice(1) : 0, e = num >= 1 && num <= S.flora.n ? num : 0;
  if (t.contained || pageDraws(t)) {
    if (e) showGrown(e, false);
    dropExtra(t.id);
    return;
  }
  if (e) {
    const plant = S.flora.isPlant(e), s = plant ? S.flora.stand(e) : S.flora.written(e);
    const asBuffer = !!s && t.kind === FLORA_N[s.kind] && (t.species ?? "") === looks.species[s.species] && t.px === s.px && t.py === s.py && t.seed === s.seed && (plant || (t.size === s.size && t.n == null));
    if (asBuffer) { showGrown(e, true, plant ? nstOf(t.n) : 0); dropExtra(t.id); return; }
    showGrown(e, false);
  }
  // a tree or bush people raised is drawn from its record; its stem's slot (flora.ts made) is hidden
  else if (S.flora.madeSlot(t.id) >= 0) showSlot(S.flora.madeSlot(t.id), false);
  putExtra(t);
}
function gone(id) {
  const num = /^t\d+$/.test(id) ? +id.slice(1) : 0;
  if (num >= 1 && num <= S.flora.n) showGrown(num, false);
  dropExtra(id);
}

// ---------- sprites ----------
// every family and size the survey found drawn and not made yet, as [family key, size index, slot]
const asked = new Set();
async function wanted() {
  const need = await R.survey(1, level.length, words32(looks.n * NS)), jobs = [];
  // a source of members has no survey: every layout, moss and size its members' sizes reach at each level
  const hq = (h) => (h < 8 ? Math.round(h * 2) : 8 + Math.round(h));
  for (const s of sources()) {
    const q = s.spec.needs, base = q && looks.base.get(q.kind * CODES + q.sp);
    if (base === undefined || base === null) continue;
    for (const l of level) {
      const lo = Math.max(1, shown(q.lo) * l.pv), hi = shown(q.hi) * l.pv;
      for (let si = hq(lo); hi >= 1 && si <= Math.min(NS - 1, hq(hi)); si++)
        for (let vr = 0; vr < 8; vr++)
          for (const moss of q.mossy ? [0, 1] : [0]) { const bit = (base + (vr * 2 + moss) * 3) * NS + si; if (bit >> 5 < need.length) need[bit >> 5] |= 1 << (bit & 31); }
    }
  }
  for (let wi = 0; wi < need.length; wi++) {
    let v = need[wi];
    while (v) {
      const b = 31 - Math.clz32(v), slot = wi * 32 + b;
      v &= ~(1 << b);
      if (table[slot] || asked.has(slot)) continue;
      asked.add(slot);
      jobs.push([looks.key(Math.floor(slot / NS)), slot % NS, slot]);
    }
  }
  return jobs;
}
// the table of every family's sprites, grown to the families numbered so far
function growTable() {
  if (table && table.length >= looks.n * NS) return;
  const t = new Uint32Array(looks.n * NS);
  if (table) t.set(table);
  table = t;
  R.setTable(table);
}
// the sprites a sprite worker sends at once while the page runs [design: a message of them taken in well within a
// frame's PART_MS, against 200 for the first view]
const REFRESH_CHUNK = 16;
// sprites for every [family key, size index, slot] in jobs, by as many sprite workers as the machine spares, chunk to a
// message (each message's sprites are taken in as one task here); the page's loading line is told how far they are
// only for the first view (report)
async function makeAll(jobs, { chunk = 200, report = true } = {}) {
  if (!jobs.length) return [];
  const nw = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2, Math.ceil(jobs.length / 100))), out = [];
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
    const list = lists[i], CH = chunk;
    let at = 0;
    const next = () => {
      if (at >= list.length) { w.terminate(); ok(); return; }
      w.postMessage({ id: at, jobs: list.slice(at, at + CH) });
      at += CH;
    };
    w.onmessage = (e) => { for (const r of e.data.out) out.push(r); done += e.data.out.length; if (report) say("drawing the sprites", done, jobs.length); next(); };
    next();
  })));
  return out;
}
// The made sprites into atlas layers, the tallest first along shelves, and the tables that find them.
function packAtlas(made) {
  const list = made.filter(([, s]) => s).sort((a, b) => b[1].h - a[1].h || b[1].w - a[1].w);
  for (const [slot, s] of made) if (!s) table[slot] = NONE;
  const sh = new Shelves(), at = list.map(([, s]) => sh.place(s.w, s.h));
  const layers = sh.layers, rowsN = list.reduce((a, [, s]) => a + s.rows.length, 0), entries = new Uint32Array((list.length + DYN_ENTRIES) * 8);
  const rows = new Uint32Array(rowsN + DYN_ROWS), px = Array.from({ length: layers }, () => null);
  let r0 = 0;
  feet = new Int16Array(list.length + DYN_ENTRIES);
  list.forEach(([slot, s], i) => {
    entries.set(entryWords(s, at[i], r0, s.rows.length), i * 8);
    feet[i] = s.foot;
    rows.set(s.rows, r0); r0 += s.rows.length;
    table[slot] = i + 1;
    const p = (px[at[i].l] ??= new Uint8Array(ATLAS * ATLAS).fill(255));
    for (let y = 0; y < s.h; y++) p.set(s.p.subarray(y * s.w, y * s.w + s.w), (at[i].y + y) * ATLAS + at[i].x);
  });
  nStatic = list.length; rowsStatic = rowsN;
  R.setAtlas({ layers: layers + DYN_LAYERS, entries, rows, table });
  px.forEach((p, l) => p && R.atlasPut(l, 0, 0, ATLAS, ATLAS, p));
  dyn = { shelves: new Shelves(layers, DYN_LAYERS), next: nStatic, rows: rowsStatic, layers };
  liveIds = new Map(); dynMade = new Set();
  return { sprites: list.length, layers };
}
// A sprite made while the page runs, into the dynamic layers; null when they are full (dynReset clears them).
function putDynamic(s) {
  if (dyn.next >= nStatic + DYN_ENTRIES) return null;
  const at = dyn.shelves.place(s.w, s.h);
  if (!at) return null;
  const r = s.rows ?? castRows(s), id = dyn.next++;
  if (dyn.rows + r.length > rowsStatic + DYN_ROWS) return null;
  R.atlasPut(at.l, at.x, at.y, s.w, s.h, s.p);
  R.entriesPut(id, Uint32Array.from(entryWords(s, at, dyn.rows, r.length)));
  feet[id] = s.foot;
  if (r.length) R.rowsPut(dyn.rows, Uint32Array.from(r));
  dyn.rows += r.length;
  return id;
}
function dynReset() {
  dyn.shelves.reset(); dyn.next = nStatic; dyn.rows = rowsStatic;
  liveIds = new Map();
  for (const slot of dynMade) { R.tablePut(slot, 0); table[slot] = 0; asked.delete(slot); }
  dynMade = new Set();
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
// The sprites the objects want now and were never made (the stems grew into new sizes and crown widths, a record of a
// new kind came), made off this thread and put in the dynamic layers a part at a time between frames (PART_MS); the
// GPU draws the nearest made meanwhile.
let refreshing = null;
function refreshSprites() {
  if (refreshing || !dyn) return;
  refreshing = (async () => {
    const made = await makeAll(await wanted(), { chunk: REFRESH_CHUNK, report: false });
    let t = performance.now();
    for (const [slot, s] of made) {
      if (performance.now() - t > PART_MS) { await nextTask(); t = performance.now(); }
      let id = s ? putDynamic(s) : null;
      if (s && id === null) { dynReset(); id = putDynamic(s); }
      table[slot] = s ? (id === null ? 0 : id + 1) : NONE;
      if (!s || id !== null) { R.tablePut(slot, table[slot]); if (s) dynMade.add(slot); }
      if (s && id === null) asked.delete(slot);
    }
  })().catch((err) => console.error("sprites", err)).finally(() => { refreshing = null; });
}
// The trees' cover laid again on the GPU (webgpu.js buildCanopy) once the trees have changed, at most once a second.
let canopyAt = 0, canopyLandings = -1;
function canopyOften() {
  const now = performance.now();
  if (!S || (!S.dirty && canopyLandings === S.flora.landings) || now - canopyAt < 1000) return;
  S.dirty = false; canopyLandings = S.flora.landings; canopyAt = now;
  R.buildCanopy();
}
// The far levels (webgpu.js farBuild): the coarsest ones, which draw trees shrunk, at most eight; and the sim day their
// lists were last built on.
const farLevels = () => { const i = level.findIndex((l) => !l.shrunk); return Math.min(8, i < 0 ? level.length : i); };
let farDay = -1;

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

// ---------- the sim ----------
// The game's sim (play/sim.js) runs here on this worker's device, so the world's objects and the drawing share one GPU
// and the page thread keeps only the UI. Its objects are drawn from its buffers from the moment its flora lives on the
// GPU, the sprites made while it warms; the page asks for each tick and gets the people, animals and camps after it
// (play/remote.js), with what it asks about (want: the selection, the things window, the history).
let sim = null, want = { sel: null, things: null, history: false }, ticking = null;
const levelsIn = Promise.withResolvers(), rendererIn = Promise.withResolvers();
const iceOf = (ice) => { const f = new Uint8Array(TILES * TILES); if (ice) for (const i of ice) f[i] = 1; return f; };
// the sim's footpath wear, stepped into the five widths the ground draws
const wearStep = (v) => (v < 2 ? 0 : v < 5 ? 1 : v < 12 ? 2 : v < 30 ? 3 : 4);
let trailSrc = null, trailQ = null, trailFlush = 0;
const trailPending = new Set();

// bundle: the sim's bundle (../sim.js), already loaded for the island it grew; createSim: play/sim.js's
async function startSim(bundle, createSim, seed, { warm = 0, jev = null }) {
  // a tick's parts with the frames drawn between them (sim.ts tickPause), the run the same as in one piece
  bundle.tickPause.fn = nextTask;
  mark("simStart");
  // The world is shown before it warms: its warm's ticks are the first the page asks for, as fast as its frames allow,
  // each drawn as it lands (simTick). The deadwood is resident after the first of them, and comes as a source then
  // (simChanged).
  sim = await createSim({
    seed, warm, jev, onProgress: (d, n) => post({ type: "simProgress", d, n }),
    // the objects are drawn once the renderer and the page's levels are there (the world grows meanwhile)
    onWorld: async (w) => { mark("world"); await rendererIn.promise; level = await levelsIn.promise; B = bundle; return setupObjects({ flora: () => bundle.floraOf(w), FLORA: bundle.FLORA, SPECIES: bundle.SPECIES }, w); },
  });
  const w = sim.w, t0 = performance.now();
  // the things the page draws every frame, as a client is sent them (inspect.ts thingView), a burning one with its
  // blaze; everything else the world holds as its buffers don't show it is drawn from a record, and what is gone or
  // stands otherwise is hidden in its buffer
  const live = [];
  for (const t of w.things) {
    if (!t.contained && pageDraws(t)) live.push(sim.view(t));
    place(t);
  }
  for (const e of S.flora.gone()) showGrown(e, false);
  const t1 = performance.now();
  post({ type: "simReady", activities: sim.activities, day: sim.day, tickS: sim.tickS, yearDays: sim.yearDays, opening: sim.opening(), state: sim.state(), live });
  R.setIce(iceOf(w.ice));
  trailSrc = sim.trails(); trailQ = new Map();
  const all = new Uint8Array(TN * TN);
  for (const [i, v] of trailSrc.wear) { const q = wearStep(v); if (q) { trailQ.set(i, q); all[i] = q; } }
  trailsAll(all);
  // The warm's first tick, in which the fish and the animals take up residence and run their days before anyone wakes
  // (animals.ts residentAnimals), runs while the sprites are made, so its burst of work is over before the first view.
  const firstTick = warm > 0 ? simTick() : null;
  // the atlas, of the sprites made while the world grew; the animals and the deadwood as sources once resident, their
  // sprites made just after the first view (refreshSprites)
  const atlas = packAtlas(await spritesP);
  mark("pack");
  await firstTick;
  mark("firstTick");
  const t2 = performance.now();
  await setupKinds();
  R.buildCanopy();
  canopyLandings = S.flora.landings; canopyAt = performance.now(); S.dirty = false;
  // the far levels' lists are built in the frames, a slice each (the opening view is not a far level)
  R.farBuild(farLevels());
  farDay = Math.floor(w.t / sim.day);
  mark("objects");
  const st = S.statics, n = S.plant.spec.cap + st.cap;
  post({ type: "objects", n, plants: S.plant.spec.cap, statics: st.cap, records: S.extras.slot.size, sprites: atlas.sprites, layers: atlas.layers, families: looks.n, timeline, ms: { ...S.ms, things: t1 - t0, sprites: t2 - t1, rest: performance.now() - t2 } });
  S.spriteLandings = S.flora.landings; S.newLooks = false; S.spritesAt = performance.now();
  refreshSprites();
}
// The ticks the page says are due (n), one after another while the frame's sim budget lasts (the warm's while it warms;
// at least one), each awaited and each in its own task (napkin: ticks run back to back in one task leave every agent
// thinking), their changes onto the GPU; then the state after them to the page once, with how many ran and what changed
// of the things it draws every frame (ch: live, those to draw as they are now; drop, the ids to draw no more).
async function simTick(n = 1) {
  const ch = { live: new Map(), drop: new Set() }, t0 = performance.now(), budget = sim.warming ? WARM_BUDGET_MS : SIM_BUDGET_MS;
  ticking = Promise.withResolvers();
  let ran = 0;
  do {
    if (ran) await nextTask();
    try { simChanged(await sim.tick(), ch); } catch (err) { console.error("tick", err); }
    ran++;
  } while (ran < n && performance.now() - t0 < budget);
  ticking.resolve(); ticking = null;
  post({ type: "simState", state: sim.state(), ch: { live: [...ch.live.values()], drop: [...ch.drop] }, ran, ...answers() });
}
// a thing to draw no more, whatever an earlier tick of the frame said of it
const chDrop = (ch, id) => { ch.drop.add(id); ch.live.delete(id); };
function simChanged(done, ch) {
  for (const t of done.things) {
    if (t.contained || !pageDraws(t)) chDrop(ch, t.id);
    else { ch.live.set(t.id, t); ch.drop.delete(t.id); }
    place(t);
  }
  for (const id of done.removed) { chDrop(ch, id); gone(id); }
  canopyOften();
  // the deadwood's sources once it is resident (after the world's first tick, with no warm), their sprites made as any
  if (!S.dead && !S.kindsComing && deadwoodOf()) { S.kindsComing = true; setupKinds().then(() => { S.newLooks = true; }).catch((err) => post({ type: "error", error: String(err) })); }
  // the far levels' lists again each sim day, as the stems grow by the day (wgsl/objects.js FAR_COUNT_WGSL)
  const day = Math.floor(sim.w.t / sim.day);
  if (day !== farDay) { farDay = day; R.farBuild(farLevels()); showReborn().catch((err) => console.error("reborn", err)); }
  // the stems grew (their law's landing) or records came: any sprite never made is made now, at most every few seconds
  if ((S.flora.landings !== S.spriteLandings || S.newLooks) && performance.now() - (S.spritesAt ?? 0) > 3000) {
    S.spriteLandings = S.flora.landings; S.newLooks = false; S.spritesAt = performance.now();
    refreshSprites();
  }
  for (const i of done.trails) trailPending.add(i);
  // wear changes every tick; only a change of drawn width counts, put up every few seconds
  const now = performance.now();
  if (trailPending.size && now - trailFlush > 4000) {
    trailFlush = now;
    const cells = [];
    for (const i of trailPending) { const q = wearStep(trailSrc.wear.get(i) ?? 0); if (q !== (trailQ.get(i) ?? 0)) { if (q) trailQ.set(i, q); else trailQ.delete(i); cells.push([i, q]); } }
    trailPending.clear();
    if (cells.length) trailCells(cells);
  }
  if (done.ice) R.setIce(iceOf(sim.w.ice));
}
// What the page asked about, as it stands now: the selection (play/sim.js about, with for a thing where it stands and
// what it is), the things window, the history.
function answers() {
  const m = {};
  if (want.sel != null) { m.sel = want.sel; m.about = aboutOf(want.sel); }
  if (want.things) m.things = sim.things(want.things);
  if (want.history) m.history = sim.history();
  return m;
}
function aboutOf(sel) {
  try {
    return sim.about(sel);
  } catch (err) {
    console.error("inspect", err);
    return { data: null };
  }
}
// the id of the thing an object's pick names (wgsl/objects.js PICK_SLOT, EXTRA_PICK), or null; one of another kind's
// (KIND_PICK) needs its slot's generation from the GPU, so its id comes by kindId
function idOfPick(p) {
  if (p & PICK_SLOT) { const e = S.flora.entry(p & (PICK_SLOT - 1)); return e ? `t${e}` : null; }
  if (p & EXTRA_PICK) return S.extras.ids[p & (EXTRA_PICK - 1)] ?? null;
  if (p & KIND_PICK) return null;
  return p ? `t${p}` : null;
}
const kindId = (p) => (p & KIND_PICK && !(p & (PICK_SLOT | EXTRA_PICK)) && (p & NO_SLOT) !== NO_SLOT ? tags[(p >>> 24) & 15]?.(p & NO_SLOT) ?? null : idOfPick(p));
// the source an object's pick came from, by name
const srcOfPick = (p) => (p & PICK_SLOT ? "plant" : p & EXTRA_PICK ? "extra" : p & KIND_PICK ? tagName[(p >>> 24) & 15] ?? null : "static");

// ---------- checks ----------
// For scripts/play/objects.ts: what view 0 drew in the next frame (each object's thing id, its anchor in art px and the
// world point its buffer gave the cull; at most 65536 sprites and as many specks); how many it drew; the far levels'
// lists, their front lists and a cross-fade's kept view on or off; view 0's G-buffer kept and compared; a kept view
// drawn again and compared; where a thing's buffer holds it, read back from the GPU; and a thing gone from the sim at
// once, as a tick would report it.
let gsnap = null;
async function check(m) {
  if (m.op === "drawn") {
    const r = await R.instances(), foot = (sp) => feet[sp] ?? 0;
    return [...r.sprites, ...r.points].map((it) => ({ id: idOfPick(it.pick), src: srcOfPick(it.pick), x: it.x, y: it.y - foot(it.sp), wx: it.wx, wz: it.wz }));
  }
  if (m.op === "count") { const r = await R.instances(); return { sprites: r.counts[0], points: r.counts[1], far: R.stats.far ?? null, front: R.stats.front ?? null, dynamic: dyn && { entries: dyn.next - nStatic, of: DYN_ENTRIES, layers: dyn.shelves.layers, ofLayers: DYN_LAYERS } }; }
  // the far lists on or off, and built again from the buffers as they are now (rebuild)
  if (m.op === "far") { R.setFarUse(!!m.on); if (m.rebuild) R.farBuild(farLevels()); return true; }
  if (m.op === "fade") { R.setFadeKeep(!!m.on); return true; }
  if (m.op === "roll") { R.debugRoll(m.kx, m.ky); return true; }
  if (m.op === "front") { R.setFrontUse(!!m.on); return true; }
  // view 0's G-buffer kept (gsnap), and the next one compared with it pixel by pixel (gdiff): what each pixel shows
  // (kind, colour, flags) and whose it is
  if (m.op === "gsnap") { gsnap = await R.gbuffer(); return { w: gsnap.w, h: gsnap.h, level: gsnap.level }; }
  if (m.op === "gdiff") {
    const g = await R.gbuffer(), a = gsnap;
    if (!a || a.w !== g.w || a.h !== g.h || a.gx0 !== g.gx0 || a.gy0 !== g.gy0) return { moved: true };
    let shows = 0, owner = 0;
    for (let i = 0; i < g.k.length; i += 2) { if (g.k[i] !== a.k[i]) shows++; else if (g.k[i + 1] !== a.k[i + 1]) owner++; }
    return { level: g.level, pixels: g.w * g.h, shows, owner };
  }
  if (m.op === "fadecheck") return R.fadeCheck();
  if (m.op === "skip") { R.setSkipped(m.names ?? []); return true; }
  if (m.op === "where") return Promise.all(m.ids.map(whereOf));
  if (m.op === "kill") {
    if (ticking) await ticking.promise;
    if (!sim.remove(m.id)) return false;
    gone(m.id);
    return true;
  }
  throw new Error(`no check ${m.op}`);
}
// a thing's place as its buffer holds it (world metres) and whether its slot is alive, read back from the GPU
async function whereOf(id) {
  const e = /^t\d+$/.test(id) ? +id.slice(1) : 0;
  if (!e || e > S.flora.n) return null;
  let src, slot;
  if (S.flora.isPlant(e)) { src = S.plant; slot = S.flora.slot(e); } else { src = S.statics; slot = staticSlot(e); }
  if (slot < 0) return null;
  const C = src.spec.cap, F = src.spec.fields, rb = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src.body, slot * 4, rb, 0, 4);
  enc.copyBufferToBuffer(src.body, ((1 + F.x) * C + slot) * 4, rb, 4, 4);
  enc.copyBufferToBuffer(src.body, ((1 + F.y) * C + slot) * 4, rb, 8, 4);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const a = new Uint32Array(rb.getMappedRange().slice(0));
  rb.destroy();
  return { id, alive: (a[0] & 1) === 1, x: Math.fround(Math.fround(a[1]) * Math.fround(0.001) + Math.fround(ORIGIN)), z: Math.fround(Math.fround(a[2]) * Math.fround(0.001) + Math.fround(ORIGIN)) };
}

// ---------- the close ground anywhere ----------
// The ladder draws the ground under it from `home` (the island the sim lives on) or, anywhere else, from a window of the planet's own ground tiles
// (groundwin.js) laid at the camera. The page says where its camera is and which it wants (a want); the worker makes the window (a few seconds the
// first time) and tells the page its frame and heights; the page puts its view in the new frame and names the ground in every frame after (its gid),
// and the first frame that names it is the one the renderer switches on (applyGround), so a frame is never drawn on ground its coordinates are not in.
let lastLut = null, lutShown = false;
let curGid = 0, gids = 0, prepared = null, switching = false, building = false, wantNow = null, wantSoon = null, home = null, curWin = null;
const winSpecs = new Map();
const winSpec = (cap) => {
  if (!winSpecs.has(cap)) winSpecs.set(cap, { cap, fields: { x: 0, y: 1, what: 2, size: 3, seed: 4, pick: 5 }, sizeMm: false, marks: false, ordered: false, indexed: true, canopy: true });
  return winSpecs.get(cap);
};
// The windows made, the last three kept (the one drawn, and two more a pan back or a zoom out and in finds made), with their ground and objects on the GPU. A window is
// found again by what it covers: the page's own test for a window's cover (the view's half extent in the window's metres and the place's distance from the window's
// centre, inside the window's half side less 600 m); one made within WIN_NEAR metres of the place asked for serves when the ask names no half extent.
const WIN_NEAR = 600, WIN_REACH = (256 * 75) / 2 - 600, WIN_KEEP = 3, winCache = [];
const arcOf = (a, b) => planet.radiusM * Math.acos(Math.min(1, Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((a.lon - b.lon) * Math.PI / 180) + Math.sin(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180)));
const winNear = (want) => {
  let best = null, bestD = Infinity;
  for (const w of winCache) {
    if (w.dead) continue;
    const d = arcOf(w, want);
    if ((want.half !== undefined ? d / w.scale + want.half <= WIN_REACH : d < WIN_NEAR) && d < bestD) { best = w; bestD = d; }
  }
  return best;
};
function destroyWindow(w) {
  w.dead = true;
  const pk = w.pack;
  pk.fine.gpu.destroy(); pk.grid.gpu.destroy(); pk.river.gpu.destroy();
  if (w.objectsValue) { w.objectsValue.body.destroy(); w.objectsValue.start.destroy(); }
}
function keepWindow(w) {
  w.pack.keep = true;
  winCache.push(w);
  while (winCache.length > WIN_KEEP) {
    const i = winCache.findIndex((x) => x !== curWin && x !== prepared?.win);
    if (i < 0) break;
    destroyWindow(winCache.splice(i, 1)[0]);
  }
}
// a window's objects arrive after its ground: until they do the source is an empty one of the smallest size
const EMPTY_CAP = 1 << 20;
let emptyObjects = null;
const emptyBody = () => (emptyObjects ??= { cap: EMPTY_CAP, body: buffer(new Uint32Array(7 * EMPTY_CAP)), start: buffer(new Uint32Array(256 * 256 + 1)) });
async function groundWant(m) {
  if (m.speculative) { if (!wantNow) wantSoon = m; } else wantNow = m;
  if (building || !planet?.wins || !S || !home) return;
  building = true;
  try {
    while (wantNow || wantSoon) {
      const want = wantNow ?? wantSoon, spec = !wantNow;
      if (spec) wantSoon = null; else wantNow = null;
      if (want.mode === "home") {
        if (!S.win && !prepared) continue;
        prepared = { gid: ++gids, mode: "home" };
        post({ type: "ground", gid: prepared.gid, mode: "home", frame: null, fields: home.fields });
        continue;
      }
      let w = winNear(want);
      // the window drawn already, or one on its way, is the answer to a repeated ask
      if (w && !spec && (w === curWin || w === prepared?.win)) continue;
      const fresh = !w;
      if (!w) {
        w = await planet.wins.build(want.lat, want.lon);
        keepWindow(w);
      }
      if (!spec) {
        prepared = { gid: ++gids, mode: "win", win: w };
        post({ type: "ground", gid: prepared.gid, mode: "win", frame: { c: w.c, e: w.e, n: w.n, scale: w.scale, rot: w.rot, id: w.id, lat: w.lat, lon: w.lon }, fields: w.fields, stats: { ...w.stats, id: w.id, objects: w.objectsValue?.n ?? null, share: w.objectsValue?.share ?? null } });
      }
      // a window made now has its objects made after its ground is out
      if (fresh) startObjects(w);
    }
  } catch (err) {
    console.error("window", err);
    post({ type: "windowError", error: String((err && err.stack) || err) });
  } finally { building = false; }
}
// the objects of a window (a promise of GPU buffers, groundwin.js startObjects): kept on the window, handed to the drawn source when they arrive, their size told to the page
function startObjects(w) {
  w.startObjects().then((o) => {
    w.objectsValue = o;
    if (w.dead) { o.body.destroy(); o.start.destroy(); return; }
    attachObjects(w);
    post({ type: "windowObjects", id: w.id, objects: o.n, share: o.share, ms: o.ms, estimate: o.estimate });
  }).catch((err) => { console.error("window objects", err); post({ type: "windowError", error: String((err && err.stack) || err) }); });
}
let applyMs = 0;
async function applyGround(p) {
  switching = true;
  const tApply = performance.now();
  try {
    if (p.mode === "win") {
      const w = p.win, o = w.objectsValue ?? emptyBody();
      S.win = { name: "win", cap: o.cap, body: o.body, start: o.start, spec: winSpec(o.cap) };
      curWin = w;
      await R.setSources(sources());
      R.setGround(w.pack);
      R.setIce(new Uint8Array(TILES * TILES));
    } else {
      S.win = null; curWin = null;
      await R.setSources(sources());
      R.setGround(home.pack);
      R.setIce(iceOf(sim.w.ice));
    }
    R.buildCanopy();
    R.farBuild(farLevels());
    curGid = p.gid;
    if (prepared === p) prepared = null;
    if (p.mode === "win") await surveyWindow();
  } finally { switching = false; applyMs = performance.now() - tApply; }
}
async function surveyWindow() {
  looks.addAll(await R.survey(0, 0, (CODES * CODES) / 32));
  R.setMeta(looks.meta());
  growTable();
  refreshSprites();
}
// the objects of the window drawn arrive: its source takes them in place of the empty one (a window not drawn takes them when it is)
async function attachObjects(w) {
  if (curWin !== w || !w.objectsValue) return;
  while (switching) await new Promise((r) => setTimeout(r, 5));
  if (curWin !== w || S.win?.body === w.objectsValue.body) return;
  switching = true;
  try {
    const o = w.objectsValue;
    S.win = { name: "win", cap: o.cap, body: o.body, start: o.start, spec: winSpec(o.cap) };
    await R.setSources(sources());
    R.buildCanopy();
    R.farBuild(farLevels());
    await surveyWindow();
  } catch (err) {
    console.error("window objects", err);
    post({ type: "windowError", error: String((err && err.stack) || err) });
  } finally { switching = false; }
}

// ---------- frames ----------
// The page's frame: views with their uniforms and live sprites by the page's sprite ids, which go into the dynamic
// layers the first time they come.
let pending = null, rendering = false, frames = 0, frontsSent = "";
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
  // a frame names the ground its view's coordinates are in: the one prepared is switched to when the page first sends it, and a frame of an earlier one is stale
  if (f.gid !== undefined && f.gid !== curGid) {
    if (prepared && f.gid === prepared.gid) {
      if (!switching) applyGround(prepared).then(() => render()).catch((err) => post({ type: "error", error: String((err && err.stack) || err) }));
      return;
    }
    pending = null;
    return;
  }
  if (R.busy >= 2) { setTimeout(render, 1); return; }
  pending = null;
  rendering = true;
  const t0 = performance.now();
  for (const s of f.sprites ?? []) liveSrc.set(s.id, s);
  // the planet layer maps its palette through the same light tables as the ladder (kept, for a layer made after the first frame)
  if (f.lut) lastLut = f.lut;
  if (f.lut || (lastLut && planetLayer && !lutShown)) { planetLayer?.setLut(lastLut); lutShown = !!planetLayer; }
  const views = f.views.map((v) => {
    const prims = v.prims ? Int32Array.from(v.prims) : null;
    // a sprite primitive names the page's sprite
    if (prims) for (let i = 0; i < prims.length; i += 8) if (prims[i] === 0) { const sp = liveId(prims[i + 3]); prims[i + 3] = sp ?? 0; if (sp === undefined) { prims[i] = 2; prims[i + 4] = 255; } }
    return { ...v, U: { ...v.U, gflags: !S?.win && trailQ?.size ? 1 : 0 }, live: v.live?.length ? liveInstances(v.live) : null, prims };
  });
  // the planet under the ladder's views, from the camera the page chose (live.js planetParams)
  const under = f.planet && planetLayer && ((enc, target) => {
    // the camera stands above the ground under its target, as drawn (lifted by the relief's exaggeration), never inside it
    const lift = (planetLift = Math.max(0, planet.pyramid.heightAt(planet.G.FRAMES, planet.G.fromLatLon((f.planet.lat * Math.PI) / 180, (f.planet.lon * Math.PI) / 180))) * f.exag);
    const cam = planetCam({ ...f.planet, w: canvas.width, h: canvas.height, radiusM: planetLayer.radiusM, lift });
    planetLayer.draw(enc, target, cam, { w: canvas.width, h: canvas.height, art: 2, sun: f.planet.sun, moon: f.planet.moon, moonMix: f.planet.moonMix, amb: f.planet.amb, exag: f.exag, riverCut: f.planet.riverCut });
  });
  R.frame({ ...f, views, under });
  frames++;
  const ms = performance.now() - t0;
  rendering = false;
  device.queue.onSubmittedWorkDone().then(() => {
    // the levels and bearings whose front lists are built, when they change (live.js listsReady)
    const fr = R.frontsReady().join(","), fronts = fr !== frontsSent ? fr : undefined;
    frontsSent = fr;
    post({ type: "frameDone", id: f.id, cpuMs: ms, gpuMs: R.stats.gpuMs, passes: R.stats.passes, counts: R.stats.counts, at: performance.now() - t0, fronts, lift: planetLift, applyMs, tiles: planet && { ...planet.pyramid.stats, held: planet.pyramid.held(), flying: planet.pyramid.flying() } });
    if (pending) render();
  });
}

const handle = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") await init(m);
    else if (m.type === "levels") levelsIn.resolve(m.levels);
    // the whole island at each level and bearing that keeps front lists (live.js islandView)
    else if (m.type === "frontViews") R.setFrontViews(m.views);
    else if (m.type === "frame") { pending = m; render(); }
    else if (m.type === "want") groundWant(m);
    else if (m.type === "simTick") await simTick(m.n);
    // asked in a tick's pause (sim.ts tickPause), answered with the state after it, as the world stands between ticks
    else if (m.type === "simWant") { want = m.want; if (!ticking) post({ type: "simState", ...answers() }); }
    else if (m.type === "pick") {
      const r = await R.pick(m.x, m.y);
      // an object's pick names the thing it is
      if (r && r.kind === 1 && S) r.id = await kindId(r.pick);
      post({ type: "pick", id: m.id, r });
    } else if (m.type === "check") post({ type: "check", id: m.id, r: await check(m.q) });
    else if (m.type === "resize") { canvas.width = m.W; canvas.height = m.H; }
  } catch (err) {
    post({ type: "error", error: String((err && err.stack) || err) });
  }
};
onmessage = handle;
for (const e of early.splice(0)) await handle(e);
