// The camp as a set piece: three canvas tents glowing from inside, lanterns on poles pouring cones of light, a fire
// ringed with stones, a woodpile, and five dark figures rimmed by the fire.
import * as THREE from "three";
import { COLORS } from "../island.js";
import { hash } from "../world.js";
import { part, merge, flatMat } from "./props.js";
import { glow, lightCone } from "./fx.js";

const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
const cyl = (r0, r1, h, s = 5) => new THREE.CylinderGeometry(r1, r0, h, s, 1);

// Figures are dark; a rim term lights whatever edge faces the fire, the way stage light catches a silhouette.
export function rimmed(mat, fireView, color, reach) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFireV = { value: fireView };
    sh.uniforms.uRim = { value: new THREE.Color(color) };
    sh.uniforms.uReach = { value: reach };
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uFireV, uRim; uniform float uReach;")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        { vec3 toF = uFireV + vViewPosition; float dF = length(toF);
          float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.2);
          float face = clamp(dot(normal, toF / dF) * 0.7 + 0.3, 0.0, 1.0);
          totalEmissiveRadiance += uRim * rim * face * clamp(uReach / (dF * dF), 0.0, 1.5); }`);
  };
  return mat;
}

function tentGeometry(size) {
  const L = size, W = size * 0.44, H = size * 0.52, zf = L / 2, zb = -L / 2;
  const tris = [], add = (...p) => tris.push(p);
  add([-W, 0, zb], [0, H, zb], [0, H, zf]); add([-W, 0, zb], [0, H, zf], [-W, 0, zf]);
  add([W, 0, zb], [0, H, zf], [0, H, zb]); add([W, 0, zb], [W, 0, zf], [0, H, zf]);
  add([-W, 0, zb], [W, 0, zb], [0, H, zb]);
  // The door flaps, tied back to either side of a triangular opening.
  add([-W, 0, zf], [0, H, zf], [-W * 0.55, 0, zf + 0.35]);
  add([W, 0, zf], [W * 0.55, 0, zf + 0.35], [0, H, zf]);
  const pos = [], inner = new THREE.Vector3(0, H * 0.3, 0);
  for (const [a, b, c] of tris) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), C = new THREE.Vector3(...c);
    const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A));
    const mid = A.clone().add(B).add(C).multiplyScalar(1 / 3).sub(inner);
    if (n.dot(mid) < 0) pos.push(...a, ...c, ...b); else pos.push(...a, ...b, ...c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return { g, L, W, H };
}

function figure(k, pose) {
  const cloth = new THREE.Color(COLORS[(k * 5 + 2) % COLORS.length]).lerp(new THREE.Color("#3a3a3e"), 0.35).lerp(new THREE.Color("#141418"), 0.6).getHexString();
  const dark = "#19181c", skin = "#7a5c4a", cl = "#" + cloth, parts = [];
  const hat = (y, z) => parts.push(part(cyl(0.24, 0.24, 0.025, 8), dark, { at: [0, y, z] }), part(cyl(0.12, 0.1, 0.14, 6), dark, { at: [0, y + 0.08, z] }));
  if (pose === "stand") {
    parts.push(part(box(0.11, 0.8, 0.13), dark, { at: [-0.09, 0.4, 0] }), part(box(0.11, 0.8, 0.13), dark, { at: [0.09, 0.4, 0] }));
    parts.push(part(cyl(0.31, 0.2, 0.95, 6), cl, { at: [0, 0.95, 0] }), part(box(0.5, 0.1, 0.26), cl, { at: [0, 1.42, 0] }));
    parts.push(part(box(0.1, 0.62, 0.11), cl, { at: [-0.29, 1.12, 0.02], rot: [0.1, 0, 0.1] }), part(box(0.1, 0.62, 0.11), cl, { at: [0.28, 1.14, 0.12], rot: [-0.5, 0, -0.08] }));
    parts.push(part(new THREE.IcosahedronGeometry(0.12, 0), skin, { at: [0, 1.6, 0.02] }));
    if (k === 1) hat(1.69, 0.02);
  } else {
    parts.push(part(cyl(0.19, 0.19, 1.0, 6), "#2e2620", { at: [0, 0.2, -0.08], rot: [0, 0, Math.PI / 2] }));
    parts.push(part(box(0.14, 0.14, 0.48), dark, { at: [-0.1, 0.46, 0.16] }), part(box(0.14, 0.14, 0.48), dark, { at: [0.1, 0.46, 0.16] }));
    parts.push(part(box(0.13, 0.46, 0.13), dark, { at: [-0.1, 0.23, 0.38] }), part(box(0.13, 0.46, 0.13), dark, { at: [0.1, 0.23, 0.38] }));
    parts.push(part(cyl(0.32, 0.17, 0.72, 6), cl, { at: [0, 0.78, 0], rot: [0.28, 0, 0] }));
    parts.push(part(box(0.09, 0.5, 0.1), cl, { at: [-0.2, 0.86, 0.26], rot: [1.15, 0, 0.1] }), part(box(0.09, 0.5, 0.1), cl, { at: [0.2, 0.86, 0.26], rot: [1.15, 0, -0.1] }));
    parts.push(part(new THREE.IcosahedronGeometry(0.12, 0), skin, { at: [0, 1.2, 0.15] }));
    if (k === 0) hat(1.29, 0.15);
  }
  return merge(parts);
}

// Builds the camp. The close view gets the fine detail; the far one gets bigger halos and longer-reaching light.
export function buildCamp(w, scene, { camera, detail = true, fireShadow = 0, fireI = 60, fireDecay = 2, fireReach = 0, tentI = 5, tentDecay = 2, lanternI = 30, glowScale = 1 }) {
  const camp = w.camp, fire = camp.fire, F = new THREE.Vector3(fire.x, fire.y, fire.z);
  const fireView = F.clone().add(new THREE.Vector3(0, 0.8, 0)).applyMatrix4(camera.matrixWorldInverse);
  const figMat = rimmed(flatMat(), fireView, "#ff9a4a", 5.5), set = flatMat();

  // Fire: stones, charred logs in a cone, tongues of flame.
  const fp = [];
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * Math.PI * 2 + hash(k, 1, 21) * 0.3, r = 0.78 + hash(k, 2, 21) * 0.08;
    fp.push(part(new THREE.DodecahedronGeometry(0.17 + hash(k, 3, 21) * 0.07, 0), "#5a5552", { at: [Math.cos(a) * r, 0.08, Math.sin(a) * r], rot: [k, k * 2, 0], scale: [1, 0.7, 1] }));
  }
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.4;
    fp.push(part(cyl(0.06, 0.05, 1.05, 5), "#1e1a18", { at: [Math.cos(a) * 0.28, 0.36, Math.sin(a) * 0.28], rot: [-Math.sin(a) * 0.62, 0, Math.cos(a) * 0.62] }));
  }
  const ring = new THREE.Mesh(merge(fp), set);
  ring.position.copy(F);
  ring.castShadow = false;
  ring.receiveShadow = true;
  scene.add(ring);
  const flame = new THREE.Group();
  [["#ff6a1f", 0.42, 1.3, 0, 0], ["#ff9c33", 0.3, 1.0, 0.08, 0.05], ["#ffd98a", 0.17, 0.62, -0.04, 0], ["#ff7d2a", 0.2, 0.75, -0.22, 0.14], ["#ff8a2e", 0.18, 0.62, 0.22, -0.12]].forEach(([c, r, h, dx, dz], k) => {
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5, 1), new THREE.MeshBasicMaterial({ color: c, fog: false }));
    m.position.set(F.x + dx, F.y + 0.12 + h / 2, F.z + dz);
    m.rotation.set(dx * 0.6, k * 1.3, dz * 0.6);
    flame.add(m);
  });
  scene.add(flame);
  scene.add(glow("#ff7a2a", 9 * glowScale, F.clone().add(new THREE.Vector3(0, 0.9, 0)), 0.8), glow("#ffc36a", 2.4 * glowScale, F.clone().add(new THREE.Vector3(0, 0.6, 0)), 0.9));
  const fl = new THREE.PointLight("#ff8434", fireI, fireReach, fireDecay);
  fl.position.copy(F).add(new THREE.Vector3(0, 0.9, 0));
  if (fireShadow) {
    fl.castShadow = true;
    fl.shadow.mapSize.set(fireShadow, fireShadow);
    fl.shadow.camera.near = 0.3; fl.shadow.camera.far = 60;
    fl.shadow.bias = -0.004;
  }
  scene.add(fl);

  // Tents: canvas lit from within, open doors spilling light, poles and guy lines.
  const guy = [];
  camp.tents.forEach((t, k) => {
    const { g, L, W, H } = tentGeometry(t.size);
    const grp = new THREE.Group();
    grp.position.set(t.at.x, t.at.y - 0.05, t.at.z);
    grp.rotation.y = t.yaw;
    const outer = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: "#b9a888", emissive: "#b8662a", emissiveIntensity: 0.55, flatShading: true }));
    const inner = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: "#ffb55c", side: THREE.BackSide }));
    outer.castShadow = true; outer.receiveShadow = true;
    grp.add(outer, inner);
    const poles = merge([part(cyl(0.035, 0.035, H + 0.35), "#1d1a18", { at: [0, (H + 0.35) / 2, L / 2 + 0.02] }), part(cyl(0.035, 0.035, H + 0.35), "#1d1a18", { at: [0, (H + 0.35) / 2, -L / 2 - 0.02] }),
      part(new THREE.BoxGeometry(0.03, 0.03, L + 0.3), "#2a2522", { at: [0, H + 0.01, 0] })]);
    const pm = new THREE.Mesh(poles, set);
    pm.castShadow = true;
    grp.add(pm);
    // Warm floor inside, seen through the door.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.7, L * 0.95).rotateX(-Math.PI / 2).translate(0, 0.03, 0), new THREE.MeshBasicMaterial({ color: "#c77a3a" }));
    grp.add(floor);
    scene.add(grp);
    grp.updateMatrixWorld();
    for (const [z, y] of [[L / 2 + 0.02, H + 0.3], [-L / 2 - 0.02, H + 0.3]]) {
      const top = new THREE.Vector3(0, y, z).applyMatrix4(grp.matrixWorld), peg = new THREE.Vector3(0, 0, z + Math.sign(z) * 1.6).applyMatrix4(grp.matrixWorld);
      peg.y = w.heightAt(peg.x, peg.z);
      guy.push(top, peg);
    }
    const tl = new THREE.PointLight("#ff9a48", tentI, 0, tentDecay);
    tl.position.copy(new THREE.Vector3(0, H * 0.35, 0.2).applyMatrix4(grp.matrixWorld));
    scene.add(tl);

    // Lantern on a pole beside the door, a cone of light under it.
    const side = k % 2 ? 1 : -1, lp = new THREE.Vector3(side * (W + 0.5), 0, L / 2 + 0.3).applyMatrix4(grp.matrixWorld);
    lp.y = w.heightAt(lp.x, lp.z);
    const PH = 2.7, lan = new THREE.Vector3(lp.x, lp.y + PH - 0.25, lp.z);
    const pole = new THREE.Mesh(merge([part(cyl(0.04, 0.03, PH, 5), "#1b1917", { at: [0, PH / 2, 0] }), part(box(0.03, 0.03, 0.42), "#1b1917", { at: [0, PH - 0.05, 0.18] })]), set);
    pole.position.copy(lp);
    pole.rotation.y = Math.atan2(fire.x - lp.x, fire.z - lp.z);
    pole.castShadow = true;
    scene.add(pole);
    pole.updateMatrixWorld();
    const hang = new THREE.Vector3(0, PH - 0.32, 0.36).applyMatrix4(pole.matrixWorld);
    const box3 = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.16), new THREE.MeshBasicMaterial({ color: "#ffe2a8" }));
    box3.position.copy(hang);
    scene.add(box3);
    scene.add(glow("#ffc070", 1.8 * glowScale, hang, 0.9), glow("#ff9a48", 5 * glowScale, hang, 0.35));
    const ground = w.heightAt(hang.x, hang.z), drop = hang.y - ground;
    scene.add(lightCone(hang, drop, drop * 0.85, "#ffb45c", detail ? 0.22 : 0.3));
    const sl = new THREE.SpotLight("#ffc27a", lanternI, 0, 0.72, 0.12, 2);
    sl.position.copy(hang);
    sl.target.position.set(hang.x, ground, hang.z);
    scene.add(sl, sl.target);
  });
  if (detail) scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(guy), new THREE.LineBasicMaterial({ color: "#3a332c" })));

  // People: two standing, three sitting, all facing the fire.
  camp.people.forEach((p, k) => {
    const pose = k === 1 || k === 3 ? "stand" : "sit";
    const m = new THREE.Mesh(figure(k, pose), figMat);
    m.position.set(p.at.x, p.at.y - 0.02, p.at.z);
    m.rotation.y = p.yaw;
    m.castShadow = true;
    scene.add(m);
  });

  // Woodpile: split logs stacked in a low pyramid.
  const wp = camp.woodpile, logs = [];
  for (let row = 0; row < 3; row++)
    for (let n = 0; n < 4 - row; n++)
      logs.push(part(cyl(0.12, 0.12, 1.3, 6), n % 2 ? "#4a3a2c" : "#3d3026", { at: [(n - (3 - row) / 2) * 0.25, 0.12 + row * 0.21, (hash(n, row, 31) - 0.5) * 0.2], rot: [Math.PI / 2, 0, 0] }));
  const pile = new THREE.Mesh(merge(logs), set);
  pile.position.set(wp.x, wp.y, wp.z);
  pile.rotation.y = Math.atan2(fire.x - wp.x, fire.z - wp.z) + Math.PI / 2;
  pile.castShadow = true;
  pile.receiveShadow = true;
  scene.add(pile);

  // A tripod and pot over the fire.
  const tri = [];
  for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2 + 0.3; tri.push(part(cyl(0.025, 0.02, 2.5, 4), "#1a1715", { at: [Math.cos(a) * 0.6, 1.15, Math.sin(a) * 0.6], rot: [-Math.sin(a) * 0.45, 0, Math.cos(a) * 0.45] })); }
  tri.push(part(cyl(0.18, 0.22, 0.24, 7), "#2b2a2c", { at: [0, 1.62, 0] }), part(box(0.015, 0.52, 0.015), "#1a1715", { at: [0, 2.0, 0] }));
  const tp = new THREE.Mesh(merge(tri), set);
  tp.position.copy(F);
  tp.castShadow = false;
  scene.add(tp);
}

// The small stuff close to the fire: grass tufts, flowers, pebbles and fallen wood from world.nearby.
export function smallStuff(w, scene, center, radius, density, keep, tuftScale = 1) {
  const near = w.nearby(center, radius, density), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), m4 = new THREE.Matrix4(), c = new THREE.Color();
  const blade = (a, lean, h) => { const g = new THREE.BufferGeometry(); const x = Math.cos(a) * 0.05, z = Math.sin(a) * 0.05, tx = Math.cos(a) * lean, tz = Math.sin(a) * lean;
    g.setAttribute("position", new THREE.Float32BufferAttribute([-z, 0, x, z, 0, -x, tx, h, tz], 3)); return g; };
  const tuft = merge([0, 1, 2, 3, 4].map((k) => part(blade(k * 1.3, 0.12 + (k % 3) * 0.06, 0.5 + (k % 2) * 0.22), k % 2 ? "#4d5840" : "#58624a")));
  const inst = (geo, list, place, cast = false) => {
    list = list.filter(keep);
    const mesh = new THREE.InstancedMesh(geo, flatMat({ side: THREE.DoubleSide }), Math.max(1, list.length));
    list.forEach((it, k) => { place(it); mesh.setMatrixAt(k, m4); mesh.setColorAt(k, c); });
    mesh.count = list.length;
    mesh.receiveShadow = true;
    mesh.castShadow = cast;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  };
  inst(tuft, near.grass, (g) => { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), g.yaw); m4.compose(v.set(g.x, g.y - 0.02, g.z), q, s.set(g.tall * tuftScale, g.tall * tuftScale, g.tall * tuftScale)); const k = 0.75 + g.tint * 0.5; c.setRGB(k, k, k); }, true);
  const fl = merge([part(new THREE.CylinderGeometry(0.008, 0.008, 1, 3), "#4a5540", { at: [0, 0.5, 0] }), part(new THREE.OctahedronGeometry(0.11, 0), "#ffffff", { at: [0, 1, 0] })]);
  const hues = ["#d8d2b8", "#c9b36a", "#9e8fb8", "#c7c5c9", "#b8746a"];
  inst(fl, near.flowers, (f) => { m4.compose(v.set(f.x, f.y, f.z), q.identity(), s.set(f.tall * 1.4, f.tall * 1.4, f.tall * 1.4)); c.set(hues[Math.floor(f.hue * hues.length) % hues.length]); });
  const peb = merge([part(new THREE.DodecahedronGeometry(1, 0), "#6c6870", { scale: [1, 0.55, 0.8] })]);
  inst(peb, near.pebbles, (p) => { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw); m4.compose(v.set(p.x, p.y, p.z), q, s.set(p.size * 0.5, p.size * 0.5, p.size * 0.5)); const k = 0.7 + p.tint * 0.5; c.setRGB(k, k, k); });
  const log = merge([part(cyl(0.2, 0.18, 1, 6), "#3b3129", { at: [0, 0.18, 0], rot: [0, 0, Math.PI / 2] })]);
  inst(log, near.logs, (l) => { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.yaw); m4.compose(v.set(l.x, l.y, l.z), q, s.set(l.length, 1, 1)); c.setRGB(1, 1, 1); }, true);
  return near;
}
