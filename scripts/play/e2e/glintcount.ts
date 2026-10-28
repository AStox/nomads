import { sharp } from "./lib.ts";
for (const f of process.argv.slice(2)) {
  const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const W = info.width, H = info.height; let n = 0, orange = 0, blue = 0;
  for (let y = 70; y < H - 30; y++) for (let x = 1; x < W - 1; x++) { const i = (y * W + x) * 3, r = data[i], g = data[i + 1], b = data[i + 2]; if (Math.max(r, g, b) > 170 && Math.min(r, g, b) > 110) { n++; if (r > b + 30) orange++; if (b > r + 40) blue++; } }
  console.log(f, "bright px", n, "orange", orange, "bluish", blue);
}
