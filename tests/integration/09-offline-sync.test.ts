import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import {
  InventoryMovement,
  Product,
  Sale,
  SyncConflict,
  SyncNode,
  SyncOutbox,
  SyncRun,
} from "../../src/models";
import { hashNodeKey } from "../../src/lib/sync/node-auth";
import { MIN_ROW_AGE_MS, markDirty, outboxCounts } from "../../src/lib/sync/outbox";
import { pushOutbox } from "../../src/lib/sync/push";
import { applyDeltas, pullFromCenter } from "../../src/lib/sync/pull";
import { LOCAL_SCHEMA_VERSION, localSchemaVersion, runLocalMigrations } from "../../src/lib/sync/local-migrations";
import {
  ACCOUNTS,
  BASE_URL,
  api,
  authFor,
  checkoutPayload,
  connectDb,
  createProduct,
  createSupplier,
  dbStock,
  openRegister,
  purgeTag,
  receiveStock,
  tag,
  type AuthCtx,
} from "../helpers/qa";

/**
 * Offline-first node ↔ center synchronization.
 *
 * The shop node owns its local MongoDB — the database this suite talks to — so
 * "the center" here is the same QA server acting in the center role, through its
 * real `/api/sync/push` and `/api/sync/pull` handlers. That exercises the whole
 * path: node outbox → HTTP → node authentication → per-row authorization →
 * application → confirmation → node-side bookkeeping.
 */

/** The worker refuses to push rows younger than its commit-grace window. */
const NODE_WAIT = MIN_ROW_AGE_MS + 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dirty markers are queued by mongoose post hooks and the outbox write is
 * deliberately fire-and-forget (a tracking failure must never fail the business
 * write), so it can land a few milliseconds AFTER the HTTP response. Polling is
 * the only deterministic way to observe it; it does not weaken the assertions.
 */
async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(25);
    value = await read();
  }
  return value;
}

function pendingRows(docId: string) {
  return SyncOutbox.countDocuments({ docId, status: { $in: ["PENDING", "SENDING", "FAILED"] } });
}

let admin: AuthCtx;
let cashier: AuthCtx;
/** A role with no sales.* permission at all — used for the denial cases. */
let accountant: AuthCtx;
let runTag = "";
const touchedDocIds = new Set<string>();
const nodeIds = new Set<string>();

const url = (path: string) => `${BASE_URL}${path}`;

async function push(rows: unknown[], nodeKey: string, nodeId: string) {
  const res = await fetch(url("/api/sync/push"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sync-node-id": nodeId,
      "x-sync-node-key": nodeKey,
    },
    body: JSON.stringify({ rows }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function registerNode(nodeId: string): Promise<string> {
  const res = await api(admin.token).post("/api/sync/nodes", {
    nodeId,
    name: `QA node ${nodeId}`,
    rotate: true,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`registerNode failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  nodeIds.add(nodeId);
  return res.body.data.key as string;
}

async function rowPayload(options: {
  rowKey?: string;
  collection: string;
  docId: string;
  actorUserId: string | null;
  operation?: "upsert" | "delete";
  doc?: Record<string, unknown> | null;
  docVersion?: string;
}) {
  return {
    rowKey: options.rowKey ?? `qa-row-${tag("k")}`,
    collection: options.collection,
    docId: options.docId,
    operation: options.operation ?? "upsert",
    entityType: options.collection,
    actorUserId: options.actorUserId,
    branchId: null,
    docVersion: options.docVersion ?? new Date().toISOString(),
    doc: options.doc ?? null,
  };
}

const rowsFor = (docId: string) => SyncOutbox.find({ docId }).lean();

/** Points this process at the running QA server as if it were the shop node. */
async function withNodeEnv<T>(
  node: { id: string; key: string; onlineUrl?: string },
  fn: () => Promise<T>
): Promise<T> {
  const previous = {
    SYNC_ONLINE_URL: process.env.SYNC_ONLINE_URL,
    SYNC_NODE_ID: process.env.SYNC_NODE_ID,
    SYNC_NODE_KEY: process.env.SYNC_NODE_KEY,
    SYNC_ENABLED: process.env.SYNC_ENABLED,
  };
  process.env.SYNC_ONLINE_URL = node.onlineUrl ?? BASE_URL;
  process.env.SYNC_NODE_ID = node.id;
  process.env.SYNC_NODE_KEY = node.key;
  process.env.SYNC_ENABLED = "true";
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Drains the queue the way the background worker would. */
async function drain(): Promise<number> {
  let pushed = 0;
  for (let round = 0; round < 25; round += 1) {
    const summary = await pushOutbox({ force: true });
    if (summary.pushed === 0) break;
    pushed += summary.pushed;
  }
  return pushed;
}

beforeAll(async () => {
  await connectDb();
  runTag = tag("qa-sync");
  [admin, cashier, accountant] = await Promise.all([
    authFor(ACCOUNTS.admin),
    authFor(ACCOUNTS.cashier),
    authFor(ACCOUNTS.accountant),
  ]);
});

afterAll(async () => {
  await connectDb();
  await SyncOutbox.deleteMany({ docId: { $in: [...touchedDocIds] } });
  await SyncConflict.deleteMany({ docId: { $in: [...touchedDocIds] } });
  await SyncNode.deleteMany({ nodeId: { $in: [...nodeIds] } });
  await SyncRun.deleteMany({ nodeId: { $in: [...nodeIds] } });
  await purgeTag(runTag);
});

describe("local-first sale capture", () => {
  it("records the sale in the local database and queues it for the center", async () => {
    const product = await createProduct(admin.token, { tag: `${runTag}-sale` });
    touchedDocIds.add(product._id);
    await receiveStock(admin.token, {
      supplierId: (await createSupplier(admin.token))._id,
      productId: product._id,
      quantity: 5,
    });
    await openRegister(cashier.token, 0);

    const clientTransactionId = `qa-ctx-${runTag}-1`;
    const res = await api(cashier.token).post(
      "/api/sales",
      checkoutPayload({
        items: [{ productId: product._id, quantity: 1 }],
        payments: [{ method: "cash", amount: 20 }],
        clientTransactionId,
      })
    );
    expect(res.status).toBe(201);
    const saleId = res.body.data.id as string;
    touchedDocIds.add(saleId);

    const sale = await Sale.findById(saleId).lean();
    expect(sale).not.toBeNull();
    expect(String(sale?.clientTransactionId)).toBe(clientTransactionId);

    // Durable locally AND dirty for replication, with the acting user recorded
    // so the center can re-check their permissions.
    const rows = await rowsFor(saleId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "PENDING")).toBe(true);
    expect(String(rows[0].actorUserId)).toBe(cashier.userId);
    expect(rows[0].collectionName).toBe("sales");

    // The stock movement is queued too, so the center's ledger stays complete.
    const movement = await InventoryMovement.findOne({ referenceId: saleId, movementType: "SALE_OUT" }).lean();
    expect(movement).not.toBeNull();
    const movementRows = await rowsFor(String(movement?._id));
    expect(movementRows.length).toBeGreaterThan(0);
    expect(movementRows[0].collectionName).toBe("inventorymovements");
  });

  it("never creates a second sale or stock deduction when the same transaction is resent", async () => {
    const product = await createProduct(admin.token, { tag: `${runTag}-idem` });
    touchedDocIds.add(product._id);
    await receiveStock(admin.token, {
      supplierId: (await createSupplier(admin.token))._id,
      productId: product._id,
      quantity: 3,
    });
    await openRegister(cashier.token, 0);

    const clientTransactionId = `qa-ctx-${runTag}-2`;
    const payload = checkoutPayload({
      items: [{ productId: product._id, quantity: 2 }],
      payments: [{ method: "cash", amount: 40 }],
      clientTransactionId,
    });

    const first = await api(cashier.token).post("/api/sales", payload);
    expect(first.status).toBe(201);
    touchedDocIds.add(first.body.data.id);

    // A lost response, a refresh or an impatient double-click resends it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await api(cashier.token).post("/api/sales", payload);
      expect(replay.status).toBe(200);
      expect(replay.body.alreadySynced).toBe(true);
      expect(replay.body.data.id).toBe(first.body.data.id);
    }

    expect(await Sale.countDocuments({ clientTransactionId })).toBe(1);
    expect(await dbStock(product._id)).toBe(1);
  });

  it("requires a session to read the node's sync state", async () => {
    const res = await fetch(url("/api/sync/status"));
    expect(res.status).toBe(401);
  });
});

describe("center ingestion", () => {
  it("rejects push without valid node credentials", async () => {
    const anonymous = await push([], "irrelevant", "missing-node");
    expect(anonymous.status).toBe(401);

    const nodeId = `${runTag}-auth`;
    await registerNode(nodeId);
    const wrongKey = await push(
      [{ rowKey: "qa-row-aaaaaaaa", collection: "products", docId: "64b7f9c2e1a2b3c4d5e6f7a8", operation: "delete" }],
      "not-the-key",
      nodeId
    );
    expect(wrongKey.status).toBe(401);
  });

  it("refuses a malformed batch", async () => {
    const nodeId = `${runTag}-bad`;
    const key = await registerNode(nodeId);
    const res = await push([{ rowKey: "x" }], key, nodeId);
    expect(res.status).toBe(400);
  });

  it("applies a reference-data change once and reports the replay as a duplicate", async () => {
    const nodeId = `${runTag}-apply`;
    const key = await registerNode(nodeId);
    const product = await createProduct(admin.token, { tag: `${runTag}-apply` });
    touchedDocIds.add(product._id);

    const current = (await Product.findById(product._id).lean()) as unknown as Record<string, unknown>;
    const row = await rowPayload({
      collection: "products",
      docId: product._id,
      actorUserId: admin.userId,
      doc: { ...current, name: `Renamed ${runTag}` },
    });

    const first = await push([row], key, nodeId);
    expect(first.status).toBe(200);
    expect(first.body.data.results[0]).toMatchObject({ rowKey: row.rowKey, status: "applied" });
    expect((await Product.findById(product._id).lean())?.name).toBe(`Renamed ${runTag}`);

    const replay = await push([row], key, nodeId);
    expect(replay.body.data.results[0]).toMatchObject({ status: "duplicate" });
    expect((await Product.findById(product._id).lean())?.name).toBe(`Renamed ${runTag}`);
  });

  it("re-authorizes the acting user instead of trusting the shop's cached permissions", async () => {
    const nodeId = `${runTag}-perm`;
    const key = await registerNode(nodeId);
    const product = await createProduct(admin.token, { tag: `${runTag}-perm` });
    touchedDocIds.add(product._id);
    const current = (await Product.findById(product._id).lean()) as unknown as Record<string, unknown>;

    const asCashier = await push(
      [
        await rowPayload({
          collection: "products",
          docId: product._id,
          actorUserId: cashier.userId,
          doc: { ...current, name: "Cashier edit" },
        }),
      ],
      key,
      nodeId
    );
    expect(asCashier.body.data.results[0]).toMatchObject({ status: "conflict", code: "PERMISSION_DENIED" });
    expect((await Product.findById(product._id).lean())?.name).not.toBe("Cashier edit");

    const anonymous = await push(
      [
        await rowPayload({
          collection: "products",
          docId: product._id,
          actorUserId: null,
          doc: { ...current, name: "Anonymous edit" },
        }),
      ],
      key,
      nodeId
    );
    expect(anonymous.body.data.results[0]).toMatchObject({ status: "conflict", code: "PERMISSION_DENIED" });

    // A user who no longer exists at the center: refused, never silently dropped.
    const ghost = await push(
      [
        await rowPayload({
          collection: "products",
          docId: product._id,
          actorUserId: new mongoose.Types.ObjectId().toString(),
          doc: { ...current, name: "Ghost edit" },
        }),
      ],
      key,
      nodeId
    );
    expect(ghost.body.data.results[0]).toMatchObject({ status: "conflict", code: "PERMISSION_DENIED" });
    expect((await Product.findById(product._id).lean())?.name).not.toBe("Ghost edit");
  });

  it("never lets a stale shop copy overwrite newer reference data", async () => {
    const nodeId = `${runTag}-stale`;
    const key = await registerNode(nodeId);
    const product = await createProduct(admin.token, { tag: `${runTag}-stale` });
    touchedDocIds.add(product._id);
    const current = (await Product.findById(product._id).lean()) as unknown as Record<string, unknown>;

    const res = await push(
      [
        await rowPayload({
          collection: "products",
          docId: product._id,
          actorUserId: admin.userId,
          doc: { ...current, name: "Stale rename" },
          docVersion: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        }),
      ],
      key,
      nodeId
    );
    expect(res.body.data.results[0]).toMatchObject({ status: "conflict", code: "STALE_OVERWRITE" });
    expect((await Product.findById(product._id).lean())?.name).not.toBe("Stale rename");
  });

  it("keeps immutable history immutable", async () => {
    const nodeId = `${runTag}-append`;
    const key = await registerNode(nodeId);
    const product = await createProduct(admin.token, { tag: `${runTag}-append` });
    touchedDocIds.add(product._id);
    const purchase = await receiveStock(admin.token, {
      supplierId: (await createSupplier(admin.token))._id,
      productId: product._id,
      quantity: 4,
    });
    const movement = await InventoryMovement.findOne({ referenceId: purchase._id }).lean();
    const movementId = String(movement?._id);
    touchedDocIds.add(movementId);

    const res = await push(
      [
        await rowPayload({
          collection: "inventorymovements",
          docId: movementId,
          actorUserId: admin.userId,
          doc: { ...(movement as unknown as Record<string, unknown>), quantity: 999 },
        }),
      ],
      key,
      nodeId
    );
    expect(res.body.data.results[0]).toMatchObject({ status: "duplicate" });
    expect((await InventoryMovement.findById(movementId).lean())?.quantity).toBe(4);
  });

  it("refuses to delete reference data but propagates history deletes", async () => {
    const nodeId = `${runTag}-delete`;
    const key = await registerNode(nodeId);
    const product = await createProduct(admin.token, { tag: `${runTag}-delete` });
    touchedDocIds.add(product._id);

    const refused = await push(
      [
        await rowPayload({
          collection: "products",
          docId: product._id,
          actorUserId: admin.userId,
          operation: "delete",
        }),
      ],
      key,
      nodeId
    );
    expect(refused.body.data.results[0]).toMatchObject({ status: "conflict", code: "UNSUPPORTED" });
    expect(await Product.findById(product._id).lean()).not.toBeNull();

    const purchase = await receiveStock(admin.token, {
      supplierId: (await createSupplier(admin.token))._id,
      productId: product._id,
      quantity: 2,
    });
    const movement = await InventoryMovement.findOne({ referenceId: purchase._id }).lean();
    const movementId = String(movement?._id);
    touchedDocIds.add(movementId);

    const applied = await push(
      [
        await rowPayload({
          collection: "inventorymovements",
          docId: movementId,
          actorUserId: admin.userId,
          operation: "delete",
        }),
      ],
      key,
      nodeId
    );
    expect(applied.body.data.results[0]).toMatchObject({ status: "applied" });
    expect(await InventoryMovement.findById(movementId).lean()).toBeNull();
  });

  it("refuses collections it does not accept", async () => {
    const nodeId = `${runTag}-unsupported`;
    const key = await registerNode(nodeId);
    const res = await push(
      [
        await rowPayload({
          collection: "sessions",
          docId: new mongoose.Types.ObjectId().toString(),
          actorUserId: admin.userId,
          doc: { anything: true },
        }),
      ],
      key,
      nodeId
    );
    expect(res.body.data.results[0]).toMatchObject({ status: "conflict", code: "UNSUPPORTED" });
  });
});

describe("node push pipeline", () => {
  it("pushes queued changes, marks them synced only after confirmation, and then has nothing left", async () => {
    const product = await createProduct(admin.token, { tag: `${runTag}-pipeline` });
    touchedDocIds.add(product._id);
    await receiveStock(admin.token, {
      supplierId: (await createSupplier(admin.token))._id,
      productId: product._id,
      quantity: 2,
    });
    await openRegister(cashier.token, 0);

    const clientTransactionId = `qa-ctx-${runTag}-pipeline`;
    const sale = await api(cashier.token).post(
      "/api/sales",
      checkoutPayload({
        items: [{ productId: product._id, quantity: 1 }],
        payments: [{ method: "cash", amount: 20 }],
        clientTransactionId,
      })
    );
    expect(sale.status).toBe(201);
    const saleId = sale.body.data.id as string;
    touchedDocIds.add(saleId);

    const nodeId = `${runTag}-node`;
    const key = await registerNode(nodeId);

    await withNodeEnv({ id: nodeId, key }, async () => {
      // The worker waits out its commit-grace window: a document written by a
      // transaction that has not committed yet must never be pushed.
      await sleep(NODE_WAIT);

      const pushed = await drain();
      expect(pushed).toBeGreaterThan(0);

      const saleRows = await rowsFor(saleId);
      expect(saleRows.length).toBeGreaterThan(0);
      expect(saleRows.every((row) => row.status === "SYNCED")).toBe(true);
      expect(saleRows[0].syncedAt).toBeInstanceOf(Date);

      // Fully drained: a second run has nothing to send, so nothing is resent.
      const second = await pushOutbox({ force: true });
      expect(second.pushed).toBe(0);
      expect(second.message).toBe("Nothing to push");

      expect(await Sale.countDocuments({ clientTransactionId })).toBe(1);
    });
  });

  it("keeps changes queued with a scheduled retry when the center is unreachable", async () => {
    const product = await createProduct(admin.token, { tag: `${runTag}-unreachable` });
    touchedDocIds.add(product._id);

    await withNodeEnv(
      { id: `${runTag}-offline`, key: "qa-unreachable-key-000000000000", onlineUrl: "http://127.0.0.1:1" },
      async () => {
        await markDirty({
          collection: "products",
          docId: product._id,
          operation: "upsert",
          actorUserId: admin.userId,
        });
        await sleep(NODE_WAIT);

        const summary = await pushOutbox({ force: true });
        expect(summary.reachable).toBe(false);
        expect(summary.failed).toBeGreaterThan(0);

        const rows = await rowsFor(product._id);
        expect(rows.length).toBeGreaterThan(0);
        // Never marked synced, never discarded: still pending with a backoff.
        expect(rows.every((row) => row.status === "PENDING")).toBe(true);
        expect(rows[0].attempts).toBeGreaterThan(0);
        expect(rows[0].lastError).toBeTruthy();
        expect(rows[0].nextAttemptAt).toBeGreaterThan(Date.now());
      }
    );
  });

  it("turns a refused change into a conflict with the payload preserved, and lets an admin set it aside", async () => {
    const nodeId = `${runTag}-conflict`;
    const key = await registerNode(nodeId);
    const product = await createProduct(admin.token, { tag: `${runTag}-conflict` });
    touchedDocIds.add(product._id);

    // A cashier edit of the catalogue is queued locally (the shop's UI would not
    // offer it, but the queue must survive whatever reached it) and the center
    // refuses it. That is the realistic path to a conflict row.
    await withNodeEnv({ id: nodeId, key }, async () => {
      // The create's own marker is written asynchronously with the ADMIN as
      // actor; if it landed after the calls below it would overwrite the
      // cashier actor and the center would accept the change. Settle it first.
      expect(await waitFor(() => pendingRows(product._id), (n) => n > 0)).toBeGreaterThan(0);
      await markDirty({
        collection: "products",
        docId: product._id,
        operation: "upsert",
        actorUserId: cashier.userId,
      });
      await markDirty({
        collection: "products",
        docId: product._id,
        operation: "upsert",
        actorUserId: cashier.userId,
      });
      await sleep(NODE_WAIT);
      await pushOutbox({ force: true });

      const rows = await rowsFor(product._id);
      expect(rows.some((row) => row.status === "FAILED")).toBe(true);
      expect(String(rows[0].lastError)).toContain("PERMISSION_DENIED");

      const conflictRow = await SyncConflict.findOne({ docId: product._id }).lean();
      expect(conflictRow).not.toBeNull();
      expect(conflictRow?.kind).toBe("PERMISSION_DENIED");
      // The original document is preserved for a human to look at.
      expect(conflictRow?.payload).toBeTruthy();
      expect(conflictRow?.resolved).toBe(false);

      const listed = await api(cashier.token).get("/api/sync/conflicts");
      expect(listed.status).toBe(200);
      const fromApi = (listed.body.data.conflicts as Array<{ conflictKey: string; docId: string }>).find(
        (entry) => entry.docId === product._id
      );
      expect(fromApi).toBeDefined();

      // Dismissing is an administrative decision.
      const denied = await api(cashier.token).post("/api/sync/conflicts", {
        action: "dismiss",
        conflictKey: fromApi!.conflictKey,
        reason: "cashiers may not decide this",
      });
      expect(denied.status).toBe(403);

      // Retrying puts it back in the queue for the next run.
      const retried = await api(cashier.token).post("/api/sync/conflicts", {
        action: "retry",
        conflictKey: fromApi!.conflictKey,
      });
      expect(retried.status).toBe(200);
      const afterRetry = await rowsFor(product._id);
      expect(afterRetry.some((row) => row.status === "PENDING")).toBe(true);

      const dismissed = await api(admin.token).post("/api/sync/conflicts", {
        action: "dismiss",
        conflictKey: fromApi!.conflictKey,
        reason: "catalogue edits belong to the manager",
      });
      expect(dismissed.status).toBe(200);
      const resolved = await SyncConflict.findOne({ docId: product._id }).lean();
      expect(resolved?.resolved).toBe(true);
      expect(resolved?.resolution).toContain("catalogue edits");
    });
  });
});

describe("node sync endpoints", () => {
  it("exposes status to sales viewers and refuses other roles", async () => {
    const asCashier = await api(cashier.token).get("/api/sync/status");
    expect(asCashier.status).toBe(200);
    // Not configured in this environment — stated plainly, not faked as success.
    expect(asCashier.body.pushEnabled).toBe(false);
    expect(Array.isArray(asCashier.body.missing)).toBe(true);
    expect(asCashier.body.missing.length).toBeGreaterThan(0);
    expect(asCashier.body.localDb.dbName).toBe(process.env.MONGODB_DB_NAME);

    const asAccountant = await api(accountant.token).get("/api/sync/status");
    expect(asAccountant.status).toBe(403);
  });

  it("only lets sales creators trigger a sync run", async () => {
    const denied = await api(accountant.token).post("/api/sync/run");
    expect(denied.status).toBe(403);

    const allowed = await api(cashier.token).post("/api/sync/run");
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.message).toMatch(/not configured/i);
  });

  it("lists the outbox for the Sync Center and protects it", async () => {
    const listed = await api(cashier.token).get("/api/sync/outbox");
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.data.rows)).toBe(true);
    expect(listed.body.data.rows.length).toBeGreaterThan(0);
    for (const row of listed.body.data.rows as Array<Record<string, unknown>>) {
      expect(typeof row.collection).toBe("string");
      expect(["PENDING", "SENDING", "FAILED"]).toContain(row.status);
    }

    const badFilter = await api(cashier.token).get("/api/sync/outbox?status=NONSENSE");
    expect(badFilter.status).toBe(400);

    const denied = await api(accountant.token).get("/api/sync/outbox");
    expect(denied.status).toBe(403);
  });
});

describe("center pull and node-side application", () => {
  it("sends reference-data deltas with per-collection cursors", async () => {
    const nodeId = `${runTag}-pull`;
    const key = await registerNode(nodeId);
    const product = await createProduct(admin.token, { tag: `${runTag}-pull` });
    touchedDocIds.add(product._id);

    const pull = (cursors: Record<string, string>) =>
      fetch(url("/api/sync/pull"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sync-node-id": nodeId,
          "x-sync-node-key": key,
        },
        body: JSON.stringify({ cursors, limit: 2000 }),
      });

    const first = await pull({});
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.hasMore).toBe(false);

    const products = firstBody.data.docs.products as Array<{ _id: string }>;
    expect(products.some((doc) => doc._id === product._id)).toBe(true);
    expect(firstBody.data.cursors.products).toBeTruthy();

    // Nothing changed since the cursor → nothing is re-sent.
    const second = await pull(firstBody.data.cursors);
    const secondBody = await second.json();
    expect((secondBody.data.docs.products as Array<{ _id: string }>).some((doc) => doc._id === product._id)).toBe(
      false
    );

    // Transactional history is push-only: a pull can never rewrite a sale.
    expect(secondBody.data.docs.sales).toBeUndefined();

    // Session material never reaches a shop.
    for (const user of (firstBody.data.docs.users ?? []) as Array<Record<string, unknown>>) {
      expect(user.refreshTokenHash).toBeUndefined();
      expect(user.passwordResetTokenHash).toBeUndefined();
      expect(user.passwordResetExpires).toBeUndefined();
    }
  });

  it("applies pulled changes locally but never over an unsent local edit, and never echoes them back", async () => {
    const product = await createProduct(admin.token, { tag: `${runTag}-apply-local` });
    touchedDocIds.add(product._id);

    // Wait for the create's dirty marker, then pretend the shop already pushed
    // its own version of this product.
    const queued = await waitFor(() => pendingRows(product._id), (n) => n > 0);
    expect(queued).toBeGreaterThan(0);
    await SyncOutbox.updateMany(
      { docId: product._id, status: { $in: ["PENDING", "SENDING", "FAILED"] } },
      { $set: { status: "SYNCED", syncedAt: new Date() } }
    );
    // Nothing may still be queued, or the pull would (correctly) be skipped.
    expect(await pendingRows(product._id)).toBe(0);

    const applied = await applyDeltas({
      docs: { products: [{ _id: product._id, name: `Center rename ${runTag}`, sellingPrice: 33 }] },
      cursors: { products: new Date().toISOString() },
      hasMore: false,
    });
    expect(applied).toBe(1);
    expect((await Product.findById(product._id).lean())?.sellingPrice).toBe(33);
    // Applying center data must not queue it straight back to the center.
    expect(await SyncOutbox.countDocuments({ docId: product._id, status: "PENDING" })).toBe(0);

    // Now the shop edits it locally: that unsent change wins over the center.
    const existing = (await Product.findById(product._id).lean()) as unknown as { sku: string };
    const edit = await api(admin.token).post("/api/products", {
      id: product._id,
      name: `Local edit ${runTag}`,
      sku: existing.sku,
      sellingPrice: 44,
      purchasePrice: 10,
      status: "active",
    });
    expect([200, 201]).toContain(edit.status);
    const editQueued = await waitFor(() => pendingRows(product._id), (n) => n > 0);
    expect(editQueued).toBeGreaterThan(0);

    const skipped = await applyDeltas({
      docs: { products: [{ _id: product._id, name: `Center rename again ${runTag}`, sellingPrice: 55 }] },
      cursors: { products: new Date().toISOString() },
      hasMore: false,
    });
    expect(skipped).toBe(0);
    expect((await Product.findById(product._id).lean())?.name).toBe(`Local edit ${runTag}`);
    expect((await Product.findById(product._id).lean())?.sellingPrice).toBe(44);
  });

  it("reports an unreachable center instead of pretending the pull worked", async () => {
    await withNodeEnv(
      { id: `${runTag}-pull-offline`, key: "qa-unreachable-key-111111111111", onlineUrl: "http://127.0.0.1:1" },
      async () => {
        const result = await pullFromCenter();
        expect(result.reachable).toBe(false);
        expect(result.applied).toBe(0);
        expect(result.message).toBeTruthy();
      }
    );
  });
});

describe("central aggregation", () => {
  it("counts a pushed sale once, however often it is replayed", async () => {
    const product = await createProduct(admin.token, { tag: `${runTag}-report` });
    touchedDocIds.add(product._id);
    await receiveStock(admin.token, {
      supplierId: (await createSupplier(admin.token))._id,
      productId: product._id,
      quantity: 2,
    });
    await openRegister(cashier.token, 0);

    const clientTransactionId = `qa-ctx-${runTag}-report`;
    const sale = await api(cashier.token).post(
      "/api/sales",
      checkoutPayload({
        items: [{ productId: product._id, quantity: 1 }],
        payments: [{ method: "cash", amount: 20 }],
        clientTransactionId,
      })
    );
    expect(sale.status).toBe(201);
    const saleId = sale.body.data.id as string;
    touchedDocIds.add(saleId);

    const before = await api(admin.token).get("/api/reports/sales?period=day");
    expect(before.status).toBe(200);

    const nodeId = `${runTag}-report-node`;
    const key = await registerNode(nodeId);
    const saleDoc = (await Sale.findById(saleId).lean()) as unknown as Record<string, unknown>;
    const row = await rowPayload({
      rowKey: `qa-row-report-${runTag}`,
      collection: "sales",
      docId: saleId,
      actorUserId: cashier.userId,
      doc: saleDoc,
    });

    const applied = await push([row], key, nodeId);
    expect(applied.body.data.results[0].status).toBe("applied");
    const replay = await push([row], key, nodeId);
    expect(replay.body.data.results[0].status).toBe("duplicate");

    expect(await Sale.countDocuments({ clientTransactionId })).toBe(1);
    const after = await api(admin.token).get("/api/reports/sales?period=day");
    expect(after.body.summary.count).toBe(before.body.summary.count);
    expect(after.body.summary.revenue).toBe(before.body.summary.revenue);
  });
});

describe("local database versioning", () => {
  it("reports the schema version and re-runs migrations idempotently", async () => {
    const first = await runLocalMigrations();
    expect(first.to).toBe(LOCAL_SCHEMA_VERSION);
    expect(await localSchemaVersion()).toBe(LOCAL_SCHEMA_VERSION);

    const second = await runLocalMigrations();
    expect(second.applied).toEqual([]);
    expect(second.from).toBe(LOCAL_SCHEMA_VERSION);
  });

  it("reports queue counts the Sync Center can rely on", async () => {
    const counts = await outboxCounts();
    expect(counts.pending).toBeGreaterThanOrEqual(0);
    expect(counts.failed).toBeGreaterThanOrEqual(0);
    expect(counts.synced).toBeGreaterThanOrEqual(0);
  });
});

describe("node credentials", () => {
  it("stores only a hash, and hashes deterministically across processes", async () => {
    const nodeId = `${runTag}-hash`;
    const key = await registerNode(nodeId);
    const node = await SyncNode.findOne({ nodeId }).lean();
    expect(node?.keyHash).toBe(hashNodeKey(key));
    expect(node?.keyHash).not.toBe(key);
    expect(hashNodeKey("another-secret")).not.toBe(node?.keyHash);
  });

  it("refuses a deactivated node even with the right secret", async () => {
    const nodeId = `${runTag}-inactive`;
    const key = await registerNode(nodeId);
    const deactivated = await api(admin.token).post("/api/sync/nodes", { action: "deactivate", nodeId });
    expect(deactivated.status).toBe(200);

    const res = await push(
      [
        await rowPayload({
          collection: "products",
          docId: new mongoose.Types.ObjectId().toString(),
          actorUserId: admin.userId,
          operation: "delete",
        }),
      ],
      key,
      nodeId
    );
    expect(res.status).toBe(401);
  });
});
