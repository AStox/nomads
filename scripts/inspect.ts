// Look inside the live world.  bun scripts/inspect.ts <stats|agent ID|jev [agent]|trace [sys] [agent]|laws|kinds|events [agent]|groups>
const BASE = process.env.NOMADS_URL ?? "http://127.0.0.1:8095";
const [cmd = "stats", a1, a2] = process.argv.slice(2);
const get = async (path: string): Promise<unknown> => (await fetch(`${BASE}${path}`)).json();
const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString();
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
switch (cmd) {
  case "stats": out(await get("/api/debug/stats")); break;
  case "agent": out(await get(`/api/agent/${a1}`)); break;
  case "jev": out(await get(`/api/debug/jev?${qs({ agent: a1, limit: "20" })}`)); break;
  case "trace": out(await get(`/api/debug/trace?${qs({ sys: a1, agent: a2, limit: "200" })}`)); break;
  case "laws": out(await get("/api/debug/laws")); break;
  case "kinds": out(Object.values((await get("/api/debug/kinds")) as Record<string, { made?: unknown }>).filter((k) => k.made)); break;
  case "events": for (const e of (await get(`/api/events?${qs({ agent: a1 })}`)) as { t: number; kind: string; text: string }[]) console.log(e.t, e.kind, e.text); break;
  case "groups": out(await get("/api/groups")); break;
  default: console.log("usage: stats | agent ID | jev [agent] | trace [sys] [agent] | laws | kinds | events [agent] | groups");
}
export {};
