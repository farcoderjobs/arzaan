import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { seedRoles } from "@/models/permissions";
import { clearPermissionCache } from "@/lib/authorization";

export async function POST(req: NextRequest) {
  try {
    await connectDB();
    await seedRoles();
    clearPermissionCache();
    return NextResponse.json({ success: true, message: "Roles and permissions seeded" });
  } catch (error) {
    console.error("Seed error:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ success: false, error: "Use POST to seed" }, { status: 405 });
}
