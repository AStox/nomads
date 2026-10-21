// A stage of the bake driver's tests that makes a few 'tiles' and nothing real: it keeps its progress in `<name>-done.u8` as the real tile stages do, so it can be killed at any moment and called again.
//   bun fake-stage.ts --dir <bake dir> --name a --tiles 6 [--per-call 2] [--sleep 60] [--reads f,g] [--writes f,g] [--fail-first K] [--die-after K] [--bulk BYTES]
//   --mode files --writes f --size B      one whole file of B bytes (a stage whose done is a file at its size)
//   --mode count --count-dir d --tiles N  files d/<k>.tile.gz, `per-call` a call, then d.json beside the directory when all are there
//   --mode marker                         sleeps and exits 0 (the driver writes the marker)
//   --reads f,g       every one must exist at the start of the call and before each tile, else exit 9 (a spent file deleted before its consumer was done shows here)
//   --fail-first K    the first K calls exit 1 at once, with no progress (calls are counted in `<name>-calls.txt`)
//   --die-after K     exit 3 after K tiles of a call (a crash with progress kept)
import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string, d = "") => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg("dir"), name = arg("name"), mode = arg("mode", "tiles"), tiles = Number(arg("tiles", "1")), perCall = Number(arg("per-call", "1000000")), sleep = Number(arg("sleep", "0"));
const reads = arg("reads") ? arg("reads").split(",") : [], writes = arg("writes") ? arg("writes").split(",") : [];
mkdirSync(dir, { recursive: true });
const path = (f: string) => join(dir, f);
const needInputs = () => { for (const f of reads) if (!existsSync(path(f))) { console.log(`ERROR ${name}: input ${f} is missing`); process.exit(9); } };

const callsFile = path(`${name}-calls.txt`), callNo = (existsSync(callsFile) ? readFileSync(callsFile, "utf8").length : 0) + 1;
appendFileSync(callsFile, "x");
console.log(`${name} call ${callNo} (${mode})`);
needInputs();
if (callNo <= Number(arg("fail-first", "0"))) { console.log(`${name}: failing on purpose`); process.exit(1); }
if (arg("bulk")) writeFileSync(path(`${name}-bulk.bin`), new Uint8Array(Number(arg("bulk"))).fill(7));

if (mode === "tiles") {
  const doneFile = path(`${name}-done.u8`), done = existsSync(doneFile) ? new Uint8Array(readFileSync(doneFile)) : new Uint8Array(tiles);
  const fds = writes.map((f) => { const fd = openSync(path(f), "a+"); ftruncateSync(fd, tiles); return fd; });
  let made = 0;
  for (let k = 0; k < tiles && made < perCall; k++) {
    if (done[k]) continue;
    needInputs();
    await Bun.sleep(sleep);
    for (const fd of fds) writeSync(fd, new Uint8Array([k + 1]), 0, 1, k);
    done[k] = 1;
    writeFileSync(doneFile, done);
    made++;
    console.log(`${name} tile ${k}`);
    if (made === Number(arg("die-after", "-1"))) process.exit(3);
  }
  for (const fd of fds) closeSync(fd);
} else if (mode === "files") {
  await Bun.sleep(sleep);
  for (const f of writes) if (!existsSync(path(f))) writeFileSync(path(f), new Uint8Array(Number(arg("size", "100"))).fill(3));
} else if (mode === "count") {
  const cdir = path(arg("count-dir")), have = (k: number) => existsSync(join(cdir, `${k}.tile.gz`));
  mkdirSync(cdir, { recursive: true });
  let made = 0;
  for (let k = 0; k < tiles && made < perCall; k++) if (!have(k)) { await Bun.sleep(sleep); writeFileSync(join(cdir, `${k}.tile.gz`), `tile ${k}`); made++; console.log(`${name} file ${k}`); }
  if (Array.from({ length: tiles }, (_, k) => k).every(have)) writeFileSync(path(`${arg("count-dir")}.json`), "{}");
} else await Bun.sleep(sleep);
console.log(`${name} call ${callNo} done`);
