import { Thing } from "../Things";

interface Action {
  name: string;
  cost: number;
  preconditions: any;
  effects: any;
  target: Thing;

  perform(): boolean;
}

export type { Action };
