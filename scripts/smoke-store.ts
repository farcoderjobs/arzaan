/**
 * Smoke test for the Online Store module (public storefront + admin + report).
 * Mints an access token for the seeded admin user and exercises the APIs.
 *
 * Usage: start the app first (npm run dev / npm start), then:
 *   npx tsx scripts/smoke-store.ts [baseUrl]
 */
import "dotenv/config";
import { connectDB, disconnectDB } from "../src/lib/mongodb";
import { createAccessToken } from "../src/utils/auth";
import { User, StoreProduct, StoreOrder } from "../src/models";

const BASE = process.argv[2] ?? "http://localhost:3000";
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name} ${extra}`); }
}

async function api(path: string, init?: RequestInit, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON (CSV) */ }
  return { status: res.status, body: body as Record<string, unknown> };
}

async function main() {
  await connectDB();
  const admin = await User.findOne({ email: "admin@pos.local" }).lean<{ _id: unknown; roleId: unknown } | null>();
  check("admin user exists", Boolean(admin), "run seed-demo first");
  if (!admin) {
    await disconnectDB();
    process.exit(1);
  }
  const cookie = `pos_access_token=${createAccessToken(String(admin._id), String(admin.roleId))}`;
  const json = { "Content-Type": "application/json", Cookie: cookie };

  // ---------- Admin: create a store product ----------
  const marker = `Smoke Store Product ${Date.now()}`;
  const created = await api("/api/store/admin", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      name: marker,
      description: "Created by smoke-store.ts",
      price: 250,
      compareAtPrice: 300,
      category: "Beverages",
      stock: 3,
      featured: true,
      accent: "emerald",
      status: "active",
    }),
  });
  check("admin creates store product", created.status === 201, JSON.stringify(created.body).slice(0, 200));
  const product = (created.body as { data?: { product?: { id?: string; slug?: string } } })?.data?.product;
  const pid = product?.id ?? "";
  check("product id returned", Boolean(pid));

  // ---------- Admin: validation rejects bad input ----------
  const badPrice = await api("/api/store/admin", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Bad row", price: -5 }),
  });
  check("negative price rejected", badPrice.status === 400);

  const badCompare = await api("/api/store/admin", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Bad compare", price: 100, compareAtPrice: 50 }),
  });
  check("compare-at <= price rejected", badCompare.status === 400);

  // ---------- Public: storefront lists only active products ----------
  const pub = await api("/api/store/products");
  const listed = (pub.body as { products?: Array<{ id: string; price: number; inStock: boolean; stock: number }> })?.products ?? [];
  check("public listing includes product", listed.some((p) => p.id === pid));
  check("public listing hides admin-only fields", !JSON.stringify(listed).includes("costPrice"));

  // Hidden products must disappear from the storefront.
  await api("/api/store/admin", { method: "PATCH", headers: json, body: JSON.stringify({ id: pid, status: "inactive" }) });
  const pubHidden = await api("/api/store/products");
  const listedHidden = (pubHidden.body as { products?: Array<{ id: string }> })?.products ?? [];
  check("inactive product hidden from store", !listedHidden.some((p) => p.id === pid));
  await api("/api/store/admin", { method: "PATCH", headers: json, body: JSON.stringify({ id: pid, status: "active" }) });

  // ---------- Public: checkout is server-priced ----------
  const orderRes = await api("/api/store/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // NOTE: deliberately no price from the client — ids + quantities only.
    body: JSON.stringify({
      customerName: "Smoke Buyer",
      phone: "070 123 4567",
      address: "Kabul, Shahr-e Naw",
      note: "call before arriving",
      items: [{ productId: pid, quantity: 2 }],
    }),
  });
  check("checkout accepted", orderRes.status === 201, JSON.stringify(orderRes.body).slice(0, 200));
  const order = (orderRes.body as { data?: { id?: string; orderNumber?: string; total?: number } })?.data;
  check("checkout total is server-priced (250 × 2 = 500)", order?.total === 500, `got ${order?.total}`);

  // Stock must be 3 − 2 = 1 now.
  const afterBuy = await StoreProduct.findById(pid).lean<{ stock: number }>();
  check("stock decremented on checkout (3 → 1)", afterBuy?.stock === 1, `got ${afterBuy?.stock}`);

  // ---------- Public: overselling is rejected ----------
  const over = await api("/api/store/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "Greedy Buyer", phone: "0711111111", items: [{ productId: pid, quantity: 5 }] }),
  });
  check("overselling rejected", over.status === 400);

  // ---------- Public: validation ----------
  const noPhone = await api("/api/store/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "No Phone", phone: "", items: [{ productId: pid, quantity: 1 }] }),
  });
  check("checkout without phone rejected", noPhone.status === 400);

  // ---------- Admin: order visible + status flow ----------
  const orders = await api(`/api/store/orders/admin?search=${encodeURIComponent(order?.orderNumber ?? "")}`, undefined, cookie);
  const found = ((orders.body as { orders?: Array<{ id: string; status: string; phone: string }> })?.orders ?? [])[0];
  check("admin finds the order", Boolean(found), JSON.stringify(orders.body).slice(0, 200));
  check("order captured customer phone", found?.phone === "070 123 4567", `got ${found?.phone}`);

  // Invalid transition must be rejected (pending → delivered).
  if (found) {
    const skip = await api("/api/store/orders/admin", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ id: found.id, status: "delivered" }),
    });
    check("invalid status transition rejected", skip.status === 400);

    const confirmed = await api("/api/store/orders/admin", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ id: found.id, status: "confirmed" }),
    });
    check("pending → confirmed", confirmed.status === 200);
  }

  // ---------- Report: revenue reflects the order ----------
  const report = await api("/api/reports/store?period=day", undefined, cookie);
  const summary = (report.body as { summary?: { revenue?: number; orders?: number; units?: number; pending?: number } })?.summary;
  check("store report includes revenue", (summary?.revenue ?? 0) >= 500, `revenue=${summary?.revenue}`);
  check("store report counts units", (summary?.units ?? 0) >= 2, `units=${summary?.units}`);
  const csv = await fetch(`${BASE}/api/reports/store?format=csv`, { headers: { Cookie: cookie } });
  check("store report CSV export", csv.status === 200 && (csv.headers.get("content-type") ?? "").includes("text/csv"));

  // ---------- Permission gates ----------
  // NOTE: the app's convention returns 500 "Internal error" for unauthenticated
  // API calls (requireSessionUser throws inside the route's try/catch), so the
  // gate is "no data leaks", not a specific status code.
  const anonAdmin = await api("/api/store/admin");
  check(
    "anonymous cannot list admin products",
    anonAdmin.status !== 200 && !JSON.stringify(anonAdmin.body).includes(marker),
    `status=${anonAdmin.status}`
  );
  const anonReport = await api("/api/reports/store");
  check(
    "anonymous cannot read store report",
    anonReport.status !== 200 || (anonReport.body as { summary?: unknown })?.summary === undefined,
    `status=${anonReport.status}`
  );
  const anonPatch = await api("/api/store/orders/admin", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: found?.id ?? pid, status: "canceled" }),
  });
  const orderAfterAnon = await StoreOrder.findById(found?.id).lean<{ status: string }>();
  check(
    "anonymous cannot change order status",
    anonPatch.status !== 200 && orderAfterAnon?.status === "confirmed",
    `status=${anonPatch.status} orderStatus=${orderAfterAnon?.status}`
  );

  // ---------- Cleanup ----------
  await StoreOrder.deleteMany({ orderNumber: order?.orderNumber });
  await StoreProduct.deleteOne({ _id: pid });

  console.log(`\n${passed} passed, ${failed} failed`);
  await disconnectDB();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke-store crashed:", err);
  process.exit(1);
});
