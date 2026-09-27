// Stranded cotton, by shade card number. The ground colours come in dark to light ramps so the chart can shade relief
// and tree crowns the way a pattern designer would, by picking the next skein along.
export const FLOSS = {
  890: "#1d3a2a", 501: "#3b6755", 3345: "#29481d", 3346: "#3f6331", 987: "#577439", 988: "#6f8d3d",
  470: "#8ca446", 471: "#a9bc6c", 581: "#98a034", 166: "#bcc24f", 472: "#d3dd98",
  3740: "#6a4a5e", 3041: "#8a6780", 3042: "#b09aae",
  3051: "#58623d", 3052: "#7f8961", 3053: "#a3a983",
  3021: "#57513f", 3022: "#8c8a72", 3023: "#b3ac98", 413: "#5c5e61", 647: "#9f988c",
  738: "#e3c595", 739: "#f1e1c3",
  3750: "#2c4356", 517: "#316b88", 518: "#4b8aa5", 519: "#80b2c9", 3325: "#b1cfe0",
  // for the small things: flowers, fire, wood, tents and people
  726: "#f3cb45", blanc: "#fbfaf5", 3354: "#dc9aa8", 340: "#a097cf", 946: "#e35d17", 971: "#f48a1c", 321: "#bd272c",
  801: "#6a4424", 433: "#8c5a2e", 3371: "#2d1f16", 3033: "#e4d9c6", 3864: "#c9ad8d", 3862: "#8b6a4c", 951: "#efc6a2", 407: "#bb8a74",
};

export const RAMP = {
  pine: [890, 890, 501], oak: [3345, 3346, 987], ash: [3346, 987, 988], aspen: [988, 470, 471],
  meadow: [988, 581, 166], heath: [3740, 3041, 3042], scrub: [987, 581, 166], marsh: [3051, 3052, 3053],
  meadowNear: [3346, 988, 470], rock: [3021, 3022, 3023], shingle: [3022, 3023, 739], sand: [738, 738, 739],
};

export const rgb = (hex) => { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
export const col = (key) => rgb(FLOSS[key] ?? key);
