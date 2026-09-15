/**
 * Wire-side validation for what the managed API accepts. The `protocol/types.ts` interfaces are
 * what a client compiles against; these schemas are what the server holds a request body to
 * before it touches the store. They are kept together so a field added to one shows up as a
 * type error in the other (see the `satisfies` checks at the bottom).
 *
 * Bodies arrive as `unknown` from JSON: every rule about them lives here, and nowhere else,
 * so a rejected request always names the field that failed.
 */
import { z } from "zod";
import type { InterruptAnswer } from "operon-agents";
import type {
  AgentRef,
  CreateManagedMessageRequest,
  CreateManagedSessionRequest,
  EnvironmentRef,
  ResumeManagedSessionRequest,
  UpdateManagedSessionRequest,
} from "../protocol/types.ts";
import { ManagedInvalidRequestError } from "./errors.ts";

const nonBlank = (what: string) => z.string().refine((value) => value.trim().length > 0, `${what} must not be empty`);

/** `AgentRef | string` on the wire, always an `AgentRef` once parsed. */
export const AgentRefSchema = z.union([
  nonBlank("agent id").transform((id): AgentRef => ({ id })),
  z.object({ id: nonBlank("agent id"), version: z.string().optional() }),
], { error: "agent must be an id string or an object with a non-empty id" });

/** `EnvironmentRef | string` on the wire, always an `EnvironmentRef` once parsed. */
export const EnvironmentRefSchema = z.union([
  nonBlank("environment id").transform((id): EnvironmentRef => ({ id })),
  z.object({ id: nonBlank("environment id") }),
], { error: "environment must be an id string or an object with a non-empty id" });

export const CreateSessionRequestSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "session id may contain only letters, digits, underscores and hyphens").optional(),
  title: z.string().optional(),
  agent: AgentRefSchema,
  environment: EnvironmentRefSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateSessionRequestSchema = z.object({
  title: nonBlank("title"),
});

const ExternalMetadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()], {
  error: "metadata values must be strings, numbers, booleans or null",
});

export const CreateMessageRequestSchema = z.object({
  input: nonBlank("input"),
  origin: z.enum(["user", "external"]).optional(),
  source: nonBlank("source").optional(),
  actor: z.string().optional(),
  metadata: z.record(z.string(), ExternalMetadataValueSchema).optional(),
  mode: z.enum(["steer", "follow_up"]).optional(),
}).check((ctx) => {
  const { origin, source, actor, metadata } = ctx.value;
  if (origin !== "external" && (source !== undefined || actor !== undefined || metadata !== undefined)) {
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      message: 'source, actor and metadata describe a relayed delivery; set origin: "external"',
    });
  }
});

const ApprovalResponseShape = {
  decision: z.enum(["approved", "rejected", "cancelled"]),
  scope: z.literal("session").optional(),
  feedback: z.string().optional(),
};

/**
 * One answer per pending interrupt. A bare `ApprovalResponse` (no `kind`) is accepted the way
 * `HarnessSession.resume` accepts it, and normalised to the tagged form before it is journaled.
 */
export const InterruptAnswerSchema = z.union([
  z.object({ kind: z.literal("approval"), ...ApprovalResponseShape }),
  z.object({ kind: z.literal("input"), data: z.unknown() }),
  z.object({ kind: z.undefined().optional(), ...ApprovalResponseShape }).transform(
    ({ kind: _kind, ...response }): InterruptAnswer => ({ kind: "approval", ...response }),
  ),
], { error: 'an answer is { kind: "approval", decision } or { kind: "input", data }' });

export const InterruptAnswersSchema = z.record(z.string(), InterruptAnswerSchema);

export const ResumeSessionRequestSchema = z.object({
  answers: InterruptAnswersSchema,
});

/** Parse a request body, turning schema issues into a 400 that names the offending field. */
export function parseRequest<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ManagedInvalidRequestError(describeIssues(result.error.issues));
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

// The wire types stay hand-written for clients; these pin the schemas to them in both directions.
type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;
export type _CreateSessionInput = Assert<Extends<CreateManagedSessionRequest, z.input<typeof CreateSessionRequestSchema>>>;
export type _UpdateSessionInput = Assert<Extends<UpdateManagedSessionRequest, z.input<typeof UpdateSessionRequestSchema>>>;
export type _CreateMessageInput = Assert<Extends<CreateManagedMessageRequest, z.input<typeof CreateMessageRequestSchema>>>;
export type _CreateMessageOutput = Assert<Extends<z.output<typeof CreateMessageRequestSchema>, CreateManagedMessageRequest>>;
export type _ResumeInput = Assert<Extends<ResumeManagedSessionRequest, z.input<typeof ResumeSessionRequestSchema>>>;
export type _InterruptAnswerOutput = Assert<Extends<z.output<typeof InterruptAnswerSchema>, InterruptAnswer>>;
