import { sharp } from "./lib.ts";
const [out, w, ...files] = process.argv.slice(2); const W = +w;
const tiles = await Promise.all(files.map((f) => sharp(f).resize(W).png().toBuffer())); const h = (await sharp(tiles[0]).metadata()).height!;
const cols = Math.min(3, tiles.length), rows = Math.ceil(tiles.length / cols);
await sharp({ create: { width: cols * (W + 4), height: rows * (h + 4), channels: 3, background: "#fff" } }).composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * (W + 4), top: Math.floor(i / cols) * (h + 4) }))).png().toFile(out);
