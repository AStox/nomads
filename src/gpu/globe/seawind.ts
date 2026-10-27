// The sea's wind for the renderer: the planet's zonal-mean surface wind (atmosphere.ts windTable, the circulation of this radius at the equinox) at the latitude nodes the sea's wave
// spectrum is sampled at, as a speed in m/s and the direction the wind blows toward (east, north, unit). The speed is the scalar wind (the sea feels the gusts, not the mean flow), never under 2 m/s
// as air.ts reads it, the direction the mean flow's (Ekman turned), taken from the node a degree off the equator and the pole where it has none.
import { circulationOf, planetOf, windTable } from "./atmosphere";
import { PLANET_RADIUS_M } from "./grid";

export const SEA_WIND_STEP_DEG = 2.5;
export const SEA_WIND_NODES = 180 / SEA_WIND_STEP_DEG + 1;

export function seaWindTable(radius = PLANET_RADIUS_M): { speed: Float64Array; east: Float64Array; north: Float64Array } {
  const p = planetOf({ radius }), wt = windTable(p, circulationOf(p), 0);
  const nodeDeg = 180 / (wt.s.length - 1), speed = new Float64Array(SEA_WIND_NODES), east = new Float64Array(SEA_WIND_NODES), north = new Float64Array(SEA_WIND_NODES);
  const at = (deg: number) => Math.round((deg + 90) / nodeDeg);
  for (let i = 0; i < SEA_WIND_NODES; i++) {
    const lat = -90 + i * SEA_WIND_STEP_DEG, j = at(lat);
    speed[i] = Math.max(2, wt.s[j]);
    // no mean flow on the equator or at the poles: the direction there is the next node's, on the same side
    const k = at(Math.max(-89, Math.min(89, Math.abs(lat) < 1 ? 1 : lat)));
    const n = Math.hypot(wt.u[k], wt.v[k]) || 1;
    east[i] = wt.u[k] / n; north[i] = wt.v[k] / n;
  }
  return { speed, east, north };
}
