// The planet's camera: pure math, shared by the page (panning and picking while zoomed out) and the render worker's planet
// layer (planet.js). Units: the planet is the unit sphere (its radius, `radiusM`, 2,000,000 m unless the view says otherwise, is
// 1), lat and lon in degrees, angles in radians, screen y down like canvas px. The camera looks at a target point T on the
// sphere from `dist` metres away, tilted `tilt` from straight down (0 is nadir; the ladder's fixed look is elevation 30
// degrees, tilt 60), with `heading` the compass bearing of the ground direction that is screen up (0 north, a quarter turn east).
const DEG = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

export function planetCam({ lat, lon, dist, tilt, heading, tanH, w, h, radiusM = 2_000_000, lift = 0 }) {
  const la = Math.max(-89.999, Math.min(89.999, lat)) * DEG, lo = lon * DEG, cl = Math.cos(la);
  const T = [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
  const east = [-Math.sin(lo), Math.cos(lo), 0], north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), cl];
  const ch = Math.cos(heading), sh = Math.sin(heading), ct = Math.cos(tilt), st = Math.sin(tilt);
  const hd = [0, 1, 2].map((i) => ch * north[i] + sh * east[i]);
  const d = dist / radiusM;
  // the camera stands behind the target, away from where it looks, and above it
  const off = [0, 1, 2].map((i) => d * (ct * T[i] - st * hd[i]) + (lift / radiusM) * T[i]);
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
  // the surface under a canvas point as a unit point, or null off it: the sphere raised by `lift` (the ground under the target as
  // drawn), relief otherwise ignored, so the target itself is exact
  const rho2m1 = 2 * (lift / radiusM) + (lift / radiusM) ** 2;
  function pick(x, y) {
    const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2;
    const rd = unit([0, 1, 2].map((i) => fwd[i] + nx * tanH * aspect * right[i] + ny * tanH * up[i]));
    // the near root t = c / (-b + sqrt(disc)) keeps its digits when the camera is close to the ground
    const b = dot(o, rd), c = 2 * dot(T, off) + dot(off, off) - rho2m1, disc = b * b - c;
    if (disc < 0 || b >= 0) return null;
    const t = c / (-b + Math.sqrt(disc));
    return t < 0 ? null : unit([0, 1, 2].map((i) => o[i] + t * rd[i]));
  }
  return { o, T, off, fwd, right, up, tanH, aspect, dist, tilt, heading, lat, lon, w, h, radiusM, lift, project, pick };
}
