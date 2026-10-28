// The bake driver (scripts/globe-bake-driver.ts) on FAKE stages (bake-driver-fixture/fake-stage.ts: a few 'tiles', a sleep, can be killed and made to fail) in a scratch bake dir under /tmp/planet-75m,
// and the real stage table's own invariants, read against the real tier-4 bake of key 883a8d9387df where it is there (read-only). No GPU and no real stage runs. Each case alone:
//   bun test ./src/gpu/globe/bake-driver.test.ts -t "<name>" --timeout 120000
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { PLANET_TIER } from "./grid";
import { doneFileOf } from "./stages";
import { COARSE_TIER, PLANET_STAGES, PLANET_STORE, STREAM_TIER, acquireLock, alive, cellsOf, evaluate, expand, fromLog, loadStages, markerOf, measure, parseOpts, realStages, signature, takesTier, type Cfg, type Stage } from "../../../scripts/globe-bake-driver";

const SCRATCH = "/tmp/planet-75m/bakedriver-scratch", SCRIPT = join(import.meta.dir, "../../../scripts/globe-bake-driver.ts"), FIX = join(import.meta.dir, "bake-driver-fixture/fake-stage.ts");
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const procs: { kill: (s?: number | NodeJS.Signals) => void }[] = [];
afterEach(() => { for (const p of procs.splice(0)) try { p.kill("SIGKILL"); } catch { /* gone */ } });

// the fixture takes the first of a repeated option, so a case's extra options come before the defaults
const fake = (name: string, extra: string[]) => ["bun", FIX, "--dir", "{dir}", "--name", name, ...extra];
const chain = (sleep: number, a: string[] = [], b: string[] = []) => [
  { name: "a", kind: "CPU", command: fake("a", [...a, "--tiles", "6", "--per-call", "2", "--sleep", `${sleep}`, "--writes", "a-out.bin,a-tmp.bin"]), outputs: ["a-done.u8", "a-out.bin", "a-tmp.bin"], measure: { tiles: ["a-done.u8"], of: 6 } },
  { name: "b", kind: "GPU", command: fake("b", [...b, "--tiles", "4", "--per-call", "3", "--sleep", `${sleep}`, "--reads", "a-tmp.bin", "--writes", "b-out.bin"]), needs: ["a"], inputs: ["a-tmp.bin"], outputs: ["b-done.u8", "b-out.bin"],
    measure: { tiles: ["b-done.u8"], of: 4 }, spent: [{ name: "a-tmp.bin", from: "a" }] },
  { name: "c", kind: "CPU", command: fake("c", ["--mode", "files", "--writes", "c-whole.bin", "--size", "100"]), needs: ["b"], outputs: ["c-whole.bin"], measure: { files: [{ name: "c-whole.bin", bytes: 100 }] }, whole: [{ name: "c-whole.bin", bytes: 100 }] },
  { name: "d", kind: "CPU", command: fake("d", ["--mode", "count", "--count-dir", "d-tiles", "--tiles", "3", "--per-call", "2"]), needs: ["c"], outputs: ["d-tiles", "d-tiles.json"], measure: { count: "d-tiles", ext: ".tile.gz", of: 3, also: ["d-tiles.json"] } },
  { name: "e", kind: "CPU", command: fake("e", ["--mode", "marker", "--sleep", "20"]), needs: ["d"], outputs: ["e-done.json"], measure: { marker: "e-done.json" } },
];
interface Box { root: string; dir: string; stagesFile: string; lock: string }
function sandbox(stages: object[]): Box {
  const root = mkdtempSync(join(SCRATCH, "run-")), stagesFile = join(root, "stages.json");
  writeFileSync(stagesFile, JSON.stringify({ stages }));
  return { root, dir: join(root, "1-k"), stagesFile, lock: join(root, "gpu.lock") };
}
type Driver = Subprocess<"ignore", "pipe", "pipe">;
const spawnDriver = (box: Box, args: string[], env: Record<string, string | undefined> = {}): Driver => {
  const p = Bun.spawn([process.execPath, SCRIPT, "--seed", "1", "--key", "k", "--stages-file", box.stagesFile, "--lock-file", box.lock, "--sample-ms", "40", ...args], { env: { ...process.env, NOMADS_BAKE: box.root, ...env }, stdout: "pipe", stderr: "pipe" });
  procs.push(p);
  return p;
};
const finish = async (p: Driver) => { const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { code, out: out + err }; };
const drive = (box: Box, args: string[] = []) => finish(spawnDriver(box, args));
// The condition is a file another process writes (a tile made, a lock taken): the test polls for that, with a ceiling, and takes no guess at how long it takes.
const waitFor = async (pred: () => boolean, ms = 30000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("waited too long"); await Bun.sleep(25); } };
const ones = (box: Box, file: string) => { try { return readFileSync(join(box.dir, file)).reduce((a, b) => a + (b === 1 ? 1 : 0), 0); } catch { return 0; } };
const progress = (box: Box) => JSON.parse(readFileSync(join(box.dir, "bake-progress.json"), "utf8")) as { driver: unknown; stages: Record<string, { state: string; calls: number; tilesDone: number; tilesOf: number; peakRssGB: number; bytesOnDisk: number; seconds: number }> };
const log = (box: Box) => readFileSync(join(box.dir, "bake.log"), "utf8");
// every file of the bake dir but the driver's own and the fake stages' call counters, by name, size and content
function snapshot(dir: string, at = dir): string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((e) => {
    const p = join(at, e.name);
    if (e.isDirectory()) return snapshot(dir, p);
    if (/^(bake-progress\.json.*|bake\.log|bake-driver\.lock.*|.*-calls\.txt)$/.test(e.name)) return [];
    return [`${relative(dir, p)} ${statSync(p).size} ${/-done\.json$/.test(e.name) ? "" : createHash("sha1").update(readFileSync(p)).digest("hex").slice(0, 12)}`]; // the driver's own marker holds its time
  }).sort();
}
let reference: string[] | null = null;
async function cleanFinal() {
  if (reference) return reference;
  const box = sandbox(chain(10));
  expect((await drive(box)).code).toBe(0);
  return (reference = snapshot(box.dir));
}

describe("the driver on fake stages", () => {
  test("end to end: every stage done, the progress file right, spent files deleted after their consumer and not before", async () => {
    const box = sandbox(chain(60)), r = await drive(box);
    expect(r.code).toBe(0);
    const p = progress(box);
    expect(Object.fromEntries(Object.entries(p.stages).map(([k, v]) => [k, v.state]))).toEqual({ a: "done", b: "done", c: "done", d: "done", e: "done" });
    expect(Object.fromEntries(Object.entries(p.stages).map(([k, v]) => [k, v.calls]))).toEqual({ a: 3, b: 2, c: 1, d: 2, e: 1 });
    expect([p.stages.a.tilesDone, p.stages.a.tilesOf, p.stages.d.tilesDone, p.stages.d.tilesOf]).toEqual([6, 6, 3, 3]);
    expect(p.stages.a.peakRssGB).toBeGreaterThan(0);
    expect(p.stages.b.peakRssGB).toBeGreaterThan(0); // the GPU stage's script is the lockf's child: its tree was found
    expect(p.stages.b.bytesOnDisk).toBeGreaterThan(0);
    expect(p.driver).toBeNull();
    expect(existsSync(join(box.dir, "a-tmp.bin"))).toBe(false);
    expect(existsSync(join(box.dir, "a-out.bin"))).toBe(true);
    const lines = log(box).split("\n"), lastB = lines.map((l, i) => (l.includes("[b] call-end") ? i : -1)).filter((i) => i >= 0).pop()!, deleted = lines.findIndex((l) => l.includes("spent: deleted a-tmp.bin"));
    expect(deleted).toBeGreaterThan(lastB);
    expect(lines.filter((l) => l.includes("[b] call-end") && !l.includes("code=0 signal=none")).length).toBe(0); // b read a-tmp.bin at every tile and never found it gone
    expect(existsSync(join(box.dir, "bake-driver.lock"))).toBe(false);
    expect(Math.abs(statSync(join(box.dir, "bake.log")).size - log(box).length)).toBeLessThan(200);
  }, 60000);

  test("a stage's spent family keeps the files it names as exceptions: the coarse heads outlive the cascade's scratch and every later tile reads them", async () => {
    const heads = ["t3-g-head1.i32", "t3-g-head2.i32"], scratch = ["t3-g-head1-part.i32", "t3-g-casc1.json", "t3-g-a-ht.i32", "g-solve1.json"];
    const box = sandbox([
      { name: "t3-flow", kind: "GPU", command: fake("t3-flow", ["--mode", "files", "--writes", "t3-to.u32", "--size", "10"]), outputs: ["t3-to.u32"], measure: { files: [{ name: "t3-to.u32", bytes: 10 }] }, whole: [{ name: "t3-to.u32", bytes: 10 }] },
      { name: "coarse", kind: "GPU", command: fake("coarse", ["--mode", "files", "--reads", "t3-to.u32", "--writes", [...heads, ...scratch].join(","), "--size", "10"]), needs: ["t3-flow"], inputs: ["t3-to.u32"], outputs: [...heads, "t3-g-*", "g-*"],
        measure: { files: heads.map((name) => ({ name, bytes: 10 })) }, spent: [{ name: "t3-to.u32", from: "t3-flow" }, { name: "t3-g-*", from: "coarse", except: heads }, { name: "g-*", from: "coarse" }] },
      { name: "water", kind: "GPU", command: fake("water", ["--tiles", "4", "--per-call", "2", "--sleep", "10", "--reads", heads.join(","), "--writes", "w-out.bin"]), needs: ["coarse"], inputs: heads, outputs: ["water-done.u8", "w-out.bin"], measure: { tiles: ["water-done.u8"], of: 4 } },
    ]);
    const r = await drive(box);
    expect(r.code).toBe(0);
    for (const h of heads) expect(existsSync(join(box.dir, h))).toBe(true);
    for (const s of ["t3-to.u32", ...scratch]) expect(existsSync(join(box.dir, s))).toBe(false);
    expect(log(box).split("\n").filter((l) => l.includes("[water] call-end") && !l.includes("code=0 signal=none")).length).toBe(0);
    expect(log(box)).toContain("spent: deleted t3-g-head1-part.i32");
    expect(log(box)).not.toContain("spent: deleted t3-g-head1.i32");
  }, 60000);

  test("--keep-all deletes nothing", async () => {
    const box = sandbox(chain(10));
    expect((await drive(box, ["--keep-all"])).code).toBe(0);
    expect(existsSync(join(box.dir, "a-tmp.bin"))).toBe(true);
  }, 60000);

  test("a driver killed with SIGKILL mid-stage and run again ends in the same state as an undisturbed run, after the dead driver's own call has ended", async () => {
    const want = await cleanFinal(), box = sandbox(chain(700));
    const first = spawnDriver(box, []);
    await waitFor(() => ones(box, "a-done.u8") >= 1);
    first.kill("SIGKILL");
    await first.exited;
    expect(existsSync(join(box.dir, "bake-driver.lock"))).toBe(true);
    const r = await drive(box);
    expect(r.code).toBe(0);
    expect(log(box)).toContain("took over the lock of the dead driver");
    expect(log(box)).toContain("waiting for process");
    expect(snapshot(box.dir)).toEqual(want);
    expect(Object.values(progress(box).stages).every((s) => s.state === "done")).toBe(true);
  }, 90000);

  test("a child killed with SIGKILL mid-call is retried and the end state is the same", async () => {
    const want = await cleanFinal(), box = sandbox(chain(300)), p = spawnDriver(box, []);
    await waitFor(() => ones(box, "b-done.u8") >= 1);
    const pids = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes("fake-stage.ts") && l.includes("--name b") && l.includes(box.dir) && !l.includes("lockf")).map((l) => Number(l.trim().split(/\s+/)[0]));
    expect(pids.length).toBe(1);
    process.kill(pids[0], "SIGKILL");
    const r = await finish(p);
    expect(r.code).toBe(0);
    expect(log(box).split("\n").filter((l) => l.includes("[b] call-end") && !l.includes("code=0 signal=none")).length).toBeGreaterThanOrEqual(1);
    expect(snapshot(box.dir)).toEqual(want);
  }, 90000);

  test("a stage that dies after each tile is called again until done; one that makes no progress is given up after three calls", async () => {
    const dies = sandbox(chain(10, ["--die-after", "1"])), r = await drive(dies);
    expect(r.code).toBe(0);
    expect(progress(dies).stages.a.calls).toBe(6);
    const flaky = sandbox(chain(10, ["--fail-first", "2"]));
    expect((await drive(flaky)).code).toBe(0); // two failures, then progress: the count starts again
    const broken = sandbox(chain(10, ["--fail-first", "9"])), b = await drive(broken);
    expect(b.code).toBe(1);
    expect(b.out).toContain("3 calls in a row made no progress");
    expect(progress(broken).stages.a).toMatchObject({ calls: 3, state: "failed" });
    expect(ones(broken, "a-done.u8")).toBe(0);
    expect(existsSync(join(broken.dir, "bake-driver.lock"))).toBe(false);
  }, 90000);

  test("a GPU call waits for the lock without the wait counting against its budget, and the lock is held only for the call", async () => {
    const box = sandbox(chain(10)), holder = Bun.spawn(["lockf", box.lock, "sleep", "3"]);
    procs.push(holder);
    await waitFor(() => existsSync(box.lock));
    const r = await drive(box, ["--budget", "1", "--grace", "1"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("ran over its budget");
    const waits = log(box).split("\n").filter((l) => l.includes("[b] call-end")).map((l) => Number(/wait=([\d.]+)/.exec(l)![1]));
    expect(Math.max(...waits)).toBeGreaterThan(1);
    expect(Bun.spawnSync(["lockf", "-t", "0", box.lock, "true"]).exitCode).toBe(0); // free again: the driver kept nothing between calls
  }, 60000);

  test("a call that runs over its budget and grace is stopped, and counts as no progress when it moved nothing", async () => {
    const box = sandbox(chain(10, ["--sleep", "20000", "--per-call", "1"])), r = await drive(box, ["--budget", "1", "--grace", "1"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ran over its budget");
    expect(progress(box).stages.a.calls).toBe(3);
  }, 90000);

  test("--stop-after, --from, --max-calls", async () => {
    const want = await cleanFinal(), box = sandbox(chain(10));
    const stop = await drive(box, ["--stop-after", "b"]);
    expect(stop.code).toBe(2);
    expect(Object.fromEntries(Object.entries(progress(box).stages).map(([k, v]) => [k, v.state]))).toMatchObject({ a: "done", b: "done", c: "pending" });
    expect(existsSync(join(box.dir, "a-tmp.bin"))).toBe(false); // b is done, so the file it was the last reader of goes
    const from = await drive(box, ["--from", "c"]);
    expect(from.code).toBe(0);
    expect(readFileSync(join(box.dir, "a-calls.txt"), "utf8").length).toBe(3); // a and b were not called again
    expect(snapshot(box.dir)).toEqual(want);
    const fresh = sandbox(chain(10)), blocked = await drive(fresh, ["--from", "c"]);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toContain("needs b done first");
    const outside = sandbox([{ ...chain(10)[0], external: ["{here}/not-kept.bin"] }]), o = await drive(outside);
    expect(o.code).toBe(1);
    expect(o.out).toContain("the planet's coarse stages are not kept");
    expect(existsSync(join(outside.dir, "a-calls.txt"))).toBe(false); // refused before any call
    const some = sandbox(chain(10)), m = await drive(some, ["--max-calls", "1"]);
    expect(m.code).toBe(2);
    expect(progress(some).stages.a.calls).toBe(1);
    expect(ones(some, "a-done.u8")).toBe(2);
    expect((await drive(some, ["--max-calls", "1"])).code).toBe(2);
    expect(progress(some).stages.a.calls).toBe(2);
    expect((await drive(sandbox(chain(10)), ["--stop-after", "nope"])).code).toBe(1);
    const last = sandbox(chain(10));
    expect((await drive(last, ["--stop-after", "e"])).code).toBe(0); // the last stage: everything is done
  }, 120000);

  test("--status prints the table while a driver runs and changes nothing; --dry-run touches nothing", async () => {
    const box = sandbox(chain(700)), p = spawnDriver(box, []);
    await waitFor(() => ones(box, "a-done.u8") >= 1);
    const t0 = Date.now(), s = await finish(spawnDriver(box, ["--status"]));
    expect(s.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(s.out).toMatch(/driver \d+ running stage a/);
    expect(s.out).toMatch(/a\s+CPU\s+running\s+1\/6|a\s+CPU\s+running\s+2\/6/);
    expect(s.out).toMatch(/e\s+CPU\s+pending\s+0\/1/);
    p.kill("SIGTERM");
    await p.exited;
    const idle = sandbox(chain(10)), d = await drive(idle, ["--dry-run"]);
    expect(d.code).toBe(0);
    expect(d.out).toContain("spent once done: a-tmp.bin");
    expect(existsSync(idle.dir)).toBe(false);
  }, 90000);

  test("SIGTERM is passed to the child and stops the driver cleanly (exit 2, no lock, no stray child)", async () => {
    const box = sandbox(chain(700)), p = spawnDriver(box, []);
    await waitFor(() => ones(box, "a-done.u8") >= 1);
    p.kill("SIGTERM");
    const r = await finish(p);
    expect(r.code).toBe(2);
    expect(existsSync(join(box.dir, "bake-driver.lock"))).toBe(false);
    expect(log(box)).toContain("SIGTERM");
    expect(spawnSync("ps", ["-A", "-o", "command="], { encoding: "utf8" }).stdout.split("\n").some((l) => l.includes("fake-stage.ts") && l.includes(box.dir))).toBe(false);
    expect(progress(box).driver).toBeNull();
    expect((await drive(box)).code).toBe(0);
  }, 90000);

  test("the free-space floor and the hard stop on the bake root's size stop with exit 3 and name the stage", async () => {
    const floor = sandbox(chain(10)), f = await drive(floor, ["--min-free-gb", "100000000"]);
    expect(f.code).toBe(3);
    expect(f.out).toMatch(/HARD STOP: .* GB free .* stage a/);
    expect(ones(floor, "a-done.u8")).toBe(0);
    const big = sandbox(chain(10, ["--bulk", "300000"])), h = await drive(big, ["--max-gb", "0.0002"]);
    expect(h.code).toBe(3);
    expect(h.out).toMatch(/HARD STOP: .* holds .* over the limit .* stage a/);
    expect(progress(big).stages.a.calls).toBe(1);
    expect((await drive(big)).code).toBe(0); // the stop lost nothing
  }, 90000);

  test("a second driver on the same bake dir is refused; a lock of a dead pid, or of a pid that is not a driver, is taken over", async () => {
    const box = sandbox(chain(700)), p = spawnDriver(box, []);
    await waitFor(() => ones(box, "a-done.u8") >= 1);
    const second = await drive(box);
    expect(second.code).toBe(1);
    expect(second.out).toContain("another driver");
    expect(existsSync(join(box.dir, "bake-driver.lock"))).toBe(true); // the refused one left the first's lock alone
    p.kill("SIGKILL");
    await p.exited;
    for (const ps of spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes("fake-stage.ts") && l.includes(box.dir))) process.kill(Number(ps.trim().split(/\s+/)[0]), "SIGKILL");
    const dead = Bun.spawnSync(["true"]), lock = join(box.dir, "bake-driver.lock");
    writeFileSync(lock, JSON.stringify({ pid: dead.pid, started: "x", stage: "a", command: null }));
    const taken = await drive(box);
    expect(taken.code).toBe(0);
    expect(log(box)).toContain(`took over the lock of the dead driver ${dead.pid}`);
    const sleeper = Bun.spawn(["sleep", "30"]);
    procs.push(sleeper);
    const box2 = sandbox(chain(10));
    mkdirSync(box2.dir, { recursive: true });
    writeFileSync(join(box2.dir, "bake-driver.lock"), JSON.stringify({ pid: sleeper.pid, started: "x", stage: null, command: null }));
    expect(alive(sleeper.pid)).toBe(false);
    expect((await drive(box2)).code).toBe(0);
  }, 90000);

  test("the progress file is rebuilt from the log when it is gone or torn, and the disk's state decides what is done", async () => {
    const box = sandbox(chain(10));
    expect((await drive(box)).code).toBe(0);
    for (const damage of ["gone", "torn"]) {
      const path = join(box.dir, "bake-progress.json");
      if (damage === "gone") rmSync(path); else writeFileSync(path, '{"version":1,"stages":{"a":');
      const s = await drive(box, ["--status"]);
      expect(s.code).toBe(0);
      expect(s.out).toMatch(/a\s+CPU\s+done\s+6\/6\s+3\s/);
      const again = await drive(box);
      expect(again.code).toBe(0);
      expect(progress(box).stages.a).toMatchObject({ calls: 3, state: "done", tilesDone: 6 });
    }
    expect(fromLog(join(box.dir, "bake.log")).b.calls).toBe(2);
  }, 90000);

  test("a file torn by a kill (a whole-file output at the wrong size) is removed before the next call, so the stage makes it again", async () => {
    const box = sandbox(chain(10));
    expect((await drive(box, ["--stop-after", "b"])).code).toBe(2);
    mkdirSync(box.dir, { recursive: true });
    writeFileSync(join(box.dir, "c-whole.bin"), "torn");
    expect((await drive(box)).code).toBe(0);
    expect(statSync(join(box.dir, "c-whole.bin")).size).toBe(100);
    expect(log(box)).toContain("removed c-whole.bin: 4 bytes, not 100");
  }, 90000);
});

describe("the pieces", () => {
  test("measure, signature, evaluate and expand read the disk; a stage is done when a stage that reads its files is", () => {
    const box = sandbox(chain(10)), dir = join(box.root, "pieces");
    mkdirSync(dir, { recursive: true });
    const cfg: Cfg = { seed: 1, key: "k", tier: 1, budget: 1, dir, lock: box.lock }, stages = loadStages(box.stagesFile, cfg);
    expect(measure(dir, stages[0].measure)).toEqual({ have: 0, of: 6, done: false });
    writeFileSync(join(dir, "a-done.u8"), new Uint8Array([1, 1, 0, 1, 0, 0]));
    const before = signature(dir, stages[0]);
    expect(measure(dir, stages[0].measure)).toEqual({ have: 3, of: 6, done: false });
    writeFileSync(join(dir, "a-done.u8"), new Uint8Array(6).fill(1));
    expect(signature(dir, stages[0])).not.toBe(before);
    expect(measure(dir, stages[0].measure).done).toBe(true);
    writeFileSync(join(dir, "c-whole.bin"), "xx");
    expect(measure(dir, stages[2].measure)).toEqual({ have: 0, of: 1, done: false });
    mkdirSync(join(dir, "d-tiles"));
    writeFileSync(join(dir, "d-tiles", "0.tile.gz"), "");
    writeFileSync(join(dir, "d-tiles", "1.tile.part"), "");
    expect(measure(dir, stages[3].measure)).toEqual({ have: 1, of: 3, done: false });
    // a-done is all ones, nothing else: a is done by its own files; e (a marker) is done, which makes d, c, b done too, whatever their own files say
    writeFileSync(join(dir, "e-done.json"), "{}");
    const e = evaluate(stages, dir);
    expect(e.map((x) => [x.stage.name, x.done, x.implied])).toEqual([["a", true, false], ["b", true, true], ["c", true, true], ["d", true, true], ["e", true, false]]);
    writeFileSync(join(dir, "t5-g-one"), "");
    writeFileSync(join(dir, "t5-g-two"), "");
    writeFileSync(join(dir, "t5-other"), "");
    expect(expand(dir, "t5-g-*")).toEqual(["t5-g-one", "t5-g-two"]);
    expect(expand(dir, "nothing")).toEqual([]);
    expect(() => expand(dir, "../x")).toThrow();
    expect(() => expand(dir, "a/b")).toThrow();
  });

  test("a tier-less marker is the tier's only when it holds the tier's tile count (stages.ts)", () => {
    const dir = mkdtempSync(join(SCRATCH, "legacy-")), m = { tiles: ["t5-air-done.u8"], of: 6144, legacy: ["air-done.u8"] };
    writeFileSync(join(dir, "air-done.u8"), new Uint8Array(1536).fill(1)); // tier 4's tile count: another tier's
    expect(measure(dir, m)).toEqual({ have: 0, of: 6144, done: false });
    writeFileSync(join(dir, "air-done.u8"), new Uint8Array(6144).fill(1));
    expect(measure(dir, m)).toEqual({ have: 6144, of: 6144, done: true });
    writeFileSync(join(dir, "t5-air-done.u8"), new Uint8Array(6144));
    expect(measure(dir, m).have).toBe(0); // the tier's own name wins
  });

  test("the planet store's path and records are the scripts'", () => {
    expect(readFileSync(join(import.meta.dir, "../../../scripts/globe-planet.ts"), "utf8")).toContain("export const STORE = PLANET_STORE;");
    const window = readFileSync(join(import.meta.dir, "window.ts"), "utf8");
    expect(window).toContain('export const STAGES = ["chain", "climate0", "ice", "climate1"]');
    for (const n of PLANET_STAGES) expect(window).toContain(`get("${n}")`);
  });

  test("options and the lock", () => {
    expect(parseOpts(["--key", "k"], {})).toMatchObject({ seed: 1, tier: PLANET_TIER, budget: 240, minFreeGB: 20, maxGB: 100, maxCalls: Infinity });
    expect(() => parseOpts([], {})).toThrow("key");
    expect(() => parseOpts(["--key", "k", "--tier"], {})).toThrow("needs a value");
    expect(() => parseOpts(["--key", "k", "--nope"], {})).toThrow("unknown");
    expect(() => parseOpts(["--key", "k", "--water", "patch"], {})).toThrow("unknown"); // the one route is the patch stage seeded from the coarse heads
    expect(parseOpts([], { NOMADS_PLANET_KEY: "z" }).key).toBe("z");
    expect(takesTier('const tier = Number(arg("tier", "5"))')).toBe(true);
    expect(takesTier("// --tier is not read here\nconst tier = PLANET_TIER")).toBe(false);
    const dir = mkdtempSync(join(SCRATCH, "lock-")), path = join(dir, "l"), dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(path, JSON.stringify({ pid: dead, started: "x", stage: "a", command: "c" }));
    const got = acquireLock(path, { pid: process.pid, started: "y", stage: null, command: null });
    expect(got).toMatchObject({ ok: true, stale: { pid: dead, stage: "a" } });
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    expect(readdirSync(dir)).toEqual(["l"]);
    writeFileSync(path, "{ not json");
    expect(acquireLock(path, { pid: process.pid, started: "y", stage: null, command: null })).toMatchObject({ ok: true });
  });
});

const KEY = "883a8d9387df", REAL = `/tmp/planet-75m/1-${KEY}`;
const cfgOf = (tier: number): Cfg => ({ seed: 1, key: KEY, tier, budget: 240, dir: REAL, lock: "/tmp/nomads-gpu.lock" });
const T3 = ["t3-flow", "t3-pool", "t3-surplus", "t3-discharge", "t3-basin", "coarse"];

describe("the real stage table", () => {
  const stages = realStages(cfgOf(PLANET_TIER)), index = new Map(stages.map((s, i) => [s.name, i])), by = (name: string, all: Stage[] = stages) => all.find((s) => s.name === name)!;
  test("order, needs, kinds, commands and the sizes at tier 5", () => {
    expect(stages.map((s) => s.name)).toEqual(["tiers", "terrain", "air", ...T3, "surplus", "discharge", "basin", "water", "ground", "groundtiles", "pyramid", "maps"]);
    for (const s of stages) for (const n of s.needs) expect(index.get(n)!).toBeLessThan(index.get(s.name)!);
    expect(cellsOf(5)).toBe(402_653_184);
    const spent = stages.flatMap((s) => s.spent.map((x) => [x.name, x.bytes] as const));
    expect(spent).toContainEqual(["t5-vs0.u32", 1_610_612_736]);
    expect(spent).toContainEqual(["t5-q0-hi.u16", 805_306_368]);
    expect(spent).toContainEqual(["t4-height.i32", 4 * 100_663_296]);
    expect(spent).toContainEqual(["t1-height.i32", 4 * 1_572_864]);
    expect(by("tiers").measure).toMatchObject({ files: expect.arrayContaining([{ name: "t5-run.json" }]) });
    expect(by("pyramid").measure).toMatchObject({ count: "pyramid", of: 8190 });
    expect(by("groundtiles").measure).toMatchObject({ of: 6144 });
    expect(by("terrain").measure).toEqual({ tiles: [doneFileOf(5, "terrain")], of: 6144, legacy: ["terrain-done.u8"] });
    expect(by("t3-surplus").measure).toEqual({ tiles: [doneFileOf(3, "surplus")], of: 384, legacy: ["surplus-done.u8"] });
    expect(realStages(cfgOf(4)).find((s) => s.name === "pyramid")!.measure).toMatchObject({ of: 2046 });
    expect(stages.filter((s) => s.skip)).toEqual([]);
    expect(realStages(cfgOf(3)).filter((s) => s.skip).map((s) => s.name)).toEqual(T3);
    // the tier-3 stages and the cascade: the coarse tier's heights stay until `coarse` is done, then go; the two heads every tier-5 water tile reads never go
    expect(by("tiers").spent.map((x) => x.name)).not.toContain("t3-height.i32");
    expect(by("tiers").spent.map((x) => x.name)).toEqual(expect.arrayContaining(["t1-height.i32", "t2-height.i32", "t4-height.i32"]));
    expect(by("coarse").spent.map((x) => x.name)).toEqual(expect.arrayContaining(["t3-height.i32", "t3-to.u32", "t3-flooded.i32", "t3-rock.u8", "t3-pr0.u16", "t3-q0-lo.u32", "t3-cells.u32", "t3-basin.u8", "t3-g-*", "g-*"]));
    expect(by("coarse").spent.find((x) => x.name === "t3-g-*")!.except).toEqual(["t3-g-head1.i32", "t3-g-head2.i32"]);
    expect(by("coarse").measure).toEqual({ files: [{ name: "t3-g-head1.i32", bytes: 100_663_296 }, { name: "t3-g-head2.i32", bytes: 100_663_296 }] });
    expect(by("water").inputs).toEqual(expect.arrayContaining(["t3-g-head1.i32", "t3-g-head2.i32"]));
    expect(by("water").needs).toContain("coarse");
    // kinds and commands: the discharge and the lakes are CPU and streamed from tier 5, GPU below; the tier-3 stages are the same scripts at --tier 3
    expect([by("discharge").kind, by("basin").kind, by("surplus").kind, by("t3-discharge").kind, by("t3-basin").kind]).toEqual(["CPU", "CPU", "GPU", "GPU", "GPU"]);
    expect(by("discharge").command!.slice(1, 4)).toEqual(["scripts/globe-water-stream.ts", "--stage", "discharge"]);
    expect(by("discharge").command).toEqual(expect.arrayContaining(["--tier", "5", "--block", "4"]));
    expect(by("t3-discharge").command!.slice(1, 4)).toEqual(["scripts/globe-water.ts", "--stage", "discharge"]);
    expect(realStages(cfgOf(4)).find((s) => s.name === "discharge")!.kind).toBe("GPU");
    expect(by("t3-flow").command!.join(" ")).toContain("globe-water.ts --stage flow --seed 1 --key 883a8d9387df --tier 3");
    expect(by("coarse").command!.join(" ")).toContain("globe-water.ts --stage coarse --seed 1 --key 883a8d9387df --tier 3 --budget 230");
    expect(by("t3-pool").command!.slice(1).join(" ")).toBe("scripts/globe-pool.ts --seed 1 --key 883a8d9387df --from 5 --to 3 --budget 240");
    expect(by("air").command!.join(" ")).toContain("--tier 5 --budget 240 --block 4");
    expect(by("water").command!.join(" ")).toContain("--stage water --seed 1 --key 883a8d9387df --tier 5 --budget 240 --coarse 3");
    expect(by("t3-pool").kind).toBe("CPU");
    expect(by("t3-pool").needs).toEqual(["tiers", "terrain", "air"]);
    expect(by("t3-pool").inputs).toEqual(["t5-rock.u8", "t5-drift.u8", "t5-dd.u16", ...[0, 1, 2, 3].map((k) => `t5-pr${k}.u16`), ...[0, 1, 2, 3].map((k) => `t5-pe${k}.u16`)]);
    expect(by("t3-pool").outputs).toHaveLength(12); // the 11 pooled files and the marker
    expect(by("t3-pool").spent).toEqual([]);
    expect(by("t3-pool").measure).toEqual({ tiles: ["t3-pool-done.u8"], of: 384 });
    expect(by("t3-surplus").needs).toEqual(["tiers", "t3-pool", "t3-flow"]);
    expect(by("t3-surplus").inputs).toEqual(["t3-height.i32", "t3-flooded.i32", ...[0, 1, 2, 3].map((k) => `t3-pr${k}.u16`), ...[0, 1, 2, 3].map((k) => `t3-pe${k}.u16`)]);
    expect(by("coarse").needs).toEqual(["tiers", ...T3.slice(0, -1)]);
    // the tier-3 terrain and air stages are gone; the tier-5 terrain and air stay and come before the tier-3 flow and pool
    expect(index.has("t3-terrain") || index.has("t3-air")).toBe(false);
    expect(index.get("air")!).toBeLessThan(index.get("t3-flow")!);
    expect(index.get("t3-flow")!).toBeLessThan(index.get("t3-pool")!);
    expect(index.get("coarse")!).toBeLessThan(index.get("surplus")!);
    // only the 11 pooled files of tier 3 are named as made by the pool; none of the 47 air files, and no tier-5 terrain or air file is ever spent
    const pooled = by("coarse").spent.filter((x) => x.from === "t3-pool").map((x) => x.name);
    expect(pooled).toEqual(["t3-rock.u8", "t3-drift.u8", "t3-dd.u16", ...[0, 1, 2, 3].map((k) => `t3-pr${k}.u16`), ...[0, 1, 2, 3].map((k) => `t3-pe${k}.u16`)]);
    expect(by("coarse").spent.map((x) => x.name)).not.toContain("t3-sun0.u16");
    expect(spent.map((s) => s[0])).not.toContain("t5-rock.u8");
  });

  test("the table's marker, stream tier and coarse tier are the sources'", () => {
    expect(markerOf(5, "air")).toBe(doneFileOf(5, "air"));
    expect(readFileSync(join(import.meta.dir, "../../../scripts/globe-water.ts"), "utf8")).toContain(`const STREAM_TIER = ${STREAM_TIER};`);
    expect(readFileSync(join(import.meta.dir, "water.ts"), "utf8")).toContain(`WATER_SEEDED = { coarse: ${COARSE_TIER},`);
    expect(readFileSync(join(import.meta.dir, "../../../scripts/globe-water-stream.ts"), "utf8")).toContain('arg("block", "4")');
  });

  for (const tier of [4, 5]) {
    test(`nothing a later stage or the viewer reads is spent (tier ${tier})`, () => {
      const all = realStages(cfgOf(tier)).filter((s) => !s.skip), viewer = ["pyramid", "pyramid.json", "groundtiles"];
      const matches = (sp: { name: string; except?: string[] }, f: string) => (sp.name.endsWith("*") ? f.startsWith(sp.name.slice(0, -1)) && !(sp.except ?? []).includes(f) : f === sp.name);
      all.forEach((last, i) => {
        for (const sp of last.spent) {
          expect(viewer.some((v) => sp.name === v || sp.name.startsWith(`${v}/`))).toBe(false);
          for (const later of all.slice(i + 1)) {
            const reads = [...later.inputs, ...("files" in later.measure ? later.measure.files.map((f) => f.name) : [])];
            expect(reads.filter((f) => matches(sp, f))).toEqual([]); // a file a later stage reads, or whose absence would make a done stage look undone
          }
        }
      });
      // a stage's own done marker is never in a spent list: the done state must survive the deletion
      for (const s of all) for (const sp of s.spent) for (const o of all) if ("tiles" in o.measure) expect(o.measure.tiles.filter((m) => matches(sp, m))).toEqual([]);
    });
  }

  const real = existsSync(REAL);
  (real ? test : test.skip)("on the real tier-4 bake of key 883a8d9387df every file is some stage's, every input is there, and the done states are those of a finished bake", () => {
    const tier4 = realStages(cfgOf(4)), named = new Set<string>();
    for (const s of tier4) for (const n of [...s.outputs, ...s.spent.map((x) => x.name), ...s.whole.map((x) => x.name), ...("tiles" in s.measure ? s.measure.tiles : [])]) for (const m of expand(REAL, n)) named.add(m);
    const tiers = by("tiers", tier4);
    expect(tiers.external!.map((f) => f.replace(PLANET_STORE, ""))).toEqual(PLANET_STAGES.map((n) => `/1-${KEY}/${n}.bin`));
    if (existsSync(`${PLANET_STORE}/1-${KEY}`)) expect(tiers.external!.filter((f) => !existsSync(f))).toEqual([]);
    const stray = readdirSync(REAL).filter((n) => !named.has(n) && !n.startsWith("bake"));
    expect(stray).toEqual([]);
    for (const s of tier4) {
      if (s.name === "discharge" || s.name === "water" || T3.includes(s.name)) continue; // spent by the bake that made this directory (the surplus weights), or made by a route this bake did not take (the tier-3 stages and their heads)
      expect(s.inputs.filter((f) => !existsSync(join(REAL, f)))).toEqual([]);
    }
    const state = Object.fromEntries(evaluate(tier4, REAL).map((e) => [e.stage.name, e.done]));
    expect(state).toMatchObject({ tiers: true, terrain: true, air: true, surplus: true, discharge: true, basin: true, water: true, ground: true, groundtiles: true, pyramid: true, maps: false });
    // the tier-3 stages are done only because the water, which reads them, is: their own files are not there (`own` false)
    expect(evaluate(tier4, REAL).filter((e) => T3.includes(e.stage.name)).map((e) => [e.own, e.implied])).toEqual(T3.map(() => [false, true]));
  });

  (real ? test : test.skip)("a dry run and a status on the real store print every stage and its command, and write nothing", () => {
    const { NOMADS_BAKE: _bake, ...env } = process.env; // the real default root
    const before = readdirSync(REAL).sort().join(), run = (a: string[], tier = "4") => spawnSync(process.execPath, [SCRIPT, "--seed", "1", "--key", KEY, "--tier", tier, ...a], { env, encoding: "utf8" });
    const dry = run(["--dry-run"]);
    expect(dry.status).toBe(0);
    for (const n of ["tiers", ...T3, "terrain", "air", "surplus", "discharge", "basin", "water", "ground", "groundtiles", "pyramid", "maps"]) expect(dry.stdout).toContain(`${n} (`);
    expect(dry.stdout).toContain("lockf /tmp/nomads-gpu.lock bun scripts/globe-stage.ts --stage terrain --seed 1 --key 883a8d9387df");
    expect(dry.stdout).toContain("bun scripts/globe-pyramid.ts --seed 1 --key 883a8d9387df --tier 4 --budget 240");
    expect(dry.stdout).not.toContain("globe-water-stream.ts");
    const five = run(["--dry-run"], "5");
    expect(five.status).toBe(0);
    expect(five.stdout).toMatch(/\n  \$ bun scripts\/globe-water-stream\.ts --stage discharge --seed 1 --key 883a8d9387df --tier 5 --block 4/); // no lockf in front
    const st = run(["--status"]);
    expect(st.status).toBe(0);
    expect(st.stdout).toMatch(/groundtiles\s+CPU\s+done\s+1536\/1536/);
    expect(st.stdout).toMatch(/pyramid\s+CPU\s+done\s+2046\/2046/);
    expect(st.stdout).toMatch(/coarse\s+GPU\s+done\*/);
    expect(readdirSync(REAL).sort().join()).toBe(before);
  });
});

export type { Stage };
