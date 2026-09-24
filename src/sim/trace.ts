// Everything the simulation decides is recorded here: in memory for the debug API, and as JSONL on disk.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";

export type TraceEntry = { id: number; t: number; sys: string; kind: string; agent?: string; data: unknown };
export type JevEntry = {
  id: number; t: number; agent?: string; purpose: string; ms: number; tokens: number;
  state: unknown; questions: unknown; answers?: unknown; error?: string;
};

const MAX_TRACE = 30_000, MAX_JEV = 3_000, ROTATE = 100 * 1024 * 1024;
const traceBuf: TraceEntry[] = [], jevBuf: JevEntry[] = [];
let dir: string | null = null, pending: { file: string; line: string }[] = [], nextId = 1;
export const clock = { t: 0 };
export const counters: Record<string, number> = {};
export const tickMs: Record<string, number> = {};

export function logTo(path: string | null) {
  dir = path;
  if (dir) mkdirSync(dir, { recursive: true });
}
export const count = (k: string, n = 1) => (counters[k] = (counters[k] ?? 0) + n);

export function trace(sys: string, kind: string, data: unknown, agent?: string) {
  const e: TraceEntry = { id: nextId++, t: clock.t, sys, kind, agent, data };
  traceBuf.push(e);
  if (traceBuf.length > MAX_TRACE) traceBuf.splice(0, traceBuf.length - MAX_TRACE);
  count(`${sys}.${kind}`);
  if (dir) pending.push({ file: "trace.jsonl", line: JSON.stringify(e) });
}
export function jevLog(e: Omit<JevEntry, "id" | "t">) {
  const full = { id: nextId++, t: clock.t, ...e };
  jevBuf.push(full);
  if (jevBuf.length > MAX_JEV) jevBuf.splice(0, jevBuf.length - MAX_JEV);
  if (dir) pending.push({ file: "jev.jsonl", line: JSON.stringify(full) });
}

// Rolling average cost of each system per tick.
export function timed<T>(sys: string, fn: () => T): T {
  const t0 = performance.now();
  try { return fn(); } finally { tickMs[sys] = (tickMs[sys] ?? 0) * 0.95 + (performance.now() - t0) * 0.05; }
}

export function flush() {
  if (!dir || !pending.length) return;
  const byFile: Record<string, string[]> = {};
  for (const p of pending) (byFile[p.file] ??= []).push(p.line);
  pending = [];
  for (const [file, lines] of Object.entries(byFile)) {
    const path = `${dir}/${file}`;
    if (existsSync(path) && statSync(path).size > ROTATE) renameSync(path, `${path}.1`);
    appendFileSync(path, lines.join("\n") + "\n");
  }
}

type Filter = { sys?: string; agent?: string; kind?: string; purpose?: string; limit?: number };
export function traces(f: Filter) {
  const out = traceBuf.filter((e) => (!f.sys || e.sys === f.sys) && (!f.agent || e.agent === f.agent) && (!f.kind || e.kind === f.kind));
  return out.slice(-(f.limit ?? 500));
}
export function jevCalls(f: Filter) {
  const out = jevBuf.filter((e) => (!f.agent || e.agent === f.agent) && (!f.purpose || e.purpose === f.purpose));
  return out.slice(-(f.limit ?? 200));
}
