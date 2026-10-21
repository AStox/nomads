// Earth's laws on a planet of another radius, by dynamic similarity (docs/research/globe/2026-10-20-small-planet-impl.md, R1768 and up). The 2,000 km planet
// (`RADIUS_M`) is the generator's reference: its constants are Earth's own, set against 12 km cells in 2026-10-19 and pinned by the tests, so it is scaled by
// nothing. Every other radius is a similar planet: a number that carries Earth's behaviour is kept and the dimensional constant that holds it is rederived from it.
//
// The scale ratio is s = radius / Earth's radius. Under the similarity:
//   - velocities, heights and depths of the solid Earth, temperatures and fluxes per area are Earth's;
//   - lengths along the surface are Earth's times s, so the times of a flow (a length over a speed) are Earth's times s and rates are Earth's over s;
//   - the rotation rate is Earth's over s (Omega a is Earth's, so the thermal Rossby number g H Dh / (Omega a)^2 of Held and Hou, R1433, is Earth's);
//   - the tectonic clock is not scaled (a plate crosses the angle it crosses on Earth in the same time: its speed is Earth's times s), so lengths there are Earth's
//     times s and the time is Earth's.
// What this cannot keep is written as a gap in the note: the energy budget per area and the vapour's residence against the advective time (the evaporation is an
// energy flux), gravity, and the aspect ratio of every landform (heights are not scaled).
import { RADIUS_M } from "./grid";

// Earth's radius and sidereal rotation rate [cited: standard values].
export const EARTH_R = 6.371e6, EARTH_OMEGA = 7.292e-5;

export interface Similarity {
  similar: boolean;
  // s: radius over Earth's (1 on the reference planet): the factor on the atmosphere's times (the rotation period, the air's adjustment, the convective and the cloud
  // delays, the days a march is spun up) and the boundary layer's depth, and 1 over it on rates.
  s: number;
  // length: the factor on Earth's lengths along the surface in tectonics, erosion and ice (a hot spot's footprint, a creep diffusivity as its square): s, or 1 on the reference planet.
  length: number;
  // cells: the factor on the number of cells a length was worth on the 2,000 km planet's 12.27 km cells: with 256 cells a face a length of Earth's L km is L s / (cell width
  // of this planet) = L / 39.08 km cells whatever the radius, against L / 12.27 on the reference planet: RADIUS_M / EARTH_R (1 on the reference planet).
  cells: number;
}
export const similarityOf = (radius: number): Similarity => (radius === RADIUS_M
  ? { similar: false, s: 1, length: 1, cells: 1 }
  : { similar: true, s: radius / EARTH_R, length: radius / EARTH_R, cells: RADIUS_M / EARTH_R });
