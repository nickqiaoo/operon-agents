import type { Usage } from "../protocol/index.ts";

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/** Delta between two cumulative usage snapshots, used when a paused child frame resumes. */
export function subtractUsage(total: Usage, previous: Usage): Usage {
  return {
    input: Math.max(0, total.input - previous.input),
    output: Math.max(0, total.output - previous.output),
    cacheRead: Math.max(0, total.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - previous.cacheWrite),
    totalTokens: Math.max(0, total.totalTokens - previous.totalTokens),
    cost: {
      input: Math.max(0, total.cost.input - previous.cost.input),
      output: Math.max(0, total.cost.output - previous.cost.output),
      cacheRead: Math.max(0, total.cost.cacheRead - previous.cost.cacheRead),
      cacheWrite: Math.max(0, total.cost.cacheWrite - previous.cost.cacheWrite),
      total: Math.max(0, total.cost.total - previous.cost.total),
    },
  };
}
