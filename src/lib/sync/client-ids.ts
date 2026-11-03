/**
 * Client-side identifiers (browser-safe: no mongoose, no server imports).
 *
 * The POS generates one idempotency key per sale BEFORE sending it. If the
 * response is lost — browser crash, tab close, dropped request on the shop's own
 * network — a retry with the same key can never create a second sale: the server
 * stores it on the document and enforces uniqueness on it.
 */
export function newClientTransactionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Stable per-browser device label, kept in localStorage (not in any database). */
export function getDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.localStorage.getItem("pos.deviceId");
    if (existing) return existing;
    const created = newClientTransactionId();
    window.localStorage.setItem("pos.deviceId", created);
    return created;
  } catch {
    return "unknown-device";
  }
}
