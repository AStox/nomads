// The night's light as one law at every zoom: the ground shows by the light it has, starlight and the moon, as the planet pass draws it from above (wgsl/globe.js nightGround) and as the light
// tables give it to the ladder's ground and sprites (live.js row). Radiance of a ground of albedo rho under illuminance E is rho E / pi; the sky beside it has the dark sky's radiance, and the display
// runs as the light to the power GAM (live.js exposure), so a colour shows at the ink's luminance times (rho E / (pi L_sky)) ^ GAM, keeping its own hue.
// E: moonless clear night sky 2.2e-3 lx (Allen, Astrophysical Quantities) and the full moon at its zenith 0.267 lx (Allen; Kyba et al. 2017), by the lit share of the disc, the moon's height and,
// on a face, the share of the moon's light that faces it; L_sky 2.2e-4 cd/m2 (the dark night sky, 22 mag/arcsec2, Leinert et al. 1998); rho from the palette colour's luminance [design: 0.4 of it,
// a mid land colour 0.15 and the sea 0.05]; GAM is live.js's.
export const NG = { moon: 0.267, star: 0.0022, sky: 2.2e-4, alb: 0.4, gam: 0.16 };
const LUM = [0.3, 0.59, 0.11];
const lum = (c) => c[0] * LUM[0] + c[1] * LUM[1] + c[2] * LUM[2];
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// the moon's light on a face of the ground: its zenith's by the lit share, fading across the horizon, times `facing` (the moon's height on flat ground, the key light's share on a face)
export const moonLux = (m, lit, facing) => NG.moon * lit * smooth(-0.017, 0.17, m) * Math.max(facing, 0);

// the colour c (0 to 1 each) shown under illuminance E against the ink's luminance
export function nightShown(c, E, inkLum) {
  const lc = Math.max(lum(c), 1e-3), k = (inkLum / lc) * Math.pow((NG.alb * lc * E) / (Math.PI * NG.sky), NG.gam);
  return [c[0] * k, c[1] * k, c[2] * k];
}

// as the dark drains colour (live.js row): less saturated, bluer; dim 0 to 1
export function nightDrain(g, dim) {
  const y = lum(g), sat = 1 - 0.45 * dim;
  return [(y + (g[0] - y) * sat) * (1 - 0.2 * dim), (y + (g[1] - y) * sat) * (1 - 0.04 * dim), (y + (g[2] - y) * sat) * (1 + 0.15 * dim)];
}

// never darker than the sky beside it, by luminance so the colour keeps its hue (starlight alone puts a ground below the dark sky's luminance, and land and sea would be one flat ink)
export function nightFloor(g, inkLum) {
  const y = lum(g), k = y < inkLum ? inkLum / Math.max(y, 1e-6) : 1;
  return [g[0] * k, g[1] * k, g[2] * k];
}
