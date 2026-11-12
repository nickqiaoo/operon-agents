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
import type {
  AgentRef,
  CreateManagedSessionRequest,
  ManagedInputEvent,
  SendManagedEventsRequest,
  UpdateManagedSessionRequest,
} from "../protocol/types.ts";
import { ManagedInvalidRequestError } from "./errors.ts";

const nonBlank = (what: string) => z.string().refine((value) => value.trim().length > 0, `${what} must not be empty`);

/** `AgentRef | string` on the wire, always an `AgentRef` once parsed. */
export const AgentRefSchema = z.union([
  nonBlank("agent id").transform((id): AgentRef => ({ id })),
  z.object({ type: z.literal("agent").optional(), id: nonBlank("agent id"), version: z.string().optional() })
    .transform(({ type: _type, ...ref }): AgentRef => ref),
], { error: "agent must be an id string or an object with a non-empty id" });

const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() }).strict();

const UserMessageSchema = z.object({
  type: z.literal("user.message"),
  content: z.array(TextBlockSchema).min(1).readonly()
    .refine((blocks) => blocks.some((block) => block.text.trim().length > 0), "content must contain some text"),
}).strict();

export const ManagedInputEventSchema = z.discriminatedUnion("type", [
  UserMessageSchema,
  z.object({ type: z.literal("user.interrupt") }).strict(),
  z.object({
    type: z.literal("user.tool_confirmation"),
    tool_use_id: nonBlank("tool_use_id"),
    result: z.enum(["allow", "deny"]),
    deny_message: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("user.custom_tool_result"),
    custom_tool_use_id: nonBlank("custom_tool_use_id"),
    content: z.array(TextBlockSchema).readonly(),
    is_error: z.boolean().optional(),
  }).strict(),
], { error: "type must be one of user.message, user.interrupt, user.tool_confirmation, user.custom_tool_result" });

export const SendEventsRequestSchema = z.object({
  events: z.array(ManagedInputEventSchema).min(1, "events must not be empty").max(50).readonly(),
}).strict();

export const CreateSessionRequestSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "session id may contain only letters, digits, underscores and hyphens").optional(),
  title: z.string().optional(),
  agent: AgentRefSchema,
  environment_id: nonBlank("environment_id"),
  initial_events: z.array(UserMessageSchema).max(50).readonly().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const UpdateSessionRequestSchema = z.object({
  title: nonBlank("title").optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

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
export type _SendEventsInput = Assert<Extends<SendManagedEventsRequest, z.input<typeof SendEventsRequestSchema>>>;
export type _InputEventOutput = Assert<Extends<z.output<typeof ManagedInputEventSchema>, ManagedInputEvent>>;
