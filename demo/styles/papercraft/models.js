// Everything that stands on the sheets, all of it paper: slotted card trees, paper-cone pines, crumpled balls,
// folded card rocks, fringed grass strips, paper discs, folded tents, cut-out people on stands, paper flames.
import * as THREE from "three";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { canvas } from "./paper.js";

const tex = (c, srgb = false) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
};

// Card silhouettes. Red is the paper shade (tinted per tree), green flags the trunk, alpha is the cut.
export function treeCard(kind, rand) {
  const W = 256, H = 320, c = canvas(W, H), g = c.getContext("2d");
  const crown = new Path2D();
  const blobs = kind === "oak"
    ? [[0.5, 0.42, 0.3], [0.3, 0.5, 0.2], [0.7, 0.5, 0.2], [0.38, 0.3, 0.2], [0.62, 0.3, 0.2], [0.5, 0.2, 0.17], [0.2, 0.6, 0.12], [0.8, 0.6, 0.12]]
    : kind === "ash"
      ? [[0.5, 0.42, 0.24], [0.36, 0.52, 0.17], [0.64, 0.52, 0.17], [0.42, 0.28, 0.17], [0.58, 0.28, 0.17], [0.5, 0.14, 0.13], [0.5, 0.62, 0.15]]
      : [[0.5, 0.2, 0.12], [0.5, 0.33, 0.15], [0.5, 0.48, 0.16], [0.5, 0.62, 0.14], [0.42, 0.4, 0.1], [0.58, 0.4, 0.1], [0.44, 0.56, 0.1], [0.56, 0.56, 0.1]];
  for (const [x, y, r] of blobs) {
    // Each lobe cut as a slightly faceted arc, the way it is snipped.
    const n = 9;
    crown.moveTo(x * W + r * W, y * H);
    for (let k = 1; k <= n; k++) {
      const a = (k / n) * Math.PI * 2, rr = r * W * (0.94 + rand() * 0.1);
      crown.lineTo(x * W + Math.cos(a) * rr, y * H + Math.sin(a) * rr * 1.05);
    }
  }
  const tw = kind === "aspen" ? 0.05 : 0.07;
  // The white margin scissors leave around a printed cut-out, flagged in blue so it stays untinted.
  g.strokeStyle = "rgb(240,0,255)";
  g.fillStyle = "rgb(240,0,255)";
  g.lineJoin = "round";
  g.lineWidth = 7;
  g.stroke(crown);
  g.fill(crown, "nonzero");
  g.beginPath();
  g.moveTo(W * (0.5 - tw), H);
  g.lineTo(W * (0.5 - tw * 0.6), H * 0.5);
  g.lineTo(W * (0.5 + tw * 0.6), H * 0.5);
  g.lineTo(W * (0.5 + tw), H);
  g.stroke();
  g.fillStyle = "rgb(0,255,0)";
  g.beginPath();
  g.moveTo(W * (0.5 - tw), H);
  g.lineTo(W * (0.5 - tw * 0.6), H * 0.5);
  g.lineTo(W * (0.5 + tw * 0.6), H * 0.5);
  g.lineTo(W * (0.5 + tw), H);
  g.fill();
  g.fillStyle = "rgb(225,0,0)";
  g.save();
  g.translate(W / 2, H / 2);
  g.scale(0.965, 0.965);
  g.translate(-W / 2, -H / 2);
  g.fill(crown, "nonzero");
  g.restore();
  // Scored fold lines printed on the card before it was cut.
  g.save();
  g.clip(crown);
  g.strokeStyle = "rgba(170,0,0,0.5)";
  g.lineWidth = 2;
  for (let k = 0; k < 7; k++) {
    const x = W * (0.5 + (rand() - 0.5) * 0.35), y = H * (0.2 + rand() * 0.4);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (x < W / 2 ? -1 : 1) * W * 0.08, y - H * 0.06);
    g.stroke();
  }
  g.restore();
  // Punched leaf holes: little cut-outs through the crown.
  g.globalCompositeOperation = "destination-out";
  for (let k = 0; k < (kind === "aspen" ? 4 : 7); k++) {
    const x = W * (0.5 + (rand() - 0.5) * 0.4), y = H * (0.18 + rand() * 0.42), r = W * (0.012 + rand() * 0.018);
    g.beginPath();
    g.ellipse(x, y, r, r * 1.8, rand() * 3, 0, Math.PI * 2);
    g.fill();
  }
  return { map: tex(c), aspect: W / H };
}

// Two creased cards slotted crosswise: four panels folded a little off flat at the centre line.
export function slottedCards(aspect) {
  const w = aspect / 2, fold = 0.32, parts = [];
  for (const turn of [0, Math.PI / 2]) {
    for (const side of [-1, 1]) {
      const g = new THREE.PlaneGeometry(w, 1);
      g.translate((side * w) / 2, 0.5, 0);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, side < 0 ? uv.getX(i) * 0.5 : 0.5 + uv.getX(i) * 0.5);
      g.rotateY(turn + side * fold);
      parts.push(g);
    }
  }
  return mergeGeometries(parts);
}

// A pine of three stacked paper cones on a rolled trunk.
export function pineCones() {
  const tiers = [[0.2, 0.44, 0.3], [0.4, 0.4, 0.23], [0.6, 0.4, 0.15]].map(([y, h, r]) => {
    const g = new THREE.ConeGeometry(r, h, 8, 1, true);
    g.translate(0, y + h / 2, 0);
    return g;
  });
  return mergeGeometries(tiers).toNonIndexed();
}
export function trunk() {
  const g = new THREE.CylinderGeometry(0.03, 0.04, 0.3, 6, 1, true);
  g.translate(0, 0.15, 0);
  return g;
}

// Crumpled paper: a subdivided ball pushed in and out, then left faceted.
export function crumpled(rand) {
  let g = mergeVertices(new THREE.IcosahedronGeometry(1, 1));
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = 0.72 + rand() * 0.45;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.9, p.getZ(i) * s);
  }
  g = g.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

// Folded card rock: a handful of flat facets around a squat hull.
export function foldedRock(rand) {
  const pts = [];
  for (let k = 0; k < 9; k++) {
    const a = rand() * Math.PI * 2, e = rand() * 1.2 - 0.25, r = 0.7 + rand() * 0.4;
    pts.push(new THREE.Vector3(Math.cos(a) * Math.cos(e) * r, Math.max(-0.2, Math.sin(e) * r * 0.75), Math.sin(a) * Math.cos(e) * r));
  }
  pts.push(new THREE.Vector3(0, -0.25, 0));
  const g = new ConvexGeometry(pts);
  return g.index ? g.toNonIndexed() : g;
}

// A fringed strip: a paper band snipped into blades, curled into an arc.
export function grassStrip() {
  const seg = 5, arc = 1.2, r = 0.5, pos = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = -arc / 2 + (arc * i) / seg, x = Math.sin(a) * r, z = Math.cos(a) * r - r;
    pos.push(x, 0, z, x * 1.3, 1, z * 1.3 - 0.12);
    uv.push(i / seg, 0, i / seg, 1);
    if (i < seg) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
export function fringeTexture(rand) {
  const W = 512, H = 128, c = canvas(W, H), g = c.getContext("2d");
  g.fillStyle = "rgb(210,0,0)";
  g.fillRect(0, H * 0.86, W, H * 0.14);
  let x = 0;
  while (x < W) {
    const bw = 26 + rand() * 18, top = H * (0.02 + rand() * 0.3), lean = (rand() - 0.5) * 22;
    const grd = g.createLinearGradient(0, H, 0, top);
    grd.addColorStop(0, "rgb(222,0,0)");
    grd.addColorStop(1, "rgb(248,0,0)");
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(x + 2, H * 0.88);
    g.lineTo(x + bw * 0.5 + lean, top);
    g.lineTo(x + bw - 2, H * 0.88);
    g.fill();
    x += bw;
  }
  return tex(c);
}

// A paper flower: a scalloped disc with a centre, on a thin strip stem.
export function flowerTexture() {
  const S = 128, c = canvas(S), g = c.getContext("2d");
  g.fillStyle = "rgb(230,0,0)";
  g.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    g.moveTo(S / 2, S / 2);
    g.ellipse(S / 2 + Math.cos(a) * S * 0.24, S / 2 + Math.sin(a) * S * 0.24, S * 0.2, S * 0.13, a, 0, Math.PI * 2);
  }
  g.fill();
  g.fillStyle = "rgb(255,255,0)";
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.12, 0, Math.PI * 2);
  g.fill();
  return tex(c);
}

// Flames: a teardrop with licks, cut three times in shrinking sizes.
export function flameTexture(rand) {
  const W = 128, H = 256, c = canvas(W, H), g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(W * 0.5, H * 0.02);
  g.bezierCurveTo(W * 0.62, H * 0.25, W * 0.92, H * 0.45, W * 0.86, H * 0.72);
  g.bezierCurveTo(W * 0.82, H * 0.95, W * 0.62, H, W * 0.5, H);
  g.bezierCurveTo(W * 0.3, H, W * 0.14, H * 0.92, W * 0.14, H * 0.72);
  g.bezierCurveTo(W * 0.14, H * 0.55, W * 0.3, H * 0.5, W * 0.28, H * 0.3);
  g.bezierCurveTo(W * 0.4, H * 0.42, W * 0.42, H * 0.3, W * 0.5, H * 0.02);
  g.fill();
  return tex(c);
}

// A cut-out person: printed figure with the white margin left by the scissors, on a stand.
export function personTexture(cloth, rand) {
  const W = 128, H = 256, c = canvas(W, H), g = c.getContext("2d");
  const skin = ["#e8b48c", "#c98e62", "#8d5a3b", "#f0c9a4"][Math.floor(rand() * 4)];
  const hair = ["#2b1d14", "#5a3a22", "#1a1a1a", "#8a5a2b", "#c9a15a"][Math.floor(rand() * 5)];
  const trousers = ["#3b3a4a", "#4a3a2a", "#2f4050", "#554433"][Math.floor(rand() * 4)];
  const body = (grow) => {
    g.beginPath();
    g.arc(W / 2, H * 0.14, W * 0.12 + grow, 0, Math.PI * 2);
    g.moveTo(W * 0.3 - grow, H * 0.26 - grow);
    g.lineTo(W * 0.7 + grow, H * 0.26 - grow);
    g.lineTo(W * 0.8 + grow, H * 0.55 + grow);
    g.lineTo(W * 0.66 + grow, H * 0.57 + grow);
    g.lineTo(W * 0.64 + grow, H * 0.98 + grow);
    g.lineTo(W * 0.36 - grow, H * 0.98 + grow);
    g.lineTo(W * 0.34 - grow, H * 0.57 + grow);
    g.lineTo(W * 0.2 - grow, H * 0.55 + grow);
    g.closePath();
  };
  g.fillStyle = "#f7f3ea";
  g.lineJoin = "round";
  g.strokeStyle = "#f7f3ea";
  g.lineWidth = 12;
  body(0);
  g.fill();
  g.stroke();
  g.fillStyle = trousers;
  g.fillRect(W * 0.36, H * 0.6, W * 0.28, H * 0.38);
  g.fillStyle = "#f7f3ea";
  g.fillRect(W * 0.49, H * 0.66, W * 0.02, H * 0.32);
  g.fillStyle = cloth;
  g.beginPath();
  g.moveTo(W * 0.3, H * 0.26);
  g.lineTo(W * 0.7, H * 0.26);
  g.lineTo(W * 0.8, H * 0.55);
  g.lineTo(W * 0.68, H * 0.57);
  g.lineTo(W * 0.68, H * 0.64);
  g.lineTo(W * 0.32, H * 0.64);
  g.lineTo(W * 0.32, H * 0.57);
  g.lineTo(W * 0.2, H * 0.55);
  g.closePath();
  g.fill();
  g.fillStyle = "rgba(0,0,0,0.18)";
  g.fillRect(W * 0.3, H * 0.44, W * 0.4, H * 0.03);
  g.fillStyle = skin;
  g.beginPath();
  g.arc(W / 2, H * 0.14, W * 0.12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = hair;
  g.beginPath();
  g.arc(W / 2, H * 0.12, W * 0.125, Math.PI * 1.05, Math.PI * 1.95);
  g.fill();
  g.fillStyle = "#2a1f18";
  g.fillRect(W * 0.43, H * 0.14, 4, 4);
  g.fillRect(W * 0.54, H * 0.14, 4, 4);
  return tex(c, true);
}

// Folded paper A-frame: one sheet creased along the ridge, a back gable, and the front flaps turned back.
export function aFrame(len, wid, hgt) {
  const hw = wid / 2, hl = len / 2, v = [];
  const quad = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
  const tri = (a, b, c) => v.push(...a, ...b, ...c);
  const R0 = [0, hgt, -hl], R1 = [0, hgt, hl];
  quad([-hw, 0, -hl], [-hw, 0, hl], R1, R0);
  quad([hw, 0, hl], [hw, 0, -hl], R0, R1);
  tri([-hw, 0, -hl], R0, [hw, 0, -hl]);
  // Front flaps folded open, leaving a dark doorway between them.
  tri([-hw, 0, hl], [-hw * 0.2, 0, hl + hw * 0.55], R1);
  tri([hw * 0.2, 0, hl + hw * 0.55], [hw, 0, hl], R1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

export function doorway(wid, hgt, len) {
  const g = new THREE.BufferGeometry(), hw = wid * 0.42, hl = len / 2 - 0.02;
  g.setAttribute("position", new THREE.Float32BufferAttribute([-hw, 0, hl, hw, 0, hl, 0, hgt * 0.86, hl], 3));
  g.computeVertexNormals();
  return g;
}

export function tipi(r, h) {
  const cone = new THREE.ConeGeometry(r, h, 10, 1, true).toNonIndexed();
  cone.translate(0, h / 2, 0);
  const poles = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3, p = new THREE.CylinderGeometry(0.035, 0.035, h * 0.4, 5, 1, true);
    p.translate(0, h * 0.2, 0);
    p.rotateX(0.22);
    p.rotateY(a);
    p.translate(0, h * 0.84, 0);
    poles.push(p.toNonIndexed());
  }
  return { cone, poles: mergeGeometries(poles) };
}

// A rolled paper tube with lighter card at the ends.
export function tube(r, len) {
  const g = new THREE.CylinderGeometry(r, r, len, 8, 1, false).toNonIndexed();
  const n = g.attributes.normal, col = [];
  for (let i = 0; i < n.count; i++) { const cap = Math.abs(n.getY(i)) > 0.9; col.push(...(cap ? [1.35, 1.25, 1.1] : [1, 1, 1])); }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.rotateZ(Math.PI / 2);
  return g;
}
