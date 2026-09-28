// The live page: the game's sim running in this tab, drawn by the isopixel renderer with a pan, zoom and orbit camera.
import { createLive, loadingScreen } from "../isopixel/live.js";

const Q = new URLSearchParams(location.search);
const seed = Number(Q.get("seed") || 1), warm = Math.max(0, Number(Q.get("warm") ?? 2016) | 0), withSim = Q.get("sim") !== "0";
const canvas = document.getElementById("view"), hint = document.getElementById("hint"), statsEl = document.getElementById("stats");
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8], TURN_MS = 380;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); loadingScreen(canvas, `failed: ${e?.message ?? e}`.slice(0, 90), 0); };
window.addEventListener("error", (e) => fail(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => fail(e.reason));

function fit() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
fit();
window.addEventListener("resize", fit);

async function main() {
  const t0 = performance.now();
  // one line of progress in the game's own font until the opening view is complete
  const steps = { renderer: ["growing the island", 0], sim: ["warming the world", 0] };
  const say = () => { const r = steps.renderer, w = steps.sim; loadingScreen(canvas, `${r[0]}  ${w[1] < 1 && withSim ? "/ " + w[0] : ""}`.trim(), (r[1] + (withSim ? w[1] : 1)) / 2); };
  say();
  // the sim and the renderer's workers grow the same island at the same time
  const simP = withSim ? import("./sim.js").then(({ createSim }) => createSim({ seed, warm, onProgress: (d, n) => { steps.sim = ["warming the world", d / n]; say(); } })) : Promise.resolve(null);
  const live = await createLive({ seed, canvas, workers: Number(Q.get("workers")) || undefined, adjacent: Q.get("adj") !== "0", onProgress: (d, n, what) => { steps.renderer = [what, 0.5 * (what === "baking the island" ? 1 : 0) + (0.5 * d) / n]; say(); } });
  const sim = await simP;
  const ready = performance.now() - t0;
  // ?zoom= takes a name, the old 0..3 index, or a number of zoom steps; ?bearing= 0..7
  const zq = Q.get("zoom"), names = ["island", "region", "valley", "close"];
  const zoom0 = zq == null ? live.named.close : zq in live.named ? live.named[zq] : /^[0-3]$/.test(zq) ? live.named[names[+zq]] : clamp(Number(zq) || 0, 0, live.zmax);
  const view = { x: -2738, z: -1838, zoom: zoom0, bearing: Number(Q.get("bearing") || 0) % 8, selected: null, turnTo: null };
  let follow = null, openingPerson = null, opening = null, farSince = 0, farDest = null;
  // Open on the densest cluster of shelters, fires and stumps, and follow the person nearest to it; with nothing
  // built yet, on whoever has the most going on around them.
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
    const [ox, oz] = best && bs >= 4 ? live.spotOf(best) : [-4725 + 150 * person.x, -4725 + 150 * person.y];
    opening = view.zoom < 1 ? [0, 0] : [ox, oz];
    Object.assign(view, live.centreOn(...opening, view));
    openingPerson = person.id;
  }
  let dragged = false;
  const metrics = { readyMs: Math.round(ready), revealMs: 0, tabs: [], turns: [] };
  let tabWatch = null;
  const select = (id) => { view.selected = id; follow = id; farSince = 0; tabWatch = { t0: performance.now(), hole: 0, cutAt: 0, last: performance.now() }; };

  // ---------- zoom: eased toward a goal, about the cursor ----------
  let zoomGoal = view.zoom, zoomAnchor = null;
  const zoomTo = (goal, sx, sy) => { zoomGoal = clamp(goal, 0, live.zmax); zoomAnchor = follow || sx == null ? null : [sx, sy]; };
  function zoomStep(dt) {
    if (Math.abs(zoomGoal - view.zoom) < 1e-3) { view.zoom = zoomGoal; return; }
    const [ax, ay] = zoomAnchor ?? [canvas.width / 2, canvas.height / 2], before = live.toWorld(ax, ay, view);
    view.zoom += (zoomGoal - view.zoom) * Math.min(1, dt / 90);
    const after = live.toWorld(ax, ay, view);
    if (!follow) { view.x += before.x - after.x; view.z += before.z - after.z; }
  }
  // ---------- orbit: Q and E bake the next bearing first, then turn; right-drag turns freely ----------
  let turn = null;
  const turnBy = (d) => {
    const base = turn ? turn.to : Math.round(view.bearing);
    view.turnTo = base + d;
    turn = { from: view.bearing, to: base + d, asked: performance.now(), t0: 0 };
  };
  function turnStep(now) {
    if (!turn) return;
    if (!turn.t0) {
      if (!turn.drag && !live.bearingReady(view, turn.to) && now - turn.asked < 5000) return;
      turn.t0 = now; turn.from = view.bearing;
      if (!turn.drag) metrics.turns.push(Math.round(now - turn.asked));
    }
    const p = Math.min(1, (now - turn.t0) / (turn.drag ? 220 : TURN_MS));
    view.bearing = turn.from + (turn.to - turn.from) * ease(p);
    if (p >= 1) { view.bearing = ((turn.to % 8) + 8) % 8; view.turnTo = null; turn = null; }
  }
  globalThis.play = globalThis.nomads = { live, sim, view, select, metrics, zoomTo, turnBy };

  // ---------- input ----------
  const pointers = new Map();
  let drag = null, pinch = null, orbit = null;
  const panBy = (dx, dy) => {
    const a = live.toWorld(canvas.width / 2, canvas.height / 2, view), b = live.toWorld(canvas.width / 2 - dx, canvas.height / 2 - dy, view);
    view.x = clamp(view.x + b.x - a.x, -4700, 4700); view.z = clamp(view.z + b.z - a.z, -4700, 4700);
  };
  const settle = () => { turn = { from: view.bearing, to: Math.round(view.bearing), t0: 0, drag: true, asked: performance.now() }; view.turnTo = null; };
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 2) { orbit = { x: e.clientX }; turn = null; view.turnTo = null; return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: 0 };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), a: Math.atan2(b.y - a.y, b.x - a.x) }; drag = null; turn = null; }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (orbit) { view.bearing += (orbit.x - e.clientX) / 180; orbit.x = e.clientX; return; }
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      zoomTo(zoomGoal + Math.log2(d / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      let da = ang - pinch.a;
      if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
      view.bearing -= da / (Math.PI / 4);
      pinch.d = d; pinch.a = ang;
      panBy(dx / 2, dy / 2);
      return;
    }
    if (!drag) return;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > 5) { canvas.classList.add("dragging"); follow = null; dragged = true; panBy(dx, dy); }
  });
  const up = (e) => {
    if (orbit) { orbit = null; settle(); return; }
    pointers.delete(e.pointerId);
    canvas.classList.remove("dragging");
    if (pinch && pointers.size < 2) { pinch = null; settle(); }
    if (drag && drag.moved <= 5 && e.type === "pointerup") {
      const hit = live.pick(e.clientX, e.clientY, view);
      if (hit && hit.kind !== "thing") select(hit.id);
      else { view.selected = null; follow = null; }
    }
    drag = null;
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomTo(zoomGoal - clamp(e.deltaY, -200, 200) * 0.004, e.clientX, e.clientY);
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => zoomTo(zoomGoal + 1, e.clientX, e.clientY));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { view.selected = null; follow = null; }
    else if (e.key === "Tab" && sim?.w.agents.length) {
      e.preventDefault();
      const list = sim.w.agents, k = list.findIndex((a) => a.id === view.selected), n = list.length;
      select(list[((k < 0 ? (e.shiftKey ? 0 : -1) : k) + (e.shiftKey ? -1 : 1) + n) % n].id);
    }
    else if (e.key === " " && sim) { sim.paused = !sim.paused; e.preventDefault(); }
    else if ((e.key === "[" || e.key === "]") && sim) { const k = SPEEDS.indexOf(sim.speed); sim.speed = SPEEDS[clamp((k < 0 ? 2 : k) + (e.key === "]" ? 1 : -1), 0, SPEEDS.length - 1)]; }
    else if (e.key === "+" || e.key === "=") zoomTo(Math.round(zoomGoal) + 1);
    else if (e.key === "-") zoomTo(Math.round(zoomGoal) - 1);
    else if (e.key === "q" || e.key === "Q") turnBy(-1);
    else if (e.key === "e" || e.key === "E") turnBy(1);
  });
  setTimeout(() => hint.classList.add("gone"), 8000);

  // Near targets are eased toward. A far one (a Tab to someone across the island, or a close-up follow hopping a
  // whole sim tile) is baked first while the camera holds, then cut to, so the close level never sits on a fallback.
  function followStep(now) {
    const p = live.where(follow, sim, view);
    if (!p) { follow = null; view.selected = null; live.prefetch(null); return; }
    const c = live.centreOn(p.x, p.z, view), pxm = live.ppm(view.zoom), far = Math.hypot(c.x - view.x, c.z - view.z) * pxm > canvas.width * 0.35;
    const next = p.dx || p.dz ? live.centreOn(p.x + p.dx, p.z + p.dz, view) : null, ahead = next ? [{ ...view, ...next, later: true }] : [];
    if (!far) {
      const k = live.isClose(view) ? 0.3 : 0.2;
      view.x += (c.x - view.x) * k; view.z += (c.z - view.z) * k;
      farSince = 0;
      live.prefetch(ahead);
      return;
    }
    // lock the destination when the jump starts: a walker hops on every tick, and chasing each hop would never finish
    if (!farSince) { farSince = now; farDest = { ...view, x: c.x, z: c.z }; }
    const dest = farDest;
    live.prefetch([dest, ...ahead]);
    if (live.readiness(dest).ready || now - farSince > 3000) {
      view.x = dest.x; view.z = dest.z; farSince = 0;
      if (tabWatch && !tabWatch.cutAt) tabWatch.cutAt = now - tabWatch.t0;
    }
  }

  // ---------- loop ----------
  const showStats = Q.get("stats") === "1";
  statsEl.hidden = !showStats;
  let lastStats = 0, readyMarked = false, lastNow = performance.now();
  const bench = Q.get("bench") ? benchRunner(Q.get("bench"), live, view, sim) : null;
  let revealed = false;
  function loop(now) {
    const dt = Math.min(100, now - lastNow);
    lastNow = now;
    // the world waits behind the loading line until the opening view is baked, so nothing is missed
    if (sim && revealed) {
      const ch = sim.update(now);
      if (ch) live.changed(ch);
    }
    if (revealed && bench) bench.step(now);
    zoomStep(dt);
    turnStep(now);
    if (follow && sim) followStep(now);
    else live.prefetch(null);
    const r = live.frame(view, sim);
    if (!revealed) {
      // the ground under the opening shot is only exact once its chunks are in, so keep it centred until then
      if (opening) Object.assign(view, live.centreOn(...opening, view));
      const rd = live.readiness(view);
      if (rd.ready && !r.holes) {
        revealed = true;
        metrics.revealMs = Math.round(performance.now() - t0);
        // follow the settlement's person only if they are in this frame
        if (openingPerson && !bench && live.picks().some((p) => p.id === openingPerson)) { view.selected = openingPerson; follow = openingPerson; }
      } else loadingScreen(canvas, `baking the view ${rd.done}/${rd.all}`, rd.done / rd.all);
    }
    if (tabWatch) {
      const dt2 = now - tabWatch.last;
      tabWatch.last = now;
      if (r.holes) tabWatch.hole += dt2;
      if (now - tabWatch.t0 > 6000) { metrics.tabs.push({ holeMs: Math.round(tabWatch.hole), cutMs: Math.round(tabWatch.cutAt) }); tabWatch = null; }
    }
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
  function benchRunner(kind, live, view, sim) {
    const secs = Number(Q.get("benchs") || 12), out = { kind, samples: [] };
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
        if (kind === "zoom") { view.zoom = zoomGoal = live.zmax * (f < 0.5 ? f * 2 : 2 - f * 2); }
        else if (kind === "orbit") view.bearing = base.bearing + 8 * f;
        else if (kind === "turn") {
          // three turns, each to a bearing nothing has prefetched, a few seconds apart
          if (!turn && k < 3 && t > k * 4) { turnBy(1); k++; }
          if (k === 3 && !turn && t > 12) { finish(); return; }
          return;
        } else if (kind === "pan") {
          const zi = Math.min(3, Math.floor(f * 4)), pxm = live.ppm(view.zoom), tri = Math.abs(((t / 3) % 1) * 2 - 1) * 2 - 1;
          view.zoom = zoomGoal = live.named[names[zi]];
          view.x = base.x + (tri * Math.min(600 / pxm, 2500)); view.z = base.z + tri * Math.min(240 / pxm, 1000);
        }
        if (f >= 1) finish();
      },
    };
  }
}

main().catch(fail);
