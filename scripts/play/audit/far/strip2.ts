import { sharp } from "./lib.ts";
const [out, H, ...files] = process.argv.slice(2); const hh = +H;
const tiles = await Promise.all(files.map((f) => sharp(f).resize({ height: hh }).png().toBuffer())); const ws = await Promise.all(tiles.map(async (t) => (await sharp(t).metadata()).width!));
let x = 0; const comp = tiles.map((t, i) => { const c = { input: t, left: x, top: 0 }; x += ws[i] + 6; return c; });
await sharp({ create: { width: x, height: hh, channels: 3, background: "#fff" } }).composite(comp).png().toFile(out);
