// Build a demo as a static site: its page files as written, plus the game's generator and simulation bundled for the browser.
//   bun scripts/demo.ts 3d --out /root/goldclaw/www/nomads-3d
//   bun scripts/demo.ts styles --out /root/goldclaw/www/nomads-styles
import { cpSync, mkdirSync } from "node:fs";

const app = process.argv[2], at = process.argv.indexOf("--out");
if (!app || at < 0) throw new Error("usage: bun scripts/demo.ts <3d|looks|styles> --out <dir>");
const out = process.argv[at + 1], root = `${import.meta.dir}/../demo`;
mkdirSync(out, { recursive: true });
const built = await Bun.build({ entrypoints: [`${root}/island.ts`], outdir: out, target: "browser", minify: true });
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
});
if (!sim.success) throw new AggregateError(sim.logs, "bundling the simulation failed");
cpSync(`${root}/${app}`, out, { recursive: true });
console.log(`${app} demo in ${out}`);
