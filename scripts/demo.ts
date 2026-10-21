// Build a demo as a static site: its page files as written, plus the game's generator and simulation bundled for the browser.
//   bun scripts/demo.ts 3d --out /root/goldclaw/www/nomads-3d
//   bun scripts/demo.ts styles --out /root/goldclaw/www/nomads-styles
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Where the planets' bakes are (a directory `<seed>-<key>` each, with its `pyramid` of tiles), and the newest bake of each seed with a tier 0 is
// copied into the site under `planets/<seed>-<key>/pyramid`, tiles that are there already left alone, with `planets/<seed>.json` naming it:
// the tiers it has and the faces that hold tiles (a bake in progress has some).
const BAKES = process.env.NOMADS_BAKES ?? "/tmp/planet-75m";
function copyPyramids(out: string): number[] {
  const newest = new Map<number, { name: string; t: number }>();
  for (const name of existsSync(BAKES) ? readdirSync(BAKES) : []) {
    const m = /^(\d+)-(\w+)$/.exec(name), t0 = join(BAKES, name, "pyramid", "t0");
    if (!m || !existsSync(t0)) continue;
    const t = statSync(t0).mtimeMs, seed = Number(m[1]);
    if ((newest.get(seed)?.t ?? -1) < t) newest.set(seed, { name, t });
  }
  mkdirSync(join(out, "planets"), { recursive: true });
  for (const [seed, { name }] of newest) {
    const from = join(BAKES, name, "pyramid"), to = join(out, "planets", name, "pyramid");
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    const tiers = readdirSync(from).filter((d) => /^t\d+$/.test(d)).length, faces = readdirSync(join(from, "t0")).map((f) => Number(f.slice(1))).sort();
    writeFileSync(join(out, "planets", `${seed}.json`), JSON.stringify({ seed, key: name.split("-")[1], tiers, faces, tiles: name }));
  }
  return [...newest.keys()];
}

const app = process.argv[2], at = process.argv.indexOf("--out");
if (!app || at < 0) throw new Error("usage: bun scripts/demo.ts <3d|looks|styles> --out <dir>");
const out = process.argv[at + 1], root = `${import.meta.dir}/../demo`;
mkdirSync(out, { recursive: true });
// The page's GPU is navigator.gpu (src/gpu/device.ts); Dawn's bindings are for Bun alone and never load in a page.
const built = await Bun.build({ entrypoints: [`${root}/island.ts`], outdir: out, target: "browser", minify: true, external: ["webgpu"] });
if (!built.success) throw new AggregateError(built.logs, "bundling the generator failed");
// node:fs only writes trace logs after logTo(), which the browser never calls.
const noFs: Bun.BunPlugin = {
  name: "no-fs",
  setup(b) {
    b.onResolve({ filter: /^node:fs$/ }, () => ({ path: "fs", namespace: "no-fs" }));
    b.onLoad({ filter: /.*/, namespace: "no-fs" }, () => ({ loader: "js", contents: "const no = () => {};\nexport { no as appendFileSync, no as existsSync, no as mkdirSync, no as renameSync, no as statSync };" }));
  },
};
const sim = await Bun.build({
  entrypoints: [`${root}/sim.ts`], outdir: out, target: "browser", minify: true, plugins: [noFs],
  // The random brain answers locally, so the browser never reaches Jev.
  define: { "process.env.NOMADS_BRAIN": '"random"' },
  external: ["webgpu"],
});
if (!sim.success) throw new AggregateError(sim.logs, "bundling the simulation failed");
cpSync(`${root}/${app}`, out, { recursive: true });
if (app === "styles") {
  // the planet layer's share of the generator (isopixel/planet.js) and the baked planets' tile pyramids it streams (src/gpu/globe/pyramid.ts)
  const globe = await Bun.build({ entrypoints: [`${root}/globe.ts`], outdir: out, target: "browser", minify: true, external: ["webgpu"] });
  if (!globe.success) throw new AggregateError(globe.logs, "bundling the globe failed");
  const seeds = copyPyramids(out);
  console.log(seeds.length ? `pyramid of seed ${seeds.join(", ")} in ${out}/planets` : `no pyramid baked under ${BAKES}: build one with scripts/globe-pyramid.ts, then build again`);
}
console.log(`${app} demo in ${out}`);
