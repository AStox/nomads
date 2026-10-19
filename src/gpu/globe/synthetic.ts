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
