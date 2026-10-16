/**
 * End-to-end verification of the reported broken flows against the running dev
 * server, through the real APIs (same calls the UI makes). Creates its own
 * tagged test data and removes it afterwards.
 *
 * Run: npx tsx scripts/_e2e-flows.ts "<access token>"   (dev server on :3000)
 */
import fs from "fs";
import { connectDB, disconnectDB } from "@/lib/mongodb";
import {
  Customer,
  CustomerTransaction,
  Sale,
  SaleReturn,
  InventoryMovement,
  CashTransaction,
  Supplier,
  SupplierTransaction,
  Purchase,
  Payment,
} from "@/models";

const BASE = "http://localhost:3000";
const TOK = process.argv[2] ?? fs.readFileSync("/tmp/tok.txt", "utf8").trim();
const H = { Cookie: `pos_access_token=${TOK}`, "Content-Type": "application/json" };

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
const approx = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

// Typed accessors for loosely-shaped API JSON (repo convention: no explicit any).
type Json = Record<string, unknown>;
const asRow = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asRows = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {}
  return { status: res.status, body: parsed };
}
const msg = (r: { body: Json }) => {
  const err = r.body.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Json).message;
    if (typeof m === "string") return m;
  }
  return JSON.stringify(r.body).slice(0, 200);
};

const TAG = `repro-${Date.now()}`;
let testCustomerId = "";
const testSaleIds: string[] = [];
let testSupplierId = "";
let testPurchaseId = "";
const testPaymentTxIds: string[] = [];

async function cleanup() {
  // Sales + returns + everything referencing them
  if (testSaleIds.length) {
    const rets = await SaleReturn.find({ saleId: { $in: testSaleIds } }).select("_id");
    const refIds = [...testSaleIds, ...rets.map((r) => r._id)];
    await InventoryMovement.deleteMany({ referenceId: { $in: refIds } });
    await CashTransaction.deleteMany({ referenceId: { $in: refIds } });
    await SaleReturn.deleteMany({ saleId: { $in: testSaleIds } });
    await Sale.deleteMany({ _id: { $in: testSaleIds } });
  }
  // Customer + ledger
  if (testCustomerId) {
    await CustomerTransaction.deleteMany({ customerId: testCustomerId });
    await Customer.deleteOne({ _id: testCustomerId });
  }
  // Supplier payment artifacts
  if (testPaymentTxIds.length) {
    await Payment.deleteMany({ referenceId: { $in: testPaymentTxIds } });
    await CashTransaction.deleteMany({ referenceId: { $in: testPaymentTxIds } });
  }
  if (testSupplierId) {
    await SupplierTransaction.deleteMany({ supplierId: testSupplierId });
    await InventoryMovement.deleteMany({ referenceId: testPurchaseId });
    await CashTransaction.deleteMany({ referenceId: testPurchaseId });
    await Purchase.deleteOne({ _id: testPurchaseId });
    await Supplier.deleteOne({ _id: testSupplierId });
  }
}

async function main() {
  await connectDB();

  // ============================================================
  // A. Customer: credit sale → outstanding balance → payment
  // ============================================================
  console.log("\n--- A. customer payment flow ---");
  const cust = await call("POST", "/api/customers", {
    name: `ZZ Repro Customer ${TAG}`,
    phone: "0700000001",
    email: "",
    address: "",
    notes: "",
    status: "active",
    branchId: null,
  });
  check("create test customer", cust.status === 201, `${cust.status} ${msg(cust)}`);
  testCustomerId = str(asRow(asRow(cust.body.data).customer)._id);

  const prods = await call("GET", "/api/products?perPage=100");
  const productList = asRows(prods.body.products);
  const p0 = productList.find(
    (p) => str(p.status) === "active" && Number(p.taxRate ?? 0) === 0 && Number(p.discountPrice ?? 0) === 0
  );
  check("found a tax-free test product", !!p0, JSON.stringify(productList.slice(0, 3)));

  if (testCustomerId && p0) {
    const price = Number(p0.sellingPrice);
    const creditTag = `repro-credit-${Date.now()}`;
    const sale = await call("POST", "/api/sales", {
      clientTransactionId: creditTag,
      customerId: testCustomerId,
      items: [{ productId: p0._id, quantity: 1, unitDiscount: 0 }],
      discount: 0,
      discountType: "amount",
      payments: [{ method: "credit", amount: price, reference: "" }],
      note: "repro credit sale",
      status: "completed",
    });
    const saleId = str(asRow(sale.body.data).id);
    if (saleId) testSaleIds.push(saleId);
    check(`credit sale completes (${price})`, sale.status === 201 || sale.status === 200, `${sale.status} ${msg(sale)}`);

    const list = await call("GET", "/api/customers?page=1&perPage=100&withBalance=1");
    const me = asRows(list.body.customers).find((c) => c._id === testCustomerId);
    check(
      "credit sale creates outstanding balance",
      !!me && approx(Number(me.balance), price),
      `balance=${String(me?.balance)} expected=${price}`
    );

    if (me && Number(me.balance) > 0) {
      // exact displayed balance must be accepted
      const pay = await call("POST", "/api/customers", {
        action: "payment",
        customerId: testCustomerId,
        amount: me.balance,
        method: "cash",
        reference: "repro",
        note: "",
      });
      check("record payment for exact balance succeeds", pay.status === 201, `${pay.status} ${msg(pay)}`);

      const list2 = await call("GET", "/api/customers?page=1&perPage=100&withBalance=1");
      const me2 = asRows(list2.body.customers).find((c) => c._id === testCustomerId);
      check("payment zeroes the balance", !!me2 && approx(Number(me2.balance), 0), `balance=${String(me2?.balance)}`);

      // overpay without allowOverpay → 400 (expected business rule)
      const over = await call("POST", "/api/customers", {
        action: "payment",
        customerId: testCustomerId,
        amount: 50,
        method: "cash",
        reference: "",
        note: "",
      });
      check("overpayment rejected with 400 + message", over.status === 400 && !!msg(over), `${over.status} ${msg(over)}`);
    }
  }

  // ============================================================
  // B. Supplier payment reduces the purchase "due"
  // ============================================================
  console.log("\n--- B. supplier payment reduces purchase due ---");
  const sup = await call("POST", "/api/suppliers", {
    name: `ZZ Repro Supplier ${TAG}`,
    phone: "0700000002",
    email: "",
    address: "",
    note: "",
    status: "active",
  });
  check("create test supplier", sup.status === 201, `${sup.status} ${msg(sup)}`);
  testSupplierId = str(asRow(asRow(sup.body.data).supplier)._id);

  if (testSupplierId && p0) {
    const pur = await call("POST", "/api/purchases", {
      action: "create",
      supplierId: testSupplierId,
      items: [{ productId: p0._id, quantity: 2, purchasePrice: 100, discount: 0, tax: 0 }],
      discount: 0,
      tax: 0,
      paymentMethod: "account",
      paidAmount: 0,
      note: "repro purchase",
    });
    testPurchaseId = str(asRow(asRow(pur.body.data).purchase)._id);
    check("create purchase (due 200)", pur.status === 201, `${pur.status} ${msg(pur)}`);

    if (testPurchaseId) {
      const before = await call("GET", "/api/purchases?page=1&perPage=100");
      const row0 = asRows(before.body.purchases).find((p) => p._id === testPurchaseId);
      check("purchase starts fully due", !!row0 && approx(Number(row0.dueAmount), 200), `due=${String(row0?.dueAmount)}`);

      const pay1 = await call("POST", "/api/finance/supplier-payments", {
        supplierId: testSupplierId,
        amount: 50,
        method: "transfer",
        reference: "repro",
        note: "",
        allowOverpay: false,
      });
      check("record supplier payment (50)", pay1.status === 201, `${pay1.status} ${msg(pay1)}`);
      const tid1 = str(asRow(pay1.body.data).transactionId);
      if (tid1) testPaymentTxIds.push(tid1);

      const after1 = await call("GET", "/api/purchases?page=1&perPage=100");
      const row1 = asRows(after1.body.purchases).find((p) => p._id === testPurchaseId);
      check("payment reduces purchase due (200 → 150)", !!row1 && approx(Number(row1.dueAmount), 150), `due=${String(row1?.dueAmount)}`);

      const pay2 = await call("POST", "/api/finance/supplier-payments", {
        supplierId: testSupplierId,
        amount: 150,
        method: "transfer",
        reference: "repro2",
        note: "",
        allowOverpay: false,
      });
      check("record supplier payment (rest)", pay2.status === 201, `${pay2.status} ${msg(pay2)}`);
      const tid2 = str(asRow(pay2.body.data).transactionId);
      if (tid2) testPaymentTxIds.push(tid2);

      const after2 = await call("GET", "/api/purchases?page=1&perPage=100");
      const row2 = asRows(after2.body.purchases).find((p) => p._id === testPurchaseId);
      check("purchase due reaches 0", !!row2 && approx(Number(row2.dueAmount), 0), `due=${String(row2?.dueAmount)}`);

      // third payment would exceed balance → 400 (business rule)
      const pay3 = await call("POST", "/api/finance/supplier-payments", {
        supplierId: testSupplierId,
        amount: 10,
        method: "transfer",
        reference: "repro3",
        note: "",
        allowOverpay: false,
      });
      check("over-payment rejected with 400", pay3.status === 400, `${pay3.status} ${msg(pay3)}`);
    }
  }

  // ============================================================
  // C. Refund shows up in the dashboard (sale → refund → KPI)
  // ============================================================
  console.log("\n--- C. dashboard refunds ---");
  const dash0 = await call("GET", "/api/dashboard?days=1");
  const today0 = asRow(dash0.body.today);
  const s0 = Number(today0.sales ?? 0);
  const r0 = Number(today0.refunds ?? 0);
  check("dashboard exposes refunds field", typeof today0.refunds === "number", JSON.stringify(today0));

  if (p0) {
    const price = Number(p0.sellingPrice);
    const saleTag = `repro-dash-${Date.now()}`;
    const sale = await call("POST", "/api/sales", {
      clientTransactionId: saleTag,
      customerId: null,
      items: [{ productId: p0._id, quantity: 1, unitDiscount: 0 }],
      discount: 0,
      discountType: "amount",
      payments: [{ method: "card", amount: price, reference: "" }],
      note: "repro dashboard sale",
      status: "completed",
    });
    const saleId = str(asRow(sale.body.data).id);
    if (saleId) testSaleIds.push(saleId);
    check("card sale completes", !!saleId, `${sale.status} ${msg(sale)}`);

    const dash1 = await call("GET", "/api/dashboard?days=1");
    const s1 = Number(asRow(dash1.body.today).sales ?? 0);
    check("sale increases dashboard sales", approx(s1, s0 + price), `now=${s1} before=${s0} price=${price}`);

    if (saleId) {
      const ret = await call("POST", "/api/sales-returns", {
        saleId,
        items: [{ productId: p0._id, quantity: 1 }],
        refundMethod: "cash",
        reason: "repro refund test",
        note: "",
      });
      const retStatus = str(asRow(ret.body.data).status);
      const retId = str(asRow(ret.body.data).id);
      check("return created", ret.status === 201, `${ret.status} ${msg(ret)}`);
      if (retStatus === "pending" && retId) {
        const appr = await call("PUT", "/api/sales-returns", { id: retId, action: "approve" });
        check("pending return approved", appr.status === 200, `${appr.status} ${msg(appr)}`);
      }

      const dash2 = await call("GET", "/api/dashboard?days=1");
      const today2 = asRow(dash2.body.today);
      const s2 = Number(today2.sales ?? 0);
      const r2 = Number(today2.refunds ?? 0);
      check("refund reduces dashboard sales", approx(s2, s0), `now=${s2} expected=${s0}`);
      check("refund appears in dashboard refunds", approx(r2, r0 + price), `now=${r2} expected=${r0 + price}`);
    }
  }

  // ============================================================
  await cleanup();
  console.log(`\nRESULT: ${passed} passed, ${failed} failed (test data cleaned up)`);
  await disconnectDB();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  try {
    await cleanup();
  } catch {}
  process.exit(1);
});
