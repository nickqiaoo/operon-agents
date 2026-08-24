export interface ClockSources {
  wallNow(): number;
  monoNowMs(): number;
}

const systemMonoNowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

export const SYSTEM_CLOCKS: ClockSources = {
  wallNow: () => Date.now(),
  monoNowMs: systemMonoNowMs,
};

export interface MutableClock extends ClockSources {
  set(ms: number): void;
  advance(deltaMs: number): void;
}

export function mutableClock(initialMs: number): MutableClock {
  let wall = initialMs;
  return {
    wallNow: () => wall,
    monoNowMs: systemMonoNowMs,
    set: (ms: number) => {
      wall = ms;
    },
    advance: (deltaMs: number) => {
      wall += deltaMs;
    },
  };
}
