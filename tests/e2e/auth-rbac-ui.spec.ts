/**
 * Area 1 + 2 (UI side) — Login, session handling, protected routes and
 * role-based UI visibility. Server-side RBAC is covered by the integration
 * suite; this file proves the browser experience matches it.
 */
import "./env";
import { test, expect } from "@playwright/test";
import jwt from "jsonwebtoken";

const PASSWORD = process.env.QA_USER_PASSWORD ?? "qa-test-pass-123!";

async function login(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
}

test.describe("login & sessions", () => {
  test("unauthenticated visits to protected pages redirect to /login with a redirect param", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fdashboard/);
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
  });

  test("invalid credentials show an error and stay on the login page", async ({ page }) => {
    await login(page, "qa-admin@qa.test", "definitely-the-wrong-password");
    await expect(page.getByText(/invalid credentials/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("valid credentials sign in, set session cookies, and reach the dashboard", async ({ page }) => {
    await login(page, "qa-admin@qa.test", PASSWORD);
    await page.waitForURL("**/dashboard**", { timeout: 60_000 });

    const cookies = await page.context().cookies();
    const names = cookies.map((c) => c.name);
    expect(names).toContain("pos_access_token");
    expect(names).toContain("pos_refresh_token");

    // Server-side session probe agrees
    const session = await page.request.get("/api/auth/[...nextauth]");
    expect(session.status()).toBe(200);
    expect((await session.json()).user.email).toBe("qa-admin@qa.test");
  });

  test("an expired access token is rejected by APIs (401) and pages fall back to login", async ({ page }) => {
    const secret = process.env.JWT_SECRET;
    expect(secret, "JWT_SECRET must be loaded from .env").toBeTruthy();
    const expired = jwt.sign({ sub: "000000000000000000000000", role: "x" }, secret as string, { expiresIn: -3600 });

    await page.context().addCookies([
      { name: "pos_access_token", value: expired, url: process.env.QA_BASE_URL || "http://localhost:3210" },
    ]);

    // API: structured 401
    const api = await page.request.get("/api/products?perPage=1");
    expect(api.status()).toBe(401);
    expect((await api.json()).error.code).toBe("UNAUTHORIZED");

    // Page: redirected back to login
    await page.goto("/pos");
    await expect(page).toHaveURL(/\/login/);
  });

  test("sign out clears the session and returns to the login page", async ({ page }) => {
    await login(page, "qa-admin@qa.test", PASSWORD);
    await page.waitForURL("**/dashboard**", { timeout: 60_000 });

    // Avatar dropdown (chevron) → Sign out. The chevron path alone is not
    // unique (the Language button uses the same icon), so scope it to the
    // user-menu button.
    await page.getByRole("button", { name: /QA Admin/ }).click();
    await page.getByRole("button", { name: /sign out/i }).click();

    await page.waitForURL("**/login**", { timeout: 30_000 });
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "pos_access_token")).toBeUndefined();
  });
});

test.describe("UI role-based access control", () => {
  test("cashier sidebar shows cashier links and hides privileged ones", async ({ page }) => {
    await login(page, "qa-cashier@qa.test", PASSWORD);
    await page.waitForURL("**/dashboard**", { timeout: 60_000 });

    // Visible: cashier scope
    await expect(page.locator('a[href="/pos"]')).toHaveCount(1);
    await expect(page.locator('a[href="/products"]')).toHaveCount(1);
    await expect(page.locator('a[href="/sales"]')).toHaveCount(1);
    await expect(page.locator('a[href="/cash-register"]')).toHaveCount(1);

    // Hidden: privileged areas
    await expect(page.locator('a[href="/users"]')).toHaveCount(0);
    await expect(page.locator('a[href="/roles"]')).toHaveCount(0);
    await expect(page.locator('a[href="/purchases"]')).toHaveCount(0);
    await expect(page.locator('a[href="/inventory"]')).toHaveCount(0);
    await expect(page.locator('a[href="/reports"]')).toHaveCount(0);
    await expect(page.locator('a[href="/settings"]')).toHaveCount(0);
  });

  test("cashier APIs are denied server-side even when called directly", async ({ page }) => {
    await login(page, "qa-cashier@qa.test", PASSWORD);
    await page.waitForURL("**/dashboard**", { timeout: 60_000 });

    expect((await page.request.get("/api/users?perPage=1")).status()).toBe(403);
    expect((await page.request.get("/api/settings")).status()).toBe(403);
    expect(
      (await page.request.post("/api/products", { data: { name: "Nope", sku: "NOPE-1" } })).status()
    ).toBe(403);

    // Allowed scope works
    expect((await page.request.get("/api/products?perPage=1")).status()).toBe(200);
  });

  test("admin sidebar exposes the privileged areas", async ({ page }) => {
    await login(page, "qa-admin@qa.test", PASSWORD);
    await page.waitForURL("**/dashboard**", { timeout: 60_000 });

    await expect(page.locator('a[href="/users"]')).toHaveCount(1);
    await expect(page.locator('a[href="/settings"]')).toHaveCount(1);
    await expect(page.locator('a[href="/purchases"]')).toHaveCount(1);
  });
});
