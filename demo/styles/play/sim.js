// Runs the game's simulation in the page the way server.ts loop() does: one tick per task, the same change sets, cleared the same way.
import { DAY, changed, changedKinds, groupsChanged, iceChanged, inspect, inspectGround, newKinds, newWorld, objects, pathChanges, removed, thingById, tick, trailChanges, trails } from "../sim.js";

const BASE_MS = 500;

// The random brain answers through promise chains and a thinking agent skips its turn, so each tick waits for a fresh task.
const port = new MessageChannel(), waiting = [];
port.port1.onmessage = () => waiting.shift()();
const nextTask = () => {
  const { promise, resolve } = Promise.withResolvers();
  waiting.push(resolve);
  port.port2.postMessage(0);
  return promise;
};

function clearChanges() {
  iceChanged.now = false; groupsChanged.now = false;
  changed.clear(); removed.clear(); newKinds.clear(); changedKinds.clear(); pathChanges.clear(); trailChanges.clear();
}

// app.js nightAmount: dark 21:00 to 04:00, ramps over 19-21 and 04-06.
const nightAt = (h) => (h >= 21 || h < 4 ? 1 : h >= 19 ? (h - 19) / 2 : h < 6 ? 1 - (h - 4) / 2 : 0);

// One live sim per page: the change sets are module globals inside the bundle.
export async function createSim({ seed = 1, warm = 0, onProgress } = {}) {
  const w = newWorld(seed);
  // Where each agent and animal stood before the last tick, so a frame can draw them partway between, and who's alive now.
  const prev = new Map(), ents = new Map();
  let alpha = 0, tickMs = 0, last = null, pausedAt = null, lastIv = 0, lastEvent = 0;

  const step = () => {
    const t0 = performance.now();
    try { tick(w); } catch (e) { console.error("tick", e); }
    // The server's save() trims the chronicle like this every 50 ticks.
    if (w.t % 50 === 0 && w.events.length > 50_000) w.events = w.events.slice(-50_000);
    return t0;
  };
  const took = (t0) => {
    const ms = performance.now() - t0;
    tickMs = tickMs ? tickMs * 0.95 + ms * 0.05 : ms;
  };
  const remember = () => {
    prev.clear();
    for (const a of w.agents) prev.set(a.id, [a.px, a.py]);
    for (const a of w.animals) prev.set(a.id, [a.px, a.py]);
  };
  const roll = () => {
    ents.clear();
    for (const a of w.agents) ents.set(a.id, a);
    for (const a of w.animals) ents.set(a.id, a);
  };
  const newEvents = () => {
    let i = w.events.length;
    while (i > 0 && w.events[i - 1].id > lastEvent) i--;
    lastEvent = w.events.at(-1)?.id ?? lastEvent;
    return w.events.slice(i);
  };

  clearChanges();
  for (let i = 0; i < warm; i++) {
    took(step());
    clearChanges();
    await nextTask();
    if (onProgress && ((i + 1) % 50 === 0 || i + 1 === warm)) onProgress(i + 1, warm);
  }
  clearChanges();
  lastEvent = w.events.at(-1)?.id ?? 0;
  remember();
  roll();

  const sim = {
    get w() { return w; },
    get alpha() { return alpha; },
    get tickMs() { return tickMs; },
    speed: 1,
    paused: false,
    // Current and previous float positions in tiles; things don't move, so theirs match.
    pos(id) {
      const e = ents.get(id) ?? thingById(w, id);
      if (!e) return null;
      const p = prev.get(id);
      return { px: e.px, py: e.py, ppx: p ? p[0] : e.px, ppy: p ? p[1] : e.py };
    },
    objects: () => objects(w),
    // Fine wear where people have walked: cell meters, n cells a side, wear 0..255 row-major from the island's north-west corner.
    trails: () => { const t = trails(w); return { cell: t.cell, n: t.n, wear: t.wear }; },
    inspect: (id) => inspect(w, id),
    inspectGround: (px, py) => inspectGround(w, px, py),
    // the hour the page is drawn at: null follows the sim, a number pins it there (?hour=, or from the console)
    hour: null,
    clock() {
      const ft = w.t + alpha, h = sim.hour ?? ((ft % DAY) / DAY) * 24;
      return { hour: h, day: Math.floor(ft / DAY) + 1, season: w.weather.season, night: nightAt(h) };
    },
    // At most one tick per call: each tick needs its own task, and the server never bursts to catch up either.
    update(now) {
      if (sim.paused) { pausedAt ??= now; return null; }
      if (pausedAt !== null) { if (last !== null) last += now - pausedAt; pausedAt = null; }
      const iv = BASE_MS / sim.speed;
      if (last === null) { last = now; lastIv = iv; return null; }
      if (iv !== lastIv) { last = now - alpha * iv; lastIv = iv; }
      if (now - last < iv) { alpha = Math.max(0, (now - last) / iv); return null; }
      last = now - last < 2 * iv ? last + iv : now;
      remember();
      const t0 = step();
      roll();
      const things = [...changed].map((id) => thingById(w, id)).filter(Boolean);
      const out = {
        things,
        removed: [...removed].filter((id) => !thingById(w, id)),
        paths: [...pathChanges],
        trails: [...trailChanges],
        ice: iceChanged.now,
        groups: groupsChanged.now,
        events: newEvents(),
        kinds: newKinds.size || changedKinds.size ? [...new Set([...newKinds, ...changedKinds])].filter((id) => w.kinds[id]) : [],
      };
      clearChanges();
      took(t0);
      alpha = Math.min(1, (now - last) / iv);
      return out;
    },
  };
  return sim;
}
