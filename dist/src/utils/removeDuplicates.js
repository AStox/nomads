"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareByProximity = exports.removeDuplicatesByType = void 0;
function removeDuplicatesByType(things, compare) {
    const typeMap = new Map();
    // Group things by type
    things.forEach((thing) => {
        const group = typeMap.get(thing.type);
        if (group) {
            group.push(thing);
        }
        else {
            typeMap.set(thing.type, [thing]);
        }
    });
    // For each type, sort the group and keep the first one
    const uniqueThings = [];
    typeMap.forEach((group, type) => {
        if (group.length > 1) {
            group.sort(compare); // Sort based on the comparator
        }
        uniqueThings.push(group[0]); // Only take the first item after sorting
    });
    return uniqueThings;
}
exports.removeDuplicatesByType = removeDuplicatesByType;
function compareByProximity(player, a, b) {
    const distanceA = Math.hypot(player.x - a.x, player.y - a.y);
    const distanceB = Math.hypot(player.x - b.x, player.y - b.y);
    return distanceA - distanceB; // Smaller distance will sort the element to the front
}
exports.compareByProximity = compareByProximity;
//# sourceMappingURL=removeDuplicates.js.map