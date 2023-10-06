enum ThingType {
  PLAYER = "PLAYER",
  STONE = "STONE",
  STICK = "STICK",
  TREE = "TREE",
  AXE = "AXE",
  HAMMER = "HAMMER",
  KNIFE = "KNIFE",
  FISH = "FISH",
  BERRY = "BERRY",
  MUSHROOM = "MUSHROOM",
  TENT = "TENT",
}

interface Thing {
  name: string;
  type: ThingType;
  x: number;
  y: number;
  symbol: string;
  actions: Function[];
}

export { Thing, ThingType };
