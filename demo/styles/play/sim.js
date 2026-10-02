// Runs the game's simulation in the page the way server.ts loop() does: one tick per task, the same change sets, cleared the same way.
import { DAY, brainKind, changed, changedKinds, groupsChanged, iceChanged, inspect, inspectGround, newKinds, newWorld, objects, pathChanges, removed, thingById, tick, trailChanges, trails, useBrain } from "../sim.js";

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

// One live sim per page: the change sets are module globals inside the bundle. jev: the relay's token (scripts/play/serve.ts)
// for people to think with Jev once the world is warm; without it, and while warming, they think with the random brain.
export async function createSim({ seed = 1, warm = 0, onProgress, jev = null } = {}) {
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
  // the relay says whether it would let this token through without asking Jev anything
  const url = new URL("/jev", location.href).href;
  const ok = !!jev && (await fetch(url, { headers: { "X-Nomads-Token": jev } }).then((r) => r.json()).then((r) => r.ready && r.ok).catch(() => false));
  if (jev && !ok) console.warn("the Jev relay refused this page's token or is off; people think with the random brain");
  useBrain(ok ? { kind: "relay", url, token: jev } : { kind: "random" });
  lastEvent = w.events.at(-1)?.id ?? 0;
  remember();
  roll();

  const sim = {
    get w() { return w; },
    get alpha() { return alpha; },
    get tickMs() { return tickMs; },
    // "relay" while people think with Jev, "random" otherwise; jev: calls and tokens so far
    get brain() { return brainKind(); },
    get jev() { return w.jev; },
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
    // Fine wear where people have walked: cell meters, n cells a side, and the wear 1..255 of each worn cell by its
    // row-major index from the island's north-west corner.
    trails: () => { const t = trails(w); return { cell: t.cell, n: t.n, wear: t.wear }; },
    inspect: (id) => inspect(w, id),
    inspectGround: (px, py) => inspectGround(w, px, py),
    // the hour the page is drawn at: null follows the sim, a number pins it there (?hour=, or from the console)
    hour: null,
    clock() {
      const ft = w.t + alpha, h = sim.hour ?? ((ft % DAY) / DAY) * 24;
      return { hour: h, day: Math.floor(ft / DAY) + 1, season: w.weather.season };
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
