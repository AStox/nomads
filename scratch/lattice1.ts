// Longest exact coast runs and cliff runs of a tier-0 field: the places where the tier-0 lattice is the coast. `bun scratch/lattice1.ts name=path ...` (paths as lattice0.ts)
import { FACES, cellId, tierGrid } from "../src/gpu/globe/grid";
import { neighbours } from "../src/gpu/globe/tectonics";
import { control, chainHeight, f32 } from "./lattice0";
const fn = 256, g = tierGrid(0), nb = neighbours(g);
// Runs of land/sea edges on one lattice line whose two sides differ by more than `jump` m; reports the edge share in runs and the longest runs.
export function runs(h: Float32Array, jump: number, level = 0) {
  const out: { len: number; f: number; axis: string; line: number; at: number; dh: number }[] = [];
  for (const [dir, axis] of [[0, "col"], [1, "row"]] as const) {
    for (let f = 0; f < FACES; f++) for (let l = 0; l < fn; l++) {
      let run = 0, start = 0, dsum = 0;
      const flush = () => { if (run) out.push({ len: run, f, axis, line: l, at: start, dh: dsum / run }); run = 0; dsum = 0; };
      for (let p = 0; p < fn; p++) {
        const X = dir === 0 ? l : p, Y = dir === 0 ? p : l;
        const c = cellId(g, f, X, Y), o = nb[4 * c + dir], ok = dir === 0 ? X < fn - 1 : Y < fn - 1;
        const a = h[c], b = h[o], coast = ok && (a > level) !== (b > level) && Math.abs(a - b) > jump;
        if (coast) { if (!run) start = p; run++; dsum += Math.abs(a - b); } else flush();
      }
      flush();
    }
  }
  return out.sort((a, b) => b.len - a.len);
}
if (import.meta.main) {
  const H = process.env.HOME!;
  const specs = process.argv.slice(2).length ? process.argv.slice(2) : [`new=${H}/.cache/nomads-scratch/t7/raw/height.f32`, `old=chain:${H}/.cache/nomads-bakes/small/store/1-1121d207f3b8`, "ctl-rough=ctl:rough"];
  for (const sp of specs) {
    const [name, p] = sp.split("=");
    const h = p === "ctl:smooth" ? control(false) : p === "ctl:rough" ? control(true) : p.startsWith("chain:") ? chainHeight(p.slice(6)) : f32(p);
    for (const [jump, level] of [[0, 0], [300, 0], [0, -100], [0, -1000]]) {
      const r = runs(h, jump, level), tot = r.reduce((a, b) => a + b.len, 0);
      const n = (L: number) => r.filter((x) => x.len >= L).reduce((a, b) => a + b.len, 0);
      console.log(`${name} level ${level} jump>${jump}: edges ${tot}; in runs >=6 ${n(6)} >=10 ${n(10)} >=16 ${n(16)}; top: ${r.slice(0, 6).map((x) => `${x.len}@f${x.f}${x.axis}${x.line}[${x.at}] dh${x.dh.toFixed(0)}`).join(" ")}`);
    }
  }
}
