// The island every style mock draws, as plain data with no renderer: the generator's fields, the finer ground under
// them, streams, every tree, shrub and rock, and a camp. Styles differ in everything they draw; the world is the same.
// The fine ground and everything growing on it come from the game's own flora.ts, so the mocks and the game agree.
import { CELL, COVERS, FLORA, N, SIZE, SPECIES, START, STEP, K, M, clamp, fbm, fineGround, generateIsland, hash, noise, rng, scatter, smooth } from "./island.js";

export { COVERS, clamp, fbm, hash, noise, smooth };

// How heathy each kind of shrub looks, 0 leafy to 1 heather.
const HEATH = { berry: 0.1, hazel: 0.25, gorse: 0.7, heather: 0.9 };

export function grow(seed = 1) {
  const isle = generateIsland(rng(seed)), rand = rng(seed ^ 0x51f15e);
  const g = fineGround(isle);
  const { h, cover, wet, river, moist, at, bilinear, bicubic, fine, heightAt, slopeAt, dry, riverAt, rivers, riverWidth } = g;
  const Hc = isle.height, wetC = Float32Array.from(isle.water, (w) => (w > 0 ? 1 : 0));

  // How much sky each vertex sees: the highest horizon along eight bearings, out to 450 m.
  const sky = new Float32Array(M * M);
  const reach = [20, 40, 70, 110, 160, 230, 320, 450];
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const i = v * M + u, x = START + u * STEP, z = START + v * STEP, h0 = h[i];
      let open = 0;
      for (let d = 0; d < 8; d++) {
        const dx = Math.cos((d * Math.PI) / 4), dz = Math.sin((d * Math.PI) / 4);
        let rise = 0;
        for (const r of reach) rise = Math.max(rise, (heightAt(x + dx * r, z + dz * r) - h0) / r);
        open += 1 - Math.sin(Math.atan(rise));
      }
      sky[i] = open / 8;
    }

  // ---------- the camp ----------
  // A camp on a meadow near water, with woods close by and hills behind: the kind of spot people would pick.
  let best = null;
  for (let cy = 12; cy < N - 12; cy++)
    for (let cx = 12; cx < N - 12; cx++) {
      const k = cy * N + cx;
      if (isle.grass[k] < 0.35 || isle.water[k] > 0 || Hc[k] < 3) continue;
      const x = START + cx * CELL, z = START + cy * CELL;
      if (slopeAt(x, z) > 0.12) continue;
      let woods = 0, water = 99, rise = 0;
      for (let dy = -5; dy <= 5; dy++)
        for (let dx = -5; dx <= 5; dx++) {
          const j = at(isle.tree, cx + dx, cy + dy), d = Math.hypot(dx, dy);
          if (j > 0.5 && d <= 4) woods++;
          if ((at(wetC, cx + dx, cy + dy) > 0 || riverAt(x + dx * CELL, z + dy * CELL) > 0.3) && d < water) water = d;
          rise = Math.max(rise, at(Hc, cx + dx * 2, cy + dy * 2) - Hc[k]);
        }
      const score = Math.min(woods, 20) + Math.min(rise, 120) / 8 + (water <= 2 ? 10 : water <= 4 ? 5 : 0) + rand();
      if (!best || score > best.score) best = { score, x, z };
    }
  const camp = { x: best.x, y: heightAt(best.x, best.z), z: best.z };
  // Which way the ground rises from the camp (`uphill`), and the open side to look at it from (`from`), so hills stand
  // behind it in a view.
  let uphill = 0, most = -Infinity;
  for (let d = 0; d < 16; d++) {
    const a = (d / 16) * Math.PI * 2, gain = heightAt(camp.x + Math.cos(a) * 900, camp.z + Math.sin(a) * 900);
    if (gain > most) { most = gain; uphill = a; }
  }
  const wooded = (a, dist) => { let s = 0; for (let k = 1; k <= 10; k++) s += fine(cover.tree, camp.x + (Math.cos(a) * dist * k) / 10, camp.z + (Math.sin(a) * dist * k) / 10); return s / 10; };
  let from = uphill + Math.PI, shut = Infinity;
  for (let d = -5; d <= 5; d++) {
    const a = uphill + Math.PI + d * 0.25, cost = wooded(a, 70) + 0.4 * wooded(a, 400) + 0.03 * Math.abs(d);
    if (cost < shut) { shut = cost; from = a; }
  }

  // ---------- what grows and lies about, everywhere ----------
  // The game's own objects, minus the ground people have cleared around the mock camp, thinning out toward its edge.
  // Built on first use: pages that draw the game's objects straight from the sim never pay for these lists.
  const cleared = (x, z, r0, r1) => { const d = Math.hypot(x - camp.x, z - camp.z); return d < r0 || (d < r1 && hash(Math.round(x * 10), Math.round(z * 10), 5) < (r1 - d) / (r1 - r0)); };
  let flora = null;
  const lists = () => {
    if (flora) return flora;
    const s = scatter(isle, g, seed), trees = [], shrubs = [], rocks = [];
    for (let i = 0; i < s.n; i++) {
      const kind = FLORA[s.kind[i]], x = s.x[i], z = s.z[i], seedI = s.seed[i];
      const yaw = ((seedI & 0xffff) / 65536) * 6.283, tint = (seedI >>> 16) / 65536, sp = SPECIES[s.species[i]];
      if (kind === "tree" && !cleared(x, z, 22, 40)) trees.push({ x, y: heightAt(x, z), z, tall: s.size[i], kind: sp, yaw, tint });
      else if (kind === "bush" && !cleared(x, z, 14, 26)) shrubs.push({ x, y: heightAt(x, z), z, tall: s.size[i], heath: HEATH[sp] ?? 0.3, species: sp, yaw, tint });
      else if (kind === "boulder" && !cleared(x, z, 12, 20)) rocks.push({ x, y: heightAt(x, z), z, size: s.size[i], yaw, tint });
    }
    return (flora = { trees, shrubs, rocks });
  };

  // Near the camp, the small stuff only a close look can see: grass tufts, flowers, pebbles, fallen wood. Nothing grows
  // where people have trodden: round the fire, under the tents, by the woodpile.
  const trodden = (x, z) => Math.hypot(x - camp.x, z - camp.z) < 3.4 || Math.hypot(x - camping.woodpile.x, z - camping.woodpile.z) < 1.4 || tents.some((t) => Math.hypot(x - t.at.x, z - t.at.z) < t.size * 0.62);
  function nearby(center, radius, density = 3) {
    const grass = [], flowers = [], pebbles = [], logs = [];
    const r2 = radius * radius;
    for (let n = 0; n < r2 * 4 * density; n++) {
      const x = center.x + (rand() * 2 - 1) * radius, z = center.z + (rand() * 2 - 1) * radius;
      const d2 = (x - center.x) ** 2 + (z - center.z) ** 2;
      if (d2 > r2 || !dry(x, z) || trodden(x, z)) continue;
      const meadow = fine(cover.grass, x, z) + fine(cover.shrub, x, z) * 0.5 + fine(cover.marsh, x, z) * 0.8;
      // Thinner over the outer half of the patch, so it fades into the ground rather than stopping.
      if (rand() > meadow * 1.2 * (1 - smooth(radius * 0.4, radius, Math.sqrt(d2)))) continue;
      grass.push({ x, y: heightAt(x, z), z, tall: 0.35 + rand() * 0.5, yaw: rand() * 6.283, tint: rand() });
      if (rand() < 0.035) flowers.push({ x: x + rand() - 0.5, y: heightAt(x, z), z: z + rand() - 0.5, hue: rand(), tall: 0.25 + rand() * 0.3 });
    }
    for (let n = 0; n < radius * 1.2; n++) {
      const x = center.x + (rand() * 2 - 1) * radius, z = center.z + (rand() * 2 - 1) * radius;
      if (!dry(x, z)) continue;
      if (rand() < 0.5 + fine(cover.bare, x, z)) pebbles.push({ x, y: heightAt(x, z), z, size: 0.15 + rand() * 0.5, yaw: rand() * 6.283, tint: rand() });
      if (fine(cover.tree, x, z) > 0.35 && rand() < 0.1 && Math.hypot(x - camp.x, z - camp.z) > 14) logs.push({ x, y: heightAt(x, z), z, length: 3 + rand() * 6, yaw: rand() * 6.283 });
    }
    return { grass, flowers, pebbles, logs };
  }
  const circle = (r, a) => ({ x: camp.x + Math.cos(a) * r, y: 0, z: camp.z + Math.sin(a) * r });
  const set = (p) => { p.y = heightAt(p.x, p.z); return p; };
  const facing = (p) => Math.atan2(camp.x - p.x, camp.z - p.z);
  // Tents stand behind the fire and to its sides, seen from `from`, so the fire and the people stay in view.
  const tents = [2.0, 3.1, 4.3].map((a, k) => { const p = set(circle(9 + k, from + a)); return { at: p, yaw: facing(p), size: 3.2 + k * 0.4 }; });
  const people = [0.8, 1.5, 2.6, 4.2, 5.3].map((a) => { const p = set(circle(2.6, from + a)); return { at: p, yaw: facing(p) }; });
  const camping = { at: camp, tents, people, woodpile: set(circle(5.5, from + 2.9)), fire: { ...camp }, uphill, from };

  return {
    isle, N, CELL, K, M, STEP, SIZE, START, h, cover, wet, river, moist, sky, at, bilinear, bicubic, fine, heightAt, slopeAt, dry, riverAt, rivers, riverWidth,
    get trees() { return lists().trees; }, get shrubs() { return lists().shrubs; }, get rocks() { return lists().rocks; },
    camp: camping, nearby, rand,
  };
}
