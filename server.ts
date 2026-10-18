import { mkdirSync, renameSync } from "node:fs";
import { QUIET, VERSION, YEAR_DAYS, adoptStore, clock, heldStore, islandOf, newWorld, type World } from "./src/sim/world";
import { DAY, HOUR, TICK_S } from "./src/sim/ticks";
import { agentDetail, changedKinds, summary, tick } from "./src/sim/sim";
import { changed, newKinds, removed } from "./src/sim/physics";
import { iceChanged, pathChanges, trailChanges } from "./src/sim/ecology";
import { stageOf } from "./src/sim/world";
import { beliefText } from "./src/sim/beliefs";
import { counters, flush, hourMs, jevCalls, logTo, tickMs, traces } from "./src/sim/trace";
import { campSummary, groupsChanged, groupsDetail, liveCamps, standing } from "./src/sim/groups";
import { thingById } from "./src/sim/space";
import { thingView } from "./src/sim/inspect";
import { theGpu } from "./src/gpu/device";
import { loadStore, savedHeader } from "./src/gpu/store";
import { jevMeter } from "./src/sim/brain";

const PORT = Number(process.env.PORT ?? 8095);
// NOMADS_DATA lets a second, offline copy run beside the live world without touching its save.
const DATA = process.env.NOMADS_DATA ?? `${import.meta.dir}/data`;
const SAVE = `${DATA}/world.json`;
// The GPU's objects, every buffer of every kind (src/gpu/store.ts dump), saved beside the JSON at the same tick.
const GPU_SAVE = `${DATA}/world.gpu`;
// The pace a watcher sees, in sim seconds a wall second: 600 is the pace the world has always run at, a 300 s tick each
// 500 ms [design], and the speeds a watcher can pick are twice, four, eight and sixteen times it.
const PACE = 600, SPEEDS = [1, 2, 4, 8, 16].map((k) => k * PACE);
// A save once this long has passed on the wall clock, at the next sim hour's turn [design: 25 s is the old 50 ticks at
// the old pace].
const SAVE_MS = 25_000;
if (!process.env.TYPESAFE_API_KEY && !process.env.SUBQ_API_KEY && process.env.NOMADS_BRAIN !== "random") throw new Error("missing TYPESAFE_API_KEY or SUBQ_API_KEY");
logTo(`${DATA}/logs`);

async function load(): Promise<World> {
  const f = Bun.file(SAVE);
  if (await f.exists()) {
    const w = (await f.json()) as World;
    if (w.version === VERSION) {
      await islandOf(w.seed);
      for (const a of w.agents) {
        a.near ??= {};
        a.thinking = false;
        a.engaged = null;
        for (const s of a.plan) if (s.op === "social") s.progress = 0;
        a.plan = a.plan.filter((s) => s.op !== "tinker" || s.act);
      }
      const gpu = Bun.file(GPU_SAVE);
      if (await gpu.exists()) {
        const bytes = new Uint8Array(await gpu.arrayBuffer()), t = savedHeader(bytes).t;
        if (t === w.t) adoptStore(w, loadStore(await theGpu(), bytes));
        else console.error(`world.gpu is from tick ${t} but world.json from tick ${w.t}; the GPU's objects are not loaded`);
      }
      return w;
    }
    renameSync(SAVE, `${SAVE}.v${w.version ?? 2}.bak`);
  }
  const seed = Math.floor(Math.random() * 1e9);
  await islandOf(seed);
  return newWorld(seed);
}
const w = await load();
// The JSON, and then, when the world holds objects on the GPU, their buffers read back, each written and then moved
// into place. The JSON goes first, so it is kept even when the buffers can't be read (a save called mid-tick, by a
// signal); load only takes a world.gpu of the JSON's own tick.
async function save() {
  mkdirSync(DATA, { recursive: true });
  w.events = w.events.slice(-50_000);
  await Bun.write(`${SAVE}.tmp`, JSON.stringify(w));
  renameSync(`${SAVE}.tmp`, SAVE);
  const store = heldStore(w);
  if (!store?.kinds.length) return;
  await Bun.write(`${GPU_SAVE}.tmp`, await store.dump());
  renameSync(`${GPU_SAVE}.tmp`, GPU_SAVE);
}

const kindsById = (ids: Iterable<string>) => Object.fromEntries([...ids].filter((id) => w.kinds[id]).map((id) => [id, w.kinds[id]]));
const animalView = () => w.animals.map((a) => ({ id: a.id, species: a.species, x: a.x, y: a.y, px: a.px, py: a.py, alt: a.alt, heading: a.heading, hp: a.hp, maxHp: a.maxHp, state: a.state }));

const clients = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
const send = (c: ReadableStreamDefaultController, data: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
const control = { paused: false, speed: PACE };
let lastEvent = w.events.at(-1)?.id ?? 0;

// One tick, handed to every watcher, and the world saved when it's due.
let savedAt = performance.now();
async function step() {
  try { await tick(w); } catch (e) { console.error("tick", e); }
  const events = w.events.filter((e) => e.id > lastEvent);
  lastEvent = w.events.at(-1)?.id ?? lastEvent;
  const msg = {
    type: "tick", t: w.t, jev: w.jev, weather: w.weather, agents: w.agents.map((a) => summary(w, a)), animals: animalView(), events,
    things: [...changed].flatMap((id) => { const t = thingById(w, id); return t ? [thingView(w, t)] : []; }), removed: [...removed].filter((id) => !thingById(w, id)),
    kinds: kindsById([...newKinds, ...changedKinds]),
    paths: [...pathChanges].map((i) => ({ i, v: w.paths[i] })),
    ...(iceChanged.now ? { ice: w.ice } : {}),
    ...(groupsChanged.now ? { groups: campSummary(w) } : {}),
  };
  iceChanged.now = false; groupsChanged.now = false;
  changed.clear(); removed.clear(); newKinds.clear(); changedKinds.clear(); pathChanges.clear(); trailChanges.clear();
  for (const c of clients) send(c, msg);
  flush();
  if (w.t % HOUR === 0 && performance.now() - savedAt >= SAVE_MS) {
    savedAt = performance.now();
    try { await save(); } catch (e) { console.error("save", e); }
  }
}

// ponytail: the world only advances while someone is watching, so Jev isn't billed for an empty room.
// The ticks due by the wall clock since the pace was set (since), as many as are due, one after another, each awaited.
// Behind by more than a wall second's worth (ticks slower than the pace asks for), the clock slips: what is owed is let
// go, and the next tick is the one due now. Paused or unwatched, the clock starts again from when it goes on.
let since = performance.now(), ran = 0;
const restart = () => { since = performance.now(); ran = 0; };
async function loop() {
  if (!clients.size || control.paused) { restart(); setTimeout(loop, 100); return; }
  for (;;) {
    if (!clients.size || control.paused) break;
    const tickWall = (TICK_S * 1000) / control.speed, due = Math.floor((performance.now() - since) / tickWall);
    if (due <= ran) break;
    if (due - ran > control.speed / TICK_S) { since = performance.now() - tickWall; ran = 0; }
    ran++;
    await step();
  }
  setTimeout(loop, Math.max(0, since + ((ran + 1) * TICK_S * 1000) / control.speed - performance.now()));
}
loop();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { save().catch((e) => console.error("save", e)).finally(() => { flush(); setTimeout(() => process.exit(0), 200); }); });

function stats() {
  const things: Record<string, number> = {};
  for (const t of w.things) things[t.kind] = (things[t.kind] ?? 0) + 1;
  return {
    t: w.t, clock: clock(w.t), weather: w.weather,
    population: {
      agents: w.agents.length, children: w.agents.filter((a) => stageOf(w, a) === "child").length, elders: w.agents.filter((a) => stageOf(w, a) === "elder").length,
      dead: Object.values(w.people).filter((x) => !x.alive).length, pregnant: w.agents.filter((a) => a.pregnant).length, deer: w.animals.filter((a) => a.species === "deer").length, wolf: w.animals.filter((a) => a.species === "wolf").length },
    things, fires: things.fire ?? 0, structures: things.structure ?? 0,
    laws: Object.keys(w.laws).length, kinds: Object.keys(w.kinds).length, madeKinds: Object.values(w.kinds).filter((k) => k.made).length,
    // the meter (brain.ts jevMeter): calls a sim hour and a wall minute against the relay's 300 a minute, and latency
    jev: { calls: w.jev.calls, tokens: w.jev.tokens, cost: (w.jev.tokens * 0.042) / 1e6, rulings: w.jev.rulings, costPerDay: w.t > DAY ? ((w.jev.tokens * 0.042) / 1e6) / (w.t / DAY) : null, meter: jevMeter(w) },
    tickMs, hourMs: hourMs(), day: DAY, counters,
    agents: w.agents.map((a) => ({ id: a.id, status: a.status, goal: a.goal?.type, beliefs: Object.keys(a.beliefs).length, inv: a.inv.length, needs: a.needs, sick: !!a.sickness })),
    groups: {
      camps: liveCamps(w).map((c) => ({
        id: c.id, name: c.name, members: c.members.length, leader: c.leader, precedents: c.precedents.length,
        customs: c.customs.filter((k) => !k.faded).map((k) => k.text),
        standing: Object.fromEntries(c.members.filter((id) => standing(c, id).decided).map((id) => [id, standing(c, id)])),
      })),
      formerCamps: w.camps.length - liveCamps(w).length,
      incidents: w.incidents.length,
      judged: w.incidents.filter((i) => i.group).length,
      precedents: w.camps.reduce((t, c) => t + c.precedents.length, 0),
    },
  };
}

const json = (d: unknown) => Response.json(d);
const num = (v: string | null, d: number) => (v ? Number(v) : d);
Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname, q = url.searchParams;
    if (p === "/api/stream") {
      let ctl: ReadableStreamDefaultController;
      return new Response(new ReadableStream({
        start(c) {
          ctl = c;
          clients.add(c);
          send(c, {
            type: "init", t: w.t, day: DAY, tickS: TICK_S, pace: PACE, jev: w.jev, control, tiles: w.tiles.join(""), heights: w.heights, terrain: w.terrain, things: w.things.map((t) => thingView(w, t)),
            agents: w.agents.map((a) => summary(w, a)), animals: animalView(), events: w.events.slice(-300),
            kinds: w.kinds, weather: w.weather, paths: w.paths.join(""),
            ice: w.tiles.map((_, i) => (w.ice.includes(i) ? "1" : "0")).join(""),
            groups: campSummary(w),
          });
        },
        cancel() { clients.delete(ctl); },
      }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
    }
    if (p.startsWith("/api/agent/")) {
      const a = w.agents.find((a) => a.id === p.slice(11));
      return a ? json(agentDetail(w, a)) : new Response("not found", { status: 404 });
    }
    if (p === "/api/knowledge") {
      return json({
        kinds: w.kinds,
        laws: Object.values(w.laws),
        agents: w.agents.map((a) => ({ id: a.id, beliefs: agentDetail(w, a).beliefs })),
      });
    }
    if (p === "/api/people") return json(Object.values(w.people));
    // Everything that happened, per day: counts of every kind, and the full text of all but routine events.
    // ponytail: rebuilt from the event log on each call and capped by what save() keeps; keep daily tallies in the world if histories outgrow that.
    if (p === "/api/history") {
      const days = Math.floor(w.t / DAY) + 1;
      const counts: Record<string, number[]> = {};
      const events = [];
      for (const e of w.events) {
        (counts[e.kind] ??= new Array(days).fill(0))[Math.floor(e.t / DAY)]++;
        if (!QUIET[e.kind]) events.push({ t: e.t, kind: e.kind, who: e.who, text: e.text, ...(e.tag ? { tag: e.tag } : {}) });
      }
      return json({ t: w.t, day: DAY, days, yearDays: YEAR_DAYS, since: w.events[0]?.t ?? 0, counts, events, people: Object.values(w.people) });
    }
    if (p === "/api/groups") return json(groupsDetail(w));
    if (p === "/api/events") {
      const who = q.get("agent"), before = num(q.get("before"), Infinity);
      return json(w.events.filter((e) => e.id < before && (!who || e.who.includes(who))).slice(-200));
    }
    if (p === "/api/control" && req.method === "POST") {
      const body = (await req.json()) as Partial<typeof control>;
      if (typeof body.paused === "boolean") control.paused = body.paused;
      if (body.speed && SPEEDS.includes(body.speed) && body.speed !== control.speed) { control.speed = body.speed; restart(); }
      for (const c of clients) send(c, { type: "control", control });
      return json(control);
    }
    // Full insight: every decision, every Jev call, every physics result.
    if (p === "/api/debug/jev") return json(jevCalls({ agent: q.get("agent") ?? undefined, purpose: q.get("purpose") ?? undefined, limit: num(q.get("limit"), 200) }));
    if (p === "/api/debug/trace") return json(traces({ sys: q.get("sys") ?? undefined, agent: q.get("agent") ?? undefined, kind: q.get("kind") ?? undefined, limit: num(q.get("limit"), 500) }));
    if (p === "/api/debug/stats") return json(stats());
    if (p === "/api/debug/laws") return json(Object.values(w.laws).map((l) => ({ ...l, believers: w.agents.filter((a) => a.beliefs[l.key]).map((a) => ({ id: a.id, text: beliefText(w, a.beliefs[l.key]), spurious: a.beliefs[l.key].spurious })) })));
    if (p === "/api/debug/kinds") return json(w.kinds);
    if (p === "/api/debug/rulings") return json(w.rulings);
    if (p === "/api/debug/state") return json(w);
    const file = Bun.file(`${import.meta.dir}/public${p === "/" ? "/index.html" : p}`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(`nomads on http://127.0.0.1:${PORT}`);
