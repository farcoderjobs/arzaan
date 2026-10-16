import { NextResponse } from "next/server";

/**
 * Lightweight backend health probe used by the offline connectivity service.
 *
 * The browser can report navigator.onLine === true while the API is
 * unreachable (captive portal, server down, VPN drop), so the POS calls this
 * endpoint with cache: 'no-store' to decide its ONLINE/OFFLINE state.
 *
 * Deliberately public and cheap: no auth, no DB query, no caching.
 */
export async function GET() {
  return NextResponse.json(
    { ok: true, serverTime: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } }
  );
}
