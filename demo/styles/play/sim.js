// Runs the game's simulation in the render worker (isopixel/worker.js), on the GPU device the island is drawn with, the
// way server.ts loop() runs it: one tick at a time, the same change sets, cleared the same way. The page thread keeps
// only what it shows (remote.js): after the ticks a frame ran the worker posts it state(), and what the page has asked
// about.
import { ACTIVITY, DAY, HOUR, TICK_S, YEAR_DAYS, census as headcount, TILE_M, activity, brainKind, changed, changedKinds, floraOf, groupsChanged, heading, iceChanged, inspect, inspectGround, newKinds, newWorld, pathChanges, removeThing, removed, resident, seedDriver, stemDriver, thingById, thingView, tick, trailChanges, trails, useBrain } from "../sim.js";

function clearChanges() {
  iceChanged.now = false; groupsChanged.now = false;
  changed.clear(); removed.clear(); newKinds.clear(); changedKinds.clear(); pathChanges.clear(); trailChanges.clear();
}

// One live sim per worker: the change sets are module globals inside the bundle. jev: the relay's token (scripts/play/serve.ts)
// for people to think with Jev once the world is warm; without it, and while warming, they think with the random brain.
// warm: sim days to run before the world is live. onWorld(w): called once the world's flora lives on the GPU, so the
// renderer can draw from its buffers and make its sprites. Returns before the world warms: the warm's ticks are the
// first ticks asked for (tick, onProgress).
export async function createSim({ seed = 1, warm = 0, onProgress, onWorld, jev = null } = {}) {
  const w = newWorld(seed);
  // as the first tick would (sim.ts tick), so the buffers are there before any tick
  if (!floraOf(w).store) await resident(w, stemDriver(w), seedDriver(w));
  await onWorld?.(w);
  let tickMs = 0, lastEvent = 0;

  const step = async () => {
    const t0 = performance.now();
    try { await tick(w); } catch (e) { console.error("tick", e); }
    // The server's save() trims the chronicle like this every 50 ticks.
    if (w.t % 50 === 0 && w.events.length > 50_000) w.events = w.events.slice(-50_000);
    return t0;
  };
  const took = (t0) => {
    const ms = performance.now() - t0;
    tickMs = tickMs ? tickMs * 0.95 + ms * 0.05 : ms;
  };
  // what each person is at, for the icon over their head, worked out once a tick
  const acts = new Map();
  const roll = () => {
    acts.clear();
    for (const a of w.agents) acts.set(a.id, activity(w, a));
  };
  // How many people and animals of each kind were alive, each sim hour from the start; past MAX samples every other one
  // is dropped and the spacing doubles, so a long run keeps its whole history in a bounded list.
  const SAMPLE = HOUR, MAX = 600, history = { every: SAMPLE, t: [], people: [], animals: {} };
  const census = () => {
    if (w.t % history.every) return;
    const n = history.t.length, count = headcount(w);
    history.t.push(w.t); history.people.push(w.agents.length);
    for (const sp of new Set([...Object.keys(history.animals), ...Object.keys(count)])) (history.animals[sp] ??= Array(n).fill(0)).push(count[sp] ?? 0);
    if (history.t.length > MAX) {
      const half = (xs) => xs.filter((_, i) => i % 2 === 0);
      history.t = half(history.t); history.people = half(history.people);
      for (const sp in history.animals) history.animals[sp] = half(history.animals[sp]);
      history.every *= 2;
    }
  };
  // Animals' paths, kept here: people's are the world's own and kept for good (src/sim/journeys.ts), but hundreds of
  // animals walking for ever would outgrow any save. A point each time one gets STRIDE meters from the last; past
  // PATH_MAX every other one is dropped, so a long life keeps its shape; the dead are let go.
  const STRIDE = 3 / TILE_M, PATH_MAX = 2000, tracks = new Map();
  const travel = () => {
    for (const a of w.animals) {
      const j = tracks.get(a.id);
      if (!j) { tracks.set(a.id, { x: [a.px], y: [a.py], t: [w.t], marks: [] }); continue; }
      const n = j.x.length - 1;
      if (Math.hypot(a.px - j.x[n], a.py - j.y[n]) < STRIDE) continue;
      j.x.push(a.px); j.y.push(a.py); j.t.push(w.t);
      if (j.x.length > PATH_MAX) for (const k of ["x", "y", "t"]) j[k] = j[k].filter((_, i) => i % 2 === 0 || i === j[k].length - 1);
    }
    if (w.t % 100 === 0) { const live = new Set(w.animals.map((a) => a.id)); for (const id of tracks.keys()) if (!live.has(id)) tracks.delete(id); }
  };
  const newEvents = () => {
    let i = w.events.length;
    while (i > 0 && w.events[i - 1].id > lastEvent) i--;
    lastEvent = w.events.at(-1)?.id ?? lastEvent;
    return w.events.slice(i);
  };

  clearChanges();
  census(); travel();
  // The warm: the first `warm` days' ticks are ticks like any other (tick), which the page asks for one at a time, each
  // its own task, as fast as its frames allow once the island is shown, people thinking with the random brain until they
  // end; then, if the relay says it would let this token through without asking Jev anything, with Jev.
  const warmTicks = Math.round(warm * DAY);
  let warmLeft = warmTicks;
  const url = new URL("/jev", location.href).href;
  const warmed = async () => {
    const ok = !!jev && (await fetch(url, { headers: { "X-Nomads-Token": jev } }).then((r) => r.json()).then((r) => r.ready && r.ok).catch(() => false));
    if (jev && !ok) console.warn("the Jev relay refused this page's token or is off; people think with the random brain");
    useBrain(ok ? { kind: "relay", url, token: jev } : { kind: "random" });
  };
  if (!warmTicks) await warmed();
  lastEvent = w.events.at(-1)?.id ?? 0;
  roll();

  // a thing's label in the world window: a shelter by its tier, an item by its kind's name, else its species or kind
  const words = (x) => String(x).replaceAll("_", " ");
  const labelOf = (t) => t.kind === "structure" ? ["pile", "lean-to", "hut", "cabin"][t.shelter?.tier ?? 0] : t.kind === "item" ? w.kinds[t.item]?.name ?? words(t.item ?? "item") : words(t.species ?? t.kind);

  return {
    w,
    activities: ACTIVITY,
    day: DAY, tickS: TICK_S, yearDays: YEAR_DAYS,
    // what the ground grew, as its objects stand on the GPU (src/gpu/flora.ts)
    flora: () => floraOf(w),
    // A thing gone from the world at once (physics.ts removeThing), as a felling or a taking makes it go: what a check
    // of the renderer does (scripts/play/objects.ts); the next tick reports it removed like any other.
    remove(id) {
      const t = thingById(w, id);
      if (!t) return false;
      removeThing(w, t);
      return true;
    },
    // a thing as the server sends it (inspect.ts thingView): its bed left out, its blaze in while it burns
    view: (t) => thingView(w, t),
    // Fine wear where people have walked: cell meters, n cells a side, and the wear 1..255 of each worn cell by its
    // row-major index from the island's north-west corner.
    trails: () => { const t = trails(w); return { cell: t.cell, n: t.n, wear: t.wear }; },
    // One tick, awaited, and what it changed (things as a client is sent them), its change sets cleared after. None
    // starts while one runs; one that fails is logged.
    async tick() {
      const t0 = await step();
      roll();
      census(); travel();
      const things = [...changed].map((id) => thingById(w, id)).filter(Boolean).map((t) => thingView(w, t));
      const done = {
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
      if (warmLeft > 0) {
        warmLeft--;
        if (onProgress && ((warmTicks - warmLeft) % 50 === 0 || !warmLeft)) onProgress(warmTicks - warmLeft, warmTicks);
        if (!warmLeft) await warmed();
      }
      return done;
    },
    // What the page draws and lists of the people and animals, sent after every tick: where each stands in tiles, what
    // people are at (sim.ts activity), the weather the light and smoke follow, the camps and who is in them.
    state() {
      return {
        // warming: the warm's ticks still to run
        t: w.t, tickMs, brain: brainKind(), warming: warmLeft,
        weather: { season: w.weather.season, sky: w.weather.sky, wind: w.weather.wind },
        agents: w.agents.map((a) => ({ id: a.id, name: a.name, status: a.status, color: a.color, born: a.born, down: a.down, goal: String(a.goal?.type ?? a.goal ?? ""), px: a.px, py: a.py, act: acts.get(a.id) ?? null })),
        // gpu: a view of an animal the GPU's store holds (an.obj), which the render worker draws from its buffer
        animals: w.animals.map((a) => ({ id: a.id, species: a.species, state: a.state, hp: a.hp, alt: a.alt, heading: a.heading, px: a.px, py: a.py, gpu: a.obj != null })),
        camps: w.camps.filter((c) => !c.gone).map((c) => ({ name: c.name, members: c.members.map((id) => ({ id, name: w.people[id]?.name ?? id })) })),
      };
    },
    // What the page shows of its selection (an id, or a point of ground { px, py }): its inspector (inspect.ts), and for
    // a thing where it stands; for a person or animal the path they have walked (world.ts Journey, a grave's the one
    // its person walked in life) and where they are walking to, in tiles.
    about(sel) {
      if (sel && typeof sel === "object") return { data: inspectGround(w, sel.px, sel.py) };
      const t = sel.startsWith("t") ? thingById(w, sel) : null, a = t ? null : w.agents.find((x) => x.id === sel);
      return {
        data: inspect(w, sel),
        pos: t ? { px: t.px, py: t.py } : null,
        mark: t ? { px: t.px, py: t.py, size: t.size, kind: t.kind, species: t.species } : null,
        journey: w.journeys?.of[t?.kind === "grave" ? t.person : sel] ?? tracks.get(sel) ?? null,
        heading: a ? heading(w, a) : null,
      };
    },
    // Things on the ground, by kind: how many of each, and of each kind in open the NEAR nearest point (px, py) in tiles.
    things({ open = [], px = 0, py = 0 } = {}, NEAR = 150) {
      const by = {};
      for (const t of w.things) if (!t.contained) (by[t.kind] ??= []).push(t);
      const out = {};
      for (const [k, list] of Object.entries(by)) {
        const rows = open.includes(k) ? list.map((t) => [t, (t.px - px) ** 2 + (t.py - py) ** 2]).sort((a, b) => a[1] - b[1]).slice(0, NEAR).map(([t]) => ({ id: t.id, label: labelOf(t), px: t.px, py: t.py })) : [];
        out[k] = { n: list.length, rows };
      }
      return out;
    },
    history: () => history,
    // Who the page opens on: the person nearest the densest cluster of shelters, fires and stumps, or with nothing
    // built yet, whoever has the most going on around them; null with no one alive.
    opening() {
      if (!w.agents.length) return null;
      const weight = (t) => (t.contained || t.inside ? 0 : t.kind === "structure" ? 2 + (t.shelter?.tier ?? 0) * 2 : t.kind === "fire" ? 4 : t.kind === "well" ? 2 : ["stump", "burnt_stump", "pit", "ash", "grave"].includes(t.kind) ? 1 : 0);
      const built = w.things.filter((t) => weight(t) > 0);
      let best = null, bs = 0;
      for (const t of built) {
        const sc = built.reduce((a, o) => a + (Math.abs(o.x - t.x) <= 2 && Math.abs(o.y - t.y) <= 2 ? weight(o) : 0), 0);
        if (sc > bs) { bs = sc; best = t; }
      }
      const busy = (a) => w.things.filter((t) => !t.contained && t.kind !== "tree" && Math.abs(t.x - a.x) <= 2 && Math.abs(t.y - a.y) <= 2).length + w.agents.filter((b) => Math.abs(b.x - a.x) <= 2 && Math.abs(b.y - a.y) <= 2).length * 4;
      const p = best ? [...w.agents].sort((p, q) => Math.hypot(p.x - best.x, p.y - best.y) - Math.hypot(q.x - best.x, q.y - best.y))[0] : [...w.agents].sort((p, q) => busy(q) - busy(p))[0];
      return { id: p.id, px: p.px, py: p.py };
    },
  };
}
