// Synthetic planets for the atmosphere's tests and its map viewer: height fields (m, in cell-id order) built from each cell's
// latitude and longitude, with no real terrain. The sea is at 0 m; the floor is 4,000 m down.
import type { Geometry } from "./atmosphere";

const DEG = Math.PI / 180;
export const FLOOR = -4000;
const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
// The angular distance (radians) from a cell to the half meridian circle of longitude lon0 (degrees): asin(cos phi |sin(dlon)|)
// on its side of the planet, a quarter turn (far) on the other.
export const toMeridian = (lat: number, lon: number, lon0: number) => (Math.cos(lon - lon0 * DEG) < 0 ? Math.PI / 2 : Math.asin(Math.cos(lat) * Math.abs(Math.sin(lon - lon0 * DEG))));

// An ocean world: no land at all.
export const oceanPlanet = (geo: Geometry) => new Float32Array(geo.n).fill(FLOOR);

// One north-south ridge across an ocean, from latitude lat0 to lat1 (degrees) on longitude lon0, cos-squared across, half its
// width halfKm wide at the foot, peak metres tall, its ends eased over 2 degrees of latitude.
export function ridgePlanet(geo: Geometry, o: { lat0?: number; lat1?: number; lon0?: number; halfKm?: number; peak?: number } = {}) {
  const { lat0 = 56, lat1 = 64, lon0 = 90, halfKm = 150, peak = 3000 } = o, R = geo.g.radius, out = new Float32Array(geo.n).fill(FLOOR);
  for (let i = 0; i < geo.n; i++) {
    const d = R * toMeridian(geo.lat[i], geo.lon[i], lon0), la = geo.lat[i] / DEG;
    const along = Math.min(smooth((la - lat0) / 2), smooth((lat1 - la) / 2));
    if (d < halfKm * 1000 && along > 0) {
      const h = peak * along * Math.cos((Math.PI * d) / (2 * halfKm * 1000)) ** 2;
      if (h > 1) out[i] = h;
    }
  }
  return out;
}

// A polar continent (north of 72 degrees) and an equatorial one (within 20 degrees of the equator, longitude 30 to 130), each
// 200 m above the sea, the equatorial one with a plateau up to 3,000 m along longitude 80 that the lapse is read across.
export function twoContinents(geo: Geometry) {
  const out = new Float32Array(geo.n).fill(FLOOR);
  for (let i = 0; i < geo.n; i++) {
    const la = geo.lat[i] / DEG, lo = ((geo.lon[i] / DEG + 360) % 360);
    if (la > 72) out[i] = 200;
    else if (Math.abs(la) < 20 && lo > 30 && lo < 130) out[i] = 200 + 2800 * smooth(1 - Math.abs(lo - 80) / 20);
  }
  return out;
}

// A box continent in the westerlies: latitude 52 to 72 and longitude 40 to 100 (some 3,100 km across at 62 degrees), flat at
// 200 m: its west coast has the sea behind it and its east coast the continent.
export function westerlyContinent(geo: Geometry) {
  const out = new Float32Array(geo.n).fill(FLOOR);
  for (let i = 0; i < geo.n; i++) {
    const la = geo.lat[i] / DEG, lo = ((geo.lon[i] / DEG + 360) % 360);
    if (la > 52 && la < 72 && lo > 40 && lo < 100) out[i] = 200;
  }
  return out;
}

// Four continents on a sea of 29% land, as a rough stand-in for the real thing in the tests and maps of the water cycle: a
// northern one in the westerlies (48 N, 1,400 km across the cap), a southern one in the trades (20 S), a small equatorial
// island land and a polar one in the south, each with a coast made irregular by two harmonics of the bearing from its centre,
// 150 to 600 m over most of it and a range 150 km across on the west coast of the northern one (3 km) and the east coast of the
// southern one (2.5 km). Nothing about it is Earth's map: it is for a check of the water cycle's laws, not a place.
const CONTINENTS = [
  { lat: 48, lon: 55, km: 1400, a: [0.22, 0.12], p: [0.3, 1.1] },
  { lat: -20, lon: 300, km: 1200, a: [0.18, 0.15], p: [2.0, 0.4] },
  { lat: 8, lon: 170, km: 700, a: [0.25, 0.1], p: [1.3, 2.6] },
  { lat: -62, lon: 120, km: 800, a: [0.2, 0.1], p: [0.8, 1.9] },
];
export function earthlikePlanet(geo: Geometry) {
  const R = geo.g.radius, out = new Float32Array(geo.n).fill(FLOOR), inland = new Float32Array(geo.n);
  for (let i = 0; i < geo.n; i++) {
    const la = geo.lat[i], lo = geo.lon[i];
    let h = FLOOR;
    for (const c of CONTINENTS) {
      const p0 = c.lat * DEG, dl = lo - c.lon * DEG;
      const d = Math.acos(Math.max(-1, Math.min(1, Math.sin(la) * Math.sin(p0) + Math.cos(la) * Math.cos(p0) * Math.cos(dl))));
      const th = Math.atan2(Math.sin(dl) * Math.cos(la), Math.cos(p0) * Math.sin(la) - Math.sin(p0) * Math.cos(la) * Math.cos(dl));
      const rho = (c.km * 1000 * (1 + c.a[0] * Math.sin(2 * th + c.p[0]) + c.a[1] * Math.sin(3 * th + c.p[1]))) / R;
      if (d < rho) { h = Math.max(h, 150 + 450 * smooth((1 - d / rho) * 2)); inland[i] = Math.max(inland[i], ((rho - d) * R) / 1000); }
    }
    out[i] = h;
  }
  // a range's height falls to nothing toward the coast over 300 km of land (a cliff of 3 km from the sea is a different case)
  const range = (lat0: number, lat1: number, lon0: number, peak: number) => {
    const ridge = ridgePlanet(geo, { lat0, lat1, lon0, halfKm: 150, peak });
    for (let i = 0; i < geo.n; i++) if (out[i] > 0 && ridge[i] > 0) out[i] = Math.max(out[i], ridge[i] * smooth(inland[i] / 300));
  };
  range(36, 62, 10, 3000);
  range(-40, 0, 333, 2500);
  return out;
}
