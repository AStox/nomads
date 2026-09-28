// The style guide's sprite sheet: every sprite at its in-game size, shown 3x on the meadow, with each animation's
// frames and the whole palette grouped by ramp. `?pal=` re-themes it like the game.
import { P, RGB, THEME, ramp } from "./pal.js";
import { Buf, Spr, blit, castShadow, dith, h2 } from "./px.js";
import * as SP from "./sprites.js";
import * as LF from "./life.js";
import { text } from "./ui.js";
import * as TH from "./things.js";
import { drawInspector } from "./inspect.js";

const K = 3, FW = 440, M = 6, GAP = 3;
// the game's sun, so shadows fall the same way
const SUN = { dawn: 0.42, dusk: 0.33 }[THEME] ?? 0.9, cot = 1 / Math.tan(SUN), SDU = 0.958 / 1.0002, SDV = -0.287 / 1.0002;
const SHX = (SDU - SDV) * 0.8165 * cot, SHY = (SDU + SDV) * 0.5 * 0.8165 * cot;
const cw6 = (s) => [...s].reduce((a, ch) => a + (ch === " " ? 4 : 6), 0); // label width in 2x pixels

const cell = (name, sub, sprs, opt = {}) => ({ name, sub, items: (Array.isArray(sprs) ? sprs : [sprs]).map((s) => (s.spr ? s : { spr: s })), ground: opt.ground || "grass", shadow: opt.shadow ?? true });
const range = (n, f) => Array.from({ length: n }, (_, k) => f(k));

function sections() {
  const RPp = [P.p1, P.p3, P.p4], RPb = [P.t2, P.g3, P.g4], people = [];
  for (const [hp, tag] of [[8, "TINY"], [12, "SMALL"], [20, "BIG"], [28, "BIG"]]) {
    people.push(cell(`${tag} ${hp}`, "FRONT SIDE BACK", ["front", "side", "back"].map((f, k) => SP.person(hp, P["c" + k], f, "stand", k * 7 + 1, 1))));
    people.push(cell(`${tag} ${hp} SIT`, "FRONT SIDE", [SP.person(hp, P.c3, "front", "sit", 22, 0), SP.person(hp, P.c4, "side", "sit", 29, 1)]));
  }
  return [
    ["TREES  VALLEY SCALE", [
      cell("PINE", "12 20 28", [12, 20, 28].map((h) => SP.pine(h, h * 3))),
      cell("PINE SNOW", "24", SP.pine(24, 5, true)),
      cell("OAK", "16 26", [16, 26].map((h) => SP.broad(h, "oak", h * 5, 0.5))),
      cell("ASH", "22", SP.broad(22, "ash", 7, 0.5)),
      cell("ASPEN", "20 GOLD", [SP.broad(20, "aspen", 11, 0.4), SP.broad(20, "aspen", 12, 0.9)]),
      cell("EDGE  DEEP", "DIM -1 1", [SP.pine(22, 6, false, -1), SP.pine(22, 6, false, 1), SP.broad(22, "oak", 6, 0.5, -1), SP.broad(22, "oak", 6, 0.5, 1)]),
      cell("MINI", "ISLAND", [SP.mini("pine", RPp), SP.mini("pine2", RPp), SP.mini("pineS", RPp), SP.mini("broad", RPb), SP.mini("broad2", RPb), SP.mini("broadS", RPb), SP.miniRock(1, 0), SP.miniRock(0, 1), SP.miniTent(1), SP.miniTent(2)]),
    ]],
    ["LANDMARKS", [
      cell("GIANT OAK", "60  BY OAK 24", [LF.giant(60, "oak", 1), SP.broad(24, "oak", 3, 0.5)]),
      cell("GIANT PINE", "70  BY PINE 26", [LF.giant(70, "pine", 1), SP.pine(26, 4)]),
      cell("GIANT OAK", "44 SEED 2", LF.giant(44, "oak", 2)),
      cell("GIANT PINE", "50 SEED 4", LF.giant(50, "pine", 4)),
      cell("SEASTACK", "24 36 48 SAND 40", [LF.seastack(24, 0), LF.seastack(36, 4), LF.seastack(48, 1), LF.seastack(40, 2)], { ground: "water", shadow: false }),
      cell("CAIRN", "4 5 6 10 16", [LF.cairn(4, 0), LF.cairn(5, 0), LF.cairn(6, 2), LF.cairn(10, 1), LF.cairn(16, 3)]),
    ]],
    ["TREES  CAMP SCALE", [
      cell("PINE", "64", SP.pine(64, 9)),
      cell("OAK", "70", SP.broad(70, "oak", 8, 0.5)),
      cell("ASH", "60", SP.broad(60, "ash", 8, 0.5)),
      cell("ASPEN", "56 GOLD", [SP.broad(56, "aspen", 8, 0.45), SP.broad(56, "aspen", 9, 0.9)]),
    ]],
    ["WILDLIFE", [
      cell("DEER 10", "STAND GRAZE RUN FAWN", [["stand", 0], ["graze", 1], ["run", 6], ["fawn", 3]].map(([p, s]) => LF.deer(10, p, 1, s))),
      cell("DEER 14", "BUCK DOE RUN FAWN", [["stand", 5], ["graze", 2], ["run", 7], ["fawn", 4]].map(([p, s]) => LF.deer(14, p, 0, s))),
      cell("DEER 5 4 3", "VALLEY", [5, 4, 3].flatMap((h) => ["stand", "graze", "run", "fawn"].map((p, k) => LF.deer(h, p, 1, k)))),
      cell("RABBIT", "3 4 5 7 SIT HOP", [3, 4, 5, 7].flatMap((h) => [LF.rabbit(h, "sit", h), LF.rabbit(h, "hop", h + 1)])),
      cell("HERON", "6 10 STAND FISH", [6, 10].flatMap((h) => [LF.heron(h, "stand", 0), LF.heron(h, "fish", 11)]), { ground: "water" }),
      cell("EGRET", "7 12 STAND FISH", [LF.heron(7, "stand", 9), LF.heron(7, "fish", 8), LF.heron(12, "stand", 9), LF.heron(12, "fish", 8)], { ground: "water" }),
      cell("BIRDS", "GULL CROW EAGLE", [LF.bird(5, 0, "gull"), LF.bird(9, 3, "gull"), LF.bird(5, 0, "crow"), LF.bird(8, 2, "crow"), LF.bird(10, 1, "eagle"), LF.bird(15, 3, "eagle", 3)], { shadow: false }),
      cell("FISH", "LEAP 5 7", [LF.fish(1, 1), LF.fish(1, 2, 7)], { ground: "water", shadow: false }),
      cell("BUTTERFLY", "5 KINDS", [2, 3, 1, 0, 0].map((s, k) => LF.butterfly(k & 3, s)), { shadow: false }),
    ]],
    ["CAMP AND SHORE", [
      cell("CANOE 14", "DIR 0 1 2 3", range(4, (d) => LF.canoe(14, d, [2, 1, 0, 2][d])), { ground: "sand", shadow: false }),
      cell("CANOE 24", "DIR 0 3", [LF.canoe(24, 0, 1), LF.canoe(24, 3, 2)], { ground: "sand", shadow: false }),
      cell("MUSHROOMS", "AGARIC BOLETE CHANTERELLE INKCAP", [[3, 2], [4, 3], [3, 1], [4, 0], [5, 2]].map(([s, k]) => LF.mushrooms(s, k))),
      cell("STUMP", "3 5", [SP.stump(3, 3, 3), SP.stump(5, 4, 5)]),
      cell("LOG", "DIR 1 -1 DRIFT", [SP.log(12, 2, 1, 12), SP.log(12, 2, -1, 13), SP.log(10, 1.5, 1, 10, true)]),
      cell("WOODPILE", "2", SP.woodpile(2, 3)),
      cell("FLAMES", "8 14", [SP.flames(8, 5), SP.flames(14, 5)], { shadow: false }),
      ...(SP.rod ? [cell("FISHING ROD", "10 LEFT RIGHT", [SP.rod(10, -1), SP.rod(10, 1)], { ground: "water", shadow: false })] : []),
    ]],
    ["UNDERSTORY", [
      cell("BUSH", "3 5 8", [3, 5, 8].map((s) => SP.bush(s, s * 13, 0, 0))),
      cell("BUSH", "HEATH BERRY", [SP.bush(5, 4, 1, 0), SP.bush(6, 6, 0, 0.95)]),
      cell("ROCK", "3 5 8 MOSS", [SP.rock(2.8, 1), SP.rock(4.5, 2), SP.rock(8, 3), SP.rock(8, 4, 0.8)]),
      cell("TUFT", "3 5 DRY", [SP.tuft(3, 1), SP.tuft(5, 2), SP.tuft(4, 3, 0.9)], { shadow: false }),
      cell("FLOWER", "HUES 4 2", [...range(6, (k) => SP.flower(4, k / 6 + 0.01, k)), SP.flower(2, 0.2, 1), SP.flower(2, 0.7, 2)], { shadow: false }),
      cell("REEDS", "4 8", [SP.reeds(4, 1), SP.reeds(8, 2)], { shadow: false }),
      cell("PEBBLE", "1 2", [SP.pebble(1, 1), SP.pebble(2, 2)], { shadow: false }),
      cell("FERN", "4 7", [SP.fern(4, 1), SP.fern(7, 2)], { shadow: false }),
    ]],
    ["PEOPLE", people],
    ...simSections(),
    ...ladderSections(),
    ["INSPECTOR  SHOWN 3X HERE  2X IN GAME", inspectorCells()],
    ["ANIMATION FRAMES 0 1 2 3", [
      cell("GULL", "7", range(4, (f) => LF.bird(7, f, "gull")), { shadow: false }),
      cell("CROW", "6", range(4, (f) => LF.bird(6, f, "crow")), { shadow: false }),
      cell("EAGLE", "12", range(4, (f) => LF.bird(12, f, "eagle", 2)), { shadow: false }),
      cell("FISH", "SEED 1 2", range(8, (f) => LF.fish(f & 3, f < 4 ? 1 : 2)), { ground: "water", shadow: false }),
      cell("BUTTERFLY", "SEED 1 4", range(8, (f) => LF.butterfly(f & 3, f < 4 ? 1 : 4)), { shadow: false }),
      cell("FLAMES", "SEED 1-4", range(4, (f) => SP.flames(10, f + 1)), { shadow: false }),
    ]],
  ];
}

// Every sim object and animal through things.js object() and animal(), from a 1 px dot to close zoom.
const LADDER = [1, 2, 3, 4, 6, 9, 13, 18];
const OBJECTS = [["tree", "oak", 1.6], ["tree", "pine", 1.6], ["tree", "ash", 1.6], ["tree", "aspen", 1.6], ["bush", "berry", 0.6], ["bush", "hazel", 0.6], ["bush", "heather", 0.6], ["bush", "gorse", 0.6],
  ["boulder", "", 1], ["stone", "", 0.4], ["pebble", "", 0.3], ["stick", "", 1.2], ["fallen_log", "oak", 2.4], ["fallen_log", "pine", 2.4], ["fallen_log", "ash", 2.4],
  ["mushroom", "bolete", 0.4], ["mushroom", "chanterelle", 0.4], ["mushroom", "puffball", 0.4], ["herb", "yarrow", 0.45], ["herb", "sorrel", 0.45], ["herb", "mint", 0.45],
  ["reeds", "", 0.6], ["grass", "", 1.8], ["fern", "bracken", 0.5], ["fern", "lady_fern", 0.5], ["flowers", "buttercup", 0.45], ["flowers", "daisy", 0.45], ["flowers", "clover", 0.45],
  ["flowers", "harebell", 0.45], ["flowers", "poppy", 0.45], ["sapling", "", 0.6], ["stump", "", 0.4], ["dead_bush", "", 0.5], ["clay", "", 0.5],
  ["item", "stone", 0.4], ["item", "meat", 0.4], ["item", "stick", 0.4], ["item", "hide", 0.4], ["structure", "reeds", 1.6]];
const FIRES = [["OPEN", {}], ["RING", { contained: true }], ["RING COLD", { contained: true, burning: 0 }], ["KILN", { covered: true }], ["FORGE", { charcoal: true }]];
const ANIMALS = [["deer", "graze"], ["deer", "flee"], ["wolf", "wander"], ["wolf", "hunt"], ["rabbit", "wander"], ["heron", "feed"], ["heron", "wade"], ["heron", "fly"],
  ["gull", "fly"], ["gull", "soar"], ["gull", "perch"], ["crow", "fly"], ["crow", "land"], ["eagle", "soar"], ["eagle", "dive"], ["fish", "swim"], ["fish", "jump"],
  ["butterfly", "flutter"], ["butterfly", "rest"]];
function ladderSections() {
  const sub = LADDER.join(" ");
  return [
    ["SIM OBJECTS  EVERY SIZE  THINGS OBJECT()", OBJECTS.map(([k, sp, f], i) => cell(`${k.replace("_", " ").toUpperCase()}${sp ? " " + sp.toUpperCase() : ""}`, "", LADDER.map((h) => TH.object(k, h * f, i + 3, { species: sp })), { ground: k === "reeds" ? "sand" : "grass" }))],
    ["SIM FIRES AND BURNING", [
      ...FIRES.map(([n, o], i) => cell(`FIRE ${n}`, "", [6, 10, 16].map((h, j) => TH.object("fire", h, i + j, o)), { shadow: false })),
      cell("BURNING", "TREE BUSH STRUCTURE", [TH.object("tree", 26, 2, { species: "oak", burning: 0.8 }), TH.object("bush", 8, 3, { burning: 1 }), TH.object("structure", 22, 4, { tier: 2, species: "logs", burning: 0.6 })], { shadow: false }),
    ]],
    ["SIM ANIMALS  EVERY SIZE  THINGS ANIMAL()", ANIMALS.map(([sp, st], i) => cell(`${sp.toUpperCase()} ${st.toUpperCase()}`, `PX ${sub}`, LADDER.map((h, j) => TH.animal(sp, st, h, j, i + 2, 1)), { shadow: !/fly|swim|jump|soar|dive|flutter/.test(st), ground: sp === "fish" || (sp === "heron" && st !== "fly") ? "water" : "grass" }))],
  ];
}

// Inspector panels for sample selections shaped like sim.inspect and sim.inspectGround return them.
const SAMPLES = [
  { id: "t48211", kind: "tree", name: "Oak", species: "oak", seed: 3, px: 31.42, py: 18.07,
    bars: [["HP", 184, 220]],
    rows: [["Height", "14.2 m"], ["Trunk", "0.62 m"], ["Age", "86 years"], ["Material", ""], ["Hardness", 0.62], ["Flammability", 0.45], ["Weight", "2.1 t"], ["Yields", "logs 6, sticks 14, bark 3"], ["Burning", "no"]] },
  { id: "t51077", kind: "boulder", name: "Boulder", species: "granite", seed: 2, px: 40.9, py: 12.33,
    bars: [["HP", 900, 900]],
    rows: [["Size", "2.4 m"], ["Weight", "19 t"], ["Material", ""], ["Hardness", 0.92], ["Sharpness", 0.1], ["Heavy", 1], ["Moss", "north side"]] },
  { id: "t60312", kind: "stone", name: "Stone", species: "flint", seed: 5, px: 29.71, py: 20.55,
    bars: [["HP", 40, 40]],
    rows: [["Size", "0.18 m"], ["Weight", "2.3 kg"], ["Hardness", 0.85], ["Sharpness", 0.35], ["Knaps to", "flint blade"], ["Owner", "none"]] },
  { id: "t33920", kind: "bush", name: "Blackberry bush", species: "berry", seed: 6, berries: 12, px: 30.12, py: 19.9,
    bars: [["HP", 30, 45], ["Berries", 12, 20]],
    rows: [["Size", "1.1 m"], ["Stage", "fruiting"], ["Nutrition", 0.35], ["Regrows", "in 3 days"], ["Flammability", 0.6], ["Thorny", "yes"]] },
  { id: "a912", kind: "animal", name: "Gull", species: "gull", seed: 4, px: 12.5, py: 44.1,
    bars: [["HP", 6, 8]],
    rows: [["State", "fly"], ["Altitude", "22 m"], ["Heading", "north east"], ["Speed", "14 m per tick"], ["Flock", "gulls of the west cove, 7"], ["Feeds on", "fish, scraps"]] },
  { id: "a14", kind: "animal", name: "Deer", species: "deer", seed: 5, px: 33.02, py: 21.77,
    bars: [["HP", 38, 60]],
    rows: [["State", "graze"], ["Herd", "herd 2, 4 deer"], ["Age", "3 years"], ["Sex", "stag"], ["Heading", "west"], ["Wary of", "wolves, people"], ["Last fled", "at 06:40"]] },
  { id: "mara", kind: "agent", name: "Mara", seed: 8, cloth: 1, px: 31.1, py: 18.6,
    bars: [["Health", 82, 100], ["Food", 41, 100], ["Energy", 67, 100], ["Warmth", 88, 100], ["Social", 23, 100]],
    rows: [["Status", "gathering sticks"], ["Goal", "build a lean-to before night"], ["Stage", "adult"], ["Age", "27.4 years"], ["Home", "lean-to t70411"],
      ["Traits", ""], ["Curious", 0.8], ["Patient", 0.35], ["Brave", 0.6], ["Kind", 0.72],
      ["Skills", ""], ["Foraging", 0.44], ["Building", 0.21], ["Fire making", 0.52], ["Knapping", 0.1], ["Hunting", 0.05],
      ["Inventory", ""], ["Sticks", 4], ["Berries", 7], ["Flint blade", 1], ["Hide", 1],
      ["Bonds", ""], ["Tomas", "friend +0.62"], ["Ilse", "wary -0.18"], ["Oren", "kin, brother +0.8"],
      ["Wearing", "hide wrap"], ["Holding", "flint blade"], ["Knows", "fire, knapping, lean-to"]] },
  { id: "t70411", kind: "structure", name: "Lean-to", seed: 3, tier: 1, style: "logs", px: 31.3, py: 18.9,
    bars: [["HP", 55, 80], ["Cover", 60, 100]],
    rows: [["Tier", "1, lean-to"], ["Style", "logs"], ["Owner", "Mara"], ["Insulation", 0.3], ["Sturdiness", 0.55], ["Flammability", 0.5], ["Store", "sticks 6, berries 12"], ["Built", "day 3, 09:15"]] },
  { id: "ground", kind: "ground", name: "Meadow", px: 31.64, py: 18.25,
    rows: [["Height", "142 m"], ["Slope", "6 degrees"], ["Tile", "grass"], ["Soil", "loam, deep"], ["Moisture", 0.46], ["Cover", ""], ["Grass", "72%"], ["Shrub", "11%"], ["Trees", "4%"], ["Bare", "13%"], ["Temperature", "14 °C"], ["Snow", "none"], ["Path wear", "3 of 9"], ["Ice", "no"], ["Water depth", "0 m"]] },
];
function inspectorCells() {
  const toSpr = (B) => { const S = new Spr(B.w, B.h, B.w >> 1, B.h - 1); S.p.set(B.c); return S; };
  const cells = SAMPLES.map((d) => cell(String(d.kind).toUpperCase(), d.name.toUpperCase(), toSpr(drawInspector(d, { w: 168, h: 220 })), { shadow: false }));
  const person = SAMPLES.find((d) => d.kind === "agent"), mid = drawInspector(person, { w: 168, h: 220, scroll: 1e9 });
  cells.splice(7, 0, cell("AGENT", "SCROLLED TO THE END", toSpr(mid), { shadow: false }));
  return cells;
}

// The live game's things at the valley zoom (a person 8 px, a hut 16) and the close zoom (2.5 times that).
const STYLES = ["sticks", "reeds", "logs", "planks", "stone", "brick", "hide", "clay"];
const POSES = ["stand", "walk", "run", "eat", "rest"];
const CARRY = ["none", "wood", "stone", "food"];
function simSections() {
  const out = [];
  for (const [zoom, k] of [["VALLEY", 1], ["CLOSE", 2.5]]) {
    const hut = 16 * k, man = 8 * k, wolf = zoom === "VALLEY" ? 4 : 10, g = (v) => Math.round(v * k);
    out.push([`SIM SHELTERS  ${zoom}  TIER 0 1 2 3`, STYLES.map((s, i) => cell(s.toUpperCase(), `HUT ${hut}`, range(4, (t) => TH.shelter(t, s, hut, i + 1, t === 2 ? P["c" + (i % 5)] : -1))))]);
    out.push([`SIM SHELTERS  ${zoom}  DIR 0-7`, [
      ...[0, 4].map((d0) => cell("LOGS TIER 2", `DIR ${d0} TO ${d0 + 3}`, range(4, (d) => TH.shelter(2, "logs", hut, 3, P.c1, d0 + d)))),
      ...[0, 4].map((d0) => cell("PLANKS TIER 3", `DIR ${d0} TO ${d0 + 3}`, range(4, (d) => TH.shelter(3, "planks", hut, 4, -1, d0 + d)))),
    ]]);
    out.push([`SIM WOLVES AND PEOPLE  ${zoom}`, [
      ...POSES.map((p) => cell(`WOLF ${p.toUpperCase()}`, `${wolf}  FRAMES 0-3`, range(4, (f) => TH.wolf(wolf, p, f, 1)))),
      cell("WOLF COATS", "BY DEER", [...range(4, (s) => TH.wolf(wolf, "stand", 0, s)), LF.deer(zoom === "VALLEY" ? 4 : 12, "stand", 1, 1)]),
      ...["front", "side", "back"].map((f) => cell(`WALK ${f.toUpperCase()}`, `${man}  FRAMES 0-3`, [...range(4, (fr) => TH.walker(man, P.c0, f, fr, "none", "adult", 7)), SP.person(man, P.c0, f, "stand", 7, 1)])),
      ...["child", "adult", "elder"].map((st, i) => cell(`${st.toUpperCase()} CARRY`, "NONE WOOD STONE FOOD", CARRY.map((c, j) => TH.walker(man, P["c" + ((i + j) % 5)], j & 1 ? "side" : "front", j, c, st, i * 11 + j * 3 + 2)))),
      cell("CHILD ELDER WALK", "SIDE 0-3", [...range(4, (fr) => TH.walker(man, P.c3, "side", fr, "none", "child", 4)), ...range(4, (fr) => TH.walker(man, P.c4, "side", fr, "none", "elder", 9))]),
      cell("LYING", "ASLEEP OR DOWN", [TH.lying(man, P.c1, 3), TH.lying(man, P.c2, 8)]),
      cell("ICONS", "THINK SLEEP SICK FIGHT", ["think", "sleep", "sick", "fight"].map((n) => TH.icon(n)), { shadow: false }),
    ]]);
    out.push([`SIM GROUND THINGS  ${zoom}`, [
      cell("FIRE RING", "UNLIT LIT", [TH.firering(g(3), 1), TH.firering(g(3), 2)].map((s, i) => (i ? withFlames(s, g(5)) : s)), { shadow: false }),
      cell("ASH BURNT", "", [TH.ash(g(3), 1), TH.burnt(g(5), 1), TH.burnt(g(6), 2)], { shadow: false }),
      cell("PIT", "DIGGING DUG", [TH.pit(g(3), 0.3, 1), TH.pit(g(3), 1, 2)], { shadow: false }),
      cell("TRAP", "SET SPRUNG OWNED", [TH.trap(g(6), false, 1), TH.trap(g(6), true, 2), TH.trap(g(6), false, 3, P.c2)], { shadow: false }),
      cell("WELL GRAVE", "", [TH.well(g(7), 1), TH.grave(g(6), 1), TH.grave(g(6), 2)]),
      cell("PILE", "WOOD STONE FOOD HIDE MISC", ["wood", "stone", "food", "hide", "misc"].map((w, i) => TH.pile(g(5), w, i))),
      cell("SAPLING HERB", "", [TH.sapling(g(4), 1), TH.sapling(g(7), 2), TH.herb(g(3), 1), TH.herb(g(3), 3)], { shadow: false }),
      cell("CLAY DEADBUSH STICK", "", [TH.clay(g(3), 1), TH.deadbush(g(4), 1), TH.deadbush(g(5), 2), TH.stick(g(4), 1), TH.stick(g(4), 3)], { shadow: false }),
      cell("REUSED", "TREE STUMP BUSH ROCK REEDS MUSHROOM", [SP.pine(g(12), 3), SP.broad(g(10), "oak", 2, 0.5), SP.stump(g(2), g(2), 1), SP.bush(g(3), 2), SP.rock(g(2.4), 1), SP.rock(g(5), 2), SP.reeds(g(4), 1), LF.mushrooms(g(2), 2)]),
    ]]);
  }
  return out;
}
// A lit fire ring: the unlit ring with flames stood in its middle.
function withFlames(ring, h) {
  const F = SP.flames(h, 5), S = new Spr(Math.max(ring.w, F.w), ring.h + F.h, 0, 0);
  S.ax = S.w >> 1; S.ay = ring.ay + F.h;
  const put = (T, x, y) => { for (let j = 0; j < T.h; j++) for (let i = 0; i < T.w; i++) { const c = T.p[j * T.w + i]; if (c !== 255) S.set(x - T.ax + i, y - T.ay + j, c); } };
  put(ring, S.ax, S.ay);
  put(F, S.ax, S.ay - ring.foot);
  return S;
}

// Flow each section's cells into rows; every row shares a ground line, labels sit under it.
function layout(secs, y) {
  const out = [];
  for (const [title, cells] of secs) {
    out.push({ title, y });
    y += 14;
    let row = [];
    const flush = () => {
      if (!row.length) return;
      const up = Math.max(...row.map((c) => c.up)), down = Math.max(...row.map((c) => c.down));
      const base = y + up + 4;
      let x = M;
      for (const c of row) { c.x = x; c.base = base; c.rd = down; x += c.w; }
      const h = up + down + 4 + 18;
      for (const c of row) c.h = h;
      out.push({ row, y, h });
      y += h;
      row = [];
    };
    let x = M;
    for (const c of cells) {
      c.sw = c.items.reduce((a, it) => a + it.spr.w, 0) + GAP * (c.items.length - 1);
      c.w = Math.max(c.sw, Math.ceil((Math.max(cw6(c.name), cw6(c.sub || "")) * 2) / 3)) + 10;
      c.up = Math.max(...c.items.map((it) => it.spr.ay + 1));
      c.down = Math.max(...c.items.map((it) => (c.ground === "grass" ? 0 : Math.ceil((it.spr.w / 2 + 3) / 2) + 1)), ...c.items.map((it) => it.spr.h - it.spr.ay - 1));
      if (x + c.w > FW - M && row.length) { flush(); x = M; }
      row.push(c);
      x += c.w;
    }
    flush();
  }
  return { out, y };
}

function grass(B, x0, y0, x1, y1) {
  const r = ramp("g2", "g3", "g4");
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) B.c[y * B.w + x] = dith(r, 1.3 + (h2(x >> 3, y >> 3, 1) - 0.5) * 0.5 + (h2(x, y, 2) - 0.5) * 0.7, x, y);
}
function fill(B, x0, y0, x1, y1, c) {
  for (let y = Math.max(0, y0); y < Math.min(B.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(B.w, x1); x++) B.c[y * B.w + x] = c;
}
// An isometric patch of water or sand under a cell, so shore sprites sit on their own ground.
function patch(B, cx, cy, hw, kind) {
  const r = kind === "water" ? ramp("w3", "w4", "w5") : ramp("s0", "s1", "s2");
  const hh = hw / 2;
  for (let y = Math.floor(cy - hh); y <= Math.ceil(cy + hh); y++)
    for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw); x++) {
      const d = Math.abs(x + 0.5 - cx) / hw + Math.abs(y + 0.5 - cy) / hh;
      if (d > 1 || x < 0 || y < 0 || x >= B.w || y >= B.h) continue;
      let c = dith(r, 1.2 + (h2(x >> 2, y, 4) - 0.5) * 0.9 + (h2(x, y, 5) - 0.5) * 0.5, x, y);
      if (kind === "water" && h2(x, y, 6) < 0.015) c = P.w6;
      if (d > 0.93) c = kind === "water" ? P.w6 : P.s3;
      B.c[y * B.w + x] = c;
    }
}

function labels(L, s, x, y, c = P.s3) { text(L, s, x + 1, y + 1, P.ink); return text(L, s, x, y, c); }

function draw() {
  const secs = sections(), top = 22;
  const { out, y: yEnd } = layout(secs, top);
  // the palette chart: one block per ramp family
  const fam = new Map();
  for (const [name, i] of Object.entries(P).sort((a, b) => a[1] - b[1])) {
    const m = /^([a-z]+?)(\d+)$/.exec(name), key = m && name !== "haze2" ? m[1] : "accents";
    if (!fam.has(key)) fam.set(key, []);
    fam.get(key).push([name, i]);
  }
  const NAMES = { g: "GRASS", t: "CANOPY", p: "PINE", a: "GOLD", d: "EARTH BARK", r: "ROCK", s: "SAND", w: "WATER", m: "MOSS HEATH", k: "SKIN", f: "FIRE", c: "CLOTH", accents: "ACCENTS" };
  const SW = 26, blocks = [];
  let px = M, py = yEnd + 16, rowH = 0;
  for (const [key, list] of fam) {
    const w = list.length * (SW + 2) + 4;
    if (px + w > FW - M) { px = M; py += rowH; rowH = 0; }
    blocks.push({ key, list, x: px, y: py });
    px += w + 6;
    rowH = 40;
  }
  const FH = py + rowH + 6;
  const B = new Buf(FW, FH), L = new Buf(FW * 1.5, Math.ceil(FH * 1.5));
  L.c.fill(255);
  grass(B, 0, 0, FW, FH);
  fill(B, 0, 0, FW, top - 4, P.ink);
  const ly = (y) => Math.round(y * 1.5), lx = (x) => Math.round(x * 1.5);
  labels(L, "NOMADS  ISOPIXEL SPRITE SHEET", lx(M), 8);
  const right = `PALETTE ${THEME}   SHOWN 3X`;
  labels(L, right, L.w - cw6(right) - lx(M), 8, P.a3);
  let id = 1;
  for (const o of out) {
    if (o.title) {
      fill(B, 0, o.y, FW, o.y + 11, P.t1);
      fill(B, 0, o.y + 11, FW, o.y + 12, P.ink);
      labels(L, o.title, lx(M), ly(o.y) + 4);
      continue;
    }
    for (const c of o.row) {
      // frame each cell like a tile on the grid
      fill(B, c.x + c.w - 1, o.y, c.x + c.w, o.y + o.h, P.g2);
      const x0 = c.x + Math.round((c.w - c.sw) / 2);
      let x = x0;
      const at = c.items.map((it) => { const p = x + it.spr.ax; x += it.spr.w + GAP; return p; });
      if (c.ground !== "grass") c.items.forEach((it, k) => patch(B, at[k] + 0.5, c.base + 0.5, it.spr.w / 2 + 3, c.ground));
      if (c.shadow) c.items.forEach((it, k) => castShadow(B, it.spr, at[k], c.base, SHX, SHY));
      c.items.forEach((it, k) => blit(B, it.spr, at[k], c.base, 0, id++));
      labels(L, c.name, lx(c.x + 4), ly(c.base + c.rd + 4));
      if (c.sub) labels(L, c.sub, lx(c.x + 4), ly(c.base + c.rd + 4) + 9, P.s1);
    }
    fill(B, 0, o.y + o.h - 1, FW, o.y + o.h, P.g2);
  }
  // palette
  fill(B, 0, yEnd + 2, FW, FH, P.ink);
  labels(L, "PALETTE  EVERY NAMED COLOR BY RAMP", lx(M), ly(yEnd + 4));
  for (const b of blocks) {
    labels(L, NAMES[b.key] || b.key.toUpperCase(), lx(b.x), ly(b.y), P.a3);
    b.list.forEach(([name, i], k) => {
      const sx = b.x + k * (SW + 2), sy = b.y + 7;
      fill(B, sx, sy, sx + SW, sy + 12, P.r1);
      fill(B, sx + 1, sy + 1, sx + SW - 1, sy + 11, i);
      const hex = RGB[i].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
      labels(L, name, lx(sx), ly(sy + 13), P.r5);
      labels(L, hex, lx(sx), ly(sy + 13) + 9, P.r3);
    });
  }
  const cv = document.getElementById("view");
  cv.width = FW * K; cv.height = FH * K;
  cv.style.width = cv.width + "px"; cv.style.height = cv.height + "px";
  const g = cv.getContext("2d");
  g.imageSmoothingEnabled = false;
  const off = Object.assign(document.createElement("canvas"), { width: B.w, height: B.h });
  B.toImage(off.getContext("2d"));
  g.drawImage(off, 0, 0, B.w * K, B.h * K);
  const lo = Object.assign(document.createElement("canvas"), { width: L.w, height: L.h });
  L.toImage(lo.getContext("2d"), 255);
  g.drawImage(lo, 0, 0, L.w * 2, L.h * 2);
}

try {
  draw();
  document.body.classList.add("ready");
} catch (e) {
  document.body.classList.add("failed");
  document.body.dataset.error = e.stack || String(e);
}
