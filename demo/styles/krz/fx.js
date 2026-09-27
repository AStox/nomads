// Stage effects: halos round the lights, cones of light, fog cards hung between depth layers, smoke and embers.
import * as THREE from "three";
import { hash, clamp } from "../world.js";

function canvasTex(W, H, paint) {
  const cv = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = cv.getContext("2d");
  paint(g, W, H);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let glowTex;
export function glow(color, size, at, opacity = 1) {
  glowTex ??= canvasTex(128, 128, (g, W) => {
    const r = g.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.08, "rgba(255,255,255,0.75)"); r.addColorStop(0.25, "rgba(255,255,255,0.22)");
    r.addColorStop(0.55, "rgba(255,255,255,0.05)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, W, W);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity }));
  s.position.copy(at);
  s.scale.setScalar(size);
  s.renderOrder = 5;
  return s;
}

// A cone of light, apex at `top`, spreading to radius r at the ground: brightest where it is thickest to the eye.
export function lightCone(top, height, r, color, strength = 0.5) {
  const g = new THREE.ConeGeometry(r, height, 28, 6, true).translate(0, -height / 2, 0);
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uCol: { value: new THREE.Color(color) }, uK: { value: strength }, uH: { value: height } },
    vertexShader: /* glsl */ `varying float vT; varying vec3 vN, vV; uniform float uH;
      void main() { vT = -position.y / uH; vec4 p = modelViewMatrix * vec4(position, 1.0); vV = -p.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * p; }`,
    fragmentShader: /* glsl */ `uniform vec3 uCol; uniform float uK; varying float vT; varying vec3 vN, vV;
      void main() { float face = abs(dot(normalize(vN), normalize(vV)));
        float a = uK * pow(face, 1.6) * smoothstep(0.0, 0.12, vT) * (1.0 - 0.55 * vT) * smoothstep(1.0, 0.9, vT);
        gl_FragColor = vec4(uCol * a, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.copy(top);
  mesh.renderOrder = 4;
  return mesh;
}

// Soft-topped mist cards: textures with a ragged upper edge, faded at the sides.
const cardTex = [];
function mistTex(k) {
  return (cardTex[k] ??= canvasTex(512, 128, (g, W, H) => {
    const img = g.createImageData(W, H);
    for (let x = 0; x < W; x++) {
      const u = x / W, edge = 0.35 + 0.25 * Math.sin(u * 9 + k * 2) * 0.5 + 0.18 * Math.sin(u * 23 + k * 5) * 0.5 + 0.1 * (hash(x >> 3, k, 9) - 0.5);
      const side = Math.min(1, u / 0.18, (1 - u) / 0.18);
      for (let y = 0; y < H; y++) {
        const t = 1 - y / H, a = clamp((edge - t) / 0.28, 0, 1) ** 1.5 * side * side * (0.8 + 0.2 * clamp(1 - t * 1.4, 0, 1));
        const o = (y * W + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
  }));
}

// A vertical card facing the camera along `fwd`, centred at `at` with its bottom edge at at.y.
export function mistCard(at, width, height, fwd, color, opacity, k = 0) {
  const m = new THREE.MeshBasicMaterial({ map: mistTex(k % 3), color, transparent: true, opacity, depthWrite: false, fog: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height).translate(0, height / 2, 0), m);
  mesh.position.copy(at);
  mesh.rotation.y = Math.atan2(-fwd.x, -fwd.z);
  mesh.renderOrder = 3;
  return mesh;
}

// A mist sheet lying on the ground or water.
let sheetT;
export function mistSheet(at, sx, sz, yaw, color, opacity) {
  sheetT ??= canvasTex(256, 256, (g, W) => {
    const img = g.createImageData(W, W);
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        const u = x / W - 0.5, v = y / W - 0.5, r = Math.hypot(u * 1.0, v * 2.2) * 2;
        const n = 0.75 + 0.25 * Math.sin(x * 0.07 + Math.sin(y * 0.05) * 3) * Math.sin(y * 0.11);
        const o = (y * W + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = clamp(1 - r, 0, 1) ** 1.6 * n * 255;
      }
    g.putImageData(img, 0, 0);
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: sheetT, color, transparent: true, opacity, depthWrite: false, fog: false }));
  mesh.position.copy(at);
  mesh.rotation.y = yaw;
  mesh.renderOrder = 3;
  return mesh;
}

// Smoke: flat, faceted puffs rising and widening downwind, warm where the fire lights them and cold above.
export function smoke(base, wind, camera, rand, { n = 26, rise = 26, warm = "#8a5634", cold = "#39424f" } = {}) {
  const group = new THREE.Group(), wc = new THREE.Color(warm), cc = new THREE.Color(cold);
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1), y = 1.3 + t ** 1.1 * rise, drift = t ** 2 * rise * 0.6;
    const r = 0.2 + t * 2.2 + rand() * 0.3, sides = 5 + Math.floor(rand() * 3);
    const g = new THREE.CircleGeometry(r, sides);
    const p = g.attributes.position;
    for (let i = 1; i < p.count; i++) { const j = 0.7 + rand() * 0.6; p.setXY(i, p.getX(i) * j * 0.9, p.getY(i) * j * 1.3); }
    const c = cc.clone().lerp(wc, clamp(1 - t * 3, 0, 1));
    const m = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.16 * (1 - t) ** 1.2 + 0.025, depthWrite: false, fog: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(base.x + wind.x * drift + (rand() - 0.5) * t * 2.5, base.y + y, base.z + wind.y * drift + (rand() - 0.5) * t * 2.5);
    mesh.quaternion.copy(camera.quaternion);
    mesh.rotateZ(rand() * 6.28);
    mesh.renderOrder = 6 + k;
    group.add(mesh);
  }
  return group;
}

export function embers(base, wind, rand, n = 40, rise = 9, size = 2.2) {
  const pos = [];
  for (let k = 0; k < n; k++) {
    const t = rand() ** 1.4, y = 0.6 + t * rise;
    pos.push(base.x + wind.x * t * rise * 0.4 + (rand() - 0.5) * (0.5 + t * 2), base.y + y, base.z + wind.y * t * rise * 0.4 + (rand() - 0.5) * (0.5 + t * 2));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: "#ffb04a", size, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
}

// Grain and a heavy vignette over the finished frame.
export function grade(opts) {
  const m = new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { uV: { value: opts.vignette ?? 0.55 }, uG: { value: opts.grain ?? 0.05 }, uAsp: { value: innerWidth / innerHeight } },
    vertexShader: `varying vec2 vU; void main() { vU = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `uniform float uV, uG, uAsp; varying vec2 vU;
      float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 c = (vU - 0.5) * vec2(uAsp, 1.0);
        float v = smoothstep(0.45, 1.25, length(c)) * uV;
        float n = (h(gl_FragCoord.xy) - 0.5) * uG;
        gl_FragColor = vec4(vec3(max(n, 0.0) * (1.0 - v)), v + max(-n, 0.0) * (1.0 - v));
      }`,
  });
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m));
  return { scene, cam };
}

// A dialogue box in the empty sky, the way the story talks over its stage: a line of narration and numbered replies.
export async function dialogue({ x, y, width, text, choices, pick }) {
  const face = '"Bitstream Charter", "Liberation Serif", Georgia, serif';
  await Promise.all([document.fonts.load(`17px ${face}`), document.fonts.load(`italic 15px ${face}`)]).catch(() => {});
  const W = innerWidth, H = innerHeight;
  const tex = canvasTex(W, H, (g) => {
    const wrap = (s, font, max) => {
      g.font = font;
      const out = [];
      let line = "";
      for (const word of s.split(" ")) { const t = line ? `${line} ${word}` : word; if (g.measureText(t).width > max && line) { out.push(line); line = word; } else line = t; }
      return [...out, line];
    };
    const pad = 20, body = wrap(text, `17px ${face}`, width - pad * 2), opts = choices.map((c, k) => wrap(`${k + 1}.  ${c}`, `15px ${face}`, width - pad * 2 - 14));
    const h = pad * 2 + body.length * 25 + 14 + opts.reduce((a, o) => a + o.length * 21 + 6, 0);
    g.fillStyle = "rgba(4,6,10,0.72)";
    g.fillRect(x, y, width, h);
    g.strokeStyle = "rgba(210,220,230,0.22)";
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, width - 1, h - 1);
    g.textBaseline = "top";
    let ty = y + pad;
    g.font = `17px ${face}`;
    g.fillStyle = "#e9e6dc";
    for (const l of body) { g.fillText(l, x + pad, ty); ty += 25; }
    ty += 14;
    opts.forEach((o, k) => {
      g.font = `15px ${face}`;
      g.fillStyle = k === pick ? "#ffc27a" : "#9aa8b6";
      if (k === pick) g.fillText("\u203a", x + pad - 12, ty);
      for (const l of o) { g.fillText(l, x + pad, ty); ty += 21; }
      ty += 6;
    });
  });
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })));
  return { scene, cam };
}
