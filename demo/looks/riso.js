// Riso: the island as a three-ink risograph print. Flat bold shapes in banded light are separated into fluorescent
// pink, blue and yellow, each screened into dots at its own angle, laid a little out of register on cream stock, with
// the uneven ink and white specks of a cheap drum.
import * as THREE from "three";
import { NOISE, QUAD, pitchCamp, puffCrown, rockGeometry, scatter, spireCrown, trunk, tuft } from "./stage.js";

const band = (steps) => {
  const t = new THREE.DataTexture(Uint8Array.from(steps.flatMap((v) => [v, v, v, 255])), steps.length, 1);
  t.needsUpdate = true;
  return t;
};
const BANDS = band([90, 175, 255]);
const flat = (color, options = {}) => new THREE.MeshToonMaterial({ color, gradientMap: BANDS, ...options });

export async function dress(stage, { view }) {
  const { scene, renderer, sun } = stage;
  renderer.toneMapping = THREE.NeutralToneMapping;
  scene.background = new THREE.Color(0xfff3d6);
  scene.fog = new THREE.FogExp2(0xfff0dc, { island: 0.00005, valley: 0.00018, camp: 0.0004 }[view]);
  const sunDir = new THREE.Vector3(-0.6, 0.6, 0.5).normalize();
  sun.intensity = 2.3;
  // Shade falls pink from the sky and blue from the ground, so shadows print as overlapping inks, not grey.
  scene.add(new THREE.HemisphereLight(0xff9ad0, 0x6f8cff, 1.4));
  stage.bloom.enabled = false;
  Object.assign(stage.grade.uniforms, { uSaturation: { value: 1.25 }, uContrast: { value: 1.1 }, uVignette: { value: 0 } });

  scene.add(stage.ground(flat(0xffffff), {
    paint: /* glsl */ `
      vec3 forest = vec3(0.05, 0.42, 0.35), heath = vec3(0.95, 0.42, 0.55), meadow = vec3(0.98, 0.86, 0.25), marsh = vec3(0.3, 0.7, 0.5), rock = vec3(0.75, 0.62, 0.8), sand = vec3(1.0, 0.8, 0.6);
      float w0 = pow(ca.r, 3.0), w1 = pow(ca.g, 3.0), w2 = pow(ca.b, 3.0), w3 = pow(ca.a, 3.0), w4 = pow(cb.r, 3.0), w5 = pow(cb.g * 1.3, 3.0);
      vec3 g = (forest * w0 + heath * w1 + meadow * w2 + marsh * w3 + rock * w4 + sand * w5) / max(w0 + w1 + w2 + w3 + w4 + w5, 1e-5);
      diffuseColor.rgb = g * mix(0.6, 1.0, vSky);`,
  }));
  scene.add(...stage.water(/* glsl */ `
    vec3 c = mix(vec3(0.2, 0.7, 0.95), vec3(0.05, 0.22, 0.75), smoothstep(0.5, 10.0, depth));
    float wave = step(0.72, fract(vWorld.z / 14.0 + sin(vWorld.x / 30.0) * 0.6)) * (1.0 - smoothstep(4.0, 30.0, depth));
    c = mix(c, vec3(1.0, 0.95, 0.9), max(1.0 - smoothstep(0.0, 0.5, depth), wave * 0.8));
    gl_FragColor = vec4(c, 1.0);`, { transparent: false }));

  // ---------- trees, shrubs, rocks ----------
  const leaves = flat(0xffffff, { vertexColors: true }), bark = flat(0x8a3a58);
  const hues = { oak: 0x0d7a5a, ash: 0x1f9a6a, aspen: 0x7ac23a, pine: 0x0a4a8a };
  stage.levels(stage.trees, { island: [0, 0], valley: [900, 3200], camp: [600, 2400] }[view], 2500).forEach((list, level) => {
    const detail = 2 - level;
    for (const kind of ["oak", "ash", "aspen", "pine"]) {
      const some = list.filter((t) => t.kind === kind), c = new THREE.Color(hues[kind]);
      scene.add(scatter(kind === "pine" ? spireCrown(detail) : puffCrown({ detail }), leaves, some, (t) => [t.tall * 1.1, t.tall, t.tall * 1.1], (t, out) => out.copy(c).offsetHSL((t.tint - 0.5) * 0.06, 0, (t.tint - 0.5) * 0.1)));
    }
    if (detail) scene.add(scatter(trunk(detail), bark, list, (t) => [t.tall, t.tall, t.tall], (t, c) => c.setScalar(1)));
  });
  const [near, mid] = stage.levels(stage.shrubs, { island: [0, 0], valley: [500, 1500], camp: [300, 1000] }[view], 3000);
  [near, mid].forEach((list, level) => scene.add(scatter(puffCrown({ shrub: true, detail: 2 - level }), leaves, list, (s) => [s.tall * 1.3, s.tall, s.tall * 1.3], (s, c) => c.setRGB(0.1 + s.heath * 0.85, 0.6 - s.heath * 0.2, 0.3 + s.heath * 0.2))));
  const stone = flat(0xc9a8e8);
  const [, rocks] = stage.levels(stage.rocks, { island: [0, 0], valley: [0, 1600], camp: [0, 1200] }[view]);
  scene.add(scatter(rockGeometry(1), stone, rocks, (r) => [r.size, r.size * 0.8, r.size * 1.1], (r, c) => c.setScalar(0.85 + r.tint * 0.3)));

  if (view !== "island") {
    const { grass, flowers, pebbles } = stage.nearby(stage.camp.at, view === "camp" ? 100 : 130, view === "camp" ? 5 : 2);
    scene.add(scatter(tuft(), flat(0xffffff, { vertexColors: true, side: THREE.DoubleSide }), grass, (g) => [g.tall * 1.2, g.tall * 1.3, g.tall * 1.2], (g, c) => c.setRGB(0.5 + g.tint * 0.4, 0.85, 0.2)));
    const bloom = new THREE.IcosahedronGeometry(0.16, 1).translate(0, 0.7, 0);
    scene.add(scatter(bloom, flat(0xffffff), [...flowers, ...flowers.map((f) => ({ ...f, x: f.x + 0.6, z: f.z - 0.5, hue: (f.hue + 0.5) % 1 }))], (f) => [1.4, 1.4, 1.4], (f, c) => c.set(f.hue < 0.5 ? 0xff3aa0 : 0x2a6aff)));
    scene.add(scatter(rockGeometry(1), stone, pebbles, (p) => [p.size, p.size * 0.6, p.size], (p, c) => c.setScalar(1)));
    const pink = flat(0xff4fa8, { side: THREE.DoubleSide }), blue = flat(0x2f6bff, { side: THREE.DoubleSide }), yellow = flat(0xffd21f, { side: THREE.DoubleSide });
    scene.add(pitchCamp(stage, { tent: [pink, yellow, blue], stone, wood: bark, flame: new THREE.MeshBasicMaterial({ color: 0xff5a1f }), clothes: [blue, pink, yellow, blue, pink], skin: flat(0xffb08a), glow: 30 }));
  }

  stage.print(RISO);
  return { sunDir };
}

// Separate the picture into three inks by how much of each color of light each ink holds back, screen each into dots,
// and print them one over another.
const RISO = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: null } },
  vertexShader: QUAD,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    ${NOISE}
    const vec3 PAPER = vec3(0.97, 0.94, 0.86), BLUE = vec3(0.0, 0.47, 0.75), PINK = vec3(1.0, 0.28, 0.69), YELLOW = vec3(1.0, 0.91, 0.0);
    // Blue alone holds back red; pink holds back green, yellow holds back blue, each with some spill into the others.
    vec3 separate(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      float b = clamp(1.0 - c.r / PAPER.r, 0.0, 1.0), p = 0.0, y = 0.0;
      for (int i = 0; i < 4; i++) {
        p = clamp((1.0 - c.g / (PAPER.g * (1.0 - 0.53 * b) * (1.0 - 0.09 * y))) / 0.72, 0.0, 1.0);
        y = clamp(1.0 - c.b / (PAPER.b * (1.0 - 0.25 * b) * (1.0 - 0.31 * p)), 0.0, 1.0);
      }
      return vec3(b, p, y);
    }
    float dots(vec2 px, float angle, float k) {
      vec2 p = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * px / 4.6;
      float r = sqrt(k) * 0.64, d = length(fract(p) - 0.5);
      return 1.0 - smoothstep(r - 0.1, r + 0.1, d);
    }
    void main() {
      vec2 px = vUv / uTexel;
      // Each drum lands a little off the others.
      float b = separate(texture2D(tDiffuse, vUv + vec2(1.5, -1.0) * uTexel).rgb).x;
      float p = separate(texture2D(tDiffuse, vUv).rgb).y;
      float y = separate(texture2D(tDiffuse, vUv + vec2(-1.0, 1.8) * uTexel).rgb).z;
      // Ink lies unevenly, heavier in patches, with white specks where the drum skipped.
      float lay = 0.82 + 0.18 * fbm2(px / 50.0), skip = step(0.07, hash21(floor(px / 1.5)));
      float cb = dots(px, 0.26, b) * lay * skip, cp = dots(px, 1.31, p) * lay * skip, cy = dots(px, 0.0, y) * lay;
      vec3 col = PAPER * (0.95 + 0.05 * vnoise(px / 1.7));
      col *= mix(vec3(1.0), BLUE, cb) * mix(vec3(1.0), PINK, cp) * mix(vec3(1.0), YELLOW, cy);
      gl_FragColor = vec4(col, 1.0);
    }`,
};
