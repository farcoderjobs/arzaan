/**
 * Area 1 — Authentication, session expiration, protected routes.
 * Runs against the QA server (see scripts/run-integration.mjs).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { ACCOUNTS, BASE_URL, api, authFor, connectDb, tag } from "../helpers/qa";
import { User } from "../../src/models";
import { hashToken } from "../../src/utils/auth";

const secret = () => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET missing");
  return process.env.JWT_SECRET;
};

describe("auth & sessions", () => {
  let admin: Awaited<ReturnType<typeof authFor>>;

  beforeAll(async () => {
    await connectDb();
    admin = await authFor(ACCOUNTS.admin);
  });

  // ---------------------------------------------------------------------------
  // Token validation on protected APIs (central gate: src/proxy.ts)
  // ---------------------------------------------------------------------------

  it("rejects API calls without any token with 401 UNAUTHORIZED", async () => {
    const res = await api().get("/api/products?perPage=1");
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe("UNAUTHORIZED");
  });

  it("rejects malformed tokens with 401 (not 500)", async () => {
    const res = await api("not-a-jwt").get("/api/products?perPage=1");
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe("UNAUTHORIZED");
  });

  it("rejects expired tokens with 401", async () => {
    const expired = jwt.sign({ sub: admin.userId, role: admin.roleId }, secret(), { expiresIn: -3600 });
    const res = await api(expired).get("/api/products?perPage=1");
    expect(res.status).toBe(401);
  });

  it("rejects tokens forged with a different secret with 401", async () => {
    const forged = jwt.sign({ sub: admin.userId, role: admin.roleId }, "a".repeat(40), { expiresIn: "1d" });
    const res = await api(forged).get("/api/products?perPage=1");
    expect(res.status).toBe(401);
  });

  it("accepts a correctly signed token", async () => {
    const res = await api(admin.token).get("/api/products?perPage=1");
    expect(res.status).toBe(200);
  });

  it("does not authenticate tokens of users deactivated after signing", async () => {
    const email = `qa-deact-${tag()}@qa.test`;
    const created = await User.create({
      name: "QA Deactivated Probe",
      email,
      phone: "",
      passwordHash: "x",
      roleId: admin.roleId,
      branchId: null,
      status: "active",
    });
    const token = { sign: () => jwt.sign({ sub: String(created._id), role: String(admin.roleId) }, secret(), { expiresIn: "1d" }) };
    try {
      const before = await api(token.sign()).get("/api/products?perPage=1");
      expect(before.status).toBe(200);

      await User.updateOne({ _id: created._id }, { $set: { status: "inactive" } });
      const after = await api(token.sign()).get("/api/products?perPage=1");
      expect(after.status).toBe(401);
    } finally {
      await User.deleteOne({ _id: created._id });
    }
  });

  // ---------------------------------------------------------------------------
  // Public vs protected surfaces
  // ---------------------------------------------------------------------------

  it("keeps /api/health reachable without a session (offline-mode probe)", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
  });

  it("redirects protected pages to /login with a redirect param", async () => {
    const res = await fetch(`${BASE_URL}/dashboard`, { redirect: "manual" });
    expect([302, 307, 308]).toContain(res.status);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain("redirect=%2Fdashboard");
  });

  it("lets the login page render without a session", async () => {
    const res = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Refresh-token flow (session renewal)
  // ---------------------------------------------------------------------------

  describe("refresh flow", () => {
    let email: string;

    beforeAll(() => {
      email = `qa-refresh-${tag()}@qa.test`;
    });

    afterAll(async () => {
      await connectDb();
      await User.deleteOne({ email });
    });

    async function makeUserWithRefreshHash() {
      await connectDb();
      const user = await User.create({
        name: "QA Refresh Probe",
        email,
        phone: "",
        passwordHash: "x",
        roleId: admin.roleId,
        branchId: null,
        status: "active",
      });
      const refreshToken = jwt.sign({ sub: String(user._id), type: "refresh" }, secret(), { expiresIn: "1d" });
      await User.updateOne({ _id: user._id }, { $set: { refreshTokenHash: hashToken(refreshToken) } });
      return { userId: String(user._id), refreshToken };
    }

    it("issues a fresh session when a valid refresh token is presented as a cookie", async () => {
      const { userId, refreshToken } = await makeUserWithRefreshHash();
      const res = await fetch(`${BASE_URL}/api/auth/[...nextauth]`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `pos_refresh_token=${refreshToken}` },
        body: JSON.stringify({ intent: "refresh" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe(userId);
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("pos_access_token=");
      expect(setCookie).toContain("pos_refresh_token=");
    });

    it("expires the session (401) when the refresh token is unknown", async () => {
      const unknown = jwt.sign({ sub: admin.userId, type: "refresh" }, secret(), { expiresIn: "1d" });
      const res = await fetch(`${BASE_URL}/api/auth/[...nextauth]`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `pos_refresh_token=${unknown}` },
        body: JSON.stringify({ intent: "refresh" }),
      });
      expect(res.status).toBe(401);
    });

    it("expires the session (401) when the refresh token is expired", async () => {
      const expired = jwt.sign({ sub: admin.userId, type: "refresh" }, secret(), { expiresIn: -60 });
      const res = await fetch(`${BASE_URL}/api/auth/[...nextauth]`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `pos_refresh_token=${expired}` },
        body: JSON.stringify({ intent: "refresh" }),
      });
      expect(res.status).toBe(401);
    });

    it("logout clears both auth cookies in the response", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/[...nextauth]`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Deleting a cookie that was never sent emits no set-cookie header,
          // so present both cookies to observe the clearing headers.
          cookie: "pos_access_token=probe; pos_refresh_token=probe",
        },
        body: JSON.stringify({ intent: "logout" }),
      });
      expect(res.status).toBe(200);
      const cookies = res.headers.getSetCookie().join(" ; ");
      expect(cookies).toContain("pos_access_token=;");
      expect(cookies).toContain("pos_refresh_token=;");
    });
  });
});
