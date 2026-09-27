// Resamples the island onto a pointy-top hex grid: each hex becomes one tile with a type, a stepped level and the
// river edges it connects. Grid space is the world rotated about an origin so a view can look along a hex axis.
import { hash, fbm } from "../world.js";

export const SQ3 = Math.sqrt(3);
export const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]; // neighbor d sits at angle 60d degrees
export const COVER = ["tree", "shrub", "grass", "marsh", "bare", "sand"];
export const hkey = (q, r) => (q + 2048) * 4096 + (r + 2048);
export const hexDist = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;

export function makeGrid(flat, ox, oz, rot) {
  const R = flat / SQ3, c = Math.cos(rot), s = Math.sin(rot);
  return {
    flat, R, rot,
    world: (gx, gz) => [ox + gx * c - gz * s, oz + gx * s + gz * c],
    grid: (x, z) => { const dx = x - ox, dz = z - oz; return [dx * c + dz * s, -dx * s + dz * c]; },
    center: (q, r) => [R * SQ3 * (q + r / 2), R * 1.5 * r],
    hexOf(gx, gz) {
      const fq = ((SQ3 / 3) * gx - gz / 3) / R, fr = ((2 / 3) * gz) / R, fs = -fq - fr;
      let q = Math.round(fq), r = Math.round(fr);
      const rs = Math.round(fs), dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(rs - fs);
      if (dq > dr && dq > ds) q = -r - rs;
      else if (dr > ds) r = -q - rs;
      return [q, r];
    },
  };
}

// A nearest-neighbor index over world objects with x, z.
export function spatial(items, cell) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const o of items) { x0 = Math.min(x0, o.x); z0 = Math.min(z0, o.z); x1 = Math.max(x1, o.x); z1 = Math.max(z1, o.z); }
  const W = Math.max(1, Math.ceil((x1 - x0) / cell) + 1), H = Math.max(1, Math.ceil((z1 - z0) / cell) + 1);
  const cellOf = (x, z) => Math.floor((z - z0) / cell) * W + Math.floor((x - x0) / cell);
  const start = new Int32Array(W * H + 1), order = new Int32Array(items.length);
  items.forEach((o) => start[cellOf(o.x, o.z) + 1]++);
  for (let k = 0; k < W * H; k++) start[k + 1] += start[k];
  const fill = start.slice(0, W * H);
  items.forEach((o, i) => { order[fill[cellOf(o.x, o.z)]++] = i; });
  return {
    nearest(x, z, rad) {
      const cx = Math.floor((x - x0) / cell), cz = Math.floor((z - z0) / cell), span = Math.ceil(rad / cell);
      let best = null, bd = rad * rad;
      for (let j = Math.max(0, cz - span); j <= Math.min(H - 1, cz + span); j++)
        for (let i = Math.max(0, cx - span); i <= Math.min(W - 1, cx + span); i++) {
          const k = j * W + i;
          for (let n = start[k]; n < start[k + 1]; n++) {
            const o = items[order[n]], d = (o.x - x) ** 2 + (o.z - z) ** 2;
            if (d < bd) { bd = d; best = o; }
          }
        }
      return best;
    },
  };
}

export function buildBoard(w, view) {
  const grid = makeGrid(view.flat, view.ox, view.oz, view.rot), R = grid.R;
  const probe = [[0, 0]];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 + Math.PI / 6, b = (k * Math.PI) / 3;
    probe.push([Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55], [Math.cos(b) * R * 0.78, Math.sin(b) * R * 0.78]);
  }
  const sample = (q, r) => {
    const [gx, gz] = grid.center(q, r);
    let wetN = 0, n = 0, h = 0, hMax = -Infinity, surf = 0;
    const cov = Object.fromEntries(COVER.map((k) => [k, 0]));
    for (const [ox, oz] of probe) {
      const [x, z] = grid.world(gx + ox, gz + oz);
      if (w.fine(w.wet, x, z) > 0.5) {
        wetN++;
        const cx = (x - w.START) / w.CELL, cy = (z - w.START) / w.CELL;
        surf += w.bilinear(w.isle.height, cx, cy) + w.bilinear(w.isle.water, cx, cy);
      } else {
        const hh = w.heightAt(x, z);
        n++; h += hh; hMax = Math.max(hMax, hh);
        for (const k of COVER) cov[k] += w.fine(w.cover[k], x, z);
      }
    }
    if (n) for (const k of COVER) cov[k] /= n;
    return { q, r, gx, gz, key: hkey(q, r), water: wetN * 2 > probe.length, h: n ? h / n : 0, hMax: n ? hMax : 0, surf: wetN ? surf / wetN : 0, cov, edges: new Set() };
  };

  const map = new Map();
  if (view.extent === "island") {
    const span = 5150, rows = Math.ceil(span / (R * 1.5));
    for (let r = -rows; r <= rows; r++)
      for (let q = Math.floor(-span / (R * SQ3) - r / 2) - 1; q <= Math.ceil(span / (R * SQ3) - r / 2) + 1; q++) {
        const [gx, gz] = grid.center(q, r);
        if (Math.abs(gx) <= span && Math.abs(gz) <= span) map.set(hkey(q, r), sample(q, r));
      }
    // Sea tiles out to a wandering two or three rings off the coast, so the board has a ragged, placed-tile edge.
    const dist = new Map(), queue = [];
    for (const t of map.values()) if (!t.water) { dist.set(t.key, 0); queue.push(t); }
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i], d = dist.get(t.key);
      if (d >= 4) continue;
      for (const [dq, dr] of DIRS) {
        const k = hkey(t.q + dq, t.r + dr), nb = map.get(k);
        if (nb && !dist.has(k)) { dist.set(k, d + 1); queue.push(nb); }
      }
    }
    for (const [k, t] of map) {
      const d = dist.get(k), lim = 2 + (fbm(t.gx / 1300, t.gz / 1300, 91, 2) > -0.05 ? 1 : 0) + (hash(t.q, t.r, 5) < 0.12 ? 1 : 0);
      if (d === undefined || d > lim) map.delete(k);
    }
  } else {
    const Rv = view.extent.radius;
    for (let r = -Rv - 1; r <= Rv + 1; r++)
      for (let q = -Rv - 1; q <= Rv + 1; q++) {
        const d = hexDist(q, r), keep = d <= Rv - 1 || (d === Rv && hash(q, r, 11) > 0.35) || (d === Rv + 1 && hash(q, r, 12) > 0.86);
        if (keep) map.set(hkey(q, r), sample(q, r));
      }
    // Outer strays only stay when they touch the kept ring.
    for (const [k, t] of map)
      if (hexDist(t.q, t.r) === Rv + 1 && !DIRS.some(([dq, dr]) => { const nb = map.get(hkey(t.q + dq, t.r + dr)); return nb && hexDist(nb.q, nb.r) === Rv; })) map.delete(k);
  }

  const tiles = [...map.values()];
  const nb = (t, d) => map.get(hkey(t.q + DIRS[d][0], t.r + DIRS[d][1]));

  // Distance of each water tile to land, for how deep its blue is.
  const queue = tiles.filter((t) => !t.water);
  for (const t of tiles) t.depth = t.water ? Infinity : 0;
  for (let i = 0; i < queue.length; i++)
    for (let d = 0; d < 6; d++) {
      const n = nb(queue[i], d);
      if (n && n.water && n.depth === Infinity) { n.depth = queue[i].depth + 1; queue.push(n); }
    }
  for (const t of tiles) if (t.depth === Infinity) t.depth = 6;

  // Levels: land steps up with height; standing water sits half a step below the land level it would have.
  for (const t of tiles) {
    if (t.water) { t.lake = t.surf > 1.2; t.level = view.levelOf(Math.max(0, t.surf)); }
    else t.level = Math.max(1, view.levelOf(t.h));
  }
  for (const t of tiles) if (t.water) for (let d = 0; d < 6; d++) { const n = nb(t, d); if (n && !n.water) n.level = Math.max(n.level, t.level); }
  for (const t of tiles) t.top = t.water ? (t.level - 0.5) * view.step : t.level * view.step;

  // Streams: walk each line through the grid, drop loops, and link consecutive tiles across their shared edge.
  for (const line of w.rivers) {
    const path = [];
    for (let k = 0; k < line.length - 1; k++) {
      const [x0, z0] = line[k], [x1, z1] = line[k + 1], steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (R * 0.25)));
      for (let s = 0; s < steps; s++) {
        const [gx, gz] = grid.grid(x0 + ((x1 - x0) * s) / steps, z0 + ((z1 - z0) * s) / steps), [q, r] = grid.hexOf(gx, gz);
        const t = map.get(hkey(q, r));
        if (!t) { path.push(null); continue; }
        if (path.at(-1) === t) continue;
        const seen = path.lastIndexOf(t);
        if (seen >= 0 && !path.slice(seen).includes(null)) path.length = seen + 1;
        else path.push(t);
      }
    }
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1], b = path[k];
      if (!a || !b || (a.water && b.water)) continue;
      const d = DIRS.findIndex(([dq, dr]) => a.q + dq === b.q && a.r + dr === b.r);
      if (d < 0) continue;
      if (!a.water) a.edges.add(d);
      if (!b.water) b.edges.add((d + 3) % 6);
    }
  }

  // Tile types come from the dominant cover of the ground under the hex.
  for (const t of tiles) {
    if (t.water) { t.type = t.lake ? "lake" : "sea"; continue; }
    const c = t.cov, coast = [0, 1, 2, 3, 4, 5].some((d) => { const n = nb(t, d); return n && n.water && !n.lake; });
    const top = Math.max(c.tree, c.grass, c.marsh, c.bare);
    if (c.sand > 0.2 || (coast && c.sand > 0.1)) t.type = "beach";
    else if (c.bare >= top && c.bare > 0.33) t.type = t.hMax > view.mountainH ? "mountain" : "rock";
    else if (c.shrub > 0.11 && c.tree < 0.5) t.type = "heath";
    else if (c.marsh >= top && c.marsh > 0.28) t.type = "marsh";
    else if (c.tree >= top && c.tree > 0.38) t.type = "forest";
    else t.type = c.tree > c.grass + 0.15 ? "forest" : "meadow";
  }
  if (view.camp) {
    const t = map.get(hkey(0, 0));
    t.type = "camp";
    t.edges.clear();
    for (let d = 0; d < 6; d++) nb(t, d)?.edges.delete((d + 3) % 6);
  }
  return { grid, tiles, map, nb, view };
}
