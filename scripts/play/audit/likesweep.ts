// The zoom sweep's luma step with the content taken out. zoomsweep.ts's dLuma is the whole frame's mean against the last frame's, and a zoom in on a place whose middle is brighter than its edges (a
// sunlit slope at the middle of a dark ravine) raises it with no change in the picture of the ground: the A mountain's 3.6 to 4.8 ramp of 10 luma a step is that. Here each frame is compared with the
// next over the ground both show: the wider frame's middle (the share 1 / 2^dz, the camera being parallel from zoom 3 and the zoom a uniform scale about the screen's middle) against the finer frame
// whole. What is left is what the renderer changed (its light, its colours, its trees), not what the camera cropped.
//   bun scripts/play/audit/likesweep.ts <sweepDir> [--from 3] [--to 5.1] [--over 2.5]
// <sweepDir> is a zoomsweep.ts output (data.json and its frames); only steps whose frames are in the ladder's window mode (a parallel camera) are read. Prints every step and ringed those over --over.
import { homedir } from "node:os";
import { join } from "node:path";

// sharp is a global install, so its path is known only at run time
const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;

interface Sample { z: number; dir: "in" | "out"; mode: string; luma: number; file: string }
const args = process.argv.slice(2);
const at = (n: string, d: number) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const dir = args[0];
if (!dir || dir.startsWith("--")) { console.error("usage: likesweep.ts <sweepDir> [--from 3] [--to 5.1] [--over 2.5]"); process.exit(2); }
const FROM = at("--from", 3), TO = at("--to", 5.1), OVER = at("--over", 2.5);
const data = JSON.parse(await Bun.file(join(dir, "data.json")).text()) as { samples: Sample[] };
const rows = data.samples.filter((s) => s.mode === "win" && s.z >= FROM - 1e-6 && s.z <= TO + 1e-6);

// the mean luma of the middle 1 / k of a frame
async function lumaOfMiddle(file: string, k: number): Promise<number> {
  const img = sharp(join(dir, file));
  const { width, height } = await img.metadata();
  const w = Math.round(width / k), h = Math.round(height / k);
  const { data: px } = await sharp(join(dir, file)).extract({ left: Math.round((width - w) / 2), top: Math.round((height - h) / 2), width: w, height: h }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < px.length; i += 3) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  return sum / (px.length / 3);
}

let over = 0;
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  if (a.dir !== b.dir) continue;
  const wide = a.z < b.z ? a : b, fine = a.z < b.z ? b : a;
  const k = 2 ** (fine.z - wide.z);
  const like = (await lumaOfMiddle(fine.file, 1)) - (await lumaOfMiddle(wide.file, k));
  // the sign is the way the zoom went: zooming in the picture got `like` brighter, zooming out darker
  const step = a.z < b.z ? like : -like;
  const flag = Math.abs(step) > OVER;
  if (flag) over++;
  console.log(`${b.dir} ${a.z} to ${b.z}: whole frame ${(b.luma - a.luma).toFixed(1)}, same ground ${step.toFixed(2)}${flag ? "  <--" : ""}`);
}
console.log(`${over} steps of the same ground over ${OVER} luma`);
process.exit(0);
