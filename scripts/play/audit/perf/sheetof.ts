// A contact sheet of the screenshots arrcorr.ts saved: sheetof.ts <dir> <prefix> <out.jpg> [every=2] [cols=6]
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
const [dir, prefix, out, every = "2", cols = "6"] = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".jpg")).sort().filter((_, i) => i % Number(every) === 0);
const W = 300, H = 200, C = Number(cols), rows = Math.ceil(files.length / C);
const tiles = await Promise.all(files.map(async (f, i) => ({ input: await sharp(join(dir, f)).resize(W, H).composite([{ input: Buffer.from(`<svg width="${W}" height="${H}"><text x="4" y="16" font-size="14" fill="yellow" stroke="black" stroke-width="0.5">${f.split("-").at(-1)!.replace(".jpg", "")}</text></svg>`) }]).jpeg().toBuffer(), left: (i % C) * W, top: Math.floor(i / C) * H })));
await sharp({ create: { width: W * C, height: H * rows, channels: 3, background: "#222" } }).composite(tiles).jpeg({ quality: 85 }).toFile(out);
console.log(files.length, "frames ->", out);
