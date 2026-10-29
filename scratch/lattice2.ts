// Land share, land overlap (land in both over land in either) and coast length of tier-0 fields, against a reference. `bun scratch/lattice2.ts ref=path name=path ...` (paths as lattice0.ts)
import { FACES, cellId, tierGrid } from "../src/gpu/globe/grid";
import { neighbours } from "../src/gpu/globe/tectonics";
import { control, chainHeight, f32 } from "./lattice0";
const g = tierGrid(0), nb = neighbours(g), N = FACES * g.fn * g.fn;
const load = (p: string) => (p === "ctl:smooth" ? control(false) : p === "ctl:rough" ? control(true) : p.startsWith("chain:") ? chainHeight(p.slice(6)) : f32(p));
const specs = process.argv.slice(2), ref = load(specs[0].split("=")[1]);
for (const sp of specs) {
  const [name, p] = sp.split("="), h = load(p);
  let land = 0, both = 0, either = 0, coast = 0;
  for (let i = 0; i < N; i++) {
    const l = h[i] > 0, r = ref[i] > 0;
    if (l) land++;
    if (l && r) both++;
    if (l || r) either++;
    for (let d = 0; d < 2; d++) if ((h[nb[4 * i + d]] > 0) !== l) coast++;
  }
  console.log(`${name.padEnd(12)} land ${(land / N).toFixed(4)} overlap-with-ref ${(both / either).toFixed(4)} coastEdges ${coast}`);
}
void cellId;
