// What grew on the planet's window, held within a budget. A tile's scatter holds up to 17.7 million objects (300 MB as arrays) and a window takes
// the quarter of up to four of them, so each tile is cut to the window's cells the moment it is made and its arrays let go; the cut objects are kept as
// exact-size arrays (20 bytes each) and, past `cap` in all, thinned by halves: an object is kept at share s (1, 1/2, 1/4...) when its own seed's hash is under
// s, so a thinning only ever drops objects (the ones kept at a half are kept at a whole), and two windows over the same ground thin by the same rule
// [gap: a place in a window that is thinned further than the next one's differs by the share's step between them]. No import: the page and a CPU
// test both load it.

// a seed's place in [0, 1): the murmur finaliser's mix of it
export function unitHash(seed) {
  let h = seed >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// N cells of CELL metres a side; cap the most objects kept
export function collector({ N, CELL, cap }) {
  const parts = [];
  let share = 1, kept = 0;
  const keeps = (seed) => share >= 1 || unitHash(seed) < share;
  // a scatter (n objects: kind, species, size, seed; place(q, out) puts the window's x and y in cells of object q in out) cut to the window,
  // as exact-size arrays; place returns false for an object outside it
  function add(sc, place) {
    const out = [0, 0];
    let m = 0;
    for (let q = 0; q < sc.n; q++) if (place(q, out) && out[0] >= 0 && out[0] < N && out[1] >= 0 && out[1] < N && keeps(sc.seed[q])) m++;
    const p = { n: m, mx: new Uint32Array(m), mz: new Uint32Array(m), what: new Uint32Array(m), size: new Float32Array(m), seed: new Uint32Array(m) };
    m = 0;
    for (let q = 0; q < sc.n; q++) {
      if (!place(q, out) || out[0] < 0 || out[0] >= N || out[1] < 0 || out[1] >= N || !keeps(sc.seed[q])) continue;
      p.mx[m] = Math.round(out[0] * CELL * 1000); p.mz[m] = Math.round(out[1] * CELL * 1000);
      p.what[m] = sc.kind[q] + 256 * sc.species[q]; p.size[m] = sc.size[q]; p.seed[m] = sc.seed[q];
      m++;
    }
    parts.push(p);
    kept += p.n;
    while (kept > cap) thin();
  }
  // the share halved: every part keeps only what its seeds keep at it
  function thin() {
    share /= 2;
    kept = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      let m = 0;
      for (let q = 0; q < p.n; q++) if (unitHash(p.seed[q]) < share) m++;
      const o = { n: m, mx: new Uint32Array(m), mz: new Uint32Array(m), what: new Uint32Array(m), size: new Float32Array(m), seed: new Uint32Array(m) };
      m = 0;
      for (let q = 0; q < p.n; q++) {
        if (unitHash(p.seed[q]) >= share) continue;
        o.mx[m] = p.mx[q]; o.mz[m] = p.mz[q]; o.what[m] = p.what[q]; o.size[m] = p.size[q]; o.seed[m] = p.seed[q];
        m++;
      }
      parts[i] = o;
      kept += m;
    }
  }
  // The objects as a source's body (worker.js statics: the slot words, then x, y, what, size, seed, pick, each of `capOf(kept)` slots), in runs by the
  // 75 m cell of their place, and the first slot of every cell's run; the collector lets go of its parts.
  function lay(capOf) {
    const cells = N * N, start = new Uint32Array(cells + 1), cellOf = (x, z) => Math.min(N - 1, Math.floor(z / (CELL * 1000))) * N + Math.min(N - 1, Math.floor(x / (CELL * 1000)));
    for (const p of parts) for (let q = 0; q < p.n; q++) start[cellOf(p.mx[q], p.mz[q]) + 1]++;
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const slots = capOf(kept), body = new Uint32Array(7 * slots), B = new Float32Array(body.buffer), cur = start.slice(0, cells);
    body.fill(1, 0, kept);
    for (const p of parts)
      for (let q = 0; q < p.n; q++) {
        const s = cur[cellOf(p.mx[q], p.mz[q])]++;
        body[slots + s] = p.mx[q]; body[2 * slots + s] = p.mz[q]; body[3 * slots + s] = p.what[q];
        B[4 * slots + s] = p.size[q]; body[5 * slots + s] = p.seed[q];
      }
    parts.length = 0;
    return { n: kept, cap: slots, share, body, start };
  }
  return { add, lay, get kept() { return kept; }, get share() { return share; } };
}
