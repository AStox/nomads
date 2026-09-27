// Board game: the island as a painted relief map on a table. Clean pastel ground in contour lines, trees as turned
// wooden pieces, water in crisp bands with a white shoreline, soft studio light. Built to be read at a glance.
import * as THREE from "three";
import { rockGeometry, scatter } from "./stage.js";

function studioSky(evening) {
  const c = Object.assign(document.createElement("canvas"), { width: 512, height: 256 }), g = c.getContext("2d");
  const fade = g.createLinearGradient(0, 0, 0, 128);
  fade.addColorStop(0, evening ? "#7d86c4" : "#9fcaf0");
  fade.addColorStop(1, evening ? "#f6d2b4" : "#eef6fb");
  g.fillStyle = fade;
  g.fillRect(0, 0, 512, 256);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function dress(stage, { evening = false, view }) {
  const { scene, renderer, sun } = stage;
  const sky = studioSky(evening);
  scene.background = sky;
  scene.environment = new THREE.PMREMGenerator(renderer).fromEquirectangular(sky).texture;
  scene.environmentIntensity = 0.35;
  const sunDir = new THREE.Vector3(...(evening ? [-0.75, 0.3, 0.6] : [-0.45, 0.72, 0.52])).normalize();
  sun.color.set(evening ? 0xffc89a : 0xfffaf0);
  sun.intensity = evening ? 2.2 : 2.6;
  scene.add(new THREE.HemisphereLight(evening ? 0xc8b8e8 : 0xe2f0ff, evening ? 0x8a7050 : 0xa8c088, 0.6));
  scene.fog = new THREE.FogExp2(evening ? 0xf0d0c0 : 0xe8f2f8, { island: 0.00003, valley: 0.00006, camp: 0.00008 }[view]);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  Object.assign(stage.grade.uniforms, { uSaturation: { value: 1.2 }, uContrast: { value: 1.05 }, uVignette: { value: 0.22 } });
  stage.bloom.strength = 0.15;

  const [coverA, coverB] = stage.coverTextures(), height = stage.heightTexture(), river = stage.riverTexture();
  const land = new THREE.Mesh(stage.terrainGeometry(), groundMaterial({ coverA, coverB, river }));
  land.receiveShadow = land.castShadow = true;
  scene.add(land);
  const water = waterMaterial({ height, size: stage.SIZE, evening });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(stage.SIZE * 12, stage.SIZE * 12, 64, 64).rotateX(-Math.PI / 2), water), new THREE.Mesh(stage.lakeGeometry(), water), new THREE.Mesh(stage.riverGeometry(), water));

  // Trees as turned pieces: a ball on a peg for the broadleaf, a stacked cone for the pine. Farther pieces are turned
  // with fewer facets, and the farthest lose their pegs.
  const wood = new THREE.MeshStandardMaterial({ color: 0x9a7452, roughness: 0.6 }), paint = new THREE.MeshStandardMaterial({ roughness: 0.55 });
  const piece = (pine, level) => {
    if (level === 2) return [{ geometry: pine ? new THREE.ConeGeometry(0.24, 0.95, 6).translate(0, 0.5, 0) : new THREE.SphereGeometry(0.34, 6, 4).scale(1, 1.45, 1).translate(0, 0.5, 0), material: paint }];
    const [round, peg] = [[20, 10], [10, 6]][level];
    const top = pine ? new THREE.ConeGeometry(0.24, 0.85, round).translate(0, 0.55, 0) : new THREE.SphereGeometry(0.3, round, Math.ceil(round * 0.7)).scale(1, 1.1, 1).translate(0, 0.66, 0);
    const stem = pine ? new THREE.CylinderGeometry(0.04, 0.05, 0.2, peg).translate(0, 0.1, 0) : new THREE.CylinderGeometry(0.045, 0.06, 0.45, peg).translate(0, 0.22, 0);
    return [{ geometry: top, material: paint }, { geometry: stem, material: wood }];
  };
  const greens = { oak: [0.29, 0.42, 0.44], ash: [0.27, 0.45, 0.5], aspen: [0.22, 0.5, 0.58], pine: [0.38, 0.4, 0.36] };
  stage.levels(stage.trees, { island: [0, 0], valley: [1200, 4000], camp: [800, 3000] }[view], 4000).forEach((list, level) => {
    for (const kind of ["oak", "ash", "aspen", "pine"]) {
      const [hue, sat, light] = greens[kind];
      for (const part of piece(kind === "pine", level))
        scene.add(scatter(part.geometry, part.material, list.filter((t) => t.kind === kind), (t) => [t.tall * 1.1, t.tall, t.tall * 1.1], (t, c) => (part.material === wood ? c.setRGB(1, 1, 1) : c.setHSL(hue + (t.tint - 0.5) * 0.03, sat, light + (t.tint - 0.5) * 0.08))));
    }
  });
  const felt = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const [nearShrubs, midShrubs] = stage.levels(stage.shrubs, { island: [0, 0], valley: [600, 1500], camp: [400, 1000] }[view], 5000);
  [nearShrubs, midShrubs].forEach((list, level) => {
    const shrub = new THREE.SphereGeometry(0.5, level ? 8 : 14, level ? 5 : 10).scale(1.2, 0.7, 1.2).translate(0, 0.3, 0);
    scene.add(scatter(shrub, felt, list, (s) => [s.tall, s.tall, s.tall], (s, c) => c.setHSL(0.3 - s.heath * 0.35, 0.3, 0.5)));
  });
  const pebble = new THREE.MeshStandardMaterial({ color: 0xdad4ca, roughness: 0.7, flatShading: true });
  const [, rocks] = stage.levels(stage.rocks, { island: [0, 0], valley: [0, 1600], camp: [0, 1200] }[view]);
  scene.add(scatter(rockGeometry(1), pebble, rocks, (r) => [r.size, r.size * 0.7, r.size * 1.1], (r, c) => c.setScalar(0.9 + r.tint * 0.15)));
  if (view !== "island") camp(stage, scene);
  return { sunDir };
}

// Flat pastel ground by what covers it, lighter with height, drawn over with contour lines every 10 m and a firmer
// one every 50 m.
function groundMaterial({ coverA, coverB, river }) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, { uCoverA: { value: coverA }, uCoverB: { value: coverB }, uRiver: { value: river } });
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float sky;\nvarying float vSky;\nvarying vec2 vCover;\nvarying vec3 vWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSky = sky;\nvCover = uv;\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uCoverA, uCoverB, uRiver;\nvarying float vSky;\nvarying vec2 vCover;\nvarying vec3 vWorld;")
      .replace("#include <map_fragment>", /* glsl */ `
        vec4 ca = texture2D(uCoverA, vCover), cb = texture2D(uCoverB, vCover);
        float rv = texture2D(uRiver, vCover).r;
        vec3 forest = vec3(0.22, 0.45, 0.20), heath = vec3(0.62, 0.50, 0.58), marsh = vec3(0.42, 0.58, 0.40), rock = vec3(0.78, 0.75, 0.70), sand = vec3(0.96, 0.87, 0.64);
        vec3 meadow = mix(vec3(0.70, 0.78, 0.38), vec3(0.50, 0.72, 0.30), cb.b);
        float w0 = pow(ca.r, 3.0), w1 = pow(ca.g, 3.0), w2 = pow(ca.b, 3.0), w3 = pow(ca.a, 3.0), w4 = pow(cb.r * (1.0 - cb.a), 3.0), w5 = pow(cb.g * 1.3 + cb.a, 3.0);
        vec3 ground = (forest * w0 + heath * w1 + meadow * w2 + marsh * w3 + rock * w4 + sand * w5) / max(w0 + w1 + w2 + w3 + w4 + w5, 1e-5);
        ground = mix(ground, vec3(0.45, 0.72, 0.85), smoothstep(0.3, 0.6, rv));
        ground *= 0.92 + 0.14 * smoothstep(0.0, 350.0, vWorld.y);
        float step10 = vWorld.y / 10.0, near10 = min(fract(step10), 1.0 - fract(step10)) / max(fwidth(step10), 1e-4);
        float step50 = vWorld.y / 50.0, near50 = min(fract(step50), 1.0 - fract(step50)) / max(fwidth(step50), 1e-4);
        float line = max((1.0 - smoothstep(0.5, 1.5, near10)) * 0.12, (1.0 - smoothstep(0.8, 2.0, near50)) * 0.22) * smoothstep(1.0, 3.0, vWorld.y);
        diffuseColor.rgb *= ground * (1.0 - line) * mix(0.7, 1.0, vSky) * (1.0 - 0.3 * cb.a);`);
  };
  return material;
}

// Water in three clean bands, a crisp white line where it meets the land, and a fainter one just offshore.
function waterMaterial({ height, size, evening }) {
  return new THREE.ShaderMaterial({
    uniforms: { uHeight: { value: height }, uSize: { value: size }, fogColor: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 1 }, fogDensity: { value: 0 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform sampler2D uHeight;
      uniform float uSize;
      varying vec3 vWorld;
      void main() {
        vec2 uv = vWorld.xz / uSize + 0.5;
        float rim = 1.0 - smoothstep(0.0, 0.12, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
        float depth = max(vWorld.y - texture2D(uHeight, clamp(uv, 0.0, 1.0)).r, rim * 60.0);
        vec3 c = ${evening ? "vec3(0.46, 0.52, 0.74)" : "vec3(0.34, 0.74, 0.80)"};
        c = mix(c, ${evening ? "vec3(0.28, 0.34, 0.62)" : "vec3(0.18, 0.54, 0.76)"}, step(1.5, depth));
        c = mix(c, ${evening ? "vec3(0.14, 0.18, 0.44)" : "vec3(0.09, 0.34, 0.62)"}, step(8.0, depth));
        float w = fwidth(depth);
        c = mix(c, vec3(1.0), 1.0 - smoothstep(0.1, 0.1 + w * 2.0, depth));
        c = mix(c, vec3(1.0), (1.0 - smoothstep(w, w * 2.5, abs(depth - 0.8))) * 0.45);
        gl_FragColor = vec4(c, 1.0);
        #include <fog_fragment>
      }`,
    fog: true,
    transparent: true,
  });
}

// The camp as game pieces: bright tents, a fire, and people as pawns.
function camp(stage, scene) {
  const add = (geo, mat, p, yaw = 0) => { const mesh = new THREE.Mesh(geo, mat); mesh.position.copy(p); mesh.rotation.y = yaw; mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh); return mesh; };
  const tent = (size) => new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-size * 0.45, 0), new THREE.Vector2(size * 0.45, 0), new THREE.Vector2(0, size * 0.7)]), { depth: size, bevelEnabled: false }).translate(0, 0, -size / 2);
  stage.camp.tents.forEach(({ at, yaw, size }, k) => add(tent(size), new THREE.MeshStandardMaterial({ color: [0xe25c48, 0x4a7fd0, 0xf0b840][k], roughness: 0.6 }), at, yaw));
  add(new THREE.ConeGeometry(0.45, 1.0, 16), new THREE.MeshStandardMaterial({ color: 0xffa040, emissive: 0xff6a20, emissiveIntensity: 1.5 }), stage.camp.fire.clone().add(new THREE.Vector3(0, 0.5, 0))).castShadow = false;
  const light = new THREE.PointLight(0xffa860, 40, 26, 2);
  light.position.copy(stage.camp.fire).add(new THREE.Vector3(0, 1.2, 0));
  scene.add(light);
  const wood = new THREE.MeshStandardMaterial({ color: 0xa27a54, roughness: 0.6 });
  for (let k = 0; k < 9; k++) add(new THREE.CylinderGeometry(0.14, 0.14, 1.5, 12).rotateX(Math.PI / 2), wood, stage.camp.woodpile.clone().add(new THREE.Vector3((k % 3) * 0.3 - 0.3, 0.15 + Math.floor(k / 3) * 0.27, 0)));
  [0xe25c48, 0x4a7fd0, 0xf0b840, 0x58b060, 0xa066c0].forEach((color, k) => {
    const { at, yaw } = stage.camp.people[k], paint = new THREE.MeshStandardMaterial({ color, roughness: 0.45 });
    add(new THREE.CylinderGeometry(0.2, 0.34, 1.0, 20), paint, at.clone().add(new THREE.Vector3(0, 0.5, 0)), yaw);
    add(new THREE.SphereGeometry(0.22, 20, 14), paint, at.clone().add(new THREE.Vector3(0, 1.22, 0)), yaw);
  });
}
