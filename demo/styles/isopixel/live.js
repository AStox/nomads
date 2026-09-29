// The live isopixel renderer: an orbiting camera with a continuous zoom over the whole island. Workers bake the static
// landscape in chunks of global art pixels, one chunk set per zoom level and 45 degree bearing. Every frame composes
// the visible chunks (colour and depth) of one or two levels or bearings, z-tests the live sim on top, animates water,
// fire and smoke on a real clock, relights the indexed palette for the time of day, and scales the art buffer to the
// exact zoom without losing its crisp pixels.
import { RGB, NCOL, P, GLOW, HAZE } from "./pal.js";
import { Buf, ObjBins, blit, castShadow, bayer, h2 } from "./px.js";
import * as SP from "./sprites.js";
import { text } from "./ui.js";

const CS = 256, SIM = 150, ORIGIN = -4800, DAY = 288, YEAR = DAY * 40, TAU = Math.PI * 2, NL = 9, NB = 8;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mod8 = (b) => ((Math.round(b) % NB) + NB) % NB;
const norm8 = (b) => { const r = ((b % NB) + NB) % NB; return r >= NB ? 0 : r; };
// Fire, its glow and its smoke column drawn larger than life, as the old sims do, so a camp shows from far out: art px
// at the tuned levels (island, region, valley, close); levels in between interpolate by art px per meter. Everything
// else is sized by its own meters.
const ANCHORS = [
  [0, { person: 3, fire: 2, glow: 3, smoke: 3 }],
  [3, { person: 5, fire: 4, glow: 6, smoke: 3 }],
  [5, { person: 9, fire: 6, glow: 12, smoke: 5 }],
  [8, { person: 24, fire: 14, glow: 30, smoke: 3 }],
];
// animal body size in meters: standing height, a bird's wingspan, a fish's length
const BODY = { deer: 1.5, wolf: 0.9, rabbit: 0.35, heron: 1, gull: 1.2, crow: 0.9, eagle: 2, fish: 0.5, butterfly: 0.1 };
const FLIERS = new Set(["heron", "gull", "crow", "eagle", "butterfly"]);
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const idH = (id, k) => h2(strHash(String(id)), k, 611);
const toM = (t) => t * SIM + ORIGIN;
const NOSHADOW = new Set(["ash", "pit", "trap", "fire", "clay", "stick"]);

export async function createLive({ seed = 1, canvas, onProgress, workers: nW, adjacent = true, check = false } = {}) {
  const TH = await import("./things.js").catch((e) => (console.warn(`things.js not loaded: ${e.message}`), {}));
  const n = nW ?? clamp((navigator.hardwareConcurrency || 4) - 2, 1, 3);
  const tStart = performance.now(), classWait = new Map();
  const pool = [], maps = new Map(), mapPending = new Map();
  const stats = { fps: 0, composeMs: 0, bakeQueue: 0, bakedChunks: 0, bakeMsAvg: 0, memMB: 0, firstFrameMs: 0, growMs: 0, mapMs: {}, workers: n, slots: 1 };
  let bakeN = 0, bakeSum = 0;
  const cache = new Map();
  let cacheBytes = 0, stateVer = 0, simRef = null, synced = false;
  const grounds = new Map();

  const onChunk = (wk, m) => {
    wk.busy = null;
    if (m.type === "error") { console.warn("bake error", m.error); const ch = cache.get(m.key); if (ch) { ch.failed = true; ch.pending = false; } return; }
    const ch = cache.get(m.key);
    if (!ch) return;
    if (ch.c) cacheBytes -= ch.bytes;
    dropGround(ch);
    if (m.ground) { m.ground.chunk = ch.key; (grounds.get(ch.mk) ?? grounds.set(ch.mk, []).get(ch.mk)).push(m.ground); }
    Object.assign(ch, { c: m.c, z: m.z, obj: m.obj, animP: m.animP, animC: m.animC, ground: m.ground, dbg: m.dbg, ver: m.ver, pending: false, bytes: m.c.length * 6 + m.animC.length + m.animP.length * 4 + (m.ground ? m.ground.C.byteLength + m.ground.diag.length * 2 : 0) });
    cacheBytes += ch.bytes;
    bakeN++; bakeSum += m.ms;
    stats.bakedChunks++; stats.bakeMsAvg = bakeSum / bakeN;
    if ((stats.bakeLog ??= []).length < 200) stats.bakeLog.push(Math.round(m.ms));
  };
  const dropGround = (ch) => {
    if (!ch.ground) return;
    const list = grounds.get(ch.mk), i = list ? list.indexOf(ch.ground) : -1;
    if (i >= 0) list.splice(i, 1);
    ch.ground = null;
  };
  await new Promise((done, fail) => {
    let ready = 0;
    for (let k = 0; k < n; k++) {
      const ex = new URLSearchParams(location.search).get("exag"), wk = new Worker(new URL(`./bake.js${ex ? `?exag=${encodeURIComponent(ex)}` : ""}`, import.meta.url), { type: "module" });
      wk.onerror = (e) => fail(new Error(`bake worker: ${e.message}`));
      wk.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") { stats.growMs = Math.max(stats.growMs, m.ms); if (++ready === n) done(); onProgress?.(ready, n, "growing the island"); }
        else if (m.type === "map") onMap(m);
        else if (m.type === "heights") onHeights?.(m);
        else if (m.type === "classes") classWait.get(m.id)?.(m.out);
        else onChunk(wk, m);
      };
      wk.postMessage({ type: "init", seed, debug: check });
      pool.push(wk);
    }
  });

  // ---------- maps: a level at a bearing ----------
  const mk = (L, b) => `${L}:${b}`;
  function onMap(m) {
    const key = mk(m.level, m.bearing);
    maps.set(key, prepMap(m));
    stats.mapMs[key] = Math.round(m.ms);
    const p = mapPending.get(key);
    mapPending.delete(key);
    p?.();
  }
  // every level of one bearing, the island levels built by the workers, the paged ones only their parameters
  function requestMaps(b) {
    const out = [];
    for (let L = 0; L < NL; L++) {
      const key = mk(L, b);
      if (maps.has(key)) continue;
      if (!mapPending.has(key)) {
        out.push(new Promise((r) => mapPending.set(key, r)));
        pool[(L + b) % n].postMessage({ type: "map", level: L, bearing: b });
      }
    }
    return Promise.all(out);
  }
  const mapsFor = (b) => { for (let L = 0; L < NL; L++) if (!maps.has(mk(L, b))) { requestMaps(b); return false; } return true; };
  function prepMap(m) {
    const md = { ...m, key: mk(m.level, m.bearing), L: m.level, b: m.bearing, hb: m.H * 0.5, isle: m.view === "island", p: m.H / m.tileM };
    md.tall = md.isle ? 12 : Math.round(34 * m.k * 0.866 * m.treeK) + 8;
    const { eu, ev, ox, oz, tileM } = m;
    md.uv = (x, z) => { const dx = x - ox, dz = z - oz; return [(dx * eu[0] + dz * eu[1]) / tileM, (dx * ev[0] + dz * ev[1]) / tileM]; };
    md.world = (u, v) => [ox + (u * eu[0] + v * ev[0]) * tileM, oz + (u * eu[1] + v * ev[1]) * tileM];
    // world direction to tile-axis direction, for facing and wind
    md.dir = (dx, dz) => [dx * eu[0] + dz * eu[1], dx * ev[0] + dz * ev[1]];
    const tri = (C, q, fu, fv, diag) => {
      const T = C[q * 4], R = C[q * 4 + 1], B = C[q * 4 + 2], L = C[q * 4 + 3];
      if (diag === 0) return fu >= fv ? T + (R - T) * fu + (B - R) * fv : T + (B - L) * fu + (L - T) * fv;
      return fu + fv <= 1 ? T + (R - T) * fu + (L - T) * fv : R + L - B + (B - L) * fu + (B - R) * fv;
    };
    if (!m.paged) {
      const { NI, NJ, C, diag } = m;
      md.ground = (u, v) => {
        const i = Math.floor(u), j = Math.floor(v);
        if (i < 0 || j < 0 || i >= NI || j >= NJ) return 0;
        const t = j * NI + i;
        return tri(C, t, u - i, v - j, diag[t]);
      };
      md.water = (u, v) => { const i = Math.floor(u), j = Math.floor(v); return i < 0 || j < 0 || i >= NI || j >= NJ || m.kind[j * NI + i] !== 0; };
      return md;
    }
    // Paged levels have no map of their own: sprites stand on the corner levels each baked chunk sends back, and on
    // the finest island map's ground, converted, where nothing is baked yet.
    let hit = null;
    const table = (u, v) => {
      const i = Math.floor(u), j = Math.floor(v), ok = (g) => g && i >= g.i0 && j >= g.j0 && i < g.i0 + g.w && j < g.j0 + g.h;
      if (!ok(hit)) hit = grounds.get(md.key)?.find(ok) ?? null;
      return hit ? [hit, (j - hit.j0) * hit.w + (i - hit.i0)] : null;
    };
    const coarse = (u, v) => { const cm = maps.get(mk(2, m.bearing)); if (!cm) return null; const k = m.tileM / cm.tileM; return [cm, u * k, v * k]; };
    md.ground = (u, v) => {
      const tb = table(u, v);
      if (tb) return tri(tb[0].C, tb[1], u - Math.floor(u), v - Math.floor(v), tb[0].diag[tb[1]]);
      return heightM(...md.world(u, v)) / m.levelM;
    };
    md.water = (u, v) => { const tb = table(u, v); if (tb) return tb[0].kind[tb[1]] !== 0; const c = coarse(u, v); return c ? c[0].water(c[1], c[2]) : false; };
    return md;
  }
  let onHeights = null;
  const HG = await new Promise((r) => { onHeights = r; pool[0].postMessage({ type: "heights", step: 25 }); });
  const heightM = (x, z) => {
    const fx = clamp((x + 4800) / HG.step, 0, HG.n - 1.001), fz = clamp((z + 4800) / HG.step, 0, HG.n - 1.001), i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, k = j * HG.n + i, h = HG.h;
    return (h[k] * (1 - a) + h[k + 1] * a) * (1 - b) + (h[k + HG.n] * (1 - a) + h[k + HG.n + 1] * a) * b;
  };
  await requestMaps(0);
  onProgress?.(1, 1, "building the map");
  const PL = Array.from({ length: NL }, (_, L) => maps.get(mk(L, 0)).p);
  // screen px a meter of height rises, per screen px per meter across; the maps' levelM carries EXAG
  const VK = maps.get(mk(0, 0)).lp / (maps.get(mk(0, 0)).levelM * PL[0]);
  // one camera height for all levels: ground blurred 300 m or more, until VK * sqrt2 * |grad| <= 0.5 keeps solves well posed
  const CH = Float32Array.from(HG.h);
  {
    const n = HG.n, r = Math.round(150 / HG.step), tmp = new Float32Array(n * n);
    const steep = () => {
      let g = 0;
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const k = j * n + i; g = Math.max(g, Math.hypot(CH[k + 1] - CH[k], CH[k + n] - CH[k])); }
      return (g / HG.step) * VK * Math.SQRT2;
    };
    let pass = 0;
    for (; pass < 2 || (pass < 64 && steep() > 0.5); pass++)
      for (const [src, dst, di, dj] of [[CH, tmp, 1, n], [tmp, CH, n, 1]])
        for (let j = 0; j < n; j++) {
          let a = 0, c = 0;
          for (let q = 0; q <= r && q < n; q++) { a += src[j * dj + q * di]; c++; }
          for (let i = 0; i < n; i++) {
            dst[j * dj + i * di] = a / c;
            if (i + r + 1 < n) { a += src[j * dj + (i + r + 1) * di]; c++; }
            if (i - r >= 0) { a -= src[j * dj + (i - r) * di]; c--; }
          }
        }
    stats.camHeight = { passes: pass, steep: +steep().toFixed(3) };
  }
  const camHg = (x, z) => {
    const n = HG.n, fx = clamp((x + 4800) / HG.step, 0, n - 1.001), fz = clamp((z + 4800) / HG.step, 0, n - 1.001), i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, k = j * n + i;
    const h00 = CH[k], h10 = CH[k + 1], h01 = CH[k + n], h11 = CH[k + n + 1];
    return [(h00 * (1 - a) + h10 * a) * (1 - b) + (h01 * (1 - a) + h11 * a) * b, ((h10 - h00) * (1 - b) + (h11 - h01) * b) / HG.step, ((h01 - h00) * (1 - a) + (h11 - h10) * a) / HG.step];
  };
  const camH = (x, z) => camHg(x, z)[0];
  // zoom: log2 of screen px per meter over the island seen at 2 screen px per art px
  const PPM0 = 2 * PL[0], ppmOf = (z) => PPM0 * 2 ** z, ZMAX = Math.log2((4 * PL[NL - 1]) / PPM0);
  const named = { island: 0, region: Math.log2((2 * PL[3]) / PPM0), valley: Math.log2((2 * PL[5]) / PPM0), close: Math.log2((2 * PL[8]) / PPM0) };
  // the level drawn at a zoom: the coarsest one still at 2 screen px or more per art px, and how far along its range
  function levelFor(zoom) {
    const ppm = ppmOf(clamp(zoom, 0, ZMAX));
    let L = 0;
    while (L < NL - 1 && 2 * PL[L + 1] <= ppm * 1.000001) L++;
    const s = ppm / PL[L], t = L < NL - 1 ? Math.log(s / 2) / Math.log(PL[L + 1] / PL[L]) : 0;
    return { L, s, t, ppm };
  }
  const SIZES = PL.map((p) => {
    const lp = Math.log(p), A = ANCHORS.map(([L, v]) => [Math.log(PL[L]), v]);
    let k = 0;
    while (k < A.length - 2 && lp > A[k + 1][0]) k++;
    const [a0, v0] = A[k], [a1, v1] = A[k + 1], f = clamp((lp - a0) / (a1 - a0), 0, 1), out = {};
    for (const key of Object.keys(v0)) {
      const x = v0[key], y = v1[key];
      out[key] = Math.round(x * (y / x) ** f);
    }
    return out;
  });

  // ---------- chunk scheduling ----------
  const keyOf = (L, b, cx, cy) => `${L}:${b}:${cx},${cy}`;
  function want(md, cx, cy, prio, list) {
    const key = keyOf(md.L, md.b, cx, cy);
    let ch = cache.get(key);
    if (!ch) {
      // the world rectangle the chunk can show, for marking it stale when the sim changes the ground there
      const a0 = (cx * CS) / md.H - 2, a1 = ((cx + 1) * CS + md.tall * Math.abs(md.shx)) / md.H + 2, b0 = (cy * CS - md.tall) / md.hb - 3, b1 = ((cy + 1) * CS + md.maxLev * md.lp) / md.hb + 3;
      const cs = [[a0, b0], [a1, b0], [a0, b1], [a1, b1]].map(([a, bb]) => md.world((a + bb) / 2, (bb - a) / 2)), xs = cs.map((c) => c[0]), zs = cs.map((c) => c[1]);
      ch = { key, mk: md.key, L: md.L, b: md.b, cx, cy, ver: -1, need: 0, pending: false, box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] };
      cache.set(key, ch);
    }
    ch.used = performance.now();
    if (ch.failed || ch.pending) return ch;
    if (!ch.c || ch.ver < ch.need) list.push([prio, ch]);
    return ch;
  }
  function rectOf(cam) {
    return [Math.floor(cam.gx0 / CS), Math.floor((cam.gx0 + cam.AW - 1) / CS), Math.floor(cam.gy0 / CS), Math.floor((cam.gy0 + cam.AH - 1) / CS)];
  }
  function wantView(cam, base, list, visible, ring) {
    if (!cam) return;
    const [cx0, cx1, cy0, cy1] = rectOf(cam), mid = [(cam.gx0 + cam.AW / 2) / CS - 0.5, (cam.gy0 + cam.AH / 2) / CS - 0.5], r = ring ? 1 : 0;
    for (let cy = cy0 - r; cy <= cy1 + r; cy++)
      for (let cx = cx0 - r; cx <= cx1 + r; cx++) {
        const inside = cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1, d = Math.hypot(cx - mid[0], cy - mid[1]);
        const ch = want(cam.md, cx, cy, (inside ? base : base + 60) + d, list);
        if (inside) visible.add(ch.key);
      }
  }
  const camReady = (cam) => {
    if (!cam) return false;
    const [cx0, cx1, cy0, cy1] = rectOf(cam);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (!cache.get(keyOf(cam.md.L, cam.md.b, cx, cy))?.c) return false;
    return true;
  };
  // share of a view's chunks already baked, at the level its zoom shows and the bearing it faces
  function readiness(view, bearing) {
    const cam = camera(view, levelFor(view.zoom).L, mod8(bearing ?? view.bearing ?? 0));
    if (!cam) return { done: 0, all: 1, ready: false };
    const [cx0, cx1, cy0, cy1] = rectOf(cam);
    let done = 0, all = 0;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) { all++; if (cache.get(keyOf(cam.md.L, cam.md.b, cx, cy))?.c) done++; }
    return { done, all, ready: done === all };
  }
  let prefetchViews = [], settled = false;
  function dispatch(list) {
    list.sort((a, b) => a[0] - b[0]);
    stats.bakeQueue = list.length;
    for (const wk of pool) {
      if (wk.busy) continue;
      const next = list.shift();
      if (!next) break;
      const ch = next[1];
      ch.pending = true; wk.busy = ch.key;
      wk.postMessage({ type: "bake", level: ch.L, bearing: ch.b, cx: ch.cx, cy: ch.cy, CS, key: ch.key });
    }
  }
  const keep = new Set();
  let pruned = 0;
  function evict(visible) {
    const cap = 75e6, now = performance.now();
    // entries wanted once and never baked would otherwise pile up over a long session
    if (now - pruned > 5000) { pruned = now; for (const [k, c] of cache) if (!c.c && !c.pending && !visible.has(k) && now - c.used > 20000) cache.delete(k); }
    if (cacheBytes < cap) return;
    const list = [...cache.values()].filter((c) => c.c && !visible.has(c.key) && !keep.has(c.key)).sort((a, b) => a.used - b.used);
    for (const c of list) {
      if (cacheBytes < cap * 0.85) break;
      cacheBytes -= c.bytes;
      dropGround(c);
      cache.delete(c.key);
    }
  }

  // ---------- the sim's objects ----------
  // Most are baked into the chunks from a binned copy each worker keeps; the kinds that change often draw every frame.
  let bins = null;
  const liveThings = new Map();
  const isLive = (t) => ObjBins.LIVE.has(t.kind) || t.burning > 0;
  const numId = (id) => +String(id).slice(1);
  function postState(msg) {
    stateVer++;
    for (const wk of pool) wk.postMessage({ type: "state", version: stateVer, ...msg });
  }
  function sync(sim) {
    const W = sim.w, o = sim.objects();
    bins = new ObjBins(o);
    liveThings.clear();
    for (const t of W.things) if (!t.contained && isLive(t)) liveThings.set(t.id, t);
    lastIce = iceFlags(W.ice);
    trailSrc = sim.trails?.() ?? null;
    trailQ = trailSrc ? Uint8Array.from(trailSrc.wear, wearStep) : null;
    season = sim.clock?.().season ?? "spring";
    postState({ objs: o, trail: trailQ, ice: lastIce, season });
    // everything baked so far was baked without the sim's objects
    for (const ch of cache.values()) ch.need = stateVer;
    synced = true;
  }
  const iceFlags = (ice) => { const f = new Array(4096).fill(0); if (ice) for (const i of ice) f[i] = 1; return f; };
  // mark every cached chunk that can show part of a world rectangle as stale; it keeps showing until the rebake lands.
  // With an object's size, only the levels that draw it at a pixel or more.
  function dirty(x0, z0, x1, z1, size) {
    for (const ch of cache.values()) {
      if (ch.L === 0 && size == null) continue;
      const [a, b, c, d] = ch.box;
      if (a > x1 || c < x0 || b > z1 || d < z0) continue;
      if (size != null) { const md = maps.get(ch.mk); if (md && ObjBins.shown(size) * md.k * 0.866 * md.treeK < 1) continue; }
      ch.need = stateVer;
    }
  }
  function changed(ch) {
    if (!ch || !simRef) return;
    if (!synced) { sync(simRef); return; }
    const W = simRef.w, up = [], rm = [], touched = [];
    const gone = (id) => { const old = bins.get(id); if (old) { bins.drop(id); rm.push(id); touched.push(old); } };
    for (const t of ch.things || []) {
      const id = numId(t.id);
      if (t.contained || isLive(t)) {
        if (t.contained) liveThings.delete(t.id); else liveThings.set(t.id, t);
        gone(id);
        continue;
      }
      liveThings.delete(t.id);
      const r = bins.recOf(t), old = bins.get(id);
      if (old && old.kind === r.kind && old.sp === r.sp && old.px === r.px && old.py === r.py && old.size === r.size && old.seed === r.seed && (old.n > 0) === (r.n > 0)) continue;
      if (old) touched.push(old);
      bins.upsert(r); up.push(r); touched.push(r);
    }
    for (const sid of ch.removed || []) { liveThings.delete(sid); gone(numId(sid)); }
    const msg = {};
    if (up.length || rm.length) Object.assign(msg, { up, rm, kinds: bins.kinds, species: bins.species });
    if (trailQ && ch.trails) for (const i of ch.trails) trailPending.add(i);
    // wear changes every tick; only a change of drawn width counts, and the rebakes for it go out every few seconds
    const now = performance.now();
    if (trailPending.size && now - trailFlush > 4000) {
      trailFlush = now;
      const up = [];
      for (const i of trailPending) { const q = wearStep(trailSrc.wear[i]); if (q !== trailQ[i]) { trailQ[i] = q; up.push(i, q); } }
      trailPending.clear();
      if (up.length) { msg.trailUp = Int32Array.from(up); trailTouched = up; }
    }
    const iceDiff = [];
    if (ch.ice) {
      const iceNow = iceFlags(W.ice);
      for (let i = 0; i < 4096; i++) if (iceNow[i] !== lastIce[i]) iceDiff.push(i);
      lastIce = iceNow;
      msg.ice = iceNow;
    }
    // the ground's colour follows the season, so a new season rebakes whatever is cached as it is next shown
    const sn = simRef.clock?.().season;
    if (sn && sn !== season) { season = sn; msg.season = sn; }
    if (!Object.keys(msg).length) return;
    postState(msg);
    if (msg.season) for (const c of cache.values()) c.need = stateVer;
    // a tall thing reaches up the screen and casts a shadow, so its box is as wide as it is tall
    for (const r of touched) { const x = toM(r.px), z = toM(r.py), R = Math.max(2, r.size) + 3; dirty(x - R, z - R, x + R, z + R, r.size); }
    if (msg.trailUp) for (let k = 0; k < trailTouched.length; k += 2) {
      const i = trailTouched[k], x = ((i % TRAIL_N) + 0.5) * TRAIL_C - 4800, z = (Math.floor(i / TRAIL_N) + 0.5) * TRAIL_C - 4800;
      dirty(x - 5, z - 5, x + 5, z + 5);
    }
    for (const i of iceDiff) {
      const tx = i % 64, ty = (i / 64) | 0;
      dirty(ORIGIN + SIM * (tx - 1), ORIGIN + SIM * (ty - 1), ORIGIN + SIM * (tx + 2), ORIGIN + SIM * (ty + 2));
    }
  }
  let lastIce = new Array(4096).fill(0), season = "spring";
  // the sim's footpath wear, stepped into the five widths the bake draws
  const TRAIL_C = 3, TRAIL_N = 3200, wearStep = (v) => (v < 2 ? 0 : v < 5 ? 1 : v < 12 ? 2 : v < 30 ? 3 : 4);
  let trailSrc = null, trailQ = null, trailFlush = 0, trailTouched = [];
  const trailPending = new Set();

  // ---------- cameras and compose slots ----------
  const sprites = new Map();
  // sprite keys follow continuous sizes, so the cache is emptied now and then rather than left to grow for a session
  const spr = (key, make) => { let s = sprites.get(key); if (s === undefined) { if (sprites.size > 3000) sprites.clear(); s = make() || null; sprites.set(key, s); } return s; };
  let frames = 0, fpsT = performance.now(), lastPick = [], pickCam = null, pickSlot = null, pickTurn = 0, firstFrame = true, lastLut = null, lastLutKey = "";
  const facingMem = new Map();
  // owners[id]: the pick ({ kind, id }) of whatever drew sprite id `id` into the id buffer of the slot being composed
  let B = null, light = null, owners = [];

  function project(md, x, z) {
    const [u, v] = md.uv(x, z), lev = md.ground(u, v);
    return { u, v, lev, gx: (u - v) * md.H, gy: (u + v) * md.hb - lev * md.lp, cz: 1.5 * md.H * (u + v) + lev * md.lp, water: md.water(u, v) };
  }
  // A camera at one level and bearing: the art buffer covering the canvas at this zoom (grown by ex, ey when it will be
  // turned), and where its top-left pixel lands on the canvas.
  function camera(view, L, b, ex = 1, ey = 1) {
    const md = maps.get(mk(L, b));
    if (!md) return null;
    // the target stands on the one smooth camera height plus view.up; a level only snaps it to its own pixel grid
    const s = ppmOf(clamp(view.zoom, 0, ZMAX)) / md.p, [u, v] = md.uv(view.x, view.z), lev = (camH(view.x, view.z) + (view.up || 0)) / md.levelM;
    const W = canvas.width, H = canvas.height, gcx = (u - v) * md.H, gcy = (u + v) * md.hb - lev * md.lp;
    const AW = Math.ceil((W * ex) / s) + 4, AH = Math.ceil((H * ey) / s) + 4, gx0 = Math.floor(gcx - AW / 2), gy0 = Math.floor(gcy - AH / 2);
    return { view, md, L, b, s, AW, AH, gcx, gcy, gx0, gy0, lev, dx: W / 2 + (gx0 - gcx) * s, dy: H / 2 + (gy0 - gcy) * s };
  }
  let slots = [], capW = 0, capH = 0;
  function ensureSlots() {
    const W = canvas.width, H = canvas.height, cw = Math.ceil(W / 1.25) + 8, chh = Math.ceil(H / 1.25) + 8;
    if (cw === capW && chh === capH) return;
    capW = cw; capH = chh;
    const cap = cw * chh;
    // each slot has its own upscale canvas: reusing one within a frame makes the browser copy it before the redraw
    slots = [0, 1].map(() => {
      const mid = new OffscreenCanvas(Math.ceil(W * 2.2) + 24, Math.ceil(H * 2.2) + 24);
      return { c: new Uint8Array(cap), z: new Float32Array(cap), id: new Uint16Array(cap), sh: new Uint8Array(cap), light: new Uint8Array(cap), rgba: new ArrayBuffer(cap * 4), off: new OffscreenCanvas(cw, chh), mid, midG: mid.getContext("2d") };
    });
  }
  const viewOf = (sl, w, h) => ({ w, h, c: sl.c.subarray(0, w * h), z: sl.z.subarray(0, w * h), id: sl.id.subarray(0, w * h), sh: sl.sh.subarray(0, w * h), light: sl.light.subarray(0, w * h) });

  function compose(sl, cam, now, sim, clock, view) {
    const { md, AW, AH, gx0, gy0 } = cam;
    B = viewOf(sl, AW, AH); light = B.light; owners = sl.owners = [null, null];
    const fr = Math.floor(now / 160) & 7;
    B.c.fill(P.w1); B.z.fill(-1e30); B.id.fill(0); B.sh.fill(0); light.fill(0);
    let holes = false;
    const [cx0, cx1, cy0, cy1] = rectOf(cam);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const ch = cache.get(keyOf(md.L, md.b, cx, cy)), ox = cx * CS - gx0, oy = cy * CS - gy0;
        const x0 = Math.max(0, ox), x1 = Math.min(AW, ox + CS), y0 = Math.max(0, oy), y1 = Math.min(AH, oy + CS);
        if (!ch?.c) { holes = true; fallback(cam, x0, x1, y0, y1); continue; }
        for (let y = y0; y < y1; y++) {
          const src = (y - oy) * CS + (x0 - ox), dst = y * AW + x0, len = x1 - x0;
          B.c.set(ch.c.subarray(src, src + len), dst);
          B.z.set(ch.z.subarray(src, src + len), dst);
          B.id.set(ch.obj.subarray(src, src + len), dst);
        }
        const aP = ch.animP, aC = ch.animC;
        for (let i = 0; i < aP.length; i++) {
          const p = aP[i], x = (p % CS) + ox, y = ((p / CS) | 0) + oy;
          if (x >= 0 && y >= 0 && x < AW && y < AH) B.c[y * AW + x] = aC[i * 8 + fr];
        }
      }
    for (let p = 0; p < B.id.length; p++) if (B.id[p] === 2) { B.id[p] = 0; B.sh[p] = 1; } else if (B.id[p] === 3) { B.id[p] = 1; }
    const night = clamp(clock.night ?? 0, 0, 1);
    let picks = [];
    if (sim) {
      const E = entities(cam, sim, now);
      E.out.sort((a, b) => a.z - b.z);
      for (const o of E.out) if (o.shadow && night < 0.6) castShadow(B, o.spr, o.sx, o.sy, md.shx, md.shy, o.mirror);
      let id = 2;
      for (const o of E.out) { o.id = id++; owners[o.id] = o.pick ?? null; blit(B, o.spr, o.sx, o.sy, o.z, o.id, o.mirror, o.bias); }
      // people behind trees still show, as a checkered silhouette through the leaves
      for (const o of E.out) if (o.xray) xray(o);
      drawFires(cam, E.fires, now, night);
      picks = E.picks;
      if (view.selected) markSelected(cam, view.selected, picks);
    }
    haze(cam, clock.hour ?? 8);
    // indexed colour to RGBA through the time-of-day table; the light buffer picks the fire-lit copy
    const lut = lutFor(clock.hour ?? 8), c = B.c, out = new Uint32Array(sl.rgba, 0, AW * AH);
    for (let p = 0; p < c.length; p++) out[p] = lut[light[p] * NCOL + c[p]];
    sl.off.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(sl.rgba, 0, AW * AH * 4), AW, AH), 0, 0);
    return { holes, picks };
  }
  // a missing chunk shows the coarser levels of the same bearing blown up around the camera centre
  function fallback(cam, x0, x1, y0, y1) {
    for (let k = cam.L - 1; k >= 0; k--) {
      const cc = camera(cam.view, k, cam.b);
      if (!cc) continue;
      const s = cc.md.p / cam.md.p;
      // skip a level with nothing baked under this hole, rather than walking every pixel to find that out
      const gx0 = Math.floor(cc.gcx + (cam.gx0 + x0 - cam.gcx) * s), gx1 = Math.floor(cc.gcx + (cam.gx0 + x1 - cam.gcx) * s);
      const gy0 = Math.floor(cc.gcy + (cam.gy0 + y0 - cam.gcy) * s), gy1 = Math.floor(cc.gcy + (cam.gy0 + y1 - cam.gcy) * s);
      let any = false;
      for (let cy = Math.floor(gy0 / CS); cy <= Math.floor(gy1 / CS) && !any; cy++)
        for (let cx = Math.floor(gx0 / CS); cx <= Math.floor(gx1 / CS); cx++) if (cache.get(keyOf(k, cam.b, cx, cy))?.c) { any = true; break; }
      if (!any) continue;
      let missing = false, lcx = NaN, lcy = NaN, ch = null;
      for (let y = y0; y < y1; y++) {
        const gy = Math.floor(cc.gcy + (cam.gy0 + y - cam.gcy) * s), cy = Math.floor(gy / CS), ry = (gy - cy * CS) * CS;
        for (let x = x0; x < x1; x++) {
          const p = y * cam.AW + x;
          if (B.z[p] === -2e30) continue;
          const gx = Math.floor(cc.gcx + (cam.gx0 + x - cam.gcx) * s), cx = Math.floor(gx / CS);
          if (cx !== lcx || cy !== lcy) { lcx = cx; lcy = cy; ch = cache.get(keyOf(k, cam.b, cx, cy)); }
          if (!ch?.c) { missing = true; continue; }
          B.c[p] = ch.c[ry + gx - cx * CS];
          B.z[p] = -2e30;
        }
      }
      if (!missing) break;
    }
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = y * cam.AW + x; if (B.z[p] === -2e30) B.z[p] = -1e30; }
  }
  // The composed art buffer onto the canvas at the exact zoom: nearest neighbour up to the next whole factor, then one
  // smoothed step down, so pixels stay crisp and never shimmer. T turns the ground plane about the canvas centre.
  function present(g, sl, cam, alpha, turn) {
    const w = cam.AW, h = cam.AH, s = cam.s, n = Math.max(1, Math.ceil(s - 1e-3)), W = canvas.width, H = canvas.height;
    g.globalAlpha = alpha;
    if (turn) {
      // the ground plane turned by `turn` steps in tile space, seen through the 2:1 projection
      const a = (-turn * Math.PI) / 4, c = Math.cos(a), sn = Math.sin(a), A = c, Bt = sn / 2, Ct = -2 * sn, Dt = c;
      g.setTransform(A, Bt, Ct, Dt, W / 2 - (A * W) / 2 - (Ct * H) / 2, H / 2 - (Bt * W) / 2 - (Dt * H) / 2);
    } else g.setTransform(1, 0, 0, 1, 0, 0);
    // turned, the frame is already moving and sheared: one nearest-neighbour draw keeps the pixels hard and costs a third
    if (turn || Math.abs(s - n) < 1e-3) {
      g.imageSmoothingEnabled = false;
      g.drawImage(sl.off, 0, 0, w, h, cam.dx, cam.dy, w * s, h * s);
    } else {
      sl.midG.imageSmoothingEnabled = false;
      sl.midG.drawImage(sl.off, 0, 0, w, h, 0, 0, w * n, h * n);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "low";
      g.drawImage(sl.mid, 0, 0, w * n, h * n, cam.dx, cam.dy, w * s, h * s);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
  }
  // how much bigger the buffer must be so a turn of `turn` steps still covers the canvas
  const grow = (turn) => {
    if (!turn) return [1, 1];
    const a = (turn * Math.PI) / 4, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a)), W = canvas.width, H = canvas.height;
    return [(c * W + 2 * sn * H) / W + 0.02, ((sn / 2) * W + c * H) / H + 0.02];
  };

  // ---------- live sprites ----------
  const clothOf = (color) => { const k = ["#9e3b2f", "#2f4a6d", "#a8812a", "#4e6b3a", "#6b3f5e"].indexOf(String(color).toLowerCase()); return P["c" + (k >= 0 ? k : strHash(String(color)) % 5)]; };
  function facingOf(id, du, dv) {
    if (du || dv) {
      const toCam = du + dv, across = du - dv;
      facingMem.set(id, { facing: Math.abs(across) > Math.abs(toCam) * 1.3 ? "side" : toCam > 0 ? "front" : "back", across });
    }
    return facingMem.get(id) ?? { facing: "front", across: 1 };
  }
  // where a sim agent, animal or thing is right now in world meters, between its last two ticks, and its last step
  function motion(id, sim) {
    const q = sim.pos?.(id);
    if (!q) return null;
    const al = clamp(sim.alpha ?? 1, 0, 1), dx = (q.px - q.ppx) * SIM, dz = (q.py - q.ppy) * SIM;
    return { x: toM(q.ppx) + dx * al, z: toM(q.ppy) + dz * al, dx, dz, moving: dx !== 0 || dz !== 0 };
  }
  function entities(cam, sim, now) {
    const W = sim.w, md = cam.md, sz = SIZES[md.L], isle = md.isle, out = [], fires = [], picks = [];
    const pv = md.k * 0.866 * md.treeK;
    const at = (x, z) => { const p = project(md, x, z); return { ...p, sx: Math.round(p.gx - cam.gx0), sy: Math.round(p.gy - cam.gy0) }; };
    const onScreen = (a, m = 40) => a.sx > -m && a.sy > -m && a.sx < cam.AW + m && a.sy < cam.AH + m * 2;
    // footprint sprites anchor below their footprint centre; small people stand two pixels high in their sprite
    const add = (a, s, o = {}) => { if (s) out.push({ z: o.z ?? a.cz, sx: a.sx, sy: a.sy + (s.foot || 0) + (o.lift || 0), spr: s, mirror: !!o.mirror, bias: o.bias ?? md.hb + 2, shadow: o.shadow ?? !NOSHADOW.has(s.kind), xray: o.xray, pick: o.pick }); };
    const alpha = clamp(sim.alpha ?? 1, 0, 1), selectedId = cam.view.selected ?? null;
    for (const t of liveThings.values()) {
      const a = at(toM(t.px), toM(t.py));
      // drawn wherever the sim holds it: the sim keeps things off the fine wet field, and a level's coarse map would lose it
      if (!onScreen(a, 60)) continue;
      const hpx = ObjBins.shown(t.size ?? 1) * pv;
      if (t.kind === "fire" || t.burning > 0) fires.push({ a, big: t.kind === "fire" ? 1 : 0.7 + (t.burning || 0), id: t.id });
      if (hpx < 1) continue;
      const s = thingSprite(t, hpx, md.b);
      if (s) { s.kind ??= t.kind; add(a, s, { mirror: ((t.seed >>> 3) & 1) === 1 && !FACED.has(t.kind), bias: t.kind === "structure" ? md.hb + 4 : 2, pick: { kind: "thing", id: t.id } }); }
      picks.push({ kind: "thing", id: t.id, sx: a.sx, sy: a.sy - hpx / 2, h: Math.max(3, hpx), name: t.name || t.kind.replaceAll("_", " "), top: a.sy - hpx - 2 });
    }
    for (const an of W.animals || []) {
      if (an.hp <= 0) continue;
      const hpx = ObjBins.shown(BODY[an.species] ?? 0.5) * 1.5 * pv;
      if (hpx < 1) continue;
      const p = motion(an.id, sim);
      if (!p) continue;
      const a = at(p.x, p.z), fly = FLIERS.has(an.species), lift = Math.round((an.alt || 0) * pv), seedA = strHash(an.id) % 8;
      if (!onScreen({ sx: a.sx, sy: a.sy - lift })) continue;
      const [du, dv] = p.moving ? md.dir(p.dx, p.dz) : md.dir(Math.cos(an.heading ?? 0), Math.sin(an.heading ?? 0)), facing = du - dv >= 0 ? 1 : 0;
      // wings beat on the clock, legs only while the animal covers ground
      const frame = fly ? Math.floor(now / 120 + seedA) & 3 : p.moving ? Math.floor(alpha * 4) & 3 : 0, hq = hpx < 8 ? Math.round(hpx * 2) / 2 : Math.round(hpx);
      const s = spr(`a${an.species}|${an.state}|${hq}|${frame}|${seedA}|${facing}`, () => TH.animal?.(an.species, an.state, hq, frame, seedA, facing));
      const up = lift > 1;
      // depth of the drawn point, the ground's plus the lift, so trees and ridges in front still hide a bird
      add(a, s, { lift: -lift, z: a.cz + lift, bias: 3, shadow: !up && !fly && hpx >= 3, xray: an.id === selectedId, pick: { kind: "animal", id: an.id } });
      picks.push({ kind: "animal", id: an.id, sx: a.sx, sy: a.sy - lift - hpx / 2, h: Math.max(4, hpx) + 3, name: an.species, top: a.sy - lift - hpx - 2 });
    }
    for (const ag of W.agents || []) {
      if (ag.dead || ag.alive === false) continue;
      const p = motion(ag.id, sim);
      if (!p) continue;
      const a = at(p.x, p.z);
      if (!onScreen(a)) continue;
      const stage = (W.t - ag.born) / YEAR < 1 ? "child" : (W.t - ag.born) / YEAR < 5 ? "adult" : "elder";
      // by meters like everything else, a little larger than life, and never below three pixels so a nomad is findable
      const hp = Math.max(3, Math.round(1.7 * 1.6 * pv * (stage === "child" ? 0.7 : 1))), cloth = clothOf(ag.color), seedA = strHash(ag.id) % 997;
      const down = ag.down > W.t;
      // facing comes from the motion as it looks on screen, so it turns with the camera
      const f = facingOf(ag.id, ...(p.moving ? md.dir(p.dx, p.dz) : [0, 0]));
      let s, mirror = false;
      if (down) s = TH.lying ? spr(`lie${hp}|${cloth}|${seedA}`, () => TH.lying(hp, cloth, seedA)) : spr(`sit${hp}|${cloth}|${seedA}`, () => SP.person(hp, cloth, "front", "sit", seedA));
      else if (TH.walker && !isle) {
        const goal = String(ag.goal?.type ?? ag.goal ?? ""), carry = /wood|stick|log/.test(goal) ? "wood" : /stone|rock/.test(goal) ? "stone" : /food|forage|hunt|berr|fish/.test(goal) ? "food" : "none";
        const step = p.moving ? Math.floor(alpha * 4) & 3 : 0;
        s = spr(`walk${hp}|${cloth}|${f.facing}|${step}|${carry}|${stage}|${seedA}`, () => TH.walker(hp, cloth, f.facing, step, carry, stage, seedA));
        mirror = f.across < 0;
      } else {
        s = spr(`man${hp}|${cloth}|${f.facing}|${seedA}|${f.across > 0 ? 1 : 0}`, () => SP.person(hp, cloth, f.facing, "stand", seedA, f.across > 0 ? 1 : 0));
        mirror = f.facing !== "side" && f.across < 0;
      }
      const own = { kind: "agent", id: ag.id };
      add(a, s, { mirror, bias: 4, lift: hp < 16 && !down ? 2 : 0, xray: true, pick: own });
      const icon = down ? "sleep" : ag.sickness ? "sick" : ag.thinking ? "think" : ag.engaged ? "fight" : null;
      if (icon && !isle && TH.icon) { const ic = spr(`icon${icon}`, () => TH.icon(icon)); if (ic) out.push({ z: 1e9, sx: a.sx, sy: a.sy - hp - 2, spr: ic, bias: 0, shadow: false, pick: own }); }
      picks.push({ kind: "agent", id: ag.id, sx: a.sx, sy: a.sy - (hp >> 1), h: hp + 3, name: ag.name, top: a.sy - hp - 2 });
    }
    return { out, fires, picks };
  }
  // things that have a front turn with the camera: a world facing from the seed, less the camera's clockwise turns
  const FACED = new Set(["structure", "trap", "well", "grave", "item"]);
  function thingSprite(t, hpx, bearing) {
    if (!TH.object) return null;
    const seedT = (t.seed >>> 0) % 8, dir = (((t.seed >>> 5) & 7) - bearing + 16) % 8, hq = hpx < 8 ? Math.round(hpx * 2) / 2 : Math.round(hpx);
    // flames are drawn by drawFires on the clock, so the sprite is always the unlit thing
    const species = t.kind === "structure" ? t.shelter?.style : t.kind === "item" ? t.item : t.species;
    const o = { species, stage: clamp(t.stage ?? 1, 0, 1), tier: t.shelter?.tier ?? 0, caught: !!t.caught, n: t.n, covered: !!t.covered, charcoal: t.charcoal > 0, dir, burning: 0 };
    return spr(`t${t.kind}|${species}|${hq}|${seedT}|${o.stage}|${o.tier}|${o.caught}|${o.n > 0}|${o.covered}|${o.charcoal}|${dir}`, () => TH.object(t.kind, hq, seedT * 131 + 7, o));
  }


  // ---------- fire, smoke, light ----------
  function drawFires(cam, fires, now, night) {
    const md = cam.md, sz = SIZES[md.L];
    const wind = simRef?.w?.weather?.wind ?? { dx: 1, dy: 0 }, [du, dv] = md.dir(wind.dx ?? 1, wind.dy ?? 0), drift = clamp((du - dv) * 0.3, -0.45, 0.45);
    for (const f of fires) {
      const { a } = f, fl = Math.max(2, Math.round(sz.fire * f.big)), ph = (now / 1000) * 5 + idH(f.id, 5) * 8;
      // glow on the ground by day; warm light pools by night
      const R = sz.glow * (1 + night * 1.6) * f.big * (0.95 + 0.05 * Math.sin(ph * 2.3));
      for (let y = Math.floor(a.sy - R * 0.6); y <= a.sy + R * 0.6; y++)
        for (let x = Math.floor(a.sx - R); x <= a.sx + R; x++) {
          if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
          const d = Math.hypot((x - a.sx) / R, (y - a.sy) / (R * 0.55));
          if (d >= 1) continue;
          const p = y * B.w + x, X = x + cam.gx0, Y = y + cam.gy0;
          const lvl = Math.min(3, Math.floor((1 - d) * 3.4 + bayer(X, Y)));
          if (lvl > light[p]) light[p] = lvl;
          if (!B.id[p] && bayer(X, Y) < (1 - d) * (1.4 - night * 0.6)) B.c[p] = GLOW[B.c[p]];
        }
      if (!md.isle) {
        const s = spr(`flame${fl}|${Math.floor(ph) & 7}`, () => SP.flames(fl, 5 + (Math.floor(ph) & 7)));
        blit(B, s, a.sx, a.sy + 1, a.cz + 2, owners.push({ kind: "thing", id: f.id }) - 1, false, md.hb + 3);
      } else if (a.sx >= 0 && a.sy >= 1 && a.sx < B.w && a.sy < B.h) B.c[(a.sy - 1) * B.w + a.sx] = (Math.floor(ph) & 1) ? P.f3 : P.f2;
      smoke(cam, a.sx, a.sy - fl, sz.person * sz.smoke * f.big, Math.max(0.8, sz.person * 0.18), drift, now / 1000 + idH(f.id, 6) * 9);
    }
  }
  // the still's smoke column on a continuous clock: puffs rise, swell, lean downwind and fade
  function smoke(cam, x0, y0, h, r0, drift, t) {
    const n = Math.max(5, Math.round(h / (r0 * 2.2))), ph = (t * 1.2) % 1;
    for (let k = n; k >= 0; k--) {
      const q = (k + ph) / (n + 1), tt = q ** 1.8, rise = h * tt;
      const r = r0 * (0.6 + tt * 1.8) * (0.8 + 0.4 * (Math.sin(tt * 9 + 1.3) * 0.5 + 0.5));
      const cx = x0 + drift * h * tt ** 1.6 + Math.sin(tt * 5 + 1) * r0 * 0.6 * tt, cy = y0 - rise, alpha = Math.min(1, q * 14) * (1.2 - tt * 1.25);
      if (alpha <= 0) continue;
      for (let y = Math.floor(cy - r); y <= cy + r; y++)
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          if (x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
          const dx = (x + 0.5 - cx) / r, dy = (y + 0.5 - cy) / r, d = dx * dx + dy * dy, X = x + cam.gx0, Y = y + cam.gy0;
          if (d > 1 || bayer(X, Y) > alpha * (1.3 - d * 0.8)) continue;
          const l = -(dx * 0.7 + dy * 0.75) + (h2(X, Y, 78) - 0.5) * 0.2;
          B.c[y * B.w + x] = d > 0.7 && dx + dy > 0.25 ? P.r4 : l > 0.35 ? P.snow : P.r5;
        }
    }
  }

  // ---------- time of day: the palette itself is re-lit ----------
  const KEYS = [
    [0, { m: [0.32, 0.38, 0.62], s: 0.4, a: [6, 8, 20] }],
    [4.6, { m: [0.32, 0.38, 0.62], s: 0.4, a: [6, 8, 20] }],
    [6, { m: [0.85, 0.7, 0.72], s: 0.8, a: [18, 6, 10] }],
    [7.5, { m: [1, 1, 1], s: 1, a: [0, 0, 0] }],
    [12, { m: [1.04, 1.04, 1.02], s: 1.02, a: [4, 4, 4] }],
    [16.5, { m: [1.03, 0.99, 0.92], s: 1, a: [6, 2, 0] }],
    [19, { m: [1.08, 0.8, 0.66], s: 0.9, a: [14, 0, 0] }],
    [20.6, { m: [0.5, 0.42, 0.6], s: 0.55, a: [10, 4, 22] }],
    [22, { m: [0.32, 0.38, 0.62], s: 0.4, a: [6, 8, 20] }],
    [24, { m: [0.32, 0.38, 0.62], s: 0.4, a: [6, 8, 20] }],
  ];
  function lutFor(hour) {
    const key = (Math.round(hour * 12) / 12).toFixed(3);
    if (key === lastLutKey) return lastLut;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1][0] <= hour) i++;
    const [h0, A] = KEYS[i], [h1, Bk] = KEYS[i + 1], f = clamp((hour - h0) / (h1 - h0 || 1), 0, 1), mix = (a, b) => a + (b - a) * f;
    const m = A.m.map((v, k) => mix(v, Bk.m[k])), s = mix(A.s, Bk.s), ad = A.a.map((v, k) => mix(v, Bk.a[k]));
    const night = clamp(1 - (m[0] + m[1]) / 1.6, 0, 1) * 1.6;
    const lut = new Uint32Array(NCOL * 4);
    for (let c = 0; c < NCOL; c++) {
      const [r, g, b] = RGB[c], L = r * 0.3 + g * 0.59 + b * 0.11;
      const amb = [L + (r - L) * s, L + (g - L) * s, L + (b - L) * s].map((v, k) => v * m[k] + ad[k]);
      const warm = [r * 1.18 + 26, g * 0.96 + 10, b * 0.66];
      for (let l = 0; l < 4; l++) {
        const w = Math.min(1, night) * [0, 0.35, 0.65, 0.9][l];
        const o = amb.map((v, k) => clamp(Math.round(v + (warm[k] - v) * w), 0, 255));
        lut[l * NCOL + c] = 0xff000000 | (o[2] << 16) | (o[1] << 8) | o[0];
      }
    }
    lastLut = lut; lastLutKey = key;
    return lut;
  }

  // ---------- the frame ----------
  // What to draw: one camera, or two cross-fading ones, either the next finer level near the end of a level's zoom
  // range or the next bearing while the camera is between two.
  function plan(view) {
    const lf = levelFor(view.zoom), beta = ((view.bearing ?? 0) % NB + NB) % NB, b0 = Math.floor(beta + 1e-6) % NB, f = beta - Math.floor(beta + 1e-6);
    if (f > 1e-4) {
      const b1 = (b0 + 1) % NB;
      mapsFor(b0); mapsFor(b1);
      const g0 = grow(f), g1 = grow(f - 1);
      const A = camera(view, lf.L, b0, ...g0), Bc = camera(view, lf.L, b1, ...g1);
      let wB = smooth(0.35, 0.65, f);
      const rA = camReady(A), rB = camReady(Bc);
      if (!Bc || (!rB && rA)) wB = 0;
      else if (!A || (!rA && rB)) wB = 1;
      return { lf, parts: [[A, 1 - (wB >= 1 ? 1 : 0), f], [Bc, wB, f - 1]].filter(([c, w]) => c && w > 0), orbit: true, b0 };
    }
    let A = camera(view, lf.L, b0);
    if (!A) {
      mapsFor(b0);
      // this bearing's maps are still loading: show the nearest bearing that has them, turned into place
      for (const d of [1, -1, 2, -2, 3, -3, 4]) {
        const bb = (b0 + d + NB) % NB, g2 = grow(-d), c = mapsFor(bb) && camera(view, lf.L, bb, ...g2);
        if (c) return { lf, parts: [[c, 1, -d]], orbit: true, b0: bb };
      }
      return { lf, parts: [], orbit: false, b0 };
    }
    const parts = [[A, 1, 0]];
    if (lf.L < NL - 1 && lf.t > 0.6) {
      const Bc = camera(view, lf.L + 1, b0), w = smooth(0.6, 1, lf.t);
      if (Bc && camReady(Bc)) parts.push([Bc, w, 0]);
    }
    return { lf, parts, orbit: false, b0 };
  }
  function schedule(view, pl) {
    const list = [], visible = new Set(), L = pl.lf.L, b = pl.b0;
    for (const [c] of pl.parts) wantView(c, c === pl.parts[0][0] ? 0 : 8, list, visible, c === pl.parts[0][0]);
    if (!pl.orbit && pl.lf.t > 0.3 && L < NL - 1) wantView(camera(view, L + 1, b), 12, list, visible, false);
    if (view.turnTo != null) { const tb = mod8(view.turnTo); if (mapsFor(tb)) wantView(camera(view, L, tb, ...grow(0.5)), 4, list, visible, false); }
    for (const pv of prefetchViews) { const pb = mod8(pv.bearing ?? b); if (mapsFor(pb)) wantView(camera(pv, levelFor(pv.zoom ?? view.zoom).L, pb), pv.later ? 50 : 20, list, visible, false); }
    if (L > 0) wantView(camera(view, L - 1, b), 40, list, visible, false);
    if (L > 1) wantView(camera(view, 0, b), 45, list, visible, false);
    // a free orbit is crossing b and b + 1: the bearings either side of that pair come next, whichever way it turns
    // once the view is whole, this bearing's turn margin and then every other bearing's view bake while the workers are
    // idle, so a first turn is quick
    const around = pl.orbit ? [[2, 30], [NB - 1, 30]] : adjacent ? [...(settled ? [[0, 60]] : []), [1, 70], [NB - 1, 70], ...(settled ? [2, 3, 4, 5, 6].map((d) => [d, 90]) : [])] : [];
    // with the rect a half-step turn needs, so a turn through them has no holes at the edges
    for (const [db, pr] of around) { const nb = (b + db) % NB; if (mapsFor(nb)) wantView(camera(view, L, nb, ...grow(0.5)), pr, list, visible, false); }
    dispatch(list);
    evict(visible);
  }

  function frame(view, sim) {
    const now = performance.now(), t0 = now;
    if (sim) { simRef = sim; if (!synced) sync(sim); }
    ensureSlots();
    const pl = plan(view);
    schedule(view, pl);
    const clock = sim?.clock?.() ?? { hour: 8, night: 0 };
    const g = canvas.getContext("2d"), lut = lutFor(clock.hour ?? 8), sea = lut[P.w1];
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = `rgb(${sea & 255},${(sea >> 8) & 255},${(sea >> 16) & 255})`;
    g.fillRect(0, 0, canvas.width, canvas.height);
    let holes = false, best = -1;
    const T = (stats.parts ??= { schedule: 0, compose: 0, present: 0 }), tS = performance.now(), fp = (api.lastParts = [Math.round((tS - t0) * 10) / 10]);
    T.schedule = T.schedule * 0.95 + (tS - t0) * 0.05;
    pl.parts.forEach(([cam, w, turn], k) => {
      const t1 = performance.now();
      const r = compose(slots[k], cam, now, sim, clock, view);
      const t2 = performance.now();
      if (k === 0) holes = r.holes;
      present(g, slots[k], cam, k === 0 ? 1 : w, turn);
      T.compose = T.compose * 0.95 + (t2 - t1) * 0.05; T.present = T.present * 0.95 + (performance.now() - t2) * 0.05;
      fp.push(Math.round((t2 - t1) * 10) / 10, Math.round((performance.now() - t2) * 10) / 10, cam.AW * cam.AH);
      if (w > best) { best = w; lastPick = r.picks; pickCam = cam; pickSlot = slots[k]; pickTurn = turn; }
    });
    stats.slots = pl.parts.length;
    const ms = performance.now() - t0;
    stats.composeMs = stats.composeMs ? stats.composeMs * 0.9 + ms * 0.1 : ms;
    frames++;
    if (now - fpsT > 1000) { stats.fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; stats.memMB = Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6); stats.cacheMB = Math.round(cacheBytes / 1e6); }
    if (firstFrame && !holes) { firstFrame = false; stats.firstFrameMs = Math.round(performance.now() - tStart); }
    if (!settled && !holes && adjacent) { settled = true; for (let b = 0; b < NB; b++) requestMaps(b); }
    api.lastMs = ms; api.lastHoles = holes; api.level = pl.lf;
    return { holes };
  }
  function xray(o) {
    const s = o.spr, ax = o.mirror ? s.w - 1 - s.ax : s.ax;
    for (let y = 0; y < s.h; y++) {
      const sy = o.sy - s.ay + y;
      if (sy < 0 || sy >= B.h) continue;
      for (let x = 0; x < s.w; x++) {
        const col = s.p[y * s.w + (o.mirror ? s.w - 1 - x : x)], sx = o.sx - ax + x;
        if (col === 255 || sx < 0 || sx >= B.w) continue;
        const p = sy * B.w + sx;
        // the whole silhouette picks the person seen through the leaves; only the checker pixels are painted
        if (B.id[p] !== o.id && B.id[p] !== 0) { if ((sx + sy) & 1) B.c[p] = col; B.id[p] = o.id; }
      }
    }
  }
  function label(s, cx, y) {
    const txt = s.toUpperCase(), w = txt.length * 6 - 1, x = Math.round(cx - w / 2);
    y = Math.round(y);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) text(B, txt, x + dx, y - 7 + dy, P.ink);
    text(B, txt, x, y - 7, P.snow);
  }
  function haze(cam, hour) {
    const morning = clamp(1 - Math.abs(hour - 7.5) / 3.5, 0, 1) * 0.8 + 0.2, most = 0.32 * morning, reach = 0.42;
    // tied to the canvas, not the buffer, so a grown buffer or a zoom does not move the horizon band
    const top = -cam.dy / cam.s, span = canvas.height / cam.s;
    for (let y = 0; y < B.h; y++) {
      const a = most * Math.max(0, 1 - (y - top) / (span * reach)) ** 1.5;
      if (a <= 0) break;
      if (a < 0.001) continue;
      for (let x = 0; x < B.w; x++) if (bayer(x + cam.gx0, y + cam.gy0) < Math.min(a, most)) { const p = y * B.w + x; B.c[p] = HAZE[B.c[p]]; }
    }
  }

  // ---------- picking and coordinates ----------
  const mainCam = (view) => camera(view, levelFor(view.zoom).L, mod8(view.bearing ?? 0));
  // the main level's camera at the whole bearing nearest the view's, and the turn present() draws it with
  function turnedCam(view) {
    const beta = norm8(view.bearing ?? 0), b0 = Math.floor(beta), f = beta - b0, L = levelFor(view.zoom).L;
    for (const d of f > 0.5 ? [1, 0] : [0, 1]) { const c = camera(view, L, (b0 + d) % NB); if (c) return [c, f - d]; }
    return [null, 0];
  }
  // a canvas point taken back through present()'s turn about the canvas centre
  function unturn(sx, sy, turn) {
    if (!turn) return [sx, sy];
    const a = (-turn * Math.PI) / 4, c = Math.cos(a), sn = Math.sin(a), W = canvas.width / 2, H = canvas.height / 2, X = sx - W, Y = sy - H;
    return [W + c * X + 2 * sn * Y, H - (sn / 2) * X + c * Y];
  }
  // ray-marched front to back on the level's own drawn surface, so a ridge in front is hit where it is drawn
  function rayGround(cam, gx, gy) {
    const md = cam.md, a = gx / md.H, gap = (lev) => { const b = (gy + lev * md.lp) / md.hb; return md.ground((a + b) / 2, (b - a) / 2) - lev; };
    let hi = (md.maxLev ?? 0) + 2, lo = hi;
    while (lo > -2 && gap(lo) < 0) { hi = lo; lo -= 0.25; }
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (gap(m) >= 0) lo = m; else hi = m; }
    const lev = (lo + hi) / 2, b = (gy + lev * md.lp) / md.hb, u = (a + b) / 2, v = (b - a) / 2, [x, z] = md.world(u, v);
    return { x, z, y: lev * md.levelM, u, v };
  }
  function groundUnder(view, sx, sy) {
    const [cam, turn] = turnedCam(view);
    if (!cam) return null;
    const [x, y] = unturn(sx, sy, turn), g = rayGround(cam, cam.gx0 + (x - cam.dx) / cam.s, cam.gy0 + (y - cam.dy) / cam.s);
    return { x: g.x, z: g.z, y: g.y };
  }
  const drawnY = (view, x, z) => { const [cam] = turnedCam(view); return cam ? cam.md.ground(...cam.md.uv(x, z)) * cam.md.levelM : camH(x, z); };
  // G maps a ground offset to canvas px per ppm (rows eu - ev, (eu + ev) / 2); camera() matches it at every level
  const basis = (bearing) => { const a = (norm8(bearing) * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a); return [c + s, s - c, (c - s) / 2, (s + c) / 2]; };
  function screenOf(view, x, z, y) {
    const [g00, g01, g10, g11] = basis(view.bearing ?? 0), ppm = ppmOf(clamp(view.zoom, 0, ZMAX)), dx = x - view.x, dz = z - view.z;
    return [canvas.width / 2 + ppm * (g00 * dx + g01 * dz), canvas.height / 2 + ppm * (g10 * dx + g11 * dz - VK * (y - camH(view.x, view.z) - (view.up || 0)))];
  }
  // the target showing (x, z, y) at (ox, oy) px off centre: G inverted exactly, Newton for the height it rides
  function solveTarget(view, x, z, y, ox, oy) {
    const [g00, g01, g10, g11] = basis(view.bearing ?? 0), ppm = ppmOf(clamp(view.zoom, 0, ZMAX)), r0 = ox / ppm, r1 = oy / ppm, up = view.up || 0;
    let q0 = g11 * r0 - g01 * r1, q1 = g00 * r1 - g10 * r0, err = Infinity;
    for (let k = 0; k < 30 && err > 1e-9; k++) {
      const [h, hx, hz] = camHg(x - q0, z - q1), f0 = g00 * q0 + g01 * q1 - r0, f1 = g10 * q0 + g11 * q1 + VK * (h + up - y) - r1;
      err = Math.abs(f0) + Math.abs(f1);
      const j10 = g10 - VK * hx, j11 = g11 - VK * hz, det = g00 * j11 - g01 * j10;
      q0 -= (j11 * f0 - g01 * f1) / det; q1 -= (g00 * f1 - j10 * f0) / det;
    }
    return err * ppm < 1e-4 && Number.isFinite(q0 + q1) ? { x: x - q0, z: z - q1 } : null;
  }
  // the target, with no lift, that puts world point (x, z) standing on its drawn ground mid-screen
  const centreOn = (x, z, view) => solveTarget({ ...view, up: 0 }, x, z, drawnY(view, x, z), 0, 0) ?? { x, z };
  // by what is drawn: a live sprite's own pixel, then a near miss (people first), then a baked sprite's own pixel
  const UPRIGHT = new Set(["tree", "bush", "fern", "reeds", "sapling", "dead_bush", "herb", "flowers"]);
  function pick(sx, sy, view) {
    const cam = pickCam ?? mainCam(view);
    if (!cam) return null;
    const [cx, cy] = unturn(sx, sy, pickCam ? pickTurn : 0), x = (cx - cam.dx) / cam.s, y = (cy - cam.dy) / cam.s, ix = Math.floor(x), iy = Math.floor(y);
    const idv = pickCam && pickSlot && ix >= 0 && iy >= 0 && ix < cam.AW && iy < cam.AH ? pickSlot.id[iy * cam.AW + ix] : 0;
    if (idv >= 2 && pickSlot.owners?.[idv]) return { ...pickSlot.owners[idv] };
    const g = rayGround(cam, cam.gx0 + x, cam.gy0 + y), ground = { kind: "ground", px: (g.x - ORIGIN) / SIM, py: (g.z - ORIGIN) / SIM };
    // a baked sprite drawn under the cursor is in front of anything a near miss could find
    if (idv === 1) return bakedAt(cam, g, cam.gx0 + ix, cam.gy0 + iy) ?? ground;
    let best = null, bd = Infinity;
    for (const p of lastPick) {
      const d = Math.hypot(p.sx - x, p.sy - y), score = d + (p.kind === "agent" ? 0 : 3);
      if (d < Math.max(4, p.h * 0.6) && score < bd) { bd = score; best = { kind: p.kind, id: p.id }; }
    }
    return best ?? ground;
  }
  // the front-most baked object whose sprite, rebuilt the way the bake draws it, covers global art pixel (X, Y)
  function bakedAt(cam, g, X, Y) {
    if (!bins) return null;
    const md = cam.md, pv = md.k * 0.866 * md.treeK, pw = md.k * md.treeK, r = pv < 0.5 ? 1 : 0;
    const tx = Math.floor((g.x - ORIGIN) / SIM), ty = Math.floor((g.z - ORIGIN) / SIM);
    let best = null, front = -Infinity;
    bins.each(tx - 1 - r, ty - 1 - r, tx + 1 + r, ty + 1 + r, (ki, si, px, py, size, seed, id, n) => {
      const K = bins.kinds[ki];
      if (ObjBins.LIVE.has(K)) return;
      const hpx = K === "grass" ? size * pw : ObjBins.shown(size) * pv;
      if (hpx < 1) return;
      const p = project(md, toM(px), toM(py)), bx = Math.round(p.gx), by = Math.round(p.gy);
      if (Math.abs(X - bx) > hpx * 2 + 6 || Y > by + 6 || Y < by - hpx * 2 - 8) return;
      const s = bakedSprite(K, bins.species[si], hpx, seed, n), mirror = ((seed >>> 3) & 1) === 1;
      if (!s) return;
      const ax = mirror ? s.w - 1 - s.ax : s.ax, i = X - bx + ax, j = Y - by - (s.foot || 0) + s.ay;
      if (i < 0 || j < 0 || i >= s.w || j >= s.h || s.p[j * s.w + (mirror ? s.w - 1 - i : i)] === 255) return;
      const z = p.cz + s.ay - j;
      if (z > front) { front = z; best = { kind: "thing", id: "t" + id }; }
    });
    return best;
  }
  function bakedSprite(K, sp, hpx, seed, n) {
    const vr = seed % 8, tint = ((seed >>> 8) & 255) / 255;
    if (K === "tree") {
      // palette indices only recolour a tree, so any two opaque ones give the drawn pixel mask
      if (hpx < 24) {
        const hp = Math.max(1, Math.round(hpx)), kind = sp === "pine" ? "pine" : sp === "aspen" && tint > 0.8 ? "gold" : "broad";
        return spr(`pk|ft${hp}|${kind}|${vr & 3}`, () => SP.flatTree(hp, kind, P.snow, P.ink, vr & 3));
      }
      const hp = Math.round(hpx);
      return sp === "pine" ? spr(`pk|p${hp}|${vr}`, () => SP.pine(hp, vr * 17 + hp, false, 0)) : spr(`pk|${sp}${hp}|${vr}|${tint > 0.8 ? 1 : 0}`, () => SP.broad(hp, sp || "oak", vr * 31 + hp, tint, 0));
    }
    if (!TH.object) return null;
    const hq = hpx < 8 ? Math.round(hpx * 2) / 2 : Math.round(hpx);
    return spr(`pk|${K}|${sp}|${hq}|${vr}|${n === undefined ? "" : n > 0}`, () => TH.object(K, hq, vr * 131 + 7, n === undefined ? { species: sp, moss: 0 } : { species: sp, moss: 0, n }));
  }
  // a bird's lift is at sprite scale (treeK) and the ground's at terrain scale (exag), so both become terrain meters
  function where(id, sim, view) {
    if (id && typeof id === "object") { if (id.kind !== "ground") return null; const x = toM(id.px), z = toM(id.py); return { x, z, y: drawnY(view, x, z), dx: 0, dz: 0 }; }
    const m = motion(id, sim);
    if (!m) return null;
    const [cam] = turnedCam(view), alt = sim.w.animals.find((a) => a.id === id)?.alt ?? 0, md = cam?.md;
    m.y = md ? md.ground(...md.uv(m.x, m.z)) * md.levelM + (alt * md.treeK) / md.exag : camH(m.x, m.z);
    return m;
  }
  // the selection's name above it, and brackets round a thing baked into the ground, which has no live sprite to show
  // the label is the inspector's own title, fetched once per selection and tick
  let titleOf = { sel: null, t: -1, name: "" };
  const title = (sel) => {
    const t = simRef?.w?.t ?? 0;
    if (titleOf.sel !== sel || titleOf.t !== t) {
      const d = typeof sel === "object" ? simRef?.inspectGround?.(sel.px, sel.py) : simRef?.inspect?.(sel);
      titleOf = { sel, t, name: d?.name || "" };
    }
    return titleOf.name;
  };
  function markSelected(cam, sel, picks) {
    const live = picks.find((p) => p.id === sel);
    if (live) { label(title(sel) || live.name || String(live.id), live.sx, live.top ?? live.sy - live.h); return; }
    const md = cam.md, pv = md.k * 0.866 * md.treeK;
    let x, z, hpx = 2, name = "ground", tall = true;
    if (typeof sel === "object") { x = toM(sel.px); z = toM(sel.py); }
    else {
      const r = bins?.get(numId(sel));
      if (!r) return;
      const K = bins.kinds[r.kind];
      x = toM(r.px); z = toM(r.py); hpx = Math.max(2, ObjBins.shown(r.size) * pv); name = bins.species[r.sp] || K; tall = UPRIGHT.has(K);
    }
    const p = project(md, x, z), ox = Math.round(p.gx - cam.gx0), oy = Math.round(p.gy - cam.gy0);
    const hw = Math.ceil(Math.max(2, hpx * 0.5)) + 1, top = oy - Math.ceil(tall ? hpx : hpx * 0.7) - 2, bot = oy + 2;
    for (const [bx, by, sx2, sy2] of [[ox - hw, top, 1, 1], [ox + hw, top, -1, 1], [ox - hw, bot, 1, -1], [ox + hw, bot, -1, -1]])
      for (let k = 0; k < 3; k++) { dot(bx + k * sx2, by); dot(bx, by + k * sy2); }
    label(title(sel) || name.replaceAll("_", " "), ox, top - 1);
  }
  const dot = (x, y) => { if (x >= 0 && y >= 0 && x < B.w && y < B.h) B.c[y * B.w + x] = P.snow; };

  // the island level is small; baked whole up front it is the last fallback under everything, so no view shows flat colour
  {
    const md = maps.get(mk(0, 0)), m = 30, hb = md.H * 0.5;
    const cx0 = Math.floor((-(md.NJ + 2 * m) * md.H) / CS), cx1 = Math.floor(((md.NI + 2 * m) * md.H) / CS);
    const cy0 = Math.floor((-2 * m * hb - md.maxLev * md.lp - 40) / CS), cy1 = Math.floor(((md.NI + md.NJ + 2 * m) * hb) / CS);
    const keys = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) keys.push([cx, cy]);
    const t1 = performance.now();
    while (true) {
      const list = [];
      for (const [cx, cy] of keys) keep.add(want(md, cx, cy, 0, list).key);
      if (!list.length && keys.every(([cx, cy]) => { const c = cache.get(keyOf(0, 0, cx, cy)); return c.c || c.failed; })) break;
      dispatch(list);
      onProgress?.(keys.filter(([cx, cy]) => cache.get(keyOf(0, 0, cx, cy)).c).length, keys.length, "baking the island");
      await new Promise((r) => setTimeout(r, 30));
    }
    stats.islandMs = Math.round(performance.now() - t1); stats.islandChunks = keys.length;
  }
  // the two neighbouring bearings' maps load in the background, so the first turn only waits for chunks
  if (adjacent) { requestMaps(1); requestMaps(NB - 1); }
  stats.readyMs = Math.round(performance.now() - tStart);
  const levels = PL.map((p, L) => ({ name: maps.get(mk(L, 0)).name, tileM: maps.get(mk(L, 0)).tileM, p, zoom: Math.log2((2 * p) / PPM0) }));
  const api = {
    zmax: ZMAX, named, levels, ppm: (z) => ppmOf(clamp(z, 0, ZMAX)), levelFor,
    readiness, bearingReady: (view, b) => mapsFor(mod8(b)) && camReady(camera(view, levelFor(view.zoom).L, mod8(b), ...grow(0.5))),
    prefetch: (views) => { prefetchViews = views || []; }, centreOn, camH, screenOf, solveTarget, groundUnder,
    picks: () => lastPick.map((p) => ({ kind: p.kind, id: p.id, sx: p.sx, sy: p.sy })),
    frame, changed, pick, where, stats, cache, pool, lastMs: 0, lastHoles: false, level: null,
  };
  if (check) {
    let cid = 0;
    api.debug = {
      CS, maps, keyOf, mk, project, camera, bins: () => bins, pickCam: () => [pickCam, pickTurn, pickSlot],
      pv: (md) => md.k * 0.866 * md.treeK, pw: (md) => md.k * md.treeK,
      classify: (points) => new Promise((r) => { const id = ++cid; classWait.set(id, (out) => { classWait.delete(id); r(out); }); pool[0].postMessage({ type: "classify", id, points }); }),
    };
  }
  return api;
}

// A dark screen with one line of 5x7 text and a dotted progress bar, drawn on the art-pixel grid like everything else.
export function loadingScreen(canvas, msg, frac = 0) {
  const S = 2, AW = Math.ceil(canvas.width / S), AH = Math.ceil(canvas.height / S), B = new Buf(AW, AH);
  B.c.fill(P.ink);
  const txt = String(msg).toUpperCase(), w = txt.length * 6 - 1, x = Math.round((AW - w) / 2), y = Math.round(AH / 2 - 8);
  text(B, txt, x, y, P.r5);
  const bw = 120, bx = Math.round((AW - bw) / 2), by = y + 14, fill = Math.round(bw * clamp(frac, 0, 1));
  for (let i = 0; i < bw; i += 2) B.c[by * AW + bx + i] = i < fill ? P.f3 : P.r1;
  const img = new ImageData(AW, AH), o = new Uint32Array(img.data.buffer);
  for (let p = 0; p < B.c.length; p++) { const c = RGB[B.c[p]]; o[p] = 0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]; }
  const off = new OffscreenCanvas(AW, AH);
  off.getContext("2d").putImageData(img, 0, 0);
  const g = canvas.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(off, 0, 0, AW * S, AH * S);
}
