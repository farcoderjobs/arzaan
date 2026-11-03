# Offline-first operation

Each shop runs the whole application (Next.js + MongoDB) on its own PC. The
browser talks to that local process, so the POS keeps working with no internet:
the local MongoDB is the system of record, not a cache. When connectivity
returns, pending changes replicate to the center (HQ) MongoDB.

There is no IndexedDB queue. The previous browser queue was removed; pending
writes now live in the same local MongoDB as the business documents, which is
why a refresh, browser restart or power cut cannot lose a completed sale.

---

## 1. Roles

| Process | `NODE_ROLE` | Responsibility |
| --- | --- | --- |
| Shop PC | unset / `shop` | Serves POS + API from local MongoDB; queues changes in `syncoutbox`; pushes to the center |
| Center (HQ) | `center` | Accepts pushes and re-authorizes them; serves consolidated reports |

Shop environment:

```env
# The shop PC's own database (what MongoDB Compass opens). When it is reachable
# the app uses it for every read and write, so the POS works with no internet.
MONGODB_LOCAL_URI="mongodb://127.0.0.1:27017"
# The online/cloud database, used when the local server is unreachable and by
# the center deployment. Replication is paused while running on this one.
MONGODB_URI="mongodb+srv://…"
MONGODB_DB_NAME="pos"
NODE_ROLE="shop"            # optional, this is the default
SYNC_NODE_ID="shop-01"      # issued by the center
SYNC_NODE_KEY="..."         # issued once when the node is registered
SYNC_ONLINE_URL="https://pos.example.com"
SYNC_PULL_ENABLED="true"
SYNC_INTERVAL_MS="60000"
SYNC_BATCH_SIZE="200"
```

First run on a new shop PC:

```bash
# 1. copy the shop's data (products, customers, settings, history) from the
#    online database into the local one — safe to re-run, never overwrites
npm run db:hydrate
# 2. confirm the local database is a replica set and holds the data
npm run db:check
```

`db:hydrate` inserts with `$setOnInsert` by `_id`, so re-running it only adds
missing documents and never overwrites a sale or edit made on the shop PC.

If `MONGODB_LOCAL_URI` is configured but MongoDB is not running, the process
starts against `MONGODB_URI` (the app still serves) and the Sync Center shows a
red "local database is not running" banner. Every mutation is recorded in the
online database in that state and dirty-document tracking is switched off, so
nothing is queued for replication until the local server is restarted with its
database up.

The center must run MongoDB as a replica set, because pushes are applied inside
per-row upserts (single-document atomicity) and sales/payroll on the center use
transactions. A shop's local MongoDB must also be a **single-node replica set**
(`replSetName` + `rs.initiate()`), otherwise transactional writes are refused.
The Sync Center probes the topology and says so plainly if it is standalone.

---

### Direct transport (no center app)

A single-PC shop usually has no second deployment of this app. When
`SYNC_ONLINE_URL` is absent, `MONGODB_LOCAL_URI` is set and `MONGODB_URI` points
at a different database, the worker uses the **direct** transport: it writes the
outbox straight into `MONGODB_URI` and pulls reference data back with the same
delta cursors. **Sync Now** therefore works with just the shop PC and the online
cluster.

Direct mode skips the center's re-authorization and stale-overwrite guards —
the shop's local database is the system of record, so its version wins. The
at-most-once ledger (`syncappliedops`) still lives on the online database, so a
replayed batch can never post the same sale or payment twice. Deploy a center
and set the three `SYNC_*` variables to switch to the HTTP transport.

## 2. How a change travels

1. A business write (sale, purchase, department, payroll, transfer…) runs inside
   a MongoDB transaction where money or stock moves.
2. Mongoose hooks on every replicated schema enqueue a **dirty marker** in
   `syncoutbox` (`SyncOutbox`) in the same transaction. The marker stores only
   `collection + document id + operation + actor + branch + version`; the payload
   is read from the local database when it is pushed. Editing a document twice
   before a sync therefore replicates it once, in its final form.
3. The worker (background loop or **Sync Now**) picks due rows ordered by
   dependency band — reference data and parents before documents that reference
   them — and pushes them to `POST /api/sync/push` with the node credentials.
4. The center verifies the node key, re-authorizes the **acting user** against
   its own role/permission data (cached client permissions are never trusted),
   and applies each row through the `SyncAppliedOp` at-most-once ledger.
5. A row is marked `SYNCED` only after the center confirms persistence. Failures
   keep the row: transient errors get exponential backoff, permanent errors move
   the row to `FAILED` and preserve its document snapshot as a conflict row.

Dependency bands (`src/lib/sync/collections.ts`):

```
roles/permissions/branches/users  → departments/employee salaries → settings
→ categories/brands/store products → products/customers/suppliers
→ purchases/cash registers → stock transfers → inventory movements → sales
→ returns/ledgers → attendance → payroll periods/entries → cash payments
→ expenses/store orders → audit logs
```

New collections from this release (`departments`, `employeesalaries`,
`attendancerecords`, `payrollperiods`, `payrollentries`, `stocktransfers`) are
registered in the same tables, so they are queued, ordered and re-authorized
like the rest. Departments and salary configuration are also pulled back from
the center as reference data; attendance, payroll and transfers are push-only
transactional history.

---

## 3. Idempotency and conflicts

- `POST /api/sync/push` returns a per-row outcome (`applied`, `duplicate`,
  `conflict`, `error`). `SyncAppliedOp` has a unique `(nodeId, rowKey)` index, so
  a replayed batch can never post the same sale, payment or movement twice.
- Sales and returns also carry a client-generated `clientTransactionId` with a
  unique partial index, protecting the online path against retries from the
  browser.
- Conflicts (`syncConflicts`) store the original payload. They are never
  auto-deleted; the Sync Center lets an admin inspect, resolve or retry them.
- Reference data (roles, users, products, departments, salaries) is
  center-authoritative: if the center has a newer version, the row is refused as
  `STALE_OVERWRITE` instead of silently overwriting HQ.
- Account deactivation or a lost permission is a `PERMISSION_DENIED` conflict;
  the shop's pending financial rows are preserved for intervention rather than
  discarded.

---

## 4. Versioning and migration

`src/lib/sync/local-migrations.ts` owns the local sync schema version
(`LOCAL_SCHEMA_VERSION`, currently 2). Rules:

- migrations are additive and idempotent;
- the stored version is written only after `up()` succeeds, so an interrupted
  start retries instead of skipping;
- downgrades are refused (`assertLocalSchemaSupported`) because an older build
  cannot know what a newer migration did.

Version 1 established the local node layout (nothing imported from the removed
IndexedDB queue); version 2 created the sync-collection indexes. The state lives
in `syncstates` under `local.schemaVersion`, with migration errors recorded in
`local.migrationError`.

The business-document migrations for departments/purchase source/payroll and the
new indexes are separate and run once per database:
`npx tsx scripts/migrate-2026-10-departments-payroll.ts` (see
[DEPLOYMENT.md](../DEPLOYMENT.md)).

---

## 5. Recovery

- **Browser closed / PC restarted:** nothing to recover. Pending rows and the
  documents they point at are in MongoDB.
- **Sync interrupted:** rows left `SENDING` are reset to `PENDING` after five
  minutes; the worker resumes automatically. A manual **Sync Now** skips the
  backoff window but not the per-row outcome accounting.
- **Center unreachable:** rows stay queued with backoff; the UI shows pending
  counts and the last error.
- **Row permanently refused (permission, validation):** fix the cause in the
  Sync Center (or re-enter the transaction), then retry; the conflict keeps the
  original data until it is resolved.
- **Database restore:** restore the shop's local MongoDB backup. Because the
  outbox lives in the same database, unsynced work comes back with it; the
  center refuses already-applied rows as duplicates.
- **Backups:** `mongodump` nightly on each shop PC (including `syncoutbox` and
  `syncconflicts`) plus center snapshots. Keep the pre-upgrade dump until one
  full business day has passed.
