// What living things go by instead of a calendar: the length of the day and whether it is growing, as plants and animals
// read it, and the warmth of the air. Nothing here names a season.
import { DAY } from "./world";
import { daylight } from "./sky";

const day = (t: number) => Math.floor(t / DAY) + 1;
// The days are drawing out.
export const lengthening = (t: number) => daylight(day(t)) > daylight(day(t) - 1);
// Young are born as the days draw out past eleven hours, so they have the warm months to grow.
export const breeding = (t: number) => lengthening(t) && daylight(day(t)) > 11;
// Trees and bushes ripen their seed as the days draw in, until they are short.
export const ripening = (t: number) => !lengthening(t) && daylight(day(t)) < 13.5 && daylight(day(t)) > 8.5;
// How fast a plant grows at an air temperature, 0 to 1: nothing at 4 C and below, full at 14.
export const warmRate = (temp: number) => { const x = Math.max(0, Math.min(1, (temp - 4) / 10)); return x * x * (3 - 2 * x); };
// How hard the cold bites a warm-blooded animal, 0 above 6 C, 1 at -6.
export const coldBite = (temp: number) => Math.max(0, Math.min(1.2, (6 - temp) / 12));
