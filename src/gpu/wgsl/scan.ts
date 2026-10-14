// An exclusive prefix sum of u32 words in place, over any length, on the GPU (store.ts drives it). Each workgroup of
// 256 invocations sums a block of 1,024 words, four consecutive words to an invocation, writes the block's offsets in
// place and its total to sums[block]; the block totals are scanned the same way, a level up, and added back. Integer
// addition in a fixed tree, so the same words come out on every GPU and every run. Bindings: 0 the words, 1 the block
// totals, 2 the parameters (n, the number of words).
export const SCAN = /* wgsl */ `
struct P { n: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> v: array<u32>;
@group(0) @binding(1) var<storage, read_write> sums: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
var<workgroup> t: array<u32, 256>;

@compute @workgroup_size(256) fn blocks(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) l: u32) {
  let wg = wid.x + wid.y * nwg.x;
  if (wg * 1024u >= max(p.n, 1u)) { return; }
  let base = wg * 1024u + l * 4u;
  var x: array<u32, 4>;
  var s = 0u;
  for (var k = 0u; k < 4u; k++) {
    let i = base + k;
    var y = 0u;
    if (i < p.n) { y = v[i]; }
    x[k] = s;
    s += y;
  }
  t[l] = s;
  workgroupBarrier();
  for (var d = 1u; d < 256u; d <<= 1u) {
    var u = 0u;
    if (l >= d) { u = t[l - d]; }
    workgroupBarrier();
    t[l] += u;
    workgroupBarrier();
  }
  let before = t[l] - s;
  for (var k = 0u; k < 4u; k++) {
    let i = base + k;
    if (i < p.n) { v[i] = before + x[k]; }
  }
  if (l == 255u) { sums[wg] = t[255]; }
}

@compute @workgroup_size(256) fn add(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) l: u32) {
  let wg = wid.x + wid.y * nwg.x;
  if (wg * 1024u >= p.n) { return; }
  let a = sums[wg];
  for (var k = 0u; k < 4u; k++) {
    let i = wg * 1024u + l * 4u + k;
    if (i < p.n) { v[i] += a; }
  }
}
`;
