// The object store's allocation kernels in WGSL (store.ts drives them; layouts are described there). Every kind keeps
// two buffers: its body, the slot words (bit 0 alive, bits 1 to 31 the generation) followed by one run of `cap` words
// for each field, and its alloc, sixteen control words (CTL_*) followed by the free list. Capacities come in through
// the parameters, so one pipeline serves every kind with the same fields.

// Control words at the head of a kind's alloc buffer.
export const CTL = { head: 0, nfree: 1, tail: 2, overflow: 3 } as const;
export const CTL_WORDS = 16;

export type Layout = { fields: readonly { name: string; type: "u32" | "i32" }[] };

// WGSL accessors for a kind's body bound as `buf`, its capacity read from the expression `cap`: <p>_alive(i),
// <p>_gen(i), <p>_<field>(i), and when writable <p>_set_<field>(i, v) and <p>_kill(i).
export function access(p: string, buf: string, cap: string, k: Layout, write: boolean): string {
  const lines = [
    `fn ${p}_alive(i: u32) -> bool { return (${buf}[i] & 1u) == 1u; }`,
    `fn ${p}_gen(i: u32) -> u32 { return ${buf}[i] >> 1u; }`,
  ];
  k.fields.forEach((f, n) => {
    const at = `(${n + 1}u * ${cap} + i)`;
    lines.push(f.type === "i32"
      ? `fn ${p}_${f.name}(i: u32) -> i32 { return bitcast<i32>(${buf}[${at}]); }`
      : `fn ${p}_${f.name}(i: u32) -> u32 { return ${buf}[${at}]; }`);
    if (write) lines.push(`fn ${p}_set_${f.name}(i: u32, v: ${f.type}) { ${buf}[${at}] = ${f.type === "i32" ? "bitcast<u32>(v)" : "v"}; }`);
  });
  if (write) lines.push(`fn ${p}_kill(i: u32) { ${buf}[i] = ${buf}[i] & ~1u; }`);
  return lines.join("\n");
}

const INDEX = /* wgsl */ `
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;

// Births, step one: each parent's child count, kept only for live parents below the tail, into m (to be scanned into
// offsets) and into kept (kept as it is). Step two reads its parents' counts from kept, never from the parents' slot
// words: when a kind breeds into itself those are the words step two writes, and a dead parent's slot reborn as a
// child by another invocation would read back alive. Bindings: parent body, parent alloc, counts, m, kept, P (n:
// parent capacity).
export const BIRTH_MASK = /* wgsl */ `
struct Params { n: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> pb: array<u32>;
@group(0) @binding(1) var<storage, read> pa: array<u32>;
@group(0) @binding(2) var<storage, read> cnt: array<u32>;
@group(0) @binding(3) var<storage, read_write> m: array<u32>;
@group(0) @binding(4) var<storage, read_write> kept: array<u32>;
@group(0) @binding(5) var<uniform> P: Params;
${INDEX}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let p = flat(g, n);
  if (p >= P.n) { return; }
  var c = 0u;
  if (p < pa[${CTL.tail}u] && (pb[p] & 1u) == 1u) { c = cnt[p]; }
  m[p] = c;
  kept[p] = c;
}`;

// Births, step two: each parent with children in kept gives them the slots their places in the scan (parent-id
// order) name, from the free list (recycled in index order) and then the tail; a child's slot gets the next
// generation, alive, its fields zeroed, and then the kind's own initialization runs with the parent and the slot.
// Children past the capacity are not born (the commit counts them). A parent is alive and a child's slot was not, so
// no invocation writes a word another reads as a parent's. Bindings with distinct kinds: parent body (bound whether
// or not the initialization reads it), child body, child alloc, kept, offsets, extras, P; with one kind or no parent
// kind (parent then the row number of kept): body, alloc, kept, offsets, extras, P. P: n parent capacity (or rows), t
// tick, pcap, ccap.
export function birthAssign(parent: Layout | null, child: Layout, same: boolean, init: string, extra?: Extra): string {
  const own = same || !parent
    ? `@group(0) @binding(0) var<storage, read_write> cb: array<u32>;
@group(0) @binding(1) var<storage, read_write> ca: array<u32>;
@group(0) @binding(2) var<storage, read> kept: array<u32>;
@group(0) @binding(3) var<storage, read> ofs: array<u32>;`
    : `@group(0) @binding(0) var<storage, read> pb: array<u32>;
@group(0) @binding(1) var<storage, read_write> cb: array<u32>;
@group(0) @binding(2) var<storage, read_write> ca: array<u32>;
@group(0) @binding(3) var<storage, read> kept: array<u32>;
@group(0) @binding(4) var<storage, read> ofs: array<u32>;`;
  const first = same || !parent ? 4 : 5, more = extra?.bufs ?? [];
  const head = [own, ...more.map((b, i) => `@group(0) @binding(${first + i}) var<storage, ${b.write ? "read_write" : "read"}> ${b.name}: array<u32>;`),
    `@group(0) @binding(${first + more.length}) var<uniform> P: Params;`].join("\n");
  return /* wgsl */ `
struct Params { n: u32, t: u32, pcap: u32, ccap: u32 }
${head}
${parent ? access("parent", same ? "cb" : "pb", "P.pcap", parent, false) : ""}
${access("child", "cb", "P.ccap", child, true)}
${INDEX}
${extra?.wgsl ?? ""}
fn born(slot: u32, parent: u32, k: u32, j: u32, tick: u32) {
${init}
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let p = flat(g, n);
  if (p >= P.n) { return; }
  ${same || !parent ? "" : "_ = &pb;"}
  ${more.map((b) => `_ = &${b.name};`).join(" ")}
  let c = kept[p];
  if (c == 0u) { return; }
  let head = ca[${CTL.head}u];
  let avail = ca[${CTL.nfree}u] - head;
  let tail = ca[${CTL.tail}u];
  for (var k = 0u; k < c; k++) {
    let j = ofs[p] + k;
    var slot = 0u;
    if (j < avail) { slot = ca[${CTL_WORDS}u + head + j]; } else {
      let e = j - avail;
      if (e >= P.ccap - tail) { continue; }
      slot = tail + e;
    }
    var gen = ((cb[slot] >> 1u) + 1u) & 0x7fffffffu;
    if (gen == 0u) { gen = 1u; }
    cb[slot] = (gen << 1u) | 1u;
    for (var f = 1u; f <= ${child.fields.length}u; f++) { cb[f * P.ccap + slot] = 0u; }
    born(slot, p, k, j, P.t);
  }
}`;
}
// More storage buffers a births initialization reads (or writes), bound after the births' own as array<u32> under
// the names given, and WGSL helpers placed ahead of the initialization.
export type Extra = { bufs: { name: string; buf: GPUBuffer; write?: boolean }[]; wgsl: string };

// Births, step three, one invocation: the free list's head and the tail move past the slots given; children the
// capacity had no room for are counted in the overflow word. Bindings: child alloc, the scan's total, P (ccap).
export const BIRTH_COMMIT = /* wgsl */ `
struct Params { ccap: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> ca: array<u32>;
@group(0) @binding(1) var<storage, read> tot: array<u32>;
@group(0) @binding(2) var<uniform> P: Params;
@compute @workgroup_size(1) fn main() {
  let total = tot[0];
  let head = ca[${CTL.head}u];
  let used = min(total, ca[${CTL.nfree}u] - head);
  ca[${CTL.head}u] = head + used;
  let extra = total - used;
  let tail = ca[${CTL.tail}u];
  let put = min(extra, P.ccap - tail);
  ca[${CTL.tail}u] = tail + put;
  ca[${CTL.overflow}u] = ca[${CTL.overflow}u] + (extra - put);
}`;

// Reclaim, step one: a 1 for every dead slot below the tail. Bindings: body, alloc, flags, P (cap).
export const RECLAIM_FLAG = /* wgsl */ `
struct Params { cap: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read_write> f: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${INDEX}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap) { return; }
  f[i] = select(0u, 1u, i < a[${CTL.tail}u] && (b[i] & 1u) == 0u);
}`;

// Reclaim, step two: every dead slot below the tail goes to its place in the scan, so the free list runs in index
// order. Bindings: body, alloc, scanned flags, P (cap).
export const RECLAIM_SCATTER = /* wgsl */ `
struct Params { cap: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read_write> a: array<u32>;
@group(0) @binding(2) var<storage, read> f: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${INDEX}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap) { return; }
  if (i < a[${CTL.tail}u] && (b[i] & 1u) == 0u) { a[${CTL_WORDS}u + f[i]] = i; }
}`;

// Reclaim, step three, one invocation: the free list starts over at its head. Bindings: alloc, the scan's total.
export const RECLAIM_CTL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> a: array<u32>;
@group(0) @binding(1) var<storage, read> tot: array<u32>;
@compute @workgroup_size(1) fn main() {
  a[${CTL.head}u] = 0u;
  a[${CTL.nfree}u] = tot[0];
}`;

// Delta records, four words each from word P.base: slot, generation, op << 16 | field, value; sorted by slot and then
// by the order the CPU queued them, so one invocation for each slot applies its records in that order whatever order they came in. SET
// and KILL apply only to a live slot whose generation matches the record's low 17 bits (a stale reference does
// nothing); BORN brings a dead slot to life at the record's full generation with every field zero.
export const OP = { set: 0, kill: 1, born: 2 } as const;
export const DELTA_APPLY = /* wgsl */ `
struct Params { n: u32, cap: u32, nf: u32, base: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> d: array<u32>;
@group(0) @binding(2) var<uniform> P: Params;
${INDEX}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let r = flat(g, n);
  if (r >= P.n) { return; }
  let s = d[P.base + 4u * r];
  if (r > 0u && d[P.base + 4u * (r - 1u)] == s) { return; }
  for (var j = r; j < P.n && d[P.base + 4u * j] == s; j++) {
    let gen = d[P.base + 4u * j + 1u];
    let op = d[P.base + 4u * j + 2u] >> 16u;
    let f = d[P.base + 4u * j + 2u] & 0xffffu;
    let m = b[s];
    let live = (m & 1u) == 1u && ((m >> 1u) & 0x1ffffu) == (gen & 0x1ffffu);
    if (op == ${OP.set}u && live && f < P.nf) { b[(f + 1u) * P.cap + s] = d[P.base + 4u * j + 3u]; }
    if (op == ${OP.kill}u && live) { b[s] = m & ~1u; }
    if (op == ${OP.born}u && (m & 1u) == 0u) {
      b[s] = (gen << 1u) | 1u;
      for (var k = 1u; k <= P.nf; k++) { b[k * P.cap + s] = 0u; }
    }
  }
}`;

// The allocation state the CPU needs to place its own spawns: the control words, then the next K slots of the free
// list (0xffffffff past its end) and their slot words. Bindings: body, alloc, out, P (base word in out, K).
export const PEEK = /* wgsl */ `
struct Params { base: u32, k: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${INDEX}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let q = flat(g, n);
  if (q < ${CTL_WORDS}u) { out[P.base + q] = a[q]; return; }
  let j = q - ${CTL_WORDS}u;
  if (j >= P.k) { return; }
  let head = a[${CTL.head}u];
  var slot = 0xffffffffu;
  var word = 0u;
  if (j < a[${CTL.nfree}u] - head) { slot = a[${CTL_WORDS}u + head + j]; word = b[slot]; }
  out[P.base + ${CTL_WORDS}u + j] = slot;
  out[P.base + ${CTL_WORDS}u + P.k + j] = word;
}`;
