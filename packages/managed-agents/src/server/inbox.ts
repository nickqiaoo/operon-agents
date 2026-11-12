/**
 * The inbox: events a client sent that no worker has dealt with yet.
 *
 * It belongs to the managed layer alone. The API persists what the client sent, in the client's
 * vocabulary, and nothing else; it never writes into the framework's journal and never shapes a
 * record the runtime would recognise. A worker holding the session pulls the inbox and hands
 * each entry to the Harness through its public interface (`steerTo`, `respond`, `cancel`).
 *
 * An entry stays pending until it is PROCESSED, which is decided by its kind:
 *  - `user.message`: once it is in the conversation (a `message.appended` carrying its id as
 *    `origin.steerId`), or once the runtime dropped it (`steer.discarded`). Being pulled, or
 *    being on the Harness's in-memory queue, is not enough — a worker can die holding either.
 *  - `user.interrupt`: once the run it stopped has settled. Messages accepted before it that
 *    never reached the conversation are processed with it: an interrupt cancels what was queued.
 *  - `user.tool_confirmation` / `user.custom_tool_result`: once the resumed run settles, or at
 *    once when the session is no longer waiting on that call.
 */
import type { ManagedInputResource } from "../protocol/types.ts";

export interface InboxEntry {
  readonly event: ManagedInputResource;
  /** When the API accepted it, epoch ms. Bounds how far back recovery looks for it. */
  readonly acceptedAt: number;
}
