import { Chop } from "./goap/Actions/Chop";
import { Drop } from "./goap/Actions/Drop";
import { Heal } from "./goap/Actions/Heal";
import { Eat } from "./goap/Actions/Eat";
import { PickUp } from "./goap/Actions/PickUp";
import { StartFire } from "./goap/Actions/StartFire";
import { WalkTo } from "./goap/Actions/WalkTo";

enum ThingType {
  PLAYER = "PLAYER",
  STONE = "STONE",
  STICK = "STICK",
  WOOD = "WOOD",
  BOARD = "BOARD",
  TREE = "TREE",
  AXE = "AXE",
  HAMMER = "HAMMER",
  KNIFE = "KNIFE",
  SAW = "SAW",
  FISH = "FISH",
  BERRY = "BERRY",
  MUSHROOM = "MUSHROOM",
  ROASTED_MUSHROOM = "ROASTED_MUSHROOM",
  TENT = "TENT",
  CAMPFIRE = "CAMPFIRE",
  POULTICE = "POULTICE",
}

interface Thing {
  id: string;
  name: string;
  type: ThingType;
  x: number;
  y: number;
  symbol: string;
  actions: Function[];
}

interface Food extends Thing {
  satiation: number;
}

interface Healable extends Thing {
  healing: number;
}

function createThing(type: ThingType, overrides: Partial<Thing> = {}): Thing {
  const defaultThing = ThingTemplates[type];
  if (!defaultThing) {
    throw new Error(`No template found for type: ${type}`);
  }

  return {
    id: generateRandomId(),
    ...defaultThing,
    ...overrides,
    type,
    name: defaultThing.name || type,
  } as Thing;
}

function generateRandomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

const defaultThing: Omit<Thing, "name" | "type" | "id" | "symbol"> = {
  x: 0,
  y: 0,
  actions: [WalkTo],
};

export const things: Record<ThingType, Partial<Thing | Food | Healable>> = {
  [ThingType.PLAYER]: {
    symbol: "🧍",
    actions: [WalkTo],
  },
  [ThingType.WOOD]: {
    symbol: "🪵",
    actions: [...defaultThing.actions, PickUp, Drop, StartFire],
  },
  [ThingType.BOARD]: {
    symbol: "🪵",
    actions: [...defaultThing.actions, PickUp, Drop],
  },
  [ThingType.STONE]: {
    symbol: "🪨",
    actions: [...defaultThing.actions, PickUp, Drop],
  },
  [ThingType.STICK]: {
    symbol: "🪵",
    actions: [...defaultThing.actions, PickUp, Drop],
  },
  [ThingType.TREE]: {
    symbol: "🌲",
    actions: [...defaultThing.actions, Chop],
  },
  [ThingType.AXE]: {
    symbol: "🪓",
    actions: [...defaultThing.actions, PickUp, Drop],
  },
  [ThingType.HAMMER]: {
    symbol: "🔨",
    actions: [...defaultThing.actions, PickUp, Drop],
  },
  [ThingType.KNIFE]: {
    symbol: "🔪",
    actions: [...defaultThing.actions, PickUp, Drop],
  },
  [ThingType.FISH]: {
    symbol: "🐟",
    actions: [...defaultThing.actions, PickUp, Drop, Eat],
    satiation: 10,
  },
  [ThingType.BERRY]: {
    symbol: "🍓",
    actions: [...defaultThing.actions, PickUp, Drop, Eat],
    satiation: 15,
  },
  [ThingType.MUSHROOM]: {
    symbol: "🍄",
    actions: [...defaultThing.actions, PickUp, Drop, Eat],
    satiation: 10,
  },
  [ThingType.ROASTED_MUSHROOM]: {
    symbol: "🍄",
    actions: [...defaultThing.actions, PickUp, Drop, Eat],
    satiation: 40,
  },
  [ThingType.TENT]: {
    symbol: "⛺",
    actions: [...defaultThing.actions, PickUp, Drop],
  },
  [ThingType.CAMPFIRE]: {
    symbol: "🔥",
    actions: [...defaultThing.actions],
  },
  [ThingType.SAW]: {
    symbol: "🪚",
    actions: [...defaultThing.actions, PickUp, Drop],
  },
  [ThingType.POULTICE]: {
    symbol: "🩹",
    actions: [...defaultThing.actions, PickUp, Drop, Heal],
    healing: 50,
  },
};

const ThingTemplates = Object.fromEntries(
  Object.entries(things).map(([key, value]) => [
    key,
    {
      ...defaultThing,
      name: key,
      type: key,
      ...value,
    },
  ])
) as Record<ThingType, Partial<Thing>>;

export { Thing, Food, Healable, ThingType, createThing };
