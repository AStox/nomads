// A dense voxel grid and the mesher that turns it into merged buffers: only faces that touch air (or see-through
// voxels) are emitted, each vertex carrying the classic corner ambient occlusion from its three neighbors.
export const AIR = 0, EARTH = 1, THING = 2, WATER = 3, GLOW = 4, SMALL = 5, SMOKE = 6;
const SOLID = new Uint8Array([0, 1, 1, 0, 1, 1, 0]);
const CLEAR = new Uint8Array([0, 0, 0, 1, 0, 0, 1]);

export class Grid {
  constructor(nx, ny, nz) {
    Object.assign(this, { nx, ny, nz });
    this.kind = new Uint8Array(nx * ny * nz);
    this.rgb = new Uint32Array(nx * ny * nz);
  }
  at(x, y, z) { return (y * this.nz + z) * this.nx + x; }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz; }
  get(x, y, z) { return this.inside(x, y, z) ? this.kind[(y * this.nz + z) * this.nx + x] : AIR; }
  set(x, y, z, kind, rgb) {
    if (!this.inside(x, y, z)) return;
    const i = (y * this.nz + z) * this.nx + x;
    this.kind[i] = kind;
    this.rgb[i] = rgb;
  }
  // Models only grow into air (or smoke), so they never eat the ground or each other.
  add(x, y, z, kind, rgb) {
    if (!this.inside(x, y, z)) return false;
    const i = (y * this.nz + z) * this.nx + x, k = this.kind[i];
    if (k !== AIR && k !== SMOKE) return false;
    this.kind[i] = kind;
    this.rgb[i] = rgb;
    return true;
  }
}

class Buffers {
  constructor(alpha) {
    this.alpha = alpha;
    this.faces = 0;
    this.cap = 1 << 15;
    this.grow();
  }
  grow() {
    const c = this.cap, cw = this.alpha ? 4 : 3;
    const more = (old, T, n) => { const a = new T(n); if (old) a.set(old); return a; };
    this.pos = more(this.pos, Int16Array, c * 12);
    this.nrm = more(this.nrm, Int8Array, c * 12);
    this.col = more(this.col, Uint8Array, c * 4 * cw);
    this.ao = more(this.ao, Uint8Array, c * 4);
    this.idx = more(this.idx, Uint32Array, c * 6);
  }
  trim() {
    const f = this.faces, cw = this.alpha ? 4 : 3;
    return { faces: f, pos: this.pos.subarray(0, f * 12), nrm: this.nrm.subarray(0, f * 12), col: this.col.subarray(0, f * 4 * cw), ao: this.ao.subarray(0, f * 4), idx: this.idx.subarray(0, f * 6), alpha: this.alpha };
  }
}

// Positions are stored in eighths of a voxel so the water surface can sit a little below the voxel top.
const Q = 8;
// Face table: for each of the six directions, the normal, the two tangent axes and the four corners in
// counter-clockwise order seen from outside.
const FACES = [];
for (let a = 0; a < 3; a++)
  for (const s of [1, -1]) {
    const b = (a + 1) % 3, c = (a + 2) % 3, n = [0, 0, 0];
    n[a] = s;
    const order = s > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
    const corners = order.map(([cb, cc]) => {
      const p = [0, 0, 0], u = [0, 0, 0], v = [0, 0, 0];
      p[a] = s > 0 ? 1 : 0;
      p[b] = cb;
      p[c] = cc;
      u[b] = cb ? 1 : -1;
      v[c] = cc ? 1 : -1;
      return { p, u, v };
    });
    FACES.push({ a, s, n, corners });
  }

const AO = [0.3, 0.54, 0.77, 1];

// toCamera/toSun are unit vectors; a face that looks away from the camera and toward the sun is never seen in
// either the view or the shadow map, so it is skipped.
export function mesh(g, { toCamera, toSun, waterDrop = 2 }) {
  const { nx, ny, nz, kind, rgb } = g;
  const SX = 1, SZ = nx, SY = nx * nz;
  const opaque = new Buffers(false), clear = new Buffers(true), glow = new Buffers(false);
  // Highest tree/tent voxel per column: a vertex under one sees less sky.
  const top = new Int16Array(nx * nz).fill(-1);
  for (let y = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0, i = (y * nz + z) * nx; x < nx; x++, i++) if (kind[i] === THING) top[z * nx + x] = y;
  const skyAt = (x, y, z) => {
    let n = 0;
    for (let dz = -2; dz < 2; dz++) {
      const zz = z + dz;
      if (zz < 0 || zz >= nz) continue;
      for (let dx = -2; dx < 2; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < nx && top[zz * nx + xx] >= y) n++;
      }
    }
    return 1 - 0.62 * (n / 16);
  };
  const dot = (n, v) => n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
  const seen = FACES.map((f) => dot(f.n, toCamera) > 0.001);
  const needed = FACES.map((f, d) => seen[d] || dot(f.n, toSun) < 0.001);
  const solid = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && SOLID[kind[(y * nz + z) * nx + x]] === 1;
  const q = [0, 0, 0], ao4 = [0, 0, 0, 0], sky4 = [0, 0, 0, 0];

  function emit(buf, x, y, z, d, color, shade, drop) {
    if (buf.faces === buf.cap) { buf.cap *= 2; buf.grow(); }
    const f = FACES[d], k = buf.faces, v0 = k * 4, cw = buf.alpha ? 4 : 3;
    const r = (color >>> 16) & 255, gg = (color >>> 8) & 255, b = color & 255, al = (color >>> 24) & 255;
    for (let c = 0; c < 4; c++) {
      const p = f.corners[c].p, o = (v0 + c) * 3;
      buf.pos[o] = (x + p[0]) * Q;
      buf.pos[o + 1] = (y + p[1]) * Q - (p[1] === 1 ? drop : 0);
      buf.pos[o + 2] = (z + p[2]) * Q;
      buf.nrm[o] = f.n[0] * 127;
      buf.nrm[o + 1] = f.n[1] * 127;
      buf.nrm[o + 2] = f.n[2] * 127;
      const oc = (v0 + c) * cw;
      buf.col[oc] = r;
      buf.col[oc + 1] = gg;
      buf.col[oc + 2] = b;
      if (cw === 4) buf.col[oc + 3] = al;
      buf.ao[v0 + c] = shade ? Math.round(AO[ao4[c]] * sky4[c] * 255) : 255;
    }
    const o = k * 6;
    if (!shade || ao4[0] + ao4[2] >= ao4[1] + ao4[3]) {
      buf.idx[o] = v0; buf.idx[o + 1] = v0 + 1; buf.idx[o + 2] = v0 + 2;
      buf.idx[o + 3] = v0; buf.idx[o + 4] = v0 + 2; buf.idx[o + 5] = v0 + 3;
    } else {
      buf.idx[o] = v0 + 1; buf.idx[o + 1] = v0 + 2; buf.idx[o + 2] = v0 + 3;
      buf.idx[o + 3] = v0 + 1; buf.idx[o + 4] = v0 + 3; buf.idx[o + 5] = v0;
    }
    buf.faces++;
  }

  for (let y = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const i = (y * nz + z) * nx + x, k = kind[i];
        if (k === AIR) continue;
        for (let d = 0; d < 6; d++) {
          const f = FACES[d];
          q[0] = x; q[1] = y; q[2] = z;
          q[f.a] += f.s;
          const out = q[0] < 0 || q[1] < 0 || q[2] < 0 || q[0] >= nx || q[1] >= ny || q[2] >= nz;
          const nk = out ? AIR : kind[i + (f.a === 0 ? SX : f.a === 1 ? SY : SZ) * f.s];
          if (CLEAR[k]) {
            // See-through voxels show a face only against air (or a different see-through kind).
            if (!seen[d] || (nk !== AIR && !(CLEAR[nk] && nk !== k))) continue;
            const surface = k === WATER && (y + 1 >= ny || kind[i + SY] !== WATER);
            emit(clear, x, y, z, d, rgb[i], false, surface ? waterDrop : 0);
            continue;
          }
          if (SOLID[nk] || !needed[d]) continue;
          if (k === GLOW) {
            if (!seen[d]) continue;
            emit(glow, x, y, z, d, rgb[i], false, 0);
            continue;
          }
          for (let c = 0; c < 4; c++) {
            const { u, v, p } = f.corners[c];
            const s1 = solid(q[0] + u[0], q[1] + u[1], q[2] + u[2]) ? 1 : 0;
            const s2 = solid(q[0] + v[0], q[1] + v[1], q[2] + v[2]) ? 1 : 0;
            const cn = solid(q[0] + u[0] + v[0], q[1] + u[1] + v[1], q[2] + u[2] + v[2]) ? 1 : 0;
            ao4[c] = s1 && s2 ? 0 : 3 - s1 - s2 - cn;
            sky4[c] = skyAt(x + p[0], y + p[1], z + p[2]);
          }
          emit(opaque, x, y, z, d, rgb[i], true, 0);
        }
      }
  return { opaque: opaque.trim(), clear: clear.trim(), glow: glow.trim(), Q };
}
