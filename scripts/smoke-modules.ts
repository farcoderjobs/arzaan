/**
 * Smoke test for the Cash Register / Finance / Reports / Dashboard modules.
 * Mints an access token for the seeded admin user and exercises the APIs.
 */
import "dotenv/config";
import { connectDB, disconnectDB } from "../src/lib/mongodb";
import { createAccessToken } from "../src/utils/auth";
import { User } from "../src/models";

const BASE = "http://localhost:3000";
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name} ${extra}`); }
}

async function api(path: string, init?: RequestInit, adminCookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(adminCookie ? { Cookie: adminCookie } : {}), ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: body as Record<string, unknown> };
}

async function main() {
  await connectDB();
  const admin = await User.findOne({ email: "admin@pos.local" }).lean<{ _id: unknown; roleId: unknown } | null>();
  check("admin user exists", Boolean(admin), "run src/scripts/seed-demo.ts first");
  if (!admin) {
    await disconnectDB();
    process.exit(1);
  }
  const token = createAccessToken(String(admin._id), String(admin.roleId));
  const cookie = `pos_access_token=${token}`;
  const jsonHeaders = { "Content-Type": "application/json", Cookie: cookie };

  const cookieHeaders = { Cookie: cookie };

  // ---------- Cash Register ----------
  // Close any leftover session from a previous run so the test is idempotent
  const pre = await api("/api/cash-register", undefined, cookie);
  const preSession = pre.body?.session as { _id: string; status: string; expectedCash: number } | null;
  if (preSession && preSession.status === "open") {
    await api("/api/cash-register", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ action: "close", registerId: preSession._id, countedCash: preSession.expectedCash, note: "smoke cleanup" }),
    });
  }

  const opened = await api("/api/cash-register", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ action: "open", openCash: 100, note: "smoke test" }),
  });
  check("open register", opened.status === 201, JSON.stringify(opened.body).slice(0, 200));
  const registerId = (opened.body?.data as { registerId?: string } | undefined)?.registerId ?? "";

  const cashIn = await api("/api/cash-register", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ action: "cash-in", amount: 25, description: "Owner float deposit" }),
  });
  check("cash-in movement", cashIn.status === 201, JSON.stringify(cashIn.body).slice(0, 200));

  const cashOut = await api("/api/cash-register", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ action: "cash-out", amount: 10, description: "Tea for the team" }),
  });
  check("cash-out movement", cashOut.status === 201, JSON.stringify(cashOut.body).slice(0, 200));

  // Second open must be blocked (one open register per cashier)
  const secondOpen = await api("/api/cash-register", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ action: "open", openCash: 50 }),
  });
  check("one open register per cashier enforced", secondOpen.status === 400, JSON.stringify(secondOpen.body).slice(0, 200));

  const current = await api("/api/cash-register", undefined, cookie);
  const summary = (current.body?.summary ?? {}) as Record<string, number>;
  check("current session summary", current.status === 200 && summary.expectedCash === 115, `expected=115 got=${summary.expectedCash}`);
  check("opening cash recorded", summary.openingCash === 100, `got=${summary.openingCash}`);

  // ---------- Finance: cash expense (should draw from the open register) ----------
  const expense = await api("/api/finance/expenses", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ category: "transport", amount: 15, paymentMethod: "cash", description: "Smoke test taxi", reference: "TX-1" }),
  });
  check("create cash expense", expense.status === 201, JSON.stringify(expense.body).slice(0, 200));

  const afterExpense = await api("/api/cash-register", undefined, cookie);
  const s2 = (afterExpense.body?.summary ?? {}) as Record<string, number>;
  check("cash expense deducted from drawer", s2.expectedCash === 100, `expected=100 got=${s2.expectedCash}`);

  // Cancel the expense → money returns to drawer
  const expenseId = ((expense.body?.data as { id?: string } | undefined)?.id ?? "");
  if (expenseId) {
    const canceled = await api("/api/finance/expenses", {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({ id: expenseId }),
    });
    check("cancel expense (no physical delete)", canceled.status === 200, JSON.stringify(canceled.body).slice(0, 200));
    const s3 = await api("/api/cash-register", undefined, cookie);
    const sum3 = (s3.body?.summary ?? {}) as Record<string, number>;
    check("canceled cash expense returns to drawer", sum3.expectedCash === 115, `expected=115 got=${sum3.expectedCash}`);
  }

  // ---------- Cash sale via completeSale ----------
  const prodRes = await api("/api/pos/products?perPage=1", undefined, cookie);
  const product = (prodRes.body as { products?: Array<{ _id: string; currentStock: number }> } | undefined)?.products?.[0];
  check("pos product available for sale", Boolean(product));
  if (product && product.currentStock > 0) {
    const sale = await api("/api/sales", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        items: [{ productId: product._id, quantity: 1, unitDiscount: 0 }],
        discount: 0,
        discountType: "amount",
        payments: [{ method: "cash", amount: 100, reference: "" }],
        note: "smoke sale",
        status: "completed",
      }),
    });
    check("cash sale completes against open register", sale.status === 201, JSON.stringify(sale.body).slice(0, 300));

    const afterSale = await api("/api/cash-register", undefined, cookie);
    const s4 = (afterSale.body?.summary ?? {}) as Record<string, number>;
    check("cash sale added to drawer (net of change)", (s4.cashSales ?? 0) > 0, `cashSales=${s4.cashSales}`);

    // Cash sale without register must be rejected — close first, then try
    const sessionNow = await api("/api/cash-register", undefined, cookie);
    const sessionIdNow = (sessionNow.body?.session as { _id: string } | null)?._id ?? "";
    const closed = await api("/api/cash-register", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ action: "close", registerId: registerId || sessionIdNow, countedCash: s4.expectedCash, note: "smoke close" }),
    });
    const closedData = closed.body?.data as { expectedCash?: number; countedCash?: number; difference?: number } | undefined;
    check("close register returns summary", closed.status === 200 && closedData?.countedCash !== undefined, JSON.stringify(closed.body).slice(0, 200));

    const saleNoRegister = await api("/api/sales", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        items: [{ productId: product._id, quantity: 1, unitDiscount: 0 }],
        discount: 0,
        discountType: "amount",
        payments: [{ method: "cash", amount: 100, reference: "" }],
        note: "no register",
        status: "completed",
      }),
    });
    check("cash sale rejected without open register", saleNoRegister.status === 400 && JSON.stringify(saleNoRegister.body).includes("NO_OPEN_REGISTER"), JSON.stringify(saleNoRegister.body).slice(0, 200));
  }

  // ---------- Reports ----------
  const reports = [
    "/api/reports/sales?groupBy=day",
    "/api/reports/sales?groupBy=cashier",
    "/api/reports/sales?groupBy=category",
    "/api/reports/products?view=best",
    "/api/reports/products?view=never",
    "/api/reports/inventory?view=valuation",
    "/api/reports/inventory?view=movements",
    "/api/reports/purchases?view=by-supplier",
    "/api/reports/purchases?view=outstanding",
    "/api/reports/customers?view=balances",
    "/api/reports/suppliers?view=purchases",
    "/api/reports/finance?view=expenses",
    "/api/reports/finance?view=cashflow",
    "/api/reports/profit",
  ];
  for (const r of reports) {
    const res = await api(r, undefined, cookie);
    check(`report ${r.split("?")[0]} (${r.split("?")[1] ?? ""})`, res.status === 200, JSON.stringify(res.body).slice(0, 150));
  }

  // CSV export
  const csvRes = await fetch(`${BASE}/api/reports/profit?format=csv`, { headers: { Cookie: cookie } });
  const csvText = await csvRes.text();
  check("profit CSV export", csvRes.status === 200 && csvText.includes("Gross Profit"), csvText.slice(0, 100));

  // ---------- Dashboard ----------
  const dash = await api("/api/dashboard?days=7", undefined, cookie);
  check("dashboard payload", dash.status === 200 && typeof (dash.body as { today?: { sales?: number } }).today?.sales === "number", JSON.stringify(dash.body).slice(0, 150));
  const dashToday = (dash.body as { today?: Record<string, unknown> }).today ?? {};
  check("dashboard cash sales tracked", "cashSales" in dashToday, JSON.stringify(dashToday).slice(0, 150));

  // ---------- Pages render ----------
  for (const page of ["/cash-register", "/finance", "/reports", "/reports/sales", "/reports/profit", "/dashboard"]) {
    const res = await fetch(`${BASE}${page}`, { headers: { Cookie: cookie } });
    check(`page ${page} renders`, res.status === 200, `status=${res.status}`);
  }

  await disconnectDB();
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
