// The live page: the game's sim running in this tab, drawn by the isopixel renderer with a pan and zoom camera.
import { createLive, loadingScreen } from "../isopixel/live.js";

const Q = new URLSearchParams(location.search);
const seed = Number(Q.get("seed") || 1), warm = Math.max(0, Number(Q.get("warm") ?? 2016) | 0), withSim = Q.get("sim") !== "0";
const canvas = document.getElementById("view"), hint = document.getElementById("hint"), statsEl = document.getElementById("stats");
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

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
  const live = await createLive({ seed, canvas, workers: Number(Q.get("workers")) || undefined, onProgress: (d, n, what) => { steps.renderer = [what, 0.5 * (what === "baking the island" ? 1 : 0) + (0.5 * d) / n]; say(); } });
  const sim = await simP;
  const ready = performance.now() - t0;
  const view = { x: -2738, z: -1838, zoom: Math.max(0, Math.min(live.zooms.length - 1, Number(Q.get("zoom") ?? 3) | 0)), selected: null };
  let follow = null, openingPerson = null, farSince = 0, farDest = null;
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
    Object.assign(view, view.zoom === 0 ? live.centreOn(0, 0, view) : live.centreOn(ox, oz, view));
    openingPerson = person.id;
  }
  let dragged = false;
  const metrics = { readyMs: Math.round(ready), revealMs: 0, tabs: [] };
  let tabWatch = null;
  const select = (id) => { view.selected = id; follow = id; farSince = 0; tabWatch = { t0: performance.now(), hole: 0, cutAt: 0, last: performance.now() }; };
  globalThis.play = globalThis.nomads = { live, sim, view, select, metrics };

  // ---------- input ----------
  const pointers = new Map();
  let drag = null, pinch = null, wheelAcc = 0;
  const zoomAt = (dz, sx, sy) => {
    const z = Math.max(0, Math.min(live.zooms.length - 1, view.zoom + dz));
    if (z === view.zoom) return;
    const before = live.toWorld(sx, sy, view);
    view.zoom = z;
    const after = live.toWorld(sx, sy, view);
    if (!follow) { view.x += before.x - after.x; view.z += before.z - after.z; }
  };
  const panBy = (dx, dy) => {
    const a = live.toWorld(canvas.width / 2, canvas.height / 2, view), b = live.toWorld(canvas.width / 2 - dx, canvas.height / 2 - dy, view);
    view.x = Math.max(-4700, Math.min(4700, view.x + b.x - a.x)); view.z = Math.max(-4700, Math.min(4700, view.z + b.z - a.z));
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: 0 };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; drag = null; }
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > pinch.d * 1.45) { zoomAt(1, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch.d = d; }
      else if (d < pinch.d / 1.45) { zoomAt(-1, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch.d = d; }
      else panBy(dx / 2, dy / 2);
      return;
    }
    if (!drag) return;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > 5) { canvas.classList.add("dragging"); follow = null; dragged = true; panBy(dx, dy); }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    canvas.classList.remove("dragging");
    if (pointers.size < 2) pinch = null;
    if (drag && drag.moved <= 5 && e.type === "pointerup") {
      const hit = live.pick(e.clientX, e.clientY, view);
      if (hit && hit.kind !== "thing") { view.selected = hit.id; follow = hit.id; }
      else { view.selected = null; follow = null; }
    }
    drag = null;
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) >= 80) { zoomAt(wheelAcc < 0 ? 1 : -1, e.clientX, e.clientY); wheelAcc = 0; }
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => zoomAt(1, e.clientX, e.clientY));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { view.selected = null; follow = null; }
    else if (e.key === "Tab" && sim?.w.agents.length) {
      e.preventDefault();
      const list = sim.w.agents, k = list.findIndex((a) => a.id === view.selected), n = list.length;
      select(list[((k < 0 ? (e.shiftKey ? 0 : -1) : k) + (e.shiftKey ? -1 : 1) + n) % n].id);
    }
    else if (e.key === " " && sim) { sim.paused = !sim.paused; e.preventDefault(); }
    else if ((e.key === "[" || e.key === "]") && sim) { const k = SPEEDS.indexOf(sim.speed); sim.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (k < 0 ? 2 : k) + (e.key === "]" ? 1 : -1)))]; }
    else if (e.key === "+" || e.key === "=") zoomAt(1, canvas.width / 2, canvas.height / 2);
    else if (e.key === "-") zoomAt(-1, canvas.width / 2, canvas.height / 2);
  });
  setTimeout(() => hint.classList.add("gone"), 7000);

  // Near targets are eased toward. A far one (a Tab to someone across the island, or a close-up follow hopping a
  // whole sim tile) is baked first while the camera holds, then cut to, so the close level never sits on a fallback.
  function followStep(now) {
    const p = live.where(follow, sim, view);
    if (!p) { follow = null; view.selected = null; live.prefetch(null); return; }
    const c = live.centreOn(p.x, p.z, view), pxm = live.zooms[view.zoom].pxPerM, far = Math.hypot(c.x - view.x, c.z - view.z) * pxm > canvas.width * 0.35;
    const next = p.dx || p.dz ? live.centreOn(p.x + p.dx, p.z + p.dz, view) : null, ahead = next ? [{ ...view, ...next, later: true }] : [];
    if (!far) {
      const k = live.zooms[view.zoom].name === "close" ? 0.3 : 0.2;
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
  let lastStats = 0, readyMarked = false;
  const bench = Q.get("bench") ? benchRunner(live, view, sim) : null;
  let revealed = !!bench;
  function loop(now) {
    // the world waits behind the loading line until the opening view is baked, so nothing is missed
    if (sim && revealed) {
      const ch = sim.update(now);
      if (ch) live.changed(ch);
    }
    if (bench) bench.step(now);
    if (follow && sim) followStep(now);
    else live.prefetch(null);
    const r = live.frame(view, sim);
    if (!revealed) {
      const rd = live.readiness(view);
      if (rd.ready && !r.holes) {
        revealed = true;
        metrics.revealMs = Math.round(performance.now() - t0);
        // follow the settlement's person only if they are in this frame
        if (openingPerson && live.picks().some((p) => p.id === openingPerson)) { view.selected = openingPerson; follow = openingPerson; }
      } else loadingScreen(canvas, `baking the view ${rd.done}/${rd.all}`, rd.done / rd.all);
    }
    if (tabWatch) {
      const dt = now - tabWatch.last;
      tabWatch.last = now;
      if (r.holes) tabWatch.hole += dt;
      if (now - tabWatch.t0 > 6000) { metrics.tabs.push({ holeMs: Math.round(tabWatch.hole), cutMs: Math.round(tabWatch.cutAt) }); tabWatch = null; }
    }
    if (!readyMarked && revealed && !bench) { readyMarked = true; document.body.dataset.firstFrame = String(Math.round(performance.now() - t0)); document.body.classList.add("ready"); }
    if (showStats && now - lastStats > 250) {
      lastStats = now;
      const s = live.stats, c = sim?.clock();
      statsEl.textContent = [
        `fps ${s.fps.toFixed(0)}  compose ${s.composeMs.toFixed(1)} ms`,
        `bake queue ${s.bakeQueue}  baked ${s.bakedChunks}  avg ${s.bakeMsAvg.toFixed(0)} ms`,
        `heap ${s.memMB} MB  chunks ${s.cacheMB ?? 0} MB  workers ${s.workers}`,
        `zoom ${live.zooms[view.zoom].name}  ready ${(ready / 1000).toFixed(1)} s  first ${s.firstFrameMs} ms`,
        sim ? `day ${c.day} ${String(Math.floor(c.hour)).padStart(2, "0")}:${String(Math.floor((c.hour % 1) * 60)).padStart(2, "0")}  x${sim.speed}${sim.paused ? " paused" : ""}  tick ${sim.tickMs.toFixed(1)} ms` : "no sim",
      ].join("\n");
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// ?bench=1: pan across each zoom for a few seconds and record frame rate and compose cost, for the report.
function benchRunner(live, view, sim) {
  const plan = [0, 1, 2, 3].map((z) => ({ z, ms: Number(new URLSearchParams(location.search).get("benchms") || 5000) }));
  const out = [];
  let k = -1, start = 0, frames = 0, compose = 0, holesF = 0, base = null, lastC = 0;
  return {
    step(now) {
      if (k === -1 || now - start > plan[k].ms) {
        if (k >= 0) out.push({ zoom: live.zooms[plan[k].z].name, fps: +((frames * 1000) / (now - start)).toFixed(1), composeMs: +(compose / Math.max(1, frames)).toFixed(2), holeFrames: holesF, baked: live.stats.bakedChunks, bakeMsAvg: +live.stats.bakeMsAvg.toFixed(0), heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6), cacheMB: live.stats.cacheMB });
        k++;
        if (k >= plan.length) {
          document.body.dataset.bench = JSON.stringify({ first: live.stats.firstFrameMs, grow: Math.round(live.stats.growMs), maps: live.stats.mapMs, workers: live.stats.workers, runs: out, bakes: live.stats.bakeLog?.slice(0, 60) });
          console.warn("BENCH " + document.body.dataset.bench);
          document.body.classList.add("ready");
          this.step = () => {};
          return;
        }
        view.zoom = plan[k].z; start = now; frames = 0; compose = 0; holesF = 0; base ??= { x: view.x, z: view.z };
      }
      // pan at 300 screen px per second, back and forth over a 1200 px stretch, so every zoom keeps meeting new chunks
      const t = (now - start) / 1000, pxm = live.zooms[view.zoom].pxPerM, tri = Math.abs(((t / 4) % 1) * 2 - 1) * 2 - 1, reach = Math.min(600 / pxm, 2500);
      view.x = base.x + tri * reach; view.z = base.z + tri * reach * 0.4;
      frames++;
      compose += live.lastMs;
      if (live.lastHoles) holesF++;
    },
  };
}

main().catch(fail);
