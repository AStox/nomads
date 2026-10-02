// What anyone pointing at the world gets told: the real fields of a thing, an animal or a person, or the facts of the
// ground at a point, laid out as tabs of titled sections. A section holds rows, a bag of items, or both; a row can name
// an id to go to (link), an icon, a bar, and lines that open under it (more). bars are the vital few shown above the tabs.
import { BASE, THING_MATERIAL, MADE_OF, PROPS, p, type Kind } from "./materials";
import { BONDS, DAY, H, LABELS, QUIET, TILE_M, Tile, W, ageOf, clock, colorIndex, groundOf, iceAt, level, meters, spriteSeed, stageOf, tileAt, type Agent, type Animal, type Thing, type World } from "./world";
import { thingById } from "./space";
import { shelterName } from "./physics";
import { activity, agentDetail, goalText, heading, type Activity } from "./sim";
import { beliefText, conditionWords, groundOfKey, type Belief } from "./beliefs";
import { campOf, knownCustoms, sharedStore, standing } from "./groups";
import { lightAt, lightOn, lightWords, type Light } from "./light";
import { airAt, airWords } from "./air";
import { CELL } from "../terrain/grid";
import { GROUND, LAKE, RIVER, SEA, SIZE, groundClass, rockAt } from "../terrain/flora";
import { fertilityAt } from "./soil";
import { fitHere } from "./plants";
import { NICHE } from "../terrain/niche";
import { streamNow } from "./streams";
import { walked } from "./journeys";
import { TRICKLE } from "../terrain/water";

// A line under an opened row: words, or words that go somewhere when clicked.
export type Line = string | { text: string; link: string };
export type Row = {
  label: string; value?: string | number;
  // icon: "act:<activity>" or "item:<look>"; bar: [value, max, min?] (min below 0 fills from the middle); hot: the one that matters now (the current step)
  link?: string; icon?: string; bar?: [number, number] | [number, number, number]; hot?: boolean; more?: Line[];
};
// One kind of item held or kept: its look picks the icon, n how many.
export type Bag = { k: string; look: string; name: string; n: number; more: Line[] };
export type Section = { tab: string; title?: string; rows?: Row[]; bag?: Bag[]; none?: string };
export type Inspected = {
  id: string; kind: string; name: string; species?: string; px: number; py: number;
  // facts: the few lines beside the portrait; bars: the vital ones over the tabs
  facts: string[]; bars: [string, number, number][]; sections: Section[]; activity?: Activity | null;
  // For drawing the icon: the same fields the sprite is chosen and varied by.
  seed?: number; size?: number; state?: string; alt?: number; color?: string; colorIndex?: number;
  // Things: what picks the sprite on the map.
  tier?: number; style?: string; item?: string; contained?: boolean; covered?: boolean; caught?: string; n?: number; burning?: number; stage?: number;
};

const r = (v: number, dp = 1) => Math.round(v * 10 ** dp) / 10 ** dp;
const words = (s: string) => s.replaceAll("_", " ");
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const nameOf = (w: World, id?: string) => (id ? w.people[id]?.name ?? id : undefined);
const lux = (l: Light) => `${l.lux >= 100 ? Math.round(l.lux).toLocaleString("en-US") : r(l.lux, l.lux < 1 ? 2 : 1)} lux`;
const days = (w: World, t: number) => `${r((w.t - t) / DAY)} days ago`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
// a direction across the map, x east and y south
const compass = (dx: number, dy: number) => ["E", "SE", "S", "SW", "W", "NW", "N", "NE"][(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
// someone alive to go to, else just their name
const who = (w: World, id: string | undefined, text: string): Line => (id && w.agents.some((a) => a.id === id) ? { text, link: id } : text);
const PROP_WORDS: Record<string, string> = {
  hard: "hardness", sharp: "sharpness", heavy: "weight", long: "reach", flexible: "flexibility", fibrous: "fibre", binding: "binding",
  flammable: "flammability", edible: "nutrition", toxic: "toxicity", plastic: "plasticity", container: "holds things", insulating: "insulation",
  medicinal: "medicine", seed: "seeds", toughness: "toughness", metal: "metal",
};

// ---------- items ----------
// What an item looks like, for its icon: its own for a raw material, else the shape its properties give it.
function lookOf(k?: Kind): string {
  if (!k) return "lump";
  if (BASE[k.id]) return k.id;
  // foods by how they were made: smoked, ground to meal, mixed to dough, baked to bread
  if (k.id.startsWith("smoked:")) return "smoked";
  if (k.verb === "rub" && p(k, "edible") > 0) return "meal";
  if (k.verb === "wet" && p(k, "plastic") >= 0.5) return "dough";
  if (k.name === "bread") return "bread";
  const q = (x: Parameters<typeof p>[1]) => p(k, x);
  if (q("metal") >= 0.9) return "metal";
  // a bow: a stiff, springy stave strung with something that binds (a loose cord is only a cord)
  if (q("flexible") >= 0.8 && q("long") >= 0.5 && q("binding") >= 0.5 && q("hard") >= 0.2) return "bow";
  // soft things that hold things: a basket if it's woven, a bag if not; anything stiff that holds is a pot
  if (q("container") >= 0.4 && q("flexible") >= 0.4) return q("fibrous") >= 0.6 ? "basket" : "bag";
  if (q("container") >= 0.4) return "pot";
  if (q("sharp") >= 0.5 && q("long") >= 0.5) return q("heavy") >= 0.4 ? "axe" : "spear";
  if (q("sharp") >= 0.5) return "blade";
  if (q("insulating") >= 0.5 && q("flexible") >= 0.4) return "cloth";
  if (q("binding") >= 0.5 && q("fibrous") >= 0.4) return "cord";
  if (q("edible") >= 0.1) return "food";
  if (q("long") >= 0.5) return q("heavy") >= 0.5 ? "club" : "rod";
  if (q("hard") >= 0.6) return "brick";
  return "lump";
}
function itemLines(w: World, k: Kind | undefined): Line[] {
  if (!k) return [];
  const out: Line[] = [];
  if (k.desc && k.desc !== k.name) out.push(k.desc);
  const props = PROPS.filter((x) => x !== "toughness" && p(k, x) >= 0.1).sort((x, y) => p(k, y) - p(k, x));
  for (const x of props.slice(0, 5)) out.push(`${PROP_WORDS[x]} ${r(p(k, x), 2)}`);
  if (k.parts?.length) out.push(`made from ${k.parts.map((id) => w.kinds[id]?.name ?? words(id)).join(" and ")}`);
  if (k.made) out.push(who(w, k.made.by, `first made by ${nameOf(w, k.made.by)}, ${days(w, k.made.t)}`));
  const uses = Object.entries(k.uses ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 3);
  if (uses.length) out.push(`used for ${uses.map(([u, n]) => `${u} (${n})`).join(", ")}`);
  if (k.shelf) out.push(`keeps ${k.shelf} days`);
  if (k.fuel) out.push(`burns ${k.fuel} ticks`);
  return out;
}
function bag(w: World, ks: Iterable<string>): Bag[] {
  const c = new Map<string, number>();
  for (const k of ks) c.set(k, (c.get(k) ?? 0) + 1);
  return [...c].map(([k, n]) => ({ k, n, look: lookOf(w.kinds[k]), name: w.kinds[k]?.name ?? words(k), more: itemLines(w, w.kinds[k]) }));
}
const bagOf = (w: World, counts: Record<string, number>) => bag(w, Object.entries(counts).flatMap(([k, n]) => Array<string>(n).fill(k)));
const itemRow = (w: World, label: string, k: string): Row => ({ label, value: w.kinds[k]?.name ?? words(k), icon: `item:${lookOf(w.kinds[k])}`, more: itemLines(w, w.kinds[k]) });

function material(w: World, id: string | undefined): Section | null {
  const k = id ? w.kinds[id] : undefined;
  if (!k) return null;
  const rows: Row[] = [{ label: "made of", value: k.name, icon: `item:${lookOf(k)}` }];
  for (const prop of PROPS) if (p(k, prop) > 0) rows.push({ label: PROP_WORDS[prop], bar: [r(p(k, prop), 2), 1] });
  if (k.fuel) rows.push({ label: "burns for", value: `${k.fuel} ticks` });
  if (k.shelf) rows.push({ label: "keeps", value: `${k.shelf} days` });
  return { tab: "material", rows };
}

// ---------- things ----------
function thing(w: World, t: Thing): Inspected {
  const rows: Row[] = [], bars: Inspected["bars"] = [], sections: Section[] = [{ tab: "thing", rows }];
  const kind = t.kind === "item" ? w.kinds[t.item ?? ""]?.name ?? t.item ?? "item" : t.species ? `${words(t.species)} ${t.kind === "tree" || t.kind === "bush" || t.kind === "fallen_log" ? words(t.kind) : ""}`.trim() : words(t.kind);
  const name = t.kind === "structure" ? shelterName(w, t) : t.kind === "grave" ? `grave of ${t.name}` : kind;
  rows.push({ label: t.kind === "tree" || t.kind === "bush" || t.kind === "reeds" || t.kind === "sapling" ? "height" : t.kind === "stick" || t.kind === "fallen_log" ? "length" : "width", value: `${r(t.size, 2)} m` });
  if (t.hp !== undefined) bars.push(["hp", r(Math.max(0, t.hp)), t.maxHp ?? THING_MATERIAL[t.kind]?.hp ?? r(t.hp)]);
  rows.push({ label: "age", value: t.born !== undefined ? days(w, t.born) : "older than anyone" });
  if (t.n !== undefined) rows.push({ label: t.kind === "bush" ? "berries" : "count", value: t.n });
  if (t.owner) rows.push({ label: "owner", value: nameOf(w, t.owner) ?? t.owner, link: w.agents.some((a) => a.id === t.owner) ? t.owner : undefined });
  if (t.burning) bars.push(["burning", r(t.burning, 2), 1]);
  if (t.burnedBy) rows.push({ label: "fire started by", value: nameOf(w, t.burnedBy) ?? t.burnedBy, link: w.agents.some((a) => a.id === t.burnedBy) ? t.burnedBy : undefined });
  if (t.stage !== undefined) bars.push(["grown", r(t.stage, 2), 1]);
  if (t.until !== undefined) rows.push({ label: t.kind === "ash" ? "blows away" : "grows back", value: t.until > w.t ? `in ${r((t.until - w.t) / DAY)} days` : "soon" });
  if (t.scarred !== undefined) rows.push({ label: "cut into", value: days(w, t.scarred) });
  if (t.resin) rows.push({ label: "resin", value: t.resin });
  if (t.bark) rows.push({ label: "bark peeled", value: t.bark });
  if (t.caught) rows.push({ label: "caught", value: t.caught });
  if (t.shared) rows.push({ label: "shared by", value: w.camps.find((c) => c.id === t.shared)?.name ?? t.shared });
  if (t.kind === "fire") {
    rows.push({ label: "heat", value: t.heat ?? 1 });
    if (t.contained) rows.push({ label: "ringed", value: "yes" });
    if (t.covered) rows.push({ label: "covered", value: "yes" });
    if (t.charcoal) rows.push({ label: "charcoal", value: r(t.charcoal) });
    if (t.hp !== undefined) rows.push({ label: "burns for", value: `${Math.round(t.hp)} more ticks` });
  }
  if (t.kind === "sapling") {
    // what it lives on where it stands: the same the sim weighs (ecology.ts seedlings)
    rows.push({ label: "doing", value: (t.hp ?? 5) < (t.maxHp ?? 5) * 0.8 ? "wilting" : "thriving" });
    if (t.fit !== undefined) rows.push({ label: "ground suits it", bar: [r(t.fit, 2), 1] });
    if (t.water) rows.push({ label: "watered", bar: [r(t.water, 2), 1] });
  }
  if (t.kind === "grave") {
    rows.push({ label: "died", value: t.died !== undefined ? clock(t.died) : "?" }, { label: "of", value: t.cause ?? "?" });
    // the path they walked in life is drawn from the grave while it is selected
    const path = t.person ? w.journeys?.of[t.person] : undefined;
    if (path) rows.push({ label: "walked", value: `${r(walked(path) / 1000, 1)} km in life` });
  }
  rows.push({ label: "tile", value: `${t.x}, ${t.y}` });
  if (t.shelter) {
    const living = w.agents.filter((x) => x.home === t.id);
    sections.push({ tab: "thing", title: "shelter", rows: [
      { label: "style", value: t.shelter.style }, { label: "sleeps", value: `${living.length} of ${t.shelter.room ?? 1}` },
      ...living.map((x) => ({ label: "lives here", value: x.name, link: x.id })),
      { label: "cover", bar: [r(t.shelter.cover, 2), 1] }, { label: "insulation", bar: [r(t.shelter.insul, 2), 1] }, { label: "sturdiness", bar: [r(t.shelter.sturdy, 2), 1] },
    ] });
    sections.push({ tab: "thing", title: "built from", bag: bagOf(w, t.parts ?? {}), none: "nothing" });
  }
  if (t.store?.length) sections.push({ tab: "thing", title: "stores", bag: bag(w, t.store.map((s) => s.k)) });
  if (t.inside) sections.push({ tab: "thing", title: "inside", bag: bagOf(w, t.inside) });
  const mat = THING_MATERIAL[t.kind];
  if (mat) sections.push({ tab: "thing", title: "breaks into", bag: bagOf(w, mat.breaks) });
  const m = material(w, t.kind === "item" ? t.item : MADE_OF[t.kind]);
  if (m) sections.push(m);
  return {
    id: t.id, kind: t.kind, name, species: t.species, px: t.px, py: t.py, facts: [words(t.kind), ...(t.species ? [words(t.species)] : [])], bars, sections, seed: spriteSeed(t), size: t.size,
    tier: t.shelter?.tier, style: t.shelter?.style, item: t.item, contained: t.contained, covered: t.covered, caught: t.caught, n: t.n, burning: t.burning, stage: t.stage,
  };
}

// ---------- animals ----------
function animal(w: World, a: Animal): Inspected {
  const rows: Row[] = [{ label: "doing", value: words(a.state) }, { label: "born", value: a.born > 0 ? days(w, a.born) : "before anyone came" }];
  if (a.alt > 0.05) rows.push({ label: "height", value: `${r(a.alt)} m up` });
  rows.push({ label: "heading", value: `${Math.round((((a.heading * 180) / Math.PI) % 360 + 360) % 360)} deg` });
  if (a.target) {
    const prey = w.animals.find((x) => x.id === a.target), t = thingById(w, a.target);
    rows.push({ label: "after", value: nameOf(w, w.agents.some((x) => x.id === a.target) ? a.target : undefined) ?? prey?.species ?? t?.kind ?? a.target, link: w.agents.some((x) => x.id === a.target) || prey || t ? a.target : undefined });
  }
  if (a.home) rows.push({ label: "keeps to", value: `${r(a.home[0], 2)}, ${r(a.home[1], 2)}` });
  const kin = w.animals.filter((x) => x !== a && x.species === a.species && a.home && x.home && x.home[0] === a.home[0] && x.home[1] === a.home[1]);
  const sections: Section[] = [{ tab: "animal", rows }];
  if (kin.length) sections.push({ tab: "animal", title: `${a.species === "wolf" ? "pack" : a.species === "deer" ? "herd" : "group"} of ${kin.length + 1}`, rows: kin.slice(0, 30).map((x) => ({ label: x.species, value: words(x.state), link: x.id })) });
  const mat = THING_MATERIAL[a.species];
  if (mat) sections.push({ tab: "animal", title: "butchers into", rows: [{ label: "toughness", value: mat.toughness }], bag: bagOf(w, mat.breaks) });
  const bars: Inspected["bars"] = [["hp", r(Math.max(0, a.hp)), a.maxHp], ["fed", r(Math.max(0, a.hunger)), 100]];
  return { id: a.id, kind: "animal", name: a.species, species: a.species, px: a.px, py: a.py, facts: [a.species, words(a.state)], bars, sections, seed: spriteSeed(a), state: a.state, alt: a.alt };
}

// ---------- people ----------
// The icon of a belief: what it gives, else what it builds or does.
const BUILDS: Record<string, string> = { fire: "act:fire", fed_fire: "act:fire", hearth: "act:fire", kiln: "act:fire", forge: "act:fire", shelter: "act:build", pile: "act:build", bush: "act:plant", pit: "act:dig", trap: "act:dig", worn: "item:cloth", cured: "item:herb" };
const VERBS: Record<string, string> = { strike: "act:craft", rub: "act:fire", join: "act:craft", heat: "act:fire", wet: "act:collect", shape: "act:craft", place: "act:build", plant: "act:plant", pour: "act:plant", eat: "act:eat", wear: "item:cloth", throw: "act:hunt", dig: "act:dig" };
const HOW: Record<Belief["how"], string> = { discovered: "worked it out themselves", watched: "learned it watching", taught: "was taught it by", seen: "saw it happen" };
function beliefRow(w: World, a: Agent, b: Belief): Row {
  const out = Object.keys(b.out)[0] ?? b.fields.gives[0];
  const more: Line[] = [b.from ? who(w, b.from, `${HOW[b.how]} ${nameOf(w, b.from)}`) : HOW[b.how], `${days(w, b.t)}; tried ${b.tries}, worked ${b.wins}`];
  const uses = Object.entries(b.uses).filter(([, n]) => n > 0);
  if (uses.length) more.push(`uses up ${uses.map(([k, n]) => `${n} ${w.kinds[k]?.name ?? words(k)}`).join(", ")}`);
  if (Object.keys(b.out).length) more.push(`gives ${Object.entries(b.out).map(([k, n]) => `${r(n)} ${w.kinds[k]?.name ?? words(k)}`).join(", ")}`);
  // how it has gone for them in each condition they've done it in: the record a theory of theirs rests on
  const record = Object.entries(b.when ?? {}).filter(([, s]) => s.tries > 0);
  if (record.length) more.push(record.map(([c, s]) => `${conditionWords(c)} ${s.wins} of ${s.tries}`).join(", "));
  const law = b.law ? Object.values(w.laws).find((l) => l.id === b.law) : undefined;
  if (law && law.by !== a.id) more.push(who(w, law.by, `first found by ${nameOf(w, law.by)}`));
  return { label: beliefText(w, b), icon: out ? `item:${lookOf(w.kinds[out])}` : (b.fields.builds && BUILDS[b.fields.builds]) || VERBS[b.fields.verb] || "act:craft", more };
}
function person(w: World, a: Agent): Inspected {
  const d = agentDetail(w, a), act = activity(w, a), camp = campOf(w, a.id), home = thingById(w, a.home);
  // now: what they are at, what for, and the steps to it
  const now: Row[] = [{ label: a.status, icon: act ? `act:${act}` : undefined }];
  if (a.goal) {
    const dec = a.lastDecision?.chosen === a.goal.type ? a.lastDecision : null;
    const odds = dec ? Object.entries(dec.goal).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${pct(v)} ${dec.labels[k] ?? goalText(w, k)}`) : [];
    now.push({ label: "goal", value: goalText(w, a.goal.type, a.goal.target), more: [...(odds.length ? ["what they weighed:", ...odds] : []), `since ${days(w, a.goal.since)}`] });
  } else now.push({ label: "goal", value: a.thinking ? "making up their mind" : "none yet" });
  const to = heading(w, a);
  if (to) now.push({ label: "heading", value: `${Math.round(meters(a, to))} m ${compass(to.px - a.px, to.py - a.py)}` });
  now.push({ label: "light", value: lightWords(lightOn(w, a)), more: [lux(lightOn(w, a))] });
  if (a.sickness) now.push({ label: "sick", value: `until ${clock(a.sickness.until)}` });
  if (a.pregnant) now.push({ label: "expecting", value: `in ${r((a.pregnant.due - w.t) / DAY)} days`, more: [who(w, a.pregnant.father, `father: ${nameOf(w, a.pregnant.father)}`)] });
  if (a.down > w.t) now.push({ label: "out cold", value: `for ${a.down - w.t} ticks` });
  const sections: Section[] = [{ tab: "now", rows: now }];
  if (d.plan.length) sections.push({ tab: "now", title: "plan", rows: d.plan.map((s, i) => ({ label: `${i + 1}. ${s.label}`, hot: i === 0 })) });

  // bag: what they carry, wear and keep
  sections.push({ tab: "bag", title: "carrying", bag: bag(w, a.inv.map((s) => s.k)), none: "nothing" });
  const worn: Row[] = [];
  if (a.wearing) worn.push(itemRow(w, "wearing", a.wearing.k));
  const weapon = d.holding && a.inv.find((s) => w.kinds[s.k]?.name === d.holding);
  if (weapon) worn.push(itemRow(w, "best weapon", weapon.k));
  if (worn.length) sections.push({ tab: "bag", rows: worn });
  if (home) sections.push({ tab: "bag", title: `at home`, bag: bag(w, (home.store ?? []).map((s) => s.k)), none: "nothing kept there" });
  const store = sharedStore(w, a);
  if (store && store !== home) sections.push({ tab: "bag", title: "camp store", bag: bag(w, (store.store ?? []).map((s) => s.k)), none: "empty" });

  // knows: how to do things, what they've seen, what their camp holds to
  const beliefs = Object.values(a.beliefs).sort((x, y) => Number(y.wins > 0) - Number(x.wins > 0) || y.t - x.t);
  sections.push({ tab: "knows", title: `how to (${beliefs.length})`, rows: beliefs.map((b) => beliefRow(w, a, b)), none: "nothing yet" });
  // what they've done that hasn't shown what comes of it yet
  const waiting = a.waiting ?? [];
  if (waiting.length) sections.push({
    tab: "knows", title: `waiting to see (${waiting.length})`,
    rows: waiting.map((e) => {
      const b = a.beliefs[e.key], ground = e.now.find((c) => groundOfKey(c));
      const what = b?.fields.verb === "pour" ? "watered a young plant" : `planted ${w.kinds[b?.fields.inputs[0] ?? ""]?.name ?? "something"}`;
      return { label: `${what}${ground ? ` ${conditionWords(ground)}` : ""}`, value: days(w, e.t), link: e.thing };
    }),
  });
  const seen = Object.values(a.facts);
  if (seen.length) sections.push({ tab: "knows", title: `seen (${seen.length})`, rows: seen.map((f) => ({ label: f })) });
  const customs = knownCustoms(w, a);
  if (customs.length) sections.push({ tab: "knows", title: "customs", rows: customs.map((c) => ({ label: c })) });

  // people: family, camp, home, and everyone they know
  const fam: Row[] = [
    ...a.parents.map((id) => ({ label: "parent", value: `${nameOf(w, id)}${w.people[id]?.alive === false ? " (dead)" : ""}`, link: w.agents.some((x) => x.id === id) ? id : undefined })),
    ...a.children.map((id) => ({ label: "child", value: `${nameOf(w, id)}${w.people[id]?.alive === false ? " (dead)" : ""}`, link: w.agents.some((x) => x.id === id) ? id : undefined })),
  ];
  if (fam.length) sections.push({ tab: "people", title: "family", rows: fam });
  const place: Row[] = [];
  if (home) place.push({ label: "home", value: shelterName(w, home), link: home.id });
  else place.push({ label: "home", value: "none yet" });
  if (camp) {
    const s = standing(camp, a.id);
    place.push({ label: "camp", value: camp.name, more: [`founded ${days(w, camp.founded)}`, `${camp.members.length} people`, ...(s.followed + s.defied ? [`their rulings followed ${s.followed}, defied ${s.defied}`] : [])] });
    if (camp.leader) place.push({ label: "leader", value: nameOf(w, camp.leader) ?? camp.leader, link: camp.leader !== a.id && w.agents.some((x) => x.id === camp.leader) ? camp.leader : undefined });
  }
  for (const o of d.outcast) if (o) place.push({ label: o.how, value: `by ${o.camp}`, more: [`until ${clock(o.until)}`] });
  sections.push({ tab: "people", title: "home and camp", rows: place });
  const rels = Object.entries(a.rel).filter(([, rl]) => rl.label !== "stranger" || rl.history.length).sort((x, y) => Math.abs(y[1].affinity) - Math.abs(x[1].affinity));
  sections.push({
    tab: "people", title: `knows (${rels.length})`, none: "no one yet",
    rows: rels.map(([id, rl]) => ({
      label: nameOf(w, id) ?? id, value: words(rl.label), bar: [r(rl.affinity, 2), 1, -1],
      more: [
        who(w, id, `go to ${nameOf(w, id)}`), LABELS[rl.label], `liking ${r(rl.affinity, 2)}, trust ${r(rl.trust, 2)}`,
        ...[...rl.bonds].sort((x, y) => y.weight - x.weight).slice(0, 3).map((b) => BONDS[b.kind]),
        ...Object.entries(rl.beliefs).map(([k, v]) => (v! > 0.65 ? `thinks they are ${k}` : v! < 0.35 ? `thinks they are not ${k}` : `unsure if they are ${k}`)),
        ...rl.history.slice(-3),
      ],
    })),
  });

  // story: what has happened to them that mattered, newest first
  const story: Row[] = [];
  for (let i = w.events.length - 1; i >= 0 && story.length < 60; i--) {
    const e = w.events[i];
    if (!QUIET[e.kind] && e.who.includes(a.id)) story.push({ label: e.text, more: [clock(e.t), ...e.who.filter((id) => id !== a.id).map((id) => who(w, id, `with ${nameOf(w, id)}`))] });
  }
  sections.push({ tab: "story", rows: story, none: "nothing yet" });

  // self: who they are
  const xpTo = (L: number) => 10 * L * L;
  const path = w.journeys?.of[a.id];
  sections.push({ tab: "self", rows: [{ label: "age", value: `${r(ageOf(w, a))} years, ${stageOf(w, a)}` }, ...(path ? [{ label: "walked", value: `${r(walked(path) / 1000, 1)} km` }] : []), ...(a.bio ? [{ label: a.bio }] : [])] });
  sections.push({ tab: "self", title: "traits", rows: Object.entries(a.traits).sort((x, y) => y[1] - x[1]).map(([t, s]) => ({ label: t, bar: [Math.round(s * 100), 100] as [number, number] })) });
  if (a.desires.length) sections.push({ tab: "self", title: "wants to", rows: a.desires.map((x) => ({ label: x })) });
  const skills = Object.entries(a.skills).filter(([, xp]) => xp > 0).sort((x, y) => y[1] - x[1]);
  if (skills.length) sections.push({ tab: "self", title: "skills", rows: skills.map(([s, xp]) => { const L = level(xp); return { label: `${s} ${L}`, bar: [r(xp - xpTo(L)), xpTo(L + 1) - xpTo(L)] as [number, number] }; }) });

  const bars: Inspected["bars"] = (["food", "energy", "warmth", "health", "social"] as const).map((k) => [k, r(a.needs[k]), 100]);
  const facts = [`${stageOf(w, a)}, ${r(ageOf(w, a))} years`, camp ? `of ${camp.name}` : "no camp", home ? `lives in a ${shelterName(w, home)}` : "no home"];
  return { id: a.id, kind: "agent", name: a.name, px: a.px, py: a.py, facts, bars, sections, activity: act, state: stageOf(w, a), color: a.color, colorIndex: colorIndex(a), seed: spriteSeed(a) };
}

export function inspect(w: World, id: string): Inspected | null {
  const a = w.agents.find((x) => x.id === id);
  if (a) return person(w, a);
  const an = w.animals.find((x) => x.id === id);
  if (an) return animal(w, an);
  const t = thingById(w, id);
  return t ? thing(w, t) : null;
}

// ---------- ground ----------
// A soil's texture in the words a farmer would use, from its shares of sand and clay.
const texture = (sand: number, clay: number) => (sand > 0.7 ? "sand" : clay > 0.4 ? "clay" : sand > 0.45 ? "sandy loam" : clay > 0.27 ? "clay loam" : "loam");
const TILES: Record<number, string> = { [Tile.Grass]: "grass", [Tile.Forest]: "forest", [Tile.Water]: "water", [Tile.Rock]: "rock" };
// The ground at a point in tiles, classed by the same rule the map is drawn with.
export function inspectGround(w: World, px: number, py: number): Inspected {
  const { isle, fine } = groundOf(w.seed);
  const x = px * TILE_M - SIZE / 2, z = py * TILE_M - SIZE / 2, cx = (px * TILE_M) / CELL - 0.5, cy = (py * TILE_M) / CELL - 0.5;
  const tx = Math.floor(px), ty = Math.floor(py), tile = tileAt(w, tx, ty), onMap = tx >= 0 && ty >= 0 && tx < W && ty < H;
  const g = groundClass(isle, fine, x, z), height = fine.heightAt(x, z), slope = (Math.atan(g.slope) * 180) / Math.PI;
  const frozen = onMap && g.water === LAKE && iceAt(w, tx, ty);
  const name = frozen ? "frozen lake" : GROUND[g.cls];
  const lit = lightAt(w, px, py), at = (k: Float32Array) => fine.bilinear(k, cx, cy);
  const land: Row[] = [{ label: "tile", value: onMap ? `${TILES[tile]} (${tx}, ${ty})` : "off the map" }];
  const climate: Row[] = [{ label: "light", value: lightWords(lit), bar: [r(lit.bright, 2), 1], more: [lux(lit)] }];
  if (lit.canopy >= 0.01) climate.push({ label: "under leaves", value: `${pct(lit.canopy)} of the sky hidden` });
  climate.push({ label: "air now", value: airWords(airAt(w, px, py)) });
  const sections: Section[] = [{ tab: "land", rows: land }, { tab: "climate", rows: climate }];
  if (g.water === SEA || g.water === LAKE) {
    const depth = g.water === SEA ? Math.max(0, -height) : at(isle.water);
    land.push({ label: "water depth", value: `${r(Math.max(0.1, depth), 1)} m` }, { label: "surface", value: g.water === SEA ? "sea level" : `${r(height + depth)} m` }, { label: "ice", value: frozen ? "frozen" : "no" });
    if (g.water === SEA) climate.push({ label: "salt spray", bar: [r(at(isle.salt), 2), 1] });
  } else {
    land.push(
      { label: "height", value: `${r(height)} m` }, { label: "slope", value: `${r(slope)} deg` }, { label: "bedrock", value: rockAt(isle, x, z).name },
      { label: "path wear", bar: [onMap ? w.paths[ty * W + tx] : 0, 9] },
    );
    const st = streamNow(w, px, py);
    if (st && (g.water === RIVER || st.d <= st.bed / 2))
      land.push({ label: "stream", value: st.flowing ? `${r(st.width, 1)} m wide` : st.q < TRICKLE ? "a dry bed" : "a shrunken bank", more: [st.flowing ? `${r(st.width, 1)} m wide and ${r(st.depth, 2)} m deep, ${r(st.q, 3)} m3/s` : st.q < TRICKLE ? "it runs in the wetter seasons" : "the bank of a shrunken stream"] });
    sections.push({
      tab: "land", title: "soil", rows: [
        { label: "depth", value: `${r(at(isle.soil), 2)} m` }, { label: "texture", value: texture(at(isle.sandy), at(isle.clayey)) }, { label: "pH", value: r(at(isle.ph), 1) },
        { label: "fertility", bar: [r(fertilityAt(w, px, py), 2), 1], more: [`as it grew ${r(at(isle.fertility), 2)}`] },
        { label: "humus", bar: [r(at(isle.humus), 2), 1] }, { label: "peat", bar: [r(at(isle.peat), 2), 1] }, { label: "silt", bar: [r(at(isle.silt), 2), 1] },
        { label: "moisture", bar: [r(fine.fine(fine.moist, x, z), 2), 1] },
      ],
    });
    climate.push(
      { label: "yearly mean", value: `${r(at(isle.temp))} C`, more: [`summer ${r(at(isle.seasons[1].temp))} C, winter ${r(at(isle.seasons[3].temp))} C`] },
      { label: "sunlight", bar: [r(at(isle.sun), 2), 1], more: [`${pct(at(isle.sun))} of open level ground's`, `${pct(at(isle.sky))} of the sky open`] },
      { label: "wind", value: `${r(at(isle.breeze), 1)} m/s`, more: [`exposure ${r(g.exposure, 2)}`] },
      { label: "snow", value: `${pct(at(isle.snow))} of the fall`, more: [`lies ${pct(at(isle.snowCover))} of the year`] },
      { label: "cold air pools", bar: [r(at(isle.pool), 2), 1] },
    );
    sections.push({ tab: "plants", title: "cover", rows: (["grass", "tree", "shrub", "marsh", "bare", "sand"] as const).map((k, q) => ({ label: k, bar: [r(g.cover[q], 2), 1] as [number, number] })) });
    sections.push({
      tab: "plants", title: "would grow best",
      rows: Object.keys(NICHE).map((n): [string, number] => [n, fitHere(w, n, px, py)]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, f]) => ({ label: words(n), bar: [r(f, 2), 1] as [number, number] })),
    });
  }
  return { id: `ground:${r(px, 4)},${r(py, 4)}`, kind: "ground", name, px, py, facts: [cap(name), onMap ? `tile ${tx}, ${ty}` : "off the map"], bars: [], sections };
}
