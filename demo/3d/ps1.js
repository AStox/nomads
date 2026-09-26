// The PlayStation look: each frame drawn small and blown up with hard pixels, vertices snapped to that pixel grid so
// geometry wobbles, textures stretched affinely across each triangle, 15-bit color with ordered dithering, and fog.
import * as THREE from "three";

// Shared by every material, so one change reaches the whole scene.
export const uniforms = {
  uRes: { value: new THREE.Vector2(426, 240) },
  uSnap: { value: 1 },
  uAffine: { value: 1 },
  uPxPerM: { value: 230 }, // pixels a one meter tall thing covers from one meter away
  uClock: { value: 0 },
  uFogColor: { value: new THREE.Color(0.7, 0.8, 0.9) },
  uFogNear: { value: 3000 },
  uFogFar: { value: 20000 },
  uSun: { value: new THREE.Vector3(0.5, 0.7, 0.3).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
  uAmbient: { value: new THREE.Color(0.35, 0.4, 0.5) },
};

const COMMON = /* glsl */ `
uniform vec2 uRes;
uniform float uSnap, uAffine, uPxPerM, uClock, uFogNear, uFogFar;
uniform vec3 uFogColor, uSun, uSunColor, uAmbient;
// No subpixel precision: every vertex lands on a whole pixel of the small frame.
vec4 snap(vec4 clip) {
  if (uSnap < 0.5 || clip.w <= 0.0) return clip;
  vec2 grid = uRes * 0.5;
  clip.xy = floor(clip.xy / clip.w * grid + 0.5) / grid * clip.w;
  return clip;
}
vec3 lit(vec3 n) { return uAmbient + uSunColor * max(dot(n, uSun), 0.0); }
vec3 fogged(vec3 c, float d) { return mix(c, uFogColor, smoothstep(uFogNear, uFogFar, d)); }
float bayer(vec2 p) {
  const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  ivec2 q = ivec2(mod(floor(p), 4.0));
  return (m[q.x + q.y * 4] + 0.5) / 16.0;
}
`;

// Ground: each pixel shows the texture of whichever cover is strongest there. Where two run close, an ordered dither
// mixes them, the way PS1 games blended what they couldn't afford to blend. Ground and water triangles are tens of
// meters across, far bigger than anything a PS1 drew, so they keep perspective-correct textures; small things warp.
export function terrainMaterial({ coverA, coverB, river, ground }) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uCoverA: { value: coverA }, uCoverB: { value: coverB }, uRiver: { value: river }, uGround: { value: ground }, uTile: { value: 7 } },
    vertexShader: COMMON + /* glsl */ `
      varying vec2 vUv, vXZ;
      varying vec3 vLight;
      varying float vDist;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0), view = viewMatrix * world;
        gl_Position = snap(projectionMatrix * view);
        vUv = uv;
        vXZ = world.xz;
        vLight = lit(normalize(mat3(modelMatrix) * normal));
        vDist = length(view.xyz);
      }`,
    fragmentShader: "precision highp sampler2DArray;\n" + COMMON + /* glsl */ `
      uniform sampler2D uCoverA, uCoverB, uRiver;
      uniform sampler2DArray uGround;
      uniform float uTile;
      varying vec2 vUv, vXZ;
      varying vec3 vLight;
      varying float vDist;
      void main() {
        vec4 a = texture(uCoverA, vUv), b = texture(uCoverB, vUv);
        float w[8];
        w[0] = a.r;                 // forest floor
        w[1] = a.g;                 // heath and scrub
        w[2] = a.b * b.b;           // grass with water at its roots
        w[3] = a.b * (1.0 - b.b);   // grass gone to straw
        w[4] = a.a;                 // marsh
        w[5] = b.r;                 // bare rock
        w[6] = b.g * 1.6;           // sand
        w[7] = smoothstep(0.3, 0.6, texture(uRiver, vUv).r) * 4.0; // a stream
        int k1 = w[1] > w[0] ? 1 : 0, k2 = 1 - k1;
        for (int k = 2; k < 8; k++) {
          if (w[k] > w[k1]) { k2 = k1; k1 = k; }
          else if (w[k] > w[k2]) k2 = k;
        }
        float share = w[k2] / max(1e-4, w[k1] + w[k2]);
        int pick = bayer(gl_FragCoord.xy) < clamp((share - 0.3) * 2.5, 0.0, 0.5) ? k2 : k1;
        vec3 c = texture(uGround, vec3(vXZ / uTile, float(pick))).rgb;
        gl_FragColor = vec4(fogged(c * vLight, vDist), 1.0);
      }`,
  });
}

// Open water, sea or lake: shallows to deeps by the ground under it, rolling ripples, and foam where it meets land.
export function waterMaterial({ height, size, wave }) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uHeight: { value: height }, uSize: { value: size }, uWave: { value: wave } },
    vertexShader: COMMON + /* glsl */ `
      varying vec3 vWorld;
      varying float vDist;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0), view = viewMatrix * world;
        gl_Position = snap(projectionMatrix * view);
        vWorld = world.xyz;
        vDist = length(view.xyz);
      }`,
    fragmentShader: COMMON + /* glsl */ `
      uniform sampler2D uHeight, uWave;
      uniform float uSize;
      varying vec3 vWorld;
      varying float vDist;
      void main() {
        vec2 uv = vWorld.xz / uSize + 0.5;
        bool inside = all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)));
        float depth = inside ? vWorld.y - texture(uHeight, uv).r : 60.0;
        vec3 c = mix(vec3(0.26, 0.55, 0.58), vec3(0.05, 0.15, 0.32), smoothstep(0.0, 24.0, depth));
        float wave = (texture(uWave, vWorld.xz / 22.0 + uClock * vec2(0.010, 0.006)).r + texture(uWave, vWorld.xz / 37.0 - uClock * vec2(0.004, 0.009)).r) * 0.5;
        c *= 0.84 + 0.3 * wave;
        float foam = (1.0 - smoothstep(0.0, 0.5 + 0.35 * sin(uClock * 0.9 + (vWorld.x + vWorld.z) * 0.02), depth)) * (1.0 - smoothstep(800.0, 4000.0, vDist));
        if (bayer(gl_FragCoord.xy) < foam * 0.85) c = mix(c, vec3(0.86, 0.92, 0.9), 0.7);
        vec3 v = normalize(cameraPosition - vWorld);
        float glint = pow(max(dot(reflect(-uSun, vec3(0.0, 1.0, 0.0)), v), 0.0), 60.0) * step(0.55, wave);
        c = c * (uAmbient + uSunColor * 0.75) + uSunColor * glint;
        gl_FragColor = vec4(fogged(c, vDist), 1.0);
      }`,
  });
}

// Low-poly things, instanced or not: vertex colors under a speckled grey texture, lit per vertex. Anything smaller than
// a pixel folds away, so a far forest doesn't fizz.
export function propMaterial(tex, { shrink = true } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uTex: { value: tex }, uShrink: { value: shrink ? 1 : 0 } },
    vertexColors: true,
    vertexShader: COMMON + /* glsl */ `
      uniform float uShrink;
      varying vec3 vColor, vLight, vAff;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = m * instanceMatrix;
        #endif
        vec4 world = m * vec4(position, 1.0);
        if (uShrink > 0.5) {
          vec3 base = m[3].xyz;
          float px = length(m[1].xyz) / max(1.0, distance(base, cameraPosition)) * uPxPerM;
          world.xyz = base + (world.xyz - base) * smoothstep(0.6, 1.6, px);
        }
        vec4 view = viewMatrix * world;
        gl_Position = snap(projectionMatrix * view);
        vUv = uv;
        vAff = vec3(uv * gl_Position.w, gl_Position.w);
        vColor = color;
        #ifdef USE_INSTANCING_COLOR
          vColor *= instanceColor;
        #endif
        vLight = lit(normalize(mat3(m) * normal));
        vDist = length(view.xyz);
      }`,
    fragmentShader: COMMON + /* glsl */ `
      uniform sampler2D uTex;
      varying vec3 vColor, vLight, vAff;
      varying vec2 vUv;
      varying float vDist;
      void main() {
        float t = texture(uTex, mix(vUv, vAff.xy / vAff.z, uAffine)).r;
        gl_FragColor = vec4(fogged(vColor * t * vLight, vDist), 1.0);
      }`,
  });
}

// A dome that follows the camera: horizon to zenith, the sun or moon, and stars at night.
export function skyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uZenith: { value: new THREE.Color() }, uNight: { value: 0 } },
    vertexShader: COMMON + /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = snap(projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0));
      }`,
    fragmentShader: COMMON + /* glsl */ `
      uniform vec3 uZenith;
      uniform float uNight;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = mix(uFogColor, uZenith, pow(clamp(d.y, 0.0, 1.0), 0.55));
        float s = dot(d, uSun);
        c += uSunColor * (smoothstep(0.9975, 0.999, s) * 1.2 + pow(max(s, 0.0), 24.0) * 0.25);
        c += vec3(0.9) * uNight * step(0.9983, hash(floor(d * 260.0))) * step(0.02, d.y);
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
}

// Light through the day: [hour, zenith, horizon and fog, sun, ambient, stars].
const DAY = [
  [0, 0x0a0e24, 0x1c2644, 0x6070a8, 0x2c3660, 1],
  [5, 0x0e1430, 0x283050, 0x6878ac, 0x303a64, 1],
  [6.5, 0x34508a, 0xe0a070, 0xffb070, 0x5a4a60, 0.2],
  [9, 0x3a70c8, 0xa8c4e0, 0xfff0d8, 0x6a7890, 0],
  [15, 0x3a70c8, 0xa8c4e0, 0xfff0d8, 0x6a7890, 0],
  [18, 0x4a3a78, 0xf08a50, 0xff9048, 0x6a4a58, 0],
  [19.5, 0x1c1a40, 0x503858, 0x8a6aa0, 0x363458, 0.6],
  [21, 0x0a0e24, 0x1c2644, 0x6070a8, 0x2c3660, 1],
  [24, 0x0a0e24, 0x1c2644, 0x6070a8, 0x2c3660, 1],
];
export function setTime(hours, sky) {
  let k = 0;
  while (DAY[k + 1][0] < hours) k++;
  const [h0, ...a] = DAY[k], [h1, ...b] = DAY[k + 1], t = (hours - h0) / (h1 - h0);
  const mix = (j, out) => out.set(a[j]).lerp(new THREE.Color(b[j]), t);
  mix(0, sky.uniforms.uZenith.value);
  mix(1, uniforms.uFogColor.value);
  mix(2, uniforms.uSunColor.value);
  mix(3, uniforms.uAmbient.value);
  sky.uniforms.uNight.value = a[4] + (b[4] - a[4]) * t;
  // The sun climbs from the east and sets in the west; by night the moon stands in for it.
  const arc = ((hours - 6) / 12) * Math.PI;
  uniforms.uSun.value.set(Math.cos(arc), Math.abs(Math.sin(arc)) * 0.9 + 0.08, 0.45).normalize();
}

// The small frame is quantized to 15-bit color through a 4x4 ordered dither, then shown with hard pixels.
export function post(target) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const material = new THREE.ShaderMaterial({
    uniforms: { tFrame: { value: target.texture }, uDither: { value: 1 } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: COMMON + /* glsl */ `
      uniform sampler2D tFrame;
      uniform float uDither;
      varying vec2 vUv;
      void main() {
        vec3 c = texture(tFrame, vUv).rgb;
        if (uDither > 0.5) c = floor(c * 31.0 + bayer(gl_FragCoord.xy)) / 31.0;
        gl_FragColor = vec4(c, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  return { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material };
}

// ---------- pixel textures, painted by code ----------
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Value noise that wraps every `p` lattice steps, so tiles repeat without seams.
function pnoise(x, y, p, s) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const v = (i, j) => hash(((i % p) + p) % p, ((j % p) + p) % p, s);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return (v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx) * (1 - sy) + (v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx) * sy;
}
const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
function pixels(texture) {
  texture.needsUpdate = true;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Ground tiles, 32 pixels to 7 meters, one layer per cover in the order the terrain shader numbers them.
const TILE = 32;
const PALETTES = [
  [0x2e3a1e, 0x3d4b26, 0x4a5a2c, 0x6a5530], // forest floor, with fallen needles
  [0x4f3a44, 0x644656, 0x7a5468, 0x8a8040], // heather, a little gorse
  [0x3f6a2a, 0x4f7d33, 0x5f913d, 0x9ab048], // green grass
  [0x7a7a40, 0x8e8c4c, 0xa29e5a, 0x6a6436], // straw
  [0x3e4c30, 0x4a5a36, 0x56663c, 0x3a5058], // marsh, with standing water
  [0x5e5a52, 0x74706a, 0x8a8680, 0x46423c], // rock, with cracks
  [0xb8a67a, 0xc8b88a, 0xd6c89c, 0xa08e66], // sand
  [0x2f5a78, 0x3a6a8a, 0x4a7e9c, 0x7ab0c8], // running water
];
export function groundTiles() {
  const data = new Uint8Array(TILE * TILE * 4 * PALETTES.length);
  PALETTES.forEach((pal, m) => {
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const n = 0.65 * pnoise(x / 4, y / 4, 8, m) + 0.35 * pnoise(x / 2, y / 2, 16, m + 9);
        let c = n < 0.42 ? 0 : n < 0.62 ? 1 : 2;
        if (hash(x, y, m + 40) > 0.94) c = 3;
        if ((m === 2 || m === 3) && hash(x >> 1, y >> 1, m + 50) > 0.85) c = m === 2 ? 2 : 1; // tufts
        if (m === 5 && Math.abs(pnoise(x / 4, y / 4, 8, 77) - 0.5) < 0.035) c = 3; // cracks
        if (m === 7) c = Math.abs(((x + y * 0.25 + pnoise(x / 8, y / 8, 4, 81) * 8) % 8) - 4) < 0.7 ? 3 : n < 0.5 ? 0 : 1;
        data.set([...rgb(pal[c]), 255], ((m * TILE + y) * TILE + x) * 4);
      }
  });
  return pixels(new THREE.DataArrayTexture(data, TILE, TILE, PALETTES.length));
}

// One grey speckle for every model; their vertex colors carry the hue.
export function speckle() {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const v = 0.6 * pnoise(x / 4, y / 4, 8, 70) + 0.4 * hash(x, y, 71);
      const g = [178, 206, 232, 255][Math.min(3, Math.floor(v * 4))];
      data.set([g, g, g, 255], (y * 32 + x) * 4);
    }
  return pixels(new THREE.DataTexture(data, 32, 32));
}

// Ripples for the water, bright crests on a dark swell.
export function waves() {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const band = Math.abs(((y + pnoise(x / 8, y / 8, 4, 90) * 7) % 8) - 4);
      const g = band < 0.8 ? 255 : band < 1.8 ? 170 : 110;
      data.set([g, g, g, 255], (y * 32 + x) * 4);
    }
  return pixels(new THREE.DataTexture(data, 32, 32));
}
