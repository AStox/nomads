// Ink: the island brushed in sumi-e on rice paper. Grey washes for the land, a wandering ink line round every form,
// hatching where the light fails, ripples echoing the shore, mist swallowing the distance, and one red: the camp.
import * as THREE from "three";
import { EDGES, NOISE, QUAD, pitchCamp, puffCrown, rockGeometry, scatter, spireCrown, trunk, tuft } from "./stage.js";

const PAPER = new THREE.Color(0xefe6d0), INK = new THREE.Color(0x1d1b21), RED = new THREE.Color(0xc8321e);

export async function dress(stage, { view }) {
  const { scene, renderer, sun } = stage;
  const mist = { island: 0.00004, valley: 0.00045, camp: 0.0011 }[view];
  renderer.toneMapping = THREE.NoToneMapping;
  scene.background = PAPER.clone();
  scene.fog = new THREE.FogExp2(PAPER.clone(), mist);
  const sunDir = new THREE.Vector3(-0.5, 0.78, 0.38).normalize();
  sun.intensity = 2.1;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.1));
  stage.bloom.enabled = false;
  Object.assign(stage.grade.uniforms, { uSaturation: { value: 1 }, uContrast: { value: 1.04 }, uVignette: { value: 0.22 } });

  // Forest floor darkest, then marsh, heath, bare rock, meadow, and sand nearly paper; broad wash marks across it.
  scene.add(stage.ground(new THREE.MeshLambertMaterial(), {
    paint: /* glsl */ `
      float t = (0.2 * ca.r + 0.42 * ca.g + 0.78 * ca.b + 0.45 * ca.a + 0.6 * cb.r + 0.95 * cb.g) / max(ca.r + ca.g + ca.b + ca.a + cb.r + cb.g, 1e-3);
      t *= 0.8 + 0.4 * fbm2(vWorld.xz / 110.0);
      t = mix(t, 0.95, cb.a * 0.7 + rv * 0.5);
      diffuseColor.rgb = vec3(t) * mix(0.5, 1.0, vSky);`,
  }));
  // Water is bare paper, with ripple lines that follow the shore's contours, broken like brush strokes.
  scene.add(...stage.water(/* glsl */ `
    float f = depth * 0.55 + fbm2(vWorld.xz / 40.0) * 0.9;
    float line = 1.0 - smoothstep(0.6, 1.6, abs(fract(f) - 0.5) / max(fwidth(f), 1e-4));
    line *= step(0.38, vnoise(vWorld.xz / 11.0)) * (1.0 - smoothstep(1.5, 9.0, depth));
    vec3 c = mix(mix(uInk, uPaper, 0.72), uPaper, smoothstep(0.0, 3.0, depth));
    gl_FragColor = vec4(mix(c, uInk, line * 0.8), 1.0);`, { decls: "uniform vec3 uInk, uPaper;", uniforms: { uInk: { value: INK }, uPaper: { value: PAPER } }, transparent: false }));

  // ---------- trees, shrubs, rocks ----------
  const grey = (lo, hi) => (o, c) => c.setScalar(lo + (hi - lo) * o.tint);
  const leaves = new THREE.MeshLambertMaterial({ vertexColors: true }), bark = new THREE.MeshLambertMaterial({ color: 0x2a2724 });
  stage.levels(stage.trees, { island: [0, 0], valley: [900, 3200], camp: [600, 2400] }[view], 2500).forEach((list, level) => {
    const detail = 2 - level, broad = list.filter((t) => t.kind !== "pine"), pines = list.filter((t) => t.kind === "pine");
    const size = (t) => [t.tall * 0.95, t.tall * 1.1, t.tall * 0.95];
    scene.add(scatter(puffCrown({ detail }), leaves, broad, size, grey(0.32, 0.55)), scatter(spireCrown(detail), leaves, pines, size, grey(0.12, 0.25)));
    if (detail) scene.add(scatter(trunk(detail), bark, list, size, grey(1, 1)));
  });
  const [near, mid] = stage.levels(stage.shrubs, { island: [0, 0], valley: [500, 1500], camp: [300, 1000] }[view], 3000);
  [near, mid].forEach((list, level) => scene.add(scatter(puffCrown({ shrub: true, detail: 2 - level }), leaves, list, (s) => [s.tall * 1.3, s.tall, s.tall * 1.3], grey(0.3, 0.55))));
  const stone = new THREE.MeshLambertMaterial({ color: 0xb8b2a6 });
  const [, rocks] = stage.levels(stage.rocks, { island: [0, 0], valley: [0, 1600], camp: [0, 1200] }[view]);
  scene.add(scatter(rockGeometry(1), stone, rocks, (r) => [r.size, r.size * 0.8, r.size * 1.1], grey(0.8, 1.1)));

  if (view !== "island") {
    const { grass, pebbles } = stage.nearby(stage.camp.at, view === "camp" ? 90 : 120, view === "camp" ? 1.2 : 0.35);
    scene.add(scatter(tuft(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), grass, (g) => [g.tall, g.tall * 1.2, g.tall], grey(0.35, 0.6)));
    scene.add(scatter(rockGeometry(1), stone, pebbles, (p) => [p.size, p.size * 0.6, p.size], grey(0.8, 1)));
    const red = new THREE.MeshLambertMaterial({ color: RED, side: THREE.DoubleSide }), black = new THREE.MeshLambertMaterial({ color: INK });
    scene.add(pitchCamp(stage, { tent: red, stone, wood: bark, flame: new THREE.MeshBasicMaterial({ color: RED }), clothes: [black, red, black, black, red], skin: black }));
  }

  const ink = stage.paint(INK_PASS);
  ink.uniforms.tG.value = stage.gbuffer();
  Object.assign(ink.uniforms, { uPaper: { value: PAPER }, uInk: { value: INK }, uRed: { value: RED }, uMist: { value: mist } });
  return { sunDir };
}

const INK_PASS = {
  uniforms: { tDiffuse: { value: null }, tG: { value: null }, uTexel: { value: null }, uPaper: { value: null }, uInk: { value: null }, uRed: { value: null }, uMist: { value: 0 } },
  vertexShader: QUAD,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tG;
    uniform vec2 uTexel;
    uniform vec3 uPaper, uInk, uRed;
    uniform float uMist;
    varying vec2 vUv;
    ${NOISE}
    ${EDGES}
    // Parallel strokes across the page at an angle, wobbling a little like a hand drawing them.
    float hatch(vec2 px, float angle, float gap, float width) {
      float s = dot(px, vec2(cos(angle), sin(angle))) / gap + vnoise(px / 45.0) * 0.9;
      return 1.0 - smoothstep(width * 0.5, width * 0.5 + 0.9, abs(fract(s) - 0.5) * gap);
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec4 g = texture2D(tG, vUv);
      vec2 px = vUv / uTexel;
      float far = g.a > 0.0 ? 1.0 - exp(-pow(g.a * uMist, 2.0)) : 1.0;

      // The line, its weight wandering like a brush.
      float line = edges(tG, vUv, uTexel, 0.8 + 1.4 * vnoise(px / 26.0), 0.75) * (1.0 - far * 0.9);

      // Tone from the render; hatching in one direction in half light, crossed in shade, a third set in deep shade.
      float tone = clamp(dot(c, vec3(0.3, 0.59, 0.11)) * 1.15 + (fbm2(px / 70.0) - 0.5) * 0.12, 0.0, 1.0);
      float h = hatch(px, 0.85, 6.5, 1.2) * (1.0 - smoothstep(0.2, 0.32, tone));
      h = max(h, hatch(px, -0.75, 6.5, 1.1) * (1.0 - smoothstep(0.08, 0.16, tone)));
      h = max(h, hatch(px, 0.1, 4.0, 1.0) * (1.0 - smoothstep(0.02, 0.05, tone)));
      h *= (1.0 - far) * step(0.001, g.a);

      // Paper with a fibrous grain; the wash laid on it; then hatching and line in ink, and the one red.
      vec3 paper = uPaper * (0.94 + 0.06 * fbm2(px / 2.5)) * (0.975 + 0.025 * vnoise(px * vec2(0.04, 0.9)));
      vec3 col = mix(mix(uInk, paper, 0.25), paper, smoothstep(0.0, 0.85, tone));
      col = mix(col, uInk, max(line, h * 0.65));
      float red = smoothstep(0.05, 0.15, c.r - max(c.g, c.b));
      col = mix(col, uRed * (0.7 + 0.5 * tone), red * (1.0 - far));
      gl_FragColor = vec4(col, 1.0);
    }`,
};
