// The island every style mock draws, as plain data with no renderer: the generator's fields, a finer ground under
// them, streams, every tree, shrub and rock, and a camp. Styles differ in everything they draw; the world is the same.
import { CELL, N, generateIsland, rng } from "./island.js";

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Gradient noise, roughly -1..1, and a few octaves of it.
export function noise(x, y, s) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const g = (i, j) => { const a = hash(i, j, s) * 6.2831853; return Math.cos(a) * (fx - (i - x0)) + Math.sin(a) * (fy - (j - y0)); };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = g(x0, y0), b = g(x0 + 1, y0), c = g(x0, y0 + 1), d = g(x0 + 1, y0 + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.4;
}
export function fbm(x, y, s, octaves = 3) {
  let total = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) { total += noise(x * f, y * f, s + o * 31) * amp; f *= 2.03; amp *= 0.5; }
  return total;
}

export const COVERS = ["tree", "shrub", "grass", "marsh", "bare", "sand"];


export function grow(seed = 1) {
  const isle = generateIsland(rng(seed)), rand = rng(seed ^ 0x51f15e);
  // The fine grid puts four quads across every 75 m cell, with a vertex on every cell center.
  const K = 4, M = (N - 1) * K + 1, STEP = CELL / K, SIZE = N * CELL, START = CELL / 2 - SIZE / 2, LEN = M * M;
  const Hc = isle.height, wetC = Float32Array.from(isle.water, (w) => (w > 0 ? 1 : 0));
  const at = (f, i, j) => f[clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1)];
  const bilinear = (f, cx, cy) => {
    const x = Math.floor(cx), y = Math.floor(cy), tx = cx - x, ty = cy - y;
    return (at(f, x, y) * (1 - tx) + at(f, x + 1, y) * tx) * (1 - ty) + (at(f, x, y + 1) * (1 - tx) + at(f, x + 1, y + 1) * tx) * ty;
  };
  const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const bicubic = (f, cx, cy) => {
    const x = Math.floor(cx), y = Math.floor(cy), tx = cx - x, ty = cy - y;
    const row = (j) => cr(at(f, x - 1, j), at(f, x, j), at(f, x + 1, j), at(f, x + 2, j), tx);
    return cr(row(y - 1), row(y), row(y + 1), row(y + 2), ty);
  };
  const cellOf = (x) => (x - START) / CELL; // world to coarse coordinate

  // Streams, smoothed, in world meters, each point carrying its discharge; drawn into a mask for carving and shading.
  const chaikin = (p) => [p[0], ...p.slice(0, -1).flatMap((a, i) => [a.map((v, k) => v * 0.75 + p[i + 1][k] * 0.25), a.map((v, k) => v * 0.25 + p[i + 1][k] * 0.75)]), p.at(-1)];
  const rivers = isle.rivers.map((line) => chaikin(chaikin(chaikin(line.map(([x, y, q]) => [START + x * CELL, START + y * CELL, q])))));
  const RM = 2048, canvas = Object.assign(document.createElement("canvas"), { width: RM, height: RM }), g = canvas.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, RM, RM);
  g.strokeStyle = "#fff";
  g.lineCap = g.lineJoin = "round";
  const px = (x) => ((x + SIZE / 2) / SIZE) * RM;
  const riverWidth = (q) => clamp(2.5 + 2.8 * Math.sqrt(q), 2.5, 16);
  for (const line of rivers)
    for (let k = 1; k < line.length; k++) {
      g.lineWidth = (riverWidth((line[k - 1][2] + line[k][2]) / 2) * RM) / SIZE + 1;
      g.beginPath();
      g.moveTo(px(line[k - 1][0]), px(line[k - 1][1]));
      g.lineTo(px(line[k][0]), px(line[k][1]));
      g.stroke();
    }
  const mask = g.getImageData(0, 0, RM, RM).data;
  const riverAt = (x, z) => mask[(clamp(Math.floor(px(z)), 0, RM - 1) * RM + clamp(Math.floor(px(x)), 0, RM - 1)) * 4] / 255;

  // ---------- the fine ground ----------
  // Heights come from a smooth cubic through the generator's cells, plus a little ground swell the cells are too
  // coarse to hold. Streams cut their beds. Covers wander at their edges instead of following the cell grid.
  const h = new Float32Array(LEN), wet = new Float32Array(LEN), river = new Float32Array(LEN), moist = new Float32Array(LEN);
  const cover = Object.fromEntries(COVERS.map((k) => [k, new Float32Array(LEN)]));
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const i = v * M + u, cx = u / K, cy = v / K, x = START + u * STEP, z = START + v * STEP;
      const base = bicubic(Hc, cx, cy), wf = bilinear(wetC, cx, cy), rv = riverAt(x, z);
      const swell = 2.6 * fbm(x / 240, z / 240, 7, 3) + 0.8 * fbm(x / 60, z / 60, 8, 2);
      h[i] = base + smooth(-2, 6, base) * (1 - wf) * swell - rv * 1.8;
      wet[i] = wf;
      river[i] = rv;
      moist[i] = bilinear(isle.moist, cx, cy);
      let sum = 0;
      COVERS.forEach((k, n) => {
        const w = Math.max(0, bilinear(isle[k], cx, cy) * (1 + 0.85 * fbm(x / 150, z / 150, 40 + n, 2)));
        cover[k][i] = w;
        sum += w;
      });
      if (sum > 0) for (const k of COVERS) cover[k][i] /= sum;
    }
  const fine = (f, x, z) => {
    const fu = clamp((x - START) / STEP, 0, M - 1.001), fv = clamp((z - START) / STEP, 0, M - 1.001);
    const u = Math.floor(fu), v = Math.floor(fv), tu = fu - u, tv = fv - v, i = v * M + u;
    return (f[i] * (1 - tu) + f[i + 1] * tu) * (1 - tv) + (f[i + M] * (1 - tu) + f[i + M + 1] * tu) * tv;
  };
  const heightAt = (x, z) => fine(h, x, z);
  const slopeAt = (x, z) => Math.hypot(heightAt(x + 4, z) - heightAt(x - 4, z), heightAt(x, z + 4) - heightAt(x, z - 4)) / 8;
  const dry = (x, z) => fine(wet, x, z) < 0.15 && riverAt(x, z) < 0.25 && heightAt(x, z) > 0.8;

  // How much sky each vertex sees: the highest horizon along eight bearings, out to 450 m.
  const sky = new Float32Array(LEN);
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
  // Conifers take cold, thin, windswept ground; oak the deep soils; ash the moist ones; aspen the wet edges. People
  // have cleared the ground around the camp, thinning out toward its edge.
  const trees = [], shrubs = [], rocks = [];
  const cleared = (x, z, r0, r1) => { const d = Math.hypot(x - camp.x, z - camp.z); return d < r0 || (d < r1 && rand() < (r1 - d) / (r1 - r0)); };
  for (let v = 0; v < M - 1; v++)
    for (let u = 0; u < M - 1; u++) {
      const i = v * M + u, x0 = START + u * STEP, z0 = START + v * STEP;
      if (wet[i] > 0.3 || h[i] < 0.8) continue;
      const cx = cellOf(x0), cy = cellOf(z0), exposure = bilinear(isle.exposure, cx, cy), soil = Math.min(1.5, bilinear(isle.soil, cx, cy));
      const m = moist[i], vigor = clamp(0.6 + m * 0.35 + soil * 0.2 - exposure * 0.4, 0.4, 1.2);
      for (let n = Math.floor(cover.tree[i] * 3.6 + rand()); n > 0; n--) {
        const x = x0 + rand() * STEP, z = z0 + rand() * STEP;
        if (!dry(x, z) || slopeAt(x, z) > 0.7 || cleared(x, z, 22, 40)) continue;
        const pine = clamp(0.08 + (heightAt(x, z) - 80) / 320 + exposure * 0.8 - soil * 0.3 + (1 - m) * 0.3, 0.03, 0.97);
        const kind = rand() < pine ? "pine" : m > 0.9 && rand() < 0.45 ? "aspen" : soil > 0.9 && rand() < 0.6 ? "oak" : "ash";
        const tall = { pine: 17, oak: 15, ash: 16, aspen: 13 }[kind] * vigor * (0.7 + rand() * 0.55);
        trees.push({ x, y: heightAt(x, z), z, tall, kind, yaw: rand() * Math.PI * 2, tint: rand() });
      }
      const edge = cover.tree[i] * (1 - cover.tree[i]) * 4;
      for (let n = Math.floor((cover.shrub[i] * 5 + edge * 1.2) * 0.6 + rand()); n > 0; n--) {
        const x = x0 + rand() * STEP, z = z0 + rand() * STEP;
        if (dry(x, z) && !cleared(x, z, 14, 26)) shrubs.push({ x, y: heightAt(x, z), z, tall: 0.8 + rand() * 1.8, heath: clamp(exposure * 1.4 + cover.shrub[i] - m * 0.3, 0, 1), yaw: rand() * 6.283, tint: rand() });
      }
      for (let n = Math.floor(cover.bare[i] * 1.6 + slopeAt(x0, z0) * 1.5 + rand() * 0.8); n > 0; n--) {
        const x = x0 + rand() * STEP, z = z0 + rand() * STEP;
        if (fine(wet, x, z) < 0.3 && !cleared(x, z, 12, 20)) rocks.push({ x, y: heightAt(x, z), z, size: 0.5 + rand() ** 3 * 5, yaw: rand() * 6.283, tint: rand() });
      }
    }

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

  return { isle, N, CELL, K, M, STEP, SIZE, START, h, cover, wet, river, moist, sky, at, bilinear, bicubic, fine, heightAt, slopeAt, dry, riverAt, rivers, riverWidth, trees, shrubs, rocks, camp: camping, nearby, rand };
}
