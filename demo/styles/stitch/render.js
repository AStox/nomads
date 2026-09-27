// One still of the embroidered island: set up the cloth and the view, chart the pattern, stitch it, add the props,
// light it and develop it like a photograph. Pure JavaScript over typed arrays; the page only shows the result.
import { clamp, hash, fbm } from "../world.js";
import { GBuf } from "./gbuf.js";
import { Fabric, weave } from "./fabric.js";
import { Stitcher } from "./stitch.js";
import { chart } from "./chart.js";
import { details } from "./details.js";
import { col } from "./floss.js";
import { table, hoop, props } from "./props.js";

const OUT_W = 1280, OUT_H = 720, SS = 2;
const LIGHT = [-0.52, -0.46, 0.72];

function setup(kind, w) {
  const W = OUT_W * SS, H = OUT_H * SS, camp = w.camp.at;
  const ls = Math.hypot(LIGHT[0], LIGHT[1]), lightS = [LIGHT[0] / ls, LIGHT[1] / ls];
  let fab, mpc, C, uc, vc, R0, R1, inside, hoopAt = null;
  if (kind === "island") {
    const cs = 11.2, rot = -0.09, Ri = 632, hx = 930, hy = 722;
    const cols = 150, rows = 150;
    // the hoop's centre sits on a hole near the middle of the cloth
    uc = 75; vc = 75;
    const ox = hx - (uc * Math.cos(rot) - vc * Math.sin(rot)) * cs, oy = hy - (uc * Math.sin(rot) + vc * Math.cos(rot)) * cs;
    fab = new Fabric({ ox, oy, cs, rot, cols, rows });
    mpc = 5600 / ((Ri - cs * 1.2) / cs);
    C = [(w.START + w.START + w.SIZE - w.CELL) / 2, (w.START + w.START + w.SIZE - w.CELL) / 2];
    R0 = [1, 0]; R1 = [0, 1];
    const rin = (Ri - cs * 0.9) / cs;
    inside = (i, j) => Math.hypot(i + 0.5 - uc, j + 0.5 - vc) < rin;
    hoopAt = { x: hx, y: hy, Ri, rot };
  } else {
    const cs = kind === "valley" ? 36 : 48, cols = Math.ceil(W / cs) + 3, rows = Math.ceil(H / cs) + 3, rot = kind === "valley" ? 0.012 : -0.008;
    fab = new Fabric({ ox: -cs * 1.3, oy: -cs * 1.2, cs, rot, cols, rows });
    const f = w.camp.from;
    R1 = [Math.cos(f), Math.sin(f)]; R0 = [Math.sin(f), -Math.cos(f)];
    let fy = 0.6, fx = 0.5;
    mpc = 9;
    if (kind === "camp") {
      // fit the tents (standing up behind the fire) and the people in front into the frame
      const off = (p) => [(p.x - camp.x) * R0[0] + (p.z - camp.z) * R0[1], (p.x - camp.x) * R1[0] + (p.z - camp.z) * R1[1]];
      let top = -2, bot = 3.6, lef = -3, rig = 3;
      for (const t of w.camp.tents) { const [a, b] = off(t.at); top = Math.min(top, b - t.size * 1.05); lef = Math.min(lef, a - t.size); rig = Math.max(rig, a + t.size); }
      const rowsM = H / cs, colsM = W / cs;
      mpc = Math.max(0.6, (bot - top + 2.2) / rowsM, (rig - lef + 2.5) / colsM);
      fy = (1.1 - top / mpc) / rowsM; fx = 0.5 - ((lef + rig) / 2 / mpc) / colsM;
    }
    const [cu, cv] = fab.raw(W * fx, H * fy);
    uc = cu; vc = cv;
    C = [camp.x, camp.z];
    inside = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows;
  }
  const world = (u, v) => [C[0] + ((u - uc) * R0[0] + (v - vc) * R1[0]) * mpc, C[1] + ((u - uc) * R0[1] + (v - vc) * R1[1]) * mpc];
  const fabOf = (x, z) => { const dx = x - C[0], dz = z - C[1]; return [uc + (dx * R0[0] + dz * R0[1]) / mpc, vc + (dx * R1[0] + dz * R1[1]) / mpc]; };
  const lightW = [lightS[0] * R0[0] + lightS[1] * R1[0], lightS[0] * R0[1] + lightS[1] * R1[1]];
  const exposureAt = (x, z) => w.bilinear(w.isle.exposure, (x - w.START) / w.CELL, (z - w.START) / w.CELL);
  return { kind, W, H, fab, mpc, world, fabOf, inside, lightW, lightS, exposureAt, hoopAt, campAt: camp, depthScale: kind === "island" ? 1 : 0.15, R0, R1, uc, vc };
}

export function render(w, kind, COLORS) {
  const T = [performance.now()], V = setup(kind, w), { W, H, fab } = V;
  const ch = chart(w, V);
  V.chart = ch;
  details(w, V, ch, COLORS);
  T.push(performance.now());
  fab.pull(ch.density, kind === "island" ? 0.25 : 0.3);
  const gb = new GBuf(W, H), hp = V.hoopAt;
  // even in a hoop the cloth is not quite flat; the stitches ride its gentle swell
  const swell = (x, y) => 9 * fbm(x / 560, y / 560, 505, 2);
  const st = new Stitcher(gb, fab, hp ? (x, y) => 40 - 3 * (1 - Math.min(1, (Math.hypot(x - hp.x, y - hp.y) / hp.Ri) ** 2)) : swell);
  if (kind === "island") {
    table(gb, V);
    hoop(gb, V);
  } else weave(gb, fab, [0, 0, W, H], swell, undefined, { threads: 4 });
  T.push(performance.now());
  const cache = new Map(), C = (k) => { if (!cache.has(k)) cache.set(k, col(k)); return cache.get(k); };
  const { cols, rows, key, type, quarter } = ch;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i, t = type[k];
      if (!t) continue;
      const c = C(key[k]);
      if (t === 1) st.cross(i, j, c);
      else if (t === 2) st.half(i, j, c);
      else {
        st.threeQ(i, j, t - 3, c);
        if (quarter[k] != null) { const q = 3 - (t - 3), M = [i + 0.5, j + 0.5], P = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]][q]; st.straight(P[0], P[1], M[0], M[1], C(quarter[k]), { r: 0.2, dive1: 0.5 }); }
      }
    }
  for (const b of ch.backs) st.back(b.i0, b.j0, b.i1, b.j1, C(b.key), { r: b.r });
  for (const o of ch.ops) {
    const c = typeof o.c === "string" && o.c[0] === "#" ? col(o.c) : C(o.c);
    if (o.t === "knot") st.knot(o.u, o.v, c, o);
    else if (o.t === "flower") st.flower(o.u, o.v, o.n, o.len, c, o.centre == null ? null : C(o.centre), o);
    else if (o.t === "straight") st.straight(o.u0, o.v0, o.u1, o.v1, c, o);
    else if (o.t === "satin") st.satin(o.poly, o.a, c, o);
    else if (o.t === "tail") st.tail(o.u, o.v, o.a, o.len, c, o);
    else if (o.t === "cross") st.cross(o.i, o.j, c, o);
    else if (o.t === "path") gb.thread(o.pts.map(([u, v]) => fab.at(u, v)), { r: fab.cs * o.r, c, drape: true, plies: 1, seed: 5, gloss: 0.7, above: fab.cs * 0.03, soft: 1, pitch: 3 });
  }
  T.push(performance.now());
  props(gb, V, C);
  T.push(performance.now());
  const cs = fab.cs;
  const { img, w: ow, h: oh } = gb.shade({ light: LIGHT, down: SS, aoR: [Math.max(2, Math.round(cs * 0.3)), Math.round(cs * 1.1), 44], aoK: [0.3, 0.3, 0.3] });
  T.push(performance.now());
  const out = develop(img, ow, oh, kind);
  T.push(performance.now());
  return { data: out, width: ow, height: oh, times: T.slice(1).map((t, k) => Math.round(t - T[k])) };
}

// Like a photo off a decent camera: light falling off away from the window, a soft vignette, a little grain.
function develop(img, w, h, kind) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, nx = x / w - 0.5, ny = y / h - 0.5;
      const vig = 1 - 0.32 * Math.pow(nx * nx * 1.1 + ny * ny * 1.6, 1.15) * 2.2;
      const fall = 1.05 - 0.1 * (nx * 0.65 + ny * 0.5);
      const gr = 1 + (hash(x, y, 77) - 0.5) * 0.035;
      for (let c = 0; c < 3; c++) {
        let v = img[i * 3 + c] * vig * fall * gr;
        v = v / (1 + Math.max(0, v - 0.85) * 0.9);
        out[i * 4 + c] = 255 * Math.pow(clamp(v, 0, 1), 0.94);
      }
      out[i * 4 + 3] = 255;
    }
  return out;
}
