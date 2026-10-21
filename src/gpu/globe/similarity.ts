// Earth's laws on a planet of another radius, by dynamic similarity (docs/research/globe/2026-10-20-small-planet-impl.md, R1768 and up). The 2,000 km planet
// (`RADIUS_M`) is the generator's reference: its constants are Earth's own, set against 12 km cells in 2026-10-19 and pinned by the tests, so it is scaled by
// nothing. Every other radius is a similar planet: a number that carries Earth's behaviour is kept and the dimensional constant that holds it is rederived from it.
//
// The scale ratio is s = radius / Earth's radius. A constant scales only if the dimensionless number that carries Earth's behaviour holds the planet's radius or its spin (amended
// 2026-10-21 after the 75 m bake, Unit 4c; Unit 4b had scaled every length and made 6 km ranges 3 km wide):
//   scales (s):   the spin (the thermal Rossby number, Omega a is Earth's), the atmosphere's and the convective and cloud times (a length over a speed, a over U), the boundary layer
//                 (the Ekman number), the vapour column (the vapour's residence against the advective time), the eddy diffusivity (a mixing length goes as a), the energy balance's
//                 transport (the second mode of the temperature), the plates' angular rate (a plate crosses Earth's angle in Earth's time, the tectonic clock is not scaled), and the
//                 counts against the sphere (plates, hot spots by area: s^2);
//   stays Earth's: every length that rock, gravity and water set and a radius does not: orogen and wedge widths, the flexural scale, the arc band over the slab, a hot spot's
//                 footprint and flux, the weak channel's viscosity, creep, the sediment's reach, the shelf's slope, the bed's relaxation, the start's continental margins. Heights,
//                 depths, temperatures and fluxes per area are Earth's too.
// What this cannot keep is written as a gap in the note: the energy budget per area and the vapour's residence against the advective time (the evaporation is an energy flux),
// gravity, and the aspect ratio of the sphere against a continent (a 300 km range on a 1,229 km circumference).
import { RADIUS_M } from "./grid";

// Earth's radius and sidereal rotation rate [cited: standard values].
export const EARTH_R = 6.371e6, EARTH_OMEGA = 7.292e-5;

export interface Similarity {
  similar: boolean;
  // s: radius over Earth's (1 on the reference planet): the factor on the atmosphere's times (the rotation period, the air's adjustment, the convective and the cloud
  // delays, the days a march is spun up) and the boundary layer's depth, and 1 over it on rates.
  s: number;
  // cells: how many times more cells an Earth length takes here than on the 2,000 km reference planet, against whose 12.27 km cells every constant was set. Both have 256 cells a face,
  // so a cell here is radius / RADIUS_M of a reference cell: 10.2 at 195.6 km, 1 on the reference.
  cells: number;
}
export const similarityOf = (radius: number): Similarity => (radius === RADIUS_M
  ? { similar: false, s: 1, cells: 1 }
  : { similar: true, s: radius / EARTH_R, cells: RADIUS_M / radius });
