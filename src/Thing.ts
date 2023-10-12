import { Chop } from "./goap/Actions/Chop";
import { PickUp } from "./goap/Actions/PickUp";
import { StartFire } from "./goap/Actions/StartFire";
import { WalkTo } from "./goap/Actions/WalkTo";

enum ThingType {
  PLAYER = "PLAYER",
  STONE = "STONE",
  STICK = "STICK",
  WOOD = "WOOD",
  TREE = "TREE",
  AXE = "AXE",
  HAMMER = "HAMMER",
  KNIFE = "KNIFE",
  FISH = "FISH",
  BERRY = "BERRY",
  MUSHROOM = "MUSHROOM",
  TENT = "TENT",
  CAMPFIRE = "CAMPFIRE",
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

export const things: Record<ThingType, Partial<Thing>> = {
  [ThingType.PLAYER]: {
    symbol: "🧍",
    actions: [WalkTo],
  },
  [ThingType.WOOD]: {
    symbol: "🪵",
    actions: [...defaultThing.actions, PickUp, StartFire],
  },
  [ThingType.STONE]: {
    symbol: "🪨",
    actions: [...defaultThing.actions, PickUp],
  },
  [ThingType.STICK]: {
    symbol: "🪵",
    actions: [...defaultThing.actions, PickUp],
  },
  [ThingType.TREE]: {
    symbol: "🌲",
    actions: [...defaultThing.actions, Chop],
  },
  [ThingType.AXE]: {
    symbol: "🪓",
    actions: [...defaultThing.actions, PickUp],
  },
  [ThingType.HAMMER]: {
    symbol: "🔨",
    actions: [...defaultThing.actions, PickUp],
  },
  [ThingType.KNIFE]: {
    symbol: "🔪",
    actions: [...defaultThing.actions, PickUp],
  },
  [ThingType.FISH]: {
    symbol: "🐟",
    actions: [...defaultThing.actions, PickUp],
  },
  [ThingType.BERRY]: {
    symbol: "🍓",
    actions: [...defaultThing.actions, PickUp],
  },
  [ThingType.MUSHROOM]: {
    symbol: "🍄",
    actions: [...defaultThing.actions, PickUp],
  },
  [ThingType.TENT]: {
    symbol: "⛺",
    actions: [...defaultThing.actions, PickUp],
  },
  [ThingType.CAMPFIRE]: {
    symbol: "🔥",
    actions: [...defaultThing.actions, PickUp],
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

export { Thing, ThingType, createThing };
