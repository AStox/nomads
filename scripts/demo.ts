// Build a demo as a static site: its page files as written, plus the game's generator and simulation bundled for the browser.
//   bun scripts/demo.ts 3d --out /root/goldclaw/www/nomads-3d
//   bun scripts/demo.ts styles --out /root/goldclaw/www/nomads-styles
import { cpSync, mkdirSync } from "node:fs";
import { copyGlobes } from "./globe-bake";

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
  // the play page's globe (play/globe.js) and the baked planets it reads (scripts/globe-bake.ts)
  const globe = await Bun.build({ entrypoints: [`${root}/globe.ts`], outdir: out, target: "browser", minify: true, external: ["webgpu"] });
  if (!globe.success) throw new AggregateError(globe.logs, "bundling the globe failed");
  const seeds = copyGlobes(out);
  console.log(seeds.length ? `globe of seed ${seeds.join(", ")} in ${out}/planets` : "no planet baked: run bun scripts/globe-bake.ts --seed 1 until it says baked, then build again");
}
console.log(`${app} demo in ${out}`);
