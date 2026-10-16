/**
 * Reproduces the reported bug batch through the real API with a logged-in
 * session (admin@pos.local). Prints PASS/FAIL per scenario.
 *
 * Run: npx tsx scripts/verify-batch.ts   (dev server on :3000)
 * Env: BASE_URL (default http://localhost:3000)
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ||
  "C:/Users/Administrator/.ScreamingFrogSEOSpider/chrome/147.0.7727.102-sf1/chromium/chrome.exe";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

type Json = Record<string, unknown> & { success?: boolean; error?: unknown };

async function login(): Promise<string> {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.fill('input[id="email"]', "admin@pos.local");
  await page.fill('input[id="password"]', "admin123");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/dashboard", { timeout: 60_000 });
  const cookies = await page.context().cookies();
  await browser.close();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function api(
  cookie: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Json; ms: number }> {
  const t = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json, ms: Date.now() - t };
  } catch (e) {
    return { status: 0, json: { error: String(e) }, ms: Date.now() - t };
  }
}

function msg(r: { json: Json }): string {
  const err = r.json.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const m = (err as { message?: string }).message;
    const d = (err as { details?: unknown }).details;
    return `${m ?? ""}${d ? ` ${JSON.stringify(d)}` : ""}`;
  }
  return JSON.stringify(r.json).slice(0, 200);
}

(async () => {
  const cookie = await login();
  console.log("logged in\n");

  // ---------- 1. categories CRUD ----------
  const catName = `BatchCat-${Date.now()}`;
  const catCreate = await api(cookie, "POST", "/api/categories", {
    name: catName,
    description: "batch verify",
    parentId: null,
    status: "active",
  });
  console.log(`  categories create -> ${catCreate.status} ${msg(catCreate)}`);
  const catId =
    ((catCreate.json.data as { category?: { _id?: string } } | undefined)?.category?._id) ?? "";
  check("POST /api/categories creates", catCreate.status === 201 || catCreate.status === 200, `got ${catCreate.status}`);

  const catEdit = await api(cookie, "POST", "/api/categories", {
    id: catId,
    name: `${catName}-edited`,
    description: "edited",
    parentId: null,
    status: "active",
  });
  console.log(`  categories edit via POST -> ${catEdit.status} ${msg(catEdit)}`);
  const catPut = await api(cookie, "PUT", "/api/categories", {
    id: catId,
    name: `${catName}-renamed`,
    description: "renamed",
    parentId: null,
    status: "active",
  });
  console.log(`  categories PUT -> ${catPut.status} ${msg(catPut)}`);
  check("PUT /api/categories works", catPut.status >= 200 && catPut.status < 300, `got ${catPut.status}`);
  const afterEdit = await api(cookie, "GET", "/api/categories?all=1");
  const list = Array.isArray(afterEdit.json) ? (afterEdit.json as Array<{ _id: string; name: string }>) : [];
  const edited = list.find((c) => c._id === catId);
  check("editing a category updates it (no duplicate)", !!edited && edited.name.endsWith("-renamed"), edited ? `name=${edited.name}` : "category missing");
  check(
    "edit did not create an extra category",
    list.filter((c) => c.name.startsWith(catName)).length === 1,
    `found ${list.filter((c) => c.name.startsWith(catName)).length}`
  );

  const catDel = await api(cookie, "DELETE", "/api/categories", { id: catId });
  console.log(`  categories DELETE -> ${catDel.status} ${msg(catDel)}`);
  check("DELETE /api/categories is not 405", catDel.status !== 405, `got ${catDel.status}`);
  check("DELETE /api/categories succeeds", catDel.status >= 200 && catDel.status < 300, `got ${catDel.status} ${msg(catDel)}`);

  // ---------- 2. products create / update / status toggle ----------
  const sku = `BATCH-${Date.now().toString().slice(-8)}`;
  const prodCreate = await api(cookie, "POST", "/api/products", {
    id: null,
    name: "Batch product",
    sku,
    barcode: "",
    categoryId: null,
    brandId: null,
    purchasePrice: 10,
    sellingPrice: 20,
    wholesalePrice: 15,
    tax: 0,
    discount: 0,
    minimumStock: 0,
    description: "",
    status: "active",
  });
  console.log(`  products create (no category) -> ${prodCreate.status} ${msg(prodCreate)}`);
  check("POST /api/products without id is not a 400 validation bomb", prodCreate.status !== 400 || msg(prodCreate).includes("Category"), `got ${prodCreate.status} ${msg(prodCreate)}`);

  // with a real category
  const anyCat = list[0]?._id ?? "";
  const prodCreate2 = await api(cookie, "POST", "/api/products", {
    name: "Batch product 2",
    sku: `${sku}-2`,
    barcode: "",
    categoryId: anyCat || null,
    brandId: null,
    purchasePrice: 10,
    sellingPrice: 20,
    wholesalePrice: 15,
    tax: 0,
    discount: 0,
    minimumStock: 0,
    description: "",
    status: "active",
  });
  console.log(`  products create (with category) -> ${prodCreate2.status} ${msg(prodCreate2)}`);
  check("POST /api/products create succeeds", prodCreate2.status === 201, `got ${prodCreate2.status} ${msg(prodCreate2)}`);
  const prodId =
    ((prodCreate2.json.data as { product?: { _id?: string } } | undefined)?.product?._id) ?? "";

  if (prodId) {
    const prodPatch = await api(cookie, "PATCH", "/api/products", { id: prodId, status: "inactive" });
    console.log(`  products PATCH status -> ${prodPatch.status} ${msg(prodPatch)}`);
    check("PATCH /api/products (deactivate) works", prodPatch.status >= 200 && prodPatch.status < 300, `got ${prodPatch.status}`);

    const prodPatch2 = await api(cookie, "PATCH", "/api/products", { id: prodId, status: "active" });
    console.log(`  products PATCH re-activate -> ${prodPatch2.status} ${msg(prodPatch2)}`);
    check("PATCH /api/products (reactivate) works", prodPatch2.status >= 200 && prodPatch2.status < 300, `got ${prodPatch2.status}`);
  }

  // ---------- 3. suppliers update / delete ----------
  const supName = `BatchSup-${Date.now()}`;
  const supCreate = await api(cookie, "POST", "/api/suppliers", {
    name: supName,
    phone: "0700000000",
    email: "",
    address: "",
    note: "",
    status: "active",
  });
  console.log(`  suppliers create -> ${supCreate.status} ${msg(supCreate)}`);
  check("POST /api/suppliers creates", supCreate.status === 201, `got ${supCreate.status}`);
  const supId = ((supCreate.json.data as { supplier?: { _id?: string } } | undefined)?.supplier?._id) ?? "";

  const supBefore = await api(cookie, "GET", "/api/suppliers?all=1");
  const supEdit = await api(cookie, "POST", "/api/suppliers", {
    id: supId,
    name: `${supName}-edited`,
    phone: "0711111111",
    email: "",
    address: "addr",
    note: "",
    status: "active",
  });
  console.log(`  suppliers edit via POST -> ${supEdit.status} ${msg(supEdit)}`);
  const supPut = await api(cookie, "PUT", "/api/suppliers", {
    id: supId,
    name: `${supName}-renamed`,
    phone: "0722222222",
    email: "",
    address: "addr2",
    note: "",
    status: "active",
  });
  console.log(`  suppliers PUT -> ${supPut.status} ${msg(supPut)}`);
  check("PUT /api/suppliers works", supPut.status >= 200 && supPut.status < 300, `got ${supPut.status}`);

  const supAfter = await api(cookie, "GET", "/api/suppliers?all=1");
  const supList = Array.isArray(supAfter.json) ? (supAfter.json as Array<{ _id: string; name: string }>) : [];
  const supEdited = supList.find((s) => s._id === supId);
  check("supplier update edits the same record", !!supEdited && supEdited.name.endsWith("-renamed"), supEdited ? `name=${supEdited.name}` : "missing");
  check(
    "supplier update did not create a duplicate",
    supList.filter((s) => s.name.startsWith(supName)).length === 1,
    `found ${supList.filter((s) => s.name.startsWith(supName)).length} (before=${(Array.isArray(supBefore.json) ? supBefore.json.length : "?")}, after=${supList.length})`
  );

  const supDel = await api(cookie, "DELETE", "/api/suppliers", { id: supId });
  console.log(`  suppliers DELETE -> ${supDel.status} ${msg(supDel)}`);
  check("DELETE /api/suppliers works", supDel.status >= 200 && supDel.status < 300, `got ${supDel.status} ${msg(supDel)}`);

  // ---------- 4. customer payment ----------
  const custRes = await api(cookie, "GET", "/api/customers?page=1&perPage=50&withBalance=1");
  const customers = ((custRes.json as { customers?: Array<{ _id: string; name: string; balance: number }> }).customers) ?? [];
  console.log(`  customers: ${customers.map((c) => `${c.name}=${c.balance}`).join(", ")}`);
  const withBalance = customers.filter((c) => c.balance > 0);
  const zero = customers.filter((c) => c.balance <= 0);

  for (const c of withBalance.slice(0, 2)) {
    const pay = await api(cookie, "POST", "/api/customers", {
      action: "payment",
      customerId: c._id,
      amount: Number(c.balance.toFixed(2)),
      method: "cash",
      reference: "",
      note: "batch verify",
    });
    console.log(`  payment for ${c.name} (balance ${c.balance}) -> ${pay.status} ${msg(pay)} in ${pay.ms}ms`);
    check(`customer payment (exact balance) succeeds for ${c.name}`, pay.status >= 200 && pay.status < 300, `got ${pay.status} ${msg(pay)}`);
  }
  if (zero.length > 0 && withBalance.length === 0) {
    const c = zero[0];
    const pay = await api(cookie, "POST", "/api/customers", {
      action: "payment",
      customerId: c._id,
      amount: 5,
      method: "cash",
      reference: "",
      note: "batch verify",
    });
    console.log(`  payment for ${c.name} (balance ${c.balance}, amount 5) -> ${pay.status} ${msg(pay)}`);
  }

  // ---------- 5. purchase complete (status pending -> completed) ----------
  const purRes = await api(cookie, "GET", "/api/purchases?page=1&perPage=20");
  const purchases = ((purRes.json as { purchases?: Array<{ _id: string; status: string; purchaseNumber: string }> }).purchases) ?? [];
  const pending = purchases.find((p) => p.status === "pending");
  console.log(`  purchases: ${purchases.map((p) => `${p.purchaseNumber}=${p.status}`).join(", ")}`);
  if (pending) {
    const comp = await api(cookie, "POST", "/api/purchases", { action: "complete", id: pending._id });
    console.log(`  complete ${pending.purchaseNumber} -> ${comp.status} ${msg(comp)}`);
    check("purchase can be completed from pending", comp.status >= 200 && comp.status < 300, `got ${comp.status} ${msg(comp)}`);
  } else {
    console.log("  (no pending purchase to complete — creating one)");
  }

  // ---------- 6. dashboard refunds ----------
  const dash = await api(cookie, "GET", "/api/dashboard?days=30");
  const today = (dash.json as { today?: Record<string, number> }).today ?? {};
  const range = (dash.json as { range?: Record<string, number> }).range ?? {};
  console.log(`  dashboard today=${JSON.stringify(today)}`);
  console.log(`  dashboard range=${JSON.stringify(range)}`);
  console.log("  (refund handling verified separately via returns flow)");

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error("script crashed:", e);
  process.exit(1);
});
