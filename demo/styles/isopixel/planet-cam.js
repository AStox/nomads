// The planet's camera: pure math, shared by the page (panning and picking while zoomed out) and the render worker's planet
// layer (planet.js). Units: the planet is the unit sphere (its radius, `radiusM`, 2,000,000 m unless the view says otherwise, is
// 1), lat and lon in degrees, angles in radians, screen y down like canvas px. The camera looks at a target point T on the
// sphere from `dist` metres away, tilted `tilt` from straight down (0 is nadir; the ladder's fixed look is elevation 30
// degrees, tilt 60), with `heading` the compass bearing of the ground direction that is screen up (0 north, a quarter turn east).
const DEG = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

export function planetCam({ lat, lon, dist, tilt, heading, tanH, ortho = 0, q = null, w, h, radiusM = 2_000_000, lift = 0 }) {
  const la = Math.max(-89.999, Math.min(89.999, lat)) * DEG, lo = lon * DEG, cl = Math.cos(la);
  const T = [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
  const east = [-Math.sin(lo), Math.cos(lo), 0], north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), cl];
  const ch = Math.cos(heading), sh = Math.sin(heading), ct = Math.cos(tilt), st = Math.sin(tilt);
  const hd = [0, 1, 2].map((i) => ch * north[i] + sh * east[i]);
  const d = dist / radiusM;
  // the camera stands behind the target, away from where it looks, and above it
  const off = [0, 1, 2].map((i) => d * (ct * T[i] - st * hd[i]) + (lift / radiusM) * T[i]);
  const o = [T[0] + off[0], T[1] + off[1], T[2] + off[2]];
  const fwd0 = [0, 1, 2].map((i) => -ct * T[i] + st * hd[i]), fwd = fwd0;
  const right = cross(hd, T);
  const up = cross(right, fwd);
  const aspect = w / h;
  // the ground's local cells as the ladder lays them, q (2 by 2 on east and north, from the window's own frame to the cells here, planet.js worker.js cellQ): drawn in the ladder's metric, a
  // cell of the window is where the ladder puts it (the objects stand on cells), so the rays are mapped by q about the target as they leave the camera, in the share the camera is parallel
  const m = q ? [1 + ortho * (q[0] - 1), ortho * q[1], ortho * q[2], 1 + ortho * (q[3] - 1)] : [1, 0, 0, 1], det = m[0] * m[3] - m[1] * m[2];
  const via = (a, b, c, d) => (v) => { const e = dot(v, east), n = dot(v, north); return [0, 1, 2].map((i) => v[i] + east[i] * ((a - 1) * e + b * n) + north[i] * (c * e + (d - 1) * n)); };
  const warp = via(m[0], m[1], m[2], m[3]), unwarp = via(m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  // the orthographic share: a pixel's ray starts `ortho` of the screen's half height (at the target's depth) off the camera and spreads by what is left (wgsl/globe.js fs)
  const hh = (tanH * dist) / radiusM;
  // a point (unit sphere scale, any radius at or above 1) on the canvas, or null behind the camera or hidden by the planet
  function project(P0) {
    const P = add3(T, unwarp(sub3(P0, T)));
    const v = [P[0] - o[0], P[1] - o[1], P[2] - o[2]], z = dot(v, fwd);
    if (z <= 1e-12) return null;
    const a = dot(v, v), b = dot(o, v), disc = b * b - a * (dot(o, o) - 1);
    if (disc > 0 && b < 0) {
      const s = (-b - Math.sqrt(disc)) / a;
      if (s > 0 && s < 1 - 1e-9) return null;
    }
    const den = ortho * hh + (1 - ortho) * tanH * z;
    return [((dot(v, right) / (den * aspect) + 1) / 2) * w, ((1 - dot(v, up) / den) / 2) * h];
  }
  // the surface under a canvas point as a unit point, or null off it: the sphere raised by `lift` (the ground under the target as
  // drawn), relief otherwise ignored, so the target itself is exact
  const rho2m1 = 2 * (lift / radiusM) + (lift / radiusM) ** 2;
  function pick(x, y) {
    const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2;
    const lat = [0, 1, 2].map((i) => nx * aspect * right[i] + ny * up[i]);
    const rd = unit([0, 1, 2].map((i) => fwd[i] + (1 - ortho) * tanH * lat[i]));
    const po = [0, 1, 2].map((i) => o[i] + ortho * hh * lat[i]), poff = [0, 1, 2].map((i) => off[i] + ortho * hh * lat[i]);
    // the near root t = c / (-b + sqrt(disc)) keeps its digits when the camera is close to the ground
    const b = dot(po, rd), c = 2 * dot(T, poff) + dot(poff, poff) - rho2m1, disc = b * b - c;
    if (disc < 0 || b >= 0) return null;
    const t = c / (-b + Math.sqrt(disc));
    if (t < 0) return null;
    const hit = [0, 1, 2].map((i) => po[i] + t * rd[i]);
    return unit(add3(T, warp(sub3(hit, T))));
  }
  // what the shader takes: the same camera with every vector mapped
  const offW = warp(off), oW = add3(T, offW);
  return { o: oW, T, off: offW, fwd: warp(fwd), right: warp(right), up: warp(up), tanH, ortho, hh, aspect, dist, tilt, heading, lat, lon, w, h, radiusM, lift, project, pick };
}
