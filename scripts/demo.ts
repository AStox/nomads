// Build a demo as a static site: its page files as written, plus the game's generator and simulation bundled for the browser.
//   bun scripts/demo.ts 3d --out /root/goldclaw/www/nomads-3d
//   bun scripts/demo.ts styles --out /root/goldclaw/www/nomads-styles
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Where the planets' bakes are (a directory `<seed>-<key>` each): the newest bake of each seed whose pyramid is finished (`pyramid/../pyramid.json`; or the key in NOMADS_PLANET)
// is linked into the site under `planets/link-<seed>-<key>/` (its tile `pyramid` and its `groundtiles`, symlinks, a bake being a gigabyte or more), with `planets/<seed>.json`
// naming it: the tiers it has and the faces that hold tiles (a bake in progress has some).
const BAKES = process.env.NOMADS_BAKES ?? join(process.env.HOME ?? "/tmp", ".cache", "nomads-bakes");
function linkPlanets(out: string): number[] {
  const newest = new Map<number, { name: string; t: number }>();
  for (const name of existsSync(BAKES) ? readdirSync(BAKES) : []) {
    const m = /^(\d+)-(\w+)$/.exec(name), done = join(BAKES, name, "pyramid.json");
    if (!m || !existsSync(done) || (process.env.NOMADS_PLANET && m[2] !== process.env.NOMADS_PLANET)) continue;
    const t = statSync(done).mtimeMs, seed = Number(m[1]);
    if ((newest.get(seed)?.t ?? -1) < t) newest.set(seed, { name, t });
  }
  mkdirSync(join(out, "planets"), { recursive: true });
  for (const [seed, { name }] of newest) {
    const dir = join(BAKES, name), link = join(out, "planets", `link-${name}`);
    mkdirSync(link, { recursive: true });
    // The pyramid is linked under its format's version (pyramid-v2): a visitor's browser cache (tilecache.js keeps files by their path) and any HTTP cache never hand a v1 tile to a v2 page. A bake
    // holds its pyramid as `pyramid` (marker pyramid.json) or, beside an older one, as `pyramid-v<N>` (marker pyramid-v<N>.json); the highest version is the one linked, so a newer pyramid is put
    // beside the old and the old stays where it is until the site that shows the new has been checked.
    const versions = readdirSync(dir).flatMap((d) => {
      const v = /^pyramid(?:-v(\d+))?$/.exec(d), marker = join(dir, d === "pyramid" ? "pyramid.json" : `${d}.json`);
      if (!v || !existsSync(marker)) return [];
      return [{ d, version: (JSON.parse(readFileSync(marker, "utf8")) as { version?: number }).version ?? Number(v[1] ?? 1) }];
    }).sort((x, y) => y.version - x.version);
    const { d: src, version } = versions[0], pyramid = `pyramid-v${version}`;
    for (const [d, as] of [[src, pyramid], ["groundtiles", "groundtiles"]]) if (existsSync(join(dir, d)) && !existsSync(join(link, as))) symlinkSync(join(dir, d), join(link, as));
    const tiers = readdirSync(join(dir, src)).filter((d) => /^t\d+$/.test(d)).length, faces = readdirSync(join(dir, src, "t0")).map((f) => Number(f.slice(1))).sort();
    writeFileSync(join(out, "planets", `${seed}.json`), JSON.stringify({ seed, key: name.split("-")[1], tiers, faces, tiles: `link-${name}`, pyramid, groundtiles: existsSync(join(dir, "groundtiles")) }));
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
    b.onLoad({ filter: /.*/, namespace: "no-fs" }, () => ({ loader: "js", contents: "const no = () => {};\nexport { no as appendFileSync, no as existsSync, no as mkdirSync, no as renameSync, no as statSync, no as writeFileSync, no as openSync, no as readSync, no as closeSync, no as readdirSync, no as readFileSync, no as rmSync, no as ftruncateSync, no as writeSync };" }));
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
  const tile = await Bun.build({ entrypoints: [`${root}/tile.ts`], outdir: out, target: "browser", minify: true, plugins: [noFs], define: { "process.env.NOMADS_BAKE": "undefined", "process.env.HOME": "undefined" }, external: ["webgpu"] });
  if (!tile.success) throw new AggregateError(tile.logs, "bundling the tile scatter failed");
  const seeds = linkPlanets(out);
  console.log(seeds.length ? `pyramid of seed ${seeds.join(", ")} in ${out}/planets` : `no finished pyramid under ${BAKES}: build one with scripts/globe-pyramid.ts, then build again`);
}
console.log(`${app} demo in ${out}`);
