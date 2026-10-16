// The hourly law of the water in everything lying out, in WGSL (src/gpu/moisture.ts drives it and holds its twin,
// whose comments give the law; docs/research/fire-constants.md sec. 35). Three passes: each cell's air from the
// island's hour, each texel's classes in its cell's air under its crowns, and each log in its texel's. Integer
// throughout, and each invocation writes only its own words, so every GPU gives the same words.
import { N } from "../../terrain/grid";
import { DIRS } from "../../terrain/climate";
import { FIXED } from "./fixed";
import { CROWN_ACCESS, LAYERED, SIDE, TEXELS, TEXEL_MM } from "./crowns";
import { common, type DeadLaw } from "./deadwood";
import { CELL_WORDS, CLASSES, CLASS_LAWS, FSP, GROUND, HOUR_FIELDS, LOG_DIAS, LOG_ROWS, LOG_STEP, SHELTER_H, TEXEL_WORDS, toW } from "../moisture";

export type MoistureLayout = {
  logCap: number; upCap: number;
  log: { x: number; y: number; born: number; what: number; dia: number; uf: number; fr: number };
  up: { x: number; y: number; born: number; what: number; dia: number; uf: number; fr: number; oslot: number; ogen: number };
};

const FLAT = /* wgsl */ `fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;
const Q = (x: number) => `${Math.round(x * 65536)}i`;
const K = (x: number) => `${Math.round(x * 2 ** 24)}u`;
// The hour's fields, read from the bound hour buffer (i32s in HOUR_FIELDS order).
// (functions, not constants: this module and ../moisture.ts import each other)
const hourFns = () => HOUR_FIELDS.map((k, i) => `fn h_${k}() -> i32 { return hr[${i}u]; }`).join("\n");

// Simard, Byram and Jemison, the soil's damp, the exchange and the hour (moisture.ts emcQ ... step).
const LAW = /* wgsl */ `
fn k24(a: i32, k: u32) -> i32 {
  let p = mul64(mag(a), k);
  let r = bitcast<i32>((p.x >> 24u) | (p.y << 8u));
  return select(r, -r, a < 0i);
}
fn emc_q(rh: i32, temp: i32) -> i32 {
  let RH = clamp(rh * 100i, 0i, 6553600i);
  let T = qmul(temp, ${Q(1.8)}) + ${Q(32)};
  var pct = 0i;
  if (RH < ${Q(10)}) { pct = ${Q(0.03229)} + k24(RH, ${K(0.281073)}) - k24(qmul(T, RH), ${K(0.000578)}); }
  else if (RH < ${Q(50)}) { pct = ${Q(2.22749)} + k24(RH, ${K(0.160107)}) - k24(T, ${K(0.014784)}); }
  else { pct = ${Q(21.0606)} + k24(qmul(RH, RH), ${K(0.005565)}) - k24(qmul(RH, T), ${K(0.00035)}) - k24(RH, ${K(0.483199)}); }
  return max(0i, pct) * 256i / 100i;
}
fn esat_q(temp: i32) -> i32 { return qmul(${Q(0.6108)}, qexp(qdiv(qmul(${Q(17.27)}, temp), temp + ${Q(237.3)}))); }
fn humid_q(vapour: i32, temp: i32) -> i32 { return clamp(qdiv(vapour, esat_q(temp)), 0i, 65536i); }
fn equilibrium_q(temp: i32, vapour: i32, shine: i32, wind: i32) -> i32 {
  let own = temp + qdiv(shine, ${Q(32.7)} + qmul(${Q(42.2)}, wind));
  return emc_q(humid_q(vapour, own), own);
}
fn lying_q(air: i32, temp: i32, vapour: i32, kr: i32) -> i32 {
  let rh = humid_q(vapour, temp);
  return (air + emc_q(rh + qmul(65536i - rh, kr), temp)) >> 1u;
}
struct Water { m: i32, skin: i32 }
fn toward(x: Water, to: i32, k: vec4i) -> Water {
  let s0 = x.skin - to;
  let c0 = 2i * x.m - x.skin - to;
  let s = qmul(s0, k.x) + qmul(c0, k.y);
  let c = qmul(s0, k.z) + qmul(c0, k.w);
  return Water(to + ((s + c) >> 1u), to + s);
}
fn hour_step(x: Water, mmax: i32, face: i32, wet: vec4i, dry: vec4i, rain: i32, eq: i32) -> Water {
  if (rain > 0i) {
    let next = toward(x, mmax, wet);
    let gain = next.m - x.m;
    let most = min(qmul(rain, face), 0x7fffffi) << 8u;
    if (gain <= most) { return next; }
    return Water(x.m + most, x.skin + qmul(next.skin - x.skin, qdiv(most, gain)));
  }
  let to = min(mmax, eq);
  let next = toward(x, to, dry);
  let m = max(min(to, x.m), next.m);
  return Water(m, min(2i * m, max(min(to, x.skin), next.skin)));
}`;

// Each cell's air this hour (moisture.ts cellAir). Bindings: cells (CELL_WORDS i32 a cell), lee (bytes), hour, air.
export function moistureCells() {
  return /* wgsl */ `
${FIXED}
@group(0) @binding(0) var<storage, read> cells: array<i32>;
@group(0) @binding(1) var<storage, read> lee: array<u32>;
@group(0) @binding(2) var<storage, read> hr: array<i32>;
@group(0) @binding(3) var<storage, read_write> air: array<i32>;
${FLAT}
${hourFns()}
fn blend(base: u32, i: u32) -> i32 {
  let a = cells[base + i + u32(h_s())];
  let b = cells[base + i + (u32(h_s()) + 1u) % 4u];
  return a + qmul(b - a, h_f());
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let c = flat(g, n);
  if (c >= ${N * N}u) { return; }
  let base = c * ${CELL_WORDS}u;
  if (cells[base + 15u] == 0i) { return; }
  let temp = h_temp() + blend(base, 0u) - qmul(cells[base + 12u], h_pooled());
  let vapour = blend(base, 4u);
  let li = c * ${DIRS}u + u32(h_k());
  let l = (lee[li >> 2u] >> ((li & 3u) * 8u)) & 255u;
  let head = qmul(h_speed(), i32((l * 65536u) / 100u));
  var rain = 0i;
  if (h_wet() > 0i) {
    rain = blend(base, 8u) * h_wet();
    if (h_v() > 0i) {
      let share = 65536i + qmul(qdiv(head, h_v()), qmul(cells[base + 13u], h_ux()) + qmul(cells[base + 14u], h_uy()));
      rain = qmul(rain, max(0i, share));
    }
  }
  air[4u * c] = temp; air[4u * c + 1u] = vapour; air[4u * c + 2u] = rain; air[4u * c + 3u] = head;
}`;
}

const classConsts = () => CLASS_LAWS.map((L, i) => `
const MMAX${i} = ${L.mmax}i; const FACE${i} = ${L.face}i;
const WET${i} = vec4i(${L.wet.map((v) => `${v}i`).join(", ")}); const DRY${i} = vec4i(${L.dry.map((v) => `${v}i`).join(", ")});`).join("");
const classSteps = () => CLASSES.map((c, i) => `
  {
    let x = hour_step(Water(states[base + ${2 * i}u], states[base + ${2 * i + 1}u]), MMAX${i}, FACE${i}, WET${i}, DRY${i}, rain, ${c.lying ? "lying" : "aloft"});
    states[base + ${2 * i}u] = x.m; states[base + ${2 * i + 1}u] = x.skin;
  }`).join("");

// Each texel's dead stuff an hour on (moisture.ts envQ, texelHour), what it lay in kept for the logs. Bindings: air,
// crowns (crowns.ts words), shelter (A pine, A broadleaf, B pine, B broadleaf, SHELTER_H each), hour, env (3 a texel),
// states.
export function moistureTexels() {
  return /* wgsl */ `
${FIXED}
${LAYERED}
@group(0) @binding(0) var<storage, read> air: array<i32>;
@group(0) @binding(1) var<storage, read> crowns: array<u32>;
@group(0) @binding(2) var<storage, read> shelter: array<i32>;
@group(0) @binding(3) var<storage, read> hr: array<i32>;
@group(0) @binding(4) var<storage, read_write> env: array<i32>;
@group(0) @binding(5) var<storage, read_write> states: array<i32>;
${FLAT}
${hourFns()}
${CROWN_ACCESS}
${LAW}
${classConsts()}
fn shelter_q(open: i32, cov: u32, h: u32, kind: u32) -> i32 {
  let c = i32(min(65536u, cov));
  let j = kind * ${SHELTER_H}u + min(h, ${SHELTER_H - 1}u);
  if (h == 0u || qmul(c, shelter[${2 * SHELTER_H}u + j]) <= ${Q(0.05)}) { return open; }
  return min(open, qdiv(qmul(open, shelter[j]), qsqrt(c)));
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let t = flat(g, n);
  if (t >= ${TEXELS}u) { return; }
  let c = ((t / ${SIDE}u) >> 2u) * ${N}u + ((t % ${SIDE}u) >> 2u);
  let temp = air[4u * c]; let vapour = air[4u * c + 1u]; let open_rain = air[4u * c + 2u]; let open_head = air[4u * c + 3u];
  if (vapour == 0i) { return; }
  let pine = pine_cover(t); let broad = broad_cover(t);
  var kind = 1u;
  if (pine > broad) { kind = 0u; }
  let head = shelter_q(open_head, pine + broad, crown_height_dm(c), kind);
  let shine = qmul(h_sun(), i32(layered(pine + broad)));
  let rain = qmul(qmul(open_rain, i32(layered_by(pine, u32(h_tp())))), i32(layered_by(broad, u32(h_tb()))));
  let aloft = equilibrium_q(temp, vapour, shine, head);
  let lying = lying_q(equilibrium_q(temp, vapour, shine, qmul(head, ${Q(GROUND)})), temp, vapour, h_kr());
  env[3u * t] = rain; env[3u * t + 1u] = lying; env[3u * t + 2u] = aloft;
  let base = t * ${TEXEL_WORDS}u;
${classSteps()}
}`;
}

// Each log and touched log an hour on (moisture.ts logHour). Its state: m, skin and a tag, the slot word of the object
// it is the water of, bit 31 set while it is green wood above fibre saturation. Bindings: log body, logup body, env,
// log tables (LOG_ROWS x 4, then LOG_DIAS x 8), hour, states, P (the first hour).
export function moistureLogs(L: MoistureLayout, D: DeadLaw) {
  const at = TEXELS * TEXEL_WORDS;
  return /* wgsl */ `
${FIXED}
${common(D)}
@group(0) @binding(0) var<storage, read> lb: array<u32>;
@group(0) @binding(1) var<storage, read> ub: array<u32>;
@group(0) @binding(2) var<storage, read> env: array<i32>;
@group(0) @binding(3) var<storage, read> tab: array<i32>;
@group(0) @binding(4) var<storage, read> hr: array<i32>;
@group(0) @binding(5) var<storage, read_write> states: array<i32>;
@group(0) @binding(6) var<uniform> P: vec4u;
${FLAT}
${hourFns()}
${LAW}
fn texel_of(x: u32, y: u32) -> u32 { return min(y / ${TEXEL_MM}u, ${SIDE - 1}u) * ${SIDE}u + min(x / ${TEXEL_MM}u, ${SIDE - 1}u); }
fn field(up: bool, f: u32, i: u32) -> u32 { if (up) { return ub[f + i]; } return lb[f + i]; }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let k = flat(g, n);
  if (k >= ${L.logCap + L.upCap}u) { return; }
  let up = k >= ${L.logCap}u;
  var i = k;
  if (up) { i = k - ${L.logCap}u; }
  let word = field(up, 0u, i);
  if ((word & 1u) == 0u) { return; }
  var fx = ${L.log.x}u; var fy = ${L.log.y}u; var fb = ${L.log.born}u; var fw = ${L.log.what}u; var fd = ${L.log.dia}u; var fu = ${L.log.uf}u; var ff = ${L.log.fr}u;
  if (up) { fx = ${L.up.x}u; fy = ${L.up.y}u; fb = ${L.up.born}u; fw = ${L.up.what}u; fd = ${L.up.dia}u; fu = ${L.up.uf}u; ff = ${L.up.fr}u; }
  let t = texel_of(field(up, fx, i), field(up, fy, i));
  let born = field(up, fb, i);
  let lying = !standing(field(up, fu, i), field(up, ff, i), u32(h_hour()) - born);
  let base = ${at}u + 3u * k;
  var tag = bitcast<u32>(states[base + 2u]);
  var x = Water(states[base], states[base + 1u]);
  let r = min(field(up, fw, i), ${LOG_ROWS - 1}u);
  if ((tag & 0x7fffffffu) != word) {
    tag = word;
    var found = false;
    if (up) {
      let o = ${at}u + 3u * ub[${L.up.oslot}u + i];
      let ot = bitcast<u32>(states[o + 2u]) & 0x7fffffffu;
      if ((ot >> 1u) == ub[${L.up.ogen}u + i]) { x = Water(states[o], states[o + 1u]); tag = word | (bitcast<u32>(states[o + 2u]) & 0x80000000u); found = true; }
    }
    if (!found) {
      if (born <= P.x) {
        var c = 2u;
        if (!lying) { c = 4u; }
        x = Water(states[t * ${TEXEL_WORDS}u + 2u * c], states[t * ${TEXEL_WORDS}u + 2u * c + 1u]);
      } else {
        x = Water(tab[r * 4u + 2u], tab[r * 4u + 2u]);
        tag = word | 0x80000000u;
      }
    }
  }
  let dia = field(up, fd, i);
  let j = ${LOG_ROWS * 4}u + min(dia / ${LOG_STEP}u, ${LOG_DIAS - 1}u) * 8u;
  let wet = vec4i(tab[j], tab[j + 1u], tab[j + 2u], tab[j + 3u]);
  var dry = wet;
  let green = (tag & 0x80000000u) != 0u && x.m > ${toW(FSP)}i;
  if (green) { dry = vec4i(tab[j + 4u], tab[j + 5u], tab[j + 6u], tab[j + 7u]); }
  let eq = select(env[3u * t + 2u], env[3u * t + 1u], lying);
  x = hour_step(x, tab[r * 4u], tab[r * 4u + 1u] / i32(max(dia, 1u)), wet, dry, env[3u * t], eq);
  if (!green) { tag = tag & 0x7fffffffu; }
  states[base] = x.m; states[base + 1u] = x.skin; states[base + 2u] = bitcast<i32>(tag);
}`;
}

// The asked words copied into the landing. Bindings: states, idx, out, P (n, at).
export function moistureGather() {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> states: array<u32>;
@group(0) @binding(1) var<storage, read> idx: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> P: vec4u;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.x) { return; }
  out[P.y + i] = states[idx[i]];
}`;
}
