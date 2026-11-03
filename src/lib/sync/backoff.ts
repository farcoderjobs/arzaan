/**
 * Pure sync-queue logic (no mongoose, no browser APIs) so it can be unit-tested
 * directly with vitest.
 *
 * Backoff schedule: 30s → 60s → 2m → 5m (capped at 5m), applied per outbox row
 * so a permanently failing document is retried less and less while fresh
 * documents keep flowing.
 */

export type QueueStatus = "PENDING" | "SENDING" | "SYNCED" | "FAILED";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Escalating delays by attempt number (attempt 1 fails → wait BACKOFF[0]…). */
export const BACKOFF_SCHEDULE_MS = [30 * SECOND, 60 * SECOND, 2 * MINUTE, 5 * MINUTE];

/** Delay before retrying after `attempts` failed attempts. Capped at 5m. */
export function backoffDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const index = Math.min(attempts, BACKOFF_SCHEDULE_MS.length) - 1;
  return BACKOFF_SCHEDULE_MS[index];
}

/** Timestamp of the next allowed attempt after `attempts` failures at `failedAt`. */
export function nextAttemptAt(attempts: number, failedAt: number): number {
  return failedAt + backoffDelayMs(attempts);
}

/** True when an outbox row is due for a retry at `now`. */
export function isDue(entry: { status: QueueStatus; nextAttemptAt: number }, now: number): boolean {
  if (entry.status === "SYNCED") return false;
  // A FAILED row waits for a human (or an explicit Retry) — never auto-runs.
  if (entry.status === "FAILED") return false;
  return entry.nextAttemptAt <= now;
}

/**
 * Idempotency key for an outbox row. The client (POS) may also generate one for
 * its own requests; this one identifies the *replication* of a document.
 */
export function newRowKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Human label for a run summary: "12 pushed, 1 conflicted". */
export function summarise(counts: {
  pushed: number;
  failed: number;
  conflicted: number;
  remaining: number;
}): string {
  const parts: string[] = [];
  parts.push(`${counts.pushed} pushed`);
  if (counts.conflicted > 0) parts.push(`${counts.conflicted} conflicted`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  parts.push(`${counts.remaining} pending`);
  return parts.join(", ");
}
