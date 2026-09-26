// Build the 3D island demo as a static site: the page as written, plus the game's generator bundled for the browser.
//   bun scripts/demo3d.ts --out /root/goldclaw/www/nomads-3d
import { copyFileSync, mkdirSync } from "node:fs";

const at = process.argv.indexOf("--out");
if (at < 0) throw new Error("usage: bun scripts/demo3d.ts --out <dir>");
const out = process.argv[at + 1], src = `${import.meta.dir}/../demo/3d`;
mkdirSync(out, { recursive: true });
const built = await Bun.build({ entrypoints: [`${src}/island.ts`], outdir: out, target: "browser", minify: true });
if (!built.success) throw new AggregateError(built.logs, "bundling the generator failed");
for (const file of ["index.html", "main.js", "look.js", "world.js"]) copyFileSync(`${src}/${file}`, `${out}/${file}`);
console.log(`demo in ${out}`);
