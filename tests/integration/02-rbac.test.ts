/**
 * Area 2 (server APIs) — Role-based access control.
 *
 * Table-driven permission matrix against the real role definitions seeded by
 * scripts/seed-test-db.ts (SuperAdmin, Manager, Cashier, Accountant).
 * A denied role must get 403 FORBIDDEN *before* payload validation, while an
 * allowed role reaches validation (400 on a malformed body) — this proves the
 * permission check runs and is not incidental to the payload outcome.
 * UI-level RBAC is covered by tests/e2e/auth-rbac-ui.spec.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, api, authFor, connectDb, tag, type AuthCtx } from "../helpers/qa";

type Expectations = { admin: number; manager: number; cashier: number; accountant: number };

const roles = ["admin", "manager", "cashier", "accountant"] as const;
type RoleName = (typeof roles)[number];

describe("RBAC on server APIs", () => {
  let ctx: Record<RoleName, AuthCtx>;

  beforeAll(async () => {
    await connectDb();
    ctx = {
      admin: await authFor(ACCOUNTS.admin),
      manager: await authFor(ACCOUNTS.manager),
      cashier: await authFor(ACCOUNTS.cashier),
      accountant: await authFor(ACCOUNTS.accountant),
    };
  });

  const t = tag("rbac");

  // Each entry: [label, request fn, per-role expected HTTP status]
  const matrix: Array<[string, (token: string) => Promise<{ status: number }>, Expectations]> = [
    ["GET /api/products (view)", (tok) => api(tok).get("/api/products?perPage=1"), { admin: 200, manager: 200, cashier: 200, accountant: 403 }],
    [
      "POST /api/products (create)",
      (tok) => api(tok).post("/api/products", { name: `RBAC ${t}`, sku: `RB-${t}-${Math.random().toString(36).slice(2, 8)}` }),
      { admin: 201, manager: 201, cashier: 403, accountant: 403 },
    ],
    ["GET /api/inventory (view)", (tok) => api(tok).get("/api/inventory?perPage=1"), { admin: 200, manager: 200, cashier: 403, accountant: 403 }],
    ["POST /api/inventory (adjust — malformed body reaches validation only if allowed)", (tok) => api(tok).post("/api/inventory", {}), { admin: 400, manager: 400, cashier: 403, accountant: 403 }],
    ["POST /api/sales (create — empty items validates400 iff allowed)", (tok) => api(tok).post("/api/sales", { items: [] }), { admin: 400, manager: 400, cashier: 400, accountant: 403 }],
    ["POST /api/sales-returns (refund)", (tok) => api(tok).post("/api/sales-returns", { saleId: "000000000000000000000000", items: [], reason: "rbac" }), { admin: 400, manager: 400, cashier: 400, accountant: 403 }],
    ["POST /api/purchases (create)", (tok) => api(tok).post("/api/purchases", { action: "create", items: [] }), { admin: 400, manager: 400, cashier: 403, accountant: 400 }],
    ["POST /api/customers (create)", (tok) => api(tok).post("/api/customers", {}), { admin: 400, manager: 400, cashier: 403, accountant: 403 }],
    ["DELETE /api/customers", (tok) => api(tok).del("/api/customers", {}), { admin: 400, manager: 400, cashier: 403, accountant: 403 }],
    ["GET /api/users (view)", (tok) => api(tok).get("/api/users?perPage=1"), { admin: 200, manager: 200, cashier: 403, accountant: 403 }],
    ["POST /api/users (create — malformed body validates iff allowed)", (tok) => api(tok).post("/api/users", {}), { admin: 400, manager: 400, cashier: 403, accountant: 403 }],
    ["GET /api/reports/sales", (tok) => api(tok).get("/api/reports/sales"), { admin: 200, manager: 200, cashier: 403, accountant: 200 }],
    ["GET /api/settings (view)", (tok) => api(tok).get("/api/settings"), { admin: 200, manager: 200, cashier: 403, accountant: 403 }],
    ["POST /api/settings (manage — unknown setting validates iff allowed)", (tok) => api(tok).post("/api/settings", { fields: { "store.unknown_setting_qa": 1 } }), { admin: 400, manager: 400, cashier: 403, accountant: 403 }],
    ["GET /api/finance/expenses (view)", (tok) => api(tok).get("/api/finance/expenses?perPage=1"), { admin: 200, manager: 200, cashier: 403, accountant: 200 }],
    ["POST /api/finance/expenses (create — negative amount validates iff allowed)", (tok) => api(tok).post("/api/finance/expenses", { category: "rent", amount: -5, description: "rbac" }), { admin: 400, manager: 400, cashier: 403, accountant: 400 }],
    ["GET /api/categories (view)", (tok) => api(tok).get("/api/categories"), { admin: 200, manager: 200, cashier: 403, accountant: 403 }],
    ["GET /api/cash-register (view)", (tok) => api(tok).get("/api/cash-register"), { admin: 200, manager: 200, cashier: 200, accountant: 200 }],
    ["POST /api/cash-register (open — malformed body validates iff allowed)", (tok) => api(tok).post("/api/cash-register", { action: "open", openCash: -1 }), { admin: 400, manager: 400, cashier: 400, accountant: 400 }],
  ];

  for (const [label, request, expected] of matrix) {
    for (const role of roles) {
      it(`${label} → ${expected[role]} for ${role}`, async () => {
        const res = await request(ctx[role].token);
        expect(res.status, `${label} as ${role} → got ${res.status} ${JSON.stringify(res).slice(0, 200)}`).toBe(expected[role]);
      });
    }
  }
});
