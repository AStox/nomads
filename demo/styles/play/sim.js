// Runs the game's simulation in the page the way server.ts loop() does: one tick per task, the same change sets, cleared the same way.
import { DAY, changed, changedKinds, groupsChanged, iceChanged, newKinds, newWorld, pathChanges, removed, tick } from "../sim.js";

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
  changed.clear(); removed.clear(); newKinds.clear(); changedKinds.clear(); pathChanges.clear();
}

// app.js nightAmount: dark 21:00 to 04:00, ramps over 19-21 and 04-06.
const nightAt = (h) => (h >= 21 || h < 4 ? 1 : h >= 19 ? (h - 19) / 2 : h < 6 ? 1 - (h - 4) / 2 : 0);

// One live sim per page: the change sets are module globals inside the bundle.
export async function createSim({ seed = 1, warm = 0, onProgress } = {}) {
  const w = newWorld(seed);
  const pos = new Map();
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
  const track = (list) => {
    for (const a of list) {
      const p = pos.get(a.id);
      if (!p) pos.set(a.id, { x: a.x, y: a.y, px: a.x, py: a.y });
      else { p.px = p.x; p.py = p.y; p.x = a.x; p.y = a.y; }
    }
  };
  const trackAll = () => {
    track(w.agents); track(w.animals);
    if (pos.size > w.agents.length + w.animals.length) {
      const live = new Set([...w.agents, ...w.animals].map((a) => a.id));
      for (const id of pos.keys()) if (!live.has(id)) pos.delete(id);
    }
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
  trackAll();

  const sim = {
    get w() { return w; },
    get alpha() { return alpha; },
    get tickMs() { return tickMs; },
    speed: 1,
    paused: false,
    pos: (id) => pos.get(id) ?? null,
    clock() {
      const ft = w.t + alpha, h = ((ft % DAY) / DAY) * 24;
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
      const t0 = step();
      trackAll();
      const things = changed.size ? w.things.filter((t) => changed.has(t.id)) : [];
      const out = {
        things,
        removed: [...removed].filter((id) => !changed.has(id) || !things.some((t) => t.id === id)),
        paths: [...pathChanges],
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
