// What anyone pointing at the world gets told: the real fields of a thing, an animal or a person, or the facts of the
// ground at a point. Rows are [label, value]; bars are [label, value, max].
import { THING_MATERIAL, MADE_OF, PROPS, p } from "./materials";
import { DAY, H, TILE_M, Tile, W, ageOf, clock, colorIndex, groundOf, iceAt, level, spriteSeed, stageOf, tileAt, type Agent, type Animal, type Thing, type World } from "./world";
import { thingById } from "./space";
import { shelterName } from "./physics";
import { agentDetail, goalText } from "./sim";
import { campOf } from "./groups";
import { SIZE } from "../terrain/flora";

export type Inspected = {
  id: string; kind: string; name: string; species?: string; px: number; py: number;
  rows: [string, string | number][]; bars: [string, number, number][];
  // For drawing the icon: the same fields the sprite is chosen and varied by.
  seed?: number; size?: number; state?: string; alt?: number; color?: string; colorIndex?: number;
  // Things: what picks the sprite on the map.
  tier?: number; style?: string; item?: string; contained?: boolean; covered?: boolean; caught?: string; n?: number; burning?: number; stage?: number;
};

const r = (v: number, dp = 1) => Math.round(v * 10 ** dp) / 10 ** dp;
const words = (s: string) => s.replaceAll("_", " ");
const nameOf = (w: World, id?: string) => (id ? w.people[id]?.name ?? id : undefined);
const days = (w: World, t: number) => `${r((w.t - t) / DAY)} days ago`;
const PROP_WORDS: Record<string, string> = {
  hard: "hardness", sharp: "sharpness", heavy: "weight", long: "length", flexible: "flexibility", fibrous: "fibre", binding: "binding",
  flammable: "flammability", edible: "nutrition", toxic: "toxicity", plastic: "plasticity", container: "holds things", insulating: "insulation",
  medicinal: "medicine", seed: "seeds", toughness: "toughness", metal: "metal",
};
function material(w: World, id: string | undefined, rows: Inspected["rows"]) {
  const k = id ? w.kinds[id] : undefined;
  if (!k) return;
  rows.push(["made of", k.name]);
  for (const prop of PROPS) if (p(k, prop) > 0) rows.push([PROP_WORDS[prop], r(p(k, prop), 2)]);
  if (k.fuel) rows.push(["burns for", `${k.fuel} ticks`]);
  if (k.shelf) rows.push(["keeps", `${k.shelf} days`]);
}

function thing(w: World, t: Thing): Inspected {
  const rows: Inspected["rows"] = [], bars: Inspected["bars"] = [];
  const kind = t.kind === "item" ? w.kinds[t.item ?? ""]?.name ?? t.item ?? "item" : t.species ? `${words(t.species)} ${t.kind === "tree" || t.kind === "bush" || t.kind === "fallen_log" ? words(t.kind) : ""}`.trim() : words(t.kind);
  const name = t.kind === "structure" ? shelterName(w, t) : t.kind === "grave" ? `grave of ${t.name}` : kind;
  rows.push(["kind", words(t.kind)]);
  if (t.species) rows.push(["species", words(t.species)]);
  rows.push([t.kind === "tree" || t.kind === "bush" || t.kind === "reeds" || t.kind === "sapling" ? "height" : t.kind === "stick" || t.kind === "fallen_log" ? "length" : "width", `${r(t.size, 2)} m`]);
  if (t.hp !== undefined) bars.push(["hp", r(Math.max(0, t.hp)), t.maxHp ?? THING_MATERIAL[t.kind]?.hp ?? r(t.hp)]);
  rows.push(["age", t.born !== undefined ? days(w, t.born) : "older than anyone"]);
  if (t.n !== undefined) rows.push([t.kind === "bush" ? "berries" : "count", t.n]);
  if (t.owner) rows.push(["owner", nameOf(w, t.owner) ?? t.owner]);
  if (t.burning) bars.push(["burning", r(t.burning, 2), 1]);
  if (t.burnedBy) rows.push(["fire started by", nameOf(w, t.burnedBy) ?? t.burnedBy]);
  if (t.stage !== undefined) bars.push(["grown", r(t.stage, 2), 1]);
  if (t.until !== undefined) rows.push([t.kind === "ash" ? "blows away" : "grows back", t.until > w.t ? `in ${r((t.until - w.t) / DAY)} days` : "soon"]);
  if (t.inside) rows.push(["inside", Object.entries(t.inside).map(([k, n]) => `${n} ${w.kinds[k]?.name ?? k}`).join(", ")]);
  if (t.scarred !== undefined) rows.push(["cut into", days(w, t.scarred)]);
  if (t.resin) rows.push(["resin", t.resin]);
  if (t.bark) rows.push(["bark peeled", t.bark]);
  if (t.caught) rows.push(["caught", t.caught]);
  if (t.shelter) {
    rows.push(["style", t.shelter.style]);
    bars.push(["cover", r(t.shelter.cover, 2), 1], ["insulation", r(t.shelter.insul, 2), 1], ["sturdiness", r(t.shelter.sturdy, 2), 1]);
    rows.push(["built from", Object.entries(t.parts ?? {}).map(([k, n]) => `${n} ${w.kinds[k]?.name ?? k}`).join(", ") || "nothing"]);
  }
  if (t.store?.length) {
    const c: Record<string, number> = {};
    for (const s of t.store) c[s.k] = (c[s.k] ?? 0) + 1;
    rows.push(["stores", Object.entries(c).map(([k, n]) => `${n} ${w.kinds[k]?.name ?? k}`).join(", ")]);
  }
  if (t.shared) rows.push(["shared by", w.camps.find((c) => c.id === t.shared)?.name ?? t.shared]);
  if (t.kind === "fire") {
    rows.push(["heat", t.heat ?? 1]);
    if (t.contained) rows.push(["ringed", "yes"]);
    if (t.covered) rows.push(["covered", "yes"]);
    if (t.charcoal) rows.push(["charcoal", r(t.charcoal)]);
    if (t.hp !== undefined) rows.push(["burns for", `${Math.round(t.hp)} more ticks`]);
  }
  if (t.kind === "grave") rows.push(["died", t.died !== undefined ? clock(t.died) : "?"], ["of", t.cause ?? "?"]);
  const mat = THING_MATERIAL[t.kind];
  if (mat) rows.push(["breaks into", Object.entries(mat.breaks).map(([k, n]) => `${n} ${w.kinds[k]?.name ?? k}`).join(", ")]);
  material(w, t.kind === "item" ? t.item : MADE_OF[t.kind], rows);
  rows.push(["tile", `${t.x}, ${t.y}`]);
  return {
    id: t.id, kind: t.kind, name, species: t.species, px: t.px, py: t.py, rows, bars, seed: spriteSeed(t), size: t.size,
    tier: t.shelter?.tier, style: t.shelter?.style, item: t.item, contained: t.contained, covered: t.covered, caught: t.caught, n: t.n, burning: t.burning, stage: t.stage,
  };
}

function animal(w: World, a: Animal): Inspected {
  const rows: Inspected["rows"] = [["species", a.species], ["doing", words(a.state)], ["born", a.born > 0 ? days(w, a.born) : "before anyone came"]];
  if (a.alt > 0.05) rows.push(["height", `${r(a.alt)} m up`]);
  rows.push(["heading", `${Math.round((((a.heading * 180) / Math.PI) % 360 + 360) % 360)} deg`]);
  if (a.target) rows.push(["after", nameOf(w, a.target) ?? w.animals.find((x) => x.id === a.target)?.species ?? thingById(w, a.target)?.kind ?? a.target]);
  if (a.home) rows.push(["keeps to", `${r(a.home[0], 2)}, ${r(a.home[1], 2)}`]);
  const kin = w.animals.filter((x) => x !== a && x.species === a.species && a.home && x.home && x.home[0] === a.home[0] && x.home[1] === a.home[1]).length;
  if (kin) rows.push([a.species === "wolf" ? "pack" : a.species === "deer" ? "herd" : "group", `${kin + 1}`]);
  const mat = THING_MATERIAL[a.species];
  if (mat) rows.push(["toughness", mat.toughness], ["butchers into", Object.entries(mat.breaks).map(([k, n]) => `${n} ${w.kinds[k]?.name ?? k}`).join(", ")]);
  const bars: Inspected["bars"] = [["hp", r(Math.max(0, a.hp)), a.maxHp], ["fed", r(Math.max(0, a.hunger)), 100]];
  return { id: a.id, kind: "animal", name: a.species, species: a.species, px: a.px, py: a.py, rows, bars, seed: spriteSeed(a), state: a.state, alt: a.alt };
}

function person(w: World, a: Agent): Inspected {
  const d = agentDetail(w, a);
  const rows: Inspected["rows"] = [
    ["doing", a.status], ["goal", a.goal ? goalText(w, a.goal.type, a.goal.target) : "none"],
    ["age", `${r(ageOf(w, a))} years, ${stageOf(w, a)}`],
    ["traits", Object.entries(a.traits).map(([t, s]) => `${t} ${Math.round(s * 100)}`).join(", ")],
    ["wants", a.desires.join("; ")],
  ];
  // A skill shows its level once it has one; before that, how much practice has gone into it.
  const skills = Object.entries(a.skills).filter(([, xp]) => xp > 0);
  if (skills.length) rows.push(["skills", skills.map(([s, xp]) => (level(xp) >= 1 ? `${s} ${level(xp)}` : `${s} (${Math.round(xp)} xp)`)).join(", ")]);
  rows.push(["carrying", d.inventoryText.join(", ") || "nothing"]);
  if (d.wearing) rows.push(["wearing", d.wearing]);
  if (d.holding) rows.push(["best weapon", d.holding]);
  const home = thingById(w, a.home);
  if (home) rows.push(["home", `${shelterName(w, home)} (${home.id})`]);
  const camp = campOf(w, a.id);
  if (camp) rows.push(["camp", camp.name]);
  const bonds = Object.entries(a.rel).filter(([, rl]) => rl.label !== "stranger").map(([id, rl]) => `${nameOf(w, id)}: ${rl.label}`);
  if (bonds.length) rows.push(["knows", bonds.join(", ")]);
  if (a.sickness) rows.push(["sick", `until ${clock(a.sickness.until)}`]);
  if (a.pregnant) rows.push(["expecting", `in ${r((a.pregnant.due - w.t) / DAY)} days`]);
  if (a.parents.length) rows.push(["parents", a.parents.map((id) => nameOf(w, id)).join(", ")]);
  if (a.children.length) rows.push(["children", a.children.map((id) => nameOf(w, id)).join(", ")]);
  rows.push(["knows how", `${Object.keys(a.beliefs).length} things`]);
  if (a.down > w.t) rows.push(["unconscious", `for ${a.down - w.t} ticks`]);
  const bars: Inspected["bars"] = (["food", "energy", "warmth", "health", "social"] as const).map((k) => [k, r(a.needs[k]), 100]);
  return { id: a.id, kind: "agent", name: a.name, px: a.px, py: a.py, rows, bars, state: stageOf(w, a), color: a.color, colorIndex: colorIndex(a), seed: spriteSeed(a) };
}

export function inspect(w: World, id: string): Inspected | null {
  const a = w.agents.find((x) => x.id === id);
  if (a) return person(w, a);
  const an = w.animals.find((x) => x.id === id);
  if (an) return animal(w, an);
  const t = thingById(w, id);
  return t ? thing(w, t) : null;
}

const TILES: Record<number, string> = { [Tile.Grass]: "grass", [Tile.Forest]: "forest", [Tile.Water]: "water", [Tile.Rock]: "rock" };
// The ground at a point in tiles, read off the same fields the map is drawn from.
export function inspectGround(w: World, px: number, py: number): Inspected {
  const { isle, fine } = groundOf(w.seed);
  const x = px * TILE_M - SIZE / 2, z = py * TILE_M - SIZE / 2, cx = (px * TILE_M) / 75 - 0.5, cy = (py * TILE_M) / 75 - 0.5;
  const tx = Math.floor(px), ty = Math.floor(py), tile = tileAt(w, tx, ty), onMap = tx >= 0 && ty >= 0 && tx < W && ty < H;
  const height = fine.heightAt(x, z), slope = (Math.atan(fine.slopeAt(x, z)) * 180) / Math.PI;
  const water = fine.bilinear(isle.water, cx, cy), wet = fine.fine(fine.wet, x, z), river = fine.riverAt(x, z);
  const cover = (["tree", "shrub", "grass", "marsh", "bare", "sand"] as const).map((k) => [k, fine.fine(fine.cover[k], x, z)] as const);
  const top = [...cover].sort((a, b) => b[1] - a[1])[0][0];
  const name = wet > 0.5 ? (water > 2 ? "deep water" : "shallow water") : river > 0.3 ? "stream bed" : { tree: "forest floor", shrub: "scrub", grass: "grassland", marsh: "marsh", bare: "bare rock", sand: "sand" }[top];
  const rows: Inspected["rows"] = [
    ["height", `${r(height)} m`], ["slope", `${r(slope)} deg`], ["tile", onMap ? `${TILES[tile]} (${tx}, ${ty})` : "off the map"],
    ["soil", `${r(fine.bilinear(isle.soil, cx, cy), 2)} m deep`], ["peat", r(fine.bilinear(isle.peat, cx, cy), 2)], ["silt", r(fine.bilinear(isle.silt, cx, cy), 2)],
    ["air now", `${r(w.weather.temp - 0.0065 * Math.max(0, height))} C`], ["yearly mean", `${r(fine.bilinear(isle.temp, cx, cy))} C`],
    ["snow share", r(fine.bilinear(isle.snow, cx, cy), 2)], ["exposure", r(fine.bilinear(isle.exposure, cx, cy), 2)],
    ["path wear", `${onMap ? w.paths[ty * W + tx] : 0} / 9`], ["ice", onMap && wet > 0.5 && iceAt(w, tx, ty) ? "frozen" : "no"],
    ["water depth", `${wet > 0.5 ? r(Math.max(0.05, water), 2) : 0} m`],
  ];
  if (river > 0) rows.push(["stream", r(river, 2)]);
  const bars: Inspected["bars"] = [["moisture", r(fine.fine(fine.moist, x, z), 2), 1], ...cover.map(([k, v]) => [k, r(v, 2), 1] as [string, number, number])];
  return { id: `ground:${r(px, 4)},${r(py, 4)}`, kind: "ground", name, px, py, rows, bars };
}
