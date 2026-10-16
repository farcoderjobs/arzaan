import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import mongoose from "mongoose";
import { verifyAccessToken } from "@/utils/auth";
import { connectDB } from "@/lib/mongodb";
import { User } from "@/models";

/**
 * Next.js 16 Proxy (formerly middleware — the `middleware.ts` convention is
 * deprecated and renamed `proxy.ts`; see node_modules/next/dist/docs).
 *
 * Runs before every request on the Node.js runtime (Next 16 default):
 *  - Optimistic page guard: protected pages redirect to /login when the
 *    session cookie is missing (full validation happens in the layout).
 *  - API guard: protected /api/* routes return a structured 401 when the
 *    access token is missing, malformed, or expired. Without this, each
 *    route's generic `catch` surfaced an unauthenticated call as a 500 —
 *    clients (e.g. the offline sync engine) cannot distinguish "refresh
 *    your session" from "server is broken". Route handlers still perform
 *    the authoritative user + permission checks; this is an optimistic gate.
 */

const PUBLIC_FILE = /\.(.*)$/;
const PROTECTED_ROUTES = ["/dashboard", "/pos", "/products", "/inventory", "/purchases", "/customers", "/suppliers", "/sales", "/returns", "/finance", "/cash-register", "/reports", "/users", "/settings", "/roles", "/store-products", "/store-orders"];

/**
 * API paths that are intentionally reachable without a session:
 *  - /api/health            → public connectivity probe for the offline mode
 *  - /api/seed              → idempotent roles/permissions bootstrap (existing behavior)
 *  - /api/auth/*            → refresh / logout / password-reset handle their own tokens
 *  - /api/store/products    → public storefront catalog
 *  - /api/store/orders      → public storefront checkout (exact path only —
 *                             /api/store/orders/admin stays authenticated)
 * Everything else under /api requires a valid pos_access_token.
 */
const PUBLIC_API_EXACT = new Set([
  "/api/health",
  "/api/seed",
  "/api/store/products",
  "/api/store/orders",
]);
const PUBLIC_API_PREFIXES = ["/api/auth/"];

function apiUnauthorized() {
  return NextResponse.json(
    { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
    { status: 401 }
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_FILE.test(pathname)) {
    return NextResponse.next();
  }

  // ---------- API routes: structured 401 for missing/expired sessions ----------
  if (pathname.startsWith("/api/")) {
    if (PUBLIC_API_EXACT.has(pathname) || PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) {
      return NextResponse.next();
    }

    const token = request.cookies.get("pos_access_token")?.value ?? null;
    if (!token) return apiUnauthorized();

    const payload = verifyAccessToken(token);
    if (!payload || typeof payload !== "object" || !payload.sub) {
      return apiUnauthorized();
    }

    // The signature only proves the token was issued by us — the user must
    // still exist and be active. Without this check a deactivated (or deleted)
    // user's still-valid JWT sails into the route, where `requireSessionUser`
    // throws UNAUTHORIZED into a generic catch and the client sees a 500
    // instead of the 401 that drives session cleanup / refresh.
    const sub = String(payload.sub);
    if (!mongoose.Types.ObjectId.isValid(sub)) return apiUnauthorized();
    try {
      await connectDB();
      const active = await User.exists({ _id: sub, status: "active" });
      if (!active) return apiUnauthorized();
    } catch {
      // Database unreachable — auth state cannot be confirmed (not a client error).
      return NextResponse.json(
        { success: false, error: { code: "INTERNAL_ERROR", message: "Could not verify session" } },
        { status: 500 }
      );
    }
    return NextResponse.next();
  }

  // ---------- Page routes: optimistic cookie-presence redirect ----------
  const isProtected = PROTECTED_ROUTES.some((route) => pathname.startsWith(route));
  if (!isProtected) {
    return NextResponse.next();
  }

  const pageToken = request.cookies.get("pos_access_token")?.value ?? null;
  if (!pageToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
