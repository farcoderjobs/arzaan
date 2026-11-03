import { describe, expect, it } from "vitest";
import type { ISyncOutboxDocument } from "../src/models";
import {
  BACKOFF_SCHEDULE_MS,
  backoffDelayMs,
  isDue,
  newRowKey,
  nextAttemptAt,
  summarise,
} from "../src/lib/sync/backoff";
import { buildPushOperations } from "../src/lib/sync/payload";
import { COLLECTION_POLICY, policyFor, priorityFor, stripForSync } from "../src/lib/sync/policy";
import { describeSyncState } from "../src/lib/sync/status-types";
import type { SyncStatus } from "../src/lib/sync/status-types";
import { LOCAL_MIGRATIONS, LOCAL_SCHEMA_VERSION } from "../src/lib/sync/local-migrations";
import { newClientTransactionId } from "../src/lib/sync/client-ids";
import { newRowKey as uniqueRowKey } from "../src/lib/sync/backoff";

/**
 * Unit coverage for the offline-first pipeline's pure logic.
 *
 * The parts that need a database (applying rows, cursors, migrations) are
 * covered by tests/integration/09-offline-sync.test.ts against the real API.
 */

function outboxRow(overrides: Record<string, unknown> = {}): ISyncOutboxDocument {
  return {
    rowKey: "row-1",
    collectionName: "sales",
    docId: "64b7f9c2e1a2b3c4d5e6f7a8",
    operation: "upsert",
    priority: 70,
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    actorUserId: null,
    branchId: null,
    entityType: "Sale",
    docVersion: new Date("2026-10-01T10:00:00Z"),
    syncedAt: null,
    ...overrides,
  } as unknown as ISyncOutboxDocument;
}

describe("retry backoff", () => {
  it("escalates 30s → 60s → 2m → 5m and stays capped", () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(30_000);
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(backoffDelayMs(3)).toBe(120_000);
    expect(backoffDelayMs(4)).toBe(300_000);
    expect(backoffDelayMs(9)).toBe(300_000);
  });

  it("schedules the next attempt relative to the failure time", () => {
    const failedAt = Date.UTC(2026, 9, 1, 12, 0, 0);
    expect(nextAttemptAt(1, failedAt)).toBe(failedAt + 30_000);
    expect(nextAttemptAt(4, failedAt)).toBe(failedAt + 300_000);
  });

  it("only considers pending rows that are due", () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0);
    expect(isDue({ status: "PENDING", nextAttemptAt: now }, now)).toBe(true);
    expect(isDue({ status: "PENDING", nextAttemptAt: now + 1_000 }, now)).toBe(false);
    expect(isDue({ status: "SENDING", nextAttemptAt: now }, now)).toBe(true);
    // A FAILED row waits for a human — it never auto-retries.
    expect(isDue({ status: "FAILED", nextAttemptAt: 0 }, now)).toBe(false);
    expect(isDue({ status: "SYNCED", nextAttemptAt: 0 }, now)).toBe(false);
  });

  it("summarises a run in operator language", () => {
    expect(summarise({ pushed: 3, failed: 0, conflicted: 0, remaining: 0 })).toBe("3 pushed, 0 pending");
    expect(summarise({ pushed: 2, failed: 1, conflicted: 2, remaining: 5 })).toContain("2 conflicted");
  });
});

describe("idempotency keys", () => {
  it("produces unique replication keys", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newRowKey()));
    expect(keys.size).toBe(200);
  });

  it("produces unique client transaction ids for POS sales", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newClientTransactionId()));
    expect(ids.size).toBe(200);
    expect(uniqueRowKey()).not.toBe(newRowKey());
  });
});

describe("replication policy", () => {
  it("never replicates session or password-reset material", () => {
    const user = {
      _id: "abc",
      email: "cashier@example.com",
      passwordHash: "$2a$10$hash",
      refreshTokenHash: "session",
      passwordResetTokenHash: "reset",
      passwordResetExpires: new Date(),
    };
    const stripped = stripForSync(user, "users");
    expect(stripped.refreshTokenHash).toBeUndefined();
    expect(stripped.passwordResetTokenHash).toBeUndefined();
    expect(stripped.passwordResetExpires).toBeUndefined();
    // Password HASHES travel: a shop must be able to verify an offline login.
    expect(stripped.passwordHash).toBe("$2a$10$hash");
  });

  it("refuses collections outside the replication table", () => {
    expect(policyFor("syncoutboxes")).toBeNull();
    expect(policyFor("sale")).toBeNull();
    expect(stripForSync({ _id: "x" }, "unknown")).toEqual({ _id: "x" });
  });

  it("orders pushes so references land before the records that use them", () => {
    expect(priorityFor("products")).toBeLessThan(priorityFor("inventorymovements"));
    expect(priorityFor("inventorymovements")).toBeLessThan(priorityFor("sales"));
    expect(priorityFor("sales")).toBeLessThan(priorityFor("cashtransactions"));
    expect(priorityFor("unknown-collection")).toBeGreaterThan(priorityFor("auditlogs"));
  });

  it("marks transactional history append-only and reference data center-authoritative", () => {
    expect(COLLECTION_POLICY.sales.appendOnly).toBe(false);
    expect(COLLECTION_POLICY.inventorymovements.appendOnly).toBe(true);
    expect(COLLECTION_POLICY.products.centerAuthoritative).toBe(true);
    expect(COLLECTION_POLICY.sales.centerAuthoritative).toBe(false);
  });
});

describe("push payload building", () => {
  const doc = { _id: "64b7f9c2e1a2b3c4d5e6f7a8", invoiceNumber: "INV-1", total: 10, __v: 3 };

  it("collapses repeated dirty markers for one document into a single operation", async () => {
    const rows = [
      outboxRow({ rowKey: "row-a", createdAt: new Date(1) }),
      outboxRow({ rowKey: "row-b", createdAt: new Date(2) }),
      outboxRow({ rowKey: "row-c", createdAt: new Date(3) }),
    ];
    const result = await buildPushOperations(rows, async () => doc);

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].rowKey).toBe("row-a");
    // Every marker is covered, so one confirmation marks them all synced.
    expect(result.operations[0].rowKeys).toEqual(["row-a", "row-b", "row-c"]);
    expect(result.operations[0].operation).toBe("upsert");
    expect(result.operations[0].doc).not.toHaveProperty("__v");
  });

  it("derives a delete when the document no longer exists", async () => {
    const result = await buildPushOperations([outboxRow()], async () => null);
    expect(result.operations[0].operation).toBe("delete");
    expect(result.operations[0].doc).toBeNull();
  });

  it("strips session fields before a user document ever leaves the shop", async () => {
    const row = outboxRow({
      collectionName: "users",
      entityType: "User",
      docId: "64b7f9c2e1a2b3c4d5e6f7b9",
    });
    const result = await buildPushOperations([row], async () => ({
      _id: "64b7f9c2e1a2b3c4d5e6f7b9",
      name: "Cashier",
      refreshTokenHash: "secret",
    }));
    expect(result.operations[0].doc).not.toHaveProperty("refreshTokenHash");
    expect(result.operations[0].doc?.name).toBe("Cashier");
  });

  it("keeps the acting user so the center can re-authorize the change", async () => {
    const row = outboxRow({ actorUserId: "64b7f9c2e1a2b3c4d5e6f7aa" });
    const result = await buildPushOperations([row], async () => doc);
    expect(result.operations[0].actorUserId).toBe("64b7f9c2e1a2b3c4d5e6f7aa");
  });

  it("reports unsupported collections instead of pushing them", async () => {
    const row = outboxRow({ collectionName: "syncoutboxes", entityType: "SyncOutbox" });
    const result = await buildPushOperations([row], async () => doc);
    expect(result.operations).toHaveLength(0);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0].collection).toBe("syncoutboxes");
  });
});

describe("connection indicator state", () => {
  const base: SyncStatus = {
    role: "shop",
    enabled: true,
    configured: true,
    missing: [],
    nodeId: "shop-1",
    nodeName: "Shop",
    onlineUrl: "https://center.example.com",
    pushEnabled: true,
    pullEnabled: true,
    workerRunning: false,
    transport: "http",
    databaseMode: "local",
    localDatabaseConfigured: true,
    localDb: {
      dbName: "pos",
      topology: "rs0",
      transactionsSupported: true,
      standalone: false,
      checkedAt: "2026-10-01T10:00:00.000Z",
    },
    schemaVersion: LOCAL_SCHEMA_VERSION,
    schemaTargetVersion: LOCAL_SCHEMA_VERSION,
    counts: { pending: 0, sending: 0, failed: 0, synced: 0, conflicts: 0 },
    connectivity: {
      reachable: true,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      pullLastError: null,
    },
    trackingError: null,
    migrationError: null,
    runs: [],
  };

  it("reports unconfigured instead of a false 'offline'", () => {
    expect(describeSyncState(null)).toBe("UNCONFIGURED");
    expect(describeSyncState({ ...base, pushEnabled: false, pullEnabled: false })).toBe("UNCONFIGURED");
  });

  it("treats an unreachable center as offline, with the shop still working", () => {
    expect(
      describeSyncState({
        ...base,
        counts: { pending: 4, sending: 0, failed: 0, synced: 0, conflicts: 0 },
        connectivity: { ...base.connectivity, reachable: false },
      })
    ).toBe("OFFLINE");
  });

  it("shows syncing while a run is active and complete once the queue drains", () => {
    expect(describeSyncState({ ...base, workerRunning: true })).toBe("SYNCING");
    expect(
      describeSyncState({
        ...base,
        counts: { pending: 0, sending: 0, failed: 0, synced: 12, conflicts: 0 },
      })
    ).toBe("SYNC_COMPLETE");
    expect(describeSyncState(base)).toBe("ONLINE");
  });
});

describe("local database migrations", () => {
  it("declares one migration per schema version, in order", () => {
    const versions = LOCAL_MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(Math.max(...versions)).toBe(LOCAL_SCHEMA_VERSION);
  });

  it("describes every migration", () => {
    for (const migration of LOCAL_MIGRATIONS) {
      expect(migration.name.length).toBeGreaterThan(2);
      expect(typeof migration.up).toBe("function");
    }
  });
});
