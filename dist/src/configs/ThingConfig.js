"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThingTemplates = exports.things = void 0;
const Thing_1 = require("../Thing");
const Chop_1 = require("../goap/Actions/Chop");
const PickUp_1 = require("../goap/Actions/PickUp");
const StartFire_1 = require("../goap/Actions/StartFire");
const WalkTo_1 = require("../goap/Actions/WalkTo");
const defaultThing = {
    x: 0,
    y: 0,
    actions: [WalkTo_1.WalkTo],
};
exports.things = {
    [Thing_1.ThingType.PLAYER]: {
        symbol: "🧍",
        actions: [WalkTo_1.WalkTo],
    },
    [Thing_1.ThingType.WOOD]: {
        symbol: "🪵",
        actions: [...defaultThing.actions, PickUp_1.PickUp, StartFire_1.StartFire],
    },
    [Thing_1.ThingType.STONE]: {
        symbol: "🪨",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
    [Thing_1.ThingType.STICK]: {
        symbol: "🪵",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
    [Thing_1.ThingType.TREE]: {
        symbol: "🌲",
        actions: [...defaultThing.actions, Chop_1.Chop],
    },
    [Thing_1.ThingType.AXE]: {
        symbol: "🪓",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
    [Thing_1.ThingType.HAMMER]: {
        symbol: "🔨",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
    [Thing_1.ThingType.KNIFE]: {
        symbol: "🔪",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
    [Thing_1.ThingType.FISH]: {
        symbol: "🐟",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
    [Thing_1.ThingType.BERRY]: {
        symbol: "🍓",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
    [Thing_1.ThingType.MUSHROOM]: {
        symbol: "🍄",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
    [Thing_1.ThingType.TENT]: {
        symbol: "⛺",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
    [Thing_1.ThingType.CAMPFIRE]: {
        symbol: "🔥",
        actions: [...defaultThing.actions, PickUp_1.PickUp],
    },
};
exports.ThingTemplates = Object.fromEntries(Object.entries(exports.things).map(([key, value]) => [
    key,
    Object.assign(Object.assign(Object.assign({}, defaultThing), { name: key, type: key }), value),
]));
//# sourceMappingURL=ThingConfig.js.map