// Storybook: the island as a painted animated film would draw it. Soft banded light, round billowing trees, meadows
// thick with flowers, bright shallows ringed with foam, colored shadows, and a painted sky.
import * as THREE from "three";
import { hash, merged, rockGeometry, scatter, tuft } from "./stage.js";

// A few soft steps of light, the way a painter blocks in lit and shaded sides.
function ramp(steps) {
  const t = new THREE.DataTexture(Uint8Array.from(steps.flatMap((v) => [v, v, v, 255])), steps.length, 1);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
const RAMP = ramp([50, 130, 205, 255]);

// Brush marks for the ground: soft overlapping dabs, tileable, used only to vary how light each patch is.
function strokes() {
  const S = 512, c = Object.assign(document.createElement("canvas"), { width: S, height: S }), g = c.getContext("2d");
  g.fillStyle = "rgb(128,128,128)";
  g.fillRect(0, 0, S, S);
  for (let k = 0; k < 2600; k++) {
    const x = hash(k, 1, 3) * S, y = hash(k, 2, 3) * S, r = 6 + hash(k, 3, 3) * 26, a = hash(k, 4, 3) * Math.PI, v = Math.floor(90 + hash(k, 5, 3) * 80);
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
      g.save();
      g.translate(x + ox, y + oy);
      g.rotate(a);
      g.fillStyle = `rgba(${v},${v},${v},0.16)`;
      g.beginPath();
      g.ellipse(0, 0, r * 1.8, r * 0.55, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// The painted sky: a deep zenith falling to a pale horizon, with fat soft clouds.
function paintedSky(evening) {
  const W = 2048, H = 1024, c = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = c.getContext("2d");
  const fade = g.createLinearGradient(0, 0, 0, H / 2);
  const [top, mid, low] = evening ? ["#3b4f9a", "#c98ab0", "#ffc98a"] : ["#3f8fe0", "#8cc8f4", "#e4f4ff"];
  fade.addColorStop(0, top);
  fade.addColorStop(0.7, mid);
  fade.addColorStop(1, low);
  g.fillStyle = fade;
  g.fillRect(0, 0, W, H);
  for (let k = 0; k < 46; k++) {
    const x = hash(k, 7, 9) * W, y = H * (0.22 + hash(k, 8, 9) * 0.24), w = 60 + hash(k, 9, 9) * 160;
    for (let p = 0; p < 9; p++) {
      const px = x + (hash(k, p, 10) - 0.5) * w * 1.6, py = y - hash(k, p, 11) * w * 0.35, r = w * (0.25 + hash(k, p, 12) * 0.35);
      const puff = g.createRadialGradient(px, py - r * 0.3, 0, px, py, r);
      puff.addColorStop(0, evening ? "rgba(255,226,210,0.95)" : "rgba(255,255,255,0.95)");
      puff.addColorStop(0.75, evening ? "rgba(240,180,190,0.6)" : "rgba(236,244,255,0.6)");
      puff.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = puff;
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function dress(stage, { evening = false, view }) {
  const { scene, renderer, sun } = stage;
  const sky = paintedSky(evening);
  scene.background = sky;
  const sunDir = new THREE.Vector3(...(evening ? [-0.8, 0.22, 0.55] : [-0.55, 0.62, 0.55])).normalize();
  sun.color.set(evening ? 0xffb27a : 0xfff0d4);
  sun.intensity = evening ? 2.4 : 2.8;
  scene.add(new THREE.HemisphereLight(evening ? 0xb6a0d8 : 0xbfe0ff, evening ? 0x6a5040 : 0x6f8a44, evening ? 1.0 : 1.05));
  scene.fog = new THREE.FogExp2(evening ? 0xe9b9a8 : 0xcfe8fa, { island: 0.00007, valley: 0.0002, camp: 0.0003 }[view]);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  Object.assign(stage.grade.uniforms, { uSaturation: { value: 1.18 }, uContrast: { value: 1.04 }, uVignette: { value: 0.28 } });
  stage.grade.uniforms.uShadows.value.set(0.0, 0.01, 0.04);
  stage.grade.uniforms.uHighlights.value.set(0.03, 0.02, -0.01);
  stage.bloom.strength = 0.4;
  stage.bloom.threshold = 0.85;

  const [coverA, coverB] = stage.coverTextures(), height = stage.heightTexture(), river = stage.riverTexture(), brush = strokes();
  const land = new THREE.Mesh(stage.terrainGeometry(), groundMaterial({ coverA, coverB, river, brush }));
  land.receiveShadow = land.castShadow = true;
  scene.add(land);
  const water = waterMaterial({ height, size: stage.SIZE, evening });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(stage.SIZE * 12, stage.SIZE * 12, 64, 64).rotateX(-Math.PI / 2), water), new THREE.Mesh(stage.lakeGeometry(), water), new THREE.Mesh(stage.riverGeometry(), water));

  // ---------- trees: round billowing crowns, and tiered spires for the pines ----------
  // Full crowns near the view, plainer ones farther off, and across the island a puff or two per tree.
  const greens = { oak: [0x2f6a2c, 0x5a9a3a], ash: [0x3a7a34, 0x6aa844], aspen: [0x5a8f38, 0x9ab84a] };
  const shade = (o, c) => c.setHSL(0, 0, 0.82 + o.tint * 0.3);
  stage.levels(stage.trees, { island: [0, 0], valley: [900, 3200], camp: [600, 2400] }[view], 2500).forEach((list, level) => {
    for (const kind of ["oak", "ash", "aspen", "pine"]) {
      const model = kind === "pine" ? spireTree(2 - level) : puffTree(greens[kind], { detail: 2 - level });
      for (const part of model.parts) scene.add(scatter(part.geometry, part.material, list.filter((t) => t.kind === kind), (t) => [t.tall * 1.05, t.tall, t.tall * 1.05], shade));
    }
  });
  const [nearShrubs, midShrubs] = stage.levels(stage.shrubs, { island: [0, 0], valley: [500, 1500], camp: [300, 1000] }[view], 3000);
  [nearShrubs, midShrubs].forEach((list, level) => {
    for (const [colors, heath] of [[[0x5f9a40, 0x8cc050], false], [[0x9a6a8a, 0xc08aa8], true]])
      for (const part of puffTree(colors, { shrub: true, detail: 2 - level }).parts)
        scene.add(scatter(part.geometry, part.material, list.filter((s) => s.heath >= 0.5 === heath), (s) => [s.tall * 1.3, s.tall, s.tall * 1.3], shade));
  });
  const rockMat = toon({ color: 0xb4aa9c });
  const [, rocks] = stage.levels(stage.rocks, { island: [0, 0], valley: [0, 1600], camp: [0, 1200] }[view]);
  scene.add(scatter(rockGeometry(), rockMat, rocks, (r) => [r.size, r.size * 0.7, r.size * 1.1], (r, c) => c.setHSL(0.08, 0.1, 0.72 + r.tint * 0.2)));

  if (view !== "island") {
    const { grass, flowers, pebbles } = stage.nearby(stage.camp.at, view === "camp" ? 100 : 130, view === "camp" ? 6 : 2);
    scene.add(scatter(tuft(), toon({ vertexColors: true, side: THREE.DoubleSide }), grass, (g) => [g.tall * 1.2, g.tall * 1.2, g.tall * 1.2], (g, c) => c.setHSL(0.22 + g.tint * 0.06, 0.6, 0.42 + g.tint * 0.1)));
    const blossom = merged([new THREE.CylinderGeometry(0.012, 0.012, 0.8, 3).translate(0, 0.4, 0), new THREE.IcosahedronGeometry(0.1, 1).scale(1, 0.6, 1).translate(0, 0.82, 0)]);
    const petals = [...flowers, ...flowers.map((f) => ({ ...f, x: f.x + 0.7, z: f.z - 0.4, hue: (f.hue + 0.37) % 1 }))];
    scene.add(scatter(blossom, toon({ color: 0xffffff }), petals, (f) => [f.tall * 1.3, f.tall * 1.3, f.tall * 1.3], (f, c) => c.set([0xfff4c0, 0xffffff, 0xf7a8c8, 0xc8a8f0][Math.floor(f.hue * 4)])));
    scene.add(scatter(rockGeometry(), rockMat, pebbles, (p) => [p.size, p.size * 0.6, p.size], (p, c) => c.setHSL(0.08, 0.1, 0.75 + p.tint * 0.2)));
    camp(stage, scene);
  }
  return { sunDir };
}

// Every surface here shades in the painter's few steps; foliage also catches a rim of sky light at its edges.
function toon(options, rim = 0) {
  const material = new THREE.MeshToonMaterial({ gradientMap: RAMP, ...options });
  if (rim)
    material.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace("#include <opaque_fragment>", /* glsl */ `
        float edge = pow(1.0 - max(dot(normalize(vViewPosition), normal), 0.0), 3.0);
        outgoingLight += diffuseColor.rgb * vec3(0.9, 1.0, 0.8) * edge * ${rim.toFixed(2)};
        #include <opaque_fragment>`);
    };
  return material;
}

function groundMaterial({ coverA, coverB, river, brush }) {
  const material = toon({ vertexColors: false });
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, { uCoverA: { value: coverA }, uCoverB: { value: coverB }, uRiver: { value: river }, uBrush: { value: brush } });
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float sky;\nvarying float vSky;\nvarying vec2 vCover;\nvarying vec3 vWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSky = sky;\nvCover = uv;\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uCoverA, uCoverB, uRiver, uBrush;\nvarying float vSky;\nvarying vec2 vCover;\nvarying vec3 vWorld;")
      .replace("#include <map_fragment>", /* glsl */ `
        vec4 ca = texture2D(uCoverA, vCover), cb = texture2D(uCoverB, vCover);
        float rv = texture2D(uRiver, vCover).r;
        vec3 forest = vec3(0.16, 0.34, 0.12), heath = vec3(0.45, 0.30, 0.38), marsh = vec3(0.30, 0.42, 0.22), rock = vec3(0.58, 0.54, 0.50), sand = vec3(0.92, 0.82, 0.58);
        vec3 meadow = mix(vec3(0.62, 0.66, 0.24), vec3(0.34, 0.60, 0.16), cb.b);
        float w0 = pow(ca.r, 2.0), w1 = pow(ca.g, 2.0), w2 = pow(ca.b, 2.0), w3 = pow(ca.a + rv, 2.0), w4 = pow(cb.r * (1.0 - cb.a), 2.0), w5 = pow(cb.g * 1.3 + cb.a, 2.0);
        vec3 ground = (forest * w0 + heath * w1 + meadow * w2 + marsh * w3 + rock * w4 + sand * w5) / max(w0 + w1 + w2 + w3 + w4 + w5, 1e-5);
        float dab = texture2D(uBrush, vWorld.xz / 60.0).r * 0.6 + texture2D(uBrush, vWorld.xz / 230.0 + 0.3).r * 0.4;
        ground *= 0.78 + 0.44 * dab;
        // Hollows sink into a cool violet rather than going grey.
        ground = mix(ground * vec3(0.72, 0.72, 0.95), ground, smoothstep(0.35, 0.95, vSky));
        diffuseColor.rgb *= ground * (1.0 - 0.35 * cb.a);`);
  };
  return material;
}

// Shallows glowing turquoise over sand, deepening to blue, with bands of foam that lap the shore.
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
        vec3 c = mix(${evening ? "vec3(0.36, 0.40, 0.52)" : "vec3(0.16, 0.62, 0.62)"}, ${evening ? "vec3(0.14, 0.18, 0.40)" : "vec3(0.05, 0.34, 0.56)"}, smoothstep(0.0, 3.0, depth));
        c = mix(c, ${evening ? "vec3(0.06, 0.07, 0.22)" : "vec3(0.02, 0.14, 0.36)"}, smoothstep(4.0, 25.0, depth));
        float ripple = sin(vWorld.x * 0.21 + sin(vWorld.z * 0.17) * 2.0) * sin(vWorld.z * 0.19 - sin(vWorld.x * 0.13) * 2.0);
        c += vec3(0.05) * smoothstep(0.7, 1.0, ripple) * (1.0 - smoothstep(10.0, 30.0, depth));
        float band = step(0.7, fract(depth * 2.5 + 0.2 * ripple)) * (1.0 - smoothstep(0.0, 0.9, depth));
        c = mix(c, vec3(1.0), max(1.0 - smoothstep(0.0, 0.12, depth), band * 0.55));
        gl_FragColor = vec4(c, clamp(mix(0.55, 1.0, smoothstep(0.0, 3.0, depth)), 0.0, 1.0));
        #include <fog_fragment>
      }`,
    fog: true,
    transparent: true,
  });
}

// A round tree: a short trunk under a crown of overlapping balls, each shaded as part of one big soft mass, darker
// underneath and lit toward the top. At detail 0, two low balls and no trunk, for trees a few pixels tall.
function puffTree([low, high], { shrub = false, detail = 2 } = {}) {
  const balls = [];
  if (detail === 0) balls.push(...(shrub ? [[0, 0.3, 0, 0.3]] : [[0, 0.45, 0, 0.3], [0.1, 0.72, 0.05, 0.26]]).map(([x, y, z, r]) => new THREE.IcosahedronGeometry(r, 0).translate(x, y, z)));
  else
    for (let k = 0, n = shrub ? 4 : 7; k < n; k++) {
      const a = k * 2.4, r = shrub ? 0.22 : 0.18 + (k % 3) * 0.05, y = shrub ? 0.28 + (k % 2) * 0.12 : 0.55 + (k % 4) * 0.09;
      balls.push(new THREE.IcosahedronGeometry(shrub ? 0.22 : 0.2 + (k % 2) * 0.05, detail).translate(Math.cos(a) * r * (k ? 1 : 0), y, Math.sin(a) * r * (k ? 1 : 0)));
    }
  const crown = merged(balls), p = crown.attributes.position, nrm = crown.attributes.normal, center = new THREE.Vector3(0, shrub ? 0.3 : 0.66, 0);
  const col = new Float32Array(p.count * 3), v = new THREE.Vector3(), a = new THREE.Color(low), b = new THREE.Color(high), tint = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const out = v.clone().sub(center).normalize();
    const blended = new THREE.Vector3().fromBufferAttribute(nrm, i).multiplyScalar(0.3).addScaledVector(out, 0.7).normalize();
    nrm.setXYZ(i, blended.x, blended.y, blended.z);
    tint.copy(a).lerp(b, THREE.MathUtils.clamp((v.y - center.y) * 3 + 0.5, 0, 1));
    col.set([tint.r, tint.g, tint.b], i * 3);
  }
  crown.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const parts = [{ geometry: crown, material: toon({ vertexColors: true }, 0.35) }];
  if (!shrub && detail) parts.push({ geometry: new THREE.CylinderGeometry(0.03, 0.055, 0.5, detail * 3 + 1).translate(0, 0.25, 0), material: toon({ color: 0x6a4a32 }) });
  return { parts };
}
function spireTree(detail = 2) {
  const n = detail + 2;
  const tiers = detail === 0 ? [new THREE.ConeGeometry(0.26, 0.95, 6).translate(0, 0.52, 0)] : Array.from({ length: n }, (_, k) => new THREE.ConeGeometry(0.26 - (k * 0.2) / n, 1.44 / n, detail * 3 + 4).translate(0, 0.3 + (k * 0.76) / n, 0));
  const crown = merged(tiers), p = crown.attributes.position, col = new Float32Array(p.count * 3), a = new THREE.Color(0x1f5a44), b = new THREE.Color(0x3f8a5c), t = new THREE.Color();
  for (let i = 0; i < p.count; i++) { t.copy(a).lerp(b, THREE.MathUtils.clamp(p.getY(i), 0, 1)); col.set([t.r, t.g, t.b], i * 3); }
  crown.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const parts = [{ geometry: crown, material: toon({ vertexColors: true }, 0.25) }];
  if (detail) parts.push({ geometry: new THREE.CylinderGeometry(0.025, 0.045, 0.3, 6).translate(0, 0.15, 0), material: toon({ color: 0x5a3e2a }) });
  return { parts };
}

function camp(stage, scene) {
  const add = (geo, mat, p, yaw = 0) => { const mesh = new THREE.Mesh(geo, mat); mesh.position.copy(p); mesh.rotation.y = yaw; mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh); return mesh; };
  const canvases = [0xf2e2c4, 0xe8c9a0, 0xf4dccc].map((color) => toon({ color, side: THREE.DoubleSide })), trim = toon({ color: 0xc0503a });
  stage.camp.tents.forEach(({ at, yaw, size }, k) => {
    add(new THREE.ConeGeometry(size * 0.55, size, 12, 1, true), canvases[k], at.clone().add(new THREE.Vector3(0, size / 2, 0)), yaw);
    add(new THREE.CylinderGeometry(size * 0.2, size * 0.28, size * 0.14, 12, 1, true), trim, at.clone().add(new THREE.Vector3(0, size * 0.72, 0)), yaw);
  });
  const fire = stage.camp.fire, glow = toon({ color: 0xffb040, emissive: 0xff7a20, emissiveIntensity: 3 });
  add(new THREE.ConeGeometry(0.4, 1.1, 8), glow, fire.clone().add(new THREE.Vector3(0, 0.55, 0))).castShadow = false;
  for (let k = 0; k < 9; k++) { const a = (k / 9) * Math.PI * 2; add(new THREE.IcosahedronGeometry(0.24, 1), toon({ color: 0x9a948c }), fire.clone().add(new THREE.Vector3(Math.cos(a), 0.12, Math.sin(a)))); }
  const light = new THREE.PointLight(0xffa050, 50, 30, 2);
  light.position.copy(fire).add(new THREE.Vector3(0, 1.2, 0));
  scene.add(light);
  const wood = toon({ color: 0x7a5236 });
  for (let k = 0; k < 12; k++) add(new THREE.CylinderGeometry(0.13, 0.13, 1.6, 8).rotateX(Math.PI / 2), wood, stage.camp.woodpile.clone().add(new THREE.Vector3((k % 4) * 0.28 - 0.42, 0.14 + Math.floor(k / 4) * 0.25, 0)));
  [0xd0503a, 0x3a6ab0, 0xe0a030, 0x5a9a4a, 0x9a5a9a].forEach((color, k) => {
    const { at, yaw } = stage.camp.people[k];
    add(new THREE.CapsuleGeometry(0.24, 0.8, 4, 12), toon({ color }), at.clone().add(new THREE.Vector3(0, 0.68, 0)), yaw);
    add(new THREE.SphereGeometry(0.17, 16, 12), toon({ color: 0xf0c8a0 }), at.clone().add(new THREE.Vector3(0, 1.45, 0)), yaw);
  });
}
