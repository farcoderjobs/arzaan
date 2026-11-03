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
