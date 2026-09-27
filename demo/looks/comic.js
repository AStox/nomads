// Ligne claire: the island as a French science-fiction comic draws it. Flat pastel color in hard-edged fields, a fine
// plum line round everything, a low sun throwing long lilac shadows, stone pines like parasols, cypresses like
// candle flames, banded rock spires standing out of peach earth, and still turquoise water.
import * as THREE from "three";
import { EDGES, QUAD, merged, pitchCamp, puffCrown, rockGeometry, scatter, spireCrown, trunk } from "./stage.js";

const band = (steps) => {
  const t = new THREE.DataTexture(Uint8Array.from(steps.flatMap((v) => [v, v, v, 255])), steps.length, 1);
  t.needsUpdate = true;
  return t;
};
const TWO = band([30, 255]);
const cel = (color, options = {}) => new THREE.MeshToonMaterial({ color, gradientMap: TWO, ...options });

export async function dress(stage, { view }) {
  const { scene, renderer, sun } = stage;
  renderer.toneMapping = THREE.NoToneMapping;
  scene.background = new THREE.Color(0xfbe6c4);
  scene.fog = new THREE.FogExp2(0xf7dcc0, { island: 0.00004, valley: 0.00016, camp: 0.00035 }[view]);
  const sunDir = new THREE.Vector3(-0.78, 0.4, 0.48).normalize();
  sun.intensity = 1.6;
  // All shade is lilac: the sky fills it from above, warm earth from below.
  scene.add(new THREE.HemisphereLight(0xb89cff, 0xffb890, 1.2));
  stage.bloom.enabled = false;
  Object.assign(stage.grade.uniforms, { uSaturation: { value: 1.05 }, uContrast: { value: 1.0 }, uVignette: { value: 0.12 } });

  // Each point takes the one cover that leads there, so color changes in hard-edged fields. Bare rock and steep ground
  // show their strata in bands.
  scene.add(stage.ground(cel(0xffffff), {
    paint: /* glsl */ `
      float jitter = (fbm2(vWorld.xz / 35.0) - 0.5) * 0.25;
      float w[6];
      w[0] = ca.r + jitter; w[1] = ca.g; w[2] = ca.b - jitter; w[3] = ca.a + rv; w[4] = cb.r * 1.2; w[5] = cb.g * 1.4 + cb.a;
      vec3 pick[6];
      pick[0] = vec3(0.42, 0.62, 0.36); pick[1] = vec3(0.93, 0.62, 0.64); pick[2] = vec3(0.6, 0.82, 0.42);
      pick[3] = vec3(0.45, 0.78, 0.66); pick[4] = vec3(0.96, 0.7, 0.53); pick[5] = vec3(0.99, 0.88, 0.7);
      int best = 0;
      for (int k = 1; k < 6; k++) if (w[k] > w[best]) best = k;
      vec3 g = pick[best];
      if (best == 4) g = mix(g, vec3(0.88, 0.55, 0.5), step(0.62, fract(vWorld.y / 7.0 + jitter)));
      diffuseColor.rgb = g;`,
  }));
  scene.add(...stage.water(/* glsl */ `
    vec3 c = mix(vec3(0.42, 0.82, 0.78), vec3(0.18, 0.56, 0.66), step(3.0, depth));
    c = mix(c, vec3(0.12, 0.4, 0.55), step(14.0, depth));
    c = mix(c, vec3(1.0, 0.97, 0.9), 1.0 - step(0.35, depth));
    gl_FragColor = vec4(c, 1.0);`, { transparent: false }));

  // ---------- trees: parasols, flames and lollipops; a few trees turn coral for no reason ----------
  const leaves = cel(0xffffff, { vertexColors: true }), bark = cel(0x7a4a5a);
  const parasol = (detail) => puffCrown({ detail }).scale(1.9, 0.38, 1.9).translate(0, 0.62, 0);
  const flame = (detail) => spireCrown(detail).scale(0.55, 1.35, 0.55);
  const pole = (detail) => trunk(detail, 0.82, 0.04);
  const tone = (base, odd) => (t, c) => c.set(t.tint > 0.86 ? odd : base).offsetHSL(0, 0, (t.tint - 0.5) * 0.08);
  stage.levels(stage.trees, { island: [0, 0], valley: [900, 3200], camp: [600, 2400] }[view], 2500).forEach((list, level) => {
    const detail = 2 - level, size = (t) => [t.tall * 0.9, t.tall * 1.15, t.tall * 0.9];
    const pines = list.filter((t) => t.kind === "pine"), aspens = list.filter((t) => t.kind === "aspen"), broad = list.filter((t) => t.kind === "oak" || t.kind === "ash");
    scene.add(scatter(parasol(detail), leaves, broad, size, tone(0x2fa89a, 0xf08a5a)));
    scene.add(scatter(flame(detail), leaves, pines, size, tone(0x1f6878, 0x3a5aa8)));
    scene.add(scatter(puffCrown({ detail }).scale(0.8, 0.8, 0.8).translate(0, 0.25, 0), leaves, aspens, size, tone(0x9ad6a0, 0xf2c25a)));
    if (detail) scene.add(scatter(pole(detail), bark, [...broad, ...aspens], size, (t, c) => c.setScalar(1)));
  });
  const [near, mid] = stage.levels(stage.shrubs, { island: [0, 0], valley: [500, 1500], camp: [300, 1000] }[view], 3000);
  [near, mid].forEach((list, level) => scene.add(scatter(puffCrown({ shrub: true, detail: 2 - level }), leaves, list, (s) => [s.tall * 1.4, s.tall * 0.8, s.tall * 1.4], (s, c) => c.set(s.heath > 0.5 ? 0xd9829a : 0x6fbf9a))));
  // Rocks rise as banded spires; the biggest carry a cap stone, like hoodoos.
  const spire = rockGeometry(1), cap = rockGeometry(1).scale(1.7, 0.18, 1.7).translate(0, 0.38, 0), rock = cel(0xffffff);
  const [, rocks] = stage.levels(stage.rocks, { island: [0, 0], valley: [0, 1600], camp: [0, 1200] }[view]);
  const tall = (r) => [r.size * 0.7, r.size * (1.6 + r.tint * 2.2), r.size * 0.7];
  scene.add(scatter(spire, rock, rocks, tall, (r, c) => c.set(r.tint > 0.5 ? 0xf0a890 : 0xe7c3b0)));
  scene.add(scatter(cap, rock, rocks.filter((r) => r.size > 2.2), tall, (r, c) => c.set(0xb89ac0)));

  if (view !== "island") {
    // No grass: each tuft inks into a little cross. Flowers stand in for it.
    const { flowers, pebbles } = stage.nearby(stage.camp.at, view === "camp" ? 100 : 130, view === "camp" ? 3 : 1.2);
    scene.add(scatter(merged([new THREE.CylinderGeometry(0.015, 0.015, 0.9, 4).translate(0, 0.45, 0), new THREE.SphereGeometry(0.14, 10, 6).translate(0, 0.95, 0)]), cel(0xffffff), flowers, (f) => [1.2, 1.2, 1.2], (f, c) => c.set(f.hue < 0.5 ? 0xff7a5a : 0x7a5aff)));
    scene.add(scatter(rockGeometry(1), rock, pebbles, (p) => [p.size, p.size * 0.6, p.size], (p, c) => c.set(0xe7c3b0)));
    const cloth = (color) => cel(color, { side: THREE.DoubleSide });
    scene.add(pitchCamp(stage, { tent: [cloth(0xfff4e0), cloth(0xf08a5a), cloth(0xfff4e0)], stone: rock, wood: bark, flame: new THREE.MeshBasicMaterial({ color: 0xffd060 }), clothes: [cloth(0x3a5aa8), cloth(0xf08a5a), cloth(0xfff4e0), cloth(0x2fa89a), cloth(0xd9829a)], skin: cel(0xe8a888) }));
  }

  const line = stage.paint(LINE);
  line.uniforms.tG.value = stage.gbuffer();
  return { sunDir };
}

// A fine, even plum line, gone where the haze takes the distance.
const LINE = {
  uniforms: { tDiffuse: { value: null }, tG: { value: null }, uTexel: { value: null } },
  vertexShader: QUAD,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tG;
    uniform vec2 uTexel;
    varying vec2 vUv;
    ${EDGES}
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float far = smoothstep(2000.0, 6000.0, texture2D(tG, vUv).a);
      gl_FragColor = vec4(mix(c, vec3(0.14, 0.08, 0.2), min(1.0, edges(tG, vUv, uTexel, 1.5, 0.6) * 1.6) * (1.0 - far)), 1.0);
    }`,
};
