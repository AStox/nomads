// Glow: the island on a night when everything living shines. Moonlight picks out the crowns, moss glows on the forest
// floor, lanterns of fruit hang in the trees, giant mushrooms light the woods' edges, the shore burns with plankton,
// fireflies drift over the meadow, and the tents glow from the fires inside. An aurora hangs over it all.
import * as THREE from "three";
import { hash, pitchCamp, puffCrown, rockGeometry, scatter, spireCrown, trunk, tuft } from "./stage.js";

// Unlit, brighter than white, so the bloom catches it.
const shine = (color, k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), fog: false });

function nightSky() {
  const W = 2048, H = 1024, c = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = c.getContext("2d");
  const fade = g.createLinearGradient(0, 0, 0, H / 2);
  fade.addColorStop(0, "#02030c");
  fade.addColorStop(0.75, "#0b1236");
  fade.addColorStop(1, "#1c2a5a");
  g.fillStyle = fade;
  g.fillRect(0, 0, W, H);
  // Curtains of aurora: soft vertical streaks along a wandering band.
  for (let k = 0; k < 900; k++) {
    const x = hash(k, 1, 5) * W, y = H * (0.3 + 0.08 * Math.sin(x / 140) + 0.04 * Math.sin(x / 37)), tall = 60 + hash(k, 2, 5) * 140;
    const streak = g.createLinearGradient(0, y - tall, 0, y + 10);
    streak.addColorStop(0, "rgba(160,80,255,0)");
    streak.addColorStop(0.6, `rgba(80,255,190,${0.03 + hash(k, 3, 5) * 0.05})`);
    streak.addColorStop(1, "rgba(80,255,190,0)");
    g.fillStyle = streak;
    g.fillRect(x, y - tall, 3 + hash(k, 4, 5) * 6, tall + 10);
  }
  for (let k = 0; k < 2600; k++) {
    const b = hash(k, 7, 9) ** 3;
    g.fillStyle = `rgba(255,255,255,${0.3 + b * 0.7})`;
    g.fillRect(hash(k, 8, 9) * W, hash(k, 9, 9) * H * 0.5, 1 + b * 1.5, 1 + b * 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function dress(stage, { view }) {
  const { scene, renderer, sun, rand } = stage;
  scene.background = nightSky();
  scene.fog = new THREE.FogExp2(0x060a20, { island: 0.00004, valley: 0.00012, camp: 0.00025 }[view]);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const sunDir = new THREE.Vector3(0.5, 0.7, -0.5).normalize();
  sun.color.set(0x8fa8ff);
  sun.intensity = 0.9;
  scene.add(new THREE.HemisphereLight(0x2a3a8a, 0x05070a, 0.5));
  Object.assign(stage.bloom, { strength: 0.85, radius: 0.45, threshold: 1.0 });
  Object.assign(stage.grade.uniforms, { uSaturation: { value: 1.25 }, uContrast: { value: 1.08 }, uVignette: { value: 0.55 } });
  stage.grade.uniforms.uShadows.value.set(0.0, 0.0, 0.03);

  // Dark ground, with moss that glows in speckled drifts where the woods and marshes are.
  scene.add(stage.ground(new THREE.MeshStandardMaterial({ roughness: 1 }), {
    paint: /* glsl */ `
      vec3 g = (vec3(0.03, 0.07, 0.06) * ca.r + vec3(0.1, 0.07, 0.12) * ca.g + vec3(0.07, 0.12, 0.08) * ca.b + vec3(0.03, 0.09, 0.09) * ca.a + vec3(0.12, 0.12, 0.14) * cb.r + vec3(0.3, 0.28, 0.25) * cb.g)
        / max(ca.r + ca.g + ca.b + ca.a + cb.r + cb.g, 1e-3);
      diffuseColor.rgb = g * mix(0.4, 1.0, vSky);`,
    glow: /* glsl */ `
      vec2 cell = floor(vWorld.xz / 1.6);
      float spot = step(0.9, hash21(cell)) * (1.0 - smoothstep(0.15, 0.5, length(fract(vWorld.xz / 1.6) - 0.5)));
      float drift = smoothstep(0.45, 0.75, fbm2(vWorld.xz / 60.0)) * (ca.r + ca.a * 1.5);
      totalEmissiveRadiance += (spot * 2.5 + 0.18) * drift * mix(vec3(0.1, 1.0, 0.8), vec3(0.6, 0.3, 1.0), vnoise(vWorld.xz / 23.0));`,
  }));
  // Black water that burns cyan where it breaks on the shore, with sparks of plankton further out.
  scene.add(...stage.water(/* glsl */ `
    vec3 c = mix(vec3(0.01, 0.03, 0.06), vec3(0.0, 0.005, 0.02), smoothstep(0.0, 8.0, depth));
    float surf = (1.0 - smoothstep(0.0, 0.6, depth)) * (0.6 + 0.4 * vnoise(vWorld.xz / 3.0));
    float sparks = step(0.985, hash21(floor(vWorld.xz / 0.9))) * (1.0 - smoothstep(2.0, 25.0, depth));
    c += vec3(0.1, 1.2, 1.1) * (surf * 0.9 + sparks * 2.0);
    gl_FragColor = vec4(c, 1.0);`, { transparent: false }));

  // ---------- trees: dark crowns rimmed with light ----------
  const crowns = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  crowns.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace("#include <opaque_fragment>", /* glsl */ `
      float rim = pow(1.0 - max(dot(normalize(vViewPosition), normal), 0.0), 3.0);
      outgoingLight += vec3(0.2, 0.45, 1.0) * rim * 0.3;
      #include <opaque_fragment>`);
  };
  const bark = new THREE.MeshStandardMaterial({ color: 0x0c0a10 });
  const [close, mid, far] = stage.levels(stage.trees, { island: [0, 0], valley: [900, 3200], camp: [600, 2400] }[view], 2500);
  [close, mid, far].forEach((list, level) => {
    const detail = 2 - level, size = (t) => [t.tall * 1.05, t.tall, t.tall * 1.05];
    scene.add(scatter(puffCrown({ detail }), crowns, list.filter((t) => t.kind !== "pine"), size, (t, c) => c.setRGB(0.05, 0.14 + t.tint * 0.08, 0.13)));
    scene.add(scatter(spireCrown(detail), crowns, list.filter((t) => t.kind === "pine"), size, (t, c) => c.setRGB(0.03, 0.07, 0.1)));
    if (detail) scene.add(scatter(trunk(detail), bark, list, size, (t, c) => c.setScalar(1)));
  });
  // Lantern fruit in the nearer crowns, pink and gold.
  const fruit = [];
  for (const t of [...close, ...mid])
    for (let k = Math.floor(rand() * 3.2); k > 0; k--) {
      const a = rand() * 6.283, r = t.tall * (0.12 + rand() * 0.2);
      fruit.push({ x: t.x + Math.cos(a) * r, y: t.y + t.tall * (0.45 + rand() * 0.35), z: t.z + Math.sin(a) * r, size: t.tall * 0.035, hue: rand() });
    }
  scene.add(scatter(new THREE.IcosahedronGeometry(1, 1), shine(0xffffff, 1), fruit, (f) => [f.size, f.size, f.size], (f, c) => c.set(f.hue < 0.6 ? 0xff4fc0 : 0xffc040).multiplyScalar(5), { cast: false }));

  // Giant mushrooms where shrubs grow at the woods' edge: pale stems under caps that glow from beneath.
  const [nearShrubs, midShrubs] = stage.levels(stage.shrubs, { island: [0, 0], valley: [500, 1500], camp: [300, 1000] }[view], 3000);
  const shrubs = [...nearShrubs, ...midShrubs];
  const mushrooms = shrubs.filter((s) => s.heath < 0.45 && s.tint < 0.3).map((s) => ({ ...s, tall: s.tall * 2.2 }));
  scene.add(scatter(new THREE.CylinderGeometry(0.06, 0.1, 1, 8).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x9a9ab8, emissive: 0x303060 }), mushrooms, (m) => [m.tall, m.tall, m.tall], (m, c) => c.setScalar(1)));
  scene.add(scatter(new THREE.SphereGeometry(0.42, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 0.95, 0), shine(0xffffff, 1), mushrooms, (m) => [m.tall, m.tall, m.tall], (m, c) => c.set(m.tint < 0.15 ? 0x40ffd0 : 0xb060ff).multiplyScalar(2.6), { cast: false }));
  scene.add(scatter(puffCrown({ shrub: true, detail: 1 }), crowns, shrubs.filter((s) => !(s.heath < 0.45 && s.tint < 0.3)), (s) => [s.tall * 1.3, s.tall, s.tall * 1.3], (s, c) => c.setRGB(0.06 + s.heath * 0.1, 0.1, 0.12)));
  const stone = new THREE.MeshStandardMaterial({ color: 0x2a2c3a, roughness: 0.9 });
  const [, rocks] = stage.levels(stage.rocks, { island: [0, 0], valley: [0, 1600], camp: [0, 1200] }[view]);
  scene.add(scatter(rockGeometry(1), stone, rocks, (r) => [r.size, r.size * 0.8, r.size * 1.1], (r, c) => c.setScalar(0.8 + r.tint * 0.4)));

  if (view !== "island") {
    const { grass, flowers, pebbles } = stage.nearby(stage.camp.at, view === "camp" ? 100 : 130, view === "camp" ? 5 : 2);
    scene.add(scatter(tuft(), new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 }), grass, (g) => [g.tall, g.tall * 1.2, g.tall], (g, c) => c.setRGB(0.05, 0.12 + g.tint * 0.08, 0.1)));
    scene.add(scatter(new THREE.IcosahedronGeometry(0.1, 1).translate(0, 0.55, 0), shine(0xffffff, 1), flowers, (f) => [1.3, 1.3, 1.3], (f, c) => c.set(f.hue < 0.5 ? 0x60c0ff : 0xff70e0).multiplyScalar(4), { cast: false }));
    const flies = grass.filter(() => rand() < (view === "camp" ? 0.004 : 0.008)).map((g) => ({ ...g, y: g.y + 0.6 + rand() * 2.5 }));
    const fly = view === "camp" ? 0.07 : 0.35;
    scene.add(scatter(new THREE.IcosahedronGeometry(1, 0), shine(0xd8ff60, 7), flies, () => [fly, fly, fly], (f, c) => c.setScalar(1), { cast: false }));
    scene.add(scatter(rockGeometry(1), stone, pebbles, (p) => [p.size, p.size * 0.6, p.size], (p, c) => c.setScalar(1)));
    const lit = (color) => new THREE.MeshStandardMaterial({ color: 0x201008, emissive: color, emissiveIntensity: 2.2, side: THREE.DoubleSide });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14121a });
    scene.add(pitchCamp(stage, { tent: [lit(0xff8a30), lit(0xffb050), lit(0xff7040)], stone, wood: bark, flame: shine(0xff8a30, 6), clothes: [dark], skin: dark, glow: 120 }));
  }
  return { sunDir };
}
