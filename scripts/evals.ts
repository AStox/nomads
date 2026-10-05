// Holding each build to the last good one. Each tier runs many seeds and keeps one set of numbers per seed, stored with
// the commit in evals/:
//   bun scripts/evals.ts probes [--seeds 10] [--days 5] [--people 6] [--brain random|jev] [--jobs N] [--against <commit>] [--dry]
//     every learning probe (scripts/probes.ts) in the world as it is and flipped: the gate for any change to the sim
//   bun scripts/evals.ts worlds [--seeds 6] [--days 60] [--jobs N] [--against <commit>] [--dry]
//     whole worlds (scripts/theories.ts) with learning as it is, off (the floor) and known from the start (the ceiling),
//     each scored against its island's answer key (scripts/truth.ts, scripts/theory-report.ts): nightly
//   bun scripts/evals.ts live [--data data] [--dry]
//     the live world's own trace and save, scored the same way: a monitor, not a gate
//   bun scripts/evals.ts trend [--tier probes|worlds|live] [--brain random|jev]
//   bun scripts/evals.ts proxy
//     whether the offline brain, which every gate runs on, finds what Jev finds
// A build is compared with the baseline, seed by seed: the latest build that clearly improved on the one before it (or
// --against a commit, run now). A number worse by more than its tolerance, with the whole 99% interval of the
// difference on the worse side, is a regression and fails the build; one better the same way is an improvement, and a
// passing build with an improvement becomes the new baseline, so the bar only rises. A claim (what learning should
// show, held over the seeds with a 95% interval) that the baseline met and this build doesn't is a regression too.
// Runs go in separate processes, from a copy of the sim and these scripts named by what's in it (data/evals/snap), so
// edits made meanwhile don't leak into later seeds and the same code, committed or not, never runs twice: each run's
// result is kept (data/evals/runs). The ledger is a file per tier run in evals/, so runs on different machines never
// conflict.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DAY } from "../src/sim/world";
import { PROBES, type Claim, type Metric, type ProbeRun } from "./probes";
import { bootstrap, mean } from "./stats";

// Bump when what a tier measures changes meaning: ledger entries of another version are never compared.
const VERSION = 1;
const ROOT = join(import.meta.dir, ".."), DATA = join(ROOT, "data/evals");
type Numbers = Record<string, number | null>;
// what a tier measured: by variant ("blame/real", "seen"...), by seed, its numbers
type Runs = Record<string, Record<string, Numbers>>;
type Entry = {
  at: string; tier: string; brain: string; commit: string; dirty: boolean; content: string; version: number;
  seeds: number[]; days: number; people?: number;
  runs: Runs; claims: Record<string, Record<string, boolean | null>>;
  against?: string; regressions: string[]; improvements: string[]; verdict: "baseline" | "pass" | "fail" | "unjudged" | "monitor"; baseline: boolean;
};
type Spec = { metrics: Record<string, Metric>; claims: Claim[] };

const argv = process.argv.slice(2);
const opt = (name: string, d: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (name: string) => argv.includes(`--${name}`);
// at most half the cores, and about a gigabyte and a quarter of memory each, half the machine's
const JOBS = Number(opt("jobs", String(Math.max(1, Math.min(Math.floor(cpus().length / 2), Math.floor(totalmem() / 2 / 1.25e9))))));
// where the ledger lives: evals/, committed with the code it judged (--ledger elsewhere for trying things out)
const LEDGER = resolve(ROOT, opt("ledger", "evals"));

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (r.exitCode) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

// ---------- snapshots and runs ----------
type Snap = { id: string; dir: string; commit: string; dirty: boolean };
// What a run depends on: the sim, and the scripts beside this one (not this one, which only orders runs, nor the play
// page's checks).
const FILES = ["src", ":(glob)scripts/*.ts", ":(exclude)scripts/evals.ts"];
function copy(from: string, files: string[], into: string) {
  for (const f of files) { mkdirSync(dirname(join(into, f)), { recursive: true }); cpSync(join(from, f), join(into, f)); }
}
const contentOf = (dir: string, files: string[]) => Bun.hash(files.map((f) => `${f}\0${readFileSync(join(dir, f), "utf8")}`).join("\0")).toString(36);
// The working tree's sim and scripts as they are now.
function snapshot(): Snap {
  const commit = git("rev-parse", "--short=10", "HEAD"), dirty = git("status", "--porcelain", "--", ...FILES) !== "";
  const files = git("ls-files", "-co", "--exclude-standard", "--", ...FILES).split("\n").filter((f) => f && existsSync(join(ROOT, f))).sort();
  const id = contentOf(ROOT, files), dir = join(DATA, "snap", id);
  if (!existsSync(dir)) copy(ROOT, files, dir);
  return { id, dir, commit, dirty };
}
// A commit's sim with this tree's scripts, to run a baseline the ledger doesn't have.
function snapshotOf(commit: string): Snap {
  const full = git("rev-parse", "--short=10", commit), tmp = join(DATA, "snap", `${full}.tmp`), tar = join(DATA, `${full}.tar`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(tar, Bun.spawnSync(["git", "archive", "--format=tar", full, "src"], { cwd: ROOT }).stdout);
  if (Bun.spawnSync(["tar", "-xf", tar, "-C", tmp]).exitCode) throw new Error(`couldn't unpack ${full}'s src`);
  rmSync(tar);
  const scripts = git("ls-files", "-co", "--exclude-standard", "--", ...FILES.slice(1)).split("\n").filter(Boolean);
  copy(ROOT, scripts, tmp);
  const src = readdirSync(join(tmp, "src"), { recursive: true }).map((f) => join("src", String(f))).filter((f) => statSync(join(tmp, f)).isFile());
  const id = contentOf(tmp, [...src, ...scripts].sort()), dir = join(DATA, "snap", id);
  if (existsSync(dir)) rmSync(tmp, { recursive: true }); else renameSync(tmp, dir);
  return { id, dir, commit: full, dirty: false };
}

// Run one of a snapshot's scripts to the end, its output in a log beside the result.
async function script(snap: Snap, name: string, args: string[], log: string, offline: boolean) {
  mkdirSync(dirname(log), { recursive: true });
  const env = { ...process.env, ...(offline ? { NOMADS_BRAIN: "random" } : {}) };
  if (!offline) delete env.NOMADS_BRAIN;
  const p = Bun.spawn([process.execPath, join(snap.dir, "scripts", name), ...args], { cwd: ROOT, env, stdout: Bun.file(log), stderr: Bun.file(`${log}.err`) });
  if (await p.exited) throw new Error(`${name} ${args.join(" ")} failed: see ${log}.err\n${readFileSync(`${log}.err`, "utf8").slice(-1500)}`);
}
async function pool<T>(tasks: (() => Promise<T>)[], jobs = JOBS): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
      if (++done % Math.max(1, Math.ceil(tasks.length / 10)) === 0 || done === tasks.length) console.error(`  ${done}/${tasks.length} runs`);
    }
  }));
  return out;
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// ---------- comparing ----------
const fmt = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? "-" : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
const values = (runs: Record<string, Numbers> | undefined, m: string) => Object.values(runs ?? {}).map((r) => r[m]).filter((x): x is number => typeof x === "number");
function claimHolds(c: Claim, runs: Record<string, Numbers> | undefined): boolean | null {
  if ("gap" in c) {
    const xs = Object.values(runs ?? {}).map((r) => (typeof r[c.gap[0]] === "number" && typeof r[c.gap[1]] === "number" ? r[c.gap[0]]! - r[c.gap[1]]! : null)).filter((x): x is number => x !== null);
    return xs.length < 2 ? null : bootstrap(xs)[0] > c.value;
  }
  const xs = values(runs, "above" in c ? c.above : c.below);
  if (xs.length < 2) return null;
  const [lo, hi] = bootstrap(xs);
  return "above" in c ? lo > c.value : hi < c.value;
}
type Row = { variant: string; metric: string; cand: number; ci: [number, number]; base?: number; diff?: number; dci?: [number, number]; mark: string };
type Comparison = { rows: Row[]; regressions: string[]; improvements: string[]; claims: Entry["claims"]; claimText: string[] };
function compare(specs: Record<string, Spec>, cand: Runs, base: Runs | undefined): Comparison {
  const rows: Row[] = [], regressions: string[] = [], improvements: string[] = [], claims: Entry["claims"] = {}, claimText: string[] = [];
  for (const [variant, spec] of Object.entries(specs)) {
    for (const [m, s] of Object.entries(spec.metrics)) {
      const xs = values(cand[variant], m);
      if (!xs.length) continue;
      const row: Row = { variant, metric: m, cand: mean(xs), ci: bootstrap(xs), mark: "" };
      const both = Object.keys(cand[variant] ?? {}).filter((seed) => typeof cand[variant][seed]?.[m] === "number" && typeof base?.[variant]?.[seed]?.[m] === "number");
      if (both.length >= 2) {
        const d = both.map((seed) => cand[variant][seed][m]! - base![variant][seed][m]!), sign = s.better === "higher" ? 1 : -1;
        row.base = mean(both.map((seed) => base![variant][seed][m]!));
        row.diff = mean(d); row.dci = bootstrap(d, 0.99);
        const [lo, hi] = row.dci, worse = sign > 0 ? hi < 0 && row.diff < -s.tol : lo > 0 && row.diff > s.tol, better = sign > 0 ? lo > 0 && row.diff > s.tol : hi < 0 && row.diff < -s.tol;
        const what = `${variant} ${m} ${fmt(row.base)} -> ${fmt(row.cand)} (${row.diff >= 0 ? "+" : ""}${fmt(row.diff)} [${fmt(lo)}, ${fmt(hi)}])`;
        if (worse) { row.mark = "worse"; regressions.push(what); }
        if (better) { row.mark = "better"; improvements.push(what); }
      }
      rows.push(row);
    }
    claims[variant] = {};
    for (const c of spec.claims) {
      const now = claimHolds(c, cand[variant]), was = base ? claimHolds(c, base[variant]) : null;
      claims[variant][c.id] = now;
      if (was === true && now === false) regressions.push(`${variant} no longer: ${c.text}`);
      claimText.push(`${variant.padEnd(20)} ${now === true ? "holds" : now === false ? (was === true ? "LOST " : "open ") : "  -  "} ${c.text}${was === false && now === true ? " (newly)" : ""}`);
    }
  }
  return { rows, regressions, improvements, claims, claimText };
}
function show(title: string, r: Comparison, against?: string) {
  console.log(`\n${title}${against ? `, against ${against}` : ", no baseline yet"}`);
  console.log(`${"".padEnd(20)} ${"metric".padEnd(12)} ${"mean".padStart(6)} ${"95% interval".padEnd(16)} ${"was".padStart(6)} ${"change".padStart(7)} ${"99% interval".padEnd(16)}`);
  let last = "";
  for (const x of r.rows) {
    const variant = x.variant === last ? "" : x.variant;
    last = x.variant;
    console.log(`${variant.padEnd(20)} ${x.metric.padEnd(12)} ${fmt(x.cand).padStart(6)} ${`[${fmt(x.ci[0])}, ${fmt(x.ci[1])}]`.padEnd(16)} ${fmt(x.base).padStart(6)} ${x.diff === undefined ? "".padStart(7) : `${x.diff >= 0 ? "+" : ""}${fmt(x.diff)}`.padStart(7)} ${(x.dci ? `[${fmt(x.dci[0])}, ${fmt(x.dci[1])}]` : "").padEnd(16)} ${x.mark}`);
  }
  console.log("\nclaims:");
  for (const line of r.claimText) console.log(`  ${line}`);
}

// ---------- the ledger ----------
const ledger = (): Entry[] => (existsSync(LEDGER) ? readdirSync(LEDGER).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(LEDGER, f), "utf8"))) : []);
function keep(e: Entry) {
  if (flag("dry")) return;
  mkdirSync(LEDGER, { recursive: true });
  writeFileSync(join(LEDGER, `${e.at.replace(/[:.]/g, "-")}-${e.tier}-${e.brain}-${e.commit}${e.dirty ? "-dirty" : ""}.json`), JSON.stringify(e) + "\n");
}
const sameKind = (e: Entry, x: Pick<Entry, "tier" | "brain" | "days" | "people">) => e.version === VERSION && e.tier === x.tier && e.brain === x.brain && e.days === x.days && e.people === x.people;
// The verdict: the first build of its kind becomes the baseline (unless it has uncommitted changes: then it's unjudged);
// after that, a regression fails, and a pass with an improvement becomes the new baseline.
function settle(entry: Omit<Entry, "verdict" | "baseline" | "regressions" | "improvements" | "claims">, r: Comparison, hadBase: boolean) {
  const verdict: Entry["verdict"] = !hadBase ? (entry.dirty ? "unjudged" : "baseline") : r.regressions.length ? "fail" : "pass";
  const baseline = !entry.dirty && (verdict === "baseline" || (verdict === "pass" && r.improvements.length > 0));
  const full: Entry = { ...entry, claims: r.claims, regressions: r.regressions, improvements: r.improvements, verdict, baseline };
  if (r.regressions.length) console.log(`\nregressions:\n${r.regressions.map((x) => `  ${x}`).join("\n")}`);
  if (r.improvements.length) console.log(`\nimprovements:\n${r.improvements.map((x) => `  ${x}`).join("\n")}`);
  console.log(`\nverdict: ${verdict}${baseline && hadBase ? " (now the baseline)" : entry.dirty && verdict === "pass" && r.improvements.length ? " (commit it and rerun to make it the baseline: the runs are kept)" : ""}`);
  keep(full);
  return full;
}
// The baseline: --against a commit, run now with this tree's scripts; else the ledger's.
async function baselineFor(kind: Pick<Entry, "tier" | "brain" | "days" | "people">, measure: (snap: Snap) => Promise<Runs>) {
  const against = opt("against", "");
  if (against) { const snap = snapshotOf(against); return { commit: snap.commit, runs: await measure(snap) }; }
  const e = ledger().filter((x) => sameKind(x, kind) && x.baseline).at(-1);
  return e ? { commit: e.commit, runs: e.runs } : null;
}

// ---------- probes ----------
async function probes() {
  const seeds = range(Number(opt("seeds", "10"))), days = Number(opt("days", "5")), people = Number(opt("people", "6")), brain = opt("brain", "random");
  if (brain !== "random" && brain !== "jev") throw new Error(`--brain ${brain}: random or jev`);
  const variants = Object.entries(PROBES).flatMap(([p, x]) => Object.keys(x.variants).map((v) => [p, v] as const));
  const specs: Record<string, Spec> = Object.fromEntries(variants.map(([p, v]) => [`${p}/${v}`, { metrics: PROBES[p].metrics, claims: PROBES[p].claims }]));
  const measure = async (snap: Snap): Promise<Runs> => {
    console.error(`probes on ${snap.id}: ${variants.length} variants x ${seeds.length} seeds, ${JOBS} at a time`);
    const tasks = variants.flatMap(([p, v]) => seeds.map((s) => async () => {
      const out = join(DATA, "runs", snap.id, "probes", `${p}-${v}-s${s}-${brain}-${days}d-${people}p.json`);
      if (!existsSync(out)) await script(snap, "probes.ts", ["--probe", p, "--variant", v, "--seed", String(s), "--days", String(days), "--people", String(people), "--brain", brain, "--out", out], out.replace(/\.json$/, ".log"), brain === "random");
      return JSON.parse(readFileSync(out, "utf8")) as ProbeRun;
    }));
    const runs: Runs = {};
    for (const r of await pool(tasks)) (runs[`${r.probe}/${r.variant}`] ??= {})[r.seed] = r.metrics;
    return runs;
  };
  const kind = { tier: "probes", brain, days, people };
  const snap = snapshot(), cand = await measure(snap), base = await baselineFor(kind, measure);
  const r = compare(specs, cand, base?.runs);
  show(`probes: ${brain} brain, seeds 1-${seeds.length}, ${days} days, ${people} people: ${snap.id}`, r, base?.commit);
  return settle({ at: new Date().toISOString(), ...kind, commit: snap.commit, dirty: snap.dirty, content: snap.id, version: VERSION, seeds, runs: cand, against: base?.commit }, r, !!base);
}

// ---------- whole worlds ----------
const KPIS: Record<string, Metric> = {
  worked: { better: "higher", tol: 0.05, text: "share of their tries (tests aside) that worked" },
  wasted: { better: "lower", tol: 0.03, text: "share of their tries made in a condition that truly hurts" },
  right: { better: "higher", tol: 0.1, text: "true theories held per person-day" },
  wrong: { better: "lower", tol: 0.1, text: "false theories held per person-day" },
  regret: { better: "lower", tol: 2, text: "ticks lost per try to a slower way they knew" },
  discovery: { better: "lower", tol: 2, text: "ticks lost per try to a faster way the world allows" },
  churn: { better: "lower", tol: 0.05, text: "share of theories formed that had been formed and dropped before" },
  coverage: { better: "higher", tol: 0.1, text: "share of tries the answer key could judge" },
};
// How much of the way from learning off to knowing from the start the real people get, for each number: 1 is as good
// as knowing, 0 no better than never learning. Higher is better whichever way the number itself runs.
const GAP: Record<string, Metric> = Object.fromEntries(["worked", "wasted", "right", "regret"].map((k) => [k, { better: "higher", tol: 0.1, text: `share of the gap closed in ${KPIS[k].text}` } satisfies Metric]));
type Kpis = { early: Numbers; late: Numbers };
async function worlds() {
  const seeds = range(Number(opt("seeds", "6"))), days = Number(opt("days", "60")), brain = "random";
  const specs: Record<string, Spec> = {
    seen: { metrics: KPIS, claims: [{ id: "learn", text: "fewer tries go to waste late than early", gap: ["wastedEarly", "wasted"], value: 0 }] },
    gap: { metrics: GAP, claims: [{ id: "closes", text: "learning closes some of the gap in wasted tries", above: "wasted", value: 0 }] },
  };
  const measure = async (snap: Snap): Promise<Runs> => {
    const at = join(DATA, "runs", snap.id, `worlds-${days}d`), file = (mode: string, s: number) => join(at, mode, `s${s}`, "run.jsonl");
    const theories = (mode: string, s: number, extra: string[] = []) => async () => {
      if (!existsSync(file(mode, s))) await script(snap, "theories.ts", ["--seed", String(s), "--days", String(days), "--learning", mode, "--out", file(mode, s), ...extra], join(at, "logs", `${mode}-${s}.log`), true);
    };
    console.error(`worlds on ${snap.id}: ${seeds.length} seeds, ${days} days, learning as it is first`);
    await pool(seeds.map((s) => theories("seen", s)));
    // every way anyone used on any island, tried on each island
    const pooled = join(at, "seen-all");
    mkdirSync(pooled, { recursive: true });
    for (const s of seeds) if (!existsSync(join(pooled, `s${s}.jsonl`))) symlinkSync(file("seen", s), join(pooled, `s${s}.jsonl`));
    const key = (s: number) => join(at, `key-s${s}.json`);
    console.error("  the answer key for each island");
    await pool(seeds.map((s) => async () => { if (!existsSync(key(s))) await script(snap, "truth.ts", ["--seed", String(s), "--runs", pooled, "--per", "8", "--out", key(s)], join(at, "logs", `truth-${s}.log`), true); }));
    console.error("  learning off, and known from the start");
    await pool(seeds.flatMap((s) => [theories("off", s), theories("known", s, ["--key", key(s)])]));
    const kpis = async (mode: string, s: number) => {
      const out = join(at, mode, `s${s}`, "report.json");
      if (!existsSync(out)) await script(snap, "theory-report.ts", [dirname(file(mode, s)), "--key", key(s), "--json", out], join(at, "logs", `report-${mode}-${s}.log`), true);
      return (JSON.parse(readFileSync(out, "utf8")) as { kpis: Kpis }).kpis;
    };
    const runs: Runs = { seen: {}, off: {}, known: {}, gap: {} };
    await pool(seeds.map((s) => async () => {
      const [seen, off, known] = [await kpis("seen", s), await kpis("off", s), await kpis("known", s)];
      runs.seen[s] = { ...seen.late, wastedEarly: seen.early.wasted };
      runs.off[s] = off.late; runs.known[s] = known.late;
      runs.gap[s] = Object.fromEntries(Object.keys(GAP).map((k) => {
        const [a, lo, hi] = [seen.late[k], off.late[k], known.late[k]];
        return [k, typeof a === "number" && typeof lo === "number" && typeof hi === "number" && Math.abs(hi - lo) > 1e-9 ? (a - lo) / (hi - lo) : null];
      }));
    }));
    return runs;
  };
  const kind = { tier: "worlds", brain, days, people: undefined };
  const snap = snapshot(), cand = await measure(snap), base = await baselineFor(kind, measure);
  const r = compare(specs, cand, base?.runs);
  show(`worlds: seeds 1-${seeds.length}, ${days} days: ${snap.id}`, r, base?.commit);
  for (const mode of ["off", "known"]) console.log(`${mode.padEnd(6)} ${Object.keys(KPIS).map((k) => `${k} ${fmt(mean(values(cand[mode], k)))}`).join("  ")}`);
  return settle({ at: new Date().toISOString(), ...kind, commit: snap.commit, dirty: snap.dirty, content: snap.id, version: VERSION, seeds, runs: cand, against: base?.commit }, r, !!base);
}

// ---------- the live world ----------
// The live server's trace (its data/logs) turned into what scripts/theories.ts writes, scored against an answer key
// for its island built from what its people did. What everyone holds each day is worked out from the theories formed,
// taught and dropped; who was alive, from who did anything that day.
async function live() {
  const data = resolve(ROOT, opt("data", "data")), snap = snapshot(), stamp = new Date().toISOString().slice(0, 10);
  const save = JSON.parse(readFileSync(join(data, "world.json"), "utf8")) as { seed: number; t: number; kinds: Record<string, { made?: unknown }>; rulings: Record<string, unknown> };
  const traces = ["trace.jsonl.1", "trace.jsonl"].map((f) => join(data, "logs", f)).filter(existsSync);
  type Trace = { t: number; sys: string; kind: string; agent?: string; data: Record<string, unknown> };
  const lines: string[] = [], held = new Map<string, Set<string>>(), active = new Map<number, Set<string>>();
  const hold = (agent: string, key: string, conds: unknown, on: boolean) => {
    const mine = held.get(agent) ?? held.set(agent, new Set()).get(agent)!;
    for (const c of Array.isArray(conds) ? conds : [conds]) if (typeof c === "string") mine[on ? "add" : "delete"](`${key}#${c}`);
  };
  let day = -1;
  const endDay = (t: number) => {
    for (const [agent, set] of held) if (active.get(day)?.has(agent)) for (const kc of set) { const [key, cond] = kc.split("#"); lines.push(JSON.stringify({ ev: "held", t, agent, key, cond })); }
    lines.push(JSON.stringify({ ev: "day", t, day: day + 1, alive: active.get(day)?.size ?? 0 }));
  };
  for (const path of traces) for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw) continue;
    const e = JSON.parse(raw) as Trace, d = Math.floor(e.t / DAY);
    if (day < 0) day = d;
    for (; day < d; day++) endDay((day + 1) * DAY);
    if (e.agent) (active.get(d) ?? active.set(d, new Set()).get(d)!).add(e.agent);
    if (e.sys === "theory" && e.agent) {
      lines.push(JSON.stringify({ ev: e.kind, t: e.t, agent: e.agent, ...e.data }));
      if (e.kind === "formed") hold(e.agent, String(e.data.key), e.data.cond, true);
      if (e.kind === "taught") hold(e.agent, String(e.data.key), e.data.conds, true);
      if (e.kind === "dropped") hold(e.agent, String(e.data.key), e.data.conds, false);
    }
    if (e.sys === "brain" && e.kind === "decided" && e.agent) {
      const odds = (e.data.odds ?? {}) as Record<string, number>, test = Object.keys(odds).find((k) => k.startsWith("test:"));
      if (test) lines.push(JSON.stringify({ ev: "test", t: e.t, agent: e.agent, goal: test, p: odds[test], chosen: e.data.chosen === test }));
    }
  }
  if (day >= 0) endDay((day + 1) * DAY);
  lines.push(JSON.stringify({ ev: "kinds", t: save.t, learning: "seen", kinds: Object.fromEntries(Object.entries(save.kinds).filter(([, k]) => k.made)), rulings: save.rulings }));
  const at = join(DATA, "live", stamp), runs = join(at, "run");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "live.jsonl"), lines.join("\n") + "\n");
  console.error(`live: ${lines.length} lines from ${traces.length} trace files, island ${save.seed}; trying its ways for the answer key`);
  await script(snap, "truth.ts", ["--seed", String(save.seed), "--runs", runs, "--per", "8", "--out", join(at, "key.json")], join(at, "truth.log"), true);
  await script(snap, "theory-report.ts", [runs, "--key", join(at, "key.json"), "--json", join(at, "report.json")], join(at, "report.log"), true);
  const k = (JSON.parse(readFileSync(join(at, "report.json"), "utf8")) as { kpis: Kpis }).kpis;
  console.log(readFileSync(join(at, "report.log"), "utf8"));
  console.log(`live, early third: ${Object.keys(KPIS).map((x) => `${x} ${fmt(k.early[x])}`).join("  ")}`);
  console.log(`live, late third:  ${Object.keys(KPIS).map((x) => `${x} ${fmt(k.late[x])}`).join("  ")}`);
  keep({ at: new Date().toISOString(), tier: "live", brain: "jev", commit: snap.commit, dirty: snap.dirty, content: snap.id, version: VERSION, seeds: [save.seed], days: Math.floor(save.t / DAY), runs: { early: { [save.seed]: k.early }, late: { [save.seed]: k.late } }, claims: {}, regressions: [], improvements: [], verdict: "monitor", baseline: false });
}

// ---------- the trend ----------
const BARS = "▁▂▃▄▅▆▇█";
const spark = (xs: (number | null)[]) => {
  const ys = xs.filter((x): x is number => x !== null), lo = Math.min(...ys), hi = Math.max(...ys);
  return xs.map((x) => (x === null ? " " : BARS[hi > lo ? Math.round(((x - lo) / (hi - lo)) * 7) : 3])).join("");
};
function trend() {
  const tier = opt("tier", "probes"), brain = opt("brain", tier === "live" ? "jev" : "random");
  const es = ledger().filter((e) => e.tier === tier && e.brain === brain && e.version === VERSION);
  if (!es.length) { console.log(`no ${tier} entries for the ${brain} brain`); return; }
  for (const e of es) console.log(`${e.at.slice(0, 16)} ${e.commit}${e.dirty ? "+" : " "} ${e.verdict.padEnd(8)}${e.baseline ? " baseline" : "         "} ${e.regressions.length} worse, ${e.improvements.length} better`);
  console.log("");
  const variants = [...new Set(es.flatMap((e) => Object.keys(e.runs)))];
  for (const v of variants) {
    const metrics = [...new Set(es.flatMap((e) => Object.values(e.runs[v] ?? {}).flatMap((r) => Object.keys(r))))];
    for (const m of metrics) {
      const xs = es.map((e) => { const ys = values(e.runs[v], m); return ys.length ? mean(ys) : null; });
      console.log(`${v.padEnd(20)} ${m.padEnd(12)} ${spark(xs)}  ${fmt(xs.at(-1))}`);
    }
  }
}

// ---------- the cheap brain against the real one ----------
// The offline brain stands in for Jev's judgment in every gate. Where a build's probes were run with both (the same days
// and people), what each found, side by side; and between the last two such builds, whether they moved the same way. If
// the offline brain calls a change better where Jev calls it worse, the cheap gate is wrong about it.
function proxy() {
  const es = ledger().filter((e) => e.tier === "probes" && e.version === VERSION);
  const pairs = es.filter((j) => j.brain === "jev").flatMap((jev) => {
    const random = es.filter((r) => r.brain === "random" && r.content === jev.content && r.days === jev.days && r.people === jev.people).at(-1);
    return random ? [{ jev, random }] : [];
  });
  if (!pairs.length) { console.log("no build has had its probes run with both brains at the same days and people: bun scripts/evals.ts probes --brain jev --seeds 2 --days D --people P, after the offline run"); return; }
  const now = pairs.at(-1)!, before = pairs.length > 1 ? pairs.at(-2) : undefined;
  console.log(`${now.jev.commit}: offline brain against Jev, ${now.jev.days} days, ${now.jev.people} people${before ? `; change since ${before.jev.commit}` : ""}`);
  for (const [probe, x] of Object.entries(PROBES)) for (const v of Object.keys(x.variants)) for (const [m, s] of Object.entries(x.metrics)) {
    const id = `${probe}/${v}`, at = (e: Entry) => mean(values(e.runs[id], m));
    const [off, jev] = [at(now.random), at(now.jev)];
    let moved = "";
    if (before) {
      const [dOff, dJev] = [off - at(before.random), jev - at(before.jev)], still = (d: number) => Math.abs(d) <= s.tol;
      moved = still(dOff) && still(dJev) ? "both steady" : Math.sign(dOff) === Math.sign(dJev) || still(dOff) || still(dJev) ? "agree" : "DISAGREE";
    }
    console.log(`${id.padEnd(20)} ${m.padEnd(12)} offline ${fmt(off).padStart(6)}  jev ${fmt(jev).padStart(6)}  ${moved}`);
  }
}

const tier = argv[0];
if (tier === "probes") process.exit((await probes()).verdict === "fail" ? 1 : 0);
else if (tier === "worlds") process.exit((await worlds()).verdict === "fail" ? 1 : 0);
else if (tier === "live") await live();
else if (tier === "trend") trend();
else if (tier === "proxy") proxy();
else console.log(readFileSync(import.meta.path, "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 18).join("\n"));
