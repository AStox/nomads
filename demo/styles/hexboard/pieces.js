// The little painted pieces that sit on the tiles, and where they go. Every piece is instanced from a handful of
// low-poly templates; placement reads the world's cover fields and its nearest real tree, shrub or rock.
import * as THREE from "three";
import { clamp, smooth, fbm } from "../world.js";
import { Buf, lin, mix, mul, ico, spire, post, log } from "./geo.js";
import { hexR } from "./tiles.js";
import { hkey } from "./board.js";
import { COLORS } from "../island.js";

const PINE = lin("#2d6a50"), PINE_L = lin("#57946a"), OAK = lin("#437d34"), OAK_L = lin("#7aab48"), ASH = lin("#57913f"), ASH_L = lin("#92bd58");
const ASPEN = lin("#86a947"), ASPEN_L = lin("#b9c962"), TRUNK = lin("#6c4a31"), BUSH = lin("#4f8039"), BUSH_L = lin("#8bb157");
const HEATH = lin("#84498f"), HEATH_L = lin("#c784c4"), ROCK = lin("#8a8782"), ROCK_L = lin("#d2cdc3"), MOSS = lin("#8a9868"), SAND = lin("#dcc28c"), SAND_L = lin("#eed8a6");
const GRASS = lin("#5a8c35"), GRASS_L = lin("#b9d46c"), REED = lin("#5b7a3a"), REED_L = lin("#c7b66a"), CATTAIL = lin("#5b3c28");
const DRIFT = lin("#b7a78f"), DRIFT_END = lin("#e3d6bd"), PUDDLE = lin("#3a88b0"), PUDDLE_E = lin("#78bfd6"), MUD = lin("#6b6e45");
const WHITE = [1, 1, 1], BARK = lin("#6b4b33"), CUT = lin("#e7c996");
const FLOWERS = ["#f6f2e6", "#f3d04b", "#e0583f", "#6f90dc", "#ec9dc4", "#f0a04c"].map(lin), HEATHERS = ["#d78fd3", "#b56bc6", "#e6a6dc"].map(lin);

// Deterministic randomness for template shapes.
const seeded = (s) => () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const grad = (lo, hi, k = 0.8) => (v) => mix(mul(lo, k), hi, (v + 1) / 2);

function blade(b, x, z, a, h, wdt, lean, c0, c1) {
  const ca = Math.cos(a), sa = Math.sin(a), px = -sa * wdt, pz = ca * wdt;
  b.tri([x + px, 0, z + pz], [x - px, 0, z - pz], [x + ca * lean, h, z + sa * lean], c0, c0, c1, [ca, 0.3, sa]);
}

// A cylinder between two points, for poles, sticks, logs and arms.
export function stick(b, a, e, r, c0, c1, sides = 5) {
  const d = [e[0] - a[0], e[1] - a[1], e[2] - a[2]], L = Math.hypot(...d), u = d.map((v) => v / L);
  const ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let p = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]];
  const pl = Math.hypot(...p); p = p.map((v) => v / pl);
  const q = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]];
  const ring = (o) => [...Array(sides)].map((_, s) => { const t = (s / sides) * Math.PI * 2, c = Math.cos(t) * r, si = Math.sin(t) * r; return [o[0] + p[0] * c + q[0] * si, o[1] + p[1] * c + q[1] * si, o[2] + p[2] * c + q[2] * si]; });
  const A = ring(a), B = ring(e);
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides, m = [(A[s][0] + A[s1][0]) / 2 - a[0], (A[s][1] + A[s1][1]) / 2 - a[1], (A[s][2] + A[s1][2]) / 2 - a[2]];
    b.quad(A[s], A[s1], B[s1], B[s], c0, c0, c1, c1, m);
    b.tri(B[s], B[s1], e, c1, c1, c1, u);
    b.tri(A[s], A[s1], a, c0, c0, c0, u.map((v) => -v));
  }
}

function templates() {
  const T = {}, mk = (name, seed, fn) => { const b = new Buf(256); fn(b, seeded(seed)); T[name] = b.geometry(); };
  for (let v = 0; v < 3; v++)
    mk(`pine${v}`, 11 + v, (b, rnd) => {
      post(b, 0, 0, 0, 0.2, 0.055, 0.04, 5, mul(TRUNK, 0.7), TRUNK);
      [[0.13, 0.37, 0.52], [0.33, 0.3, 0.76], [0.54, 0.21, 1.0]].forEach(([y, r, top], k) => {
        const s = 1 + (rnd() - 0.5) * 0.16;
        spire(b, 0, 0, [[y, r * s, mul(PINE, 0.62 + k * 0.06)], [y + (top - y) * 0.42, r * s * 0.6, mix(PINE, PINE_L, 0.25 + k * 0.1)]], [top, PINE_L], 7, rnd, 0.14, rnd() * 6);
      });
    });
  for (let v = 0; v < 2; v++) {
    mk(`oak${v}`, 21 + v, (b, rnd) => {
      post(b, 0, 0, 0, 0.42, 0.065, 0.045, 5, mul(TRUNK, 0.7), TRUNK);
      const c = grad(OAK, OAK_L, 0.72);
      ico(b, 0, 0.6, 0, 0.34, 0.27, 0.34, c, rnd);
      ico(b, 0.14 - v * 0.05, 0.75, 0.05, 0.22, 0.2, 0.22, c, rnd);
      ico(b, -0.12, 0.72, -0.08 + v * 0.1, 0.21, 0.19, 0.21, c, rnd);
    });
    mk(`ash${v}`, 31 + v, (b, rnd) => {
      post(b, 0, 0, 0, 0.46, 0.05, 0.035, 5, mul(TRUNK, 0.7), TRUNK);
      const c = grad(ASH, ASH_L, 0.72);
      ico(b, 0, 0.64, 0, 0.26, 0.33, 0.26, c, rnd);
      ico(b, 0.04, 0.88, 0.02 - v * 0.04, 0.16, 0.15, 0.16, c, rnd);
    });
    mk(`aspen${v}`, 41 + v, (b, rnd) => {
      post(b, 0, 0, 0, 0.44, 0.04, 0.03, 5, lin("#8f8676"), lin("#d8d2c2"));
      const c = grad(ASPEN, ASPEN_L, 0.74);
      ico(b, 0, 0.66, 0, 0.17, 0.35, 0.17, c, rnd, 0.14);
      if (v) ico(b, 0.06, 0.48, 0.04, 0.12, 0.14, 0.12, c, rnd);
    });
    mk(`bush${v}`, 51 + v, (b, rnd) => {
      const c = grad(BUSH, BUSH_L, 0.72);
      ico(b, 0, 0.3, 0, 0.5, 0.36, 0.5, c, rnd, 0.2, 0);
      ico(b, 0.3, 0.22, 0.12 - v * 0.24, 0.3, 0.26, 0.3, c, rnd, 0.2, 0);
    });
    mk(`heath${v}`, 61 + v, (b, rnd) => {
      const c = grad(HEATH, HEATH_L, 0.7);
      for (let k = 0; k < 4 + v; k++) { const a = rnd() * 6.28, r = k ? 0.3 + rnd() * 0.18 : 0; ico(b, Math.cos(a) * r, 0.14, Math.sin(a) * r, 0.28, 0.24, 0.28, c, rnd, 0.22, 0); }
    });
    mk(`tuft${v}`, 71 + v, (b, rnd) => {
      const k = 6 + v;
      for (let i = 0; i < k; i++) { const a = (i / k) * 6.28 + rnd() * 0.5; blade(b, Math.cos(a) * 0.05, Math.sin(a) * 0.05, a, 0.75 + rnd() * 0.35, 0.07, 0.32 + rnd() * 0.12, mul(GRASS, 0.75), GRASS_L); }
    });
    mk(`reed${v}`, 81 + v, (b, rnd) => {
      for (let i = 0; i < 11; i++) {
        const a = rnd() * 6.28, r = rnd() * 0.16, x = Math.cos(a) * r, z = Math.sin(a) * r, h = 0.8 + rnd() * 0.5;
        blade(b, x, z, a, h, 0.07, 0.08 + rnd() * 0.12, mul(REED, 0.75), REED_L);
      }
      for (let i = 0; i < 2 + v; i++) {
        const a = rnd() * 6.28, x = Math.cos(a) * 0.08, z = Math.sin(a) * 0.08, h = 1.1 + rnd() * 0.3;
        stick(b, [x, 0, z], [x * 1.5, h, z * 1.5], 0.012, REED, REED, 3);
        ico(b, x * 1.5, h - 0.1, z * 1.5, 0.065, 0.15, 0.065, () => CATTAIL, rnd, 0.05);
      }
    });
    mk(`puddle${v}`, 91 + v, (b, rnd) => {
      const K = 11, rr = [...Array(K)].map(() => 0.8 + rnd() * 0.35);
      for (let i = 0; i < K; i++) {
        const a0 = (i / K) * 6.283, a1 = ((i + 1) / K) * 6.283, r0 = rr[i], r1 = rr[(i + 1) % K], P = (a, r, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
        b.tri([0, 0.02, 0], P(a0, r0, 0.02), P(a1, r1, 0.02), mul(PUDDLE, 0.85), PUDDLE_E, PUDDLE_E, [0, 1, 0]);
        b.quad(P(a0, r0, 0.02), P(a1, r1, 0.02), P(a1, r1 * 1.22, 0.01), P(a0, r0 * 1.22, 0.01), MUD, MUD, mul(MUD, 1.2), mul(MUD, 1.2), [0, 1, 0]);
      }
    });
  }
  for (let v = 0; v < 3; v++) {
    mk(`rock${v}`, 101 + v, (b, rnd) => { ico(b, 0, 0.16, 0, 0.5, 0.4 + v * 0.06, 0.44, grad(ROCK, ROCK_L, 0.78), rnd, 0.32, 0); });
    mk(`peak${v}`, 111 + v, (b, rnd) => {
      const rock = (s) => mix(ROCK, lin("#9b9184"), (s % 3) / 3);
      spire(b, 0, 0, [[-0.02, 0.56, MOSS], [0.22, 0.44, mix(MOSS, ROCK, 0.6)], [0.5, 0.27, rock], [0.74, 0.13, mix(ROCK, ROCK_L, 0.6)]], [1, lin("#ece6da")], 7, rnd, 0.22, rnd() * 6, [(rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.12]);
      spire(b, 0.34, 0.12 - v * 0.1, [[-0.02, 0.3, MOSS], [0.2, 0.2, mix(MOSS, ROCK, 0.6)], [0.4, 0.1, rock]], [0.55, ROCK_L], 6, rnd, 0.22, rnd() * 6);
      spire(b, -0.3, -0.18 + v * 0.1, [[-0.02, 0.26, MOSS], [0.18, 0.16, mix(MOSS, ROCK, 0.6)]], [0.42, ROCK_L], 6, rnd, 0.22, rnd() * 6);
    });
  }
  for (let v = 0; v < 2; v++)
    mk(`crag${v}`, 161 + v, (b, rnd) => {
      spire(b, 0, 0, [[-0.02, 0.5, mul(ROCK, 0.85)], [0.3, 0.36, ROCK], [0.62, 0.18, mix(ROCK, ROCK_L, 0.5)]], [1, ROCK_L], 6, rnd, 0.26, rnd() * 6, [(rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.2]);
      spire(b, 0.3, 0.1 - v * 0.2, [[-0.02, 0.26, mul(ROCK, 0.85)], [0.25, 0.14, ROCK]], [0.5, ROCK_L], 5, rnd, 0.26, rnd() * 6);
    });
  mk("patch", 181, (b, rnd) => {
    const K = 9, rr = [...Array(K)].map(() => 0.75 + rnd() * 0.4);
    for (let i = 0; i < K; i++) { const a0 = (i / K) * 6.283, a1 = ((i + 1) / K) * 6.283; b.tri([0, 0.03, 0], [Math.cos(a0) * rr[i], 0.02, Math.sin(a0) * rr[i]], [Math.cos(a1) * rr[(i + 1) % K], 0.02, Math.sin(a1) * rr[(i + 1) % K]], WHITE, [0.85, 0.85, 0.85], [0.85, 0.85, 0.85], [0, 1, 0]); }
  });
  mk("dune", 171, (b, rnd) => { ico(b, 0, 0, 0, 1, 0.34, 1, grad(SAND, SAND_L, 0.9), rnd, 0.12, 0); });
  mk("pebble", 121, (b, rnd) => { ico(b, 0, 0.1, 0, 0.5, 0.32, 0.42, grad(ROCK, ROCK_L, 0.85), rnd, 0.25, 0); });
  mk("flower", 131, (b, rnd) => { blade(b, 0, 0, 0, 0.3, 0.03, 0, lin("#6f9a3c"), lin("#6f9a3c")); ico(b, 0, 0.32, 0, 0.13, 0.08, 0.13, () => WHITE, rnd, 0.1); });
  mk("drift", 141, (b) => { log(b, 1, 0.12, 5, DRIFT, DRIFT_END, 0.3); stick(b, [0.2, 0.1, 0.02], [0.42, 0.14, 0.26], 0.035, DRIFT, DRIFT_END, 4); stick(b, [-0.3, 0.1, -0.02], [-0.5, 0.1, -0.2], 0.03, DRIFT, DRIFT_END, 4); });
  mk("log", 142, (b) => { log(b, 1, 0.08, 6, BARK, CUT, 0.2); });
  mk("wave", 151, (b) => {
    const K = 8;
    for (let i = 0; i < K; i++) {
      const a0 = -0.9 + (i / K) * 1.8, a1 = -0.9 + ((i + 1) / K) * 1.8, w0 = 0.05 + 0.07 * Math.sin(((i) / K) * Math.PI), w1 = 0.05 + 0.07 * Math.sin(((i + 1) / K) * Math.PI);
      const P = (a, r) => [Math.sin(a) * r, 0, -Math.cos(a) * r + 1];
      b.quad(P(a0, 1), P(a1, 1), P(a1, 1 - w1), P(a0, 1 - w0), WHITE, WHITE, WHITE, WHITE, [0, 1, 0]);
    }
  });
  const blob = new THREE.PlaneGeometry(2, 2);
  blob.rotateX(-Math.PI / 2);
  T.blob = blob;
  return T;
}

export function toonRamp() {
  // Three soft-edged light bands, indexed by N.L mapped to 0..1.
  const W = 256, data = new Uint8Array(W * 4);
  for (let i = 0; i < W; i++) {
    const u = i / (W - 1), v = 0.44 + 0.36 * smooth(0.47, 0.53, u) + 0.2 * smooth(0.74, 0.8, u);
    data.set([v * 255, v * 255, v * 255, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, W, 1);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function blobTexture() {
  const c = Object.assign(document.createElement("canvas"), { width: 64, height: 64 }), g = c.getContext("2d");
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.45, "rgba(255,255,255,0.75)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Instances {
  constructor() { this.sets = new Map(); }
  put(name, x, y, z, yaw, s, sy, c, sz = s) {
    let a = this.sets.get(name);
    if (!a) this.sets.set(name, (a = []));
    a.push(x, y, z, yaw, s, sy, sz, c[0], c[1], c[2]);
  }
  meshes(T, mats) {
    const out = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color(), Y = new THREE.Vector3(0, 1, 0);
    for (const [name, a] of this.sets) {
      const base = name.replace(/\d+$/, ""), n = a.length / 10, mesh = new THREE.InstancedMesh(T[name], mats[base] || mats.solid, n);
      for (let i = 0; i < n; i++) {
        const o = i * 10;
        m.compose(p.set(a[o], a[o + 1], a[o + 2]), q.setFromAxisAngle(Y, a[o + 3]), sc.set(a[o + 4], a[o + 5], a[o + 6]));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, col.setRGB(a[o + 7], a[o + 8], a[o + 9]));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      const small = ["tuft", "flower", "pebble", "wave", "puddle", "blob", "reed", "patch"].includes(base);
      mesh.castShadow = !small;
      mesh.receiveShadow = base !== "blob";
      if (base === "blob") mesh.renderOrder = 2;
      out.push(mesh);
    }
    return out;
  }
}

export function decorate(board, w, D, idx, mats, rand) {
  const { grid, tiles, nb, view } = board, { R, inT } = D, u = view.unit, I = new Instances(), T = templates();
  const wind = grid.grid(w.camp.at.x + w.isle.wind[0], w.camp.at.z + w.isle.wind[1]).map((v, k) => v - grid.grid(w.camp.at.x, w.camp.at.z)[k]);
  const windYaw = Math.atan2(wind[0], wind[1]);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const blob = (x, y, z, r, k = 1) => I.put("blob", x, y + u * 0.03, z, 0, r, 1, [k, k, k]);
  const cs = view.coverScale;
  mats.blob = new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0x3a2c2c, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  for (const t of tiles) {
    const y = t.top, placed = [], ch = t.channel;
    const toW = (px, pz) => grid.world(t.gx + px, t.gz + pz);
    const free = (px, pz, r) => hexR(px, pz) < inT - r * 0.8 - R * 0.03 && (!ch || ch.dist(px, pz) > ch.hw * 1.45 + r * 0.7) && placed.every(([x, z, rr]) => (x - px) ** 2 + (z - pz) ** 2 > (r + rr) ** 2 * 0.55);
    const lattice = (sp) => {
      const out = [], m = Math.ceil(R / sp) + 1;
      for (let j = -m; j <= m; j++)
        for (let i = -m; i <= m; i++) {
          const px = (i + j / 2) * sp + (rand() - 0.5) * sp * 0.7, pz = j * sp * 0.866 + (rand() - 0.5) * sp * 0.7;
          if (hexR(px, pz) < inT) out.push([px, pz]);
        }
      for (let k = out.length - 1; k > 0; k--) { const r = Math.floor(rand() * (k + 1)); [out[k], out[r]] = [out[r], out[k]]; }
      return out;
    };
    const covAt = (x, z) => ({ tree: w.fine(w.cover.tree, x, z), shrub: w.fine(w.cover.shrub, x, z), grass: w.fine(w.cover.grass, x, z), marsh: w.fine(w.cover.marsh, x, z), bare: w.fine(w.cover.bare, x, z), sand: w.fine(w.cover.sand, x, z) });

    if (t.water) {
      const n = t.lake ? 1 : t.depth >= 2 ? 2 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 2);
      for (let k = 0; k < n; k++) {
        const a = rand() * 6.283, r = Math.sqrt(rand()) * inT * 0.62, px = Math.cos(a) * r, pz = Math.sin(a) * r;
        if (hexR(px, pz) > inT - R * 0.34) continue;
        const s = R * (0.1 + rand() * 0.07);
        I.put("wave", t.gx + px, y + R * 0.004, t.gz + pz, windYaw + (rand() - 0.5) * 0.6, s, 1, [1, 1, 1]);
      }
      continue;
    }
    if (t.type === "camp") continue;

    // Mountains carry their peaks first; marshes their pools.
    if (t.type === "mountain") {
      const lift = smooth(view.mountainH, view.mountainH * 4, t.hMax), H = R * (0.8 + 0.8 * lift);
      const turn = rand() * 6.28, spots = [[0, 0, 1], [R * 0.45, R * 0.15, 0.6], [-R * 0.38, -R * 0.28, 0.5]].slice(0, 1 + (lift > 0.25 || rand() < 0.5) + (rand() < 0.45));
      for (const [ox, oz, k] of spots) {
        const cx = ox * Math.cos(turn) - oz * Math.sin(turn), cz = ox * Math.sin(turn) + oz * Math.cos(turn);
        const px = cx + (rand() - 0.5) * R * 0.3, pz = cz + (rand() - 0.5) * R * 0.3, h = H * k * (0.65 + rand() * 0.55);
        I.put(`peak${Math.floor(rand() * 3)}`, t.gx + px, y, t.gz + pz, rand() * 6.28, h * 0.95, h, [1, 1, 1]);
        blob(t.gx + px, y, t.gz + pz, h * 0.75, 0.9);
        placed.push([px, pz, h * 0.5]);
      }
    }
    // Rocky ground breaks into low crags, as many as the bare share of the tile asks for.
    if (t.type === "rock")
      for (let k = 0, n = Math.round(t.cov.bare * 3); k < n; k++) {
        const a = rand() * 6.28, r = k ? R * (0.3 + rand() * 0.25) : rand() * R * 0.2, px = Math.cos(a) * r, pz = Math.sin(a) * r, h = R * (0.22 + 0.2 * t.cov.bare) * (0.7 + rand() * 0.5);
        if (!free(px, pz, h * 0.55)) continue;
        I.put(`crag${Math.floor(rand() * 2)}`, t.gx + px, y, t.gz + pz, rand() * 6.28, h * 1.1, h, [0.96, 0.95, 0.93]);
        blob(t.gx + px, y, t.gz + pz, h * 0.8, 0.9);
        placed.push([px, pz, h * 0.55]);
      }
    // Seen from far, a meadow's flowers gather into drifts of color.
    if (view.patches && (t.type === "meadow" || t.type === "heath"))
      for (let k = 0, n = Math.round(t.cov.grass * 5 + t.cov.shrub * 8 + rand()); k < n; k++) {
        const a = rand() * 6.28, r = Math.sqrt(rand()) * inT * 0.65, px = Math.cos(a) * r, pz = Math.sin(a) * r, s = R * (0.14 + rand() * 0.12);
        if (!free(px, pz, s)) continue;
        const f = t.type === "heath" ? pick(HEATHERS) : pick(FLOWERS);
        I.put("patch", t.gx + px, y, t.gz + pz, rand() * 6.28, s, 1, mix(f, [0.4, 0.55, 0.2], 0.12), s * (0.6 + rand() * 0.4));
      }
    // Beaches heap into low dunes held by grass.
    if (t.type === "beach")
      for (let k = 0, n = Math.round(2 + t.cov.grass * 6 + rand()); k < n; k++) {
        const a = rand() * 6.28, r = Math.sqrt(rand()) * inT * 0.65, px = Math.cos(a) * r, pz = Math.sin(a) * r, s = R * (0.12 + rand() * 0.1);
        if (!free(px, pz, s)) continue;
        I.put("dune", t.gx + px, y, t.gz + pz, rand() * 6.28, s, s * (0.7 + rand() * 0.5), [1, 1, 1], s * (0.7 + rand() * 0.4));
        for (let g = 0; g < 7; g++) {
          const ga = rand() * 6.28, gr = Math.sqrt(rand()) * s * 0.7, gs = u * cs * (0.9 + rand() * 0.6);
          I.put(`tuft${g % 2}`, t.gx + px + Math.cos(ga) * gr, y + s * 0.3 * (1 - (gr / s) ** 2), t.gz + pz + Math.sin(ga) * gr, rand() * 6.28, gs, gs * 1.3, [1.08, 1.04, 0.72]);
        }
        placed.push([px, pz, s]);
      }
    if (t.type === "marsh")
      for (let k = 0, n = 3 + Math.floor(rand() * 3); k < n; k++) {
        const a = rand() * 6.28, r = Math.sqrt(rand()) * inT * 0.7, px = Math.cos(a) * r, pz = Math.sin(a) * r, s = R * (0.09 + rand() * 0.08) * view.pool;
        if (!free(px, pz, s * 1.1)) continue;
        I.put(`puddle${k % 2}`, t.gx + px, y, t.gz + pz, rand() * 6.28, s, 1, [1, 1, 1]);
        placed.push([px, pz, s * 1.1]);
      }

    // Big pieces on a jittered lattice: trees, bushes, boulders, reeds, driftwood.
    let nTrees = 0;
    const forest = t.type === "forest", tf = { forest: 1, meadow: 0.8, heath: 0.45, marsh: 0.5, rock: 0.35, mountain: 0.3, beach: 0.3 }[t.type];
    const addTree = (px, pz, x, z, reach) => {
      const real = idx.trees.nearest(x, z, reach);
      if (!real) return false;
      const H = real.tall * view.treeScale * u * (0.88 + rand() * 0.24), r = H * (real.kind === "pine" ? 0.3 : real.kind === "aspen" ? 0.2 : 0.3);
      if (!free(px, pz, r)) return false;
      const v = real.kind === "pine" ? Math.floor(rand() * 3) : Math.floor(rand() * 2), k = real.tint;
      let c = [0.9 + k * 0.2, 0.92 + k * 0.14, 0.9 + k * 0.1];
      if (real.kind === "aspen" && k > 0.86) c = [1.3, 1.02, 0.5];
      else if (real.kind === "oak" && k > 0.9) c = [1.3, 0.92, 0.5];
      else if (real.kind === "ash" && k > 0.93) c = [1.35, 0.84, 0.44];
      I.put(`${real.kind}${v}`, t.gx + px, y, t.gz + pz, rand() * 6.28, H, H * (0.92 + rand() * 0.16), c);
      blob(t.gx + px, y, t.gz + pz, r * 1.35);
      placed.push([px, pz, r]);
      nTrees++;
      return true;
    };
    for (const [px, pz] of lattice(R * (forest ? 0.26 : 0.3))) {
      if (forest && nTrees >= 30) break;
      const [x, z] = toW(px, pz), c = covAt(x, z);
      const pTree = (forest ? smooth(0.1, 0.42, c.tree) : smooth(0.32, 0.72, c.tree) * 0.85) * tf;
      if (rand() < pTree && addTree(px, pz, x, z, view.treeReach)) continue;
      const heathy = t.type === "heath";
      if (rand() < (heathy ? 0.8 : smooth(0.03, 0.22, c.shrub) * 0.8 + c.tree * (1 - c.tree) * 0.25)) {
        const real = idx.shrubs.nearest(x, z, view.treeReach * 1.5), purple = heathy || (real && real.heath > 0.34);
        const s = u * (heathy ? 2.2 : 1.6) * (0.8 + (real ? real.tall : 1.4) * 0.35) * (0.85 + rand() * 0.3);
        if (free(px, pz, s * 0.55)) {
          const k = real ? real.tint : rand();
          I.put(purple ? `heath${Math.floor(rand() * 2)}` : `bush${Math.floor(rand() * 2)}`, t.gx + px, y, t.gz + pz, rand() * 6.28, s, s * (0.85 + rand() * 0.3), purple ? [0.85 + k * 0.3, 0.9 + k * 0.1, 0.9 + k * 0.2] : [0.9 + k * 0.2, 0.95 + k * 0.1, 0.9]);
          blob(t.gx + px, y, t.gz + pz, s * 0.7, 0.8);
          placed.push([px, pz, s * 0.55]);
          continue;
        }
      }
      const rocky = t.type === "rock" || t.type === "mountain";
      if (rand() < (rocky ? smooth(0.15, 0.6, c.bare) * 0.75 : smooth(0.4, 0.85, c.bare) * 0.4)) {
        const real = idx.rocks.nearest(x, z, view.treeReach * 2), s = u * (rocky ? 4.2 : 2.4) * cs * (0.7 + (real ? real.size : 1) * 0.3) * (0.75 + rand() * 0.5);
        if (free(px, pz, s * 0.5)) {
          const k = real ? real.tint : rand();
          I.put(`rock${Math.floor(rand() * 3)}`, t.gx + px, y, t.gz + pz, rand() * 6.28, s, s * (0.8 + rand() * 0.4), [0.92 + k * 0.14, 0.9 + k * 0.12, 0.88 + k * 0.1]);
          blob(t.gx + px, y, t.gz + pz, s * 0.62, 0.8);
          placed.push([px, pz, s * 0.5]);
          continue;
        }
      }
      if (rand() < smooth(0.18, 0.55, c.marsh) * 0.85) {
        const s = u * 1.9 * cs * (0.8 + rand() * 0.4);
        if (free(px, pz, s * 0.2)) { I.put(`reed${Math.floor(rand() * 2)}`, t.gx + px, y, t.gz + pz, rand() * 6.28, s, s, [0.9 + rand() * 0.2, 0.95, 0.9]); placed.push([px, pz, s * 0.2]); continue; }
      }
      if (t.type === "beach" && c.sand > 0.12 && rand() < 0.14) {
        const s = u * (3.2 + rand() * 2.4) * cs;
        if (free(px, pz, s * 0.45)) { I.put("drift", t.gx + px, y, t.gz + pz, rand() * 6.28, s, s * 1.1, [0.95 + rand() * 0.1, 0.95, 0.95]); placed.push([px, pz, s * 0.45]); }
      }
    }
    // Woods are woods: top a forest tile up to fifteen trees wherever the ground allows.
    for (let tries = 0; forest && nTrees < 15 && tries < 60; tries++) {
      const a = rand() * 6.28, r = Math.sqrt(rand()) * inT * 0.9, px = Math.cos(a) * r, pz = Math.sin(a) * r, [x, z] = toW(px, pz);
      addTree(px, pz, x, z, view.treeReach * 2);
    }

    // Ground cover on a finer lattice: tufts, flowers, scree, little reeds.
    const flowerP = { meadow: 0.26, heath: 0.3, forest: 0.03, marsh: 0.06, rock: 0.05, mountain: 0.03, beach: 0.02 }[t.type];
    const tuftK = { meadow: 1, heath: 0.6, forest: view.patches ? 0 : 0.35, marsh: 0.7, rock: 0.35, mountain: 0.3, beach: 0.28 }[t.type];
    for (const [px, pz] of lattice(R * view.fine)) {
      const [x, z] = toW(px, pz), c = covAt(x, z);
      if (!free(px, pz, R * 0.015)) continue;
      const X = t.gx + px, Z = t.gz + pz, r = rand();
      if (r < (c.bare * 0.55 + (t.type === "beach" ? 0.16 : 0)) * (t.type === "meadow" ? 0.3 : 1)) {
        const s = u * 0.5 * cs * (0.6 + rand() * 0.9), k = rand(), shell = t.type === "beach" && rand() < 0.5;
        I.put("pebble", X, y, Z, rand() * 6.28, s, s * (shell ? 0.6 : 1), shell ? [1.25, 1.1 + k * 0.1, 1.05] : [0.9 + k * 0.2, 0.9 + k * 0.15, 0.88 + k * 0.1]);
        continue;
      }
      if (rand() < flowerP * (0.4 + c.grass + c.shrub)) {
        const s = u * cs * (1.3 + rand() * 0.6);
        I.put("flower", X, y, Z, rand() * 6.28, s, s, t.type === "heath" ? pick(HEATHERS) : pick(FLOWERS));
        I.put(`tuft${Math.floor(rand() * 2)}`, X, y, Z, rand() * 6.28, s * 0.7, s * 0.6, [1, 1, 1]);
        continue;
      }
      if (rand() < clamp(c.grass * 1.1 + c.marsh * 0.6 + c.shrub * 0.6 + c.tree * 0.3, 0, 0.95) * tuftK) {
        const s = u * 0.95 * cs * (0.65 + rand() * 0.7), g = fbm(x / 40, z / 40, 9, 2);
        const col = t.type === "forest" ? [0.7, 0.85, 0.75] : t.type === "beach" ? [1.05, 1.02, 0.7] : t.type === "heath" ? [1.05, 0.9, 0.85] : [1 + g * 0.15, 1, 0.9 - g * 0.1];
        I.put(`tuft${Math.floor(rand() * 2)}`, X, y, Z, rand() * 6.28, s, s * (0.8 + rand() * 0.5), col);
        continue;
      }
      if (rand() < c.marsh * 0.22) { const s = u * 1.1 * cs * (0.7 + rand() * 0.5); I.put(`reed${Math.floor(rand() * 2)}`, X, y, Z, rand() * 6.28, s, s, [1, 1, 1]); }
    }
  }
  return { T, I };
}

// ---------- the camp ----------
const CANVAS = ["#efe3c6", "#d8a35a", "#c7714b"].map(lin), SKIN = ["#eab996", "#c78c62", "#8e5b3c", "#dca27a", "#b37552"].map(lin), HAIR = ["#3a2a20", "#6b4428", "#1f1a17", "#9a6a3a", "#2d2320"].map(lin);

function tent(size, canvas) {
  const b = new Buf(128), L = size, W = size * 0.86, H = size * 0.64;
  const lo = mul(canvas, 0.78), hi = mul(canvas, 1.08);
  const fl = [-W / 2, 0, L / 2], fr = [W / 2, 0, L / 2], ft = [0, H, L / 2], bl = [-W / 2, 0, -L / 2], br = [W / 2, 0, -L / 2], bt = [0, H, -L / 2];
  b.quad(fl, ft, bt, bl, lo, hi, hi, lo, [-1, 0.6, 0]);
  b.quad(fr, ft, bt, br, lo, hi, hi, lo, [1, 0.6, 0]);
  b.tri(fl, fr, ft, mul(canvas, 0.92), mul(canvas, 0.92), canvas, [0, 0, 1]);
  b.tri(bl, br, bt, mul(canvas, 0.85), mul(canvas, 0.85), canvas, [0, 0, -1]);
  const dz = L / 2 + 0.02, dark = lin("#3b2a22");
  b.tri([-W * 0.2, 0, dz], [W * 0.2, 0, dz], [0, H * 0.68, dz], dark, dark, mul(dark, 1.3), [0, 0, 1]);
  const flap = mul(canvas, 0.96);
  b.tri([-W * 0.2, 0, dz + 0.01], [-W * 0.34, 0, dz + 0.25], [0, H * 0.68, dz + 0.01], flap, mul(flap, 0.8), flap, [0.3, 0.2, 1]);
  const pole = lin("#7a5a3c");
  stick(b, [0, 0, L / 2 + 0.05], [0, H * 1.12, L / 2 + 0.05], 0.05, pole, pole);
  stick(b, [0, 0, -L / 2 - 0.05], [0, H * 1.12, -L / 2 - 0.05], 0.05, pole, pole);
  stick(b, [0, H * 1.06, L / 2 + 0.05], [0, H * 1.06, -L / 2 - 0.05], 0.035, mul(canvas, 0.7), mul(canvas, 0.7));
  const rope = lin("#d9ccb0");
  for (const s of [-1, 1]) for (const e of [-1, 1]) stick(b, [0, H * 1.05, e * (L / 2 + 0.05)], [s * W * 0.4, 0, e * (L / 2 + W * 0.45)], 0.012, rope, rope, 3);
  return b.geometry();
}

function person(cloth, skin, hair, rnd) {
  const b = new Buf(256), c0 = mul(cloth, 0.7), c1 = mul(cloth, 1.1);
  post(b, 0, 0, 0, 0.95, 0.3, 0.19, 7, c0, c1);
  ico(b, 0, 0.98, 0, 0.25, 0.14, 0.22, grad(cloth, mul(cloth, 1.15), 0.85), rnd, 0.06);
  ico(b, 0, 1.33, 0, 0.19, 0.2, 0.19, () => skin, rnd, 0.05);
  ico(b, 0, 1.4, -0.02, 0.2, 0.15, 0.2, () => hair, rnd, 0.08, 1.36);
  stick(b, [-0.24, 0.98, 0], [-0.26, 0.55, 0.12], 0.06, c1, c0);
  stick(b, [0.24, 0.98, 0], [0.26, 0.55, 0.12], 0.06, c1, c0);
  ico(b, 0.26, 0.52, 0.13, 0.06, 0.06, 0.06, () => skin, rnd, 0.05);
  ico(b, -0.26, 0.52, 0.13, 0.06, 0.06, 0.06, () => skin, rnd, 0.05);
  const eye = lin("#1c1512");
  ico(b, 0.07, 1.36, 0.17, 0.025, 0.03, 0.02, () => eye, rnd, 0);
  ico(b, -0.07, 1.36, 0.17, 0.025, 0.03, 0.02, () => eye, rnd, 0);
  return b.geometry();
}

function woodpile() {
  const b = new Buf(256), r = 0.17, L = 1.7;
  const rows = [[-0.36, 0, 0.36], [-0.18, 0.18], [0]];
  rows.forEach((row, k) => row.forEach((z) => { const y = r + k * r * 1.72; stick(b, [-L / 2, y, z * 1.1], [L / 2, y, z * 1.1], r, BARK, mul(BARK, 1.1), 6); b.tri([L / 2 + 0.001, y - r * 0.8, z * 1.1 - r * 0.5], [L / 2 + 0.001, y - r * 0.8, z * 1.1 + r * 0.5], [L / 2 + 0.001, y + r * 0.9, z * 1.1], CUT, CUT, CUT, [1, 0, 0]); b.tri([-L / 2 - 0.001, y - r * 0.8, z * 1.1 - r * 0.5], [-L / 2 - 0.001, y - r * 0.8, z * 1.1 + r * 0.5], [-L / 2 - 0.001, y + r * 0.9, z * 1.1], CUT, CUT, CUT, [-1, 0, 0]); }));
  const axe = lin("#8a8f96");
  stick(b, [L / 2 + 0.25, 0.02, 0.5], [L / 2 + 0.05, 0.75, 0.35], 0.03, lin("#9b7447"), lin("#9b7447"), 4);
  ico(b, L / 2 + 0.07, 0.72, 0.36, 0.1, 0.07, 0.03, () => axe, seeded(3), 0);
  return b.geometry();
}

function fire(rnd) {
  const b = new Buf(512), flame = new Buf(128);
  for (let k = 0; k < 10; k++) { const a = (k / 10) * 6.283, s = 0.2 + rnd() * 0.1; ico(b, Math.cos(a) * 0.72, 0.08, Math.sin(a) * 0.72, s, s * 0.7, s, grad(ROCK, ROCK_L, 0.7), rnd, 0.3, 0); }
  for (let k = 0; k < 5; k++) { const a = (k / 5) * 6.283 + 0.3; stick(b, [Math.cos(a) * 0.52, 0.03, Math.sin(a) * 0.52], [Math.cos(a) * 0.05, 0.62, Math.sin(a) * 0.05], 0.055, lin("#4a3222"), lin("#2a1d15"), 5); }
  ico(b, 0, 0.03, 0, 0.42, 0.06, 0.42, () => lin("#2b211c"), rnd, 0.1);
  const o = lin("#ff7a1c"), yv = lin("#ffd23a"), wv = lin("#fff4b0");
  spire(flame, 0, 0, [[0.05, 0.3, o], [0.35, 0.2, lin("#ffa02a")]], [1.05, yv], 6, rnd, 0.25);
  spire(flame, 0.12, 0.05, [[0.05, 0.18, o], [0.3, 0.12, yv]], [0.72, wv], 5, rnd, 0.25);
  spire(flame, -0.1, -0.07, [[0.05, 0.16, o], [0.25, 0.1, yv]], [0.6, wv], 5, rnd, 0.25);
  return { logs: b.geometry(), flame: flame.geometry() };
}

// Grid-space layout of the camp, scaled up like toy pieces but kept inside its hex.
export function campLayout(w, grid, toy) {
  const G = (p) => grid.grid(p.x, p.z), c = w.camp;
  const tents = c.tents.map((t) => { const [x, z] = G(t.at); return { x: x * 1.08, z: z * 1.08, size: t.size * toy }; });
  const people = c.people.map((p) => { const [x, z] = G(p.at); return { x: x * 1.5, z: z * 1.5 }; });
  const [wx, wz] = G(c.woodpile);
  const woodpile = { x: wx * 1.3, z: wz * 1.3 };
  const spots = [{ x: 0, z: 0, r: 5.2 * toy * 0.75, k: 1 }, ...tents.map((t) => ({ x: t.x, z: t.z, r: t.size * 0.95, k: 0.75 })), { x: woodpile.x, z: woodpile.z, r: 2.4 * toy, k: 0.7 }];
  for (const t of [...tents, woodpile]) for (let s = 0.3; s < 0.95; s += 0.12) spots.push({ x: t.x * s, z: t.z * s, r: 1.5 * toy * 0.6, k: 0.55 });
  return { tents, people, woodpile, spots };
}

export function buildCamp(w, board, D, layout, toy, mats, decor, rand) {
  const { grid, map } = board, t = map.get(hkey(0, 0)), y = t.top, out = [], face = (p) => Math.atan2(-p.x, -p.z);
  const blob = (x, z, r, k = 1) => decor.I.put("blob", x, y + 0.04, z, 0, r, 1, [k, k, k]);
  layout.tents.forEach((p, k) => {
    const m = new THREE.Mesh(tent(p.size, CANVAS[k % 3]), mats.solid);
    m.position.set(p.x, y, p.z);
    m.rotation.y = face(p);
    m.castShadow = m.receiveShadow = true;
    out.push(m);
    blob(p.x, p.z, p.size * 0.78, 1);
  });
  layout.people.forEach((p, k) => {
    const m = new THREE.Mesh(person(lin(COLORS[(k * 5 + 2) % COLORS.length]), SKIN[k % 5], HAIR[k % 5], seeded(200 + k)), mats.solid);
    m.position.set(p.x, y, p.z);
    m.rotation.y = face(p) + (rand() - 0.5) * 0.4;
    m.scale.setScalar(toy);
    m.castShadow = m.receiveShadow = true;
    out.push(m);
    blob(p.x, p.z, 0.55 * toy, 1);
  });
  const wp = new THREE.Mesh(woodpile(), mats.solid);
  wp.position.set(layout.woodpile.x, y, layout.woodpile.z);
  wp.rotation.y = face(layout.woodpile) + Math.PI / 2;
  wp.scale.setScalar(toy);
  wp.castShadow = wp.receiveShadow = true;
  out.push(wp);
  blob(layout.woodpile.x, layout.woodpile.z, 1.3 * toy, 1);
  const f = fire(seeded(99)), logs = new THREE.Mesh(f.logs, mats.solid), flame = new THREE.Mesh(f.flame, new THREE.MeshBasicMaterial({ vertexColors: true }));
  for (const m of [logs, flame]) { m.position.set(0, y, 0); m.scale.setScalar(toy); out.push(m); }
  logs.castShadow = logs.receiveShadow = true;
  flame.scale.setScalar(toy * 1.3);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffa04a, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.set(0, y + 0.7 * toy, 0);
  glow.scale.set(3.6 * toy, 3.6 * toy, 1);
  out.push(glow);
  const light = new THREE.PointLight(0xff9a48, 9, 7 * toy, 1.6);
  light.position.set(0, y + 1.2 * toy, 0);
  out.push(light);
  // A thread of smoke, leaning downwind, so the camp is found from afar.
  const [wx, wz] = grid.grid(w.camp.at.x + w.isle.wind[0], w.camp.at.z + w.isle.wind[1]), smokeRnd = seeded(7);
  for (let k = 0; k < 6; k++) {
    const r = (0.32 + k * 0.16) * toy, puff = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshToonMaterial({ color: 0xf1ece4, gradientMap: mats.solid.gradientMap, transparent: true, opacity: 0.88 - k * 0.12, depthWrite: false }));
    puff.position.set(wx * k * 0.55 * toy + (smokeRnd() - 0.5) * 0.4 * toy, y + (1.9 + k * 1.15) * toy, wz * k * 0.55 * toy + (smokeRnd() - 0.5) * 0.4 * toy);
    puff.scale.set(r, r * 0.85, r);
    puff.rotation.set(smokeRnd() * 6, smokeRnd() * 6, 0);
    out.push(puff);
  }

  // The camp's own ground: grass, flowers, pebbles and fallen wood scattered by the world, set on the tiles they fall on.
  const near = w.nearby(w.camp.at, board.view.nearR, board.view.nearDensity);
  const onTile = (x, z, r) => {
    const [gx, gz] = grid.grid(x, z), [q, rr] = grid.hexOf(gx, gz), s = map.get(hkey(q, rr));
    if (!s || s.water) return null;
    const px = gx - s.gx, pz = gz - s.gz;
    if (hexR(px, pz) > D.inT - r - D.R * 0.03 || (s.channel && s.channel.dist(px, pz) < s.channel.hw * 1.5)) return null;
    if (s === t && (layout.tents.some((p) => Math.hypot(gx - p.x, gz - p.z) < p.size * 0.62) || Math.hypot(gx, gz) < 3.2 * toy || layout.people.some((p) => Math.hypot(gx - p.x, gz - p.z) < 0.6 * toy) || Math.hypot(gx - layout.woodpile.x, gz - layout.woodpile.z) < 1.5 * toy)) return null;
    return [gx, s.top, gz];
  };
  for (const g of near.grass) { const p = onTile(g.x, g.z, 0.3); if (p) decor.I.put(`tuft${g.tint > 0.5 ? 1 : 0}`, p[0], p[1], p[2], g.yaw, g.tall * 1.5, g.tall * 1.6, [0.95 + g.tint * 0.15, 1, 0.92]); }
  for (const g of near.flowers) { const p = onTile(g.x, g.z, 0.2); if (p) decor.I.put("flower", p[0], p[1], p[2], rand() * 6.28, g.tall * 3.4, g.tall * 3.4, FLOWERS[Math.floor(g.hue * FLOWERS.length) % FLOWERS.length]); }
  for (const g of near.pebbles) { const p = onTile(g.x, g.z, g.size); if (p) decor.I.put("pebble", p[0], p[1], p[2], g.yaw, g.size * 1.4, g.size * 1.2, [0.95 + g.tint * 0.1, 0.95, 0.92]); }
  for (const g of near.logs) { const p = onTile(g.x, g.z, g.length * 0.5); if (p) { decor.I.put("log", p[0], p[1], p[2], g.yaw + board.grid.rot, g.length, g.length * 0.9, [1, 1, 1]); blob(p[0], p[2], g.length * 0.4, 0.6); } }
  return out;
}

function glowTexture() {
  const c = Object.assign(document.createElement("canvas"), { width: 64, height: 64 }), g = c.getContext("2d");
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.3, "rgba(255,255,255,0.45)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
