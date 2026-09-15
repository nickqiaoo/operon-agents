import type { ToolCallBlockData } from '../types.ts';

/**
 * The tool calls Ctrl+B may move to the background: the engine announced each one as
 * detachable (`tool.detachable`) and it has not produced its result yet. Most recent first.
 */
export function pickDetachableToolCalls(active: Iterable<ToolCallBlockData>): ToolCallBlockData[] {
  const out: ToolCallBlockData[] = [];
  for (const call of active) {
    if (call.detachable === true && call.result === undefined) out.push(call);
  }
  return out.sort((a, b) => (b.streamingStartedAtMs ?? 0) - (a.streamingStartedAtMs ?? 0));
}
