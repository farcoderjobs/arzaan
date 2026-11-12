# Deployment, migration and recovery

This build adds employee departments, Import/Local purchase sources,
department reporting, attendance-based payroll and warehouse/shop stock
transfers. This document covers what to configure and in which order to roll it
out. The application is unchanged in shape: Next.js on Node.js, Mongoose, and an
offline-first MongoDB node per shop replicating to a center MongoDB.

---

## 1. Environment

`JWT_SECRET` must be at least 32 characters. `MONGODB_URI` points at the
database this process serves; `MONGODB_DB_NAME` names it.

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Local shop node or center connection string |
| `MONGODB_DB_NAME` | Database name (test databases must end in `-test`) |
| `JWT_SECRET` | Access-token signing secret (32+ chars) |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | Session lifetimes |
| `APP_URL` / `NEXT_PUBLIC_APP_URL` | Public URL used by the app |
| `NODE_ROLE` | `center` for the HQ/aggregation node; unset/`node` for shops |
| `SYNC_NODE_ID`, `SYNC_NODE_KEY` | Shop node identity + key issued by the center |
| `SYNC_CENTER_URL` | Center base URL the shop pushes to |

### MongoDB requirement (important)

Sales, returns, payroll and stock writes use **multi-document transactions**.
MongoDB Community supports them, but only on a **replica set** — a standalone
`mongod` rejects them with
`Transaction numbers are only allowed on a replica set member or mongos`.

Run the shop's local MongoDB as a single-node replica set:

```bash
# mongod.cfg
replication:
  replSetName: rs0
```

```javascript
// once, from mongosh (or Compass shell) on the shop PC:
rs.initiate()
```

The center must also be a replica set (Atlas is one by default). Verify with
`rs.status()` / `db.hello().isWritablePrimary === true` before deployment.

---

## 2. Schema migration

The changes are additive and backward compatible: new fields have schema
defaults, and code treats missing historical values as **unknown/unassigned**
rather than guessing.

Run the idempotent backfill once per database, before starting the new build:

```bash
npx tsx scripts/migrate-2026-10-departments-payroll.ts
```

It performs, without deleting anything:

1. `Branch.type = "shop"` for existing branches.
2. `Sale.employeeId = cashierId`; `departmentId = null`, `departmentName = ""`
   (legacy sales stay visibly unassigned).
3. Legacy sale lines and inventory movements get `purchaseSource = null`
   (origin unknown — never assumed Local).
4. Sale returns inherit employee/department attribution from their original
   sale when it exists.
5. `syncIndexes()` for the new and changed models. This creates the unique
   guards that make duplicate payroll entries/payments and duplicate active
   department assignments impossible.

Then re-run the permission seed so existing roles receive the new permissions:

```bash
npm run seed
```

Role changes: Manager gains departments, attendance, payroll, transfers,
`purchases.import` and department reports; InventoryManager gains the transfer
permissions; Accountant gains read-only payroll/attendance/reports; Cashier
gains `departments.view` only. Custom roles are untouched — assign the new
permissions manually where needed.

### New collections

`departments`, `employeesalaries`, `attendancerecords`, `payrollperiods`,
`payrollentries`, `stocktransfers`.

They are registered in the replication tables (`src/lib/sync/collections.ts`,
`src/lib/sync/policy.ts`) and dirty-document tracking, so a shop node queues and
pushes them like every other collection. `departments` and `employeesalaries`
are also pulled from the center as reference data; attendance, payroll and
transfers are push-only transactional history.

No offline-queue migration is required: the local outbox stores dirty markers,
not payloads, and its schema did not change. Existing pending sales simply
replicate with `employeeId`/`departmentId` null when they predate this build.

---

## 3. Backup and recovery

- **Before migrating:** take a logical backup of the target database
  (`mongodump --uri=... --db=<name>`), or an Atlas snapshot. Keep it until the
  new version has served one full business day.
- **Shop PC:** the local MongoDB is the system of record while offline. Back it
  up nightly (`mongodump` to a second disk or NAS). The sync outbox lives in the
  same database, so restoring the database also restores unsynced work.
- **Recovery after a sync failure:** never delete `syncoutbox`/`syncconflicts`
  rows. Use the Sync Center to inspect failures; conflicts preserve the original
  payload and can be resolved or exported. A permanently failed sale/purchase
  must be re-entered through the app (or corrected by an admin) — do not edit
  financial documents directly in MongoDB.
- **Restore procedure:** restore the snapshot, start MongoDB as the same
  single-node replica set, start the app, then run a sync. Documents the center
  already applied are refused as duplicates by the idempotency ledger, so a
  replayed restore cannot double-post sales or movements.

---

## 4. Deployment sequence

1. **Back up** the center and each shop database.
2. **Stop** the app on the center and shops.
3. **Upgrade MongoDB topology** if a shop still runs standalone: enable
   `replSetName`, `rs.initiate()`, confirm primary.
4. **Run the migration** on the center, then on each shop.
5. **Re-seed permissions/roles** (`npm run seed`) on the center; let shops pull
   the roles/users reference data after their first sync.
6. **Deploy** the new build to the center first, then to shops.
7. **Verify:** open Departments, create one test department; open Attendance and
   mark/correct a day; generate a payroll draft for a past month and finalize it;
   create a warehouse branch, move one unit through dispatch → partial receive →
   receive; confirm `/api/reports/locations` shows the unit at the destination
   and no change in total stock.
8. **Sync** each shop once and confirm the Sync Center reports succeeded rows
   with no permission conflicts (new permissions must be present at the center).

Rollback: restore the pre-migration backup and redeploy the previous build.
New collections are ignored by the old code, so a rollback that keeps the
database also works as long as no finalized payroll or received transfer must be
reversed.

---

## 5. Known limitations

- Payroll is per shop. An employee assigned to one branch is paid from that
  branch; HQ-wide consolidated payroll is not aggregated across shops yet.
- Finalized payroll is immutable by design. Corrections after finalization are
  audited payments/adjustments, not silent regeneration; there is no dedicated
  "payroll correction" form yet.
- Transfer lines that span multiple batches must be split per batch. This is
  intentional so expiry and Import/Local origin stay exact.
- A transfer in transit cannot be canceled after dispatch; receiving (possibly a
  short receipt) is the only path forward, so dispatched stock is never lost.
- Attendance is exception-based. There is no per-employee shift schedule; the
  weekly rest day is per shop (default Friday, override with the
  `payroll.weekly_rest_day` setting) and the allowance defaults to 7 days
  (`payroll.absence_allowance_days`).
- The E2E suite covers offline capture/reload/sync; the new department, payroll
  and transfer flows are covered by unit and integration tests.

---

## 6. Copying the live data to another PC

`npm run seed` is the one command a fresh install needs: it seeds
roles/permissions **and** imports `data/seed/seed-data.json`, which carries the
branches, users (with password hashes), settings, catalogue, customers,
suppliers, store products and business history of the machine that exported it.

```bash
# on the PC that owns the current data (it must reach MongoDB)
npm run seed:export        # rewrites data/seed/seed-data.json from the live DB

# commit + push the updated snapshot, then on the other PC:
git pull
npm run seed               # roles/permissions + all data from the snapshot
npm run db:check           # verify row counts and that the local DB is active
```

The import only inserts documents that are missing (`$setOnInsert` by `_id`), so
it is safe to re-run and never overwrites local edits. Roles, permissions and
users are matched on their business key (name/email) instead, because
`npm run seed` creates roles and permissions with this computer's own ids: on a
database that was already seeded the snapshot row is kept, and the seeded users
are re-pointed at the role that actually exists there. When the snapshot must
win, use `npm run seed:data -- --replace` (destructive).

`.env` is git-ignored, so it does not travel with the repository. Copy it to the
other PC as well (same `JWT_SECRET`, `LICENSE_SECRET`, MongoDB URIs and sync
settings); the seeded user passwords keep working because the hashes are part of
the snapshot.

---

## 7. Client PC without the source code

`next start` serves the compiled output in `.next/`; it never reads `src/`.
After `npm run build` on the client PC, delete the source tree before handing the
machine over.

**Keep** (the server will not start without these):

| Path | Why |
| --- | --- |
| `.next/` | Compiled server routes, pages and static assets — the `npm start` entry point |
| `public/` | Served at `/`: `arzaan-logo.jpeg` (receipts), `sw.js`, `offline.html` |
| `node_modules/` | Runtime packages (`next`, `mongoose`, `react`, …) |
| `package.json` | Provides the `start` script |
| `next.config.ts` | Read when the production server starts |
| `.env` | Database, JWT, licence and sync configuration |

`tsconfig.json` and `next-env.d.ts` are harmless and can stay.

**Delete** (nothing here is needed at runtime):

```bash
rm -rf src scripts tests docs data .git .db-backup \
       MANUAL.md DEPLOYMENT.md README.md AGENTS.md CLAUDE.md \
       eslint.config.mjs postcss.config.mjs \
       vitest.config.ts vitest.integration.config.ts playwright.config.ts \
       test-results *.log
```

Notes:

- Import the data (`npm run seed`) **before** deleting `scripts/` and `data/`;
  after that the client PC has no seeder and no snapshot left to import.
- Deleting `.git/` removes the full history, so the code cannot be cloned back
  from the client machine. Keep your own repository elsewhere.
- Deleting `src/` prevents future `npm run build` on that machine. Build on your
  development PC, then copy the production folder to the client.
- Browser bundles in `.next/` and `public/sw.js` are still readable JavaScript;
  this hides the source tree, not compiled/minified code.
- For the smallest handover, `output: "standalone"` in `next.config.ts` emits a
  self-contained `.next/standalone` (server + traced `node_modules`) that runs
  with `node .next/standalone/server.js` after copying `public` and
  `.next/static` into it. The current setup uses `next start`.
