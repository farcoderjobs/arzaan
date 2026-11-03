/**
 * Offline-first operation, through the browser:
 *
 *   1. the center (the online database) is down — Sync Now reports the outage
 *      and keeps everything queued instead of dropping it;
 *   2. the POS keeps selling, shows the local-first banner and flags the
 *      receipt as awaiting sync;
 *   3. the browser restarts — the pending change is still queued, because the
 *      queue lives in the shop's local MongoDB and never in the page;
 *   4. the center comes back — Sync Now drains the queue and confirms it;
 *   5. a repeated sync pushes nothing a second time (idempotent).
 *
 * The center is a stub on its own port that either drops connections or
 * proxies to the QA server. playwright.config.ts points the QA server's
 * SYNC_ONLINE_URL at it and scripts/seed-test-db.ts seeds the matching node
 * credentials, so the app server itself never has to restart to "lose" the
 * online database.
 */
import "./env";
import http from "node:http";
import { test, expect, type Page } from "@playwright/test";
import {
  ACCOUNTS,
  api,
  authFor,
  connectDb,
  createProduct,
  createSupplier,
  dbStock,
  openRegister,
  purgeTag,
  receiveStock,
  tag,
} from "../helpers/qa";
import { InventoryMovement, Sale, SyncOutbox } from "../../src/models";

const PASSWORD = process.env.QA_USER_PASSWORD ?? "qa-test-pass-123!";
const STUB_PORT = Number(process.env.QA_CENTER_STUB_PORT || "3999");
const UPSTREAM = new URL(process.env.QA_BASE_URL || "http://localhost:3210");

/** "down" drops every connection (the center is offline); "up" proxies it. */
let centerMode: "down" | "up" = "down";
let stub: http.Server | null = null;

function startCenterStub(): Promise<void> {
  stub = http.createServer((req, res) => {
    if (centerMode === "down") {
      req.socket.destroy();
      return;
    }
    const proxyReq = http.request(
      {
        host: "127.0.0.1",
        port: Number(UPSTREAM.port || 80),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: UPSTREAM.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxyReq);
  });
  return new Promise((resolve, reject) => {
    stub!.once("error", reject);
    stub!.listen(STUB_PORT, "127.0.0.1", () => resolve());
  });
}

function stopCenterStub(): Promise<void> {
  return new Promise((resolve) => {
    if (!stub) return resolve();
    stub.closeAllConnections?.();
    stub.close(() => resolve());
  });
}

type SyncStatus = {
  counts: { pending: number; sending: number; failed: number; synced: number; conflicts: number };
  connectivity: { reachable: boolean | null };
  runs: Array<{ status: string; pushed: number; failed: number; conflicted: number; remaining: number }>;
};

async function syncStatus(token: string): Promise<SyncStatus> {
  const res = await fetch(`${UPSTREAM.origin}/api/sync/status`, {
    headers: { cookie: `pos_access_token=${token}` },
    cache: "no-store",
  });
  expect(res.status, "sync status is readable for the cashier").toBe(200);
  return res.json();
}

async function loginAsCashier(page: Page) {
  await page.goto("/login");
  await page.fill("#email", ACCOUNTS.cashier);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard**", { timeout: 60_000 });
}

test.describe.serial("offline-first sync", () => {
  const runTag = tag("ofl");
  const PURCHASE_QTY = 5;
  const SELLING_PRICE = 30;

  let adminToken = "";
  let cashierToken = "";
  let product: { _id: string; name: string; barcode: string; sku: string };
  let invoice = "";
  let saleId = "";

  test.beforeAll(async () => {
    await startCenterStub();
    await connectDb();
    adminToken = (await authFor(ACCOUNTS.admin)).token;
    cashierToken = (await authFor(ACCOUNTS.cashier)).token;
  });

  test.afterAll(async () => {
    try {
      const current = await api(cashierToken).get("/api/cash-register");
      if (current.body?.session?._id) {
        await api(cashierToken).post("/api/cash-register", {
          action: "close",
          registerId: current.body.session._id,
          countedCash: 0,
          note: "QA cleanup",
        });
      }
    } catch {
      /* teardown only */
    }
    await purgeTag(runTag).catch(() => undefined);
    await stopCenterStub();
  });

  test("setup: stocked product and an open drawer", async () => {
    centerMode = "down";

    const supplier = await createSupplier(adminToken);
    product = await createProduct(adminToken, {
      tag: runTag,
      sellingPrice: SELLING_PRICE,
      purchasePrice: 10,
    });

    const purchase = await receiveStock(adminToken, {
      supplierId: supplier._id,
      productId: product._id,
      quantity: PURCHASE_QTY,
      purchasePrice: 10,
      paymentMethod: "transfer",
      paidAmount: PURCHASE_QTY * 10,
      note: runTag,
    });
    expect(purchase.total).toBe(PURCHASE_QTY * 10);
    expect(await dbStock(product._id)).toBe(PURCHASE_QTY);

    await openRegister(cashierToken, 0);
  });

  test("Sync Now reports the outage and keeps every change queued", async () => {
    centerMode = "down";
    // Outbox rows are only eligible once the commit-grace window has passed.
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const before = await syncStatus(cashierToken);
    expect(before.counts.pending, "the setup above queued local changes").toBeGreaterThan(0);

    const run = await api(cashierToken).post("/api/sync/run", {});
    expect(run.status).toBe(200);
    expect(run.body.data.reachable, "the center refused every connection").toBe(false);
    expect(run.body.data.failed, "each queued row was attempted").toBeGreaterThan(0);

    const after = await syncStatus(cashierToken);
    expect(after.counts.pending, "an outage never drops queued work").toBeGreaterThanOrEqual(
      before.counts.pending
    );
    expect(after.connectivity.reachable, "status reports the center as unreachable").toBe(false);
  });

  test("the POS keeps selling while the center is down and flags the receipt", async ({ page }) => {
    centerMode = "down";
    const before = await syncStatus(cashierToken);

    await loginAsCashier(page);
    await page.goto("/pos");
    await expect(page.locator("[data-offline-banner]")).toBeVisible();

    const search = page.getByPlaceholder(/Scan barcode/);
    await search.click();
    await search.fill(product.barcode);
    await search.press("Enter");

    await page.getByRole("button", { name: /Payment \(F4\)/ }).click();
    await page.getByRole("button", { name: /Complete Sale/ }).click();
    await expect(page.getByText("Sale Completed").last()).toBeVisible({ timeout: 30_000 });

    // The receipt tells the cashier the sale is local, not yet on the center.
    await expect(page.getByText(/Saved on this device/).first()).toBeVisible();

    const invoiceText = (await page.locator(".font-mono").filter({ hasText: /INV/ }).first().textContent()) ?? "";
    invoice = invoiceText.trim();
    expect(invoice).toMatch(/^INV-/);

    // Local truth: one sale, its stock movement, and a queued row for it.
    const sales = await Sale.find({ invoiceNumber: invoice }).lean();
    expect(sales).toHaveLength(1);
    saleId = String(sales[0]._id);
    const movements = await InventoryMovement.find({ referenceId: sales[0]._id, movementType: "SALE_OUT" }).lean();
    expect(movements).toHaveLength(1);
    expect(await dbStock(product._id)).toBe(PURCHASE_QTY - 1);

    const saleRow = await SyncOutbox.findOne({ collectionName: "sales", docId: saleId }).lean();
    expect(saleRow, "the sale is queued for the center").toBeTruthy();
    expect(["PENDING", "SENDING"]).toContain(String(saleRow!.status));

    const after = await syncStatus(cashierToken);
    expect(after.counts.pending).toBeGreaterThan(before.counts.pending);
  });

  test("the queue survives a browser restart and drains once the center returns", async ({ page }) => {
    centerMode = "down";
    // A fresh browser context: nothing was kept in the old page.
    await loginAsCashier(page);
    await page.goto("/sync");
    await expect(page.getByText("Pending changes").first()).toBeVisible();
    // The sale made before the "restart" is still in the queue. Rows render the
    // entity type next to the document id's last 6 characters ("Sale7afe3f"),
    // so match this specific sale rather than any row labelled "Sale".
    await expect(
      page.getByRole("cell", { name: new RegExp(`^Sale\\s*${saleId.slice(-6)}$`) }).first()
    ).toBeVisible();

    await page.getByRole("button", { name: /Sync now/i }).click();
    await expect(page.getByText(/Center unreachable/).first()).toBeVisible({ timeout: 45_000 });

    const during = await syncStatus(cashierToken);
    expect(during.counts.pending, "a failed run keeps the queue").toBeGreaterThan(0);
    expect(await Sale.countDocuments({ invoiceNumber: invoice })).toBe(1);

    // ---- the center comes back ----
    centerMode = "up";
    const runsBefore = (await syncStatus(cashierToken)).runs.length;
    await page.getByRole("button", { name: /Sync now/i }).click();

    // The drain is the outcome that matters. The toast is intentionally an
    // error when the shared queue still holds conflicts from earlier specs, so
    // assert on the run itself: one new completed run that actually pushed.
    // Rows reach SYNCED before the run writes its success marker, so wait for
    // both rather than racing the bookkeeping.
    await expect
      .poll(
        async () => {
          const status = await syncStatus(cashierToken);
          // The run is still pulling reference data after the push drains.
          return (
            status.counts.pending === 0 &&
            status.connectivity.reachable === true &&
            status.runs[0]?.status === "completed"
          );
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    const healed = await syncStatus(cashierToken);
    expect(healed.counts.pending).toBe(0);
    expect(healed.connectivity.reachable).toBe(true);
    expect(healed.runs.length).toBeGreaterThan(runsBefore);
    expect(healed.runs[0].status).toBe("completed");
    expect(healed.runs[0].pushed).toBeGreaterThan(0);

    // The sale exists exactly once — the push never duplicated it.
    expect(await Sale.countDocuments({ invoiceNumber: invoice })).toBe(1);
    expect(await InventoryMovement.countDocuments({ referenceId: saleId, movementType: "SALE_OUT" })).toBe(1);
    expect(await dbStock(product._id)).toBe(PURCHASE_QTY - 1);

    // Push order respects dependencies: the product row landed before the sale.
    const productRow = await SyncOutbox.findOne({ collectionName: "products", docId: product._id }).lean();
    const saleRow = await SyncOutbox.findOne({ collectionName: "sales", docId: saleId }).lean();
    expect(String(productRow?.status)).toBe("SYNCED");
    expect(String(saleRow?.status)).toBe("SYNCED");
    expect(productRow!.priority).toBeLessThan(saleRow!.priority);
  });

  test("syncing again pushes nothing twice", async () => {
    centerMode = "up";
    const run = await api(cashierToken).post("/api/sync/run", {});
    expect(run.status).toBe(200);
    expect(run.body.data.pushed, "the queue was already drained").toBe(0);

    expect(await Sale.countDocuments({ invoiceNumber: invoice })).toBe(1);
    expect(await InventoryMovement.countDocuments({ referenceId: saleId, movementType: "SALE_OUT" })).toBe(1);
    expect(await dbStock(product._id)).toBe(PURCHASE_QTY - 1);
  });
});
