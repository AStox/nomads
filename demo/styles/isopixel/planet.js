// The planet as a base layer: the seed's tile pyramid (pyramid.js, from scripts/globe-pyramid.ts) drawn in the island's art
// (wgsl/globe.js, whose colour is the ground painter's own) into any target, from the whole sphere down to an isometric view tens of
// metres across, for the render worker to put under the ladder's tiles. One call records two passes: the planet made at an art
// pixel of `art` device pixels, then a blit of that onto the target by whole pixels. The camera is planet-cam.js's. Before it draws,
// it asks the pyramid for the tiles the view's pixels need (a grid of screen points, a margin beyond the screen, each at the tier
// whose cells are about an art pixel across and the two coarser ones), so the finer tier arrives over the coarser, and it tells the
// shader the finest level for which every tile the whole view reads is held (`cap`): the whole screen shows one level and a finer one
// arrives as one cross-fade of all of it.
import { dqBuild, noiseGrads } from "./ground.wgsl.js";
import { faceFrac, tierOffset } from "./pyramid.js";
import { globeWgsl } from "./wgsl/globe.js";

const DEPTH = "depth32float", ART_FORMAT = "rgba8unorm";
const RING = 4;
const sm = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
// the screen points a view's tiles are found by, spread over the screen and MARGIN of it beyond each edge (the tiles a pan is about to need)
const GRID_X = 14, GRID_Y = 10, MARGIN = 0.12;
// how fast the level the screen shows rises once the tiles of a finer one are held, in levels a second: a cross-fade of about a third of a second
const CAP_RATE = 3;

// G: the globe.js bundle's namespace (FRAMES); pyramid: pyramid.js openPyramid's; pal: pal.js's namespace; radiusM: the planet's radius
// in metres, which every metre in here follows; the cameras (planetCam's radiusM) must be of the same radius.
// -> { hmax, draw(enc, targetView, cam, opts) }
// draw: cam from planetCam; opts { w, h (target px), art (device px an art pixel, 2), sun (unit vector, the light that shades the
// sphere), relief (the light's exaggeration of slopes, 2.5), exag (the ground's lift, 1.5 as the ladder's), riverCut (m3/s), frame (the
// water's loop, 0 to 7: the clock's when not given), season (0 spring to 3 winter, 0 when not given), clearRGB (0 to 255),
// timestampWrites }. A draw's uniforms are one of RING buffers in turn, so up to RING draws may be recorded before one submit.
export async function createPlanet({ device, format, G, pyramid, pal, radiusM, hmax, levels }) {
  const R = radiusM, { P, RGB, NCOL, HAZE, SHADOW, TONE, TONE_S } = pal, offsets = Array.from({ length: pyramid.tiers + 1 }, (_, t) => tierOffset(t));
  const store = (data) => {
    const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  // HAZE and SHADOW, then TONE's rows, one palette index a word (wgsl/globe.js T_SHADOW, T_TONE)
  const tables = new Uint32Array(NCOL * (2 + TONE_S.length));
  tables.set(HAZE, 0); tables.set(SHADOW, NCOL); tables.set(TONE, 2 * NCOL);
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, F = GPUShaderStage.FRAGMENT;
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: VF, buffer: { type: "uniform" } },
      { binding: 1, visibility: F, texture: { sampleType: "uint", viewDimension: "2d-array" } },
      { binding: 2, visibility: F, texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
      { binding: 3, visibility: F, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: F, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: F, buffer: { type: "read-only-storage" } },
      { binding: 6, visibility: F, buffer: { type: "read-only-storage" } },
      { binding: 7, visibility: F, buffer: { type: "read-only-storage" } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const blitBgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: F, buffer: { type: "uniform" } },
      { binding: 8, visibility: F, texture: { sampleType: "float", viewDimension: "2d" } },
    ],
  });
  const module = device.createShaderModule({ code: globeWgsl({ FRAMES: G.FRAMES, P, RGB, NCOL, TONE_S, offsets, LEVELS: levels }) });
  const artTarget = [{ format: ART_FORMAT }];
  const [planetPipe, blitPipe] = await Promise.all([
    device.createRenderPipelineAsync({ layout, vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: artTarget }, primitive: { topology: "triangle-list" }, depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: "always" } }),
    device.createRenderPipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [blitBgl] }), vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "bfs", targets: [{ format }] }, primitive: { topology: "triangle-list" } }),
  ]);
  const dq = store(dqBuild()), tab = store(tables), grads = store(noiseGrads());
  // the sky's light tables (the page sends them as the light changes): levels x 4 fire levels (and a last row) of NCOL colours
  const lutB = device.createBuffer({ size: (levels * 4 + 1) * NCOL * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const ring = Array.from({ length: RING }, () => {
    const buffer = device.createBuffer({ size: 240, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bind = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: pyramid.fieldsT.createView({ dimension: "2d-array" }) },
        { binding: 2, resource: pyramid.heightsT.createView({ dimension: "2d-array" }) },
        { binding: 3, resource: { buffer: pyramid.tableB } },
        { binding: 4, resource: { buffer: tab } },
        { binding: 5, resource: { buffer: dq } },
        { binding: 6, resource: { buffer: lutB } },
        { binding: 7, resource: { buffer: grads } },
      ],
    });
    return { buffer, bind, blit: null };
  });
  // the picture is made at an art pixel (a quarter of the pixels at 2) and shown by whole pixels in a second pass
  let slot = 0, art = null;
  // wgsl/globe.js U: 44 floats, then the noise frame's fractions and tangents, its whole metres and the target's face, the level cap, the water frame and the season
  const ub = new ArrayBuffer(240), u = new Float32Array(ub), ui = new Int32Array(ub);
  function artFor(aw, ah) {
    if (art && art.w === aw && art.h === ah) return art;
    art?.color.destroy(); art?.depth.destroy();
    const color = device.createTexture({ size: [aw, ah], format: ART_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const depth = device.createTexture({ size: [aw, ah], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    art = { w: aw, h: ah, color, depth, colorView: color.createView(), depthView: depth.createView() };
    for (const r of ring) r.blit = device.createBindGroup({ layout: blitBgl, entries: [{ binding: 0, resource: { buffer: r.buffer } }, { binding: 8, resource: art.colorView }] });
    return art;
  }

  // the level whose cells are an art pixel across (wgsl/globe.js levelFor), for a metre an art pixel
  const c0 = (R * (Math.PI / 2)) / 256 * 0.8, top = pyramid.tiers - 1;
  const levelFor = (mpp) => Math.max(0, Math.min(top, Math.log2(c0 / Math.max(mpp, 1e-3))));
  // the view's points: for each of a grid of screen points (and a margin round the screen) the face, its place on it and the level its pixel is at
  function viewPoints(cam, w, h, artPx) {
    const pts = [];
    for (let j = 0; j < GRID_Y; j++)
      for (let i = 0; i < GRID_X; i++) {
        const x = (((i + 0.5) / GRID_X) * (1 + 2 * MARGIN) - MARGIN) * w, y = (((j + 0.5) / GRID_Y) * (1 + 2 * MARGIN) - MARGIN) * h, p = cam.pick(x, y);
        if (!p) continue;
        const d = Math.hypot(p[0] - cam.o[0], p[1] - cam.o[1], p[2] - cam.o[2]), mpp = ((artPx * 2 * cam.tanH) / h) * d * R, { f, fx, fy } = faceFrac(G.FRAMES, p);
        pts.push({ f, fx, fy, lv: levelFor(mpp), centre: Math.hypot(x - w / 2, y - h / 2) / w });
      }
    return pts;
  }
  const tileOf = (p, t) => { const n = 2 ** t; return { t, f: p.f, tx: Math.min(n - 1, Math.floor(p.fx * n)), ty: Math.min(n - 1, Math.floor(p.fy * n)) }; };
  // the tiles the view's pixels read: for each point the tier its cells fit and the two coarser, coarsest first
  function wanted(pts) {
    const seen = new Map();
    for (const p of pts) {
      const want = Math.ceil(p.lv);
      for (let t = Math.max(0, want - 2); t <= want; t++) {
        const k = tileOf(p, t), key = ((t * 6 + p.f) * 64 + k.ty) * 64 + k.tx, pri = t * 10 + p.centre;
        const had = seen.get(key);
        if (!had || had.pri > pri) seen.set(key, { ...k, pri });
      }
    }
    return [...seen.values()].sort((a, b) => a.pri - b.pri);
  }
  // the finest level (a whole number) at which every point of the view can be drawn: the tiers round its level, held to that level, are held
  function readyLevel(pts) {
    for (let k = top; k > 0; k--)
      if (pts.every((p) => { const e = Math.min(p.lv, k), a = tileOf(p, Math.floor(e)), b = tileOf(p, Math.min(top, Math.ceil(e))); return pyramid.ready(a.t, a.f, a.tx, a.ty) && pyramid.ready(b.t, b.f, b.tx, b.ty); })) return k;
    return 0;
  }
  // the level the screen shows: down at once (a coarser level is always held), up by CAP_RATE a second
  let cap = 0, capAt = performance.now();

  // the noise's frame: the face of the camera's target, the tangents of the target on it and its place in metres along the equiangular axes (wgsl/globe.js noiseXZ)
  function noiseFrame(T) {
    let f = 0, best = -Infinity;
    for (let k = 0; k < 6; k++) { const d = T[0] * G.FRAMES[k].n[0] + T[1] * G.FRAMES[k].n[1] + T[2] * G.FRAMES[k].n[2]; if (d > best) { best = d; f = k; } }
    const X = G.FRAMES[f].ex, Y = G.FRAMES[f].ey, ua = (T[0] * X[0] + T[1] * X[1] + T[2] * X[2]) / best, vb = (T[0] * Y[0] + T[1] * Y[1] + T[2] * Y[2]) / best;
    const mx = R * Math.atan(ua) + (R * Math.PI) / 4, mz = R * Math.atan(vb) + (R * Math.PI) / 4, ox = Math.floor(mx), oz = Math.floor(mz);
    return { f, ua, vb, fx: mx - ox, fz: mz - oz, ox, oz };
  }

  function draw(enc, targetView, cam, opts) {
    const w = opts.w, h = opts.h, artPx = opts.art ?? 2, exag = opts.exag ?? 1.5, sun = opts.sun ?? [0.6, 0.5, 0.62], clear = opts.clearRGB ?? [0, 0, 0];
    const pts = viewPoints(cam, w, h, artPx);
    pyramid.want(wanted(pts));
    const now = performance.now(), ready = readyLevel(pts);
    cap = ready < cap ? ready : Math.min(ready, cap + ((now - capAt) / 1000) * CAP_RATE);
    capAt = now;
    const a = artFor(Math.ceil(w / artPx), Math.ceil(h / artPx));
    const hmaxR = (exag * hmax) / R, oLen = Math.hypot(cam.o[0], cam.o[1], cam.o[2]), cut = opts.riverCut ?? 20, nf = noiseFrame(cam.T);
    u.set([...cam.o, cam.tanH, ...cam.fwd, cam.aspect, ...cam.right, opts.relief ?? 2.5, ...cam.up, exag, ...sun, R, ...cam.T, hmaxR, ...cam.off, artPx,
      w, h, Math.max(1e-6, 0.4 * (oLen - 1 - hmaxR)), oLen + 1.01, cut, sm(0.05, 0.3, oLen - 1), a.w, a.h, ...(opts.moon ?? [0, 0, 1]), opts.moonMix ?? 0, opts.amb ?? 1, 0, 0, 0,
      nf.ua, nf.vb, nf.fx, nf.fz]);
    ui[48] = nf.ox; ui[49] = nf.oz; ui[50] = 0; ui[51] = 0;
    u[52] = cap; u[53] = opts.frame ?? (Math.floor(now / 160) & 7); u[54] = opts.season ?? 0; u[55] = 0;
    ui[56] = nf.f; ui[57] = 0; ui[58] = 0; ui[59] = 0;
    const r = ring[slot++ % RING], ts = opts.timestampWrites;
    device.queue.writeBuffer(r.buffer, 0, ub);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: a.colorView, loadOp: "clear", storeOp: "store", clearValue: [clear[0] / 255, clear[1] / 255, clear[2] / 255, 1] }],
      depthStencilAttachment: { view: a.depthView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
      ...(ts ? { timestampWrites: { querySet: ts.querySet, beginningOfPassWriteIndex: ts.beginningOfPassWriteIndex } } : {}),
    });
    pass.setBindGroup(0, r.bind);
    pass.setPipeline(planetPipe); pass.draw(3);
    pass.end();
    const blit = enc.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: "clear", storeOp: "store", clearValue: [clear[0] / 255, clear[1] / 255, clear[2] / 255, 1] }],
      ...(ts ? { timestampWrites: { querySet: ts.querySet, endOfPassWriteIndex: ts.endOfPassWriteIndex } } : {}),
    });
    blit.setPipeline(blitPipe); blit.setBindGroup(0, r.blit); blit.draw(3); blit.end();
  }
  const setLut = (lut) => device.queue.writeBuffer(lutB, 0, lut.subarray(0, Math.min(lut.length, (levels * 4 + 1) * NCOL)));
  return { hmax, draw, setLut, level: () => cap };
}
