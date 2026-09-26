// The look: PS1-era bones (chunky faceted polygons, crisp pixel-art textures) under modern light: soft shadows, baked
// occlusion, aerial haze, see-through shallows, and a tilt-shift lens that turns the island into a tabletop miniature.
import * as THREE from "three";

export const time = { value: 0 };

// ---------- ground, water and things ----------
// Ground: every cover's texture, weighted by how much of it grows there. The weights are sharpened, so each cover holds
// its own patch and meets the next in a short blend rather than a wash.
export function terrainMaterial({ coverA, coverB, river, tiles }) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uCoverA: { value: coverA }, uCoverB: { value: coverB }, uRiver: { value: river }, uTiles: { value: tiles } });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vCover;\nvarying vec2 vGround;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCover = uv;\nvGround = (modelMatrix * vec4(transformed, 1.0)).xz / 3.5;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", /* glsl */ `#include <common>
        uniform sampler2D uCoverA, uCoverB, uRiver;
        uniform highp sampler2DArray uTiles;
        varying vec2 vCover;
        varying vec2 vGround;`)
      .replace("#include <map_fragment>", /* glsl */ `
        vec4 a = texture2D(uCoverA, vCover), b = texture2D(uCoverB, vCover);
        float w[8];
        w[0] = a.r;                                   // forest floor
        w[1] = a.g;                                   // heath and scrub
        w[2] = a.b * b.b;                             // grass with water at its roots
        w[3] = a.b * (1.0 - b.b);                     // grass gone to straw
        w[4] = a.a;                                   // marsh
        w[5] = b.r * (1.0 - b.a);                     // bare rock
        w[6] = max(b.g * 1.6, b.a * 1.4);             // sand, and the bed under the water
        w[7] = smoothstep(0.3, 0.6, texture2D(uRiver, vCover).r) * 2.5; // a stream
        vec3 ground = vec3(0.0);
        float total = 0.0;
        for (int k = 0; k < 8; k++) {
          float wk = w[k] * w[k] * w[k] * w[k];
          ground += texture(uTiles, vec3(vGround, float(k))).rgb * wk;
          total += wk;
        }
        diffuseColor.rgb *= ground / max(total, 1e-5) * (1.0 - 0.4 * b.a);`);
  };
  return material;
}

// Open water, sea or lake: see-through over the shallows, deepening to ink, with pixel ripples that catch the sun, the
// sky in it at a glance, and foam where it laps the shore.
export function waterMaterial({ height, size, wave }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHeight: { value: height }, uWave: { value: wave }, uSize: { value: size }, uTime: time,
      uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() }, uSky: { value: new THREE.Color() },
      fogColor: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 2000 }, fogDensity: { value: 0 },
    },
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
      uniform sampler2D uHeight, uWave;
      uniform float uSize, uTime;
      uniform vec3 uSun, uSunColor, uSky;
      varying vec3 vWorld;
      float swell(vec2 p) {
        return texture2D(uWave, p / 26.0 + uTime * vec2(0.011, 0.007)).r * 0.6 + texture2D(uWave, p / 47.0 - uTime * vec2(0.005, 0.009)).r * 0.4;
      }
      void main() {
        vec2 uv = vWorld.xz / uSize + 0.5;
        // Past the map there's only open ocean; the shelf falls away to it over the last kilometer inside the edge.
        float rim = 1.0 - smoothstep(0.0, 0.12, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
        float depth = max(vWorld.y - texture2D(uHeight, clamp(uv, 0.0, 1.0)).r, rim * 60.0);
        float h = swell(vWorld.xz);
        vec3 n = normalize(vec3((h - swell(vWorld.xz + vec2(0.8, 0.0))) * 1.4, 1.0, (h - swell(vWorld.xz + vec2(0.0, 0.8))) * 1.4));
        vec3 v = normalize(cameraPosition - vWorld);
        float glance = pow(1.0 - max(dot(n, v), 0.0), 5.0);
        vec3 body = mix(vec3(0.06, 0.34, 0.36), vec3(0.008, 0.045, 0.12), smoothstep(0.0, 22.0, depth)) * (uSky * 0.7 + uSunColor * 0.3);
        vec3 c = mix(body, fogColor, 0.02 + 0.6 * glance);
        c += uSunColor * pow(max(dot(reflect(-uSun, n), v), 0.0), 160.0) * 3.0;
        float foam = smoothstep(0.8, 0.0, depth + (h - 0.5) * 0.7) * step(0.0, depth) * (1.0 - 0.7 * smoothstep(0.2, 1.0, vWorld.y));
        c = mix(c, uSky * 0.7 + uSunColor * 0.35, foam * 0.85);
        // The frame is floating point, so blending won't clamp alpha for us, and alpha over one would subtract
        // whatever lies behind.
        gl_FragColor = vec4(c, clamp(max(mix(0.42, 1.0, smoothstep(0.0, 9.0, depth)) + glance, foam * 0.9), 0.0, 1.0));
        #include <fog_fragment>
      }`,
    fog: true,
    transparent: true,
  });
}

// Low-poly things: faceted, vertex colored, under one grey speckle that makes every surface read as a pixel texture.
export const propMaterial = (speckle) => new THREE.MeshLambertMaterial({ vertexColors: true, map: speckle, flatShading: true });

// ---------- light through the day ----------
// [hour, zenith, horizon and haze, sun or moon, its strength, sky fill, ground bounce, fill strength, stars]
const DAY = [
  [0, 0x0b1030, 0x1e2a4a, 0x93a3d0, 0.6, 0x34467a, 0x14181e, 0.8, 1],
  [5.5, 0x1a2250, 0x3a3a5a, 0x9aa6d0, 0.6, 0x3e4a7a, 0x181c24, 0.8, 0.8],
  [6.5, 0x4a6ab0, 0xf0b080, 0xffb070, 1.6, 0x8a98c8, 0x3a3028, 0.9, 0.1],
  [9, 0x3f7fd8, 0xbcd6ee, 0xfff2dc, 3, 0xb4ccf0, 0x5a5040, 1.15, 0],
  [15, 0x3f7fd8, 0xbcd6ee, 0xfff2dc, 3, 0xb4ccf0, 0x5a5040, 1.15, 0],
  [18, 0x5070c0, 0xf4b070, 0xffb060, 2.4, 0xa0a0c8, 0x4a3a30, 0.95, 0],
  [19.5, 0x2a2a60, 0xc07068, 0xff8050, 0.9, 0x6a5a8a, 0x2a2228, 0.8, 0.4],
  [21, 0x0b1030, 0x1e2a4a, 0x93a3d0, 0.6, 0x34467a, 0x14181e, 0.8, 1],
  [24, 0x0b1030, 0x1e2a4a, 0x93a3d0, 0.6, 0x34467a, 0x14181e, 0.8, 1],
];
export function daylight(hours) {
  const at = ((hours % 24) + 24) % 24;
  let k = 0;
  while (DAY[k + 1][0] < at) k++;
  const a = DAY[k], b = DAY[k + 1], t = (at - a[0]) / (b[0] - a[0]);
  const color = (j) => new THREE.Color(a[j]).lerp(new THREE.Color(b[j]), t), num = (j) => a[j] + (b[j] - a[j]) * t;
  // The sun climbs from the east and sets in the west; by night the moon stands in for it.
  const arc = ((at - 6) / 12) * Math.PI;
  return {
    zenith: color(1), horizon: color(2), sun: color(3), strength: num(4), sky: color(5), ground: color(6), fill: num(7), stars: num(8),
    dir: new THREE.Vector3(Math.cos(arc), Math.abs(Math.sin(arc)) * 1.1 + 0.08, 0.5).normalize(),
  };
}

// A dome that rides with the camera: zenith to horizon, a sun or moon with its glow, and stars by night.
export function skyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() }, uStars: { value: 0 } },
    vertexShader: "varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uHorizon, uSun, uSunColor;
      uniform float uStars;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = mix(uHorizon, uZenith, pow(clamp(d.y, 0.0, 1.0), 0.6));
        float s = max(dot(d, uSun), 0.0);
        c += uSunColor * (smoothstep(0.9993, 0.9997, s) * 12.0 + pow(s, 40.0) * 0.5 + pow(s, 6.0) * 0.12);
        vec3 cell = floor(d * 300.0);
        float star = step(0.9985, fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
        c += vec3(0.9) * star * uStars * smoothstep(0.02, 0.2, d.y);
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

// ---------- the lens ----------
// A tilt-shift: a band held sharp across the thing in view, and a soft bokeh blur growing toward the top and bottom
// of the frame, as a macro lens gives a model. Also a touch of extra color, a vignette, and the tone curve.
export function lens(frame) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tFrame: { value: frame.texture }, uTexel: { value: new THREE.Vector2() },
      uFocus: { value: 0.5 }, uBand: { value: 0.12 }, uBlur: { value: 0 }, uSaturation: { value: 1.18 }, uVignette: { value: 0.35 },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: /* glsl */ `
      uniform sampler2D tFrame;
      uniform vec2 uTexel;
      uniform float uFocus, uBand, uBlur, uSaturation, uVignette;
      varying vec2 vUv;
      void main() {
        float r = uBlur * smoothstep(0.0, 0.42, max(0.0, abs(vUv.y - uFocus) - uBand));
        vec3 c;
        if (r < 0.6) c = texture2D(tFrame, vUv).rgb;
        else {
          // A spiral of taps over a disc, turned a little per pixel so no pattern shows; bright taps weigh more,
          // so highlights bloom into round bokeh.
          float turn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2832;
          vec3 sum = vec3(0.0);
          float total = 0.0;
          for (int i = 0; i < 32; i++) {
            float f = float(i) + 0.5, a = f * 2.39996 + turn;
            vec3 s = texture2D(tFrame, vUv + vec2(cos(a), sin(a)) * sqrt(f / 32.0) * r * uTexel).rgb;
            float wt = 1.0 + 4.0 * max(0.0, max(s.r, max(s.g, s.b)) - 0.9);
            sum += s * wt;
            total += wt;
          }
          c = sum / total;
        }
        c = max(vec3(0.0), mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uSaturation));
        vec2 q = vUv - 0.5;
        gl_FragColor = vec4(c * (1.0 - uVignette * dot(q, q) * 2.0), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    depthTest: false,
    depthWrite: false,
    toneMapped: true,
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
// Crisp texels up close, smooth and steady far off.
function pixels(texture, color) {
  texture.needsUpdate = true;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Ground tiles, 32 pixels to 3.5 meters, one layer per cover in the order the terrain shader numbers them. Shades sit
// close together, so the ground reads as a pixel texture rather than noise.
const TILE = 32;
const PALETTES = [
  [0x45552a, 0x4f6030, 0x596b36, 0x76603a], // forest floor, with fallen needles
  [0x6a4c5e, 0x77566a, 0x846076, 0xa09250], // heather, a little gorse
  [0x588a38, 0x60933e, 0x699c44, 0x9cb85c], // green grass
  [0x9c9650, 0xa8a15a, 0xb4ad64, 0x8a8246], // straw
  [0x566b40, 0x5e7446, 0x667d4c, 0x4d6a74], // marsh, with standing water
  [0x7c7870, 0x86827a, 0x908c84, 0x66625a], // rock, with cracks
  [0xd2c294, 0xdacb9e, 0xe2d4a8, 0xc0ae82], // sand
  [0x3a7896, 0x4282a0, 0x4c8eac, 0x90c8dc], // running water
];
export function groundTiles() {
  const data = new Uint8Array(TILE * TILE * 4 * PALETTES.length);
  PALETTES.forEach((pal, m) => {
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const n = 0.65 * pnoise(x / 4, y / 4, 8, m) + 0.35 * pnoise(x / 2, y / 2, 16, m + 9);
        let c = n < 0.42 ? 0 : n < 0.62 ? 1 : 2;
        if (hash(x, y, m + 40) > 0.965) c = 3;
        if ((m === 2 || m === 3) && hash(x >> 1, y >> 1, m + 50) > 0.88) c = m === 2 ? 2 : 1; // tufts
        if (m === 5 && Math.abs(pnoise(x / 4, y / 4, 8, 77) - 0.5) < 0.025) c = 3; // cracks
        if (m === 7) c = Math.abs(((x + y * 0.25 + pnoise(x / 8, y / 8, 4, 81) * 8) % 8) - 4) < 0.7 ? 3 : n < 0.5 ? 0 : 1;
        data.set([...rgb(pal[c]), 255], ((m * TILE + y) * TILE + x) * 4);
      }
  });
  return pixels(new THREE.DataArrayTexture(data, TILE, TILE, PALETTES.length), true);
}

// One grey speckle for every model; their vertex colors carry the hue.
export function speckle() {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const v = 0.6 * pnoise(x / 4, y / 4, 8, 70) + 0.4 * hash(x, y, 71);
      const g = [190, 214, 236, 255][Math.min(3, Math.floor(v * 4))];
      data.set([g, g, g, 255], (y * 32 + x) * 4);
    }
  return pixels(new THREE.DataTexture(data, 32, 32), false);
}

// A swell for the water: rolling bands of height, for its ripples to be drawn from.
export function waves() {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const band = Math.abs(((y + pnoise(x / 8, y / 8, 4, 90) * 7) % 8) - 4);
      const g = band < 0.8 ? 255 : band < 1.8 ? 170 : 110;
      data.set([g, g, g, 255], (y * 32 + x) * 4);
    }
  return pixels(new THREE.DataTexture(data, 32, 32), false);
}
