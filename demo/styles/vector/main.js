// Nomads as a 1980 colour vector cabinet would draw it: every surface a wireframe, hidden lines removed by painting
// black occluders far to near, then phosphor glow on a curved dark tube.
import { grow, clamp, hash } from "../world.js";
import { Beam, PAL, present } from "./beam.js";
import { terrain } from "./terrain.js";
import * as M from "./models.js";
import { hud } from "./hud.js";

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function camera(eye, target, fov, W, H, vex, near) {
  const E = [eye[0], eye[1] * vex, eye[2]], T = [target[0], target[1] * vex, target[2]];
  const f = norm([T[0] - E[0], T[1] - E[1], T[2] - E[2]]), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  const F = H / 2 / Math.tan((fov * Math.PI) / 360), hl = Math.hypot(f[0], f[2]), fh = [f[0] / hl, f[2] / hl];
  const project = (x, y, z, o) => {
    const dx = x - E[0], dy = y * vex - E[1], dz = z - E[2];
    const d = dx * f[0] + dy * f[1] + dz * f[2];
    o.x = W / 2 + ((dx * r[0] + dz * r[2]) / d) * F;
    o.y = H / 2 - ((dx * u[0] + dy * u[1] + dz * u[2]) / d) * F;
    o.d = d;
    return d;
  };
  const P = (x, y, z) => { const o = { x: 0, y: 0, d: 0 }; project(x, y, z, o); return o; };
  return { eye: E, eyeRaw: eye, f, r, u, F, W, H, vex, near, fh, project, P, hfov: 2 * Math.atan(W / 2 / F) };
}

const dirOf = (a) => [Math.cos(a), Math.sin(a)];

const VIEWS = {
  island(w) {
    const c = w.camp.at;
    return {
      eye: [-1000, 2850, 9300], target: [-150, 0, 300], fov: 43, vex: 2.2, near: 50,
      focus: { x: 0, z: 0 }, levels: [{ step: 75, radius: 5000 }],
      fog: [5000, 14000], edgeFade: [3900, 4750, 0, 0],
      landGain: 1.1, waterGain: 1.25, plantGain: 0.8, markGain: 1,
      waterStep: 50, waterPx: 3.2, swell: 600, dashCut: -0.25, shallow: 10, surf: 8,
      lodPx: 4, dotPx: 1e9, markPx: 1e9, grassArea: 400, riverWaterStep: 0,
      trees: { cell: 80, gs: 3.2, max: 30000, full: 30000 }, shrubs: 0, rocks: 0,
      range: 2400, ring: [180, 420],
      label: "CAMP", alert: "ISLAND SURVEY",
      camp: c,
    };
  },
  valley(w) {
    const c = w.camp.at, [dx, dz] = dirOf(w.camp.from);
    return {
      eye: [c.x + dx * 200, c.y + 86, c.z + dz * 200], target: [c.x - dx * 80, c.y, c.z - dz * 80], fov: 50, vex: 1, near: 4,
      focus: { x: c.x + dx * 90, z: c.z + dz * 90 },
      levels: [{ step: 9.375, radius: 360 }, { step: 18.75, radius: 900 }, { step: 37.5, radius: 2300 }, { step: 75, radius: 6000 }],
      fog: [180, 5200],
      landGain: 1.0, waterGain: 1.0, plantGain: 1.0, markGain: 1,
      waterStep: 3.5, waterPx: 3.5, swell: 70, dashCut: -0.35, shallow: 5, surf: 1.6,
      lodPx: 7, dotPx: 11, markPx: 15, grassArea: 230, riverWaterStep: 0,
      trees: { gs: 1, max: 7000, full: 700 }, plantFog: [160, 2200, 0.85], shrubs: 900, rocks: 1100,
      range: 450,
      label: "CAMP", alert: null,
      camp: c,
    };
  },
  camp(w) {
    const c = w.camp.at, [dx, dz] = dirOf(w.camp.from - 0.12);
    return {
      eye: [c.x + dx * 14, c.y + 6.8, c.z + dz * 14], target: [c.x - dx * 3, c.y + 1.2, c.z - dz * 3], fov: 48, vex: 1, near: 0.6,
      focus: { x: c.x, z: c.z },
      levels: [{ step: 2.34375, radius: 46 }, { step: 4.6875, radius: 110 }, { step: 9.375, radius: 260 }, { step: 18.75, radius: 700 }, { step: 37.5, radius: 1800 }, { step: 75, radius: 6000 }],
      fog: [12, 700],
      landGain: 0.95, waterGain: 1.0, plantGain: 1.0, markGain: 0.8, tuftR: 31,
      waterStep: 1.1, waterPx: 4, swell: 14, dashCut: -0.35, shallow: 2, surf: 0.5,
      lodPx: 13, dotPx: 12, markPx: 16, grassArea: 520, riverWaterStep: 5,
      trees: { gs: 1, max: 2600, full: 500 }, plantFog: [20, 900, 0.75], shrubs: 400, rocks: 500,
      range: 150,
      label: null, alert: "5 NOMADS AT CAMP",
      camp: c,
    };
  },
};

export async function run() {
  const q = new URLSearchParams(location.search), view = VIEWS[q.get("view")] ? q.get("view") : "valley", seed = Number(q.get("seed")) || 1;
  const W = innerWidth || 1280, H = innerHeight || 720;
  const w = grow(seed), V = VIEWS[view](w), camp = w.camp;
  const cam = camera(V.eye, V.target, V.fov, W, H, V.vex, V.near);
  V.light = norm([-0.8 * cam.r[0] - 0.2 * cam.fh[0], 0.85, -0.8 * cam.r[2] - 0.2 * cam.fh[1]]);
  const beam = new Beam(W, H, seed * 7 + 1), items = [];
  const bounds = terrain(w, V, cam, beam, items);

  const fog = (d) => 1 - 0.78 * clamp((d - V.fog[0]) / (V.fog[1] - V.fog[0]), 0, 1);
  const edge = (x, z) => (V.edgeFade ? clamp((V.edgeFade[1] - Math.hypot(x - V.edgeFade[2], z - V.edgeFade[3])) / (V.edgeFade[1] - V.edgeFade[0]), 0, 1) : 1);
  // painter's key bias: things standing on a quad draw after it, so its fill never hides their feet
  const stepAt = (x, z) => { for (let n = 0; n < V.levels.length; n++) { const b = bounds[n]; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) return V.levels[n].step; } return 75; };
  const o = { x: 0, y: 0, d: 0 };
  const visible = (x, y, z, hWorld, margin = 60) => {
    const d = cam.project(x, y, z, o);
    if (d <= cam.near * 2 || o.x < -margin || o.x > W + margin || o.y < -8) return false;
    return o.y - (hWorld * cam.F * cam.u[1] * cam.vex) / d < H + 8;
  };

  // ---------- streams, as black ribbons with bright banks (or one line when narrow) ----------
  const inWaterRing = (x, z) => V.levels.some((L, n) => L.step <= V.riverWaterStep && x > bounds[n][0] && x < bounds[n][2] && z > bounds[n][1] && z < bounds[n][3]);
  for (const line of w.rivers) {
    const nrm = line.map((p, k) => { const a = line[Math.max(0, k - 1)], b = line[Math.min(line.length - 1, k + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; });
    for (let k = 1; k < line.length; k++) {
      const a = line[k - 1], b = line[k], mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if (inWaterRing(mx, mz)) continue;
      const d = cam.project(mx, w.heightAt(mx, mz), mz, o);
      if (d <= cam.near * 3 || o.x < -200 || o.x > W + 200 || o.y < -200 || o.y > H + 200) continue;
      items.push({ k: d - stepAt(mx, mz) * 0.8, f: riverSeg, a: [a, b, nrm[k - 1], nrm[k], w.riverWidth((a[2] + b[2]) / 2), k], p: fog(d) * edge(mx, mz) });
    }
  }
  function riverSeg([a, b, na, nb, width, k], I) {
    const ya = w.heightAt(a[0], a[1]) + 0.35, yb = w.heightAt(b[0], b[1]) + 0.35;
    const A = cam.P(a[0], ya, a[1]), B = cam.P(b[0], yb, b[1]);
    if (A.d <= cam.near || B.d <= cam.near) return;
    const wpx = (width * cam.F) / Math.min(A.d, B.d);
    I *= V.waterGain;
    if (wpx < 3) { beam.seg(A.x, A.y, B.x, B.y, PAL.water, I * (0.75 + 0.1 * wpx), beam.width * (1 + wpx * 0.15)); return; }
    const h = width / 2;
    const La = cam.P(a[0] + na[0] * h, ya, a[1] + na[1] * h), Ra = cam.P(a[0] - na[0] * h, ya, a[1] - na[1] * h);
    const Lb = cam.P(b[0] + nb[0] * h, yb, b[1] + nb[1] * h), Rb = cam.P(b[0] - nb[0] * h, yb, b[1] - nb[1] * h);
    beam.occlude([La.x, La.y, Lb.x, Lb.y, Rb.x, Rb.y, Ra.x, Ra.y]);
    beam.seg(La.x, La.y, Lb.x, Lb.y, PAL.water, I * 0.95);
    beam.seg(Ra.x, Ra.y, Rb.x, Rb.y, PAL.water, I * 0.95);
    if (k % 2) beam.seg(A.x, A.y, (A.x + B.x) / 2, (A.y + B.y) / 2, PAL.water, I * 0.5);
  }

  // ---------- trees ----------
  const T = V.trees;
  let trees = w.trees;
  if (T.cell) {
    const best = new Map();
    for (const t of w.trees) {
      const key = Math.floor((t.x - w.START) / T.cell) * 4096 + Math.floor((t.z - w.START) / T.cell), b = best.get(key);
      if (!b || t.tall > b.tall) best.set(key, t);
    }
    trees = [...best.values()];
  }
  const drawTree = (t, I) => M.tree(beam, cam, t, T.gs, I);
  for (let n = 0; n < trees.length; n++) {
    const t = trees[n];
    if (!visible(t.x, t.y, t.z, t.tall * T.gs)) continue;
    const d = o.d;
    if (d > T.max || (d > T.full && hash(n, 7, 3) > (T.full / d) ** 2)) continue;
    const pf = V.plantFog ? 1 - V.plantFog[2] * clamp((d - V.plantFog[0]) / (V.plantFog[1] - V.plantFog[0]), 0, 1) : fog(d);
    items.push({ k: d - stepAt(t.x, t.z) * 0.7, f: drawTree, a: t, p: pf * edge(t.x, t.z) * V.plantGain });
  }
  // ---------- shrubs and rocks ----------
  if (V.shrubs) {
    const f = (s, I) => M.shrub(beam, cam, s, I);
    for (const s of w.shrubs) {
      if (!visible(s.x, s.y, s.z, s.tall) || o.d > V.shrubs) continue;
      items.push({ k: o.d - stepAt(s.x, s.z) * 0.7, f, a: s, p: fog(o.d) });
    }
  }
  if (V.rocks) {
    const f = (r, I) => M.rock(beam, cam, r, I);
    for (const r of w.rocks) {
      if (!visible(r.x, r.y, r.z, r.size) || o.d > V.rocks) continue;
      items.push({ k: o.d - stepAt(r.x, r.z) * 0.7, f, a: r, p: fog(o.d) });
    }
  }

  // ---------- the camp ----------
  const cb = stepAt(camp.at.x, camp.at.z) * 0.7;
  const add = (x, y, z, f, a, bias = cb) => { const d = cam.project(x, y, z, o); if (d > cam.near) items.push({ k: d - bias, f, a, p: fog(d) }); };
  if (view === "island") {
    // survey rings on the ground round the camp
    for (const r of V.ring) add(camp.at.x, camp.at.y, camp.at.z + r, () => {
      const p = [];
      for (let k = 0; k < 40; k++) { const a = (k / 40) * 6.2832, x = camp.at.x + Math.cos(a) * r, z = camp.at.z + Math.sin(a) * r, P = cam.P(x, Math.max(0, w.heightAt(x, z)) + 4, z); p.push(P.x, P.y); }
      beam.poly(p, true, PAL.camp, r < 300 ? 0.95 : 0.55);
    }, null, 0);
    for (const t of camp.tents) add(t.at.x, t.at.y, t.at.z, () => M.tent(beam, cam, { ...t, size: t.size * 14 }, w, 1.0), null, 0);
  } else {
    const poses = ["crouch", "sit", "stand", "sit", "stand"];
    for (const t of camp.tents) add(t.at.x, t.at.y, t.at.z, (a, I) => M.tent(beam, cam, t, w, Math.max(0.75, I)), null);
    camp.people.forEach((p, n) => add(p.at.x, p.at.y, p.at.z, (a, I) => M.person(beam, cam, p, poses[n], Math.max(0.85, I)), null));
    add(camp.fire.x, camp.fire.y, camp.fire.z, (a, I) => M.fire(beam, cam, w, camp.fire, Math.max(0.9, I), beam.rand), null);
    add(camp.woodpile.x, camp.woodpile.y, camp.woodpile.z, (a, I) => M.woodpile(beam, cam, w, camp.woodpile, camp.fire, Math.max(0.55, I * 0.7)), null);
    if (view === "camp") {
      const near = w.nearby(camp.at, 34, 1.5);
      for (const g of near.grass) add(g.x, g.y, g.z, (a, I) => M.tuft(beam, cam, a, I), g, 0.4);
      for (const fl of near.flowers) add(fl.x, fl.y, fl.z, (a, I) => M.flower(beam, cam, a, I), fl, 0.4);
      for (const p of near.pebbles) add(p.x, p.y, p.z, (a, I) => M.pebble(beam, cam, a, I), p, 0.5);
      for (const l of near.logs) {
        const ex = Math.cos(l.yaw) * l.length / 2, ez = Math.sin(l.yaw) * l.length / 2;
        add(l.x, l.y, l.z, (a, I) => M.log(beam, cam, [l.x - ex, w.heightAt(l.x - ex, l.z - ez) + 0.2, l.z - ez], [l.x + ex, w.heightAt(l.x + ex, l.z + ez) + 0.2, l.z + ez], 0.2, I), null, 1);
      }
    }
  }

  items.sort((a, b) => b.k - a.k);
  for (const it of items) it.f(it.a, it.p);

  // ---------- HUD, from the data ----------
  const range = V.range, rel = [];
  let inRange = 0;
  for (const t of w.trees) {
    const dx = t.x - camp.at.x, dz = t.z - camp.at.z;
    if (dx * dx + dz * dz < range * range) { inRange++; rel.push([dx, dz]); }
  }
  const treesR = rel.length > 1100 ? rel.filter((_, k) => hash(k, 3, 9) < 1100 / rel.length) : rel;
  const isWater = (dx, dz) => w.fine(w.wet, camp.at.x + dx, camp.at.z + dz) > 0.5 || w.riverAt(camp.at.x + dx, camp.at.z + dz) > 0.4;
  let water = Infinity;
  for (let z = camp.at.z - 1500; z <= camp.at.z + 1500; z += w.STEP) for (let x = camp.at.x - 1500; x <= camp.at.x + 1500; x += w.STEP) {
    const d = Math.hypot(x - camp.at.x, z - camp.at.z);
    if (d < water && (w.fine(w.wet, x, z) > 0.5 || w.riverAt(x, z) > 0.4)) water = d;
  }
  const cp = cam.P(camp.at.x, camp.at.y, camp.at.z), eyeGround = w.heightAt(V.eye[0], V.eye[2]);
  const dist = Math.hypot(V.eye[0] - camp.at.x, V.eye[1] - camp.at.y, V.eye[2] - camp.at.z);
  let target = V.label ? [cp.x, cp.y, view === "island" ? 16 : 30, view === "island" ? 16 : 30, V.label, `RNG ${Math.round(dist)}M`] : null;
  if (view === "camp") {
    // the nomad feeding the fire, selected as a colony game would show it
    const p = camp.people[0].at, lo = cam.P(p.x, p.y, p.z), hi = cam.P(p.x, p.y + 1.25, p.z), hh = (lo.y - hi.y) / 2 + 9;
    target = [(lo.x + hi.x) / 2, (lo.y + hi.y) / 2, hh * 0.7, hh, "NOMAD 01", "TENDING FIRE", true];
  }
  hud(beam, {
    fh: cam.fh, range, trees: treesR, isWater, sweep: -0.95, hfov: cam.hfov,
    eyeRel: [V.eye[0] - camp.at.x, V.eye[2] - camp.at.z],
    heading: ((Math.atan2(cam.fh[0], -cam.fh[1]) * 180) / Math.PI + 360) % 360,
    day: 1, treesInRange: inRange, water, pop: camp.people.length, elev: camp.at.y, alt: V.eye[1] - Math.max(0, eyeGround),
    target,
    alert: V.alert || (water < 400 ? "WATER IN RANGE" : "NO WATER IN RANGE"),
    status: `SEED ${seed}  X${Math.round(camp.at.x)} Z${Math.round(camp.at.z)}  ${view.toUpperCase()}`,
  });
  present(beam, document.getElementById("view"));
  document.body.classList.add("ready");
}
