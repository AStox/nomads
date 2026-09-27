// Nomads as a handmade paper model: the island cut as a stack of card contour sheets on a cutting mat, the sea two
// sheets of blue paper, and every tree, rock, tent and person folded or cut from paper, shot under a studio lamp.
import * as THREE from "three";
import { grow, clamp, smooth, hash, fbm } from "../world.js";
import { COLORS } from "../island.js";
import { trace, cut, shapes, tops, walls, geometry } from "./contour.js";
import { PAPER, grainTexture, shared, paperMaterial, OBJECT_LIGHT, softerShadows, canvas } from "./paper.js";
import * as P from "./models.js";

const query = new URLSearchParams(location.search);
const VIEW = ["island", "valley", "camp"].includes(query.get("view")) ? query.get("view") : "valley";
const SEED = Number(query.get("seed") || 1);
const fail = (e) => { document.body.dataset.error = String((e && e.stack) || e); document.body.classList.add("failed"); console.error(e); };
addEventListener("error", (e) => fail(e.error || e.message));
addEventListener("unhandledrejection", (e) => fail(e.reason));

// Per view: contour bands ([up to height, interval] in m) and the model height of one sheet (so low ground can be
// cut finer than the hills), card share of each step, model scale (world m per model mm), camera, lamp, and how
// the standing things are thinned and scaled at that zoom.
const VIEWS = {
  island: {
    bands: [[1e9, 16]], step: 48, card: 0.4, inset: 0.75, shallow: -16, mm: 12, grid: 640, detail: 0,
    fov: 26, elev: 46, turn: 0.25, dist: 17000, light: { turn: 2.2, elev: 42 }, sun: 3.4, hemi: 0.8,
    trees: { keep: 0.09, scale: 4.5 }, shrubs: { keep: 0.05, scale: 5 }, rocks: { keep: 0.1, scale: 4, min: 1.5 },
    dof: { k: 20, max: 10 }, shadow: { radius: 2 },
  },
  valley: {
    bands: [[16, 2.5], [60, 5], [1e9, 10]], step: 7, card: 0.5, inset: 0.8, shallow: -4, mm: 1.6, grid: 640, detail: 0.5,
    fov: 30, elev: 24, turn: 0.1, frame: 360, ahead: 120, light: { turn: 2.2, elev: 40 }, sun: 3.4, hemi: 0.8,
    trees: { keep: 0.7, scale: 1.7 }, shrubs: { keep: 0.8, scale: 2 }, rocks: { keep: 1, scale: 1.6, min: 0 }, camp: 1.8,
    grass: { scale: 3, per: 2.2, reach: 330, hole: 0 },
    dof: { k: 10, max: 11 }, shadow: { radius: 3 },
  },
  camp: {
    bands: [[1e9, 1.25]], step: 1.5, card: 0.6, inset: 0.35, shallow: -1.5, mm: 0.12, grid: 560, detail: 0.18,
    fov: 30, elev: 17, turn: 0.1, frame: 28, ahead: 5, light: { turn: 2.2, elev: 40 }, sun: 3.4, hemi: 0.8,
    trees: { keep: 1, scale: 1 }, shrubs: { keep: 1, scale: 1 }, rocks: { keep: 1, scale: 1, min: 0 }, nearby: 40, camp: 1,
    grass: { scale: 1.4, per: 40, reach: 140, hole: 38 },
    dof: { k: 16, max: 14 }, shadow: { radius: 4 },
  },
};

const glsl = (hex) => { const c = new THREE.Color(hex); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };
const rad = (d) => (d * Math.PI) / 180;

main().catch(fail);

async function main() {
  softerShadows();
  const w = grow(SEED);
  const V = VIEWS[VIEW], camp = w.camp, C = camp.at;
  // Framing overrides for tuning a shot: ?frame=&elev=&ahead=&turn=&fov=&dist=&dof=
  for (const k of ["frame", "elev", "ahead", "turn", "fov", "dist"]) if (query.has(k)) V[k] = Number(query.get(k));
  if (query.has("dof")) V.dof.k = Number(query.get("dof"));
  const step = V.step, yDeep = step * 0.1, yShallow = yDeep + step * 0.28;
  const topY = (v) => (v <= 1 ? yDeep + v * (yShallow - yDeep) : yShallow + (v - 1) * step);

  // Levels: the coast, then every interval of its band, shifted so the camp ground sits in the middle of one sheet.
  const surface = makeSurface(w, V.detail, VIEW === "camp" ? 7 : 45);
  const campPts = [C, camp.woodpile, ...camp.tents.map((t) => t.at), ...camp.people.map((p) => p.at)];
  for (let a = 0; a < 12; a++) campPts.push({ x: C.x + Math.cos(a * 0.52) * 4, z: C.z + Math.sin(a * 0.52) * 4 });
  const campYs = campPts.map((p) => surface(p.x, p.z));
  const mid = (Math.min(...campYs) + Math.max(...campYs)) / 2, first = V.bands[0][1];
  let maxH = 0;
  for (const v of w.h) maxH = Math.max(maxH, v);
  const levels = [0.6];
  for (let L = (((mid - first / 2) % first) + first) % first, b = 0; L <= maxH; L += V.bands[b][1]) {
    if (L > 0.6 + first * 0.5) levels.push(L);
    while (L >= V.bands[b][0]) b++;
  }
  const modelY = (x, z) => { const h = surface(x, z); let k = -1; for (let i = 0; i < levels.length; i++) if (h >= levels[i]) k = i; return k < 0 ? yShallow : topY(k + 2); };

  // ---------- camera ----------
  const W = innerWidth || 1280, H = innerHeight || 720, aspect = W / H;
  const camera = new THREE.PerspectiveCamera(V.fov, aspect, 1, 10);
  const az = camp.from + V.turn, el = rad(V.elev), hfov = 2 * Math.atan(Math.tan(rad(V.fov / 2)) * aspect);
  let target, dist;
  if (VIEW === "island") {
    let sx = 0, sz = 0, n = 0;
    for (let k = 0; k < w.N * w.N; k++) if (w.isle.height[k] > 0) { sx += w.START + (k % w.N) * w.CELL; sz += w.START + Math.floor(k / w.N) * w.CELL; n++; }
    // Nudged toward the lens so the near coast and its sea margin stay in frame.
    target = new THREE.Vector3(sx / n + Math.cos(az) * 650, topY(2) + step * 4, sz / n + Math.sin(az) * 650);
    dist = V.dist;
  } else {
    const ux = Math.cos(camp.uphill), uz = Math.sin(camp.uphill), tx = C.x + ux * V.ahead, tz = C.z + uz * V.ahead;
    target = new THREE.Vector3(tx, VIEW === "camp" ? modelY(C.x, C.z) + 0.6 : modelY(tx, tz), tz);
    dist = V.frame / 2 / Math.tan(hfov / 2);
  }
  camera.position.set(target.x + Math.cos(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + Math.sin(az) * Math.cos(el) * dist);
  camera.near = dist * 0.08;
  camera.far = dist * 8;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  // ---------- region the model is built over ----------
  let region;
  if (VIEW === "island") region = { x0: -5600, z0: -5600, size: 11200 };
  else {
    const pts = [[target.x, target.z]], ray = new THREE.Vector3();
    for (const nx of [-1, -0.5, 0, 0.5, 1]) for (const ny of [-1, 0, 1]) {
      ray.set(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
      const cap = dist * (VIEW === "camp" ? 12 : 5), t = ray.y < -0.03 ? (camera.position.y - yShallow) / -ray.y : cap;
      pts.push([camera.position.x + ray.x * Math.min(t, cap), camera.position.z + ray.z * Math.min(t, cap)]);
    }
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * 1.25;
    region = { x0: cx - size / 2, z0: cz - size / 2, size };
  }

  // ---------- contour sheets ----------
  const G = V.grid, dx = region.size / (G - 1), f = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) f[j * G + i] = surface(region.x0 + i * dx, region.z0 + j * dx);
  const minArea = (dx * 2.5) ** 2;
  const cutAll = (loops, seed, extra = {}) => loops.map((l, n) => cut(l, { step: dx * 0.9, wobble: dx * 0.3, seed: seed * 131 + n, ...extra }));
  const shallow = shapes(cutAll(trace(f, G, V.shallow, region.x0, region.z0, dx), 5, { scallop: dx * 0.9 }), minArea);
  const land = levels.map((L, k) => ({ k, L, shapes: shapes(cutAll(trace(f, G, L, region.x0, region.z0, dx), 11 + k), minArea) })).filter((l) => l.shapes.length);
  const deepPad = VIEW === "island" ? 5700 : region.size * 0.9;
  const dcx = region.x0 + region.size / 2, dcz = region.z0 + region.size / 2, tilt = VIEW === "island" ? 0.03 : 0;
  const rect = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [dcx + (a * Math.cos(tilt) - b * Math.sin(tilt)) * deepPad, dcz + (a * Math.sin(tilt) + b * Math.cos(tilt)) * deepPad]);
  const deep = [{ outer: cut(rect, { step: deepPad / 80, wobble: deepPad / 500, seed: 3 }), holes: [] }];

  // ---------- plan rasters: which sheet is on top, what paper covers it, and the baked lamp ----------
  const R = 2048, B = 1024, cellB = region.size / B;
  const S = rasterSheets(R, region, [{ value: 1, shapes: shallow }, ...land.map((l) => ({ value: l.k + 2, shapes: l.shapes }))]);
  const sheetAt = (x, z) => { const i = Math.floor(((x - region.x0) / region.size) * R), j = Math.floor(((z - region.z0) / region.size) * R); return i < 0 || j < 0 || i >= R || j >= R ? 0 : S[j * R + i]; };
  const standY = (x, z) => { const v = Math.round(sheetAt(x, z)); return v >= 2 ? topY(v) : null; };

  const Y = new Float32Array(B * B);
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
    const a = (j * 2) * R + i * 2;
    Y[j * B + i] = topY((S[a] + S[a + 1] + S[a + R] + S[a + R + 1]) / 4);
  }
  const lAz = az + V.light.turn, lEl = rad(V.light.elev), L = { x: Math.cos(lAz), z: Math.sin(lAz), tan: Math.tan(lEl) };
  const sun = sunVisibility(Y, B, cellB, L, 0.2);
  const ao = terrainAO(Y, B, cellB, step);

  // ---------- what stands on the sheets ----------
  const inRegion = (x, z, m = 0) => x > region.x0 + m && z > region.z0 + m && x < region.x0 + region.size - m && z < region.z0 + region.size - m;
  const scene = new THREE.Scene();
  const blobs = [];
  const things = placeThings(w, V, { inRegion, standY, target, camera, blobs, scene });
  const occ = contactShadows(blobs, B, region);
  const bake = new Uint8Array(B * B * 4);
  for (let i = 0; i < B * B; i++) {
    bake[i * 4] = sun[i] * 255;
    bake[i * 4 + 1] = ao[i] * 255;
    bake[i * 4 + 2] = (1 - occ[i]) * 255;
    bake[i * 4 + 3] = 255;
  }
  const [cls1, cls2] = coverRasters(w, region, 1024);
  shared.tBake.value = dataTex(bake, B);
  shared.tCls1.value = dataTex(cls1, 1024);
  shared.tCls2.value = dataTex(cls2, 1024);
  shared.tGrain.value = grainTexture(w.rand);
  shared.uGrainScale.value = 1 / (V.mm * 45);
  shared.uRegion.value.set(region.x0, region.z0, 1 / region.size, 1 / region.size);
  shared.uWobble.value.set(1 / (V.mm * 70), 0.2);
  shared.uEdge.value = cellB * 1.5;
  const sheets = new THREE.DataTexture(Uint8Array.from(S), R, R, THREE.RedFormat, THREE.UnsignedByteType);
  sheets.magFilter = sheets.minFilter = THREE.LinearFilter;
  sheets.needsUpdate = true;
  shared.tSheets.value = sheets;
  shared.uSheetPx.value = 1 / R;

  // ---------- the sheets as geometry ----------
  const topBuf = { pos: [], layer: [] }, wallBuf = { pos: [], nrm: [], uv: [], layer: [] }, spacerBuf = { pos: [], nrm: [], uv: [], layer: [] };
  const seaTop = { pos: [], layer: [] }, seaWall = { pos: [], nrm: [], uv: [], layer: [] };
  tops(deep, yDeep, -2, seaTop);
  walls(deep, 0, yDeep, -2, seaWall);
  tops(shallow, yShallow, -1, seaTop);
  walls(shallow, yDeep, yShallow, -1, seaWall);
  const t = step * V.card;
  for (const l of land) {
    const y = topY(l.k + 2), below = topY(l.k + 1);
    tops(l.shapes, y, l.k, topBuf);
    walls(l.shapes, y - t, y, l.k, wallBuf);
    walls(l.shapes, below, y - t + 0.01 * step, l.k, spacerBuf, step * V.inset);
  }
  const terrainDecl = `
    uniform sampler2D tCls1; uniform sampler2D tCls2; uniform vec2 uWobble;
    varying float vLayer; varying vec2 vWall; varying vec3 vNw;
    vec3 landColor( vec2 xz, out float edge ) {
      vec2 uv = planUv( xz );
      vec4 a = texture2D( tCls1, uv ), b = texture2D( tCls2, uv );
      vec4 n1 = texture2D( tGrain, xz * uWobble.x ) - 0.5, n2 = texture2D( tGrain, xz * uWobble.x * 4.3 + 0.31 ) - 0.5;
      float wb = uWobble.y;
      float w[7];
      w[0] = a.r * 1.05 + ( n1.g + 0.15 * n2.b ) * wb;
      w[1] = a.g + ( n1.b + 0.15 * n2.a ) * wb;
      w[2] = a.b * 1.25 + ( n1.a + 0.15 * n2.g ) * wb;
      w[3] = a.a * 1.3 + ( - n1.g + 0.15 * n2.a ) * wb;
      w[4] = b.r * 1.5 + ( - n1.b + 0.15 * n2.g ) * wb;
      w[5] = b.g * 0.85 + ( - n1.a + 0.15 * n2.b ) * wb;
      w[6] = b.b * 2.2 - 0.45 + 0.3 * n2.g * wb;
      vec3 pal[7] = vec3[7]( ${[PAPER.forest, PAPER.meadow, PAPER.heath, PAPER.rock, PAPER.sand, PAPER.marsh, PAPER.water].map(glsl).join(", ")} );
      float prio[7] = float[7]( 2.0, 0.0, 3.0, 4.0, 5.0, 1.0, 6.0 );
      int bi = 0, si = 0; float bw = -9.0, sw = -9.0;
      for ( int i = 0; i < 7; i ++ ) {
        if ( w[i] > bw ) { sw = bw; si = bi; bw = w[i]; bi = i; } else if ( w[i] > sw ) { sw = w[i]; si = i; }
      }
      float m = bw - sw, px = m / max( fwidth( m ), 1e-5 );
      // A patch glued over its neighbour throws a hairline shadow onto it and catches a little light on its cut.
      edge = prio[bi] < prio[si] ? - ( 1.0 - smoothstep( 0.0, 3.0, px ) ) : 0.6 * ( 1.0 - smoothstep( 0.0, 1.2, px ) );
      return pal[bi];
    }`;
  const layerV = { vdecl: "attribute float aLayer; varying float vLayer; attribute vec2 aWall; varying vec2 vWall; varying vec3 vNw;", vcode: "vLayer = aLayer; vNw = normal;" };
  const topMat = paperMaterial({
    ...layerV, decl: terrainDecl, grain: 0.5,
    color: `float edge; vec3 col = landColor( vW.xz, edge );
      float lh = fract( sin( vLayer * 91.7 + 3.1 ) * 4375.85 );
      col *= ( 0.94 + 0.1 * lh ) * ( 1.0 + 0.2 * edge );
      // Sheets never lie quite flat: a slow swell in how they take the light.
      col *= 1.0 + 0.16 * ( texture2D( tGrain, vW.xz * uGrainScale * 0.09 ).g - 0.5 );
      vec2 uv = planUv( vW.xz ), se = sheetEdges( uv );
      col *= ( 1.0 + 0.28 * se.x ) * ( 1.0 - 0.75 * step( vLayer + 2.5, sheetAt( uv ) ) );
      gCont = se.y;
      diffuseColor.rgb = col;`,
    light: `vec4 bk = texture2D( tBake, planUv( vW.xz ) ); gSun = bk.r * ( 1.0 - 0.3 * gCont ); ao = bk.g * bk.b * ( 1.0 - 0.45 * gCont );`,
  });
  const wallMat = paperMaterial({
    vdecl: layerV.vdecl, vcode: "vLayer = aLayer; vNw = normal; vWall = aWall;", decl: terrainDecl, grain: 0.35, wrap: 0.25,
    color: `float edge; vec3 col = landColor( vW.xz - vNw.xz * uEdge, edge );
      col = mix( col, vec3( 1.0 ), 0.2 ) * 1.08;
      col *= 1.0 + 0.35 * smoothstep( 0.7, 1.0, vWall.y );
      diffuseColor.rgb = col;`,
    light: `vec4 bk = texture2D( tBake, planUv( vW.xz + vNw.xz * uEdge ) ); gSun = bk.r; ao = mix( 0.72, 1.0, vWall.y ) * mix( 0.65, 1.0, bk.g );`,
  });
  const spacerMat = paperMaterial({ ...layerV, decl: "varying float vLayer;", color: `diffuseColor.rgb = ${glsl(PAPER.spacer)};`, light: "gSun = 0.12; ao = 0.4;" });
  const seaTopMat = paperMaterial({
    ...layerV, decl: "varying float vLayer;", grain: 0.3,
    color: `vec2 uv = planUv( vW.xz ), se = sheetEdges( uv );
      diffuseColor.rgb = ( vLayer < -1.5 ? ${glsl(PAPER.deep)} : ${glsl(PAPER.shallow)} ) * ( 1.0 + 0.25 * se.x );
      gCont = se.y;`,
    light: `vec4 bk = texture2D( tBake, planUv( vW.xz ) ); gSun = bk.r * ( 1.0 - 0.3 * gCont ); ao = bk.g * bk.b * ( 1.0 - 0.45 * gCont );`,
  });
  const seaWallMat = paperMaterial({
    vdecl: layerV.vdecl, vcode: "vLayer = aLayer; vNw = normal; vWall = aWall;", decl: "varying float vLayer; varying vec2 vWall; varying vec3 vNw;", grain: 0.1,
    color: `diffuseColor.rgb = mix( vLayer < -1.5 ? ${glsl(PAPER.deep)} : ${glsl(PAPER.shallow)}, vec3( 1.0 ), 0.18 );`,
    light: `vec4 bk = texture2D( tBake, planUv( vW.xz + vNw.xz * uEdge ) ); gSun = bk.r; ao = mix( 0.7, 1.0, vWall.y );`,
  });
  const mesh = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; m.frustumCulled = false; scene.add(m); return m; };
  mesh(geometry(topBuf, false), topMat);
  mesh(geometry(wallBuf, true), wallMat);
  mesh(geometry(spacerBuf, true), spacerMat);
  mesh(geometry(seaTop, false), seaTopMat);
  mesh(geometry(seaWall, true), seaWallMat);
  addWaves(scene, { shallow, dx, yDeep, step });
  addDesk(scene, VIEW, region, V, deepPad, dcx, dcz);
  if (VIEW === "island") addProps(scene, camera, V, deepPad, tilt, dcx, dcz, w.rand);

  // ---------- light ----------
  const lamp = new THREE.DirectionalLight(0xfff0de, V.sun);
  const Ld = new THREE.Vector3(Math.cos(lAz) * Math.cos(lEl), Math.sin(lEl), Math.sin(lAz) * Math.cos(lEl));
  const reach = VIEW === "island" ? 9000 : VIEW === "valley" ? region.size * 0.42 : 60;
  lamp.position.copy(target).addScaledVector(Ld, reach * 3);
  lamp.target.position.copy(target);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(4096, 4096);
  Object.assign(lamp.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: reach * 0.5, far: reach * 6 });
  lamp.shadow.camera.updateProjectionMatrix();
  lamp.shadow.bias = -0.0003;
  lamp.shadow.normalBias = (reach * 2) / 4096;
  lamp.shadow.radius = V.shadow.radius;
  scene.add(lamp, lamp.target);
  scene.add(new THREE.HemisphereLight(0xcfdaea, 0xd9b98f, V.hemi));
  if (things.fire) {
    const fire = new THREE.PointLight(0xff8a3c, VIEW === "camp" ? 26 : 220, 0, 2);
    fire.position.set(things.fire.x, things.fire.y + (VIEW === "camp" ? 0.9 : 3), things.fire.z);
    scene.add(fire);
  }
  // A paper sweep behind the table, which a low macro shot catches past the far edge of the model.
  const sweep = canvas(4, 256), sg = sweep.getContext("2d"), grad = sg.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#c9c2b4");
  grad.addColorStop(1, "#8f887c");
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 4, 256);
  scene.background = new THREE.CanvasTexture(sweep);
  scene.background.colorSpace = THREE.SRGBColorSpace;

  // ---------- render, then the lens ----------
  // The lens focuses on the camp in the close views and on the model's middle in the establishing shot.
  const focus = VIEW === "island" ? target : new THREE.Vector3(C.x, modelY(C.x, C.z) + (VIEW === "camp" ? 0.8 : 2), C.z);
  await render(scene, camera, W, H, focus, V);
  document.body.classList.add("ready");
}

// ---------------------------------------------------------------------------------------------------------------
function makeSurface(w, detail, scale) {
  const c = w.camp.at;
  const { M, STEP, START, h, N, CELL, isle } = w;
  const lake = new Float32Array(N * N), lakeLv = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) if (isle.water[k] > 0 && isle.height[k] + isle.water[k] > 0.3) { lake[k] = 1; lakeLv[k] = isle.height[k] + isle.water[k]; }
  const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const Hf = (u, v) => h[clamp(v, 0, M - 1) * M + clamp(u, 0, M - 1)];
  return (x, z) => {
    const fu = (x - START) / STEP, fv = (z - START) / STEP, u = Math.floor(fu), v = Math.floor(fv), tu = fu - u, tv = fv - v;
    const row = (j) => cr(Hf(u - 1, j), Hf(u, j), Hf(u + 1, j), Hf(u + 2, j), tu);
    let y = cr(row(v - 1), row(v), row(v + 1), row(v + 2), tv);
    const cx = (x - START) / CELL, cy = (z - START) / CELL, lk = w.bilinear(lake, cx, cy);
    // Lakes are one flat sheet at their surface, not a pit of steps.
    if (lk > 0.05) y += smooth(0.3, 0.6, lk) * Math.max(0, w.bilinear(lakeLv, cx, cy) / lk - y);
    // The trodden ground of the camp stays level, so no sheet edge cuts through it.
    if (detail) y += detail * fbm(x / scale, z / scale, 91, 2) * smooth(0, 2, y) * smooth(8, 24, Math.hypot(x - c.x, z - c.z));
    return y;
  };
}

function rasterSheets(R, region, layers) {
  const c = canvas(R), g = c.getContext("2d", { willReadFrequently: true }), s = R / region.size;
  g.fillStyle = "#000";
  g.fillRect(0, 0, R, R);
  for (const L of layers) {
    const path = new Path2D();
    for (const sh of L.shapes) for (const loop of [sh.outer, ...sh.holes]) {
      loop.forEach(([x, z], i) => (i ? path.lineTo((x - region.x0) * s, (z - region.z0) * s) : path.moveTo((x - region.x0) * s, (z - region.z0) * s)));
      path.closePath();
    }
    g.fillStyle = `rgb(${L.value},${L.value},${L.value})`;
    g.fill(path, "evenodd");
  }
  const d = g.getImageData(0, 0, R, R).data, S = new Float32Array(R * R);
  for (let i = 0; i < R * R; i++) S[i] = d[i * 4];
  return S;
}

// How much of the lamp each point sees past the sheets toward it: a horizon march, softened by the lamp's size so
// shadows are sharp at the foot of a step and widen away from it.
function sunVisibility(Y, B, cell, L, soft) {
  let lo = Infinity, hi = -Infinity;
  for (const v of Y) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const maxD = Math.min(B, (hi - lo) / (L.tan - soft) / cell + 2), NS = 44, ds = [];
  for (let s = 0; s < NS; s++) ds.push(Math.max(0.75 * (s + 1), maxD * ((s + 1) / NS) ** 2));
  const vis = new Float32Array(B * B);
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
    const y0 = Y[j * B + i];
    let mt = -1e9;
    for (let s = 0; s < NS; s++) {
      const d = ds[s], x = Math.round(i + L.x * d), z = Math.round(j + L.z * d);
      if (x < 0 || z < 0 || x >= B || z >= B) break;
      const tn = (Y[z * B + x] - y0) / (d * cell);
      if (tn > mt) { mt = tn; if (mt > L.tan + soft) break; }
    }
    vis[j * B + i] = smooth(-soft, soft, L.tan - mt);
  }
  return blur(vis, B, 1);
}

function terrainAO(Y, B, cell, step) {
  const r1 = Math.max(1, Math.round((step * 0.9) / cell)), r2 = Math.max(2, Math.round((step * 3) / cell));
  const b1 = blur(Y, B, r1), b2 = blur(Y, B, r2), ao = new Float32Array(B * B);
  for (let i = 0; i < B * B; i++) ao[i] = clamp(1 - 0.5 * clamp((b1[i] - Y[i]) / step, 0, 1) - 0.3 * clamp((b2[i] - Y[i]) / (step * 2), 0, 1), 0, 1);
  return ao;
}

// Separable box blur, three passes, which is close to a gaussian.
function blur(src, n, r, passes = 2) {
  let a = Float32Array.from(src), b = new Float32Array(n * n);
  const k = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += a[j * n + clamp(i, 0, n - 1)];
      for (let i = 0; i < n; i++) { b[j * n + i] = s * k; s += a[j * n + Math.min(n - 1, i + r + 1)] - a[j * n + Math.max(0, i - r)]; }
    }
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += b[clamp(j, 0, n - 1) * n + i];
      for (let j = 0; j < n; j++) { a[j * n + i] = s * k; s += b[Math.min(n - 1, j + r + 1) * n + i] - b[Math.max(0, j - r) * n + i]; }
    }
  }
  return a;
}

// Soft dark pools under everything standing on the paper.
function contactShadows(blobs, B, region) {
  const c = canvas(B), g = c.getContext("2d", { willReadFrequently: true }), s = B / region.size;
  for (const [x, z, r, a] of blobs) {
    g.fillStyle = `rgba(0,0,0,${a})`;
    g.beginPath();
    g.arc((x - region.x0) * s, (z - region.z0) * s, Math.max(0.6, r * s), 0, Math.PI * 2);
    g.fill();
  }
  const d = g.getImageData(0, 0, B, B).data, o = new Float32Array(B * B);
  for (let i = 0; i < B * B; i++) o[i] = d[i * 4 + 3] / 255;
  return blur(o, B, 2);
}

// Cover shares on the plan, blurred so the patches the shader cuts from them come out as smooth scissor curves
// instead of following the grid.
function coverRasters(w, region, C) {
  const ch = Array.from({ length: 7 }, () => new Float32Array(C * C));
  const lake = new Float32Array(w.N * w.N);
  for (let k = 0; k < w.N * w.N; k++) lake[k] = w.isle.water[k] > 0 && w.isle.height[k] + w.isle.water[k] > 0.3 ? 1 : 0;
  const cv = w.cover, fine = w.fine;
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) {
    const x = region.x0 + ((i + 0.5) / C) * region.size, z = region.z0 + ((j + 0.5) / C) * region.size, o = j * C + i;
    ch[0][o] = fine(cv.tree, x, z);
    ch[1][o] = fine(cv.grass, x, z);
    ch[2][o] = fine(cv.shrub, x, z);
    ch[3][o] = fine(cv.bare, x, z);
    ch[4][o] = fine(cv.sand, x, z);
    ch[5][o] = fine(cv.marsh, x, z);
    const lk = w.bilinear(lake, (x - w.START) / w.CELL, (z - w.START) / w.CELL);
    ch[6][o] = clamp(Math.max(w.riverAt(x, z) * 1.1, smooth(0.35, 0.6, lk) * Math.min(1, fine(w.wet, x, z) * 1.5)), 0, 1);
  }
  const r = clamp(Math.round(20 / (region.size / C)), 2, C / 8);
  const bl = ch.map((c, k) => blur(c, C, k === 6 ? 1 : r));
  const a = new Uint8Array(C * C * 4), b = new Uint8Array(C * C * 4);
  for (let o = 0; o < C * C; o++) {
    a[o * 4] = bl[0][o] * 255; a[o * 4 + 1] = bl[1][o] * 255; a[o * 4 + 2] = bl[2][o] * 255; a[o * 4 + 3] = bl[3][o] * 255;
    b[o * 4] = bl[4][o] * 255; b[o * 4 + 1] = bl[5][o] * 255; b[o * 4 + 2] = bl[6][o] * 255; b[o * 4 + 3] = 255;
  }
  return [a, b];
}

function dataTex(data, n) {
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// Placement: every tree, shrub and rock from the world that stands inside the model, on the sheet under it.
function placeThings(w, V, { inRegion, standY, target, camera, blobs, scene }) {
  const rand = w.rand, out = {};
  const up = new THREE.Vector3(0, 1, 0), M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
  const build = (geo, mat, list, shadow = true) => {
    if (!list.length) return null;
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      q.setFromAxisAngle(up, it.yaw || 0);
      if (it.tilt) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), it.tilt));
      m.setMatrixAt(i, M4.compose(p.set(it.x, it.y, it.z), q, s.set(it.sx ?? it.s, it.sy ?? it.s, it.sz ?? it.s)));
      m.setColorAt(i, col.set(it.color));
    });
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const shade = (hex, t, dl = 0.08, dh = 0.02) => { const c = new THREE.Color(hex); c.offsetHSL((t - 0.5) * dh, (t - 0.5) * 0.08, (t - 0.5) * dl); return "#" + c.getHexString(); };

  // Trees.
  const cards = { oak: [], ash: [], aspen: [] }, pines = [];
  w.trees.forEach((tr, i) => {
    if (!inRegion(tr.x, tr.z, 5) || hash(i, 7, 1) > V.trees.keep) return;
    const y = standY(tr.x, tr.z);
    if (y === null) return;
    const sc = tr.tall * V.trees.scale;
    if (tr.kind === "pine") {
      pines.push({ x: tr.x, y, z: tr.z, s: sc, yaw: tr.yaw, color: shade(PAPER.pine, tr.tint, 0.1) });
      blobs.push([tr.x, tr.z, sc * 0.26, 0.42]);
    } else {
      let color = PAPER[tr.kind];
      if (tr.kind === "aspen") color = tr.tint > 0.93 ? PAPER.rust : tr.tint > 0.78 ? PAPER.gold : tr.tint > 0.5 ? "#8fae45" : PAPER.aspen;
      if (tr.kind === "oak" && tr.tint > 0.9) color = "#5c8a2e";
      cards[tr.kind].push({ x: tr.x, y, z: tr.z, s: sc, yaw: tr.yaw, color: shade(color, (tr.tint * 7.3) % 1, 0.1) });
      blobs.push([tr.x, tr.z, sc * 0.3, 0.38]);
    }
  });
  const cardShader = `vec4 tx = texture2D( map, vMapUv ); gUntint = max( step( 0.5, tx.g ), step( 0.5, tx.b ) );
    diffuseColor.rgb = tx.b > 0.5 ? vec3( 0.84, 0.82, 0.77 ) : mix( vec3( tx.r ), ${glsl(PAPER.trunk)} * ( 0.8 + 0.2 * tx.r ), gUntint );`;
  for (const kind of ["oak", "ash", "aspen"]) {
    const { map, aspect } = P.treeCard(kind, rand);
    const mat = paperMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide, trans: 0.4, wrap: 0.45, color: cardShader, light: OBJECT_LIGHT, grain: 0.1 });
    build(P.slottedCards(kind === "aspen" ? aspect * 0.85 : aspect), mat, cards[kind]);
  }
  build(P.pineCones(), paperMaterial({ flatShading: true, trans: 0.2, wrap: 0.3, light: OBJECT_LIGHT }), pines);
  build(P.trunk(), paperMaterial({ color: `diffuseColor.rgb = ${glsl(PAPER.trunk)};`, light: OBJECT_LIGHT, objH: 0.3 }), pines.map((t) => ({ ...t, color: "#ffffff" })));

  // Shrubs: crumpled balls, lilac where the heath is, green elsewhere.
  const balls = [[], [], []];
  w.shrubs.forEach((sh, i) => {
    if (!inRegion(sh.x, sh.z, 3) || hash(i, 9, 2) > V.shrubs.keep) return;
    const y = standY(sh.x, sh.z);
    if (y === null) return;
    const sc = sh.tall * V.shrubs.scale * 0.5;
    const color = sh.heath > 0.5 ? shade(sh.tint > 0.6 ? "#a77cc4" : "#8f6aa8", sh.tint, 0.12) : shade(sh.tint > 0.5 ? "#5f8f3c" : "#79953f", sh.tint, 0.12);
    balls[i % 3].push({ x: sh.x, y: y - sc * 0.15, z: sh.z, s: sc, yaw: sh.yaw, color });
    blobs.push([sh.x, sh.z, sc * 0.8, 0.3]);
  });
  const ballMat = paperMaterial({ flatShading: true, trans: 0.1, wrap: 0.35, light: OBJECT_LIGHT, objH: 1.8 });
  balls.forEach((list) => { const g = P.crumpled(rand); g.translate(0, 0.9, 0); build(g, ballMat, list); });

  // Rocks: folded grey card.
  const rocks = [[], [], [], []];
  w.rocks.forEach((r, i) => {
    if (r.size < V.rocks.min || !inRegion(r.x, r.z, 3) || hash(i, 11, 3) > V.rocks.keep) return;
    const y = standY(r.x, r.z);
    if (y === null) return;
    const sc = r.size * V.rocks.scale * 0.5;
    rocks[i % 4].push({ x: r.x, y: y - sc * 0.1, z: r.z, s: sc, yaw: r.yaw, color: shade(r.tint > 0.7 ? "#b3aea4" : "#9a968e", r.tint, 0.14) });
    blobs.push([r.x, r.z, sc * 0.9, 0.35]);
  });
  const rockMat = paperMaterial({ flatShading: true, trans: 0.05, wrap: 0.2, light: OBJECT_LIGHT });
  rocks.forEach((list) => { const g = P.foldedRock(rand); g.translate(0, 0.25, 0); build(g, rockMat, list, 1); });

  // Grass: fringed strips from the meadow share of the ground, and the camp's own tufts close in.
  const grass = [], flowers = [], pebbles = [], logs = [];
  if (V.grass) {
    const { M, STEP, START } = w, G = V.grass, R2 = G.reach ** 2, cx = w.camp.at.x, cz = w.camp.at.z;
    for (let v = 0; v < M; v++) for (let u = 0; u < M; u++) {
      const x0 = START + u * STEP, z0 = START + v * STEP;
      if ((x0 - target.x) ** 2 + (z0 - target.z) ** 2 > R2) continue;
      const i = v * M + u, g = w.cover.grass[i] + 0.6 * w.cover.marsh[i];
      for (let n = Math.floor(g * G.per + hash(u, v, 5)); n > 0; n--) {
        const x = x0 + hash(u, v, 100 + n) * STEP, z = z0 + hash(u, v, 200 + n) * STEP;
        if (!w.dry(x, z) || Math.hypot(x - cx, z - cz) < G.hole) continue;
        const y = standY(x, z);
        if (y === null) continue;
        const tt = hash(u, v, 300 + n);
        grass.push({ x, y, z, s: (0.5 + tt * 0.5) * G.scale, yaw: hash(u, v, 400 + n) * 6.283, color: shade(tt > 0.7 ? "#c6d360" : tt > 0.35 ? "#a9c353" : "#8cb84e", tt, 0.1) });
      }
    }
  }
  if (V.nearby) {
    const nb = w.nearby(w.camp.at, V.nearby, 3);
    nb.grass.forEach((g, i) => { const y = standY(g.x, g.z); if (y !== null && hash(i, 3, 9) < 0.32) grass.push({ x: g.x, y, z: g.z, s: g.tall * 1.7, yaw: g.yaw, color: shade(g.tint > 0.7 ? "#c6d360" : g.tint > 0.35 ? "#a9c353" : "#8cb84e", g.tint, 0.1) }); });
    const hues = ["#e0463c", "#f2c230", "#f4efe4", "#e889b5", "#6c8fd6", "#f08a3a"];
    for (const fl of nb.flowers) { const y = standY(fl.x, fl.z); if (y !== null) flowers.push({ x: fl.x, y, z: fl.z, tall: fl.tall, yaw: fl.hue * 40, color: hues[Math.floor(fl.hue * hues.length)] }); }
    for (const pb of nb.pebbles) { const y = standY(pb.x, pb.z); if (y !== null) pebbles.push({ x: pb.x, y: y - pb.size * 0.1, z: pb.z, s: pb.size * 0.5, yaw: pb.yaw, color: shade("#a39f97", pb.tint, 0.16) }); }
    for (const lg of nb.logs) { const y = standY(lg.x, lg.z); if (y !== null) logs.push({ ...lg, y }); }
  }
  if (grass.length) {
    const mat = paperMaterial({ map: P.fringeTexture(rand), alphaTest: 0.5, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide, trans: 0.18, wrap: 0.45, color: "diffuseColor.rgb = vec3( texture2D( map, vMapUv ).r );", light: OBJECT_LIGHT });
    build(P.grassStrip(), mat, grass);
  }
  if (flowers.length) {
    const disc = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const fmat = paperMaterial({ map: P.flowerTexture(), alphaTest: 0.5, side: THREE.DoubleSide, trans: 0.4, wrap: 0.5, light: OBJECT_LIGHT,
      color: "vec4 tx = texture2D( map, vMapUv ); gUntint = step( 0.5, tx.g ); diffuseColor.rgb = mix( vec3( tx.r ), vec3( 0.95, 0.62, 0.08 ), gUntint );" });
    build(disc, fmat, flowers.map((f) => ({ x: f.x, y: f.y + f.tall, z: f.z, s: 0.3 + f.tall * 0.35, yaw: f.yaw, tilt: 0.3, color: f.color })));
    const stem = new THREE.PlaneGeometry(0.03, 1).translate(0, 0.5, 0);
    build(stem, paperMaterial({ side: THREE.DoubleSide, color: `diffuseColor.rgb = ${glsl("#5f8f3c")};`, light: OBJECT_LIGHT }), flowers.map((f) => ({ x: f.x, y: f.y, z: f.z, sx: 1, sy: f.tall, sz: 1, yaw: f.yaw, color: "#ffffff" })));
  }
  if (pebbles.length) build(P.foldedRock(rand).translate(0, 0.25, 0), rockMat, pebbles);

  // The camp.
  if (V.camp) out.fire = addCamp(w, V, { standY, camera, blobs, scene, build, rand, logs });
  return out;
}

function addCamp(w, V, { standY, camera, blobs, scene, build, rand, logs }) {
  const camp = w.camp, k = V.camp, fire = camp.fire;
  const fy = standY(fire.x, fire.z) ?? 0;
  const add = (geo, mat, x, y, z, yaw = 0, s = 1, cast = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = yaw; m.scale.setScalar(s); m.castShadow = cast; m.receiveShadow = true; scene.add(m); return m; };
  const plain = (hex, extra = {}) => paperMaterial({ color: `diffuseColor.rgb = ${glsl(hex)};`, light: OBJECT_LIGHT, ...extra });

  // Tents: two folded A-frames and a paper cone, each with a pattern printed on the sheet before it was folded.
  const tentPaper = ["#c65a3a", "#dfa13f", "#efe3c4"];
  const local = { vdecl: "varying vec3 vLoc;", vcode: "vLoc = position;", decl: "varying vec3 vLoc;", side: THREE.DoubleSide, flatShading: true, wrap: 0.3, trans: 0.3, light: OBJECT_LIGHT };
  camp.tents.forEach((t, i) => {
    const y = standY(t.at.x, t.at.z) ?? fy, sz = t.size * k;
    if (i < 2) {
      const len = sz, wid = sz * 0.82, hgt = sz * 0.62, base = glsl(tentPaper[i]), band = glsl(i ? "#8a4a2a" : "#f1e2c2");
      const mat = paperMaterial({ ...local, color: `vec3 col = ${base};
        float hem = step( vLoc.y, ${(hgt * 0.16).toFixed(3)} );
        float stitch = step( abs( vLoc.y - ${(hgt * 0.2).toFixed(3)} ), ${(hgt * 0.015).toFixed(3)} ) * step( 0.5, fract( vLoc.z * ${(6 / sz).toFixed(3)} ) );
        float ridge = step( ${(hgt * 0.94).toFixed(3)}, vLoc.y );
        col = mix( col, ${band}, max( hem, stitch ) );
        col = mix( col, col * 1.25, ridge );
        diffuseColor.rgb = col;` });
      add(P.aFrame(len, wid, hgt), mat, t.at.x, y, t.at.z, t.yaw);
      add(P.doorway(wid, hgt, len), plain("#2a2019", { side: THREE.DoubleSide }), t.at.x, y + 0.01, t.at.z, t.yaw, 1, false);
    } else {
      const h = sz * 0.95, tp = P.tipi(sz * 0.48, h);
      const mat = paperMaterial({ ...local, color: `vec3 col = ${glsl(tentPaper[i])};
        float a = atan( vLoc.z, vLoc.x ), zig = abs( fract( a * 1.4324 ) - 0.5 ) * 2.0, y = vLoc.y / ${h.toFixed(3)};
        float zz = step( 0.22 + 0.07 * zig, y ) * step( y, 0.3 + 0.07 * zig );
        float top = step( 0.78, y ) * step( y, 0.84 );
        float dots = step( length( vec2( fract( a * 2.8648 ) - 0.5, ( y - 0.5 ) * 9.0 ) ), 0.22 );
        col = mix( col, ${glsl("#b8462c")}, max( zz, top ) );
        col = mix( col, ${glsl("#2f5f8a")}, dots );
        diffuseColor.rgb = col;` });
      add(tp.cone, mat, t.at.x, y, t.at.z, t.yaw);
      add(tp.poles, plain(PAPER.kraft), t.at.x, y, t.at.z, t.yaw);
    }
    blobs.push([t.at.x, t.at.z, sz * 0.62, 0.55]);
  });

  // People: printed cut-outs on little card stands, turned halfway from the fire toward the lens.
  camp.people.forEach((pp, i) => {
    const y = standY(pp.at.x, pp.at.z) ?? fy;
    const toCam = Math.atan2(camera.position.x - pp.at.x, camera.position.z - pp.at.z);
    let d = toCam - pp.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const yaw = pp.yaw + d * 0.6, hgt = 1.8 * k;
    const fig = new THREE.PlaneGeometry(hgt * 0.5, hgt).translate(0, hgt / 2 + 0.06 * k, 0);
    add(fig, paperMaterial({ map: P.personTexture(COLORS[(i * 5 + 2) % COLORS.length], rand), alphaTest: 0.5, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide, trans: 0.3, wrap: 0.45, light: OBJECT_LIGHT, grain: 0.08 }), pp.at.x, y, pp.at.z, yaw);
    add(new THREE.BoxGeometry(0.55 * k, 0.06 * k, 0.32 * k).translate(0, 0.03 * k, 0), plain("#5a4636"), pp.at.x, y, pp.at.z, yaw);
    blobs.push([pp.at.x, pp.at.z, 0.4 * k, 0.4]);
  });

  // Fire: three rings of slotted paper flames over rolled-paper logs, inside a ring of folded stones.
  const flame = P.flameTexture(rand);
  [[1.5, 0.95, "#e2502a", 0], [1.1, 0.72, "#f28a26", 0.4], [0.72, 0.48, "#ffd045", 0.8]].forEach(([hgt, wid, hex, rot]) => {
    // Unlit, so the lamp and the fire's own light do not wash the paper colours out.
    const m = new THREE.MeshBasicMaterial({ map: flame, alphaTest: 0.5, side: THREE.DoubleSide, color: new THREE.Color(hex).multiplyScalar(1.25) });
    add(P.slottedCards(wid / hgt), m, fire.x, fy + 0.12 * k, fire.z, rot, hgt * k, false);
  });
  const tubeMat = paperMaterial({ vertexColors: true, color: `diffuseColor.rgb = ${glsl(PAPER.kraft)};`, light: OBJECT_LIGHT });
  for (let n = 0; n < 4; n++) {
    const m = add(P.tube(0.08 * k, 1.2 * k), tubeMat, fire.x, fy + 0.1 * k, fire.z, (n / 4) * Math.PI);
    m.rotation.z = 0.25;
  }
  const stone = P.foldedRock(rand).translate(0, 0.25, 0), stoneMat = plain("#8f8b84", { flatShading: true });
  for (let n = 0; n < 9; n++) { const a = (n / 9) * Math.PI * 2; add(stone, stoneMat, fire.x + Math.cos(a) * 0.85 * k, fy - 0.03, fire.z + Math.sin(a) * 0.85 * k, a * 3, 0.24 * k); }
  blobs.push([fire.x, fire.z, 1.1 * k, 0.6]);

  // Woodpile: rolled paper tubes, stacked.
  const wp = camp.woodpile, wy = standY(wp.x, wp.z) ?? fy, wyaw = Math.atan2(fire.x - wp.x, fire.z - wp.z) + Math.PI / 2;
  const tubes = [];
  [[5, 0], [4, 1], [3, 2]].forEach(([n, row]) => {
    for (let c = 0; c < n; c++) {
      const off = (c - (n - 1) / 2) * 0.25 * k, r = 0.12 * k;
      tubes.push({ x: wp.x + Math.cos(wyaw) * off, y: wy + r + row * r * 1.7, z: wp.z - Math.sin(wyaw) * off, s: 1, yaw: wyaw + Math.PI / 2, color: ["#c9a06e", "#b48a5e", "#a47a4e"][(c + row) % 3] });
    }
  });
  build(P.tube(0.12 * k, 1.6 * k), tubeMat, tubes);
  blobs.push([wp.x, wp.z, 0.9 * k, 0.5]);
  if (logs.length) build(P.tube(0.2, 1), tubeMat, logs.map((l) => ({ x: l.x, y: l.y + 0.2, z: l.z, sx: l.length, sy: 1, sz: 1, yaw: l.yaw, color: "#b08a60" })));
  return { x: fire.x, y: fy, z: fire.z };
}

// White paper wave crests glued on the sea just off the shallows, following the cut edge.
function addWaves(scene, { shallow, dx, yDeep, step }) {
  const pos = [];
  const thick = step * 0.06, len = dx * (VIEW === "camp" ? 6 : 9), wid = len * 0.16;
  let n = 0;
  for (const sh of shallow) {
    const loop = sh.outer;
    for (let i = 0; i < loop.length; i += 5) {
      if (hash(i, n, 4) > 0.5) continue;
      const a = loop[i], b = loop[(i + 2) % loop.length];
      const tx = b[0] - a[0], tz = b[1] - a[1], tl = Math.hypot(tx, tz) || 1, nx = tz / tl, nz = -tx / tl;
      const o = dx * (2 + hash(i, n, 5) * 9), cx = a[0] + nx * o, cz = a[1] + nz * o;
      // A crescent: two arcs, thick in the middle, pointed at both ends.
      const seg = 8, pts = [];
      for (let k = 0; k <= seg; k++) { const t = k / seg - 0.5, bend = (1 - 4 * t * t) * wid; pts.push([t * len, bend]); }
      for (let k = seg; k >= 0; k--) { const t = k / seg - 0.5, bend = (1 - 4 * t * t) * wid * 0.35; pts.push([t * len, bend]); }
      const world = pts.map(([u, v]) => [cx + (tx / tl) * u + nx * v, cz + (tz / tl) * u + nz * v]);
      const y = yDeep + thick;
      for (let k = 0; k < seg; k++) {
        const o0 = world[k], o1 = world[k + 1], i0 = world[2 * seg + 1 - k], i1 = world[2 * seg - k];
        pos.push(o0[0], y, o0[1], i0[0], y, i0[1], o1[0], y, o1[1], o1[0], y, o1[1], i0[0], y, i0[1], i1[0], y, i1[1]);
      }
      n++;
    }
  }
  if (!pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, paperMaterial({ side: THREE.DoubleSide, color: `diffuseColor.rgb = ${glsl(PAPER.foam)};`, light: "vec4 bk = texture2D( tBake, planUv( vW.xz ) ); gSun = bk.r; ao = bk.g;" }));
  m.receiveShadow = true;
  m.castShadow = true;
  m.frustumCulled = false;
  scene.add(m);
}

// A pencil and a few offcuts left on the mat beside the model, out where the paper sheet ends.
function addProps(scene, camera, V, pad, tilt, cx, cz, rand) {
  const mm = V.mm, ground = (nx, ny) => {
    const r = new THREE.Vector3(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
    const t = -camera.position.y / r.y;
    return [camera.position.x + r.x * t, camera.position.z + r.z * t];
  };
  // Push a point out past the nearest edge of the sea sheet; returns it and that edge's direction.
  const snap = ([x, z], m) => {
    const c = Math.cos(tilt), s = Math.sin(tilt);
    let u = (x - cx) * c + (z - cz) * s, v = -(x - cx) * s + (z - cz) * c;
    const alongU = Math.abs(v) > Math.abs(u);
    if (alongU) v = Math.sign(v) * Math.max(Math.abs(v), pad + m); else u = Math.sign(u) * Math.max(Math.abs(u), pad + m);
    return { x: cx + u * c - v * s, z: cz + u * s + v * c, edge: alongU ? tilt : tilt + Math.PI / 2 };
  };
  const mat = (hex, extra = {}) => paperMaterial({ color: `diffuseColor.rgb = ${glsl(hex)};`, grain: 0.15, light: "ao = 1.0;", ...extra });
  const r = 3.6 * mm, L = 150 * mm, parts = [];
  const body = new THREE.CylinderGeometry(r, r, L, 6).toNonIndexed();
  const wood = new THREE.ConeGeometry(r, 20 * mm, 6, 1, true).toNonIndexed().rotateZ(Math.PI).translate(0, -L / 2 - 10 * mm, 0);
  const lead = new THREE.ConeGeometry(r * 0.32, 6.4 * mm, 6, 1, true).toNonIndexed().rotateZ(Math.PI).translate(0, -L / 2 - 16.8 * mm, 0);
  const ferrule = new THREE.CylinderGeometry(r * 1.03, r * 1.03, 9 * mm, 12).toNonIndexed().translate(0, L / 2 + 4.5 * mm, 0);
  const eraser = new THREE.CylinderGeometry(r * 0.98, r * 0.98, 8 * mm, 12).toNonIndexed().translate(0, L / 2 + 13 * mm, 0);
  parts.push([body, "#e7b53b"], [wood, "#e9cfa2"], [lead, "#3a3a3c"], [ferrule, "#b9b7ae"], [eraser, "#e58d8a"]);
  const at = snap(ground(0.8, 0.74), 16 * mm);
  const pencil = new THREE.Group();
  for (const [g, hex] of parts) { const m = new THREE.Mesh(g, mat(hex, { flatShading: true })); m.castShadow = m.receiveShadow = true; pencil.add(m); }
  pencil.rotation.set(0, Math.PI - at.edge + 0.1, Math.PI / 2, "YXZ");
  pencil.position.set(at.x, r * 0.87, at.z);
  scene.add(pencil);
  // Offcuts: the paper the sheets were cut from, in the model's own colours.
  const scraps = [[-0.82, -0.7, PAPER.forest], [-0.62, -0.84, PAPER.heath], [0.86, -0.6, PAPER.sand], [0.78, -0.82, PAPER.meadow], [-0.9, 0.2, PAPER.shallow]];
  for (const [nx, ny, hex] of scraps) {
    const s = (18 + rand() * 16) * mm, p = snap(ground(nx, ny), s * 1.7 + 6 * mm);
    const shape = new THREE.Shape(), n = 7;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand() * 0.4, rr = s * (0.55 + rand() * 0.6);
      k ? shape.lineTo(Math.cos(a) * rr * 1.5, Math.sin(a) * rr) : shape.moveTo(Math.cos(a) * rr * 1.5, Math.sin(a) * rr);
    }
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.35 * mm, bevelEnabled: false }).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat(hex));
    m.position.set(p.x, 0.2 * mm, p.z);
    m.rotation.y = rand() * 6.28;
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
}

// The cutting mat and the desk under it.
function addDesk(scene, view, region, V, pad, cx, cz) {
  const cm = V.mm * 10, size = view === "island" ? pad * 2.9 : region.size * 4;
  const T = 4096, c = canvas(T), g = c.getContext("2d"), px = T / size;
  g.fillStyle = PAPER.mat;
  g.fillRect(0, 0, T, T);
  const lines = Math.floor(size / cm);
  for (let k = 0; k <= lines; k++) {
    const v = k * cm * px, major = k % 10 === 0, half = k % 5 === 0;
    g.strokeStyle = major ? "rgba(236,232,214,0.55)" : half ? "rgba(236,232,214,0.32)" : "rgba(236,232,214,0.16)";
    g.lineWidth = major ? 2.2 : half ? 1.4 : 1;
    g.beginPath(); g.moveTo(v, 0); g.lineTo(v, T); g.stroke();
    g.beginPath(); g.moveTo(0, v); g.lineTo(T, v); g.stroke();
  }
  g.fillStyle = "rgba(236,232,214,0.7)";
  g.font = `${Math.round(cm * px * 0.45)}px sans-serif`;
  g.textAlign = "center";
  for (let k = 1; k < lines; k++) {
    g.fillText(String(k), k * cm * px, cm * px * 0.75);
    g.save(); g.translate(cm * px * 0.6, k * cm * px); g.rotate(-Math.PI / 2); g.fillText(String(k), 0, 0); g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = paperMaterial({ map: tex, grain: 0.05, wrap: 0.1, trans: 0, light: "ao = 1.0;" });
  const off = view === "island" ? [cx - size * 0.1, cz - size * 0.08] : [cx, cz];
  const matMesh = new THREE.Mesh(new THREE.BoxGeometry(size, cm * 0.3, size).translate(0, -cm * 0.15, 0), mat);
  matMesh.position.set(off[0], 0, off[1]);
  matMesh.receiveShadow = true;
  scene.add(matMesh);
  const wood = `float s = uGrainScale; float gr = texture2D( tGrain, vec2( vW.x * s * 0.05, vW.z * s * 1.6 ) ).b + 0.5 * texture2D( tGrain, vec2( vW.x * s * 0.2, vW.z * s * 5.0 ) ).a;
    diffuseColor.rgb = ${glsl(PAPER.desk)} * ( 0.7 + 0.45 * gr );`;
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(size * 6, size * 6).rotateX(-Math.PI / 2), paperMaterial({ color: wood, grain: 0.05, light: "ao = 0.9;" }));
  desk.position.set(cx, -cm * 0.3, cz);
  desk.receiveShadow = true;
  scene.add(desk);
}

// ---------------------------------------------------------------------------------------------------------------
// Render at twice the size into a float target, then one lens pass: a gathered bokeh from depth (thin-lens circle
// of confusion around the focus distance), filmic tone, a warm and cool grade, vignette and a whisper of grain.
async function render(scene, camera, W, H, target, V) {
  const canvasEl = document.getElementById("view");
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const SS = 2;
  const rt = new THREE.WebGLRenderTarget(W * SS, H * SS, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  rt.depthTexture = new THREE.DepthTexture(W * SS, H * SS);
  rt.depthTexture.type = THREE.UnsignedIntType;
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  const post = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: rt.texture }, tDepth: { value: rt.depthTexture }, uRes: { value: new THREE.Vector2(W, H) },
      uNear: { value: camera.near }, uFar: { value: camera.far }, uFocus: { value: camera.position.distanceTo(target) },
      uK: { value: V.dof.k }, uMax: { value: V.dof.max }, uExposure: { value: 0.86 },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uRes;
      uniform float uNear, uFar, uFocus, uK, uMax, uExposure;
      varying vec2 vUv;
      float depthAt( vec2 uv ) { float d = texture2D( tDepth, uv ).r; return ( uNear * uFar ) / ( uFar - d * ( uFar - uNear ) ); }
      float coc( float z ) { return min( uMax, uK * abs( 1.0 - uFocus / z ) ); }
      vec3 aces( vec3 x ) { return clamp( ( x * ( 2.51 * x + 0.03 ) ) / ( x * ( 2.43 * x + 0.59 ) + 0.14 ), 0.0, 1.0 ); }
      float rnd( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
      void main() {
        float cz = depthAt( vUv ), cs = coc( cz );
        vec3 col = texture2D( tColor, vUv ).rgb;
        float tot = 1.0, r = 0.6, ang = 0.0;
        for ( int i = 0; i < 360; i ++ ) {
          if ( r >= uMax ) break;
          vec2 tc = vUv + vec2( cos( ang ), sin( ang ) ) * r / uRes;
          vec3 sc = texture2D( tColor, tc ).rgb;
          float sz = depthAt( tc ), ss = coc( sz );
          if ( sz > cz ) ss = clamp( ss, 0.0, cs * 2.0 );
          float m = smoothstep( r - 0.5, r + 0.5, ss );
          col += mix( col / tot, sc, m );
          tot += 1.0;
          r += 0.75 / r;
          ang += 2.39996;
        }
        col /= tot;
        col = aces( col * uExposure );
        float l = dot( col, vec3( 0.299, 0.587, 0.114 ) );
        col = mix( col * vec3( 0.95, 0.98, 1.05 ), col * vec3( 1.04, 1.0, 0.94 ), smoothstep( 0.15, 0.75, l ) );
        vec2 q = ( vUv - 0.5 ) * vec2( uRes.x / uRes.y, 1.0 );
        col *= mix( 1.0, 0.68, smoothstep( 0.35, 1.05, length( q ) ) );
        col = pow( max( col, 0.0 ), vec3( 1.0 / 2.2 ) );
        col += ( rnd( vUv * uRes + 17.0 ) - 0.5 ) * 0.018;
        gl_FragColor = vec4( col, 1.0 );
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post);
  const postScene = new THREE.Scene();
  postScene.add(quad);
  renderer.setRenderTarget(null);
  renderer.render(postScene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
  renderer.getContext().finish();
}
