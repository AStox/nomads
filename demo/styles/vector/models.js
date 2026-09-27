// Vector models: every object is a few runs of the beam plus black occluders, detail picked by its size on screen.
import { hash } from "../world.js";
import { PAL } from "./beam.js";

const TREE_COL = { pine: [0.18, 1.0, 0.55], oak: [0.55, 1.0, 0.28], ash: [0.3, 1.0, 0.4], aspen: [0.75, 1.0, 0.36] };
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// A billboard frame standing on the ground at (x, y, z): local (u across in m, v up in m) to screen.
function frame(cam, x, y, z, hWorld) {
  const b = cam.P(x, y, z);
  if (b.d <= cam.near) return null;
  const t = cam.P(x, y + hWorld / cam.vex, z);
  const s = cam.F / b.d, ax = (t.x - b.x) / hWorld, ay = (t.y - b.y) / hWorld;
  return { b, hp: b.y - t.y, map: (u, v, out, k) => { out[k] = b.x + u * s + ax * v; out[k + 1] = b.y + ay * v; } };
}
const mapAll = (fr, pts, h) => { const out = new Array(pts.length); for (let k = 0; k < pts.length; k += 2) fr.map(pts[k] * h, pts[k + 1] * h, out, k); return out; };

function pineOutline(n, seed) {
  const cb = 0.17, th = (1 - cb) / (n * 0.62 + 0.38), right = [[0, 1]], w0 = 0.34 * (0.85 + 0.3 * hash(seed, 1, 5));
  const top = (t) => 1 - t * 0.62 * th, wid = (t) => w0 * (0.42 + 0.58 * (t + 1) / n);
  for (let t = 0; t < n; t++) {
    const bot = top(t) - th;
    right.push([wid(t) * (0.9 + 0.2 * hash(seed, t, 7)), bot + 0.02 * (hash(seed, t, 9) - 0.5)]);
    if (t < n - 1) right.push([(wid(t + 1) * (top(t + 1) - bot)) / th, bot + 0.015]);
  }
  right.push([0.035, cb]);
  const left = right.slice(1).reverse().map(([u, v], k) => [-u * (0.92 + 0.16 * hash(seed, k, 11)), v]);
  return { poly: [...right, ...left].flat(), cb };
}

function crown(nv, cx, cy, rx, ry, seed, flat) {
  const p = [], ph = hash(seed, 3, 3) * 6.283;
  for (let k = 0; k < nv; k++) {
    const a = ph + (k / nv) * 6.283, r = 1 + 0.2 * (hash(seed, k, 13) - 0.5);
    let v = Math.sin(a) * ry * r;
    if (flat && v < 0) v *= 0.6;
    p.push(cx + Math.cos(a) * rx * r, cy + v);
  }
  return p;
}

export function tree(beam, cam, t, gs, I) {
  const h = t.tall * gs, fr = frame(cam, t.x, t.y, t.z, h);
  if (!fr) return;
  const hp = fr.hp, col = mixc(TREE_COL[t.kind], PAL.plant, 0.3), seed = Math.floor(t.tint * 1e6);
  I *= 0.62 + 0.36 * t.tint;
  const o = [0, 0, 0, 0];
  if (hp < 3) {
    fr.map(0, 0, o, 0);
    fr.map(0, h, o, 2);
    beam.seg(o[0], o[1], o[2], o[3], col, I * 0.8);
    return;
  }
  if (t.kind === "pine") {
    const n = hp < 9 ? 1 : hp < 16 ? 2 : hp < 34 ? 3 : hp < 80 ? 4 : 5;
    const { poly, cb } = pineOutline(n, seed);
    fr.map(0, 0, o, 0);
    fr.map(0, cb * h + 0.2, o, 2);
    beam.seg(o[0], o[1], o[2], o[3], col, I * 0.8);
    const p = mapAll(fr, poly, h);
    beam.occlude(p);
    beam.poly(p, true, col, I, { ends: hp > 14 ? "all" : true, dot: 1.5 });
    if (hp > 34) {
      const a = [0, 0, 0, 0];
      fr.map(0, cb * h, a, 0);
      fr.map(0, h * 0.93, a, 2);
      beam.seg(a[0], a[1], a[2], a[3], col, I * 0.35);
    }
    return;
  }
  const aspen = t.kind === "aspen", oak = t.kind === "oak";
  const cy = aspen ? 0.63 : 0.64, ry = aspen ? 0.36 : 0.34, rx = aspen ? 0.17 : oak ? 0.42 : 0.31;
  const nv = hp < 9 ? 6 : hp < 30 ? 9 : hp < 70 ? 12 : 16;
  const trunkTop = cy - ry * 0.6;
  fr.map(0, 0, o, 0);
  fr.map(0, trunkTop * h, o, 2);
  beam.seg(o[0], o[1], o[2], o[3], col, I * 0.85);
  const p = mapAll(fr, crown(nv, 0, cy, rx, ry, seed, oak), h);
  beam.occlude(p);
  beam.poly(p, true, col, I, { ends: hp > 14 ? "all" : true, dot: 1.5 });
  if (hp > 26) {
    // a leader with side branches leaving it at different heights, dimmer, as the inner vectors of a wire model
    const m = hash(seed, 5, 17) < 0.5 ? -1 : 1;
    const f = [0, trunkTop, 0.05 * rx * m, cy + ry * 0.3, 0.005, trunkTop + ry * 0.18, -0.5 * rx * m, cy + ry * 0.0, 0.01, trunkTop + ry * 0.45, 0.46 * rx * m, cy + ry * 0.22];
    for (let k = 0; k < f.length; k += 4) {
      const a = [0, 0, 0, 0];
      fr.map(f[k] * h, f[k + 1] * h, a, 0);
      fr.map(f[k + 2] * h, f[k + 3] * h, a, 2);
      beam.seg(a[0], a[1], a[2], a[3], col, I * 0.4);
    }
  }
  if (hp > 70) beam.poly(mapAll(fr, crown(nv, 0.02, cy + ry * 0.12, rx * 0.62, ry * 0.58, seed + 7, oak), h), true, col, I * 0.3);
}

export function shrub(beam, cam, s, I) {
  const h = s.tall, fr = frame(cam, s.x, s.y, s.z, h);
  if (!fr || fr.hp < 1.2) return;
  const col = mixc(PAL.plant, [0.6, 1, 0.3], s.heath * 0.6);
  I *= 0.5 + 0.3 * s.tint;
  if (fr.hp < 3) { const o = [0, 0]; fr.map(0, h * 0.5, o, 0); beam.dot(o[0], o[1], col, I); return; }
  const w = 0.75 + 0.4 * s.tint;
  const shape = s.heath > 0.5
    ? [-w, 0, -w * 0.72, 0.62, -w * 0.4, 0.38, -w * 0.12, 1, w * 0.18, 0.46, w * 0.46, 0.8, w * 0.72, 0.4, w, 0]
    : [-w, 0, -w * 0.9, 0.45, -w * 0.55, 0.85, 0, 1, w * 0.55, 0.85, w * 0.9, 0.45, w, 0];
  const p = mapAll(fr, shape, h);
  beam.occlude(p);
  beam.poly(p, false, col, I, { ends: true, dot: 1.4 });
}

// A convex-ish faceted solid: its faces are drawn far to near, only those facing the eye.
function solid(beam, cam, verts, faces, center, col, I, fill = true) {
  const pr = verts.map((v) => cam.P(v[0], v[1], v[2]));
  if (pr.some((p) => p.d <= cam.near)) return;
  const e = cam.eyeRaw, list = [];
  for (const f of faces) {
    let nx = 0, ny = 0, nz = 0, fx = 0, fy = 0, fz = 0;
    for (let k = 0; k < f.length; k++) {
      const a = verts[f[k]], b = verts[f[(k + 1) % f.length]];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
      fx += a[0]; fy += a[1]; fz += a[2];
    }
    fx /= f.length; fy /= f.length; fz /= f.length;
    if (nx * (fx - center[0]) + ny * (fy - center[1]) + nz * (fz - center[2]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (nx * (e[0] - fx) + ny * (e[1] - fy) + nz * (e[2] - fz) <= 0) continue;
    let d = 0;
    for (const k of f) d += pr[k].d;
    list.push({ f, d: d / f.length });
  }
  list.sort((a, b) => b.d - a.d);
  for (const { f } of list) {
    const p = [];
    for (const k of f) p.push(pr[k].x, pr[k].y);
    if (fill) beam.occlude(p);
    beam.poly(p, true, col, I, { ends: "all", dot: 1.5 });
  }
}

export function rock(beam, cam, r, I, scale = 1) {
  const s = r.size * scale, b = cam.P(r.x, r.y, r.z);
  if (b.d <= cam.near) return;
  const px = (s * cam.F) / b.d;
  if (px < 1.2) return;
  const col = PAL.rock;
  I *= 0.55 + 0.35 * r.tint;
  if (px < 5) {
    const q = cam.P(r.x, r.y + (s * 0.5) / cam.vex, r.z), w = px * 0.5;
    const p = [b.x - w, b.y, q.x, q.y, b.x + w, b.y];
    beam.occlude(p);
    beam.poly(p, true, col, I, { ends: "all", dot: 1.3 });
    return;
  }
  const seed = Math.floor(r.tint * 1e6), n = px < 14 ? 5 : 6, verts = [], faces = [];
  const ht = s * (0.45 + 0.3 * hash(seed, 0, 2)), top = [];
  for (let k = 0; k < n; k++) {
    const a = r.yaw + (k / n) * 6.283, rr = s * 0.55 * (0.8 + 0.4 * hash(seed, k, 3));
    verts.push([r.x + Math.cos(a) * rr, r.y - 0.05 * s, r.z + Math.sin(a) * rr]);
  }
  for (let k = 0; k < n; k++) {
    const a = r.yaw + ((k + 0.5) / n) * 6.283, rr = s * 0.34 * (0.75 + 0.5 * hash(seed, k, 4));
    verts.push([r.x + Math.cos(a) * rr, r.y + ht * (0.85 + 0.3 * hash(seed, k, 5)), r.z + Math.sin(a) * rr]);
    top.push(n + k);
  }
  for (let k = 0; k < n; k++) {
    faces.push([k, (k + 1) % n, n + k]);
    faces.push([(k + 1) % n, n + ((k + 1) % n), n + k]);
  }
  faces.push(top);
  solid(beam, cam, verts, faces, [r.x, r.y + ht * 0.4, r.z], col, I);
}

// A pyramid tent with its door toward the fire, crossed poles above the peak, and guy lines to pegs.
export function tent(beam, cam, t, w, I) {
  const { x, z } = t.at, a = t.size * 0.55, hgt = t.size * 0.95;
  const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw), rx = fz, rz = -fx, col = PAL.camp;
  const c = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([f, r]) => { const px = x + (fx * f + rx * r) * a, pz = z + (fz * f + rz * r) * a; return [px, w.heightAt(px, pz), pz]; });
  const base = t.at.y, apex = [x, base + hgt, z], verts = [...c, apex];
  const faces = [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]];
  const pr = verts.map((v) => cam.P(v[0], v[1], v[2]));
  // guy lines and pegs behind everything else of the tent
  for (let k = 0; k < 4; k++) {
    const m = [(c[k][0] + apex[0] * 0.8) / 1.8, (c[k][1] + apex[1] * 0.8) / 1.8, (c[k][2] + apex[2] * 0.8) / 1.8];
    const ox = c[k][0] + (c[k][0] - x) * 0.55, oz = c[k][2] + (c[k][2] - z) * 0.55, oy = w.heightAt(ox, oz);
    const A = cam.P(m[0], m[1], m[2]), B = cam.P(ox, oy, oz), T = cam.P(ox, oy + 0.3, oz);
    beam.seg(A.x, A.y, B.x, B.y, col, I * 0.35);
    beam.seg(B.x, B.y, T.x, T.y, col, I * 0.7);
  }
  solid(beam, cam, verts, faces, [x, base + hgt * 0.3, z], col, I);
  // door on the face toward the fire, seams on every face that shows
  const eye = cam.eyeRaw;
  faces.forEach((f, k) => {
    const cxm = (verts[f[0]][0] + verts[f[1]][0]) / 2, czm = (verts[f[0]][2] + verts[f[1]][2]) / 2, cym = (verts[f[0]][1] + verts[f[1]][1]) / 2;
    const nx = cxm - x, nz = czm - z;
    if (nx * (eye[0] - cxm) + (hgt * 0.5) * (eye[1] - cym) + nz * (eye[2] - czm) <= 0) return;
    const M = cam.P(cxm, cym, czm);
    if (k === 0) {
      const L = cam.P(verts[f[0]][0] * 0.62 + verts[f[1]][0] * 0.38, cym, verts[f[0]][2] * 0.62 + verts[f[1]][2] * 0.38);
      const R = cam.P(verts[f[0]][0] * 0.38 + verts[f[1]][0] * 0.62, cym, verts[f[0]][2] * 0.38 + verts[f[1]][2] * 0.62);
      const T = cam.P(cxm * 0.45 + x * 0.55, cym + hgt * 0.55, czm * 0.45 + z * 0.55);
      beam.poly([L.x, L.y, T.x, T.y, R.x, R.y], false, col, I * 1.05, { ends: true });
      beam.seg(M.x, M.y, T.x, T.y, col, I * 0.6);
    } else beam.seg(M.x, M.y, pr[4].x, pr[4].y, col, I * 0.3);
  });
  for (let k = 0; k < 3; k++) {
    const ang = t.yaw + k * 2.1 + 0.4, e = cam.P(x + Math.sin(ang) * 0.35, base + hgt + 0.45, z + Math.cos(ang) * 0.35);
    beam.seg(pr[4].x, pr[4].y, e.x, e.y, col, I * 0.9);
  }
}

// Stick figures in three poses, facing the fire.
const POSES = {
  stand: { foot: [[-0.13, 0, 0], [0.13, 0, 0.06]], knee: [[-0.11, 0.5, 0.03], [0.12, 0.5, 0.07]], hip: [0, 0.95, 0], neck: [0, 1.45, 0], sh: [[-0.21, 1.42, 0], [0.21, 1.42, 0]], el: [[-0.27, 1.17, 0.12], [0.27, 1.17, 0.12]], hand: [[-0.14, 1.12, 0.38], [0.14, 1.12, 0.38]], head: [0, 1.63, 0.01] },
  sit: { foot: [[-0.18, 0, 0.55], [0.18, 0, 0.52]], knee: [[-0.16, 0.48, 0.38], [0.16, 0.48, 0.36]], hip: [0, 0.3, 0], neck: [0, 0.86, -0.04], sh: [[-0.2, 0.83, -0.04], [0.2, 0.83, -0.04]], el: [[-0.24, 0.6, 0.18], [0.24, 0.6, 0.18]], hand: [[-0.14, 0.5, 0.36], [0.14, 0.5, 0.36]], head: [0, 1.04, -0.02] },
  crouch: { foot: [[-0.18, 0, 0.05], [0.18, 0, 0.12]], knee: [[-0.2, 0.46, 0.3], [0.2, 0.46, 0.36]], hip: [0, 0.52, -0.08], neck: [0, 1.0, 0.18], sh: [[-0.2, 0.98, 0.17], [0.2, 0.98, 0.17]], el: [[-0.26, 0.78, 0.36], [0.22, 0.8, 0.4]], hand: [[-0.12, 0.62, 0.55], [0.1, 0.72, 0.62]], head: [0, 1.17, 0.27] },
};
export function person(beam, cam, p, pose, I) {
  const P0 = POSES[pose], fx = Math.sin(p.yaw), fz = Math.cos(p.yaw), rx = fz, rz = -fx, { x, y, z } = p.at;
  const W = ([r, u, f]) => cam.P(x + rx * r + fx * f, y + u, z + rz * r + fz * f);
  const col = PAL.people, o = { ends: "all", dot: 2.4, width: 1.6 };
  const hip = W(P0.hip), neck = W(P0.neck);
  for (let s = 0; s < 2; s++) {
    const F = W(P0.foot[s]), K = W(P0.knee[s]), S = W(P0.sh[s]), E = W(P0.el[s]), H = W(P0.hand[s]);
    beam.poly([F.x, F.y, K.x, K.y, hip.x, hip.y], false, col, I, o);
    beam.poly([neck.x, neck.y, S.x, S.y, E.x, E.y, H.x, H.y], false, col, I, o);
  }
  beam.poly([hip.x, hip.y, neck.x, neck.y], false, col, I, o);
  const hc = W(P0.head), r = (0.13 * cam.F) / hc.d, head = [];
  for (let k = 0; k < 10; k++) head.push(hc.x + Math.cos((k / 10) * 6.283) * r, hc.y + Math.sin((k / 10) * 6.283) * r * 1.12);
  beam.occlude(head);
  beam.poly(head, true, col, I * 1.05);
  if (pose === "crouch") {
    const H = W(P0.hand[1]), T = cam.P(p.at.x + fx * 1.9, y + 0.25, p.at.z + fz * 1.9);
    beam.seg(H.x, H.y, T.x, T.y, PAL.camp, I * 0.8);
  }
}

// A log as a wire cylinder: black silhouette hull, outline, and the growth rings on the end that faces the eye.
export function log(beam, cam, a, b, rad, I, rings = true) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz);
  const ax = dx / L, ay = dy / L, az = dz / L;
  let ux = -az, uy = 0, uz = ax;
  const ul = Math.hypot(ux, uz) || 1;
  ux /= ul; uz /= ul;
  const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
  const ring = (c) => { const p = []; for (let k = 0; k < 8; k++) { const t = (k / 8) * 6.283, cs = Math.cos(t) * rad, sn = Math.sin(t) * rad; p.push(cam.P(c[0] + ux * cs + vx * sn, c[1] + uy * cs + vy * sn, c[2] + uz * cs + vz * sn)); } return p; };
  const A = ring(a), B = ring(b);
  if (A.some((p) => p.d <= cam.near) || B.some((p) => p.d <= cam.near)) return;
  const pts = [...A, ...B].map((p) => [p.x, p.y]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length > 1 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.reverse()) { while (hi.length > 1 && cross(hi.at(-2), hi.at(-1), p) <= 0) hi.pop(); hi.push(p); }
  const hull = [...lo.slice(0, -1), ...hi.slice(0, -1)].flat();
  const col = PAL.camp;
  beam.occlude(hull);
  beam.poly(hull, true, col, I * 0.8);
  const e = cam.eyeRaw, facingA = (e[0] - a[0]) * -ax + (e[1] - a[1]) * -ay + (e[2] - a[2]) * -az > 0;
  const end = facingA ? A : B, c = facingA ? a : b;
  const p = end.flatMap((q) => [q.x, q.y]);
  beam.poly(p, true, col, I);
  if (rings) {
    const C = cam.P(c[0], c[1], c[2]), inner = p.map((v, k) => (k % 2 ? C.y + (v - C.y) * 0.5 : C.x + (v - C.x) * 0.5));
    beam.poly(inner, true, col, I * 0.6);
    beam.dot(C.x, C.y, col, I);
  }
}

export function woodpile(beam, cam, w, wp, fire, I) {
  const dx = wp.x - fire.x, dz = wp.z - fire.z, dl = Math.hypot(dx, dz), tx = -dz / dl, tz = dx / dl, rad = 0.13, len = 1.7;
  const rows = [5, 4, 3, 2], logs = [];
  rows.forEach((n, row) => {
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * rad * 2.05, cx = wp.x + (dx / dl) * off, cz = wp.z + (dz / dl) * off, cy = wp.y + rad + row * rad * 1.75;
      const j = 0.12 * (hash(row, k, 21) - 0.5);
      logs.push({ a: [cx - tx * (len / 2 + j), cy, cz - tz * (len / 2 + j)], b: [cx + tx * (len / 2 - j), cy, cz + tz * (len / 2 - j)] });
    }
  });
  for (const L of logs) L.d = cam.P((L.a[0] + L.b[0]) / 2, L.a[1], (L.a[2] + L.b[2]) / 2).d - L.a[1] * 0.3;
  logs.sort((p, q) => q.d - p.d);
  for (const L of logs) log(beam, cam, L.a, L.b, rad, I);
  // stakes holding the stack at each end
  for (const s of [-1, 1]) for (const e of [-1, 1]) {
    const x = wp.x + tx * s * (len / 2 - 0.2) + (dx / dl) * e * rad * 5.6, z = wp.z + tz * s * (len / 2 - 0.2) + (dz / dl) * e * rad * 5.6;
    const B = cam.P(x, w.heightAt(x, z), z), T = cam.P(x, wp.y + 0.95, z);
    beam.seg(B.x, B.y, T.x, T.y, PAL.camp, I * 0.8);
  }
}

// Flickering vector flames in three nested colours, a ring of stones, crossed logs, sparks and a thread of smoke.
export function fire(beam, cam, w, f, I, rand) {
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * 6.283 + 0.3, x = f.x + Math.cos(a) * 0.82, z = f.z + Math.sin(a) * 0.82;
    rock(beam, cam, { x, y: w.heightAt(x, z), z, size: 0.22 + 0.08 * hash(k, 1, 31), yaw: a, tint: hash(k, 2, 31) }, I * 0.75);
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * 6.283 + 0.7, x0 = f.x + Math.cos(a) * 0.75, z0 = f.z + Math.sin(a) * 0.75;
    log(beam, cam, [x0, f.y + 0.1, z0], [f.x + Math.cos(a) * 0.08, f.y + 0.42, f.z + Math.sin(a) * 0.08], 0.07, I * 0.8, false);
  }
  const layers = [[PAL.fire, 1, 0.8], [[1, 0.55, 0.15], 0.72, 0.65], [PAL.flame, 0.45, 0.75]];
  beam.glow(() => {
    for (const [col, sc, li] of layers) {
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * 6.283 + rand() * 0.6, r0 = 0.42 * sc, hgt = (0.9 + rand() * 1.1) * sc * (k % 2 ? 0.75 : 1.15);
        const bx = f.x + Math.cos(a) * r0 * 0.4, bz = f.z + Math.sin(a) * r0 * 0.4, lean = (rand() - 0.5) * 0.25;
        const pts = [];
        const steps = 6;
        for (let s = 0; s <= steps * 2; s++) {
          const t = s <= steps ? s / steps : 2 - s / steps, side = s <= steps ? -1 : 1;
          const width = r0 * 0.55 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.5);
          const wob = Math.sin(t * 9 + k * 2 + rand() * 1.5) * 0.06 * t;
          const P = cam.P(bx + Math.cos(a + 1.57) * width * side + lean * t + wob, f.y + 0.3 + hgt * t, bz + Math.sin(a + 1.57) * width * side);
          pts.push(P.x, P.y);
        }
        beam.poly(pts, false, col, I * li * 0.62, { ends: true, dot: 1.8 });
      }
    }
    for (let k = 0; k < 34; k++) {
      const hgt = 1.2 + rand() ** 1.6 * 4.2, a = rand() * 6.283, r = rand() * 0.5 + hgt * 0.12;
      const P = cam.P(f.x + Math.cos(a) * r, f.y + hgt, f.z + Math.sin(a) * r), Q = cam.P(f.x + Math.cos(a) * r * 0.97, f.y + hgt - 0.12, f.z + Math.sin(a) * r * 0.97);
      beam.seg(P.x, P.y, Q.x, Q.y, rand() < 0.5 ? PAL.flame : PAL.fire, I * (0.4 + 0.6 * rand()) * (1.3 - hgt / 6));
    }
    for (let k = 0; k < 18; k++) {
      const a = rand() * 6.283, r = rand() * 0.55, P = cam.P(f.x + Math.cos(a) * r, f.y + 0.12, f.z + Math.sin(a) * r);
      beam.dot(P.x, P.y, PAL.fire, I * (0.5 + rand() * 0.6), 2);
    }
  });
  for (let s = 0; s < 2; s++) {
    const pts = [];
    for (let k = 0; k <= 16; k++) {
      const t = k / 16, P = cam.P(f.x + Math.sin(t * 7 + s * 2.4) * (0.2 + t * 0.9) + t * 1.4, f.y + 2.2 + t * 7, f.z + Math.cos(t * 5 + s) * 0.3 * t);
      pts.push(P.x, P.y);
    }
    beam.poly(pts, false, [0.6, 0.66, 0.8], I * (0.32 - s * 0.1));
  }
}

export function tuft(beam, cam, g, I) {
  const B = cam.P(g.x, g.y, g.z);
  if (B.d <= cam.near) return;
  const col = PAL.plant, n = 3;
  for (let k = 0; k < n; k++) {
    const a = g.yaw + (k - 1) * 0.9, lean = 0.08 + 0.1 * ((k * 0.37 + g.tint) % 1);
    const T = cam.P(g.x + Math.cos(a) * lean, g.y + g.tall * (k === 1 ? 1 : 0.75), g.z + Math.sin(a) * lean);
    beam.seg(B.x, B.y, T.x, T.y, col, I * (0.26 + 0.24 * g.tint));
  }
}

export function flower(beam, cam, fl, I) {
  const B = cam.P(fl.x, fl.y, fl.z), T = cam.P(fl.x, fl.y + fl.tall, fl.z);
  if (B.d <= cam.near) return;
  const col = fl.hue < 0.4 ? PAL.sand : fl.hue < 0.7 ? PAL.people : PAL.fire;
  beam.seg(B.x, B.y, T.x, T.y, PAL.plant, I * 0.45);
  const r = Math.max(1.2, (0.07 * cam.F) / T.d);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * 3.1416 + fl.hue * 3;
    beam.seg(T.x - Math.cos(a) * r, T.y - Math.sin(a) * r * 0.6, T.x + Math.cos(a) * r, T.y + Math.sin(a) * r * 0.6, col, I * 0.95);
  }
}

export function pebble(beam, cam, p, I) {
  const pts = [];
  for (let k = 0; k < 5; k++) {
    const a = p.yaw + (k / 5) * 6.283, r = p.size * (0.4 + 0.25 * hash(k, Math.floor(p.tint * 1e4), 41));
    const P = cam.P(p.x + Math.cos(a) * r, p.y + (k % 2) * p.size * 0.12, p.z + Math.sin(a) * r);
    if (P.d <= cam.near) return;
    pts.push(P.x, P.y);
  }
  beam.occlude(pts);
  beam.poly(pts, true, PAL.rock, I * (0.4 + 0.3 * p.tint));
}
