// The globe (/play/?globe): the seed's baked planet (scripts/globe-bake.ts) to turn and zoom, from the whole planet down to
// a few times the game's square across the screen, drawn in the island's art: the palette's indices, its ramps and tone
// steps, dithered sea and shallows, drawn at an art pixel and shown by whole pixels (isopixel/wgsl/globe.js). Near enough,
// the cursor's square is the game's ground (19.2 km, north up), and a click on land or coast lands there: the page goes to
// ?at=<lat>,<lon>, whose render worker refines the ground from the planet (worker.js landAt); the GLOBE button or G comes
// back here, to the camera as it was. The globe's detail is the planet's tier 0 (12 km cells): a cubic B-spline of the heights.

// what the globe and the game screen keep between them in the tab's session: the camera, the last landing's place and
// when it was clicked
export const KEPT = { cam: "nomads-globe-cam", last: "nomads-globe-last", clickedAt: "nomads-landing-t" };
const DEG = Math.PI / 180, APRON = 2, FOV_DEG = 45;
// the view's heights above the ground, m: from the whole planet down to the square three quarters of the screen's height
// (a 45 degree view shows 0.83 of its height across) [design]
const ALT_MIN_M = 30_000, ALT_MAX_M = 8_000_000;
// the cursor's square takes a click once it is this many screen px across [design: a target a hand hits]
const CLICK_PX = 14;
// the relief's exaggeration for the light: the island's 1.5 (main.js EXAG) and two thirds more, since a 12 km cell's slopes are
// the island's smoothed [design]
const RELIEF = 2.5;
// an art pixel in CSS px (?art= tries others) [design: the ladder shows an art pixel at 2 to 4 screen px]
const ART_CSS = 2;
// the rivers drawn: those carrying at least this much at the view's height, m3/s [design: the big ones from afar]
const riverCut = (altM) => Math.min(3000, Math.max(20, (altM / 2_000_000) * 600));

// From the game screen back to the globe: the same page without the place.
export function toGlobe() {
  const q = new URLSearchParams(location.search);
  q.delete("at");
  q.set("globe", "");
  location.href = `${location.pathname}?${q}`;
}

const inflate = async (res) => new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

export async function runGlobe({ seed, hint }) {
  const G = await import("../globe.js");
  const manifest = await fetch(new URL(`../planets/${seed}.json`, import.meta.url));
  if (!manifest.ok) throw new Error(`no planet is baked for seed ${seed}: bun scripts/globe-bake.ts --seed ${seed}, then build the site`);
  const { view: viewName } = await manifest.json();
  const res = await fetch(new URL(`../planets/${viewName}`, import.meta.url));
  if (!res.ok) throw new Error(`the planet's view did not load (${res.status})`);
  const V = G.viewFromBytes(await inflate(res)), g = G.tierGrid(0), FN = g.fn, R = G.RADIUS_M;
  const tLoaded = performance.now();

  // ---------- the face textures, each face with an apron of its neighbours' cells ----------
  const SIDE = FN + 2 * APRON, T = SIDE * SIDE;
  const hTex = new Float32Array(6 * T), cTex = new Uint8Array(6 * T * 4);
  for (let f = 0; f < 6; f++)
    for (let j = 0; j < SIDE; j++)
      for (let i = 0; i < SIDE; i++) {
        const X = i - APRON, Y = j - APRON;
        let id;
        if (X >= 0 && X < FN && Y >= 0 && Y < FN) id = G.cellId(g, f, X, Y);
        else {
          const a = ((X + 0.5) / FN - 0.5) * (Math.PI / 2), b = ((Y + 0.5) / FN - 0.5) * (Math.PI / 2), q = G.locateVec(g, G.pointOf(f, Math.tan(a), Math.tan(b)));
          id = G.cellId(g, q.face, q.X, q.Y);
        }
        const o = f * T + j * SIDE + i;
        hTex[o] = V.height[id];
        // climTexel: the air in half degrees from -64 C, the rain as 16 log2(1 + mm), the ice as 4 sqrt(m), the rock's class
        cTex[4 * o] = V.temp[id] + 128;
        cTex[4 * o + 1] = Math.min(255, Math.round(16 * Math.log2(1 + V.rain[id])));
        cTex[4 * o + 2] = Math.min(255, Math.round(4 * Math.sqrt(V.ice[id])));
        cTex[4 * o + 3] = V.rock[id];
      }
  // the rivers' segments, cell centre to receiver's centre (cut where the height crosses the sea), and each one's flow
  const nSeg = V.segments.length / 2, segP = new Float32Array(nSeg * 6), segQ = new Float32Array(nSeg);
  const centreOf = (id) => { const f = Math.floor(id / (FN * FN)), r = id % (FN * FN); return G.centre(g, f, r % FN, Math.floor(r / FN)); };
  for (let k = 0; k < nSeg; k++) {
    const from = V.segments[2 * k], to = V.segments[2 * k + 1], a = centreOf(from), b = centreOf(to), hf = V.height[from], ht = V.height[to];
    const t = ht < 0 && hf > 0 ? hf / (hf - ht) : 1;
    segP.set(a, 6 * k); segP.set([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t), 6 * k + 3);
    segQ[k] = 2 ** (V.river[from] / 16) - 1;
  }
  const cellAt = (p) => { const q = G.locateVec(g, p); return G.cellId(g, q.face, q.X, q.Y); };

  // ---------- WebGPU ----------
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("this browser found no WebGPU adapter");
  const device = await adapter.requestDevice();
  device.addEventListener?.("uncapturederror", (e) => { document.body.dataset.error = `gpu: ${e.error.message}`; });
  const gpuCanvas = document.createElement("canvas"), riv = document.createElement("canvas"), over = document.createElement("canvas");
  for (const c of [gpuCanvas, riv, over]) Object.assign(c.style, { position: "fixed", left: "0", top: "0" });
  for (const c of [gpuCanvas, over]) Object.assign(c.style, { width: "100vw", height: "100vh" });
  Object.assign(riv.style, { imageRendering: "pixelated", pointerEvents: "none" });
  over.style.cursor = "grab"; over.style.touchAction = "none";
  over.setAttribute("aria-label", "The planet: drag to turn it, scroll or pinch to zoom, click land to play there once the square shows");
  document.body.append(gpuCanvas, riv, over);
  const c2 = over.getContext("2d"), rc = riv.getContext("2d");
  const ctx = gpuCanvas.getContext("webgpu"), format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  const tex = (fmt, data, bpt) => {
    const t = device.createTexture({ size: [SIDE, SIDE, 6], format: fmt, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: t }, data, { bytesPerRow: SIDE * bpt, rowsPerImage: SIDE }, [SIDE, SIDE, 6]);
    return t;
  };
  const pal = await import("../isopixel/pal.js"), { dqBuild } = await import("../isopixel/ground.wgsl.js");
  const { globeWgsl } = await import("../isopixel/wgsl/globe.js");
  const { P, RGB, NCOL, HAZE, SHADOW, TONE, TONE_S } = pal;
  const module = device.createShaderModule({ code: globeWgsl({ FRAMES: G.FRAMES, FN, APRON, P, RGB, NCOL, TONE_S }) });
  const pipeline = await device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } });
  const ubuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const store = (data) => {
    const b = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  // HAZE and SHADOW, then TONE's rows, one palette index a word (isopixel/wgsl/globe.js T_SHADOW, T_TONE)
  const tables = new Uint32Array(NCOL * (2 + TONE_S.length));
  tables.set(HAZE, 0); tables.set(SHADOW, NCOL); tables.set(TONE, 2 * NCOL);
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: ubuf } },
      { binding: 1, resource: tex("r32float", hTex, 4).createView({ dimension: "2d-array" }) },
      { binding: 2, resource: tex("rgba8unorm", cTex, 4).createView({ dimension: "2d-array" }) },
      { binding: 3, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) },
      { binding: 4, resource: { buffer: store(tables) } },
      { binding: 5, resource: { buffer: store(dqBuild()) } },
    ],
  });

  // ---------- the camera: straight down on a point, north up ----------
  const Q = new URLSearchParams(location.search), kept = JSON.parse(sessionStorage.getItem(KEPT.cam) ?? "null");
  const first = V.meta.landings[0] ?? { latDeg: 0, lonDeg: 0 };
  const qn = (k, d) => (Q.get(k) != null && Number.isFinite(Number(Q.get(k))) ? Number(Q.get(k)) : d);
  const cam = { lat: qn("lat", kept?.lat ?? first.latDeg), lon: qn("lon", kept?.lon ?? first.lonDeg), alt: qn("alt", kept?.alt ?? 2.4 * R) };
  const last = JSON.parse(sessionStorage.getItem(KEPT.last) ?? "null");
  const tanH = Math.tan((FOV_DEG / 2) * DEG);
  let B = null, W = 0, H = 0, dirty = true, mouse = null;
  function basis() {
    cam.lat = Math.max(-88, Math.min(88, cam.lat)); cam.lon = ((((cam.lon + 180) % 360) + 360) % 360) - 180;
    cam.alt = Math.max(ALT_MIN_M, Math.min(ALT_MAX_M, cam.alt));
    const d = G.fromLatLon(cam.lat * DEG, cam.lon * DEG), [e, n] = G.eastNorth(d), a = cam.alt / R;
    B = { d, e, n, a, o: [d[0] * (1 + a), d[1] * (1 + a), d[2] * (1 + a)], fwd: [-d[0], -d[1], -d[2]], sun: unit([0.75 * d[0] + 0.5 * n[0] - 0.45 * e[0], 0.75 * d[1] + 0.5 * n[1] - 0.45 * e[1], 0.75 * d[2] + 0.5 * n[2] - 0.45 * e[2]]) };
  }
  // a point (unit sphere scale) on the screen, or null behind the camera
  function project(P) {
    const v = [P[0] - B.o[0], P[1] - B.o[1], P[2] - B.o[2]], z = dot(v, B.fwd);
    if (z <= 1e-12) return null;
    return [((dot(v, B.e) / (z * tanH * (W / H)) + 1) / 2) * W, ((1 - dot(v, B.n) / (z * tanH)) / 2) * H];
  }
  const seen = (p) => dot(p, B.o) >= 1;
  // the sphere's point under a screen point, or null off the planet
  function pick(x, y) {
    const nx = (x / W) * 2 - 1, ny = 1 - (y / H) * 2;
    const rd = unit([0, 1, 2].map((k) => B.fwd[k] + nx * tanH * (W / H) * B.e[k] + ny * tanH * B.n[k]));
    const b = dot(B.o, rd), disc = b * b - B.a * (2 + B.a);
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t < 0 ? null : unit([0, 1, 2].map((k) => B.o[k] + t * rd[k]));
  }
  const latLonOf = (p) => { const l = G.latLon(p); return { lat: l.lat / DEG, lon: l.lon / DEG }; };
  // the game's square centred at a place: its corners on the sphere (the window's gnomonic plane, window.ts frameAt)
  function square(lat, lon) {
    const f = G.frameAt(lat, lon), h = G.WINDOW_M / 2;
    const at = (x, y) => unit([0, 1, 2].map((k) => f.c[k] + (x * f.e[k] + y * f.n[k]) / R));
    return { f, at, corners: [at(-h, h), at(h, h), at(h, -h), at(-h, -h)] };
  }
  // what the cursor stands on, and whether a click there lands: the square big enough to aim, off the poles, and some of
  // its ground above the sea (land or coast), read on the planet's cells over a grid of 7 by 7 points of the square
  function aim(x, y) {
    const p = pick(x, y);
    if (!p) return null;
    const { lat, lon } = latLonOf(p), cell = cellAt(p), sq = square(lat, lon), px = sq.corners.map(project);
    const sidePx = px.every(Boolean) ? Math.hypot(px[1][0] - px[0][0], px[1][1] - px[0][1]) : 0;
    let land = 0;
    for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) if (V.height[cellAt(sq.at(((i - 3) / 3) * (G.WINDOW_M / 2), ((j - 3) / 3) * (G.WINDOW_M / 2)))] > 0) land++;
    const why = Math.abs(lat) > 85 ? "too near the pole" : sidePx < CLICK_PX ? "zoom in to choose a place" : land === 0 ? "open sea: choose land or coast" : null;
    return { p, lat, lon, cell, sq, px, sidePx, land, ok: !why, why };
  }

  // ---------- drawing ----------
  // the planet is drawn on a canvas of device pixels, an art pixel being whole ones; the rivers on a canvas of art pixels
  const dpr = window.devicePixelRatio || 1, artCss = qn("art", ART_CSS), ART = Math.max(1, Math.round(artCss * dpr));
  let rw = 0, rh = 0, rimg = null, rpx = null;
  function fit() {
    W = window.innerWidth; H = window.innerHeight;
    gpuCanvas.width = Math.floor(W * dpr); gpuCanvas.height = Math.floor(H * dpr);
    over.width = W; over.height = H;
    rw = Math.ceil(gpuCanvas.width / ART); rh = Math.ceil(gpuCanvas.height / ART);
    riv.width = rw; riv.height = rh;
    riv.style.width = `${(rw * ART) / dpr}px`; riv.style.height = `${(rh * ART) / dpr}px`;
    rimg = rc.createImageData(rw, rh); rpx = new Uint32Array(rimg.data.buffer);
    dirty = true;
  }
  fit();
  window.addEventListener("resize", fit);
  const u = new Float32Array(24);
  function drawGlobe() {
    u.set([...B.o, B.a, ...B.fwd, tanH, ...B.e, W / H, ...B.n, RELIEF, ...B.sun, R, gpuCanvas.width, gpuCanvas.height, ART, 0]);
    device.queue.writeBuffer(ubuf, 0, u);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    device.queue.submit([enc.finish()]);
  }
  // a straight run of art pixels t wide from a to b (pixel coordinates), Bresenham's, as the palette's colour
  function artLine(ax, ay, bx, by, t, colour) {
    let x = Math.floor(ax), y = Math.floor(ay);
    const x1 = Math.floor(bx), y1 = Math.floor(by), dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1, o = -(t >> 1);
    let err = dx + dy;
    for (let n = 0; n < 4096; n++) {
      for (let j = 0; j < t; j++) for (let i = 0; i < t; i++) { const px = x + o + i, py = y + o + j; if (px >= 0 && px < rw && py >= 0 && py < rh) rpx[py * rw + px] = colour; }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }
  // the rivers on the island's water ramp, 1 to 3 art pixels wide, the wider the more they carry
  const RIVER_RGBA = [P.w5, P.w4, P.w3].map((i) => 0xff000000 | (RGB[i][2] << 16) | (RGB[i][1] << 8) | RGB[i][0]);
  function drawRivers() {
    rpx.fill(0);
    const cut = riverCut(cam.alt), k = dpr / ART;
    for (let s = 0; s < nSeg; s++) {
      if (segQ[s] < cut) continue;
      const a = segP.subarray(6 * s, 6 * s + 3), b = segP.subarray(6 * s + 3, 6 * s + 6);
      if (!seen(a) || !seen(b)) continue;
      const pa = project(a), pb = project(b);
      if (!pa || !pb || (Math.max(pa[0], pb[0]) < 0 || Math.min(pa[0], pb[0]) > W || Math.max(pa[1], pb[1]) < 0 || Math.min(pa[1], pb[1]) > H)) continue;
      const w = Math.min(2, Math.floor(Math.log2(segQ[s] / cut) / 2));
      artLine(pa[0] * k, pa[1] * k, pb[0] * k, pb[1] * k, w + 1, RIVER_RGBA[w]);
    }
    rc.putImageData(rimg, 0, 0);
  }
  const fmt = (v, d = 0) => v.toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: d });
  const place = (lat, lon) => `${fmt(Math.abs(lat), 2)} ${lat >= 0 ? "N" : "S"}, ${fmt(Math.abs(lon), 2)} ${lon >= 0 ? "E" : "W"}`;
  const readout = document.createElement("div");
  Object.assign(readout.style, { position: "fixed", left: "12px", top: "12px", padding: "5px 9px", background: "rgba(13, 11, 20, 0.72)", borderRadius: "3px", font: "12px/1.45 ui-monospace, Menlo, Consolas, monospace", color: "#eef2f6", whiteSpace: "pre", pointerEvents: "none" });
  document.body.append(readout);
  function polyline(pts, close) {
    c2.beginPath();
    pts.forEach((q, k) => (k ? c2.lineTo(q[0], q[1]) : c2.moveTo(q[0], q[1])));
    if (close) c2.closePath();
  }
  function drawOver() {
    c2.clearRect(0, 0, W, H);
    drawRivers();
    // the planet's ranked landings (window.ts landingsOf)
    for (const l of V.meta.landings) {
      const p = G.fromLatLon(l.latDeg * DEG, l.lonDeg * DEG);
      if (!seen(p)) continue;
      const s = project(p);
      c2.beginPath(); c2.arc(s[0], s[1], 3.5, 0, 2 * Math.PI);
      c2.fillStyle = "#f4d35e"; c2.fill(); c2.lineWidth = 1.2; c2.strokeStyle = "#0d0b14"; c2.stroke();
    }
    const box = (corners, color) => {
      const px = corners.map((p) => (seen(p) ? project(p) : null));
      if (!px.every(Boolean)) return;
      polyline(px, true);
      c2.lineWidth = 3.5; c2.strokeStyle = "rgba(13, 11, 20, 0.8)"; c2.stroke();
      c2.lineWidth = 1.6; c2.strokeStyle = color; c2.stroke();
    };
    if (last) box(square(last.lat, last.lon).corners, "#f29e4c");
    const lines = [`planet ${seed} \u00b7 view from ${fmt(cam.alt / 1000)} km`];
    if (mouse?.aim) {
      const A = mouse.aim, i = A.cell, h = V.height[i];
      box(A.sq.corners, A.ok ? "#ffffff" : "rgba(255, 255, 255, 0.6)");
      if (A.sidePx < CLICK_PX) {
        // too small to aim at: a ring round it shows where it is
        c2.beginPath(); c2.arc(mouse.x, mouse.y, CLICK_PX, 0, 2 * Math.PI); c2.setLineDash([3, 3]);
        c2.lineWidth = 1.2; c2.strokeStyle = "rgba(255, 255, 255, 0.7)"; c2.stroke(); c2.setLineDash([]);
      }
      lines.push(
        place(A.lat, A.lon),
        h > 0 ? `ground ${fmt(h)} m \u00b7 ${V.meta.rocks[V.rock[i]] ?? "rock"}` : `sea ${fmt(-h)} m deep`,
        `air ${fmt(V.temp[i] / 2, 1)} C a year \u00b7 rain ${fmt(V.rain[i])} mm${V.ice[i] > 0 ? ` \u00b7 ice ${fmt(V.ice[i])} m` : ""}`,
        A.ok ? "click to play on this square (19.2 km)" : A.why,
      );
    }
    readout.textContent = lines.join("\n");
  }
  let firstFrame = true;
  function loop() {
    if (dirty) {
      dirty = false;
      basis();
      if (mouse) mouse.aim = aim(mouse.x, mouse.y);
      drawGlobe(); drawOver();
      over.style.cursor = drag ? "grabbing" : mouse?.aim?.ok ? "crosshair" : "grab";
      if (firstFrame) {
        firstFrame = false;
        device.queue.onSubmittedWorkDone().then(() => {
          document.body.dataset.globeMs = String(Math.round(performance.now()));
          document.body.dataset.globeDataMs = String(Math.round(tLoaded));
          document.body.classList.add("ready");
        });
      }
    }
    requestAnimationFrame(loop);
  }

  // ---------- input: drag turns, wheel and pinch zoom toward the cursor, a click lands ----------
  const ptrs = new Map();
  let drag = null, pinch = 0;
  const radPerPx = () => (2 * tanH * cam.alt) / (H * R);
  function zoomAt(k, x, y) {
    const before = cam.alt, p = x == null ? null : pick(x, y);
    cam.alt = Math.max(ALT_MIN_M, Math.min(ALT_MAX_M, cam.alt * k));
    if (p && cam.alt < before) {
      // toward the point under the cursor, by the share of the height lost
      const s = 1 - cam.alt / before, d = B.d, ang = Math.acos(Math.max(-1, Math.min(1, dot(d, p))));
      if (ang > 1e-9) {
        const a = Math.sin((1 - s) * ang) / Math.sin(ang), b = Math.sin(s * ang) / Math.sin(ang), q = latLonOf(unit([0, 1, 2].map((i) => a * d[i] + b * p[i])));
        cam.lat = q.lat; cam.lon = q.lon;
      }
    }
    dirty = true;
  }
  function land(lat, lon) {
    sessionStorage.setItem(KEPT.cam, JSON.stringify({ lat: cam.lat, lon: cam.lon, alt: cam.alt }));
    sessionStorage.setItem(KEPT.last, JSON.stringify({ lat, lon }));
    sessionStorage.setItem(KEPT.clickedAt, String(Date.now()));
    const q = new URLSearchParams(location.search);
    q.delete("globe"); q.delete("lat"); q.delete("lon"); q.delete("alt");
    q.set("seed", String(seed)); q.set("at", `${lat.toFixed(5)},${lon.toFixed(5)}`);
    location.href = `${location.pathname}?${q}`;
  }
  over.addEventListener("pointerdown", (e) => {
    over.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: 0 };
    else { drag = null; const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
    dirty = true;
  });
  over.addEventListener("pointermove", (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2 && pinch > 0) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d > 0) zoomAt(pinch / d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pinch = d;
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y, r = radPerPx();
      drag.x = e.clientX; drag.y = e.clientY; drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0));
      cam.lat += (dy * r) / DEG;
      cam.lon -= (dx * r) / DEG / Math.max(0.05, Math.cos(cam.lat * DEG));
    }
    dirty = true;
  });
  const up = (e) => {
    const wasDrag = drag;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = 0;
    drag = null;
    if (wasDrag && wasDrag.moved < 5 && e.type === "pointerup") {
      basis();
      const A = aim(e.clientX, e.clientY);
      if (A?.ok) land(A.lat, A.lon);
    }
    dirty = true;
  };
  over.addEventListener("pointerup", up);
  over.addEventListener("pointercancel", up);
  over.addEventListener("pointerleave", () => { if (!drag) { mouse = null; dirty = true; } });
  over.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX, e.clientY); }, { passive: false });
  window.addEventListener("keydown", (e) => {
    const r = radPerPx() * 60;
    if (e.key === "+" || e.key === "=") zoomAt(0.7);
    else if (e.key === "-") zoomAt(1 / 0.7);
    else if (e.key === "ArrowUp") cam.lat += r / DEG;
    else if (e.key === "ArrowDown") cam.lat -= r / DEG;
    else if (e.key === "ArrowLeft") cam.lon -= r / DEG / Math.cos(cam.lat * DEG);
    else if (e.key === "ArrowRight") cam.lon += r / DEG / Math.cos(cam.lat * DEG);
    else return;
    dirty = true;
  });
  window.addEventListener("pagehide", () => sessionStorage.setItem(KEPT.cam, JSON.stringify({ lat: cam.lat, lon: cam.lon, alt: cam.alt })));
  if (hint) {
    hint.textContent = "drag to turn the planet \u00b7 scroll or pinch to zoom \u00b7 near enough, the square is the game's ground: click land or coast to play there \u00b7 yellow dots are the planet's best landings, orange your last";
    setTimeout(() => hint.classList.add("gone"), 12000);
  }
  requestAnimationFrame(loop);
  // for checks: where the camera is, a place on the screen, and what a point would aim at
  globalThis.globe = {
    cam, meta: V.meta, set: (c) => { Object.assign(cam, c); dirty = true; },
    screenOf: (lat, lon) => { basis(); return project(G.fromLatLon(lat * DEG, lon * DEG)); },
    aimAt: (x, y) => { basis(); const A = aim(x, y); return A && { lat: A.lat, lon: A.lon, sidePx: A.sidePx, land: A.land, ok: A.ok, why: A.why }; },
    land,
  };
}
