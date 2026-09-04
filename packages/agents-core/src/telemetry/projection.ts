/**
 * Built-in projection: the `AgentEvent` stream → registry events.
 *
 * Mirrors `tracing/bridge.ts` in shape (subscribe to a session's sink, keep per-address state,
 * emit on lifecycle boundaries) but counts instead of building a tree. One subscription per
 * session; sub-agents are told apart by `address`, which is stamped as a property here rather
 * than by nested context views.
 *
 * Owns its own clock: `AgentEvent` carries no timestamp.
 *
 * Deliberately NOT projected: `assistant.delta`, `thinking.delta`, `tool.call.delta`,
 * `content.part`, `history.*`, `log` — content or volume, never a count.
 */

import type { AgentEvent, EventSink } from "../events/index.ts";
import type { FrameworkTelemetryEvents } from "./events.ts";
import { capTelemetryText, redactTelemetryString } from "./redact.ts";
import type { TelemetryService } from "./service.ts";

export interface TelemetryProjectionOptions {
  readonly now?: () => number;
  /** Reported on `session_started`. The opener knows; the stream does not. */
  readonly resumed?: boolean;
}

interface TurnState {
  readonly turnId: string;
  readonly startedAt: number;
  stepCount: number;
  toolCallCount: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  model: string | null;
}

interface ToolState {
  readonly turnId: string | null;
  readonly startedAt: number;
}

/** Segments in an address: `""` is 0, `"a"` is 1, `"a/b"` is 2. */
function depthOf(address: string): number {
  return address === "" ? 0 : address.split("/").length;
}

export function subscribeTelemetryProjection(
  sink: EventSink,
  telemetry: TelemetryService<FrameworkTelemetryEvents>,
  options: TelemetryProjectionOptions = {},
): () => void {
  const now = options.now ?? (() => Date.now());
  const resumed = options.resumed ?? false;
  /** Active turn per agent address. Sub-agent turns nest under their own address. */
  const turnByAddress = new Map<string, TurnState>();
  const toolById = new Map<string, ToolState>();
  const agentByAddress = new Map<string, string>();
  let sessionStarted = false;
  let rootAddress: string | undefined;

  const at = (address: string) => telemetry.withContext({ address, agent: agentByAddress.get(address) ?? null });

  const handle = (event: AgentEvent): void => {
    const { address } = event;
    switch (event.type) {
      case "agent.started": {
        agentByAddress.set(address, event.agent);
        if (!sessionStarted) {
          sessionStarted = true;
          rootAddress = address;
          at(address).track("session_started", { resumed });
        } else if (address !== rootAddress) {
          at(address).track("subagent_spawned", { agent_name: event.agent, depth: depthOf(address) - depthOf(rootAddress ?? "") });
        }
        break;
      }
      case "agent.ended": {
        // A finished agent's dangling turn (cancelled mid-flight without turn.ended) is closed
        // here so counts do not leak into the next agent at the same address.
        const turn = turnByAddress.get(address);
        if (turn !== undefined) {
          turnByAddress.delete(address);
          finish(address, turn, "cancelled");
        }
        break;
      }
      case "turn.started": {
        turnByAddress.set(address, {
          turnId: event.turnId,
          startedAt: now(),
          stepCount: 0,
          toolCallCount: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          model: null,
        });
        at(address).track("turn_started", { turn_id: event.turnId, origin: event.origin?.kind ?? "unknown" });
        break;
      }
      case "turn.ended": {
        const turn = turnByAddress.get(address);
        if (turn === undefined || turn.turnId !== event.turnId) break;
        turnByAddress.delete(address);
        finish(address, turn, event.reason);
        break;
      }
      case "turn.step.started": {
        const turn = turnByAddress.get(address);
        if (turn !== undefined && turn.turnId === event.turnId) turn.stepCount += 1;
        break;
      }
      case "turn.step.retrying": {
        at(address).track("step_retry", {
          turn_id: event.turnId,
          attempt: event.attempt,
          max_attempts: event.maxAttempts,
          delay_ms: event.delayMs,
          reason: event.reason === undefined ? null : capTelemetryText(redactTelemetryString(event.reason), 64),
        });
        break;
      }
      case "message.appended": {
        const turn = turnByAddress.get(address);
        const message = event.message;
        if (turn === undefined || message.role !== "assistant") break;
        turn.input += message.usage.input;
        turn.output += message.usage.output;
        turn.cacheRead += message.usage.cacheRead;
        turn.cacheWrite += message.usage.cacheWrite;
        turn.model = message.model;
        break;
      }
      case "tool.call.started": {
        const turn = turnByAddress.get(address);
        if (turn !== undefined) turn.toolCallCount += 1;
        toolById.set(event.toolCallId, { turnId: turn?.turnId ?? null, startedAt: now() });
        break;
      }
      case "tool.result": {
        const tool = toolById.get(event.toolCallId);
        toolById.delete(event.toolCallId);
        at(address).track("tool_call", {
          turn_id: tool?.turnId ?? turnByAddress.get(address)?.turnId ?? null,
          tool_name: event.toolName,
          outcome: event.isError ? "error" : "success",
          duration_ms: tool === undefined ? 0 : now() - tool.startedAt,
        });
        break;
      }
      case "tool.suspended": {
        at(address).track("tool_suspended", {
          turn_id: toolById.get(event.toolCallId)?.turnId ?? turnByAddress.get(address)?.turnId ?? null,
          tool_name: event.toolName,
          has_request: event.request !== undefined,
        });
        break;
      }
      case "compaction.completed": {
        at(address).track("compaction", {
          before_tokens: event.tokensBefore,
          after_tokens: event.tokensAfter,
          compacted_count: event.compactedCount,
        });
        break;
      }
      case "guardrail.blocked": {
        at(address).track("guardrail_blocked", { stage: event.stage, guardrail: event.guardrail });
        break;
      }
      case "skill.activated": {
        at(address).track("skill_activated", { skill_name: event.skillName, trigger: event.trigger });
        break;
      }
      case "steer.queued": {
        at(address).track("steer_queued", { channel: event.channel, origin: event.origin.kind });
        break;
      }
      case "error": {
        at(address).track("turn_error", {
          turn_id: turnByAddress.get(address)?.turnId ?? null,
          message: capTelemetryText(redactTelemetryString(event.message)),
        });
        break;
      }
      default:
        break;
    }
  };

  const finish = (address: string, turn: TurnState, reason: "completed" | "cancelled" | "failed"): void => {
    at(address).track("turn_finished", {
      turn_id: turn.turnId,
      reason,
      duration_ms: now() - turn.startedAt,
      step_count: turn.stepCount,
      tool_call_count: turn.toolCallCount,
      input_tokens: turn.input,
      output_tokens: turn.output,
      cache_read_tokens: turn.cacheRead,
      cache_write_tokens: turn.cacheWrite,
      model: turn.model,
    });
  };

  return sink.subscribe((event) => {
    try {
      handle(event);
    } catch {
      // A projection bug must never reach the session's event loop.
    }
  });
}
