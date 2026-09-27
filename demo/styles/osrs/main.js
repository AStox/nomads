// Nomads as the 2007 client: a tile-grid island drawn in chunky Gouraud-lit low poly that ends in black past the draw
// distance, rendered at 640x360 and blown up, under the resizable-mode interface drawn at native size.
import { grow } from "../world.js";
import { COLORS, NAMES } from "../island.js";
import { loadFonts } from "./font.js";
import { buildGround, campPaths } from "./terrain.js";
import { populate, render, lookFor } from "./scene.js";
import * as UI from "./ui.js";
import { drawWorldMap } from "./worldmap.js";

const VIEWS = {
  valley: { T: 4, R: 30, fade: [21.5, 30.3], fov: 40, pitch: 42, dist: 90, lift: 0, vex: 1.5, treeScale: 1.25, treeArea: 14, decor: 0.8, personScale: 1.6, toShore: 30, turn: 1.1, aside: 20 },
  camp: { T: 2, R: 27, fade: [17, 26.8], fov: 40, pitch: 30, dist: 26, lift: 1.3, vex: 1.5, treeScale: 1.05, treeArea: 14, decor: 1, personScale: 1.35, toShore: 0, turn: -1.0, aside: 2.5 },
};
const DIRS = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
const dirWord = (a) => DIRS[Math.round(((a % 6.2832) + 6.2832) % 6.2832 / (Math.PI / 4)) % 8];

export async function run() {
  const q = new URLSearchParams(location.search), v = q.get("view"), view = v === "island" || VIEWS[v] ? v : "valley", seed = Number(q.get("seed") || 1);
  const canvas = document.getElementById("view"), g = canvas.getContext("2d");
  g.imageSmoothingEnabled = false;
  const fontsP = loadFonts();
  const W = grow(seed), F = await fontsP;
  const camp = W.camp, paths = campPaths(W);
  if (view === "island") { drawWorldMap(g, F, W, paths, seed); return; }

  const V = { ...VIEWS[view] };
  const fire = camp.fire, shoreA = paths.shore ? paths.shore.a : camp.from + Math.PI;
  V.look = (view === "camp" ? camp.from + Math.PI : shoreA) + V.turn;
  // aside: nudge the focus to the right so the camp sits in the open part of the screen, left of the side panel
  V.focus = { x: fire.x + Math.cos(shoreA) * V.toShore - Math.sin(V.look) * V.aside, z: fire.z + Math.sin(shoreA) * V.toShore + Math.cos(V.look) * V.aside };
  const G = buildGround(W, { focus: V.focus, T: V.T, R: V.R, vex: V.vex, paths });
  const P = populate(W, G, V, V.focus);
  if (view === "camp") P.logs = W.nearby(fire, 44, 0.15).logs.filter((l) => G.overAt(l.x, l.z) === 0).map((l) => ({ ...l, y: G.groundAt(l.x, l.z) }));

  // the five campers: standing, sitting on a log, talking, cooking on a stick, and one chopping (at the nearest tree
  // ahead when zoomed out, at the woodpile's block when close in)
  const poses = ["stand", "sit", "talk", "crouch", "stand"], names = camp.people.map((_, k) => NAMES[(k * 7 + seed * 5) % NAMES.length]);
  const people = camp.people.map((p, k) => ({ x: p.at.x, z: p.at.z, yaw: p.yaw, pose: poses[k], look: lookFor(k, seed, COLORS), name: names[k] }));
  const cook = people[3], cd = Math.hypot(cook.x - fire.x, cook.z - fire.z);
  cook.x = fire.x + ((cook.x - fire.x) / cd) * 2.0; cook.z = fire.z + ((cook.z - fire.z) / cd) * 2.0;
  const ahead = (t) => { const a = Math.atan2(t.z - fire.z, t.x - fire.x) - V.look; return Math.cos(a) > 0.72; };
  const tree = view === "valley" && P.trees.filter((t) => t.model !== "dead" && ahead(t)).sort((a, b) => Math.hypot(a.x - fire.x, a.z - fire.z) - Math.hypot(b.x - fire.x, b.z - fire.z))[0];
  const me = people[4];
  me.pose = "chop";
  if (!tree) {
    // in close, the chopping is done at the woodpile's block, where the camera can see it
    const wp = camp.woodpile, yaw = Math.atan2(fire.x - wp.x, fire.z - wp.z) + Math.PI / 2, bx = wp.x - 1.4 * Math.cos(yaw) + 0.3 * Math.sin(yaw), bz = wp.z + 1.4 * Math.sin(yaw) + 0.3 * Math.cos(yaw);
    const d = Math.hypot(fire.x - bx, fire.z - bz);
    me.x = bx + ((fire.x - bx) / d) * 0.95; me.z = bz + ((fire.z - bz) / d) * 0.95;
    me.yaw = Math.atan2(bx - me.x, bz - me.z);
  } else {
    const d = Math.hypot(fire.x - tree.x, fire.z - tree.z), stand = 1.3 + tree.s * 0.9;
    me.x = tree.x + ((fire.x - tree.x) / d) * stand; me.z = tree.z + ((fire.z - tree.z) / d) * stand;
    me.yaw = Math.atan2(tree.x - me.x, tree.z - me.z);
  }
  const out = render(W, G, V, P, { ...camp, people }, COLORS, seed);
  g.drawImage(out.canvas, 0, 0, 1280, 720);

  // what the chat, the overhead text and the click marker say, all from the data in view
  const shore = paths.shore, dist = shore ? Math.round(shore.r) : 0, sdir = dirWord(shoreA), nTrees = P.trees.length;
  const pub = (n, s) => [[n + ": ", "#000000"], [s, "#0000ff"]], game = (s) => [[s, "#000000"]];
  const talker = people[2], said = shore ? `sea's ${dist}m ${sdir}, go fish` : "fire's lit";
  const lines = view === "valley"
    ? [game("Welcome to Nomads."), game("You light a fire."), pub(people[0].name, `${camp.tents.length} tents up by the fire`), game("You catch some shrimps."), pub(people[1].name, `${nTrees} trees round here lol`), game("You swing your axe at the tree."), game("You get some logs."), pub(talker.name, said)]
    : [game("Welcome to Nomads."), game("The fire catches and the logs begin to burn."), pub(people[0].name, "anyone got a tinderbox?"), game("You swing your axe at the logs."), game("You get some logs."), pub(people[1].name, `${nTrees} trees and all of them mine`), pub(talker.name, said)];
  const head = (p, h) => out.project(p.x, out.groundY(p.x, p.z) + h * V.personScale, p.z);
  const [tx, ty] = head(talker, 2.35);
  UI.overhead(g, F, said, tx, ty);
  if (view === "valley" && shore) {
    const seg = paths.segs[paths.segs.length - Math.max(2, Math.floor(paths.segs.length * 0.35))], [x, z] = seg.b, [sx, sy] = out.project(x, out.groundY(x, z) + 0.05, z);
    UI.clickCross(g, sx, sy);
  }
  UI.xpDrops(g, F, view === "valley" ? [["woodcutting", 25], ["firemaking", 40]] : [["woodcutting", 25]]);
  UI.mouseText(g, F, view === "valley" ? [["Walk here", "#ffffff"], [" / 3 more options", "#ffffff"]] : [["Talk-to ", "#ffffff"], [talker.name, "#ffff00"], [" / 2 more options", "#ffffff"]]);

  UI.minimap(g, F, { G, P, center: me, look: V.look, npcs: people.filter((p) => p !== me), fire });
  UI.chatbox(g, F, lines, me.name);
  const I = UI.itemIcons(), inv = [I.axe, I.net, I.tinderbox, I.coins, I.raw, I.raw, I.raw, I.cooked, I.cooked, I.logs, I.logs, I.logs, I.oak, I.knife, I.bread];
  UI.sidePanel(g, F, inv.map((icon) => ({ icon, count: icon === I.coins ? camp.people.length * 25 : 0 })));
}
