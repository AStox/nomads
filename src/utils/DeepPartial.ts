import { Thing } from "../Things";

export type DeepPartial<T> = T extends Function
  ? T
  : T extends Thing[]
  ? T
  : {
      [P in keyof T]?: DeepPartial<T[P]>;
    };
