import { readPlanet } from "../src/gpu/globe/window";
import { diskStore } from "../scripts/globe-window";
const planet = await readPlanet(1, diskStore(process.env.HOME + "/.cache/nomads-scratch/t5/bake/small/store", "b4c6e7d1b819"));
console.log(Object.keys(planet));
for (const k of Object.keys(planet)) { const v = (planet as any)[k]; if (v && typeof v === "object" && !ArrayBuffer.isView(v)) console.log(k, JSON.stringify(v).slice(0, 600)); else if (typeof v !== "object") console.log(k, v); else console.log(k, v.constructor.name, v.length); }
process.exit(0);
