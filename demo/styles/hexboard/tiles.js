// Tile bodies: a painted plateau, a chamfered rim, stacked earth slabs down the sides, carved stream channels with
// water ribbons and falls, foam where the sea meets land, and a thin outline round every rim.
import * as THREE from "three";
import { smooth, fbm, hash } from "../world.js";
import { Buf, lin, mix, mul } from "./geo.js";
import { SQ3 } from "./board.js";

const TOP = { meadow: lin("#9cc261"), forest: lin("#58873d"), heath: lin("#a3849a"), marsh: lin("#6f917b"), rock: lin("#a8aaa6"), mountain: lin("#a6a59f"), beach: lin("#f0dcaa"), camp: lin("#a6c35c") };
const COV = { tree: lin("#5b8b3c"), shrub: lin("#a0849a"), grass: lin("#a2c562"), marsh: lin("#7a9276"), bare: lin("#adaea8"), sand: lin("#f0dcaa") };
const SEA = [lin("#79cfc9"), lin("#62bccb"), lin("#4fa4c4"), lin("#428fba"), lin("#3a7fae")];
const SHALLOW = lin("#a6e2d4"), LAKE = lin("#63b6c6"), WETSAND = lin("#d9c088"), DIRT = lin("#bb9c6a"), TRODDEN = lin("#a88a5c");
const FOAM = lin("#f7f6ee"), RIVER_E = lin("#4aa6c9"), RIVER_C = lin("#93def0"), BANK = lin("#9c8a5c"), BED = lin("#3d7f96");
const EARTH = lin("#a57b52"), EARTH_HI = lin("#9b8c7b"), BASE = lin("#5b4333"), BASE_D = lin("#2f241d");

export const N6 = [...Array(6)].map((_, d) => [Math.cos((d * Math.PI) / 3), Math.sin((d * Math.PI) / 3)]);
const C7 = [...Array(7)].map((_, k) => { const a = (k * Math.PI) / 3 + Math.PI / 6; return [Math.cos(a), Math.sin(a)]; });
// Distance from the tile center measured like the hexagon's inradius: 1 * inradius on every edge.
export const hexR = (x, z) => Math.max(Math.abs(x), Math.abs(x * 0.5 + z * 0.8660254), Math.abs(-x * 0.5 + z * 0.8660254));

export function dims(board) {
  const R = board.grid.R, v = board.view, Rs = R * (1 - v.gap), Rt = Rs - R * 0.06;
  return { R, Rs, Rt, inT: (Rt * SQ3) / 2, inS: (Rs * SQ3) / 2, bevH: R * 0.045, lipH: R * 0.035, gapW: R * v.gap * SQ3 };
}

// The stream through a tile: curves from each linked edge, meeting in the middle or bending across.
function channelOf(t, D, view) {
  const E = [...t.edges].sort((a, b) => a - b), { R, inS, inT } = D;
  const hw = R * view.riverW, depth = Math.min(view.step * 0.5, R * 0.12);
  const at = (d, r) => [N6[d][0] * r, N6[d][1] * r];
  const bez = (a, c, b, k = 14) => [...Array(k + 1)].map((_, i) => { const s = i / k, u = 1 - s; return [u * u * a[0] + 2 * u * s * c[0] + s * s * b[0], u * u * a[1] + 2 * u * s * c[1] + s * s * b[1]]; });
  const curves = [], pools = [];
  if (E.length === 2) {
    const w = (hash(t.q, t.r, 77) - 0.5) * 0.3 * R, mid = [(N6[E[0]][1] - N6[E[1]][1]) * w, (N6[E[1]][0] - N6[E[0]][0]) * w];
    curves.push([at(E[0], inS), ...bez(at(E[0], inT), mid, at(E[1], inT)), at(E[1], inS)]);
  } else {
    for (const d of E) curves.push([at(d, inS), ...bez(at(d, inT), at(d, inT * 0.5), [0, 0], 8)]);
    pools.push([0, 0, hw * (E.length === 1 ? 1.9 : 1.5)]);
  }
  const segs = curves.flatMap((c) => c.slice(1).map((p, i) => [c[i][0], c[i][1], p[0], p[1]]));
  const dist = (x, z) => {
    let best = Infinity;
    for (const [ax, az, bx, bz] of segs) {
      const vx = bx - ax, vz = bz - az, l = vx * vx + vz * vz, s = l ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l)) : 0;
      best = Math.min(best, Math.hypot(x - ax - vx * s, z - az - vz * s));
    }
    for (const [px, pz, r] of pools) best = Math.min(best, Math.hypot(x - px, z - pz) - r + hw);
    return best;
  };
  const carve = (x, z) => { const d = dist(x, z); return d <= hw ? depth : depth * (1 - smooth(hw, hw * 1.7, d)); };
  return { E, hw, depth, curves, pools, dist, carve };
}

export function buildTiles(board, w, extra = {}) {
  const { grid, tiles, nb, view } = board, D = dims(board), { R, Rs, Rt, inT, bevH, lipH, gapW } = D;
  const step = view.step, base = -view.baseT, eps = step * 0.03;
  const buf = new Buf(1 << 17), line = [];
  const up = [0, 1, 0];

  const sideColor = (y) => {
    if (y < 0) return mix(BASE, BASE_D, Math.min(1, -y / view.baseT));
    const k = Math.floor(y / step), f = ((k + 1) * step - y) / step, hi = mix(EARTH, EARTH_HI, smooth(5, 13, k)), wob = 1 + 0.07 * Math.sin(k * 2.3);
    return mul(mix(hi, mul(hi, 0.56), Math.pow(f, 0.85)), wob);
  };

  for (const t of tiles) {
    const ch = t.edges.size && !t.water ? channelOf(t, D, view) : null;
    t.channel = ch;
    const n = ch ? view.riverDetail : t.type === "camp" ? view.campDetail : view.detail;
    const landEdges = t.water ? [0, 1, 2, 3, 4, 5].filter((d) => { const o = nb(t, d); return o && !o.water; }) : [];
    const seaEdges = t.type === "beach" ? [0, 1, 2, 3, 4, 5].filter((d) => { const o = nb(t, d); return o && o.water; }) : [];
    const tone = 0.95 + hash(t.q, t.r, 3) * 0.1;

    const color = (px, pz) => {
      const [x, z] = grid.world(t.gx + px, t.gz + pz), rr = hexR(px, pz) / inT;
      let c;
      if (t.water) {
        c = t.lake ? LAKE : SEA[Math.min(SEA.length - 1, t.depth - 1)];
        let near = Infinity;
        for (const d of landEdges) near = Math.min(near, inT - (px * N6[d][0] + pz * N6[d][1]));
        if (near < Infinity) c = mix(c, SHALLOW, 1 - smooth(0, R * 0.95, near));
        c = mul(c, 1 + 0.05 * fbm(x / (R * 0.9), z / (R * 0.9), 17, 2));
        return c;
      }
      const cov = t.type === "camp" ? null : Object.fromEntries(Object.keys(COV).map((k) => [k, Math.pow(w.fine(w.cover[k], x, z), 2.2)]));
      c = TOP[t.type];
      if (cov) {
        let sum = 0, loc = [0, 0, 0];
        for (const k in COV) { sum += cov[k]; loc[0] += COV[k][0] * cov[k]; loc[1] += COV[k][1] * cov[k]; loc[2] += COV[k][2] * cov[k]; }
        if (sum > 0) c = mix(c, mul(loc, 1 / sum), 0.3);
      }
      if (t.type === "beach") c = mul(c, 1 + 0.045 * Math.sin((x * 0.8 + z * 0.6) / (R * 0.055) + 3 * fbm(x / (R * 0.5), z / (R * 0.5), 41, 2)));
      if (seaEdges.length) {
        let near = Infinity;
        for (const d of seaEdges) near = Math.min(near, inT - (px * N6[d][0] + pz * N6[d][1]));
        c = mix(c, WETSAND, 0.8 * (1 - smooth(0, R * 0.4, near)));
      }
      if (t.type === "camp" && extra.spots) {
        let dirt = 0;
        for (const s of extra.spots) dirt = Math.max(dirt, (1 - smooth(s.r * 0.55, s.r, Math.hypot(px - s.x, pz - s.z) * (1 + 0.25 * fbm(px / 2.5, pz / 2.5, 5, 2)))) * s.k);
        c = mix(c, mix(DIRT, TRODDEN, smooth(0.6, 1, dirt)), dirt);
      }
      const b = fbm(x / (R * 0.7), z / (R * 0.7), 23, 2), hue = fbm(x / (R * 1.6), z / (R * 1.6), 29, 2);
      c = mul([c[0] * (1 + hue * 0.08), c[1], c[2] * (1 - hue * 0.08)], (1 + 0.1 * b) * (1.06 - 0.15 * rr * rr) * tone);
      if (ch) {
        const d = ch.dist(px, pz);
        c = d < ch.hw ? BED : mix(c, BANK, 1 - smooth(ch.hw, ch.hw * 1.8, d));
      }
      return c;
    };
    const yTop = (px, pz) => t.top - (ch ? ch.carve(px, pz) : 0);
    const V = (px, pz) => [t.gx + px, yTop(px, pz), t.gz + pz];

    // Plateau: six triangular sectors subdivided n times.
    const ring = [];
    for (let s = 0; s < 6; s++) {
      const P = (i, j) => [((C7[s][0] * (i - j) + C7[s + 1][0] * j) * Rt) / n, ((C7[s][1] * (i - j) + C7[s + 1][1] * j) * Rt) / n];
      let prev = [[P(0, 0)]].map(([p]) => ({ v: V(...p), c: color(...p) }));
      for (let i = 1; i <= n; i++) {
        const row = [];
        for (let j = 0; j <= i; j++) { const p = P(i, j); row.push({ p, v: V(...p), c: color(...p) }); }
        for (let j = 0; j < i; j++) buf.tri(row[j].v, row[j + 1].v, prev[j].v, row[j].c, row[j + 1].c, prev[j].c, up);
        for (let j = 0; j < i - 1; j++) buf.tri(prev[j].v, row[j + 1].v, prev[j + 1].v, prev[j].c, row[j + 1].c, prev[j + 1].c, up);
        prev = row;
      }
      for (let j = 0; j < n; j++) ring.push(prev[j]);
    }

    // Chamfered rim, then the skirt of earth slabs, edge by edge.
    const k = Rs / Rt, rimY = (p) => t.top - bevH - (ch ? ch.carve(p[0] * k, p[1] * k) * 0.8 : 0);
    const rim = ring.map((o) => ({ p: [o.p[0] * k, o.p[1] * k], y: rimY(o.p), c: mul(o.c, 1.06) }));
    for (let m = 0; m < ring.length; m++) {
      const a = ring[m], b = ring[(m + 1) % ring.length], ra = rim[m], rb = rim[(m + 1) % ring.length];
      const hint = [a.p[0] + b.p[0], R * 0.6, a.p[1] + b.p[1]];
      buf.quad(a.v, b.v, [t.gx + rb.p[0], rb.y, t.gz + rb.p[1]], [t.gx + ra.p[0], ra.y, t.gz + ra.p[1]], mul(a.c, 1.08), mul(b.c, 1.08), rb.c, ra.c, hint);
    }
    const lipC = t.water ? mul(TOP.beach, 0.62) : mul(TOP[t.type], 0.62);
    let floor = Infinity, open = false;
    for (let s = 0; s < 6; s++) {
      const d = (s + 1) % 6, o = nb(t, d), pts = ch ? [...rim.slice(s * n, s * n + n), rim[((s + 1) * n) % rim.length]] : [rim[s * n], rim[((s + 1) * n) % rim.length]];
      const lo = Math.min(...pts.map((p) => p.y)), yb = o ? Math.max(base, Math.min(o.top - bevH - 2.5 * gapW, lo - 2.5 * gapW)) : base;
      floor = Math.min(floor, yb);
      open ||= !o;
      const rows = [pts.map((p) => [p.y, mul(lipC, 1.1)]), pts.map((p) => [p.y - lipH, mul(lipC, 0.8)]), pts.map((p) => [p.y - lipH - eps, sideColor(p.y - lipH - eps)])];
      const cut = lo - lipH - eps * 2;
      for (let b = Math.floor(cut / step) * step; b > yb + eps && b >= 0; b -= step) { rows.push(pts.map(() => [b + eps, sideColor(b + eps)]), pts.map(() => [b - eps, sideColor(b - eps)])); }
      rows.push(pts.map(() => [yb, sideColor(yb)]));
      const hint = [N6[d][0], 0, N6[d][1]];
      for (let r = 0; r < rows.length - 1; r++)
        for (let m = 0; m < pts.length - 1; m++) {
          const A = pts[m].p, B = pts[m + 1].p, ya = rows[r], yb2 = rows[r + 1];
          if (yb2[m][0] >= ya[m][0] && yb2[m + 1][0] >= ya[m + 1][0]) continue;
          buf.quad([t.gx + A[0], ya[m][0], t.gz + A[1]], [t.gx + B[0], ya[m + 1][0], t.gz + B[1]], [t.gx + B[0], yb2[m + 1][0], t.gz + B[1]], [t.gx + A[0], yb2[m][0], t.gz + A[1]], ya[m][1], ya[m + 1][1], yb2[m + 1][1], yb2[m][1], hint);
        }
      for (let m = 0; m < pts.length - 1; m++) line.push(t.gx + pts[m].p[0], pts[m].y, t.gz + pts[m].p[1], t.gx + pts[m + 1].p[0], pts[m + 1].y, t.gz + pts[m + 1].p[1]);
    }
    // A dark floor closing the gaps at the depth the skirts stop, so no backdrop shows between tiles.
    const fr = open ? Rs : R, fy = floor + eps, fc = mul(BASE_D, 0.8);
    for (let s = 0; s < 6; s++) buf.tri([t.gx, fy, t.gz], [t.gx + C7[s][0] * fr, fy, t.gz + C7[s][1] * fr], [t.gx + C7[s + 1][0] * fr, fy, t.gz + C7[s + 1][1] * fr], fc, fc, fc, up);

    if (ch) {
      // Water in the channel: a ribbon with a pale middle, dipping over the rim where it leaves the tile.
      const yw = t.top - ch.depth * 0.5, hr = ch.hw * 1.12;
      for (const cv of ch.curves) {
        const Y = cv.map((p, i) => (i === 0 || (i === cv.length - 1 && hexR(...p) > inT * 1.01) ? yw - bevH * 0.9 : yw));
        for (let i = 0; i < cv.length - 1; i++) {
          const a = cv[i], b = cv[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = -dz / l * hr, nz = dx / l * hr;
          const pa = [t.gx + a[0], Y[i] + 0.01, t.gz + a[1]], pb = [t.gx + b[0], Y[i + 1] + 0.01, t.gz + b[1]];
          const la = [pa[0] + nx, pa[1], pa[2] + nz], ra = [pa[0] - nx, pa[1], pa[2] - nz], lb = [pb[0] + nx, pb[1], pb[2] + nz], rb = [pb[0] - nx, pb[1], pb[2] - nz];
          buf.quad(la, pa, pb, lb, RIVER_E, RIVER_C, RIVER_C, RIVER_E, up);
          buf.quad(pa, ra, rb, pb, RIVER_C, RIVER_E, RIVER_E, RIVER_C, up);
        }
      }
      for (const [px, pz, r] of ch.pools)
        for (let s = 0; s < 12; s++) {
          const a0 = (s / 12) * Math.PI * 2, a1 = ((s + 1) / 12) * Math.PI * 2, rr = r * 1.05;
          buf.tri([t.gx + px, yw + 0.01, t.gz + pz], [t.gx + px + Math.cos(a0) * rr, yw + 0.01, t.gz + pz + Math.sin(a0) * rr], [t.gx + px + Math.cos(a1) * rr, yw + 0.01, t.gz + pz + Math.sin(a1) * rr], RIVER_C, RIVER_E, RIVER_E, up);
        }
      // Falls down to a lower neighbor or into the sea.
      for (const d of ch.E) {
        const o = nb(t, d);
        if (!o || !(o.water || o.top < t.top - 1e-6)) continue;
        const y0 = yw - bevH * 0.9, y1 = o.water ? o.top : o.top - Math.min(step * 0.5, R * 0.12) * 0.5, off = D.inS + R * 0.004;
        const cx = N6[d][0] * off, cz = N6[d][1] * off, tx = -N6[d][1] * hr * 0.85, tz = N6[d][0] * hr * 0.85, hint = [N6[d][0], 0, N6[d][1]];
        const ym = (y0 + y1) / 2, P = (s, y) => [t.gx + cx + tx * s, y, t.gz + cz + tz * s];
        buf.quad(P(-1, y0), P(1, y0), P(1, ym), P(-1, ym), RIVER_C, RIVER_C, mix(RIVER_C, FOAM, 0.5), mix(RIVER_C, FOAM, 0.5), hint);
        buf.quad(P(-1, ym), P(1, ym), P(1.15, y1), P(-1.15, y1), mix(RIVER_C, FOAM, 0.5), mix(RIVER_C, FOAM, 0.5), FOAM, FOAM, hint);
        const fx = t.gx + N6[d][0] * (D.inS + gapW + R * 0.05), fz = t.gz + N6[d][1] * (D.inS + gapW + R * 0.05), fr = hr * 1.3;
        for (let s = 0; s < 10; s++) {
          const a0 = (s / 10) * Math.PI * 2, a1 = ((s + 1) / 10) * Math.PI * 2;
          buf.tri([fx, y1 + R * 0.006, fz], [fx + Math.cos(a0) * fr, y1 + R * 0.006, fz + Math.sin(a0) * fr], [fx + Math.cos(a1) * fr, y1 + R * 0.006, fz + Math.sin(a1) * fr], FOAM, FOAM, FOAM, up);
        }
      }
    }

    // Foam lines along every edge the water shares with land: a wavy band on the shore and a broken line further out.
    if (t.water)
      for (const d of landEdges) {
        const A = C7[(d + 5) % 6], B = C7[d], ix = -N6[d][0], iz = -N6[d][1], y = t.top + R * 0.004, K = 12, ph = hash(t.q, t.r, d) * 6.28;
        const E = (s, inset) => [t.gx + (A[0] + (B[0] - A[0]) * s) * Rt + ix * inset, y, t.gz + (A[1] + (B[1] - A[1]) * s) * Rt + iz * inset];
        for (let i = 0; i < K; i++) {
          const s0 = i / K, s1 = (i + 1) / K, w0 = R * (0.085 + 0.03 * Math.sin(s0 * 19 + ph)), w1 = R * (0.085 + 0.03 * Math.sin(s1 * 19 + ph));
          buf.quad(E(s0, R * 0.01), E(s1, R * 0.01), E(s1, w1), E(s0, w0), FOAM, FOAM, mix(FOAM, SHALLOW, 0.3), mix(FOAM, SHALLOW, 0.3), up);
        }
        for (const s0 of [0.12, 0.42, 0.72]) {
          const s1 = s0 + 0.15 + hash(t.q, t.r, d * 7 + s0 * 10) * 0.08, a = R * (0.2 + 0.02 * Math.sin(ph + s0 * 9)), b = a + R * 0.03;
          buf.quad(E(s0, a), E(s1, a), E(s1, b), E(s0, b), FOAM, FOAM, FOAM, FOAM, up);
        }
      }
  }

  const lines = new THREE.BufferGeometry();
  lines.setAttribute("position", new THREE.Float32BufferAttribute(line, 3));
  return { geometry: buf.geometry(), lines, D };
}
