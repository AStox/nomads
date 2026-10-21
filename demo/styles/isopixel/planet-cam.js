// The planet's camera: pure math, shared by the page (panning and picking while zoomed out) and the render worker's planet
// layer (planet.js). Units: the planet is the unit sphere (its radius, `radiusM`, 2,000,000 m unless the view says otherwise, is
// 1), lat and lon in degrees, angles in radians, screen y down like canvas px. The camera looks at a target point T on the
// sphere from `dist` metres away, tilted `tilt` from straight down (0 is nadir; the ladder's fixed look is elevation 30
// degrees, tilt 60), with `heading` the compass bearing of the ground direction that is screen up (0 north, a quarter turn east).
const DEG = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

export function planetCam({ lat, lon, dist, tilt, heading, tanH, w, h, radiusM = 2_000_000 }) {
  const la = Math.max(-89.999, Math.min(89.999, lat)) * DEG, lo = lon * DEG, cl = Math.cos(la);
  const T = [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
  const east = [-Math.sin(lo), Math.cos(lo), 0], north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), cl];
  const ch = Math.cos(heading), sh = Math.sin(heading), ct = Math.cos(tilt), st = Math.sin(tilt);
  const hd = [0, 1, 2].map((i) => ch * north[i] + sh * east[i]);
  const d = dist / radiusM;
  // the camera stands behind the target, away from where it looks, and above it
  const off = [0, 1, 2].map((i) => d * (ct * T[i] - st * hd[i]));
  const o = [T[0] + off[0], T[1] + off[1], T[2] + off[2]];
  const fwd = [0, 1, 2].map((i) => -ct * T[i] + st * hd[i]);
  const right = cross(hd, T);
  const up = cross(right, fwd);
  const aspect = w / h;
  // a point (unit sphere scale, any radius at or above 1) on the canvas, or null behind the camera or hidden by the planet
  function project(P) {
    const v = [P[0] - o[0], P[1] - o[1], P[2] - o[2]], z = dot(v, fwd);
    if (z <= 1e-12) return null;
    const a = dot(v, v), b = dot(o, v), disc = b * b - a * (dot(o, o) - 1);
    if (disc > 0 && b < 0) {
      const s = (-b - Math.sqrt(disc)) / a;
      if (s > 0 && s < 1 - 1e-9) return null;
    }
    return [((dot(v, right) / (z * tanH * aspect) + 1) / 2) * w, ((1 - dot(v, up) / (z * tanH)) / 2) * h];
  }
  // the sphere's point under a canvas point (relief ignored), or null off the planet
  function pick(x, y) {
    const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2;
    const rd = unit([0, 1, 2].map((i) => fwd[i] + nx * tanH * aspect * right[i] + ny * tanH * up[i]));
    // the near root t = c / (-b + sqrt(disc)) keeps its digits when the camera is close to the ground
    const b = dot(o, rd), c = 2 * dot(T, off) + dot(off, off), disc = b * b - c;
    if (disc < 0 || b >= 0) return null;
    const t = c / (-b + Math.sqrt(disc));
    return t < 0 ? null : unit([0, 1, 2].map((i) => o[i] + t * rd[i]));
  }
  return { o, T, off, fwd, right, up, tanH, aspect, dist, tilt, heading, lat, lon, w, h, radiusM, project, pick };
}

// The planet's tier-0 heights as the picture reads them: one texel per cell on each cube face with an apron of the
// neighbouring faces' cells, and `heightAt(lat, lon)` (m, the cells' cubic B-spline, so the camera can stand on what is drawn).
// `ids[k]` is the view's cell index of texel k, for the other fields. G is demo/globe.ts, V its viewFromBytes.
export function planetField(G, V) {
  const g = G.tierGrid(0), FN = g.fn, APRON = 2, SIDE = FN + 2 * APRON, T = SIDE * SIDE;
  const ids = new Uint32Array(6 * T), hTex = new Float32Array(6 * T);
  for (let f = 0; f < 6; f++)
    for (let j = 0; j < SIDE; j++)
      for (let i = 0; i < SIDE; i++) {
        const X = i - APRON, Y = j - APRON;
        let id;
        if (X >= 0 && X < FN && Y >= 0 && Y < FN) id = G.cellId(g, f, X, Y);
        else {
          const a = ((X + 0.5) / FN - 0.5) * (Math.PI / 2), b = ((Y + 0.5) / FN - 0.5) * (Math.PI / 2), q = G.locateVec(g, G.pointOf(f, Math.tan(a), Math.tan(b)));
          id = G.cellId(g, q.face, q.X, q.Y);
        }
        ids[f * T + j * SIDE + i] = id;
        hTex[f * T + j * SIDE + i] = V.height[id];
      }
  const bs = (t) => { const s = 1 - t; return [(s * s * s) / 6, (3 * t * t * t - 6 * t * t + 4) / 6, (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6, (t * t * t) / 6]; };
  function heightAt(lat, lon) {
    const p = G.fromLatLon(lat * DEG, lon * DEG);
    let f = 0, best = -2;
    for (let k = 0; k < 6; k++) { const d = dot(p, G.FRAMES[k].n); if (d > best) { best = d; f = k; } }
    const fr = G.FRAMES[f], sx = (Math.atan(dot(p, fr.ex) / best) / (Math.PI / 2) + 0.5) * FN, sy = (Math.atan(dot(p, fr.ey) / best) / (Math.PI / 2) + 0.5) * FN;
    const tx = sx + APRON - 0.5, ty = sy + APRON - 0.5, ix = Math.floor(tx), iy = Math.floor(ty), wx = bs(tx - ix), wy = bs(ty - iy);
    let r = 0;
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) r += hTex[f * T + Math.max(0, Math.min(SIDE - 1, iy - 1 + j)) * SIDE + Math.max(0, Math.min(SIDE - 1, ix - 1 + i))] * wx[i] * wy[j];
    return r;
  }
  return { FN, APRON, SIDE, ids, hTex, heightAt };
}
