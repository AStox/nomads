import { sharp } from "./lib";
const files = process.argv.slice(3), out = process.argv[2];
const cells = await Promise.all(files.map(async (f) => sharp(f).resize(400, 250).toBuffer()));
const cols = 3, rows = Math.ceil(cells.length / cols);
await sharp({ create: { width: cols * 400, height: rows * 250, channels: 3, background: "#222" } }).composite(cells.map((b, i) => ({ input: b, left: (i % cols) * 400, top: Math.floor(i / cols) * 250 }))).jpeg({ quality: 82 }).toFile(out);
