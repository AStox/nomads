import { mkdirSync, renameSync } from "node:fs";
import { DAY, QUIET, VERSION, YEAR_DAYS, clock, newWorld, type World } from "./src/sim/world";
import { agentDetail, changedKinds, summary, tick } from "./src/sim/sim";
import { changed, newKinds, removed } from "./src/sim/physics";
import { iceChanged, pathChanges } from "./src/sim/ecology";
import { stageOf } from "./src/sim/world";
import { beliefText } from "./src/sim/beliefs";
import { counters, flush, jevCalls, logTo, tickMs, traces } from "./src/sim/trace";
import { campSummary, groupsChanged, groupsDetail, liveCamps, standing } from "./src/sim/groups";

const PORT = Number(process.env.PORT ?? 8095);
// NOMADS_DATA lets a second, offline copy run beside the live world without touching its save.
const DATA = process.env.NOMADS_DATA ?? `${import.meta.dir}/data`;
const SAVE = `${DATA}/world.json`;
const BASE_MS = 500;
if (!process.env.TYPESAFE_API_KEY && process.env.NOMADS_BRAIN !== "random") throw new Error("missing TYPESAFE_API_KEY");
logTo(`${DATA}/logs`);

async function load(): Promise<World> {
  const f = Bun.file(SAVE);
  if (await f.exists()) {
    const w = (await f.json()) as World;
    if (w.version === VERSION) {
      for (const a of w.agents) {
        a.near ??= {};
        a.thinking = false;
        a.engaged = null;
        for (const s of a.plan) if (s.op === "social") s.progress = 0;
        a.plan = a.plan.filter((s) => s.op !== "tinker" || s.act);
      }
      return w;
    }
    renameSync(SAVE, `${SAVE}.v${w.version ?? 2}.bak`);
  }
  return newWorld(Math.floor(Math.random() * 1e9));
}
const w = await load();
function save() {
  mkdirSync(DATA, { recursive: true });
  w.events = w.events.slice(-50_000);
  Bun.write(`${SAVE}.tmp`, JSON.stringify(w)).then(() => renameSync(`${SAVE}.tmp`, SAVE));
}

const kindsById = (ids: Iterable<string>) => Object.fromEntries([...ids].filter((id) => w.kinds[id]).map((id) => [id, w.kinds[id]]));
const animalView = () => w.animals.map((a) => ({ id: a.id, species: a.species, x: a.x, y: a.y, hp: a.hp, maxHp: a.maxHp, state: a.state }));

const clients = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
const send = (c: ReadableStreamDefaultController, data: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
const control = { paused: false, speed: 1 };
let lastEvent = w.events.at(-1)?.id ?? 0;

// ponytail: the world only advances while someone is watching, so Jev isn't billed for an empty room.
function loop() {
  if (clients.size && !control.paused) {
    try { tick(w); } catch (e) { console.error("tick", e); }
    const events = w.events.filter((e) => e.id > lastEvent);
    lastEvent = w.events.at(-1)?.id ?? lastEvent;
    const msg = {
      type: "tick", t: w.t, jev: w.jev, weather: w.weather, agents: w.agents.map((a) => summary(w, a)), animals: animalView(), events,
      things: w.things.filter((t) => changed.has(t.id)), removed: [...removed].filter((id) => !changed.has(id) || !w.things.some((t) => t.id === id)),
      kinds: kindsById([...newKinds, ...changedKinds]),
      paths: [...pathChanges].map((i) => ({ i, v: w.paths[i] })),
      ...(iceChanged.now ? { ice: w.ice } : {}),
      ...(groupsChanged.now ? { groups: campSummary(w) } : {}),
    };
    iceChanged.now = false; groupsChanged.now = false;
    changed.clear(); removed.clear(); newKinds.clear(); changedKinds.clear(); pathChanges.clear();
    for (const c of clients) send(c, msg);
    flush();
    if (w.t % 50 === 0) save();
  }
  setTimeout(loop, BASE_MS / control.speed);
}
loop();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { save(); flush(); setTimeout(() => process.exit(0), 200); });

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
    jev: { calls: w.jev.calls, tokens: w.jev.tokens, cost: (w.jev.tokens * 0.042) / 1e6, rulings: w.jev.rulings, costPerDay: w.t > DAY ? ((w.jev.tokens * 0.042) / 1e6) / (w.t / DAY) : null },
    tickMs, counters,
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
            type: "init", t: w.t, jev: w.jev, control, tiles: w.tiles.join(""), things: w.things,
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
      return json({ t: w.t, days, yearDays: YEAR_DAYS, since: w.events[0]?.t ?? 0, counts, events, people: Object.values(w.people) });
    }
    if (p === "/api/groups") return json(groupsDetail(w));
    if (p === "/api/events") {
      const who = q.get("agent"), before = num(q.get("before"), Infinity);
      return json(w.events.filter((e) => e.id < before && (!who || e.who.includes(who))).slice(-200));
    }
    if (p === "/api/control" && req.method === "POST") {
      const body = (await req.json()) as Partial<typeof control>;
      if (typeof body.paused === "boolean") control.paused = body.paused;
      if (body.speed && [1, 2, 4, 8, 16].includes(body.speed)) control.speed = body.speed;
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
