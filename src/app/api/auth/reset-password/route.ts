import { NextRequest, NextResponse } from "next/server";
import { initiatePasswordReset, resetPassword as resetPasswordFn } from "@/lib/auth";
import { badRequest } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { intent } = body;

    if (intent === "request") {
      const { email } = body;
      if (!email) return NextResponse.json(badRequest("Email is required"), { status: 400 });
      const token = await initiatePasswordReset(email);
      if (!token) {
        return NextResponse.json({ success: false, error: "If that email exists, a reset link has been sent." }, { status: 200 });
      }
      return NextResponse.json({ success: true, message: "If that email exists, a reset link has been sent." });
    }

    if (intent === "reset") {
      const { token, newPassword, confirmPassword } = body;
      if (!token || !newPassword) return NextResponse.json(badRequest("Token and new password are required"), { status: 400 });
      if (newPassword !== confirmPassword) return NextResponse.json(badRequest("Passwords do not match"), { status: 400 });
      const ok = await resetPasswordFn(token, newPassword);
      if (!ok) return NextResponse.json(badRequest("Invalid or expired reset token"), { status: 400 });
      return NextResponse.json({ success: true, message: "Password reset successful" });
    }

    return NextResponse.json(badRequest("Unknown intent"), { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
