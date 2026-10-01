// Bake worker for the live renderer: grows the island once, builds one tile map per zoom level on demand, and paints
// chunks of the static landscape (terrain, the sim's objects, footpaths and ice) into indexed colour plus depth.
globalThis.document ??= { createElement: () => new OffscreenCanvas(1, 1) };
globalThis.ISO_LIB = true;
// messages that arrive while the modules below load would be dropped, so hold them until the handler exists
const early = [];
onmessage = (e) => early.push(e);

const { grow, noise } = await import("../world.js");
const { SIZE, TILE_M, TILES } = await import("../island.js");
const L = await import("./main.js");
const { P, SHADOW } = await import("./pal.js");
const { Buf, ObjBins, dith, shadowRows } = await import("./px.js");

let w = null;
// one view per level and bearing, least recently used first out: at most MAPS_KEPT island-wide maps and LEVELS_KEPT
// views in all, so touring every bearing and zoom cannot grow the worker
const levels = new Map(), MAPS_KEPT = 3, LEVELS_KEPT = 8;
// the live world, sent by the page whenever the sim changes it: its objects, worn paths and ice; realtime: the page
// lights the slopes and casts the shadows on the GPU for the hour, so the bake does neither; ao: and it takes the sky's
// light from the hollows (ambient occlusion), so the bake leaves the hollows alone
const D = { version: 0, objs: null, trail: null, ice: new Uint8Array(TILES * TILES), season: "spring", realtime: false, ao: false };

const SIM = TILE_M, SIM0 = -SIZE / 2;
const simTile = (x, z) => [Math.floor((x - SIM0) / SIM), Math.floor((z - SIM0) / SIM)];

function level(k, b) {
  const key = `${k}:${b}`;
  let lv = levels.get(key);
  if (lv) { levels.delete(key); levels.set(key, lv); return lv; }
  const t0 = performance.now();
  const V = L.makeLiveView(w, k, b);
  V.season = D.season;
  const M = V.paged ? null : L.buildMap(w, V);
  lv = { V, M, ms: performance.now() - t0 };
  levels.set(key, lv);
  const big = [...levels].filter(([, l]) => l.M);
  for (const [k2] of big.slice(0, Math.max(0, big.length - MAPS_KEPT))) levels.delete(k2);
  for (const k2 of [...levels.keys()].slice(0, Math.max(0, levels.size - LEVELS_KEPT))) levels.delete(k2);
  return lv;
}

function bake(msg) {
  const lv = level(msg.level, msg.bearing ?? 0), V = lv.V, CS = msg.CS, t0 = performance.now(), gx0 = msg.cx * CS, gy0 = msg.cy * CS;
  let M = lv.M, ground = null;
  // the season's snow goes into the map itself, so the map is built under this season
  V.season = D.season;
  L.setMode(V.view, 0);
  const tall = V.view === "island" ? 12 : Math.round(34 * V.k * 0.866 * V.treeK) + 8;
  if (!V.paged) L.chunkWindow(V, M.maxLev, gx0, gy0, CS, tall, tall * V.shx + 4);
  else {
    // a map of its own over the drawn tiles and every object that can reach in, with a margin wide enough that the
    // slope limiter and the shore and rock distances agree with the neighbouring chunks
    L.chunkWindow(V, L.liftInto(w, V, gy0, gx0, CS), gx0, gy0, CS, tall, tall * V.shx + 4);
    // wider toward the sun (low u, high v), so hills beyond the chunk still cast their shadows into it
    const draw = [V.i0, V.i1, V.j0, V.j1], [ou0, ou1, ov0, ov1] = V.obox, m = 14;
    V.i0 = Math.min(ou0, draw[0]) - m - 10; V.i1 = Math.max(ou1, draw[1]) + m; V.j0 = Math.min(ov0, draw[2]) - m; V.j1 = Math.max(ov1, draw[3]) + m + 4;
    V.NI = V.i1 - V.i0; V.NJ = V.j1 - V.j0;
    M = L.buildMap(w, V);
    [V.i0, V.i1, V.j0, V.j1] = draw;
    // the drawn tiles' corner levels, so the page can stand live sprites on the ground as drawn
    const gi0 = V.i0 - M.i0, gj0 = V.j0 - M.j0, gw = V.i1 - V.i0, gh = V.j1 - V.j0, C = new M.C.constructor(gw * gh * 4), diag = new Uint8Array(gw * gh), kind = new Uint8Array(gw * gh);
    for (let j = 0; j < gh; j++)
      for (let i = 0; i < gw; i++) {
        const t = (gj0 + j) * M.NI + gi0 + i, q = j * gw + i;
        C.set(M.C.subarray(t * 4, t * 4 + 4), q * 4); diag[q] = M.diag[t]; kind[q] = M.kind[t];
      }
    ground = { i0: V.i0, j0: V.j0, w: gw, h: gh, C, diag, kind };
  }
  V.trail = D.trail; V.season = D.season; V.realtime = D.realtime; V.aoGpu = D.realtime && D.ao;
  // the sim freezes whole 150 m tiles; between a frozen tile and an open one the ice edge wanders instead of ruling a line
  const ice = (tx, ty) => (tx >= 0 && ty >= 0 && tx < TILES && ty < TILES && D.ice[ty * TILES + tx] === 1 ? 1 : 0);
  V.iceAt = (x, z) => {
    const fx = (x - SIM0) / SIM - 0.5, fz = (z - SIM0) / SIM - 0.5, i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j;
    const v = (ice(i, j) * (1 - a) + ice(i + 1, j) * a) * (1 - b) + (ice(i, j + 1) * (1 - a) + ice(i + 1, j + 1) * a) * b;
    return v > 0.5 + noise(x / 40, z / 40, 77) * 0.3;
  };
  V.anim = new Map();
  // the consistency check reads what every pixel shows: its object's sim id, its ground class and world point
  V.debug = D.debug ? { cls: new Uint8Array(CS * CS), wx: new Float32Array(CS * CS), wz: new Float32Array(CS * CS) } : null;
  const B = new Buf(CS, CS), waterV = (V.waterV = new Uint8Array(CS * CS));
  // Beyond the map the sea runs on, deep and plain: at sea level (gy + z = 2H(u + v) with no height, so z = 3 gy), a tone
  // of 23/16 on the water ramp, which paints the same pixels as this dither.
  const DEEP = [P.w0, P.w1, P.w2, P.w3];
  for (let y = 0; y < CS; y++)
    for (let x = 0; x < CS; x++) { const p = y * CS + x; B.c[p] = dith(DEEP, 1.35, x + V.gx, y + V.gy); B.z[p] = 3 * (y + V.gy); waterV[p] = 24; }
  const O = L.collectLive(w, V, M, D);
  const t1 = performance.now();
  L.drawTerrainLive(B, w, V, M);
  const t2 = performance.now();
  // blit records each sprite pixel's column from its own anchor, a tent's pixels main.js MESH_PX: ids wrap past 65000
  // objects in a chunk, and the island levels' chunks hold more, so an anchor looked up by id could be another's
  B.ax = new Int16Array(CS * CS);
  L.drawObjects(B, V, O);
  const obj = new Uint8Array(CS * CS), ax = new Int8Array(CS * CS), tent = new Float32Array(65536).fill(NaN);
  // cast, when the GPU casts the sun: the rows of every shadow-casting sprite anchored in this chunk, whole, as px.js
  // shadowRows lists them; a tent pixel by pixel as drawn, at the height over its ground that its depth gives
  // (gy + z = 2H(u + v), and the depth carries the height)
  const rows = [];
  if (D.realtime)
    for (const o of O) {
      if (o.mesh) tent[o.lid] = o.base * V.lp;
      else if (o.shadow && o.sx >= 0 && o.sy >= 0 && o.sx < CS && o.sy < CS) shadowRows(o.spr, o.sx, o.sy, o.mirror, rows);
    }
  // 1: an object drew here, 2: ground already in shadow (so live sprite shadows do not darken it twice), 4: still open
  // water, its tone on the water ramp times 16 in ax. ax otherwise: a sprite pixel's column from its anchor, so a turn
  // can move it with its anchor and keep it upright; 0 on a tent, whose depth places each pixel where it stands.
  for (let p = 0; p < obj.length; p++) {
    const id = B.id[p], still = !id && !B.sh[p] && waterV[p] > 0;
    obj[p] = (id ? 1 : 0) | (B.sh[p] ? 2 : 0) | (still ? 4 : 0);
    if (still) ax[p] = waterV[p] - 1;
    if (!id) continue;
    const a = B.ax[p];
    if (a !== L.MESH_PX) { ax[p] = Math.max(-127, Math.min(127, a)); continue; }
    if (!Number.isNaN(tent[id])) {
      const x = p % CS, y = (p / CS) | 0, k = Math.round(0.25 * B.z[p] - 0.75 * (y + V.gy) - tent[id]);
      if (k >= 0) rows.push(2 * x + 1, y + k, 1, k);
    }
  }
  const casters = Int16Array.from(rows);
  // animated water and falls: only pixels still showing the ground; a sprite shadow cast later darkens every frame.
  // In pixel order, so the page can find a row's run of them by binary search.
  const aP = [], aC = [];
  for (const [p, cols] of [...V.anim].sort((a, b) => a[0] - b[0])) {
    if (B.id[p]) continue;
    const dark = B.c[p] !== cols[0] && B.sh[p];
    aP.push(p);
    for (const c of cols) aC.push(dark ? SHADOW[c] : c);
  }
  V.anim = null; V.waterV = null;
  let dbg = null;
  if (V.debug) {
    const byLid = new Map(), oid = new Uint32Array(CS * CS);
    for (const o of O) if (o.oid != null) byLid.set(o.lid, o.oid);
    for (let p = 0; p < oid.length; p++) oid[p] = byLid.get(B.id[p]) ?? 0;
    dbg = { ...V.debug, oid, drawn: O.filter((o) => o.oid != null).map((o) => [o.oid, o.ax, o.ay]) };
    V.debug = null;
  }
  const animP = Uint32Array.from(aP), animC = Uint8Array.from(aC);
  const moved = [B.c.buffer, B.z.buffer, obj.buffer, ax.buffer, casters.buffer, animP.buffer, animC.buffer];
  if (ground) moved.push(ground.C.buffer, ground.diag.buffer, ground.kind.buffer);
  V.trail = null; V.iceAt = null;
  postMessage({ type: "chunk", key: msg.key, ver: D.version, c: B.c, z: B.z, obj, ax, cast: casters, animP, animC, ground, dbg, ms: performance.now() - t0, parts: [t1 - t0, t2 - t1, performance.now() - t2], objects: O.length }, moved);
}

function mapData(k, b) {
  const { V, M, ms } = level(k, b);
  const head = { type: "map", level: k, bearing: b, ms, name: L.LADDER[k].name, view: V.view, NI: V.NI, NJ: V.NJ, tileM: V.tileM, H: V.H, W: V.W, lp: V.lp, levelM: V.levelM, exag: V.exag, k: V.k, shx: V.shx, shy: V.shy, treeK: V.treeK ?? 1, eu: V.eu, ev: V.ev, ox: V.ox, oz: V.oz };
  if (!M) { postMessage({ ...head, paged: true, maxLev: V.peakLev }); return; }
  const out = { ...head, maxLev: M.maxLev, C: M.C.slice(), diag: M.diag.slice(), kind: M.kind.slice() };
  postMessage(out, [out.C.buffer, out.diag.buffer, out.kind.buffer]);
}

// the page keeps the real queue, nearest chunk first, and hands each worker one job at a time
function run(m) {
  try {
    if (m.type === "bake") bake(m);
    else if (m.type === "map") mapData(m.level, m.bearing ?? 0);
    else if (m.type === "classify") {
      const V = level(5, 0).V, out = new Uint8Array(m.points.length / 2);
      for (let k = 0; k < out.length; k++) out[k] = L.surfaceAt(w, V, m.points[2 * k], m.points[2 * k + 1]);
      postMessage({ type: "classes", id: m.id, out });
    }
    else if (m.type === "heights") {
      // the true ground on a coarse grid, where the page stands sprites before their chunk is baked
      const n = Math.ceil(SIZE / m.step) + 1, h = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = Math.max(0, w.heightAt(SIM0 + i * m.step, SIM0 + j * m.step));
      postMessage({ type: "heights", n, step: m.step, h }, [h.buffer]);
    }
  } catch (e) {
    postMessage({ type: "error", key: m.key, error: String((e && e.stack) || e) });
  }
}

const handle = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    const t0 = performance.now();
    w = grow(m.seed);
    D.debug = !!m.debug; D.realtime = !!m.realtime; D.ao = !!m.ao;
    L.setLife(await import("./life.js").catch(() => ({})));
    L.setThings(await import("./things.js").catch((e) => (console.warn(`things.js not loaded: ${e.message}`), {})));
    postMessage({ type: "ready", ms: performance.now() - t0 });
    return;
  }
  if (m.type === "state") {
    D.version = m.version;
    if (m.objs) D.objs = new ObjBins(m.objs);
    if (D.objs && (m.up || m.rm)) {
      D.objs.kinds = m.kinds; D.objs.species = m.species;
      for (const id of m.rm || []) D.objs.drop(id);
      for (const r of m.up || []) D.objs.upsert(r);
    }
    if (m.trail) D.trail = m.trail;
    // a new season lays or melts snow, which the levels' maps hold
    if (m.season && m.season !== D.season) { D.season = m.season; levels.clear(); }
    if (m.trailUp && D.trail) for (let k = 0; k < m.trailUp.length; k += 2) { const i = m.trailUp[k], q = m.trailUp[k + 1]; if (q) D.trail.set(i, q); else D.trail.delete(i); }
    if (m.ice) D.ice = Uint8Array.from(m.ice);
    if (m.realtime != null) D.realtime = m.realtime;
    return;
  }
  run(m);
};
onmessage = handle;
for (const e of early.splice(0)) await handle(e);
