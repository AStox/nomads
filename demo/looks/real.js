// Field guide: the island as it would really look, shot from a hilltop through a tilt-shift lens. Photographed ground,
// grown trees with real bark and leaves, the sky lighting everything, water that mirrors it.
import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { Tree } from "@dgreenheck/ez-tree";
import { merged, rockGeometry, scatter, tuft } from "./stage.js";

const PH = "https://dl.polyhaven.org/file/ph-assets";
const SKIES = { day: `${PH}/HDRIs/hdr/2k/kloofendal_48d_partly_cloudy_puresky_2k.hdr`, evening: `${PH}/HDRIs/hdr/2k/evening_road_01_puresky_2k.hdr` };
// One photographed ground per cover, in the order the ground shader weighs them: forest floor, heath, meadow, mud,
// rock, sand.
const GROUND = [
  ["forest_leaves_02", "diffuse"], ["sparse_grass", "diff"], ["forrest_ground_01", "diff"],
  ["forest_ground_04", "diff"], ["aerial_rocks_02", "diff"], ["coast_sand_01", "diff"],
].map(([id, diff]) => [`${PH}/Textures/jpg/1k/${id}/${id}_${diff}_1k.jpg`, `${PH}/Textures/jpg/1k/${id}/${id}_nor_gl_1k.jpg`]);
const WAVES = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r186/examples/textures/waternormals.jpg";
// EZ-Tree presets for each kind the stage plants, and for the shrubs.
const PRESETS = { oak: ["Oak Medium", "Oak Large"], ash: ["Ash Medium", "Ash Large"], aspen: ["Aspen Medium", "Aspen Small"], pine: ["Pine Medium", "Pine Large"] };
const BUSHES = ["Bush 1", "Bush 2", "Bush 3"];
const WHITE = new THREE.Color(1, 1, 1);

const image = (url) => new Promise((ok, fail) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => ok(img); img.onerror = fail; img.src = url; });
// Images of one size packed into layers of a single texture, so the ground shader can weigh them all in one sampler.
function layers(images, srgb, anisotropy) {
  const S = 1024, c = Object.assign(document.createElement("canvas"), { width: S, height: S }), g = c.getContext("2d", { willReadFrequently: true });
  const data = new Uint8Array(S * S * 4 * images.length);
  images.forEach((img, k) => { g.drawImage(img, 0, 0, S, S); data.set(g.getImageData(0, 0, S, S).data, k * S * S * 4); });
  const t = new THREE.DataArrayTexture(data, S, S, images.length);
  Object.assign(t, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, anisotropy, needsUpdate: true });
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// Where the sun sits in a sky photograph: its brightest texel, turned into a direction.
function sunIn(hdr) {
  const { data, width: W, height: H } = hdr.image, half = data instanceof Uint16Array;
  const f = half ? (i) => THREE.DataUtils.fromHalfFloat(data[i]) : (i) => data[i];
  let best = 0, at = 0;
  for (let i = 0; i < W * H; i++) { const l = f(i * 4) + f(i * 4 + 1) + f(i * 4 + 2); if (l > best) { best = l; at = i; } }
  const u = ((at % W) + 0.5) / W, v = 1 - (Math.floor(at / W) + 0.5) / H;
  const az = (u - 0.5) * Math.PI * 2, el = (v - 0.5) * Math.PI;
  // The horizon's average color, for the haze.
  const haze = new THREE.Color(0, 0, 0), row = Math.floor(H * 0.49);
  for (let x = 0; x < W; x++) { const i = (row * W + x) * 4; haze.r += f(i); haze.g += f(i + 1); haze.b += f(i + 2); }
  haze.multiplyScalar(1 / W);
  return { dir: new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize(), haze };
}

export async function dress(stage, { evening = false, view }) {
  const { scene, renderer, sun } = stage, anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const [hdr, waves, ...ground] = await Promise.all([new HDRLoader().loadAsync(evening ? SKIES.evening : SKIES.day), new THREE.TextureLoader().loadAsync(WAVES), ...GROUND.flat().map(image)]);
  const { dir, haze } = sunIn(hdr);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = hdr;
  scene.environment = new THREE.PMREMGenerator(renderer).fromEquirectangular(hdr).texture;
  scene.environmentIntensity = evening ? 0.5 : 0.55;
  scene.fog = new THREE.FogExp2(haze.clone().multiplyScalar(evening ? 0.8 : 1), { island: 0.000055, valley: 0.00016, camp: 0.00022 }[view]);
  sun.color.set(evening ? 0xffb070 : 0xfff1dd);
  sun.intensity = evening ? 3.4 : 4.5;
  const sunDir = dir.y < 0.06 ? dir.setY(0.06).normalize() : dir;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = evening ? 1.05 : 0.95;
  Object.assign(stage.grade.uniforms, { uSaturation: { value: 1.12 }, uContrast: { value: 1.06 }, uVignette: { value: 0.32 } });
  stage.grade.uniforms.uShadows.value.set(-0.01, 0.0, 0.02);
  stage.grade.uniforms.uHighlights.value.set(0.02, 0.01, -0.01);
  stage.bloom.strength = evening ? 0.35 : 0.18;

  const albedo = layers(ground.filter((_, k) => k % 2 === 0), true, anisotropy), normals = layers(ground.filter((_, k) => k % 2 === 1), false, anisotropy);
  const [coverA, coverB] = stage.coverTextures(), height = stage.heightTexture(), river = stage.riverTexture();
  const land = new THREE.Mesh(stage.terrainGeometry(), groundMaterial({ coverA, coverB, river, albedo, normals }));
  land.receiveShadow = land.castShadow = true;
  scene.add(land);

  waves.wrapS = waves.wrapT = THREE.RepeatWrapping;
  const water = waterMaterial({ height, size: stage.SIZE, waves, evening });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(stage.SIZE * 12, stage.SIZE * 12, 64, 64).rotateX(-Math.PI / 2), water);
  for (const mesh of [sea, new THREE.Mesh(stage.lakeGeometry(), water), new THREE.Mesh(stage.riverGeometry(), water)]) { mesh.receiveShadow = true; scene.add(mesh); }

  // ---------- trees ----------
  // Grown trees where the view can make out their limbs; farther off, crowns of soft lumps; across the island, where a
  // tree is a pixel or two, a single lump.
  const [close, mid, far] = stage.levels(stage.trees, { island: [0, 0], valley: [460, 2800], camp: [340, 2000] }[view], 380);
  const grown = close.length ? Object.fromEntries(Object.entries(PRESETS).map(([kind, names]) => [kind, names.map((name) => growTree(name, sunDir))])) : null;
  // Leaves vary a little from tree to tree, and aspens wear summer green rather than their preset's autumn gold.
  const leafy = (t, c) => (t.kind === "aspen" ? c.setRGB(0.62, 0.95, 0.5) : c.setRGB(1, 1, 1)).multiplyScalar(0.8 + t.tint * 0.35);
  const barky = (t, c) => c.setScalar(0.85 + t.tint * 0.3);
  const plant = (model, list) => {
    for (const part of model.parts) scene.add(scatter(part.geometry, part.material, list, (t) => { const s = t.tall / model.tall; return [s, s * (0.9 + t.tint * 0.2), s]; }, part.leaf ? leafy : barky));
  };
  const crowns = { oak: 0x3f5a26, ash: 0x4a6a2c, aspen: 0x5f7a34 };
  for (const kind of Object.keys(PRESETS)) {
    grown?.[kind].forEach((model, k, all) => plant(model, close.filter((t) => t.kind === kind && Math.floor(t.tint * all.length) === k)));
    plant(kind === "pine" ? conifer(1) : canopy(crowns[kind], 1), mid.filter((t) => t.kind === kind));
    plant(kind === "pine" ? conifer(0) : canopy(crowns[kind], 0), far.filter((t) => t.kind === kind));
  }

  // ---------- shrubs, rocks, and near the camp, grass ----------
  const [nearShrubs, midShrubs] = stage.levels(stage.shrubs, { island: [0, 0], valley: [150, 1100], camp: [90, 700] }[view], 260);
  // Heather goes purple-brown on the exposed ground; scrub stays green in the lee.
  const heather = (s, c) => c.setRGB(0.95 + s.heath * 0.15, 0.95 - s.heath * 0.35, 0.9 - s.heath * 0.1);
  const bushy = (model, list) => {
    for (const part of model.parts) scene.add(scatter(part.geometry, part.material, list, (s) => { const k = s.tall / model.tall; return [k * 1.3, k, k * 1.3]; }, heather));
  };
  if (nearShrubs.length) BUSHES.map((name) => growTree(name, sunDir)).forEach((model, k) => bushy(model, nearShrubs.filter((s) => Math.floor(s.tint * BUSHES.length) === k)));
  bushy(canopy(0x55603a, 1, false), midShrubs);
  const stone = rockGeometry(), rockMat = new THREE.MeshStandardMaterial({ map: srgb(new THREE.Texture(ground[8])), normalMap: new THREE.Texture(ground[9]), roughness: 0.9 });
  rockMat.map.needsUpdate = rockMat.normalMap.needsUpdate = true;
  const [, rocks] = stage.levels(stage.rocks, { island: [0, 0], valley: [0, 1600], camp: [0, 1200] }[view]);
  scene.add(scatter(stone, rockMat, rocks, (r) => [r.size, r.size * 0.7, r.size * 1.1], (r, c) => c.setScalar(0.75 + r.tint * 0.35)));

  if (view !== "island") {
    const { grass, flowers, pebbles, logs } = stage.nearby(stage.camp.at, view === "camp" ? 100 : 130, view === "camp" ? 6 : 2);
    scene.add(scatter(tuft(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }), grass, (g) => [g.tall, g.tall, g.tall], (g, col) => col.setHSL(0.24 + g.tint * 0.06, 0.5, 0.28 + g.tint * 0.12)));
    scene.add(scatter(bloom(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }), flowers, (f) => [f.tall, f.tall, f.tall], (f, col) => col.setHSL([0.13, 0.0, 0.75, 0.6][Math.floor(f.hue * 4)], 0.8, 0.7)));
    scene.add(scatter(stone, rockMat, pebbles, (p) => [p.size, p.size * 0.6, p.size], (p, col) => col.setScalar(0.8 + p.tint * 0.3)));
    const bark = grown?.oak[0].parts[0].material ?? new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
    scene.add(scatter(new THREE.CylinderGeometry(0.22, 0.28, 1, 8).rotateZ(Math.PI / 2), bark, logs, (l) => [l.length, 1, 1], (l, col) => col.setScalar(0.9)));
    camp(stage, scene, bark);
  }
  return { sunDir };
}

// ---------- materials ----------
function groundMaterial({ coverA, coverB, river, albedo, normals }) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, { uCoverA: { value: coverA }, uCoverB: { value: coverB }, uRiver: { value: river }, uAlbedo: { value: albedo }, uNormals: { value: normals } });
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float sky;\nvarying float vSky;\nvarying vec2 vCover;\nvarying vec3 vWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSky = sky;\nvCover = uv;\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", /* glsl */ `#include <common>
        uniform sampler2D uCoverA, uCoverB, uRiver;
        uniform highp sampler2DArray uAlbedo, uNormals;
        varying float vSky;
        varying vec2 vCover;
        varying vec3 vWorld;
        float w6[6];
        vec2 stA, stB;
        float bump(vec2 p) {
          vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
          float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5), b = fract(sin(dot(i + vec2(1, 0), vec2(127.1, 311.7))) * 43758.5);
          float c = fract(sin(dot(i + vec2(0, 1), vec2(127.1, 311.7))) * 43758.5), d = fract(sin(dot(i + vec2(1, 1), vec2(127.1, 311.7))) * 43758.5);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }`)
      .replace("#include <map_fragment>", /* glsl */ `
        vec4 ca = texture2D(uCoverA, vCover), cb = texture2D(uCoverB, vCover);
        float rv = texture2D(uRiver, vCover).r;
        w6[0] = ca.r; w6[1] = ca.g; w6[2] = ca.b; w6[3] = ca.a + rv * 1.5; w6[4] = cb.r * (1.0 - cb.a); w6[5] = cb.g * 1.3 + cb.a * 1.5;
        // Two tilings of every ground at different sizes and angles, so no pattern repeats across a hillside.
        stA = vWorld.xz / 7.0;
        stB = mat2(0.76, 0.65, -0.65, 0.76) * vWorld.xz / 29.0;
        vec3 ground = vec3(0.0);
        float total = 0.0;
        for (int k = 0; k < 6; k++) {
          vec3 t = mix(texture(uAlbedo, vec3(stA, float(k))).rgb, texture(uAlbedo, vec3(stB, float(k))).rgb, 0.45);
          // Where two grounds meet, the brighter, higher bits of each win: pebbles through grass, grass through mud.
          float wk = pow(w6[k], 3.0) * (0.4 + dot(t, vec3(0.6)));
          w6[k] = wk;
          ground += t * wk;
          total += wk;
        }
        ground /= max(total, 1e-5);
        // Meadows green where the soil holds water and paler where it doesn't; broad patches of lighter and darker
        // ground; the beds of lakes and the sea darker.
        ground *= mix(vec3(1.0), mix(vec3(0.95, 1.0, 0.72), vec3(0.78, 1.04, 0.64), cb.b), w6[2] / max(total, 1e-5));
        ground *= 0.82 + 0.36 * bump(vWorld.xz / 170.0);
        ground *= 1.0 - 0.45 * cb.a;
        diffuseColor.rgb *= ground * mix(0.45, 1.0, vSky);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.95, 0.4, clamp(rv * 1.5 + cb.a, 0.0, 1.0));")
      .replace("#include <normal_fragment_maps>", /* glsl */ `
        {
          vec3 nt = vec3(0.0);
          for (int k = 0; k < 6; k++) nt += (texture(uNormals, vec3(stA, float(k))).xyz * 2.0 - 1.0) * w6[k];
          nt = normalize(vec3(nt.xy / max(total, 1e-5) * 1.1, 1.0));
          vec3 T = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz), B = normalize(cross(T, normal));
          T = cross(normal, B);
          normal = normalize(T * nt.x + B * nt.y + normal * nt.z);
        }`);
  };
  return material;
}

function waterMaterial({ height, size, waves, evening }) {
  const material = new THREE.MeshStandardMaterial({ color: 0x0b3440, roughness: 0.12, metalness: 0, envMapIntensity: 0.7, transparent: true });
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, { uHeight: { value: height }, uSize: { value: size }, uWaves: { value: waves } });
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uHeight, uWaves;\nuniform float uSize;\nvarying vec3 vWorld;\nfloat foam;")
      .replace("#include <map_fragment>", /* glsl */ `
        vec2 wuv = vWorld.xz / uSize + 0.5;
        float rim = 1.0 - smoothstep(0.0, 0.12, min(min(wuv.x, wuv.y), min(1.0 - wuv.x, 1.0 - wuv.y)));
        float depth = max(vWorld.y - texture2D(uHeight, clamp(wuv, 0.0, 1.0)).r, rim * 60.0);
        vec3 shallow = ${evening ? "vec3(0.03, 0.08, 0.08)" : "vec3(0.03, 0.12, 0.10)"}, deep = vec3(0.004, 0.03, 0.05);
        diffuseColor.rgb = mix(shallow, deep, smoothstep(0.0, 5.0, depth));
        foam = smoothstep(0.25, 0.0, depth) * step(0.02, depth);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8), foam * 0.7);
        diffuseColor.a = clamp(max(mix(0.55, 0.97, smoothstep(0.0, 3.0, depth)), foam * 0.9), 0.0, 1.0);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.12, 0.5, foam);")
      .replace("#include <normal_fragment_maps>", /* glsl */ `
        {
          vec3 a = texture2D(uWaves, vWorld.xz / 38.0).xyz * 2.0 - 1.0, b = texture2D(uWaves, vWorld.xz / 11.0 + 0.37).xyz * 2.0 - 1.0;
          vec3 nt = normalize(vec3((a.xy + b.xy * 0.5) * 0.45, 1.0));
          vec3 T = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz), B = normalize(cross(T, normal));
          T = cross(normal, B);
          normal = normalize(T * nt.x + B * nt.y + normal * nt.z);
        }`);
  };
  return material;
}

// ---------- growing things ----------
// A tree from a preset, as unit-free parts for instancing: bark and leaves, with leaf normals bent outward from the
// crown so it shades like a mass of foliage, and light glowing through the leaves when the sun is behind them.
function growTree(name, sunDir) {
  const tree = new Tree();
  tree.loadPreset(name);
  // Fuller crowns than the presets grow, so woods read as woods rather than an orchard.
  if (!name.startsWith("Bush")) {
    tree.options.leaves.count = Math.round(tree.options.leaves.count * 1.5);
    tree.options.leaves.size *= 1.12;
    tree.generate();
  }
  const box = new THREE.Box3().setFromObject(tree), tall = box.max.y - box.min.y;
  const bark = tree.branchesMesh.material, leaves = tree.leavesMesh.material;
  // The preset's ambient occlusion goes easy, or trunks in their own canopy's shade turn black.
  const barkMat = new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, roughnessMap: bark.roughnessMap, aoMap: bark.aoMap, aoMapIntensity: 0.35, color: bark.color, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ map: leaves.map, color: leaves.color, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7 });
  leafMat.onBeforeCompile = (s) => {
    s.uniforms.uSun = { value: sunDir };
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uSun;")
      .replace("#include <lights_fragment_end>", /* glsl */ `#include <lights_fragment_end>
        float through = pow(max(dot(normalize(vViewPosition), -normalize((viewMatrix * vec4(uSun, 0.0)).xyz)), 0.0), 5.0);
        reflectedLight.directDiffuse += diffuseColor.rgb * vec3(1.0, 0.95, 0.7) * through * 1.2;`);
  };
  const leafGeo = tree.leavesMesh.geometry.clone(), p = leafGeo.attributes.position, n = leafGeo.attributes.normal;
  const crown = new THREE.Vector3(), v = new THREE.Vector3(), r = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) crown.add(v.fromBufferAttribute(p, i));
  crown.multiplyScalar(1 / p.count);
  for (let i = 0; i < p.count; i++) {
    r.fromBufferAttribute(p, i).sub(crown).normalize();
    v.fromBufferAttribute(n, i).multiplyScalar(0.35).addScaledVector(r, 0.65).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  // Stood on the ground and sunk a touch, so trunks don't float where the ground slopes.
  for (const g of [tree.branchesMesh.geometry, leafGeo]) g.translate(0, -box.min.y - tall * 0.015, 0);
  return { tall, parts: [{ geometry: tree.branchesMesh.geometry, material: barkMat }, { geometry: leafGeo, material: leafMat, leaf: true }] };
}
// Farther off, a crown of soft lumps, or a spire for a conifer, in the canopy's own green; at detail 0, where a tree
// is a few pixels, one lump reaching to the ground.
function canopy(color, detail, trunk = true) {
  const leaves = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  if (!detail) return { tall: 1, parts: [{ geometry: new THREE.IcosahedronGeometry(0.5, 0).scale(0.72, 1.05, 0.72).translate(0, 0.5, 0), material: leaves, leaf: true }] };
  const crown = merged([new THREE.IcosahedronGeometry(0.34, 1).scale(1, 0.8, 1).translate(0, 0.62, 0), new THREE.IcosahedronGeometry(0.24, 1).translate(0.16, 0.5, 0.08)]);
  const parts = [{ geometry: crown, material: leaves, leaf: true }];
  if (trunk) parts.push({ geometry: new THREE.CylinderGeometry(0.035, 0.05, 0.4, 5).translate(0, 0.2, 0), material: new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 1 }) });
  return { tall: 1, parts };
}
function conifer(detail) {
  const needles = new THREE.MeshStandardMaterial({ color: 0x2c4424, roughness: 0.9 });
  if (!detail) return { tall: 1, parts: [{ geometry: new THREE.ConeGeometry(0.24, 1, 6).translate(0, 0.5, 0), material: needles, leaf: true }] };
  const crown = merged([new THREE.ConeGeometry(0.26, 0.6, 8).translate(0, 0.45, 0), new THREE.ConeGeometry(0.19, 0.45, 8).translate(0, 0.78, 0)]);
  return { tall: 1, parts: [{ geometry: crown, material: needles, leaf: true }, { geometry: new THREE.CylinderGeometry(0.03, 0.045, 0.3, 5).translate(0, 0.15, 0), material: new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 1 }) }] };
}
function bloom() {
  const g = merged([new THREE.CylinderGeometry(0.01, 0.01, 0.9, 3).translate(0, 0.45, 0), new THREE.IcosahedronGeometry(0.09, 0).translate(0, 0.92, 0)]);
  g.setAttribute("color", new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count }, (_, i) => (i < 18 ? [0.25, 0.5, 0.2] : [1, 1, 1])).flat(), 3));
  return g;
}
const srgb = (t) => { t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };

// ---------- the camp ----------
function camp(stage, scene, bark) {
  const canvas = new THREE.MeshStandardMaterial({ color: 0xcdb892, roughness: 0.9, side: THREE.DoubleSide });
  const add = (geo, mat, p, yaw = 0) => { const mesh = new THREE.Mesh(geo, mat); mesh.position.copy(p); mesh.rotation.y = yaw; mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh); return mesh; };
  for (const { at, yaw, size } of stage.camp.tents) {
    add(new THREE.ConeGeometry(size * 0.55, size, 9, 1, true), canvas, at.clone().add(new THREE.Vector3(0, size / 2 - 0.05, 0)), yaw);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2, pole = add(new THREE.CylinderGeometry(0.03, 0.03, size * 1.25, 4), bark, at.clone().add(new THREE.Vector3(0, size * 0.55, 0)));
      pole.rotation.set(Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14);
    }
  }
  const fire = stage.camp.fire, ember = new THREE.MeshStandardMaterial({ color: 0x331a0a, emissive: 0xff6a1a, emissiveIntensity: 6 });
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * Math.PI * 2;
    add(new THREE.IcosahedronGeometry(0.22, 1), new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.9 }), fire.clone().add(new THREE.Vector3(Math.cos(a) * 0.9, 0.1, Math.sin(a) * 0.9)));
  }
  for (let k = 0; k < 4; k++) add(new THREE.CylinderGeometry(0.08, 0.1, 1.1, 6).rotateZ(Math.PI / 2 - 0.3), bark, fire.clone().add(new THREE.Vector3(0, 0.25, 0)), (k / 4) * Math.PI);
  add(new THREE.ConeGeometry(0.35, 0.9, 7), ember, fire.clone().add(new THREE.Vector3(0, 0.45, 0))).castShadow = false;
  const glow = new THREE.PointLight(0xff8a3a, 60, 30, 2);
  glow.position.copy(fire).add(new THREE.Vector3(0, 1.1, 0));
  scene.add(glow);
  const pile = stage.camp.woodpile;
  for (let k = 0; k < 12; k++) add(new THREE.CylinderGeometry(0.12, 0.12, 1.6, 7).rotateX(Math.PI / 2), bark, pile.clone().add(new THREE.Vector3((k % 4) * 0.26 - 0.4, 0.13 + Math.floor(k / 4) * 0.23, 0)));
  const tunics = [0x9e3b2f, 0x2f4a6d, 0xa8812a, 0x4e6b3a, 0x6b3f5e].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
  const skin = new THREE.MeshStandardMaterial({ color: 0xc89a78, roughness: 0.7 });
  stage.camp.people.forEach(({ at, yaw }, k) => {
    add(new THREE.CapsuleGeometry(0.2, 0.9, 4, 10), tunics[k], at.clone().add(new THREE.Vector3(0, 0.7, 0)), yaw);
    add(new THREE.SphereGeometry(0.13, 12, 10), skin, at.clone().add(new THREE.Vector3(0, 1.5, 0)), yaw);
  });
}
