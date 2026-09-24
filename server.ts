import { mkdirSync, renameSync } from "node:fs";
import { newWorld, type Agent, type World } from "./src/sim/world";
import { dirty, tick } from "./src/sim/sim";
import { RECIPES } from "./src/sim/recipes";

const PORT = Number(process.env.PORT ?? 8095);
const SAVE = `${import.meta.dir}/data/world.json`;
const BASE_MS = 500;
if (!process.env.TYPESAFE_API_KEY) throw new Error("missing TYPESAFE_API_KEY");

async function load(): Promise<World> {
  const f = Bun.file(SAVE);
  if (!(await f.exists())) return newWorld(Math.floor(Math.random() * 1e9));
  const w = (await f.json()) as World;
  w.inventions ??= {};
  for (const a of w.agents) {
    a.know ??= {}; a.clues ??= {}; a.tried ??= {};
    a.thinking = false;
    a.engaged = null;
    for (const s of a.plan) if (s.op === "social") s.progress = 0;
  }
  return w;
}
const w = await load();
function save() {
  mkdirSync(`${import.meta.dir}/data`, { recursive: true });
  w.events = w.events.slice(-50_000);
  Bun.write(`${SAVE}.tmp`, JSON.stringify(w)).then(() => renameSync(`${SAVE}.tmp`, SAVE));
}

const summary = (a: Agent) => ({
  id: a.id, name: a.name, color: a.color, x: a.x, y: a.y, status: a.status,
  goal: a.goal?.type ?? null, target: a.goal?.target ?? null, needs: a.needs, thinking: a.thinking, down: a.down > w.t,
});

const clients = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
const send = (c: ReadableStreamDefaultController, data: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
const control = { paused: false, speed: 1 };
let lastEvent = w.events.at(-1)?.id ?? 0;

// ponytail: the world only advances while someone is watching, so Jev isn't billed for an empty room.
function loop() {
  if (clients.size && !control.paused) {
    tick(w);
    const events = w.events.filter((e) => e.id > lastEvent);
    lastEvent = w.events.at(-1)?.id ?? lastEvent;
    const msg = {
      type: "tick", t: w.t, jev: w.jev, agents: w.agents.map(summary), events,
      things: w.things.filter((t) => dirty.things.has(t.id)), removed: [...dirty.removed],
    };
    dirty.things.clear();
    dirty.removed.clear();
    for (const c of clients) send(c, msg);
    if (w.t % 50 === 0) save();
  }
  setTimeout(loop, BASE_MS / control.speed);
}
loop();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { save(); setTimeout(() => process.exit(0), 200); });

const json = (d: unknown) => Response.json(d);
Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/api/stream") {
      let ctl: ReadableStreamDefaultController;
      return new Response(new ReadableStream({
        start(c) {
          ctl = c;
          clients.add(c);
          send(c, {
            type: "init", t: w.t, jev: w.jev, control, tiles: w.tiles.join(""), things: w.things,
            agents: w.agents.map(summary), events: w.events.slice(-300),
          });
        },
        cancel() { clients.delete(ctl); },
      }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
    }
    if (p.startsWith("/api/agent/")) {
      const a = w.agents.find((a) => a.id === p.slice(11));
      if (!a) return new Response("not found", { status: 404 });
      return json({ ...a, down: a.down > w.t });
    }
    if (p === "/api/knowledge") {
      return json({
        recipes: RECIPES, inventions: w.inventions,
        agents: w.agents.map((a) => ({ id: a.id, know: a.know, clues: a.clues })),
      });
    }
    if (p === "/api/events") {
      const who = url.searchParams.get("agent");
      const before = Number(url.searchParams.get("before") ?? Infinity);
      const list = w.events.filter((e) => e.id < before && (!who || e.who.includes(who)));
      return json(list.slice(-200));
    }
    if (p === "/api/control" && req.method === "POST") {
      const body = (await req.json()) as Partial<typeof control>;
      if (typeof body.paused === "boolean") control.paused = body.paused;
      if (body.speed && [1, 2, 4, 8].includes(body.speed)) control.speed = body.speed;
      for (const c of clients) send(c, { type: "control", control });
      return json(control);
    }
    const file = Bun.file(`${import.meta.dir}/public${p === "/" ? "/index.html" : p}`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(`nomads on http://127.0.0.1:${PORT}`);
