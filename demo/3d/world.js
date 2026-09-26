// The island as a PS1 scene at true scale: 75 m ground cells, trees ten to twenty meters tall, people under two.
import * as THREE from "three";
import { groundTiles, propMaterial, speckle, terrainMaterial, waterMaterial, waves } from "./ps1.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function buildWorld(isle, { N, CELL, rand, people }) {
  const S = N * CELL, half = S / 2, LEN = N * N, H = isle.height, Wd = isle.water;
  const center = (c) => (c + 0.5) * CELL - half;
  const cellAt = (x, z) => clamp(Math.floor((z + half) / CELL), 0, N - 1) * N + clamp(Math.floor((x + half) / CELL), 0, N - 1);
  const group = new THREE.Group();

  // Ground height anywhere, over the same two triangles per quad the mesh is drawn with.
  function ground(x, z) {
    const gx = clamp((x + half) / CELL - 0.5, 0, N - 1.001), gy = clamp((z + half) / CELL - 0.5, 0, N - 1.001);
    const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j, k = j * N + i;
    return fx + fy <= 1
      ? H[k] + (H[k + 1] - H[k]) * fx + (H[k + N] - H[k]) * fy
      : H[k + N + 1] + (H[k + N] - H[k + N + 1]) * (1 - fx) + (H[k + 1] - H[k + N + 1]) * (1 - fy);
  }
  // Where a foot comes to rest: the ground, or the surface of the sea or a lake over it.
  function floor(x, z) {
    const i = cellAt(x, z), g = ground(x, z);
    return Math.max(g, Wd[i] > 0 ? H[i] + Wd[i] : g < 0 ? 0 : -Infinity);
  }

  // ---------- ground ----------
  const pos = new Float32Array(LEN * 3), uv = new Float32Array(LEN * 2), index = [];
  const coverA = new Uint8Array(LEN * 4), coverB = new Uint8Array(LEN * 4), heights = new Uint16Array(LEN);
  const byte = (v) => Math.round(clamp(v, 0, 1) * 255);
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N;
    pos.set([center(x), H[i], center(y)], i * 3);
    uv.set([(x + 0.5) / N, (y + 0.5) / N], i * 2);
    coverA.set([isle.tree[i], isle.shrub[i], isle.grass[i], isle.marsh[i]].map(byte), i * 4);
    coverB.set([isle.bare[i], isle.sand[i], isle.moist[i], 0].map(byte), i * 4);
    heights[i] = THREE.DataUtils.toHalfFloat(H[i]);
  }
  for (let y = 0; y < N - 1; y++)
    for (let x = 0; x < N - 1; x++) {
      const a = y * N + x, b = a + N;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const terrain = new THREE.BufferGeometry();
  terrain.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  terrain.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  terrain.setIndex(index);
  terrain.computeVertexNormals();
  const data = (array, format, type) => {
    const t = new THREE.DataTexture(array, N, N, format, type);
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  const heightTex = data(heights, THREE.RedFormat, THREE.HalfFloatType);

  // Streams drawn into a fine mask, widening with the water they carry.
  const R = 1024, canvas = document.createElement("canvas");
  canvas.width = canvas.height = R;
  const g = canvas.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, R, R);
  g.strokeStyle = "#fff";
  g.lineCap = g.lineJoin = "round";
  const chaikin = (p) => [p[0], ...p.slice(0, -1).flatMap((a, i) => [a.map((v, k) => v * 0.75 + p[i + 1][k] * 0.25), a.map((v, k) => v * 0.25 + p[i + 1][k] * 0.75)]), p.at(-1)];
  for (const line of isle.rivers) {
    const pts = chaikin(chaikin(line.map(([x, y, q]) => [((x + 0.5) / N) * R, ((y + 0.5) / N) * R, q])));
    for (let k = 1; k < pts.length; k++) {
      g.lineWidth = Math.min(3.2, 0.9 + Math.sqrt((pts[k - 1][2] + pts[k][2]) / 2) * 0.8);
      g.beginPath();
      g.moveTo(pts[k - 1][0], pts[k - 1][1]);
      g.lineTo(pts[k][0], pts[k][1]);
      g.stroke();
    }
  }
  const mask = g.getImageData(0, 0, R, R).data;
  const river = (x, z) => mask[(clamp(Math.floor(((z + half) / S) * R), 0, R - 1) * R + clamp(Math.floor(((x + half) / S) * R), 0, R - 1)) * 4] / 255;
  const riverTex = new THREE.CanvasTexture(canvas);
  riverTex.flipY = false;
  riverTex.minFilter = THREE.LinearMipmapLinearFilter;
  const dry = (x, z) => Wd[cellAt(x, z)] <= 0 && ground(x, z) > 0.5 && river(x, z) < 0.5;

  group.add(new THREE.Mesh(terrain, terrainMaterial({ coverA: data(coverA), coverB: data(coverB), river: riverTex, ground: groundTiles() })));

  // ---------- water ----------
  // The sea runs out to the horizon. Each lake is a sheet at its own level over its cells and their rim; the ground
  // rising through it draws the shore. Rim corners lower than the lake, at its outlet, are left out.
  const water = waterMaterial({ height: heightTex, size: S, wave: waves() });
  group.add(new THREE.Mesh(new THREE.PlaneGeometry(S * 12, S * 12, 48, 48).rotateX(-Math.PI / 2), water));
  const lake = (k) => Wd[k] > 0 && H[k] + Wd[k] > 0.3;
  const sheet = [];
  for (let y = 0; y < N - 1; y++)
    for (let x = 0; x < N - 1; x++) {
      const corners = [y * N + x, (y + 1) * N + x, y * N + x + 1, (y + 1) * N + x + 1];
      const wet = corners.filter(lake);
      if (!wet.length) continue;
      const level = Math.max(...wet.map((k) => H[k] + Wd[k]));
      if (corners.some((k) => !lake(k) && H[k] < level - 0.5)) continue;
      const [a, b, c, d] = corners.map((k) => [center(k % N), level, center(Math.floor(k / N))]);
      sheet.push(...a, ...b, ...c, ...b, ...d, ...c);
    }
  const lakes = new THREE.BufferGeometry();
  lakes.setAttribute("position", new THREE.Float32BufferAttribute(sheet, 3));
  group.add(new THREE.Mesh(lakes, water));

  // ---------- what grows and lies about ----------
  // Kept in patches of 16 by 16 cells. A patch out of view, or too far off for anything in it to cover a pixel, costs
  // nothing; one farther off than thirty times the height of its tallest thing draws only a shuffled share of them, so
  // woods stay thick around the camera and cheap across the island.
  const PATCH = 16, patches = new Map();
  const put = (kind, x, z, size, [r, gr, b], squash = 1) => {
    const key = `${kind} ${Math.floor((x + half) / CELL / PATCH)} ${Math.floor((z + half) / CELL / PATCH)}`;
    if (!patches.has(key)) patches.set(key, { kind, list: [] });
    patches.get(key).list.push({ x, y: ground(x, z), z, size, squash, yaw: rand() * Math.PI * 2, r, g: gr, b });
  };
  const vary = (c, v) => c.map((k) => k * v);
  for (let i = 0; i < LEN; i++) {
    if (Wd[i] > 0 || H[i] < 0.5) continue;
    const cx = center(i % N), cz = center(Math.floor(i / N));
    const spot = () => [cx + (rand() - 0.5) * CELL, cz + (rand() - 0.5) * CELL];
    const exposure = isle.exposure[i], moist = isle.moist[i], soil = Math.min(1.5, isle.soil[i]);
    // Conifers take the cold, thin, windswept ground; broadleaf the deep, damp soil of the valleys.
    const pine = clamp(0.15 + (H[i] - 120) / 450 + exposure * 0.6 - soil * 0.25 + (1 - moist) * 0.2, 0.05, 0.95);
    const vigor = clamp(0.55 + moist * 0.35 + soil * 0.25 - exposure * 0.45, 0.35, 1.25);
    const heath = clamp(0.2 + exposure * 1.3 + isle.peat[i] - moist * 0.4, 0, 1);
    for (let n = Math.floor(isle.tree[i] * 30 + rand()); n > 0; n--) {
      const [x, z] = spot();
      if (!dry(x, z)) continue;
      const conifer = rand() < pine;
      put(conifer ? "conifer" : "broadleaf", x, z, (conifer ? 17 : 13) * vigor * (0.75 + rand() * 0.5), vary([1, 0.98, 0.94], 0.85 + rand() * 0.25), 0.9 + rand() * 0.25);
    }
    for (let n = Math.floor(isle.shrub[i] * 30 + rand()); n > 0; n--) {
      const [x, z] = spot();
      if (!dry(x, z)) continue;
      const t = clamp(heath + (rand() - 0.5) * 0.4, 0, 1);
      put("shrub", x, z, (0.6 + rand() * 1.4) * (0.6 + vigor * 0.5), vary([0.3 + 0.26 * t, 0.42 - 0.06 * t, 0.24 + 0.26 * t], 0.85 + rand() * 0.3), 1 + rand() * 0.4);
    }
    for (let n = Math.floor(isle.marsh[i] * 30 + rand()); n > 0; n--) {
      const [x, z] = spot();
      if (Wd[cellAt(x, z)] > 0) continue;
      put("reeds", x, z, 1.4 + rand() * 1.2, vary([0.62, 0.66, 0.34], 0.85 + rand() * 0.3));
    }
    for (let n = Math.floor(isle.bare[i] * (1 - isle.sand[i]) * 10 + rand()); n > 0; n--) {
      const [x, z] = spot();
      if (!dry(x, z)) continue;
      const v = 0.55 + rand() * 0.2;
      put("rock", x, z, 0.6 + rand() ** 3 * 4.5, [v * 1.02, v, v * 0.95], 0.8 + rand() * 0.5);
    }
  }
  const models = { conifer: conifer(), broadleaf: broadleaf(), shrub: shrub(), reeds: reeds(), rock: rock() };
  const grey = speckle(), props = propMaterial(grey);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  const counts = {}, meshes = [];
  for (const { kind, list } of patches.values()) {
    for (let k = list.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [list[k], list[j]] = [list[j], list[k]];
    }
    const mesh = new THREE.InstancedMesh(models[kind], props, list.length);
    list.forEach((o, k) => {
      mesh.setMatrixAt(k, m4.compose(p.set(o.x, o.y, o.z), q.setFromAxisAngle(up, o.yaw), s.set(o.size * o.squash, o.size, o.size * o.squash)));
      mesh.setColorAt(k, c.setRGB(o.r, o.g, o.b));
    });
    mesh.computeBoundingSphere();
    mesh.userData = { tall: list.reduce((t, o) => Math.max(t, o.size), 0), total: list.length };
    group.add(mesh);
    meshes.push(mesh);
    counts[kind] = (counts[kind] ?? 0) + list.length;
  }
  function cull(eye, pxPerM, far) {
    for (const m of meshes) {
      const { tall, total } = m.userData, d = Math.max(1, m.boundingSphere.center.distanceTo(eye) - m.boundingSphere.radius);
      m.visible = d < far && (tall / d) * pxPerM > 0.6;
      m.count = Math.ceil(total * Math.min(1, ((tall * 30) / d) ** 2));
    }
  }

  // ---------- people and animals ----------
  const figure = propMaterial(grey, { shrink: false });
  const shadow = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
  const taken = [];
  const place = (test, far) => {
    for (let t = 0; t < 4000; t++) {
      const x = 24 + Math.floor(rand() * 80), y = 24 + Math.floor(rand() * 80), i = y * N + x, at = [center(x), center(y)];
      if (test(i) && taken.every((o) => Math.hypot(o[0] - at[0], o[1] - at[1]) > far)) { taken.push(at); return at; }
    }
    return [0, 0];
  };
  const open = (need) => (i) => Wd[i] <= 0 && H[i] > 2 && isle.grass[i] > need;
  const walkers = [];
  const spawn = (rig, [x, z], o) => {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(o.shadow, 8).rotateX(-Math.PI / 2), shadow);
    disc.position.y = 0.05;
    rig.root.add(disc);
    group.add(rig.root);
    const w = new Walker(rig, x, z, o, { ground, dry, rand });
    walkers.push(w);
    return w;
  };
  const folk = people.map(({ name, color }) =>
    Object.assign(spawn(person(figure, color), place(open(0.35), 700), { speed: 1.3, fast: 1.3, range: 260, idle: 9, stride: 2.4, shadow: 0.4 }), { name, color }),
  );
  const deer = [];
  for (let herd = 0; herd < 2; herd++) {
    const [hx, hz] = place(open(0.3), 300);
    for (let k = 0; k < 4; k++) deer.push(spawn(beast(figure, DEER), [hx + (rand() - 0.5) * 12, hz + (rand() - 0.5) * 12], { speed: 0.7, fast: 9, range: 90, idle: 12, stride: 2, shadow: 0.7 }));
  }
  const [wx, wz] = place(open(0.2), 300);
  for (let k = 0; k < 3; k++) spawn(beast(figure, WOLF), [wx + k * 3, wz], { speed: 1.8, fast: 8, range: 500, idle: 6, stride: 2.6, shadow: 0.55 });

  function update(dt) {
    // Deer bolt from anyone who comes too close.
    for (const d of deer)
      for (const f of folk)
        if (!d.run && Math.hypot(d.x - f.x, d.z - f.z) < 35) d.flee(f.x, f.z);
    for (const w of walkers) w.update(dt);
  }

  return { group, ground, floor, size: S, people: folk, update, cull, counts };
}

// Something that wanders about a home: walks to a spot, lingers, picks another. Water turns it back.
class Walker {
  constructor(rig, x, z, o, env) {
    Object.assign(this, o, { rig, env, x, z, homeX: x, homeZ: z, tx: x, tz: z, wait: env.rand() * 4, run: 0, phase: 0, heading: env.rand() * Math.PI * 2 });
    this.update(0);
  }
  pick() {
    const { rand, dry } = this.env;
    for (let k = 0; k < 12; k++) {
      const a = rand() * Math.PI * 2, d = this.range * (0.2 + rand() * 0.8);
      const x = this.homeX + Math.cos(a) * d, z = this.homeZ + Math.sin(a) * d;
      if (dry(x, z) && dry((x + this.x) / 2, (z + this.z) / 2)) { this.tx = x; this.tz = z; return; }
    }
    this.tx = this.homeX;
    this.tz = this.homeZ;
  }
  flee(fx, fz) {
    const d = Math.hypot(this.x - fx, this.z - fz) || 1;
    this.tx = this.x + ((this.x - fx) / d) * 70;
    this.tz = this.z + ((this.z - fz) / d) * 70;
    this.homeX = this.tx;
    this.homeZ = this.tz;
    this.run = 8;
    this.wait = 0;
  }
  update(dt) {
    let pace = 0;
    this.run = Math.max(0, this.run - dt);
    if (this.wait > 0) this.wait -= dt;
    else {
      const dx = this.tx - this.x, dz = this.tz - this.z, d = Math.hypot(dx, dz);
      if (d < 0.3) {
        this.wait = this.idle * (0.4 + this.env.rand());
        this.pick();
      } else {
        const speed = this.run ? this.fast : this.speed, step = Math.min(d, speed * dt);
        const nx = this.x + (dx / d) * step, nz = this.z + (dz / d) * step;
        if (this.env.dry(nx, nz)) { this.x = nx; this.z = nz; } else this.pick();
        const turn = ((Math.atan2(dx, dz) - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        this.heading += turn * Math.min(1, dt * 6);
        this.phase += step * this.stride;
        pace = speed / this.speed > 2 ? 1.6 : 1;
      }
    }
    this.rig.root.position.set(this.x, this.env.ground(this.x, this.z), this.z);
    this.rig.root.rotation.y = this.heading;
    this.rig.pose(this.phase, pace, this.wait > 0);
  }
  focus(out) {
    return out.set(this.x, this.env.ground(this.x, this.z) + 1.1, this.z);
  }
}

// ---------- models, one unit tall, flat shaded ----------
function part(geometry, color, repeat = 1) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.computeVertexNormals();
  const n = g.attributes.position.count, col = new Float32Array(n * 3), tint = new THREE.Color(color), uv = g.attributes.uv;
  for (let i = 0; i < n; i++) {
    col.set([tint.r, tint.g, tint.b], i * 3);
    uv.setXY(i, uv.getX(i) * repeat, uv.getY(i) * repeat);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}
function merge(parts) {
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv", "color"]) {
    const arrays = parts.map((p) => p.attributes[name].array);
    const all = new Float32Array(arrays.reduce((s, a) => s + a.length, 0));
    arrays.reduce((o, a) => (all.set(a, o), o + a.length), 0);
    out.setAttribute(name, new THREE.BufferAttribute(all, parts[0].attributes[name].itemSize));
  }
  return out;
}
const conifer = () => merge([
  part(new THREE.CylinderGeometry(0.035, 0.05, 0.3, 4, 1, true).translate(0, 0.15, 0), 0x5a3e26, 2),
  part(new THREE.ConeGeometry(0.3, 0.55, 5).translate(0, 0.42, 0), 0x2c5a2e, 3),
  part(new THREE.ConeGeometry(0.21, 0.45, 5, 1, true).translate(0, 0.775, 0), 0x336634, 3),
]);
const broadleaf = () => merge([
  part(new THREE.CylinderGeometry(0.04, 0.06, 0.45, 4, 1, true).translate(0, 0.225, 0), 0x5e4228, 2),
  part(new THREE.IcosahedronGeometry(0.36, 0).scale(1, 0.85, 1).translate(0, 0.66, 0), 0x4a7a34, 3),
]);
const shrub = () => merge([part(new THREE.IcosahedronGeometry(0.5, 0).scale(1.1, 0.75, 1).translate(0, 0.37, 0), 0xffffff, 2)]);
const reeds = () => merge([0, 1, 2, 3, 4].map((k) => {
  const a = k * 2.4, r = 0.08 + (k % 3) * 0.09, h = 0.65 + ((k * 37) % 10) / 28;
  return part(new THREE.ConeGeometry(0.035, h, 3, 1, true).translate(Math.cos(a) * r, h / 2, Math.sin(a) * r), 0xffffff, 1);
}));
function rock() {
  const g = new THREE.IcosahedronGeometry(0.5, 0);
  const p = g.attributes.position;
  // Knock each corner in or out by an amount fixed by where it is, so faces that share it stay joined.
  for (let i = 0; i < p.count; i++) {
    const k = 0.75 + (Math.abs(Math.sin(p.getX(i) * 12.9 + p.getY(i) * 78.2 + p.getZ(i) * 37.7) * 43758.5) % 1) * 0.5;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7 + 0.12, p.getZ(i) * k);
  }
  return merge([part(g, 0xffffff, 1)]);
}

// People and beasts are jointed boxes: limbs hang from hips and shoulders so a stride is a swing about the joint.
const box = (w, h, d, color, y0) => part(new THREE.BoxGeometry(w, h, d).translate(0, y0 + h / 2, 0), color, 1);
function limb(root, material, geometry, x, y, z = 0) {
  const joint = new THREE.Group();
  joint.position.set(x, y, z);
  joint.add(new THREE.Mesh(geometry, material));
  root.add(joint);
  return joint;
}
function person(material, color) {
  const root = new THREE.Group(), add = (g) => root.add(new THREE.Mesh(g, material));
  const leg = box(0.13, 0.86, 0.15, 0x4a3a2a, -0.86), arm = box(0.1, 0.58, 0.11, color, -0.58);
  const legs = [limb(root, material, leg, -0.1, 0.86), limb(root, material, leg, 0.1, 0.86)];
  const arms = [limb(root, material, arm, -0.26, 1.42), limb(root, material, arm, 0.26, 1.42)];
  add(box(0.4, 0.6, 0.24, color, 0.84));
  add(box(0.22, 0.24, 0.22, 0xd8a878, 1.46));
  add(box(0.24, 0.07, 0.24, 0x3a2a1a, 1.68));
  return {
    root,
    pose(phase, pace) {
      const s = Math.sin(phase) * 0.6 * Math.min(1, pace);
      legs[0].rotation.x = s; legs[1].rotation.x = -s;
      arms[0].rotation.x = -s * 0.8; arms[1].rotation.x = s * 0.8;
    },
  };
}
const DEER = { coat: 0x8a5a32, leg: 0x6a4424, body: [0.42, 0.48, 1.3], legH: 0.82, neck: 0.55, head: [0.18, 0.2, 0.36], tail: 0xe8e0d0 };
const WOLF = { coat: 0x6e6a62, leg: 0x55524c, body: [0.34, 0.38, 1.05], legH: 0.55, neck: 0.3, head: [0.2, 0.2, 0.36], tail: 0x6e6a62 };
function beast(material, k) {
  const root = new THREE.Group(), [bw, bh, bl] = k.body, top = k.legH + bh;
  root.add(new THREE.Mesh(part(new THREE.BoxGeometry(bw, bh, bl).translate(0, k.legH + bh / 2, 0), k.coat, 1), material));
  const leg = box(0.08, k.legH, 0.09, k.leg, -k.legH);
  const legs = [[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => limb(root, material, leg, sx * (bw / 2 - 0.05), k.legH, sz * (bl / 2 - 0.1)));
  const neck = new THREE.Group();
  neck.position.set(0, top - 0.08, bl / 2 - 0.08);
  neck.add(new THREE.Mesh(box(0.16, k.neck, 0.16, k.coat, 0), material));
  const head = new THREE.Mesh(part(new THREE.BoxGeometry(...k.head).translate(0, k.neck, k.head[2] / 2 - 0.06), k.coat, 1), material);
  neck.add(head);
  root.add(neck);
  const tail = limb(root, material, box(0.07, 0.3, 0.07, k.tail, -0.3), 0, top - 0.04, -bl / 2);
  tail.rotation.x = -0.5;
  return {
    root,
    pose(phase, pace, idle) {
      const s = Math.sin(phase) * 0.5 * Math.min(1.4, pace);
      legs[0].rotation.x = legs[3].rotation.x = s;
      legs[1].rotation.x = legs[2].rotation.x = -s;
      // Heads go down to graze while they stand.
      neck.rotation.x += ((idle ? 1.9 : 0.45) - neck.rotation.x) * 0.05;
    },
  };
}
