/**
 * Tells "the database is unreachable" apart from "the user is not signed in".
 *
 * Without this distinction the dashboard layout sent BOTH cases to /login. On a
 * shop PC whose MongoDB is not running that produced a login page that could
 * never log anyone in — it looked like the whole app was broken offline, when
 * the real message should be "start the local database".
 */

const NETWORK_ERROR_NAME = /Mongo(ServerSelection|Network|NotConnected|Timeout)Error/i;
const NETWORK_ERROR_MESSAGE =
  /(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|failed to connect|connection .* (refused|closed)|server selection timed out|buffering timed out)/i;

export function isDatabaseUnavailable(error: unknown): boolean {
  if (!error) return false;
  const name = typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name) : "";
  const message = error instanceof Error ? error.message : String(error);
  return NETWORK_ERROR_NAME.test(name) || NETWORK_ERROR_MESSAGE.test(message);
}

/** User-facing explanation shown by the offline error screens. */
export function databaseUnavailableMessage(): string {
  return "The app cannot reach its database. On a shop PC, start MongoDB (the instance MongoDB Compass connects to) and reload. Everything you sold is stored in that local database, so nothing is lost.";
}
