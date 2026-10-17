// Work as energy delivered at a power (docs/research/people-constants.md sec. 7). An act needs so many joules of work, and
// whoever does it puts them in at their power: what their body keeps up through a working day (body.ts workWatts) at the
// arms' net efficiency (mechanics.ts NET_EFF), the more for practice and, where the act needs light to see by, at the share
// of its pace poor light leaves it (light.ts workRate). Helpers put their own power in. An act's time is its work over the
// power it gets, and what the work costs goes into the body's energy (sim.ts metOf).
import { NET_EFF } from "./mechanics";
import { bodyOf, frame, frameOf, newBody, workWatts } from "./body";
import { PHYS } from "./fuel";
import type { Agent, World } from "./world";

// ---------- power ----------
// What a rested, grown body puts into its work, W: the power every act's work is reckoned against (about 31 W).
const GROWN_BODY = newBody(18);
export const REF_W = NET_EFF * workWatts(GROWN_BODY, frame(GROWN_BODY, 18));
// Practice (R1152): Wright's 80% curve, each doubling of the times something has been done taking 0.8 of the time, so a
// practised hand puts (n + 1)^0.322 as much into the work as a first try does, n the times done before, each the 5 xp a
// success brings (sim.ts gain), counted no further than a skill's top level (world.ts level 10 at 1000 xp) [design].
const PROGRESS = 0.8, XP_TRY = 5, XP_TOP = 1000;
export const practised = (xp = 0) => (Math.min(xp, XP_TOP) / XP_TRY + 1) ** -Math.log2(PROGRESS);
// The power someone puts into an act, W: their body's, the more for their practice at it (xp in the act's skill), and
// light, the share of its pace the light leaves the work (1 where light doesn't come into it).
export const powerOf = (w: World, a: Agent, xp = 0, light = 1) => NET_EFF * workWatts(bodyOf(w, a), frameOf(w, a)) * practised(xp) * light;

// ---------- acts with no measured work ----------
// What each took a novice in full light at five minutes a tick, s (join and heat 8 ticks, wet 10, shape 6, place and
// plant 3, pour and wear 2, anything else 4), at the reference power [derived; gap: each act's own physics].
const SECS: Record<string, number> = { join: 2400, heat: 2400, wet: 3000, shape: 1800, place: 900, plant: 900, pour: 600, wear: 600 };
export const ACT_WORK: Record<string, number> = Object.fromEntries(Object.entries(SECS).map(([verb, s]) => [verb, s * REF_W]));
export const OTHER_WORK = 1200 * REF_W;

// ---------- digging ----------
// ILO's excavation norms (R1153): m3 of ground in place one worker digs in an eight-hour day with the right hand tools,
// soft ground 5.0, medium 3.5, hard 3.0, very hard 2.0, the classes ILO names after BS 5930's cohesive soils (soft, firm,
// stiff, very stiff), each taken at the middle of its undrained shear strength, Pa (R1154: 20 to 40, 40 to 75, 75 to 150
// and 150 to 300 kPa) [derived]. Between them along a straight line, past either end the end's.
const NORM: [number, number][] = [[30e3, 5], [57.5e3, 3.5], [112.5e3, 3], [225e3, 2]];
const DAY_S = 8 * 3600;
// The island's ground, firm [gap: no shear strength by spot]; its bulk density, clay's (fuel.ts PHYS) [analogue].
export const FIRM = 57.5e3;
const RHO_GROUND = PHYS.clay.rho, G = 9.81;
// The work of digging a m3 of ground of shear strength tau, J: a working day at the reference power over what a day digs.
function excavation(tau: number) {
  const i = NORM.findIndex(([t]) => t >= tau);
  if (i === 0) return (REF_W * DAY_S) / NORM[0][1];
  if (i < 0) return (REF_W * DAY_S) / NORM[NORM.length - 1][1];
  const [t0, m0] = NORM[i - 1], [t1, m1] = NORM[i];
  return (REF_W * DAY_S) / (m0 + ((m1 - m0) * (tau - t0)) / (t1 - t0));
}
// The work of digging out so much ground, m3, and lifting it from as deep on average, m, J: its excavation and its
// weight raised [derived].
export const digWork = (m3: number, lift: number, tau = FIRM) => m3 * (excavation(tau) + RHO_GROUND * G * lift);
// A lump of clay as dug, m3: its dry stuff at its own density and its water at water's (gait.ts bulkOf).
export const LUMP_M3 = PHYS.clay.mass / PHYS.clay.rho + (PHYS.clay.mass * (PHYS.clay.green ?? 0)) / 1000;
