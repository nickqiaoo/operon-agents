import type { AgentRecord } from "./store.ts";

/**
 * Wire protocol version for the on-disk record log. Bump this whenever `AgentRecordBody`'s
 * persisted shape changes, and register a migration for the previous version in
 * `RECORD_MIGRATIONS` below.
 *
 * Version 1 introduced the linear `AgentRecord` format. Version 2 adds
 * durable handoff linkage and seed provenance without invalidating version-1 records.
 */
export const WIRE_PROTOCOL_VERSION = 2;

/** KV state key under which a session stamps the version its log was written at. */
export const WIRE_VERSION_KEY = "wire_version";

/**
 * Upgrades a raw record from version N to version N+1, keyed by the SOURCE version N.
 * Returning `null` DROPS the record (for a record that has no place in the new format).
 */
export type RecordMigration = (raw: Record<string, unknown>) => Record<string, unknown> | null;

/** Version 2 adds durable handoff linkage/provenance; every version-1 record remains valid. */
export const RECORD_MIGRATIONS: Readonly<Record<number, RecordMigration>> = {
  1: (raw) => raw,
};

/**
 * Apply the migration chain to bring a raw record from `fromVersion` up to `toVersion`.
 * Returns `null` if a migration dropped the record. `registry`/`toVersion` are injectable
 * for tests.
 */
export function migrateRecord(
  raw: unknown,
  fromVersion: number,
  registry: Record<number, RecordMigration> = RECORD_MIGRATIONS,
  toVersion: number = WIRE_PROTOCOL_VERSION,
): AgentRecord | null {
  let current: Record<string, unknown> | null = raw as Record<string, unknown>;
  for (let v = fromVersion; v < toVersion; v++) {
    if (current === null) return null;
    const migration = registry[v];
    if (migration !== undefined) current = migration(current);
  }
  return current as unknown as AgentRecord | null;
}
