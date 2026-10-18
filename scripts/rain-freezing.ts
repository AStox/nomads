// The share of the moist layer's condensation that happens above the freezing level, by game season, from the radiosondes
// of Greifswald and Leba in the hours Hammer Odde reports rain or snow falling (src/gpu/terrain/rain.ts ICE_SHARE;
// docs/research/generator/2026-10-18-rain.md). Same sources and caches as docs/research/isd/bornholm.py upper:
// NOAA ISD hourly SYNOP (ISD_CACHE, default /tmp/nm/isdb, files hammer_<year>.csv) and IGRA2 soundings (IGRA_CACHE,
// default /tmp/nm/igra), 2015 to 2024, fetched on first use.
//   bun scripts/rain-freezing.ts
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { H_W } from "../src/terrain/climate";
import { ICE_SHARE } from "../src/gpu/terrain/rain";

const ISD = process.env.ISD_CACHE ?? "/tmp/nm/isdb", IGRA = process.env.IGRA_CACHE ?? "/tmp/nm/igra";
const SONDES = ["GMM00010184", "PLM00012120"], YEARS = Array.from({ length: 10 }, (_, i) => 2015 + i);
mkdirSync(ISD, { recursive: true }); mkdirSync(IGRA, { recursive: true });
const fetchTo = async (url: string, to: string) => { if (!existsSync(to)) await Bun.write(to, await fetch(url)); };
for (const y of YEARS) await fetchTo(`https://noaa-global-hourly-pds.s3.amazonaws.com/${y}/06193099999.csv`, `${ISD}/hammer_${y}.csv`);
for (const sid of SONDES) {
  if (existsSync(`${IGRA}/${sid}-data.txt`)) continue;
  await fetchTo(`https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/access/data-por/${sid}-data.txt.zip`, `${IGRA}/${sid}.zip`);
  spawnSync("unzip", ["-oq", `${IGRA}/${sid}.zip`, "-d", IGRA]);
}

// A CSV line's fields (quoted fields may hold commas; an empty field is bare).
function fields(line: string) {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (const ch of line) { if (ch === '"') quoted = !quoted; else if (ch === "," && !quoted) { out.push(cur); cur = ""; } else cur += ch; }
  return [...out, cur];
}
// The game's season (0 spring .. 3 winter) of a date: spring centred on the March equinox (day 79), as src/sim/sky.ts.
const season = (month: number, day: number) => {
  const doy = Math.floor((Date.UTC(2001, month - 1, day) - Date.UTC(2001, 0, 1)) / 864e5) + 1;
  return Math.floor(((((doy - 79 + 365.25 / 8) % 365.25) + 365.25) % 365.25) / (365.25 / 4));
};

// Hammer Odde's wet hours: a SYNOP on the hour whose present weather is 40 to 89 (bornholm.py classify: rain, snow or a storm).
const wet: Record<string, true> = {};
for (const y of YEARS) {
  const lines = readFileSync(`${ISD}/hammer_${y}.csv`, "latin1").split("\n"), head = fields(lines[0]);
  const date = head.indexOf("DATE"), type = head.indexOf("REPORT_TYPE"), aw = head.indexOf("AW1");
  for (const line of lines.slice(1)) {
    const f = fields(line);
    if (f.length < head.length - 2 || f[type].trim() !== "FM-12" || f[date].slice(14, 16) !== "00") continue;
    const code = Number((f[aw] ?? "").split(",")[0]);
    if (code >= 40 && code <= 89) wet[f[date].slice(0, 13)] = true;
  }
}

// Each wet-hour sounding's freezing level above the sea (0 where the air at the ground is below freezing, none up the
// sounding: infinite), and e^(-z_f / H_w): the share of the moist layer's condensation above it.
const share: number[][] = [[], [], [], []], level: number[][] = [[], [], [], []];
for (const sid of SONDES) {
  let at = -1, levels: { z: number; t: number }[] = [];
  const close = () => {
    const v = levels.filter((l) => !Number.isNaN(l.z) && !Number.isNaN(l.t)).sort((a, b) => a.z - b.z);
    if (at >= 0 && v.length >= 3) {
      let zf = Infinity;
      if (v[0].t < 0) zf = 0;
      else for (let i = 0; i + 1 < v.length; i++) if (v[i].t >= 0 && v[i + 1].t < 0) { zf = v[i].z + ((v[i + 1].z - v[i].z) * v[i].t) / (v[i].t - v[i + 1].t); break; }
      share[at].push(Math.exp(-zf / H_W)); level[at].push(zf);
    }
  };
  for (const line of readFileSync(`${IGRA}/${sid}-data.txt`, "latin1").split("\n")) {
    if (line[0] === "#") {
      close();
      const y = Number(line.slice(13, 17)), mo = Number(line.slice(18, 20)), d = Number(line.slice(21, 23)), hr = Number(line.slice(24, 26));
      const key = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hr).padStart(2, "0")}`;
      at = y >= 2015 && y <= 2024 && (hr === 0 || hr === 12) && wet[key] ? season(mo, d) : -1;
      levels = [];
    } else if (at >= 0) {
      const num = (a: number, b: number) => { const v = Number(line.slice(a, b)); return v === -9999 || v === -8888 ? NaN : v; };
      levels.push({ z: num(16, 21), t: num(22, 27) / 10 });
    }
  }
  close();
}
const NAMES = ["spring", "summer", "autumn", "winter"];
NAMES.forEach((name, s) => {
  const z = [...level[s]].sort((a, b) => a - b), m = share[s].reduce((a, b) => a + b, 0) / share[s].length;
  console.log(`${name}: ${share[s].length} soundings, ice share ${m.toFixed(3)} (rain.ts ICE_SHARE ${ICE_SHARE[s]}), freezing level median ${z[Math.floor(z.length / 2)].toFixed(0)} m`);
});
