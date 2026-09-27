// The live isopixel renderer: a fixed-bearing camera over the whole island. Workers bake the static landscape in
// chunks of global art pixels; every frame composes the visible chunks (colour and depth), z-tests the live sim on
// top, animates water, fire and smoke on a real clock, and remaps the indexed palette for the time of day.
import { RGB, NCOL, P, GLOW, SHADOW, HAZE } from "./pal.js";
import { Buf, Spr, blit, castShadow, bayer, h2 } from "./px.js";
import * as SP from "./sprites.js";
import * as LF from "./life.js";
import { text } from "./ui.js";

const CS = 256, SIM = 150, ORIGIN = -4800, DAY = 288, YEAR = DAY * 40, TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ZOOMS = [
  { name: "island", level: 0, S: 2 },
  { name: "region", level: 1, S: 2 },
  { name: "valley", level: 2, S: 2 },
  { name: "close", level: 3, S: 2 },
];
// per level: a grown-up's height, a deer's, a shelter's and a flame's, in art px (SimCity exaggeration)
const SIZE = [
  { person: 3, deer: 3, wolf: 2, hut: 4, fire: 2, thing: 0 },
  { person: 5, deer: 4, wolf: 3, hut: 8, fire: 4, thing: 0.5 },
  { person: 9, deer: 7, wolf: 4, hut: 16, fire: 6, thing: 1 },
  { person: 24, deer: 18, wolf: 11, hut: 40, fire: 14, thing: 2.5 },
];
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const idH = (id, k) => h2(strHash(String(id)), k, 611);
// where a thing or creature stands inside its 150 m tile, spread by a hash of its id so a camp does not stack up
const spot = (id, tx, ty, spread = 0.6) => [ORIGIN + SIM * (tx + 0.5 + (idH(id, 1) - 0.5) * spread), ORIGIN + SIM * (ty + 0.5 + (idH(id, 2) - 0.5) * spread)];
const NOSHADOW = new Set(["ash", "pit", "trap", "fire", "clay", "stick"]);
const CLEARS = { stump: 7, burnt_stump: 9, fire: 5, ash: 5, pit: 4, well: 4, grave: 3, trap: 2 };

export async function createLive({ seed = 1, canvas, onProgress, workers: nW } = {}) {
  const TH = await import("./things.js").catch((e) => (console.warn(`things.js not loaded: ${e.message}`), {}));
  const n = nW ?? clamp((navigator.hardwareConcurrency || 4) - 2, 1, 3);
  const tStart = performance.now();
  const pool = [], maps = [];
  const stats = { fps: 0, composeMs: 0, bakeQueue: 0, bakedChunks: 0, bakeMsAvg: 0, memMB: 0, firstFrameMs: 0, growMs: 0, mapMs: [], workers: n };
  let bakeN = 0, bakeSum = 0;
  const cache = new Map(), mapWait = [];
  let cacheBytes = 0, stateVer = 0, simRef = null, synced = false;
  const clearings = new Map();

  const onChunk = (wk, m) => {
    wk.busy = null;
    if (m.type === "error") { console.warn("bake error", m.error); const ch = cache.get(m.key); if (ch) { ch.failed = true; ch.pending = false; } return; }
    const ch = cache.get(m.key);
    if (!ch) return;
    if (ch.c) cacheBytes -= ch.bytes;
    if (ch.ground) closeGround.splice(closeGround.indexOf(ch.ground), 1);
    if (m.ground) closeGround.push(m.ground);
    Object.assign(ch, { c: m.c, z: m.z, obj: m.obj, animP: m.animP, animC: m.animC, ground: m.ground, ver: m.ver, pending: false, bytes: m.c.length * 6 + m.animC.length + m.animP.length * 4 });
    cacheBytes += ch.bytes;
    bakeN++; bakeSum += m.ms;
    stats.bakedChunks++; stats.bakeMsAvg = bakeSum / bakeN;
    if ((stats.bakeLog ??= []).length < 200) stats.bakeLog.push(Math.round(m.ms));
  };
  await new Promise((done, fail) => {
    let ready = 0;
    for (let k = 0; k < n; k++) {
      const wk = new Worker(new URL("./bake.js", import.meta.url), { type: "module" });
      wk.onerror = (e) => fail(new Error(`bake worker: ${e.message}`));
      wk.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") { stats.growMs = Math.max(stats.growMs, m.ms); if (++ready === n) done(); onProgress?.(ready, n, "growing the island"); }
        else if (m.type === "map") { wk.busy = null; mapWait[m.level]?.(m); }
        else onChunk(wk, m);
      };
      wk.postMessage({ type: "init", seed });
      pool.push(wk);
    }
  });
  // map data (corner levels) for placing live sprites; one worker builds each level, the others build theirs lazily
  let mapsDone = 0;
  const raw = await Promise.all([0, 1, 2, 3].map((lv) => new Promise((res) => {
    mapWait[lv] = (m) => { onProgress?.(++mapsDone, 4, "building the map"); res(m); };
    pool[lv % n].postMessage({ type: "map", level: lv });
  })));
  // the close level borrows the valley map's ground, so the valley goes first
  for (const lv of [0, 1, 2, 3]) { maps[lv] = prepMap(raw[lv]); stats.mapMs[lv] = Math.round(raw[lv].ms); }

  function prepMap(m) {
    if (m.paged) return pagedMap(m);
    const { NI, NJ, C, diag } = m, md = { ...m };
    md.ground = (u, v) => {
      const i = Math.floor(u), j = Math.floor(v);
      if (i < 0 || j < 0 || i >= NI || j >= NJ) return 0;
      const t = j * NI + i, fu = u - i, fv = v - j, T = C[t * 4], R = C[t * 4 + 1], B = C[t * 4 + 2], L = C[t * 4 + 3];
      if (diag[t] === 0) return fu >= fv ? T + (R - T) * fu + (B - R) * fv : T + (B - L) * fu + (L - T) * fv;
      return fu + fv <= 1 ? T + (R - T) * fu + (L - T) * fv : R + L - B + (B - L) * fu + (B - R) * fv;
    };
    md.water = (u, v) => { const i = Math.floor(u), j = Math.floor(v); return i < 0 || j < 0 || i >= NI || j >= NJ || m.kind[j * NI + i] !== 0; };
    // the camera rides a heavily smoothed ground level, so panning over hills drifts rather than jumps
    const f = 4, cw = Math.ceil(NI / f), chh = Math.ceil(NJ / f), g = new Float32Array(cw * chh);
    for (let j = 0; j < chh; j++) for (let i = 0; i < cw; i++) g[j * cw + i] = md.ground(i * f + f / 2, j * f + f / 2);
    const r = Math.max(2, Math.round(360 / (m.tileM * f)));
    for (let pass = 0; pass < 2; pass++)
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const src = g.slice();
        for (let j = 0; j < chh; j++) for (let i = 0; i < cw; i++) {
          let a = 0, c = 0;
          for (let q = -r; q <= r; q++) { const ii = i + q * di, jj = j + q * dj; if (ii >= 0 && jj >= 0 && ii < cw && jj < chh) { a += src[jj * cw + ii]; c++; } }
          g[j * cw + i] = a / c;
        }
      }
    md.camLev = (u, v) => {
      const x = clamp(u / f - 0.5, 0, cw - 1.001), y = clamp(v / f - 0.5, 0, chh - 1.001), i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, k = j * cw + i;
      return (g[k] * (1 - fx) + g[k + 1] * fx) * (1 - fy) + (g[k + cw] * (1 - fx) + g[k + cw + 1] * fx) * fy;
    };
    md.hb = m.H * 0.5;
    md.tall = m.level === 0 ? 12 : Math.round(34 * m.k * 0.866 * (m.level === 1 ? 2.2 : 1.15)) + 8;
    return md;
  }

  // The close level has no island-wide map: sprites stand on the corner levels each baked chunk sends back, and on
  // the valley map's ground, converted to close levels, where nothing is baked yet.
  const closeGround = [];
  function pagedMap(m) {
    const md = { ...m, hb: m.H * 0.5, tall: Math.round(34 * m.k * 0.866 * 0.8) + 8 };
    let hit = null;
    const table = (u, v) => {
      const i = Math.floor(u), j = Math.floor(v), ok = (g) => g && i >= g.i0 && j >= g.j0 && i < g.i0 + g.w && j < g.j0 + g.h;
      if (!ok(hit)) hit = closeGround.find(ok) ?? null;
      return hit ? [hit, (j - hit.j0) * hit.w + (i - hit.i0)] : null;
    };
    const valleyM = (u, v) => { const vm = maps[2], k = m.tileM / vm.tileM; return [vm, u * k, v * k]; };
    md.ground = (u, v) => {
      const tb = table(u, v);
      if (!tb) { const [vm, uu, vv] = valleyM(u, v); return (vm.ground(uu, vv) * vm.levelM) / m.levelM; }
      const [g, q] = tb, C = g.C, fu = u - Math.floor(u), fv = v - Math.floor(v), T = C[q * 4], R = C[q * 4 + 1], B = C[q * 4 + 2], L = C[q * 4 + 3];
      if (g.diag[q] === 0) return fu >= fv ? T + (R - T) * fu + (B - R) * fv : T + (B - L) * fu + (L - T) * fv;
      return fu + fv <= 1 ? T + (R - T) * fu + (L - T) * fv : R + L - B + (B - L) * fu + (B - R) * fv;
    };
    md.water = (u, v) => { const tb = table(u, v); if (tb) return tb[0].kind[tb[1]] !== 0; const [vm, uu, vv] = valleyM(u, v); return vm.water(uu, vv); };
    md.camLev = (u, v) => { const [vm, uu, vv] = valleyM(u, v); return (vm.camLev(uu, vv) * vm.levelM) / m.levelM; };
    return md;
  }

  // ---------- chunk scheduling ----------
  const keyOf = (lv, cx, cy) => `${lv}:${cx},${cy}`;
  function want(lv, cx, cy, prio, list) {
    const key = keyOf(lv, cx, cy);
    let ch = cache.get(key);
    if (!ch) { ch = { key, lv, cx, cy, ver: -1, need: 0, pending: false }; cache.set(key, ch); }
    ch.used = performance.now();
    if (ch.failed || ch.pending) return ch;
    if (!ch.c || ch.ver < ch.need) list.push([prio, ch]);
    return ch;
  }
  function rectOf(cam) {
    return [Math.floor(cam.gx0 / CS), Math.floor((cam.gx0 + cam.AW - 1) / CS), Math.floor(cam.gy0 / CS), Math.floor((cam.gy0 + cam.AH - 1) / CS)];
  }
  function wantView(cam, base, list, visible, ring) {
    const lv = cam.md.level, [cx0, cx1, cy0, cy1] = rectOf(cam), mid = [(cam.gx0 + cam.AW / 2) / CS - 0.5, (cam.gy0 + cam.AH / 2) / CS - 0.5], r = ring ? 1 : 0;
    for (let cy = cy0 - r; cy <= cy1 + r; cy++)
      for (let cx = cx0 - r; cx <= cx1 + r; cx++) {
        const inside = cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1, d = Math.hypot(cx - mid[0], cy - mid[1]);
        const ch = want(lv, cx, cy, (inside ? base : 60) + d, list);
        if (inside) visible.add(ch.key);
      }
  }
  // share of a view's chunks already baked at its own level
  function readiness(view) {
    const cam = camera(view), [cx0, cx1, cy0, cy1] = rectOf(cam);
    let done = 0, all = 0;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) { all++; if (cache.get(keyOf(cam.md.level, cx, cy))?.c) done++; }
    return { done, all, ready: done === all };
  }
  let prefetchViews = [];
  function dispatch(list) {
    list.sort((a, b) => a[0] - b[0]);
    stats.bakeQueue = list.length;
    for (const wk of pool) {
      if (wk.busy) continue;
      const next = list.shift();
      if (!next) break;
      const ch = next[1];
      ch.pending = true; wk.busy = ch.key;
      wk.postMessage({ type: "bake", level: ch.lv, cx: ch.cx, cy: ch.cy, CS, key: ch.key });
    }
  }
  function evict(visible) {
    const cap = 160e6;
    if (cacheBytes < cap) return;
    const list = [...cache.values()].filter((c) => c.c && !visible.has(c.key) && c.lv !== 0).sort((a, b) => a.used - b.used);
    for (const c of list) {
      if (cacheBytes < cap * 0.85) break;
      cacheBytes -= c.bytes;
      if (c.ground) closeGround.splice(closeGround.indexOf(c.ground), 1);
      cache.delete(c.key);
    }
  }

  // ---------- landscape state from the sim ----------
  function clearingOf(t) {
    if (t.contained || t.inside) return null;
    let r = CLEARS[t.kind];
    if (t.kind === "structure") r = 6 + (t.shelter?.tier ?? 0) * 4;
    if (!r) return null;
    const [x, z] = spot(t.id, t.x, t.y);
    return { x, z, r };
  }
  function postState(msg) {
    stateVer++;
    for (const wk of pool) wk.postMessage({ type: "state", version: stateVer, ...msg });
  }
  const clearList = () => [...clearings.values()];
  function sync(sim) {
    const W = sim.w;
    clearings.clear();
    for (const t of W.things) { const c = clearingOf(t); if (c) clearings.set(t.id, c); }
    postState({ clear: clearList(), paths: Array.from(W.paths), ice: iceFlags(W.ice) });
    synced = true;
  }
  const iceFlags = (ice) => { const f = new Array(4096).fill(0); if (ice) for (const i of ice) f[i] = 1; return f; };
  // mark every cached chunk a world rectangle can reach as stale; it keeps showing until the rebake lands
  function dirty(x0, z0, x1, z1) {
    for (const md of maps) {
      if (!md || md.level === 0) continue;
      const us = [(x0 - ORIGIN) / md.tileM, (x1 - ORIGIN) / md.tileM], vs = [(z0 - ORIGIN) / md.tileM, (z1 - ORIGIN) / md.tileM];
      let hmax = 0;
      for (let v = Math.floor(vs[0]); v <= vs[1]; v += 2) for (let u = Math.floor(us[0]); u <= us[1]; u += 2) hmax = Math.max(hmax, md.ground(u, v));
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const u of us) for (const v of vs) { a0 = Math.min(a0, u - v); a1 = Math.max(a1, u - v); b0 = Math.min(b0, u + v); b1 = Math.max(b1, u + v); }
      const gx0 = a0 * md.H - 8, gx1 = a1 * md.H + md.tall * md.shx + 8, gy0 = b0 * md.hb - (hmax + 2) * md.lp - md.tall, gy1 = b1 * md.hb + 8;
      for (let cy = Math.floor(gy0 / CS); cy <= Math.floor(gy1 / CS); cy++)
        for (let cx = Math.floor(gx0 / CS); cx <= Math.floor(gx1 / CS); cx++) {
          const ch = cache.get(keyOf(md.level, cx, cy));
          if (ch) ch.need = stateVer;
        }
    }
  }
  function changed(ch) {
    if (!ch || !simRef) return;
    if (!synced) { sync(simRef); return; }
    const W = simRef.w, touched = [];
    const redo = (id, c) => {
      const old = clearings.get(id);
      if (old && c && old.x === c.x && old.z === c.z && old.r === c.r) return;
      if (old) { clearings.delete(id); touched.push(old); }
      if (c) { clearings.set(id, c); touched.push(c); }
    };
    for (const t of ch.things || []) redo(t.id, clearingOf(t));
    for (const id of ch.removed || []) redo(id, null);
    const msg = {};
    if (touched.length) msg.clear = clearList();
    if (ch.paths?.length) msg.paths = Array.from(W.paths);
    let iceNow = null, iceDiff = [];
    if (ch.ice) {
      iceNow = iceFlags(W.ice);
      for (let i = 0; i < 4096; i++) if (iceNow[i] !== lastIce[i]) iceDiff.push(i);
      lastIce = iceNow;
      msg.ice = iceNow;
    }
    if (!Object.keys(msg).length) return;
    postState(msg);
    for (const c of touched) dirty(c.x - c.r - 4, c.z - c.r - 4, c.x + c.r + 4, c.z + c.r + 4);
    for (const i of [...(msg.paths ? ch.paths : []), ...iceDiff]) {
      const tx = i % 64, ty = (i / 64) | 0;
      dirty(ORIGIN + SIM * (tx - 1), ORIGIN + SIM * (ty - 1), ORIGIN + SIM * (tx + 2), ORIGIN + SIM * (ty + 2));
    }
  }
  let lastIce = new Array(4096).fill(0);

  // ---------- per-frame compose ----------
  let B = null, light = null, img = null, off = null, out32 = null;
  const sprites = new Map();
  const spr = (key, make) => { let s = sprites.get(key); if (s === undefined) { s = make() || null; sprites.set(key, s); } return s; };
  let frames = 0, fpsT = performance.now(), lastPick = [], firstFrame = true, lastLut = null, lastLutKey = "";
  const facingMem = new Map();

  function project(md, x, z) {
    const u = (x - ORIGIN) / md.tileM, v = (z - ORIGIN) / md.tileM, lev = md.ground(u, v);
    return { u, v, lev, gx: (u - v) * md.H, gy: (u + v) * md.hb - lev * md.lp, cz: 1.5 * md.H * (u + v) + lev * md.lp, water: md.water(u, v) };
  }
  function camera(view) {
    const zl = ZOOMS[clamp(view.zoom | 0, 0, ZOOMS.length - 1)], md = maps[zl.level];
    const W = canvas.width, H = canvas.height, AW = Math.ceil(W / zl.S), AH = Math.ceil(H / zl.S);
    const u = (view.x - ORIGIN) / md.tileM, v = (view.z - ORIGIN) / md.tileM, lev = md.camLev(u, v);
    const gcx = (u - v) * md.H, gcy = (u + v) * md.hb - lev * md.lp;
    return { zl, md, AW, AH, S: zl.S, gcx, gcy, gx0: Math.round(gcx - AW / 2), gy0: Math.round(gcy - AH / 2), lev };
  }

  function compose(cam, now) {
    const { md, AW, AH, gx0, gy0 } = cam, lv = md.level;
    if (!B || B.w !== AW || B.h !== AH) {
      B = new Buf(AW, AH); light = new Uint8Array(AW * AH);
      off = new OffscreenCanvas(AW, AH);
      img = new ImageData(AW, AH); out32 = new Uint32Array(img.data.buffer);
    }
    // The wish list is rebuilt every frame, so anything the view has moved away from simply drops out of it. Order:
    // this zoom's visible chunks from the screen centre out, any view about to be cut to, the next zoom out's
    // visible chunks, then a one-chunk ring. The island level is baked whole before the first frame.
    const list = [], visible = new Set();
    wantView(cam, 0, list, visible, true);
    for (const pv of prefetchViews) wantView(camera(pv), pv.later ? 50 : 20, list, visible, false);
    if (lv > 0) wantView(camera({ x: camView.x, z: camView.z, zoom: ZOOMS.findIndex((z) => z.level === lv - 1) }), 40, list, visible, false);
    dispatch(list);
    evict(visible);
    const [cx0, cx1, cy0, cy1] = rectOf(cam);
    const fr = Math.floor(now / 160) & 7;
    B.c.fill(P.w1); B.z.fill(-1e30); B.id.fill(0); B.sh.fill(0);
    let holes = false;
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const ch = cache.get(keyOf(lv, cx, cy)), ox = cx * CS - gx0, oy = cy * CS - gy0;
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
    return holes;
  }
  // a missing chunk shows the next coarser level blown up around the camera centre
  function fallback(cam, x0, x1, y0, y1) {
    for (let k = cam.md.level - 1; k >= 0; k--) {
      const cc = camera({ x: camView.x, z: camView.z, zoom: ZOOMS.findIndex((z) => z.level === k) }), s = (maps[k].H / maps[k].tileM) / (cam.md.H / cam.md.tileM);
      let missing = false, lcx = NaN, lcy = NaN, ch = null;
      for (let y = y0; y < y1; y++) {
        const gy = Math.floor(cc.gcy + (cam.gy0 + y - cam.gcy) * s), cy = Math.floor(gy / CS), ry = (gy - cy * CS) * CS;
        for (let x = x0; x < x1; x++) {
          const p = y * cam.AW + x;
          if (B.z[p] === -2e30) continue;
          const gx = Math.floor(cc.gcx + (cam.gx0 + x - cam.gcx) * s), cx = Math.floor(gx / CS);
          if (cx !== lcx || cy !== lcy) { lcx = cx; lcy = cy; ch = cache.get(keyOf(k, cx, cy)); }
          if (!ch?.c) { missing = true; continue; }
          B.c[p] = ch.c[ry + gx - cx * CS];
          B.z[p] = -2e30;
        }
      }
      if (!missing) break;
    }
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = y * cam.AW + x; if (B.z[p] === -2e30) B.z[p] = -1e30; }
  }

  // ---------- live sprites ----------
  const clothOf = (color) => { const k = ["#9e3b2f", "#2f4a6d", "#a8812a", "#4e6b3a", "#6b3f5e"].indexOf(String(color).toLowerCase()); return P["c" + (k >= 0 ? k : strHash(String(color)) % 5)]; };
  function facingOf(id, dx, dz) {
    if (dx || dz) {
      const toCam = dx + dz, across = dx - dz;
      const f = { facing: Math.abs(across) > Math.abs(toCam) * 1.3 ? "side" : toCam > 0 ? "front" : "back", across };
      facingMem.set(id, f);
    }
    return facingMem.get(id) ?? { facing: "front", across: 1 };
  }
  // A sim step is a whole 150 m tile. Far out that reads as walking; close up it would streak across two screens, so
  // there the figure cuts to the new tile and walks only the last few meters into its spot.
  function motion(id, e, sim, lv) {
    const p = sim.pos?.(id) ?? { x: e.x, y: e.y, px: e.x, py: e.y }, al = clamp(sim.alpha ?? 1, 0, 1);
    const [ax, az] = spot(id, p.px, p.py, 0.35), [bx, bz] = spot(id, p.x, p.y, 0.35), dx = bx - ax, dz = bz - az;
    const moving = p.x !== p.px || p.y !== p.py;
    if (lv === 3 && moving) {
      const d = Math.hypot(dx, dz) || 1, walk = Math.min(d, 7) * (1 - al);
      return { x: bx - (dx / d) * walk, z: bz - (dz / d) * walk, dx, dz, moving };
    }
    return { x: ax + dx * al, z: az + dz * al, dx, dz, moving };
  }
  let selectedId = null;
  function entities(cam, sim, now) {
    const W = sim.w, md = cam.md, lv = md.level, sz = SIZE[lv], out = [], fires = [], picks = [];
    const at = (x, z) => { const p = project(md, x, z); return { ...p, sx: Math.round(p.gx - cam.gx0), sy: Math.round(p.gy - cam.gy0) }; };
    const onScreen = (a, m = 40) => a.sx > -m && a.sy > -m && a.sx < cam.AW + m && a.sy < cam.AH + m * 2;
      // footprint sprites anchor below their footprint centre; small people stand two pixels high in their sprite
    const add = (a, s, o = {}) => { if (s) out.push({ z: a.cz, sx: a.sx, sy: a.sy + (s.foot || 0) + (o.lift || 0), spr: s, mirror: !!o.mirror, bias: o.bias ?? md.hb + 2, shadow: o.shadow ?? !NOSHADOW.has(s.kind), xray: o.xray }); };
    const tileOf = (x, y) => W.tiles?.[y * 64 + x];
    const alpha = clamp(sim.alpha ?? 1, 0, 1);
    const pos = (e) => motion(e.id, e, sim, lv);
    // things: landscape props, piles, shelters, fires
    for (const t of W.things) {
      if (t.contained || t.inside) continue;
      if (lv === 0 && t.kind !== "structure" && t.kind !== "fire") continue;
      if (t.kind === "tree" && tileOf(t.x, t.y) === 1) continue;
      const [x, z] = spot(t.id, t.x, t.y), a = at(x, z);
      if (!onScreen(a, 60) || a.water && t.kind !== "fire") continue;
      const s = thingSprite(t, lv, sz);
      if (s) { s.kind ??= t.kind; add(a, s, { mirror: idH(t.id, 3) < 0.5 && t.kind !== "structure", bias: t.kind === "structure" ? md.hb + 4 : 2 }); }
      if (t.kind === "fire" || t.burning > 0) fires.push({ a, big: t.kind === "fire" ? 1 : 0.7 + (t.burning || 0), id: t.id });
      if (t.kind === "grave" || t.kind === "structure") picks.push({ kind: "thing", id: t.id, sx: a.sx, sy: a.sy, h: 6 });
    }
    // animals
    for (const an of W.animals || []) {
      if (an.hp !== undefined && an.hp <= 0) continue;
      const p = pos(an), a = at(p.x, p.z);
      if (!onScreen(a)) continue;
      const dir = p.moving ? p.dx - p.dz : an.dx - an.dy || 1, face = dir >= 0 ? 1 : 0;
      const step = p.moving ? Math.floor(alpha * 4) & 3 : 0, st = an.state;
      let s;
      if (an.species === "wolf") {
        const pose = st === "hunt" || st === "attack" || st === "flee" ? "run" : p.moving ? "walk" : st === "eat" ? "eat" : st === "rest" ? "rest" : "stand";
        s = TH.wolf ? spr(`wolf${sz.wolf}|${pose}|${step}|${strHash(an.id) % 97}`, () => TH.wolf(sz.wolf, pose, step, strHash(an.id) % 97)) : spr(`deerw${sz.deer}`, () => LF.deer(sz.deer, "stand", 1, 3));
        add(a, s, { mirror: !face, bias: 3, xray: an.id === selectedId });
      } else {
        const pose = st === "flee" ? "run" : st === "graze" && !p.moving ? "graze" : "stand";
        s = spr(`deer${sz.deer}|${pose}|${face}|${strHash(an.id) % 5}`, () => LF.deer(sz.deer, pose, face, strHash(an.id) % 5));
        add(a, s, { bias: 3, xray: an.id === selectedId });
      }
      picks.push({ kind: "animal", id: an.id, sx: a.sx, sy: a.sy - (sz.deer >> 1), h: sz.deer + 3, name: an.species });
    }
    // people
    for (const ag of W.agents || []) {
      if (ag.dead || ag.alive === false) continue;
      const p = pos(ag), a = at(p.x, p.z);
      if (!onScreen(a)) continue;
      const stage = (W.t - ag.born) / YEAR < 1 ? "child" : (W.t - ag.born) / YEAR < 5 ? "adult" : "elder";
      const hp = Math.max(3, Math.round(sz.person * (stage === "child" ? 0.7 : 1))), cloth = clothOf(ag.color), seedA = strHash(ag.id) % 997;
      const down = ag.down > W.t;
      const f = facingOf(ag.id, p.dx, p.dz);
      let s, mirror = false;
      if (down) s = TH.lying ? spr(`lie${hp}|${cloth}|${seedA}`, () => TH.lying(hp, cloth, seedA)) : spr(`sit${hp}|${cloth}|${seedA}`, () => SP.person(hp, cloth, "front", "sit", seedA));
      else if (TH.walker && lv > 0) {
        const goal = String(ag.goal?.type ?? ag.goal ?? ""), carry = /wood|stick|log/.test(goal) ? "wood" : /stone|rock/.test(goal) ? "stone" : /food|forage|hunt|berr|fish/.test(goal) ? "food" : "none";
        const step = p.moving ? Math.floor(alpha * 4) & 3 : 0;
        s = spr(`walk${hp}|${cloth}|${f.facing}|${step}|${carry}|${stage}|${seedA}`, () => TH.walker(hp, cloth, f.facing, step, carry, stage, seedA));
        mirror = f.across < 0;
      } else {
        s = spr(`man${hp}|${cloth}|${f.facing}|${seedA}|${f.across > 0 ? 1 : 0}`, () => SP.person(hp, cloth, f.facing, "stand", seedA, f.across > 0 ? 1 : 0));
        mirror = f.facing !== "side" && f.across < 0;
      }
      add(a, s, { mirror, bias: 4, lift: hp < 16 && !down ? 2 : 0, xray: true });
      const icon = down ? "sleep" : ag.sickness ? "sick" : ag.thinking ? "think" : ag.engaged ? "fight" : null;
      if (icon && lv > 0 && TH.icon) { const ic = spr(`icon${icon}`, () => TH.icon(icon)); if (ic) out.push({ z: 1e9, sx: a.sx, sy: a.sy - hp - 2, spr: ic, bias: 0, shadow: false }); }
      picks.push({ kind: "agent", id: ag.id, sx: a.sx, sy: a.sy - (hp >> 1), h: hp + 3, name: ag.name, top: a.sy - hp - 2 });
    }
    ambient(cam, out, now);
    return { out, fires, picks };
  }
  // Gulls wheel over open water and fish leap near it: anchors on a world grid, so they stay put while the camera pans.
  function ambient(cam, out, now) {
    const md = cam.md, lv = md.level;
    if (lv === 0) return;
    const t = now / 1000, G = [0, 300, 140, 45][lv], span = [0, 5, 8, 14][lv], fl = [0, 3, 5, 9][lv];
    const [ua, va] = [cam.gx0 / md.H, cam.gy0 / md.hb], x0 = cam.AW / md.H, y0 = cam.AH / md.hb;
    const us = [(ua + va) / 2, (ua + x0 + va + y0) / 2], vs = [(va - ua - x0) / 2, (va + y0 - ua) / 2];
    const X0 = ORIGIN + us[0] * md.tileM, X1 = ORIGIN + us[1] * md.tileM, Z0 = ORIGIN + vs[0] * md.tileM, Z1 = ORIGIN + vs[1] * md.tileM;
    for (let gz = Math.floor(Z0 / G); gz <= Z1 / G; gz++)
      for (let gx = Math.floor(X0 / G); gx <= X1 / G; gx++) {
        const r = h2(gx, gz, 701);
        if (r > 0.3 && r < 0.75) continue;
        const x = (gx + h2(gx, gz, 702)) * G, z = (gz + h2(gx, gz, 703)) * G, p = project(md, x, z);
        if (!p.water) continue;
        const sx = Math.round(p.gx - cam.gx0), sy = Math.round(p.gy - cam.gy0);
        if (sx < -40 || sy < -60 || sx > cam.AW + 40 || sy > cam.AH + 40) continue;
        if (r <= 0.3) {
          // a gull on its own slow loop, flapping four frames
          const ph = h2(gx, gz, 704) * TAU, R = span * 3, a = t * 0.45 + ph, f = Math.floor(t * 7 + ph * 3) & 3, seedB = gx & 1;
          const b = spr(`gull${span}|${f}|${seedB}`, () => LF.bird(span, f, "gull", seedB));
          if (b) out.push({ z: 1e9, sx: Math.round(sx + Math.cos(a) * R), sy: Math.round(sy - span * 5 + Math.sin(a) * R * 0.5), spr: b, bias: 0, shadow: false });
        } else if (r >= 0.9) {
          // a fish breaks the surface now and then, four frames of splash out of every few seconds
          const cyc = t * 1.6 + h2(gx, gz, 705) * 16, f = Math.floor(cyc * 2.5) % 10;
          if (f > 3) continue;
          const fsh = spr(`fish${f}|${gz & 1}|${fl}`, () => LF.fish(f, gz & 1, fl));
          if (fsh) out.push({ z: p.cz + 1, sx, sy, spr: fsh, bias: 1, shadow: false });
        }
      }
  }
  function thingSprite(t, lv, sz) {
    const k = sz.thing, seedT = strHash(t.id) % 13, r = (v) => Math.max(1, Math.round(v));
    if (lv === 0) {
      if (t.kind === "structure" && (t.shelter?.tier ?? 0) >= 1) return spr("minitent", () => SP.miniTent(1));
      return null;
    }
    const hut = sz.hut;
    switch (t.kind) {
      case "tree": return spr(`tree${lv}|${seedT}`, () => SP.broad(r(18 * k + 4), "oak", seedT * 31, 0.5));
      case "stump": return spr(`stump${lv}`, () => SP.stump(r(2 * k + 1), r(1.6 * k + 1), 3));
      case "burnt_stump": return TH.burnt ? spr(`burnt${lv}`, () => TH.burnt(r(5 * k + 1), 1)) : spr(`stumpb${lv}`, () => SP.stump(r(2 * k + 1), r(1.6 * k + 1), 5));
      case "bush": return spr(`bush${lv}|${seedT}`, () => SP.bush(r(4 * k + 2), seedT, 0, 0.6));
      case "dead_bush": return TH.deadbush ? spr(`dbush${lv}|${seedT & 1}`, () => TH.deadbush(r(4.5 * k), seedT)) : spr(`bushd${lv}`, () => SP.bush(r(4 * k + 2), seedT, 1, 0));
      case "sapling": return TH.sapling ? spr(`sap${lv}|${seedT & 3}`, () => TH.sapling(r((4 + (seedT & 3)) * k), seedT)) : spr(`sapb${lv}`, () => SP.broad(r(6 * k + 3), "ash", seedT, 0.3));
      case "mushroom": return spr(`mush${lv}`, () => LF.mushrooms(r(3 * k), seedT & 3));
      case "herb": return TH.herb ? spr(`herb${lv}`, () => TH.herb(r(3 * k), seedT)) : spr(`herbf${lv}`, () => SP.flower(r(2 * k + 1), 0.3, seedT));
      case "stick": return TH.stick ? spr(`stick${lv}|${seedT & 3}`, () => TH.stick(r(4 * k), seedT)) : spr(`stickl${lv}`, () => SP.log(r(5 * k + 2), 1, 1, seedT));
      case "stone": return spr(`stone${lv}|${seedT & 3}`, () => SP.pebble(r(1.5 * k + 1), seedT));
      case "boulder": return spr(`boulder${lv}|${seedT & 3}`, () => SP.rock(r(5 * k + 2), seedT, 0.2));
      case "reeds": return spr(`reeds${lv}|${seedT & 3}`, () => SP.reeds(r(5 * k + 2), seedT));
      case "clay": return TH.clay ? spr(`clay${lv}`, () => TH.clay(r(3 * k), seedT)) : null;
      case "ash": return TH.ash ? spr(`ash${lv}`, () => TH.ash(r(3 * k), seedT)) : null;
      case "pit": return TH.pit ? spr(`pit${lv}|${t.stage ?? 0}`, () => TH.pit(r(3 * k), clamp(t.stage ?? 0, 0, 1), seedT)) : null;
      case "trap": return TH.trap ? spr(`trap${lv}|${!!t.caught}`, () => TH.trap(r(6 * k), !!t.caught, seedT)) : null;
      case "well": return TH.well ? spr(`well${lv}`, () => TH.well(r(7 * k), seedT)) : spr(`wellr${lv}`, () => SP.rock(r(3 * k + 2), 2, 0));
      case "grave": return TH.grave ? spr(`grave${lv}|${seedT & 3}`, () => TH.grave(r(6 * k), seedT)) : spr(`graver${lv}`, () => SP.rock(r(2 * k + 1), 1, 0));
      case "fire": return TH.firering ? spr(`ring${lv}`, () => TH.firering(r(3 * k), 1)) : null;
      case "item": {
        const it = String(t.item ?? ""), what = /wood|log|stick|plank/.test(it) ? "wood" : /stone|ore|flint/.test(it) ? "stone" : /hide|fur|leather/.test(it) ? "hide" : /meat|berr|fish|food|root|nut/.test(it) ? "food" : "misc";
        return TH.pile ? spr(`pile${lv}|${what}|${seedT & 3}`, () => TH.pile(r(5 * k), what, seedT)) : what === "wood" ? spr(`wp${lv}`, () => SP.woodpile(r(k + 0.5), 3)) : spr(`pb${lv}`, () => SP.pebble(r(1.5 * k + 1), seedT));
      }
      case "structure": {
        const tier = t.shelter?.tier ?? 0, style = t.shelter?.style ?? "sticks";
        if (TH.shelter) return spr(`sh${lv}|${tier}|${style}|${seedT & 3}`, () => TH.shelter(tier, style, hut, seedT));
        return tier === 0 ? spr(`wpile${lv}`, () => SP.woodpile(r(k + 0.5), 3)) : spr(`mt${lv}|${tier}`, () => SP.miniTent(lv >= 2 ? 2 : 1));
      }
    }
    return null;
  }

  // ---------- fire, smoke, light ----------
  function drawFires(cam, fires, now, night) {
    const md = cam.md, sz = SIZE[md.level];
    const wind = simRef?.w?.weather?.wind ?? { dx: 1, dy: 0 }, du = wind.dx ?? 1, dv = wind.dy ?? 0, drift = clamp((du - dv) * 0.3, -0.45, 0.45);
    for (const f of fires) {
      const { a } = f, fl = Math.max(2, Math.round(sz.fire * f.big)), ph = (now / 1000) * 5 + idH(f.id, 5) * 8;
      // glow on the ground by day; warm light pools by night
      const R = [3, 6, 12, 30][md.level] * (1 + night * 1.6) * f.big * (0.95 + 0.05 * Math.sin(ph * 2.3));
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
      if (md.level > 0) {
        const s = spr(`flame${fl}|${Math.floor(ph) & 7}`, () => SP.flames(fl, 5 + (Math.floor(ph) & 7)));
        blit(B, s, a.sx, a.sy + 1, a.cz + 2, 9, false, md.hb + 3);
      } else if (a.sx >= 0 && a.sy >= 1 && a.sx < B.w && a.sy < B.h) B.c[(a.sy - 1) * B.w + a.sx] = (Math.floor(ph) & 1) ? P.f3 : P.f2;
      smoke(cam, a.sx, a.sy - fl, sz.person * (md.level === 2 ? 5 : 3) * f.big, Math.max(0.8, sz.person * 0.18), drift, now / 1000 + idH(f.id, 6) * 9);
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

  let camView = { x: 0, z: 0, zoom: 2 };
  function frame(view, sim) {
    const now = performance.now(), t0 = now;
    camView = view;
    if (sim) { simRef = sim; if (!synced) sync(sim); }
    const cam = camera(view);
    const holes = compose(cam, now);
    const clock = sim?.clock?.() ?? { hour: 8, night: 0 };
    const night = clamp(clock.night ?? 0, 0, 1);
    light.fill(0);
    let picks = [];
    if (sim) {
      const E = entities(cam, sim, now);
      E.out.sort((a, b) => a.z - b.z);
      for (const o of E.out) if (o.shadow && night < 0.6) castShadow(B, o.spr, o.sx, o.sy, cam.md.shx, cam.md.shy, o.mirror);
      selectedId = view.selected ?? null;
      let id = 2;
      for (const o of E.out) { o.id = id++; blit(B, o.spr, o.sx, o.sy, o.z, o.id, o.mirror, o.bias); }
      // people behind trees still show, as a checkered silhouette through the leaves
      for (const o of E.out) if (o.xray) xray(o);
      drawFires(cam, E.fires, now, night);
      picks = E.picks;
      const sel = view.selected && picks.find((p) => p.id === view.selected);
      if (sel) label(sel.name ?? String(sel.id), sel.sx, (sel.top ?? sel.sy - sel.h) - 3);
    }
    haze(cam, clock.hour ?? 8);
    lastPick = picks.map((p) => ({ ...p, cam }));
    // indexed colour to RGBA through the time-of-day table; the light buffer picks the fire-lit copy
    const lut = lutFor(clock.hour ?? 8), c = B.c;
    for (let p = 0; p < c.length; p++) out32[p] = lut[light[p] * NCOL + c[p]];
    off.getContext("2d").putImageData(img, 0, 0);
    const g = canvas.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.drawImage(off, 0, 0, cam.AW * cam.S, cam.AH * cam.S);
    const ms = performance.now() - t0;
    stats.composeMs = stats.composeMs ? stats.composeMs * 0.9 + ms * 0.1 : ms;
    frames++;
    if (now - fpsT > 1000) { stats.fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; stats.memMB = Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6); stats.cacheMB = Math.round(cacheBytes / 1e6); }
    if (firstFrame && !holes) { firstFrame = false; stats.firstFrameMs = Math.round(performance.now() - tStart); }
    api.lastMs = ms; api.lastHoles = holes;
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
        if (B.id[p] !== o.id && B.id[p] !== 0 && ((sx + sy) & 1)) B.c[p] = col;
      }
    }
  }
  function label(s, cx, y) {
    const txt = s.toUpperCase(), w = txt.length * 6 - 1, x = Math.round(cx - w / 2);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) text(B, txt, x + dx, y - 7 + dy, P.ink);
    text(B, txt, x, y - 7, P.snow);
  }
  function haze(cam, hour) {
    const morning = clamp(1 - Math.abs(hour - 7.5) / 3.5, 0, 1) * 0.8 + 0.2, most = 0.32 * morning, reach = 0.42;
    for (let y = 0; y < B.h; y++) {
      const a = most * Math.max(0, 1 - y / (B.h * reach)) ** 1.5;
      if (a <= 0) break;
      for (let x = 0; x < B.w; x++) if (bayer(x + cam.gx0, y + cam.gy0) < a) { const p = y * B.w + x; B.c[p] = HAZE[B.c[p]]; }
    }
  }

  function toWorld(sx, sy, view) {
    const cam = camera(view), md = cam.md, gx = cam.gx0 + sx / cam.S, gy = cam.gy0 + sy / cam.S, a = gx / md.H;
    let lev = cam.lev, u = 0, v = 0;
    for (let k = 0; k < 5; k++) { const b = (gy + lev * md.lp) / md.hb; u = (a + b) / 2; v = (b - a) / 2; lev = md.ground(u, v); }
    return { x: ORIGIN + u * md.tileM, z: ORIGIN + v * md.tileM };
  }
  // the view centre that puts world point (x, z), standing on its ground, in the middle of the screen
  function centreOn(x, z, view) {
    const md = maps[ZOOMS[clamp(view.zoom | 0, 0, ZOOMS.length - 1)].level], p = project(md, x, z), a = p.gx / md.H;
    let u = p.u, v = p.v;
    for (let k = 0; k < 4; k++) { const b = (p.gy + md.camLev(u, v) * md.lp) / md.hb; u = (a + b) / 2; v = (b - a) / 2; }
    return { x: ORIGIN + u * md.tileM, z: ORIGIN + v * md.tileM };
  }
  function pick(sx, sy, view) {
    const cam = camera(view), x = sx / cam.S, y = sy / cam.S;
    let best = null, bd = Infinity;
    for (const p of lastPick) {
      const d = Math.hypot(p.sx - x, p.sy - y), r = Math.max(7, p.h);
      if (d < r && d + (p.kind === "agent" ? 0 : 3) < bd) { bd = d; best = { kind: p.kind, id: p.id }; }
    }
    return best;
  }
  // world position of a sim agent or animal right now, for the follow camera
  function where(id, sim, view) {
    const e = sim.w.agents.find((a) => a.id === id) || sim.w.animals.find((a) => a.id === id);
    if (!e) return null;
    return motion(id, e, sim, ZOOMS[clamp((view?.zoom ?? 2) | 0, 0, ZOOMS.length - 1)].level);
  }
  // the island level is small; baked whole up front it is the fallback under everything, so no view shows flat colour
  {
    // a wide margin of open sea round the map, so the fallback under any view at the map's edge is still sea
    const md = maps[0], m = 30, hb = md.H * 0.5;
    const cx0 = Math.floor((-(md.NJ + 2 * m) * md.H) / CS), cx1 = Math.floor(((md.NI + 2 * m) * md.H) / CS);
    const cy0 = Math.floor((-2 * m * hb - md.maxLev * md.lp - 40) / CS), cy1 = Math.floor(((md.NI + md.NJ + 2 * m) * hb) / CS);
    const keys = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) keys.push([cx, cy]);
    const t1 = performance.now();
    while (true) {
      const list = [];
      for (const [cx, cy] of keys) want(0, cx, cy, 0, list);
      if (!list.length && keys.every(([cx, cy]) => { const c = cache.get(keyOf(0, cx, cy)); return c.c || c.failed; })) break;
      dispatch(list);
      onProgress?.(keys.filter(([cx, cy]) => cache.get(keyOf(0, cx, cy)).c).length, keys.length, "baking the island");
      await new Promise((r) => setTimeout(r, 30));
    }
    stats.islandMs = Math.round(performance.now() - t1); stats.islandChunks = keys.length;
  }
  const zooms = ZOOMS.map((z) => ({ ...z, tileM: maps[z.level].tileM, pxPerM: (maps[z.level].H / maps[z.level].tileM) * z.S }));
  stats.readyMs = Math.round(performance.now() - tStart);
  const api = { readiness, prefetch: (views) => { prefetchViews = views || []; }, centreOn, spotOf: (t) => spot(t.id, t.x, t.y), picks: () => lastPick.map(({ cam, ...p }) => ({ kind: p.kind, id: p.id, sx: p.sx, sy: p.sy })), zooms, frame, changed, pick, toWorld, where, stats, maps, pool, cache, lastMs: 0, lastHoles: false };
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
  g.imageSmoothingEnabled = false;
  g.drawImage(off, 0, 0, AW * S, AH * S);
}
