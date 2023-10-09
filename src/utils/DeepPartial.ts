export type DeepPartial<T> = T extends Function
  ? T
  : {
      [P in keyof T]?: DeepPartial<T[P]>;
    };
