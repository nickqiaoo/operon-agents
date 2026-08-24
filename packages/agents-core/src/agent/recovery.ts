import type { LlmRequest } from "../llm/model.ts";
import type { AssistantMessage, Message, ToolCall } from "../protocol/index.ts";
import type { AgentRecord, SessionStore } from "../store/index.ts";
import type { BackgroundTaskInfo } from "../capabilities/background/task.ts";
import type { RunState } from "./runner.ts";

const SUBAGENT_META = "subagent_meta";
const WORKFLOW_JOURNAL = "wf_journal";

interface RecoveredAgent {
  readonly agentId: string;
  readonly type: string;
  readonly address: string;
}

interface RecoveredWorkflow {
  readonly runId: string;
  readonly address: string;
  readonly status?: string;
}

/**
 * Add request-only recovery context for the final assistant batch when some tool calls have no
 * durable result. Pi still owns protocol repair (one synthetic error tool result per missing
 * call); this hook only tells the model which real execution identities survived the crash.
 * Nothing here is appended to ConversationContext or SessionStore.
 */
export async function withToolCallRecoveryContext<TContext>(
  state: RunState<TContext>,
  request: LlmRequest,
): Promise<LlmRequest> {
  const unresolved = unresolvedTailCalls(request.messages);
  if (unresolved.length === 0) return request;

  const background = new Map<string, BackgroundTaskInfo>();
  for (const call of unresolved) {
    const task = findBackgroundByOrigin(state.background, state.address, call.id);
    if (task !== undefined) background.set(call.id, task);
  }

  const unresolvedWithoutTask = unresolved.filter((call) => !background.has(call.id));
  const durable = state.store === undefined
    ? { agents: new Map<string, RecoveredAgent>(), workflows: new Map<string, RecoveredWorkflow>() }
    : await findDurableExecutions(state.store, state.address, new Set(unresolvedWithoutTask.map((call) => call.id)));

  const lines = [
    "Recovery context: the previous process ended with an unresolved assistant tool-call batch.",
    "Pi will supply a synthetic error tool result for each missing result so the conversation can continue. Those synthetic results do not prove that execution never started; treat every call below independently.",
  ];
  for (const call of unresolved) {
    lines.push("", `- tool_call_id: ${call.id}`, `  tool: ${call.name}`);
    const task = background.get(call.id);
    if (task !== undefined) {
      lines.push(
        `  recovered_task_id: ${task.taskId}`,
        `  task_kind: ${task.kind}`,
        `  persisted_status: ${task.status}`,
        `  action: Inspect it with BackgroundOutput(task_id=\"${task.taskId}\", block=false) before retrying or resuming anything.`,
      );
      continue;
    }
    const agent = durable.agents.get(call.id);
    if (agent !== undefined) {
      lines.push(
        `  recovered_agent_id: ${agent.agentId}`,
        `  subagent_type: ${agent.type}`,
        `  action: Continue the same durable subagent with Agent(resume=\"${agent.agentId}\", prompt=...). Do not spawn a replacement unless continuation fails.`,
      );
      continue;
    }
    const workflow = durable.workflows.get(call.id);
    if (workflow !== undefined) {
      lines.push(
        `  recovered_run_id: ${workflow.runId}`,
        ...(workflow.status !== undefined ? [`  journal_status: ${workflow.status}`] : []),
        `  action: Continue the same journaled run with Workflow(resumeFromRunId=\"${workflow.runId}\").`,
      );
      continue;
    }
    lines.push("  recovered_execution: none", "  action: Execution status is unknown. Inspect likely side effects before deciding whether retrying is safe.");
  }

  const reminder = lines.join("\n");
  return {
    ...request,
    system: request.system === undefined || request.system.length === 0
      ? reminder
      : `${request.system}\n\n${reminder}`,
  };
}

function findBackgroundByOrigin(value: unknown, parentAddress: string, toolCallId: string): BackgroundTaskInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const lookup = (value as { findByOrigin?: unknown }).findByOrigin;
  if (typeof lookup !== "function") return undefined;
  return lookup.call(value, parentAddress, toolCallId) as BackgroundTaskInfo | undefined;
}

/** Calls in the last assistant message minus every real tool result recorded after it. */
function unresolvedTailCalls(messages: readonly Message[]): ToolCall[] {
  let assistantIndex = -1;
  let assistant: AssistantMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    assistantIndex = i;
    assistant = message;
    break;
  }
  if (assistant === undefined) return [];
  const calls = assistant.content.filter((part): part is ToolCall => part.type === "toolCall");
  if (calls.length === 0) return [];
  const completed = new Set<string>();
  for (let i = assistantIndex + 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant") break;
    if (message.role === "toolResult") completed.add(message.toolCallId);
  }
  return calls.filter((call) => !completed.has(call.id));
}

async function findDurableExecutions(
  store: SessionStore,
  parentAddress: string,
  wanted: ReadonlySet<string>,
): Promise<{ agents: Map<string, RecoveredAgent>; workflows: Map<string, RecoveredWorkflow> }> {
  const agents = new Map<string, RecoveredAgent>();
  const workflows = new Map<string, RecoveredWorkflow>();
  const workflowOutcomes = new Map<string, string>();
  if (wanted.size === 0) return { agents, workflows };

  for await (const record of store.readRecords()) {
    if (record.type !== "custom") continue;
    if (record.name === SUBAGENT_META) {
      const data = objectData(record);
      const callId = stringField(data, "parentToolCallId");
      if (
        callId !== undefined &&
        wanted.has(callId) &&
        stringField(data, "parentAddress") === parentAddress
      ) {
        const agentId = stringField(data, "agentId");
        const type = stringField(data, "type");
        if (agentId !== undefined && type !== undefined) {
          agents.set(callId, { agentId, type, address: record.address ?? "main" });
        }
      }
      continue;
    }
    if (record.name !== WORKFLOW_JOURNAL) continue;
    const data = objectData(record);
    const type = stringField(data, "type");
    if (type === "outcome") {
      const status = stringField(data, "status");
      if (status !== undefined) workflowOutcomes.set(record.address ?? "", status);
      continue;
    }
    if (type !== "run") continue;
    const callId = stringField(data, "parentToolCallId");
    if (
      callId === undefined ||
      !wanted.has(callId) ||
      stringField(data, "parentAddress") !== parentAddress
    ) continue;
    const runId = stringField(data, "runId");
    if (runId !== undefined) workflows.set(callId, { runId, address: record.address ?? "" });
  }

  // Outcome records follow their run record in the same workflow shard. Apply them after the
  // full scan so ordering across store backends does not matter.
  for (const [callId, workflow] of workflows) {
    const status = workflowOutcomes.get(workflow.address);
    if (status !== undefined) workflows.set(callId, { ...workflow, status });
  }
  return { agents, workflows };
}

function objectData(record: Extract<AgentRecord, { type: "custom" }>): Record<string, unknown> {
  return typeof record.data === "object" && record.data !== null
    ? record.data as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
