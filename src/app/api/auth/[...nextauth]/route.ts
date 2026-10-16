import { NextRequest, NextResponse } from "next/server";
import { refreshSession, clearAuthCookies, setAuthCookies, getCurrentUser } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const intent = body.intent;

  if (intent === "refresh") {
    const result = await refreshSession();
    if (!result) {
      // Awaited: an unawaited cookie delete races the response commit, so the
      // clearing Set-Cookie headers can be lost (logout/refresh must expire them).
      await clearAuthCookies();
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }
    await setAuthCookies(result.accessToken, result.refreshToken);
    return NextResponse.json({ user: result.user });
  }

  if (intent === "logout") {
    await clearAuthCookies();
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown intent" }, { status: 400 });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({ user });
}
