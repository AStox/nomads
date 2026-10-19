// A seed's planet for the play page: the planet built by stages into the store of scripts/globe-window.ts (each call
// under five minutes: run it again until it says baked), then exported as the files the page reads (src/gpu/globe/bake.ts)
// into ~/.cache/nomads-globe/<seed>-<key>/ gzipped (the page inflates them), from where scripts/demo.ts copies the newest
// export of each seed into the site.
//   bun scripts/globe-bake.ts --seed 1                  # build what is not kept, export once all of it is
//   bun scripts/globe-bake.ts --seed 1 --key <key>      # export a planet the globe's sources made before they changed
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { planetBytes, viewBytes } from "../src/gpu/globe/bake";
import { STAGES, buildStage, readPlanet, type PlanetStore } from "../src/gpu/globe/window";
import { diskStore, sourceKey } from "./globe-window";

export const GLOBE_CACHE = process.env.NOMADS_GLOBE ?? join(homedir(), ".cache", "nomads-globe");
const PLANETS = process.env.NOMADS_PLANETS ?? "/tmp/globe-window/planets";
// What one call may spend, s, and what each whole stage takes on the M3 Pro (the ice stage runs in parts of what is left)
// [design: the operator's five-minute rule with a margin; the window note's timings].
const BUDGET_S = 270, STAGE_S: Record<string, number> = { chain: 200, climate0: 60, climate1: 60 };

const kept = async (store: PlanetStore, seed: number) => (await Promise.all(STAGES.map((s) => store.get(seed, s)))).every((b) => b !== null);

export async function exportPlanet(seed: number, key: string, store: PlanetStore): Promise<string> {
  const planet = await readPlanet(seed, store), dir = join(GLOBE_CACHE, `${seed}-${key}`);
  mkdirSync(dir, { recursive: true });
  // packRecord's bytes always own a plain ArrayBuffer
  writeFileSync(join(dir, "view.bin.gz"), Bun.gzipSync(viewBytes(planet, key) as Uint8Array<ArrayBuffer>));
  writeFileSync(join(dir, "planet.bin.gz"), Bun.gzipSync(planetBytes(planet) as Uint8Array<ArrayBuffer>));
  return dir;
}

// The newest export of each seed into <out>/planets: view-<seed>-<key>.bin.gz, planet-<seed>-<key>.bin.gz and <seed>.json
// naming them (their names carry the key, so a copy a browser keeps is never another planet's). Returns the seeds copied.
export function copyGlobes(out: string): number[] {
  if (!existsSync(GLOBE_CACHE)) return [];
  const newest = new Map<number, { key: string; dir: string; t: number }>();
  for (const name of readdirSync(GLOBE_CACHE)) {
    const m = /^(\d+)-(\w+)$/.exec(name), dir = join(GLOBE_CACHE, name);
    if (!m || !existsSync(join(dir, "view.bin.gz")) || !existsSync(join(dir, "planet.bin.gz"))) continue;
    const seed = Number(m[1]), t = statSync(join(dir, "view.bin.gz")).mtimeMs;
    if ((newest.get(seed)?.t ?? -1) < t) newest.set(seed, { key: m[2], dir, t });
  }
  const to = join(out, "planets");
  mkdirSync(to, { recursive: true });
  for (const [seed, { key, dir }] of newest) {
    const view = `view-${seed}-${key}.bin.gz`, planet = `planet-${seed}-${key}.bin.gz`;
    copyFileSync(join(dir, "view.bin.gz"), join(to, view));
    copyFileSync(join(dir, "planet.bin.gz"), join(to, planet));
    writeFileSync(join(to, `${seed}.json`), JSON.stringify({ seed, key, view, planet }));
  }
  return [...newest.keys()];
}

async function main() {
  const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
  const seed = Number(arg("seed", "1")), key = arg("key", "") || sourceKey(), store = diskStore(PLANETS, key), t0 = performance.now();
  const spent = () => (performance.now() - t0) / 1000;
  if (!(await kept(store, seed))) {
    if (arg("key", "")) throw new Error(`planet ${seed} of key ${key} is not wholly kept in ${store.dir(seed)}`);
    const gpu = await theGpu();
    for (const stage of STAGES) {
      if (await store.get(seed, stage)) continue;
      const left = BUDGET_S - spent();
      if (left < (STAGE_S[stage] ?? 60)) break;
      const done = await buildStage(gpu, seed, stage, store, left - 60);
      console.log(`planet ${seed} ${stage}: ${done ? "kept" : "part kept"} at ${spent().toFixed(0)} s`);
      if (!done) break;
    }
    if (!(await kept(store, seed))) { console.log(`planet ${seed} (key ${key}) not yet wholly built: run this again`); return; }
  }
  const dir = await exportPlanet(seed, key, store);
  console.log(`planet ${seed} baked into ${dir} in ${spent().toFixed(0)} s; rebuild the site to serve it`);
}

if (import.meta.main) {
  try { await main(); } finally { await releaseGpu(); }
  process.exit(0);
}
