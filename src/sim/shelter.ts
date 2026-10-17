// What a shelter, a fire's ring and a pit's cover are by what they are built of (docs/research/people-constants.md sec.
// 8). Every piece laid into a shelter is a pole, a sheet, thatch or a solid by what it is and its shape: wood at least
// ten times as long as it is thick is a pole; anything else at least a hundred times as long (as a round piece of its
// mass would be) as it is thick lies flat as a sheet; fine plant stuff is thatch; the rest are solids. The poles lean
// together at thatch's least pitch into a cone whose slant is the third longest of them (three set it up, the rest lean
// on them); the solids stand as a wall round the cone's foot if they close a course round it; the sheets and the thatch
// cover the cone, thatch only where rafters stand close enough to hold it. So a shelter has a floor, a roof and walls in
// metres, a cover that closes so much of its roof, layers that resist heat by their conductivities and thicknesses,
// rafters that break under so much, and a wind that breaks or tips it. Without three poles that carry their cover over at
// least one sleeper's floor, it is a heap, which the wind scatters once it slides its stoutest pieces.
import { BURNS, physOf, stackPhys, type Phys } from "./fuel";
import { MU_WOOD, isWood } from "./mechanics";
import { grown, hc } from "./body";
import type { Registry } from "./materials";
import type { Shelter, Stack } from "./world";
import { TALLEST } from "../terrain/niche";

const G = 9.81, RHO_AIR = 1.2; // m/s2; air, kg/m3 (fire-constants sec. 6)
// Thatch (R1101): laid no flatter than 45 degrees, about 150 kg of it to the m3, 0.07 W/mK at its usual damp, and 0.30 m
// deep where it keeps the rain out, on rafters no more than a metre apart.
export const PITCH = Math.PI / 4;
const THATCH = { rho: 150, k: 0.07, depth: 0.3, apart: 1 };
// The widest floor a roof stands over: a cone of the longest pole anyone gets, a fifth of the tallest tree (fuel.ts
// pieceOf), at that pitch [derived].
export const WIDEST = (TALLEST / 5) * Math.cos(PITCH);
// A pole is at least ten times as long as it is thick, a sheet a hundred times [design: where a piece stops leaning as a
// rafter, or lying flat over one].
const POLE = 10, SHEET = 100;
// The floor one sleeper takes: a grown body's stature by its shoulders' breadth, 0.259 of stature (R1062) [derived].
const STATURE = grown(18).m, SLEEPER = STATURE * 0.259 * STATURE;
// A heap's solid share, a fire's heap's (fire-constants sec. 17) [analogue].
const PACK = 0.1;
// The wind's push: a sphere's drag, 0.47, on a hut's rounded body, and a disk's, 1.17, on a piece lying broadside to it
// (Hoerner, R1034) [analogue]; a piece slides when that beats wood's friction on wood (matter-constants) [analogue].
const CD_HUT = 0.47, CD_PIECE = 1.17;

// ---------- members ----------
// A piece laid: what it is, how many alike, and how long one is, m.
export type Member = { x: Phys; n: number; len: number };
const lenOf = (x: Phys, len?: number) => len ?? x.mass / (x.rho * ((Math.PI * x.d * x.d) / 4));
// The pieces of what was built, by kind: those whose own pieces were kept as laid, and the rest as their kind comes.
export function membersOf(reg: Registry, parts: Record<string, number>, pieces: Stack[] = []): Member[] {
  const out: Member[] = [];
  for (const [k, c] of Object.entries(parts)) {
    const own = pieces.filter((s) => s.k === k).slice(0, c);
    for (const s of own) { const x = stackPhys(reg, s); if (x) out.push({ x, n: 1, len: lenOf(x, s.size?.len) }); }
    const x = physOf(reg, reg[k]);
    if (x && c > own.length) out.push({ x, n: c - own.length, len: lenOf(x) });
  }
  return out;
}
// What a piece does in a shelter.
export const roleOf = (m: Member) =>
  m.x.herb ? "thatch" : isWood(m.x) ? (m.len >= POLE * m.x.d ? "pole" : "solid") : m.len >= SHEET * m.x.d ? "sheet" : "solid";
// Green wood's modulus of rupture, Pa: the Wood Handbook's 109,600 G^1.01 kPa for softwoods and 118,700 G^1.16 for
// hardwoods (R317, matter-constants sec. 2), a member out in the weather taken as wet through [design].
export const rupture = (x: Phys) => (x.burn === BURNS.hardwood ? 118.7e6 * (x.rho / 1000) ** 1.16 : 109.6e6 * (x.rho / 1000) ** 1.01);
const section = (d: number) => (Math.PI * d ** 3) / 32; // m3: a round member's section modulus
// The load a round member breaks under across a span L, N: spread along it, 8 MOR S / L, or on its middle, 4 MOR S / L.
export const spreadLoad = (x: Phys, L: number) => (8 * rupture(x) * section(x.d)) / L;
export const pointLoad = (x: Phys, L: number) => (4 * rupture(x) * section(x.d)) / L;
// The wind that slides a piece lying on the ground broadside to it, m/s.
const slides = (m: Member) => Math.sqrt((MU_WOOD * m.x.mass * G) / (0.5 * RHO_AIR * CD_PIECE * m.x.d * m.len));

// ---------- the shelter ----------
export function shelterOf(members: Member[], style: string): Shelter {
  const poles: { x: Phys; len: number }[] = [];
  let all = 0, weight = 0, sheets = 0, thatch = 0, coverR = 0, cover = 0, solid = 0, solidD = 0, solidK = 0;
  for (const m of members) {
    const vol = (m.n * m.x.mass) / m.x.rho, role = roleOf(m);
    all += vol;
    weight += m.n * m.x.mass * G;
    if (role === "pole") for (let i = 0; i < m.n; i++) poles.push({ x: m.x, len: m.len });
    else if (role === "sheet") { sheets += (m.n * m.x.mass) / (m.x.rho * m.x.d); coverR += vol / m.x.k; cover += m.n * m.x.mass * G; }
    else if (role === "thatch") { const v = (m.n * m.x.mass) / THATCH.rho; thatch += v; coverR += v / THATCH.k; cover += m.n * m.x.mass * G; }
    else { solid += vol; solidD += vol * m.x.d; solidK += vol * m.x.k; }
  }
  // a heap holds together until the wind slides its stoutest pieces; lighter ones blow off it before [gap: what blows
  // off is not taken from it]
  const heap = (): Shelter => {
    const r = Math.cbrt((3 * all) / (2 * Math.PI * PACK));
    const wind = members.length ? Math.max(...members.map(slides)) : 0;
    return { tier: 0, style, r, top: r, eaves: 0, roof: 0, closed: 0, rRoof: 0, wall: 0, rWall: 0, wind, room: 0 };
  };
  if (poles.length < 3) return heap();
  poles.sort((a, b) => b.len - a.len);
  const L = poles[2].len, r = L * Math.cos(PITCH), rise = L * Math.sin(PITCH), roof = Math.PI * r * L, ring = 2 * Math.PI * r;
  // the walls: the solids' face, a course of their mean thickness high at least, round the foot
  const t = solid ? solidD / solid : 0, high = solid ? solid / (ring * t) : 0, eaves = high >= t ? high : 0;
  // the cover: its sheets, and its thatch where rafters stand within a metre of each other at the eaves
  const held = Math.min(1, (poles.length * THATCH.apart) / ring);
  const closed = Math.min(1, sheets / roof + Math.min(held, thatch / (roof * THATCH.depth)));
  // the rafters, each across its own length or the cone's slant, against the cover's weight across them and the wind's
  // push on the hut's profile; and the whole of it, standing loose on the ground, against that push tipping it over its
  // downwind foot at the height the push acts at, its weight holding it down at its middle [gap: pegs and lashings]
  const load = poles.reduce((s, p) => s + spreadLoad(p.x, Math.min(p.len, L)), 0), dead = cover * Math.cos(PITCH);
  const top = eaves + rise, below = 2 * r * eaves, above = r * rise, profile = below + above;
  const acts = (below * (eaves / 2) + above * (eaves + rise / 3)) / profile;
  const room = Math.floor((closed * Math.PI * r * r) / SLEEPER);
  if (load < dead || room < 1) return heap();
  const push = 0.5 * RHO_AIR * CD_HUT * profile, wind = Math.sqrt(Math.min(load - dead, (weight * r) / acts) / push);
  const tier = closed < 1 ? 1 : eaves > 0 ? 3 : 2, wall = ring * eaves;
  return { tier, style, r, top, eaves, roof, closed, rRoof: coverR / (closed * roof), wall, rWall: eaves ? (t * solid) / solidK : 0, wind, room };
}
// Whether a point x, y m from a shelter's middle, z m up, is within its roof or walls.
export function within(sh: Shelter, x: number, y: number, z: number) {
  if (!sh.tier || z > sh.top) return false;
  const rz = z <= sh.eaves ? sh.r : (sh.r * (sh.top - z)) / (sh.top - sh.eaves);
  return x * x + y * y <= rz * rz;
}
// The air inside a shelter, C, of the air outside it at this temperature in this wind and the heat given off inside it,
// W: its closed roof and walls conduct through their layers, the open share of its roof only through still air's film
// inside and the wind's outside (body.ts hc, and the radiation each film exchanges at the outside air's warmth, body-
// constants sec. 5), until they lose as much as is given off. Air leaking through the layers and the floor's loss are
// left out [gap].
export function insideAir(sh: Shelter, outside: number, wind: number, heat: number) {
  const film = (u: number) => 1 / (hc(u) + 4 * 0.95 * 5.67e-8 * (outside + 273.15) ** 3), skin = film(0) + film(wind);
  const ua = sh.roof * (sh.closed / (skin + sh.rRoof) + (1 - sh.closed) / skin) + sh.wall / (skin + sh.rWall);
  return ua > 0 ? outside + heat / ua : outside;
}

// ---------- a fire's ring and lid (fire-constants sec. 29) ----------
// The mouth of a ring laid this wide round, m2: the circle its stone stands on.
export const mouthOf = (width: number) => width ** 2 / (4 * Math.PI);
// What heaped over a ring's mouth closes of it, m2: a stone as a ball its thickness across, anything plastic spread as a
// layer its thickness deep [design: how the heap lies].
export const lidOf = (x: Phys, plastic: boolean) => (plastic ? x.mass / (x.rho * x.d) : (Math.PI * x.d * x.d) / 4);

// ---------- a pit's cover ----------
// The weight a cover laid over a pit this wide takes before it gives way, N: each piece of wood long enough to span the
// mouth breaks under its share at its middle; whatever lies on them carries nothing. None if nothing spans it.
export function coverHolds(members: Member[], mouth: number) {
  let holds = 0, spans = 0;
  for (const m of members) if (isWood(m.x) && m.len >= mouth) { holds += m.n * pointLoad(m.x, mouth); spans += m.n; }
  return spans ? holds : undefined;
}
// How high an animal of a kind can leap from where it stands, m: the least fence that keeps it in, as the Forestry
// Commission gives them, 1.8 m for red deer and 0.9 m for rabbits (R1102). Wolves and foxes take the deer's [gap: no fence
// height for them was found].
export const LEAP: Record<string, number> = { deer: 1.8, rabbit: 0.9, wolf: 1.8, fox: 1.8 };
// A pit is dug as deep as the trapping pits for elk, reindeer and wolves were, up to about 2 m (time-constants R451).
export const PIT_DEPTH = 2;
