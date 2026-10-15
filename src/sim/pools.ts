// The animals still counted a tile at a time: each water tile's fish (fish.ts; Unit 11 makes them individuals) and each
// land tile's butterflies (insects, Unit 12b), and those people see of them stood on the ground as whole animals. The
// deer, rabbits, wolves, foxes and birds are individuals on the GPU (animals.ts); the butterflies step there too.
import { DAY, H, TILE_M, W, YEAR_DAYS, dryAt, type Animal, type AnimalSpecies, type World } from "./world";
import { revealFish, startFish } from "./fish";

// fish: each water tile's fish, kg a ha (fish.ts); fishEaten: what the animals ate of them since the fish last stepped;
// butterfly: the adults on the wing over each tile; gdd: the degree-days over 10 C each tile has had since midwinter;
// day: the island day the butterflies last stepped to; den: where the island's first pack denned, in tiles.
export type Pools = { fish: number[]; fishEaten: number[]; butterfly: number[]; gdd: number[]; day: number; den: [number, number] };
const blank = () => new Array<number>(W * H).fill(0);
export function startPools(w: World, den: [number, number]): Pools {
  const p: Pools = { fish: blank(), fishEaten: blank(), butterfly: blank(), gdd: blank(), day: ((w.t / DAY) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS, den };
  startFish(w, p.fish);
  return p;
}
export const tileOf = (a: { px: number; py: number }) => Math.min(H - 1, Math.max(0, Math.floor(a.py))) * W + Math.min(W - 1, Math.max(0, Math.floor(a.px)));

// Stand each tile's butterflies and the water's fish on the ground within sight of anyone awake, as whole animals, and
// take them back off it once no one sees them; put: how one is put down there. A tile shows the share of its count
// that stands on the part of it in sight (judged at K x K points over it).
const REVEAL_K = 4;
// The fish people see stand in the shallows within a basket's sweep of them (physics.ts FISH_REACH) [design]; butterflies
// are seen from 30 m [design].
const SHALLOWS = 15, BUTTERFLY_SEEN = 30;
export function reveal(w: World, put: (sp: AnimalSpecies, px: number, py: number) => Animal, rand = Math.random) {
  const p = w.pools;
  if (!p) return;
  revealFish(w, p.fish, SHALLOWS, (px, py) => put("fish", px, py), rand);
  const awake = w.agents.filter((a) => a.down <= w.t), r = BUTTERFLY_SEEN / TILE_M, count = p.butterfly;
  const near = (x: number, y: number) => awake.some((a) => (a.px - x) ** 2 + (a.py - y) ** 2 <= r * r);
  const out = new Set(w.animals.filter((an) => an.species === "butterfly" && !near(an.px, an.py)));
  if (out.size) w.animals = w.animals.filter((x) => !out.has(x));
  const here = new Map<number, Animal[]>(), seen = new Set<number>();
  for (const an of w.animals) if (an.species === "butterfly") { const i = tileOf(an), l = here.get(i); if (l) l.push(an); else here.set(i, [an]); }
  for (const a of awake) for (let y = Math.floor(a.py - r); y <= Math.floor(a.py + r); y++) for (let x = Math.floor(a.px - r); x <= Math.floor(a.px + r); x++) if (x >= 0 && y >= 0 && x < W && y < H) seen.add(y * W + x);
  for (const i of seen) {
    const pts: [number, number][] = [];
    for (let u = 0; u < REVEAL_K; u++) for (let v = 0; v < REVEAL_K; v++) { const px = (i % W) + (u + 0.5) / REVEAL_K, py = Math.floor(i / W) + (v + 0.5) / REVEAL_K; if (near(px, py) && dryAt(w, px, py)) pts.push([px, py]); }
    if (!pts.length) continue;
    const n = count[i], show = (n * pts.length) / (REVEAL_K * REVEAL_K), ans = here.get(i) ?? [];
    let have = ans.length;
    if (have > Math.ceil(n)) { const gone = new Set(ans.slice(0, have - Math.ceil(n))); w.animals = w.animals.filter((x) => !gone.has(x)); have -= gone.size; }
    const want = Math.floor(show) + (!ans.length && rand() < show - Math.floor(show) ? 1 : 0);
    for (let k = 0; have < want && k < 30; k++) {
      const [cx, cy] = pts[Math.floor(rand() * pts.length)], px = cx + (rand() - 0.5) / REVEAL_K, py = cy + (rand() - 0.5) / REVEAL_K;
      if (!dryAt(w, px, py) || !near(px, py)) continue;
      put("butterfly", px, py).hunger = 100;
      have++;
    }
  }
}
