// A trace of what the planet pass and the tile pyramid do, for the arrival gate: `self.__arr` is an array when a check turns it on (worker.js `arr` op), else null and every call is a lookup.
export const tr = (...a) => { const A = globalThis.__arr; if (A) A.push([performance.now(), ...a]); };
