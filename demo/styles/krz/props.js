// What stands on the stage: trees as tall thin prisms and faceted crowns, shrubs and rocks as a handful of flat
// planes, all instanced from the world's lists and culled to the camera.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hash } from "../world.js";

// One flat-shaded part: a primitive, placed, painted a single color.
export function part(geo, hex, { at = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0] } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute("uv");
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scale)));
  g.computeVertexNormals();
  const c = new THREE.Color(hex), n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}
export const merge = (parts) => mergeGeometries(parts);

const cyl = (r0, r1, h, s = 4) => new THREE.CylinderGeometry(r1, r0, h, s, 1);
const cone = (r, h, s = 5) => new THREE.ConeGeometry(r, h, s, 1);
const oct = () => new THREE.OctahedronGeometry(1, 0);
// Two cones base to base: a faceted spindle, the stage-flat idea of a crown.
const spindle = (hex, r, down, upH, at, s = 5, turn = 0) => [
  part(cone(r, upH, s), hex, { at: [at[0], at[1] + upH / 2, at[2]], rot: [0, turn, 0] }),
  part(cone(r, down, s), hex, { at: [at[0], at[1] - down / 2, at[2]], rot: [Math.PI, turn, 0] }),
];

// Unit-height trees (y 0..1), scaled by each tree's `tall`.
export function treeModels(detail) {
  const T = "#2b2724";
  if (!detail)
    return {
      pine: merge([part(cone(0.2, 1, 4), "#1c2624", { at: [0, 0.5, 0] })]),
      oak: merge([part(cyl(0.03, 0.02, 0.45), T, { at: [0, 0.22, 0] }), part(oct(), "#2a3226", { at: [0, 0.66, 0], scale: [0.26, 0.3, 0.26] })]),
      ash: merge([part(cyl(0.03, 0.02, 0.5), T, { at: [0, 0.25, 0] }), part(oct(), "#303a2b", { at: [0, 0.66, 0], scale: [0.18, 0.32, 0.18] })]),
      aspen: merge([part(cyl(0.02, 0.012, 0.6), "#8f8d82", { at: [0, 0.3, 0] }), part(oct(), "#394230", { at: [0, 0.74, 0], scale: [0.1, 0.26, 0.1] })]),
    };
  return {
    pine: merge([
      part(cyl(0.02, 0.01, 1), T, { at: [0, 0.5, 0] }),
      part(cone(0.17, 0.42), "#1c2624", { at: [0, 0.5, 0] }),
      part(cone(0.13, 0.38), "#1f2b28", { at: [0, 0.74, 0], rot: [0, 0.6, 0] }),
      part(cone(0.08, 0.26), "#22302b", { at: [0, 0.9, 0], rot: [0, 1.3, 0] }),
    ]),
    oak: merge([
      part(cyl(0.035, 0.02, 0.62), T, { at: [0, 0.31, 0] }),
      ...spindle("#2a3226", 0.25, 0.16, 0.36, [0, 0.62, 0]),
      ...spindle("#262e23", 0.14, 0.1, 0.2, [0.15, 0.6, 0.05], 5, 0.6),
      ...spindle("#2e3729", 0.12, 0.08, 0.18, [-0.13, 0.72, -0.04], 5, 1.1),
    ]),
    ash: merge([
      part(cyl(0.028, 0.014, 0.8), T, { at: [0, 0.4, 0] }),
      ...spindle("#303a2b", 0.16, 0.2, 0.4, [0, 0.6, 0]),
      ...spindle("#2b3427", 0.1, 0.08, 0.16, [0.09, 0.5, 0.03], 5, 0.8),
    ]),
    aspen: merge([
      part(cyl(0.02, 0.009, 1), "#a6a498", { at: [0, 0.5, 0] }),
      ...spindle("#394230", 0.095, 0.16, 0.3, [0, 0.7, 0]),
      ...spindle("#353d2d", 0.06, 0.05, 0.1, [0.03, 0.5, 0], 4, 1.1),
    ]),
  };
}

const shrubModels = () => ({
  bush: merge([part(cone(0.75, 0.6, 6), "#343a2d", { at: [0, 0.3, 0] }), part(cone(0.5, 0.55, 5), "#30362a", { at: [0.42, 0.27, 0.15], rot: [0, 0.7, 0] }), part(cone(0.4, 0.4, 5), "#2c3227", { at: [-0.35, 0.2, -0.2], rot: [0, 1.9, 0] })]),
  heath: merge([part(oct(), "#3d3834", { at: [0, 0.2, 0], scale: [0.8, 0.28, 0.7], rot: [0, 0.4, 0] })]),
});
const rockModel = () => merge([part(new THREE.DodecahedronGeometry(1, 0), "#6b6770", { at: [0, 0.18, 0], scale: [0.55, 0.42, 0.45], rot: [0.3, 0.2, 0.5] })]);

export const flatMat = (o = {}) => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, ...o });

// Instances from a list: `keep(item)` culls, `place(item, m4, color)` fills the matrix and tint.
function instanced(geo, items, place, mat, shadow) {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length)), m = new THREE.Matrix4(), c = new THREE.Color();
  items.forEach((it, k) => { place(it, m, c); mesh.setMatrixAt(k, m); mesh.setColorAt(k, c); });
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = shadow.cast;
  mesh.receiveShadow = shadow.receive;
  mesh.frustumCulled = false;
  return mesh;
}

const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), s = new THREE.Vector3();

export function trees(w, keep, { detail = true, scale = 1, cast = false, lean = 0.04 } = {}) {
  const models = treeModels(detail), mat = flatMat(), out = [], by = { pine: [], oak: [], ash: [], aspen: [] };
  for (const t of w.trees) if (keep(t)) by[t.kind].push(t);
  for (const kind in by) {
    out.push(instanced(models[kind], by[kind], (t, m, c) => {
      const tl = t.tall * scale, wide = kind === "aspen" ? 1 : 0.85 + t.tint * 0.3;
      q.setFromEuler(new THREE.Euler((hash(t.x | 0, t.z | 0, 3) - 0.5) * lean, t.yaw, (hash(t.x | 0, t.z | 0, 4) - 0.5) * lean));
      m.compose(v.set(t.x, t.y - 0.3, t.z), q, s.set(tl * wide, tl, tl * wide));
      const b = 0.75 + t.tint * 0.45;
      c.setRGB(b, b * (0.97 + t.tint * 0.05), b * 0.96);
    }, mat, { cast, receive: true }));
  }
  return { meshes: out, count: Object.values(by).reduce((a, l) => a + l.length, 0) };
}

export function shrubs(w, keep, { cast = false } = {}) {
  const models = shrubModels(), mat = flatMat(), bush = [], heath = [];
  for (const b of w.shrubs) if (keep(b)) (b.heath > 0.55 ? heath : bush).push(b);
  const place = (b, m, c) => { q.setFromAxisAngle(up, b.yaw); m.compose(v.set(b.x, b.y - 0.1, b.z), q, s.set(b.tall, b.tall, b.tall)); const k = 0.8 + b.tint * 0.4; c.setRGB(k, k, k); };
  return [instanced(models.bush, bush, place, mat, { cast, receive: true }), instanced(models.heath, heath, place, mat, { cast, receive: true })];
}

export function rocks(w, keep, { cast = false } = {}) {
  const list = w.rocks.filter(keep);
  return instanced(rockModel(), list, (r, m, c) => {
    q.setFromAxisAngle(up, r.yaw);
    m.compose(v.set(r.x, r.y - r.size * 0.12, r.z), q, s.set(r.size, r.size * (0.6 + r.tint * 0.5), r.size * (0.8 + r.tint * 0.3)));
    const k = 0.7 + r.tint * 0.5; c.setRGB(k, k, k * 1.02);
  }, flatMat(), { cast, receive: true });
}
