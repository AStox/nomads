import { sharp } from "./lib.ts";
const f = process.argv[2]; const pts = process.argv.slice(3).map((s) => s.split(",").map(Number));
const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
for (const [x, y] of pts) { const i = (y * info.width + x) * 3; console.log(x, y, data[i], data[i + 1], data[i + 2]); }
