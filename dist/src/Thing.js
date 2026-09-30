"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createThing = exports.ThingType = exports.things = void 0;
const Chop_1 = require("./goap/Actions/Chop");
const Drop_1 = require("./goap/Actions/Drop");
const Heal_1 = require("./goap/Actions/Heal");
const Eat_1 = require("./goap/Actions/Eat");
const PickUp_1 = require("./goap/Actions/PickUp");
const StartFire_1 = require("./goap/Actions/StartFire");
const WalkTo_1 = require("./goap/Actions/WalkTo");
var ThingType;
(function (ThingType) {
    ThingType["PLAYER"] = "PLAYER";
    ThingType["STONE"] = "STONE";
    ThingType["STICK"] = "STICK";
    ThingType["WOOD"] = "WOOD";
    ThingType["BOARD"] = "BOARD";
    ThingType["TREE"] = "TREE";
    ThingType["AXE"] = "AXE";
    ThingType["HAMMER"] = "HAMMER";
    ThingType["KNIFE"] = "KNIFE";
    ThingType["SAW"] = "SAW";
    ThingType["FISH"] = "FISH";
    ThingType["BERRY"] = "BERRY";
    ThingType["MUSHROOM"] = "MUSHROOM";
    ThingType["ROASTED_MUSHROOM"] = "ROASTED_MUSHROOM";
    ThingType["TENT"] = "TENT";
    ThingType["CAMPFIRE"] = "CAMPFIRE";
    ThingType["POULTICE"] = "POULTICE";
})(ThingType || (exports.ThingType = ThingType = {}));
function createThing(type, overrides = {}) {
    const defaultThing = ThingTemplates[type];
    if (!defaultThing) {
        throw new Error(`No template found for type: ${type}`);
    }
    return Object.assign(Object.assign(Object.assign({ id: generateRandomId() }, defaultThing), overrides), { type, name: defaultThing.name || type });
}
exports.createThing = createThing;
function generateRandomId() {
    return Math.random().toString(36).substring(2, 15);
}
const defaultThing = {
    x: 0,
    y: 0,
    actions: [WalkTo_1.WalkTo],
};
exports.things = {
    [ThingType.PLAYER]: {
        symbol: "🧍",
        actions: [WalkTo_1.WalkTo],
    },
    [ThingType.WOOD]: {
        symbol: "🪵",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop, StartFire_1.StartFire],
    },
    [ThingType.BOARD]: {
        symbol: "🪵",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop],
    },
    [ThingType.STONE]: {
        symbol: "🪨",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop],
    },
    [ThingType.STICK]: {
        symbol: "🪵",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop],
    },
    [ThingType.TREE]: {
        symbol: "🌲",
        actions: [...defaultThing.actions, Chop_1.Chop],
    },
    [ThingType.AXE]: {
        symbol: "🪓",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop],
    },
    [ThingType.HAMMER]: {
        symbol: "🔨",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop],
    },
    [ThingType.KNIFE]: {
        symbol: "🔪",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop],
    },
    [ThingType.FISH]: {
        symbol: "🐟",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop, Eat_1.Eat],
        satiation: 10,
    },
    [ThingType.BERRY]: {
        symbol: "🍓",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop, Eat_1.Eat],
        satiation: 15,
    },
    [ThingType.MUSHROOM]: {
        symbol: "🍄",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop, Eat_1.Eat],
        satiation: 10,
    },
    [ThingType.ROASTED_MUSHROOM]: {
        symbol: "🍄",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop, Eat_1.Eat],
        satiation: 40,
    },
    [ThingType.TENT]: {
        symbol: "⛺",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop],
    },
    [ThingType.CAMPFIRE]: {
        symbol: "🔥",
        actions: [...defaultThing.actions],
    },
    [ThingType.SAW]: {
        symbol: "🪚",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop],
    },
    [ThingType.POULTICE]: {
        symbol: "🩹",
        actions: [...defaultThing.actions, PickUp_1.PickUp, Drop_1.Drop, Heal_1.Heal],
        healing: 50,
    },
};
const ThingTemplates = Object.fromEntries(Object.entries(exports.things).map(([key, value]) => [
    key,
    Object.assign(Object.assign(Object.assign({}, defaultThing), { name: key, type: key }), value),
]));
//# sourceMappingURL=Thing.js.map