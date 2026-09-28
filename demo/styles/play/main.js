// The live page: the game's sim running in this tab, drawn by the isopixel renderer with a pan, zoom and orbit camera.
import { createLive, loadingScreen } from "../isopixel/live.js";
import { drawInspector } from "../isopixel/inspect.js";
import { RGB, P } from "../isopixel/pal.js";
import { Buf } from "../isopixel/px.js";
import { text } from "../isopixel/ui.js";
import { createCamera, norm8 } from "./camera.js";

const Q = new URLSearchParams(location.search);
// every URL parameter is checked, so a bad one falls back to its default instead of stopping the page
const num = (k, def, lo = -Infinity, hi = Infinity) => {
  const s = Q.get(k), v = s == null || s.trim() === "" ? NaN : Number(s);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
};
const seed = Math.trunc(num("seed", 1)), warm = Math.trunc(num("warm", 2016, 0, 40000)), withSim = Q.get("sim") !== "0";
const benchKind = ["zoom", "orbit", "turn", "pan"].includes(Q.get("bench")) ? Q.get("bench") : null;
const canvas = document.getElementById("view"), hint = document.getElementById("hint"), statsEl = document.getElementById("stats"), pace = document.getElementById("pace");
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8], DBL_MS = 300;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toM = (t) => t * 150 - 4800;

const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); loadingScreen(canvas, `failed: ${e?.message ?? e}`.slice(0, 90), 0); };
window.addEventListener("error", (e) => fail(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => fail(e.reason));

function fit() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
fit();
window.addEventListener("resize", fit);

// an indexed art buffer onto a small canvas, shown at twice its size like the rest of the art
function paintBuf(cv, B) {
  if (cv.width !== B.w || cv.height !== B.h) { cv.width = B.w; cv.height = B.h; cv.style.width = `${B.w * 2}px`; cv.style.height = `${B.h * 2}px`; }
  const img = new ImageData(B.w, B.h), o = new Uint32Array(img.data.buffer);
  for (let p = 0; p < B.c.length; p++) { const c = RGB[B.c[p]]; o[p] = 0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]; }
  cv.getContext("2d").putImageData(img, 0, 0);
}

async function main() {
  const t0 = performance.now();
  // one line of progress in the game's own font until the opening view is complete
  const steps = { renderer: ["growing the island", 0], sim: ["warming the world", 0] };
  const say = () => { const r = steps.renderer, w = steps.sim; loadingScreen(canvas, `${r[0]}  ${w[1] < 1 && withSim ? "/ " + w[0] : ""}`.trim(), (r[1] + (withSim ? w[1] : 1)) / 2); };
  say();
  // the sim and the renderer's workers grow the same island at the same time
  const simP = withSim ? import("./sim.js").then(({ createSim }) => createSim({ seed, warm, onProgress: (d, n) => { steps.sim = ["warming the world", d / n]; say(); } })) : Promise.resolve(null);
  const live = await createLive({ seed, canvas, workers: Math.trunc(num("workers", 0, 0, 8)) || undefined, adjacent: Q.get("adj") !== "0", check: Q.get("check") === "1", onProgress: (d, n, what) => { steps.renderer = [what, 0.5 * (what === "baking the island" ? 1 : 0) + (0.5 * d) / n]; say(); } });
  const sim = await simP;
  const ready = performance.now() - t0;
  // ?zoom= takes a name, the old 0..3 index, or a number of zoom steps; ?bearing= one of the 8 whole bearings
  const zq = Q.get("zoom"), names = ["island", "region", "valley", "close"];
  const zoom0 = zq == null ? live.named.close : Object.hasOwn(live.named, zq) ? live.named[zq] : /^[0-3]$/.test(zq) ? live.named[names[+zq]] : num("zoom", live.named.close, 0, live.zmax);
  const view = { x: -2738, z: -1838, zoom: zoom0, bearing: norm8(Math.round(num("bearing", 0))), up: 0, selected: null, turnTo: null };
  const metrics = { readyMs: Math.round(ready), revealMs: 0, tabs: [], turns: [] };
  const camera = createCamera({ live, view, canvas, onTurn: (ms) => metrics.turns.push(Math.round(ms)) });
  let follow = null, openingPerson = null, opening = null, farSince = 0, farDest = null;
  // Open on the person nearest the densest cluster of shelters, fires and stumps, and follow them; with nothing built
  // yet, on whoever has the most going on around them.
  if (sim?.w.agents.length) {
    const W = sim.w, weight = (t) => (t.contained || t.inside ? 0 : t.kind === "structure" ? 2 + (t.shelter?.tier ?? 0) * 2 : t.kind === "fire" ? 4 : t.kind === "well" ? 2 : ["stump", "burnt_stump", "pit", "ash", "grave"].includes(t.kind) ? 1 : 0);
    const built = W.things.filter((t) => weight(t) > 0);
    let best = null, bs = 0;
    for (const t of built) {
      const sc = built.reduce((a, o) => a + (Math.abs(o.x - t.x) <= 2 && Math.abs(o.y - t.y) <= 2 ? weight(o) : 0), 0);
      if (sc > bs) { bs = sc; best = t; }
    }
    const busy = (a) => W.things.filter((t) => !t.contained && t.kind !== "tree" && Math.abs(t.x - a.x) <= 2 && Math.abs(t.y - a.y) <= 2).length + W.agents.filter((b) => Math.abs(b.x - a.x) <= 2 && Math.abs(b.y - a.y) <= 2).length * 4;
    const person = best ? [...W.agents].sort((p, q) => Math.hypot(p.x - best.x, p.y - best.y) - Math.hypot(q.x - best.x, q.y - best.y))[0] : [...W.agents].sort((p, q) => busy(q) - busy(p))[0];
    opening = view.zoom < 1 ? { kind: "ground", px: 32, py: 32 } : { kind: "ground", px: person.px, py: person.py };
    camera.lookAt(live.where(opening, sim, view));
    openingPerson = person.id;
  }
  let tabWatch = null;
  // anything can be selected: a person, animal or thing by id, or a point of ground; people and animals are followed
  const movers = (id) => !!sim && (sim.w.agents.some((a) => a.id === id) || sim.w.animals.some((a) => a.id === id));
  const select = (sel, watch = true) => {
    view.selected = sel; follow = typeof sel === "string" && movers(sel) ? sel : null; farSince = 0;
    if (watch && follow) tabWatch = { t0: performance.now(), hole: 0, cutAt: 0, last: performance.now() };
    inspScroll = 0; inspect();
  };

  // ---------- inspector: the selection's real data, redrawn every tick, with a box to close it ----------
  const insp = document.getElementById("inspector"), IW = 184, IH = 232, CB = { x: IW - 15, y: 4, s: 9 };
  let inspScroll = 0, inspMax = 0, inspData = null;
  function inspect() {
    const sel = view.selected;
    inspData = sel && sim ? (typeof sel === "object" ? sim.inspectGround(sel.px, sel.py) : sim.inspect(sel)) : null;
    if (sel && !inspData) { view.selected = null; follow = null; }
    if (!inspData) { insp.hidden = true; return; }
    paintInspector();
  }
  function paintInspector() {
    const B = drawInspector(inspData, { w: IW, h: IH, scroll: inspScroll });
    inspScroll = B.scroll; inspMax = B.scrollMax;
    // a raised button at the end of the title bar, over the end of a long title
    const { x, y, s } = CB, put = (i, j, c) => { B.c[j * B.w + i] = c; };
    for (let j = y; j < y + s; j++) for (let i = x - 2; i < x + s; i++) put(i, j, P.w2);
    for (let k = 0; k < s; k++) { put(x + k, y, P.w4); put(x, y + k, P.w4); put(x + k, y + s - 1, P.ink); put(x + s - 1, y + k, P.ink); }
    for (let k = 0; k < 5; k++) { put(x + 2 + k, y + 2 + k, P.snow); put(x + 6 - k, y + 2 + k, P.snow); }
    paintBuf(insp, B);
    insp.hidden = false;
  }
  const onClose = (e) => {
    const r = insp.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * IW, y = ((e.clientY - r.top) / r.height) * IH;
    return x >= CB.x - 1 && x <= CB.x + CB.s && y >= CB.y - 1 && y <= CB.y + CB.s;
  };
  insp.addEventListener("wheel", (e) => { e.preventDefault(); inspScroll = clamp(inspScroll + e.deltaY / 2, 0, inspMax); if (inspData) paintInspector(); }, { passive: false });
  insp.addEventListener("pointerdown", (e) => { if (onClose(e)) { e.preventDefault(); select(null); } });
  insp.addEventListener("pointermove", (e) => { insp.style.cursor = onClose(e) ? "pointer" : ""; });

  // ---------- pause and speed: a small marker in the corner while either is off the usual ----------
  let paceKey = "";
  function paintPace() {
    const key = !sim ? "" : sim.paused ? "PAUSED" : sim.speed !== 1 ? `X${sim.speed}` : "";
    if (key === paceKey) return;
    paceKey = key;
    pace.hidden = !key;
    if (!key) return;
    const B = new Buf(key.length * 6 + 7, 13);
    B.c.fill(P.w2);
    for (let i = 0; i < B.w; i++) { B.c[i] = P.w4; B.c[(B.h - 1) * B.w + i] = P.w1; }
    text(B, key, 4, 3, P.snow);
    paintBuf(pace, B);
  }

  // ---------- input ----------
  const pointers = new Map();
  let drag = null, orbit = null, pinching = false, lastClick = null;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 2) { orbit = { x: e.clientX }; camera.stopTurn(); return; }
    if (e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x0: e.clientX, y0: e.clientY, moved: 0, on: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      camera.pinchStart((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y), Math.atan2(b.y - a.y, b.x - a.x));
      pinching = true; drag = null; follow = null;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (orbit) { camera.orbitBy((orbit.x - e.clientX) / 180); orbit.x = e.clientX; return; }
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pinching && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      camera.pinchMove((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y), Math.atan2(b.y - a.y, b.x - a.x));
      return;
    }
    if (!drag) return;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    // past the click threshold the world jumps to the cursor, then moves with it exactly
    if (!drag.on && drag.moved > 5) { drag.on = true; canvas.classList.add("dragging"); follow = null; camera.panBy(e.clientX - drag.x0, e.clientY - drag.y0); }
    else if (drag.on) camera.panBy(dx, dy);
  });
  const up = (e) => {
    if (orbit) { orbit = null; camera.settle(); return; }
    pointers.delete(e.pointerId);
    canvas.classList.remove("dragging");
    if (pinching) { if (pointers.size < 2) { pinching = false; camera.pinchEnd(); } drag = null; return; }
    if (drag && !drag.on && e.type === "pointerup") click(e.clientX, e.clientY);
    drag = null;
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  // a click waits out the double-click window; a double-click only zooms, undoing a first click that landed
  function click(sx, sy) {
    const now = performance.now(), prev = lastClick;
    if (prev && now - prev.t < DBL_MS + 200 && Math.hypot(sx - prev.x, sy - prev.y) < 10) {
      clearTimeout(prev.timer);
      if (prev.done) select(prev.before, false);
      lastClick = null;
      camera.zoomTo(camera.goal + 1, follow ? null : sx, follow ? null : sy);
      return;
    }
    const hit = live.pick(sx, sy, view), c = { t: now, x: sx, y: sy, before: view.selected, done: false };
    c.timer = setTimeout(() => { c.done = true; choose(hit, sx, sy); }, DBL_MS);
    lastClick = c;
  }
  // a second click on what is already selected lets it go
  function choose(hit, sx, sy) {
    if (!hit) { select(null); return; }
    const sel = hit.kind === "ground" ? hit : hit.id, cur = view.selected;
    let again = sel === cur;
    if (!again && typeof sel === "object" && cur && typeof cur === "object") {
      const g = live.where(cur, sim, view), s = g && live.screenOf(view, g.x, g.z, g.y);
      again = !!s && Math.hypot(s[0] - sx, s[1] - sy) < 8;
    }
    select(again ? null : sel);
  }
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.zoomTo(camera.goal - clamp(e.deltaY, -200, 200) * 0.004, follow ? null : e.clientX, follow ? null : e.clientY);
  }, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") select(null);
    else if (e.key === "Tab" && sim?.w.agents.length) {
      e.preventDefault();
      const list = sim.w.agents, k = list.findIndex((a) => a.id === view.selected), n = list.length;
      select(list[((k < 0 ? (e.shiftKey ? 0 : -1) : k) + (e.shiftKey ? -1 : 1) + n) % n].id);
    }
    else if (e.key === " " && sim) { sim.paused = !sim.paused; e.preventDefault(); }
    else if ((e.key === "[" || e.key === "]") && sim) { const k = SPEEDS.indexOf(sim.speed); sim.speed = SPEEDS[clamp((k < 0 ? 2 : k) + (e.key === "]" ? 1 : -1), 0, SPEEDS.length - 1)]; }
    else if (e.key === "+" || e.key === "=" || e.key === "-") {
      const mid = follow ? [null, null] : [canvas.width / 2, canvas.height / 2];
      camera.zoomTo(Math.round(camera.goal) + (e.key === "-" ? -1 : 1), ...mid);
    }
    else if (e.key === "q" || e.key === "Q") camera.turnBy(-1);
    else if (e.key === "e" || e.key === "E") camera.turnBy(1);
  });
  setTimeout(() => hint.classList.add("gone"), 8000);
  globalThis.play = globalThis.nomads = { live, sim, view, camera, select, metrics, zoomTo: (g, sx, sy) => camera.zoomTo(g, sx, sy), turnBy: (d) => camera.turnBy(d), inspected: () => inspData };

  // Near targets are eased toward. A far one (a Tab to someone across the island) is baked first while the camera
  // holds, then cut to, so the close level never sits on a fallback.
  function followStep(now, dt) {
    const p = live.where(follow, sim, view);
    if (!p) { select(null); live.prefetch(null); return; }
    const upOf = (q) => q.y - live.camH(q.x, q.z), ahead = p.dx || p.dz ? [{ ...view, x: p.x + p.dx, z: p.z + p.dz, up: upOf(p), later: true }] : [];
    if (camera.offCentre(p) <= canvas.width * 0.35) {
      camera.follow(p, dt);
      farSince = 0;
      live.prefetch(ahead);
      return;
    }
    // lock the destination when the jump starts: a walker keeps moving, and chasing each step would never finish
    if (!farSince) { farSince = now; farDest = { ...view, x: p.x, z: p.z, up: upOf(p) }; }
    live.prefetch([farDest, ...ahead]);
    if (live.readiness(farDest).ready || now - farSince > 3000) {
      camera.lookAt({ x: farDest.x, z: farDest.z, y: farDest.up + live.camH(farDest.x, farDest.z) });
      farSince = 0;
      if (tabWatch && !tabWatch.cutAt) tabWatch.cutAt = now - tabWatch.t0;
    }
  }

  // ---------- loop ----------
  const showStats = Q.get("stats") === "1";
  statsEl.hidden = !showStats;
  let lastStats = 0, readyMarked = false, lastNow = performance.now();
  const bench = benchKind ? benchRunner(benchKind, live, view) : null;
  let revealed = false;
  function loop(now) {
    const dt = Math.min(100, now - lastNow);
    lastNow = now;
    // the world waits behind the loading line until the opening view is baked, so nothing is missed
    if (sim && revealed) {
      const ch = sim.update(now);
      if (ch) { live.changed(ch); if (view.selected) inspect(); }
    }
    if (revealed && bench) bench.step(now);
    camera.step(dt, now);
    if (follow && sim) followStep(now, dt);
    else live.prefetch(null);
    // the ground under the opening shot is only exact once its chunks are in, so keep it centred until then
    if (!revealed && opening) camera.lookAt(live.where(opening, sim, view));
    camera.guard();
    const r = live.frame(view, sim);
    if (!revealed) {
      const rd = live.readiness(view);
      if (rd.ready && !r.holes) {
        revealed = true;
        metrics.revealMs = Math.round(performance.now() - t0);
        // follow the settlement's person only if they are in this frame
        if (openingPerson && !bench && live.picks().some((p) => p.id === openingPerson)) select(openingPerson, false);
      } else loadingScreen(canvas, `baking the view ${rd.done}/${rd.all}`, rd.done / rd.all);
    }
    if (tabWatch) {
      const dt2 = now - tabWatch.last;
      tabWatch.last = now;
      if (r.holes) tabWatch.hole += dt2;
      if (now - tabWatch.t0 > 6000) { metrics.tabs.push({ holeMs: Math.round(tabWatch.hole), cutMs: Math.round(tabWatch.cutAt) }); tabWatch = null; }
    }
    if (revealed) paintPace();
    if (!readyMarked && revealed && !bench) { readyMarked = true; document.body.dataset.firstFrame = String(Math.round(performance.now() - t0)); document.body.classList.add("ready"); }
    if (showStats && now - lastStats > 250) {
      lastStats = now;
      const s = live.stats, c = sim?.clock(), lf = live.level;
      statsEl.textContent = [
        `fps ${s.fps.toFixed(0)}  frame ${s.composeMs.toFixed(1)} ms  slots ${s.slots}`,
        `bake queue ${s.bakeQueue}  baked ${s.bakedChunks}  avg ${s.bakeMsAvg.toFixed(0)} ms`,
        `heap ${s.memMB} MB  chunks ${s.cacheMB ?? 0} MB  workers ${s.workers}`,
        `zoom ${view.zoom.toFixed(2)} ${live.levels[lf?.L ?? 0].name} x${(lf?.s ?? 0).toFixed(2)}  bearing ${view.bearing.toFixed(2)}`,
        sim ? `day ${c.day} ${String(Math.floor(c.hour)).padStart(2, "0")}:${String(Math.floor((c.hour % 1) * 60)).padStart(2, "0")}  x${sim.speed}${sim.paused ? " paused" : ""}  tick ${sim.tickMs.toFixed(1)} ms` : "no sim",
      ].join("\n");
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ?bench=zoom | orbit | turn | pan: drive the camera and record frame rate and frame cost, for the report.
  function benchRunner(kind, live, view) {
    const secs = num("benchs", 12, 1, 600), out = { kind, samples: [] };
    let start = 0, done = false, base = null, lastT = 0, k = 0;
    const finish = () => {
      const ms = out.samples.map((s) => s.ms).sort((a, b) => a - b), dts = out.samples.map((s) => s.dt).filter((d) => d > 0);
      out.fps = +(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)).toFixed(1);
      out.frameMs = +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2);
      out.frameP95 = +ms[Math.floor(ms.length * 0.95)].toFixed(2);
      out.holeFrames = out.samples.filter((s) => s.holes).length;
      out.frames = ms.length;
      out.twoSlotFrames = out.samples.filter((s) => s.slots > 1).length;
      out.heapMB = Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6); out.cacheMB = live.stats.cacheMB; out.turns = metrics.turns;
      out.reveal = metrics.revealMs;
      out.slow = [...out.samples].sort((a, b) => b.ms - a.ms).slice(0, 12).map((s) => [+s.ms.toFixed(1), s.z, s.slots, s.holes ? 1 : 0, ...(s.parts || [])]);
      out.slowGaps = [...out.samples].sort((a, b) => b.dt - a.dt).slice(0, 6).map((s) => [Math.round(s.dt), +s.ms.toFixed(1), s.z]);
      delete out.samples;
      document.body.dataset.bench = JSON.stringify(out);
      document.body.classList.add("ready");
      done = true;
    };
    return {
      step(now) {
        if (done) return;
        if (!start) { start = now; base = { x: view.x, z: view.z, bearing: view.bearing }; lastT = now; }
        const t = (now - start) / 1000, f = Math.min(1, t / secs);
        if (lastT !== now) out.samples.push({ dt: now - lastT, ms: live.lastMs, holes: live.lastHoles, slots: live.stats.slots, z: +view.zoom.toFixed(2), parts: live.lastParts });
        lastT = now;
        if (kind === "zoom") camera.setZoom(live.zmax * (f < 0.5 ? f * 2 : 2 - f * 2));
        else if (kind === "orbit") view.bearing = norm8(base.bearing + 8 * f);
        else if (kind === "turn") {
          // three turns, each to a bearing nothing has prefetched, a few seconds apart
          if (!camera.turning && k < 3 && t > k * 4) { camera.turnBy(1); k++; }
          if (k === 3 && !camera.turning && t > 12) { finish(); return; }
          return;
        } else if (kind === "pan") {
          const zi = Math.min(3, Math.floor(f * 4)), pxm = live.ppm(view.zoom), tri = Math.abs(((t / 3) % 1) * 2 - 1) * 2 - 1;
          camera.setZoom(live.named[names[zi]]);
          view.x = base.x + (tri * Math.min(600 / pxm, 2500)); view.z = base.z + tri * Math.min(240 / pxm, 1000);
        }
        if (f >= 1) finish();
      },
    };
  }
}

main().catch(fail);
