// Surface stitches worked over the cross stitch once the ground is done: French knots for flowers and pebbles, lazy
// daisies for shrubs, straight stitches for reeds and grass, satin for tents, and the camp's little people, fire and
// woodpile. Everything is placed where the world puts it.
import { clamp, hash } from "../world.js";
import { RAMP } from "./floss.js";

const TAU = Math.PI * 2;
const FLOWERS = [726, "blanc", 3354, 340, 726, "blanc"];

export function details(w, V, ch, COLORS) {
  const { kind, mpc } = V, { cols, rows, key, type, cls, ground } = ch, ops = ch.ops, backs = ch.backs;
  const K = (i, j) => j * cols + i;
  const ok = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows && V.inside(i, j);
  const cover = (i, j) => (ok(i, j) && ground[K(i, j)] && cls[K(i, j)] === 9 && !ch.canopy[K(i, j)] ? ground[K(i, j)].cover : -1);
  const push = (o) => ops.push(o);
  // squares taken by a motif, so the scatter of grass and flowers keeps off it
  const busy = new Uint8Array(cols * rows);
  const isBusy = (u, v) => { const i = Math.floor(u), j = Math.floor(v); return !ok(i, j) || busy[K(i, j)] === 1; };
  const clearPoly = (poly, grow = 0) => {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const [u, v] of poly) { u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v); }
    for (let j = Math.floor(v0 - 1); j <= v1 + 1; j++)
      for (let i = Math.floor(u0 - 1); i <= u1 + 1; i++) {
        if (!ok(i, j)) continue;
        if (insidePoly(poly, i + 0.5, j + 0.5, grow)) type[K(i, j)] = 0;
        if (insidePoly(poly, i + 0.5, j + 0.5, grow + 0.9)) busy[K(i, j)] = 1;
      }
  };

  if (kind === "island") island();
  else closer();

  function waves(every, key0, len) {
    for (let j = 2; j < rows - 3; j += every)
      for (let i = 2 + (Math.floor(j / every) % 2) * Math.floor(every / 2); i < cols - len - 2; i += every) {
        const ii = i + Math.floor(hash(i, j, 300) * 3) - 1, jj = j + Math.floor(hash(i, j, 301) * 3) - 1;
        let clear = true;
        for (let dj = -2; dj <= 2 && clear; dj++) for (let di = -1; di <= len + 1 && clear; di++) { const q = K(clamp(ii + di, 0, cols - 1), clamp(jj + dj, 0, rows - 1)); if (!ok(ii + di, jj + dj) || type[q] || busy[q] || cls[q] !== 1) clear = false; }
        if (!clear || hash(i, j, 302) < 0.15) continue;
        // a low arch of backstitch, the way samplers draw the sea
        const pts = len === 3 ? [[0, 1], [1, 0], [2, 0], [3, 1]] : [[0, 1], [1, 0], [2, 1], [3, 0], [4, 1]];
        for (let s = 1; s < pts.length; s++) backs.push({ i0: ii + pts[s - 1][0], j0: jj + pts[s - 1][1], i1: ii + pts[s][0], j1: jj + pts[s][1], key: key0, r: 0.19 });
      }
  }

  function island() {
    compass();
    waves(5, 519, 4);
    // shrubs counted per square, so heath shows as lazy daisies where there is a lot of it
    const sc = new Uint16Array(cols * rows), sh = new Float32Array(cols * rows);
    for (const s of w.shrubs) { const [u, v] = V.fabOf(s.x, s.z), i = Math.floor(u), j = Math.floor(v); if (ok(i, j)) { sc[K(i, j)]++; sh[K(i, j)] += s.heath; } }
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = K(i, j), c = cover(i, j), r = hash(i, j, 310);
        if (c < 0) continue;
        if (c === 2 && r < 0.09) push({ t: "knot", u: i + 0.3 + hash(i, j, 311) * 0.4, v: j + 0.3 + hash(i, j, 312) * 0.4, c: FLOWERS[Math.floor(hash(i, j, 313) * 6)], r: 0.34 });
        else if ((c === 4 && r < 0.06) || (c === 5 && r < 0.08)) push({ t: "knot", u: i + 0.5, v: j + 0.5, c: [413, 647, 3023][Math.floor(hash(i, j, 314) * 3)], r: 0.3 });
        else if (c === 3 && r < 0.07) reeds(i + 0.5, j + 0.9, 1.3, 3);
        if (sc[k] >= 4 && sh[k] / sc[k] > 0.4 && hash(i, j, 315) < 0.3) daisy(i + 0.5, j + 0.5, 0.75, hash(i, j, 316) < 0.5 ? 3041 : 3740, 3042, 5);
        else if (sc[k] >= 8 && hash(i, j, 315) < 0.05) daisy(i + 0.5, j + 0.5, 0.7, 988, null, 4);
      }
    // the camp, as a sampler would mark it: a tiny satin tent and a knot of fire
    const [cu, cv] = V.fabOf(w.camp.at.x, w.camp.at.z);
    for (let j = Math.floor(cv - 2); j <= cv + 1; j++) for (let i = Math.floor(cu - 2); i <= cu + 2; i++) if (ok(i, j)) type[K(i, j)] = 0;
    tent(cu - 0.2, cv + 0.6, 2.4, 2.0, 3033, 3862);
    push({ t: "knot", u: cu + 1.2, v: cv + 0.4, c: 946, r: 0.36 });

    // where the working thread comes up: a stitched square near the hoop's lower right
    let best = Infinity;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        if (type[K(i, j)] !== 1) continue;
        const d = Math.hypot(i - (V.uc + 36), j - (V.vc + 33));
        if (d < best) { best = d; V.lastStitch = [i + 1, j, key[K(i, j)]]; }
      }
    // a couple of thread ends not yet woven in
    tailNear(3750, 1, 0.7);
    tailNear(3346, 9, 1.5);
  }

  function closer() {
    const cam = w.camp, [fu, fv] = V.fabOf(cam.fire.x, cam.fire.z), grow = kind === "valley" ? 6 : 1;
    // camp layout, spread a little in the valley so a tent is more than a stitch
    const at = (p) => { const [u, v] = V.fabOf(p.x, p.z); return [fu + (u - fu) * grow, fv + (v - fv) * grow]; };
    const cs = kind === "camp";
    if (!cs) waves(9, 518, 4);
    // rocks: big ones are stitched in grey squares, small ones are knots
    const view = (u, v) => u > -1 && v > -1 && u < cols + 1 && v < rows + 1;
    for (const r of w.rocks) {
      const [u, v] = V.fabOf(r.x, r.z);
      if (!view(u, v)) continue;
      const i = Math.floor(u), j = Math.floor(v);
      if (!ok(i, j) || cls[K(i, j)] !== 9) continue;
      const rc = (r.size * 0.45) / mpc;
      if (rc > 0.55) {
        for (let jj = Math.floor(v - rc); jj <= v + rc; jj++)
          for (let ii = Math.floor(u - rc); ii <= u + rc; ii++) {
            if (!ok(ii, jj) || Math.hypot(ii + 0.5 - u, jj + 0.5 - v) > rc + 0.2) continue;
            const lt = -((ii + 0.5 - u) * V.lightS[0] + (jj + 0.5 - v) * V.lightS[1]) / Math.max(rc, 0.5);
            key[K(ii, jj)] = RAMP.rock[lt > 0.2 ? 2 : lt < -0.35 ? 0 : 1]; type[K(ii, jj)] = 1;
          }
      } else if (hash(i, j, 320) < 0.7) push({ t: "knot", u, v, c: [413, 647, 3023][Math.floor(r.tint * 3)], r: clamp(0.22 + rc * 0.5, 0.22, 0.45) });
    }
    // shrubs as lazy daisies: purple where they are heather, green where they are scrub
    for (const s of w.shrubs) {
      const [u, v] = V.fabOf(s.x, s.z);
      if (!view(u, v)) continue;
      const i = Math.floor(u), j = Math.floor(v);
      if (!ok(i, j) || cls[K(i, j)] !== 9 || ch.canopy[K(i, j)]) continue;
      const len = clamp((0.5 + s.tall * 0.25) * (cs ? 1.6 : 1) * (6 / Math.max(mpc, 1.5)) * 0.18, 0.45, 1.3);
      daisy(u, v, len, s.heath > 0.45 ? (s.tint < 0.5 ? 3041 : 3740) : s.tint < 0.5 ? 3346 : 987, s.heath > 0.45 ? 3042 : null, s.tint < 0.3 ? 4 : 5, s.yaw);
    }
    // ground cover stitches
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const c = cover(i, j), r = hash(i, j, 330);
        if (c < 0) continue;
        const shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => ok(i + a, j + b) && (cls[K(i + a, j + b)] === 1 || cls[K(i + a, j + b)] === 2));
        if (c === 3 && r < (shore ? 0.3 : cs ? 0.08 : 0.07)) reeds(i + hash(i, j, 331), j + 0.95, cs ? 2.2 : 1.2, 3 + Math.floor(hash(i, j, 332) * 2));
        else if (c === 2 && r < (cs ? 0 : 0.05)) push({ t: "knot", u: i + 0.25 + hash(i, j, 333) * 0.5, v: j + 0.25 + hash(i, j, 334) * 0.5, c: FLOWERS[Math.floor(hash(i, j, 335) * 6)], r: 0.3 });
        else if (c === 2 && r < (cs ? 0 : 0.062)) flower(i + 0.5, j + 0.5, 0.55, "blanc", 726);
        else if (c === 5 && r < 0.05) push({ t: "knot", u: i + 0.5, v: j + 0.5, c: [647, 3023][Math.floor(hash(i, j, 336) * 2)], r: 0.25 });
      }

    // ---------- the camp ----------
    const trod = (u, v) => {
      if (Math.hypot(u - fu, v - fv) < (cs ? 3.4 / mpc : 2.3)) return 1;
      const [wu, wv] = at(cam.woodpile);
      if (Math.hypot(u - wu, v - wv) < (cs ? 1.6 / mpc : 0.9)) return 1;
      return 0;
    };
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        if (!ok(i, j) || cls[K(i, j)] !== 9) continue;
        const u = i + 0.5, v = j + 0.5, d = Math.hypot(u - fu, v - fv) * (cs ? mpc : 1);
        if (trod(u, v)) type[K(i, j)] = 0;
        // grass thins toward the fire: half stitches, then cloth
        else if (cs && d < 6.2 && hash(i, j, 340) < (6.2 - d) / 2.4) type[K(i, j)] = hash(i, j, 341) < 0.6 ? 2 : 0;
      }
    const TENTS = [3033, 3864, 738], TRIM = [3862, 3862, 433];
    const items = [];
    cam.tents.forEach((t, k) => {
      const [u, v] = at(t.at), s = t.size / (cs ? mpc : mpc / grow);
      items.push([v, () => tent(u, v, s * 1.25, s * 0.95, TENTS[k], TRIM[k])]);
    });
    cam.people.forEach((p, k) => { const [u, v] = at(p.at); items.push([v, () => person(u, v, cs ? 1 : 0.34, COLORS[(k * 5 + 2) % COLORS.length], k)]); });
    {
      const [u, v] = at(cam.woodpile);
      items.push([v, () => woodpile(u, v, cs ? 1 : 0.4)]);
    }
    items.push([fv, () => fire(fu, fv, cs ? 1 : 0.42)]);
    items.sort((a, b) => a[0] - b[0]);
    for (const [, f] of items) f();
    if (cs) {
      // the small things around the camp, from the world's own scatter
      const nb = w.nearby(cam.at, 19, 2.2);
      for (const g of nb.grass) {
        const [u, v] = V.fabOf(g.x, g.z);
        if (!view(u, v)) continue;
        const i = Math.floor(u), j = Math.floor(v);
        if (isBusy(u, v) || isBusy(u, v - 1) || hash(Math.floor(u * 7), Math.floor(v * 7), 350) > 0.5) continue;
        const n = 2 + Math.floor(g.tint * 2.5), L = 0.55 + g.tall * 1.1, c = [988, 470, 3346, 581][Math.floor(g.tint * 4)];
        for (let q = 0; q < n; q++) {
          const a = -Math.PI / 2 + (q - (n - 1) / 2) * 0.38 + (hash(q, i, j) - 0.5) * 0.3;
          push({ t: "straight", u0: u + (q - (n - 1) / 2) * 0.08, v0: v, u1: u + Math.cos(a) * L, v1: v + Math.sin(a) * L, c, r: 0.1, plies: 1, dive1: 0.6 });
        }
      }
      for (const f of nb.flowers) {
        const [u, v] = V.fabOf(f.x, f.z);
        if (!view(u, v) || isBusy(u, v) || isBusy(u + 0.7, v) || isBusy(u - 0.7, v) || isBusy(u, v - 0.7) || isBusy(u, v + 0.7)) continue;
        if (f.hue < 0.45) flower(u, v, 0.5 + f.tall, f.hue < 0.2 ? "blanc" : f.hue < 0.33 ? 3354 : 340, 726, 5, f.hue * 20);
        else push({ t: "knot", u, v, c: FLOWERS[Math.floor(f.hue * 6)], r: 0.34 });
      }
      for (const p of nb.pebbles) {
        const [u, v] = V.fabOf(p.x, p.z);
        if (!view(u, v) || isBusy(u, v)) continue;
        push({ t: "knot", u, v, c: [413, 647, 3023][Math.floor(p.tint * 3)], r: clamp(0.25 + p.size * 0.5, 0.25, 0.55) });
      }
      tailNear(946, 21, 2.4, [fu + 3.2, fv + 1.4]);
      tailNear(3862, 22, 2.8, [fu - 9, fv + 5]);
    } else {
      tailNear(3052, 23, 2.2);
      tailNear(518, 24, 2.6);
      tailNear(3346, 25, 2.0);
    }
  }

  // A sampler's compass rose in open sea: a star in backstitch with dark satin on one side of each point.
  function compass() {
    for (const S of [5, 4, 3]) {
      const free = (ci, cj) => {
        for (let j = cj - S - 5; j <= cj + S + 1; j++) for (let i = ci - S - 1; i <= ci + S + 1; i++) { const k = K(i, j); if (!ok(i, j) || type[k] || cls[k] !== 1) return false; }
        return true;
      };
      let at = null, best = -Infinity;
      for (let cj = S + 6; cj < rows - S - 2; cj++)
        for (let ci = S + 2; ci < cols - S - 2; ci++) {
          // prefer the upper right, where a map puts its compass
          const pref = (ci - V.uc) - (cj - V.vc);
          if (pref > best && free(ci, cj)) { best = pref; at = [ci, cj]; }
        }
      if (!at) continue;
      const [ci, cj] = at, D = S - 2, L = [[0, -S], [1, -1], [S, 0], [1, 1], [0, S], [-1, 1], [-S, 0], [-1, -1]];
      for (let j = cj - S - 5; j <= cj + S + 1; j++) for (let i = ci - S - 1; i <= ci + S + 1; i++) busy[K(i, j)] = 1;
      for (let q = 0; q < 8; q++) { const a = L[q], b = L[(q + 1) % 8]; backs.push({ i0: ci + a[0], j0: cj + a[1], i1: ci + b[0], j1: cj + b[1], key: 3750, r: 0.2 }); }
      for (let q = 0; q < 4; q++) { const a = L[q * 2], b = L[q * 2 + 1]; backs.push({ i0: ci, j0: cj, i1: ci + a[0], j1: cj + a[1], key: 3750, r: 0.16 }); push({ t: "satin", poly: [[ci, cj], [ci + a[0], cj + a[1]], [ci + b[0], cj + b[1]]], a: Math.atan2(a[1], a[0]), c: q === 0 ? 321 : 3750, gap: 0.3, r: 0.17, lift: 0.08 }); }
      for (const [a, b] of [[D, -D], [D, D], [-D, D], [-D, -D]]) backs.push({ i0: ci, j0: cj, i1: ci + a, j1: cj + b, key: 519, r: 0.16 });
      push({ t: "knot", u: ci, v: cj, c: 726, r: 0.5 });
      for (const [a, b, c2, d] of [[-1, -S - 2, -1, -S - 5], [-1, -S - 5, 1, -S - 2], [1, -S - 2, 1, -S - 5]]) backs.push({ i0: ci + a, j0: cj + b, i1: ci + c2, j1: cj + d, key: 321, r: 0.2 });
      return;
    }
  }

  // ---------- motifs ----------
  function reeds(u, v, L, n) {
    for (let q = 0; q < n; q++) {
      const a = -Math.PI / 2 + (q - (n - 1) / 2) * 0.22 + (hash(u * 7, v * 3, q) - 0.5) * 0.2, l = L * (0.75 + 0.4 * hash(u * 5, v, q + 9));
      const u0 = u + (q - (n - 1) / 2) * 0.12, u1 = u0 + Math.cos(a) * l, v1 = v + Math.sin(a) * l;
      push({ t: "straight", u0, v0: v, u1, v1, c: q % 2 ? 3051 : 3052, r: 0.09, plies: 1 });
      if (hash(u * 3, v * 9, q) < 0.16) push({ t: "straight", u0: u1 - Math.cos(a) * l * 0.28, v0: v1 - Math.sin(a) * l * 0.28, u1: u1 - Math.cos(a) * 0.05, v1: v1 - Math.sin(a) * 0.05, c: 801, r: 0.15, plies: 2, dive0: 0.5 });
    }
  }
  function daisy(u, v, len, c, centre, n = 5, rot = 0) { push({ t: "flower", u, v, n, len, c, centre, rot, r: 0.12 }); }
  function flower(u, v, len, petal, centre, n = 5, rot = 0) { daisy(u, v, len, petal, centre, n, rot); }
  // an A-frame tent standing on (u, v): satin laid along each slope, a dark door, a line of backstitch round it
  function tent(u, v, wd, ht, c, trim) {
    const L = [u - wd / 2, v], R = [u + wd / 2, v], A = [u + wd * 0.04, v - ht];
    clearPoly([L, R, A], wd > 3 ? 0.15 : 0.35);
    const lean = Math.atan2(A[1] - L[1], A[0] - L[0]), lean2 = Math.atan2(R[1] - A[1], R[0] - A[0]);
    const mid = [u + wd * 0.04, v];
    const sm = wd > 3 ? 1 : 0.8;
    push({ t: "satin", poly: [L, mid, A], a: lean, c, gap: 0.26 * sm, r: 0.15 * sm, lift: 0.1, shade: () => 0.92, z: 0.1 });
    push({ t: "satin", poly: [mid, R, A], a: lean2, c, gap: 0.26 * sm, r: 0.15 * sm, lift: 0.1, z: 0.1 });
    // door flap folded back
    const dw = wd * 0.2, dh = ht * 0.55, D0 = [mid[0] - dw, v], D1 = [mid[0] + dw, v], DA = [mid[0], v - dh];
    push({ t: "satin", poly: [D0, D1, DA], a: Math.PI / 2, c: 3371, gap: 0.2 * sm, r: 0.13 * sm, lift: 0.05, z: 0.35 });
    const lines = [[L, A], [A, R], [L, R], [mid, A]];
    for (const [p, q] of lines) push({ t: "straight", u0: p[0], v0: p[1], u1: q[0], v1: q[1], c: trim, r: 0.1 * sm, plies: 1 });
    if (wd > 3) {
      // guy lines and pegs
      push({ t: "straight", u0: A[0] - 0.2, v0: A[1] + 0.3, u1: L[0] - wd * 0.28, v1: v + 0.3, c: 3023, r: 0.05, plies: 1 });
      push({ t: "straight", u0: A[0] + 0.2, v0: A[1] + 0.3, u1: R[0] + wd * 0.28, v1: v + 0.3, c: 3023, r: 0.05, plies: 1 });
      push({ t: "knot", u: L[0] - wd * 0.28, v: v + 0.3, c: 801, r: 0.22 });
      push({ t: "knot", u: R[0] + wd * 0.28, v: v + 0.3, c: 801, r: 0.22 });
      push({ t: "knot", u: A[0], v: A[1] - 0.1, c: 801, r: 0.3 });
    }
  }
  // a person standing at (u, v), about s * 5 squares tall
  function person(u, v, s, cloth, k) {
    const skin = k % 2 ? 951 : 407, hair = [3371, 801, 433, 3371, 738][k % 5];
    if (s < 0.5) {
      push({ t: "straight", u0: u, v0: v, u1: u, v1: v - 5 * s * 0.55, c: cloth, r: 0.2, plies: 2 });
      push({ t: "knot", u, v: v - 5 * s * 0.72, c: skin, r: 0.26 });
      return;
    }
    const hip = v - 2.1 * s, sh = v - 3.7 * s, bw = 0.7 * s;
    clearPoly([[u - bw - 0.2, v], [u + bw + 0.2, v], [u + bw + 0.2, sh - 1.2], [u - bw - 0.2, sh - 1.2]], 0.3);
    push({ t: "straight", u0: u - 0.32 * s, v0: v, u1: u - 0.22 * s, v1: hip, c: 3371, r: 0.2, plies: 2 });
    push({ t: "straight", u0: u + 0.32 * s, v0: v, u1: u + 0.22 * s, v1: hip, c: 3371, r: 0.2, plies: 2 });
    push({ t: "satin", poly: [[u - bw, hip + 0.1], [u + bw, hip + 0.1], [u + bw * 0.85, sh], [u - bw * 0.85, sh]], a: Math.PI / 2, c: cloth, gap: 0.24, r: 0.14, lift: 0.08, z: 0.1 });
    const sway = k % 2 ? 1 : -1;
    push({ t: "straight", u0: u - bw * 0.9, v0: sh + 0.15, u1: u - bw - 0.35 * s, v1: hip + 0.1 + (sway > 0 ? -0.6 : 0), c: cloth, r: 0.17, plies: 2 });
    push({ t: "straight", u0: u + bw * 0.9, v0: sh + 0.15, u1: u + bw + 0.35 * s, v1: hip + 0.1 + (sway < 0 ? -0.6 : 0), c: cloth, r: 0.17, plies: 2 });
    push({ t: "knot", u, v: sh - 0.62 * s, c: skin, r: 0.62 * s, wraps: 2 });
    push({ t: "straight", u0: u - 0.45 * s, v0: sh - 0.95 * s, u1: u + 0.45 * s, v1: sh - 1.02 * s, c: hair, r: 0.16, plies: 2 });
  }
  function fire(u, v, s) {
    const ring = s > 0.5 ? 9 : 5, R = 1.25 * s + 0.35;
    clearPoly([[u - R, v - 3 * s], [u + R, v - 3 * s], [u + R, v + R], [u - R, v + R]], 0.2);
    for (let q = 0; q < ring; q++) { const a = (q / ring) * TAU + 0.3; push({ t: "knot", u: u + Math.cos(a) * R, v: v + Math.sin(a) * R * 0.8, c: [413, 647, 3023][q % 3], r: 0.3 + 0.12 * s }); }
    // crossed logs, then flames fanning up out of them
    push({ t: "straight", u0: u - 1.1 * s, v0: v + 0.4 * s, u1: u + 1.0 * s, v1: v - 0.3 * s, c: 801, r: 0.22, plies: 2 });
    push({ t: "straight", u0: u - 1.0 * s, v0: v - 0.35 * s, u1: u + 1.1 * s, v1: v + 0.35 * s, c: 433, r: 0.22, plies: 2 });
    const F = [[321, 2.0, -0.55], [946, 2.5, -0.3], [971, 2.9, 0.02], [946, 2.4, 0.3], [321, 1.9, 0.55], [726, 1.8, -0.12], [726, 1.6, 0.16]];
    for (const [c, l, a] of F) push({ t: "straight", u0: u + a * 0.6 * s, v0: v + 0.15 * s, u1: u + a * 1.6 * s, v1: v - l * s, c, r: s > 0.5 ? 0.17 : 0.16, plies: 2, gloss: 1 });
    if (s > 0.5) {
      for (let q = 0; q < 6; q++) push({ t: "knot", u: u + (hash(q, 1, 360) - 0.5) * 2.2, v: v + 0.3 + (hash(q, 2, 360) - 0.5) * 0.8, c: q % 2 ? 946 : 726, r: 0.2 });
      // a curl of smoke in one strand of grey
      const sm = [];
      for (let q = 0; q <= 16; q++) sm.push([u + 0.3 + Math.sin(q * 0.55) * 0.55 * (q / 16 + 0.3), v - 3.1 - q * 0.32]);
      push({ t: "path", pts: sm, c: 3023, r: 0.07 });
    }
  }
  function woodpile(u, v, s) {
    const logs = s > 0.5 ? [[-1.4, 0], [0, 0], [1.4, 0], [-0.7, -1], [0.7, -1], [0, -2]] : [[-0.6, 0], [0.6, 0], [0, -0.9]];
    for (const [a, b] of logs) {
      const cu = u + a * s, cv = v + b * s, hw = 0.65 * s + 0.25, hh = 0.48 * s + 0.12, c = hash(a, b, 370) < 0.5 ? 801 : 433;
      clearPoly([[cu - hw, cv - hh], [cu + hw, cv - hh], [cu + hw, cv + hh], [cu - hw, cv + hh]]);
      push({ t: "satin", poly: [[cu - hw, cv - hh], [cu + hw, cv - hh], [cu + hw, cv + hh], [cu - hw, cv + hh]], a: Math.PI / 2, c, gap: 0.22, r: 0.13, lift: 0.06, z: 0.05 + (-b) * 0.08 });
      if (s > 0.5) push({ t: "knot", u: cu + hw * 0.55, v: cv, c: 3864, r: hh * 0.7, wraps: 3 });
    }
  }
  function tailNear(c, seed, len, near) {
    let u, v;
    if (near) [u, v] = near;
    else {
      // find a square of that colour to start from
      const cand = [];
      for (let k = 0; k < cols * rows; k++) if (key[k] === c && type[k]) cand.push(k);
      if (!cand.length) return;
      const k = cand[Math.floor(hash(seed, 1, 380) * cand.length)];
      u = (k % cols) + 1; v = Math.floor(k / cols);
    }
    push({ t: "tail", u: Math.round(u), v: Math.round(v), a: hash(seed, 2, 380) * TAU, len, c, r: 0.15, curl: (hash(seed, 3, 380) - 0.5) * 0.3 });
  }
}

function insidePoly(poly, x, y, grow) {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a], [xb, yb] = poly[b];
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  if (inside || !grow) return inside;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a], [xb, yb] = poly[b], dx = xb - xa, dy = yb - ya, t = clamp(((x - xa) * dx + (y - ya) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    if (Math.hypot(x - xa - t * dx, y - ya - t * dy) < grow) return true;
  }
  return false;
}
