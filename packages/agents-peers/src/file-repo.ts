/**
 * Local-first durable repo: two JSON files in a directory the host owns.
 *
 * - `mailbox.json` — messages in flight (the crash window `reconcile()` walks)
 * - `cards.json`   — team labels + type/description cards (what makes parked teammates wakeable)
 * - stats stay in memory on purpose — see `MemoryPeerStatsStore` for why
 *
 * Atomicity is per PROCESS: every mutation runs on a per-file promise chain (load → apply →
 * write tmp → rename), so concurrent calls inside one process serialize and a crash mid-write
 * leaves the previous file intact. It is NOT safe for two processes to share the directory —
 * a multi-process deployment implements `PeerRepo` on a store with real cross-process atomicity
 * (PG, Redis) instead.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PeerCard, PeerCardStore } from "./directory.ts";
import type { PeerMailbox, PeerMessage } from "./mailbox.ts";
import { MemoryPeerStatsStore } from "./stats.ts";
import type { PeerRepo } from "./repo.ts";

/** One JSON file holding a `Record<string, T>`, all access serialized on a promise chain. */
class JsonBook<T> {
  private chain: Promise<unknown> = Promise.resolve();
  private book: Record<string, T> | undefined;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private async load(): Promise<Record<string, T>> {
    if (this.book !== undefined) return this.book;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.book = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
    } catch {
      this.book = {};
    }
    return this.book;
  }

  /** Read-only access still goes through the chain, so it never observes a half-applied mutation. */
  read<R>(fn: (book: Record<string, T>) => R): Promise<R> {
    return this.run(async () => fn(await this.load()));
  }

  mutate<R>(fn: (book: Record<string, T>) => R): Promise<R> {
    return this.run(async () => {
      const book = await this.load();
      const result = fn(book);
      await mkdir(join(this.path, ".."), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(book, null, 2), "utf8");
      await rename(tmp, this.path);
      return result;
    });
  }

  private run<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.chain.then(fn);
    // Keep the chain alive even when one operation rejects.
    this.chain = next.catch(() => undefined);
    return next;
  }
}

class FilePeerMailbox implements PeerMailbox {
  private readonly file: JsonBook<PeerMessage[]>;

  constructor(path: string) {
    this.file = new JsonBook(path);
  }

  enqueue(message: PeerMessage, opts?: { readonly capacity?: number }): Promise<{ readonly accepted: boolean }> {
    return this.file.mutate((book) => {
      const queue = book[message.to] ?? [];
      if (opts?.capacity !== undefined && queue.length >= opts.capacity) return { accepted: false };
      queue.push(message);
      book[message.to] = queue;
      return { accepted: true };
    });
  }

  pending(agentId: string): Promise<readonly PeerMessage[]> {
    return this.file.read((book) => [...(book[agentId] ?? [])]);
  }

  settle(agentId: string, messageId: string): Promise<void> {
    return this.file.mutate((book) => {
      const queue = book[agentId];
      if (queue === undefined) return;
      const next = queue.filter((message) => message.messageId !== messageId);
      if (next.length === 0) delete book[agentId];
      else book[agentId] = next;
    });
  }

  pendingRecipients(): Promise<readonly string[]> {
    return this.file.read((book) => Object.keys(book));
  }
}

class FilePeerCardStore implements PeerCardStore {
  private readonly file: JsonBook<PeerCard>;

  constructor(path: string) {
    this.file = new JsonBook(path);
  }

  put(agentId: string, card: PeerCard): Promise<void> {
    return this.file.mutate((book) => {
      book[agentId] = card;
    });
  }

  remove(agentId: string): Promise<void> {
    return this.file.mutate((book) => {
      delete book[agentId];
    });
  }

  list(): Promise<ReadonlyArray<{ readonly agentId: string; readonly card: PeerCard }>> {
    return this.file.read((book) => Object.entries(book).map(([agentId, card]) => ({ agentId, card })));
  }
}

export function createFilePeerRepo(dir: string): PeerRepo {
  return {
    mailbox: new FilePeerMailbox(join(dir, "mailbox.json")),
    cards: new FilePeerCardStore(join(dir, "cards.json")),
    stats: new MemoryPeerStatsStore(),
  };
}
