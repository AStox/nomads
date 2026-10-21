// The planet's bake as one resumable driver: every stage of the tier-5 planet (tiers 1 to PLANET_TIER streamed, terrain, air, surplus, discharge, basin, the water as one solve or on patches, ground,
// ground tiles, pyramid, maps) run in order as separate subprocess calls of at most --budget seconds each (a GPU stage's call under `lockf /tmp/nomads-gpu.lock`, taken for the call and never
// held between calls; the CPU stages without it), each stage called again until its done marker on disk says it is done. State is the disk's, never the driver's memory: kill the driver or a child at any
// moment and run it again. Notes: docs/research/globe/2026-10-22-planet-bake-driver.md.
//   bun scripts/globe-bake-driver.ts --seed 1 --key <planet key> [--tier 5] [--budget 240] [--from <stage>] [--stop-after <stage>] [--max-calls N] [--water global|patch]
//        [--status | --dry-run] [--keep-all] [--min-free-gb 20] [--max-gb 100] [--stages-file <json>]
// Exit: 0 everything done, 1 failure (a stage with no progress in 3 calls, a missing script, a second driver, bad arguments), 2 stopped (--stop-after, --max-calls, SIGINT, SIGTERM, SIGHUP), 3 hard stop (disk).
// Files in the bake dir: bake-progress.json (per stage state, calls, seconds, tiles, peak RSS, bytes), bake.log (appended), bake-driver.lock (pid of the running driver).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BAKE, tierFile } from "../src/gpu/globe/bakedir";
import { PLANET_TIER, TILE } from "../src/gpu/globe/grid";
import { tileCount } from "../src/gpu/globe/patch";

const ROOT = resolve(import.meta.dir, "..");
const GB = 2 ** 30;
// [design: the brief's rule] a stage is given up after this many calls in a row that moved nothing
const GIVE_UP = 3;
// [design] a script gets this long after SIGTERM (a call over its time) or after the driver's own signal to release the GPU in its `finally` before SIGKILL
const KILL_AFTER_MS = 15000, KILL_AFTER_SIGNAL_MS = 20000;
// [design] the last lines of a call's output kept for the message when a stage is given up
const TAIL_LINES = 40;
// The planet's coarse stages (scripts/globe-planet.ts makes them, not the driver): its STORE, and the three records window.ts readPlanet reads [derived]. The store's path is the script's, not imported
// because that script pulls the GPU stack; bake-driver.test.ts compares it to the source.
export const PLANET_STORE = "/tmp/planet-small/store";
export const PLANET_STAGES = ["chain", "ice", "climate1"];

// ---------- the stage table's types ----------
export interface Sized { name: string; bytes?: number }
export interface Spent extends Sized { from?: string }
// What done means, read from the files of the bake dir. A name ending in `*` is a family of files (every file of the dir that starts with the rest).
export type Measure =
  | { tiles: string[]; of: number } // `<stage>-done.u8` files, a byte a tile, 1 = made (stages.ts runTiles); several are added
  | { files: Sized[] } // whole files, each there at its size
  | { count: string; ext: string; of: number; also?: string[] } // files with an extension under a directory, and these files too
  | { marker: string }; // a file the driver writes after the stage's clean exit, for a script with no marker of its own
export interface Stage {
  name: string;
  kind: "GPU" | "CPU";
  command: string[] | null; // null: the stage's script does not exist (a gap): the stage is `missing`
  tierFlag?: string; // the script that must take --tier when the tier is not the planet's (else it would make PLANET_TIER's files)
  needs: string[]; // earlier stages whose files this one reads
  inputs: string[]; // files it reads (all must exist before its first call)
  outputs: string[]; // files and directories it makes (their bytes are the stage's bytesOnDisk)
  measure: Measure;
  watch: string[]; // families whose change is progress when the measure does not move in a call (a solve's steps)
  whole: Sized[]; // outputs a script writes whole in one write: one of the wrong size is a torn write and is removed before the next call
  spent: Spent[]; // deleted once THIS stage is done: it is their last reader
  skip?: string; // why the stage is not in this bake
  external?: string[]; // files outside the bake dir that the stage reads and does not make (the planet's coarse stages in its store)
}
export interface Cfg { seed: number; key: string; tier: number; budget: number; dir: string; lock: string; water: "global" | "patch" }

// ---------- the real table ----------
const WIDTH: Record<string, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 };
export const cellsOf = (tier: number) => 6 * (TILE << tier) ** 2;
export const sizedAt = (tier: number, file: string, bytesTier = tier): Sized => { const w = WIDTH[file.slice(file.lastIndexOf(".") + 1)]; return { name: file, bytes: w ? cellsOf(bytesTier) * w : undefined }; };

export function realStages(c: Cfg): Stage[] {
  const T = c.tier, f = (n: string) => tierFile(T, n), sz = (file: string): Sized => sizedAt(T, file), tiles = tileCount(T);
  const season = (stem: string, type: string) => [0, 1, 2, 3].map((k) => f(`${stem}${k}.${type}`));
  const HEIGHT = f("height.i32"), FLOODED = f("flooded.i32"), TO = f("to.u32"), ACC = f("acc.u32");
  const terrain = [f("rock.u8"), f("drift.u8"), f("dd.u16")];
  const air = [...season("pr", "u16"), ...season("pe", "u16"), ...season("sun", "u16"), ...season("tmp", "i16"), ...season("hum", "u8"), f("snow.u8"), f("wsh.u8"), f("fog.u8"), ...season("snp", "u16")];
  const surplus = [...season("vs", "u32"), f("lakenet.i32")];
  const q = [0, 1, 2, 3].flatMap((s) => [f(`q${s}-lo.u32`), f(`q${s}-hi.u16`)]), cells = f("cells.u32"), discharge = [...q, cells];
  const BASIN = f("basin.u8");
  const waterMade = ["water.u16", "flow.u32", "qwet.u32", "base.u16", "chn.u8", "valley.u8", "pwr.u16", "stb0.u16", "stb1.u16", "stb2.u16", "stb3.u16", "dry.u16", "tab.u16", "under.u16"].map(f);
  const water = [...waterMade, f("quick.json")];
  const ground = ["tree.u8", "shr.u8", "grs.u8", "mar.u8", "bare.u8", "soil.u16", "sflag.u8", "sandy.u8", "clayey.u8", "fert.u8", "moist.u8", "sw0.u8", "sw1.u8", "sw2.u8", "sw3.u8", "ph.u8", "org.u8", "carb.u16", "nit.u16"].map(f);
  const groundIn = [HEIGHT, f("water.u16"), ...terrain, f("chn.u8"), f("valley.u8"), f("pwr.u16"), ...season("stb", "u16"), f("dry.u16"), ...season("pr", "u16"), ...season("pe", "u16"), ...season("sun", "u16"), ...season("tmp", "i16"), ...season("hum", "u8")];
  const climate = [...season("pr", "u16"), ...season("pe", "u16")];
  const groundTileIn = [HEIGHT, f("water.u16"), f("rock.u8"), f("moist.u8"), f("tree.u8"), f("shr.u8"), f("grs.u8"), f("mar.u8"), f("bare.u8"), f("sflag.u8"), f("soil.u16"), f("clayey.u8"), f("ph.u8"), f("stb3.u16"), f("tab.u16"),
    ...season("sun", "u16"), ...season("tmp", "i16"), ...season("sw", "u8"), f("pr1.u16"), f("pe1.u16"), f("wsh.u8"), f("fog.u8"), ...season("snp", "u16"), TO, f("chn.u8"), f("flow.u32"), f("base.u16"), f("under.u16")];
  const pyramidIn = [HEIGHT, f("rock.u8"), f("drift.u8"), f("dd.u16"), ...season("tmp", "i16"), ...season("pr", "u16"), f("water.u16"), f("flow.u32"), f("tree.u8"), f("shr.u8"), f("grs.u8"), f("mar.u8"), f("bare.u8"), f("soil.u16")];
  const lower = Array.from({ length: T - 1 }, (_, i): Spent => ({ ...sizedAt(T, tierFile(i + 1, "height.i32"), i + 1), from: "tiers" }));
  // 4 by 4 tiles a patch: the halo (400 cells) is shared by 16 tiles, 4.6 times faster at tier 5 and the same bytes (tier5.test.ts); a patch of 1,824 cells holds 2.1 GB
  const AIR_BLOCK = 4;
  const done = (stage: string) => ({ tiles: [`${stage}-done.u8`], of: tiles });
  const sc = (file: string, ...a: (string | number)[]) => ["bun", `scripts/${file}`, ...a.map(String)];
  const who = ["--seed", c.seed, "--key", c.key], tb = ["--tier", c.tier, "--budget", c.budget];
  const stage = (s: string, ...a: (string | number)[]) => sc("globe-stage.ts", "--stage", s, ...who, ...tb, ...a);
  const waterCmd = (s: string) => sc("globe-water.ts", "--stage", s, ...who, ...tb);
  const gFamily = `${tierFile(T, "g-")}*`, qSpent = discharge.map((n): Spent => ({ ...sz(n), from: "discharge" }));
  const waterNeeds = ["tiers", "terrain", "air", "discharge", "basin"], waterIn = [TO, FLOODED, HEIGHT, BASIN, ...discharge, ...terrain, ...climate];
  const stored = ["tiers", "terrain", "air", "global", "water"];
  const table: Stage[] = [
    { name: "tiers", kind: "GPU", command: sc("globe-tiers-stream.ts", ...who, "--last", c.tier, "--budget", c.budget), needs: [], inputs: [], external: PLANET_STAGES.map((n) => join(PLANET_STORE, `${c.seed}-${c.key}`, `${n}.bin`)),
      outputs: [...Array.from({ length: T }, (_, i) => tierFile(i + 1, "height.i32")), TO, ACC, FLOODED, ...Array.from({ length: T }, (_, i) => `t${i + 1}-run.json`), "stream-t*"],
      measure: { files: [sz(HEIGHT), sz(TO), sz(ACC), sz(FLOODED), { name: `t${T}-run.json` }] }, watch: ["stream-t*"],
      whole: [...Array.from({ length: T }, (_, i) => sizedAt(T, tierFile(i + 1, "height.i32"), i + 1)), sz(TO), sz(ACC), sz(FLOODED)], spent: [...lower, { name: "stream-t*", from: "tiers" }] },
    { name: "terrain", kind: "GPU", command: stage("terrain"), tierFlag: "scripts/globe-stage.ts", needs: ["tiers"], inputs: [HEIGHT], outputs: [...terrain, "terrain-done.u8"], measure: done("terrain"), watch: [], whole: [], spent: [] },
    { name: "air", kind: "GPU", command: stage("air", "--block", AIR_BLOCK), tierFlag: "scripts/globe-stage.ts", needs: ["tiers"], inputs: [HEIGHT, FLOODED], outputs: [...air, "air-done.u8"], measure: done("air"), watch: [], whole: [], spent: [] },
    { name: "surplus", kind: "GPU", command: waterCmd("surplus"), tierFlag: "scripts/globe-water.ts", needs: ["tiers", "air"], inputs: [HEIGHT, FLOODED, ...climate], outputs: [...surplus, "surplus-done.u8"], measure: done("surplus"), watch: [], whole: [], spent: [] },
    { name: "discharge", kind: "GPU", command: waterCmd("discharge"), tierFlag: "scripts/globe-water.ts", needs: ["tiers", "surplus"], inputs: [TO, ...season("vs", "u32")], outputs: discharge,
      measure: { files: discharge.map(sz) }, watch: [`${f("q")}*`, cells], whole: discharge.map(sz), spent: season("vs", "u32").map((n): Spent => ({ ...sz(n), from: "surplus" })) },
    { name: "basin", kind: "GPU", command: waterCmd("basin"), tierFlag: "scripts/globe-water.ts", needs: ["tiers", "surplus", "discharge"], inputs: [HEIGHT, FLOODED, TO, f("lakenet.i32"), ...discharge], outputs: [BASIN],
      measure: { files: [sz(BASIN)] }, watch: [], whole: [sz(BASIN)], spent: [{ ...sz(f("lakenet.i32")), from: "surplus" }] },
    { name: "global", kind: "GPU", command: waterCmd("global"), tierFlag: "scripts/globe-water.ts", needs: waterNeeds, inputs: waterIn, outputs: [...water, gFamily, "g-*"], measure: { tiles: ["g-final-done.u8"], of: tiles },
      watch: [gFamily, "g-*"], whole: [], spent: [...qSpent, { name: gFamily, from: "global" }], skip: c.water === "global" ? undefined : "the water is made on patches (--water patch)" },
    { name: "water", kind: "GPU", command: waterCmd("water"), tierFlag: "scripts/globe-water.ts", needs: waterNeeds, inputs: waterIn, outputs: [...water, "water-done.u8"], measure: done("water"), watch: [], whole: [], spent: qSpent,
      skip: c.water === "patch" ? undefined : "the water is made as one solve (--water global)" },
    { name: "ground", kind: "GPU", command: stage("ground"), tierFlag: "scripts/globe-stage.ts", needs: ["terrain", "air", "global", "water"], inputs: groundIn, outputs: [...ground, "ground-done.u8"], measure: done("ground"), watch: [], whole: [], spent: [] },
    { name: "groundtiles", kind: "CPU", command: sc("globe-groundtiles.ts", ...who, ...tb), tierFlag: "scripts/globe-groundtiles.ts", needs: [...stored, "ground"], inputs: groundTileIn, outputs: ["groundtiles"],
      measure: { count: "groundtiles", ext: ".gt.gz", of: tiles }, watch: [], whole: [], spent: [] },
    { name: "pyramid", kind: "CPU", command: sc("globe-pyramid.ts", ...who, ...tb), tierFlag: "scripts/globe-pyramid.ts", needs: [...stored, "ground"], inputs: pyramidIn, outputs: ["pyramid", "pyramid.json"],
      measure: { count: "pyramid", ext: ".tile.gz", of: 2 * (4 ** (T + 1) - 1), also: ["pyramid.json"] }, watch: [], whole: [], spent: [] }, // 6 4^k tiles a tier k, tiers 0 to T
    { name: "maps", kind: "CPU", command: sc("globe-maps75.ts", ...who, "--tier", c.tier), tierFlag: "scripts/globe-maps75.ts", needs: [...stored, "ground"], inputs: [HEIGHT, ACC, FLOODED], outputs: ["maps-done.json"],
      measure: { marker: "maps-done.json" }, watch: [], whole: [], spent: [] },
  ];
  return table;
}

// ---------- a stage table from a file (the tests' fake stages) ----------
// {"stages": [{"name", "kind", "command": [...], "needs", "inputs", "outputs", "measure", "watch", "whole", "spent"}]}; the strings may hold {seed} {key} {tier} {budget} {dir} {lock} {here} (the file's directory).
export function loadStages(path: string, c: Cfg): Stage[] {
  const vars: Record<string, string> = { seed: String(c.seed), key: c.key, tier: String(c.tier), budget: String(c.budget), dir: c.dir, lock: c.lock, here: dirname(resolve(path)) };
  const sub = (v: unknown): unknown => typeof v === "string" ? v.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m) : Array.isArray(v) ? v.map(sub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v;
  const raw = sub(JSON.parse(readFileSync(path, "utf8"))) as { stages: Record<string, unknown>[] };
  const sized = (v: unknown): Sized[] => (v as (string | Sized)[] ?? []).map((x) => (typeof x === "string" ? { name: x } : x));
  return raw.stages.map((s) => ({ name: s.name as string, kind: (s.kind as Stage["kind"]) ?? "CPU", command: (s.command as string[] | undefined) ?? null, needs: (s.needs as string[]) ?? [], inputs: (s.inputs as string[]) ?? [], outputs: (s.outputs as string[]) ?? [],
    measure: s.measure as Measure, watch: (s.watch as string[]) ?? [], whole: sized(s.whole), spent: sized(s.spent), skip: s.skip as string | undefined, external: s.external as string[] | undefined }));
}

// ---------- reading the disk ----------
const SAFE = /^[A-Za-z0-9._-]+\*?$/;
// The files of the dir a name stands for: itself if it is there, or a family's members.
export function expand(dir: string, name: string): string[] {
  if (!SAFE.test(name) || name === "." || name === "..") throw new Error(`bad file name in a stage's table: ${name}`);
  if (!name.endsWith("*")) return existsSync(join(dir, name)) ? [name] : [];
  const prefix = name.slice(0, -1);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(prefix)).sort() : [];
}
const sizeOf = (path: string) => { try { return statSync(path).size; } catch { return -1; } };
export function diskBytes(path: string): number {
  let st; try { st = lstatSync(path); } catch { return 0; }
  if (!st.isDirectory()) return st.blocks * 512;
  return readdirSync(path).reduce((a, n) => a + diskBytes(join(path, n)), st.blocks * 512);
}
function countFiles(path: string, ext: string): number {
  let n = 0;
  if (!existsSync(path)) return 0;
  for (const e of readdirSync(path, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(path, e.name), ext) : e.name.endsWith(ext) ? 1 : 0;
  return n;
}
export interface Have { have: number; of: number; done: boolean }
export function measure(dir: string, m: Measure): Have {
  if ("tiles" in m) {
    let have = 0;
    for (const f of m.tiles) { try { for (const b of readFileSync(join(dir, f))) if (b === 1) have++; } catch { /* not made yet */ } }
    return { have, of: m.of, done: have === m.of };
  }
  if ("files" in m) {
    const have = m.files.filter((x) => (x.bytes === undefined ? existsSync(join(dir, x.name)) : sizeOf(join(dir, x.name)) === x.bytes)).length;
    return { have, of: m.files.length, done: have === m.files.length };
  }
  if ("count" in m) {
    const have = countFiles(join(dir, m.count), m.ext);
    return { have, of: m.of, done: have === m.of && (m.also ?? []).every((x) => existsSync(join(dir, x))) };
  }
  const have = existsSync(join(dir, m.marker)) ? 1 : 0;
  return { have, of: 1, done: have === 1 };
}
// What a call that moves nothing in the measure can still have moved: the files of the stage's watched families (a name, size and time each, one directory deep).
export function signature(dir: string, st: Stage): string {
  const parts = [String(measure(dir, st.measure).have)];
  for (const w of st.watch) for (const name of expand(dir, w)) {
    const p = join(dir, name), s = lstatSync(p);
    parts.push(`${name}:${s.size}:${s.mtimeMs}`);
    if (s.isDirectory()) for (const e of readdirSync(p)) { const t = lstatSync(join(p, e)); parts.push(`${name}/${e}:${t.size}:${t.mtimeMs}`); }
  }
  return parts.join("|");
}
export type State = "pending" | "partial" | "running" | "done" | "skipped" | "missing" | "blocked" | "failed";
export interface Eval { stage: Stage; have: Have; own: boolean; done: boolean; implied: boolean }
// A stage is done if its own files say so, or if a stage that reads its files is done (its spent files may be gone by then).
export function evaluate(stages: Stage[], dir: string): Eval[] {
  const live = stages.filter((s) => !s.skip), out = new Map<string, Eval>();
  for (const s of live) { const have = measure(dir, s.measure); out.set(s.name, { stage: s, have, own: have.done, done: have.done, implied: false }); }
  for (const s of [...live].reverse()) {
    const e = out.get(s.name)!;
    if (!e.done && live.some((d) => d.needs.includes(s.name) && out.get(d.name)!.done)) { e.done = true; e.implied = true; }
  }
  return stages.map((s) => out.get(s.name) ?? { stage: s, have: { have: 0, of: 0, done: false }, own: false, done: false, implied: false });
}

// ---------- the guards ----------
export function freeGB(path: string): number {
  let p = path; while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const r = spawnSync("df", ["-k", p], { encoding: "utf8" });
  const row = r.stdout.trim().split("\n").pop()!.split(/\s+/);
  return Number(row[3]) * 1024 / GB;
}
export function usedGB(path: string): number {
  if (!existsSync(path)) return 0;
  return Number(spawnSync("du", ["-sk", path], { encoding: "utf8" }).stdout.split(/\s/)[0]) * 1024 / GB;
}
// A script that does not take --tier makes the planet's finest tier whatever it is asked: refuse it for any other tier.
export const takesTier = (source: string) => /arg\(\s*["']tier["']/.test(source);

// ---------- the driver lock ----------
export interface LockInfo { pid: number; started: string; stage: string | null; command: string | null }
export const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  return spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout.includes("globe-bake-driver"); // a reused pid is not a driver
};
const readLock = (path: string): LockInfo | null => { try { return JSON.parse(readFileSync(path, "utf8")) as LockInfo; } catch { return null; } };
// Take the lock by a hard link (atomic). A lock whose driver is dead is moved aside and replaced; `stale` is what it said.
export function acquireLock(path: string, info: LockInfo): { ok: true; stale: LockInfo | null } | { ok: false; holder: LockInfo | null } {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info));
  let stale: LockInfo | null = null;
  try {
    for (let attempt = 0; attempt < 4; attempt++) { // [design] link, or move a dead driver's lock aside and link again; a lock that changes hands under us at most a few times
      try { linkSync(tmp, path); return { ok: true, stale }; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      const holder = readLock(path);
      if (holder && alive(holder.pid)) return { ok: false, holder };
      const aside = `${path}.stale-${process.pid}`;
      try { renameSync(path, aside); } catch { continue; }
      const moved = readLock(aside);
      if (holder && moved && moved.pid !== holder.pid) { try { linkSync(aside, path); } catch { /* the lock moved again: the next attempt sees it */ } unlinkSync(aside); return { ok: false, holder: moved }; }
      stale = moved ?? holder; unlinkSync(aside);
    }
    return { ok: false, holder: readLock(path) };
  } finally { rmSync(tmp, { force: true }); }
}
const writeLock = (path: string, info: LockInfo) => { const tmp = `${path}.${process.pid}.upd`; writeFileSync(tmp, JSON.stringify(info)); renameSync(tmp, path); };
const releaseLock = (path: string) => { if (readLock(path)?.pid === process.pid) rmSync(path, { force: true }); };
// Processes still running a command line (a dead driver's child: it holds the stage's files until its call ends).
export function procsRunning(command: string): number[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
  return r.stdout.split("\n").flatMap((l) => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return m && Number(m[1]) !== process.pid && m[2].includes(command) ? [Number(m[1])] : []; });
}

// ---------- progress ----------
export interface StageProgress { state: State; calls: number; seconds: number; lockWaitS: number; tilesDone: number; tilesOf: number; peakRssGB: number; bytesOnDisk: number }
export interface Progress { version: 1; seed: number; key: string; tier: number; updated: string; driver: { pid: number; stage: string | null } | null; stages: Record<string, StageProgress> }
const blank = (): StageProgress => ({ state: "pending", calls: 0, seconds: 0, lockWaitS: 0, tilesDone: 0, tilesOf: 0, peakRssGB: 0, bytesOnDisk: 0 });
const CALL_END = /\[(\S+)\] call-end .*seconds=([\d.]+) wait=([\d.]+) rss=([\d.]+)/;
// The calls, seconds and peak memory of each stage from the log's call-end lines: what is left of a progress file that is gone or torn.
export function fromLog(logPath: string): Record<string, StageProgress> {
  const out: Record<string, StageProgress> = {};
  if (!existsSync(logPath)) return out;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const m = CALL_END.exec(line);
    if (!m) continue;
    const p = (out[m[1]] ??= blank());
    p.calls++; p.seconds += Number(m[2]); p.lockWaitS += Number(m[3]); p.peakRssGB = Math.max(p.peakRssGB, Number(m[4]));
  }
  return out;
}
export function readProgress(dir: string, c: Cfg): Progress {
  const path = join(dir, "bake-progress.json");
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Progress;
    if (p.version === 1 && p.seed === c.seed && p.key === c.key && p.tier === c.tier && p.stages) return p;
  } catch { /* absent or torn: rebuilt below */ }
  return { version: 1, seed: c.seed, key: c.key, tier: c.tier, updated: new Date().toISOString(), driver: null, stages: fromLog(join(dir, "bake.log")) };
}
export function writeProgress(dir: string, p: Progress) {
  p.updated = new Date().toISOString();
  const path = join(dir, "bake-progress.json"), tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 1));
  renameSync(tmp, path);
}
const gb = (b: number) => (b / GB).toFixed(b >= 10 * GB ? 1 : 2);
// The bytes the stage's outputs hold on disk now (a stage not in this bake holds none of its own: the water's two routes share their files).
const outputBytes = (s: Stage, dir: string) => (s.skip ? 0 : s.outputs.reduce((a, o) => a + expand(dir, o).reduce((b, n) => b + diskBytes(join(dir, n)), 0), 0));
const stateOf = (e: Eval, running: string | null, missingScript: boolean): State =>
  e.stage.skip ? "skipped" : e.done ? "done" : running === e.stage.name ? "running" : missingScript ? "missing" : e.have.have > 0 ? "partial" : "pending";
// The table `--status` prints; the progress file's calls, seconds and memory with the disk's state, tiles and bytes.
export function statusTable(stages: Stage[], dir: string, p: Progress, running: string | null): string {
  const rows = [["stage", "kind", "state", "tiles", "calls", "seconds", "peak RSS GB", "GB"]], evals = evaluate(stages, dir);
  let total = 0;
  for (const e of evals) {
    const s = e.stage, g = p.stages[s.name] ?? blank(), bytes = outputBytes(s, dir);
    total += bytes;
    rows.push([s.name, s.kind, s.skip ? "skipped" : stateOf(e, running, s.command === null) + (e.implied ? "*" : ""), s.skip ? "-" : `${e.have.have}/${e.have.of}`, String(g.calls), g.seconds.toFixed(0), g.peakRssGB.toFixed(2), gb(bytes)]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return [...rows.map((r) => r.map((x, i) => (i < 3 ? x.padEnd(w[i]) : x.padStart(w[i]))).join("  ")), `total ${gb(total)} GB in the stages' outputs${evals.some((e) => e.implied) ? "; * done because a later stage that reads it is" : ""}`].join("\n");
}

// ---------- the options ----------
export interface Opts {
  seed: number; key: string; tier: number; budget: number; stopAfter?: string; from?: string; maxCalls: number; stagesFile?: string; water: "global" | "patch"; status: boolean; dryRun: boolean; keepAll: boolean;
  minFreeGB: number; maxGB: number; grace: number; sampleMs: number; lockFile: string;
}
const VALUES = ["seed", "key", "tier", "budget", "stop-after", "from", "max-calls", "stages-file", "water", "min-free-gb", "max-gb", "grace", "sample-ms", "lock-file"];
const FLAGS = ["status", "dry-run", "keep-all", "help"];
export function parseOpts(argv: string[], env: Record<string, string | undefined> = process.env): Opts {
  const v = new Map<string, string>(), f = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const n = a.slice(2);
    if (FLAGS.includes(n)) f.add(n);
    else if (VALUES.includes(n)) { if (i + 1 >= argv.length) throw new Error(`--${n} needs a value`); v.set(n, argv[++i]); } else throw new Error(`unknown option ${a}`);
  }
  const num = (n: string, d: number) => { const x = Number(v.get(n) ?? d); if (Number.isNaN(x) || x < 0) throw new Error(`--${n} is not a number`); return x; };
  if (f.has("help")) throw new Error("");
  const key = v.get("key") ?? env.NOMADS_PLANET_KEY ?? "";
  if (!key) throw new Error("name the planet's key: --key <hash> (the bake dir is <seed>-<key> under the bake root)");
  const water = v.get("water") ?? "global";
  if (water !== "global" && water !== "patch") throw new Error("--water is global or patch");
  return {
    seed: num("seed", 1), key, tier: num("tier", PLANET_TIER), budget: num("budget", 240), stopAfter: v.get("stop-after"), from: v.get("from"), maxCalls: num("max-calls", Infinity), stagesFile: v.get("stages-file") ?? env.NOMADS_BAKE_STAGES,
    water, status: f.has("status"), dryRun: f.has("dry-run"), keepAll: f.has("keep-all"),
    // [design: the operator's rules: 20 GB free on the volume, 100 GB under the bake root; a call under 5 minutes is the budget 240 and 45 s of grace; ps every 2 s]
    minFreeGB: num("min-free-gb", 20), maxGB: num("max-gb", 100), grace: num("grace", 45), sampleMs: num("sample-ms", 2000), lockFile: v.get("lock-file") ?? "/tmp/nomads-gpu.lock",
  };
}
const USAGE = "usage: bun scripts/globe-bake-driver.ts --seed 1 --key <key> [--tier 5] [--budget 240] [--from <stage>] [--stop-after <stage>] [--max-calls N] [--water global|patch] [--status | --dry-run] [--keep-all]\n"
  + "       [--min-free-gb 20] [--max-gb 100] [--grace 45] [--sample-ms 2000] [--lock-file /tmp/nomads-gpu.lock] [--stages-file <json> (or NOMADS_BAKE_STAGES)]   (GB = 2^30 bytes)";

export function tableOf(o: Opts): { cfg: Cfg; stages: Stage[] } {
  const cfg: Cfg = { seed: o.seed, key: o.key, tier: o.tier, budget: o.budget, dir: join(BAKE, `${o.seed}-${o.key}`), lock: o.lockFile, water: o.water };
  const stages = o.stagesFile ? loadStages(o.stagesFile, cfg) : realStages(cfg);
  const seen = new Set<string>();
  for (const s of stages) {
    if (seen.has(s.name)) throw new Error(`stage ${s.name} twice in the table`);
    for (const n of s.needs) if (!seen.has(n)) throw new Error(`stage ${s.name} needs ${n}, which is not an earlier stage`);
    seen.add(s.name);
  }
  for (const n of [o.from, o.stopAfter]) if (n && !seen.has(n)) throw new Error(`no stage ${n}: ${stages.map((s) => s.name).join(", ")}`);
  return { cfg, stages };
}
export const commandLine = (st: Stage, c: Cfg) => { const argv = st.command!.map((a, i) => (i === 0 && a === "bun" ? process.execPath : a)); return st.kind === "GPU" ? ["lockf", c.lock, ...argv] : argv; };

// ---------- the dry run ----------
export function describePlan(stages: Stage[], c: Cfg, o: Opts): string {
  const evals = evaluate(stages, c.dir), out: string[] = [`bake ${c.dir}: tier ${c.tier}, ${tileCount(c.tier)} tiles, budget ${c.budget} s a call (+${o.grace} s grace), floor ${o.minFreeGB} GB free, hard stop ${o.maxGB} GB under ${BAKE}`, ""];
  for (const e of evals) {
    const s = e.stage;
    out.push(`${s.name} (${s.kind}) ${s.skip ? `skipped: ${s.skip}` : `${e.done ? `done${e.implied ? "*" : ""}` : `${e.have.have}/${e.have.of}`}`}${s.needs.length ? `; reads the files of ${s.needs.join(", ")}` : ""}`);
    if (s.external?.length) out.push(`  reads the planet's coarse stages in ${dirname(s.external[0])}: ${s.external.every((f) => existsSync(f)) ? "there" : `MISSING ${s.external.filter((f) => !existsSync(f)).map((f) => f.split("/").pop()).join(", ")}`}`);
    if (s.skip) continue;
    out.push(s.command ? `  $ ${commandLine(s, c).map((a) => a.replace(ROOT, ".")).join(" ").replace(process.execPath, "bun")}` : "  no script: a gap (the stage is `missing`)");
    if (s.command && s.tierFlag && c.tier !== PLANET_TIER && !takesTier(readFileSync(join(ROOT, s.tierFlag), "utf8"))) out.push(`  BLOCKED at tier ${c.tier}: ${s.tierFlag} does not take --tier`);
    if (s.spent.length) out.push(`  spent once done: ${s.spent.map((x) => `${x.name}${x.bytes ? ` ${gb(x.bytes)} GB` : ""}`).join(", ")}${o.keepAll ? " (kept: --keep-all)" : ""}`);
  }
  return out.join("\n");
}

// ---------- the run ----------
interface CallResult { code: number | null; signal: string | null; seconds: number; wait: number; rss: number; timedOut: boolean; tail: string[] }
class Run {
  private logPath: string;
  stopping = false;
  calls = 0;
  progress: Progress;
  interrupt: ((sig: NodeJS.Signals) => void) | null = null;
  started = new Date().toISOString();
  constructor(readonly o: Opts, readonly c: Cfg, readonly stages: Stage[]) {
    this.logPath = join(c.dir, "bake.log");
    this.progress = readProgress(c.dir, c);
  }
  log(stage: string | null, msg: string) {
    const line = `${new Date().toISOString()} [${stage ?? "driver"}] ${msg}`;
    appendFileSync(this.logPath, `${line}\n`);
    console.log(line);
  }
  stat(name: string) { return (this.progress.stages[name] ??= blank()); }
  save(running: string | null) {
    for (const e of evaluate(this.stages, this.c.dir)) {
      const s = this.stat(e.stage.name), fresh = e.stage.skip ? "skipped" : e.done ? "done" : stateOf(e, running, e.stage.command === null);
      // a stop's reason (failed, blocked) stays until the stage runs again; everything else is what the disk says
      s.state = !e.done && !e.stage.skip && running !== e.stage.name && (s.state === "failed" || s.state === "blocked") ? s.state : fresh;
      s.tilesDone = e.have.have; s.tilesOf = e.have.of;
      s.bytesOnDisk = outputBytes(e.stage, this.c.dir);
    }
    this.progress.driver = { pid: process.pid, stage: running };
    writeProgress(this.c.dir, this.progress);
  }
  guard(stage: string): number {
    const free = freeGB(this.c.dir), used = usedGB(BAKE);
    if (free < this.o.minFreeGB) { this.log(stage, `HARD STOP: ${free.toFixed(1)} GB free on the volume of ${BAKE}, under the floor of ${this.o.minFreeGB} GB (before a call of stage ${stage})`); return 3; }
    if (used > this.o.maxGB) { this.log(stage, `HARD STOP: ${BAKE} holds ${used.toFixed(2)} GB, over the limit of ${this.o.maxGB} GB (before a call of stage ${stage})`); return 3; }
    return 0;
  }
  // Delete the files a done stage was the last reader of. Only by the names of its own list, and never with --keep-all.
  cleanSpent(st: Stage) {
    if (this.o.keepAll) return;
    for (const s of st.spent) for (const name of expand(this.c.dir, s.name)) {
      const path = join(this.c.dir, name), bytes = diskBytes(path);
      rmSync(path, { recursive: true, force: true });
      this.log(st.name, `spent: deleted ${name} (${gb(bytes)} GB, made by ${s.from ?? "an earlier stage"}, last read by ${st.name})`);
    }
  }
  repair(st: Stage) {
    for (const w of st.whole) {
      const path = join(this.c.dir, w.name), size = sizeOf(path);
      if (size >= 0 && w.bytes !== undefined && size !== w.bytes) { rmSync(path, { force: true }); this.log(st.name, `removed ${w.name}: ${size} bytes, not ${w.bytes} (a write a kill cut short)`); }
    }
  }
  // One call of the stage's script. Seconds are counted from the moment the script runs (a GPU call waits for the lock first, and that wait is kept apart); the child's tree is sampled by ps for its RSS.
  call(st: Stage): Promise<CallResult> {
    const cmd = commandLine(st, this.c), text = cmd.join(" "), n = ++this.calls, t0 = Date.now(), tail: string[] = [];
    writeLock(join(this.c.dir, "bake-driver.lock"), { pid: process.pid, started: this.started, stage: st.name, command: text });
    this.log(st.name, `call-start n=${n} ${text}`);
    const { promise, resolve: done } = Promise.withResolvers<CallResult>();
    let startedAt = st.kind === "GPU" ? 0 : t0, peakKB = 0, timedOut = false, ended = false;
    const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* gone */ } };
    const emit = (line: string) => { tail.push(line); if (tail.length > TAIL_LINES) tail.shift(); this.log(st.name, `| ${line}`); };
    for (const s of [child.stdout!, child.stderr!]) {
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (d: string) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { emit(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      s.on("end", () => { if (buf) emit(buf); });
    }
    const sample = () => {
      if (ended || child.pid === undefined) return;
      const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
      if (ps.status !== 0) return;
      const kids = new Map<number, number[]>(), rss = new Map<number, number>();
      for (const l of ps.stdout.split("\n")) { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(l); if (m) { rss.set(Number(m[1]), Number(m[3])); kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), Number(m[1])]); } }
      const tree: number[] = [], todo = [child.pid];
      while (todo.length) { const p = todo.pop()!; if (rss.has(p) && !tree.includes(p)) { tree.push(p); todo.push(...(kids.get(p) ?? [])); } }
      for (const p of tree) peakKB = Math.max(peakKB, rss.get(p)!);
      if (!startedAt && tree.length > 1) startedAt = Date.now(); // lockf has forked the script: the lock is ours
      if (startedAt && !timedOut && Date.now() - startedAt > (this.o.budget + this.o.grace) * 1000) {
        timedOut = true;
        this.log(st.name, `call ${n} ran over its budget of ${this.o.budget} s and grace of ${this.o.grace} s: stopping it`);
        killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), KILL_AFTER_MS).unref();
      }
    };
    this.interrupt = (sig) => { killGroup(sig); setTimeout(() => killGroup("SIGKILL"), KILL_AFTER_SIGNAL_MS).unref(); };
    if (this.stopping) this.interrupt("SIGTERM");
    const first = setTimeout(sample, Math.min(150, this.o.sampleMs)), timer = setInterval(sample, this.o.sampleMs);
    const finish = (code: number | null, signal: string | null) => {
      if (ended) return;
      ended = true; clearInterval(timer); clearTimeout(first); this.interrupt = null;
      const now = Date.now(), seconds = startedAt ? (now - startedAt) / 1000 : 0, wait = ((startedAt || now) - t0) / 1000, rss = peakKB / 2 ** 20;
      done({ code, signal, seconds, wait, rss, timedOut, tail });
    };
    child.on("error", (e) => { emit(`spawn failed: ${e.message}`); finish(-1, null); });
    child.on("close", (code, signal) => finish(code, signal));
    return promise;
  }

  async run(): Promise<number> {
    const { o, c, stages } = this, live = stages.filter((s) => !s.skip);
    const first = o.from ? live.findIndex((s) => s.name === o.from) : 0;
    if (o.from && first < 0) { this.log(null, `stage ${o.from} is skipped in this bake`); return 1; }
    const last = o.stopAfter ? live.findIndex((s) => s.name === o.stopAfter) : live.length - 1;
    if (o.stopAfter && last < 0) { this.log(null, `stage ${o.stopAfter} is skipped in this bake`); return 1; }
    this.log(null, `start pid ${process.pid}: seed ${c.seed} key ${c.key} tier ${c.tier}, stages ${live.slice(first, last + 1).map((s) => s.name).join(", ")}${o.keepAll ? ", keeping every file" : ""}`);
    for (const s of stages.filter((x) => x.skip)) this.log(s.name, `skipped: ${s.skip}`);
    this.save(null);
    for (let i = first; i <= last; i++) {
      const st = live[i], g = this.stat(st.name), ev = evaluate(stages, c.dir).find((e) => e.stage.name === st.name)!;
      if (ev.done && !ev.own) this.log(st.name, "done (a stage that reads its files is)");
      else {
        if (!ev.done) {
          const code = await this.work(st, g);
          if (code !== 0) { this.save(null); return code; }
        }
        this.cleanSpent(st);
      }
      this.save(null);
      this.log(st.name, `done: ${g.calls} calls, ${g.seconds.toFixed(0)} s, peak ${g.peakRssGB.toFixed(2)} GB RSS, ${gb(g.bytesOnDisk)} GB on disk`);
    }
    const all = evaluate(stages, c.dir).filter((e) => !e.stage.skip).every((e) => e.done);
    this.log(null, all ? "every stage is done" : "stopped before every stage is done");
    return all ? 0 : 2;
  }

  // The calls of one stage until its own files say it is done. Returns the exit code to stop with, or 0 when the stage is done.
  async work(st: Stage, g: StageProgress): Promise<number> {
    const { o, c, stages } = this, dir = c.dir;
    if (st.command === null) { this.log(st.name, "no script for this stage: a gap, so the bake cannot go on"); g.state = "missing"; return 1; }
    const needed = evaluate(stages, dir), undone = st.needs.filter((n) => needed.some((e) => e.stage.name === n && !e.stage.skip && !e.done));
    const absent = st.inputs.filter((f) => !existsSync(join(dir, f))), outside = (st.external ?? []).filter((f) => !existsSync(f));
    if (outside.length) { this.log(st.name, `blocked: the planet's coarse stages are not kept (${outside.join(", ")}): scripts/globe-planet.ts makes them, the driver does not`); g.state = "blocked"; return 1; }
    if (undone.length || absent.length) {
      this.log(st.name, `blocked: ${undone.length ? `needs ${undone.join(", ")} done first` : ""}${undone.length && absent.length ? "; " : ""}${absent.length ? `reads ${absent.slice(0, 4).join(", ")}${absent.length > 4 ? ` and ${absent.length - 4} more` : ""}, which are not in ${dir}` : ""}`);
      g.state = "blocked"; return 1;
    }
    if (st.tierFlag && c.tier !== PLANET_TIER && !takesTier(readFileSync(join(ROOT, st.tierFlag), "utf8"))) {
      this.log(st.name, `blocked: ${st.tierFlag} does not take --tier, so it would make tier ${PLANET_TIER} and not tier ${c.tier}`);
      g.state = "blocked"; return 1;
    }
    let streak = 0;
    for (;;) {
      if (this.stopping) return 2;
      if (this.calls >= o.maxCalls) { this.log(null, `--max-calls ${o.maxCalls} reached in stage ${st.name}`); return 2; }
      const stop = this.guard(st.name);
      if (stop) return stop;
      this.repair(st);
      const before = signature(dir, st), have0 = measure(dir, st.measure).have;
      this.save(st.name);
      const r = await this.call(st);
      g.calls++; g.seconds += r.seconds; g.lockWaitS += r.wait; g.peakRssGB = Math.max(g.peakRssGB, r.rss);
      if ("marker" in st.measure && r.code === 0) writeFileSync(join(dir, st.measure.marker), JSON.stringify({ at: new Date().toISOString(), calls: g.calls }));
      const after = measure(dir, st.measure);
      this.log(st.name, `call-end n=${this.calls} code=${r.code} signal=${r.signal ?? "none"} seconds=${r.seconds.toFixed(1)} wait=${r.wait.toFixed(1)} rss=${r.rss.toFixed(3)} progress=${after.have}/${after.of}${r.timedOut ? " timed-out" : ""}`);
      this.save(st.name);
      if (after.done) return 0;
      if (this.stopping) return 2;
      const moved = signature(dir, st) !== before || after.have > have0;
      streak = moved ? 0 : streak + 1;
      if (streak >= GIVE_UP) {
        this.log(st.name, `stopped: ${GIVE_UP} calls in a row made no progress (last: exit ${r.code}${r.signal ? `, ${r.signal}` : ""}${r.timedOut ? ", over its time" : ""}, ${after.have}/${after.of}). Last output:`);
        for (const l of r.tail.slice(-12)) this.log(st.name, `  ${l}`);
        g.state = "failed";
        return 1;
      }
      if (!moved) this.log(st.name, `no progress in call ${this.calls} (${streak} of ${GIVE_UP}): trying again`);
    }
  }
}

// What a dead driver left: a child still running its call must end before this driver touches the stage.
async function waitForOrphans(run: Run, stale: LockInfo) {
  if (!stale.command) return;
  const patience = (run.o.budget + run.o.grace + 30) * 1000, t0 = Date.now();
  for (let pids = procsRunning(stale.command); pids.length; pids = procsRunning(stale.command)) {
    if (Date.now() - t0 > patience) { run.log(null, `orphan ${pids.join(", ")} of the dead driver ${stale.pid} ran too long: stopping it`); for (const p of pids) try { process.kill(p, "SIGKILL"); } catch { /* gone */ } break; }
    if (Date.now() - t0 < 1500 || (Date.now() - t0) % 10000 < 1000) run.log(null, `waiting for process ${pids.join(", ")}, the call the dead driver ${stale.pid} left running in stage ${stale.stage}`);
    await Bun.sleep(500);
  }
}

export async function main(argv: string[]): Promise<number> {
  process.stdout.on("error", () => { /* a closed pipe must not stop a bake: bake.log has every line */ });
  let o: Opts, cfg: Cfg, stages: Stage[];
  try { o = parseOpts(argv); ({ cfg, stages } = tableOf(o)); } catch (e) { const m = (e as Error).message; console.error(m ? `${m}\n${USAGE}` : USAGE); return m ? 1 : 0; }
  if (o.status) {
    const lock = readLock(join(cfg.dir, "bake-driver.lock")), running = lock && alive(lock.pid) ? lock : null;
    console.log(`bake ${cfg.dir} (tier ${cfg.tier}, ${tileCount(cfg.tier)} tiles; ${running ? `driver ${running.pid} running${running.stage ? ` stage ${running.stage}` : ""} since ${running.started}` : "no driver running"})`);
    console.log(statusTable(stages, cfg.dir, readProgress(cfg.dir, cfg), running?.stage ?? null));
    console.log(`disk: ${freeGB(cfg.dir).toFixed(1)} GB free (floor ${o.minFreeGB}); ${BAKE} holds ${usedGB(BAKE).toFixed(1)} GB (hard stop ${o.maxGB})`);
    return 0;
  }
  if (o.dryRun) { console.log(describePlan(stages, cfg, o)); return 0; }
  mkdirSync(cfg.dir, { recursive: true });
  const lockPath = join(cfg.dir, "bake-driver.lock"), info: LockInfo = { pid: process.pid, started: new Date().toISOString(), stage: null, command: null }, got = acquireLock(lockPath, info);
  if (!got.ok) { console.error(`another driver (pid ${got.holder?.pid ?? "?"}${got.holder?.stage ? `, stage ${got.holder.stage}` : ""}) holds ${lockPath}: not starting`); return 1; }
  const run = new Run(o, cfg, stages);
  run.started = info.started;
  const onExit = () => releaseLock(lockPath);
  process.on("exit", onExit);
  const onSignal = (sig: NodeJS.Signals) => { run.stopping = true; run.log(null, `${sig}: passing it to the call in flight and stopping`); run.interrupt?.(sig); };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const s of signals) process.on(s, onSignal);
  try {
    if (got.stale) { run.log(null, `took over the lock of the dead driver ${got.stale.pid}`); await waitForOrphans(run, got.stale); }
    const code = await run.run();
    run.progress.driver = null;
    writeProgress(cfg.dir, run.progress);
    console.log(statusTable(stages, cfg.dir, run.progress, null));
    return code;
  } catch (e) {
    run.log(null, `failed: ${(e as Error).stack ?? e}`);
    return 1;
  } finally { for (const s of signals) process.off(s, onSignal); onExit(); }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
