// Serves the built pages (scripts/demo.ts styles --out <dir>) with nothing cached, and relays the play page's questions to
// Jev at POST /jev, adding the key there so the page never sees it. Run it from the repo root, where Bun loads .env:
//   bun scripts/play/serve.ts <dir> <port>
// The relay answers only a request carrying NOMADS_RELAY_TOKEN in X-Nomads-Token, shaped like the game's own questions,
// and at most RATE a minute and BUSY at once, so a public link to the page can't spend the key on anything else.
import { timingSafeEqual } from "node:crypto";
import { join, normalize } from "node:path";

const ROOT = process.argv[2] ?? "/tmp/nomads-styles", PORT = Number(process.argv[3] ?? 8197);
const KEY = process.env.TYPESAFE_API_KEY ?? "", TOKEN = process.env.NOMADS_RELAY_TOKEN ?? "";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RATE = 300, BUSY = 16, MAX_BYTES = 256_000, MAX_QUESTIONS = 16;
const NO_STORE = { "Cache-Control": "no-store" };

let busy = 0, calls = 0, tokens = 0, refused = 0;
const recent: number[] = [];
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE });

// The game asks choice, noul and score questions about a state object; anything else is not the game asking.
function shaped(body: unknown): body is { state: object; questions: Record<string, { type: string; instructions: unknown }> } {
  if (!body || typeof body !== "object") return false;
  const { state, questions } = body as { state?: unknown; questions?: unknown };
  if (!state || typeof state !== "object" || !questions || typeof questions !== "object") return false;
  const qs = Object.values(questions as Record<string, unknown>);
  return qs.length > 0 && qs.length <= MAX_QUESTIONS && qs.every((q) => !!q && typeof q === "object" && ["choice", "noul", "score"].includes((q as { type?: string }).type ?? ""));
}

async function relay(req: Request) {
  if (!KEY || !TOKEN) return reply(503, { error: "the relay has no key or token" });
  if (!same(req.headers.get("x-nomads-token") ?? "", TOKEN)) return reply(401, { error: "bad token" });
  const now = Date.now();
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= RATE || busy >= BUSY) { refused++; return reply(429, { error: "too many questions" }); }
  const text = await req.text();
  if (text.length > MAX_BYTES) return reply(413, { error: "too large" });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return reply(400, { error: "not json" }); }
  if (!shaped(body)) return reply(400, { error: "not the game's questions" });
  recent.push(now);
  busy++;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state: body.state, questions: body.questions }),
      signal: AbortSignal.timeout(20_000),
    });
    const out = await res.text();
    if (res.ok) { calls++; tokens += (JSON.parse(out) as { usage?: { input_tokens?: number } }).usage?.input_tokens ?? 0; }
    return new Response(out, { status: res.status, headers: { "Content-Type": "application/json", ...NO_STORE } });
  } catch (e) {
    return reply(502, { error: String(e) });
  } finally {
    busy--;
  }
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);
    // GET /jev: how much the relay has relayed, and whether the token the asker holds would be let through
    if (url.pathname === "/jev") return req.method === "POST" ? relay(req) : reply(200, { calls, tokens, refused, busy, ready: !!(KEY && TOKEN), ok: !!TOKEN && same(req.headers.get("x-nomads-token") ?? "", TOKEN) });
    const path = normalize(decodeURIComponent(url.pathname));
    if (path.includes("..")) return new Response("not found", { status: 404, headers: NO_STORE });
    let file = Bun.file(join(ROOT, path));
    if (path.endsWith("/") || !(await file.exists())) {
      file = Bun.file(join(ROOT, path, "index.html"));
      // a directory's page loads its scripts relative to it, so it has to be asked for with the trailing slash
      if (!path.endsWith("/") && (await file.exists())) return new Response(null, { status: 301, headers: { Location: `${path}/${url.search}`, ...NO_STORE } });
    }
    if (!(await file.exists())) return new Response("not found", { status: 404, headers: NO_STORE });
    return new Response(file, { headers: NO_STORE });
  },
});
console.log(`up ${PORT}: ${ROOT}, Jev relay ${KEY && TOKEN ? "on" : "off (no key or token)"}`);
setInterval(() => { if (calls || refused) console.log(`jev: ${calls} calls, ${tokens} input tokens, ${refused} refused`); }, 60_000);
