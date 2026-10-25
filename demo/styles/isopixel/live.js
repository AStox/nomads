// The live isopixel renderer: an orbiting camera with a continuous zoom over the whole island, drawn on WebGPU in a
// worker (worker.js, webgpu.js) on the page's canvas handed to it as an OffscreenCanvas. The GPU rasterizes everything
// every frame: the ground of the level and bearing shown, painted pixel by pixel from the world's fields, and every
// object standing on it as a sprite from one atlas, so a zoom, a pan or a turn never waits on the CPU. The game's sim runs
// in the same worker on the same device (play/sim.js), which keeps every object of it on the GPU as it ticks. This side
// keeps the camera and its exact projection, the sky of the hour, and what moves: it places the sim's people, animals and
// fires (as the worker last posted them, play/remote.js) on the drawn ground, lays out the smoke, labels, icons and paths
// over them, and sends each frame to the worker. Between two bearings the GPU draws the tile map of the nearer one turned
// to the bearing shown, so the island turns as a solid thing with its trees upright.
import { RGB, NCOL, P } from "./pal.js";
import { Buf, shown, shadowRows, h2, ANIMAL_BODY, ANIMAL_DRAWN } from "./px.js";
import { text } from "./ui.js";
import * as SP from "./sprites.js";
import { LEVELS } from "./webgpu.js";
import { crownRatio } from "./atlas.js";
import { createGround } from "./ground.js";
import { LADDER, levelOf } from "./ladder.js";
import { SIZE, TILE_M, CELL, N as WIN_N, crownShare } from "../island.js";
import { planetCam } from "./planet-cam.js";
import { canopyHold } from "./canopy.js";
import { moonLux, skyLux, nightShown, nightDrain, nightFloor } from "./night.js";

const SIM = TILE_M, ORIGIN = -SIZE / 2, TAU = Math.PI * 2, NL = LADDER.length, NB = 8;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const norm8 = (b) => { const r = ((b % NB) + NB) % NB; return r >= NB ? 0 : r; };
// One vertical exaggeration for every zoom and bearing (main.js EXAG): ?exag= overrides it once at load.
const EXAG = (() => { const q = Number(new URLSearchParams(globalThis.location?.search ?? "").get("exag")); return q ? clamp(q, 1, 3) : 1.5; })();
// Fire, its glow and its smoke column drawn larger than life, as the old sims do, so a camp shows from far out: art px
// at the tuned levels (island, region, valley, close); levels in between interpolate by art px per meter. Everything
// else is sized by its own meters.
const ANCHORS = [
  [levelOf("island"), { person: 3, fire: 2, glow: 3, smoke: 3 }],
  [levelOf("region"), { person: 5, fire: 4, glow: 6, smoke: 3 }],
  [levelOf("valley"), { person: 9, fire: 6, glow: 12, smoke: 5 }],
  [levelOf("close"), { person: 24, fire: 14, glow: 30, smoke: 3 }],
];
// How big a blaze (the sim's, inspect.ts Blaze) shows: its flames blaze.flame meters tall at pv art px a meter, but never
// under the level's tuned fire for a FLAME_M meter flame's share of it, so a camp still shows from far out; none over a
// bed of coals alone, which its sprite shows glowing. k scales its glow and smoke by the root of its whole output against
// a KW kW campfire's.
const FLAME_M = 0.5, KW = 100;
const blazeShown = (b, sz, pv) => ({
  fl: b.flame > 0 ? Math.max(2, Math.round(Math.max(b.flame * pv, sz.fire * Math.min(1, b.flame / FLAME_M)))) : 0,
  k: Math.max(0.3, Math.min(3, Math.sqrt((b.kw + b.glow) / KW))),
});
// animal body size in meters: standing height, a bird's wingspan, a fish's length (px.js, which the worker draws the
// GPU's animals at too)
const BODY = ANIMAL_BODY;
const FLIERS = new Set(["heron", "gull", "crow", "eagle", "butterfly"]);
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const idH = (id, k) => h2(strHash(String(id)), k, 611);
const toM = (t) => t * SIM + ORIGIN;
const NOSHADOW = new Set(["ash", "pit", "trap", "fire", "clay", "stick"]);
const SEASON_I = { spring: 0, summer: 1, autumn: 2, winter: 3 };
// a live sprite's flags for the GPU (webgpu.js SPRITE_WGSL): kind 2, mirrored, gives its own light, seen through leaves
const F_LIVE = 2, F_MIRROR = 16, F_EMIT = 32, F_XRAY = 64, PICK_LIVE = 0x80000000;

// Bearing b (any real number of 45 degree steps) turns the camera b * 45 degrees clockwise: tile axes eu, ev are the world
// axes turned by -b * 45 degrees, from an origin that keeps the whole island at u, v >= 0 (main.js bearingFrame).
function frameOf(b) {
  const a = (b * Math.PI) / 4, c = Math.cos(a), sn = Math.sin(a), R = (SIZE / 2) * (Math.abs(c) + Math.abs(sn));
  const eu = [c, sn], ev = [-sn, c], ox = -R * (eu[0] + ev[0]), oz = -R * (eu[1] + ev[1]);
  return { b, eu, ev, ox, oz };
}

// The WebGPU renderer wants a browser that offers it; createLive throws { cause: "nogpu" } where none does.
export const hasWebGPU = () => typeof navigator !== "undefined" && !!navigator.gpu;

// sim: { warm (sim days), jev } runs the game's sim in the render worker (play/remote.js connectSim reads it); null
// draws the island alone. planet: the worker opens the seed's baked planet, if there is one, and the game's ground is its home window.
export async function createLive({ seed = 1, canvas, onProgress, sim: simOpts = null, planet = true } = {}) {
  if (!hasWebGPU()) throw new Error("this browser does not offer WebGPU", { cause: "nogpu" });
  const TH = await import("./things.js").catch((e) => (console.warn(`things.js not loaded: ${e.message}`), {}));
  const tStart = performance.now();
  const stats = { fps: 0, composeMs: 0, gpuMs: 0, workerMs: 0, firstFrameMs: 0, slots: 1, memMB: 0 };

  // ---------- the worker and its canvas ----------
  // The GPU's canvas lies over the page's, which keeps the input and shows the loading screen until the first view.
  const glc = document.createElement("canvas");
  glc.id = "gpu";
  Object.assign(glc.style, { position: "fixed", left: "0", top: "0", width: "100vw", height: "100vh", pointerEvents: "none", imageRendering: "pixelated", visibility: "hidden" });
  canvas.after(glc);
  glc.width = canvas.width; glc.height = canvas.height;
  let glSize = [glc.width, glc.height];
  const off = glc.transferControlToOffscreen();
  const ex = new URLSearchParams(location.search).get("exag");
  const worker = new Worker(new URL(`./worker.js${ex ? `?exag=${encodeURIComponent(ex)}` : ""}`, import.meta.url), { type: "module" });
  let fieldsMsg = null, lost = null, lastError = null, info = null, objectsReady = false, lastDone = null, picksWait = new Map(), pickId = 0;
  // what the worker posts of the sim, held until the page listens (onSim)
  let simTo = null, quietDone = 0;
  const simEarly = [];
  const frameMs = [];
  // the levels and whole bearings ("L|b") whose front lists the worker has built (webgpu.js frontsReady), and those the
  // page asks it to build first (prefetch)
  let fronts = new Set(), ahead = [];
  await new Promise((done, fail) => {
    worker.onerror = (e) => fail(new Error(`render worker: ${e.message}`));
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") onProgress?.(m.d, m.n, m.what);
      else if (m.type === "fields") { fieldsMsg = m; info = m.info; }
      else if (m.type === "ready") done();
      else if (m.type === "error") fail(new Error(m.error));
      else onWorker(m);
    };
    worker.postMessage({ type: "init", seed, canvas: off, sim: simOpts, planet }, [off]);
  });
  function onWorker(m) {
    if (m.type.startsWith("sim")) { if (simTo) simTo(m); else simEarly.push(m); }
    else if (m.type === "frameDone") {
      lastDone = m; stats.gpuMs = m.gpuMs; stats.workerMs = m.cpuMs; stats.passes = m.passes; stats.counts = m.counts; stats.tiles = m.tiles; stats.lift = m.lift; stats.liftInfo = m.liftInfo; stats.q = m.q; stats.relief = m.relief; stats.tilesMax = m.tilesMax; stats.tilesCut = m.tilesCut; stats.applyMs = m.applyMs;
      // the share the window's view draws its trees at, which the ground paints the crowns of the rest by (planet.canopy): the worker's word at every frame, for the window the page holds. The
      // windows' own messages ("ground" with the share the blocks were made for, "windowObjects" with what all of them kept) race the page's taking the ground in, so neither tells it
      if (m.k0 !== undefined && stats.window?.id === m.win) stats.window.share = 2 ** -m.k0;
      // settled: the worker's word that what it drew has what the view asked of the planet (or, until it says so, that its tiles are held and none is in flight)
      quietDone = (m.settled ?? (m.tiles ? m.tiles.held > 0 && m.tiles.flying === 0 : true)) ? quietDone + 1 : 0;
      if (m.fronts !== undefined) fronts = new Set(m.fronts ? m.fronts.split(",") : []);
      const sent = sentAt.get(m.id);
      sentAt.delete(m.id);
      if (sent != null) frameMs.push({ id: m.id, latency: performance.now() - sent, gpu: m.gpuMs, cpu: m.cpuMs, at: performance.now(), passes: m.passes });
      if (frameMs.length > 4000) frameMs.splice(0, 2000);
    } else if (m.type === "objects") { objectsReady = true; stats.objects = m; onProgress?.(1, 1, "drawing the sprites"); }
    else if (m.type === "progress") onProgress?.(m.d, m.n, m.what);
    else if (m.type === "ground") pendingGround = m;
    else if (m.type === "windowError") console.warn(`window: ${m.error}`);
    else if (m.type === "windowObjects") { (stats.objectLog ??= []).push({ id: m.id, objects: m.objects, share: m.share, ms: Math.round(m.ms), blocks: m.blocks, made: m.made, bytes: m.bytes }); if (stats.window?.id === m.id) Object.assign(stats.window, { objects: m.objects, objectsMs: m.ms, objectsAt: performance.now(), blocks: m.blocks, made: m.made }); }
    else if (m.type === "pick") { picksWait.get(m.id)?.(m.r); picksWait.delete(m.id); }
    else if (m.type === "check") { checksWait.get(m.id)?.(m.r); checksWait.delete(m.id); }
    else if (m.type === "spritesReset") sentSprites.clear();
    else if (m.type === "lost") { lost = m.why; console.warn(`WebGPU lost: ${m.why}`); }
    else if (m.type === "gpuerror" || m.type === "error") { lastError = m.why ?? m.error; console.warn(`WebGPU: ${lastError}`); }
    else if (m.type === "groundFailed") { asked = null; mode = "home"; console.warn("the window could not be shown, asking again"); }
  }
  worker.onmessage = (e) => onWorker(e.data);
  const sentAt = new Map(), checksWait = new Map();
  let checkNo = 0;

  // ---------- the ground and the levels ----------
  let G = createGround(fieldsMsg), peak = fieldsMsg.peak;
  // a level: its art px per meter across (k) and per tile, its height step, its sprites' scale; a grid of it at a
  // bearing knows its world points and tile map (ground.js)
  const LV = LADDER.map((Z, L) => {
    const H = Z.W / 2, k = Z.W / (Z.tileM * Math.SQRT2), treeK = 1.15 * (Z.W / 2 / Z.tileM / 0.8533) ** -0.15, levelM = Z.lp / (k * 0.866 * EXAG);
    const pv = k * 0.866 * treeK;
    return { L, name: Z.name, W: Z.W, H, hb: H / 2, lp: Z.lp, tileM: Z.tileM, k, treeK, levelM, p: H / Z.tileM, pv, pw: k * treeK, shrunk: pv < SP.DIRECT_PV, peakLev: Math.ceil((peak + 10) / levelM), tall: Math.round(34 * k * 0.866 * treeK) + 8 };
  });
  // the levels' sprite scales, which the worker makes the sim's objects' sprites at
  worker.postMessage({ type: "levels", levels: LV.map((l) => ({ pv: l.pv, pw: l.pw, shrunk: l.shrunk })) });
  const grids = new Map();
  // the tile grid of level L at whole bearing b, for the ground
  const gridOf = (L, b) => {
    const key = L * 8 + b;
    let g = grids.get(key);
    if (!g) {
      const F = frameOf(b), md = LV[L];
      g = { key, levelM: md.levelM, F, toW: (u, v) => [F.ox + (u * F.eu[0] + v * F.ev[0]) * md.tileM, F.oz + (u * F.eu[1] + v * F.ev[1]) * md.tileM], uv: (x, z) => { const dx = x - F.ox, dz = z - F.oz; return [(dx * F.eu[0] + dz * F.eu[1]) / md.tileM, (dx * F.ev[0] + dz * F.ev[1]) / md.tileM]; } };
      grids.set(key, g);
    }
    return g;
  };
  // the level's view at bearing beta (any real): its world points and directions in tile units, and the drawn ground
  // under a point, on the tile map of the nearest whole bearing
  const mdOf = (L, beta) => {
    const md = LV[L], F = frameOf(beta), b = ((Math.round(beta) % NB) + NB) % NB, grid = gridOf(L, b);
    return {
      ...md, b, beta, F, grid, eu: F.eu, ev: F.ev, ox: F.ox, oz: F.oz,
      uv: (x, z) => { const dx = x - F.ox, dz = z - F.oz; return [(dx * F.eu[0] + dz * F.eu[1]) / md.tileM, (dx * F.ev[0] + dz * F.ev[1]) / md.tileM]; },
      world: (u, v) => [F.ox + (u * F.eu[0] + v * F.ev[0]) * md.tileM, F.oz + (u * F.eu[1] + v * F.ev[1]) * md.tileM],
      dir: (dx, dz) => [dx * F.eu[0] + dz * F.eu[1], dx * F.ev[0] + dz * F.ev[1]],
      // the drawn ground's level under world point (x, z), and whether it is water; and under point (u, v) of this view
      groundAt: (x, z) => G.ground(grid, ...grid.uv(x, z)),
      ground: (u, v) => { const [x, z] = [F.ox + (u * F.eu[0] + v * F.ev[0]) * md.tileM, F.oz + (u * F.eu[1] + v * F.ev[1]) * md.tileM]; return G.ground(grid, ...grid.uv(x, z)); },
      maxLev: md.peakLev,
      waterAt: (x, z) => G.isWater(grid, ...grid.uv(x, z)),
    };
  };
  const PL = LV.map((l) => l.p);
  // camera heights: the true ground on a 25 m grid, blurred 300 m or more, until VK * sqrt2 * |grad| <= 0.5 keeps the
  // camera's solves well posed; VK: screen px a meter of height rises, per screen px per meter across
  const VK = LV[0].lp / (LV[0].levelM * PL[0]);
  let HG = null, CH = null;
  // The camera heights of ground g, a generator that yields between its passes so the frames can take it a slice at a time (a planet window's ground is
  // too steep for the 64 passes' stop and takes all of them, 0.3 s in one piece).
  function* cameraHeightsOf(g) {
    const hg = { step: 25, n: Math.ceil(SIZE / 25) + 1 }, n = hg.n, r = Math.round(150 / hg.step);
    hg.h = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) hg.h[j * n + i] = Math.max(0, g.heightAt(ORIGIN + i * hg.step, ORIGIN + j * hg.step));
    yield;
    const ch = Float32Array.from(hg.h), tmp = new Float32Array(n * n);
    const steep = () => {
      let m = 0;
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const k = j * n + i, dx = ch[k + 1] - ch[k], dz = ch[k + n] - ch[k]; m = Math.max(m, dx * dx + dz * dz); }
      return (Math.sqrt(m) / hg.step) * VK * Math.SQRT2;
    };
    // one box blur along a line: its head and tail take the edges' counts, its long middle adds one and drops one with no test
    const blurLine = (src, dst, o, di) => {
      let a = 0, c = 0;
      for (let q = 0; q <= r && q < n; q++) { a += src[o + q * di]; c++; }
      let p = o, add = o + (r + 1) * di, sub = o, i = 0;
      for (; i < r && i < n; i++) { dst[p] = a / c; if (i + r + 1 < n) { a += src[add]; c++; } add += di; p += di; }
      for (; i < n - r - 1; i++) { dst[p] = a / c; a += src[add]; c++; a -= src[sub]; c--; add += di; sub += di; p += di; }
      for (; i < n; i++) { dst[p] = a / c; if (i + r + 1 < n) { a += src[add]; c++; } if (i - r >= 0) { a -= src[sub]; c--; } add += di; sub += di; p += di; }
    };
    let pass = 0;
    for (; pass < 2 || (pass < 64 && steep() > 0.5); pass++) {
      for (let j = 0; j < n; j++) blurLine(ch, tmp, j * n, 1);
      yield;
      for (let j = 0; j < n; j++) blurLine(tmp, ch, j, n);
      yield;
    }
    return { hg, ch, camHeight: { passes: pass, steep: +steep().toFixed(3) } };
  }
  const drain = (it) => { let s; while (!(s = it.next()).done); return s.value; };
  {
    const f = drain(cameraHeightsOf(G));
    HG = f.hg; CH = f.ch; stats.camHeight = f.camHeight;
  }
  const camHg = (x, z) => {
    const n = HG.n, fx = clamp((x - ORIGIN) / HG.step, 0, n - 1.001), fz = clamp((z - ORIGIN) / HG.step, 0, n - 1.001), i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, k = j * n + i;
    const h00 = CH[k], h10 = CH[k + 1], h01 = CH[k + n], h11 = CH[k + n + 1];
    return [(h00 * (1 - a) + h10 * a) * (1 - b) + (h01 * (1 - a) + h11 * a) * b, ((h10 - h00) * (1 - b) + (h11 - h01) * b) / HG.step, ((h01 - h00) * (1 - a) + (h11 - h10) * a) / HG.step];
  };
  const camH = (x, z) => camHg(x, z)[0];
  // zoom: log2 of screen px per meter over the island seen at 2 screen px per art px
  const PPM0 = 2 * PL[0], ppmOf = (z) => PPM0 * 2 ** z, ZMAX = Math.log2((4 * PL[NL - 1]) / PPM0);
  const named = Object.fromEntries(["island", "region", "valley", "close"].map((k) => [k, Math.log2((2 * PL[levelOf(k)]) / PPM0)]));

  // ---------- the planet under the ladder ----------
  // The ladder draws the play area; the planet (isopixel/planet.js, in the worker) lies under it at every zoom and is the only
  // picture from ZLAD out. One zoom runs from the whole planet to close: below the island level it is the planet's camera easing
  // from straight down to the ladder's own look (60 degrees from the vertical, bearing b turning it b * 45 degrees; a narrow field
  // of view at the end, so the sphere reads as the ladder's parallel projection). view.geo (lat, lon) is the target on the planet
  // and view.x, view.z the same place in the play area's metres; whichever moved last is kept (syncGeo).
  const PGQ = new URLSearchParams(location.search).get("pg"), PG_CANOPY = new URLSearchParams(location.search).get("cn") === null ? null : Number(new URLSearchParams(location.search).get("cn")), PLACE = fieldsMsg.place ?? null, PR = PLACE?.radiusM, D2R = Math.PI / 180, ISO_TILT = Math.PI / 3;
  // the zoom the ladder is first drawn at (faded in over the next step), and the play area's edge fade [design]
  const ZLAD = -1.5, PLAY_EDGE_M = 1200, LIFT_PER_COVER = 3;
  // the whole planet fits the canvas at its smallest zoom: 0.4 of the canvas's shorter side across a radius
  const zminNow = () => (PLACE ? Math.min(ZLAD - 0.5, Math.log2((0.4 * Math.min(canvas.width, canvas.height)) / (Math.SQRT2 * PR * PPM0))) : 0);
  const clampZ = (z) => clamp(z, zminNow(), ZMAX);
  const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vecOf = (g) => { const la = g.lat * D2R, lo = g.lon * D2R, c = Math.cos(la); return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)]; };
  const geoOfVec = (p) => { const l = Math.hypot(p[0], p[1], p[2]); return { lat: Math.asin(p[2] / l) / D2R, lon: Math.atan2(p[1], p[0]) / D2R }; };
  // the play area's plane (x east, z south of the place, ground.js place) and the sphere, gnomonic about the place
  // The ground the ladder draws is the island (the play area, true metres, north up) or a window of the planet's own ground laid at the camera by the
  // worker (groundwin.js: its frame is a face's axes, and a metre of its 75 m cells is `scale` true metres), so the plane is about FRM, not the place.
  let FRM = PLACE && { c: PLACE.c, e: PLACE.e, n: PLACE.n, scale: 1, rot: [1, 0, 0, 1] }, gid = 0, mode = "home", pendingGround = null, asked = null, askedSpec = null, onGround = null, winFadeAt = 0;
  // the window's ladder comes in over half a second from the planet layer under it when it replaces no window (the island, or no ground at all)
  const winFade = () => (winFadeAt ? smooth(0, 1, (performance.now() - winFadeAt) / 500) : 1);
  // A window's plane is its cell lattice, the frame its sprites stand in (cell (X, Y) of its face's gnomonic grid is plane ((X - x0 - 128) * 75, (y0 + 128 - Y) * 75), x east, z south): a cell is 75 m by its
  // own east and north arcs, which differ from each other and from a mean `scale` by a tenth and more away from a face's centre, so the place a plane point names on the sphere goes through the lattice
  // (the grid's own mapping, as latticeAt reads it), never the isotropic tangent plane, which drifts from the sprites by that tenth of the distance from the window's centre. The home island's plane is
  // true metres about the place (no lattice).
  const GL = PLACE?.windows ? await import("../globe.js") : null, FN = PR ? Math.round((PR * Math.PI) / (2 * CELL)) : 0, HALF = WIN_N / 2, QUARTER = Math.PI / 2;
  const cellsOfId = (id) => { const [face, x0, y0] = id.split(":").map(Number); return { face, x0, y0 }; };
  const geoOf = (x, z) => {
    const K = FRM.cells;
    if (!K) return geoOfVec([0, 1, 2].map((i) => FRM.c[i] + ((x * FRM.e[i] - z * FRM.n[i]) * FRM.scale) / PR));
    return geoOfVec(GL.pointOf(K.face, Math.tan(((K.x0 + HALF + x / CELL) / FN - 0.5) * QUARTER), Math.tan(((K.y0 + HALF - z / CELL) / FN - 0.5) * QUARTER)));
  };
  const planeOf = (g) => {
    const v = vecOf(g), K = FRM.cells;
    if (!K) { const d = dotv(v, FRM.c); return d > 0.1 ? { x: (PR * dotv(v, FRM.e)) / (d * FRM.scale), z: (-PR * dotv(v, FRM.n)) / (d * FRM.scale) } : null; }
    const F = GL.FRAMES[K.face], w = dotv(v, F.n);
    if (w < 0.2) return null;
    const X = (Math.atan(dotv(v, F.ex) / w) / QUARTER + 0.5) * FN, Y = (Math.atan(dotv(v, F.ey) / w) / QUARTER + 0.5) * FN;
    return { x: (X - K.x0 - HALF) * CELL, z: (K.y0 + HALF - Y) * CELL };
  };
  function syncGeo(view) {
    if (!PLACE) return;
    const s = view.synced, g = view.geo;
    if (!g || !s || view.x !== s.x || view.z !== s.z) view.geo = geoOf(view.x, view.z);
    else if (g.lat !== s.lat || g.lon !== s.lon) { const q = planeOf(g); if (q) { view.x = q.x; view.z = q.z; } }
    view.synced = { x: view.x, z: view.z, lat: view.geo.lat, lon: view.geo.lon };
  }
  // a target the camera solved for (solveTarget): its plane place, and its planet place when it came from the planet
  function setTarget(view, T) {
    view.x = T.x; view.z = T.z;
    if (T.geo) { view.geo = T.geo; view.synced = { x: view.x, z: view.z, lat: T.geo.lat, lon: T.geo.lon }; }
  }
  // The planet's camera and its geodesic pan hold where the play area's plane (flat, about the place) would stretch: from ZLAD out,
  // and wherever the target is farther from the place than the play area and the canvas's reach (a ladder view there draws nothing, so
  // nothing needs the plane). Within that reach the plane is true to a part in a hundred.
  const planetMode = (view) => {
    if (!PLACE) return false;
    if (view.zoom < ZLAD) return true;
    const g = view.geo;
    if (!g) return false;
    const ppm = ppmOf(clampZ(view.zoom)), reach = ((SIZE / 2 + PLAY_EDGE_M) * Math.SQRT2) + (1.25 * (0.71 * canvas.width + 1.41 * canvas.height)) / (2 * ppm);
    return (Math.acos(Math.min(1, dotv(vecOf(g), FRM.c))) * PR) / FRM.scale > reach;
  };
  const HAS_WIN = !!PLACE?.windows, HOME = FRM;
  // The ground message the worker sends when it has a window (or the island again) ready: taken at the next frame, where it replaces everything the
  // page works out from the ground's heights, puts the view in the new frame (the same place of the planet, its metres in the window's), and from
  // then on every frame names it (gid), which is how the worker knows to switch its renderer to it in the same frame.
  function applyGroundMsg(m, view, f) {
    commitFields(f);
    gid = m.gid;
    if (m.mode === "win" && mode !== "win") winFadeAt = performance.now();
    mode = m.mode;
    FRM = m.mode === "win" ? { c: m.frame.c, e: m.frame.e, n: m.frame.n, scale: m.frame.scale, rot: m.frame.rot, cells: cellsOfId(m.frame.id) } : HOME;
    if (view.geo) {
      const q = planeOf(view.geo);
      if (q) { view.x = q.x; view.z = q.z; }
      view.synced = { x: view.x, z: view.z, lat: view.geo.lat, lon: view.geo.lon };
    }
    stats.window = m.stats ?? null;
    onGround?.(mode);
  }
  // the target's own drift (a pan, a follow) carried 3 s on: the window the view will want then is asked for now, speculatively
  let panAt = 0, panGeo = null, panV = null;
  function panAhead(view, now) {
    if (!view.geo) return;
    if (panGeo && now > panAt) {
      const dt = (now - panAt) / 1000, vl = (view.geo.lat - panGeo.lat) / dt, vo = (view.geo.lon - panGeo.lon) / dt;
      panV = panV ? { lat: panV.lat * 0.8 + vl * 0.2, lon: panV.lon * 0.8 + vo * 0.2 } : { lat: vl, lon: vo };
    }
    panGeo = { lat: view.geo.lat, lon: view.geo.lon };
    panAt = now;
    if (!panV || Math.hypot(panV.lat, panV.lon * Math.cos(view.geo.lat * D2R)) * D2R * PR < 150) return;
    wantGround({ ...view, geo: { lat: view.geo.lat + panV.lat * 3, lon: view.geo.lon + panV.lon * 3 } }, now, true);
  }
  // Which ground the camera wants: the island's while its view stays inside the play area, else a window laid at the camera, made again when the view
  // nears the window's edge (the worker is told, and answers when it has it; until then the ladder draws what ground it has)
  function wantGround(view, now, speculative = false) {
    if (!HAS_WIN || !objectsReady || view.zoom < ZLAD + 0.5 || !view.geo) return;
    const ext = viewExtent(view), half = (canvas.width / 2 + canvas.height) / ppmOf(clampZ(view.zoom)), v = vecOf(view.geo), arc = (c) => Math.acos(Math.min(1, dotv(v, c))) * PR;
    // a view wider than a window can cover (the coarse ladder levels) is drawn by the planet layer alone away from the island: asking for windows there
    // would make one at every step of a pan, each a few seconds of the GPU's work for ground that cannot cover the view. mC is the margin a window laid at the camera leaves
    // (coverMargin); a window is made again when the camera nears the point where the screen's fade (half the viewport's reach) and a prefetch margin begin.
    const mC = SIZE / 2 - PLAY_EDGE_M - ext;
    if (mC < 0) return;
    let want = null;
    // with no game on it the play area is the planet's ground like any other (a window), never the island stamp
    if (simOpts && arc(HOME.c) < mC + 800) { if (mode !== "home") want = { mode: "home" }; }
    else if (mode !== "win" || arc(FRM.c) / FRM.scale > mC - 0.5 * ext - 800) want = { mode: "win", lat: view.geo.lat, lon: view.geo.lon, half, ext };
    // a speculative ask is for the view a zoom is heading to: the worker makes the window ahead of the view that needs it, and keeps it
    if (speculative) {
      if (!want || want.mode !== "win") return;
      if (askedSpec && now - askedSpec.t < 5000 && Math.hypot(askedSpec.lat - want.lat, askedSpec.lon - want.lon) * D2R * PR < 1500) return;
      askedSpec = { ...want, t: now };
      worker.postMessage({ type: "want", ...want, speculative: true });
      return;
    }
    if (!want) { asked = null; return; }
    // an ask stands until the camera has gone 1.5 km from where it was made (or the worker says it failed, or nothing is wanted): a window made at the camera is up to a snap (32 cells) from it, which at
    // some zooms already counts as near its edge, and asking again at once for the same window kept the worker rebuilding it
    if (asked && asked.mode === want.mode && (want.mode === "home" || Math.hypot(asked.lat - want.lat, asked.lon - want.lon) * D2R * PR < 1500)) return;
    asked = { ...want, t: now };
    worker.postMessage({ type: "want", ...want });
  }
  // One sun and one moon for the whole planet, set so that over the play area they are the sim's (sky.ts, whose island lies at its own latitude and whose clock
  // is the game's 24 hour day, not the planet's spin): each body's direction over the play area (its compass bearing and elevation) is a point of the sky,
  // and every other place of the planet sees that same point from where it stands. So the sun shows a day side, a night side and a terminator on the globe, turns
  // once to the game's day and rises and sets over the year's tilt as the sim's does, and a place's light on the globe is its light at the close levels.
  const skyVec = (b) => { const dl = Math.hypot(b.dir[0], b.dir[1]) || 1, ce = Math.cos(b.el); return [0, 1, 2].map((i) => PLACE.c[i] * Math.sin(b.el) + ce * ((PLACE.e[i] * b.dir[0]) / dl - (PLACE.n[i] * b.dir[1]) / dl)); };
  // a sky point as a body over a place's frame (c up, e east, n north: x east and z south on its plane)
  function bodyOver(v, F) {
    const u = dotv(v, F.c), e = dotv(v, F.e), n = dotv(v, F.n), h = Math.hypot(e, n);
    return { dir: h > 1e-9 ? [e / h, -n / h] : [0, 1], el: Math.asin(clamp(u, -1, 1)), tan: u / Math.max(h, 1e-9) };
  }
  const planetSky = (k) => ({ sun: bodyOver(skyVec(k.sun), FRM), moon: { ...bodyOver(skyVec(k.moon), FRM), phase: k.moon.phase, lit: k.moon.lit }, id: gid });
  // The sky over the camera's target whichever ground the ladder stands on, so the light tables and the ambient the planet pass is drawn through are the target's at every zoom
  // (the frame's axes are the plane's, turned off the target's up to stand tangent there): the sun and moon are one point of the sky each, seen from the target's own horizon.
  // Its id changes with the sun's and moon's elevation in steps of an eighth of a degree, which is when the tables are made again.
  function planetSkyAt(k, geo) {
    const c = vecOf(geo), tangent = (a) => { const d = dotv(a, c), r = [a[0] - c[0] * d, a[1] - c[1] * d, a[2] - c[2] * d], l = Math.hypot(r[0], r[1], r[2]) || 1; return [r[0] / l, r[1] / l, r[2] / l]; };
    const F = { c, e: tangent(FRM.e), n: tangent(FRM.n) }, sun = bodyOver(skyVec(k.sun), F), moon = bodyOver(skyVec(k.moon), F);
    return { sun, moon: { ...moon, phase: k.moon.phase, lit: k.moon.lit }, id: `${gid}|${Math.round(sun.el * 8 / D2R)}|${Math.round(moon.el * 8 / D2R)}` };
  }
  // The cells under a place as the planet's grid lays them, in the frame a window of them there would have (east along the cells' X axis, north across it): `sc` true metres a frame metre, `turn` the
  // frame's north from true north, and `q`, the 2 by 2 on the frame's east and north that carries it to the cells' own axes, which the planet's camera maps its rays by (planet-cam.js). One answer for a
  // place whether or not a window is drawn, so the ground has one projection in every mode and a window's arrival changes nothing. With no window it is the face the place lies on, which is the face a window made there would be on, so the picture does not depend on whether a window was made on the way (a face kept past its edge drew the cells 1.4 times their size at the planet's highest range, and the relief with them).
  let latFace = 0;
  function latticeAt(geo) {
    if (!GL) return { sc: FRM.scale, turn: Math.atan2(FRM.rot[2], FRM.rot[3]), q: null };
    const c = vecOf(geo);
    // a window's own face where the target lies within its reach (the sprites stand in that lattice, even past a cube edge), else the face the target is on
    if (FRM.cells && Math.acos(Math.min(1, dotv(c, FRM.c))) * PR < SIZE) latFace = FRM.cells.face;
    else latFace = GL.FRAMES.reduce((b, F, i) => (dotv(c, F.n) > dotv(c, GL.FRAMES[b].n) ? i : b), 0);
    const F = GL.FRAMES[latFace], w = dotv(c, F.n), sx = (Math.atan(dotv(c, F.ex) / w) / QUARTER + 0.5) * FN, sy = (Math.atan(dotv(c, F.ey) / w) / QUARTER + 0.5) * FN;
    const at = (dx, dy) => GL.pointOf(latFace, Math.tan(((sx + dx) / FN - 0.5) * QUARTER), Math.tan(((sy + dy) / FN - 0.5) * QUARTER));
    const [E, Nn] = GL.eastNorth(c), per = PR / CELL, a = at(0.5, 0), b = at(-0.5, 0), c2 = at(0, 0.5), d = at(0, -0.5);
    const jx = [(dotv(a, E) - dotv(b, E)) * per, (dotv(a, Nn) - dotv(b, Nn)) * per], jz = [-(dotv(c2, E) - dotv(d, E)) * per, -(dotv(c2, Nn) - dotv(d, Nn)) * per];
    const lx = Math.hypot(jx[0], jx[1]), sc = Math.sqrt(lx * Math.hypot(jz[0], jz[1])), eE = jx[0] / lx, eN = jx[1] / lx;
    // the frame's own axes: x along the cells' X axis, z south across it
    const x0 = [sc * eE, sc * eN], z0 = [sc * eN, -sc * eE], det = x0[0] * z0[1] - z0[0] * x0[1], inv = [z0[1] / det, -z0[0] / det, -x0[1] / det, x0[0] / det];
    return { sc, turn: Math.atan2(-eN, eE), q: [jx[0] * inv[0] + jz[0] * inv[2], jx[0] * inv[1] + jz[0] * inv[3], jx[1] * inv[0] + jz[1] * inv[2], jx[1] * inv[1] + jz[1] * inv[3]] };
  }
  // The lattice the planet camera draws with. latticeAt's is a face's, and where the target crosses a cube edge out of a window's reach the cells of the two faces lie at an angle to each other
  // (47 degrees at 9 degrees from a corner, none at an edge's middle; a cube's square lattice has eight cone points, so no picture that follows the lattice can turn the same way everywhere),
  // so the picture would turn by all of it in one frame. The camera's lattice follows the exact one with time constant LAT_TAU, once a frame (latTick), and is the exact one where sprites show,
  // which stand in it (the window's cover), so the ladder and the planet under it always agree and nothing else changes: with the target in one face the two are the same.
  // [design: 350 ms, a quarter turn in about a third of a second, as the camera's Q and E and planet.js's level rise]
  const LAT_TAU = 350, WIN_COVER = (view) => (mode === "win" && !simOpts ? winFade() * Math.min(1, LIFT_PER_COVER * coverFade(view)) : 1), LAT_COVER = (view) => (simOpts ? 1 : mode === "win" ? WIN_COVER(view) : 0);
  let latS = null, latAt = 0;
  function latTick(view) {
    if (!PLACE || !view.geo) return;
    const T = latticeAt(view.geo), now = performance.now();
    if (!latS || !T.q) { latS = { sc: T.sc, turn: T.turn, q: T.q && [...T.q] }; latAt = now; return; }
    const a = 1 - Math.exp(-Math.min(1000, now - latAt) / LAT_TAU);
    latAt = now;
    latS.turn += (((T.turn - latS.turn + 3 * Math.PI) % TAU) - Math.PI) * a;
    latS.sc += (T.sc - latS.sc) * a;
    latS.q = latS.q.map((v, i) => v + (T.q[i] - v) * a);
  }
  // the lattice moves once a frame; a camera that holds ground by it moves it first, so the hold is solved for the picture drawn, and the frame then takes it as it is
  let latPre = false;
  function tickLattice(view) { latTick(view); latPre = true; }
  function latOf(view) {
    const T = latticeAt(view.geo);
    if (!T.q) return T;
    if (!latS) latTick(view);
    const c = LAT_COVER(view), S = latS;
    return { sc: S.sc + (T.sc - S.sc) * c, turn: S.turn + (((T.turn - S.turn + 3 * Math.PI) % TAU) - Math.PI) * c, q: S.q.map((v, i) => v + (T.q[i] - v) * c) };
  }
  // the planet camera's look at a zoom: u runs from the whole planet (0) to the ladder's first zoom (1)
  function planetParams(view) {
    const zw = zminNow(), u = clamp((view.zoom - zw) / (ZLAD - zw), 0, 1), k = smooth(0.25, 0.9, u), tanH = 0.414 * (0.05 / 0.414) ** smooth(0.2, 0.9, u), ortho = smooth(ZLAD - 1.5, ZLAD, view.zoom);
    const lat = latOf(view), scale = 1 + ortho * (lat.sc - 1);
    // the ladder's screen x runs along (1, -1) of the plane, root 2 px a metre per px a metre of its world axes
    const ppm = ppmOf(clampZ(view.zoom)), dist = (canvas.height * scale) / (2 * Math.SQRT2 * ppm * tanH);
    // screen up on the ground at bearing b is the plane's (-1, -1) turned b * 45 degrees, the plane's north turned from the planet's by the frame's turn (as far as the camera is parallel); the whole planet is north up
    // until the bearing turns it
    let iso = ((45 * (view.bearing ?? 0) + k * -45) * D2R + k * ortho * lat.turn) % TAU;
    iso = iso > Math.PI ? iso - TAU : iso < -Math.PI ? iso + TAU : iso;
    // the light is the planet's sun (planetSky): day, night and the terminator between, as the clock stands
    const light = skyVec(homeSky?.sun ?? { el: 0.8, dir: [0.6, 0.8] }), moon = homeSky?.moon ? skyVec(homeSky.moon) : [0, 0, 1];
    // the camera stands on the planet's own height under the target until the ladder's sprites show, then eases to the ladder's camera height (they differ by tens of metres on a mountain and by a kilometre at the
  // planet's highest range) as the window's cover grows, so the same view is the same picture whether a window of this place was made on the way (the camera height is the window's, a place's window is kept
  // after a zoom out) or not. It is whole by the time the sprites are a third of the picture, where they must stand on the ground: LIFT_PER_COVER [design: 3, a third]
    return { lat: view.geo.lat, lon: view.geo.lon, dist, tilt: ISO_TILT * k, heading: iso, tanH, ortho, q: lat.q, scale: lat.sc, liftOrtho: ortho * WIN_COVER(view), liftM: mode === "win" || simOpts ? (camH(view.x, view.z) + (view.up || 0)) * EXAG : null, sun: light, moon, moonMix: sky ? smooth(3, -2, sky.e) : 0, amb: ambientOf(Math.sin(sky?.sun?.el ?? 0.8)), riverCut: clamp((720 * ((canvas.height * scale) / ppm)) / PR, 20, 3000) };
  }
  // the camera as the worker drew it last frame: stood above the ground under its target (stats.lift), so a pick lands on what is drawn
  const planetCamOf = (view, lift = stats.lift ?? 0) => { const p = planetParams(view); return planetCam({ ...p, w: canvas.width, h: canvas.height, radiusM: PR, lift }); };
  // the drawn relief (drawn metres of height) under canvas point (sx, sy), from the grid the worker posted with the last frame (worker.js reliefGrid); the target's own lift where it has none
  function reliefAt(sx, sy) {
    const R = stats.relief, lift = stats.lift ?? 0;
    if (!R) return lift;
    const fx = clamp((sx / canvas.width) * (R.w - 1), 0, R.w - 1.001), fy = clamp((sy / canvas.height) * (R.h - 1), 0, R.h - 1.001), i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j, k = j * R.w + i;
    const v = [R.d[k], R.d[k + 1], R.d[k + R.w], R.d[k + R.w + 1]], ok = v.filter((x) => x >= 0);
    if (ok.length < 4) return ok.length ? ok.reduce((s, x) => s + x, 0) / ok.length : lift;
    return (v[0] * (1 - a) + v[1] * a) * (1 - b) + (v[2] * (1 - a) + v[3] * a) * b;
  }
  // drawn metres of height a terrain metre is at this view: the relief's exaggeration, times the cells' scale as far as the camera is parallel (worker.js ex)
  const drawnK = (view) => EXAG * (1 + smooth(ZLAD - 1.5, ZLAD, view.zoom) * (latOf(view).sc - 1));
  // where planet place geo is drawn, and the height (drawn metres) it stands at: `y`, terrain metres, when the caller has it (what groundUnder answered); otherwise the height drawn where it lands, found a few times over
  function planetProject(view, geo, y) {
    const cam = planetCamOf(view), P = vecOf(geo), at = (h) => cam.project([P[0] * (1 + h / PR), P[1] * (1 + h / PR), P[2] * (1 + h / PR)]);
    let h = Number.isFinite(y) ? y * drawnK(view) : stats.lift ?? 0, s;
    for (let k = 0; k < (Number.isFinite(y) ? 0 : 3); k++) {
      s = at(h);
      if (!s) return null;
      const next = reliefAt(s[0], s[1]);
      if (Math.abs(next - h) < 0.5) break;
      h = next;
    }
    s = at(h);
    return s ? { s, h } : null;
  }
  const planetScreen = (view, geo, y) => planetProject(view, geo, y)?.s ?? [-1e9, -1e9];
  function planetUnder(view, sx, sy) {
    syncGeo(view);
    const h = reliefAt(sx, sy), P = planetCamOf(view).pick(sx, sy, h);
    if (!P) return null;
    const geo = geoOfVec(P), q = planeOf(geo);
    return { x: q?.x ?? 0, z: q?.z ?? 0, y: h / drawnK(view), geo };
  }
  // Gauss-Newton on where the grabbed place P is drawn (at hA drawn metres) against the cursor (sx, sy), from the target standing at `from`, in the target's two tangent steps, a step taken only when it brings the place
  // nearer the cursor; the nearest the place comes to the cursor (its target and its distance e from the cursor, px), or null where it is not drawn. miss: canvas px, drawn minus wanted
  const POLE_LAT = 60;
  function refineTarget(view, P, hA, sx, sy, lift0, from) {
    const PH = P.map((v) => v * (1 + hA / PR)), miss = (g) => { const s = planetCamOf({ ...view, geo: g }, lift0).project(PH); return s ? [s[0] - sx, s[1] - sy] : null; };
    // the target moved by (u, v) radians along its east and north (the camera's own frame, planet-cam.js)
    const moved = (g, u, v) => {
      const la = clamp(g.lat, -89.999, 89.999) * D2R, lo = g.lon * D2R, cl = Math.cos(la), T = [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
      const E = [-Math.sin(lo), Math.cos(lo), 0], N = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), cl];
      return geoOfVec([0, 1, 2].map((i) => T[i] + u * E[i] + v * N[i]));
    };
    const cam0 = planetCamOf(view, lift0), pxPerRad = canvas.height / 2 / (cam0.tanH * (cam0.dist / PR)), d = 1 / pxPerRad;
    let g = { ...from }, r = miss(g);
    if (!r) return null;
    for (let k = 0; k < 16 && Math.hypot(r[0], r[1]) > 0.02; k++) {
      const ru = miss(moved(g, d, 0)), rv = miss(moved(g, 0, d));
      if (!ru || !rv) break;
      const a = (ru[0] - r[0]) / d, b = (rv[0] - r[0]) / d, c = (ru[1] - r[1]) / d, e = (rv[1] - r[1]) / d, det = a * e - b * c;
      if (Math.abs(det) < 1e-9 * pxPerRad * pxPerRad) break;
      const du = -(e * r[0] - b * r[1]) / det, dv = -(a * r[1] - c * r[0]) / det;
      let t = 1, took = false;
      for (let j = 0; j < 12 && !took; j++, t /= 2) {
        const g2 = moved(g, t * du, t * dv), r2 = miss(g2);
        if (r2 && Math.hypot(r2[0], r2[1]) < Math.hypot(r[0], r[1])) { g = g2; r = r2; took = true; }
      }
      if (!took) break;
    }
    return { g, e: Math.hypot(r[0], r[1]) };
  }
  // the target, as a planet place, that shows planet place geo at (ox, oy) px off centre: the target is turned until the point
  // under that spot is geo, the point standing at its own height (y, terrain metres, as groundUnder answered; the target's own is the camera's lift)
  function planetSolve(view, geo, ox, oy, y) {
    syncGeo(view);
    const P = vecOf(geo), sx = canvas.width / 2 + ox, sy = canvas.height / 2 + oy, isTarget = geo.lat === view.geo.lat && geo.lon === view.geo.lon;
    const hA = isTarget ? stats.lift ?? 0 : Number.isFinite(y) ? y * drawnK(view) : planetProject(view, geo)?.h ?? stats.lift ?? 0;
    let g = { ...view.geo };
    // the camera stands at the lift the worker gave the target (worker.js: the ground's height averaged over a box the view's size, which a move of the target changes slowly)
    const lift0 = stats.lift ?? 0;
    for (let k = 0; k < 10; k++) {
      const Q = planetCamOf({ ...view, geo: g }, lift0).pick(sx, sy, hA);
      if (!Q) return null;
      const ax = [Q[1] * P[2] - Q[2] * P[1], Q[2] * P[0] - Q[0] * P[2], Q[0] * P[1] - Q[1] * P[0]], s = Math.hypot(ax[0], ax[1], ax[2]);
      if (s < 1e-12) break;
      const ang = Math.atan2(s, dotv(Q, P)), n = ax.map((v) => v / s), T = vecOf(g), c = Math.cos(ang), sn = Math.sin(ang), nt = dotv(n, T);
      const nxT = [n[1] * T[2] - n[2] * T[1], n[2] * T[0] - n[0] * T[2], n[0] * T[1] - n[1] * T[0]];
      g = geoOfVec([0, 1, 2].map((i) => T[i] * c + nxT[i] * sn + n[i] * nt * (1 - c)));
      if (ang < 1e-10) break;
    }
    // The iteration is a rigid turn of the sphere taking the picked place to the grabbed one, which the camera is not once the target stands near the cube's cone points (the lattice) or a pole (the north-up frame turns by
    // the target's longitude times the sine of the latitude): it may stop a few px short or fold down the far side of a pole, which was a target thrown to the pole and the grabbed ground with it. So its answer is
    // polished by Gauss-Newton on the drawn place, and near a pole that is the answer itself, found from where the target stands: the one the target reaches by the way it came. With north up a place cannot be dragged on
    // past where the pole stands at the screen's centre (the target would have to cross the pole, and the place would be drawn on the far side of the centre), so there the answer is the nearest it comes to the cursor.
    const polar = Math.abs(view.geo.lat) > POLE_LAT || Math.abs(g.lat) > POLE_LAT;
    let best = refineTarget(view, P, hA, sx, sy, lift0, polar ? view.geo : g);
    // a polar answer that stops short (the cursor gone out of reach and come back) is a valley the way back does not lead out of: the iteration's answer is tried too, and wins when it comes nearer
    if (polar && (!best || best.e > 0.5)) { const alt = refineTarget(view, P, hA, sx, sy, lift0, g); if (alt && (!best || alt.e < best.e - 0.5)) best = alt; }
    if (best) g = best.g;
    const q = planeOf(g);
    return { x: q?.x ?? view.x, z: q?.z ?? view.z, geo: g };
  }
  // the level drawn at a zoom: the coarsest one still at 2 screen px or more per art px, and how far along its range
  function levelFor(zoom) {
    const ppm = ppmOf(clampZ(zoom));
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
    for (const key of Object.keys(v0)) { const x = v0[key], y = v1[key]; out[key] = Math.round(x * (y / x) ** f); }
    return out;
  });

  // ---------- the sim's objects ----------
  // The worker keeps them all on the GPU and changes them as the sim ticks; this side draws the kinds that change often
  // every frame (the sim's liveThings), and the page's tick ends with what changed of those.
  let simRef = null, season = "spring";

  // ---------- live sprites, made here and sent to the worker's atlas once ----------
  const sprites = new Map(), sentSprites = new Set();
  let spriteNo = 0, frameSprites = [];
  // a sprite by key; keys follow continuous sizes, so the cache is emptied now and then rather than left to grow
  const spr = (key, make) => {
    let s = sprites.get(key);
    if (s === undefined) { if (sprites.size > 3000) sprites.clear(); s = make() || null; if (s) s.sid = ++spriteNo; sprites.set(key, s); }
    return s;
  };
  // the worker's id of a sprite, sent with this frame if it has not had it
  const use = (s) => {
    if (!sentSprites.has(s.sid)) { sentSprites.add(s.sid); frameSprites.push({ id: s.sid, w: s.w, h: s.h, ax: s.ax, ay: s.ay, foot: s.foot || 0, p: s.p.slice() }); }
    return s.sid;
  };

  // ---------- cameras ----------
  function project(cam, x, z) {
    const md = cam.md, [u, v] = md.uv(x, z), lev = md.groundAt(x, z);
    return { u, v, lev, gx: (u - v) * md.H, gy: (u + v) * md.hb - lev * md.lp, cz: 1.5 * md.H * (u + v) + lev * md.lp };
  }
  // A camera at one level and bearing: the art buffer covering the canvas at this zoom, and where its top-left pixel lands
  // on the canvas. czc: the depth of its target, which the GPU's depths are taken from. margin: a share of the canvas the
  // buffer reaches past it on every side (a fading level's, so the renderer can present it again a frame later).
  function camera(view, L, beta, margin = 0) {
    const md = mdOf(L, beta), s = ppmOf(clampZ(view.zoom)) / md.p, [u, v] = md.uv(view.x, view.z), lev = (camH(view.x, view.z) + (view.up || 0)) / md.levelM;
    const W = canvas.width, H = canvas.height, gcx = (u - v) * md.H, gcy = (u + v) * md.hb - lev * md.lp;
    const AW = Math.ceil((W / s) * (1 + 2 * margin)) + 4, AH = Math.ceil((H / s) * (1 + 2 * margin)) + 4, gx0 = Math.floor(gcx - AW / 2), gy0 = Math.floor(gcy - AH / 2);
    return { view, md, L, s, AW, AH, gcx, gcy, gx0, gy0, lev, czc: 1.5 * md.H * (u + v) + lev * md.lp, dx: W / 2 + (gx0 - gcx) * s, dy: H / 2 + (gy0 - gcy) * s };
  }
  // a sprite's shadow per art px of its height at the view's bearing, as the bake's V.shx, V.shy for this sun, no
  // longer than a 5 degree sun's
  const sunStep = (md, sun) => {
    const du = -(sun.dir[0] * md.eu[0] + sun.dir[1] * md.eu[1]), dv = -(sun.dir[0] * md.ev[0] + sun.dir[1] * md.ev[1]), cot = 0.8165 / Math.max(Math.tan(0.09), sun.tan);
    return [(du - dv) * cot, (du + dv) * 0.5 * cot];
  };
  // How far from the camera's own depth any pixel of its view can stand (gy + z = 2H(u + v), so z = 3 gy + 4 lev lp): the
  // GPU's depth spans this either side, so even a far level's crowded specks of trees sort as finely as the CPU sorted them.
  const zSpan = (cam, top) => 3 * (cam.AH + 2 * cam.md.tall) + 4 * (top + Math.abs(cam.lev) + 2) * cam.md.lp + 4 * cam.md.tall + 64;
  // The tile window of the grid under a camera: every tile whose ground, or whose sprites and their shadows, can show in it.
  // Ground at a screen point lies between the lowest and the highest ground of the footprint that screen can see, so the window is laid for those heights and then again for the
  // lowest and highest ground in the window so found, until it stops shrinking: a peak or a high plateau elsewhere in the island (or in the first, widest window) does not widen it, which
  // sized the ladder's terrain grid by the window's highest ground and cost up to 14 ms of a frame. [i0, j0, ni, nj, the highest level].
  function windowOf(cam, vec, cut = true) {
    const md = cam.md, grid = md.grid, reach = md.tall * (2 + Math.hypot(vec[0], vec[1])) + 16, offx = cam.gcx - cam.gx0, offy = cam.gcy - cam.gy0;
    let top = md.peakLev, bot = 0, win = null;
    for (let pass = 0; pass < 4; pass++) {
      let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const sx of [-reach, cam.AW + reach])
        for (const sy of [-reach, cam.AH + reach])
          for (const lev of [bot, top]) {
            const a = (sx - offx) / md.H, b = (sy - offy + (lev - cam.lev) * md.lp) / md.hb, du = (a + b) / 2, dv = (b - a) / 2;
            const x = cam.view.x + (du * md.eu[0] + dv * md.ev[0]) * md.tileM, z = cam.view.z + (du * md.eu[1] + dv * md.ev[1]) * md.tileM, [u, v] = grid.uv(x, z);
            i0 = Math.min(i0, u); i1 = Math.max(i1, u); j0 = Math.min(j0, v); j1 = Math.max(j1, v);
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
          }
      const pad = 3;
      win = [Math.floor(i0) - pad, Math.floor(j0) - pad, Math.ceil(i1 - i0) + 2 * pad + 1, Math.ceil(j1 - j0) + 2 * pad + 1, top];
      const r = [x0 - md.tileM * 2, z0 - md.tileM * 2, x1 + md.tileM * 2, z1 + md.tileM * 2], nTop = Math.min(top, Math.ceil((highest(...r) + 10) / md.levelM)), nBot = Math.max(bot, Math.floor((lowest(...r) - 10) / md.levelM));
      if (nTop === top && nBot === bot) break;
      top = nTop; bot = nBot;
    }
    return cut ? cutBlocks(cam, reach, win) : win;
  }
  // The window is a rectangle in the grid's axes laid for the lowest and highest ground in all of it, and on steep ground most of it lies off the screen (a mountain's face: a million tiles
  // for 500 on screen). It is cut to the blocks of BLK by BLK tiles that can show: a block shows where its corners, at the lowest and highest ground and water standing in it (the island's
  // extremes by MH_M cell, a cell's margin all round), lie on the buffer less the sprites' reach, and the tile passes work on those, a ring of blocks round them for the neighbours the vertices
  // and banks read, and on nothing else. The rectangle is the bounding box of the blocks, at whole blocks, so it follows the visible ground. [i0, j0, ni, nj, top, the blocks]: each block as
  // its index in the rectangle's blocks, a bit above 2^30 when it is one of those that can show (the ring's are for their neighbours only).
  const BLK = 16;
  function cutBlocks(cam, reach, win) {
    const md = cam.md, grid = md.grid, [i0, j0, ni, nj, top] = win, offx = cam.gcx - cam.gx0, offy = cam.gcy - cam.gy0, [cu, cv] = md.uv(cam.view.x, cam.view.z);
    const bi0 = Math.floor(i0 / BLK), bj0 = Math.floor(j0 / BLK), nbi = Math.floor((i0 + ni - 1) / BLK) - bi0 + 1, nbj = Math.floor((j0 + nj - 1) / BLK) - bj0 + 1;
    const core = new Uint8Array(nbi * nbj), m2 = md.tileM * 2;
    let ci0 = Infinity, ci1 = -1, cj0 = Infinity, cj1 = -1;
    for (let bj = 0; bj < nbj; bj++)
      for (let bi = 0; bi < nbi; bi++) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, sx0 = Infinity, sx1 = -Infinity, sb0 = Infinity, sb1 = -Infinity;
        for (let c = 0; c < 4; c++) {
          const [x, z] = grid.toW((bi0 + bi + (c & 1)) * BLK, (bj0 + bj + (c >> 1)) * BLK), [mu, mv] = md.uv(x, z), du = mu - cu, dv = mv - cv, sx = offx + (du - dv) * md.H, sb = offy + (du + dv) * md.hb + cam.lev * md.lp;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); sx0 = Math.min(sx0, sx); sx1 = Math.max(sx1, sx); sb0 = Math.min(sb0, sb); sb1 = Math.max(sb1, sb);
        }
        if (sx1 < -reach || sx0 > cam.AW + reach) continue;
        const hi = Math.max(0, Math.ceil((highest(x0 - m2, z0 - m2, x1 + m2, z1 + m2) + 10) / md.levelM)), lo = Math.max(0, Math.floor((lowest(x0 - m2, z0 - m2, x1 + m2, z1 + m2) - 10) / md.levelM));
        if (sb1 - lo * md.lp < -reach || sb0 - hi * md.lp > cam.AH + reach) continue;
        core[bj * nbi + bi] = 1;
        ci0 = Math.min(ci0, bi); ci1 = Math.max(ci1, bi); cj0 = Math.min(cj0, bj); cj1 = Math.max(cj1, bj);
      }
    if (ci1 < 0) return [bi0 * BLK, bj0 * BLK, 3 * BLK, 3 * BLK, top, new Uint32Array(0)];
    // the rectangle: the blocks that can show and a ring of one
    const ai0 = Math.max(0, ci0 - 1), ai1 = Math.min(nbi - 1, ci1 + 1), aj0 = Math.max(0, cj0 - 1), aj1 = Math.min(nbj - 1, cj1 + 1), wi = ai1 - ai0 + 1, wj = aj1 - aj0 + 1, list = [];
    for (let bj = aj0; bj <= aj1; bj++)
      for (let bi = ai0; bi <= ai1; bi++) {
        let near = false, here = core[bj * nbi + bi] === 1;
        for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1; di++) { const a = bi + di, b = bj + dj; if (a >= 0 && b >= 0 && a < nbi && b < nbj && core[b * nbi + a]) { near = true; break; } }
        if (near) list.push(((bj - aj0) * wi + (bi - ai0)) | (here ? 0x40000000 : 0));
      }
    return [(bi0 + ai0) * BLK, (bj0 + aj0) * BLK, wi * BLK, wj * BLK, top, Uint32Array.from(list)];
  }
  // the highest and lowest ground in a world rectangle, from the island's heights in MH_M cells
  const MH_M = 300, MHN = Math.ceil(SIZE / MH_M);
  let MH = null;
  // f: the fields' height and water by cell: a lake's surface can stand above every ground sample of the cell it lies in, and the tile map draws it there
  function highestOf(g, f) {
    const hi = new Float32Array(MHN * MHN), lo = new Float32Array(MHN * MHN).fill(Infinity);
    for (let j = 0; j < MHN * 8; j++)
      for (let i = 0; i < MHN * 8; i++) {
        const h = g.heightAt(ORIGIN + (i + 0.5) * (MH_M / 8), ORIGIN + (j + 0.5) * (MH_M / 8)), k = (j >> 3) * MHN + (i >> 3);
        if (h > hi[k]) hi[k] = h;
        if (h < lo[k]) lo[k] = h;
      }
    if (f?.water)
      for (let Y = 0; Y < WIN_N; Y++)
        for (let X = 0; X < WIN_N; X++) {
          const w = f.water[Y * WIN_N + X];
          if (w <= 0) continue;
          const a = clamp(Math.floor((X * CELL) / MH_M), 0, MHN - 1), b = clamp(Math.floor((Y * CELL) / MH_M), 0, MHN - 1), k = b * MHN + a, s = f.height[Y * WIN_N + X] + w;
          if (s > hi[k]) hi[k] = s;
        }
    return { hi, lo };
  }
  MH = highestOf(G);
  // the ground replaced by another's heights and water (the worker's window of the planet, or the island again): everything the page works out
  // from them is made again, a slice of it a frame (fieldsOf) while the old ground stays, then all at once (commitFields)
  function* fieldsOf(msg) {
    const g = createGround(msg), hs = yield* cameraHeightsOf(g);
    return { G: g, peak: msg.peak, ...hs, mh: highestOf(g, msg) };
  }
  function commitFields(f) {
    G = f.G; peak = f.peak;
    for (const l of LV) l.peakLev = Math.ceil((peak + 10) / l.levelM);
    HG = f.hg; CH = f.ch; MH = f.mh; stats.camHeight = f.camHeight;
  }
  // the ground message in hand, its fields made up to FIELDS_SLICE_MS a frame (a new message in hand starts again)
  const FIELDS_SLICE_MS = 12;
  let fieldsJob = null;
  function fieldsSlice(m) {
    if (fieldsJob?.m !== m) fieldsJob = { m, it: fieldsOf(m.fields) };
    const t = performance.now();
    for (let s = fieldsJob.it.next(); ; s = fieldsJob.it.next()) {
      if (s.done) { const f = s.value; fieldsJob = null; return f; }
      if (performance.now() - t > FIELDS_SLICE_MS) return null;
    }
  }
  // a cell's own samples miss the crest (or the hollow) between them by little; one cell's margin all round takes it in
  const extreme = (grid, pick, init, x0, z0, x1, z1) => {
    const c = (v) => clamp(Math.floor((v - ORIGIN) / MH_M), 0, MHN - 1), a0 = c(x0) - 1, a1 = c(x1) + 1, b0 = c(z0) - 1, b1 = c(z1) + 1;
    let m = init;
    for (let b = Math.max(0, b0); b <= Math.min(MHN - 1, b1); b++) for (let a = Math.max(0, a0); a <= Math.min(MHN - 1, a1); a++) m = pick(m, grid[b * MHN + a]);
    return m;
  };
  const highest = (...r) => extreme(MH.hi, Math.max, 0, ...r), lowest = (...r) => extreme(MH.lo, Math.min, Infinity, ...r);

  // ---------- live sprites ----------
  const clothOf = (color) => { const k = ["#9e3b2f", "#2f4a6d", "#a8812a", "#4e6b3a", "#6b3f5e"].indexOf(String(color).toLowerCase()); return P["c" + (k >= 0 ? k : strHash(String(color)) % 5)]; };
  const facingMem = new Map();
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
  // The sim's people, animals and the things that change often, placed on the drawn ground of camera cam: each a sprite
  // at its anchor (art px of the view), its depth and bias (blit's), and the world point the light reads there.
  function entities(cam, sim, now) {
    const W = sim.w, md = cam.md, sz = SIZES[md.L], out = [], fires = [], picks = [];
    const pv = md.pv;
    const at = (x, z) => { const p = project(cam, x, z); return { ...p, x, z, sx: Math.round(p.gx - cam.gx0), sy: Math.round(p.gy - cam.gy0) }; };
    const onScreen = (a, m = 40) => a.sx > -m && a.sy > -m && a.sx < cam.AW + m && a.sy < cam.AH + m * 2;
    // onScreen's bound whatever the ground's height there, checked before the ground lookup: most of the island's
    // people, animals and things are off the view
    const levHi = (md.peakLev + 2 - cam.lev) * md.lp, levLo = (-2 - cam.lev) * md.lp;
    const inView = (x, z, m, lift = 0) => {
      const [u, v] = md.uv(x, z), sx = (u - v) * md.H - cam.gx0, base = (u + v) * md.hb - cam.gy0 - lift + cam.lev * md.lp - cam.lev * md.lp;
      return sx > -m - 1 && sx < cam.AW + m + 1 && base - levLo > -m - 1 && base - levHi < cam.AH + m * 2 + 1;
    };
    // footprint sprites anchor below their footprint centre; small people stand two pixels high in their sprite
    const add = (a, s, o = {}) => { if (s) out.push({ z: o.z ?? a.cz, sx: a.sx, sy: a.sy + (s.foot || 0) + (o.lift || 0), spr: s, mirror: !!o.mirror, bias: o.bias ?? md.hb + 2, shadow: o.shadow ?? !NOSHADOW.has(s.kind), xray: o.xray, pick: o.pick, wx: a.x, wz: a.z }); };
    // each pick keeps the ground point it stands on, so labels can follow it
    const pk = (a, p) => picks.push({ ...p, ax: a.sx, ay: a.sy, az: a.cz });
    const alpha = clamp(sim.alpha ?? 1, 0, 1), selectedId = cam.view.selected ?? null;
    for (const t of sim.liveThings?.values() ?? []) {
      if (!inView(toM(t.px), toM(t.py), 60)) continue;
      const a = at(toM(t.px), toM(t.py));
      if (!onScreen(a, 60)) continue;
      const hpx = shown(t.size ?? 1) * pv;
      if (t.blaze) fires.push({ a, id: t.id, ...blazeShown(t.blaze, sz, pv) });
      if (hpx < 1) continue;
      const s = thingSprite(t, hpx, md.b);
      // a home under the trees shows through the leaves the way its people do
      if (s) { s.kind ??= t.kind; add(a, s, { mirror: ((t.seed >>> 3) & 1) === 1 && !FACED.has(t.kind), bias: t.kind === "structure" ? md.hb + 4 : 2, xray: t.kind === "structure" && (t.shelter?.tier ?? 0) >= 1, pick: { kind: "thing", id: t.id } }); }
      pk(a, { kind: "thing", id: t.id, sx: a.sx, sy: a.sy - hpx / 2, h: Math.max(3, hpx), name: t.name || t.kind.replaceAll("_", " "), top: a.sy - hpx - 2 });
    }
    // the animals the GPU's buffers hold (store kind "animal") are drawn from them by the worker; the page draws the rest
    // (fish and butterflies, which are counts a tile, and any placed by hand)
    for (const an of W.animals || []) {
      if (an.hp <= 0 || an.gpu) continue;
      const hpx = shown(BODY[an.species] ?? 0.5) * ANIMAL_DRAWN * pv;
      if (hpx < 1) continue;
      const p = motion(an.id, sim);
      if (!p || !inView(p.x, p.z, 40, Math.round((an.alt || 0) * pv))) continue;
      const a = at(p.x, p.z), fly = FLIERS.has(an.species), lift = Math.round((an.alt || 0) * pv), seedA = strHash(an.id) % 8;
      if (!onScreen({ sx: a.sx, sy: a.sy - lift })) continue;
      const [du, dv] = p.moving ? md.dir(p.dx, p.dz) : md.dir(Math.cos(an.heading ?? 0), Math.sin(an.heading ?? 0)), facing = du - dv >= 0 ? 1 : 0;
      // wings beat on the clock, legs only while the animal covers ground
      const frame = fly ? Math.floor(now / 120 + seedA) & 3 : p.moving ? Math.floor(alpha * 4) & 3 : 0, hq = hpx < 8 ? Math.round(hpx * 2) / 2 : Math.round(hpx);
      const s = spr(`a${an.species}|${an.state}|${hq}|${frame}|${seedA}|${facing}`, () => TH.animal?.(an.species, an.state, hq, frame, seedA, facing));
      const up = lift > 1;
      // depth of the drawn point, the ground's plus the lift, so trees and ridges in front still hide a bird
      add(a, s, { lift: -lift, z: a.cz + lift, bias: 3, shadow: !up && !fly && hpx >= 3, xray: an.id === selectedId, pick: { kind: "animal", id: an.id } });
      pk(a, { kind: "animal", id: an.id, sx: a.sx, sy: a.sy - lift - hpx / 2, h: Math.max(4, hpx) + 3, name: an.species, top: a.sy - lift - hpx - 2 });
    }
    for (const ag of W.agents || []) {
      if (ag.dead || ag.alive === false) continue;
      const p = motion(ag.id, sim);
      if (!p || !inView(p.x, p.z, 40)) continue;
      const a = at(p.x, p.z);
      if (!onScreen(a)) continue;
      // years of age by the sim's own clock as the worker posts it (remote.js day, yearDays)
      const year = sim.day * sim.yearDays, stage = (W.t - ag.born) / year < 1 ? "child" : (W.t - ag.born) / year < 5 ? "adult" : "elder";
      // by meters like everything else, a little larger than life, and never below three pixels so a nomad is findable
      const hp = Math.max(3, Math.round(1.7 * 1.6 * pv * (stage === "child" ? 0.7 : 1))), cloth = clothOf(ag.color), seedA = strHash(ag.id) % 997;
      const down = ag.down > W.t;
      // facing comes from the motion as it looks on screen, so it turns with the camera
      const f = facingOf(ag.id, ...(p.moving ? md.dir(p.dx, p.dz) : [0, 0]));
      let s, mirror = false;
      if (down) s = TH.lying ? spr(`lie${hp}|${cloth}|${seedA}`, () => TH.lying(hp, cloth, seedA)) : spr(`sit${hp}|${cloth}|${seedA}`, () => SP.person(hp, cloth, "front", "sit", seedA));
      else if (TH.walker) {
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
      // what they are at, as the sim words it (sim.ts activity); a server's sim without it gives the old few
      const icon = sim.activity ? sim.activity(ag.id) : down ? "faint" : ag.sickness ? "sick" : ag.thinking ? "think" : ag.engaged ? "fight" : null;
      let lid = 0;
      if (icon && TH.icon) { const ic = spr(`icon${icon}`, () => TH.icon(icon)); if (ic) { lid = ic.h; out.push({ z: 1e9, sx: a.sx, sy: a.sy - hp - 2, spr: ic, bias: 0, shadow: false, pick: own, over: true, ax: a.sx, ay: a.sy, az: a.cz }); } }
      pk(a, { kind: "agent", id: ag.id, sx: a.sx, sy: a.sy - (hp >> 1), h: hp + 3, name: ag.name, top: a.sy - hp - 2 - lid });
    }
    return { out, fires, picks };
  }
  // things that have a front turn with the camera: a world facing from the seed, less the camera's clockwise turns
  const FACED = new Set(["structure", "trap", "well", "grave", "item"]);
  function thingSprite(t, hpx, bearing) {
    if (!TH.object) return null;
    const seedT = (t.seed >>> 0) % 8, dir = (((t.seed >>> 5) & 7) - bearing + 16) % 8, hq = hpx < 8 ? Math.round(hpx * 2) / 2 : Math.round(hpx);
    // flames are drawn by drawFires on the clock, so the sprite is the thing unlit but for a fire's bed of coals, glowing
    // by their heat to the nearest 50 K so the cache keeps a few
    const species = t.kind === "structure" ? t.shelter?.style : t.kind === "item" ? t.item : t.species;
    const coals = t.kind === "fire" && t.blaze?.glow > 0 ? Math.round(t.blaze.hot / 50) * 50 : 0;
    // a burning tree's crown as wide as the GPU's trees draw theirs (atlas.js crownRatio), to the nearest hundredth
    const rho = t.kind === "tree" ? Math.round(crownRatio(crownShare, species, t.size ?? 1) * 100) / 100 : undefined;
    const o = { species, stage: clamp(t.stage ?? 1, 0, 1), tier: t.shelter?.tier ?? 0, room: t.shelter?.room ?? 0, caught: !!t.caught, n: t.n, covered: !!t.covered, charcoal: t.charcoal > 0, dir, rho, blaze: coals ? { kw: 0, glow: 1, flame: 0, r: 0, hot: coals } : undefined };
    return spr(`t${t.kind}|${species}|${hq}|${seedT}|${o.stage}|${o.tier}|${o.room}|${o.caught}|${o.n > 0}|${o.covered}|${o.charcoal}|${dir}|${coals}|${rho}`, () => TH.object(t.kind, hq, seedT * 131 + 7, o));
  }

  // ---------- fire, smoke ----------
  // A fire's glow (light in the row's low bits and a tint on the ground, webgpu.js shadeFS) and its flames, which give
  // their own light, into the view's live sprites.
  function drawFires(cam, fires, now, night, live, glow) {
    const md = cam.md;
    for (const f of fires) {
      const { a } = f, fl = f.fl, ph = (now / 1000) * 5 + idH(f.id, 5) * 8;
      // glow on the ground by day; warm light pools by night
      const R = SIZES[md.L].glow * (1 + night * 1.6) * f.k * (0.95 + 0.05 * Math.sin(ph * 2.3));
      if (glow.length < 64) glow.push([a.sx, a.sy, R, 0]);
      if (!fl) continue;
      const s = spr(`flame${fl}|${Math.floor(ph) & 7}`, () => SP.flames(fl, 5 + (Math.floor(ph) & 7)));
      if (s) live.push(use(s), a.sx, a.sy + 1, a.cz + 2 - cam.czc + md.hb + 3, F_LIVE | F_EMIT, PICK_LIVE | (owners.push({ kind: "thing", id: f.id }) - 1), a.x, a.z);
    }
  }
  // the columns stand over their fires as the view shows them, so they rise straight up through a turn
  function drawSmoke(cam, fires, now, E) {
    const md = cam.md, sz = SIZES[md.L];
    const wind = simRef?.w?.weather?.wind ?? { dx: 1, dy: 0 }, [du, dv] = md.dir(wind.dx ?? 1, wind.dy ?? 0), drift = clamp((du - dv) * 0.3, -0.45, 0.45);
    for (const f of fires) smoke(E, f.a.sx, f.a.sy - f.fl, sz.person * sz.smoke * f.k, Math.max(0.8, sz.person * 0.18), drift, now / 1000 + idH(f.id, 6) * 9);
  }
  // the smoke column on a continuous clock: puffs rise, swell, lean downwind and fade
  function smoke(E, x0, y0, h, r0, drift, t) {
    const n = Math.max(5, Math.round(h / (r0 * 2.2))), ph = (t * 1.2) % 1;
    for (let k = n; k >= 0; k--) {
      const q = (k + ph) / (n + 1), tt = q ** 1.8, rise = h * tt;
      const r = r0 * (0.6 + tt * 1.8) * (0.8 + 0.4 * (Math.sin(tt * 9 + 1.3) * 0.5 + 0.5));
      const cx = x0 + drift * h * tt ** 1.6 + Math.sin(tt * 5 + 1) * r0 * 0.6 * tt, cy = y0 - rise, alpha = Math.min(1, q * 14) * (1.2 - tt * 1.25);
      if (alpha > 0) E.puff(cx, cy, r, alpha);
    }
  }

  // ---------- the sky: the sun and the moon, and the light they give ----------
  // As the sim's (src/sim/sky.ts, change both together): the island at LAT north, the sun crossing the south at NOON, its
  // path swinging with the year by the earth's TILT, equinoxes in the middle of spring and of autumn: 58 degrees at a
  // midsummer noon and a 17.1 hour day, 11.5 degrees and 6.9 hours at midwinter. The moon crosses the same sky phase x 24
  // hours behind the sun as it waxes over LUNAR days, as far south of the equator when full as the sun is north, so a
  // summer full moon rides low. SUN_HIGH, the midsummer noon sun on REF_DAY, is what the light is measured against.
  const DEG = Math.PI / 180, LAT = 55.1 * DEG, TILT = 23.44 * DEG, NOON = 13, YEAR_DAYS = 40, LUNAR = 29.53;
  const SUN_HIGH = Math.PI / 2 - LAT + TILT, REF_DAY = 1 + (YEAR_DAYS * 3) / 8;
  const hourAngle = (hour, transit) => ((hour - transit) * Math.PI) / 12;
  const declination = (day, hour) => { const d = (((day - 1 + hour / 24) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS; return TILT * Math.sin((2 * Math.PI * (d - YEAR_DAYS / 8)) / YEAR_DAYS); };
  // a body at hour angle H and declination dec: dir toward it across the ground (x east, z south), el its elevation
  function bodyAt(H, dec) {
    const e = -Math.cos(dec) * Math.sin(H), n = Math.cos(LAT) * Math.sin(dec) - Math.sin(LAT) * Math.cos(dec) * Math.cos(H);
    const u = Math.sin(LAT) * Math.sin(dec) + Math.cos(LAT) * Math.cos(dec) * Math.cos(H), h = Math.hypot(e, n);
    return { dir: [e / h, -n / h], el: Math.asin(clamp(u, -1, 1)), tan: u / h };
  }
  const moonAt = (day, hour) => {
    const phase = ((day - 1 + hour / 24) / LUNAR + 0.35) % 1, w = 2 * Math.PI * phase;
    return { ...bodyAt(hourAngle(hour, NOON + phase * 24), declination(day, hour) * Math.cos(w)), phase, lit: (1 - Math.cos(w)) / 2 };
  };
  // Light at the ground, RGB in units of the clear noon sun's on a face turned to it. The air reddens the sun's light by
  // the air it crosses: Kasten and Young's air mass at these optical DEPTHs (red, green, blue). The sky's light falls with
  // the sun, as a power of its height by day and then an e-fold each DUSK degrees down to starlight, and takes its colour
  // from the sun's height: the day's blue, the golden hour, the rose of sunset, the blue hour. Round sunset a glow low in
  // the sun's quarter of the sky, part of its light, lights what faces it. Moonlight is MOON of the sun's, and its sky
  // MOONSKY of that, more than the day's sky gives for its sun, so moon shadows stay soft.
  const DEPTH = [0.07, 0.15, 0.32], AMB = 0.9, AMB_P = 0.65, AMB_0 = 0.021, DUSK = 2.2, STAR = 0.0012, GLOW_K = 0.25, MOON = 0.004, MOONSKY = 1.2;
  // FIRE: a fire's light at its brightest pool as shown once the dusk has fallen (the exposure of a clear sky with the sun
  // FIRE_E degrees down). A fire gives the same light at any hour, so it shows as the eye opens to the dark, not by day.
  const FIRE = [1, 0.55, 0.22], FIRE_W = [0, 0.35, 0.65, 0.9], FIRE_E = -10;
  const SKY = [[-18, [0.3, 0.4, 0.95]], [-10, [0.36, 0.45, 1]], [-5, [0.55, 0.52, 0.95]], [-1.5, [0.85, 0.62, 0.78]], [2, [1, 0.78, 0.7]], [8, [0.95, 0.88, 0.88]], [25, [0.82, 0.9, 1]]];
  const GLOW_C = [[-9, [0.6, 0.3, 0.5]], [-4, [0.95, 0.45, 0.45]], [0, [1, 0.55, 0.35]], [6, [1, 0.7, 0.45]]];
  // Shading takes a sun or moon as no lower than LOW, so flat ground keeps some of its light while long shadows cross
  // it, and the glow as GLOW_EL up. Slopes shade RELIEF times as steep as drawn, as the bake's old hillshade exaggerated
  // them, so the island's folds show which way they face. A slope turned to the sun or the moon also picks brighter
  // tones by its light over flat ground's, as a fraction of flat ground's light, TONE_G of the bake's units per unit:
  // under a low sun the slopes turned to it glow, and under cloud and by a thin moon the relief fades. The dusk's glow, a
  // broad light, shades only through the light table.
  const LOW = 12 * DEG, GLOW_EL = 25 * DEG, RELIEF = 2, TONE_G = 12;
  // cloud cover by the sim's weather (src/sim/sky.ts CLOUD)
  const COVER = { clear: 0.053, cloudy: 0.814, rain: 0.899, storm: 0.868 };
  const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  const keyed = (keys, x) => { let i = 0; while (i < keys.length - 2 && keys[i + 1][0] <= x) i++; const [x0, a] = keys[i], [x1, b] = keys[i + 1], t = clamp((x - x0) / (x1 - x0), 0, 1); return a.map((v, k) => v + (b[k] - v) * t); };
  const transmit = (el) => { const m = 1 / (Math.sin(Math.max(el, -0.5 * DEG)) + 0.50572 * Math.max(0.5, el / DEG + 6.07995) ** -1.6364); return DEPTH.map((t) => Math.exp(-t * m)); };
  const NOON_T = transmit(SUN_HIGH), toward = (b, el) => [Math.cos(el) * b.dir[0], Math.sin(el), Math.cos(el) * b.dir[1]];
  // The light of an hour under cloud (0 clear to 1 overcast): A the sky's; K the key light's, which lights a face by how it
  // turns to L (the sun, the dusk's glow and the moon, weighted by their light); cast: what casts shadows, k its share of K.
  // moonless: the sky without the moon, which the eye's exposure is measured against.
  // `at`, for a place of the planet other than the play area, is the sun and moon over it ({ sun, moon }, planetSky below)
  function lightOf(hour, day, cloud, moonless = false, at = null) {
    const sun = at?.sun ?? bodyAt(hourAngle(hour, NOON), declination(day, hour)), moon = at?.moon ?? moonAt(day, hour), e = sun.el / DEG, clear = 1 - cloud;
    const up = (b, lo, hi) => smooth(lo * DEG, hi * DEG, b.el);
    // the sun's last light goes over its last degrees, and the moon's first comes over its first
    const sunClear = transmit(sun.el).map((t, k) => (t / NOON_T[k]) * up(sun, -1, 2)), S = sunClear.map((s) => s * clear);
    const a0 = (AMB_0 / (Math.sin(SUN_HIGH) + AMB_0)) ** AMB_P, a = e >= 0 ? ((Math.sin(sun.el) + AMB_0) / (Math.sin(SUN_HIGH) + AMB_0)) ** AMB_P : a0 * Math.exp(e / DUSK);
    const G = keyed(GLOW_C, e).map((c) => c * GLOW_K * a * smooth(-10, -0.5, e) * (1 - smooth(2, 10, e)) * clear);
    const M = moonless ? [0, 0, 0] : transmit(moon.el).map((t, k) => (t / NOON_T[k]) * up(moon, -1, 10) * MOON * moon.lit * [0.8, 0.9, 1][k] * clear);
    let A = keyed(SKY, e).map((c, k) => c * (AMB * a + STAR * [0.6, 0.8, 1][k]) + M[k] * MOONSKY * [0.7, 0.85, 1][k]);
    // cloud greys the sky and spreads the sun through it; storm cloud darkens the day
    const spread = (lum(A) + lum(sunClear) * Math.max(0, Math.sin(sun.el)) * 0.5) * (1 - 0.5 * smooth(0.75, 1, cloud));
    A = A.map((v, k) => v + (spread * [0.95, 0.97, 1][k] - v) * cloud);
    const K = S.map((s, k) => s + G[k] + M[k]), wS = lum(S), wM = lum(M), kL = lum(K);
    const parts = [[toward(sun, Math.max(sun.el, LOW)), wS], [toward(sun, GLOW_EL), lum(G)], [toward(moon, Math.max(moon.el, LOW)), wM]];
    const L = [0, 1, 2].map((k) => parts.reduce((s, [v, w]) => s + v[k] * w, 0)), n = Math.hypot(...L);
    const body = wS >= wM ? (sun.el > -DEG && wS > 0 ? sun : null) : moon.el > 0 ? moon : null;
    return { sun, moon, e, A, K, L: n > 1e-9 ? L.map((v) => v / n) : [0, 1, 0], direct: wS + wM, cast: body && kL > 0 ? { dir: body.dir, tan: Math.max(body.tan, 0.005), k: (body === sun ? wS : wM) / kL } : null };
  }
  // The eye's exposure. Under a clear sky without the moon, ground in shadow shows at shadowShows(e) of the palette: what
  // shows at noon all day, falling only once the sun is low, to D_NIGHT at night, so nothing brightens as the sun goes:
  // what the sun lights dims with its light. Cloud and moonlight are seen through an exposure that opens to them only in
  // part (GAM), so an overcast day still reads bright and a moonlit night stays dark but for what the moon lights. The
  // light measured: flat ground and faces turned to the key light alike (as one turned to it by at least REFN). WB: noon's
  // light on flat ground, under which the palette shows as drawn.
  // the sky's ambient light with the sun at sin(elevation) s, as lightOf takes it (globe.js ambOf holds the same)
  const ambientOf = (s) => AMB * (s >= 0 ? ((s + AMB_0) / (Math.sin(SUN_HIGH) + AMB_0)) ** AMB_P : ((AMB_0 / (Math.sin(SUN_HIGH) + AMB_0)) ** AMB_P) * Math.exp(Math.asin(Math.max(-1, s)) / DEG / DUSK)) + STAR;
  const REFN = 0.45, GAM = 0.16, D_NIGHT = 0.15;
  const refOf = (l) => lum(l.A) + lum(l.K) * Math.max(l.L[1], REFN);
  const NOON_L = lightOf(NOON, REF_DAY, 0, true), WB = NOON_L.A.map((a, k) => a + NOON_L.K[k] * NOON_L.L[1]), WBL = lum(WB);
  const D_NOON = lum(NOON_L.A) / WBL, shadowShows = (e) => D_NIGHT + (D_NOON - D_NIGHT) * smooth(-14, 4, e);
  const exposure = (hour, day, l, c = lightOf(hour, day, 0, true)) => (shadowShows(l.e) / lum(c.A)) * (refOf(l) / refOf(c)) ** (GAM - 1);
  // the exposure at which a fire's light is all there: a clear sky with the sun FIRE_E degrees down on a midsummer evening
  const FIRE_AT = (() => { let lo = NOON, hi = NOON + 12; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (lightOf(m, REF_DAY, 0, true).e > FIRE_E) lo = m; else hi = m; } const l = lightOf(lo, REF_DAY, 0, true); return exposure(lo, REF_DAY, l, l); })();
  let cloud = 0, cloudAt = 0, sky = null, homeSky = null, tablesId = "";
  // the clock when no game runs (the world alone): a fixed hour the page sets (setClock), day 1 of the year's start
  const worldClock = { hour: 13, day: 1 };
  // The sky of a frame: its light; gain, display per unit of light by channel; dim, how far the dark has drained colour;
  // night, how dark the evening has grown for the fires; fire, how much of a fire's light shows; cast for the GPU, null
  // while nothing casts; flat, relief and toneK for the GPU's shading (the relief softer by night, as eyes see less of
  // it); id, which light tables it needs.
  function skyFor(clock, now, at = null) {
    const hour = clock.hour ?? 8, day = clock.day ?? 1;
    // a change of weather drifts in over a few seconds
    cloud += ((COVER[simRef?.w?.weather?.sky] ?? 0) - cloud) * (cloudAt ? 1 - Math.exp(-Math.min(1000, now - cloudAt) / 2500) : 1);
    cloudAt = now;
    const l = lightOf(hour, day, cloud, false, at), E = exposure(hour, day, l, at ? lightOf(hour, day, 0, true, at) : undefined), dim = smooth(-1, -11, l.e), flat = Math.max(0, l.L[1]);
    return {
      ...l, gain: WB.map((w) => (E * WBL) / w), dim, night: smooth(1, -8, l.e), fire: Math.min(1, E / FIRE_AT),
      cast: l.cast && { ...l.cast, exag: EXAG }, flat, relief: EXAG * RELIEF, toneK: ((TONE_G * l.direct) / (lum(l.A) + lum(l.K) * flat)) * (1 - 0.6 * dim),
      cloud, id: `${Math.round(hour * 60)}|${day}|${Math.round(cloud * 40)}|${at?.id ?? 0}`,
    };
  }
  // An upright thing's share of the key light seen from bearing b: the half of a round form facing the viewer, lit when
  // the light is behind the viewer and dark against it, and its top.
  function spriteLight(b) {
    const a = (b * Math.PI) / 4, vx = (Math.cos(a) - Math.sin(a)) / Math.SQRT2, vz = (Math.sin(a) + Math.cos(a)) / Math.SQRT2;
    const [lx, ly, lz] = sky.L, h = Math.hypot(lx, lz), psi = Math.acos(clamp(h > 1e-6 ? (lx * vx + lz * vz) / h : 0, -1, 1));
    return clamp((h * 0.85 * ((Math.PI - psi) * Math.cos(psi) + Math.sin(psi))) / Math.PI + 0.4 * ly, 0, 1);
  }
  // The sky's light tables, rebuilt in place as it changes. For the GPU: webgpu.js LEVELS steps of the key light, from none
  // to all of it on a face turned to it, each at the fire's four levels, and last the palette as drawn, for what gives
  // its own light. For the CPU, which bakes its shadows and its slopes' light: flat ground in the open at the fire's four
  // levels.
  const KNEE = 0.9, TOP = 1.45, M = [0, 0, 0];
  const tables = { gpu: new Uint32Array(NCOL * (LEVELS * 4 + 1)), cpu: new Uint32Array(NCOL * 4) };
  RGB.forEach((a, c) => { tables.gpu[LEVELS * 4 * NCOL + c] = 0xff000000 | (a[2] << 16) | (a[1] << 8) | a[0]; });
  // One row: the palette under key light f and the fire's level l as the eye adapted to sky s sees it, brighter than the
  // palette only up a soft shoulder, and as the light fails its colour drains and shifts toward blue, as eyes see at
  // night, moonlight too, except in a fire's light, which the eye sees in colour.
  function row(out, at, s, f, l) {
    const fire = FIRE_W[l] * s.fire, dim = s.dim * (1 - Math.min(1, fire / 0.4)), sat = 1 - 0.45 * dim, pr = 1 - 0.2 * dim, pg = 1 - 0.04 * dim, pb = 1 + 0.15 * dim;
    for (let k = 0; k < 3; k++) { const m = (s.A[k] + s.K[k] * f) * s.gain[k] + FIRE[k] * fire; M[k] = m <= KNEE ? m : KNEE + (TOP - KNEE) * (1 - Math.exp(-(m - KNEE) / (TOP - KNEE))); }
    // by night the ground shows by the moon's and the stars' light on it (night.js, as the planet pass draws it from above), as dark as the day's row and no darker
    const nt = s.night * (1 - Math.min(1, fire / 0.4)), E = skyLux(s.e) + moonLux(Math.sin(s.moon.el), s.moon.lit, f), inkL = lum(RGB[P.ink]) / 255;
    for (let c = 0; c < NCOL; c++) {
      const a = RGB[c], r = a[0] * M[0], g = a[1] * M[1], b = a[2] * M[2], y = r * 0.3 + g * 0.59 + b * 0.11;
      let R = (y + (r - y) * sat) * pr + 2 * dim, G = (y + (g - y) * sat) * pg + 3 * dim, B = (y + (b - y) * sat) * pb + 7 * dim;
      if (nt > 0) {
        const n = nightFloor(nightDrain(nightShown([a[0] / 255, a[1] / 255, a[2] / 255], E, inkL), dim), inkL);
        R += Math.max(0, 255 * n[0] - R) * nt; G += Math.max(0, 255 * n[1] - G) * nt; B += Math.max(0, 255 * n[2] - B) * nt;
      }
      out[at + c] = 0xff000000 | (clamp(Math.round(B), 0, 255) << 16) | (clamp(Math.round(G), 0, 255) << 8) | clamp(Math.round(R), 0, 255);
    }
  }
  function tablesFor(s) {
    if (s.id === tablesId) return tables;
    for (let lv = 0; lv < LEVELS; lv++) for (let l = 0; l < 4; l++) row(tables.gpu, (lv * 4 + l) * NCOL, s, lv / (LEVELS - 1), l);
    for (let l = 0; l < 4; l++) row(tables.cpu, l * NCOL, s, s.flat, l);
    tablesId = s.id;
    return tables;
  }
  // the empty sea as a frame shows it: flat water in the open
  const seaOf = (T) => T.gpu[Math.round(sky.flat * (LEVELS - 1)) * 4 * NCOL + P.w1];

  // ---------- the frame ----------
  // What to draw: one camera at the level the zoom shows and the bearing the view faces, or two cross-fading near the
  // end of a level's zoom range. The renderer draws a cross-fade's two levels one a frame in turn and presents the other
  // from its last drawing (webgpu.js fadePlan), so each reaches FADE_MARGIN of the canvas past every side: a zoom out or
  // a pan of that much between two drawings still finds the canvas covered [design: 5 percent, about three frames of the
  // zoom bench's zoom out at its 1.8 percent a frame].
  const FADE_MARGIN = 0.05;
  // The canvas's farthest ground from the target, along each axis: at most (0.71 W / 2 + 1.41 H / 2) / ppm (the ladder's basis, inverted), a quarter more for the relief's lift
  const viewExtent = (view) => (1.25 * (0.71 * canvas.width + 1.41 * canvas.height)) / (2 * ppmOf(clampZ(view.zoom)));
  // One level of detail across the whole screen (plan R6): the ladder's ground is only as large as the play area or the window laid at the camera, so it is shown only when
  // it fills the canvas (the margin, in metres, by which the viewport lies inside the area less its faded edge), and it comes in by one fade over the whole canvas as the margin
  // opens; until then the planet layer alone is drawn, at the same level everywhere on the screen.
  const coverMargin = (view) => SIZE / 2 - PLAY_EDGE_M - Math.max(Math.abs(view.x), Math.abs(view.z)) - viewExtent(view);
  const coverFade = (view) => (PLACE ? smooth(0, 1, coverMargin(view) / (0.5 * viewExtent(view))) : 1);
  const ladderAlpha = (view) => (PLACE ? smooth(ZLAD, ZLAD + 1, view.zoom) * winFade() * coverFade(view) : 1);
  // whether any of the play area (and its fade) can be in the canvas, by the corners' screen box a quarter canvas wider on every side
  function playAreaShown(view) {
    const h = SIZE / 2 + PLAY_EDGE_M, y = camH(view.x, view.z) + (view.up || 0), W = canvas.width, H = canvas.height;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [sx, sz] of [[-h, -h], [h, -h], [h, h], [-h, h]]) { const s = screenOf(view, sx, sz, y); x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[0]); y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]); }
    return x1 > -W / 4 && x0 < W * 1.25 && y1 > -H / 4 && y0 < H * 1.25;
  }
  function plan(view) {
    const lf = levelFor(view.zoom), beta = norm8(view.bearing ?? 0), a = (stats.ladderAlpha = ladderAlpha(view));
    if (a <= 0 || (PLACE && !playAreaShown(view))) return { lf, parts: [], beta };
    const fade = lf.L < NL - 1 && lf.t > 0.6, m = fade ? FADE_MARGIN : 0, parts = [[camera(view, lf.L, beta, m), a]];
    if (fade) parts.push([camera(view, lf.L + 1, beta, m), smooth(0.6, 1, lf.t)]);
    return { lf, parts, beta };
  }
  // A camera's place on its level and bearing for the GPU (webgpu.js VU): its grid, target, art buffer and tile window
  // (win: windowOf's).
  function placeOf(cam, win) {
    const md = cam.md, G0 = gridOf(cam.L, md.b).F, [i0, j0, ni, nj, top, blk] = win;
    return {
      eubx: G0.eu[0], euby: G0.eu[1], evbx: G0.ev[0], evby: G0.ev[1], obx: G0.ox, obz: G0.oz,
      eux: md.eu[0], euy: md.eu[1], evx: md.ev[0], evy: md.ev[1],
      cx: cam.view.x, cz: cam.view.z, levc: cam.lev, offx: cam.gcx - cam.gx0, offy: cam.gcy - cam.gy0, gx0: cam.gx0, gy0: cam.gy0, aw: cam.AW, ah: cam.AH,
      i0, j0, ni, nj, nbi: Math.ceil(ni / BLK), nblk: blk ? blk.length : 0, bsum: blk ? blk.reduce((a, e) => (Math.imul(a, 31) + e) | 0, blk.length) : 0, H: md.H, hb: md.hb, lp: md.lp, tileM: md.tileM, levelM: md.levelM, k: md.k, pv: md.pv, pw: md.pw, shrunk: md.shrunk ? 1 : 0, bias: md.hb + 2, peak: top, zinv: 1 / (2 * zSpan(cam, top)), mapN: LADDER[cam.L].paged ? 0 : Math.ceil((2 * (SIZE / 2) * (Math.abs(Math.cos((md.b * Math.PI) / 4)) + Math.abs(Math.sin((md.b * Math.PI) / 4)))) / md.tileM),
    };
  }
  // The whole island at level L and whole bearing b, at one art px a px, as webgpu.js builds a far level's front lists
  // from (wgsl/objects.js frontWalk): its art buffer reaches every point of the island at any height it stands at.
  function islandView(L, b) {
    const md = mdOf(L, b), [uc, vc] = md.uv(0, 0);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const x of [-SIZE / 2, SIZE / 2])
      for (const z of [-SIZE / 2, SIZE / 2]) {
        const [u, v] = md.uv(x, z);
        x0 = Math.min(x0, (u - v) * md.H); x1 = Math.max(x1, (u - v) * md.H);
        y0 = Math.min(y0, (u + v) * md.hb - md.peakLev * md.lp); y1 = Math.max(y1, (u + v) * md.hb);
      }
    const gx0 = Math.floor(x0) - 8, gy0 = Math.floor(y0) - 8, gcx = (uc - vc) * md.H, gcy = (uc + vc) * md.hb;
    const cam = { view: { x: 0, z: 0, up: 0 }, md, L, s: 1, AW: Math.ceil(x1) - gx0 + 8, AH: Math.ceil(y1) - gy0 + 8, gcx, gcy, gx0, gy0, lev: 0, czc: 1.5 * md.H * (uc + vc) };
    return placeOf(cam, windowOf(cam, [0, 0], false));
  }
  // the island levels down to FRONT_M tiles keep front lists, at every whole bearing [design: the levels whose specks
  // outnumber their sprites in a view, measured 2026-10-15 at seed 1: island, isle200, isle100]
  const FRONT_M = 100, frontLevels = new Set(LV.filter((l) => !LADDER[l.L].paged && l.tileM >= FRONT_M).map((l) => l.L));
  worker.postMessage({ type: "frontViews", views: [...frontLevels].flatMap((L) => [0, 1, 2, 3, 4, 5, 6, 7].map((b) => ({ L, b, U: islandView(L, b) }))) });
  // the view's uniforms for the GPU (webgpu.js VU) and what it draws over the ground
  function viewOf(cam, k, w, sim, clock, now, view) {
    const md = cam.md, cast = sky.cast, vec = cast ? sunStep(md, cast) : [0, 0], win = windowOf(cam, vec);
    const live = [], liveRows = [], xray = [], prims = new Emit(), fires = [];
    owners = [];
    const r = sim ? entities(cam, sim, now) : { out: [], fires: [], picks: [] };
    r.out.sort((a, b) => a.z - b.z);
    for (const o of r.out) {
      if (o.over) continue;
      const pick = o.pick ? PICK_LIVE | (owners.push(o.pick) - 1) : 0, flags = F_LIVE | (o.mirror ? F_MIRROR : 0) | (o.emit ? F_EMIT : 0) | (o.xray ? F_XRAY : 0);
      if (o.xray) xray.push(live.length / 8);
      live.push(use(o.spr), o.sx, o.sy, o.z - cam.czc + o.bias, flags, pick, o.wx, o.wz);
      if (cast && o.shadow) shadowRows(o.spr, o.sx, o.sy, o.mirror, liveRows);
    }
    drawFires(cam, r.fires, now, sky.night, live, fires);
    overlays(cam, now, view, r.fires, r.out.filter((o) => o.over), r.picks, prims);
    if (k === 0) { lastPick = r.picks; pickCam = cam; pickOwners = owners; }
    const hz = hazeOf(cam, clock.hour ?? 8), FR = new Float32Array(fires.length * 4);
    fires.forEach((f, i) => FR.set(f, i * 4));
    const U = {
      ...placeOf(cam, win),
      frame: Math.floor(now / 160) & 7, season: SEASON_I[season] ?? 0,
      casting: cast ? 1 : 0, sunx: vec[0], suny: vec[1],
      ...groundLight(), spr: spriteLight(view.bearing),
      aoDbg: AO.dbg,
      half: SIZE / 2, edge: PLACE ? PLAY_EDGE_M : 0, hmost: hz.most, htop: hz.top, hreach: hz.reach, sea: P.w1, nfires: fires.length, night: sky.night,
    };
    const n = Math.max(1, Math.ceil(cam.s - 1e-3));
    return { U, blk: win[5] ?? null, L: cam.L, beta: md.beta, alpha: w, present: { dx: cam.dx, dy: cam.dy, sc: cam.s, nn: n, nearest: Math.abs(cam.s - n) < 1e-3 ? 1 : 0 }, live, liveRows: cast ? liveRows : null, xray, prims: prims.a, fires: FR };
  }
  // the light the ground is lit by, as the shade pass takes it from a view's uniforms and the planet pass (wgsl/globe.js lightFine) from the frame
  const groundLight = () => ({ lx: sky.L[0], ly: sky.L[1], lz: sky.L[2], ar: sky.A[0], ag: sky.A[1], ab: sky.A[2], kr: sky.K[0], kg: sky.K[1], kb: sky.K[2], sunK: sky.cast ? sky.cast.k : 0, flat: sky.flat, relief: sky.relief, toneK: sky.toneK, aoK: AO.on ? AO.k : 0, aoTer: AO.ter, aoCan: AO.can, aoTree: AO.tree, aoTop: AO.top, aoSelf: AO.self, aoKey: AO.key });
  // the ambient occlusion's knobs: ?ao=0 draws without it, ?ao=dbg shows it alone. on: 0 turns it off.
  // k: the most of the sky's light a point can lose. ter: how strongly the ground's folds count. can, tree: how strongly
  // the trees' cover counts for the ground and for a sprite's pixels, top the share of it the canopy's top keeps. self:
  // the cover a tree's own crown puts at its foot. key: the share of the key light the canopy shades along with the sky's.
  const AO = { on: 1, k: 0.8, ter: 0.9, can: 1.8, tree: 3.4, top: 0.45, self: 0.12, key: 0.5, dbg: 0 };
  { const a = new URLSearchParams(location.search).get("ao"); if (a === "0") AO.on = 0; else if (a === "dbg") AO.dbg = 1; }
  let frames = 0, fpsT = performance.now(), frameNo = 0, lutSent = "", firstFrame = true, lastPick = [], pickCam = null, owners = [], pickOwners = [], shownGL = false, held = null;
  const ownersOf = new Map();
  function frame(view, sim, { show = true } = {}) {
    // the drawing's clock (the water's frame, the fires, the smoke), held still by the page checks (debug.hold)
    const t0 = performance.now(), now = held ?? t0;
    if (sim) simRef = sim;
    if (latPre) latPre = false; else latTick(view);
    // the GPU's canvas belongs to the worker once transferred: its size goes there, and is kept here only to compare
    if (glSize[0] !== canvas.width || glSize[1] !== canvas.height) { worker.postMessage({ type: "resize", W: canvas.width, H: canvas.height }); glSize = [canvas.width, canvas.height]; }
    const clock = sim?.clock?.() ?? worldClock;
    // the ground's colour follows the season
    season = clock.season ?? season;
    if (pendingGround) { const f = fieldsSlice(pendingGround); if (f) { applyGroundMsg(pendingGround, view, f); pendingGround = null; } }
    homeSky = skyFor(clock, now);
    sky = PLACE && view.geo ? skyFor(clock, now, planetSkyAt(homeSky, view.geo)) : homeSky;
    syncGeo(view);
    wantGround(view, now);
    panAhead(view, now);
    const pl = plan(view), T = tablesFor(sky);
    frameSprites = [];
    // the sim's people, animals and things live on the island: elsewhere there are none
    const simUse = mode === "home" ? sim : null;
    const views = pl.parts.map(([cam, w], k) => viewOf(cam, k, w, simUse, clock, now, view));
    // the ground is the planet pass's wherever a window of the planet is drawn (the ladder draws the sprites and their shade over it); the island of the game keeps its own (?pg=0 and ?pg=1 force either)
    const groundOff = PLACE && (PGQ === null ? mode === "win" : PGQ === "1");
    const id = frameNo + 1, msg = { type: "frame", id, gid: PLACE ? gid : undefined, views, ahead, sprites: frameSprites, seaRGB: rgbOf(seaOf(T)), cam: view.geo && PLACE ? { lat: view.geo.lat, lon: view.geo.lon, ext: viewExtent(view) } : undefined, exag: EXAG, relief: sky.relief, cast: sky.cast && { dir: sky.cast.dir, tan: sky.cast.tan, exag: EXAG }, planet: PLACE && (groundOff || ladderAlpha(view) < 1) ? { ...planetParams(view), light: groundLight(), spr: spriteLight(view.bearing), lightFade: smooth(2.6, 3.8, view.zoom), canopy: PG_CANOPY ?? 1 - ladderAlpha(view) * (1 - canopyHold(ppmOf(clampZ(view.zoom)), -Math.log2(Math.max(1e-3, stats.window?.share ?? 1)))) } : null, groundOff };
    stats.canopy = msg.planet?.canopy;
    if (lutSent !== sky.id) { msg.lut = T.gpu.slice(); lutSent = sky.id; }
    // A frame that says what the last one said (no camera, sky, ground or water step in it, no sprite or table to send) is posted again only once HEARTBEAT_MS have passed, which is how what
    // lands in the worker meanwhile (tiles, pages, a window) still reaches the screen: a still world was drawn 60 times a second for nothing. A game's frames always differ (its things move), so it skips the test.
    if (!simOpts && !msg.lut && !msg.sprites.length) {
      const { lut, sprites, ...rest } = msg, sig = JSON.stringify({ ...rest, id: 0 });
      if (sig === lastSig && t0 - lastPostAt < HEARTBEAT_MS) { stats.skipped = (stats.skipped ?? 0) + 1; return finishFrame(show, pl, t0); }
      lastSig = sig;
    }
    lastPostAt = t0;
    frameNo = id;
    ownersOf.set(id, pickOwners);
    if (ownersOf.size > 30) ownersOf.delete(ownersOf.keys().next().value);
    sentAt.set(id, now);
    if (sentAt.size > 120) sentAt.delete(sentAt.keys().next().value);
    worker.postMessage(msg, msg.lut ? [msg.lut.buffer] : []);
    return finishFrame(show, pl, t0);
  }
  const HEARTBEAT_MS = 250;
  let lastSig = "", lastPostAt = 0;
  function finishFrame(show, pl, t0) {
    const ready = objectsReady || !simOpts;
    const holes = !ready || !!lost;
    if (show && ready && !shownGL && (simOpts || !HAS_WIN || mode === "win" || (stats.ladderAlpha ?? 0) < 0.01)) { glc.style.visibility = "visible"; shownGL = true; }
    stats.slots = pl.parts.length;
    const ms = performance.now() - t0;
    stats.composeMs = stats.composeMs ? stats.composeMs * 0.9 + ms * 0.1 : ms;
    frames++;
    if (t0 - fpsT > 1000) { stats.fps = (frames * 1000) / (t0 - fpsT); frames = 0; fpsT = t0; stats.memMB = Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6); }
    if (firstFrame && !holes) { firstFrame = false; stats.firstFrameMs = Math.round(performance.now() - tStart); }
    api.lastMs = ms; api.lastHoles = holes; api.level = pl.lf; api.lastParts = [Math.round(ms * 10) / 10, +(lastDone?.cpuMs ?? 0).toFixed(1), +(lastDone?.gpuMs ?? 0).toFixed(2)];
    return { holes };
  }
  const rgbOf = (c) => [(c & 255) / 255, ((c >> 8) & 255) / 255, ((c >> 16) & 255) / 255];

  // ---------- overlays: primitives in the view's art px (webgpu.js OVER_WGSL) ----------
  class Emit {
    constructor() { this.a = []; }
    dot(x, y, c) { this.a.push(2, Math.round(x), Math.round(y), 0, c, 0, 0, 0); }
    glyph(ch, x, y, c) { this.a.push(1, x, y, ch, c, 0, 0, 0); }
    sprite(s, x, y, mirror) { this.a.push(0, Math.round(x), Math.round(y), use(s), mirror ? 1 : 0, 0, 0, 0); }
    puff(cx, cy, r, alpha) { this.a.push(3, Math.round(cx * 16), Math.round(cy * 16), Math.round(r * 16), Math.round(alpha * 1000), 0, 0, 0); }
    // a line's pixels as along() lays them: mode 0 solid, 1 kept where the dither is under keep, 2 dashes from d (the
    // distance along at its start less the dashes' phase); dy draws each pixel that many rows lower
    line(x0, y0, x1, y1, c, mode = 0, param = 0, dy = 0) { this.a.push(4, Math.round(x0), Math.round(y0), c, Math.round(x1), Math.round(y1), mode | (dy << 3), Math.round(param * (mode === 1 ? 1000 : 16))); }
    // ui.js text(): 5x7 glyphs 6 px apart, a space 4
    text(s, x, y, c) { for (const ch of s.toUpperCase()) { if (ch !== " ") this.glyph(ch.codePointAt(0), x, y, c); x += ch === " " ? 4 : 6; } return x; }
  }
  // What sits on top of the world, drawn in the view it is shown in: the smoke over the fires, the icons over people's
  // heads, and the selection, its name and its paths.
  function overlays(cam, now, view, fires, over, picks, E) {
    drawSmoke(cam, fires, now, E);
    for (const o of over) E.sprite(o.spr, o.ax, o.ay + o.sy - o.ay, o.mirror);
    if (view.selected) {
      pins = [];
      if (typeof view.selected === "string" && simRef) journey(cam, view.selected, now, view.path !== false, E);
      markSelected(cam, view.selected, picks, E);
    } else pins = [];
  }
  function label(E, s, cx, y) {
    const txt = s.toUpperCase(), w = txt.length * 6 - 1, x = Math.round(cx - w / 2);
    y = Math.round(y);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) E.text(txt, x + dx, y - 7 + dy, P.ink);
    E.text(txt, x, y - 7, P.snow);
  }
  // tied to the canvas, not the buffer, so a zoom does not move the horizon band
  const hazeOf = (cam, hour) => ({ most: 0.32 * (clamp(1 - Math.abs(hour - 7.5) / 3.5, 0, 1) * 0.8 + 0.2), top: -cam.dy / cam.s, reach: (canvas.height / cam.s) * 0.42 });

  // ---------- picking and coordinates ----------
  const mainCam = (view) => camera(view, levelFor(view.zoom).L, norm8(view.bearing ?? 0));
  // ray-marched front to back on the level's own drawn surface, so a ridge in front is hit where it is drawn
  function rayGround(cam, gx, gy) {
    const md = cam.md, a = gx / md.H, gap = (lev) => { const b = (gy + lev * md.lp) / md.hb; return md.groundAt(...md.world((a + b) / 2, (b - a) / 2)) - lev; };
    let hi = md.peakLev + 2, lo = hi;
    while (lo > -2 && gap(lo) < 0) { hi = lo; lo -= 0.25; }
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (gap(m) >= 0) lo = m; else hi = m; }
    const lev = (lo + hi) / 2, b = (gy + lev * md.lp) / md.hb, u = (a + b) / 2, v = (b - a) / 2, [x, z] = md.world(u, v);
    return { x, z, y: lev * md.levelM, u, v };
  }
  function groundUnder(view, sx, sy) {
    if (planetMode(view)) return planetUnder(view, sx, sy);
    const cam = mainCam(view), g = rayGround(cam, cam.gx0 + (sx - cam.dx) / cam.s, cam.gy0 + (sy - cam.dy) / cam.s);
    return { x: g.x, z: g.z, y: g.y, geo: PLACE ? geoOf(g.x, g.z) : undefined };
  }
  // a ground point held across frames is its planet place: its plane coordinates are about the frame it was picked in, and another window (a pan makes one every few km) puts the same x, z somewhere else
  const planeNow = (x, z, geo) => (geo && PLACE ? planeOf(geo) ?? { x, z } : { x, z });
  const drawnY = (view, x, z) => mainCam(view).md.groundAt(x, z) * LV[levelFor(view.zoom).L].levelM;
  // G maps a ground offset to canvas px per ppm (rows eu - ev, (eu + ev) / 2); camera() matches it at every level
  const basis = (bearing) => { const a = (norm8(bearing) * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a); return [c + s, s - c, (c - s) / 2, (s + c) / 2]; };
  function screenOf(view, x, z, y, geo) {
    if (planetMode(view)) return planetScreen(view, geo ?? geoOf(x, z), y);
    ({ x, z } = planeNow(x, z, geo));
    const [g00, g01, g10, g11] = basis(view.bearing ?? 0), ppm = ppmOf(clampZ(view.zoom)), dx = x - view.x, dz = z - view.z;
    return [canvas.width / 2 + ppm * (g00 * dx + g01 * dz), canvas.height / 2 + ppm * (g10 * dx + g11 * dz - VK * (y - camH(view.x, view.z) - (view.up || 0)))];
  }
  // the target showing (x, z, y) at (ox, oy) px off centre: G inverted exactly, Newton for the height it rides
  function solveTarget(view, x, z, y, ox, oy, geo) {
    if (planetMode(view)) return planetSolve(view, geo ?? geoOf(x, z), ox, oy, y);
    ({ x, z } = planeNow(x, z, geo));
    const [g00, g01, g10, g11] = basis(view.bearing ?? 0), ppm = ppmOf(clampZ(view.zoom)), r0 = ox / ppm, r1 = oy / ppm, up = view.up || 0;
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
  // By what is drawn: the GPU's own pixel there in the next frame (a live sprite's owner, or an object), then a near
  // miss (people first), then the ground. A promise.
  async function pick(sx, sy, view) {
    if (planetMode(view) || mode === "win") return null;
    const cam = pickCam ?? mainCam(view);
    if (!cam) return null;
    const x = (sx - cam.dx) / cam.s, y = (sy - cam.dy) / cam.s, ix = Math.floor(x), iy = Math.floor(y);
    const id = ++pickId, hit = await new Promise((r) => { picksWait.set(id, r); worker.postMessage({ type: "pick", id, x: ix, y: iy }); setTimeout(() => { if (picksWait.delete(id)) r(null); }, 1000); });
    if (hit && hit.pick) {
      if (hit.pick & PICK_LIVE) { const o = (ownersOf.get(hit.frame) ?? pickOwners)[hit.pick & 0x7fffffff]; if (o) return { ...o }; }
      else if (hit.kind === 1 && hit.id) return { kind: /^a\d+$/.test(hit.id) ? "animal" : "thing", id: hit.id };
    }
    const g = rayGround(cam, cam.gx0 + x, cam.gy0 + y), ground = { kind: "ground", px: (g.x - ORIGIN) / SIM, py: (g.z - ORIGIN) / SIM };
    let best = null, bd = Infinity;
    for (const p of lastPick) {
      const d = Math.hypot(p.sx - x, p.sy - y), score = d + (p.kind === "agent" ? 0 : 3);
      if (d < Math.max(4, p.h * 0.6) && score < bd) { bd = score; best = { kind: p.kind, id: p.id }; }
    }
    // outside the play area there is no sim ground to inspect
    return best ?? (Math.max(Math.abs(g.x), Math.abs(g.z)) <= SIZE / 2 ? ground : null);
  }
  // a bird's lift is at sprite scale (treeK) and the ground's at terrain scale (exag), so both become terrain meters
  function where(id, sim, view) {
    if (id && typeof id === "object") { if (id.kind !== "ground") return null; const x = toM(id.px), z = toM(id.py); return { x, z, y: drawnY(view, x, z), dx: 0, dz: 0 }; }
    const m = motion(id, sim);
    if (!m) return null;
    const md = mainCam(view).md, alt = sim.w.animals.find((a) => a.id === id)?.alt ?? 0;
    m.y = md.groundAt(m.x, m.z) * md.levelM + (alt * md.treeK) / EXAG;
    return m;
  }
  // the selection's name above it, and brackets round a thing standing on the ground, which has no live sprite to show;
  // the label is the inspector's own title
  const title = (sel) => (typeof sel === "object" ? simRef?.inspectGround?.(sel.px, sel.py) : simRef?.inspect?.(sel))?.name || "";
  const UPRIGHT = new Set(["tree", "bush", "fern", "reeds", "sapling", "dead_bush", "herb", "flowers"]);
  function markSelected(cam, sel, picks, E) {
    const live = picks.find((p) => p.id === sel);
    if (live) { label(E, title(sel) || live.name || String(live.id), live.sx, live.top ?? live.sy - live.h); return; }
    const md = cam.md, pv = md.pv;
    let x, z, hpx = 2, name = "ground", tall = true;
    if (typeof sel === "object") { x = toM(sel.px); z = toM(sel.py); }
    else {
      const r = simRef?.mark?.(sel);
      if (!r) return;
      x = toM(r.px); z = toM(r.py); hpx = Math.max(2, shown(r.size) * pv); name = r.species || r.kind; tall = UPRIGHT.has(r.kind);
    }
    const p = project(cam, x, z), ox = Math.round(p.gx - cam.gx0), oy = Math.round(p.gy - cam.gy0);
    const hw = Math.ceil(Math.max(2, hpx * 0.5)) + 1, top = oy - Math.ceil(tall ? hpx : hpx * 0.7) - 2, bot = oy + 2;
    for (const [bx, by, sx2, sy2] of [[ox - hw, top, 1, 1], [ox + hw, top, -1, 1], [ox - hw, bot, 1, -1], [ox + hw, bot, -1, -1]])
      for (let k = 0; k < 3; k++) { E.dot(bx + k * sx2, by, P.snow); E.dot(bx, by + k * sy2, P.snow); }
    label(E, title(sel) || name.replaceAll("_", " "), ox, top - 1);
  }

  // ---------- where the selection has been, and where it is going ----------
  // The hero path: a line through every point they have passed (sim.journey), its older stretches thinning out through
  // the dither, with a flag wherever something that mattered happened to them; and a marching dotted line from where
  // they stand to where they are walking (sim.heading), ending in a ring. pins: last frame's flags in canvas px, for the
  // page's tooltips.
  let pins = [];
  const PIN = { law: P.f3, discover: P.f3, invent: P.f3, learn: P.w5, teach: P.w5, collapse: P.red, attack: P.red, fight: P.red, hunt: P.f1, kill: P.f1, bond: P.violet, custom: P.violet, camp: P.violet, born: P.k0 };
  function journey(cam, id, now, path, E) {
    const m = motion(id, simRef);
    if (!m) return;
    const at = (x, z) => { const p = project(cam, x, z); return [p.gx - cam.gx0, p.gy - cam.gy0]; };
    const here = at(m.x, m.z), M = 40, off = (a, b) => (a[0] < -M && b[0] < -M) || (a[1] < -M && b[1] < -M) || (a[0] > cam.AW + M && b[0] > cam.AW + M) || (a[1] > cam.AH + M && b[1] > cam.AH + M);
    const J = path && simRef.journey?.(id);
    if (J && J.x.length) {
      const n = J.x.length, pts = new Array(n + 1);
      for (let i = 0; i < n; i++) pts[i] = at(toM(J.x[i]), toM(J.y[i]));
      pts[n] = here;
      // a shadow under it first, so the line reads on any ground
      for (const pass of [0, 1])
        for (let i = 0; i < n; i++) {
          const a = pts[i], b = pts[i + 1], keep = 0.3 + 0.7 * ((i + 1) / n) ** 0.7;
          if (!off(a, b)) E.line(a[0], a[1], b[0], b[1], pass ? P.f3 : P.ink, 1, keep, pass ? 0 : 1);
        }
      for (const mk of J.marks) {
        const [fx, fy] = at(toM(mk.px), toM(mk.py)), x = Math.round(fx), y = Math.round(fy);
        if (x < -4 || y < -4 || x > cam.AW + 4 || y > cam.AH + 4) continue;
        const c = PIN[mk.kind] ?? P.snow;
        // a little flag: an ink pole with the event's colour flying from its top
        for (let j = 0; j <= 7; j++) E.dot(x, y - j, P.ink);
        for (let i = 1; i <= 4; i++) for (let j = 5; j <= 8; j++) E.dot(x + i, y - j, i === 4 || j === 5 || j === 8 ? P.ink : c);
        pins.push({ x: cam.dx + (x + 2) * cam.s, y: cam.dy + (y - 6) * cam.s, t: mk.t, kind: mk.kind, text: mk.text });
      }
    }
    const to = simRef.heading?.(id);
    if (!to) return;
    const tx = toM(to.px), tz = toM(to.py), k = clamp(Math.ceil(Math.hypot(tx - m.x, tz - m.z) / 4), 1, 240), phase = now / 90;
    let prev = here, d = 0;
    for (let i = 1; i <= k; i++) {
      const p = at(m.x + ((tx - m.x) * i) / k, m.z + ((tz - m.z) * i) / k), len = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      if (!off(prev, p)) { E.line(prev[0], prev[1], p[0], p[1], P.ink, 2, d - phase, 1); E.line(prev[0], prev[1], p[0], p[1], P.snow, 2, d - phase, 0); }
      d += len;
      prev = p;
    }
    // a ring on the ground where they are going
    const [ex, ey] = prev;
    for (let a = 0; a < 28; a++) { const x = Math.round(ex + Math.cos((a / 28) * TAU) * 5), y = Math.round(ey + Math.sin((a / 28) * TAU) * 2.5); E.dot(x, y + 1, P.ink); E.dot(x, y, P.snow); }
  }

  const levels = PL.map((p, L) => ({ name: LV[L].name, tileM: LV[L].tileM, p, zoom: Math.log2((2 * p) / PPM0) }));
  stats.readyMs = Math.round(performance.now() - tStart);
  const api = {
    zmax: ZMAX, get zmin() { return zminNow(); }, named, levels, ppm: (z) => ppmOf(clampZ(z)), levelFor, setTarget,
    // for the page's readout: true metres across a canvas px at the camera's target (east to west, as the planet camera lays the ground: a px is root 2 of a cell metre's ppm), and the angle, clockwise from screen up,
    // that north points on the screen
    mPerPx: (view) => (PLACE && view.geo ? (1 + smooth(ZLAD - 1.5, ZLAD, view.zoom) * (latOf(view).sc - 1)) / (Math.SQRT2 * ppmOf(clampZ(view.zoom))) : null),
    northAngle: (view) => (PLACE && view.geo ? (-planetParams(view).heading) / D2R : 0),
    // whether the worker has drawn the view with what it asked of the planet held (three frames in a row, or 30 s from the load, whichever is first): the first picture worth showing, not the noise
    // of a frame drawn before any tile came
    pictureReady: () => quietDone >= 3 || performance.now() - tStart > 30000,
    // the island: its side in meters, centred on 0, and a game tile's side, for turning sim tiles into meters
    size: SIZE, tileM: TILE_M,
    // every view is drawn whole on the GPU each frame; only the first, while the objects' sprites are still being made,
    // waits for them
    // with no game on, the page is ready when its ground is: the window the view stands in (or the planet alone where none is wanted), or after 20 s whatever
    readiness: () => {
      const ready = (objectsReady || !simOpts) && (simOpts || !HAS_WIN || mode === "win" || (stats.ladderAlpha ?? 0) < 0.01 || performance.now() - tStart > 20000);
      return { done: ready ? 1 : 0, all: 1, ready };
    },
    // the views shown next (a follow's destination, a zoom's first level), whose levels' lists the worker builds first
    // the first of them, a zoom's goal, is where a window will be wanted: asked of the worker now, ahead of the view that needs it
    prefetch: (vs) => {
      ahead = (vs ?? []).filter((v) => Number.isFinite(v?.zoom)).map((v) => ({ L: levelFor(v.zoom).L, b: norm8(v.bearing ?? 0) }));
      const g = vs?.[0];
      if (g && !g.later && Number.isFinite(g.zoom) && PLACE) { const q = { ...g }; syncGeo(q); wantGround(q, performance.now(), true); }
    },
    // whether a view's level draws from lists built for it: a level that keeps front lists (the island levels, at a
    // whole bearing) only once the worker has built them; any other at once
    listsReady: (v) => { const L = levelFor(v.zoom).L, b = norm8(v.bearing ?? 0); return !frontLevels.has(L) || !Number.isInteger(b) || fronts.has(`${L}|${b}`); },
    centreOn, camH, screenOf, solveTarget, groundUnder, tickLattice, onGround: (fn) => { onGround = fn; }, get mode() { return mode; },
    // what draws the frames: WebGPU in a worker, on which GPU
    renderer: () => ({ gpu: !lost, name: [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" "), why: lost ?? "", error: lastError ?? "" }),
    picks: () => lastPick.map((p) => ({ kind: p.kind, id: p.id, sx: p.sx, sy: p.sy })),
    // the selection's hero-path flags last frame: canvas px, and the event each stands for
    pins: () => pins,
    // the last frame's sky (skyFor): sun and moon ({ dir, el in radians; the moon's phase and lit share }), e: the sun's
    // elevation in degrees, cloud: the cover it is lit under, 0 to 1
    sky: () => homeSky,
    // the frames the worker finished since the last call: { id, latency (ms from sent to done), gpu, cpu (ms), at (when
    // the page heard it was done), passes (each pass's GPU ms) }
    frameTimes: () => frameMs.splice(0),
    frame, pick, where, stats, lastMs: 0, lastHoles: true, level: null, lastParts: [],
    // the hour (and day) the world is lit at when no game runs
    setClock: (c) => Object.assign(worldClock, c),
    // the sim's side of the worker (play/remote.js): send it a message, and take what it posts of the sim
    post: (m) => worker.postMessage(m),
    onSim: (fn) => { simTo = fn; for (const m of simEarly.splice(0)) fn(m); },
    // for the page checks (scripts/play/torture.cjs, objects.ts): a camera at a level and bearing, a world point placed in
    // one, and the render worker's own checks of what it drew (worker.js check)
    debug: {
      camera, project: (md, x, z) => project({ md }, x, z),
      // the planet camera's own screen place of a play-area point, to set against the ladder's screenOf where both draw (the page checks)
      planetScreen: (view, x, z) => (PLACE ? planetCamOf(view).project(vecOf(geoOf(x, z))) : null),
      planetScreenGeo: (view, geo) => (PLACE ? planetScreen(view, geo) : null),
      // the cells' lattice the planet camera draws with now, the share of it that is the exact one (LAT_COVER) and the face the exact one is read on, for the drag checks
      lattice: (view) => ({ ...latOf(view), cover: LAT_COVER(view), face: latFace, mode }),
      // the planet camera's look at a view (planet-cam.js takes it as it is) and the lift it stands at, to solve its picks offline
      look: (view) => ({ ...planetParams(view), lift: stats.lift ?? 0, radiusM: PR, w: canvas.width, h: canvas.height }),
      // the drawing's clock held where it is (on), at a given reading (a number: the same animation frame in every run, for stills that must repeat), or let run again (false)
      hold: (on) => { held = on ? (typeof on === "number" ? on : performance.now()) : null; },
      // the query goes apart from the request's id, as a query may carry an id of its own (kill's thing)
      check: (m) => new Promise((resolve) => { const id = ++checkNo; checksWait.set(id, resolve); worker.postMessage({ type: "check", id, q: m }); }),
    },
  };
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
