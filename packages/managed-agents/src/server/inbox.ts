/**
 * The inbox: what a session has been asked to do that no turn has dealt with yet.
 *
 * It is not a table. It is a READ of the session log — every `inbox.received` and every
 * control record after the worker's cursor — which is what makes it impossible to lose: the
 * log is the only thing a delivery writes, so there is no second place for the two to disagree.
 * Queues, pending marks and wake-up signals are indexes over this read, never the truth of it.
 *
 * Shared by the two things that need the same answer to "is there work here?": the worker (to
 * do it) and the service (to tell a watching client nobody is doing it). One definition, so
 * they can never disagree on what counts. The work table's `woken` flag is an index over this
 * read — set by the same write that creates an item, cleared by a holder about to read — never
 * the truth of it.
 */
import type { AgentRecord, InboxOrigin, InterruptAnswer, SessionStore } from "operon-agents";

/** Where processing stopped. Everything at or before it has been dealt with. */
export const INBOX_CURSOR_KEY = "inbox:cursor";

/**
 * Control records ride the log as `custom` records under this name. The log's record
 * vocabulary is the framework's; the managed layer's commands are its own, and `custom` is the
 * extension point the framework left for exactly that.
 */
export const CONTROL_RECORD_NAME = "managed.control";

export type ControlCommand =
  | {
      readonly kind: "cancel";
      /** Idempotency identity, the way `deliveryId` is for an input. */
      readonly commandId: string;
      readonly requestedAt: number;
      readonly actor?: string;
    }
  | {
      readonly kind: "resume";
      readonly commandId: string;
      readonly requestedAt: number;
      readonly answers: Readonly<Record<string, InterruptAnswer>>;
      readonly actor?: string;
    };

export interface InboxInput {
  readonly kind: "input";
  readonly sequence: string;
  readonly input: string;
  /** Whose words: the session's user (`user`) or a relayed party (`external`). */
  readonly origin: InboxOrigin;
  readonly mode: "auto" | "steer" | "follow_up";
}

export interface InboxControl {
  readonly kind: "control";
  readonly sequence: string;
  readonly command: ControlCommand;
}

export type InboxItem = InboxInput | InboxControl;

/** The identity an item is tracked by once dispatched: `deliveryId` or `commandId`. */
export function inboxItemId(item: InboxItem): string {
  return item.kind === "input" ? item.origin.deliveryId : item.command.commandId;
}

export async function readInboxCursor(store: SessionStore): Promise<string | undefined> {
  const raw = await store.getState(INBOX_CURSOR_KEY);
  return typeof raw === "string" ? raw : undefined;
}

/** Inbox records after `cursor`, in log order, excluding sequences in `exclude`. */
export async function readInbox(
  store: SessionStore,
  cursor: string | undefined,
  exclude: ReadonlySet<string> = new Set(),
): Promise<readonly InboxItem[]> {
  const page = await store.readRecordPage({
    limit: 128,
    ...(cursor !== undefined ? { after: cursor } : {}),
    address: "main",
  });
  const items: InboxItem[] = [];
  for (const stored of page.data) {
    if (exclude.has(stored.sequence)) continue;
    const item = inboxItemFromRecord(stored.sequence, stored.record as AgentRecord);
    if (item !== undefined) items.push(item);
  }
  return items;
}

/** Is there anything after the cursor a worker would act on? */
export async function hasUnprocessedInbox(store: SessionStore): Promise<boolean> {
  return (await readInbox(store, await readInboxCursor(store))).length > 0;
}

function inboxItemFromRecord(sequence: string, record: AgentRecord): InboxItem | undefined {
  if (record.type === "inbox.received") {
    return { kind: "input", sequence, input: record.input, origin: record.origin, mode: record.mode };
  }
  if (record.type === "custom" && record.name === CONTROL_RECORD_NAME) {
    const command = parseControlCommand(record.data);
    return command === undefined ? undefined : { kind: "control", sequence, command };
  }
  return undefined;
}

/**
 * Tolerant on purpose: a record this version does not understand is skipped, not fatal. A
 * newer API node may write a command an older worker has not learned yet, and refusing to
 * drain the whole session over it would strand every input behind it.
 */
function parseControlCommand(data: unknown): ControlCommand | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const raw = data as Record<string, unknown>;
  if (typeof raw["commandId"] !== "string" || typeof raw["requestedAt"] !== "number") return undefined;
  const base = {
    commandId: raw["commandId"],
    requestedAt: raw["requestedAt"],
    ...(typeof raw["actor"] === "string" ? { actor: raw["actor"] } : {}),
  };
  if (raw["kind"] === "cancel") return { kind: "cancel", ...base };
  if (raw["kind"] === "resume" && typeof raw["answers"] === "object" && raw["answers"] !== null) {
    return { kind: "resume", ...base, answers: raw["answers"] as Readonly<Record<string, InterruptAnswer>> };
  }
  return undefined;
}
