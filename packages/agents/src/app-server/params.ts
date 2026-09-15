/**
 * Runtime shape of every host → server request and server → host reverse request in
 * `protocol.ts`. That module stays pure types so other languages can mirror it; this one is the
 * TypeScript side's proof that a message read off the wire actually has that shape before a
 * handler touches it. A miss is an `InvalidParams` error that names the field.
 */
import { z } from "zod";
import type { Message, QuestionItem } from "operon-agents-core";
import { ErrorCode, INVOKABLE_METHODS } from "./protocol.ts";
import { RpcError } from "./codec.ts";
import type {
  ClientCancelRequestParams,
  ClientRequestApprovalParams,
  ClientRequestQuestionParams,
  InitializeParams,
  SessionFollowUpParams,
  SessionForkParams,
  SessionInvokeParams,
  SessionNewParams,
  SessionPromptParams,
  SessionRef,
  SessionRespondParams,
  SessionResumeParams,
  SessionSnapshotParams,
  SessionSteerParams,
} from "./protocol.ts";

const sessionRef = { sessionId: z.string().min(1, "sessionId required") };

export const SessionRefSchema = z.object(sessionRef);

export const InitializeParamsSchema = z.object({
  protocolVersion: z.number({ error: "protocolVersion (number) required" }),
  clientInfo: z.object({ name: z.string(), version: z.string().optional() }).optional(),
  clientCapabilities: z.object({ approval: z.boolean().optional(), question: z.boolean().optional() }).optional(),
});

export const SessionNewParamsSchema = z.object({
  workDir: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
});

export const SessionResumeParamsSchema = SessionRefSchema;
export const SessionForkParamsSchema = z.object({ ...sessionRef, title: z.string().optional() });
export const SessionCloseParamsSchema = SessionRefSchema;
export const SessionCancelParamsSchema = SessionRefSchema;

const isMessageLike = (value: unknown): boolean =>
  typeof value === "object" && value !== null && typeof (value as { role?: unknown }).role === "string";

/** `AgentInput`: a prompt string, or a message array whose contents the core validates itself. */
const AgentInputSchema = z.union(
  [z.string(), z.custom<Message[]>((value) => Array.isArray(value) && value.every(isMessageLike))],
  { error: "input must be a string or an array of messages" },
);

export const SessionPromptParamsSchema = z.object({ ...sessionRef, input: AgentInputSchema });

export const SessionSnapshotParamsSchema = z.object({
  ...sessionRef,
  addresses: z.array(z.string()).readonly().optional(),
  maxMessages: z.number().int().nonnegative().optional(),
});

const ApprovalResponseSchema = z.object({
  decision: z.enum(["approved", "rejected", "cancelled"]),
  scope: z.literal("session").optional(),
  feedback: z.string().optional(),
});

export const SessionRespondParamsSchema = z.object({
  ...sessionRef,
  answers: z.record(z.string(), ApprovalResponseSchema),
});

export const SessionSteerParamsSchema = z.object({ ...sessionRef, text: z.string() });
export const SessionFollowUpParamsSchema = z.object({ ...sessionRef, text: z.string() });

export const SessionInvokeParamsSchema = z.object({
  ...sessionRef,
  method: z.string(),
  args: z.array(z.unknown()).readonly().optional(),
});

// ── Reverse-RPC (server → host), validated by the reference client ───────────

export const ClientRequestApprovalParamsSchema = z.object({
  ...sessionRef,
  request: z.looseObject({ toolCallId: z.string(), toolName: z.string(), approvalRule: z.string() }),
});

export const ClientRequestQuestionParamsSchema = z.object({
  ...sessionRef,
  request: z.looseObject({
    turnId: z.string(),
    toolCallId: z.string(),
    questions: z.custom<readonly QuestionItem[]>((value) => Array.isArray(value), "questions must be an array"),
  }),
});

export const ClientCancelRequestParamsSchema = z.object({ id: z.union([z.string(), z.number()]) });

/** Parse `params` against a method's schema; a miss is `InvalidParams` naming the field. */
export function parseParams<S extends z.ZodType>(schema: S, params: unknown): z.output<S> {
  const result = schema.safeParse(params ?? {});
  if (result.success) return result.data;
  throw new RpcError(ErrorCode.InvalidParams, describeIssues(result.error.issues));
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export const INVOKABLE = new Set<string>(INVOKABLE_METHODS);

// The wire types stay hand-written so other languages can mirror them; these pin each schema to
// its type, so a field added to one is a compile error until the other follows.
type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;
export type _Initialize = Assert<Extends<InitializeParams, z.input<typeof InitializeParamsSchema>>>;
export type _SessionNew = Assert<Extends<SessionNewParams, z.input<typeof SessionNewParamsSchema>>>;
export type _SessionResume = Assert<Extends<SessionResumeParams, z.input<typeof SessionResumeParamsSchema>>>;
export type _SessionFork = Assert<Extends<SessionForkParams, z.input<typeof SessionForkParamsSchema>>>;
export type _SessionRef = Assert<Extends<SessionRef, z.input<typeof SessionRefSchema>>>;
export type _SessionPrompt = Assert<Extends<SessionPromptParams, z.input<typeof SessionPromptParamsSchema>>>;
export type _SessionSnapshot = Assert<Extends<SessionSnapshotParams, z.input<typeof SessionSnapshotParamsSchema>>>;
export type _SessionRespond = Assert<Extends<SessionRespondParams, z.input<typeof SessionRespondParamsSchema>>>;
export type _SessionSteer = Assert<Extends<SessionSteerParams, z.input<typeof SessionSteerParamsSchema>>>;
export type _SessionFollowUp = Assert<Extends<SessionFollowUpParams, z.input<typeof SessionFollowUpParamsSchema>>>;
export type _SessionInvoke = Assert<Extends<SessionInvokeParams, z.input<typeof SessionInvokeParamsSchema>>>;
// Reverse requests carry core objects with optional extras, so the check runs output → type.
export type _ClientRequestApproval = Assert<Extends<z.output<typeof ClientRequestApprovalParamsSchema>, ClientRequestApprovalParams>>;
export type _ClientRequestQuestion = Assert<Extends<z.output<typeof ClientRequestQuestionParamsSchema>, ClientRequestQuestionParams>>;
export type _ClientCancelRequest = Assert<Extends<ClientCancelRequestParams, z.input<typeof ClientCancelRequestParamsSchema>>>;
