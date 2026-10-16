/**
 * Pure sync-queue logic (no browser/IndexedDB dependencies) so it can be
 * unit-tested directly with vitest.
 *
 * Backoff schedule per spec: 30s → 60s → 2m → 5m (capped at 5m).
 */

export type QueueStatus = "PENDING" | "SYNCING" | "SYNCED" | "FAILED";

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

/** True when a queue entry is due for a retry at `now`. */
export function isDue(entry: { status: QueueStatus; nextAttemptAt: number }, now: number): boolean {
  if (entry.status === "SYNCED") return false;
  // Never-synced or explicitly pending entries with no backoff go immediately.
  return entry.nextAttemptAt <= now;
}

/**
 * Offline receipt reference: OFFLINE-YYYYMMDD-NNNNNN.
 * The 6-digit suffix comes from a random pool — collisions are irrelevant
 * because the real invoice number replaces it after sync.
 */
export function offlineReference(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const suffix = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `OFFLINE-${ymd}-${suffix}`;
}

/** Client-generated idempotency key for a sale (crypto.randomUUID when available). */
export function newClientTransactionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older browsers: timestamp + randomness, still collision-safe enough.
  return `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
