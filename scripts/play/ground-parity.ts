// Parity of the GPU ground painter (demo/styles/isopixel/ground.wgsl.js) with main.js's, pixel by pixel: seed 1's
// island, a few hundred thousand points over land, shores, lakes, the sea, streams, rock, snow and worn paths, at every
// level of the zoom ladder, in every season and frame, with and without paths and ice. Prints each function's mismatch
// rate, explains each painted mismatch it can by a threshold within a millimetre, and times a million paintGround calls.
//   bun scripts/play/ground-parity.ts [--n 400000]
import { exit, holdGpu } from "../seeded";
import { theGpu } from "../../src/gpu/device";
import { readback } from "../../src/gpu/kernel";
import { rng } from "../../src/sim/world";
import { generateIsland } from "../../src/terrain/island";
import { CELL, N } from "../../src/terrain/grid";
import { M, SIZE, START, STEP, TILES, TILE_M, fineGround, groundClass, noise, riverSmooth, waterAt, worldSlope } from "../../src/terrain/flora";

const root = `${import.meta.dir}/../..`;
// the page modules import the generator from the built site's island.js; here it is demo/island.ts itself
Bun.plugin({
  name: "demo-island",
  setup(b) {
    b.onResolve({ filter: /(^|\/)island\.js$/ }, (a) => (a.importer.includes("/demo/styles/") ? { path: `${root}/demo/island.ts` } : undefined));
  },
});
const G = globalThis as Record<string, unknown>;
G.ISO_LIB = true;
G.document ??= { createElement: () => ({}) };
// loaded after the plugin above is in place, which static imports would not wait for
const L = await import(`${root}/demo/styles/isopixel/main.js`);
const { packGround, groundWGSL, GROUND_BINDINGS } = await import(`${root}/demo/styles/isopixel/ground.wgsl.js`);
const { LADDER } = await import(`${root}/demo/styles/isopixel/ladder.js`);
const { P } = await import(`${root}/demo/styles/isopixel/pal.js`);

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const TOTAL = Number(arg("n", "400000"));
const adapter = await holdGpu();
const { device: dev } = await theGpu();
const NAME: string[] = [];
for (const [k, v] of Object.entries(P as Record<string, number>)) NAME[v] = k;
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;

// ---------- the island and its packing ----------
let t = performance.now();
const isle = generateIsland(rng(1)), g = fineGround(isle);
const w = { ...g, isle, N, CELL, SIZE, START, M, STEP };
console.log(`island ${ms(t)} on ${adapter}`);
t = performance.now();
const pk = packGround(isle, g);
console.log(`packGround ${ms(t)}`);

// the packed light grid and colour table against main.js's own
const WN = pk.grid.size, W2 = WN * WN, hJS = L.worldHeights(w), aoJS = L.worldAO(w);
let gridOff = 0;
for (let k = 0; k < W2; k++) if (hJS[k] !== pk.grid.data[k] || aoJS[k] !== pk.grid.data[W2 + k]) gridOff++;
const pr = rng(7);
for (let n = 0; n < 20000; n++) {
  const i = Math.floor(pr() * (WN - 1)), j = Math.floor(pr() * (WN - 1));
  if (Math.fround(worldSlope(g, -SIZE / 2 + i * 12.5, -SIZE / 2 + j * 12.5)) !== pk.grid.data[2 * W2 + j * WN + i]) gridOff++;
}
L.dq([0, 0, 0], 0, 0);
let dqOff = 0;
for (let k = 0; k < 32768; k++) { const e = pk.dq[k]; if ((e & 255) !== L.DQ[k * 3] || ((e >> 8) & 255) !== L.DQ[k * 3 + 1] || e >>> 16 !== L.DQ[k * 3 + 2]) dqOff++; }
console.log(`grid texels off main.js: ${gridOff}; colour pairs off main.js: ${dqOff}`);

// ---------- worn paths and ice ----------
const TN = Math.round(SIZE / 3), ORIGIN = -SIZE / 2, TC = 3;
const trail = new Map<number, number>(), trailTex = new Uint8Array(TN * TN), r = rng(11);
const wear = (i: number, j: number, q: number) => { if (i < 0 || j < 0 || i >= TN || j >= TN) return; const k = j * TN + i; trail.set(k, q); trailTex[k] = q; };
const land = (x: number, z: number) => g.heightAt(x, z) > 1 && waterAt(isle, g, x, z) < 0.5 && riverSmooth(g, x, z) < 0.5;
const randPoint = () => [Math.fround((r() - 0.5) * SIZE), Math.fround((r() - 0.5) * SIZE)];
const pathCells: [number, number][] = [];
for (let p = 0; p < 80; ) {
  const [x, z] = randPoint();
  if (!land(x, z)) continue;
  p++;
  let i = Math.floor((x - ORIGIN) / TC), j = Math.floor((z - ORIGIN) / TC), dir = Math.floor(r() * 8);
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  for (let s = 0; s < 400; s++) {
    const q = 1 + (Math.floor(s / 60 + p) % 4);
    wear(i, j, q);
    pathCells.push([i, j]);
    // a trodden patch now and then, where three or four cells round a point are worn
    if (s % 97 === 0) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) wear(i + a, j + b, 4);
    if (r() < 0.25) dir = (dir + (r() < 0.5 ? 1 : 7)) % 8;
    i += DX[dir]; j += DY[dir];
  }
}
const ice = new Uint8Array(TILES * TILES);
for (let ty = 0; ty < TILES; ty++)
  for (let tx = 0; tx < TILES; tx++) {
    const x = ORIGIN + (tx + 0.5) * TILE_M, z = ORIGIN + (ty + 0.5) * TILE_M;
    if ((waterAt(isle, g, x, z) > 0.3 && g.heightAt(x, z) > 0) || r() < 0.3) ice[ty * TILES + tx] = 1;
  }
// bake.js iceAt over a set of frozen tiles
const iceAtOf = (D: Uint8Array) => {
  const at = (tx: number, ty: number) => (tx >= 0 && ty >= 0 && tx < TILES && ty < TILES && D[ty * TILES + tx] === 1 ? 1 : 0);
  return (x: number, z: number) => {
    const fx = (x - ORIGIN) / TILE_M - 0.5, fz = (z - ORIGIN) / TILE_M - 0.5, i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j;
    const v = (at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - b) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * b;
    return v > 0.5 + noise(x / 40, z / 40, 77) * 0.3;
  };
};
const ICE_AT = [iceAtOf(new Uint8Array(TILES * TILES)), iceAtOf(ice)];

// ---------- the points ----------
const CATS = ["land", "sea", "shore", "lake", "stream", "rock", "snow", "trail"] as const;
const SHARE = [0.25, 0.06, 0.15, 0.08, 0.14, 0.1, 0.1, 0.12];
type Query = { x: number; z: number; X: number; Y: number; lv: number; season: number; frame: number; flags: number; face: number; depth: number; hpx: number; lev: number; ice: number; cat: number };
const queries: Query[] = [];
const snowAt = (x: number, z: number) => g.bilinear(isle.seasons[3].snowpack, (x - START) / CELL, (z - START) / CELL);
const pick = (cat: number): [number, number] | null => {
  switch (CATS[cat]) {
    case "land": { const [x, z] = randPoint(); return land(x, z) ? [x, z] : null; }
    case "sea": { const [x, z] = randPoint(); return waterAt(isle, g, x, z) > 0.5 && g.heightAt(x, z) < 0.5 ? [x, z] : null; }
    case "shore": {
      const [x, z] = randPoint(), wv = waterAt(isle, g, x, z), rv = riverSmooth(g, x, z);
      return Math.abs(wv - 0.5) < 0.25 || Math.abs(rv - 0.5) < 0.35 ? [x, z] : null;
    }
    case "lake": { const [x, z] = randPoint(); return waterAt(isle, g, x, z) > 0.5 && g.heightAt(x, z) >= 0.5 ? [x, z] : null; }
    case "stream": {
      const line = g.rivers[Math.floor(r() * g.rivers.length)], p = line[Math.floor(r() * line.length)];
      return [Math.fround(p[0] + (r() - 0.5) * 40), Math.fround(p[1] + (r() - 0.5) * 40)];
    }
    case "rock": { const [x, z] = randPoint(); return land(x, z) && groundClass(isle, g, x, z).cls === 7 ? [x, z] : null; }
    case "snow": { const [x, z] = randPoint(); return land(x, z) && snowAt(x, z) > 2 ? [x, z] : null; }
    default: {
      const [i, j] = pathCells[Math.floor(r() * pathCells.length)];
      return [Math.fround(ORIGIN + (i + r() * 1.0) * TC + (r() - 0.5) * 12), Math.fround(ORIGIN + (j + r()) * TC + (r() - 0.5) * 12)];
    }
  }
};
t = performance.now();
for (let cat = 0; cat < CATS.length; cat++) {
  const want = Math.round(TOTAL * SHARE[cat]);
  for (let n = 0; n < want; ) {
    const at = pick(cat);
    if (!at) continue;
    n++;
    const depth = Math.fround(r() * 6);
    queries.push({
      x: at[0], z: at[1], X: Math.floor((r() - 0.5) * 300000), Y: Math.floor((r() - 0.5) * 300000),
      lv: Math.floor(r() * LADDER.length), season: CATS[cat] === "snow" && r() < 0.6 ? 3 : Math.floor(r() * 4), frame: Math.floor(r() * 8),
      flags: r() < (CATS[cat] === "trail" ? 0.9 : 0.5) ? 1 : 0, face: r() < 0.5 ? 1 : 0, depth, hpx: Math.fround(depth + r() * 8), lev: Math.fround(r() * 90 - 10),
      ice: r() < 0.5 ? 1 : 0, cat,
    });
  }
}
console.log(`${queries.length} points ${ms(t)}`);

// ---------- main.js ----------
const SEASONS = ["spring", "summer", "autumn", "winter"];
const kOf = (lv: number) => LADDER[lv].W / (LADDER[lv].tileM * Math.SQRT2);
const views = new Map<string, Record<string, unknown>>();
const viewOf = (q: Query) => {
  const key = `${q.lv}|${q.season}|${q.flags}|${q.ice}`;
  let V = views.get(key);
  if (!V) {
    const k = kOf(q.lv);
    V = { k, mpp: 1 / k, season: SEASONS[q.season], realtime: true, aoGpu: true, iceAt: ICE_AT[q.ice], trail: q.flags & 1 ? trail : null, lp: LADDER[q.lv].lp };
    views.set(key, V);
  }
  return V;
};
// main.js buildMap's surfAt, as written there
const I = isle;
const surfJS = (x: number, z: number) => {
  const cx = Math.round((x - w.START) / w.CELL), cy = Math.round((z - w.START) / w.CELL);
  let best = 0, bd = Infinity;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const X = cx + dx, Y = cy + dy;
      if (X < 0 || Y < 0 || X >= N || Y >= N || I.water[Y * N + X] <= 0) continue;
      if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = I.height[Y * N + X] + I.water[Y * N + X]; }
    }
  return best;
};
const paintJS = (q: Query, x = q.x, z = q.z) => {
  const V = viewOf(q);
  L.setMode("valley", q.frame);
  const s = L.terrainLight(w, V, x, z), gp = L.groundAt(w, V, x, z);
  return { col: gp.water ? L.paintWater(w, V, gp, q.X, q.Y) : L.paintLand(w, V, gp, q.X, q.Y, s), kind: gp.water ? 40 + gp.water : gp.cls };
};
t = performance.now();
const nq = queries.length, js = { col: new Uint32Array(nq), kind: new Uint8Array(nq), bank: new Uint32Array(nq), h: new Float64Array(nq), wa: new Float64Array(nq), surf: new Float64Array(nq) };
queries.forEach((q, n) => {
  const p = paintJS(q);
  js.col[n] = p.col; js.kind[n] = p.kind;
  js.bank[n] = L.texWall(viewOf(q), L.DIRTW, q.face, q.X, q.Y, q.depth, q.hpx, q.lev, true, 0);
  js.h[n] = g.heightAt(q.x, q.z); js.wa[n] = waterAt(isle, g, q.x, q.z); js.surf[n] = surfJS(q.x, q.z);
});
L.setMode("valley", 0);
console.log(`main.js ${ms(t)} (${((performance.now() - t) / nq * 1000).toFixed(1)} µs a point)`);

// ---------- the GPU ----------
const U = GPUTextureUsage, B = GPUBufferUsage;
const arrayTex = (p: { size: number; layers: number; data: Float32Array }) => {
  const tex = dev.createTexture({ size: [p.size, p.size, p.layers], format: "r32float", usage: U.TEXTURE_BINDING | U.COPY_DST });
  dev.queue.writeTexture({ texture: tex }, p.data, { bytesPerRow: p.size * 4, rowsPerImage: p.size }, [p.size, p.size, p.layers]);
  return tex.createView({ dimension: "2d-array" });
};
const byteTex = (size: number, data: Uint8Array) => {
  const tex = dev.createTexture({ size: [size, size], format: "r8uint", usage: U.TEXTURE_BINDING | U.COPY_DST });
  dev.queue.writeTexture({ texture: tex }, data, { bytesPerRow: size }, [size, size]);
  return tex.createView();
};
const buf = (data: ArrayBufferView, usage = B.STORAGE) => {
  const b = dev.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | B.COPY_DST | B.COPY_SRC });
  dev.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
  return b;
};
t = performance.now();
const ground = [arrayTex(pk.fine), arrayTex(pk.isle), arrayTex(pk.grid), byteTex(pk.fine.size && Math.sqrt(pk.river.length), pk.river), byteTex(TN, trailTex)];
const iceViews = [byteTex(TILES, new Uint8Array(TILES * TILES)), byteTex(TILES, ice)];
const stores = [buf(pk.dq), buf(pk.grad), buf(pk.streams), buf(pk.streamBins)];
const vis = GPUShaderStage.COMPUTE;
const groundLayout = dev.createBindGroupLayout({
  entries: GROUND_BINDINGS.map((b: { kind: string; sampleType: GPUTextureSampleType; dim: GPUTextureViewDimension }, binding: number) =>
    b.kind === "texture" ? { binding, visibility: vis, texture: { sampleType: b.sampleType, viewDimension: b.dim } } : { binding, visibility: vis, buffer: { type: "read-only-storage" as const } }),
});
const groundGroup = (iceOn: number) => dev.createBindGroup({
  layout: groundLayout,
  entries: [...ground, iceViews[iceOn]].map((resource, binding) => ({ binding, resource })).concat(stores.map((buffer, k) => ({ binding: 6 + k, resource: { buffer } })) as never[]),
});
const testLayout = dev.createBindGroupLayout({ entries: [0, 1, 2].map((binding) => ({ binding, visibility: vis, buffer: { type: binding ? ("storage" as const) : ("read-only-storage" as const) } })) });
const code = `${groundWGSL(0, pk.consts)}
struct Q { x: f32, z: f32, X: i32, Y: i32, k: f32, frame: u32, season: u32, flags: u32, face: u32, depth: f32, hpx: f32, lev: f32, lp: f32, n: u32, p1: u32, p2: u32 }
@group(1) @binding(0) var<storage, read> qs: array<Q>;
@group(1) @binding(1) var<storage, read_write> outU: array<vec2<u32>>;
@group(1) @binding(2) var<storage, read_write> outF: array<vec4<f32>>;
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * 4194240u;
  if (i >= qs[0].n) { return; }
  let q = qs[i];
  let c = PaintCtx(q.k, q.frame, q.season, q.flags);
  outU[i] = vec2<u32>(paintGround(q.x, q.z, q.X, q.Y, c), bankColour(q.face, q.X, q.Y, q.depth, q.hpx, q.lev, q.lp));
  outF[i] = vec4<f32>(heightAt(q.x, q.z), waterAt(q.x, q.z), surfAt(q.x, q.z), 0.0);
}
@compute @workgroup_size(64) fn bench(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * 4194240u;
  let q = qs[i % qs[0].n];
  outU[i].x = paintGround(q.x, q.z, q.X, q.Y, PaintCtx(q.k, q.frame, q.season, q.flags));
}`;
dev.pushErrorScope("validation");
const module = dev.createShaderModule({ code });
const info = await module.getCompilationInfo();
for (const m of info.messages) console.log(`wgsl ${m.type} ${m.lineNum}:${m.linePos} ${m.message}  | ${code.split("\n")[m.lineNum - 1]?.trim()}`);
const layout = dev.createPipelineLayout({ bindGroupLayouts: [groundLayout, testLayout] });
const [check, bench] = await Promise.all(["check", "bench"].map((entryPoint) => dev.createComputePipelineAsync({ layout, compute: { module, entryPoint } })));
const err = await dev.popErrorScope();
if (err) { console.log(`GPU validation: ${err.message}`); await exit(1); }
console.log(`GPU setup and compile ${ms(t)}`);

const groups = (n: number): [number, number] => { const k = Math.ceil(n / 64); return k <= 65535 ? [k, 1] : [65535, Math.ceil(k / 65535)]; };
const pack = (list: Query[]) => {
  const a = new ArrayBuffer(Math.max(1, list.length) * 64), f = new Float32Array(a), u = new Uint32Array(a), s = new Int32Array(a);
  list.forEach((q, n) => {
    const o = n * 16;
    f[o] = q.x; f[o + 1] = q.z; s[o + 2] = q.X; s[o + 3] = q.Y; f[o + 4] = kOf(q.lv); u[o + 5] = q.frame; u[o + 6] = q.season; u[o + 7] = q.flags;
    u[o + 8] = q.face; f[o + 9] = q.depth; f[o + 10] = q.hpx; f[o + 11] = q.lev; f[o + 12] = LADDER[q.lv].lp;
  });
  u[13] = list.length;
  return a;
};
const run = async (pipe: GPUComputePipeline, iceOn: number, list: Query[], n: number, read = true) => {
  const qb = buf(new Uint8Array(pack(list))), ob = dev.createBuffer({ size: n * 8, usage: B.STORAGE | B.COPY_SRC }), fb = dev.createBuffer({ size: n * 16, usage: B.STORAGE | B.COPY_SRC });
  const tg = dev.createBindGroup({ layout: testLayout, entries: [qb, ob, fb].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const times: number[] = [];
  for (let rep = 0; rep < (read ? 1 : 6); rep++) {
    const enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, groundGroup(iceOn));
    pass.setBindGroup(1, tg);
    const [gx, gy] = groups(n);
    pass.dispatchWorkgroups(gx, gy);
    pass.end();
    const t0 = performance.now();
    dev.queue.submit([enc.finish()]);
    await dev.queue.onSubmittedWorkDone();
    times.push(performance.now() - t0);
  }
  const out = read ? { u: new Uint32Array(await readback({ device: dev, adapter }, ob)), f: new Float32Array(await readback({ device: dev, adapter }, fb)) } : null;
  qb.destroy(); ob.destroy(); fb.destroy();
  return { out, times };
};
// the 4194240 in the shaders: 65535 workgroups of 64
const gpu = { col: new Uint32Array(nq), bank: new Uint32Array(nq), h: new Float32Array(nq), wa: new Float32Array(nq), surf: new Float32Array(nq) };
for (const iceOn of [0, 1]) {
  const idx = queries.map((q, n) => (q.ice === iceOn ? n : -1)).filter((n) => n >= 0), list = idx.map((n) => queries[n]);
  const { out } = await run(check, iceOn, list, list.length);
  idx.forEach((n, k) => { gpu.col[n] = out!.u[k * 2]; gpu.bank[n] = out!.u[k * 2 + 1]; gpu.h[n] = out!.f[k * 4]; gpu.wa[n] = out!.f[k * 4 + 1]; gpu.surf[n] = out!.f[k * 4 + 2]; });
}

// ---------- the comparison ----------
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(4)}%`;
const floats = (name: string, a: Float64Array, b: Float32Array, tol: (v: number) => number) => {
  let off = 0, worst = 0;
  for (let n = 0; n < nq; n++) { const d = Math.abs(a[n] - b[n]); worst = Math.max(worst, d); if (d > tol(a[n])) off++; }
  console.log(`${name.padEnd(12)} ${pct(off, nq)} off (${off}), largest difference ${worst.toExponential(2)}`);
};
console.log(`\n${nq} points, seed 1`);
floats("heightAt", js.h, gpu.h, (v) => 1e-4 * Math.max(1, Math.abs(v)));
floats("waterAt", js.wa, gpu.wa, () => 1e-4);
floats("surfAt", js.surf, gpu.surf, (v) => 1e-4 * Math.max(1, Math.abs(v)));
// a bank mismatch shows the two sums texWall floors or compares with 1, to see whether float32 tipped one
let bankOff = 0;
for (let n = 0; n < nq; n++) {
  if (js.bank[n] === gpu.bank[n]) continue;
  const q = queries[n], lp = LADDER[q.lv].lp;
  if (bankOff++ < 5) console.log(`  bank: face ${q.face} X ${q.X} Y ${q.Y} depth ${q.depth} hpx ${q.hpx} lev ${q.lev} lp ${lp}: hpx - depth ${q.hpx - q.depth}, band sum ${(q.lev * lp) / 3}; main.js ${NAME[js.bank[n]]}, GPU ${NAME[gpu.bank[n]]}`);
}
console.log(`${"bankColour".padEnd(12)} ${pct(bankOff, nq)} off (${bankOff})`);

// A painted mismatch is a threshold if main.js itself paints the GPU's colour within a millimetre of the point.
const NEAR = [[1e-3, 0], [-1e-3, 0], [0, 1e-3], [0, -1e-3], [5e-4, 5e-4], [-5e-4, -5e-4], [5e-4, -5e-4], [-5e-4, 5e-4], [2e-4, 0], [-2e-4, 0], [0, 2e-4], [0, -2e-4]];
const off: number[] = [];
for (let n = 0; n < nq; n++) if (js.col[n] !== gpu.col[n]) off.push(n);
let explained = 0;
const odd: number[] = [];
for (const n of off) {
  const q = queries[n];
  if (NEAR.some(([dx, dz]) => paintJS(q, q.x + dx, q.z + dz).col === gpu.col[n])) explained++;
  else odd.push(n);
}
L.setMode("valley", 0);
console.log(`${"paintGround".padEnd(12)} ${pct(off.length, nq)} off (${off.length}); ${explained} of them a threshold within a millimetre, ${odd.length} not`);
const tally = (label: string, keyOf: (q: Query, n: number) => string) => {
  const all = new Map<string, number>(), bad = new Map<string, number>();
  queries.forEach((q, n) => { const k = keyOf(q, n); all.set(k, (all.get(k) ?? 0) + 1); });
  for (const n of off) { const k = keyOf(queries[n], n); bad.set(k, (bad.get(k) ?? 0) + 1); }
  console.log(`  by ${label}: ${[...all.keys()].sort().map((k) => `${k} ${pct(bad.get(k) ?? 0, all.get(k)!)}`).join(", ")}`);
};
tally("points", (q) => CATS[q.cat]);
tally("level", (q) => String(LADDER[q.lv].name));
tally("season", (q) => SEASONS[q.season]);
tally("drawn as", (_q, n) => ({ 41: "sea", 42: "lake", 43: "stream" } as Record<number, string>)[js.kind[n]] ?? `class ${js.kind[n]}`);
tally("paths", (q) => (q.flags ? "on" : "off"));
tally("ice", (q) => (q.ice ? "on" : "off"));
for (const n of odd.slice(0, 20)) {
  const q = queries[n];
  console.log(`  unexplained: x ${q.x} z ${q.z} X ${q.X} Y ${q.Y} ${LADDER[q.lv].name} ${SEASONS[q.season]} frame ${q.frame} paths ${q.flags} ice ${q.ice}: main.js ${NAME[js.col[n]]} (kind ${js.kind[n]}), GPU ${NAME[gpu.col[n]] ?? gpu.col[n]}`);
}
// what the points reach: pixels main.js paints otherwise for the worn paths and for the ice, and snow lying on rock
let byPaths = 0, byIce = 0, rockSnow = 0;
queries.forEach((q, n) => {
  if (q.flags && paintJS({ ...q, flags: 0 }).col !== js.col[n]) byPaths++;
  if (q.ice && js.kind[n] > 41 && paintJS({ ...q, ice: 0 }).col !== js.col[n]) byIce++;
  if (js.kind[n] === 7 && (js.col[n] === P.snow || js.col[n] === P.haze)) rockSnow++;
});
L.setMode("valley", 0);
console.log(`  covered: ${byPaths} pixels painted as worn paths, ${byIce} as ice, ${rockSnow} as snow on rock`);

// ---------- a million paintGround calls ----------
const MILLION = 1 << 20;
const { times } = await run(bench, 1, queries, MILLION, false);
const sorted = times.slice(1).sort((a, b) => a - b);
console.log(`\n${MILLION} paintGround calls (this mix of points): ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms median of ${sorted.length}, first ${times[0].toFixed(1)} ms`);
await exit(0);
