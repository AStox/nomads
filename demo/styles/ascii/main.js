// Nomads as a glyph roguelike: the island on a CRT terminal, map window left, status panel right.
import { grow, clamp } from "../world.js";
import { COLORS, NAMES } from "../island.js";
import { W, P, sc, lum, loadFace, Screen, text, wrap, plain, present } from "./term.js";
import { islandGrid, localGrid, plantValley, defineGlyphs, BROAD, PINE } from "./map.js";
import { campValley, plantClose, campClose, personColor, TENT_COLORS } from "./camp.js";

const params = new URLSearchParams(location.search);
const VIEW = ["island", "valley", "camp"].includes(params.get("view")) ? params.get("view") : "valley";
const SEED = Number(params.get("seed")) || 1;

// Interface grid: 160 x 45 cells of 8 x 16 px. Map window cols 0..111, panel cols 112..159, rows 1..43.
const MAP = { x: 8, y: 32, w: 880, h: 656 };
const PANEL = { c0: 112, c1: 159, r0: 1, r1: 43 };

// Cells of `cell` px holding the 8x8 glyph scaled by `s`, centred; the padding keeps neighbouring glyphs apart.
function blit(scr, face, g, x0, y0, cell, s = cell / 8) {
  const off = (cell - 8 * s) >> 1;
  for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) {
    const k = j * g.cols + i, fg = g.fg[k], x = x0 + i * cell, y = y0 + j * cell;
    const glow = Math.max(g.glow[k], clamp((lum(fg) - 0.6) / 0.35, 0, 1) * 0.3);
    if (off) scr.rect(x, y, cell, cell, g.bg[k], g.bgGlow[k]);
    scr.glyph(face, g.ch[k], x + off, y + off, s, fg, off ? null : g.bg[k], glow, g.bgGlow[k]);
  }
}

function box(scr, face, c0, r0, c1, r1, dbl, fg) {
  const [h, v, tl, tr, bl, br] = dbl ? "═║╔╗╚╝" : "─│┌┐└┘";
  for (let c = c0 + 1; c < c1; c++) { text(scr, face, c, r0, h, fg); text(scr, face, c, r1, h, fg); }
  for (let r = r0 + 1; r < r1; r++) { text(scr, face, c0, r, v, fg); text(scr, face, c1, r, v, fg); }
  text(scr, face, c0, r0, tl, fg); text(scr, face, c1, r0, tr, fg); text(scr, face, c0, r1, bl, fg); text(scr, face, c1, r1, br, fg);
}
// A title set into a border: ╡ Title ╞ (double) or ┤ Title ├ (single).
function inset(scr, face, c, r, label, dbl, fg, lfg = P.W) {
  const end = text(scr, face, c, r, dbl ? "╡ " : "┤ ", fg);
  const e2 = text(scr, face, end, r, label, lfg, P[0], 0.5);
  return text(scr, face, e2, r, dbl ? " ╞" : " ├", fg);
}
function rule(scr, face, r, label, fg) {
  text(scr, face, PANEL.c0, r, "├" + "─".repeat(PANEL.c1 - PANEL.c0 - 1) + "┤", fg);
  inset(scr, face, PANEL.c0 + 1, r, label, false, fg);
}

// Corner brackets round a map cell: the look cursor.
function cursor(scr, x, y, size, col) {
  const L = Math.max(3, size / 3);
  for (let t = 0; t < 2; t++)
    for (let d = 0; d < L; d++)
      for (const [px, py] of [[x - 2 + d, y - 2 + t], [x - 2 + t, y - 2 + d], [x + size + 1 - d, y - 2 + t], [x + size + 1 - t, y - 2 + d],
        [x - 2 + d, y + size + 1 - t], [x - 2 + t, y + size + 1 - d], [x + size + 1 - d, y + size + 1 - t], [x + size + 1 - t, y + size + 1 - d]])
        scr.rect(px, py, 1, 1, col, 0.9);
}

const compass = (dx, dz) => ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"][((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8];
const fmt = (n) => Math.round(n).toLocaleString("en-US");

async function main() {
  const [bios, vga] = await Promise.all([loadFace("oldschool-bios-8x8", 8), loadFace("oldschool-vga-8x16", 16)]);
  defineGlyphs(bios);
  const w = grow(SEED);
  const scr = new Screen();
  const camp = w.camp, fire = camp.fire;
  const colors = COLORS.slice(0, 5), names = NAMES.slice(0, 5);

  // Facts the interface reports, all read from the world.
  let landCells = 0, peak = { h: -1e9, x: 0, z: 0 };
  for (let k = 0; k < w.N * w.N; k++) {
    if (w.isle.height[k] > 0 && w.isle.water[k] <= 0) landCells++;
    if (w.isle.height[k] > peak.h) peak = { h: w.isle.height[k], x: w.START + (k % w.N) * w.CELL, z: w.START + Math.floor(k / w.N) * w.CELL };
  }
  const km2 = (landCells * w.CELL * w.CELL) / 1e6;
  // Land cover shares over every land cell of the generator.
  const share = { tree: 0, grass: 0, marsh: 0, bare: 0, shrub: 0 };
  for (let k = 0; k < w.N * w.N; k++) if (w.isle.height[k] > 0 && w.isle.water[k] <= 0) for (const key in share) share[key] += w.isle[key][k] / landCells;
  const [wx, wz] = w.isle.wind, windFrom = compass(-wx, -wz);
  const ck = Math.round((fire.z - w.START) / w.CELL) * w.N + Math.round((fire.x - w.START) / w.CELL);
  const temp = w.isle.temp[ck];
  let cxs = 0, czs = 0, cn = 0;
  for (let k = 0; k < w.N * w.N; k++) if (w.isle.height[k] > 0) { cxs += w.START + (k % w.N) * w.CELL; czs += w.START + Math.floor(k / w.N) * w.CELL; cn++; }
  const side = compass(fire.x - cxs / cn, fire.z - czs / cn);
  // Nearest point from the fire, along 32 bearings, where `test` holds.
  const nearest = (test, step = 10, far = 700) => {
    let best = { d: Infinity, dx: 0, dz: 0 };
    for (let a = 0; a < 32; a++) for (let d = step; d < Math.min(far, best.d); d += step) {
      const dx = Math.cos((a / 32) * Math.PI * 2) * d, dz = Math.sin((a / 32) * Math.PI * 2) * d;
      if (test(fire.x + dx, fire.z + dz)) { best = { d, dx, dz }; break; }
    }
    return best;
  };
  const sea = nearest((x, z) => w.fine(w.wet, x, z) > 0.5 && w.heightAt(x, z) < 0.5);
  const lake = nearest((x, z) => w.fine(w.wet, x, z) > 0.5 && w.bilinear(w.isle.height, (x - w.START) / w.CELL, (z - w.START) / w.CELL) > 1);
  const woods = nearest((x, z) => w.fine(w.cover.tree, x, z) > 0.5, 5);
  const seaDist = sea.d, seaDir = [sea.dx, sea.dz], shore = seaDist < 250;
  const by = shore ? "by the &Cshore&y" : lake.d < 250 ? "by the &Cwater&y" : "in the &Gwoods&y";
  const rise = w.heightAt(fire.x + Math.cos(camp.uphill) * 900, fire.z + Math.sin(camp.uphill) * 900) - fire.y;
  const kindsNear = { pine: 0, oak: 0, ash: 0, aspen: 0 };
  for (const t of w.trees) if (Math.abs(t.x - fire.x) < 300 && Math.abs(t.z - fire.z) < 300) kindsNear[t.kind]++;
  const [k1, k2] = Object.keys(kindsNear).sort((a, b) => kindsNear[b] - kindsNear[a]);
  const place = `${side[0].toUpperCase()}${side.slice(1)} ${shore ? "Shore" : "Woods"}`;
  const tentNames = TENT_COLORS.map(([code, name]) => `&${code}${name}&y`);

  // ---------------- the map window
  // Glyphs grow as the view closes in: 8 px on the overview, doubled in the valley, tripled at the camp.
  const LAYOUT = { island: [8, 1], valley: [16, 2], camp: [24, 3] };
  const [cell, gs] = LAYOUT[VIEW], cols = Math.floor(MAP.w / cell), rows = Math.floor(MAP.h / cell);
  let g, look = null, extra = {};
  if (VIEW === "island") {
    g = islandGrid(w, cols, rows);
    const k = g.at(fire.x, fire.z);
    g.put(k, "☼", P.W, sc(P.o, 0.7)); g.glow[k] = 1; g.bgGlow[k] = 0.6;
    look = k;
  } else if (VIEW === "valley") {
    // Framed where the land around the camp has the most relief, with the camp kept well inside the window.
    const s = 10, aim = { score: -Infinity, x: fire.x, z: fire.z };
    for (let a = 0; a < 16; a++) for (const off of [0, 100, 150, 200]) {
      const x0 = fire.x + Math.cos((a / 16) * Math.PI * 2) * off, z0 = fire.z + Math.sin((a / 16) * Math.PI * 2) * off;
      if (Math.abs(fire.x - x0) > (cols / 2 - 6) * s || Math.abs(fire.z - z0) > (rows / 2 - 6) * s) continue;
      let lo = Infinity, hi = -Infinity, steep = 0, wet = 0;
      for (let j = 0; j < rows; j += 2) for (let i = 0; i < cols; i += 2) {
        const x = x0 + (i - cols / 2) * s, z = z0 + (j - rows / 2) * s;
        if (w.fine(w.wet, x, z) > 0.5) { wet++; continue; }
        const h = w.heightAt(x, z);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
        if (w.slopeAt(x, z) > 0.15) steep++;
      }
      const cells = Math.ceil(cols / 2) * Math.ceil(rows / 2), score = hi - lo + (steep / cells) * 40 - Math.max(0, wet / cells - 0.2) * 60;
      if (score > aim.score) Object.assign(aim, { score, x: x0, z: z0 });
    }
    g = localGrid(w, cols, rows, s, aim.x, aim.z);
    extra = plantValley(w, g);
    look = campValley(w, g, colors).fire;
  } else {
    g = localGrid(w, cols, rows, 1, fire.x - 1, fire.z + 1.5);
    extra = plantClose(w, g);
    look = campClose(w, g, colors).fire;
  }
  const mx0 = MAP.x + ((MAP.w - cols * cell) >> 1), my0 = MAP.y + ((MAP.h - rows * cell) >> 1);
  blit(scr, bios, g, mx0, my0, cell, gs);
  if (look !== null) cursor(scr, mx0 + (look % g.cols) * cell, my0 + Math.floor(look / g.cols) * cell, cell, P.W);
  if (VIEW === "island") {
    // Labels on the overview, in the map's own font.
    const label = (x, z, str, fg) => {
      const i = Math.floor((x - g.ox) / g.s), j = Math.floor((z - g.oz) / g.s);
      for (let n = 0; n < str.length; n++) scr.glyph(bios, str[n], mx0 + (i + 2 + n) * cell, my0 + j * cell, 1, fg, P[0], 0.4);
    };
    label(fire.x, fire.z, " camp ", P.W);
    label(peak.x, peak.z, ` ${Math.round(peak.h)} m `, P.Y);
  }

  // ---------------- chrome
  const frame = P.s, dim = P.s;
  scr.rect(0, 0, W, 16, sc(P.k, 0.9));
  scr.rect(0, 704, W, 16, sc(P.k, 0.9));
  let c = text(scr, vga, 1, 0, "&O☼ &YNOMADS", P.Y, null, 0.6);
  const hdr = [`&y${place}`, `&yelev &Y${Math.round(camp.at.y)}&y m`, `&Y${temp.toFixed(0)}&y°C`, `&ywind &C${windFrom}`, `&yday &Y23&y, late summer`];
  for (const h of hdr) { c = text(scr, vga, c, 0, "  &s│  ", P.s, null); c = text(scr, vga, c, 0, h, P.y, null); }
  const right = `&sseed &y${SEED}  &s│  &yturn &Y4,812 `;
  text(scr, vga, 160 - plain(right).length, 0, right, P.y, null);
  box(scr, vga, 0, 1, 111, 43, true, frame);
  const titles = { island: "The Island", valley: place, camp: `Camp, ${place}` };
  inset(scr, vga, 2, 1, titles[VIEW], true, frame);
  inset(scr, vga, 103, 1, "&YN&s↑", true, frame);
  // Scale bar on the bottom border.
  const mPerCol = g.s / (cell / 8), barM = VIEW === "island" ? 1000 : VIEW === "valley" ? 100 : 10;
  const barC = Math.round(barM / mPerCol);
  text(scr, vga, 2, 43, `&s╡ &y├${"─".repeat(barC - 2)}┤ &Y${barM >= 1000 ? barM / 1000 + " km" : barM + " m"} &s╞`, P.y, null);
  const coords = `${Math.round(fire.x)}, ${Math.round(fire.z)}`;
  inset(scr, vga, 108 - coords.length - 4, 43, `&y${coords}`, true, frame);

  box(scr, vga, PANEL.c0, PANEL.r0, PANEL.c1, PANEL.r1, false, frame);
  inset(scr, vga, PANEL.c0 + 1, PANEL.r0, "Band of Five", false, frame);
  const acts = ["tends the fire", "splits firewood", "mends a net", "guts a fish", "keeps watch"];
  names.forEach((nm, n) => {
    const r = 2 + n, hp = 6 + ((n * 7 + 3) % 5);
    let cc = text(scr, vga, PANEL.c0 + 2, r, "@", personColor(colors[n]), null, 0.5);
    cc = text(scr, vga, cc + 1, r, nm.padEnd(8), P.Y, null);
    cc = text(scr, vga, cc + 1, r, "&R" + "■".repeat(hp) + "&K" + "■".repeat(10 - hp), P.R, null);
    text(scr, vga, cc + 2, r, acts[n], dim, null);
  });

  const R1 = 8, R2 = 30;
  if (VIEW === "island") {
    rule(scr, vga, R1, "Legend", frame);
    const leg = [
      [PINE, "p", "pine forest"], [BROAD, "g", "oak wood"], [BROAD, "G", "ash, aspen"], ["*", "P", "wildflowers"],
      ["τ", "g", "scrub"], ['"', "m", "heather"], ['"', "l", "meadow"], ['"', "c", "marsh"],
      ["∙", "t", "beach"], ["∩", "v", "hills"], ["▲", "y", "mountain"], ["▒", "y", "cliff"],
      ["║", "C", "river"], ["≈", "C", "surf"], ["~", "B", "sea"], ["☼", "W", "your camp"],
    ];
    leg.forEach(([gl, code, name], n) => {
      const col = PANEL.c0 + 2 + (n % 2) * 23, r = R1 + 2 + Math.floor(n / 2);
      scr.glyph(bios, gl, col * 8, r * 16 + 4, 1, P[code], P[0], 0.3);
      text(scr, vga, col + 2, r, name, P.y, null);
    });
    const facts = [
      `&y${km2.toFixed(0)} km² of land, ${(w.SIZE / 1000).toFixed(1)} km across.`,
      `&yHighest point &Y${Math.round(peak.h)} m&y, to the ${compass(peak.x - cxs / cn, peak.z - czs / cn)}.`,
      `&C${w.rivers.length} streams&y and &C${w.isle.lakes} lakes&y.`,
      `&G${fmt(w.trees.length)}&y trees, &v${fmt(w.shrubs.length)}&y shrubs, &s${fmt(w.rocks.length)}&y boulders.`,
    ];
    let r = R1 + 11;
    for (const f of facts) for (const line of wrap(f, 44)) text(scr, vga, PANEL.c0 + 2, r++, line, P.y, null);
    const covers = [["tree", BROAD, "g", "woodland"], ["grass", '"', "l", "meadow"], ["marsh", '"', "c", "marsh"], ["bare", "▲", "y", "rock, scree"], ["shrub", "τ", "v", "scrub, heath"]];
    for (const [key, gl, code, name] of covers) {
      const n = Math.round(share[key] * 20);
      scr.glyph(bios, gl, (PANEL.c0 + 2) * 8, r * 16 + 4, 1, P[code], P[0], 0.3);
      text(scr, vga, PANEL.c0 + 4, r++, `&y${name.padEnd(13)}&${code}${"■".repeat(n)}&K${"■".repeat(20 - n)} &y${Math.round(share[key] * 100)}%`, P.y, null);
    }
  } else if (VIEW === "valley") {
    rule(scr, vga, R1, "Overview", frame);
    const mg = islandGrid(w, 44, 38, 0.8), mx = (PANEL.c0 + 2) * 8, my = (R1 + 1) * 16 + 6;
    const k = mg.at(fire.x, fire.z);
    mg.put(k, "☼", P.W, sc(P.o, 0.7)); mg.glow[k] = 1;
    blit(scr, bios, mg, mx, my, 8);
    // The valley window drawn on the overview.
    const ax = mx + ((g.ox - mg.ox) / mg.s) * 8, ay = my + ((g.oz - mg.oz) / mg.s) * 8, aw = ((g.cols * g.s) / mg.s) * 8, ah = ((g.rows * g.s) / mg.s) * 8;
    for (let t = 0; t < aw; t++) { scr.rect(Math.round(ax + t), Math.round(ay), 1, 1, P.W, 0.8); scr.rect(Math.round(ax + t), Math.round(ay + ah), 1, 1, P.W, 0.8); }
    for (let t = 0; t < ah; t++) { scr.rect(Math.round(ax), Math.round(ay + t), 1, 1, P.W, 0.8); scr.rect(Math.round(ax + aw), Math.round(ay + t), 1, 1, P.W, 0.8); }
    text(scr, vga, PANEL.c0 + 2, R2 - 1, `&s${fmt(extra.trees)} trees  ·  ${Math.round(g.cols * g.s)} x ${Math.round(g.rows * g.s)} m  ·  &y${extra.contour} m&s contours`, P.s, null);
  } else {
    rule(scr, vga, R1, "Look", frame);
    let r = R1 + 1;
    const lines = [
      "&O☼ &Wa cookfire",
      `&y${shore ? "Driftwood burns in a ring of shore stones" : "Deadwood burns in a ring of stones"}. The light reaches the ${tentNames[0]}, ${tentNames[1]} and ${tentNames[2]} tents.`,
      "",
      "&sAROUND THE FIRE",
    ];
    for (const l of lines) for (const line of l ? wrap(l, 44) : [""]) text(scr, vga, PANEL.c0 + 2, r++, line, P.y, null);
    const things = [
      ["▲", TENT_COLORS.map(([code]) => code), `3 tents`],
      ["≡", ["w"], "a woodpile, split and stacked"],
      ["@", null, "5 of your band"],
      ['"', ["l"], `${fmt(extra.grass)} tufts of grass`],
      ["*", ["P"], `${fmt(extra.flowers)} wildflowers`],
      ["∙", ["y"], `${fmt(extra.pebbles)} pebbles`],
      [BROAD, ["g"], `${fmt(extra.trees)} tree${extra.trees === 1 ? "" : "s"} at the clearing's edge`],
      ["τ", ["v"], `${fmt(extra.shrubs)} shrub${extra.shrubs === 1 ? "" : "s"}`],
    ];
    const row = (gl, list, name) => {
      const x0 = (PANEL.c0 + 1) * 8;
      list.forEach((col, n) => scr.glyph(bios, gl, list.length > 1 ? x0 + n * 9 : x0 + 16, r * 16 + 4, 1, col, P[0], 0.35));
      text(scr, vga, PANEL.c0 + 7, r++, name, P.y, null);
    };
    for (const [gl, codes, name] of things) if (!name.startsWith("0 ")) row(gl, codes === null ? colors.map(personColor) : codes.map((code) => P[code]), name);
    r++;
    text(scr, vga, PANEL.c0 + 2, r++, "&sFARTHER OFF", P.s, null);
    const at = (o) => `${Math.round(o.d / 10) * 10} m ${compass(o.dx, o.dz)}`;
    if (sea.d < Infinity) row("≈", [P.C], `the sea, ${at(sea)}`);
    if (woods.d < Infinity) row(BROAD, [P.G], `${k1} and ${k2} woods, ${at(woods)}`);
    if (lake.d < Infinity) row("~", [P.B], `a pond, ${at(lake)}`);
    row("▲", [P.y], `ground rises ${Math.round(rise)} m to the ${compass(Math.cos(camp.uphill), Math.sin(camp.uphill))}`);
  }

  rule(scr, vga, R2, "Messages", frame);
  const far = Math.round(seaDist / 10) * 10;
  let coast = 0, marsh = 0, mn = 0;
  for (let k = 0; k < w.N * w.N; k++) {
    if (w.isle.height[k] <= 0 || w.isle.water[k] > 0) continue;
    const x = k % w.N, y = (k / w.N) | 0;
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => w.at(w.isle.height, x + a, y + b) <= 0)) coast++;
  }
  for (let dz = -150; dz <= 150; dz += 15) for (let dx = -150; dx <= 150; dx += 15) { marsh += w.fine(w.cover.marsh, fire.x + dx, fire.z + dz); mn++; }
  const log = {
    island: [
      `The island: &Y${km2.toFixed(0)} km²&y, ${Math.round(share.tree * 100)}% of it under trees.`,
      `You climb a knoll and look out across the island.`,
      `The highest peak stands &Y${Math.round(peak.h)} m&y above the sea, to the ${compass(peak.x - fire.x, peak.z - fire.z)}.`,
      `&C${w.rivers.length} streams&y wind down through the woods to the coast.`,
      `Surf breaks along &C${Math.round((coast * w.CELL) / 1000)} km&y of shore.`,
      `A &C${windFrom}&y wind comes in off the sea.`,
      `You see &Wsmoke&y rising from a camp ${by}.`,
    ],
    valley: [
      `You come down through the ${k1} and ${k2} toward the ${shore ? "sea" : "water"}.`,
      `The ground rises &Y${Math.round(rise)} m&y to the ${compass(Math.cos(camp.uphill), Math.sin(camp.uphill))}.`,
      marsh / mn > 0.2 ? `Reeds and sedge crowd the &cwet ground&y.` : `Grass runs down to the &C${shore ? "shore" : "water"}&y.`,
      sea.d < Infinity ? `You hear surf &C${far} m&y to the ${compass(seaDir[0], seaDir[1])}.` : `The wind moves in the ${k1} leaves.`,
      `You see &Wsmoke&y rising from a camp ${by}.`,
      `&Y${names[1]}&y waves you in.`,
    ],
    camp: [
      `You see &Wsmoke&y rising from a camp ${by}.`,
      `You reach the camp. The fire crackles.`,
      `&Y${names[0]}&y feeds a split log to the flames.`,
      `The &Wsmoke&y drifts ${compass(wx, wz)} on a ${windFrom} wind.`,
      `&Y${names[3]}&y: "${k1[0].toUpperCase()}${k1.slice(1)} burns fast. Bring ${k2} if you find it."`,
      `&Y${names[2]}&y: "${shore ? "The surf is" : "The wind is"} loud tonight."`,
      `&M${extra.flowers} wildflowers&y bloom in the meadow.`,
    ],
  }[VIEW];
  const lines = log.flatMap((m, n) => wrap(m, 44).map((l) => [l, n >= log.length - 2]));
  let r = R2 + 1 + Math.max(0, 12 - lines.length);
  for (const [l, fresh] of lines.slice(-12)) text(scr, vga, PANEL.c0 + 2, r++, fresh ? l : l.replace(/&y/g, "&s"), fresh ? P.y : P.s, null);

  const keys = [["Esc", "menu"], ["l", "look"], ["t", "talk"], ["g", "gather"], ["b", "build"], ["i", "inventory"], ["m", "map"], ["+/-", "zoom"], ["Tab", "next @"]];
  c = 1;
  for (const [k, lab] of keys) { c = text(scr, vga, c, 44, `&s[&W${k}&s] &y${lab}   `, P.y, null); }
  const status = VIEW === "island" ? "OVERVIEW" : VIEW === "valley" ? "LOCAL" : "CLOSE";
  text(scr, vga, 160 - status.length - 2, 44, `&O${status}`, P.O, null, 0.6);

  present(document.getElementById("view"), scr);
}

window.addEventListener("error", (e) => { document.body.dataset.error = String(e.error?.stack || e.message); document.body.classList.add("failed"); });
window.addEventListener("unhandledrejection", (e) => { document.body.dataset.error = String(e.reason?.stack || e.reason); document.body.classList.add("failed"); });
try {
  await main();
  document.body.classList.add("ready");
} catch (e) {
  document.body.dataset.error = String(e.stack || e);
  document.body.classList.add("failed");
}
