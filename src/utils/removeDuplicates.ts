import { Thing, ThingType } from "../Thing";

type SortComparator<T> = (a: T, b: T) => number;

function removeDuplicatesByType(things: Thing[], compare: SortComparator<Thing>): Thing[] {
  const typeMap = new Map<ThingType, Thing[]>();

  // Group things by type
  things.forEach((thing) => {
    const group = typeMap.get(thing.type);
    if (group) {
      group.push(thing);
    } else {
      typeMap.set(thing.type, [thing]);
    }
  });

  // For each type, sort the group and keep the first one
  const uniqueThings: Thing[] = [];
  typeMap.forEach((group, type) => {
    if (group.length > 1) {
      group.sort(compare); // Sort based on the comparator
    }
    uniqueThings.push(group[0]); // Only take the first item after sorting
  });

  return uniqueThings;
}

function compareByProximity(player: Thing, a: Thing, b: Thing): number {
  const distanceA = Math.hypot(player.x - a.x, player.y - a.y);
  const distanceB = Math.hypot(player.x - b.x, player.y - b.y);
  return distanceA - distanceB; // Smaller distance will sort the element to the front
}

export { removeDuplicatesByType, compareByProximity };
