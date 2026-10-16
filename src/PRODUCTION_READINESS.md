# Production Readiness Report — Retail POS

## 1. Completed modules

- **Users & Access**
  - `/users` — create, edit, activate/deactivate, change password, assign role, assign branch, view activity (per-user audit log + last-30d sales count).
  - `/roles` — create, edit (permissions), clone, delete where safe (no assigned users; system roles protected; SuperAdmin-permission stripping guarded while active users depend on it).
  - `/permissions` → redirects to `/roles` so the permission matrix lives in one place.
  - `/audit-logs` — read-only, filterable (period, entity type, action, search), CSV export, expandable field diffs.
- **Settings & Branch management**
  - `/settings` — Store / POS / Inventory tabs plus a Branches tab.
  - Settings API: typed field whitelist with per-field validators; settings stored per-branch as key/value rows (`StoreSettings`) plus global (branchId null) defaults so the single-branch workflow is untouched.
  - Branches API: create/update with deactivation guards (active users + active products prevent deactivation).
  - Branch access control: `branch-access.ts` — Super Admin / HQ (branchId null) sees all; branch-restricted users see only their branch. Enforced on users, branches, audit logs, reports, finance, cash register listing, POS product scanner stock.
- **Audit log system**
  - New `src/lib/audit.ts` — `recordAuditLog()` used by users, roles, settings, branches, purchases, sales, and the healthcheck wiring. Shape: userId, action, entityType, entityId, oldValue/newValue (as a `changes` field), branchId, timestamp, ip, userAgent.
  - Audit rows are append-only: the audit-logs API has no POST/PUT/DELETE; writes only originate from server business flows via `recordAuditLog`.
  - Added sale-cancel endpoint at `/api/sales/[id]` PUT with audit entry; purchase-cancel endpoint (still missing from before) now done with stock + supplier balance reversal and audit.

## 2. Security issues fixed

- **Final Super Admin protection**
  - Users: cannot deactivate/demote/delete the last active SuperAdmin; users-with-sales-history are deactivated, never hard-deleted. Self-deactivation/deletion blocked.
  - Roles: system-role rename/delete blocked; SuperAdmin permission stripping with active dependents blocked.
  - Branches: deactivation blocked while active users/products exist.
- **Audit immutability**
  - Audit-logs route is read-only; no mutation APIs exist for it.
- **Branch data leakage hardened**
  - Branch scoping added to users (list/filter), audit logs (`branchId` filter), reports/finance purchasers view, customers POS listing, cash-register history, and the new settings/roles/permissions APIs where appropriate.
- **IDOR / access control**
  - Users `/[id]/activity` now asserts branch access before returning a target user's activity.
  - Delete/update actions assert `assertBranchAccess` against the target's branch when the caller is branch-restricted.
- **Injection hardening**
  - Settings API uses a field whitelist + per-field validators (no arbitrary keys).
  - Search inputs escaped in new audit-logs API; the new users list uses escaped regex for search.

## 3. Performance improvements

- **Branch-scoped queries** — branch-restricted queries are filtered early instead of returning full collections.
- **Settings caching** — `getStoreSettings()` caches for 30s per branch so settings reads on hot paths (sales, POS) don't hit the DB on every request.
- **Audit-log list** — paginated with proper indexes already present on `AuditLog(createdAt, userId, entityType+entityId)`; added `branchId` filter support.
- **Audit-log writes** — fire-and-forget, never throws into the caller; when inside a transaction the row commits atomically.

## 4. Database / index improvements

- Audit log already had indexes on createdAt, userId, entityType+entityId — good.
- StoreSettings has `{ branchId, key }` unique index — correct.
- New settings use branchId=null keys; those are covered by the same unique index (branchId null is a distinct value), so no duplicate-default-problem.
- No structural schema changes were required for the new modules.

## 5. Tests performed

- `npx tsc --noEmit` — clean before and after.
- `npm run build` — clean (0 errors). New routes show up in build manifest: `/roles`, `/users`, `/settings`, `/audit-logs` + `/api/spawn/healthcheck`.
- `npm run lint` — **0 errors** (104 pre-existing warnings remain, none introduced). All 47 prior errors fixed: 35 `react-hooks/set-state-in-effect`, 9 `no-explicit-any`, 2 `react-hooks/immutability`, 1 `prefer-const`.
- `npm test` — **new vitest unit suite (49 tests, 2 files)** covering: pricing/totals recalculation, line & sale discounts, tax, promo pricing, payment validation (underpay/overpay/credit/mixed/change), the `total === subtotal − discount + tax` invariant, report date-range parsing (day/week/month/custom), pagination, regex-escape injection guard, and branch-access isolation (`branchScope`, `canAccessBranch`, `assertBranchAccess`).
- DB smoke: MongoDB ping OK; roles/permissions/superAdmin counted; global settings seeded via script so the new Settings UI has defaults; 1 branch already present.

## 6. Remaining technical issues

- ~~Automated business-logic tests were not added~~ — **resolved**: `npm test` (vitest) now covers pricing, payments, date filtering, injection escaping, and branch isolation. Integration-level tests (concurrent sales, duplicate submissions against a live DB) remain covered only by `scripts/smoke-modules.ts` (manual run).
- ~~Sales detail + returns APIs do not yet emit audit rows~~ — **resolved**: `sale_return.create`, `sale_return.approve`, and `sale_return.reject` now call `recordAuditLog`.
- ~~Return approval side-effect gaps~~ — **resolved**: `approveSaleReturn` now (a) only writes the customer-ledger REFUND for credit sales (was unconditional) and (b) deducts cash refunds from the drawer (was missing).
- ~~`returns.requireApproval` tautology~~ — **resolved**: the API now reads the real `pos.refund_requires_approval` setting via `getStoreSettings` (previously a hardcoded `|| true` reading a nonexistent `returns.requireApproval` key — the settings toggle silently did nothing).
- **POS settings enforcement** — `allowNegativeStock`, `allowNegativeInventory`, `refundRequiresApproval`, `autoPrintReceipt` are stored and editable, but not all are enforced in the sale/return service/POS flow yet. `requireCustomerForCredit` and `maxCashierDiscountPercent` are enforced in the sales POST. `refundRequiresApproval` is now enforced by the returns API; the rest should be wired into `sales-service.ts` / POS client.
- **Purchase creation** — still uses a random 4-digit suffix for `purchaseNumber` instead of a documented counter; not audited for correctness here beyond the cancel flow.
- **`/api/spawn/healthcheck`** is a new internal-only diagnostic route used for the report; not a production feature.

### Summary
All four quality gates pass: lint 0 errors, typecheck clean, 49 automated tests green, production build clean. The previous main gaps (no automated tests, missing refund audit rows, return-approval side-effect bugs, dead approval toggle) are fixed. Remaining items are minor: partial POS-settings enforcement, purchaseNumber generation, and manual-run integration smoke tests.
