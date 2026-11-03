import { apiErrorMessage } from "@/lib/api";
import type { SyncConflictKind } from "@/models";
import { getSyncConfig, isTrackingEnabled, type SyncConfig } from "./config";
import {
  claimRows,
  failRow,
  listDueRows,
  markRowsSynced,
  scheduleRowRetry,
  setState,
} from "./outbox";
import { buildPushOperations, type PushOperation } from "./payload";
import { pushDirect } from "./direct";

/**
 * Drains the outbox into `POST {SYNC_ONLINE_URL}/api/sync/push`.
 *
 * Outcomes per operation:
 *  - applied / duplicate → the row is marked SYNCED. Nothing is ever marked
 *    synced before the center has confirmed persistence.
 *  - conflict            → FAILED plus a conflict row that keeps the original
 *    document snapshot; a human resolves it (never silently discarded).
 *  - error / transport    → PENDING with the 30s/60s/2m/5m backoff.
 */

const PUSH_TIMEOUT_MS = 30_000;

export type PushSummary = {
  configured: boolean;
  reachable: boolean;
  attempted: number;
  pushed: number;
  conflicted: number;
  failed: number;
  message: string;
};

type CenterRowResult = {
  rowKey: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  code?: string;
  message?: string;
};

function emptySummary(config: SyncConfig, message: string, reachable = false): PushSummary {
  return {
    configured: config.pushEnabled,
    reachable,
    attempted: 0,
    pushed: 0,
    conflicted: 0,
    failed: 0,
    message,
  };
}

function conflictKind(code: string | undefined): SyncConflictKind {
  switch (code) {
    case "PERMISSION_DENIED":
    case "VALIDATION":
    case "STALE_OVERWRITE":
    case "UNSUPPORTED":
      return code;
    default:
      return "SERVER_ERROR";
  }
}

function rowBody(op: PushOperation) {
  return {
    rowKey: op.rowKey,
    collection: op.collection,
    docId: op.docId,
    operation: op.operation,
    entityType: op.entityType,
    actorUserId: op.actorUserId,
    branchId: op.branchId,
    docVersion: op.docVersion,
    doc: op.doc,
  };
}

async function postPush(config: SyncConfig, operations: PushOperation[]): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    return await fetch(`${config.onlineUrl}/api/sync/push`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sync-node-id": config.nodeId,
        "x-sync-node-key": config.nodeKey ?? "",
      },
      body: JSON.stringify({
        nodeName: config.nodeName,
        sentAt: new Date().toISOString(),
        rows: operations.map(rowBody),
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function pushOutbox(options: { force?: boolean } = {}): Promise<PushSummary> {
  const config = getSyncConfig();
  if (!config.pushEnabled) {
    return emptySummary(
      config,
      config.missing.length > 0
        ? `Sync is not configured — missing ${config.missing.join(", ")}`
        : "Sync is disabled on this node"
    );
  }

  // The local database is configured but not running, so this process is on the
  // online database. Pushing now would send the center its own rows; the queue
  // pauses until the local MongoDB is back.
  if (!isTrackingEnabled()) {
    return emptySummary(
      config,
      "The local database is unavailable and the app is running on the online database."
    );
  }

  await setState("push.lastAttemptAt", new Date().toISOString());

  const rows = await listDueRows({ force: options.force, limit: config.batchSize * 2 });
  const { operations, unsupported } = await buildPushOperations(rows);

  // A collection the center does not accept can never be pushed: record it once
  // and let an operator decide, instead of retrying it forever.
  for (const item of unsupported) {
    await failRow(item.row, "UNSUPPORTED", `Collection "${item.collection}" is not replicated`);
  }

  if (operations.length === 0) {
    return {
      configured: true,
      reachable: true,
      attempted: 0,
      pushed: 0,
      conflicted: unsupported.length,
      failed: 0,
      message: "Nothing to push",
    };
  }

  await claimRows(operations.flatMap((op) => op.rowKeys));

  // Both transports produce the same per-row outcomes; only the way they reach
  // the online database differs.
  let results: Map<string, CenterRowResult>;

  if (config.transport === "direct") {
    try {
      const rows = await pushDirect(operations, config.nodeId);
      results = new Map(rows.map((row) => [row.rowKey, row]));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      for (const op of operations) {
        await scheduleRowRetry({ rowKey: op.rowKey, attempts: op.attempts }, message);
      }
      await setState("push.lastError", { at: new Date().toISOString(), message });
      return {
        configured: true,
        reachable: false,
        attempted: operations.length,
        pushed: 0,
        conflicted: 0,
        failed: operations.length,
        message: `Online database unreachable: ${message}`,
      };
    }
  } else {
    let response: Response;
    try {
      response = await postPush(config, operations);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      for (const op of operations) {
        await scheduleRowRetry({ rowKey: op.rowKey, attempts: op.attempts }, message);
      }
      await setState("push.lastError", { at: new Date().toISOString(), message });
      return {
        configured: true,
        reachable: false,
        attempted: operations.length,
        pushed: 0,
        conflicted: 0,
        failed: operations.length,
        message: `Center unreachable: ${message}`,
      };
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = apiErrorMessage(body, `Center rejected the push (HTTP ${response.status})`);

      if (response.status === 401 || response.status === 403) {
        // The node identity itself is wrong: this needs an admin, not a retry
        // storm. Rows stay queued (never dropped) with the normal backoff.
        for (const op of operations) {
          await scheduleRowRetry({ rowKey: op.rowKey, attempts: op.attempts }, message);
        }
        await setState("push.lastError", {
          at: new Date().toISOString(),
          message,
          needsIntervention: true,
        });
        return {
          configured: true,
          reachable: true,
          attempted: operations.length,
          pushed: 0,
          conflicted: 0,
          failed: operations.length,
          message,
        };
      }

      for (const op of operations) {
        await scheduleRowRetry({ rowKey: op.rowKey, attempts: op.attempts }, message);
      }
      await setState("push.lastError", { at: new Date().toISOString(), message });
      return {
        configured: true,
        reachable: true,
        attempted: operations.length,
        pushed: 0,
        conflicted: 0,
        failed: operations.length,
        message,
      };
    }

    // The route answers with the standard envelope: { success, data: { results } }.
    // Reading the results from the wrong level would silently look like "the
    // center returned no result for this row", so every row would be retried
    // forever and nothing would ever be marked synced.
    const body = (await response.json().catch(() => null)) as {
      data?: { results?: CenterRowResult[] };
    } | null;
    results = new Map<string, CenterRowResult>(
      (body?.data?.results ?? []).map((result) => [result.rowKey, result])
    );
  }

  let pushed = 0;
  let conflicted = 0;
  let failed = 0;

  for (const op of operations) {
    const result = results.get(op.rowKey);
    if (!result) {
      await scheduleRowRetry(
        { rowKey: op.rowKey, attempts: op.attempts },
        "The center returned no result for this row"
      );
      failed += 1;
      continue;
    }

    if (result.status === "applied" || result.status === "duplicate") {
      await markRowsSynced(op.rowKeys);
      pushed += 1;
      continue;
    }

    if (result.status === "conflict") {
      await failRow(
        {
          rowKey: op.rowKey,
          attempts: op.attempts,
          collectionName: op.collection,
          docId: op.docId,
          entityType: op.entityType,
        },
        conflictKind(result.code),
        result.message ?? result.code ?? "The center refused this change",
        { payload: op.doc, nodeId: config.nodeId }
      );
      conflicted += 1;
      continue;
    }

    await scheduleRowRetry(
      { rowKey: op.rowKey, attempts: op.attempts },
      result.message ?? result.code ?? "The center failed to apply this change"
    );
    failed += 1;
  }

  await setState("push.lastSuccessAt", new Date().toISOString());
  if (conflicted === 0 && failed === 0) {
    await setState("push.lastError", null);
  }

  return {
    configured: true,
    reachable: true,
    attempted: operations.length,
    pushed,
    conflicted,
    failed,
    message: `${pushed} pushed${conflicted ? `, ${conflicted} conflicted` : ""}${
      failed ? `, ${failed} retrying` : ""
    }`,
  };
}
