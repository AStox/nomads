interface Action {
  name: string;
  cost: number;
  preconditions: any;
  effects: any;

  perform(): boolean;
}

export type { Action };
