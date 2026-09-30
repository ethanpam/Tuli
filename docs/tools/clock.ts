/**
 * Stops the clock at a fixed moment, so screenshots always say "Today at 9:05 AM" no matter
 * when they're rendered. Returns a way to move time forward between scenes.
 */
export function freezeTime(iso: string) {
  let now = Date.parse(iso);
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now);
      else super(...(args as [string | number | Date]));
    }
    static override now() {
      return now;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
  return {
    advance(ms: number) {
      now += ms;
    },
  };
}
