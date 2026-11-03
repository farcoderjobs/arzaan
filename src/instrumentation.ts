/**
 * Server startup hook (next: `instrumentation.ts`, resolved from `src/`).
 *
 * Starts the offline-first sync worker: a shop node pushes its queued changes
 * to the center and pulls reference-data deltas, on an interval and right after
 * boot. The worker is a no-op on a center instance (`NODE_ROLE=center`) and on a
 * node with `SYNC_ENABLED=false`.
 *
 * Runs once per server process; `startSyncWorker()` is idempotent and keeps its
 * timer on globalThis so a dev-server reload cannot leave two loops running.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  try {
    const { startSyncWorker } = await import("@/lib/sync/worker");
    startSyncWorker();
  } catch (err) {
    // A broken sync worker must never stop the POS from serving.
    console.error("[sync] could not start the sync worker", err);
  }

  // Top up the permission catalog and system roles on every boot, so a database
  // seeded by an older build picks up newly added permissions (e.g.
  // employee_purchases.*) without needing a manual `npm run seed`.
  try {
    const { connectDB } = await import("@/lib/mongodb");
    const { seedRoles } = await import("@/models/permissions");
    await connectDB();
    await seedRoles();
  } catch (err) {
    console.error("[seed] could not refresh permissions/roles", err);
  }
}
